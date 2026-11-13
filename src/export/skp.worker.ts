import { create, type Point3 } from "openskp"

import { ATTRIBUTION_DISCLAIMER, ATTRIBUTION_LINE, attributionPageUrl } from "../attribution"
import { WALL_SINK_M } from "../buildingsMesh"
import { buildingAttributes, buildingLabel, buildingRings, BuildingTable, NOT_BUILT } from "../buildingTable"
import { LAYER_DEFS } from "../layers"
import { roadExportSampler, roadGroupExportChunks } from "../roadsMesh"
import { roadAttributes, roadGroups, roadLabel, RoadTable } from "../roadTable"
import { waterGroupExportChunks } from "../waterMesh"
import { waterAttributes, waterGroups, waterLabel, WaterTable } from "../waterTable"
import type { TinMesh } from "../terrainData"
import type { TerrainMode } from "../webgpu/terrainRenderer"
import type { ExportMesh, LayerMeshes } from "./stlClient"
import { GreenExport, GreenFaceRange, indicesOfRanges, rangesByClass, tagsOfRanges } from "./greenExport"
import { buildTerrainSlabs, P2, SlabPolygon } from "./terrainSlabs"

/**
 * 메인 → Worker: SKP 생성 요청. 레이어마다 넣을지 말지를 메인이 정해 메쉬를 주거나(null 이면 뺌) 만다.
 * 메쉬는 메인이 slice() 로 만든 사본이며 그 배열을 transfer 로 넘겨받는다
 */
export type SkpExportRequest = {
    layers: LayerMeshes
    /** 지형(terrain)을 "tin" 이면 삼각형 그대로, "stepped" 면 레벨마다 두께 step 의 판 그룹을 쌓아 넣는다. 다른 레이어는 그대로 */
    mode: TerrainMode
    /** stepped 일 때 층 간격(m) */
    step: number
    /** 녹지를 담을 때(지형 greenRanges 와 함께). 지형 그룹(매끈한 면) 또는 판 정의(계단형, 윗면만) 안에 분류별 하위 그룹·재질을 둔다 */
    green?: GreenExport
}

/** Worker → 메인: 진행률(0 ~ 1), 완료(.skp 파일 바이트, transfer) */
export type SkpExportResponse = { type: "progress"; ratio: number } | { type: "done"; buffer: ArrayBuffer }

/** SketchUp 내부 단위는 인치. TinMesh 좌표(m)를 환산한다 */
const INCH_PER_METER = 1 / 0.0254
/** 삼각형 메쉬는 이 면 수마다 진행률을 보낸다 */
const PROGRESS_EVERY_FACES = 20_000
/** 도로 계단화 조각의 버퍼 상한(바이트. Worker 메모리만 고려) */
const STEPPED_CHUNK_BYTES = 64 * 1048576

const post = (msg: SkpExportResponse, transfer: Transferable[] = []) => self.postMessage(msg, { transfer })

/**
 * 최상위 그룹("terrain"·"buildings")에 붙이는 공공데이터 출처(src/attribution.ts). openskp 는 모델 수준 속성 사전을 쓰는 API 가 없어
 * 그룹의 속성 사전("asrbbt", 건물 속성과 같은 이름)에 둔다. SketchUp 화면에는 안 보이고 Ruby API 로 읽힌다
 */
const ATTRIBUTION_ATTRS = {
    attributes: { source: ATTRIBUTION_LINE, source_url: attributionPageUrl(), disclaimer: ATTRIBUTION_DISCLAIMER },
    attributeDictName: "asrbbt",
}

