import earcut from "earcut"

import { createTerrainSampler, TerrainSampler } from "./terrainSampler"
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
 */

/** 도로를 지형 위로 띄우는 높이(m). 화면은 depthBias 와 함께, 내보내기는 이것만으로 지형과의 겹침을 막는다. 디버그 roadsLift= */
export const ROAD_LIFT_M = 0.1
/** 두 층 일반차도의 위층(phyLv > 0, 교량·고가 아님)을 층마다 더 띄우는 높이(m). 겹친 두 면이 갈리게 하는 값이라 Chrome 비교로 정한다 */
export const ROAD_LEVEL_GAP_M = 0.5
/** 면 밖 선의 폭이 0 일 때 띠 폭(m) */
export const RIBBON_DEFAULT_WIDTH_M = 2
/** 띠 모서리의 마이터 길이 상한(폭의 배수). 예각에서 모서리가 길게 뻗는 것을 막는다 */
const MITER_LIMIT = 2
/** B 에서 버리는 조각 넓이 하한(m²). 1 cm² */
const MIN_PIECE_AREA = 1e-4

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

const ringArea2 = (r: number[]) => {
    let s = 0
    const n = r.length / 2
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n
        s += r[2 * i] * r[2 * j + 1] - r[2 * j] * r[2 * i + 1]
    }
    return s
}

/**
 * 면 밖 선을 폭 w 의 띠로 만든다. 꼭짓점마다 양옆 선분의 법선 평균 방향으로 마이터(길이 w/2 ÷ cos(θ/2), 상한 MITER_LIMIT)를 두어
 * 모서리가 이어지게 하고, 선분마다 [오른쪽 i, 오른쪽 i+1, 왼쪽 i+1, 왼쪽 i] 사각형(반시계)을 낸다. 이웃 사각형은 마이터 점을 공유하므로
 * 틈·겹침이 없다. 점이 2개 미만이거나 길이가 0 이면 빈 배열
 */
const ribbonQuads = (xy: Int32Array, w: number): number[][] => {
    const pts: [number, number][] = []
    for (let i = 0; i < xy.length; i += 2) {
        const p: [number, number] = [xy[i] / 1000, xy[i + 1] / 1000]
        const last = pts[pts.length - 1]
        if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-3) pts.push(p)
    }
    const n = pts.length
    if (n < 2) return []
    const half = w / 2
    const left: number[] = [], right: number[] = []
    for (let i = 0; i < n; i++) {
        // 앞·뒤 선분의 단위 법선(왼쪽)
        const dirs: [number, number][] = []
        if (i > 0) dirs.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]])
        if (i + 1 < n) dirs.push([pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]])
        const normals = dirs.map(([dx, dy]) => {
            const len = Math.hypot(dx, dy)
            return [-dy / len, dx / len] as [number, number]
        })
        let nx = 0, ny = 0
        for (const [a, b] of normals) {
            nx += a
            ny += b
        }
        const len = Math.hypot(nx, ny)
        let ox: number, oy: number
        if (len < 1e-9) {
            // 180° 되돌아오는 꺾임: 첫 법선만
            ox = normals[0][0] * half
            oy = normals[0][1] * half
        } else {
            nx /= len
            ny /= len
            // 마이터 길이 = half / cos(θ/2). cos(θ/2) = 평균 법선과 한쪽 법선의 내적
            const cosHalf = Math.max(nx * normals[0][0] + ny * normals[0][1], 1 / MITER_LIMIT)
            ox = (nx * half) / cosHalf
            oy = (ny * half) / cosHalf
        }
        left.push(pts[i][0] + ox, pts[i][1] + oy)
        right.push(pts[i][0] - ox, pts[i][1] - oy)
    }
    const quads: number[][] = []
    for (let i = 0; i + 1 < n; i++) {
        const q = [right[2 * i], right[2 * i + 1], right[2 * i + 2], right[2 * i + 3], left[2 * i + 2], left[2 * i + 3], left[2 * i], left[2 * i + 1]]
        if (ringArea2(q) > 1e-6) quads.push(q)
    }
    return quads
}

