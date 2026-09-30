import { MeshChunk, TinMesh } from "./terrainData"

type P = [number, number, number]

/** z 를 step 으로 나눈 층 번호. 정수 높이 정점이 부동소수점 오차로 아래 층에 떨어지지 않게 작은 값을 더한다 */
const bandOf = (z: number, step: number) => Math.floor(z / step + 1e-6)

/**
 * 꽉 차면 2배로 늘리는 typed array. JS 일반 배열의 최대 길이(약 1억 개) 한계를 피하고 메모리도 절반이다.
 *
 * @param make 길이를 받아 typed array 를 만드는 함수
 * @returns push3(값 3개 추가), length(현재 길이), result(꼭 맞는 길이로 복사한 배열)
 */
const growable = <T extends Float32Array | Uint32Array>(make: (n: number) => T) => {
    let buf = make(1 << 16)
    let length = 0
    const push3 = (a: number, b: number, c: number) => {
        if (length + 3 > buf.length) {
            const next = make(buf.length * 2)
            next.set(buf)
            buf = next
        }
        buf[length++] = a
        buf[length++] = b
        buf[length++] = c
    }
    return {
        push3,
        length: () => length,
        result: () => buf.slice(0, length) as T,
        /** 비우고 작은 버퍼로 돌아간다(큰 버퍼를 붙들고 있지 않게) */
        reset: () => {
            buf = make(1 << 16)
            length = 0
        },
    }
}

/**
 * (x, y) 를 mm 로 반올림해 53비트 안전 정수 하나로 만든다. 문자열 키보다 Map 이 가볍다.
 * 원점 기준 ±33km 범위까지 표현할 수 있다.
 */
const XY_OFFSET = 1 << 25 // 33,554,432 mm
const xyKey = (x: number, y: number) =>
    (Math.round(x * 1000) + XY_OFFSET) * 67108864 + (Math.round(y * 1000) + XY_OFFSET) // 2^26

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
 * 판은 "등고선 사이 영역 전체"를 한 다각형으로 만들지 않는다. TIN 삼각형 하나씩 잘라서 나온 볼록 조각을
 * 그때그때 삼각 분할해 넣고(pushPlate), 조각들이 모여 판이 된다. 그래서 판 전체의 오목한 모양이나 구멍을
 * 따로 처리할 필요가 없다. 대신 조각 경계마다 정점이 생기는데, 좌표가 같은 정점은 하나로 공유하므로 이음새는 없다.
 *
 * 법선은 넣지 않는다. 판·벽이 모두 평면이라 셰이더가 화면 미분으로 면 법선을 구하며(stepped 모드),
 * 그 덕에 좌표가 같은 정점(판 모서리 = 벽 모서리 = 이웃 판 모서리)을 mm 단위로 비교해 하나로 공유한다.
 * 판·벽의 z 는 항상 층 높이라서, 층 번호별 Map 에 (x, y) 숫자 키로 정점을 찾는다.
 *
 * 결과는 메쉬 하나가 아니라 GPU 버퍼 한도(maxBytes) 안에 들어가는 조각들이다. 원본 삼각형을 처리하기 전에
 * 그 삼각형이 최악의 경우 만들 수 있는 정점·인덱스 수만큼 여유가 없으면 지금까지 쌓인 것을 조각으로 내보내고(yield)
 * 새 조각을 시작한다. 그래서 배열 하나가 한도를 넘는 일이 없고, 받는 쪽이 조각을 바로 GPU 에 올리고 버리면
 * 브라우저 메모리도 조각 하나 분량만 쓴다. 정점 합치기 Map 은 조각마다 새로 시작하므로 조각 경계의 정점은 양쪽에 중복되고,
 * 벽 중복 제거는 전체에서 유지한다.
 *
 * @param mesh 원본 TIN 메쉬(원점 기준 좌표)
 * @param step 층 간격(m). 1이면 1m 마다 한 층
 * @param maxBytes 조각의 정점 버퍼·인덱스 버퍼 각각의 최대 바이트 수 (device.limits.maxBufferSize)
 * @yields 판·벽으로 이루어진 인덱스 메쉬 조각
 */
