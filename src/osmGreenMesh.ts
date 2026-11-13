import earcut from "earcut"
import polygonClipping from "polygon-clipping"
import type { MultiPolygon, Polygon } from "polygon-clipping"

import { GREEN_CLASS_COUNT, GreenPiece } from "./osmGreenData"
import { ClippedMesh } from "./terrainClip"
import { MeshChunk } from "./terrainData"
import { buildSteppedMeshChunks } from "./terrainSteps"

/**
 * 녹지(osm_green) 메쉬: 5K 전처리(분류별 불리언)와 1K 지형 면 나누기(계획서 docs/osm-green-layer-plan.md 2.2절 G1 b-2·G3·G8·G11 (c), 8.6절).
 *
 * 보조 워커가 부르는 순서(G3 에서 연결):
 * 1. 5K 마다 한 번 `prepareGreen5k(fetchGreen5k 의 조각을 공통 원점으로 옮긴 것, 공통 원점)` → `GreenPrepared`(결과 캐시 키 = 5K + 원점.
 *    평면 typed array 라 구조화 복제로 옮길 수 있다).
 * 2. 도엽마다 "합침 → 법선 → 1K 자르기(clipMeshToConvexPolygon)" 로 만든 **법선 포함** 자른 TIN 을 `splitTinByGreen(tin, 도엽에 걸친 5K 의 prepared, 도엽 폴리곤)`
 *    으로 나눈다. 순서가 중요하다: 나눈 뒤 법선을 다시 계산하면 최대 63° 바뀐다(8.6절 4). 새 정점 법선은 정규화하지 않은 보간값이다.
 * 3. `greenTerrainChunks(split, { stepped, step, maxBytes, smoothNormals })` 로 모드별 조각과 분류 범위를 받는다(매끈한 면은 조각 하나,
 *    계단형은 buildSteppedMeshChunks 의 tags 옵션으로 판·벽에 분류가 따라간다).
 * 녹지가 없는 도엽은 2 가 입력 TIN 객체를 그대로 돌려주고 3 이 지금의 호출과 같은 인자로 빌더를 불러 출력이 바이트까지 같다.
 */

/** 우선순위 낮은 것 → 높은 것(G3): 공원 < 초지 < 황야 < 관목 < 과수원 < 숲. 코드는 GREEN_CLASS(숲 1 · 관목 2 · 황야 3 · 초지 4 · 공원 5 · 과수원 6) */
export const GREEN_PRIORITY: readonly number[] = [5, 4, 3, 2, 6, 1]

/**
 * 한 분류의 다각형들(공통 원점 기준 m). 고리는 닫는 점 없이 xy 에 이어 붙이고, 다각형마다 첫 고리가 외곽(CCW), 나머지가 구멍(CW)
 * (불리언 결과와 원본 모두 이 방향으로 맞춘다)
 */
export type GreenRings = {
    /** 고리 정점 (x, y) 연속, m */
    xy: Float64Array
    /** 고리마다 시작 정점 번호(길이 고리 수 + 1) */
    ringStart: Uint32Array
    /** 다각형마다 시작 고리 번호(길이 다각형 수 + 1) */
    polyStart: Uint32Array
    /** 고리마다 x0, y0, x1, y1 */
    ringBox: Float64Array
}

/** 5K 전처리 통계. 배열은 분류 코드 첨자(길이 GREEN_CLASS_COUNT + 1, 0 은 비움) */
export type GreenPrepStats = {
    /** 원본 조각 수 */
    pieces: number[]
    /** 불리언 뒤 면적 m²(외곽 − 구멍) */
    areaM2: number[]
    rings: number[]
    verts: number[]
    /** 합집합·빼기가 예외나 빈 합집합으로 실패해 원본(합집합 실패) 또는 빼기 전 합집합(빼기 실패)을 쓴 분류 수. 우선순위는 1K 분류 판정이 다시 지킨다 */
    unionFailed: number
    /** 빼기 결과가 빈 분류 수(높은 분류에 다 덮임. 실패가 아님) */
    emptyAfterDiff: number
    /** 실패 메시지(앞 120자) */
    failDetail: string[]
    ms: number
}

/** 5K 하나의 전처리 결과(G3 결과 캐시 항목). classes 는 분류 코드 첨자(0 은 빈 값) */
export type GreenPrepared = {
    origin: [number, number]
    classes: GreenRings[]
    /** 원본 조각의 bbox(x0, y0, x1, y1, m)와 분류. 도엽에 걸친 원본 조각 수를 셀 때 쓴다 */
    pieceBox: Float64Array
    pieceCls: Uint8Array
    stats: GreenPrepStats
}

type Pt = [number, number]

const emptyRings = (): GreenRings => ({ xy: new Float64Array(0), ringStart: new Uint32Array(1), polyStart: new Uint32Array(1), ringBox: new Float64Array(0) })

const ringArea2 = (r: Pt[]) => {
    let s = 0
    for (let i = 0, n = r.length; i < n; i++) {
        const a = r[i], b = r[(i + 1) % n]
        s += a[0] * b[1] - b[0] * a[1]
    }
    return s
}

