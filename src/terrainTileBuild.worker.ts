import type { Extent } from "ol/extent"
import proj4 from "proj4"

import { Building, loadBuildingCodes, loadBuildings } from "./buildingsData"
import { buildBuildingsMesh } from "./buildingsMesh"
import { BuildingTable, buildingTableBuffers, cloneBuildingTable } from "./buildingTable"
import { computeVertexNormals, NORMAL_SMOOTH_ITERATIONS, positionsBounds, smoothVertexNormals } from "./meshNormals"
import { ClippedMesh, clipMeshToConvexPolygon } from "./terrainClip"
import { fetchGunzip, MeshChunk, TinMesh } from "./terrainData"
import { TTP_BASE } from "./terrainIndex"
import { mergeTtpTiles, parseTtp, TtpTile } from "./terrainPslg"
import { buildSteppedMeshChunks } from "./terrainSteps"
import type { QueryTile, TileData, TileStyle } from "./terrainTiles.worker"

/**
 * 도엽 생성 보조 Worker(계획 문서 7절 L5-B, 2026-10-14). 조정자(terrainTiles.worker.ts)가 도엽 하나를 만들라고 보내면
 * 이웃과 합쳐 삼각분할 → 도엽 폴리곤으로 자르기 → 스타일대로 조각 → 건물 을 해서 돌려준다. 조정자가 보조 워커를 2 ~ 3개 띄워
 * 같은 5K 의 도엽은 같은 보조 워커에 보내므로(5K 파일·자른 TIN·건물 캐시가 한 곳에 모인다) 캐시는 여기 둔다.
 *
 * - 5K 파일(ttp)은 필요할 때 받아 path 로 캐시한다(받을 때마다 fetched 를 알려 조정자가 진행률을 센다. 다른 보조 워커가 같은
 *   파일을 받으면 브라우저 HTTP 캐시가 중복 전송을 막는다)
 * - 자른 TIN(+매끈한 면 법선)은 도엽별로 TIN_CACHE_BYTES 안에서 캐시해 표현 방식·층 간격 전환 때 삼각분할을 건너뛴다
 * - 건물(L5-A): 5K 단위로 한 번 받아 무게중심을 미리 계산해 두고, 도엽은 그 목록에서 bbox → 폴리곤 순으로 거르기만 한다.
 *   전에는 도엽마다 loadBuildings 가 5K 파일 안 모든 건물의 좌표를 복사해 돌려줘 도엽당 약 35 ms 가 들었다. 세운 결과도 도엽별 캐시
 * - reset 은 select 때 캐시를 모두 비운다
 */
export type BuildJob = {
    type: "build"
    jobId: number
    tile: QueryTile
    /** 이 도엽과 맞닿은 이웃(3×3, 자신 포함) */
    neighbors: QueryTile[]
    /** 이웃이 든 5K 파일 경로 */
    sheets: { id5k: string; path: string }[]
    origin: [number, number]
    style: TileStyle
    maxBytes: number
    extra: boolean
}
export type BuildRequest = BuildJob | { type: "reset" }
export type BuildResponse =
    | { type: "built"; jobId: number; data: TileData }
    | { type: "failed"; jobId: number; message: string }
    /** 5K 파일을 실제로 내려받았을 때(진행률용) */
    | { type: "fetched"; path: string }

/** 자른 TIN 캐시의 상한(바이트). 넘으면 오래 안 쓴 도엽부터 버린다(그 도엽은 전환 때 다시 삼각분할) */
const TIN_CACHE_BYTES = 256 * 1048576
/** 5K 파일 캐시 상한(개) */
const TTP_CACHE_MAX = 64

const post = (msg: BuildResponse, transfer: Transferable[] = []) => self.postMessage(msg, { transfer })

/** 5179 m 좌표를 3857 로 */
const to3857 = ([x, y]: [number, number]) => proj4("EPSG:5179", "EPSG:3857", [x, y]) as [number, number]
const extentOf = (pts: [number, number][]): Extent => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const [x, y] of pts) {
        if (x < x0) x0 = x
        if (y < y0) y0 = y
        if (x > x1) x1 = x
        if (y > y1) y1 = y
    }
    return [x0, y0, x1, y1]
}
/** 점이 다각형 안에 있는지(짝홀 규칙) */
const pointInPolygon = (x: number, y: number, poly: [number, number][]) => {
    let inside = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i]
        const [xj, yj] = poly[j]
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
}

// ---- 캐시 ----
/** 5K 파일 캐시: path → 파싱 결과 */
const ttpCache = new Map<string, Promise<ReturnType<typeof parseTtp>>>()
const fetchTtpCached = (path: string) => {
    let p = ttpCache.get(path)
    if (!p) {
        p = fetchGunzip(`${TTP_BASE}/${path}`).then((buf) => {
            post({ type: "fetched", path })
            return parseTtp(buf)
        })
        ttpCache.set(path, p)
        p.catch(() => ttpCache.delete(path))
        if (ttpCache.size > TTP_CACHE_MAX) ttpCache.delete(ttpCache.keys().next().value!)
    } else {
        // 최근 사용을 뒤로 보내 오래된 것부터 빠지게
        ttpCache.delete(path)
        ttpCache.set(path, p)
    }
    return p
}

