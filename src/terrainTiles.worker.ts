import type { Extent } from "ol/extent"
import proj4 from "proj4"

import { Building, loadBuildingCodes, loadBuildings } from "./buildingsData"
import { buildBuildingsMesh } from "./buildingsMesh"
import { BuildingTable, buildingTableBuffers, cloneBuildingTable } from "./buildingTable"
import { computeVertexNormals, NORMAL_SMOOTH_ITERATIONS, positionsBounds, smoothVertexNormals } from "./meshNormals"
import { ClippedMesh, clipMeshToConvexPolygon } from "./terrainClip"
import { fetchGunzip, MeshChunk, TinMesh } from "./terrainData"
import { getTtpSheetsInBbox, TTP_BASE } from "./terrainIndex"
import { mergeTtpTiles, parseTtp, TtpTile } from "./terrainPslg"
import { buildSteppedMeshChunks } from "./terrainSteps"
import type { TerrainMode } from "./webgpu/terrainRenderer"

/**
 * 지형 도엽 Worker(계획 문서 7절 L1, 2026-10-14). 데이터 단위를 1K 도엽(500 × 400 m)으로 통일했다: 선택 범위의 3D 도 걸어 보기
 * 스트리밍도 같은 함수(buildTile)로 도엽을 하나씩 만들어 보낸다. 전에는 선택 범위를 한 덩어리로 삼각분할·계단형 변환했고
 * 걸어 보기만 도엽 단위였다(walkTiles.worker.ts).
 *
 * 도엽 하나 만들기: 그 도엽과 맞닿은 이웃(3×3)을 함께 합쳐 재삼각분할한 뒤(mergeTtpTiles) 도엽 폴리곤으로 자른다
 * (clipMeshToConvexPolygon). 혼자 삼각분할하면 도엽 변에 바늘 삼각형이 생겨서(terrainClip 참고) 이웃을 같이 넣는다.
 * 이웃까지 넣은 합친 메쉬를 건물 바닥 높이에도 쓰고, 건물은 무게중심이 이 도엽 안인 것만 세워 경계에 걸친 건물이 한 번만
 * 나오게 한다. 지형은 스타일에 따라 계단형 조각(step) 또는 법선을 붙인 매끈한 면(tin) 으로 보낸다. 원본 TIN 도 함께 보내
 * 메인이 발 높이 조회에 쓴다. 매끈한 면의 법선은 이웃을 합친 메쉬에서 계산한 뒤 자를 때 같이 실어(terrainClip) 도엽 경계
 * 정점도 이웃 삼각형을 본 법선을 갖는다(L2, 2026-10-14).
 * 자른 TIN(과 법선)은 도엽별로 캐시해(TIN_CACHE_BYTES 안에서 오래된 것부터 버림) 표현 방식·층 간격 전환 때 이웃 합침·삼각분할을
 * 다시 하지 않는다. 건물도 도엽별 캐시. 둘 다 select 때 비운다.
 *
 * 메시지:
 * - select: 범위(3857)의 도엽 목록·원점을 찾아 알리고(selection), 5K 파일을 모두 받은 뒤(progress download), 중심에서 가까운
 *   도엽부터 하나씩 만들어 보낸다(tile, progress build). 끝나면 done
 * - style: 지형 표현 방식·층 간격을 바꾼다. 들고 있는 도엽을 같은 순서로 다시 만들어 보낸다(교체). 끝나면 done
 * - walk: 걸어 보기 중심(5179 m). 선택 범위 **밖** 도엽을 반경 안에서 가까운 순으로 더하고(extra), 반경의 1.5배 밖으로 나간 것은
 *   뺀다. 상한(maxTiles)이 차면 가장 먼 것을 빼되, 그것이 새로 넣을 것보다 가까우면 멈춘다. center 가 null 이면 밖 도엽을 모두 뺀다.
 *   선택 도엽은 걸어 보기와 무관하게 유지된다
 * 5K 파일(ttp)은 path 로 캐시한다(선택 범위의 파일은 모두 들어가게 상한을 늘린다). 건물 파일은 buildingsData 가 캐시
 */