/** 닫는 점·연속 중복점을 뺀 고리 */
const openRing = (r: Pt[]): Pt[] => {
    const out: Pt[] = []
    for (const p of r) {
        const q = out[out.length - 1]
        if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push(p)
    }
    while (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop()
    return out
}

/** MultiPolygon → GreenRings(방향 정리) 와 면적·고리·정점 수 */
const packRings = (mp: MultiPolygon) => {
    const xy: number[] = []
    const ringStart: number[] = [0]
    const polyStart: number[] = [0]
    const box: number[] = []
    let area = 0
    for (const pg of mp) {
        let k = 0
        for (const ring of pg) {
            const r = openRing(ring as Pt[])
            if (r.length < 3) continue
            const a2 = ringArea2(r)
            const outer = k === 0
            if (outer ? a2 < 0 : a2 > 0) r.reverse()
            area += (outer ? 1 : -1) * Math.abs(a2) / 2
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
            for (const [x, y] of r) {
                xy.push(x, y)
                if (x < x0) x0 = x
                if (x > x1) x1 = x
                if (y < y0) y0 = y
                if (y > y1) y1 = y
            }
            box.push(x0, y0, x1, y1)
            ringStart.push(xy.length / 2)
            k++
        }
        if (k > 0) polyStart.push(ringStart.length - 1)
    }
    const rings: GreenRings = { xy: Float64Array.from(xy), ringStart: Uint32Array.from(ringStart), polyStart: Uint32Array.from(polyStart), ringBox: Float64Array.from(box) }
    return { rings, area, nRings: ringStart.length - 1, nVerts: xy.length / 2 }
}

/**
 * 5K 전처리(G8): 분류별 합집합 → 우선순위 빼기(낮은 분류에서 높은 분류들의 합집합을 뺀다). 예열이 없으면 첫 호출이 조금 느리다.
 * 합집합이 예외·빈 결과면 그 분류는 원본 조각 그대로, 빼기가 예외면 빼기 전 합집합을 쓰고 unionFailed 를 센다(겹친 채로 남은 자리는
 * splitTinByGreen 의 분류 판정이 우선순위 순으로 다시 고른다)
 *
 * @param pieces 5K 의 녹지 조각(xy = origin 기준 mm 정수. greenInTile 이나 fetchGreen5k 를 옮긴 것)
 * @param origin 공통 원점(정수 m). 결과 좌표는 이 원점 기준 m
 */
export const prepareGreen5k = (pieces: GreenPiece[], origin: [number, number]): GreenPrepared => {
    const t0 = performance.now()
    const N = GREEN_CLASS_COUNT + 1
    const stats: GreenPrepStats = {
        pieces: new Array(N).fill(0), areaM2: new Array(N).fill(0), rings: new Array(N).fill(0), verts: new Array(N).fill(0),
        unionFailed: 0, emptyAfterDiff: 0, failDetail: [], ms: 0,
    }
    const byCls: Polygon[][] = Array.from({ length: N }, () => [])
    const pieceBox = new Float64Array(4 * pieces.length)
    const pieceCls = new Uint8Array(pieces.length)
    pieces.forEach((p, k) => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
        for (let i = 0; i < p.xy.length; i += 2) {
            const x = p.xy[i] / 1000, y = p.xy[i + 1] / 1000
            if (x < x0) x0 = x
            if (x > x1) x1 = x
            if (y < y0) y0 = y
            if (y > y1) y1 = y
        }
        pieceBox.set([x0, y0, x1, y1], 4 * k)
        pieceCls[k] = p.cls
        if (p.cls < 1 || p.cls > GREEN_CLASS_COUNT) return
        stats.pieces[p.cls]++
        const lens = [p.nPts - p.holes.reduce((s, h) => s + h, 0), ...p.holes]
        const poly: Polygon = []
        let o = 0
        for (const n of lens) {
            const r: Pt[] = []
            for (let i = o; i < o + n; i++) r.push([p.xy[2 * i] / 1000, p.xy[2 * i + 1] / 1000])
            o += n
            if (r.length >= 3) poly.push(r)
        }
        if (poly.length) byCls[p.cls].push(poly)
    })
    const msg = (what: string, c: number, e: unknown) => `${what} 분류${c}: ${String((e as Error)?.message ?? e).slice(0, 120)}`
    const union: (MultiPolygon | null)[] = new Array(N).fill(null)
    for (let c = 1; c < N; c++) {
        const ps = byCls[c]
        if (!ps.length) continue
        let u: MultiPolygon | null = null
        try {
            u = polygonClipping.union(ps[0], ...ps.slice(1))
            if (!u.length) throw new Error("빈 합집합")
        } catch (e) {
            stats.unionFailed++
            stats.failDetail.push(msg("합집합", c, e))
            u = ps
        }
        union[c] = u
    }
    const classes: GreenRings[] = Array.from({ length: N }, emptyRings)
    for (let i = 0; i < GREEN_PRIORITY.length; i++) {
        const c = GREEN_PRIORITY[i]
        const u = union[c]
        if (!u) continue
        const higher = GREEN_PRIORITY.slice(i + 1).map((h) => union[h]).filter((x): x is MultiPolygon => !!x && x.length > 0)
        let f = u
        if (higher.length) {
            try {
                f = polygonClipping.difference(u, ...higher)
                if (!f.length) stats.emptyAfterDiff++
            } catch (e) {
                stats.unionFailed++
                stats.failDetail.push(msg("빼기", c, e))
                f = u
            }
        }
        const r = packRings(f)
        classes[c] = r.rings
        stats.areaM2[c] = r.area
        stats.rings[c] = r.nRings
        stats.verts[c] = r.nVerts
    }
    stats.ms = performance.now() - t0
    return { origin, classes, pieceBox, pieceCls, stats }
}

// ---- 1K 지형 면 나누기(G11 (c) 변 공유 분할) ----

/** 분류 범위. first·count 는 **삼각형 단위**(인덱스 = first × 3 부터 count × 3 개). cls 0 은 비녹지 */
export type GreenRange = { cls: number; first: number; count: number }

/** 1K 나누기 통계(패널·골든용). 배열은 분류 코드 첨자(0 = 비녹지, 길이 GREEN_CLASS_COUNT + 1) */
export type GreenStats = {
    /** 도엽 bbox 에 걸친 원본 조각 수(5K 전처리 전 기준) */
    pieces: number[]
    /** 분류별 표시 면적 m²(나눈 TIN 의 평면 넓이, double) */
    areaM2: number[]
    trianglesIn: number
    trianglesOut: number
    newVertices: number
    /** 경계가 지나 나눈 지형 삼각형 수 */
    splitTriangles: number
    /** 면 추출·earcut 검사(넓이·경계 정점)를 못 넘겨 무게중심 부채꼴로 나눈 삼각형 수(닫힘은 유지, 그 삼각형 안 경계는 근사) */
    fallback: number
    /** float32 좌표에서 넓이가 0 이하가 되어 버린 삼각형 수와 그 넓이(double) */
    dropped: number
    droppedAreaM2: number
    /** float32 로 납작한 조각을 건너편 조각을 나눠 없앤 수(버리지 않아 닫힘 유지) */
    slivers: number
    /** 이 도엽에 쓴 경계 선분 수(노딩 뒤) */
    segments: number
    /** 걸친 5K 전처리의 unionFailed 합 */
    unionFailed: number
    ms: number
}

export type GreenSplit = { tin: ClippedMesh & { normals: Float32Array }; ranges: GreenRange[]; stats: GreenStats }

export type GreenSplitOptions = {
    /** 경계 정점을 지형 정점·변으로 붙이는 거리(m). 기본 1 mm(자료 격자). 도엽 변을 따라가는 5K 절단선이 가는 띠를 만들지 않게 한다 */
    snap?: number
}

/** 균일 격자(셀마다 번호 목록) */
const makeGrid = (x0: number, y0: number, x1: number, y1: number, cell: number) => {
    const nx = Math.max(1, Math.min(1024, Math.ceil((x1 - x0) / cell)))
    const ny = Math.max(1, Math.min(1024, Math.ceil((y1 - y0) / cell)))
    const cw = (x1 - x0) / nx || 1, ch = (y1 - y0) / ny || 1
    const cells: (number[] | undefined)[] = new Array(nx * ny)
    const cx = (x: number) => Math.max(0, Math.min(nx - 1, Math.floor((x - x0) / cw)))
    const cy = (y: number) => Math.max(0, Math.min(ny - 1, Math.floor((y - y0) / ch)))
    const add = (c: number, id: number) => (cells[c] ??= []).push(id)
    /** bbox 가 덮는 셀에 넣는다 */
    const addBox = (id: number, bx0: number, by0: number, bx1: number, by1: number) => {
        if (bx1 < x0 || bx0 > x1 || by1 < y0 || by0 > y1) return
        for (let j = cy(by0), j1 = cy(by1); j <= j1; j++) for (let i = cx(bx0), i1 = cx(bx1); i <= i1; i++) add(j * nx + i, id)
    }
    /** 선분이 지나는 셀(과 이웃)을 걸음 cw/4 로 훑는다 */
    const cellsAlong = (ax: number, ay: number, bx: number, by: number, fn: (c: number) => void) => {
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (Math.min(cw, ch) / 4)))
        let last = -1
        for (let k = 0; k <= n; k++) {
            const x = ax + ((bx - ax) * k) / n, y = ay + ((by - ay) * k) / n
            const i = cx(x), j = cy(y), c = j * nx + i
            if (c === last) continue
            last = c
            for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
                const ii = i + di, jj = j + dj
                if (ii >= 0 && ii < nx && jj >= 0 && jj < ny) fn(jj * nx + ii)
            }
        }
    }
    const boxCells = (bx0: number, by0: number, bx1: number, by1: number, fn: (c: number) => void) => {
        for (let j = cy(by0), j1 = cy(by1); j <= j1; j++) for (let i = cx(bx0), i1 = cx(bx1); i <= i1; i++) fn(j * nx + i)
    }
    return { cells, add, addBox, cellsAlong, boxCells, cellOf: (x: number, y: number) => cy(y) * nx + cx(x) }
}