export function* buildSteppedMeshChunks(
    mesh: TinMesh,
    step: number,
    maxBytes: number,
): Generator<MeshChunk> {
    const started = performance.now()
    const { positions: P0, indices: I0 } = mesh
    const maxVerts = Math.floor(maxBytes / 12)
    const maxIndices = Math.floor(maxBytes / 4)
    const positions = growable((n) => new Float32Array(n))
    const indices = growable((n) => new Uint32Array(n))
    let chunkCount = 0
    let totalTriangles = 0
    let totalVertices = 0
    /** 층 번호 → ((x, y) 키 → 정점 인덱스). 조각마다 비운다 */
    const vertexMaps = new Map<number, Map<number, number>>()
    /** 벽 윗면 층 번호 → (작은 끝점 키 → 큰 끝점 키 집합) */
    const wallSets = new Map<number, Map<number, Set<number>>>()

    /** 좌표가 같은(mm 단위) 정점은 한 번만 넣고 그 인덱스를 돌려준다 */
    const vertexOf = (x: number, y: number, z: number) => {
        const k = Math.round(z / step)
        let byXy = vertexMaps.get(k)
        if (!byXy) {
            byXy = new Map()
            vertexMaps.set(k, byXy)
        }
        const key = xyKey(x, y)
        let idx = byXy.get(key)
        if (idx === undefined) {
            idx = positions.length() / 3
            byXy.set(key, idx)
            positions.push3(x, y, z)
        }
        return idx
    }

    const pushTri = (a: P, b: P, c: P) => {
        indices.push3(vertexOf(...a), vertexOf(...b), vertexOf(...c))
    }

    /**
     * 볼록 다각형을 부채꼴(첫 꼭짓점에서 나머지를 차례로 잇는 방식)로 삼각 분할해 높이 z 의 판으로 넣는다.
     *
     * 부채꼴 분할은 볼록 다각형에서만 올바르다. 오목한 곳이 있으면 다각형 밖으로 나가는 삼각형이 생긴다.
     * 여기서 이 방식을 써도 되는 이유:
     * - 이 함수에 들어오는 poly 는 언제나 "TIN 삼각형 하나를 수평면으로 자른 조각"이다.
     * - 삼각형은 볼록이고, 볼록 다각형을 평면으로 자르면 양쪽 조각도 볼록이다(여러 번 잘라도 마찬가지).
     *   splitPolygon 이 꼭짓점 순서를 유지하므로 3~5개 꼭짓점의 볼록 다각형이 순서대로 들어온다.
     * - 등고선 판 전체는 볼록이 아니지만, 이 함수는 판 전체를 받는 게 아니라 조각 하나씩 받는다.
     *   TIN 삼각형들이 평면을 빈틈·겹침 없이 나누고 각 삼각형 안의 조각들도 그렇게 나뉘므로, 조각을 모두 모으면
     *   판 전체가 밖으로 나가는 삼각형 없이 덮인다.
     * - 부동소수점 오차로 볼록성이 아주 미세하게 깨질 수 있는데, 그때 생기는 것은 넓이가 거의 0인 삼각형이라
     *   area2 문턱값으로 걸러낸다.
     *
     * 나중에 판 전체를 하나의 다각형으로 다루게 되면(층별로 조각을 합쳐 삼각형 수를 줄이거나 등고선 윤곽을 뽑는 경우)
     * 이 함수를 그대로 쓰면 안 되고, 오목 다각형과 구멍을 지원하는 삼각 분할(ear clipping, 제약 Delaunay 등)이 필요하다.
     *
     * @param poly 볼록 다각형 꼭짓점(둘레 순서)
     * @param z 판 높이. 모든 꼭짓점의 z 를 이 값으로 바꿔 넣는다
     */
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
        let keyP = xyKey(p[0], p[1])
        let keyQ = xyKey(q[0], q[1])
        if (keyP > keyQ) [keyP, keyQ] = [keyQ, keyP]
        const kTop = Math.round(zTop / step)
        let byP = wallSets.get(kTop)
        if (!byP) {
            byP = new Map()
            wallSets.set(kTop, byP)
        }
        let qs = byP.get(keyP)
        if (!qs) {
            qs = new Set()
            byP.set(keyP, qs)
        }
        if (qs.has(keyQ)) return
        qs.add(keyQ)

        const p0: P = [p[0], p[1], zBottom]
        const p1: P = [q[0], q[1], zBottom]
        const p2: P = [q[0], q[1], zTop]
        const p3: P = [p[0], p[1], zTop]
        pushTri(p0, p1, p2)
        pushTri(p0, p2, p3)
    }

    /** 쌓인 것을 조각으로 만들고 새 조각을 시작한다 */
    const flush = (): MeshChunk => {
        const chunk = { positions: positions.result(), indices: indices.result() }
        chunkCount++
        totalTriangles += chunk.indices.length / 3
        totalVertices += chunk.positions.length / 3
        positions.reset()
        indices.reset()
        vertexMaps.clear()
        return chunk
    }

    for (let t = 0; t < I0.length; t += 3) {
        const tri: P[] = [0, 1, 2].map((k) => {
            const i = I0[t + k] * 3
            return [P0[i], P0[i + 1], P0[i + 2]] as P
        })
        const zs = tri.map((p) => p[2])
        const kMin = bandOf(Math.min(...zs), step)
        const kMax = bandOf(Math.max(...zs), step)

        // 이 삼각형이 만들 수 있는 최대 출력: 층을 L번 지나면 판 조각 L+1개(각 ≤ 3 삼각형) + 벽 L개 + 변 벽 3개(각 2 삼각형)
        // = 5L + 9 삼각형, 정점은 그 3배. 이만큼 여유가 없으면 조각을 끊는다
        const worstTriangles = 5 * (kMax - kMin) + 9
        if (
            indices.length() > 0 &&
            (indices.length() + worstTriangles * 3 > maxIndices ||
                positions.length() + worstTriangles * 9 > maxVerts * 3)
        ) {
            yield flush()
        }

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

        // 삼각형을 낮은 층부터 차례로 자른다. poly 는 "아직 안 자른 위쪽 나머지"로, 자를 때마다 볼록성이 유지된다
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
    if (indices.length() > 0) yield flush()

    console.log(
        `계단형(${step}m): 원본 삼각형 ${I0.length / 3} → ${totalTriangles}, 정점 ${totalVertices}, ${chunkCount}조각, ${Math.round(performance.now() - started)}ms (받는 쪽 처리 시간 포함)`,
    )
}