export type TileStyle = {
    mode: TerrainMode
    /** 계단형 층 간격(m). mode 가 stepped 일 때만 쓴다 */
    step: number
}
export type TerrainTilesRequest =
    | {
          type: "select"
          /** 선택 범위(3857) */
          bbox: Extent
          style: TileStyle
          /** 조각 버퍼 상한(바이트) */
          maxBytes: number
      }
    | { type: "style"; style: TileStyle }
    | {
          type: "walk"
          /** 플레이어 위치(5179 m). null 이면 걸어 보기 끝 */
          center: [number, number] | null
          /** 로드 반경(m) */
          radius: number
          /** 선택 범위 밖 도엽 상한 */
          maxTiles: number
      }

/** 도엽의 자리(선택 직후 목록용) */
export type TileSummary = {
    id: string
    name: string
    /** 도엽 xy 범위(원점 기준 m) */
    bounds: { min: [number, number]; max: [number, number] }
}
export type TileData = {
    id: string
    name: string
    /** 선택 범위 밖(걸어 보기 스트리밍) 도엽인지 */
    extra: boolean
    /** 지형 조각의 표현 방식 */
    mode: TerrainMode
    /** 도엽 xyz 범위(원점 기준 m. xy 는 도엽 폴리곤, z 는 지형) */
    bounds: { min: [number, number, number]; max: [number, number, number] }
    /** 그릴 지형 조각(계단형, 또는 법선이 있는 TIN) */
    terrain: MeshChunk[]
    /** 발 높이 조회·내보내기용 원본 TIN(도엽 폴리곤으로 자른 것) */
    tin: TinMesh
    /** 건물 메쉬(없으면 null) */
    buildings: TinMesh | null
    /** 건물 표(내보내기 속성용. 메쉬 오프셋은 이 도엽 건물 메쉬 기준) */
    buildingTable: BuildingTable | null
    /** 세운 건물 수 */
    built: number
}

export type TerrainTilesResponse =
    | {
          type: "selection"
          origin: [number, number]
          tiles: TileSummary[]
          sheets: number
          /** 선택 사각형의 중심(원점 기준 m). 걸어 보기 시작점 */
          center: [number, number]
      }
    | { type: "progress"; phase: "sheets" | "download" | "build"; done: number; total: number }
    | { type: "tile"; tile: TileData }
    | { type: "remove"; id: string }
    | { type: "done" }
    | { type: "error"; message: string }

/** 반경의 이 배수 밖으로 나간 밖 도엽을 뺀다(들락날락 방지) */
const REMOVE_RATIO = 1.5
/** 이웃 도엽을 같이 조회하려고 반경·범위에 더하는 여유(m). 1K 한 변(500 m)보다 크게 */
const NEIGHBOR_MARGIN = 600
/** 5K 파일 캐시 상한(개). 선택 범위의 파일 수 + 여유로 늘린다 */
let ttpCacheMax = 16

const post = (msg: TerrainTilesResponse, transfer: Transferable[] = []) => self.postMessage(msg, { transfer })

/** 5179 m 좌표를 3857 로 */
const to3857 = ([x, y]: [number, number]) => proj4("EPSG:5179", "EPSG:3857", [x, y]) as [number, number]

/** 5179 사각형(중심 ± half)을 3857 bbox 로(네 모서리를 바꾼 외접 범위) */
const squareTo3857 = (center: [number, number], half: number): Extent =>
    extentOf([
        to3857([center[0] - half, center[1] - half]),
        to3857([center[0] + half, center[1] - half]),
        to3857([center[0] + half, center[1] + half]),
        to3857([center[0] - half, center[1] + half]),
    ])

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
const extentsOverlap = (a: Extent, b: Extent) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]
const centroid = (pts: [number, number][]): [number, number] => [
    pts.reduce((s, p) => s + p[0], 0) / pts.length,
    pts.reduce((s, p) => s + p[1], 0) / pts.length,
]
const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1])

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

