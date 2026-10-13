import { TinMesh } from "./terrainData"

/**
 * TIN 메쉬 위의 한 점(x, y)에서 지표 높이 z 를 구하는 조회기(걸어 보기의 발 높이용).
 *
 * 삼각형을 xy 격자에 넣어 두고(셀마다 겹치는 삼각형 번호, CSR 배열) 점이 든 셀의 삼각형만 검사한다.
 * 셀 한 변은 삼각형 하나의 평균 면적의 제곱근 × 2 라 셀 하나에 삼각형이 몇 개 걸치는 정도다.
 * 만들기는 삼각형 수에 선형이고(삼각형 100만 개에 수백 ms), 조회는 셀 안의 삼각형 몇 개만 본다.
 * 원본 TIN 기준이라 계단형 모드에서도 매끈한 면의 높이를 돌려준다(1차. 계단 위를 걷게 하려면 층 간격으로 반올림)
 */
export type HeightSampler = {
    /** 점이 메쉬 안이면 그 자리의 지표 높이, 밖이면 null */
    heightAt: (x: number, y: number) => number | null
    /** 건물 지붕 높이(있으면). 걸어 보기가 발 높이를 지형과 지붕 중 높은 쪽으로 잡고, 벽은 못 넘게 하는 데 쓴다 */
    roofAt?: (x: number, y: number) => number | null
    /** 메쉬 xyz 범위 */
    min: [number, number, number]
    max: [number, number, number]
}

/**
 * @param mesh 원본 TIN(positions 는 origin 을 뺀 로컬 좌표)
 * @param options.highest 겹치는 삼각형이 여럿이면 가장 높은 z 를 돌려준다(건물 메쉬의 지붕 조회용. 건물 상자는 바닥면이 없고
 *   벽은 수직이라 xy 면적이 0 으로 건너뛰므로, 남는 것은 지붕뿐이다). 기본은 처음 만난 삼각형
 */
export const createHeightSampler = (mesh: TinMesh, options: { highest?: boolean } = {}): HeightSampler => {
    const highest = !!options.highest
    const p = mesh.positions
    const idx = mesh.indices
    const triCount = idx.length / 3

    const min: [number, number, number] = [Infinity, Infinity, Infinity]
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < p.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            const v = p[i + k]
            if (v < min[k]) min[k] = v
            if (v > max[k]) max[k] = v
        }
    }
    const w = Math.max(max[0] - min[0], 1e-6)
    const h = Math.max(max[1] - min[1], 1e-6)
    const cell = Math.max(1, Math.sqrt((w * h) / Math.max(triCount, 1)) * 2)
    const nx = Math.max(1, Math.ceil(w / cell))
    const ny = Math.max(1, Math.ceil(h / cell))
    const cellX = (x: number) => Math.min(nx - 1, Math.max(0, Math.floor((x - min[0]) / cell)))
    const cellY = (y: number) => Math.min(ny - 1, Math.max(0, Math.floor((y - min[1]) / cell)))

    // 1) 셀마다 걸치는 삼각형 수 → 2) 누적합 offsets → 3) 삼각형 번호 채우기
    const offsets = new Uint32Array(nx * ny + 1)
    const triCells = (t: number, visit: (c: number) => void) => {
        const a = idx[t * 3] * 3
        const b = idx[t * 3 + 1] * 3
        const c = idx[t * 3 + 2] * 3
        const x0 = cellX(Math.min(p[a], p[b], p[c]))
        const x1 = cellX(Math.max(p[a], p[b], p[c]))
        const y0 = cellY(Math.min(p[a + 1], p[b + 1], p[c + 1]))
        const y1 = cellY(Math.max(p[a + 1], p[b + 1], p[c + 1]))
        for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) visit(cy * nx + cx)
    }
    for (let t = 0; t < triCount; t++) triCells(t, (c) => offsets[c + 1]++)
    for (let c = 0; c < nx * ny; c++) offsets[c + 1] += offsets[c]
    const fill = new Uint32Array(offsets[nx * ny])
    const cursor = offsets.slice(0, nx * ny)
    for (let t = 0; t < triCount; t++) triCells(t, (c) => (fill[cursor[c]++] = t))

    const heightAt = (x: number, y: number): number | null => {
        if (x < min[0] || x > max[0] || y < min[1] || y > max[1]) return null
        const c = cellY(y) * nx + cellX(x)
        let best: number | null = null
        for (let k = offsets[c]; k < offsets[c + 1]; k++) {
            const t = fill[k]
            const a = idx[t * 3] * 3
            const b = idx[t * 3 + 1] * 3
            const cc = idx[t * 3 + 2] * 3
            const ax = p[a], ay = p[a + 1]
            const bx = p[b], by = p[b + 1]
            const cx = p[cc], cy = p[cc + 1]
            // 무게중심 좌표. 세 값이 모두 0 이상이면 삼각형 안(변 위 포함)
            const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
            if (d === 0) continue
            const l0 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d
            const l1 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d
            const l2 = 1 - l0 - l1
            const eps = -1e-6
            if (l0 < eps || l1 < eps || l2 < eps) continue
            const z = l0 * p[a + 2] + l1 * p[b + 2] + l2 * p[cc + 2]
            if (!highest) return z
            if (best === null || z > best) best = z
        }
        return best
    }
    return { heightAt, min, max }
}

/**
 * 점 (x, y)에서 가장 가까운 삼각형의 무게중심. 선택 범위 가운데가 메쉬 구멍(도엽 없는 바다 등)일 때 걸어 보기 시작점을
 * 메쉬 위로 옮기는 데 쓴다. 무게중심은 늘 삼각형 안이라 그 자리의 높이 조회가 null 이 아니다. 삼각형 수에 선형.
 *
 * @returns 무게중심 xy. 삼각형이 없으면 null
 */
export const nearestTriangleCentroid = (mesh: TinMesh, x: number, y: number): [number, number] | null => {
    const p = mesh.positions
    const idx = mesh.indices
    let best: [number, number] | null = null
    let bestD = Infinity
    for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
        const cx = (p[a] + p[b] + p[c]) / 3
        const cy = (p[a + 1] + p[b + 1] + p[c + 1]) / 3
        const d = (cx - x) * (cx - x) + (cy - y) * (cy - y)
        if (d < bestD) {
            bestD = d
            best = [cx, cy]
        }
    }
    return best
}
