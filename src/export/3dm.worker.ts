import { ATTRIBUTION_LINE, attributionFileText, attributionPageUrl } from "../attribution"
import { WALL_SINK_M } from "../buildingsMesh"
import { buildingAttributes, buildingLabel, buildingRings, NOT_BUILT } from "../buildingTable"
import { LAYER_DEFS } from "../layers"
import type { TinMesh } from "../terrainData"
import type { TerrainMode } from "../webgpu/terrainRenderer"
import type { ExportMesh, LayerMeshes } from "./stlClient"
import { buildTerrainSlabs, P2 } from "./terrainSlabs"

/**
 * 메인 → Worker: 3DM 생성 요청. 레이어마다 넣을지 말지를 메인이 정해 메쉬를 주거나(null 이면 뺌) 만다.
 * 메쉬는 메인이 slice() 로 만든 사본이며 그 배열을 transfer 로 넘겨받는다
 */
export type Rhino3dmExportRequest = {
    layers: LayerMeshes
    /** 지형(terrain)을 "tin" 이면 삼각형 메쉬 그대로, "stepped" 면 레벨마다 두께 step 의 판(Extrusion)을 쌓아 넣는다. 다른 레이어는 그대로 */
    mode: TerrainMode
    /** stepped 일 때 층 간격(m) */
    step: number
}

/** Worker → 메인: 진행률(0 ~ 1), 완료(.3dm 파일 바이트, transfer) */
export type Rhino3dmExportResponse = { type: "progress"; ratio: number } | { type: "done"; buffer: ArrayBuffer }

/**
 * rhino3dm(McNeel 의 openNURBS wasm 빌드)은 node 전용 require 를 품고 있어 esbuild 로 번들하지 않는다.
 * 대신 package.json 의 prebuild/predev 가 node_modules 의 rhino3dm.min.js 와 rhino3dm.wasm 을 이 Worker 와 같은 폴더(dist/export)에
 * 복사하고, 여기서 importScripts 로 읽는다. wasm 은 라이브러리가 자기 스크립트 위치(self.location) 기준으로 찾는다
 */
const RHINO_SCRIPT = "rhino3dm.min.js"
/** importScripts 가 정의하는 전역. 타입은 패키지의 선언을 빌려 쓴다 */
declare const rhino3dm: typeof import("rhino3dm").default
declare function importScripts(...urls: string[]): void
type RhinoModule = Awaited<ReturnType<typeof rhino3dm>>
type Doc = InstanceType<RhinoModule["File3dm"]>
type Attributes = InstanceType<RhinoModule["ObjectAttributes"]>

/** 삼각형 메쉬는 이 면 수마다 진행률을 보낸다 */
const PROGRESS_EVERY_FACES = 50_000

const post = (msg: Rhino3dmExportResponse, transfer: Transferable[] = []) => self.postMessage(msg, { transfer })

/** 레이어별 Rhino 레이어 색. 없는 레이어는 회색 */
const LAYER_COLORS: Record<string, { r: number; g: number; b: number; a: number }> = {
    terrain: { r: 140, g: 170, b: 120, a: 255 },
    buildings: { r: 200, g: 200, b: 200, a: 255 },
}

/**
 * 인덱스 메쉬를 Rhino Mesh 로 만든다. 정점은 그대로 공유하고(미터), 넓이 0 삼각형(같은 정점 둘 이상)은 건너뛴다.
 *
 * @returns 메쉬와 건너뛴 삼각형 수
 */
const toRhinoMesh = (
    rhino: RhinoModule,
    positions: Float32Array,
    indices: Uint32Array,
    onFace?: (done: number, total: number) => void,
) => {
    const mesh = new rhino.Mesh()
    const vertices = mesh.vertices()
    for (let i = 0; i < positions.length; i += 3) vertices.add(positions[i], positions[i + 1], positions[i + 2])
    const faces = mesh.faces()
    const count = Math.floor(indices.length / 3)
    let skipped = 0
    for (let t = 0; t < count; t++) {
        const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2]
        if (a === b || b === c || a === c) skipped++
        else faces.addTriFace(a, b, c)
        if (onFace && (t + 1) % PROGRESS_EVERY_FACES === 0) onFace(t + 1, count)
    }
    return { mesh, skipped }
}

