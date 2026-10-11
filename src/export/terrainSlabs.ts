/**
 * TIN 지형을 층 간격(step)마다 "판" 다각형으로 나눈다. 건축 모형처럼 맨 아래 판(메쉬 전체) 위에 다음 레벨 판을
 * 차례로 쌓는 구조라, SKP 내보내기의 계단형 지형이 SketchUp 에서 판을 step 두께로 push 해 쌓은 것과 같은 면·그룹이 된다.
 *
 * 판 k 는 지형 높이 z 가 k·step 이상인 평면 영역이다. 화면의 계단형(terrainSteps)이 k·step ≤ z < (k+1)·step 인 띠를
 * 높이 k·step 의 판으로 그리므로, 판 k 의 윗면을 k·step, 아랫면을 (k−1)·step 으로 두고(두께 step) 쌓으면 맨 위에 보이는
 * 면이 화면과 같다. 영역은 섬이 여럿일 수 있고 골짜기 구멍도 있을 수 있어, 판 하나가 (외곽 고리 + 구멍 고리들) 여러 개로 나온다.
 *
 * 방법: "k 이상" 영역의 윤곽은 레벨 k·step 의 등고선과, 메쉬 가장자리 중 z ≥ k·step 인 부분이다.
 * - 등고선: 레벨을 지나는 삼각형을 그 평면으로 잘라 위쪽 조각을 만들고, 조각의 변 중 양 끝이 레벨 위에 놓인 것만 모은다.
 *   레벨 높이에 평평하게 놓인 변은 이웃 조각에서 반대 방향으로 한 번 더 나오므로 서로 지운다(개수를 세어 지운다).
 * - 가장자리: 삼각형 하나에만 속한 변(경계 변)을 한 번 찾아 두고, 레벨마다 z ≥ k·step 인 부분만 잘라 넣는다.
 * 조각 안쪽 변은 이웃 조각과 반드시 지워지므로 아예 넣지 않는다. 그래서 비용이 레벨 수 × 삼각형 수가 아니라
 * (레벨을 지나는 삼각형·레벨 쌍 수) + (경계 변 수 × 레벨 수) 다.
 * 남은 변을 끝점으로 이어 고리를 만들고, 반시계 고리는 외곽, 시계 고리는 구멍으로 두어 그 구멍을 품는 가장 작은 외곽에 붙인다.
 * 가장자리가 사각형 변을 따라 수백 개 점으로 쪼개져 있으므로 일직선 위의 연속 꼭짓점은 합친다(옆면 벽 수를 줄인다).
 *
 * 전제: 삼각형은 위에서 볼 때 반시계(TinMesh 규약). 혹시 다른 방향이 섞여도 평면 넓이 부호로 바로잡는다.
 * 정점 비교는 terrainSteps 와 같이 mm 로 반올림한 (x, y) 숫자 키로 한다. 잘린 점은 변의 두 끝점을 좌표 순으로 정렬한 뒤
 * 보간해, 등고선 쪽과 가장자리 쪽이 같은 변을 잘라도 비트까지 같은 점이 나오게 한다(키가 어긋나 고리가 안 닫히는 일을 막는다).
 */
import type { TinMesh } from "../terrainData"

type P = [number, number, number]
/** 평면 좌표 (x, y), m */
export type P2 = [number, number]

/** 판 영역 하나: 외곽 고리(반시계)와 그 안의 구멍 고리들(시계) */
export type SlabPolygon = { outer: P2[]; holes: P2[][] }

/** 판 하나. 윗면 높이 zTop = k·step, 아랫면 zBottom = (k − 1)·step. 영역은 z ≥ zTop 인 곳 */
export type TerrainSlab = { k: number; zTop: number; zBottom: number; polygons: SlabPolygon[] }