type Builder = ReturnType<typeof create>
type FaceOptions = { softEdges?: boolean; smoothEdges?: boolean; material?: number }
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
    def: Pick<GroupBuilder, "addFace">,
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
 * 계단형 지형을 "레벨 k 이상 영역을 두께 step 으로 push 한 판" 그룹들을 모은 "terrain" 그룹으로 넣는다. 건축 모형처럼 맨 아래
 * 판(메쉬 전체) 위에 다음 레벨 판을 차례로 쌓는 구조라, 판을 골라 옮기거나 지울 수 있고 판끼리는 그룹이 달라 맞닿은 면이
 * 서로 합쳐지지 않는다. 아래 판의 윗면 중 위 판에 덮인 부분은 모형 속에 숨는다.
 *
 * 판 하나는 윗면(z = k·step)·아랫면(z = (k − 1)·step) 다각형 면(구멍 포함)과 둘레 변마다 벽 사각형이다. 모든 변은 hard 다.
 * openskp 의 면 법선은 점 순서로 정해지므로(Newell) 윗면은 반시계, 아랫면은 뒤집어 넣고, 벽은 영역을 왼쪽에 두고 걷는
 * 변 p→q 에 [p아래, q아래, q위, p위] 순으로 넣어 바깥을 향하게 한다. 구멍 고리는 시계 방향이라 같은 순서로 넣으면 역시 바깥(구멍 쪽)이다.
 *
 * openskp 는 중첩 그룹을 인라인으로 못 만들고, 정의(addComponentDefinition)를 먼저 만든 뒤 바깥 그룹 안에서
 * addGroupInstance 로 배치해야 한다. 그래서 판마다 정의 하나("terrain-<높이>m")를 만들고 "terrain" 그룹이 그것들을 담는다.
 *
 * 녹지를 담으면(green, G12) 윗면을 판 정의 한 장 대신 terrainSlabs 의 tops 조각으로 나눈다: 녹지 아님(분류 0)과 위 판에 덮이는 부분은
 * 판 정의에 바로, 분류 1 ~ 6 은 분류별 하위 그룹("녹지-<이름>", 정의 → 판 정의 안에 배치, 면에 분류 재질, 사전 "asrbbt" 에 OSM 출처)으로.
 * 조각들은 꼭짓점을 공유해 겹치지 않고 합치면 원래 윗면이다. 아랫면·옆면은 그대로라 판 정의와 하위 그룹을 합친 면은 닫혀 있다.
 *
 * @param progress 이 레이어 안의 진행률(0 ~ 1). 앞 절반은 판 변환, 뒤 절반은 면 쓰기
 * @returns 건너뛴(면 생성이 실패한) 면 수
 */
