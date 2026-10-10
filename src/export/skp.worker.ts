import { create, type Point3 } from "openskp"

import { LAYER_DEFS } from "../layers"
import type { TinMesh } from "../terrainData"
import type { TerrainMode } from "../webgpu/terrainRenderer"
import type { LayerMeshes } from "./stlClient"
import { buildTerrainBands, P2 } from "./terrainBands"

/**
 * 메인 → Worker: SKP 생성 요청. 레이어마다 넣을지 말지를 메인이 정해 메쉬를 주거나(null 이면 뺌) 만다.
 * 메쉬는 메인이 slice() 로 만든 사본이며 그 배열을 transfer 로 넘겨받는다
 */
export type SkpExportRequest = {
    layers: LayerMeshes
    /** 지형(terrain)을 "tin" 이면 삼각형 그대로, "stepped" 면 띠마다 두께 step 의 판 그룹으로 넣는다. 다른 레이어는 그대로 */
    mode: TerrainMode
    /** stepped 일 때 층 간격(m) */
    step: number
}

/** Worker → 메인: 진행률(0 ~ 1), 완료(.skp 파일 바이트, transfer) */
export type SkpExportResponse = { type: "progress"; ratio: number } | { type: "done"; buffer: ArrayBuffer }

/** SketchUp 내부 단위는 인치. TinMesh 좌표(m)를 환산한다 */
const INCH_PER_METER = 1 / 0.0254
/** 삼각형 메쉬는 이 면 수마다 진행률을 보낸다 */
const PROGRESS_EVERY_FACES = 20_000

const post = (msg: SkpExportResponse, transfer: Transferable[] = []) => self.postMessage(msg, { transfer })

type Builder = ReturnType<typeof create>
type FaceOptions = { softEdges?: boolean; smoothEdges?: boolean }
type GroupBuilder = ReturnType<Builder["addGroup"]>

/**
 * 인덱스 메쉬의 삼각형을 그룹 빌더에 면으로 넣는다.
 *
 * openskp 의 addFace 는 변이 아니라 면 단위로만 soft·smooth 를 받으므로 메쉬 전체에 같은 옵션을 준다.
 * 넓이가 0인 삼각형은 addFace 가 던지므로 건너뛴다.
 *
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
 * 계단형 지형을 "띠마다 두께 step 의 판" 그룹들을 모은 "terrain" 그룹으로 넣는다. SketchUp 에서 등고선 판을 하나씩 push 해
 * 쌓은 모형과 같은 구조라, 판을 골라 옮기거나 지울 수 있고 띠끼리는 그룹이 달라 맞닿은 면이 서로 합쳐지지 않는다.
 *
 * 판 하나는 윗면(z = k·step)·아랫면(z = (k − 1)·step) 다각형 면(구멍 포함)과 둘레 변마다 벽 사각형이다. 모든 변은 hard 다.
 * openskp 의 면 법선은 점 순서로 정해지므로(Newell) 윗면은 반시계, 아랫면은 뒤집어 넣고, 벽은 영역을 왼쪽에 두고 걷는
 * 변 p→q 에 [p아래, q아래, q위, p위] 순으로 넣어 바깥을 향하게 한다. 구멍 고리는 시계 방향이라 같은 순서로 넣으면 역시 바깥(구멍 쪽)이다.
 *
 * openskp 는 중첩 그룹을 인라인으로 못 만들고, 정의(addComponentDefinition)를 먼저 만든 뒤 바깥 그룹 안에서
 * addGroupInstance 로 배치해야 한다. 그래서 띠마다 정의 하나("terrain-<높이>m")를 만들고 "terrain" 그룹이 그것들을 담는다.
 *
 * @param progress 이 레이어 안의 진행률(0 ~ 1). 앞 절반은 띠 변환, 뒤 절반은 면 쓰기
 * @returns 건너뛴(면 생성이 실패한) 면 수
 */
