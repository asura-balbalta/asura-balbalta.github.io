import { LAYER_DEFS } from "../layers"
import type { TinMesh } from "../terrainData"
import { buildSteppedMeshChunks } from "../terrainSteps"
import type { TerrainMode } from "../webgpu/terrainRenderer"
import { computeVertexNormals, encodeGlb, GlbNode } from "./glb"
import type { LayerMeshes } from "./stlClient"

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
 * LAYER_DEFS 순서로 레이어마다 노드 하나. 지형 tin 은 정점 법선을 넣어 부드럽게, stepped 조각과 다른 레이어는 법선 없이
 * 평면 음영으로 둔다. 원점·좌표계는 asset.extras 에 남긴다. 진행률은 레이어 단위로 낸다(인코딩 자체가 빨라 세분하지 않는다).
 * 취소는 메인에서 terminate 로 한다(요청마다 Worker 를 새로 만든다). 오류는 메인의 worker.onerror 로 전달된다.
 */
self.onmessage = (e: MessageEvent<GlbExportRequest>) => {
    const { layers, mode, step } = e.data
    const weight = (m: TinMesh | null) => (m ? m.indices.length / 3 : 0)
    const total = Object.values(layers).reduce((sum, m) => sum + weight(m), 0) || 1
    let doneBefore = 0
    const progress = (ratioInLayer: number, layerWeight: number) =>
        post({ type: "progress", ratio: (doneBefore + ratioInLayer * layerWeight) / total })

    const nodes: GlbNode[] = []
    let origin: [number, number] | undefined
    for (const { id } of LAYER_DEFS) {
        const mesh = layers[id]
        if (!mesh) continue
        origin ??= mesh.origin
        const node: GlbNode = { name: id, color: LAYER_COLORS[id] ?? [0.63, 0.63, 0.63], primitives: [] }
        const w = weight(mesh)
        if (id === "terrain" && mode === "stepped") {
            const chunks = buildSteppedMeshChunks(mesh, step, STEPPED_CHUNK_BYTES, (done, all) => progress(done / all, w))
            for (const chunk of chunks) node.primitives.push({ positions: chunk.positions, indices: chunk.indices })
        } else if (id === "terrain") {
            node.primitives.push({ positions: mesh.positions, indices: mesh.indices, normals: computeVertexNormals(mesh.positions, mesh.indices) })
        } else {
            node.primitives.push({ positions: mesh.positions, indices: mesh.indices })
        }
        nodes.push(node)
        doneBefore += w
        progress(0, 0)
    }
    const buffer = encodeGlb(nodes, { origin, crs: "ESRI:102080", unit: "m", up: "+Y (원본 Z-up 을 (x, z, -y) 로 변환)" })
    post({ type: "done", buffer }, [buffer])
}
