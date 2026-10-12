import type { Extent } from "ol/extent"
import proj4 from "proj4"

import { Building, loadBuildingCodes, loadBuildings } from "./buildingsData"
import { buildBuildingsMesh } from "./buildingsMesh"
import { clipMeshToConvexPolygon } from "./terrainClip"
import { fetchGunzip, MeshChunk, TileInfo, TinMesh } from "./terrainData"
import { getTtpSheetsInBbox, TTP_BASE } from "./terrainIndex"
import { mergeTtpTiles, parseTtp, TtpTile } from "./terrainPslg"
import { buildSteppedMeshChunks } from "./terrainSteps"

/**
 * 걸어 보기 도엽 스트리밍 Worker(계획 문서 6절 6차). 플레이어 주변 반경 안의 1K 도엽(500 × 400 m)을 하나씩 만들어 보내고,
 * 멀어진 도엽은 빼라고 알린다. 걸어 보기 안에서만 쓰며 나가면 Worker 를 끝낸다(선택 범위 메쉬는 그대로).
 *
 * 도엽 하나 만들기: 그 도엽과 맞닿은 이웃(3×3)을 함께 합쳐 재삼각분할한 뒤(mergeTtpTiles) 도엽 폴리곤으로 자른다
 * (clipMeshToConvexPolygon). 혼자 삼각분할하면 도엽 변에 바늘 삼각형이 생겨서(terrainClip 참고) 이웃을 같이 넣는다.
 * 이웃까지 넣은 합친 메쉬를 건물 바닥 높이에도 쓰고, 건물은 무게중심이 이 도엽 안인 것만 세워 경계에 걸친 건물이 한 번만
 * 나오게 한다. 지형은 층 간격 step 으로 계단형 조각을 만들어 보낸다(걸어 보기는 계단형). 원본 TIN 도 함께 보내 메인이
 * 발 높이 조회에 쓴다.
 *
 * 순서: 중심에서 가까운 도엽부터 하나씩. 중심이 바뀌면(update) 다음 도엽부터 새 중심 기준으로 고른다. 반경의 1.5배 밖으로
 * 나간 도엽은 뺀다. 로드 상한(maxTiles)이 차면 가장 먼 것을 빼되, 그것이 새로 넣을 것보다 가까우면 멈춘다.
 * 5K 파일(ttp)은 path 로 캐시한다(건물 파일은 buildingsData 가 캐시).
 * 선택 범위에 걸친 도엽이 모두 로드되면 covers: true 를 보내 메인이 선택 메쉬를 숨기게 한다(겹치면 z-fighting)
 */
export type WalkTilesRequest =
    | {
          type: "init"
          /** 선택 범위 메쉬의 원점(정수 m, 5179). 도엽 좌표도 이 원점 기준으로 만든다 */
          origin: [number, number]
          /** 선택 범위(3857). 이 범위에 걸친 도엽이 다 로드되면 covers 를 보낸다 */
          selection: Extent
          /** 계단형 층 간격(m). 0 이면 계단형 변환 없이 TIN 을 보낸다 */
          step: number
          /** 조각 버퍼 상한(바이트) */
          maxBytes: number
          /** 로드 반경(m) */
          radius: number
          /** 동시에 들고 있을 도엽 상한 */
          maxTiles: number
      }
    | { type: "update"; center: [number, number] }

export type WalkTileData = {
    id: string
    name: string
    /** 도엽 xy 범위(원점 기준 m) */
    bounds: { min: [number, number]; max: [number, number] }
    /** 그릴 지형 조각(계단형 또는 TIN) */
    terrain: MeshChunk[]
    /** 발 높이 조회용 원본 TIN(도엽 폴리곤으로 자른 것) */
    tin: TinMesh
    /** 건물 메쉬(없으면 null) */
    buildings: TinMesh | null
}

export type WalkTilesResponse =
    | { type: "tile"; tile: WalkTileData }
    | { type: "remove"; id: string }
    | { type: "covers"; covers: boolean }
    | { type: "error"; message: string }

/** 반경의 이 배수 밖으로 나간 도엽을 뺀다(들락날락 방지) */
const REMOVE_RATIO = 1.5
/** 이웃 도엽을 같이 조회하려고 반경에 더하는 여유(m). 1K 한 변(500 m)보다 크게 */
const NEIGHBOR_MARGIN = 600
/** 5K 파일 캐시 상한(개). 넘으면 오래된 것부터 뺀다 */
const TTP_CACHE_MAX = 16

const post = (msg: WalkTilesResponse, transfer: Transferable[] = []) => self.postMessage(msg, { transfer })

/** 5179 m 좌표를 3857 로 */
const to3857 = ([x, y]: [number, number]) => proj4("EPSG:5179", "EPSG:3857", [x, y]) as [number, number]

/** 5179 사각형(중심 ± half)을 3857 bbox 로(네 모서리를 바꾼 외접 범위) */
const squareTo3857 = (center: [number, number], half: number): Extent => {
    const corners: [number, number][] = [
        to3857([center[0] - half, center[1] - half]),
        to3857([center[0] + half, center[1] - half]),
        to3857([center[0] + half, center[1] + half]),
        to3857([center[0] - half, center[1] + half]),
    ]
    return extentOf(corners)
}

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

let config: Extract<WalkTilesRequest, { type: "init" }> | null = null
/** 선택 범위에 걸친 도엽 id(covers 판정용) */
let selectionIds: string[] = []
let wanted: [number, number] | null = null
let running = false
let coversSent = false
/** 로드된 도엽: id → 도엽 중심(5179) */
const loaded = new Map<string, { center: [number, number] }>()
/** 5K 파일 캐시: path → 파싱 결과 */
const ttpCache = new Map<string, Promise<ReturnType<typeof parseTtp>>>()