/**
 * 1K 지형 면 나누기(G11 (c)). 녹지 경계 선분과 지형 삼각형 **변** 의 교점을 변마다 한 번만 만들어(정점 번호 공유, T 접합 없음) 이웃 삼각형이
 * 같은 점을 쓰게 하고, 경계가 지나는 삼각형만 "삼각형 둘레(교점 포함) + 안의 경계 선분" 의 면으로 나눠 earcut 한다. 면마다 대표점이
 * 어느 분류 다각형 안인지(우선순위 높은 것부터, 0 이 아닌 감김 수) 로 분류를 정한다. 경계가 안 지나는 삼각형은 정점 번호 그대로 분류만 붙인다.
 *
 * - 입력 TIN 은 "합침 → 법선 → 1K 자르기" 뒤의 것이어야 한다(8.6절). 원래 정점(번호·좌표·법선)은 그대로 앞에 두고 새 정점을 뒤에 붙인다.
 *   새 정점의 z·법선은 원래 삼각형(변 위면 그 변)의 무게중심 보간이고 법선은 **정규화하지 않는다**(GPU 보간이 원래 삼각형과 같게).
 * - 원래 삼각형을 비녹지(0) 포함 모두 대체한다(면적 보존). float32 좌표로 넓이가 0 이하인 삼각형은 버리고 stats.dropped 를 센다.
 * - 경계 선분은 걸친 5K 들의 분류 고리를 도엽 근처만 모아 노딩(가까운 점 합침 · 점이 선분 위면 나눔 · 교차점)한 것이다.
 * - 나눈 삼각형마다 넓이 합과 둘레 교점 사용을 검사하고, 못 넘으면 무게중심 부채꼴(둘레 교점은 모두 씀)로 대신한다(stats.fallback).
 * - 출력 인덱스는 분류 0..6 순(분류 안은 원래 삼각형 순). 녹지 경계도 녹지 삼각형도 없으면 **입력 tin 객체를 그대로** 돌려준다.
 *
 * @param tin 법선 포함 자른 TIN(원점 = prepared 의 원점)
 * @param prepared 도엽에 걸친 5K 의 전처리 결과
 * @param tilePoly 도엽 폴리곤(원점 기준 m). 고리 고르기·조각 수 세기에 쓴다
 */
