/**
 * TIN 지형을 층 간격(step)마다 "판" 다각형으로 나눈다. 건축 모형처럼 맨 아래 판(메쉬 전체) 위에 다음 레벨 판을
 * 차례로 쌓는 구조라, SKP 내보내기의 계단형 지형이 SketchUp 에서 판을 step 두께로 push 해 쌓은 것과 같은 면·그룹이 된다.
 *
 * 판 k 는 지형 높이 z 가 k·step 이상인 평면 영역이다. 화면의 계단형(terrainSteps)이 k·step ≤ z < (k+1)·step 인 띠를
 * 높이 k·step 의 판으로 그리므로, 판 k 의 윗면을 k·step, 아랫면을 (k−1)·step 으로 두고(두께 step) 쌓으면 맨 위에 보이는
 * 면이 화면과 같다. 영역은 섬이 여럿일 수 있고 골짜기 구멍도 있을 수 있어, 판 하나가 (외곽 고리 + 구멍 고리들) 여러 개로 나온다.
 *
 * 방법(2026-11-13 하나로 통일. 전에는 등고선 변 + 메쉬 경계 변을 모아 윤곽을 만들었으나, 메쉬 경계가 어긋나는 곳에서 안 닫힌 사슬이
 * 생겨 여의도에서 아래 판 셋이 통째로 빠졌다 — docs/osm-green-layer-plan.md 8.12·9절):
 * - 삼각형마다 지나는 레벨 k 의 띠 조각(k·step ≤ z ≤ (k+1)·step 인 볼록 다각형)을 만들어 그 변을 모두 (레벨, 분류) 묶음에 넣고, 반대 방향
 *   변끼리 지운다. 묶음은 띠 조각의 합집합이라 경계 변만 남고, 조각이 닫힌 다각형이라 남은 변은 언제나 닫힌 고리로 이어진다.
 * - 위 판부터 내려오며 판 k 의 묶음은 {띠 k ∩ 분류 c} + {≥ k+1}(= 판 k+1 윤곽 변, 위 판에 덮이는 부분)이고, 판 k 윤곽(z ≥ k·step,
 *   아랫면·옆면)은 이 묶음 변을 모두 다시 지운 것이다. 그래서 묶음과 윤곽이 같은 꼭짓점을 쓰고 합치면 같은 영역이다(불리언 없음).
 * - 남은 변을 끝점으로 이어 고리를 만들고, 반시계 고리는 외곽, 시계 고리는 구멍으로 두어 그 구멍을 품는 가장 작은 외곽에 붙인다.
 * - 단순화(일직선에 가까운 연속 꼭짓점 합치기, 옆면 벽 수를 줄임)는 고리마다가 아니라 판 안 평면 그래프의 갈림점(차수 ≠ 2)을 고정하고
 *   그 사이 사슬마다 한 번 해서, 이웃 묶음·윤곽이 같은 꼭짓점을 쓴다.
 * 녹지 분류(classes)를 주면 판마다 윗면 조각(tops)을 함께 낸다(G12, 2.7절). 안 주면 분류가 모두 0 인 것과 같은 계산이고 tops 는 내지 않는다
 * (윗면은 판 윤곽 한 장).
 *
 * 전제: 삼각형은 위에서 볼 때 반시계(TinMesh 규약). 혹시 다른 방향이 섞여도 평면 넓이 부호로 바로잡는다.
 * 정점 비교는 terrainSteps 와 같이 mm 로 반올림한 (x, y) 숫자 키로 한다. 잘린 점은 변의 두 끝점을 좌표 순으로 정렬한 뒤
 * 보간해, 이웃 삼각형이 같은 변을 잘라도 비트까지 같은 점이 나오게 한다(키가 어긋나 변이 안 지워지는 일을 막는다).
 */
import type { TinMesh } from "../terrainData"

type P = [number, number, number]
/** 평면 좌표 (x, y), m */
export type P2 = [number, number]

/** 판 영역 하나: 외곽 고리(반시계)와 그 안의 구멍 고리들(시계) */
export type SlabPolygon = { outer: P2[]; holes: P2[][] }