const fetchTtpCached = (path: string) => {
    let p = ttpCache.get(path)
    if (!p) {
        p = fetchGunzip(`${TTP_BASE}/${path}`).then(parseTtp)
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

/**
 * 도엽 하나를 만든다(이웃과 합쳐 삼각분할 → 도엽 폴리곤으로 자르기 → 계단형 조각 → 건물).
 *
 * @param t 만들 도엽
 * @param q 반경 + 여유 안의 도엽·5K 조회 결과(이웃을 여기서 찾는다)
 */
const buildTile = async (t: QueryTile, q: Query): Promise<{ data: WalkTileData; transfer: Transferable[] }> => {
    const cfg = config!
    const [ox, oy] = cfg.origin
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
    const merged = mergeTtpTiles(ttpTiles, cfg.origin)
    const poly = t.corners.map(([x, y]) => [x - ox, y - oy] as [number, number])
    const tin = clipMeshToConvexPolygon(merged, poly)
    const t1 = performance.now()
    const terrain: MeshChunk[] =
        cfg.step > 0
            ? [...buildSteppedMeshChunks(tin, cfg.step, cfg.maxBytes)]
            : [{ positions: tin.positions, indices: tin.indices }]
    const t2 = performance.now()

    // 건물: 이 도엽 bbox 로 받아 무게중심이 도엽 안인 것만, 바닥 높이는 이웃까지 합친 메쉬로(경계 건물이 한 번만, 지형 밖 판정 없이)
    let buildings: TinMesh | null = null
    let builtCount = 0
    try {
        const [codes, { buildings: all }] = await Promise.all([
            loadBuildingCodes(),
            loadBuildings(extentOf(t.corners.map(to3857)), cfg.origin),
        ])
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
            const built = buildBuildingsMesh(inside, merged, codes)
            buildings = built.mesh
            builtCount = built.built
        }
    } catch (err) {
        console.warn(`도엽 ${t.name} 건물 실패:`, err)
    }
    console.log(
        `도엽 ${t.name}: 이웃 ${ttpTiles.length}개 합침 ${Math.round(t1 - t0)}ms, 계단형 ${Math.round(t2 - t1)}ms, 삼각형 ${tin.indices.length / 3}, 건물 ${builtCount}, ${Math.round(performance.now() - t2)}ms`,
    )

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [x, y] of poly) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
    }
    const transfer: Transferable[] = [tin.positions.buffer as ArrayBuffer, tin.indices.buffer as ArrayBuffer]
    for (const c of terrain) {
        if (c.positions.buffer !== tin.positions.buffer) transfer.push(c.positions.buffer as ArrayBuffer)
        if (c.indices.buffer !== tin.indices.buffer) transfer.push(c.indices.buffer as ArrayBuffer)
    }
    if (buildings) transfer.push(buildings.positions.buffer as ArrayBuffer, buildings.indices.buffer as ArrayBuffer)
    return {
        data: {
            id: t.map_id,
            name: t.name,
            bounds: { min: [minX, minY], max: [maxX, maxY] },
            terrain,
            tin: { origin: cfg.origin, positions: tin.positions, indices: tin.indices },
            buildings,
        },
        transfer,
    }
}

/** 선택 범위 도엽이 다 로드됐는지 알린다(바뀔 때만) */
const postCovers = () => {
    const covers = selectionIds.length > 0 && selectionIds.every((id) => loaded.has(id))
    if (covers !== coversSent) {
        coversSent = covers
        post({ type: "covers", covers })
    }
}

/** 지금 중심 기준으로 빼고 넣을 도엽을 정해 하나씩 만든다. 이미 돌고 있으면 그 루프가 새 중심을 본다 */
const run = async () => {
    if (running || !config) return
    running = true
    try {
        for (;;) {
            const center = wanted
            if (!center) break
            const cfg = config
            const q = await getTtpSheetsInBbox(squareTo3857(center, cfg.radius + NEIGHBOR_MARGIN))
            const candidates = q.tiles
                .map((t) => ({ t, d: dist(center, centroid(t.corners)) }))
                .filter((c) => c.d <= cfg.radius)
                .sort((a, b) => a.d - b.d)
            for (const [id, info] of loaded) {
                if (dist(center, info.center) > cfg.radius * REMOVE_RATIO) {
                    loaded.delete(id)
                    post({ type: "remove", id })
                }
            }
            const next = candidates.find((c) => !loaded.has(c.t.map_id))
            if (!next) {
                postCovers()
                break
            }
            if (loaded.size >= cfg.maxTiles) {
                let farthest: { id: string; d: number } | null = null
                for (const [id, info] of loaded) {
                    const d = dist(center, info.center)
                    if (!farthest || d > farthest.d) farthest = { id, d }
                }
                if (!farthest || farthest.d <= next.d) {
                    postCovers()
                    break
                }
                loaded.delete(farthest.id)
                post({ type: "remove", id: farthest.id })
            }
            const { data, transfer } = await buildTile(next.t, q)
            loaded.set(data.id, { center: centroid(next.t.corners) })
            post({ type: "tile", tile: data }, transfer)
            postCovers()
        }
    } catch (err) {
        post({ type: "error", message: err instanceof Error ? err.message : String(err) })
    } finally {
        running = false
    }
}

self.onmessage = async (e: MessageEvent<WalkTilesRequest>) => {
    const msg = e.data
    if (msg.type === "init") {
        config = msg
        try {
            selectionIds = (await getTtpSheetsInBbox(msg.selection)).tiles.map((t: TileInfo) => t.map_id)
        } catch (err) {
            post({ type: "error", message: err instanceof Error ? err.message : String(err) })
        }
        void run()
        return
    }
    wanted = msg.center
    void run()
}
