import earcut from "earcut"
import { MeshChunk, TinMesh } from "./terrainData"

type P = [number, number, number]

/** 진행률을 알리는 최소 간격(ms) */
const PROGRESS_INTERVAL_MS = 100
/** 진행률 시각을 확인하는 주기(인덱스 수 = 삼각형 4096개 × 3) */
const PROGRESS_CHECK_INDICES = 4096 * 3

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
 * (x, y) 를 mm 로 반올림해 53비트 안전 정수 하나로 만드는 키 함수를 만든다. 문자열 키보다 Map 이 가볍다.
 *
 * 기준점은 서버 원점이 아니라 메쉬 자체의 최소 x·y 다. 그래서 키 값은 항상 0 이상이고, 서버 원점이 범위의 어느 모서리든
 * 음수 좌표가 있든 상관없다. y 는 아래 KEY_Y_BITS 비트(67.1km), x 는 그 위 27비트(134.2km)를 써서 합이 정확히 53비트다.
 * 키는 정점을 "같은 점인지" 찾는 데만 쓰고 출력 좌표에는 들어가지 않는다.
 *
 * @param minX 메쉬 x 최소(m). 자르기 교차점이 부동소수점 오차로 이보다 조금 작을 수 있어 KEY_MARGIN_MM 만큼 여유를 둔다
 * @param minY 메쉬 y 최소(m)
 * @returns (x, y) → 키
 */
const KEY_Y_BITS = 26
/** y 키 범위(mm). 2^26 = 67,108,864 */
const KEY_Y_SPAN = 2 ** KEY_Y_BITS
/** x 키 범위(mm). 53 − 26 = 27비트, 2^27 = 134,217,728 */
const KEY_X_SPAN = 2 ** (53 - KEY_Y_BITS)
/** 최소값 아래로 허용하는 여유(mm) */
const KEY_MARGIN_MM = 1000
const makeXyKey = (minX: number, minY: number) => {
    const ox = Math.round(minX * 1000) - KEY_MARGIN_MM
    const oy = Math.round(minY * 1000) - KEY_MARGIN_MM
    return (x: number, y: number) =>
        (Math.round(x * 1000) - ox) * KEY_Y_SPAN + (Math.round(y * 1000) - oy)
}

/**
 * 메쉬 정점의 x·y 최소·최대(m). 키 기준점과 범위 검사에 쓴다.
 *
 * @param positions (x, y, z) 연속 배열
 */
const xyRange = (positions: Float32Array) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i], y = positions[i + 1]
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
    }
    return { minX, minY, maxX, maxY }
}

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
 * 원본 삼각형 안의 (x, y) 에서 세 정점 법선을 무게중심 보간해 정규화하는 함수를 만든다. 위에서 볼 때 넓이가 거의 0인 삼각형(수직면)은 평균을 쓴다
 *
 * @param tri 원본 삼각형 꼭짓점
 * @param vi 꼭짓점의 원본 정점 번호
 * @param N 원본 정점 법선
 */
const smoothNormalOf = (tri: P[], vi: number[], N: Float32Array) => {
    const [[x0, y0], [x1, y1], [x2, y2]] = tri
    const n = vi.map((i) => [N[i * 3], N[i * 3 + 1], N[i * 3 + 2]])
    const det = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
    return (x: number, y: number): P => {
        let l0 = 1 / 3
        let l1 = 1 / 3
        if (Math.abs(det) > 1e-9) {
            l0 = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) / det
            l1 = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) / det
        }
        const l2 = 1 - l0 - l1
        const v: P = [0, 1, 2].map((k) => l0 * n[0][k] + l1 * n[1][k] + l2 * n[2][k]) as P
        const len = Math.hypot(v[0], v[1], v[2]) || 1
        return [v[0] / len, v[1] / len, v[2] / len]
    }
}

/**
 * 계단형 조각. tags 옵션을 줬을 때만 tagRanges 가 붙는다: (태그, 첫 삼각형, 삼각형 수) 3개씩, 조각 안 삼각형 번호(인덱스 ÷ 3).
 * 원본 삼각형을 태그 순으로 정렬해 주면 태그마다 한 범위다. 벽은 중복 제거 때문에 그 벽을 먼저 만든 원본 삼각형의 태그를 따른다
 */
export type SteppedChunk = MeshChunk & { tagRanges?: Uint32Array }

