import { create } from "openskp"

import type { TinMesh } from "./terrainData"
import { buildSteppedMeshChunks } from "./terrainSteps"
import type { TerrainMode } from "./webgpu/terrainRenderer"

/**
 * 메인 → Worker: SKP 생성 요청. 레이어마다 넣을지 말지를 메인이 정해 메쉬를 주거나(null 이면 뺌) 만다.
 * 메쉬는 메인이 slice() 로 만든 사본이며 그 배열을 transfer 로 넘겨받는다
 */
export type SkpExportRequest = {
    /** 지형. "tin" 이면 삼각형 그대로, "stepped" 면 화면과 같은 계단형으로 변환해 넣는다 */
    terrain: TinMesh | null
    mode: TerrainMode
    /** stepped 일 때 층 간격(m) */
    step: number
    /** 건물 레이어. 삼각형 그대로 넣는다 */
    buildings: TinMesh | null
}

/** Worker → 메인: 진행률(0 ~ 1), 완료(.skp 파일 바이트, transfer) */
export type SkpExportResponse = { type: "progress"; ratio: number } | { type: "done"; buffer: ArrayBuffer }

/** SketchUp 내부 단위는 인치. TinMesh 좌표(m)를 환산한다 */
const INCH_PER_METER = 1 / 0.0254
/** 계단형 변환 조각의 정점·인덱스 버퍼 최대 바이트. GPU 와 무관하므로 Worker 메모리만 고려 */
const STEPPED_CHUNK_BYTES = 64 * 1048576
/** 삼각형 메쉬는 이 면 수마다 진행률을 보낸다 */
const PROGRESS_EVERY_FACES = 20_000

const post = (msg: SkpExportResponse, transfer: Transferable[] = []) => self.postMessage(msg, { transfer })

type FaceOptions = { softEdges?: boolean; smoothEdges?: boolean }
type GroupBuilder = ReturnType<ReturnType<typeof create>["addGroup"]>

/**
 * 인덱스 메쉬의 삼각형을 그룹 빌더에 면으로 넣는다.
 *
 * openskp 의 addFace 는 변이 아니라 면 단위로만 soft·smooth 를 받으므로 메쉬 전체에 같은 옵션을 준다.
 * 넓이가 0인 삼각형은 addFace 가 던지므로 건너뛴다.
 *
 * @param def openskp 그룹 빌더
 * @param positions 꼭짓점 좌표(m, 원점 기준)
 * @param indices 삼각형 인덱스(3개씩)
 * @param options 면 옵션(soft·smooth)
 * @param onFace 면 하나를 처리할 때마다(진행률용)
 * @returns 건너뛴 삼각형 수
 */
const addTriangles = (
    def: GroupBuilder,
    positions: Float32Array,
    indices: Uint32Array,
    options: FaceOptions,
    onFace?: () => void,
) => {
    let skipped = 0
    const count = Math.floor(indices.length / 3)
    const pt = (i: number): [number, number, number] => [
        positions[i] * INCH_PER_METER,
        positions[i + 1] * INCH_PER_METER,
        positions[i + 2] * INCH_PER_METER,
    ]
    for (let t = 0; t < count; t++) {
        try {
            def.addFace([pt(indices[t * 3] * 3), pt(indices[t * 3 + 1] * 3), pt(indices[t * 3 + 2] * 3)], options)
        } catch {
            skipped++
        }
        onFace?.()
    }
    return skipped
}

/**
 * openskp(SDK 없이 .skp 를 쓰는 라이브러리)로 레이어들을 SketchUp 2017 포맷 파일 하나로 만든다. 메인 스레드 밖에서 돈다.
 *
 * 레이어마다 그룹("terrain", "buildings")을 하나씩 둔다. 지형 tin 은 면을 soft·smooth 로 두어 SketchUp 이 선을 숨기고
 * 음영을 매끄럽게 하고, stepped 와 건물은 soft 만 두어 선은 숨기되 평면 음영은 유지한다.
 * 진행률은 레이어의 원본 삼각형 수로 가중해 0 ~ 1 로 낸다. 취소는 메인에서 terminate 로 한다(요청마다 Worker 를 새로 만든다).
 * 오류는 메인의 worker.onerror 로 전달된다.
 */
self.onmessage = (e: MessageEvent<SkpExportRequest>) => {
    const { terrain, mode, step, buildings } = e.data
    const weight = (m: TinMesh | null) => (m ? m.indices.length / 3 : 0)
    const total = weight(terrain) + weight(buildings) || 1
    let doneBefore = 0
    const progress = (ratioInLayer: number, layerWeight: number) =>
        post({ type: "progress", ratio: (doneBefore + ratioInLayer * layerWeight) / total })

    /** 삼각형 메쉬를 그대로 그룹에 넣으며 진행률을 낸다 */
    const addPlain = (def: GroupBuilder, mesh: TinMesh, options: FaceOptions) => {
        const count = Math.floor(mesh.indices.length / 3)
        let done = 0
        return addTriangles(def, mesh.positions, mesh.indices, options, () => {
            done++
            if (done % PROGRESS_EVERY_FACES === 0) progress(done / count, count)
        })
    }

    const builder = create()
    let skipped = 0
    if (terrain) {
        builder.addGroup(
            (def) => {
                if (mode === "stepped") {
                    const w = weight(terrain)
                    const chunks = buildSteppedMeshChunks(terrain, step, STEPPED_CHUNK_BYTES, (done, all) =>
                        progress(done / all, w),
                    )
                    for (const chunk of chunks) {
                        skipped += addTriangles(def, chunk.positions, chunk.indices, { softEdges: true })
                    }
                } else {
                    skipped += addPlain(def, terrain, { softEdges: true, smoothEdges: true })
                }
            },
            { name: "terrain" },
        )
        doneBefore += weight(terrain)
    }
    if (buildings) {
        builder.addGroup((def) => void (skipped += addPlain(def, buildings, { softEdges: true })), { name: "buildings" })
        doneBefore += weight(buildings)
    }
    if (skipped > 0) console.warn(`SKP: 넓이 0 등으로 건너뛴 삼각형 ${skipped}개`)
    // toBytes 가 돌려주는 Uint8Array 는 더 큰 버퍼의 일부일 수 있으므로 정확한 길이만 복사해 넘긴다
    const bytes = builder.toBytes()
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    post({ type: "done", buffer }, [buffer])
}
