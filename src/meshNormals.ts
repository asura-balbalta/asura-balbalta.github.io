/**
 * 정점 법선 계산(렌더러와 도엽 워커가 함께 쓴다. 2026-10-14 terrainRenderer.ts 에서 옮김).
 * 매끈한 면(tin) 모드의 도엽은 워커가 법선을 계산해 보내고, 렌더러는 받은 법선 버퍼를 그대로 올린다
 */

/** 법선을 부드럽게 섞는 반복 횟수(매끈한 면 모드) */
export const NORMAL_SMOOTH_ITERATIONS = 2

/**
 * 정점 법선을 계산한다. 정점에 닿은 삼각형들의 면 법선을 더한 뒤 정규화한다.
 * 면 법선을 정규화하지 않고 더하므로 넓은 삼각형일수록 영향이 크다(면적 가중).
 *
 * 삼각형은 위에서 볼 때 반시계(CCW)라 면 법선이 위(+z)를 향한다.
 * 어떤 삼각형에도 쓰이지 않는 정점은 (0, 0, 1)로 둔다.
 *
 * @param positions 정점 좌표 (x, y, z) 연속 배열
 * @param indices 삼각형 정점 인덱스 (3개씩)
 * @returns positions 와 같은 길이의 정점 법선 (nx, ny, nz) 연속 배열
 */
export const computeVertexNormals = (positions: Float32Array, indices: Uint32Array) => {
    const normals = new Float32Array(positions.length)
    for (let t = 0; t < indices.length; t += 3) {
        const a = indices[t] * 3
        const b = indices[t + 1] * 3
        const c = indices[t + 2] * 3
        const e1x = positions[b] - positions[a]
        const e1y = positions[b + 1] - positions[a + 1]
        const e1z = positions[b + 2] - positions[a + 2]
        const e2x = positions[c] - positions[a]
        const e2y = positions[c + 1] - positions[a + 1]
        const e2z = positions[c + 2] - positions[a + 2]
        const nx = e1y * e2z - e1z * e2y
        const ny = e1z * e2x - e1x * e2z
        const nz = e1x * e2y - e1y * e2x
        for (const v of [a, b, c]) {
            normals[v] += nx
            normals[v + 1] += ny
            normals[v + 2] += nz
        }
    }
    return normalizeVectors(normals)
}

/**
 * (x, y, z) 연속 배열의 벡터들을 제자리에서 길이 1로 정규화한다. 길이가 0인 벡터는 (0, 0, 1)로 둔다.
 *
 * @param vectors 정규화할 벡터 배열(직접 수정됨)
 * @returns 같은 배열
 */
export const normalizeVectors = (vectors: Float32Array) => {
    for (let i = 0; i < vectors.length; i += 3) {
        const len = Math.hypot(vectors[i], vectors[i + 1], vectors[i + 2])
        if (len === 0) {
            vectors[i] = 0
            vectors[i + 1] = 0
            vectors[i + 2] = 1
            continue
        }
        vectors[i] /= len
        vectors[i + 1] /= len
        vectors[i + 2] /= len
    }
    return vectors
}

/**
 * 정점 법선을 이웃 정점의 법선과 섞어 부드럽게 한다. 형상(정점 위치)은 바꾸지 않고 음영만 매끄러워진다.
 *
 * 한 번 반복할 때마다, 각 정점의 법선에 그 정점과 삼각형을 공유하는 이웃 정점들의 법선을 더한 뒤 정규화한다.
 * 등고선 기반 TIN 의 평평한 단과 가파른 턱 사이 음영 차이를 줄이는 용도.
 *
 * @param normals 정점 법선 (nx, ny, nz) 연속 배열
 * @param indices 삼각형 정점 인덱스 (3개씩)
 * @param iterations 반복 횟수. 클수록 넓은 범위가 섞인다
 * @returns 부드럽게 한 정점 법선(새 배열)
 */
export const smoothVertexNormals = (normals: Float32Array, indices: Uint32Array, iterations: number) => {
    let current = normals
    for (let it = 0; it < iterations; it++) {
        const next = new Float32Array(current)
        for (let t = 0; t < indices.length; t += 3) {
            for (let k = 0; k < 3; k++) {
                const v = indices[t + k] * 3
                const o1 = indices[t + ((k + 1) % 3)] * 3
                const o2 = indices[t + ((k + 2) % 3)] * 3
                next[v] += current[o1] + current[o2]
                next[v + 1] += current[o1 + 1] + current[o2 + 1]
                next[v + 2] += current[o1 + 2] + current[o2 + 2]
            }
        }
        current = normalizeVectors(next)
    }
    return current
}

/** 메쉬 정점 좌표의 범위(각 축 최소·최대) */
export const positionsBounds = (p: Float32Array): { min: [number, number, number]; max: [number, number, number] } => {
    const min: [number, number, number] = [Infinity, Infinity, Infinity]
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < p.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            if (p[i + k] < min[k]) min[k] = p[i + k]
            if (p[i + k] > max[k]) max[k] = p[i + k]
        }
    }
    return { min, max }
}