/**
 * A: 고리의 변마다 지형 삼각형 변과의 교점을 끼워 넣는다. 변 p→q 가 지나는 격자 상자의 삼각형마다 세 변과의 교차 매개변수 t 를 모아
 * 정렬·중복 제거(1 mm 안)하고 그 자리에 점을 더한다. 지형 정점이 변 위에 있으면 양옆 변이 같은 t 를 주므로 중복 제거로 하나가 된다
 */
const subdivideRing = (ring: number[], sampler: TerrainSampler, P: Float32Array, I: Uint32Array): number[] => {
    const out: number[] = []
    const n = ring.length / 2
    const ts: number[] = []
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n
        const px = ring[2 * i], py = ring[2 * i + 1]
        const qx = ring[2 * j], qy = ring[2 * j + 1]
        out.push(px, py)
        const dx = qx - px, dy = qy - py
        const len = Math.hypot(dx, dy)
        if (len < 1e-6) continue
        ts.length = 0
        sampler.forTrianglesInBox(Math.min(px, qx), Math.min(py, qy), Math.max(px, qx), Math.max(py, qy), (t) => {
            for (let e = 0; e < 3; e++) {
                const a = I[3 * t + e] * 3, b = I[3 * t + ((e + 1) % 3)] * 3
                const ax = P[a], ay = P[a + 1], bx = P[b], by = P[b + 1]
                const ex = bx - ax, ey = by - ay
                const den = dx * ey - dy * ex
                if (Math.abs(den) < 1e-12) continue
                // p + s·d = a + u·e
                const s = ((ax - px) * ey - (ay - py) * ex) / den
                const u = ((ax - px) * dy - (ay - py) * dx) / den
                if (s <= 0 || s >= 1 || u < -1e-9 || u > 1 + 1e-9) continue
                ts.push(s)
            }
        })
        if (ts.length === 0) continue
        ts.sort((a, b) => a - b)
        let last = 0
        for (const s of ts) {
            if ((s - last) * len < 1e-3 || (1 - s) * len < 1e-3) continue
            out.push(px + dx * s, py + dy * s)
            last = s
        }
    }
    return out
}

