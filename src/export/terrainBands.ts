/**
 * TIN 지형을 층 간격(step)마다 "띠" 다각형으로 나눈다. SKP 내보내기의 계단형 지형이 삼각형 더미가 아니라
 * SketchUp 에서 판을 step 두께로 push 한 것과 같은 면·그룹 구조가 되게 하기 위한 것이다.
 *
 * 띠 k 는 지형 높이 z 가 k·step ≤ z < (k+1)·step 인 평면 영역이다. 화면의 계단형(terrainSteps)이 이 영역을 높이 k·step 의
 * 판으로 그리므로, 띠 k 의 판은 윗면이 k·step, 아랫면이 (k−1)·step 이다(두께 step). 영역은 섬이 여럿일 수 있고 구멍도
 * 있을 수 있어, 띠 하나가 (외곽 고리 + 구멍 고리들) 다각형 여러 개로 나온다.
 *
 * 방법: 삼각형마다 층 평면으로 잘라 띠별 조각을 만드는 것은 terrainSteps 와 같다. 다만 조각을 삼각분할해 쌓지 않고
 * 조각의 변만 띠별로 모은다. 같은 띠의 이웃 조각이 공유하는 변은 서로 반대 방향으로 두 번 나오므로 지워지고,
 * 한 번만 나온 변이 띠 영역의 윤곽이다(등고선 + 메쉬 가장자리). 남은 변을 끝점으로 이어 고리를 만들고,
 * 반시계 고리는 외곽, 시계 고리는 구멍으로 두어 그 구멍을 품는 가장 작은 외곽에 붙인다.
 *
 * 전제: 삼각형은 위에서 볼 때 반시계(TinMesh 규약). 혹시 다른 방향이 섞여도 평면 넓이 부호로 바로잡는다.
 * 정점 비교는 terrainSteps 와 같이 mm 로 반올림한 (x, y) 숫자 키로 한다. 잘린 점은 변의 두 끝점을 좌표 순으로 정렬한 뒤
 * 보간해, 이웃 삼각형이 같은 변을 잘라도 비트까지 같은 점이 나오게 한다(키가 어긋나 변이 안 지워지는 일을 막는다).
 */
import type { TinMesh } from "../terrainData"

type P = [number, number, number]
/** 평면 좌표 (x, y), m */
export type P2 = [number, number]

/** 띠 영역 하나: 외곽 고리(반시계)와 그 안의 구멍 고리들(시계) */
export type BandPolygon = { outer: P2[]; holes: P2[][] }

/** 띠 하나. 판의 윗면 높이 zTop = k·step, 아랫면 zBottom = (k − 1)·step */
export type TerrainBand = { k: number; zTop: number; zBottom: number; polygons: BandPolygon[] }

export type TerrainBandsResult = {
    /** 낮은 띠부터 */
    bands: TerrainBand[]
    /** 끝까지 이어도 시작점으로 돌아오지 못해 버린 변 사슬 수. 0 이어야 정상이다 */
    openChains: number
    /** 넓이가 0에 가까워 버린 고리 수 */
    emptyRings: number
    /** 품는 외곽을 찾지 못해 버린 구멍 수. 0 이어야 정상이다 */
    orphanHoles: number
}

/** z 를 step 으로 나눈 층 번호. 정수 높이 정점이 부동소수점 오차로 아래 층에 떨어지지 않게 작은 값을 더한다(terrainSteps 와 같음) */
const bandOf = (z: number, step: number) => Math.floor(z / step + 1e-6)

// (x, y) → mm 정수 키. 비트 배분과 한도는 terrainSteps.makeXyKey 와 같다
const KEY_Y_BITS = 26
const KEY_Y_SPAN = 2 ** KEY_Y_BITS
const KEY_X_SPAN = 2 ** (53 - KEY_Y_BITS)
const KEY_MARGIN_MM = 1000
/** 평면 넓이(m²)가 이보다 작은 삼각형은 영역에 기여하지 않으므로 건너뛴다 */
const MIN_TRIANGLE_AREA2 = 1e-9
/** 고리 넓이(m²)가 이보다 작으면 버린다 */
const MIN_RING_AREA = 1e-6
const PROGRESS_EVERY_TRIANGLES = 8192