/** 윗면 묶음의 분류 값 중 "위 판에 덮이는 부분(z ≥ zTop + step)" */
export const COVERED_TOP = -1

/** 판 윗면 조각 하나: 분류 cls(0 = 녹지 아님, 1 ~ 6 = 녹지, COVERED_TOP = 위 판 아래)의 다각형들 */
export type SlabTop = { cls: number; polygons: SlabPolygon[] }

/**
 * 판 하나. 윗면 높이 zTop = k·step, 아랫면 zBottom = (k − 1)·step. 영역은 z ≥ zTop 인 곳.
 * tops 는 분류를 줬을 때만: 윗면을 겹치지 않게 나눈 조각들(합치면 polygons 와 같은 영역, 꼭짓점 공유). cls 오름차순, COVERED_TOP 이 맨 앞
 */
export type TerrainSlab = { k: number; zTop: number; zBottom: number; polygons: SlabPolygon[]; tops?: SlabTop[] }

export type TerrainSlabsResult = {
    /** 낮은 판부터. 첫 판은 메쉬 전체다 */
    slabs: TerrainSlab[]
    /** 끝까지 이어도 시작점으로 돌아오지 못해 버린 변 사슬 수. 0 이어야 정상이다 */
    openChains: number
    /** 넓이가 0에 가까워 버린 고리 수 */
    emptyRings: number
    /** 품는 외곽을 찾지 못해 버린 구멍 수. 0 이어야 정상이다 */
    orphanHoles: number
    /** 분류를 줬을 때만: 윗면 조각(tops)에서 버린 것들의 수(위 세 값은 판 윤곽만 센다) */
    topsDropped?: { openChains: number; emptyRings: number; orphanHoles: number }
}

/** z 를 step 으로 나눈 층 번호. 정수 높이 정점이 부동소수점 오차로 아래 층에 떨어지지 않게 작은 값을 더한다(terrainSteps 와 같음) */
const bandOf = (z: number, step: number) => Math.floor(z / step + 1e-6)

// (x, y) → mm 정수 키. 비트 배분과 한도는 terrainSteps.makeXyKey 와 같다
const KEY_Y_BITS = 26
const KEY_Y_SPAN = 2 ** KEY_Y_BITS
const KEY_X_SPAN = 2 ** (53 - KEY_Y_BITS)
const KEY_MARGIN_MM = 1000
/** 평면 넓이(m²)가 이보다 작은 삼각형은 영역에 기여하지 않으므로 띠 조각을 만들지 않는다(이웃 변이 남아 넓이 0 고리로 버려진다) */
const MIN_TRIANGLE_AREA2 = 1e-9
/** 고리 넓이(m²)가 이보다 작으면 버린다 */
const MIN_RING_AREA = 1e-6
/** 고리 단순화 허용 편차(m). 원래 꼭짓점이 단순화된 선에서 이보다 멀어지지 않는다. float32 좌표 잡음(1mm 급)보다 조금 크게 */
const COLLINEAR_DIST_M = 0.002
const PROGRESS_EVERY_TRIANGLES = 8192

/**
 * 판 하나의 아직 안 지워진 변: 시작점 키 → (끝점 키 → 시작점 좌표와 개수).
 * 개수를 두는 이유: 잘린 점 둘이 mm 키로는 같은 점이 될 수 있어 같은 방향 변이 둘 생기기도 한다. 하나로 덮어쓰면
 * 수가 안 맞아 고리가 안 닫히므로 세어 두고 반대 방향이 올 때마다 하나씩 뺀다
 */
type EdgeMap = Map<number, Map<number, { p: P2; n: number }>>

/** 좌표 사전 순(x, y, z). 변의 두 끝점을 항상 같은 순서로 두기 위한 것 */
const less = (a: P, b: P) => (a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2])

/** 변 a–b 가 평면 z = level 과 만나는 점. 끝점 순서에 무관하게 같은 값이 나온다 */
const cut = (a: P, b: P, level: number): P => {
    const [p, q] = less(a, b) ? [a, b] : [b, a]
    const t = (level - p[2]) / (q[2] - p[2])
    return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, level]
}

