import { createTerrainSampler, TerrainSampler } from "./terrainSampler"
import { compactTriangles, createDrapeBuilder, liftMesh, liftSteppedChunk, ribbonQuads, ringArea2 } from "./terrainDrape"
import type { RoadCodeTable, RoadFace, RoadLine } from "./roadsData"
import {
    createRoadTable,
    isElevated,
    isUnderground,
    NOT_BUILT,
    ROAD_KIND,
    ROAD_LINE_FLAG,
    RoadCodeNames,
    RoadGroup,
    RoadRow,
    RoadTable,
} from "./roadTable"
import { MeshChunk, TinMesh } from "./terrainData"
import { buildSteppedMeshChunks } from "./terrainSteps"

/**
 * 도로 조각을 지형 위에 얹어 메쉬 하나로 만든다(docs/roads-layer-plan.md 2.1절, 2026-10-19 결정 A + B by @nanangqq).
 *
 * 도로 자료는 2D 라 높이는 전부 지형에서 가져온다. 지형 TIN 은 삼각형 안에서 평면이고 변에서만 꺾이므로 도로 면이 그 변마다 같이 꺾이면
 * 지형에 정확히 얹힌다:
 * - A. 조각의 변마다 지형 삼각형 변과의 교점(2D 선분 교차)을 끼워 넣는다(subdivideRing) → 가장자리가 지형을 따라 꺾인다.
 * - B. earcut 로 만든 도로 삼각형을 그 아래 지형 삼각형들로 자른다(clipConvex, Sutherland–Hodgman) → 조각마다 지형 삼각형 하나 위의 평면
 *   조각이 되어 안쪽까지 정확히 얹힌다. z 는 그 지형 삼각형 평면에서.
 * 교량·고가(tfceqp 5·2)는 지형을 따라가면 강·계곡으로 꺼지므로, 조각의 lineId 선(교통시설이 바뀌는 곳에서 끊겨 양끝이 지반 접점)의
 * 양끝 지형 z 를 직선으로 잇고 꼭짓점을 선에 투영한 호 길이 비례 위치의 z 를 쓴다. 터널·지하차도(6·3)는 그리지 않는다(터널 구간에도 면
 * 조각이 있어 얹으면 산 위로 도로가 그려진다). 면 밖 선(소로·면리간, flags bit3)은 폭만큼 띠로 만들어 같은 길을 탄다.
 *
 * 결과 메쉬는 **지형과 같은 평면에 놓인 값 그대로**(띄움 없음)다. 띄움(ROAD_LIFT_M)은 화면 조각(roadDisplayChunks)과 내보내기가 더한다.
 * 계단형 표현(roadDisplayChunks stepped)은 띄우지 않은 메쉬를 지형과 같은 규칙으로 계단화해야 판·벽이 지형 것과 맞기 때문이다.
 *
 * 표(RoadTable)의 행은 이은 중심선(lineId) 순이고 메쉬도 그 순서로 얹으므로 같은 선의 조각이 삼각형 범위로 이어진다(내보내기 그룹).
 *
 * A·B·띠·띄움·계단 벽 밀기 같은 기하는 2026-10-22 물 레이어와 같이 쓰려고 terrainDrape.ts 로 옮겼다(동작은 같다)
 */

/** 도로를 지형 위로 띄우는 높이(m). 화면은 depthBias 와 함께, 내보내기는 이것만으로 지형과의 겹침을 막는다. 디버그 roadsLift= */
export const ROAD_LIFT_M = 0.1
/** 두 층 일반차도의 위층(phyLv > 0, 교량·고가 아님)을 층마다 더 띄우는 높이(m). 겹친 두 면이 갈리게 하는 값이라 Chrome 비교로 정한다 */
export const ROAD_LEVEL_GAP_M = 0.5
/** 면 밖 선의 폭이 0 일 때 띠 폭(m) */
export const RIBBON_DEFAULT_WIDTH_M = 2

