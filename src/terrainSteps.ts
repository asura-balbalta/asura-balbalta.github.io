import { TinMesh } from "./terrainData"

type P = [number, number, number]

/** z 를 step 으로 나눈 층 번호. 정수 높이 정점이 부동소수점 오차로 아래 층에 떨어지지 않게 작은 값을 더한다 */
const bandOf = (z: number, step: number) => Math.floor(z / step + 1e-6)

/**
 * 볼록 다각형을 평면 z = level 로 잘라 아래쪽(z ≤ level)과 위쪽(z ≥ level)으로 나눈다.
 * 평면 위에 놓인 정점과 교차점은 양쪽에 모두 들어간다.
 *
 * @param poly 다각형 정점(순서 유지)
 * @param level 자르는 높이
 * @returns below(아래 조각), above(위 조각)
 */
const splitPolygon = (poly: P[], level: number) => {
    const below: P[] = []
    const above: P[] = []
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i]
        const b = poly[(i + 1) % poly.length]
        const da = a[2] - level
        const db = b[2] - level
        if (da <= 0) below.push(a)
        if (da >= 0) above.push(a)
        if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
            const t = da / (da - db)
            const p: P = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, level]
            below.push(p)
            above.push(p)
        }
    }
    return { below, above }
}

/**
 * 다각형 정점 중 z 가 level 인 점들에서 가장 멀리 떨어진 두 점을 고른다(= 평면과의 교차 선분).
 * 두 점이 사실상 같은 위치이거나 하나뿐이면 null.
 */
const levelSegment = (poly: P[], level: number): [P, P] | null => {
    const pts = poly.filter((p) => p[2] === level)
    if (pts.length < 2) return null
    let best: [P, P] | null = null
    let bestD = 1e-6
    for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
            const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1])
            if (d > bestD) {
                bestD = d
                best = [pts[i], pts[j]]
            }
        }
    }
    return best
}

/**
 * TIN 메쉬를 등고선 모형(콘타)처럼 계단형 메쉬로 바꾼다.
 *
 * 각 삼각형을 높이 k·step 평면들로 잘라, 조각마다 z 를 그 구간의 바닥 높이로 눌러 평평한 판을 만들고,
 * 잘린 선(등고선)을 아래 판 높이에서 위 판 높이까지 세워 벽을 만든다.
 * 벽은 위에 판이 실제로 있는 곳에만 세우고, 같은 자리의 벽은 한 번만 넣는다.
 *
 * 법선은 넣지 않는다. 판·벽이 모두 평면이라 셰이더가 화면 미분으로 면 법선을 구하며(stepped 모드),
 * 그 덕에 좌표가 같은 정점(판 모서리 = 벽 모서리 = 이웃 판 모서리)을 mm 단위로 비교해 하나로 공유한다.
 *
 * @param mesh 원본 TIN 메쉬(원점 기준 좌표)
 * @param step 층 간격(m). 1이면 1m 마다 한 층
 * @returns 판·벽으로 이루어진 인덱스 메쉬
 */
export const buildSteppedMesh = (mesh: TinMesh, step: number): TinMesh => {
    const { positions: P0, indices: I0 } = mesh
    const positions: number[] = []
    const indices: number[] = []
    const vertexIndex = new Map<string, number>()
    const wallKeys = new Set<string>()

    /** 좌표가 같은(mm 단위) 정점은 한 번만 넣고 그 인덱스를 돌려준다 */
    const vertexOf = (p: P) => {
        const key = `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)},${Math.round(p[2] * 1000)}`
        let idx = vertexIndex.get(key)
        if (idx === undefined) {
            idx = positions.length / 3
            vertexIndex.set(key, idx)
            positions.push(p[0], p[1], p[2])
        }
        return idx
    }

    const pushTri = (a: P, b: P, c: P) => {
        indices.push(vertexOf(a), vertexOf(b), vertexOf(c))
    }

    /** 볼록 다각형을 부채꼴로 삼각 분할해 높이 z 의 판으로 넣는다. 넓이가 0에 가까운 삼각형은 뺀다 */
    const pushPlate = (poly: P[], z: number) => {
        for (let i = 1; i + 1 < poly.length; i++) {
            const a = poly[0]
            const b = poly[i]
            const c = poly[i + 1]
            const area2 = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
            if (Math.abs(area2) < 1e-8) continue
            pushTri([a[0], a[1], z], [b[0], b[1], z], [c[0], c[1], z])
        }
    }

    /** 선분 s 를 zBottom~zTop 으로 세운 벽(삼각형 2개). 같은 자리에 같은 높이의 벽은 한 번만 넣는다 */
    const pushWall = (s: [P, P], zBottom: number, zTop: number) => {
        const [p, q] = s
        const key =
            [p[0], p[1], q[0], q[1]]
                .map((v) => Math.round(v * 1000))
                .sort((x, y) => x - y)
                .join(",") + `@${zTop}`
        if (wallKeys.has(key)) return
        wallKeys.add(key)

        const p0: P = [p[0], p[1], zBottom]
        const p1: P = [q[0], q[1], zBottom]
        const p2: P = [q[0], q[1], zTop]
        const p3: P = [p[0], p[1], zTop]
        pushTri(p0, p1, p2)
        pushTri(p0, p2, p3)
    }

    for (let t = 0; t < I0.length; t += 3) {
        const tri: P[] = [0, 1, 2].map((k) => {
            const i = I0[t + k] * 3
            return [P0[i], P0[i + 1], P0[i + 2]] as P
        })
        const zs = tri.map((p) => p[2])
        const kMin = bandOf(Math.min(...zs), step)
        const kMax = bandOf(Math.max(...zs), step)

        // 정점이 정확히 층 높이에 놓인 변(등고선 위 정점끼리 이은 변)은 자르기로 생기지 않으므로 여기서 벽을 세운다.
        // 옆 삼각형이 더 낮으면 이 벽이 보이고, 같은 높이면 판 아래 숨는다
        const bottom = kMin * step
        for (let i = 0; i < 3; i++) {
            const a = tri[i]
            const b = tri[(i + 1) % 3]
            if (a[2] === bottom && b[2] === bottom) {
                pushWall([a, b], bottom - step, bottom)
            }
        }

        if (kMin === kMax) {
            pushPlate(tri, bottom)
            continue
        }

        let poly = tri
        for (let k = kMin + 1; k <= kMax; k++) {
            const level = k * step
            const { below, above } = splitPolygon(poly, level)
            if (below.length >= 3) pushPlate(below, (k - 1) * step)
            // 벽은 위에 판이 실제로 있는 곳(above 에 면적이 있는 곳)에만 세운다. 능선·둔덕 꼭대기처럼 판이 선 하나인 곳은 제외
            if (above.length >= 3) {
                const seg = levelSegment(above, level)
                if (seg) pushWall(seg, (k - 1) * step, level)
            }
            poly = above
        }
        if (poly.length >= 3) pushPlate(poly, kMax * step)
    }

    const stepped: TinMesh = {
        origin: mesh.origin,
        positions: new Float32Array(positions),
        indices: new Uint32Array(indices),
    }
    console.log(
        `계단형(${step}m): 원본 삼각형 ${I0.length / 3} → ${indices.length / 3}, 정점 ${positions.length / 3}`,
    )
    return stepped
}