type Query = Awaited<ReturnType<typeof getTtpSheetsInBbox>>
type QueryTile = Query["tiles"][number]

/** 5K 파일 캐시: path → 파싱 결과 */
const ttpCache = new Map<string, Promise<ReturnType<typeof parseTtp>>>()
const fetchTtpCached = (path: string) => {
    let p = ttpCache.get(path)
    if (!p) {
        p = fetchGunzip(`${TTP_BASE}/${path}`).then(parseTtp)
        ttpCache.set(path, p)
        p.catch(() => ttpCache.delete(path))
        if (ttpCache.size > ttpCacheMax) ttpCache.delete(ttpCache.keys().next().value!)
    } else {
        // 최근 사용을 뒤로 보내 오래된 것부터 빠지게
        ttpCache.delete(path)
        ttpCache.set(path, p)
    }
    return p
}

// ---- 상태 ----
let cfg: { origin: [number, number]; style: TileStyle; maxBytes: number } | null = null
/** 지금 선택: 도엽 id 집합과 이웃까지 포함한 조회 결과(선택 도엽의 이웃을 여기서 찾는다) */
let selection: { ids: Set<string>; query: Query } | null = null
/** 로드된 도엽: id → 도엽 정보·밖 도엽인지·중심(5179) */
const loaded = new Map<string, { tile: QueryTile; extra: boolean; center: [number, number] }>()
/** 만들 차례(선택 도엽 또는 스타일 재생성). 앞에서부터 */
let pending: { tile: QueryTile; extra: boolean }[] = []
let pendingTotal = 0
let pendingDone = 0
let walk: { center: [number, number]; radius: number; maxTiles: number } | null = null
/** 자른 TIN 캐시의 상한(바이트). 넘으면 오래 안 쓴 도엽부터 버린다(그 도엽은 전환 때 다시 삼각분할) */
const TIN_CACHE_BYTES = 256 * 1048576
type CachedTin = { positions: Float32Array; indices: Uint32Array; normals?: Float32Array; bytes: number }
/** 도엽별 자른 TIN(+ 매끈한 면 법선) 캐시: id → 사본. 메인으로 transfer 하는 버퍼와 별개 */
const tinCache = new Map<string, CachedTin>()
let tinCacheBytes = 0
const tinCacheGet = (id: string) => {
    const hit = tinCache.get(id)
    if (hit) {
        // 최근 사용을 뒤로 보내 오래된 것부터 빠지게
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
/**
 * 도엽별 건물 결과 캐시(스타일 재생성 때 건물은 지형 표현 방식과 무관하므로 다시 만들지 않는다). 메인으로 transfer 하기 전에
 * 복사해 둔다. select 때 비운다
 */
const buildingsCache = new Map<string, { buildings: TinMesh | null; buildingTable: BuildingTable | null; built: number }>()
/** select 마다 1 오른다. 늦게 끝난 이전 선택의 작업은 버린다 */
let generation = 0
let running = false

/**
 * 도엽 하나를 만든다(이웃과 합쳐 삼각분할 → 도엽 폴리곤으로 자르기 → 스타일대로 조각 → 건물).
 *
 * @param t 만들 도엽
 * @param q 이웃을 찾을 조회 결과(도엽 주변 여유를 포함한 것)
 * @param extra 선택 범위 밖(걸어 보기) 도엽인지
 */
const buildTile = async (t: QueryTile, q: Query, extra: boolean): Promise<{ data: TileData; transfer: Transferable[] }> => {
    const c = cfg!
    const [ox, oy] = c.origin
    const expanded: Extent = [t.bbox[0] - 1, t.bbox[1] - 1, t.bbox[2] + 1, t.bbox[3] + 1]
    const neighbors = q.tiles.filter((n) => extentsOverlap(n.bbox, expanded))
    const pathById5k = new Map(q.sheets.map((s) => [s.id5k, s.path]))
    const ids5k = [...new Set(neighbors.map((n) => n.id5k))]
    const files = await Promise.all(ids5k.map((id) => fetchTtpCached(pathById5k.get(id)!)))
    const ttpById = new Map<string, TtpTile>()
    for (const f of files) for (const tile of f.tiles) ttpById.set(tile.mapId, tile)
    const ttpTiles = neighbors.map((n) => ttpById.get(n.map_id)).filter((x): x is TtpTile => !!x)
    if (!ttpById.has(t.map_id)) throw new Error(`도엽 ${t.map_id} 이 5K 파일에 없음`)

    const t0 = performance.now()
    const poly = t.corners.map(([x, y]) => [x - ox, y - oy] as [number, number])
    const needNormals = c.style.mode === "tin"
    /** 이웃을 합친 메쉬. 캐시가 맞으면 만들지 않는다(건물 바닥 높이에 필요하면 그때 만든다) */
    let merged: TinMesh | null = null
    const mergedMesh = () => (merged ??= mergeTtpTiles(ttpTiles, c.origin))
    const cachedTin = tinCacheGet(t.map_id)
    let tin: ClippedMesh
    let fromCache = false
    if (cachedTin && (!needNormals || cachedTin.normals)) {
        tin = { origin: c.origin, positions: cachedTin.positions.slice(), indices: cachedTin.indices.slice(), normals: cachedTin.normals?.slice() }
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
    if (c.style.mode === "stepped" && c.style.step > 0) {
        terrain = [...buildSteppedMeshChunks(tin, c.style.step, c.maxBytes)]
    } else {
        terrain = [{ positions: tin.positions, indices: tin.indices, normals: tin.normals! }]
    }
    const t2 = performance.now()

    // 건물: 이 도엽 bbox 로 받아 무게중심이 도엽 안인 것만, 바닥 높이는 이웃까지 합친 메쉬로(경계 건물이 한 번만, 지형 밖 판정 없이)
    let buildings: TinMesh | null = null
    let buildingTable: BuildingTable | null = null
    let built = 0
    const cached = buildingsCache.get(t.map_id)
    if (cached) {
        buildings = cached.buildings && { ...cached.buildings, positions: cached.buildings.positions.slice(), indices: cached.buildings.indices.slice() }
        buildingTable = cached.buildingTable && cloneBuildingTable(cached.buildingTable)
        built = cached.built
    } else try {
        const [codes, { buildings: all }] = await Promise.all([loadBuildingCodes(), loadBuildings(extentOf(t.corners.map(to3857)), c.origin)])
        const inside = all.filter((b: Building) => {
            let sx = 0, sy = 0
            const n = b.xy.length / 2
            for (let i = 0; i < b.xy.length; i += 2) {
                sx += b.xy[i]
                sy += b.xy[i + 1]
            }
            return pointInPolygon(sx / n / 1000, sy / n / 1000, poly)
        })
        if (inside.length > 0) {
            const result = buildBuildingsMesh(inside, mergedMesh(), codes)
            buildings = result.mesh
            buildingTable = result.table
            built = result.built
        }
        buildingsCache.set(t.map_id, {
            buildings: buildings && { ...buildings, positions: buildings.positions.slice(), indices: buildings.indices.slice() },
            buildingTable: buildingTable && cloneBuildingTable(buildingTable),
            built,
        })
    } catch (err) {
        console.warn(`도엽 ${t.name} 건물 실패:`, err)
    }
    console.log(
        `도엽 ${t.name}${extra ? "(밖)" : ""}: ${fromCache ? "캐시" : `이웃 ${ttpTiles.length}개 합침`} ${Math.round(t1 - t0)}ms, ${c.style.mode} ${Math.round(t2 - t1)}ms, 삼각형 ${tin.indices.length / 3}, 건물 ${built}${cached ? "(캐시)" : ""}, ${Math.round(performance.now() - t2)}ms`,
    )

    const xy = positionsBounds(tin.positions)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [x, y] of poly) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
    }
    const transfer = new Set<Transferable>([tin.positions.buffer as ArrayBuffer, tin.indices.buffer as ArrayBuffer])
    if (tin.normals) transfer.add(tin.normals.buffer as ArrayBuffer)
    for (const ch of terrain) {
        transfer.add(ch.positions.buffer as ArrayBuffer)
        transfer.add(ch.indices.buffer as ArrayBuffer)
        if (ch.normals) transfer.add(ch.normals.buffer as ArrayBuffer)
    }
    if (buildings) {
        transfer.add(buildings.positions.buffer as ArrayBuffer)
        transfer.add(buildings.indices.buffer as ArrayBuffer)
    }
    if (buildingTable) for (const b of buildingTableBuffers(buildingTable)) transfer.add(b)
    return {
        data: {
            id: t.map_id,
            name: t.name,
            extra,
            mode: c.style.mode,
            bounds: { min: [minX, minY, xy.min[2]], max: [maxX, maxY, xy.max[2]] },
            terrain,
            tin: { origin: c.origin, positions: tin.positions, indices: tin.indices },
            buildings,
            buildingTable,
            built,
        },
        transfer: [...transfer],
    }
}

/** 큐(선택·재생성)를 비우고, 걸어 보기 중이면 밖 도엽을 넣고 뺀다. 이미 돌고 있으면 그 루프가 새 상태를 본다 */
const run = async () => {
    if (running) return
    running = true
    try {
        for (;;) {
            const gen = generation
            if (!cfg || !selection) break
            const next = pending.shift()
            if (next) {
                const { data, transfer } = await buildTile(next.tile, selection.query, next.extra)
                if (gen !== generation) break
                loaded.set(data.id, { tile: next.tile, extra: next.extra, center: centroid(next.tile.corners) })
                post({ type: "tile", tile: data }, transfer)
                pendingDone++
                post({ type: "progress", phase: "build", done: pendingDone, total: pendingTotal })
                if (pending.length === 0) post({ type: "done" })
                continue
            }
            if (!walk) break
            const w = walk
            const sel = selection
            // 선택 범위 밖 도엽: 반경 안에서 가까운 순. 멀어진 것은 뺀다
            const q = await getTtpSheetsInBbox(squareTo3857(w.center, w.radius + NEIGHBOR_MARGIN))
            if (gen !== generation || walk !== w) continue
            const candidates = q.tiles
                .filter((t) => !sel.ids.has(t.map_id))
                .map((t) => ({ t, d: dist(w.center, centroid(t.corners)) }))
                .filter((x) => x.d <= w.radius)
                .sort((a, b) => a.d - b.d)
            for (const [id, info] of loaded) {
                if (info.extra && dist(w.center, info.center) > w.radius * REMOVE_RATIO) {
                    loaded.delete(id)
                    post({ type: "remove", id })
                }
            }
            const candidate = candidates.find((x) => !loaded.has(x.t.map_id))
            if (!candidate) break
            const extras = [...loaded].filter(([, info]) => info.extra)
            if (extras.length >= w.maxTiles) {
                let farthest: { id: string; d: number } | null = null
                for (const [id, info] of extras) {
                    const d = dist(w.center, info.center)
                    if (!farthest || d > farthest.d) farthest = { id, d }
                }
                if (!farthest || farthest.d <= candidate.d) break
                loaded.delete(farthest.id)
                post({ type: "remove", id: farthest.id })
            }
            const { data, transfer } = await buildTile(candidate.t, q, true)
            if (gen !== generation) break
            loaded.set(data.id, { tile: candidate.t, extra: true, center: centroid(candidate.t.corners) })
            post({ type: "tile", tile: data }, transfer)
        }
    } catch (err) {
        post({ type: "error", message: err instanceof Error ? err.message : String(err) })
    } finally {
        running = false
    }
}

/** 선택: 도엽 목록·원점 → 5K 파일 내려받기 → 중심에서 가까운 순으로 큐에 넣기 */
const select = async (msg: Extract<TerrainTilesRequest, { type: "select" }>) => {
    const gen = ++generation
    loaded.clear()
    buildingsCache.clear()
    tinCache.clear()
    tinCacheBytes = 0
    pending = []
    walk = null
    post({ type: "progress", phase: "sheets", done: 0, total: 0 })
    // 선택 범위에 걸친 도엽과, 경계 도엽의 이웃까지 포함한 조회(이웃 합치기용). 3857 단위는 m 보다 조금 크므로 여유를 넉넉히
    const margin = NEIGHBOR_MARGIN * 1.5
    const [qSel, qAll] = await Promise.all([
        getTtpSheetsInBbox(msg.bbox),
        getTtpSheetsInBbox([msg.bbox[0] - margin, msg.bbox[1] - margin, msg.bbox[2] + margin, msg.bbox[3] + margin]),
    ])
    if (gen !== generation) return
    if (qSel.tiles.length === 0) throw new Error("선택 범위에 도엽이 없습니다")
    cfg = { origin: qSel.origin, style: msg.style, maxBytes: msg.maxBytes }
    selection = { ids: new Set(qSel.tiles.map((t) => t.map_id)), query: qAll }
    const [ox, oy] = qSel.origin
    const summaries: TileSummary[] = qSel.tiles.map((t) => {
        const local = t.corners.map(([x, y]) => [x - ox, y - oy] as [number, number])
        const e = extentOf(local)
        return { id: t.map_id, name: t.name, bounds: { min: [e[0], e[1]], max: [e[2], e[3]] } }
    })
    const c5179 = proj4("EPSG:3857", "EPSG:5179", [(msg.bbox[0] + msg.bbox[2]) / 2, (msg.bbox[1] + msg.bbox[3]) / 2]) as [number, number]
    post({ type: "selection", origin: qSel.origin, tiles: summaries, sheets: qAll.sheets.length, center: [c5179[0] - ox, c5179[1] - oy] })
    // 5K 파일을 모두 받는다(캐시 상한을 선택 범위 전체가 들어가게)
    ttpCacheMax = Math.max(16, qAll.sheets.length + 8)
    let done = 0
    post({ type: "progress", phase: "download", done, total: qAll.sheets.length })
    await Promise.all(
        qAll.sheets.map((s) =>
            fetchTtpCached(s.path).then(() => {
                done++
                if (gen === generation) post({ type: "progress", phase: "download", done, total: qAll.sheets.length })
            }),
        ),
    )
    if (gen !== generation) return
    // 중심에서 가까운 순(나선): 선택 도엽 전체의 중심 기준
    const center = centroid(qSel.tiles.flatMap((t) => t.corners))
    pending = qSel.tiles
        .map((t) => ({ t, d: dist(center, centroid(t.corners)) }))
        .sort((a, b) => a.d - b.d)
        .map((x) => ({ tile: x.t, extra: false }))
    pendingTotal = pending.length
    pendingDone = 0
    post({ type: "progress", phase: "build", done: 0, total: pendingTotal })
    void run()
}

self.onmessage = async (e: MessageEvent<TerrainTilesRequest>) => {
    const msg = e.data
    try {
        if (msg.type === "select") {
            await select(msg)
        } else if (msg.type === "style") {
            if (!cfg) return
            cfg.style = msg.style
            // 들고 있는 도엽을 같은 순서(선택 도엽 → 밖 도엽)로 다시 만든다. 이미 큐에 있는 것은 새 스타일로 만들어지므로 그대로
            const queued = new Set(pending.map((p) => p.tile.map_id))
            for (const [id, info] of loaded) if (!queued.has(id)) pending.push({ tile: info.tile, extra: info.extra })
            pendingTotal = pending.length
            pendingDone = 0
            post({ type: "progress", phase: "build", done: 0, total: pendingTotal })
            void run()
        } else {
            if (msg.center) {
                walk = { center: msg.center, radius: msg.radius, maxTiles: msg.maxTiles }
            } else {
                walk = null
                for (const [id, info] of loaded) {
                    if (!info.extra) continue
                    loaded.delete(id)
                    post({ type: "remove", id })
                }
            }
            void run()
        }
    } catch (err) {
        post({ type: "error", message: err instanceof Error ? err.message : String(err) })
    }
}