/**
 * 볼록 다각형을 평면 z = level 로 잘라 위쪽(z ≥ level) 조각을 돌려준다(terrainSteps.splitPolygon 의 above 와 같은 규칙).
 * 평면 위에 놓인 정점과 교차점이 들어가고 정점 순서는 유지된다. 층 높이와의 차가 eps 이하인 정점은 층 위에 놓인 것으로
 * 본다. bandOf 가 층 높이보다 1e-6·step 낮은 정점까지 그 층으로 치므로 자르기도 같은 기준이어야 한다.
 */
const above = (poly: P[], level: number, eps: number) => {
    const out: P[] = []
    const side = (p: P) => {
        const d = p[2] - level
        return Math.abs(d) <= eps ? 0 : d
    }
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i]
        const b = poly[(i + 1) % poly.length]
        const da = side(a)
        const db = side(b)
        if (da >= 0) out.push(a)
        if ((da < 0 && db > 0) || (da > 0 && db < 0)) out.push(cut(a, b, level))
    }
    return out
}

/** above 의 반대쪽: 평면 z = level 아래(z ≤ level) 조각. 같은 eps 규칙 */
const below = (poly: P[], level: number, eps: number) => {
    const out: P[] = []
    const side = (p: P) => {
        const d = p[2] - level
        return Math.abs(d) <= eps ? 0 : d
    }
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i]
        const b = poly[(i + 1) % poly.length]
        const da = side(a)
        const db = side(b)
        if (da <= 0) out.push(a)
        if ((da < 0 && db > 0) || (da > 0 && db < 0)) out.push(cut(a, b, level))
    }
    return out
}

/** 고리의 부호 있는 넓이(m²). 양수 = 반시계 */
const ringArea = (ring: P2[]) => {
    let s = 0
    for (let i = 0; i < ring.length; i++) {
        const [x0, y0] = ring[i]
        const [x1, y1] = ring[(i + 1) % ring.length]
        s += x0 * y1 - x1 * y0
    }
    return s / 2
}

/** 점이 고리 안에 있는지(반직선 교차 수 홀짝). 경계 위의 점은 어느 쪽이라고 못 박지 않는다 */
const inRing = (ring: P2[], [x, y]: P2) => {
    let inside = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]
        const [xj, yj] = ring[j]
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
}

/** 점 p 에서 선분 a–b 까지의 거리 */
const segmentDistance = ([px, py]: P2, [ax, ay]: P2, [bx, by]: P2) => {
    const vx = bx - ax, vy = by - ay
    const len2 = vx * vx + vy * vy
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0
    return Math.hypot(px - (ax + vx * t), py - (ay + vy * t))
}

/** 버린 것들의 수(TerrainSlabsResult 와 같은 이름) */
type Dropped = { openChains: number; emptyRings: number; orphanHoles: number }

/** 아직 안 지워진 변 지도에 변 kp→kq(시작점 p)를 넣는다. 반대 방향 변이 있으면 그것을 하나 지운다 */
const pushEdge = (edges: EdgeMap, kp: number, kq: number, p: P2) => {
    const back = edges.get(kq)
    const reverse = back?.get(kp)
    if (back && reverse) {
        if (--reverse.n === 0) {
            back.delete(kp)
            if (back.size === 0) edges.delete(kq)
        }
        return
    }
    let out = edges.get(kp)
    if (!out) {
        out = new Map()
        edges.set(kp, out)
    }
    const same = out.get(kq)
    if (same) same.n++
    else out.set(kq, { p, n: 1 })
}

/**
 * 남은 변을 이어 고리로 만들고 외곽·구멍으로 나눈다(변 지도는 비워진다).
 *
 * @param simplify 이어 낸 고리(점과 그 키)를 단순화한다. 세 점 미만이면 빈 배열
 * @param dropped 버린 사슬·고리·구멍 수를 더한다
 */