/** 볼록 다각형(x, y 쌍)을 반시계 삼각형 (ax, ay, bx, by, cx, cy) 로 자른다(Sutherland–Hodgman). 결과는 x, y 쌍 */
const clipConvex = (poly: number[], ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number[] =>
    clipByEdges(poly, [
        [ax, ay, bx, by],
        [bx, by, cx, cy],
        [cx, cy, ax, ay],
    ])

/** 볼록 다각형(x, y 쌍)을 반시계 경계의 변 목록(각 변의 왼쪽이 안)으로 자른다(Sutherland–Hodgman) */
const clipByEdges = (poly: number[], edges: [number, number, number, number][]): number[] => {
    let input = poly
    for (const [ex0, ey0, ex1, ey1] of edges) {
        if (input.length < 6) return []
        const out: number[] = []
        const dx = ex1 - ex0, dy = ey1 - ey0
        const side = (x: number, y: number) => dx * (y - ey0) - dy * (x - ex0)
        const n = input.length / 2
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n
            const x0 = input[2 * i], y0 = input[2 * i + 1]
            const x1 = input[2 * j], y1 = input[2 * j + 1]
            const s0 = side(x0, y0), s1 = side(x1, y1)
            if (s0 >= 0) out.push(x0, y0)
            if ((s0 >= 0) !== (s1 >= 0)) {
                const t = s0 / (s0 - s1)
                out.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)
            }
        }
        input = out
    }
    return input
}

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
    const P = terrain.positions, I = terrain.indices
    const sampler = createTerrainSampler(P, I)
    const clip = options.clip !== false
    const bridge = options.bridge !== false
    const levelGap = options.levelGap ?? ROAD_LEVEL_GAP_M
    /** 도엽 폴리곤의 변(반시계로 맞춤). 없으면 자르지 않는다 */
    let boundaryEdges: [number, number, number, number][] | null = null
    if (options.clipTo && options.clipTo.length >= 3) {
        const pts = [...options.clipTo]
        let area2 = 0
        for (let i = 0; i < pts.length; i++) {
            const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length]
            area2 += x0 * y1 - x1 * y0
        }
        if (area2 < 0) pts.reverse()
        boundaryEdges = pts.map((p, i) => [p[0], p[1], pts[(i + 1) % pts.length][0], pts[(i + 1) % pts.length][1]])
    }
    /** 삼각형들을 도엽 폴리곤으로 잘라(볼록 조각 → 부채꼴) 삼각형 목록으로. 폴리곤이 없으면 그대로 */
    const boundTris = (tris: number[][]) => {
        if (!boundaryEdges) return tris
        const out: number[][] = []
        for (const tri of tris) {
            const p = clipByEdges(tri, boundaryEdges)
            const n = p.length / 2
            for (let i = 1; i + 1 < n; i++) {
                const piece = [p[0], p[1], p[2 * i], p[2 * i + 1], p[2 * i + 2], p[2 * i + 3]]
                if (Math.abs(ringArea2(piece)) >= 2e-8) out.push(piece)
            }
        }
        return out
    }
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

    const positions: number[] = []
    const normals: number[] = []
    const indices: number[] = []
    let built = 0, bridges = 0, hidden = 0, skipped = 0, ribbons = 0
    /** 좌표가 같은(0.1 mm 단위) 정점은 하나로. 이웃 지형 삼각형에서 각각 잘린 조각이 변의 점을 공유하므로 정점이 약 1/3 로 준다 */
    const vertexIds = new Map<string, number>()
    const vertexOf = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
        const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`
        let id = vertexIds.get(key)
        if (id === undefined) {
            id = positions.length / 3
            vertexIds.set(key, id)
            positions.push(x, y, z)
            normals.push(nx, ny, nz)
        }
        return id
    }
    const UP = [0, 0, 1, 0, 0, 1, 0, 0, 1]
    /**
     * 삼각형을 넣는다. n 은 세 꼭짓점의 법선(9개, 없으면 위 방향). 위를 향하도록(반시계) 하고, GPU·STL 이 보는 float32 좌표로 넓이를 재서
     * (건물 지붕과 같은 규칙) 1 cm² 미만은 버린다
     */
    const pushTri = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, n = UP) => {
        const f = Math.fround
        const area2 = (f(bx) - f(ax)) * (f(cy) - f(ay)) - (f(by) - f(ay)) * (f(cx) - f(ax))
        if (Math.abs(area2) < 2e-4) return
        const a = vertexOf(ax, ay, az, n[0], n[1], n[2]), b = vertexOf(bx, by, bz, n[3], n[4], n[5]), c = vertexOf(cx, cy, cz, n[6], n[7], n[8])
        if (a === b || b === c || a === c) return
        if (area2 > 0) indices.push(a, b, c)
        else indices.push(a, c, b)
    }

    const N = options.terrainNormals
    /** 지형 삼각형 t 의 평면에서 (x, y) 의 z 와(지형 법선이 있으면) 같은 가중치로 보간한 법선 [z, nx, ny, nz] */
    const planeAt = (t: number, x: number, y: number): [number, number, number, number] => {
        const a = I[3 * t] * 3, b = I[3 * t + 1] * 3, c = I[3 * t + 2] * 3
        const ax = P[a], ay = P[a + 1], bx = P[b], by = P[b + 1], cx = P[c], cy = P[c + 1]
        const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
        const l1 = ((bx - x) * (cy - y) - (cx - x) * (by - y)) / det
        const l2 = ((cx - x) * (ay - y) - (ax - x) * (cy - y)) / det
        const l3 = 1 - l1 - l2
        const z = l1 * P[a + 2] + l2 * P[b + 2] + l3 * P[c + 2]
        if (!N) return [z, 0, 0, 1]
        return [z, l1 * N[a] + l2 * N[b] + l3 * N[c], l1 * N[a + 1] + l2 * N[b + 1] + l3 * N[c + 1], l1 * N[a + 2] + l2 * N[b + 2] + l3 * N[c + 2]]
    }

    /** 평면 고리들을 earcut 로 삼각분할해 삼각형(x, y 쌍 셋) 목록으로 */
    const triangulate = (rings: number[][]) => {
        const flat: number[] = []
        const holeStarts: number[] = []
        for (const r of rings) {
            if (flat.length > 0) holeStarts.push(flat.length / 2)
            flat.push(...r)
        }
        const tris = earcut(flat, holeStarts.length ? holeStarts : undefined, 2)
        const out: number[][] = []
        for (let t = 0; t < tris.length; t += 3) {
            const a = tris[t], b = tris[t + 1], c = tris[t + 2]
            const tri = [flat[2 * a], flat[2 * a + 1], flat[2 * b], flat[2 * b + 1], flat[2 * c], flat[2 * c + 1]]
            if (ringArea2(tri) < 0) [tri[2], tri[3], tri[4], tri[5]] = [tri[4], tri[5], tri[2], tri[3]]
            if (Math.abs(ringArea2(tri)) < 2e-8) continue
            out.push(tri)
        }
        return out
    }

    /** 일반 드레이프: 다각형마다 A → earcut → B(또는 꼭짓점 높이 읽기). 넣은 삼각형 수 */
    const drape = (polys: number[][][], extraZ: number) => {
        const before = indices.length
        for (const rings of polys) drapePolygon(rings, extraZ)
        return (indices.length - before) / 3
    }
    const drapePolygon = (rings: number[][], extraZ: number) => {
        const prepared = clip ? rings.map((r) => subdivideRing(r, sampler, P, I)) : rings
        for (const tri of boundTris(triangulate(prepared))) {
            if (!clip) {
                const za = sampler(tri[0], tri[1]), zb = sampler(tri[2], tri[3]), zc = sampler(tri[4], tri[5])
                if (za === null || zb === null || zc === null) continue
                pushTri(tri[0], tri[1], za + extraZ, tri[2], tri[3], zb + extraZ, tri[4], tri[5], zc + extraZ)
                continue
            }
            const x0 = Math.min(tri[0], tri[2], tri[4]), x1 = Math.max(tri[0], tri[2], tri[4])
            const y0 = Math.min(tri[1], tri[3], tri[5]), y1 = Math.max(tri[1], tri[3], tri[5])
            sampler.forTrianglesInBox(x0, y0, x1, y1, (t) => {
                const a = I[3 * t] * 3, b = I[3 * t + 1] * 3, c = I[3 * t + 2] * 3
                let ax = P[a], ay = P[a + 1], bx = P[b], by = P[b + 1]
                const cx = P[c], cy = P[c + 1]
                // 지형 삼각형 bbox 가 안 겹치면 건너뜀
                if (Math.max(ax, bx, cx) < x0 || Math.min(ax, bx, cx) > x1 || Math.max(ay, by, cy) < y0 || Math.min(ay, by, cy) > y1) return
                if ((bx - ax) * (cy - ay) - (cx - ax) * (by - ay) < 0) [ax, ay, bx, by] = [bx, by, ax, ay]
                const poly = clipConvex(tri, ax, ay, bx, by, cx, cy)
                if (poly.length < 6 || Math.abs(ringArea2(poly)) < 2 * MIN_PIECE_AREA) return
                const n = poly.length / 2
                for (let i = 1; i + 1 < n; i++) {
                    const px = poly[0], py = poly[1], qx = poly[2 * i], qy = poly[2 * i + 1], rx = poly[2 * i + 2], ry = poly[2 * i + 3]
                    if (Math.abs((qx - px) * (ry - py) - (qy - py) * (rx - px)) < 2e-8) continue
                    const pa = planeAt(t, px, py), pb = planeAt(t, qx, qy), pc = planeAt(t, rx, ry)
                    pushTri(px, py, pa[0] + extraZ, qx, qy, pb[0] + extraZ, rx, ry, pc[0] + extraZ, [pa[1], pa[2], pa[3], pb[1], pb[2], pb[3], pc[1], pc[2], pc[3]])
                }
            })
        }
    }

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
        const before = indices.length
        for (const rings of polys) {
            for (const tri of boundTris(triangulate(rings))) {
                pushTri(tri[0], tri[1], zAt(tri[0], tri[1]), tri[2], tri[3], zAt(tri[2], tri[3]), tri[4], tri[5], zAt(tri[4], tri[5]))
            }
        }
        return (indices.length - before) / 3
    }

    units.forEach((u, k) => {
        if (isUnderground(u.facility)) {
            hidden++
            return
        }
        const first = indices.length / 3
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
            count = drape(u.polys, extra)
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
        mesh: { origin: terrain.origin, positions: new Float32Array(positions), indices: new Uint32Array(indices), normals: new Float32Array(normals) },
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

/** 메쉬 사본의 z 에 lift 를 더한다 */
export const liftMesh = (positions: Float32Array, lift: number) => {
    const out = positions.slice()
    for (let i = 2; i < out.length; i += 3) out[i] += lift
    return out
}

/**
 * 계단형 조각의 벽을 아래층 쪽으로 lift 만큼 수평 이동하고 전체를 lift 만큼 올린다(계획서 2.1절: 도로 판은 지형 판 + lift, 도로 벽은 지형 벽과
 * xy 가 같아 수직면끼리 겹치므로 아래층 쪽으로 밀어 lift 두께의 껍질처럼 둔다). 벽 삼각형(법선의 z ≈ 0)마다 가운데 점 양옆의 지형 높이를
 * 읽어 낮은 쪽을 고르고, 그 방향을 세 꼭짓점에 쌓아(판과 공유하는 꼭짓점도 같이 움직여 판이 그만큼 늘고 준다) 평균 방향으로 민다.
 * zAt 이 없으면(내보내기에 지형이 없을 때) 벽은 옮기지 않고 올리기만 한다
 */
export const liftSteppedChunk = (chunk: MeshChunk, lift: number, zAt: ((x: number, y: number) => number | null) | null): MeshChunk => {
    const p = chunk.positions.slice()
    const idx = chunk.indices
    const nV = p.length / 3
    if (zAt) {
        const disp = new Float32Array(2 * nV)
        const cnt = new Uint16Array(nV)
        for (let t = 0; t < idx.length; t += 3) {
            const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
            const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2]
            const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2]
            const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
            const len = Math.hypot(nx, ny, nz)
            if (len < 1e-12 || Math.abs(nz) > 1e-6 * len) continue
            let hx = nx / len, hy = ny / len
            const mx = (p[a] + p[b] + p[c]) / 3, my = (p[a + 1] + p[b + 1] + p[c + 1]) / 3
            const zp = zAt(mx + hx * 0.05, my + hy * 0.05), zm = zAt(mx - hx * 0.05, my - hy * 0.05)
            if (zp === null && zm === null) continue
            if ((zp ?? Infinity) > (zm ?? Infinity)) {
                hx = -hx
                hy = -hy
            }
            for (const v of [a / 3, b / 3, c / 3]) {
                disp[2 * v] += hx
                disp[2 * v + 1] += hy
                cnt[v]++
            }
        }
        for (let v = 0; v < nV; v++) {
            if (cnt[v] === 0) continue
            const dx = disp[2 * v] / cnt[v], dy = disp[2 * v + 1] / cnt[v]
            const len = Math.hypot(dx, dy)
            if (len < 1e-9) continue
            p[3 * v] += (dx / len) * lift
            p[3 * v + 1] += (dy / len) * lift
        }
    }
    for (let i = 2; i < p.length; i += 3) p[i] += lift
    return { positions: p, indices: idx }
}

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

/** 삼각형 범위가 참조하는 정점만 모은 작은 메쉬(내보내기 그룹용). lift 를 z 에 더하고, 정점 법선이 있으면 같이 옮긴다 */
export const compactTriangles = (positions: Float32Array, indices: Uint32Array, lift = 0, normals?: Float32Array): MeshChunk => {
    const map = new Map<number, number>()
    const out = new Uint32Array(indices.length)
    const pts: number[] = []
    const nrm: number[] = []
    for (let i = 0; i < indices.length; i++) {
        const v = indices[i]
        let j = map.get(v)
        if (j === undefined) {
            j = pts.length / 3
            map.set(v, j)
            pts.push(positions[3 * v], positions[3 * v + 1], positions[3 * v + 2] + lift)
            if (normals) nrm.push(normals[3 * v], normals[3 * v + 1], normals[3 * v + 2])
        }
        out[i] = j
    }
    return { positions: new Float32Array(pts), indices: out, normals: normals ? new Float32Array(nrm) : undefined }
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