/**
 * 띠 하나의 아직 안 지워진 변: 시작점 키 → (끝점 키 → 시작점 좌표와 개수).
 * 개수를 두는 이유: 잘린 점 둘이 mm 키로는 같은 점이 될 수 있어, 조각 하나가 키 기준으로 X→a, a→X, X→X 처럼 접힌
 * 꼴이 되기도 한다. 그러면 이웃 조각의 X→a 와 겹쳐 같은 방향 변이 둘이 되는데, 하나로 덮어쓰면 수가 안 맞아
 * 고리가 안 닫힌다(검증에서 실제로 나왔다). 같은 방향 변은 세어 두고 반대 방향이 올 때마다 하나씩 뺀다
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
 * 볼록 다각형을 평면 z = level 로 잘라 아래쪽(z ≤ level)과 위쪽(z ≥ level)으로 나눈다(terrainSteps.splitPolygon 과 같은 규칙).
 * 평면 위에 놓인 정점과 교차점은 양쪽에 모두 들어가고 정점 순서는 유지된다.
 *
 * 층 높이와의 차가 eps 이하인 정점은 층 위에 놓인 것으로 본다. bandOf 가 층 높이보다 1e-6·step 만큼 낮은 정점까지 그 층으로
 * 치므로, 자르기도 같은 기준을 써야 한다. 그러지 않으면 그런 정점을 가진 삼각형은 층 번호상 자르지 않는데 이웃 삼각형은
 * 자르면서 그 정점을 아래쪽으로 보내, 두 조각의 변이 서로 지워지지 않고 남는다(검증에서 실제로 안 닫힌 사슬로 나왔다).
 */
const split = (poly: P[], level: number, eps: number) => {
    const below: P[] = []
    const above: P[] = []
    const side = (p: P) => {
        const d = p[2] - level
        return Math.abs(d) <= eps ? 0 : d
    }
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i]
        const b = poly[(i + 1) % poly.length]
        const da = side(a)
        const db = side(b)
        if (da <= 0) below.push(a)
        if (da >= 0) above.push(a)
        if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
            const p = cut(a, b, level)
            below.push(p)
            above.push(p)
        }
    }
    return { below, above }
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

/**
 * TIN 메쉬를 띠별 다각형으로 나눈다.
 *
 * @param mesh 원본 TIN 메쉬(원점 기준 좌표). 삼각형은 위에서 볼 때 반시계가 규약이지만 다른 방향이 섞여도 된다
 * @param step 층 간격(m). 1이면 1m 마다 한 띠
 * @param onProgress 진행률 알림(선택). 처리한 삼각형 수와 전체 수. 자르기 단계만 세고 고리 잇기는 포함하지 않는다
 * @returns 낮은 띠부터의 목록과 버린 것들의 수
 */