const edgesToPolygons = (edges: EdgeMap, simplify: (ring: P2[], keys: number[]) => P2[], dropped: Dropped): SlabPolygon[] => {
    const outers: { ring: P2[]; area: number; box: [number, number, number, number] }[] = []
    const holes: P2[][] = []
    const emitRing = (raw: P2[], rawKeys: number[]) => {
        const ring = simplify(raw, rawKeys)
        const area = ring.length < 3 ? 0 : ringArea(ring)
        if (Math.abs(area) < MIN_RING_AREA) {
            dropped.emptyRings++
        } else if (area > 0) {
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
            for (const [x, y] of ring) {
                if (x < x0) x0 = x
                if (x > x1) x1 = x
                if (y < y0) y0 = y
                if (y > y1) y1 = y
            }
            outers.push({ ring, area, box: [x0, y0, x1, y1] })
        } else {
            holes.push(ring)
        }
    }
    // 아무 변에서나 출발해 끝점을 따라 걷는다. 걷다가 이미 지난 점을 다시 만나면(고리 둘이 한 점에서 맞닿은 곳,
    // 또는 외곽에 닿은 구멍) 그 사이 구간이 그 자체로 닫힌 고리이므로 떼어 내고 계속 걷는다. 그래서 갈림길에서
    // 어느 변을 고르든 결과는 같은 점을 두 번 지나지 않는 단순 고리들이 된다
    while (edges.size > 0) {
        const startKey = edges.keys().next().value!
        const ring: P2[] = []
        const keys: number[] = []
        /** 지금 고리에 들어 있는 점 키 → ring 안의 위치 */
        const at = new Map<number, number>()
        let cur = startKey
        let closed = false
        for (;;) {
            const out = edges.get(cur)
            if (!out) break
            const [nextKey, edge] = out.entries().next().value!
            if (--edge.n === 0) {
                out.delete(nextKey)
                if (out.size === 0) edges.delete(cur)
            }
            at.set(cur, ring.length)
            ring.push(edge.p)
            keys.push(cur)
            cur = nextKey
            if (cur === startKey) {
                closed = true
                break
            }
            const seen = at.get(cur)
            if (seen !== undefined) {
                const cutKeys = keys.splice(seen)
                for (const key of cutKeys) at.delete(key)
                emitRing(ring.splice(seen), cutKeys)
            }
        }
        if (!closed) {
            dropped.openChains++
            continue
        }
        emitRing(ring, keys)
    }

    // 구멍은 그것을 품는 가장 작은 외곽에 붙인다(구멍 속의 섬은 자기 외곽을 따로 가지므로 넓이 오름차순으로 찾는다).
    // 구멍의 꼭짓점이 외곽 경계와 맞닿아 판정이 흔들릴 수 있어, 안이라고 나오는 꼭짓점이 나올 때까지 차례로 본다
    outers.sort((p, q) => p.area - q.area)
    const polygons: SlabPolygon[] = outers.map(({ ring }) => ({ outer: ring, holes: [] }))
    for (const hole of holes) {
        let found = false
        for (const pt of hole) {
            const [x, y] = pt
            const i = outers.findIndex(
                ({ box, ring }) => x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3] && inRing(ring, pt),
            )
            if (i >= 0) {
                polygons[i].holes.push(hole)
                found = true
                break
            }
        }
        if (!found) dropped.orphanHoles++
    }
    return polygons
}

/** 방향 있는 변 하나: 시작·끝 키, 시작점 좌표, 개수 */
type DirEdge = { kp: number; kq: number; p: P2; n: number }

const edgeList = (edges: EdgeMap): DirEdge[] => {
    const out: DirEdge[] = []
    for (const [kp, byQ] of edges) for (const [kq, { p, n }] of byQ) out.push({ kp, kq, p, n })
    return out
}

/** 변 목록들을 한 지도에 넣는다(서로 반대 방향이면 지워진다) */
const edgeMapOf = (lists: DirEdge[][]): EdgeMap => {
    const edges: EdgeMap = new Map()
    for (const list of lists) for (const e of list) for (let i = 0; i < e.n; i++) pushEdge(edges, e.kp, e.kq, e.p)
    return edges
}