export type TerrainSlabsResult = {
    /** 낮은 판부터. 첫 판은 메쉬 전체다 */
    slabs: TerrainSlab[]
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
/** 평면 넓이(m²)가 이보다 작은 삼각형은 영역에 기여하지 않으므로 등고선을 만들지 않는다(경계 변 세기에는 넣는다) */
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

/**
 * 고리를 Douglas–Peucker 로 단순화한다. 원래 꼭짓점 모두가 단순화된 선에서 COLLINEAR_DIST_M 안에 남도록 보장하므로,
 * 이웃 세 점만 보고 하나씩 빼는 방식과 달리 완만한 긴 곡선에서 오차가 누적되지 않는다(그 방식은 2mm 기준으로도
 * 수 m 까지 밀렸다). 닫힌 고리라 점 0 과 거기서 가장 먼 점을 고정점으로 두고 두 반쪽을 따로 돌린다.
 * 고리가 세 점 미만으로 줄면 빈 배열
 */
const simplifyRing = (ring: P2[]) => {
    const n = ring.length
    if (n < 3) return []
    let far = 0, farD = -1
    for (let i = 1; i < n; i++) {
        const d = (ring[i][0] - ring[0][0]) ** 2 + (ring[i][1] - ring[0][1]) ** 2
        if (d > farD) {
            farD = d
            far = i
        }
    }
    const keep = new Uint8Array(n)
    keep[0] = 1
    keep[far] = 1
    const pt = (i: number) => ring[i % n]
    const stack: [number, number][] = [
        [0, far],
        [far, n],
    ]
    while (stack.length > 0) {
        const [i0, i1] = stack.pop()!
        let worst = 0, at = -1
        for (let i = i0 + 1; i < i1; i++) {
            const d = segmentDistance(pt(i), pt(i0), pt(i1))
            if (d > worst) {
                worst = d
                at = i
            }
        }
        if (at >= 0 && worst > COLLINEAR_DIST_M) {
            keep[at % n] = 1
            stack.push([i0, at], [at, i1])
        }
    }
    const out: P2[] = []
    for (let i = 0; i < n; i++) if (keep[i]) out.push(ring[i])
    return out.length < 3 ? [] : out
}

/**
 * TIN 메쉬를 쌓는 판별 다각형으로 나눈다.
 *
 * @param mesh 원본 TIN 메쉬(원점 기준 좌표). 삼각형은 위에서 볼 때 반시계가 규약이지만 다른 방향이 섞여도 된다
 * @param step 층 간격(m). 1이면 1m 마다 한 판
 * @param onProgress 진행률 알림(선택). 처리한 삼각형 수와 전체 수. 자르기 단계만 세고 고리 잇기는 포함하지 않는다
 * @returns 낮은 판부터의 목록과 버린 것들의 수
 */
export const buildTerrainSlabs = (
    mesh: TinMesh,
    step: number,
    onProgress?: (done: number, total: number) => void,
): TerrainSlabsResult => {
    const { positions: P0, indices: I0 } = mesh

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
    /** 층 높이로 간주하는 z 오차. bandOf 의 1e-6 과 같은 비율 */
    const levelEps = step * 1e-6
    const kMinAll = bandOf(minZ, step)
    const kMaxAll = bandOf(maxZ, step)

    // ---- 판별 변 모으기 ----
    const slabEdges = new Map<number, EdgeMap>()
    const addEdge = (k: number, p: P, q: P) => {
        const kp = keyOf(p[0], p[1])
        const kq = keyOf(q[0], q[1])
        if (kp === kq) return
        let edges = slabEdges.get(k)
        if (!edges) {
            edges = new Map()
            slabEdges.set(k, edges)
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

    // ---- 1) 삼각형마다: 경계 변 세기 + 지나는 레벨마다 등고선 변 ----
    /** 무방향 변(작은 키 → 큰 키) → 처음 본 방향의 두 끝점과 등장 횟수. 횟수 1 이면 경계 변 */
    const edgeCount = new Map<number, Map<number, { p: P; q: P; n: number }>>()
    const countEdge = (p: P, q: P) => {
        const kp = keyOf(p[0], p[1])
        const kq = keyOf(q[0], q[1])
        if (kp === kq) return
        const [lo, hi] = kp < kq ? [kp, kq] : [kq, kp]
        let byHi = edgeCount.get(lo)
        if (!byHi) {
            byHi = new Map()
            edgeCount.set(lo, byHi)
        }
        const e = byHi.get(hi)
        if (e) e.n++
        else byHi.set(hi, { p, q, n: 1 })
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
        for (let i = 0; i < 3; i++) countEdge(tri[i], tri[(i + 1) % 3])
        if (Math.abs(area2) < MIN_TRIANGLE_AREA2) continue

        const kMin = bandOf(Math.min(a[2], b[2], c[2]), step)
        const kMax = bandOf(Math.max(a[2], b[2], c[2]), step)
        // kMin 도 돈다: 변의 양 끝이 정확히 kMin·step 높이에 놓인 삼각형은 자르지 않아도 그 변이 레벨 kMin 의 등고선이다
        // (등고선 원본 DEM 은 정수 높이 정점이 많다). 아래쪽 이웃은 그 레벨에서 조각이 선 하나(점 2개)라 아무것도 내지 않으므로
        // 이 변이 남아 윤곽이 된다. 위쪽 이웃도 같은 변을 내면 반대 방향이라 지워진다
        for (let k = kMin; k <= kMax; k++) {
            const level = k * step
            const piece = above(tri, level, levelEps)
            if (piece.length < 3) continue
            for (let i = 0; i < piece.length; i++) {
                const p = piece[i]
                const q = piece[(i + 1) % piece.length]
                if (Math.abs(p[2] - level) <= levelEps && Math.abs(q[2] - level) <= levelEps) addEdge(k, p, q)
            }
        }
    }
    onProgress?.(nTri, nTri)

    // ---- 2) 경계 변마다: 레벨마다 z ≥ 레벨인 부분을 넣는다 ----
    for (const byHi of edgeCount.values()) {
        for (const { p, q, n } of byHi.values()) {
            if (n !== 1) continue
            const kTop = bandOf(Math.max(p[2], q[2]), step)
            for (let k = kMinAll; k <= kTop; k++) {
                const level = k * step
                const side = (v: P) => {
                    const d = v[2] - level
                    return Math.abs(d) <= levelEps ? 0 : d
                }
                const sp = side(p), sq = side(q)
                if (sp >= 0 && sq >= 0) addEdge(k, p, q)
                else if (sp > 0 && sq < 0) addEdge(k, p, cut(p, q, level))
                else if (sp < 0 && sq > 0) addEdge(k, cut(p, q, level), q)
                // 한쪽이 정확히 레벨 위이고 다른 쪽이 아래면 남는 부분이 점 하나라 넣지 않는다
            }
        }
    }
    edgeCount.clear()

    // ---- 3) 판마다 남은 변을 이어 고리로 만들고 외곽·구멍으로 나눈다 ----
    let openChains = 0, emptyRings = 0, orphanHoles = 0
    const slabs: TerrainSlab[] = []
    for (let k = kMinAll; k <= kMaxAll; k++) {
        const edges = slabEdges.get(k)
        if (!edges) continue
        const outers: { ring: P2[]; area: number; box: [number, number, number, number] }[] = []
        const holes: P2[][] = []
        const emitRing = (raw: P2[]) => {
            const ring = simplifyRing(raw)
            const area = ring.length < 3 ? 0 : ringArea(ring)
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
                    for (const key of keys.splice(seen)) at.delete(key)
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
            if (!found) orphanHoles++
        }
        slabs.push({ k, zTop: k * step, zBottom: (k - 1) * step, polygons })
    }
    return { slabs, openChains, emptyRings, orphanHoles }
}
