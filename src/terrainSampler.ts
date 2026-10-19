/**
 * 지형 TIN 의 격자 조회기(buildingsMesh.ts 에서 분리, 2026-10-19). 건물 바닥 높이(buildingsMesh)와 도로 얹기(roadsMesh)가 같이 쓴다.
 * 이 모듈은 의존성이 없다(내보내기 Worker 가 도로 계단화 때 벽 방향 판정용으로 import 하므로 proj4 등을 끌어오지 않게)
 */

/**
 * 지형 높이 조회기: (x, y) → z(어느 삼각형에도 들지 않으면 null). 도로 레이어(roadsMesh)가 같은 격자로 "상자에 걸치는 삼각형" 을
 * 순회하도록 forTrianglesInBox 를 함께 가진다
 */
export type TerrainSampler = ((x: number, y: number) => number | null) & {
    /** xy 상자에 걸친 격자 셀의 삼각형 번호를 한 번씩 콜백에 넘긴다(삼각형이 실제로 상자와 겹치는지는 검사하지 않는다) */
    forTrianglesInBox: (x0: number, y0: number, x1: number, y1: number, fn: (t: number) => void) => void
}

/**
 * 지형 삼각형을 격자에 넣어 두고 점 (x, y) 의 지형 높이를 찾는 함수를 만든다.
 * 격자 셀마다 그 셀의 bbox 에 걸친 삼각형 번호를 CSR 형태(cellStart·cellTris)로 들고 있는다.
 *
 * @param positions 지형 정점 (x, y, z) 연속 배열(원점 기준 m)
 * @param indices 지형 삼각형 인덱스
 * @param cellM 격자 셀 한 변(m)
 * @returns (x, y) → z. 어느 삼각형에도 들지 않으면 null
 */
export const createTerrainSampler = (positions: Float32Array, indices: Uint32Array, cellM = 50): TerrainSampler => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (let i = 0; i < positions.length; i += 3) {
        minX = Math.min(minX, positions[i])
        maxX = Math.max(maxX, positions[i])
        minY = Math.min(minY, positions[i + 1])
        maxY = Math.max(maxY, positions[i + 1])
    }
    const nx = Math.max(1, Math.ceil((maxX - minX) / cellM))
    const ny = Math.max(1, Math.ceil((maxY - minY) / cellM))
    const cellX = (x: number) => Math.min(nx - 1, Math.max(0, Math.floor((x - minX) / cellM)))
    const cellY = (y: number) => Math.min(ny - 1, Math.max(0, Math.floor((y - minY) / cellM)))
    const nTri = indices.length / 3
    /** 삼각형 t 의 셀 범위를 콜백에 넘긴다 */
    const forCells = (t: number, fn: (cell: number) => void) => {
        const a = indices[3 * t] * 3, b = indices[3 * t + 1] * 3, c = indices[3 * t + 2] * 3
        const x0 = cellX(Math.min(positions[a], positions[b], positions[c]))
        const x1 = cellX(Math.max(positions[a], positions[b], positions[c]))
        const y0 = cellY(Math.min(positions[a + 1], positions[b + 1], positions[c + 1]))
        const y1 = cellY(Math.max(positions[a + 1], positions[b + 1], positions[c + 1]))
        for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) fn(cy * nx + cx)
    }
    const cellStart = new Uint32Array(nx * ny + 1)
    for (let t = 0; t < nTri; t++) forCells(t, (cell) => cellStart[cell + 1]++)
    for (let c = 1; c < cellStart.length; c++) cellStart[c] += cellStart[c - 1]
    const cellTris = new Uint32Array(cellStart[cellStart.length - 1])
    const fill = cellStart.slice(0, -1)
    for (let t = 0; t < nTri; t++) forCells(t, (cell) => (cellTris[fill[cell]++] = t))

    const EPS = 1e-6
    const sample = (x: number, y: number): number | null => {
        const cell = cellY(y) * nx + cellX(x)
        for (let k = cellStart[cell]; k < cellStart[cell + 1]; k++) {
            const t = cellTris[k]
            const a = indices[3 * t] * 3, b = indices[3 * t + 1] * 3, c = indices[3 * t + 2] * 3
            const ax = positions[a], ay = positions[a + 1]
            const bx = positions[b], by = positions[b + 1]
            const cx = positions[c], cy = positions[c + 1]
            const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
            if (det === 0) continue
            const l1 = ((bx - x) * (cy - y) - (cx - x) * (by - y)) / det
            const l2 = ((cx - x) * (ay - y) - (ax - x) * (cy - y)) / det
            const l3 = 1 - l1 - l2
            if (l1 < -EPS || l2 < -EPS || l3 < -EPS) continue
            return l1 * positions[a + 2] + l2 * positions[b + 2] + l3 * positions[c + 2]
        }
        return null
    }
    // 상자 순회: 여러 셀에 걸친 삼각형을 한 번만 넘기도록 호출마다 번호표(stamp)를 올려 표시한다
    const stamp = new Uint32Array(nTri)
    let stampId = 0
    const forTrianglesInBox = (x0: number, y0: number, x1: number, y1: number, fn: (t: number) => void) => {
        stampId++
        const cx0 = cellX(x0), cx1 = cellX(x1), cy0 = cellY(y0), cy1 = cellY(y1)
        for (let cy = cy0; cy <= cy1; cy++) {
            for (let cx = cx0; cx <= cx1; cx++) {
                const cell = cy * nx + cx
                for (let k = cellStart[cell]; k < cellStart[cell + 1]; k++) {
                    const t = cellTris[k]
                    if (stamp[t] === stampId) continue
                    stamp[t] = stampId
                    fn(t)
                }
            }
        }
    }
    return Object.assign(sample, { forTrianglesInBox })
}