/**
 * 판 하나의 평면 그래프(묶음 경계 변 모두, 방향 무시)에서 남길 꼭짓점을 고른다. 차수가 2가 아닌 점(묶음 셋 이상이 만나거나
 * 고리가 한 점에서 맞닿는 곳)은 모두 남기고, 그 사이 사슬마다 끝점을 고정한 Douglas–Peucker(허용 편차 COLLINEAR_DIST_M)로
 * 고른다. 갈림점이 없는 고리는 첫 점과 가장 먼 점을 고정한다. 사슬마다 한 번만 계산하므로 그 사슬을 쓰는
 * 두 묶음(과 판 윤곽)이 같은 꼭짓점을 쓴다
 */
const keptVertices = (lists: DirEdge[][], coordOf: (key: number) => P2): Set<number> => {
    const adj = new Map<number, number[]>()
    const linked = new Map<number, Set<number>>()
    for (const list of lists) {
        for (const { kp, kq } of list) {
            const lo = Math.min(kp, kq), hi = Math.max(kp, kq)
            let s = linked.get(lo)
            if (!s) linked.set(lo, (s = new Set()))
            if (s.has(hi)) continue
            s.add(hi)
            for (const [a, b] of [[kp, kq], [kq, kp]]) {
                let l = adj.get(a)
                if (!l) adj.set(a, (l = []))
                l.push(b)
            }
        }
    }
    const used = new Map<number, Set<number>>()
    const isUsed = (a: number, b: number) => !!used.get(Math.min(a, b))?.has(Math.max(a, b))
    const markUsed = (a: number, b: number) => {
        const lo = Math.min(a, b)
        let s = used.get(lo)
        if (!s) used.set(lo, (s = new Set()))
        s.add(Math.max(a, b))
    }
    const kept = new Set<number>()
    /** keys[i0] ~ keys[i1](i1 은 길이를 넘으면 처음으로 돈다) 사이를 끝점 고정으로 단순화해 남길 점을 표시한다 */
    const peucker = (keys: number[], i0: number, i1: number) => {
        const n = keys.length
        const pt = (i: number) => coordOf(keys[i % n])
        const stack: [number, number][] = [[i0, i1]]
        while (stack.length > 0) {
            const [a, b] = stack.pop()!
            let worst = 0, at = -1
            for (let i = a + 1; i < b; i++) {
                const d = segmentDistance(pt(i), pt(a), pt(b))
                if (d > worst) {
                    worst = d
                    at = i
                }
            }
            if (at >= 0 && worst > COLLINEAR_DIST_M) {
                kept.add(keys[at % n])
                stack.push([a, at], [at, b])
            }
        }
    }
    const nextOf = (cur: number, prev: number) => {
        const [a, b] = adj.get(cur)!
        return a === prev ? b : a
    }
    for (const [v, nb] of adj) {
        if (nb.length === 2) continue
        kept.add(v)
        for (const w of nb) {
            if (isUsed(v, w)) continue
            markUsed(v, w)
            const chain = [v, w]
            let prev = v, cur = w
            while (adj.get(cur)!.length === 2) {
                const next = nextOf(cur, prev)
                if (isUsed(cur, next)) break
                markUsed(cur, next)
                chain.push(next)
                prev = cur
                cur = next
            }
            peucker(chain, 0, chain.length - 1)
        }
    }
    // 남은 변은 모든 점의 차수가 2인 고리들이다
    for (const [v, nb] of adj) {
        if (nb.length !== 2 || isUsed(v, nb[0])) continue
        const cycle = [v]
        let prev = v, cur = nb[0]
        markUsed(v, cur)
        while (cur !== v) {
            cycle.push(cur)
            const next = nextOf(cur, prev)
            markUsed(cur, next)
            prev = cur
            cur = next
        }
        const [x0, y0] = coordOf(v)
        let far = 0, farD = -1
        for (let i = 1; i < cycle.length; i++) {
            const [x, y] = coordOf(cycle[i])
            const d = (x - x0) ** 2 + (y - y0) ** 2
            if (d > farD) {
                farD = d
                far = i
            }
        }
        kept.add(v)
        kept.add(cycle[far])
        peucker(cycle, 0, far)
        peucker(cycle, far, cycle.length)
    }
    return kept
}

