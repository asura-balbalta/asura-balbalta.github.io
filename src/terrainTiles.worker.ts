import type { Extent } from "ol/extent"
import proj4 from "proj4"

import type { BuildingTable } from "./buildingTable"
import type { MeshChunk, TinMesh } from "./terrainData"
import { getTtpSheetsInBbox } from "./terrainIndex"
import type { BuildRequest, BuildResponse } from "./terrainTileBuild.worker"
import type { TerrainMode } from "./webgpu/terrainRenderer"

/**
 * 지형 도엽 조정 Worker(계획 문서 7절 L1 ~ L5, 2026-10-14). 데이터 단위를 1K 도엽(500 × 400 m)으로 통일했다: 선택 범위의 3D 도
 * 걸어 보기 스트리밍도 같은 도엽 생성으로 하나씩 만들어 보낸다. 전에는 선택 범위를 한 덩어리로 삼각분할·계단형 변환했고 걸어 보기만
 * 도엽 단위였다(walkTiles.worker.ts).
 *
 * 생성 자체는 보조 워커(terrainTileBuild.worker.ts) 2 ~ 3개가 한다(L5-B). 같은 5K 의 도엽은 같은 보조 워커로 보내 5K 파일·자른 TIN·
 * 건물 캐시가 한 곳에 모이게 한다. 이 워커는 선택·큐·걸어 보기 반경·진행률·완료만 맡는다.
 *
 * 메시지:
 * - select: 범위(3857)의 도엽 목록·원점·선택 중심을 알리고(selection), 중심에서 가까운 도엽부터 보조 워커에 나눠 만든다(tile,
 *   progress download(보조 워커가 받은 5K 파일 수)·build). 끝나면 done
 * - style: 지형 표현 방식·층 간격을 바꾼다. 들고 있는 도엽을 같은 순서로 다시 만들어 보낸다(교체. 보조 워커 캐시로 빠르다). 끝나면 done
 * - walk: 걸어 보기 중심(5179 m). 선택 범위 **밖** 도엽을 반경 안에서 가까운 순으로 더하고(extra), 반경의 1.5배 밖으로 나간 것은
 *   뺀다. 상한(maxTiles)이 차면 가장 먼 것을 빼되, 그것이 새로 넣을 것보다 가까우면 멈춘다. center 가 null 이면 밖 도엽을 모두 뺀다.
 *   선택 도엽은 걸어 보기와 무관하게 유지된다
 */
export type TileStyle = {
    mode: TerrainMode
    /** 계단형 층 간격(m). mode 가 stepped 일 때만 쓴다 */
    step: number
    /** 이웃 합치기의 경계 띠 폭(m, L5-C). 0 이면 이웃 3×3 전체(옛 동작). 없으면 보조 워커 기본값. 디버그 페이지 band= */
    band?: number
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

type Query = Awaited<ReturnType<typeof getTtpSheetsInBbox>>
export type QueryTile = Query["tiles"][number]

/** 반경의 이 배수 밖으로 나간 밖 도엽을 뺀다(들락날락 방지) */
const REMOVE_RATIO = 1.5
/** 이웃 도엽을 같이 조회하려고 반경·범위에 더하는 여유(m). 1K 한 변(500 m)보다 크게 */
const NEIGHBOR_MARGIN = 600
/** esbuild 가 src/terrainTileBuild.worker.ts 를 별도 entry 로 묶어 내는 파일(dist, 이 워커와 같은 폴더) */
const BUILD_WORKER_URL = "terrainTileBuild.worker.js"
/** 보조 워커 수: 코어 수에서 메인·조정자 몫을 빼고 1 ~ 3 */
const HELPER_COUNT = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 2))

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