const addTerrainSlabs = (builder: Builder, mesh: TinMesh, step: number, progress: (ratio: number) => void) => {
    const started = performance.now()
    const result = buildTerrainBands(mesh, step, (done, all) => progress(0.5 * (done / all)))
    const converted = performance.now()
    const { bands } = result
    const pt = (p: P2, z: number): Point3 => [p[0] * INCH_PER_METER, p[1] * INCH_PER_METER, z * INCH_PER_METER]
    const ringPts = (ring: P2[], z: number, reverse: boolean) => (reverse ? [...ring].reverse() : ring).map((p) => pt(p, z))

    let faces = 0
    let skipped = 0
    const defs = bands.map((band, i) => {
        const def = builder.addComponentDefinition(`terrain-${band.zTop}m`, (def) => {
            const face = (points: Point3[], holes?: Point3[][]) => {
                try {
                    def.addFace(points, holes && holes.length > 0 ? { holes } : undefined)
                    faces++
                } catch {
                    skipped++
                }
            }
            for (const { outer, holes } of band.polygons) {
                face(
                    ringPts(outer, band.zTop, false),
                    holes.map((h) => ringPts(h, band.zTop, false)),
                )
                face(
                    ringPts(outer, band.zBottom, true),
                    holes.map((h) => ringPts(h, band.zBottom, true)),
                )
                for (const ring of [outer, ...holes]) {
                    for (let j = 0; j < ring.length; j++) {
                        const p = ring[j]
                        const q = ring[(j + 1) % ring.length]
                        face([pt(p, band.zBottom), pt(q, band.zBottom), pt(q, band.zTop), pt(p, band.zTop)])
                    }
                }
            }
        })
        progress(0.5 + 0.5 * ((i + 1) / bands.length))
        return def
    })
    builder.addGroup(
        (group) => {
            bands.forEach((band, i) => group.addGroupInstance(defs[i], { name: `${band.zTop}m` }))
        },
        { name: "terrain" },
    )

    const polygons = bands.reduce((s, b) => s + b.polygons.length, 0)
    const holes = bands.reduce((s, b) => s + b.polygons.reduce((t, p) => t + p.holes.length, 0), 0)
    console.log(
        `SKP 계단형(${step}m): 띠 ${bands.length}개, 다각형 ${polygons}개(구멍 ${holes}개), 면 ${faces}개, ` +
            `띠 변환 ${Math.round(converted - started)}ms + 면 쓰기 ${Math.round(performance.now() - converted)}ms`,
    )
    if (result.openChains || result.emptyRings || result.orphanHoles) {
        console.warn(
            `SKP 계단형: 안 닫힌 사슬 ${result.openChains}개, 빈 고리 ${result.emptyRings}개, 외곽 없는 구멍 ${result.orphanHoles}개 버림`,
        )
    }
    return skipped
}

/**
 * openskp(SDK 없이 .skp 를 쓰는 라이브러리)로 레이어들을 SketchUp 2017 포맷 파일 하나로 만든다. 메인 스레드 밖에서 돈다.
 *
 * LAYER_DEFS 순서로 레이어마다 그룹(레이어 id 이름)을 하나씩 둔다. 지형 tin 은 삼각형 면을 soft·smooth 로 두어 SketchUp 이
 * 선을 숨기고 음영을 매끄럽게 하고, 지형 stepped 는 띠마다 판 그룹(addTerrainSlabs), 다른 레이어는 삼각형 면을 soft 만 두어
 * 선은 숨기되 평면 음영은 유지한다.
 * 진행률은 레이어의 원본 삼각형 수로 가중해 0 ~ 1 로 낸다. 취소는 메인에서 terminate 로 한다(요청마다 Worker 를 새로 만든다).
 * 오류는 메인의 worker.onerror 로 전달된다.
 */
self.onmessage = (e: MessageEvent<SkpExportRequest>) => {
    const { layers, mode, step } = e.data
    const weight = (m: TinMesh | null) => (m ? m.indices.length / 3 : 0)
    const total = Object.values(layers).reduce((sum, m) => sum + weight(m), 0) || 1
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
    for (const { id } of LAYER_DEFS) {
        const mesh = layers[id]
        if (!mesh) continue
        const w = weight(mesh)
        if (id === "terrain" && mode === "stepped") {
            skipped += addTerrainSlabs(builder, mesh, step, (ratio) => progress(ratio, w))
        } else {
            const options: FaceOptions = id === "terrain" ? { softEdges: true, smoothEdges: true } : { softEdges: true }
            builder.addGroup((def) => void (skipped += addPlain(def, mesh, options)), { name: id })
        }
        doneBefore += w
    }
    if (skipped > 0) console.warn(`SKP: 넓이 0 등으로 건너뛴 면 ${skipped}개`)
    // toBytes 가 돌려주는 Uint8Array 는 더 큰 버퍼의 일부일 수 있으므로 정확한 길이만 복사해 넘긴다
    const bytes = builder.toBytes()
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    post({ type: "done", buffer }, [buffer])
}