export const splitTinByGreen = (
    tin: ClippedMesh & { normals: Float32Array },
    prepared: GreenPrepared[],
    tilePoly: [number, number][],
    opts: GreenSplitOptions = {},
): GreenSplit => {
    const t0 = performance.now()
    const N = GREEN_CLASS_COUNT + 1
    const snap = opts.snap ?? 1e-3
    const P = tin.positions, I = tin.indices, NV = tin.normals
    const n0 = P.length / 3, nT = I.length / 3
    const stats: GreenStats = {
        pieces: new Array(N).fill(0), areaM2: new Array(N).fill(0), trianglesIn: nT, trianglesOut: nT, newVertices: 0, splitTriangles: 0,
        fallback: 0, dropped: 0, droppedAreaM2: 0, slivers: 0, segments: 0, unionFailed: prepared.reduce((s, p) => s + p.stats.unionFailed, 0), ms: 0,
    }
    // 범위: 도엽 폴리곤과 TIN 의 bbox(+1 m)
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity
    for (const [x, y] of tilePoly) {
        bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y)
    }
    for (let i = 0; i < P.length; i += 3) {
        bx0 = Math.min(bx0, P[i]); by0 = Math.min(by0, P[i + 1]); bx1 = Math.max(bx1, P[i]); by1 = Math.max(by1, P[i + 1])
    }
    bx0 -= 1; by0 -= 1; bx1 += 1; by1 += 1
    const ov = (b: ArrayLike<number>, o: number) => b[o] <= bx1 && b[o + 2] >= bx0 && b[o + 1] <= by1 && b[o + 3] >= by0
    for (const pr of prepared) for (let k = 0; k < pr.pieceCls.length; k++) if (ov(pr.pieceBox, 4 * k)) stats.pieces[pr.pieceCls[k]]++

    const whole = (): GreenSplit => {
        stats.ms = performance.now() - t0
        return { tin, ranges: [{ cls: 0, first: 0, count: nT }], stats }
    }

    // 1) 걸친 고리(통째로: 감김 수는 고리 전체가 있어야 맞다) → 분류 판정용 띠 격자
    type Edge = { x0: number; y0: number; x1: number; y1: number; c: number }
    const edges: Edge[] = []
    for (const pr of prepared) for (let c = 1; c < N; c++) {
        const R = pr.classes[c]
        for (let r = 0; r + 1 < R.ringStart.length; r++) {
            if (!ov(R.ringBox, 4 * r)) continue
            const s = R.ringStart[r], e = R.ringStart[r + 1]
            for (let i = s; i < e; i++) {
                const j = i + 1 < e ? i + 1 : s
                edges.push({ x0: R.xy[2 * i], y0: R.xy[2 * i + 1], x1: R.xy[2 * j], y1: R.xy[2 * j + 1], c })
            }
        }
    }
    if (!edges.length) return whole()
    const nBand = Math.max(1, Math.min(2048, Math.ceil((by1 - by0) / 2)))
    const bandH = (by1 - by0) / nBand
    const bands: number[][] = Array.from({ length: nBand }, () => [])
    edges.forEach((e, k) => {
        const lo = Math.max(0, Math.floor((Math.min(e.y0, e.y1) - by0) / bandH))
        const hi = Math.min(nBand - 1, Math.floor((Math.max(e.y0, e.y1) - by0) / bandH))
        for (let b = lo; b <= hi; b++) bands[b].push(k)
    })
    const wind = new Int32Array(N)
    /** (x, y) 의 분류: 우선순위 높은 분류부터 감김 수가 0 이 아닌 첫 분류, 없으면 0 */
    const classify = (x: number, y: number) => {
        wind.fill(0)
        const b = Math.max(0, Math.min(nBand - 1, Math.floor((y - by0) / bandH)))
        for (const k of bands[b]) {
            const e = edges[k]
            if ((e.y0 <= y) === (e.y1 <= y)) continue
            const xi = e.x0 + ((y - e.y0) * (e.x1 - e.x0)) / (e.y1 - e.y0)
            if (xi > x) wind[e.c] += e.y1 > e.y0 ? 1 : -1
        }
        for (let i = GREEN_PRIORITY.length - 1; i >= 0; i--) if (wind[GREEN_PRIORITY[i]] !== 0) return GREEN_PRIORITY[i]
        return 0
    }

    // 2) 경계 선분 노딩(범위 안 변만): 가까운 점 합침 → 교차점 → 점이 선분 위면 나눔 → 중복 제거
    const EPS_N = 1e-4
    const bvx: number[] = [], bvy: number[] = []
    const vHash = new Map<string, number>()
    const hk = (i: number, j: number) => `${i},${j}`
    const addBv = (x: number, y: number) => {
        const i = Math.round(x / EPS_N), j = Math.round(y / EPS_N)
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
            const v = vHash.get(hk(i + di, j + dj))
            if (v !== undefined && Math.abs(bvx[v] - x) <= EPS_N && Math.abs(bvy[v] - y) <= EPS_N) return v
        }
        const id = bvx.length
        bvx.push(x)
        bvy.push(y)
        vHash.set(hk(i, j), id)
        return id
    }
    let segA: number[] = [], segB: number[] = []
    const segKeys = new Set<number>()
    const SK = 1 << 26
    const addSeg = (a: number, b: number, A: number[], B: number[], keys: Set<number>) => {
        if (a === b) return
        const key = Math.min(a, b) * SK + Math.max(a, b)
        if (keys.has(key)) return
        keys.add(key)
        A.push(a)
        B.push(b)
    }
    for (const e of edges) {
        if (Math.max(e.x0, e.x1) < bx0 || Math.min(e.x0, e.x1) > bx1 || Math.max(e.y0, e.y1) < by0 || Math.min(e.y0, e.y1) > by1) continue
        addSeg(addBv(e.x0, e.y0), addBv(e.x1, e.y1), segA, segB, segKeys)
    }
    if (!segA.length) {
        // 경계가 도엽에 안 들어온다: 도엽이 한 분류 안이거나 녹지 밖
        const c = classify((bx0 + bx1) / 2, (by0 + by1) / 2)
        if (c === 0) return whole()
    }
    {
        const g = makeGrid(bx0, by0, bx1, by1, 8)
        segA.forEach((a, s) => g.cellsAlong(bvx[a], bvy[a], bvx[segB[s]], bvy[segB[s]], (c) => g.add(c, s)))
        const splits: number[][] = segA.map(() => [])
        const stamp = new Int32Array(segA.length).fill(-1)
        const nSeg0 = segA.length
        for (let s = 0; s < nSeg0; s++) {
            const a = segA[s], b = segB[s]
            const ax = bvx[a], ay = bvy[a], rx = bvx[b] - ax, ry = bvy[b] - ay
            g.boxCells(Math.min(ax, ax + rx), Math.min(ay, ay + ry), Math.max(ax, ax + rx), Math.max(ay, ay + ry), (c) => {
                for (const q of g.cells[c] ?? []) {
                    if (q <= s || stamp[q] === s) continue
                    stamp[q] = s
                    const c0 = segA[q], c1 = segB[q]
                    if (c0 === a || c0 === b || c1 === a || c1 === b) continue
                    const qx = bvx[c0], qy = bvy[c0], sx = bvx[c1] - qx, sy = bvy[c1] - qy
                    const d = rx * sy - ry * sx
                    if (Math.abs(d) < 1e-12 * Math.hypot(rx, ry) * Math.hypot(sx, sy)) continue
                    const t = ((qx - ax) * sy - (qy - ay) * sx) / d
                    const u = ((qx - ax) * ry - (qy - ay) * rx) / d
                    if (t <= 0 || t >= 1 || u <= 0 || u >= 1) continue
                    const v = addBv(ax + t * rx, ay + t * ry)
                    if (v !== a && v !== b) splits[s].push(v)
                    if (v !== c0 && v !== c1) splits[q].push(v)
                }
            })
        }
        // 점이 선분 위(EPS_N 안)면 나눈다(빼기 결과의 교점이 위 분류 변 위에 거의 놓인 자리)
        const vg = makeGrid(bx0, by0, bx1, by1, 8)
        for (let v = 0; v < bvx.length; v++) vg.add(vg.cellOf(bvx[v], bvy[v]), v)
        for (let s = 0; s < nSeg0; s++) {
            const a = segA[s], b = segB[s]
            const ax = bvx[a], ay = bvy[a], rx = bvx[b] - ax, ry = bvy[b] - ay
            const L2 = rx * rx + ry * ry
            vg.cellsAlong(ax, ay, ax + rx, ay + ry, (c) => {
                for (const v of vg.cells[c] ?? []) {
                    if (v === a || v === b) continue
                    const t = ((bvx[v] - ax) * rx + (bvy[v] - ay) * ry) / L2
                    if (t <= 0 || t >= 1) continue
                    if (Math.abs((bvx[v] - ax) * ry - (bvy[v] - ay) * rx) / Math.sqrt(L2) <= EPS_N) splits[s].push(v)
                }
            })
        }
        const A2: number[] = [], B2: number[] = []
        const keys2 = new Set<number>()
        for (let s = 0; s < nSeg0; s++) {
            const a = segA[s], b = segB[s]
            if (!splits[s].length) {
                addSeg(a, b, A2, B2, keys2)
                continue
            }
            const ax = bvx[a], ay = bvy[a], rx = bvx[b] - ax, ry = bvy[b] - ay
            const pts = [...new Set(splits[s])].map((v) => ({ v, t: (bvx[v] - ax) * rx + (bvy[v] - ay) * ry })).sort((p, q) => p.t - q.t)
            let prev = a
            for (const p of pts) {
                addSeg(prev, p.v, A2, B2, keys2)
                prev = p.v
            }
            addSeg(prev, b, A2, B2, keys2)
        }
        segA = A2
        segB = B2
    }
    stats.segments = segA.length

    // 3) TIN: double 좌표, 변 표, 삼각형 격자
    const px = new Float64Array(n0), py = new Float64Array(n0)
    for (let i = 0; i < n0; i++) {
        px[i] = P[3 * i]
        py[i] = P[3 * i + 1]
    }
    const edgeIdx = new Map<number, number>()
    const eu: number[] = [], ev: number[] = []
    const triEdges = new Int32Array(3 * nT)
    /** 변마다 그 변을 쓰는 삼각형 둘(없으면 -1). 변 수 ≤ 3 × 삼각형 수 */
    const edgeTri = new Int32Array(6 * nT).fill(-1)
    for (let t = 0; t < nT; t++) for (let k = 0; k < 3; k++) {
        const a = I[3 * t + k], b = I[3 * t + ((k + 1) % 3)]
        const u = Math.min(a, b), v = Math.max(a, b)
        const key = u * n0 + v
        let e = edgeIdx.get(key)
        if (e === undefined) {
            e = eu.length
            edgeIdx.set(key, e)
            eu.push(u)
            ev.push(v)
        }
        triEdges[3 * t + k] = e
        edgeTri[2 * e + (edgeTri[2 * e] < 0 ? 0 : 1)] = t
    }
    const triCell = Math.max(2, Math.sqrt(((bx1 - bx0) * (by1 - by0)) / Math.max(1, nT)))
    const tg = makeGrid(bx0, by0, bx1, by1, triCell)
    for (let t = 0; t < nT; t++) {
        const a = I[3 * t], b = I[3 * t + 1], c = I[3 * t + 2]
        tg.addBox(t, Math.min(px[a], px[b], px[c]), Math.min(py[a], py[b], py[c]), Math.max(px[a], px[b], px[c]), Math.max(py[a], py[b], py[c]))
    }

    // 새 정점(double 좌표·z·정규화 안 한 법선)
    const nx: number[] = [], ny: number[] = [], nz: number[] = [], nn: number[] = []
    const addVert = (x: number, y: number, w: [number, number][]) => {
        let z = 0, a = 0, b = 0, c = 0
        for (const [i, f] of w) {
            z += f * P[3 * i + 2]
            a += f * NV[3 * i]
            b += f * NV[3 * i + 1]
            c += f * NV[3 * i + 2]
        }
        nx.push(x)
        ny.push(y)
        nz.push(z)
        nn.push(a, b, c)
        return n0 + nx.length - 1
    }
    const vx = (v: number) => (v < n0 ? px[v] : nx[v - n0])
    const vy = (v: number) => (v < n0 ? py[v] : ny[v - n0])
    /** 변 위 교점: 변 번호 → (변 u→v 매개변수 t, 정점) */
    const edgeHits = new Map<number, { t: number; v: number }[]>()
    /** 용접 거리(m). snap(1 mm)으로 하면 용접한 점이 이 변에서 최대 1 mm 벗어나 건너편 삼각형 둘레가 꺾여 부채꼴 대체가 늘었다(2026-11-08 측정) */
    const WELD = 1e-4
    const edgeVertex = (e: number, t: number) => {
        const u = eu[e], w = ev[e]
        const len = Math.hypot(px[w] - px[u], py[w] - py[u])
        if (t * len <= snap) return u
        if ((1 - t) * len <= snap) return w
        let hits = edgeHits.get(e)
        if (!hits) edgeHits.set(e, (hits = []))
        for (const h of hits) if (Math.abs(h.t - t) * len <= snap) return h.v
        const x = px[u] + t * (px[w] - px[u]), y = py[u] + t * (py[w] - py[u])
        // 용접: 이 변을 쓰는 삼각형(둘까지)의 다른 변 위 교점이 snap 안이면 그 정점을 이 변에도 쓴다(뾰족한 삼각형의 두 변 위 교점이
        // 몇 µm 떨어져 float32 납작 조각이 되던 자리. 두 변 목록이 같은 번호라 이웃 삼각형도 같은 점을 쓴다)
        for (const tt of [edgeTri[2 * e], edgeTri[2 * e + 1]]) {
            if (tt < 0) continue
            for (let k = 0; k < 3; k++) {
                const e2 = triEdges[3 * tt + k]
                if (e2 === e) continue
                for (const h of edgeHits.get(e2) ?? []) {
                    if (Math.hypot(vx(h.v) - x, vy(h.v) - y) > WELD) continue
                    hits.push({ t, v: h.v })
                    return h.v
                }
            }
        }
        const v = addVert(x, y, [[u, 1 - t], [w, t]])
        hits.push({ t, v })
        return v
    }
    const marked = new Uint8Array(nT)

    // 4) 경계 정점 위치 정하기: 지형 정점 근처 → 그 정점, 변 근처 → 변 위 교점, 삼각형 안 → 새 정점, 밖 → 없음(-1)
    const bvMesh = new Int32Array(bvx.length).fill(-1)
    for (let v = 0; v < bvx.length; v++) {
        const x = bvx[v], y = bvy[v]
        if (x < bx0 || x > bx1 || y < by0 || y > by1) continue
        let best = -1, bestD = -Infinity
        for (const t of tg.cells[tg.cellOf(x, y)] ?? []) {
            let m = Infinity
            for (let k = 0; k < 3; k++) {
                const a = I[3 * t + k], b = I[3 * t + ((k + 1) % 3)]
                const dx = px[b] - px[a], dy = py[b] - py[a]
                m = Math.min(m, (dx * (y - py[a]) - dy * (x - px[a])) / (Math.hypot(dx, dy) || 1))
            }
            if (m > bestD) {
                bestD = m
                best = t
            }
        }
        if (best < 0 || bestD < -snap) continue
        const t = best
        const cs = [I[3 * t], I[3 * t + 1], I[3 * t + 2]]
        const near = cs.find((c) => Math.hypot(px[c] - x, py[c] - y) <= snap)
        if (near !== undefined) {
            bvMesh[v] = near
            continue
        }
        if (bestD <= snap) {
            // 가장 가까운 변에 투영
            let ek = 0, md = Infinity
            for (let k = 0; k < 3; k++) {
                const a = cs[k], b = cs[(k + 1) % 3]
                const dx = px[b] - px[a], dy = py[b] - py[a]
                const d = (dx * (y - py[a]) - dy * (x - px[a])) / (Math.hypot(dx, dy) || 1)
                if (d < md) {
                    md = d
                    ek = k
                }
            }
            const e = triEdges[3 * t + ek]
            const u = eu[e], w = ev[e]
            const dx = px[w] - px[u], dy = py[w] - py[u]
            const tt = Math.max(0, Math.min(1, ((x - px[u]) * dx + (y - py[u]) * dy) / (dx * dx + dy * dy)))
            bvMesh[v] = edgeVertex(e, tt)
            continue
        }
        const [a, b, c] = cs
        const det = (py[b] - py[c]) * (px[a] - px[c]) + (px[c] - px[b]) * (py[a] - py[c])
        const l0 = ((py[b] - py[c]) * (x - px[c]) + (px[c] - px[b]) * (y - py[c])) / det
        const l1 = ((py[c] - py[a]) * (x - px[c]) + (px[a] - px[c]) * (y - py[c])) / det
        bvMesh[v] = addVert(x, y, [[a, l0], [b, l1], [c, 1 - l0 - l1]])
        marked[t] = 1
    }

    // 5) 선분 ∩ 지형 변(변마다 한 번, 같은 정점): 선분마다 사건 목록(선분 매개변수 w, 메쉬 정점)
    const bpos = (v: number): Pt => (bvMesh[v] >= 0 ? [vx(bvMesh[v]), vy(bvMesh[v])] : [bvx[v], bvy[v]])
    const segEvents: { w: number; v: number }[][] = []
    const eStamp = new Int32Array(eu.length).fill(-1)
    for (let s = 0; s < segA.length; s++) {
        const A = segA[s], B = segB[s]
        const [ax, ay] = bpos(A), [bx, by] = bpos(B)
        const rx = bx - ax, ry = by - ay
        const ev0: { w: number; v: number }[] = []
        segEvents.push(ev0)
        // 두 끝이 같은 메쉬 정점으로 붙었거나 길이가 0 이면 건너뜀
        if ((bvMesh[A] >= 0 && bvMesh[A] === bvMesh[B]) || Math.hypot(rx, ry) <= 1e-9) continue
        if (bvMesh[A] >= 0) ev0.push({ w: 0, v: bvMesh[A] })
        if (bvMesh[B] >= 0) ev0.push({ w: 1, v: bvMesh[B] })
        tg.cellsAlong(ax, ay, bx, by, (cell) => {
            for (const t of tg.cells[cell] ?? []) for (let k = 0; k < 3; k++) {
                const e = triEdges[3 * t + k]
                if (eStamp[e] === s) continue
                eStamp[e] = s
                const u = eu[e], w = ev[e]
                const ex = px[w] - px[u], ey = py[w] - py[u]
                const d = rx * ey - ry * ex
                if (!(Math.abs(d) > 1e-15 * (Math.abs(rx) + Math.abs(ry)) * (Math.abs(ex) + Math.abs(ey)))) continue
                const qx = px[u] - ax, qy = py[u] - ay
                const wS = (qx * ey - qy * ex) / d
                const tE = (qx * ry - qy * rx) / d
                const len = Math.hypot(ex, ey), lenS = Math.hypot(rx, ry)
                if (tE * len < -snap || (tE - 1) * len > snap) continue
                if (wS * lenS <= snap || (1 - wS) * lenS <= snap) continue // 끝점 근처는 끝점 사건이 맡는다
                const m = edgeVertex(e, Math.max(0, Math.min(1, tE)))
                ev0.push({ w: wS, v: m })
            }
        })
        ev0.sort((p, q) => p.w - q.w)
    }
    // 변 위 교점이 있는 삼각형은 모두 다시 나눈다(닿기만 한 이웃도 그 점을 써야 T 접합이 없다)
    const edgeHasHits = new Uint8Array(eu.length)
    for (const [e] of edgeHits) edgeHasHits[e] = 1
    for (let t = 0; t < nT; t++) if (edgeHasHits[triEdges[3 * t]] || edgeHasHits[triEdges[3 * t + 1]] || edgeHasHits[triEdges[3 * t + 2]]) marked[t] = 1

    // 선분 격자(삼각형마다 후보 선분)
    const sg = makeGrid(bx0, by0, bx1, by1, Math.max(4, triCell))
    for (let s = 0; s < segA.length; s++) {
        const [ax, ay] = bpos(segA[s]), [bx, by] = bpos(segB[s])
        sg.cellsAlong(ax, ay, bx, by, (c) => sg.add(c, s))
    }

    // 6) 삼각형마다: 안 나누면 분류만, 나누면 면 추출 → earcut → 분류
    const out: number[][] = Array.from({ length: N }, () => [])
    const area2Of = (a: number, b: number, c: number) => (vx(b) - vx(a)) * (vy(c) - vy(a)) - (vy(b) - vy(a)) * (vx(c) - vx(a))
    const f32 = Math.fround
    const fx = (v: number) => (v < n0 ? P[3 * v] : f32(nx[v - n0]))
    const fy = (v: number) => (v < n0 ? P[3 * v + 1] : f32(ny[v - n0]))
    /** float32 로 저장했을 때의 넓이 × 2(원래 정점은 이미 float32) */
    const f32Area2 = (a: number, b: number, c: number) => (fx(b) - fx(a)) * (fy(c) - fy(a)) - (fy(b) - fy(a)) * (fx(c) - fx(a))
    /**
     * 나눈 조각을 넣는다(CCW 로 맞춤). keepFlat: 원래 삼각형이 이미 float32 넓이 0 이하면 조각도 그대로 둔다(버리면 그 삼각형의 변이 열린다).
     * 아니면 float32 넓이 0 이하를 버리고 센다
     */
    const push = (cls: number, a: number, b: number, c: number, keepFlat = false) => {
        if (a === b || b === c || a === c) return
        let A2 = area2Of(a, b, c)
        if (A2 < 0) {
            ;[b, c] = [c, b]
            A2 = -A2
        }
        if (!keepFlat && !(f32Area2(a, b, c) > 0)) {
            stats.dropped++
            stats.droppedAreaM2 += A2 / 2
            return
        }
        out[cls].push(a, b, c)
    }
    /**
     * float32 로 납작한 조각(p, q 사이에 c 가 놓인 삼각형) 없애기: 긴 변 pq 건너편 조각(q, p, x)을 c 에서 둘로 나누고 납작한 조각을 뺀다.
     * 넓이와 변 공유가 그대로라 버릴 때 생기던 열린 변 셋이 없다. 건너편이 없거나 그것도 납작하면 남겨 push 가 버린다
     */
    const fixSlivers = (tris: number[], cls: number[]) => {
        const dead = new Uint8Array(cls.length + 64)
        for (let guard = 0; guard < 64; guard++) {
            let k = -1
            for (let i = 0; i < cls.length; i++) {
                if (dead[i]) continue
                const a = tris[3 * i], b = tris[3 * i + 1], c = tris[3 * i + 2]
                if (a !== b && b !== c && a !== c && !(area2Of(a, b, c) * f32Area2(a, b, c) > 0)) {
                    k = i
                    break
                }
            }
            if (k < 0) break
            const v = [tris[3 * k], tris[3 * k + 1], tris[3 * k + 2]]
            let e = 0, el = -1
            for (let j = 0; j < 3; j++) {
                const l = Math.hypot(vx(v[(j + 1) % 3]) - vx(v[j]), vy(v[(j + 1) % 3]) - vy(v[j]))
                if (l > el) {
                    el = l
                    e = j
                }
            }
            const p = v[e], q = v[(e + 1) % 3], c = v[(e + 2) % 3]
            let nbr = -1, x = -1
            for (let i = 0; i < cls.length && nbr < 0; i++) {
                if (i === k || dead[i]) continue
                const w = [tris[3 * i], tris[3 * i + 1], tris[3 * i + 2]]
                if (w.includes(p) && w.includes(q)) {
                    nbr = i
                    x = w.find((u) => u !== p && u !== q)!
                }
            }
            dead[k] = 1
            if (nbr < 0 || !(area2Of(p, q, x) * f32Area2(p, q, x) > 0)) continue
            // 건너편 (p, q, x) 를 (p, c, x) · (c, q, x) 로(방향은 push 가 맞춘다)
            tris[3 * nbr] = p
            tris[3 * nbr + 1] = c
            tris[3 * nbr + 2] = x
            tris.push(c, q, x)
            cls.push(cls[nbr])
            stats.slivers++
        }
        return dead
    }
    const segStamp = new Int32Array(segA.length).fill(-1)
    let anyGreen = false
    for (let t = 0; t < nT; t++) {
        const a = I[3 * t], b = I[3 * t + 1], c = I[3 * t + 2]
        if (!marked[t]) {
            const cls = classify((px[a] + px[b] + px[c]) / 3, (py[a] + py[b] + py[c]) / 3)
            if (cls) anyGreen = true
            out[cls].push(a, b, c)
            continue
        }
        stats.splitTriangles++
        anyGreen = true
        if (!splitTriangle(t)) {
            stats.fallback++
            fanTriangle(t)
        }
    }

    /** 삼각형 둘레(꼭짓점 + 변 위 교점, CCW) */
    function ringOf(t: number): number[] {
        const cs = [I[3 * t], I[3 * t + 1], I[3 * t + 2]]
        if (area2Of(cs[0], cs[1], cs[2]) < 0) cs.reverse()
        const ring: number[] = []
        for (let k = 0; k < 3; k++) {
            const a = cs[k], b = cs[(k + 1) % 3]
            ring.push(a)
            const e = edgeIdx.get(Math.min(a, b) * n0 + Math.max(a, b))!
            const hits = (edgeHits.get(e) ?? []).slice().sort((p, q) => p.t - q.t)
            if (a > b) hits.reverse()
            for (const h of hits) ring.push(h.v)
        }
        // 용접한 정점이 두 변에 같이 들어가면 그 사이 꼭짓점이 폭 0 으로 눌린다(v, x, v). 그 꼭짓점 쪽 v–x 변은 두 이웃이 한 번씩 써서
        // 닫히므로 이 삼각형에서는 뺀다. 이어진 같은 정점도 하나로
        for (let changed = true; changed && ring.length > 3; ) {
            changed = false
            for (let i = 0; i < ring.length && ring.length > 3; i++) {
                const n = ring.length
                if (ring[i] === ring[(i + 1) % n]) {
                    ring.splice((i + 1) % n, 1)
                    changed = true
                } else if (ring[i] === ring[(i + 2) % n]) {
                    const j = (i + 1) % n, k = (i + 2) % n
                    ring.splice(Math.max(j, k), 1)
                    ring.splice(Math.min(j, k), 1)
                    changed = true
                }
            }
        }
        return ring
    }

    /** 무게중심 부채꼴(둘레 교점을 모두 쓰므로 이웃과 닫힘 유지) */
    function fanTriangle(t: number) {
        const a = I[3 * t], b = I[3 * t + 1], c = I[3 * t + 2]
        const ring = ringOf(t)
        const flat = !(f32Area2(a, b, c) !== 0)
        const m = addVert((px[a] + px[b] + px[c]) / 3, (py[a] + py[b] + py[c]) / 3, [[a, 1 / 3], [b, 1 / 3], [c, 1 / 3]])
        for (let i = 0; i < ring.length; i++) {
            const p = ring[i], q = ring[(i + 1) % ring.length]
            push(classify((vx(m) + vx(p) + vx(q)) / 3, (vy(m) + vy(p) + vy(q)) / 3), m, p, q, flat)
        }
    }

    /** 경계 선분으로 삼각형을 면으로 나눠 earcut. 검사(넓이 합·둘레 정점 사용)를 못 넘으면 false(아무것도 넣지 않음) */
    function splitTriangle(t: number): boolean {
        const ring = ringOf(t)
        const cs = [I[3 * t], I[3 * t + 1], I[3 * t + 2]]
        if (area2Of(cs[0], cs[1], cs[2]) < 0) cs.reverse()
        const areaT = area2Of(cs[0], cs[1], cs[2]) / 2
        /** 점이 삼각형 안(변에서 1e-7 m 넘게)인지 */
        const inside = (x: number, y: number) => {
            for (let k = 0; k < 3; k++) {
                const p = cs[k], q = cs[(k + 1) % 3]
                const dx = vx(q) - vx(p), dy = vy(q) - vy(p)
                if ((dx * (y - vy(p)) - dy * (x - vx(p))) / (Math.hypot(dx, dy) || 1) <= 1e-7) return false
            }
            return true
        }
        // 지역 그래프: 둘레 + 안쪽 부분 선분
        const loc = new Map<number, number>()
        const verts: number[] = []
        const nb: number[][] = []
        const lid = (v: number) => {
            let i = loc.get(v)
            if (i === undefined) {
                i = verts.length
                loc.set(v, i)
                verts.push(v)
                nb.push([])
            }
            return i
        }
        const eKeys = new Set<number>()
        const addE = (p: number, q: number) => {
            if (p === q) return
            const i = lid(p), j = lid(q)
            const key = Math.min(i, j) * 65536 + Math.max(i, j)
            if (eKeys.has(key)) return
            eKeys.add(key)
            nb[i].push(j)
            nb[j].push(i)
        }
        for (let i = 0; i < ring.length; i++) addE(ring[i], ring[(i + 1) % ring.length])
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
        for (const v of cs) {
            x0 = Math.min(x0, px[v]); y0 = Math.min(y0, py[v]); x1 = Math.max(x1, px[v]); y1 = Math.max(y1, py[v])
        }
        sg.boxCells(x0, y0, x1, y1, (cell) => {
            for (const s of sg.cells[cell] ?? []) {
                if (segStamp[s] === t) continue
                segStamp[s] = t
                const evs = segEvents[s]
                for (let k = 0; k + 1 < evs.length; k++) {
                    const p = evs[k].v, q = evs[k + 1].v
                    if (p === q) continue
                    if (inside((vx(p) + vx(q)) / 2, (vy(p) + vy(q)) / 2)) addE(p, q)
                }
            }
        })
        // 각도 정렬과 면 순회(왼쪽이 면)
        const ox = vx(cs[0]), oy = vy(cs[0])
        const lx = verts.map((v) => vx(v) - ox), ly = verts.map((v) => vy(v) - oy)
        for (let i = 0; i < nb.length; i++) nb[i].sort((p, q) => Math.atan2(ly[p] - ly[i], lx[p] - lx[i]) - Math.atan2(ly[q] - ly[i], lx[q] - lx[i]))
        const used = nb.map((l) => new Uint8Array(l.length))
        const cycles: number[][] = []
        for (let i = 0; i < nb.length; i++) for (let k = 0; k < nb[i].length; k++) {
            if (used[i][k]) continue
            const cyc: number[] = []
            let u = i, kk = k, guard = 0
            while (!used[u][kk] && guard++ < 100000) {
                used[u][kk] = 1
                cyc.push(u)
                const w = nb[u][kk]
                const back = nb[w].indexOf(u)
                kk = (back - 1 + nb[w].length) % nb[w].length
                u = w
            }
            cycles.push(cyc)
        }
        const cArea = cycles.map((cyc) => {
            let s = 0
            for (let k = 0; k < cyc.length; k++) {
                const p = cyc[k], q = cyc[(k + 1) % cyc.length]
                s += lx[p] * ly[q] - lx[q] * ly[p]
            }
            return s / 2
        })
        let outer = 0
        for (let k = 1; k < cycles.length; k++) if (cArea[k] < cArea[outer]) outer = k
        const faces = cycles.map((_, k) => k).filter((k) => k !== outer && cArea[k] > 0)
        const holes: number[][] = faces.map(() => [])
        const pip = (cyc: number[], x: number, y: number) => {
            let inn = false
            for (let k = 0, j = cyc.length - 1; k < cyc.length; j = k++) {
                const a = cyc[k], b = cyc[j]
                if ((ly[a] > y) !== (ly[b] > y) && x < ((lx[b] - lx[a]) * (y - ly[a])) / (ly[b] - ly[a]) + lx[a]) inn = !inn
            }
            return inn
        }
        for (let k = 0; k < cycles.length; k++) {
            if (k === outer || cArea[k] > 0) continue
            if (cArea[k] === 0) continue // 매달린 선분만으로 된 순회
            const cyc = cycles[k]
            // 가장 긴 변의 왼쪽(이 고리를 품은 면 쪽)으로 조금 떨어진 점
            let bi = 0, bl = -1
            for (let j = 0; j < cyc.length; j++) {
                const p = cyc[j], q = cyc[(j + 1) % cyc.length]
                const l = Math.hypot(lx[q] - lx[p], ly[q] - ly[p])
                if (l > bl) {
                    bl = l
                    bi = j
                }
            }
            const p = cyc[bi], q = cyc[(bi + 1) % cyc.length]
            const off = Math.min(1e-4, bl * 1e-3)
            const tx = (lx[p] + lx[q]) / 2 - ((ly[q] - ly[p]) / bl) * off, ty = (ly[p] + ly[q]) / 2 + ((lx[q] - lx[p]) / bl) * off
            let host = -1
            faces.forEach((f, fi) => {
                if (pip(cycles[f], tx, ty) && (host < 0 || cArea[f] < cArea[faces[host]])) host = fi
            })
            if (host < 0) return false
            holes[host].push(k)
        }
        // 면마다 earcut → 대표점 분류
        const tris: number[] = []
        const triCls: number[] = []
        let sum = 0
        faces.forEach((f, fi) => {
            const flat: number[] = []
            const ids: number[] = []
            const hIdx: number[] = []
            for (const cyc of [cycles[f], ...holes[fi].map((h) => cycles[h])]) {
                if (ids.length) hIdx.push(ids.length)
                for (const u of cyc) {
                    flat.push(lx[u], ly[u])
                    ids.push(u)
                }
            }
            const tri = earcut(flat, hIdx.length ? hIdx : undefined, 2)
            let best = -1, bestA = -1
            for (let k = 0; k < tri.length; k += 3) {
                const p = tri[k], q = tri[k + 1], r = tri[k + 2]
                const a2 = Math.abs((flat[2 * q] - flat[2 * p]) * (flat[2 * r + 1] - flat[2 * p + 1]) - (flat[2 * q + 1] - flat[2 * p + 1]) * (flat[2 * r] - flat[2 * p]))
                sum += a2 / 2
                if (a2 > bestA) {
                    bestA = a2
                    best = k
                }
            }
            if (best < 0) return
            const p = tri[best], q = tri[best + 1], r = tri[best + 2]
            const cls = classify(ox + (flat[2 * p] + flat[2 * q] + flat[2 * r]) / 3, oy + (flat[2 * p + 1] + flat[2 * q + 1] + flat[2 * r + 1]) / 3)
            for (let k = 0; k < tri.length; k += 3) {
                tris.push(verts[ids[tri[k]]], verts[ids[tri[k + 1]]], verts[ids[tri[k + 2]]])
                triCls.push(cls)
            }
        })
        if (Math.abs(sum - areaT) > 1e-6 * areaT + 1e-9) return false
        const usedV = new Set(tris)
        for (const v of ring) if (!usedV.has(v)) return false
        const flat = !(f32Area2(cs[0], cs[1], cs[2]) > 0)
        const dead = flat ? new Uint8Array(triCls.length) : fixSlivers(tris, triCls)
        for (let k = 0; k < triCls.length; k++) if (!dead[k]) push(triCls[k], tris[3 * k], tris[3 * k + 1], tris[3 * k + 2], flat)
        return true
    }

    if (!anyGreen && nx.length === 0) return whole()

    // 7) 모으기: 원래 정점 그대로 + 새 정점, 인덱스는 분류 0..6 순
    const nAll = n0 + nx.length
    const positions = new Float32Array(3 * nAll)
    positions.set(P)
    const normals = new Float32Array(3 * nAll)
    normals.set(NV)
    for (let k = 0; k < nx.length; k++) {
        positions[3 * (n0 + k)] = nx[k]
        positions[3 * (n0 + k) + 1] = ny[k]
        positions[3 * (n0 + k) + 2] = nz[k]
        normals.set([nn[3 * k], nn[3 * k + 1], nn[3 * k + 2]], 3 * (n0 + k))
    }
    const total = out.reduce((s, o) => s + o.length, 0)
    const indices = new Uint32Array(total)
    const ranges: GreenRange[] = []
    let off = 0
    for (let c = 0; c < N; c++) {
        const o = out[c]
        if (!o.length) continue
        indices.set(o, off)
        ranges.push({ cls: c, first: off / 3, count: o.length / 3 })
        let s = 0
        for (let k = 0; k < o.length; k += 3) s += Math.abs(area2Of(o[k], o[k + 1], o[k + 2])) / 2
        stats.areaM2[c] = s
        off += o.length
    }
    stats.trianglesOut = total / 3
    stats.newVertices = nx.length
    stats.ms = performance.now() - t0
    return { tin: { origin: tin.origin, positions, indices, normals }, ranges, stats }
}