// ---- 보조 워커 ----
type Helper = { worker: Worker; index: number }
const helpers: Helper[] = []
/** 보낸 일감: jobId → 결과를 기다리는 쪽 */
const jobs = new Map<number, { resolve: (data: TileData) => void; reject: (err: Error) => void }>()
let nextJobId = 1
/** 보조 워커가 받은 5K 파일 경로(진행률용. 같은 파일을 두 워커가 받아도 한 번만 센다) */
const fetchedPaths = new Set<string>()
let downloadTotal = 0

const ensureHelpers = () => {
    while (helpers.length < HELPER_COUNT) {
        const index = helpers.length
        const worker = new Worker(BUILD_WORKER_URL)
        worker.onmessage = (e: MessageEvent<BuildResponse>) => {
            const msg = e.data
            if (msg.type === "fetched") {
                if (!fetchedPaths.has(msg.path)) {
                    fetchedPaths.add(msg.path)
                    if (downloadTotal > 0) post({ type: "progress", phase: "download", done: Math.min(fetchedPaths.size, downloadTotal), total: downloadTotal })
                }
                return
            }
            const job = jobs.get(msg.jobId)
            if (!job) return
            jobs.delete(msg.jobId)
            if (msg.type === "built") job.resolve(msg.data)
            else job.reject(new Error(msg.message))
        }
        worker.onerror = (e) => {
            for (const job of jobs.values()) job.reject(new Error(`도엽 생성 Worker 오류: ${e.message}`))
            jobs.clear()
        }
        helpers.push({ worker, index })
    }
}
/** 같은 5K 의 도엽은 같은 보조 워커로(캐시가 한 곳에 모이게) */
const helperIndexOf = (id5k: string) => {
    let h = 0
    for (let i = 0; i < id5k.length; i++) h = (h * 31 + id5k.charCodeAt(i)) >>> 0
    return h % HELPER_COUNT
}
const sendHelpers = (msg: BuildRequest) => {
    for (const h of helpers) h.worker.postMessage(msg)
}

// ---- 상태 ----
let cfg: { origin: [number, number]; style: TileStyle; maxBytes: number } | null = null
/** 지금 선택: 도엽 id 집합과 이웃까지 포함한 조회 결과(선택 도엽의 이웃을 여기서 찾는다) */
let selection: { ids: Set<string>; query: Query } | null = null
/** 로드된 도엽: id → 도엽 정보·밖 도엽인지·중심(5179) */
const loaded = new Map<string, { tile: QueryTile; extra: boolean; center: [number, number] }>()
/** 만들 차례(선택 도엽 또는 스타일 재생성). 앞에서부터. helper 는 맡을 보조 워커 */
let pending: { tile: QueryTile; extra: boolean; helper: number }[] = []
let pendingTotal = 0
let pendingDone = 0
let walk: { center: [number, number]; radius: number; maxTiles: number } | null = null
/** select 마다 1 오른다. 늦게 끝난 이전 선택의 작업은 버린다 */
let generation = 0
let running = false

/**
 * 도엽 하나를 보조 워커에 맡겨 만든다. 이웃(3×3)과 그 5K 경로를 조회 결과에서 골라 같이 보낸다
 *
 * @param t 만들 도엽
 * @param q 이웃을 찾을 조회 결과(도엽 주변 여유를 포함한 것)
 * @param extra 선택 범위 밖(걸어 보기) 도엽인지
 */
const buildTile = (t: QueryTile, q: Query, extra: boolean): Promise<TileData> => {
    const c = cfg!
    ensureHelpers()
    const expanded: Extent = [t.bbox[0] - 1, t.bbox[1] - 1, t.bbox[2] + 1, t.bbox[3] + 1]
    const neighbors = q.tiles.filter((n) => extentsOverlap(n.bbox, expanded))
    const ids5k = new Set(neighbors.map((n) => n.id5k))
    const sheets = q.sheets.filter((s) => ids5k.has(s.id5k)).map((s) => ({ id5k: s.id5k, path: s.path }))
    const jobId = nextJobId++
    const helper = helpers[helperIndexOf(t.id5k)]
    return new Promise<TileData>((resolve, reject) => {
        jobs.set(jobId, { resolve, reject })
        helper.worker.postMessage({ type: "build", jobId, tile: t, neighbors, sheets, origin: c.origin, style: c.style, maxBytes: c.maxBytes, extra } satisfies BuildRequest)
    })
}

