import earcut from "earcut"

import { Building, BUILDING_FLAG, BuildingCodeTable, DEFAULT_STOREY_HEIGHT_M } from "./buildingsData"
import { BuildingTable, createBuildingTable } from "./buildingTable"
import { TinMesh } from "./terrainData"

/** 높이·층수가 모두 없는 건물을 세우는 높이(m): 1층 × 기본 층고 */
export const DEFAULT_BUILDING_HEIGHT_M = DEFAULT_STOREY_HEIGHT_M
/**
 * 벽을 바닥 z 보다 이만큼 더 아래로 내린다(m). 바닥면이 없는 상자라, 계단형 지형(층 간격 1m)에서는 판이 TIN 표면보다
 * 낮아 틈이 보이고, 경사지에서는 평균 높이로 둔 바닥 아래가 비므로 벽을 지형 속으로 묻는다
 */
export const WALL_SINK_M = 1

/**
 * 지형 삼각형을 격자에 넣어 두고 점 (x, y) 의 지형 높이를 찾는 함수를 만든다.
 * 격자 셀마다 그 셀의 bbox 에 걸친 삼각형 번호를 CSR 형태(cellStart·cellTris)로 들고 있는다.
 *
 * @param positions 지형 정점 (x, y, z) 연속 배열(원점 기준 m)
 * @param indices 지형 삼각형 인덱스
 * @param cellM 격자 셀 한 변(m)
 * @returns (x, y) → z. 어느 삼각형에도 들지 않으면 null
 */