// ---- 모드별 조각 ----

/** 지형 조각 + 분류 범위(조각 안 삼각형 단위) */
export type GreenTerrainChunk = MeshChunk & { ranges: GreenRange[] }

/**
 * 나눈 TIN 을 화면 모드대로 조각으로(워커의 지형 조각 자리). 매끈한 면은 조각 하나에 split.ranges 그대로. 계단형은 buildSteppedMeshChunks 에
 * 삼각형별 분류를 tags 로 넘겨 판·벽이 원래 삼각형의 분류를 따라가게 한다(벽은 먼저 만든 삼각형 쪽 분류, 중복 없음). 녹지가 없으면(범위가
 * 분류 0 하나) tags 없이 지금의 워커와 같은 인자로 불러 출력이 바이트까지 같다
 */
export function* greenTerrainChunks(
    split: GreenSplit,
    opts: { stepped: boolean; step: number; maxBytes: number; smoothNormals: boolean },
): Generator<GreenTerrainChunk> {
    const { tin, ranges } = split
    if (!(opts.stepped && opts.step > 0)) {
        yield { positions: tin.positions, indices: tin.indices, normals: tin.normals, ranges }
        return
    }
    const normals = opts.smoothNormals ? tin.normals : undefined
    if (ranges.length === 1 && ranges[0].cls === 0) {
        for (const ch of buildSteppedMeshChunks(tin, opts.step, opts.maxBytes, undefined, { normals })) {
            yield Object.assign(ch, { ranges: [{ cls: 0, first: 0, count: ch.indices.length / 3 }] })
        }
        return
    }
    const tags = new Uint8Array(tin.indices.length / 3)
    for (const r of ranges) tags.fill(r.cls, r.first, r.first + r.count)
    for (const ch of buildSteppedMeshChunks(tin, opts.step, opts.maxBytes, undefined, { normals, tags })) {
        const tr = ch.tagRanges!
        const rs: GreenRange[] = []
        for (let k = 0; k < tr.length; k += 3) rs.push({ cls: tr[k], first: tr[k + 1], count: tr[k + 2] })
        delete ch.tagRanges
        yield Object.assign(ch, { ranges: rs })
    }
}