/**
 * TIN 메쉬를 쌓는 판별 다각형으로 나눈다.
 *
 * @param mesh 원본 TIN 메쉬(원점 기준 좌표). 삼각형은 위에서 볼 때 반시계가 규약이지만 다른 방향이 섞여도 된다
 * @param step 층 간격(m). 1이면 1m 마다 한 판
 * @param onProgress 진행률 알림(선택). 처리한 삼각형 수와 전체 수. 자르기 단계만 세고 고리 잇기는 포함하지 않는다
 * @param classes 삼각형마다 녹지 분류(0 ~ 6, 선택). 주면 판마다 윗면 조각(tops)을 함께 낸다(G12). 없으면 모두 0 으로 계산하고 tops 는 내지 않는다
 * @returns 낮은 판부터의 목록과 버린 것들의 수
 */
export const buildTerrainSlabs = (
    mesh: TinMesh,
    step: number,
    onProgress?: (done: number, total: number) => void,
    classes?: Uint8Array,
): TerrainSlabsResult => {
    const { positions: P0 } = mesh

    // ---- (x, y) 키: 메쉬 최소 x·y 기준, mm ----
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (let i = 0; i < P0.length; i += 3) {
        const x = P0[i], y = P0[i + 1], z = P0[i + 2]
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        if (z < minZ) minZ = z
        if (z > maxZ) maxZ = z
    }
    const spanX = Math.round((maxX - minX) * 1000) + 2 * KEY_MARGIN_MM
    const spanY = Math.round((maxY - minY) * 1000) + 2 * KEY_MARGIN_MM
    if (spanX >= KEY_X_SPAN || spanY >= KEY_Y_SPAN) {
        throw new Error(
            `판 변환 범위 초과: 메쉬 가로 ${(spanX / 1e6).toFixed(1)}km × 세로 ${(spanY / 1e6).toFixed(1)}km ` +
                `(한도 가로 ${(KEY_X_SPAN / 1e6).toFixed(1)}km × 세로 ${(KEY_Y_SPAN / 1e6).toFixed(1)}km)`,
        )
    }
    const ox = Math.round(minX * 1000) - KEY_MARGIN_MM
    const oy = Math.round(minY * 1000) - KEY_MARGIN_MM
    const keyOf = (x: number, y: number) => (Math.round(x * 1000) - ox) * KEY_Y_SPAN + (Math.round(y * 1000) - oy)
    const decode = (key: number): P2 => [(Math.floor(key / KEY_Y_SPAN) + ox) / 1000, ((key % KEY_Y_SPAN) + oy) / 1000]
    return buildSlabs(mesh, step, keyOf, decode, bandOf(minZ, step), bandOf(maxZ, step), classes, onProgress)
}

/**
 * buildTerrainSlabs 의 본체(방법은 파일 머리). 띠 조각 변을 (레벨, 분류) 묶음에 넣어 지우고, 위 판부터 묶음 → 판 윤곽 → 고리를 만든다.
 * 넓이가 0에 가까운 삼각형은 영역에 기여하지 않으므로 넣지 않는다(이웃 변이 남아 넓이 0 고리가 되어 버려진다)
 */