type CachedTin = { positions: Float32Array; indices: Uint32Array; normals?: Float32Array; bytes: number }
/** 도엽별 자른 TIN(+ 매끈한 면 법선) 캐시: id → 사본. 메인으로 transfer 하는 버퍼와 별개 */
const tinCache = new Map<string, CachedTin>()
let tinCacheBytes = 0
const tinCacheGet = (id: string) => {
    const hit = tinCache.get(id)
    if (hit) {
        tinCache.delete(id)
        tinCache.set(id, hit)
    }
    return hit
}
const tinCacheSet = (id: string, tin: ClippedMesh) => {
    const prev = tinCache.get(id)
    if (prev) {
        tinCache.delete(id)
        tinCacheBytes -= prev.bytes
    }
    const entry: CachedTin = {
        positions: tin.positions.slice(),
        indices: tin.indices.slice(),
        normals: tin.normals?.slice(),
        bytes: tin.positions.byteLength + tin.indices.byteLength + (tin.normals?.byteLength ?? 0),
    }
    tinCache.set(id, entry)
    tinCacheBytes += entry.bytes
    for (const [oldId, old] of tinCache) {
        if (tinCacheBytes <= TIN_CACHE_BYTES || oldId === id) break
        tinCache.delete(oldId)
        tinCacheBytes -= old.bytes
    }
}

/** 도엽별 세운 건물 결과 캐시(표현 방식과 무관하므로 재생성 때 다시 만들지 않는다). transfer 전에 복사해 둔다 */
const builtBuildingsCache = new Map<string, { buildings: TinMesh | null; buildingTable: BuildingTable | null; built: number }>()

/** 5K 단위 건물 목록(무게중심 m 미리 계산): `${id5k}@${ox},${oy}` → 목록 */
type BuildingWithCenter = { b: Building; cx: number; cy: number }
const buildings5kCache = new Map<string, Promise<BuildingWithCenter[]>>()
const buildingsOf5k = (id5k: string, bbox3857: Extent, origin: [number, number]) => {
    const key = `${id5k}@${origin[0]},${origin[1]}`
    let p = buildings5kCache.get(key)
    if (!p) {
        p = loadBuildings(bbox3857, origin).then(({ buildings }) =>
            buildings.map((b) => {
                let sx = 0, sy = 0
                const n = b.xy.length / 2
                for (let i = 0; i < b.xy.length; i += 2) {
                    sx += b.xy[i]
                    sy += b.xy[i + 1]
                }
                return { b, cx: sx / n / 1000, cy: sy / n / 1000 }
            }),
        )
        buildings5kCache.set(key, p)
        p.catch(() => buildings5kCache.delete(key))
    }
    return p
}

const reset = () => {
    ttpCache.clear()
    tinCache.clear()
    tinCacheBytes = 0
    builtBuildingsCache.clear()
    buildings5kCache.clear()
}

/**
 * 도엽 하나를 만든다(이웃과 합쳐 삼각분할 → 도엽 폴리곤으로 자르기 → 스타일대로 조각 → 건물).
 *
 * @param job 조정자가 보낸 일감(도엽·이웃·5K 경로·원점·스타일)
 */