export type RoadsBuildOptions = {
    /** false 면 B(지형 삼각형으로 자르기)를 끄고 꼭짓점에서만 높이를 읽는다(디버그 roadsclip=0: 넓은 조각의 묻힘이 보여야 한다) */
    clip?: boolean
    /** false 면 교량·고가도 지형을 따라간다(디버그 roadsbridge=0: 강·계곡으로 꺼지는 것이 보여야 한다) */
    bridge?: boolean
    /** 두 층 일반차도의 층 간격(m). 없으면 ROAD_LEVEL_GAP_M */
    levelGap?: number
    /**
     * 도엽 폴리곤(원점 기준 m, 볼록). 주면 도로 삼각형을 이 안으로 자른다(지형 도엽과 같은 경계. 2026-10-19 지적 by @nanangqq: 높이 기준인 이웃 합친
     * 지형이 도엽 밖 약 100 m 까지 있어 조각이 그만큼 튀어나갔다). 경계에 걸친 조각은 양쪽 도엽이 각자 자기 부분만 얹는다
     */
    clipTo?: [number, number][]
    /**
     * 지형 정점의 부드러운 법선(terrain.positions 와 같은 길이. meshNormals smoothVertexNormals). 주면 B 에서 높이와 같은 무게중심 가중치로
     * 보간해 도로 정점 법선으로 내고, 화면은 매끈한 지형과 같은 셰이더(정점 법선 보간)로 그린다. 2026-10-19 지적 by @nanangqq: 면 법선(화면 미분)으로
     * 그리면 도로 조각이 지형 삼각형 하나 위에 놓이므로 지형의 삼각형 구조가 도로에서만 각지게 드러났다. 없으면 (0, 0, 1)
     */
    terrainNormals?: Float32Array
}

/** 도로 메쉬: 지형 TinMesh + 정점 법선(지형의 부드러운 법선을 보간한 것. 매끈한 면 모드의 화면 조각이 쓴다) */
export type RoadMesh = TinMesh & { normals: Float32Array }

export type RoadsBuildResult = {
    /** 지형과 같은 원점. 띄움 없음(위 설명) */
    mesh: RoadMesh
    table: RoadTable
    /** 얹은 행 수(조각 + 띠) */
    built: number
    /** 그중 교량·고가로 선 보간한 수 */
    bridges: number
    /** 터널·지하차도라 그리지 않은 수 */
    hidden: number
    /** 지형 밖(지형 구멍)이라 못 얹은 수 */
    skipped: number
    /** 지형 bbox 와 겹치지 않아 표에서 뺀 수 */
    outside: number
    /** 면 밖 선 띠 행 수(built 에 포함) */
    ribbons: number
    /** 이 메쉬를 만든 지형 조회기(계단형 변환의 벽 방향 판정에 다시 쓴다) */
    sampler: TerrainSampler
}

/**
 * 얹을 단위 하나: 조각 또는 면 밖 선의 띠. polys 는 m 단위 평면 다각형 목록이고 다각형 하나는 고리들(외곽 → 구멍, 닫는 점 없음).
 * 조각은 다각형 하나(구멍 포함), 띠는 선분마다 사각형 하나(긴 고리 하나로 두면 earcut 가 낸 길고 가는 삼각형의 bbox 가 커서 B 의
 * 클리핑이 지형 삼각형 수백 개를 훑었다. 2026-10-19 남산 등산로에서 도엽당 3초)
 */
type Unit = { row: RoadRow; polys: number[][][]; facility: number; lineId: number }

/**
 * 조각·선을 지형 위에 얹어 메쉬 하나와 표를 만든다.
 *
 * @param faces 공통 원점 mm 좌표의 조각들
 * @param lines 같은 원점의 선들(교량 보간의 lineId 조회, 면 밖 선 띠)
 * @param terrain 같은 원점의 지형 메쉬(이웃까지 합친 것)
 * @param codes codes.json 이름 표(표에 실어 내보내기 속성에 쓴다)
 * @param options 디버그 스위치(clip·bridge)와 층 간격
 */
