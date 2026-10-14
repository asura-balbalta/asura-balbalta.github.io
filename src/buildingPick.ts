/**
 * 둘러보기 중 조준점(시선 광선)이 가리키는 건물 찾기. GPU 를 읽지 않고(readback 없음) 메인에 이미 있는 도엽의 건물 메쉬와
 * 건물 표로 CPU 에서 광선-삼각형 교차를 푼다(docs/design-code-plan.md 10절).
 *
 * 도엽마다 한 번 만들어 두는 색인(PickIndex): 세운 건물의 xyz bbox(메쉬 정점에서)와 삼각형 범위 [faceStart, faceEnd).
 * 찾기: 도엽 bbox → 건물 bbox 를 광선 slab 검사로 거른 뒤 남은 건물의 삼각형만 Möller–Trumbore 로 교차해 가장 가까운 것.
 * 좌표는 메쉬 로컬(m, z-up)이고 플레이어 눈·시선과 같은 틀이다.
 *
 * 흐름: createBuildingPicker() → pick(tiles, eye, dir, maxDistance) → BuildingHit | null
 */
import { BuildingTable, NOT_BUILT } from "./buildingTable"

/** 찾기에 필요한 도엽 정보(TerrainTilesClient 의 TileData 가 그대로 맞는다) */
export type PickableTile = {
    id: string
    bounds: { min: [number, number, number]; max: [number, number, number] }
    buildings: { positions: Float32Array; indices: Uint32Array } | null
    buildingTable: BuildingTable | null
}

/** 조준점이 가리키는 건물: 도엽 id, 표 안 번호 k, 그 표, 도엽 건물 메쉬 안 삼각형 범위(강조용), 눈에서의 거리(m) */
export type BuildingHit = {
    tileId: string
    index: number
    table: BuildingTable
    faceStart: number
    faceEnd: number
    distance: number
}

/** 도엽 하나의 색인. bbox 는 건물마다 (minx, miny, minz, maxx, maxy, maxz), faceEnd 는 다음 세운 건물의 faceBase(없으면 삼각형 수) */
type PickIndex = {
    bbox: Float32Array
    faceEnd: Uint32Array
}

/**
 * 도엽 건물의 색인을 만든다. 건물 k 의 정점은 vertexBase[k] 부터 footprint 점 수 × 2(아래·위 고리)
 *
 * @param tile 건물 메쉬와 표가 있는 도엽
 */
const buildIndex = (tile: PickableTile): PickIndex | null => {
    const t = tile.buildingTable
    const mesh = tile.buildings
    if (!t || !mesh) return null
    const bbox = new Float32Array(t.count * 6)
    const faceEnd = new Uint32Array(t.count)
    let next = mesh.indices.length / 3
    for (let k = t.count - 1; k >= 0; k--) {
        if (t.vertexBase[k] === NOT_BUILT || t.faceBase[k] === NOT_BUILT) continue
        faceEnd[k] = next
        next = t.faceBase[k]
        const n = (t.pointStart[k + 1] - t.pointStart[k]) * 2
        let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
        for (let v = t.vertexBase[k], e = v + n; v < e; v++) {
            const x = mesh.positions[v * 3], y = mesh.positions[v * 3 + 1], z = mesh.positions[v * 3 + 2]
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
            if (z < minZ) minZ = z
            if (z > maxZ) maxZ = z
        }
        bbox.set([minX, minY, minZ, maxX, maxY, maxZ], k * 6)
    }
    return { bbox, faceEnd }
}

/**
 * 광선과 축 정렬 상자의 교차(slab). 상자에 들어가는 거리를 돌려주고, 안 만나거나 tMax 보다 멀면 null. 눈이 상자 안이면 0
 */
const rayBox = (
    ox: number, oy: number, oz: number,
    ix: number, iy: number, iz: number,
    minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number,
    tMax: number,
): number | null => {
    let t0 = 0, t1 = tMax
    let a = (minX - ox) * ix, b = (maxX - ox) * ix
    if (a > b) [a, b] = [b, a]
    if (a > t0) t0 = a
    if (b < t1) t1 = b
    if (t0 > t1) return null
    a = (minY - oy) * iy
    b = (maxY - oy) * iy
    if (a > b) [a, b] = [b, a]
    if (a > t0) t0 = a
    if (b < t1) t1 = b
    if (t0 > t1) return null
    a = (minZ - oz) * iz
    b = (maxZ - oz) * iz
    if (a > b) [a, b] = [b, a]
    if (a > t0) t0 = a
    if (b < t1) t1 = b
    return t0 > t1 ? null : t0
}

/**
 * 광선과 삼각형의 교차 거리(Möller–Trumbore). 양면. 안 만나거나 (0, tMax) 밖이면 null
 */