const addTerrainSlabs = (
    builder: Builder,
    mesh: TinMesh,
    step: number,
    progress: (ratio: number) => void,
    green?: { ranges: GreenFaceRange[]; info: GreenExport; materials: Map<number, number> },
) => {
    const started = performance.now()
    const classes = green ? tagsOfRanges(green.ranges, Math.floor(mesh.indices.length / 3)) : undefined
    const result = buildTerrainSlabs(mesh, step, (done, all) => progress(0.5 * (done / all)), classes)
    const converted = performance.now()
    // 다각형이 없는 판은 정의를 만들 수 없다(openskp 가 빈 정의를 거부한다). 정상이면 없지만 보호한다
    const bands = result.slabs.filter((s) => s.polygons.length > 0)
    const pt = (p: P2, z: number): Point3 => [p[0] * INCH_PER_METER, p[1] * INCH_PER_METER, z * INCH_PER_METER]
    const ringPts = (ring: P2[], z: number, reverse: boolean) => (reverse ? [...ring].reverse() : ring).map((p) => pt(p, z))

    let faces = 0
    let skipped = 0
    /** 분류 이름 → 하위 그룹 수(콘솔 요약) */
    const greenCounts = new Map<string, number>()
    const defs = bands.map((band, i) => {
        /** 윗면 다각형들을 def 에 넣는다(지금 윗면과 같은 면 옵션 + 재질) */
        const addTops = (def: Pick<GroupBuilder, "addFace">, polygons: SlabPolygon[], material?: number) => {
            for (const { outer, holes } of polygons) {
                try {
                    def.addFace(ringPts(outer, band.zTop, false), {
                        ...(holes.length > 0 ? { holes: holes.map((h) => ringPts(h, band.zTop, false)) } : {}),
                        ...(material !== undefined ? { material } : {}),
                    })
                    faces++
                } catch {
                    skipped++
                }
            }
        }
        // 하위 그룹 정의는 판 정의보다 먼저 닫혀 있어야 판 정의 안에 놓을 수 있다
        const subGroups = (band.tops ?? [])
            .filter((top) => top.cls > 0)
            .map((top) => {
                const c = green!.info.classes[top.cls - 1]
                const name = c?.name ?? `녹지-${top.cls}`
                greenCounts.set(name, (greenCounts.get(name) ?? 0) + 1)
                const def = builder.addComponentDefinition(`${name}-${band.zTop}m`, (def) => addTops(def, top.polygons, green!.materials.get(top.cls)))
                return { def, name }
            })
        const def = builder.addComponentDefinition(`terrain-${band.zTop}m`, (def) => {
            const face = (points: Point3[], holes?: Point3[][]) => {
                try {
                    def.addFace(points, holes && holes.length > 0 ? { holes } : undefined)
                    faces++
                } catch {
                    skipped++
                }
            }
            if (band.tops) for (const top of band.tops) if (top.cls <= 0) addTops(def, top.polygons)
            for (const { def: sub, name } of subGroups) def.addGroupInstance(sub, { name, attributes: green!.info.source, attributeDictName: "asrbbt" })
            for (const { outer, holes } of band.polygons) {
                if (!band.tops)
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
        { name: "terrain", ...ATTRIBUTION_ATTRS },
    )

    const polygons = bands.reduce((s, b) => s + b.polygons.length, 0)
    const holes = bands.reduce((s, b) => s + b.polygons.reduce((t, p) => t + p.holes.length, 0), 0)
    const tops = bands.reduce((s, b) => s + (b.tops?.reduce((t, top) => t + top.polygons.length, 0) ?? 0), 0)
    console.log(
        `SKP 계단형(${step}m): 판 ${bands.length}개, 다각형 ${polygons}개(구멍 ${holes}개), ` +
            (green ? `윗면 조각 ${tops}개(녹지 하위 그룹 ${[...greenCounts].map(([n, c]) => `${n} ${c}`).join(" · ") || "없음"}), ` : "") +
            `면 ${faces}개, 판 변환 ${Math.round(converted - started)}ms + 면 쓰기 ${Math.round(performance.now() - converted)}ms`,
    )
    if (result.openChains || result.emptyRings || result.orphanHoles) {
        console.warn(
            `SKP 계단형: 안 닫힌 사슬 ${result.openChains}개, 빈 고리 ${result.emptyRings}개, 외곽 없는 구멍 ${result.orphanHoles}개 버림`,
        )
    }
    const td = result.topsDropped
    if (td && (td.openChains || td.emptyRings || td.orphanHoles)) {
        console.warn(`SKP 계단형 윗면 조각: 안 닫힌 사슬 ${td.openChains}개, 빈 고리 ${td.emptyRings}개, 외곽 없는 구멍 ${td.orphanHoles}개 버림`)
    }
    return skipped
}

/**
 * 매끈한 면 지형을 녹지 분류로 나눠 "terrain" 그룹에 넣는다(docs/osm-green-layer-plan.md G5, 결정 G1 b-2). 녹지 아닌 삼각형은 지금처럼 그룹에 바로
 * (재질 없음), 분류마다 하위 그룹 "녹지-<이름>"(정의 → 배치, 건물·도로와 같은 구조)에 넣고 면에 그 분류 재질(색상표 원색)을 칠한다. 하위 그룹의
 * 속성 사전 "asrbbt" 에 OSM 출처(source·source_url·license)를 적는다(ODbL: 결과물에 출처 표시). 재질은 openskp 규칙대로 메인 루프 시작 전에
 * 등록해 둔 것(materials)을 쓴다. 면은 soft·smooth(지형 tin 과 같음). 그룹이 갈려 분류 경계에서는 SketchUp 의 매끈한 음영이 이어지지 않는다
 *
 * @returns 건너뛴 면 수
 */
const addGreenTerrain = (
    builder: Builder,
    mesh: TinMesh,
    ranges: GreenFaceRange[],
    green: GreenExport,
    materials: Map<number, number>,
    progress: (ratio: number) => void,
) => {
    const started = performance.now()
    const options: FaceOptions = { softEdges: true, smoothEdges: true }
    const total = Math.max(1, mesh.indices.length / 3)
    let done = 0
    let skipped = 0
    const byClass = rangesByClass(ranges)
    const defs: { def: ReturnType<Builder["addComponentDefinition"]>; name: string }[] = []
    const counts: string[] = []
    for (const [cls, rs] of byClass) {
        if (cls === 0) continue
        const c = green.classes[cls - 1]
        const name = c?.name ?? `녹지-${cls}`
        const indices = indicesOfRanges(mesh.indices, rs)
        defs.push({
            name,
            def: builder.addComponentDefinition(name, (def) => {
                skipped += addTriangles(def, mesh.positions, indices, { ...options, material: materials.get(cls) })
            }),
        })
        done += indices.length / 3
        counts.push(`${name} ${(indices.length / 3).toLocaleString()}`)
        progress(done / total)
    }
    const plain = byClass.get(0)
    builder.addGroup(
        (group) => {
            if (plain) skipped += addTriangles(group, mesh.positions, indicesOfRanges(mesh.indices, plain), options)
            for (const { def, name } of defs) group.addGroupInstance(def, { name, attributes: green.source, attributeDictName: "asrbbt" })
        },
        { name: "terrain", ...ATTRIBUTION_ATTRS },
    )
    progress(1)
    console.log(`SKP 지형 녹지: 하위 그룹 ${defs.length}개(${counts.join(" · ")}), ${Math.round(performance.now() - started)}ms`)
    return skipped
}

/**
 * 건물 레이어를 "건물마다 지붕·바닥·벽 면으로 닫은 그룹" 들을 모은 "buildings" 그룹으로 넣는다. SketchUp 에서 footprint 를
 * 건물 높이만큼 push 한 것과 같은 구조라, 건물 하나를 골라 옮기거나 지울 수 있다. 모든 변은 hard 다.
 *
 * 건물 k 의 고리는 건물 표에서 꺼낸다(buildingRings: mm 원본 좌표, 외곽 반시계·구멍 시계로 맞춤). 바닥 z 는 표의 바닥 높이에서
 * WALL_SINK_M 만큼 묻힌 높이(메쉬의 아래 고리와 같다), 지붕 z 는 바닥 높이 + 세운 높이다. 지붕은 그대로, 바닥은 뒤집어 넣고,
 * 벽은 영역을 왼쪽에 두고 걷는 변 p→q 에 [p아래, q아래, q위, p위] 로 넣어 바깥을 향하게 한다(addTerrainSlabs 와 같은 규칙).
 * 건물마다 일반 그룹이다: 이름은 "용도 (층수F, 높이m)"(buildingLabel), 그룹의 attribute dictionary "asrbbt" 에 건물 속성(buildingAttributes)을
 * 적는다. openskp 는 중첩 그룹을 "정의를 만든 뒤 addGroupInstance 로 놓기" 로만 지원하므로 정의를 거치지만(SKP 형식은 모든 그룹이 내부
 * 정의를 하나 갖는다. 최상위 addGroup 도 같다), 정의 이름은 그룹 이름과 같게 두고 속성은 정의가 아니라 그룹 배치에 붙인다
 * (2026-10-15 결정 by @nanangqq: 배경 건물은 재사용할 컴포넌트가 아니므로 일반 그룹 + 그룹 속성. 전에는 정의 "building-번호" 에 속성을 붙여
 * SketchUp 에서 그룹을 골라도 속성이 안 보이고 openskp 로도 읽히지 않았다). 지형 밖이라 못 세운 건물은 넣지 않는다. 면 생성이 실패한
 * (점이 겹치거나 일직선인) 면은 건너뛴다.
 *
 * @param progress 이 레이어 안의 진행률(0 ~ 1)
 * @returns 건너뛴 면 수
 */
const addBuildingGroups = (builder: Builder, table: BuildingTable, progress: (ratio: number) => void) => {
    const started = performance.now()
    const pt = (p: P2, z: number): Point3 => [p[0] * INCH_PER_METER, p[1] * INCH_PER_METER, z * INCH_PER_METER]
    let faces = 0
    let skipped = 0
    const defs: ReturnType<Builder["addComponentDefinition"]>[] = []
    const names: string[] = []
    const attributes: ReturnType<typeof buildingAttributes>[] = []
    for (let k = 0; k < table.count; k++) {
        if (table.vertexBase[k] === NOT_BUILT) continue
        const rings = buildingRings(table, k)
        if (rings.length === 0) continue
        const zBottom = table.baseZ[k] - WALL_SINK_M
        const zTop = table.baseZ[k] + table.builtHeight[k]
        const groupName = buildingLabel(table, k)
        names.push(groupName)
        attributes.push(buildingAttributes(table, k))
        defs.push(
            builder.addComponentDefinition(
                groupName,
                (def) => {
                    const face = (points: Point3[], holes?: Point3[][]) => {
                        try {
                            def.addFace(points, holes && holes.length > 0 ? { holes } : undefined)
                            faces++
                        } catch {
                            skipped++
                        }
                    }
                    const [outer, ...holes] = rings
                    face(
                        outer.map((p) => pt(p, zTop)),
                        holes.map((h) => h.map((p) => pt(p, zTop))),
                    )
                    face(
                        [...outer].reverse().map((p) => pt(p, zBottom)),
                        holes.map((h) => [...h].reverse().map((p) => pt(p, zBottom))),
                    )
                    for (const ring of rings) {
                        for (let j = 0; j < ring.length; j++) {
                            const p = ring[j], q = ring[(j + 1) % ring.length]
                            face([pt(p, zBottom), pt(q, zBottom), pt(q, zTop), pt(p, zTop)])
                        }
                    }
                },
            ),
        )
        if (k % 500 === 499) progress((k + 1) / table.count)
    }
    builder.addGroup(
        (group) => {
            defs.forEach((def, i) => group.addGroupInstance(def, { name: names[i], attributes: attributes[i], attributeDictName: "asrbbt" }))
        },
        { name: "buildings", ...ATTRIBUTION_ATTRS },
    )
    progress(1)
    console.log(`SKP 건물: ${defs.length}동, 면 ${faces}개, ${Math.round(performance.now() - started)}ms`)
    return skipped
}

/**
 * 도로 레이어를 "이은 중심선마다 삼각형 면 그룹" 들을 모은 "roads" 그룹으로 넣는다(2026-10-19 결정 by @nanangqq: 그룹 단위는 lineId).
 * 그룹 이름은 "도로구분 (폭m, N차로, 교통시설)"(roadLabel), 그룹의 attribute dictionary "asrbbt" 에 속성(roadAttributes). 띄움(과 지형이
 * 계단형이면 같은 계단화)은 roadGroupExportChunks 가 한다. 면은 soft 만 두어 선은 숨기되 평면 음영은 유지한다. 건물과 같은 "정의 → 배치" 구조
 *
 * @returns 건너뛴 면 수
 */
const addRoadGroups = (
    builder: Builder,
    mesh: TinMesh,
    table: RoadTable,
    mode: TerrainMode,
    step: number,
    zAt: ((x: number, y: number) => number | null) | null,
    progress: (ratio: number) => void,
) => {
    const started = performance.now()
    let skipped = 0
    const groups = roadGroups(table)
    const defs: ReturnType<Builder["addComponentDefinition"]>[] = []
    const names: string[] = []
    const attributes: ReturnType<typeof roadAttributes>[] = []
    groups.forEach((g, i) => {
        const chunks = roadGroupExportChunks(mesh, table, g, mode, step, STEPPED_CHUNK_BYTES, zAt)
        if (chunks.every((c) => c.indices.length === 0)) return
        const name = roadLabel(table, g.k0)
        names.push(name)
        attributes.push(roadAttributes(table, g.k0, g.k1))
        defs.push(
            builder.addComponentDefinition(name, (def) => {
                // 매끈한 면이면 지형 tin 과 같이 soft + smooth(SketchUp 이 음영을 매끄럽게), 계단형은 평면이라 soft 만
                for (const c of chunks) skipped += addTriangles(def, c.positions, c.indices, mode === "tin" ? { softEdges: true, smoothEdges: true } : { softEdges: true })
            }),
        )
        if (i % 200 === 199) progress((i + 1) / groups.length)
    })
    builder.addGroup(
        (group) => {
            defs.forEach((def, i) => group.addGroupInstance(def, { name: names[i], attributes: attributes[i], attributeDictName: "asrbbt" }))
        },
        { name: "roads", ...ATTRIBUTION_ATTRS },
    )
    progress(1)
    console.log(`SKP 도로: ${defs.length}구간, ${Math.round(performance.now() - started)}ms`)
    return skipped
}

/**
 * 물 레이어를 "수역(또는 하천선)마다 삼각형 면 그룹" 들을 모은 "water" 그룹으로 넣는다(2026-10-22 결정 D5 by @nanangqq: 그룹 단위는 수역, 선택 범위로
 * 자른 것만). 그룹 이름은 수역 이름(waterLabel), 속성 사전 "asrbbt" 에 속성(waterAttributes). 여러 도엽의 조각은 weld 해 한 메쉬로(waterGroupExportChunks)
 *
 * @returns 건너뛴 면 수
 */
const addWaterGroups = (builder: Builder, mesh: TinMesh, table: WaterTable, progress: (ratio: number) => void) => {
    const started = performance.now()
    let skipped = 0
    const groups = waterGroups(table)
    const defs: ReturnType<Builder["addComponentDefinition"]>[] = []
    const names: string[] = []
    const attributes: ReturnType<typeof waterAttributes>[] = []
    groups.forEach((g, i) => {
        const chunks = waterGroupExportChunks(mesh, g)
        if (chunks.every((c) => c.indices.length === 0)) return
        const name = waterLabel(table, g.k0)
        names.push(name)
        attributes.push(waterAttributes(table, g))
        defs.push(
            builder.addComponentDefinition(name, (def) => {
                // 수면은 평면이라 soft + smooth(선은 숨기고 음영은 매끄럽게)
                for (const c of chunks) skipped += addTriangles(def, c.positions, c.indices, { softEdges: true, smoothEdges: true })
            }),
        )
        if (i % 200 === 199) progress((i + 1) / groups.length)
    })
    builder.addGroup(
        (group) => {
            defs.forEach((def, i) => group.addGroupInstance(def, { name: names[i], attributes: attributes[i], attributeDictName: "asrbbt" }))
        },
        { name: "water", ...ATTRIBUTION_ATTRS },
    )
    progress(1)
    console.log(`SKP 물: ${defs.length}수역, ${Math.round(performance.now() - started)}ms`)
    return skipped
}

/**
 * openskp(SDK 없이 .skp 를 쓰는 라이브러리)로 레이어들을 SketchUp 2017 포맷 파일 하나로 만든다. 메인 스레드 밖에서 돈다.
 *
 * LAYER_DEFS 순서로 레이어마다 그룹(레이어 id 이름)을 하나씩 둔다. 지형 tin 은 삼각형 면을 soft·smooth 로 두어 SketchUp 이
 * 선을 숨기고 음영을 매끄럽게 하고, 지형 stepped 는 레벨마다 쌓는 판 그룹(addTerrainSlabs), 건물은 표(table)가 있으면 건물마다 면 그룹
 * (addBuildingGroups), 그 밖의 레이어(또는 표 없는 건물)는 삼각형 면을 soft 만 두어 선은 숨기되 평면 음영은 유지한다.
 * 진행률은 레이어의 원본 삼각형 수로 가중해 0 ~ 1 로 낸다. 취소는 메인에서 terminate 로 한다(요청마다 Worker 를 새로 만든다).
 * 오류는 메인의 worker.onerror 로 전달된다.
 */
self.onmessage = (e: MessageEvent<SkpExportRequest>) => {
    const { layers, mode, step, green } = e.data
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
    // 녹지(매끈한 면은 지형 그룹, 계단형은 판 윗면을 분류로 나눔): openskp 는 재질을 모든 정의·그룹보다 먼저 등록해야 하므로 여기서 분류 재질을 만든다
    const greenRanges = green ? layers.terrain?.greenRanges : undefined
    const greenMaterials = new Map<number, number>()
    if (greenRanges) {
        for (const cls of rangesByClass(greenRanges).keys()) {
            const c = green!.classes[cls - 1]
            if (cls > 0 && c) greenMaterials.set(cls, builder.addMaterial(c.name, c.rgb))
        }
    }
    let skipped = 0
    for (const { id } of LAYER_DEFS) {
        const mesh: ExportMesh | null = layers[id]
        if (!mesh) continue
        const w = weight(mesh)
        if (id === "terrain" && mode === "stepped") {
            const g = greenRanges ? { ranges: greenRanges, info: green!, materials: greenMaterials } : undefined
            skipped += addTerrainSlabs(builder, mesh, step, (ratio) => progress(ratio, w), g)
        } else if (id === "terrain" && greenRanges) {
            skipped += addGreenTerrain(builder, mesh, greenRanges, green!, greenMaterials, (ratio) => progress(ratio, w))
        } else if (id === "buildings" && mesh.table) {
            skipped += addBuildingGroups(builder, mesh.table, (ratio) => progress(ratio, w))
        } else if (id === "roads" && mesh.roadTable) {
            skipped += addRoadGroups(builder, mesh, mesh.roadTable, mode, step, roadExportSampler(layers.terrain), (ratio) => progress(ratio, w))
        } else if (id === "water" && mesh.waterTable) {
            skipped += addWaterGroups(builder, mesh, mesh.waterTable, (ratio) => progress(ratio, w))
        } else {
            const options: FaceOptions = id === "terrain" ? { softEdges: true, smoothEdges: true } : { softEdges: true }
            builder.addGroup((def) => void (skipped += addPlain(def, mesh, options)), { name: id, ...ATTRIBUTION_ATTRS })
        }
        doneBefore += w
    }
    if (skipped > 0) console.warn(`SKP: 넓이 0 등으로 건너뛴 면 ${skipped}개`)
    // toBytes 가 돌려주는 Uint8Array 는 더 큰 버퍼의 일부일 수 있으므로 정확한 길이만 복사해 넘긴다
    const bytes = builder.toBytes()
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    post({ type: "done", buffer }, [buffer])
}