export const buildRoadsMesh = (
    faces: RoadFace[],
    lines: RoadLine[],
    terrain: TinMesh,
    codes: RoadCodeTable | RoadCodeNames,
    options: RoadsBuildOptions = {},
): RoadsBuildResult => {
    const builder = createDrapeBuilder(terrain, { clip: options.clip, clipTo: options.clipTo, terrainNormals: options.terrainNormals })
    const { sampler, boundTris, triangulate, pushTri } = builder
    const P = terrain.positions
    const bridge = options.bridge !== false
    const levelGap = options.levelGap ?? ROAD_LEVEL_GAP_M
    const lineById = new Map<number, RoadLine>()
    for (const l of lines) lineById.set(l.id, l)
    /**
     * 2026-10-19 확인: 서버 자료의 조각 lineId(1만 ~ 10만대)가 선 id(170만 ~ 620만대)와 하나도 맞지 않는다(표본 3개 모두 0 %. 서버에 질의).
     * 그래서 교량·고가는 id 로 못 찾으면 같은 교통시설의 선 중 조각 무게중심에서 가장 가까운 선을 기하로 고른다(폭의 절반 + 2 m 안).
     * 서버가 고치면 id 경로가 먼저 맞아 이 대체는 쓰이지 않는다
     */
    const elevatedLines = lines.filter((l) => isElevated(l.tfceqp))
    const distanceToLine = (l: RoadLine, x: number, y: number) => {
        let best = Infinity
        for (let i = 0; i + 2 < l.xy.length; i += 2) {
            const ax = l.xy[i] / 1000, ay = l.xy[i + 1] / 1000, bx = l.xy[i + 2] / 1000, by = l.xy[i + 3] / 1000
            const dx = bx - ax, dy = by - ay
            const len2 = dx * dx + dy * dy
            const u = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0
            best = Math.min(best, Math.hypot(ax + dx * u - x, ay + dy * u - y))
        }
        return best
    }
    const findElevatedLine = (u: Unit): RoadLine | undefined => {
        const byId = lineById.get(u.lineId)
        if (byId) return byId
        const outer = u.polys[0][0]
        let cx = 0, cy = 0
        const n = outer.length / 2
        for (let i = 0; i < outer.length; i += 2) {
            cx += outer[i] / n
            cy += outer[i + 1] / n
        }
        const limit = Math.max(u.row.roadBt / 2, 1) + 2
        let best: RoadLine | undefined, bestD = limit
        for (const l of elevatedLines) {
            const d = distanceToLine(l, cx, cy)
            if (d < bestD) {
                bestD = d
                best = l
            }
        }
        return best
    }

    // 지형 bbox(m)에 걸치는 단위만
    let tx0 = Infinity, ty0 = Infinity, tx1 = -Infinity, ty1 = -Infinity
    for (let i = 0; i < P.length; i += 3) {
        tx0 = Math.min(tx0, P[i]); tx1 = Math.max(tx1, P[i])
        ty0 = Math.min(ty0, P[i + 1]); ty1 = Math.max(ty1, P[i + 1])
    }
    const overlaps = (polys: number[][][]) => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
        for (const rings of polys) {
            for (const r of rings) {
                for (let i = 0; i < r.length; i += 2) {
                    x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i])
                    y0 = Math.min(y0, r[i + 1]); y1 = Math.max(y1, r[i + 1])
                }
            }
        }
        return x1 >= tx0 && x0 <= tx1 && y1 >= ty0 && y0 <= ty1
    }

    const units: Unit[] = []
    let outside = 0
    for (const f of faces) {
        const n = f.xy.length / 2
        const holesTotal = f.holes.reduce((s, h) => s + h, 0)
        const outerN = n - holesTotal
        if (outerN < 3) continue
        const rings: number[][] = []
        let start = 0
        for (const len of [outerN, ...f.holes]) {
            const r: number[] = []
            for (let i = start; i < start + len; i++) r.push(f.xy[2 * i] / 1000, f.xy[2 * i + 1] / 1000)
            rings.push(r)
            start += len
        }
        if (!overlaps([rings])) {
            outside++
            continue
        }
        const line = lineById.get(f.lineId)
        units.push({
            row: {
                id: f.id, lineId: f.lineId, kind: ROAD_KIND.face, roadSe: f.roadSe, roadBt: f.roadBt, cartrk: f.cartrk,
                facility: f.tfceqp, phyLv: f.phyLv, pavement: line?.pmtr ?? 0, status: line?.usgstt ?? 0, flags: f.flags,
            },
            polys: [rings],
            facility: f.tfceqp,
            lineId: f.lineId,
        })
    }
    for (const l of lines) {
        if (!(l.flags & ROAD_LINE_FLAG.outsideFace)) continue
        const quads = ribbonQuads(l.xy, l.roadBt > 0 ? l.roadBt : RIBBON_DEFAULT_WIDTH_M)
        if (quads.length === 0) continue
        const polys = quads.map((q) => [q])
        if (!overlaps(polys)) {
            outside++
            continue
        }
        units.push({
            row: {
                id: l.id, lineId: l.id, kind: ROAD_KIND.ribbon, roadSe: l.roadSe, roadBt: l.roadBt, cartrk: l.cartrk,
                facility: l.tfceqp, phyLv: l.phyLv, pavement: l.pmtr, status: l.usgstt, flags: l.flags,
            },
            polys,
            facility: l.tfceqp,
            lineId: l.id,
        })
    }
    // 이은 중심선 순 → 같은 선의 조각이 메쉬에서 이어진다(내보내기 그룹)
    units.sort((a, b) => a.lineId - b.lineId || a.row.id - b.row.id)
    const table = createRoadTable(units.map((u) => u.row), codes)

    let built = 0, bridges = 0, hidden = 0, skipped = 0, ribbons = 0

    /**
     * 교량·고가: 선의 양끝 지형 z 를 직선으로 잇고 꼭짓점을 선에 투영한 호 길이 비례 z. 양끝이 지형 밖이면 null(호출자가 드레이프로)
     */
    const elevate = (polys: number[][][], line: RoadLine) => {
        const pts: number[] = []
        for (let i = 0; i < line.xy.length; i += 2) pts.push(line.xy[i] / 1000, line.xy[i + 1] / 1000)
        const n = pts.length / 2
        if (n < 2) return null
        const cum = [0]
        for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]))
        const total = cum[n - 1]
        if (total < 1e-6) return null
        const z0 = sampler(pts[0], pts[1]), z1 = sampler(pts[2 * n - 2], pts[2 * n - 1])
        if (z0 === null || z1 === null) return null
        const zAt = (x: number, y: number) => {
            let best = Infinity, s = 0
            for (let i = 0; i + 1 < n; i++) {
                const ax = pts[2 * i], ay = pts[2 * i + 1], bx = pts[2 * i + 2], by = pts[2 * i + 3]
                const dx = bx - ax, dy = by - ay
                const len2 = dx * dx + dy * dy
                const u = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0
                const d = Math.hypot(ax + dx * u - x, ay + dy * u - y)
                if (d < best) {
                    best = d
                    s = cum[i] + (cum[i + 1] - cum[i]) * u
                }
            }
            return z0 + ((z1 - z0) * s) / total
        }
        const before = builder.triangleCount()
        for (const rings of polys) {
            for (const tri of boundTris(triangulate(rings))) {
                pushTri(tri[0], tri[1], zAt(tri[0], tri[1]), tri[2], tri[3], zAt(tri[2], tri[3]), tri[4], tri[5], zAt(tri[4], tri[5]))
            }
        }
        return builder.triangleCount() - before
    }

    units.forEach((u, k) => {
        if (isUnderground(u.facility)) {
            hidden++
            return
        }
        const first = builder.triangleCount()
        let count = 0
        let elevated = false
        if (bridge && isElevated(u.facility)) {
            const line = u.row.kind === ROAD_KIND.ribbon ? lineById.get(u.lineId) : findElevatedLine(u)
            const n = line ? elevate(u.polys, line) : null
            if (n !== null) {
                count = n
                elevated = true
            }
        }
        if (!elevated) {
            const extra = !isElevated(u.facility) && u.row.phyLv > 0 ? u.row.phyLv * levelGap : 0
            count = builder.drape(u.polys, extra)
        }
        if (count === 0) {
            skipped++
            return
        }
        table.faceBase[k] = first
        table.faceCount[k] = count
        built++
        if (elevated) bridges++
        if (u.row.kind === ROAD_KIND.ribbon) ribbons++
    })

    return {
        mesh: builder.finish(),
        table,
        built,
        bridges,
        hidden,
        skipped,
        outside,
        ribbons,
        sampler,
    }
}

