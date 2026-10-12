import { buildingAttributes, NOT_BUILT } from "../buildingTable"
import { LAYER_DEFS } from "../layers"
import type { TinMesh } from "../terrainData"
import { buildSteppedMeshChunks } from "../terrainSteps"
import type { TerrainMode } from "../webgpu/terrainRenderer"
import { computeVertexNormals, encodeGlb, GlbMaterial, GlbNode, toFlatPrimitive } from "./glb"
import type { ExportMesh, LayerMeshes } from "./stlClient"

/**
 * 메인 → Worker: GLB 생성 요청. 레이어마다 넣을지 말지를 메인이 정해 메쉬를 주거나(null 이면 뺌) 만다.
 * 메쉬는 메인이 slice() 로 만든 사본이며 그 배열을 transfer 로 넘겨받는다
 */
export type GlbExportRequest = {
    layers: LayerMeshes
    /** 지형(terrain)을 "tin" 이면 삼각형 그대로, "stepped" 면 화면과 같은 계단형으로 변환해 넣는다. 다른 레이어는 그대로 */
    mode: TerrainMode
    /** stepped 일 때 층 간격(m) */
    step: number
}

/** Worker → 메인: 진행률(0 ~ 1), 완료(.glb 파일 바이트, transfer) */
export type GlbExportResponse = { type: "progress"; ratio: number } | { type: "done"; buffer: ArrayBuffer }

/** 계단형 변환 조각의 정점·인덱스 버퍼 최대 바이트. GPU 와 무관하므로 Worker 메모리만 고려 */
const STEPPED_CHUNK_BYTES = 64 * 1048576

/** 레이어별 재질 색(0 ~ 1). 없는 레이어는 회색 */
const LAYER_COLORS: Record<string, [number, number, number]> = {
    terrain: [0.55, 0.67, 0.47],
    buildings: [0.78, 0.78, 0.78],
}

const post = (msg: GlbExportResponse, transfer: Transferable[] = []) => self.postMessage(msg, { transfer })

/**
 * 레이어들을 GLB 파일 하나로 만든다. 메인 스레드 밖에서 돈다.
 *
 * 루트 노드(이름은 레이어 id 를 "+" 로 이은 것) 아래에 LAYER_DEFS 순서로 레이어 노드를 둔다. 재질은 레이어마다 하나.
 * - 지형 tin: 정점 법선을 넣어 부드럽게. stepped: 변환 조각마다 면 법선 평면 조각(toFlatPrimitive).
 * - 건물: 표(table)가 있으면 "buildings" 노드 아래에 건물마다 노드(이름 = 전국 고유 번호, extras = 속성)를 두고, 합쳐진 메쉬에서
 *   그 건물의 삼각형 범위(표의 첫 삼각형 번호부터 다음 세운 건물 전까지)를 평면 조각으로 넣는다. 표가 없으면 레이어 전체가
 *   평면 조각 하나다.
 * 원점·좌표계는 asset.extras 에 남긴다. 진행률은 레이어 단위로 낸다(인코딩 자체가 빨라 세분하지 않는다).
 * 취소는 메인에서 terminate 로 한다(요청마다 Worker 를 새로 만든다). 오류는 메인의 worker.onerror 로 전달된다.
 */
self.onmessage = (e: MessageEvent<GlbExportRequest>) => {
    const { layers, mode, step } = e.data
    const weight = (m: TinMesh | null) => (m ? m.indices.length / 3 : 0)
    const total = Object.values(layers).reduce((sum, m) => sum + weight(m), 0) || 1
    let doneBefore = 0
    const progress = (ratioInLayer: number, layerWeight: number) =>
        post({ type: "progress", ratio: (doneBefore + ratioInLayer * layerWeight) / total })

    const materials: GlbMaterial[] = []
    const children: GlbNode[] = []
    let origin: [number, number] | undefined
    for (const { id } of LAYER_DEFS) {
        const mesh: ExportMesh | null = layers[id]
        if (!mesh) continue
        origin ??= mesh.origin
        const material = materials.push({ name: id, color: LAYER_COLORS[id] ?? [0.63, 0.63, 0.63] }) - 1
        const w = weight(mesh)
        const node: GlbNode = { name: id, primitives: [] }
        if (id === "terrain" && mode === "stepped") {
            const chunks = buildSteppedMeshChunks(mesh, step, STEPPED_CHUNK_BYTES, (done, all) => progress(done / all, w))
            for (const chunk of chunks) node.primitives!.push(toFlatPrimitive(chunk.positions, chunk.indices, material))
        } else if (id === "terrain") {
            node.primitives!.push({
                positions: mesh.positions,
                indices: mesh.indices,
                normals: computeVertexNormals(mesh.positions, mesh.indices),
                material,
            })
        } else if (id === "buildings" && mesh.table) {
            const table = mesh.table
            delete node.primitives
            node.children = []
            // 세운 건물의 삼각형 범위: 첫 삼각형 번호부터 다음 세운 건물의 첫 삼각형 전까지
            const built: number[] = []
            for (let k = 0; k < table.count; k++) if (table.faceBase[k] !== NOT_BUILT) built.push(k)
            const totalFaces = mesh.indices.length / 3
            built.forEach((k, i) => {
                const from = table.faceBase[k]
                const to = i + 1 < built.length ? table.faceBase[built[i + 1]] : totalFaces
                if (to <= from) return
                node.children!.push({
                    name: String(table.ids[k]),
                    primitives: [toFlatPrimitive(mesh.positions, mesh.indices.subarray(from * 3, to * 3), material)],
                    extras: buildingAttributes(table, k),
                })
            })
        } else {
            node.primitives!.push(toFlatPrimitive(mesh.positions, mesh.indices, material))
        }
        children.push(node)
        doneBefore += w
        progress(0, 0)
    }
    const root: GlbNode = { name: materials.map((m) => m.name).join("+"), children }
    const buffer = encodeGlb(root, materials, {
        origin,
        crs: "ESRI:102080",
        unit: "m",
        up: "+Y (원본 Z-up 을 (x, z, -y) 로 변환)",
    })
    post({ type: "done", buffer }, [buffer])
}