/**
 * 평면 다각형(외곽 + 구멍)을 zBottom 에서 zTop 까지 돌출한 닫힌 Extrusion 을 문서에 넣는다. SketchUp 의 push/pull 결과와
 * 같은 솔리드다.
 *
 * rhino3dm 의 Extrusion 은 프로파일을 2D 좌표로 받는데, Extrusion.create(곡선, 높이) 로 만들면 그 2D 원점이 외곽 곡선의
 * 첫 점이 되어 구멍 좌표를 옮겨야 한다(node 에서 확인). 대신 경로를 (0, 0, zBottom) → (0, 0, zTop), up 을 +y 로 직접 두면
 * 프로파일 2D 축이 세계 x·y 와 같아져 외곽·구멍을 세계 xy 그대로(z = 0) 넣을 수 있다. 외곽은 반시계, 구멍은 시계여야
 * 받아들인다(반대면 addInnerProfile 이 false).
 *
 * @returns 성공 여부. 곡선이 유효하지 않으면(점이 겹치거나 자기 교차) false
 */
const addExtrusion = (
    rhino: RhinoModule,
    doc: Doc,
    outer: P2[],
    holes: P2[][],
    zBottom: number,
    zTop: number,
    attributes: Attributes,
) => {
    const closed = (ring: P2[]) => {
        const pts = ring.map(([x, y]) => [x, y, 0])
        pts.push(pts[0])
        return new rhino.PolylineCurve(pts)
    }
    const extrusion = new rhino.Extrusion()
    if (!extrusion.setPathAndUp([0, 0, zBottom], [0, 0, zTop], [0, 1, 0])) return false
    if (!extrusion.setOuterProfile(closed(outer), true)) return false
    for (const hole of holes) extrusion.addInnerProfile(closed(hole))
    doc.objects().addExtrusion(extrusion, attributes)
    return true
}

/** 이름이 name 인 Rhino 그룹을 만들고 그 인덱스를 돌려준다 */
const addGroup = (rhino: RhinoModule, doc: Doc, name: string) => {
    const group = new rhino.Group()
    group.name = name
    doc.groups().add(group)
    return doc.groups().count - 1
}

/**
 * rhino3dm 으로 레이어들을 Rhino .3dm 파일 하나로 만든다. 메인 스레드 밖에서 돈다.
 *
 * LAYER_DEFS 순서로 레이어마다 Rhino 레이어(레이어 id 이름)를 만들고 그 위에 객체를 둔다. 문서 단위는 미터라 TinMesh 좌표를
 * 환산 없이 쓴다.
 * - 지형 tin: 정점 공유 메쉬 하나.
 * - 지형 stepped: 레벨마다 "k·step 이상 영역" 을 두께 step 으로 돌출한 Extrusion(판). 건축 모형처럼 맨 아래 판(영역 전체)
 *   위에 다음 레벨 판이 쌓인다(SKP 내보내기와 같은 구조, terrainSlabs). 판은 "terrain-<높이>m" 이름의 객체이고 모두
 *   Rhino 그룹 "terrain" 에 넣어 한 번에 잡히게 한다(판 하나가 객체 하나라 판별 그룹은 두지 않는다).
 * - 건물: 표(table)가 있으면 건물마다 footprint 를 높이만큼 돌출한 Extrusion(이름은 전국 고유 번호, 그룹 "buildings",
 *   건물 속성은 user text), 없으면 삼각형 메쉬 하나. 지형 밖이라 못 세운 건물은 넣지 않는다.
 * 진행률은 레이어의 원본 삼각형 수로 가중해 0 ~ 1 로 낸다. 취소는 메인에서 terminate 로 한다(요청마다 Worker 를 새로 만든다).
 * 오류는 메인의 worker.onerror 로 전달된다(비동기 핸들러 안의 오류는 unhandledrejection 이 아니라 throw 로 올린다).
 */