const buildTile = async (job: BuildJob): Promise<{ data: TileData; transfer: Transferable[] }> => {
    const { tile: t, neighbors, origin, style, maxBytes, extra } = job
    const [ox, oy] = origin
    const pathById5k = new Map(job.sheets.map((s) => [s.id5k, s.path]))
    const ids5k = [...new Set(neighbors.map((n) => n.id5k))]
    const files = await Promise.all(ids5k.map((id) => fetchTtpCached(pathById5k.get(id)!)))
    const ttpById = new Map<string, TtpTile>()
    for (const f of files) for (const tile of f.tiles) ttpById.set(tile.mapId, tile)
    const ttpTiles = neighbors.map((n) => ttpById.get(n.map_id)).filter((x): x is TtpTile => !!x)
    if (!ttpById.has(t.map_id)) throw new Error(`도엽 ${t.map_id} 이 5K 파일에 없음`)

    const t0 = performance.now()
    const poly = t.corners.map(([x, y]) => [x - ox, y - oy] as [number, number])
    const needNormals = style.mode === "tin"
    /** 이웃을 합친 메쉬. 캐시가 맞으면 만들지 않는다(건물 바닥 높이에 필요하면 그때 만든다) */
    let merged: TinMesh | null = null
    const mergedMesh = () => (merged ??= mergeTtpTiles(ttpTiles, origin))
    const cachedTin = tinCacheGet(t.map_id)
    let tin: ClippedMesh
    let fromCache = false
    if (cachedTin && (!needNormals || cachedTin.normals)) {
        tin = { origin, positions: cachedTin.positions.slice(), indices: cachedTin.indices.slice(), normals: cachedTin.normals?.slice() }
        fromCache = true
    } else {
        // 매끈한 면: 법선은 이웃을 합친 메쉬에서 계산한 뒤 자를 때 같이 실어 경계 정점도 이웃 삼각형을 본 법선을 갖는다
        const m = mergedMesh()
        const normals = needNormals
            ? smoothVertexNormals(computeVertexNormals(m.positions, m.indices), m.indices, NORMAL_SMOOTH_ITERATIONS)
            : undefined
        tin = clipMeshToConvexPolygon(m, poly, normals)
        tinCacheSet(t.map_id, tin)
    }
    const t1 = performance.now()
    let terrain: MeshChunk[]
    if (style.mode === "stepped" && style.step > 0) {
        terrain = [...buildSteppedMeshChunks(tin, style.step, maxBytes)]
    } else {
        terrain = [{ positions: tin.positions, indices: tin.indices, normals: tin.normals! }]
    }
    const t2 = performance.now()

    // 건물: 5K 단위 목록에서 무게중심이 이 도엽 안인 것만(bbox 로 먼저 거른 뒤 폴리곤). 바닥 높이는 이웃까지 합친 메쉬로
    let buildings: TinMesh | null = null
    let buildingTable: BuildingTable | null = null
    let built = 0
    const cached = builtBuildingsCache.get(t.map_id)
    if (cached) {
        buildings = cached.buildings && { ...cached.buildings, positions: cached.buildings.positions.slice(), indices: cached.buildings.indices.slice() }
        buildingTable = cached.buildingTable && cloneBuildingTable(cached.buildingTable)
        built = cached.built
    } else {
        try {
            const [codes, all] = await Promise.all([loadBuildingCodes(), buildingsOf5k(t.id5k, extentOf(t.corners.map(to3857)), origin)])
            const bx0 = Math.min(...poly.map((p) => p[0])), bx1 = Math.max(...poly.map((p) => p[0]))
            const by0 = Math.min(...poly.map((p) => p[1])), by1 = Math.max(...poly.map((p) => p[1]))
            const inside: Building[] = []
            for (const { b, cx, cy } of all) {
                if (cx < bx0 || cx > bx1 || cy < by0 || cy > by1) continue
                if (pointInPolygon(cx, cy, poly)) inside.push(b)
            }
            if (inside.length > 0) {
                const result = buildBuildingsMesh(inside, mergedMesh(), codes)
                buildings = result.mesh
                buildingTable = result.table
                built = result.built
            }
            builtBuildingsCache.set(t.map_id, {
                buildings: buildings && { ...buildings, positions: buildings.positions.slice(), indices: buildings.indices.slice() },
                buildingTable: buildingTable && cloneBuildingTable(buildingTable),
                built,
            })
        } catch (err) {
            console.warn(`도엽 ${t.name} 건물 실패:`, err)
        }
    }
    console.log(
        `도엽 ${t.name}${extra ? "(밖)" : ""}: ${fromCache ? "캐시" : `이웃 ${ttpTiles.length}개 합침`} ${Math.round(t1 - t0)}ms, ${style.mode} ${Math.round(t2 - t1)}ms, 삼각형 ${tin.indices.length / 3}, 건물 ${built}${cached ? "(캐시)" : ""}, ${Math.round(performance.now() - t2)}ms`,
    )

    const xy = positionsBounds(tin.positions)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [x, y] of poly) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
    }
    const data: TileData = {
        id: t.map_id,
        name: t.name,
        extra,
        mode: style.mode,
        bounds: { min: [minX, minY, xy.min[2]], max: [maxX, maxY, xy.max[2]] },
        terrain,
        tin: { origin, positions: tin.positions, indices: tin.indices },
        buildings,
        buildingTable,
        built,
    }
    return { data, transfer: transferablesOf(data) }
}

/** 도엽 데이터의 typed array 버퍼 목록(postMessage transfer 용. 같은 버퍼는 한 번만) */
export const transferablesOf = (data: TileData): Transferable[] => {
    const set = new Set<Transferable>([data.tin.positions.buffer as ArrayBuffer, data.tin.indices.buffer as ArrayBuffer])
    for (const ch of data.terrain) {
        set.add(ch.positions.buffer as ArrayBuffer)
        set.add(ch.indices.buffer as ArrayBuffer)
        if (ch.normals) set.add(ch.normals.buffer as ArrayBuffer)
    }
    if (data.buildings) {
        set.add(data.buildings.positions.buffer as ArrayBuffer)
        set.add(data.buildings.indices.buffer as ArrayBuffer)
    }
    if (data.buildingTable) for (const b of buildingTableBuffers(data.buildingTable)) set.add(b)
    return [...set]
}

self.onmessage = async (e: MessageEvent<BuildRequest>) => {
    const msg = e.data
    if (msg.type === "reset") {
        reset()
        return
    }
    try {
        const { data, transfer } = await buildTile(msg)
        post({ type: "built", jobId: msg.jobId, data }, transfer)
    } catch (err) {
        post({ type: "failed", jobId: msg.jobId, message: err instanceof Error ? err.message : String(err) })
    }
}