/** 도엽 데이터를 메인으로 보낸다(버퍼 transfer) */
const postTile = (data: TileData) => {
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
    if (data.buildingTable) {
        const t = data.buildingTable
        for (const a of [t.ids, t.heights, t.floors, t.floorsUnder, t.useCd, t.structCd, t.flags, t.pointStart, t.xy, t.holeStart, t.holeLen, t.vertexBase, t.faceBase, t.baseZ, t.builtHeight, t.nameSrc]) {
            set.add(a.buffer as ArrayBuffer)
        }
    }
    post({ type: "tile", tile: data }, [...set])
}

/**
 * 큐(선택·재생성)를 보조 워커마다 하나씩 동시에 처리한다. 보조 워커 i 는 자기 몫(같은 5K)의 도엽을 앞에서부터 차례로 만든다.
 * 먼저 끝나는 도엽부터 메인에 보내므로 전체 순서는 대략 중심에서 바깥으로
 */
const drainPending = async (gen: number) => {
    const sel = selection!
    const loop = async (helper: number) => {
        for (;;) {
            if (gen !== generation) return
            const i = pending.findIndex((p) => p.helper === helper)
            if (i < 0) return
            const [next] = pending.splice(i, 1)
            const data = await buildTile(next.tile, sel.query, next.extra)
            if (gen !== generation) return
            loaded.set(data.id, { tile: next.tile, extra: next.extra, center: centroid(next.tile.corners) })
            postTile(data)
            pendingDone++
            post({ type: "progress", phase: "build", done: pendingDone, total: pendingTotal })
        }
    }
    ensureHelpers()
    await Promise.all(helpers.map((h) => loop(h.index)))
}

/** 큐를 비우고, 걸어 보기 중이면 밖 도엽을 넣고 뺀다. 이미 돌고 있으면 그 루프가 새 상태를 본다 */
const run = async () => {
    if (running) return
    running = true
    try {
        for (;;) {
            const gen = generation
            if (!cfg || !selection) break
            if (pending.length > 0) {
                await drainPending(gen)
                if (gen !== generation) continue
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
            const data = await buildTile(candidate.t, q, true)
            if (gen !== generation) break
            loaded.set(data.id, { tile: candidate.t, extra: true, center: centroid(candidate.t.corners) })
            postTile(data)
        }
    } catch (err) {
        post({ type: "error", message: err instanceof Error ? err.message : String(err) })
    } finally {
        running = false
    }
}

/** 선택: 도엽 목록·원점 → 보조 워커 캐시 비우기 → 중심에서 가까운 순으로 큐에 넣기(5K 파일은 보조 워커가 필요할 때 받는다) */
const select = async (msg: Extract<TerrainTilesRequest, { type: "select" }>) => {
    const gen = ++generation
    loaded.clear()
    pending = []
    walk = null
    fetchedPaths.clear()
    downloadTotal = 0
    ensureHelpers()
    sendHelpers({ type: "reset" })
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
    downloadTotal = qAll.sheets.length
    post({ type: "progress", phase: "download", done: 0, total: downloadTotal })
    // 중심에서 가까운 순(나선): 선택 도엽 전체의 중심 기준
    const center = centroid(qSel.tiles.flatMap((t) => t.corners))
    pending = qSel.tiles
        .map((t) => ({ t, d: dist(center, centroid(t.corners)) }))
        .sort((a, b) => a.d - b.d)
        .map((x) => ({ tile: x.t, extra: false, helper: helperIndexOf(x.t.id5k) }))
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
            for (const [id, info] of loaded) if (!queued.has(id)) pending.push({ tile: info.tile, extra: info.extra, helper: helperIndexOf(info.tile.id5k) })
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