self.onmessage = async (e: MessageEvent<Rhino3dmExportRequest>) => {
    const { layers, mode, step } = e.data
    importScripts(RHINO_SCRIPT)
    const rhino = await rhino3dm()

    const weight = (m: TinMesh | null) => (m ? m.indices.length / 3 : 0)
    const total = Object.values(layers).reduce((sum, m) => sum + weight(m), 0) || 1
    let doneBefore = 0
    const progress = (ratioInLayer: number, layerWeight: number) =>
        post({ type: "progress", ratio: (doneBefore + ratioInLayer * layerWeight) / total })

    const doc = new rhino.File3dm()
    doc.settings().modelUnitSystem = rhino.UnitSystem.Meters
    // 공공데이터 출처(src/attribution.ts). 파일 머리의 작성 프로그램 정보와 문서 사용자 문자열(Rhino 의 DocumentText)에 남긴다
    doc.applicationName = "asrbbt"
    doc.applicationUrl = attributionPageUrl()
    doc.applicationDetails = ATTRIBUTION_LINE
    doc.strings().set("attribution", attributionFileText())
    let skipped = 0
    let failedSolids = 0
    for (const { id } of LAYER_DEFS) {
        const mesh: ExportMesh | null = layers[id]
        if (!mesh) continue
        const layerIndex = doc.layers().addLayer(id, LAYER_COLORS[id] ?? { r: 160, g: 160, b: 160, a: 255 })
        const attributes = new rhino.ObjectAttributes()
        attributes.layerIndex = layerIndex
        attributes.name = id
        const w = weight(mesh)
        const addMesh = (positions: Float32Array, indices: Uint32Array, onFace?: (done: number, total: number) => void) => {
            const r = toRhinoMesh(rhino, positions, indices, onFace)
            skipped += r.skipped
            doc.objects().addMesh(r.mesh, attributes)
        }
        if (id === "terrain" && mode === "stepped") {
            const started = performance.now()
            const result = buildTerrainSlabs(mesh, step, (done, all) => progress(0.5 * (done / all), w))
            attributes.addToGroup(addGroup(rhino, doc, "terrain"))
            let solids = 0
            result.slabs.forEach((slab, i) => {
                attributes.name = `terrain-${slab.zTop}m`
                for (const { outer, holes } of slab.polygons) {
                    if (addExtrusion(rhino, doc, outer, holes, slab.zBottom, slab.zTop, attributes)) solids++
                    else failedSolids++
                }
                progress(0.5 + 0.5 * ((i + 1) / result.slabs.length), w)
            })
            console.log(`3DM 계단형(${step}m): 판 ${result.slabs.length}개, 솔리드 ${solids}개, ${Math.round(performance.now() - started)}ms`)
            if (result.openChains || result.orphanHoles) {
                console.warn(`3DM 계단형: 안 닫힌 사슬 ${result.openChains}개, 외곽 없는 구멍 ${result.orphanHoles}개 버림`)
            }
        } else if (id === "buildings" && mesh.table) {
            const started = performance.now()
            const table = mesh.table
            attributes.addToGroup(addGroup(rhino, doc, "buildings"))
            let solids = 0
            for (let k = 0; k < table.count; k++) {
                if (table.vertexBase[k] === NOT_BUILT) continue
                const rings = buildingRings(table, k)
                if (rings.length === 0) continue
                attributes.name = buildingLabel(table, k)
                // 같은 키를 건물마다 덮어쓴다. 문서에 넣을 때 속성이 복사되므로 뒤 건물이 앞 건물에 영향을 주지 않는다
                for (const [key, value] of Object.entries(buildingAttributes(table, k))) attributes.setUserString(key, String(value))
                const [outer, ...holes] = rings
                const zBottom = table.baseZ[k] - WALL_SINK_M
                const zTop = table.baseZ[k] + table.builtHeight[k]
                if (addExtrusion(rhino, doc, outer, holes, zBottom, zTop, attributes)) solids++
                else failedSolids++
                if (k % 500 === 499) progress((k + 1) / table.count, w)
            }
            console.log(`3DM 건물: ${solids}동, ${Math.round(performance.now() - started)}ms`)
        } else {
            addMesh(mesh.positions, mesh.indices, (done, all) => progress(done / all, w))
        }
        doneBefore += w
    }
    if (skipped > 0) console.warn(`3DM: 넓이 0 등으로 건너뛴 삼각형 ${skipped}개`)
    if (failedSolids > 0) console.warn(`3DM: 곡선이 유효하지 않아 건너뛴 솔리드 ${failedSolids}개`)
    // wasm 객체는 해제하지 않는다. 요청마다 Worker 를 새로 만들고 끝나면 terminate 하므로 메모리는 그때 돌아간다
    const bytes = doc.toByteArray()
    // wasm 힙을 가리키는 뷰일 수 있으므로 정확한 길이만 복사해 넘긴다
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    post({ type: "done", buffer }, [buffer])
}