export const createTerrainSampler = (positions: Float32Array, indices: Uint32Array, cellM = 50) => {
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
    return (x: number, y: number): number | null => {
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
}

/** 고리의 부호 있는 넓이 ×2 (양수 = 반시계) */
const ringArea2 = (xy: Float64Array, start: number, end: number) => {
    let s = 0
    for (let i = start; i < end; i++) {
        const j = i + 1 < end ? i + 1 : start
        s += xy[2 * i] * xy[2 * j + 1] - xy[2 * j] * xy[2 * i + 1]
    }
    return s
}

/**
 * 건물을 지형 위에 세워 메쉬 하나로 만든다(전달 문서 6절 규칙).
 *
 * 건물마다: 바닥 꼭짓점의 지형 높이를 찾아 바닥 z 로 삼고(평균, 등고선이 가로지르면 최저점), 높이는
 * height → floors × 층고(storeyByUse) → 기본값 순으로 정한다. 지붕은 earcut 로 삼각분할(항상 반시계 = 위를 향함),
 * 벽은 고리의 변마다 사각형(삼각형 둘)을 바깥을 향하게 세운다. 바닥면은 없다. 꼭짓점 하나라도 지형 밖이면 건너뛴다.
 *
 * 건물은 5K 파일 단위로 받아 지형 범위 밖이 대부분이므로(실측 61~93%), footprint 의 bbox 가 지형 bbox 와 겹치지 않는
 * 건물은 표에도 넣지 않는다. 걸치기만 하면 남기므로 일부가 밖인 건물은 "못 세움" 으로 표에 남는다.
 *
 * @param buildings 공통 원점 mm 좌표의 건물들
 * @param terrain 같은 원점의 지형 메쉬(바닥 높이 조회용)
 * @param codes codes.json 표: 층고(storeyByUse, 용도 u8 인덱스 → m)와 용도·구조 이름(표에 실어 내보내기에 쓴다)
 * @param onProgress 세운 건물 수 알림(약 2,000개마다와 끝에)
 * @returns 지형과 같은 원점의 메쉬(positions·indices), 건물 표(범위에 걸치는 건물의 모든 필드 + 세운 위치), 세운 수,
 *   표에 있지만 못 세운 수(skipped), 범위 밖이라 표에서 뺀 수(outside)
 */
export const buildBuildingsMesh = (
    all: Building[],
    terrain: TinMesh,
    codes: BuildingCodeTable,
    onProgress?: (done: number, total: number) => void,
): { mesh: TinMesh; table: BuildingTable; built: number; skipped: number; outside: number } => {
    const storeyByUse = codes.storeyByUse
    const sample = createTerrainSampler(terrain.positions, terrain.indices)
    // 지형 bbox(mm)에 footprint bbox 가 걸치는 건물만
    let tx0 = Infinity, ty0 = Infinity, tx1 = -Infinity, ty1 = -Infinity
    for (let i = 0; i < terrain.positions.length; i += 3) {
        tx0 = Math.min(tx0, terrain.positions[i]); tx1 = Math.max(tx1, terrain.positions[i])
        ty0 = Math.min(ty0, terrain.positions[i + 1]); ty1 = Math.max(ty1, terrain.positions[i + 1])
    }
    tx0 *= 1000; ty0 *= 1000; tx1 *= 1000; ty1 *= 1000
    const buildings = all.filter((b) => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
        for (let i = 0; i < b.xy.length; i += 2) {
            x0 = Math.min(x0, b.xy[i]); x1 = Math.max(x1, b.xy[i])
            y0 = Math.min(y0, b.xy[i + 1]); y1 = Math.max(y1, b.xy[i + 1])
        }
        return x1 >= tx0 && x0 <= tx1 && y1 >= ty0 && y0 <= ty1
    })
    // 상한: 정점 2n, 삼각형 ≤ 벽 2n + 지붕 (n + 2·구멍 수)
    let vCap = 0, iCap = 0
    for (const b of buildings) {
        const n = b.xy.length / 2
        vCap += 2 * n
        iCap += 3 * (3 * n + 2 * b.holes.length)
    }
    const positions = new Float32Array(3 * vCap)
    const indices = new Uint32Array(iCap)
    let v = 0, idx = 0, built = 0, skipped = 0
    const table = createBuildingTable(buildings, codes)

    for (const [k, b] of buildings.entries()) {
        const n = b.xy.length / 2
        const outerN = n - b.holes.reduce((s, h) => s + h, 0)
        if (n < 3 || outerN < 3) {
            skipped++
            continue
        }
        // 바닥 좌표(m)와 지형 높이
        const xy = new Float64Array(2 * n)
        let zMin = Infinity, zSum = 0, outside = false
        for (let i = 0; i < n; i++) {
            const x = b.xy[2 * i] / 1000, y = b.xy[2 * i + 1] / 1000
            xy[2 * i] = x
            xy[2 * i + 1] = y
            const z = sample(x, y)
            if (z === null) {
                outside = true
                break
            }
            zMin = Math.min(zMin, z)
            zSum += z
        }
        if (outside) {
            skipped++
            continue
        }
        const z0 = b.flags & BUILDING_FLAG.contourCrossed ? zMin : zSum / n
        const height =
            b.height > 0 ? b.height : b.floors > 0 ? b.floors * storeyByUse[b.useCd] : DEFAULT_BUILDING_HEIGHT_M
        const zBottom = z0 - WALL_SINK_M
        const zTop = z0 + height

        // 고리 경계: [0, outerN), 그 뒤 구멍들
        const ringStarts = [0, outerN]
        for (let h = 0; h < b.holes.length - 1; h++) ringStarts.push(ringStarts[ringStarts.length - 1] + b.holes[h])
        const roof = earcut(xy, b.holes.length ? ringStarts.slice(1) : undefined, 2)
        if (roof.length === 0) {
            skipped++
            continue
        }

        // 정점: 아래 고리 v..v+n-1, 위 고리 v+n..v+2n-1
        const base = v / 3
        table.vertexBase[k] = base
        table.faceBase[k] = idx / 3
        table.baseZ[k] = z0
        table.builtHeight[k] = height
        for (let i = 0; i < n; i++) {
            positions[v++] = xy[2 * i]
            positions[v++] = xy[2 * i + 1]
            positions[v++] = zBottom
        }
        for (let i = 0; i < n; i++) {
            positions[v++] = xy[2 * i]
            positions[v++] = xy[2 * i + 1]
            positions[v++] = zTop
        }
        // 지붕. earcut 는 반시계(위를 향함)로 내지만, 세 점이 거의 일직선인 바늘 조각은 float32 좌표로 올리면 방향이
        // 뒤집히기도 하므로 GPU·STL 이 보는 float32 좌표로 넓이를 재서 1cm² 미만은 버리고(틈은 mm 미만) 음수면 뒤집는다
        const f = (i: number) => Math.fround(xy[i])
        for (let t = 0; t < roof.length; t += 3) {
            const a = roof[t], b = roof[t + 1], c = roof[t + 2]
            const area2 = (f(2 * b) - f(2 * a)) * (f(2 * c + 1) - f(2 * a + 1)) - (f(2 * b + 1) - f(2 * a + 1)) * (f(2 * c) - f(2 * a))
            if (Math.abs(area2) < 2e-4) continue
            indices[idx++] = base + n + a
            indices[idx++] = base + n + (area2 < 0 ? c : b)
            indices[idx++] = base + n + (area2 < 0 ? b : c)
        }
        // 벽: 변 a→b 에 (a아래, b아래, b위), (a아래, b위, a위). 외곽이 반시계·구멍이 시계일 때 바깥을 향한다.
        // 파일 규약(외곽 CCW, 구멍 CW)과 다른 고리는 뒤집어 맞춘다
        for (let r = 0; r < ringStarts.length; r++) {
            const start = ringStarts[r]
            const end = r + 1 < ringStarts.length ? ringStarts[r + 1] : n
            if (end - start < 2) continue
            const area2 = ringArea2(xy, start, end)
            const flip = r === 0 ? area2 < 0 : area2 > 0
            for (let i = start; i < end; i++) {
                const j = i + 1 < end ? i + 1 : start
                const aB = base + i, bB = base + j, aT = base + n + i, bT = base + n + j
                if (!flip) {
                    indices[idx++] = aB; indices[idx++] = bB; indices[idx++] = bT
                    indices[idx++] = aB; indices[idx++] = bT; indices[idx++] = aT
                } else {
                    indices[idx++] = aB; indices[idx++] = bT; indices[idx++] = bB
                    indices[idx++] = aB; indices[idx++] = aT; indices[idx++] = bT
                }
            }
        }
        built++
        if (k % 2000 === 1999) onProgress?.(k + 1, buildings.length)
    }
    onProgress?.(buildings.length, buildings.length)
    return {
        mesh: { origin: terrain.origin, positions: positions.subarray(0, v), indices: indices.subarray(0, idx) },
        table,
        built,
        skipped,
        outside: all.length - buildings.length,
    }
}