/** 띄움·계단 벽 밀기·조각 압축은 terrainDrape.ts 로 옮겼다(물 레이어와 공용). 기존 import 경로를 위해 다시 내보낸다 */
export { compactTriangles, liftMesh, liftSteppedChunk }

/**
 * 화면(또는 내보내기)용 도로 조각을 만든다. tin 이면 띄운 메쉬 하나, stepped 면 교량·고가가 아닌 삼각형을 지형과 같은 규칙으로 계단화한 뒤
 * 벽을 밀고 띄운 조각들 + 교량·고가 삼각형을 띄운 조각 하나.
 *
 * @param mesh buildRoadsMesh 의 메쉬(띄움 없음)
 * @param table 같은 결과의 표(교량·고가 행의 삼각형 범위를 빼는 데)
 * @param mode 지형 표현 방식
 * @param step stepped 일 때 층 간격(m)
 * @param lift 띄움(m)
 * @param maxBytes 계단형 조각 버퍼 상한
 * @param zAt 지형 높이 조회(벽 방향 판정). 없으면 벽을 옮기지 않는다
 */
export const roadDisplayChunks = (
    mesh: TinMesh & { normals?: Float32Array },
    table: RoadTable,
    mode: "tin" | "stepped",
    step: number,
    lift: number,
    maxBytes: number,
    zAt: ((x: number, y: number) => number | null) | null,
): MeshChunk[] => {
    if (mode !== "stepped" || step <= 0 || mesh.indices.length === 0) {
        // 매끈한 면: 지형에서 보간한 정점 법선을 같이 실어 지형과 같은 셰이더(법선 보간)로 그린다
        return [{ positions: liftMesh(mesh.positions, lift), indices: mesh.indices.slice(), normals: mesh.normals?.slice() }]
    }
    const elevatedTri = new Uint8Array(mesh.indices.length / 3)
    for (let k = 0; k < table.count; k++) {
        if (table.faceBase[k] === NOT_BUILT || !isElevated(table.facility[k])) continue
        elevatedTri.fill(1, table.faceBase[k], table.faceBase[k] + table.faceCount[k])
    }
    const plain: number[] = [], raised: number[] = []
    for (let t = 0; t < elevatedTri.length; t++) {
        (elevatedTri[t] ? raised : plain).push(mesh.indices[3 * t], mesh.indices[3 * t + 1], mesh.indices[3 * t + 2])
    }
    const chunks: MeshChunk[] = []
    if (plain.length > 0) {
        const stepped = buildSteppedMeshChunks({ origin: mesh.origin, positions: mesh.positions, indices: new Uint32Array(plain) }, step, maxBytes, undefined, { quiet: true })
        for (const c of stepped) chunks.push(liftSteppedChunk(c, lift, zAt))
    }
    if (raised.length > 0) chunks.push(compactTriangles(mesh.positions, new Uint32Array(raised), lift))
    return chunks
}