export const buildTerrainBands = (
    mesh: TinMesh,
    step: number,
    onProgress?: (done: number, total: number) => void,
): TerrainBandsResult => {
    const { positions: P0, indices: I0 } = mesh

    // ---- (x, y) 키: 메쉬 최소 x·y 기준, mm ----
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (let i = 0; i < P0.length; i += 3) {
        const x = P0[i], y = P0[i + 1]
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
    }
    const spanX = Math.round((maxX - minX) * 1000) + 2 * KEY_MARGIN_MM
    const spanY = Math.round((maxY - minY) * 1000) + 2 * KEY_MARGIN_MM
    if (spanX >= KEY_X_SPAN || spanY >= KEY_Y_SPAN) {
        throw new Error(
            `띠 변환 범위 초과: 메쉬 가로 ${(spanX / 1e6).toFixed(1)}km × 세로 ${(spanY / 1e6).toFixed(1)}km ` +
                `(한도 가로 ${(KEY_X_SPAN / 1e6).toFixed(1)}km × 세로 ${(KEY_Y_SPAN / 1e6).toFixed(1)}km)`,
        )
    }
    const ox = Math.round(minX * 1000) - KEY_MARGIN_MM
    const oy = Math.round(minY * 1000) - KEY_MARGIN_MM
    const keyOf = (x: number, y: number) => (Math.round(x * 1000) - ox) * KEY_Y_SPAN + (Math.round(y * 1000) - oy)
    /** 층 높이로 간주하는 z 오차. bandOf 의 1e-6 과 같은 비율 */
    const levelEps = step * 1e-6

    // ---- 1) 삼각형을 잘라 띠별로 조각의 변을 모은다. 반대 방향의 같은 변이 오면 둘 다 지운다 ----
    const bandEdges = new Map<number, EdgeMap>()
    const addEdge = (k: number, p: P, q: P) => {
        const kp = keyOf(p[0], p[1])
        const kq = keyOf(q[0], q[1])
        if (kp === kq) return
        let edges = bandEdges.get(k)
        if (!edges) {
            edges = new Map()
            bandEdges.set(k, edges)
        }
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
        else out.set(kq, { p: [p[0], p[1]], n: 1 })
    }
    const addPiece = (k: number, poly: P[]) => {
        for (let i = 0; i < poly.length; i++) addEdge(k, poly[i], poly[(i + 1) % poly.length])
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
        if (Math.abs(area2) < MIN_TRIANGLE_AREA2) continue
        if (area2 < 0) [tri[1], tri[2]] = [tri[2], tri[1]]

        const kMin = bandOf(Math.min(a[2], b[2], c[2]), step)
        const kMax = bandOf(Math.max(a[2], b[2], c[2]), step)
        let poly = tri
        for (let k = kMin + 1; k <= kMax; k++) {
            const { below, above } = split(poly, k * step, levelEps)
            if (below.length >= 3) addPiece(k - 1, below)
            poly = above
        }
        if (poly.length >= 3) addPiece(kMax, poly)
    }
    onProgress?.(nTri, nTri)

    // ---- 2) 띠마다 남은 변을 이어 고리로 만들고 외곽·구멍으로 나눈다 ----
    let openChains = 0, emptyRings = 0, orphanHoles = 0
    const bands: TerrainBand[] = []
    for (const k of [...bandEdges.keys()].sort((x, y) => x - y)) {
        const edges = bandEdges.get(k)!
        const outers: { ring: P2[]; area: number; box: [number, number, number, number] }[] = []
        const holes: P2[][] = []
        const emitRing = (ring: P2[]) => {
            const area = ringArea(ring)
            if (Math.abs(area) < MIN_RING_AREA) {
                emptyRings++
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
                    for (const k of keys.splice(seen)) at.delete(k)
                    emitRing(ring.splice(seen))
                }
            }
            if (!closed) {
                openChains++
                continue
            }
            emitRing(ring)
        }

        // 구멍은 그것을 품는 가장 작은 외곽에 붙인다(구멍 속의 섬은 자기 외곽을 따로 가지므로 넓이 오름차순으로 찾는다).
        // 구멍의 꼭짓점이 외곽 경계와 맞닿아 판정이 흔들릴 수 있어, 안이라고 나오는 꼭짓점이 나올 때까지 차례로 본다
        outers.sort((p, q) => p.area - q.area)
        const polygons: BandPolygon[] = outers.map(({ ring }) => ({ outer: ring, holes: [] }))
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
            if (!found) orphanHoles++
        }
        bands.push({ k, zTop: k * step, zBottom: (k - 1) * step, polygons })
    }
    return { bands, openChains, emptyRings, orphanHoles }
}