const buildSlabs = (
    mesh: TinMesh,
    step: number,
    keyOf: (x: number, y: number) => number,
    decode: (key: number) => P2,
    kMinAll: number,
    kMaxAll: number,
    classes: Uint8Array | undefined,
    onProgress?: (done: number, total: number) => void,
): TerrainSlabsResult => {
    const { positions: P0, indices: I0 } = mesh
    const levelEps = step * 1e-6
    /** 레벨 → 분류 → 남은 변 */
    const groups = new Map<number, Map<number, EdgeMap>>()
    const groupOf = (k: number, cls: number) => {
        let byCls = groups.get(k)
        if (!byCls) groups.set(k, (byCls = new Map()))
        let edges = byCls.get(cls)
        if (!edges) byCls.set(cls, (edges = new Map()))
        return edges
    }
    const nTri = Math.floor(I0.length / 3)
    for (let t = 0; t < nTri; t++) {
        if (onProgress && t % PROGRESS_EVERY_TRIANGLES === 0) onProgress(t, nTri)
        const tri: P[] = [0, 1, 2].map((c) => {
            const i = I0[t * 3 + c] * 3
            return [P0[i], P0[i + 1], P0[i + 2]] as P
        })
        const [a, b, c] = tri
        const area2 = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        if (area2 < 0) [tri[1], tri[2]] = [tri[2], tri[1]]
        if (Math.abs(area2) < MIN_TRIANGLE_AREA2) continue
        const cls = classes?.[t] ?? 0
        const kMin = bandOf(Math.min(a[2], b[2], c[2]), step)
        const kMax = bandOf(Math.max(a[2], b[2], c[2]), step)
        for (let k = kMin; k <= kMax; k++) {
            const piece = below(above(tri, k * step, levelEps), (k + 1) * step, levelEps)
            if (piece.length < 3) continue
            const edges = groupOf(k, cls)
            for (let i = 0; i < piece.length; i++) {
                const p = piece[i]
                const q = piece[(i + 1) % piece.length]
                const kp = keyOf(p[0], p[1])
                const kq = keyOf(q[0], q[1])
                if (kp !== kq) pushEdge(edges, kp, kq, [p[0], p[1]])
            }
        }
    }
    onProgress?.(nTri, nTri)

    const dropped: Dropped = { openChains: 0, emptyRings: 0, orphanHoles: 0 }
    const topsDropped: Dropped = { openChains: 0, emptyRings: 0, orphanHoles: 0 }
    const slabs: TerrainSlab[] = []
    /** 바로 위 판의 윤곽 변(= 이 판의 {≥ k+1} 묶음) */
    let upper: DirEdge[] = []
    for (let k = kMaxAll; k >= kMinAll; k--) {
        const lists: { cls: number; edges: DirEdge[] }[] = []
        if (upper.length > 0) lists.push({ cls: COVERED_TOP, edges: upper })
        const byCls = groups.get(k)
        if (byCls) for (const cls of [...byCls.keys()].sort((p, q) => p - q)) lists.push({ cls, edges: edgeList(byCls.get(cls)!) })
        groups.delete(k)
        const outline = edgeList(edgeMapOf(lists.map((l) => l.edges)))
        upper = outline
        if (outline.length === 0) continue
        // 같은 키의 점은 판 안에서 처음 본 좌표 하나로 쓴다(묶음마다 잘린 점의 float 가 mm 안에서 다를 수 있다)
        const coords = new Map<number, P2>()
        for (const { edges } of lists) for (const e of edges) if (!coords.has(e.kp)) coords.set(e.kp, e.p)
        const coordOf = (key: number) => coords.get(key) ?? decode(key)
        const kept = keptVertices(
            lists.map((l) => l.edges),
            coordOf,
        )
        const simplify = (_ring: P2[], keys: number[]) => {
            const out: P2[] = []
            for (const key of keys) if (kept.has(key)) out.push(coordOf(key))
            return out.length < 3 ? [] : out
        }
        const polygons = edgesToPolygons(edgeMapOf([outline]), simplify, dropped)
        if (!classes) {
            slabs.push({ k, zTop: k * step, zBottom: (k - 1) * step, polygons })
            continue
        }
        const tops = lists
            .map(({ cls, edges }) => ({ cls, polygons: edgesToPolygons(edgeMapOf([edges]), simplify, topsDropped) }))
            .filter((top) => top.polygons.length > 0)
        slabs.push({ k, zTop: k * step, zBottom: (k - 1) * step, polygons, tops })
    }
    slabs.reverse()
    return classes ? { slabs, ...dropped, topsDropped } : { slabs, ...dropped }
}