/** 내보내기의 벽 방향 판정용 지형 조회기. 지형 레이어가 파일에 없으면 null(벽을 옮기지 않는다) */
export const roadExportSampler = (terrain: TinMesh | null) => (terrain ? createTerrainSampler(terrain.positions, terrain.indices) : null)

/** 내보내기: 도로 레이어 전체를 띄움(과 계단화)한 조각들로(STL 처럼 그룹이 없는 형식) */
export const roadExportChunks = (
    mesh: TinMesh,
    table: RoadTable,
    mode: "tin" | "stepped",
    step: number,
    maxBytes: number,
    zAt: ((x: number, y: number) => number | null) | null,
) => roadDisplayChunks(mesh, table, mode, step, ROAD_LIFT_M, maxBytes, zAt)

/**
 * 내보내기: 그룹(같은 이은 중심선의 행들) 하나의 삼각형을 띄움(과 계단화)한 조각들로. 그룹의 행은 같은 선이라 교통시설이 같으므로
 * 첫 행으로 교량·고가를 가른다(교량은 계단화하지 않는다).
 *
 * @param normals 도로 메쉬 전체의 정점 법선(GLB 가 매끈한 면 지형처럼 넣을 때. 그룹별로 잘라 싣는다). 계단화한 조각은 평면이라 싣지 않는다
 */
export const roadGroupExportChunks = (
    mesh: TinMesh,
    table: RoadTable,
    group: RoadGroup,
    mode: "tin" | "stepped",
    step: number,
    maxBytes: number,
    zAt: ((x: number, y: number) => number | null) | null,
    normals?: Float32Array,
): MeshChunk[] => {
    const range = mesh.indices.subarray(3 * group.from, 3 * group.to)
    if (mode === "stepped" && step > 0 && !isElevated(table.facility[group.k0])) {
        const sub = compactTriangles(mesh.positions, range)
        const stepped = buildSteppedMeshChunks({ origin: mesh.origin, ...sub }, step, maxBytes, undefined, { quiet: true })
        return [...stepped].map((c) => liftSteppedChunk(c, ROAD_LIFT_M, zAt))
    }
    return [compactTriangles(mesh.positions, range, ROAD_LIFT_M, normals)]
}