/** (태그, 시작) 쌍을 (태그, 시작, 수) 로. 삼각형을 하나도 못 낸 구간(수 0)은 뺀다 */
const tagRangesOf = (runs: number[], total: number) => {
    const out: number[] = []
    for (let i = 0; i < runs.length; i += 2) {
        const end = i + 2 < runs.length ? runs[i + 3] : total
        if (end > runs[i + 1]) out.push(runs[i], runs[i + 1], end - runs[i + 1])
    }
    return Uint32Array.from(out)
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
 * 면 법선은 넣지 않는다. 판·벽이 모두 평면이라 셰이더가 화면 미분으로 면 법선을 구하며(stepped 모드),
 * 그 덕에 좌표가 같은 정점(판 모서리 = 벽 모서리 = 이웃 판 모서리)을 mm 단위로 비교해 하나로 공유한다.
 * 판·벽의 z 는 항상 층 높이라서, 층 번호별 Map 에 (x, y) 숫자 키(makeXyKey, 메쉬 최소 x·y 기준)로 정점을 찾는다.
 * 그래서 메쉬 크기가 가로 134km × 세로 67km 를 넘으면 키가 겹칠 수 있어 시작 전에 오류를 던진다.
 *
 * 결과는 메쉬 하나가 아니라 GPU 버퍼 한도(maxBytes) 안에 들어가는 조각들이다. 원본 삼각형을 처리하기 전에
 * 그 삼각형이 최악의 경우 만들 수 있는 정점·인덱스 수만큼 여유가 없으면 지금까지 쌓인 것을 조각으로 내보내고(yield)
 * 새 조각을 시작한다. 그래서 배열 하나가 한도를 넘는 일이 없고, 받는 쪽이 조각을 바로 GPU 에 올리고 버리면
 * 브라우저 메모리도 조각 하나 분량만 쓴다. 정점 합치기 Map 과 벽 중복 제거 집합은 조각마다 새로 시작한다. 그래서 조각 경계의
 * 정점은 양쪽에 중복되고, 조각 경계를 넘는 벽도 중복될 수 있다. 중복되는 벽은 "양쪽 판이 같은 높이인 등고선 위의 변"에 세운
 * 것뿐이라 판 아래에 숨어 보이지 않으므로 그리는 결과는 같다. (벽 집합을 전체에서 유지하면 벽 시작점마다 Set 객체가 남아
 * 넓은 범위에서 수 GB 로 자라 Worker 가 메모리 부족으로 죽는다)
 *
 * @param mesh 원본 TIN 메쉬(원점 기준 좌표)
 * @param step 층 간격(m). 1이면 1m 마다 한 층
 * @param maxBytes 조각의 정점 버퍼·인덱스 버퍼 각각의 최대 바이트 수 (device.limits.maxBufferSize)
 * 원본 정점 법선(options.normals)을 주면 정점마다 "그 자리의 매끈한 지형 법선"(원본 삼각형 안에서 x·y 무게중심 보간)을 normals 로 같이 낸다.
 * 셰이더가 한 층이 화면에서 몇 px 안 될 때 면 법선 대신 이것으로 조명해 판(밝음)·벽(어두움)이 픽셀 간격으로 번갈아 생기는 무아레를 없앤다
 * (2026-10-22). 이웃 원본 삼각형과 공유하는 변 위에서는 양쪽 보간값이 같아 정점을 공유해도 이음새가 없다(먼저 만든 쪽 값을 쓴다)
 *
 * @param onProgress 진행률 알림(선택). 처리한 원본 삼각형 수와 전체 수를 약 PROGRESS_INTERVAL_MS 간격으로 받고,
 *   끝나면 (전체, 전체)를 한 번 더 받는다(간격 때문에 100% 가 빠지지 않게)
 * @yields 판·벽으로 이루어진 인덱스 메쉬 조각
 */
export function* buildSteppedMeshChunks(
    mesh: TinMesh,
    step: number,
    maxBytes: number,
    onProgress?: (done: number, total: number) => void,
    /**
     * quiet: 끝에 요약 로그를 찍지 않는다(도로 내보내기가 그룹마다 부를 때). normals: 원본 정점 법선(있으면 매끈한 법선을 같이 낸다).
     * tags: 원본 삼각형마다 태그(녹지 분류 등, 길이 = 삼각형 수). 주면 조각에 tagRanges 를 붙인다(SteppedChunk). 안 주면 출력은 이 옵션 전과 같다
     */
    options: { quiet?: boolean; normals?: Float32Array; tags?: Uint8Array } = {},
): Generator<SteppedChunk> {
    const started = performance.now()
    let lastProgress = started
    const { positions: P0, indices: I0 } = mesh

    const { minX, minY, maxX, maxY } = xyRange(P0)
    const spanX = Math.round((maxX - minX) * 1000) + 2 * KEY_MARGIN_MM
    const spanY = Math.round((maxY - minY) * 1000) + 2 * KEY_MARGIN_MM
    if (spanX >= KEY_X_SPAN || spanY >= KEY_Y_SPAN) {
        throw new Error(
            `계단형 변환 범위 초과: 메쉬 가로 ${(spanX / 1e6).toFixed(1)}km × 세로 ${(spanY / 1e6).toFixed(1)}km ` +
                `(한도 가로 ${(KEY_X_SPAN / 1e6).toFixed(1)}km × 세로 ${(KEY_Y_SPAN / 1e6).toFixed(1)}km)`,
        )
    }
    const xyKey = makeXyKey(minX, minY)
    const maxVerts = Math.floor(maxBytes / 12)
    const maxIndices = Math.floor(maxBytes / 4)
    const positions = growable((n) => new Float32Array(n))
    const indices = growable((n) => new Uint32Array(n))
    const N0 = options.normals
    const normals = N0 ? growable((n) => new Float32Array(n)) : null
    /** 지금 처리 중인 원본 삼각형의 매끈한 법선 보간(x, y → 정규화한 법선). 법선이 없으면 null */
    let smoothAt: ((x: number, y: number) => P) | null = null
    let chunkCount = 0
    let totalTriangles = 0
    let totalVertices = 0
    /** 층 번호 → ((x, y) 키 → 정점 인덱스). 조각마다 비운다 */
    const vertexMaps = new Map<number, Map<number, number>>()
    /** 벽 윗면 층 번호 → (작은 끝점 키 → 큰 끝점 키 집합). 조각마다 비운다 */
    const wallSets = new Map<number, Map<number, Set<number>>>()
    /** tags 를 줬을 때 이 조각의 (태그, 시작 삼각형) 쌍. 원본 삼각형의 판·벽은 그 삼각형을 처리할 때 이어서 쌓이므로 태그가 바뀌는 자리만 적는다 */
    const tags = options.tags
    let tagRuns: number[] = []

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
            if (normals && smoothAt) normals.push3(...smoothAt(x, y))
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
        const chunk: SteppedChunk = { positions: positions.result(), indices: indices.result(), ...(normals ? { normals: normals.result() } : {}) }
        if (tags) {
            chunk.tagRanges = tagRangesOf(tagRuns, chunk.indices.length / 3)
            tagRuns = []
        }
        chunkCount++
        totalTriangles += chunk.indices.length / 3
        totalVertices += chunk.positions.length / 3
        positions.reset()
        indices.reset()
        normals?.reset()
        vertexMaps.clear()
        wallSets.clear()
        return chunk
    }

    for (let t = 0; t < I0.length; t += 3) {
        // 시계를 매번 읽지 않도록 삼각형 4096개마다 한 번만 확인한다
        if (onProgress && t % PROGRESS_CHECK_INDICES === 0) {
            const now = performance.now()
            if (now - lastProgress >= PROGRESS_INTERVAL_MS) {
                lastProgress = now
                onProgress(t / 3, I0.length / 3)
            }
        }

        const tri: P[] = [0, 1, 2].map((k) => {
            const i = I0[t + k] * 3
            return [P0[i], P0[i + 1], P0[i + 2]] as P
        })
        if (N0) smoothAt = smoothNormalOf(tri, [0, 1, 2].map((k) => I0[t + k]), N0)
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
        if (tags) {
            const g = tags[t / 3]
            if (tagRuns.length === 0 || tagRuns[tagRuns.length - 2] !== g) tagRuns.push(g, indices.length() / 3)
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
    onProgress?.(I0.length / 3, I0.length / 3)

    if (options.quiet) return
    console.log(
        `계단형(${step}m): 원본 삼각형 ${I0.length / 3} → ${totalTriangles}, 정점 ${totalVertices}, ${chunkCount}조각, ${Math.round(performance.now() - started)}ms (yield 한 뒤 받는 쪽이 조각을 처리하는 시간 포함. Worker 에서는 postMessage 시간)`,
    )
}

/** 판 합치기 통계(도엽 로그 "판 합침 N→M(실패 k)" 와 검증용). 여러 조각에 걸쳐 더해 간다 */
export type StepMergeStats = {
    /** 판 삼각형(세 정점 z 가 같은 것) 수, 합치기 전 */
    plateBefore: number
    /** 합친 뒤 판 삼각형 수(원래대로 둔 것 포함) */
    plateAfter: number
    /** 다시 삼각분할한 성분 수 */
    merged: number
    /** 실패해 원래 삼각형을 둔 성분 수(이유별은 reasons) */
    failed: number
    reasons: Record<string, number>
    /** 시계 방향(넓이 음수)·넓이 0 이라 성분에 넣지 않고 그대로 둔 판 삼각형 수 */
    skippedTris: number
    /** earcut 가 버린 경계 정점(같은 직선 위)을 부채꼴로 다시 끼운 수(벽·이웃과의 T자 이음 방지) */
    reinserted: number
    /** 정점 수 합치기 전 → 뒤(참조되는 것만 남긴 뒤) */
    vertsBefore: number
    vertsAfter: number
    ms: number
}

export const emptyStepMergeStats = (): StepMergeStats => ({
    plateBefore: 0, plateAfter: 0, merged: 0, failed: 0, reasons: {}, skippedTris: 0, reinserted: 0, vertsBefore: 0, vertsAfter: 0, ms: 0,
})

/** 성분 실패 이유(StepMergeStats.reasons 의 키) */
const MERGE_FAIL = ["", "orientation", "nonmanifold", "open-loop", "no-outer", "zero-loop", "hole-unassigned", "reinsert", "bad-triangle", "area-mismatch"] as const
/** 넓이 검증의 상대 허용치(R0 와 같음) */
const MERGE_AREA_TOLERANCE = 1e-6

/**
 * 계단형 조각(buildSteppedMeshChunks 의 출력을 liftSteppedChunk 로 띄운 것)에서 같은 층의 평평한 판을 다시 삼각분할해 삼각형·정점을 줄인다
 * (docs/stepped-merge-plan.md R1 2026-10-25, 띄운 뒤로 옮김 R1b 2026-10-31). 판은 원본 삼각형 조각을 그대로 넣어 만들어져 안쪽에 지형 삼각형 경계 정점이 남는데,
 * 이 정점들이 합치면 사라진다(R0: 도로 판 −55 %).
 *
 * 1. 판 삼각형 = 세 정점 z 가 정확히 같은 것(판 z 는 층 값을 그대로 넣고 띄우기가 같은 lift 를 더해 층마다 같다). 나머지(벽)는 그대로 둔다. 넓이가 0 이거나 시계 방향인 판 삼각형도
 *    성분에 넣지 않고 그대로 둔다(R0: 드레이프에서 온 시계 방향 조각 하나가 큰 성분 전체를 실패시켰다).
 * 2. 정점 번호 기준 방향 변(a→b)을 정점별로 모아(CSR) 반대 변(b→a)이 하나면 안쪽 변으로 보고 두 삼각형을 union-find 로 잇는다.
 *    같은 방향 변이 둘 이상(겹친 면)·반대 변이 둘 이상(비다양체)이면 그 성분은 실패. 판의 정점은 층별로 합쳐져 있어(조각 안) 다른 층과 정점을 공유하지 않는다.
 * 3. 성분마다 경계 변(반대 변 없음)을 이어 고리를 만든다. 한 정점에서 나가는 경계 변이 여럿(핀치)이면 들어온 방향에서 시계 방향으로 처음 만나는 변.
 *    넓이 양수 = 바깥, 음수 = 구멍. 구멍은 그 변 바로 왼쪽(판 쪽) 점을 담는 가장 작은 바깥에 붙인다.
 * 4. 바깥마다 earcut(구멍 포함). earcut 는 정확히 같은 직선 위의 경계 정점을 버리는데, 그 정점을 벽·이웃이 쓰면 T자 이음(핀홀)이 되므로
 *    버려진 정점을 그 경계 변을 가진 삼각형에서 부채꼴로 다시 끼운다(넓이 그대로).
 * 5. 안전망: 합친 삼각형 넓이 합이 원래 성분 넓이와 MERGE_AREA_TOLERANCE 안이 아니거나 넓이 0 이하 삼각형이 있으면 그 성분만 원래 삼각형을 둔다.
 *    합친 수가 원래보다 적지 않으면 원래대로 둔다.
 *
 * 합친 삼각형은 기존 정점 번호를 그대로 쓰므로 정점별 매끈한 법선(normals)이 그대로 맞다(계획서 D1 (a)). 끝에 참조되지 않는 정점을 빼고
 * 순서를 유지해 압축한다. 합친 성분이 없으면 받은 조각을 그대로 돌려준다.
 *
 * @param chunk 계단형 조각. 띄운 뒤라면 접힘 수정(liftSteppedChunk fixFolds)을 거친 것이어야 한다: 벽 밀기가 뒤집은 판 삼각형은 성분에서 빠지고
 *   그 둘레 고리가 접힌 채 earcut 에 들어가 합친 판이 가장자리를 덜 덮는다(R1 6.5)
 * @param stats 통계를 더할 곳(선택)
 * @returns 판을 합친 조각
 */
export const mergeSteppedPlates = (chunk: MeshChunk, stats?: StepMergeStats): MeshChunk => {
    const started = performance.now()
    const P = chunk.positions
    const I = chunk.indices
    const nT = I.length / 3
    const nV = P.length / 3
    const X = (v: number) => P[3 * v]
    const Y = (v: number) => P[3 * v + 1]
    const area2 = (a: number, b: number, c: number) => (X(b) - X(a)) * (Y(c) - Y(a)) - (Y(b) - Y(a)) * (X(c) - X(a))

    // 1) 판 후보: z 가 같고 반시계(넓이 양수)
    const cand = new Uint8Array(nT)
    let plateBefore = 0
    let skipped = 0
    let nc = 0
    for (let t = 0; t < nT; t++) {
        const a = I[3 * t], b = I[3 * t + 1], c = I[3 * t + 2]
        const z = P[3 * a + 2]
        if (P[3 * b + 2] !== z || P[3 * c + 2] !== z) continue
        plateBefore++
        if (area2(a, b, c) > 0) {
            cand[t] = 1
            nc++
        } else skipped++
    }

    // 2) 방향 변 CSR(시작 정점별 → 끝 정점·삼각형)
    const outStart = new Int32Array(nV + 1)
    for (let t = 0; t < nT; t++) if (cand[t]) for (let k = 0; k < 3; k++) outStart[I[3 * t + k] + 1]++
    for (let v = 0; v < nV; v++) outStart[v + 1] += outStart[v]
    const outTo = new Int32Array(3 * nc)
    const outTri = new Int32Array(3 * nc)
    {
        const cur = outStart.slice(0, nV)
        for (let t = 0; t < nT; t++) {
            if (!cand[t]) continue
            for (let k = 0; k < 3; k++) {
                const j = cur[I[3 * t + k]]++
                outTo[j] = I[3 * t + ((k + 1) % 3)]
                outTri[j] = t
            }
        }
    }
    const parent = new Int32Array(nT)
    for (let t = 0; t < nT; t++) parent[t] = t
    const find = (x: number) => {
        while (parent[x] !== x) {
            parent[x] = parent[parent[x]]
            x = parent[x]
        }
        return x
    }
    /** 삼각형별 실패 이유(MERGE_FAIL 번호, 0 = 없음) */
    const badTri = new Uint8Array(nT)
    // 경계 변(반대 변 없음): 시작·끝 정점·삼각형
    const bA = new Int32Array(3 * nc)
    const bB = new Int32Array(3 * nc)
    const bT = new Int32Array(3 * nc)
    let nB = 0
    for (let t = 0; t < nT; t++) {
        if (!cand[t]) continue
        for (let k = 0; k < 3; k++) {
            const a = I[3 * t + k], b = I[3 * t + ((k + 1) % 3)]
            let same = 0, opp = 0, oppTri = -1
            for (let j = outStart[a]; j < outStart[a + 1]; j++) if (outTo[j] === b) same++
            for (let j = outStart[b]; j < outStart[b + 1]; j++) {
                if (outTo[j] === a) {
                    opp++
                    oppTri = outTri[j]
                }
            }
            if (same > 1) badTri[t] = 1
            else if (opp > 1) badTri[t] = 2
            else if (opp === 1) parent[find(t)] = find(oppTri)
            else {
                bA[nB] = a
                bB[nB] = b
                bT[nB] = t
                nB++
            }
        }
    }

    // 3) 성분 번호·삼각형 수·넓이·실패 이유
    const compOf = new Int32Array(nT).fill(-1)
    const rootComp = new Int32Array(nT).fill(-1)
    let nComp = 0
    for (let t = 0; t < nT; t++) {
        if (!cand[t]) continue
        const r = find(t)
        if (rootComp[r] < 0) rootComp[r] = nComp++
        compOf[t] = rootComp[r]
    }
    const compTris = new Int32Array(nComp)
    const compArea2 = new Float64Array(nComp)
    const compBad = new Uint8Array(nComp)
    for (let t = 0; t < nT; t++) {
        const c = compOf[t]
        if (c < 0) continue
        compTris[c]++
        compArea2[c] += area2(I[3 * t], I[3 * t + 1], I[3 * t + 2])
        if (badTri[t] && !compBad[c]) compBad[c] = badTri[t]
    }
    // 성분별 경계 변(CSR), 정점별 경계 나가는 변(CSR)
    const bComp = new Int32Array(nB)
    const compBStart = new Int32Array(nComp + 1)
    const vBStart = new Int32Array(nV + 1)
    for (let e = 0; e < nB; e++) {
        bComp[e] = compOf[bT[e]]
        compBStart[bComp[e] + 1]++
        vBStart[bA[e] + 1]++
    }
    for (let c = 0; c < nComp; c++) compBStart[c + 1] += compBStart[c]
    for (let v = 0; v < nV; v++) vBStart[v + 1] += vBStart[v]
    const compBEdge = new Int32Array(nB)
    const vBEdge = new Int32Array(nB)
    {
        const cc = compBStart.slice(0, nComp)
        const cv = vBStart.slice(0, nV)
        for (let e = 0; e < nB; e++) {
            compBEdge[cc[bComp[e]]++] = e
            vBEdge[cv[bA[e]]++] = e
        }
    }

    // 4) 성분마다 고리 → earcut → 버려진 경계 정점 다시 끼우기 → 넓이 검증
    const used = new Uint8Array(nB)
    /** 정점이 이번 바깥 묶음의 earcut 결과에 쓰였는지(묶음 번호로 표시해 매번 비우지 않는다) */
    const stamp = new Int32Array(nV)
    let stampNo = 0
    /** 성분별 합친 삼각형(merged 안의 시작·끝 인덱스). -1 이면 원래대로 */
    const compFrom = new Int32Array(nComp).fill(-1)
    const compTo = new Int32Array(nComp)
    const merged: number[] = []
    let nMerged = 0, nFailed = 0, reinserted = 0, plateAfter = skipped
    const reasons: Record<string, number> = {}
    const fail = (c: number, code: number) => {
        nFailed++
        reasons[MERGE_FAIL[code]] = (reasons[MERGE_FAIL[code]] ?? 0) + 1
        plateAfter += compTris[c]
    }

    for (let c = 0; c < nComp; c++) {
        if (compTris[c] === 1) {
            plateAfter++
            continue
        }
        if (compBad[c]) {
            fail(c, compBad[c])
            continue
        }
        // 고리 잇기
        const loops: number[][] = []
        let failCode = 0
        for (let k = compBStart[c]; k < compBStart[c + 1] && !failCode; k++) {
            const e0 = compBEdge[k]
            if (used[e0]) continue
            used[e0] = 1
            const start = bA[e0]
            const loop = [start]
            let u = start
            let v = bB[e0]
            while (v !== start) {
                loop.push(v)
                let pick = -1, count = 0
                for (let j = vBStart[v]; j < vBStart[v + 1]; j++) {
                    const e = vBEdge[j]
                    if (used[e] || bComp[e] !== c) continue
                    count++
                    if (pick < 0) pick = e
                }
                if (count > 1) {
                    // 핀치: 들어온 방향(v → u)에서 시계 방향으로 처음 만나는 변
                    const back = Math.atan2(Y(u) - Y(v), X(u) - X(v))
                    let best = Infinity
                    for (let j = vBStart[v]; j < vBStart[v + 1]; j++) {
                        const e = vBEdge[j]
                        if (used[e] || bComp[e] !== c) continue
                        let cw = back - Math.atan2(Y(bB[e]) - Y(v), X(bB[e]) - X(v))
                        while (cw <= 0) cw += 2 * Math.PI
                        while (cw > 2 * Math.PI) cw -= 2 * Math.PI
                        if (cw < best) {
                            best = cw
                            pick = e
                        }
                    }
                }
                if (pick < 0) {
                    failCode = 3
                    break
                }
                used[pick] = 1
                u = v
                v = bB[pick]
            }
            if (!failCode) loops.push(loop)
        }
        if (failCode) {
            fail(c, failCode)
            continue
        }
        // 바깥·구멍(성분 첫 정점 기준 좌표로 넓이)
        const ox = X(loops[0][0]), oy = Y(loops[0][0])
        const ringArea2 = (l: number[]) => {
            let s = 0
            for (let i = 0, n = l.length; i < n; i++) {
                const a = l[i], b = l[(i + 1) % n]
                s += (X(a) - ox) * (Y(b) - oy) - (X(b) - ox) * (Y(a) - oy)
            }
            return s
        }
        type Outer = { ring: number[]; area: number; holes: number[][]; x0: number; y0: number; x1: number; y1: number }
        const outers: Outer[] = []
        const holes: number[][] = []
        for (const l of loops) {
            const a = ringArea2(l)
            if (a > 0) {
                let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
                for (const v of l) {
                    x0 = Math.min(x0, X(v)); x1 = Math.max(x1, X(v))
                    y0 = Math.min(y0, Y(v)); y1 = Math.max(y1, Y(v))
                }
                outers.push({ ring: l, area: a, holes: [], x0, y0, x1, y1 })
            } else if (a < 0) holes.push(l)
            else failCode = 5
        }
        if (!failCode && outers.length === 0) failCode = 4
        if (!failCode) {
            const inside = (l: number[], x: number, y: number) => {
                let inn = false
                for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
                    const xi = X(l[i]), yi = Y(l[i]), xj = X(l[j]), yj = Y(l[j])
                    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inn = !inn
                }
                return inn
            }
            for (const h of holes) {
                if (outers.length === 1) {
                    outers[0].holes.push(h)
                    continue
                }
                // 구멍 첫 변 가운데에서 왼쪽(판 쪽)으로 0.1 mm 비킨 점을 담는 가장 작은 바깥
                const a = h[0], b = h[1]
                const dx = X(b) - X(a), dy = Y(b) - Y(a)
                const len = Math.hypot(dx, dy) || 1
                const qx = (X(a) + X(b)) / 2 - (dy / len) * 1e-4
                const qy = (Y(a) + Y(b)) / 2 + (dx / len) * 1e-4
                let host: Outer | null = null
                for (const o of outers) {
                    if (qx < o.x0 || qx > o.x1 || qy < o.y0 || qy > o.y1) continue
                    if ((!host || o.area < host.area) && inside(o.ring, qx, qy)) host = o
                }
                if (!host) {
                    failCode = 6
                    break
                }
                host.holes.push(h)
            }
        }
        if (failCode) {
            fail(c, failCode)
            continue
        }
        const from = merged.length
        let compReinserted = 0
        for (const o of outers) {
            const rings = [o.ring, ...o.holes]
            const ids: number[] = []
            const holeIdx: number[] = []
            for (let r = 0; r < rings.length; r++) {
                if (r > 0) holeIdx.push(ids.length)
                for (const v of rings[r]) ids.push(v)
            }
            const flat = new Float64Array(ids.length * 2)
            for (let i = 0; i < ids.length; i++) {
                flat[2 * i] = X(ids[i]) - ox
                flat[2 * i + 1] = Y(ids[i]) - oy
            }
            const tri = earcut(flat, holeIdx, 2)
            const base = merged.length
            stampNo++
            for (const k of tri) {
                merged.push(ids[k])
                stamp[ids[k]] = stampNo
            }
            // earcut 가 버린 경계 정점: 고리에서 쓰인 두 정점 p…q 사이 버려진 줄을 p→q 변을 가진 삼각형에서 부채꼴로 다시 끼운다
            for (const ring of rings) {
                const n = ring.length
                let first = -1
                for (let i = 0; i < n; i++) {
                    if (stamp[ring[i]] === stampNo) {
                        first = i
                        break
                    }
                }
                if (first < 0) {
                    failCode = 7
                    break
                }
                for (let s = 0; s < n && !failCode; ) {
                    const i = (first + s) % n
                    let len = 1
                    while (len <= n && stamp[ring[(i + len) % n]] !== stampNo) len++
                    if (len > 1) {
                        const p = ring[i], q = ring[(i + len) % n]
                        let at = -1
                        for (let m = base; m < merged.length && at < 0; m += 3) {
                            for (let k = 0; k < 3; k++) {
                                if (merged[m + k] === p && merged[m + ((k + 1) % 3)] === q) {
                                    at = m
                                    // p, q, r 순서로 돌려 놓는다
                                    const r = merged[m + ((k + 2) % 3)]
                                    merged[m] = p
                                    merged[m + 1] = q
                                    merged[m + 2] = r
                                    break
                                }
                            }
                        }
                        if (at < 0 || p === q) {
                            failCode = 7
                            break
                        }
                        const r = merged[at + 2]
                        let prev = p
                        for (let d = 1; d < len; d++) {
                            const v = ring[(i + d) % n]
                            if (d === 1) {
                                merged[at + 1] = v
                            } else merged.push(prev, v, r)
                            prev = v
                            compReinserted++
                        }
                        merged.push(prev, q, r)
                    }
                    s += len
                }
                if (failCode) break
            }
            if (failCode) break
        }
        if (!failCode) {
            let a2 = 0
            for (let m = from; m < merged.length; m += 3) {
                const ar = area2(merged[m], merged[m + 1], merged[m + 2])
                if (!(ar > 0)) {
                    failCode = 8
                    break
                }
                a2 += ar
            }
            if (!failCode && Math.abs(a2 - compArea2[c]) > MERGE_AREA_TOLERANCE * Math.abs(compArea2[c]) + 1e-9) failCode = 9
        }
        if (failCode) {
            merged.length = from
            fail(c, failCode)
            continue
        }
        const count = (merged.length - from) / 3
        if (count >= compTris[c]) {
            merged.length = from
            plateAfter += compTris[c]
            continue
        }
        compFrom[c] = from
        compTo[c] = merged.length
        nMerged++
        reinserted += compReinserted
        plateAfter += count
    }

    const finish = (out: MeshChunk, vertsAfter: number) => {
        if (stats) {
            stats.plateBefore += plateBefore
            stats.plateAfter += plateAfter
            stats.merged += nMerged
            stats.failed += nFailed
            stats.skippedTris += skipped
            stats.reinserted += reinserted
            for (const [k, n] of Object.entries(reasons)) stats.reasons[k] = (stats.reasons[k] ?? 0) + n
            stats.vertsBefore += nV
            stats.vertsAfter += vertsAfter
            stats.ms += performance.now() - started
        }
        return out
    }
    if (nMerged === 0) return finish(chunk, nV)

    // 5) 원래 순서로: 합친 성분은 그 성분의 첫 삼각형 자리에 합친 삼각형을 넣는다. 참조되는 정점만 순서대로 남긴다
    // 상한은 원래 인덱스 수(합친 성분은 원래보다 적을 때만 쓴다)
    const outIdx = new Uint32Array(I.length)
    let n = 0
    const emitted = new Uint8Array(nComp)
    for (let t = 0; t < nT; t++) {
        const c = compOf[t]
        if (c < 0 || compFrom[c] < 0) {
            outIdx[n++] = I[3 * t]
            outIdx[n++] = I[3 * t + 1]
            outIdx[n++] = I[3 * t + 2]
        } else if (!emitted[c]) {
            emitted[c] = 1
            for (let m = compFrom[c]; m < compTo[c]; m++) outIdx[n++] = merged[m]
        }
    }
    const remap = new Int32Array(nV).fill(-1)
    for (let i = 0; i < n; i++) remap[outIdx[i]] = 0
    let nv = 0
    for (let v = 0; v < nV; v++) if (remap[v] === 0) remap[v] = nv++
    const indices = new Uint32Array(n)
    for (let i = 0; i < n; i++) indices[i] = remap[outIdx[i]]
    const positions = new Float32Array(3 * nv)
    const normals = chunk.normals ? new Float32Array(3 * nv) : undefined
    for (let v = 0; v < nV; v++) {
        const w = remap[v]
        if (w < 0) continue
        positions[3 * w] = P[3 * v]
        positions[3 * w + 1] = P[3 * v + 1]
        positions[3 * w + 2] = P[3 * v + 2]
        if (normals) {
            normals[3 * w] = chunk.normals![3 * v]
            normals[3 * w + 1] = chunk.normals![3 * v + 1]
            normals[3 * w + 2] = chunk.normals![3 * v + 2]
        }
    }
    return finish({ positions, indices, ...(normals ? { normals } : {}) }, nv)
}