const rayTriangle = (
    ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
    p: Float32Array, a: number, b: number, c: number, tMax: number,
): number | null => {
    const ax = p[a], ay = p[a + 1], az = p[a + 2]
    const e1x = p[b] - ax, e1y = p[b + 1] - ay, e1z = p[b + 2] - az
    const e2x = p[c] - ax, e2y = p[c + 1] - ay, e2z = p[c + 2] - az
    const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x
    const det = e1x * hx + e1y * hy + e1z * hz
    if (Math.abs(det) < 1e-9) return null
    const inv = 1 / det
    const sx = ox - ax, sy = oy - ay, sz = oz - az
    const u = (sx * hx + sy * hy + sz * hz) * inv
    if (u < 0 || u > 1) return null
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x
    const v = (dx * qx + dy * qy + dz * qz) * inv
    if (v < 0 || u + v > 1) return null
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv
    return t > 0 && t < tMax ? t : null
}

/**
 * 건물 찾기 함수를 만든다. 도엽 색인은 도엽 객체마다 한 번 만들어 WeakMap 에 두므로(도엽이 바뀌면 새 객체 → 다시) 호출마다 싸다
 *
 * @returns pick(tiles, eye, dir, maxDistance): 광선 위 가장 가까운 건물 또는 null
 */
export const createBuildingPicker = () => {
    const cache = new WeakMap<PickableTile, PickIndex | null>()
    const indexOf = (tile: PickableTile) => {
        let idx = cache.get(tile)
        if (idx === undefined) {
            idx = buildIndex(tile)
            cache.set(tile, idx)
        }
        return idx
    }
    /**
     * @param tiles 들고 있는 도엽들(선택 + 스트리밍)
     * @param eye 눈 위치(메쉬 로컬 m)
     * @param dir 시선 단위 벡터
     * @param maxDistance 이보다 먼 건물은 무시(m)
     * @param groundAt (x, y) 의 지표 높이(걸어 보기의 발 높이 조회). 주면 건물까지 가는 길에 지형이 먼저 가로막는지 1 m 간격으로
     *   살펴, 지형 뒤에 숨은 건물은 고르지 않는다(처음엔 이게 없어 언덕 너머 건물이 걸렸다, 2026-10-15)
     */
    const pick = (
        tiles: Iterable<PickableTile>,
        eye: [number, number, number],
        dir: [number, number, number],
        maxDistance: number,
        groundAt?: (x: number, y: number) => number | null,
    ): BuildingHit | null => {
        const found = pickBuilding(tiles, eye, dir, maxDistance)
        if (!found || !groundAt) return found
        // 눈 바로 앞 1 m 부터 건물까지. 지표가 광선보다 0.3 m 넘게 높은 자리가 있으면 지형이 가린 것(스치는 정도는 통과)
        for (let t = 1; t < found.distance; t += 1) {
            const g = groundAt(eye[0] + dir[0] * t, eye[1] + dir[1] * t)
            if (g !== null && g > eye[2] + dir[2] * t + 0.3) return null
        }
        return found
    }
    const pickBuilding = (
        tiles: Iterable<PickableTile>,
        eye: [number, number, number],
        dir: [number, number, number],
        maxDistance: number,
    ): BuildingHit | null => {
        const [ox, oy, oz] = eye
        const [dx, dy, dz] = dir
        const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz
        let best: BuildingHit | null = null
        let tBest = maxDistance
        for (const tile of tiles) {
            const t = tile.buildingTable
            const mesh = tile.buildings
            if (!t || !mesh) continue
            const b = tile.bounds
            // 도엽 상자(z 는 지형 범위라 건물 높이만큼 위로 넉넉히)
            if (rayBox(ox, oy, oz, ix, iy, iz, b.min[0], b.min[1], b.min[2] - 50, b.max[0], b.max[1], b.max[2] + 500, tBest) === null) continue
            const idx = indexOf(tile)
            if (!idx) continue
            const { bbox, faceEnd } = idx
            const p = mesh.positions
            const ind = mesh.indices
            for (let k = 0; k < t.count; k++) {
                if (t.faceBase[k] === NOT_BUILT) continue
                const o = k * 6
                if (rayBox(ox, oy, oz, ix, iy, iz, bbox[o], bbox[o + 1], bbox[o + 2], bbox[o + 3], bbox[o + 4], bbox[o + 5], tBest) === null) continue
                const faceStart = t.faceBase[k]
                for (let f = faceStart; f < faceEnd[k]; f++) {
                    const hit = rayTriangle(ox, oy, oz, dx, dy, dz, p, ind[f * 3] * 3, ind[f * 3 + 1] * 3, ind[f * 3 + 2] * 3, tBest)
                    if (hit !== null) {
                        tBest = hit
                        best = { tileId: tile.id, index: k, table: t, faceStart, faceEnd: faceEnd[k], distance: hit }
                    }
                }
            }
        }
        return best
    }
    return { pick }
}
