import { Buildings5k, buildingsInTile, fetchBuildings5k, loadBuildingCodes } from "./buildingsData"
import { buildBuildingsMesh } from "./buildingsMesh"
import { createTerrainSampler } from "./terrainSampler"
import { BuildingTable, buildingTableBuffers, cloneBuildingTable } from "./buildingTable"
import type { DataLayerId, TileLayerSheets } from "./layerSheets"
import { createLruCache, createPinnedLruCache, PinnedStats } from "./lruCache"
import { computeVertexNormals, NORMAL_SMOOTH_ITERATIONS, positionsBounds, smoothVertexNormals } from "./meshNormals"
import { fetchRoads5k, loadRoadCodes, Roads5k, roadsInTile } from "./roadsData"
import { buildRoadsMesh, ROAD_LIFT_M, roadDisplayChunks, RoadMesh } from "./roadsMesh"
import { cloneRoadTable, ROAD_LINE_FLAG, RoadTable, roadTableBuffers } from "./roadTable"
import { ClippedMesh, clipMeshToConvexPolygon } from "./terrainClip"
import { CacheTable, cacheTableLine, dataCacheTable, fetchGunzip, heapBytes, MeshChunk, sheetsOf, sortCacheTable, TinMesh, XyBounds } from "./terrainData"
import { emptyLiftFixStats } from "./terrainDrape"
import { TTP_BASE } from "./terrainIndex"
import { mergeTtpTilesForTile, parseTtp, TtpTile } from "./terrainPslg"
import { buildSteppedMeshChunks, emptyStepMergeStats } from "./terrainSteps"
import type { QueryTile, TileData, TileStyle } from "./terrainTiles.worker"
import { fetchWater5k, loadWaterCodes, Water5k, waterOfTile } from "./waterData"
import { buildWaterMesh, WATER_LIFT_M, waterDisplayChunks, WaterMesh } from "./waterMesh"
import { cloneWaterTable, WaterTable, waterTableBuffers } from "./waterTable"
import { fetchForest5k, Forest5k, forestInTile, loadForestCodes } from "./forestData"
import { buildForestMask, ForestMask, forestResOf } from "./forestMask"
import { cloneForestTable, ForestTable, forestTableBuffers } from "./forestTable"

/**
 * 도엽 생성 보조 Worker(계획 문서 7절 L5-B, 2026-10-14). 조정자(terrainTiles.worker.ts)가 도엽 하나를 만들라고 보내면
 * 이웃과 합쳐 삼각분할 → 도엽 폴리곤으로 자르기 → 스타일대로 조각 → 건물 을 해서 돌려준다. 조정자가 보조 워커를 2 ~ 3개 띄워
 * 같은 5K 의 도엽은 같은 보조 워커에 보내므로(5K 파일·자른 TIN·건물 캐시가 한 곳에 모인다) 캐시는 여기 둔다.
 *
 * - 5K 파일(ttp)은 필요할 때 받아 path 로 캐시한다(받을 때마다 fetched 를 알려 조정자가 진행률을 센다. 다른 보조 워커가 같은
 *   파일을 받으면 브라우저 HTTP 캐시가 중복 전송을 막는다)
 * - 자른 TIN(+매끈한 면 법선)은 도엽별로 캐시해 표현 방식·층 간격 전환 때 삼각분할을 건너뛴다(C4: 키에 공통 원점. D6 (b): 선택 도엽은 상한 없음,
 *   선택 밖 도엽은 TIN_CACHE_MAX(64)개)
 * - 레이어(캐시 통일 C2, 2026-10-23): 조정자가 일감에 실은 레이어별 5K 목록(job.layers, 도엽 3857 bbox 에 걸치는 5K)의 파일을 데이터 층
 *   (각 *Data.ts 의 fetchX5k. 파일 원점, 레이어마다 5K 32개 LRU(D1-b), reset 에도 남음)에서 꺼내 도엽마다 합친다(xInTile). 공통 원점 사본은 도엽에
 *   필요한 것만 만든다. 건물은 파일 원점 좌표 합을 미리 계산해 두어 무게중심 판정에 좌표를 옮기지 않는다(L5-A 의 뜻을 유지)
 * - 레이어는 등록해서 만든다(C3, registerLayer·LAYERS): 레이어마다 다른 것(키·받기·만들기·복제·화면 조각·로그)만 주고, 결과 캐시(레이어마다 선택
 *   도엽은 상한 없는 고정 칸·밖 도엽은 64개 LRU(D6 (b)), 키에 공통 원점)·복제·저장·실패 경고·시간은 한 곳이 맡는다. 새 레이어를 더할 때 손댈 곳(C3 검토 L2): LAYERS 에 spec 하나
 *   (clone 은 typed array 를 모두 slice. 결과 캐시가 transfer 로 비워지지 않게. bytes 는 같은 배열을 센다) · LayerFields·TileData 의 필드
 *   (`fields = {} as LayerFields` 라 output 이 빠뜨려도 타입이 잡지 못한다) · 아래 transferablesOf 와 조정자 postTile 의 transfer 목록 ·
 *   DataLayerId·layerSheets.ts(조정자가 실을 5K 목록) · 하네스 tile-golden.mjs 의 parseLayerMs·digest. 메모리 보고·로그는 캐시 표라 따로 손댈 것 없다
 * - reset 은 select 때 원점에 묶인 캐시(TIN·레이어 결과)를 비운다. 파일 원점인 지형 파일(ttp)·레이어 데이터 층은 남긴다(D4)
 */
export type BuildJob = {
    type: "build"
    jobId: number
    tile: QueryTile
    /** 이 도엽의 이웃 두 겹(5×5, 자신 포함) */
    neighbors: QueryTile[]
    /** 이웃이 든 5K 파일 경로 */
    sheets: { id5k: string; path: string }[]
    /** 레이어마다 이 도엽이 쓸 5K(조정자가 layerSheets.ts 로 정한다. C2) */
    layers: TileLayerSheets
    origin: [number, number]
    style: TileStyle
    maxBytes: number
    extra: boolean
}
export type BuildRequest =
    | BuildJob
    | { type: "reset" }
    /** 캐시 메모리 보고(디버그 페이지 memory(), 계획서 19절). 조정자가 port 로 받는다 */
    | { type: "memory"; port: MessagePort }
export type BuildResponse =
    | { type: "built"; jobId: number; data: TileData }
    | { type: "failed"; jobId: number; message: string }
    /** 5K 파일을 실제로 내려받았을 때(진행률용) */
    | { type: "fetched"; path: string }

/**
 * 자른 TIN 캐시에서 **선택 밖 도엽**(둘러보기 스트리밍)의 상한(도엽 수. 계획서 D2 (b): 바이트 256 MB 에서 결과 층과 같은 개수 64 로).
 * 넘으면 오래 안 쓴 밖 도엽부터 버린다. 선택 도엽은 상한 없이 고정 칸에 둔다(D6 (b), createPinnedLruCache)
 */
const TIN_CACHE_MAX = 64
/** 5K 지형 파일(ttp) 캐시 상한(개. 계획서 D1-c 지금 값 유지) */
const TTP_CACHE_MAX = 64
/**
 * 이웃 합치기의 경계 띠 폭(m, L5-C 2026-10-15). 도엽 하나를 만들 때 이웃 5×5 전체 대신 도엽 범위를 이만큼 넓힌 범위 안의 점만 합쳐
 * 삼각분할하고, 외접원이 띠 밖으로 나가는 쪽만 넓혀 다시 한다(terrainPslg.ts mergeTtpTilesForTile. 결과는 전체 합침과 같다).
 * 폭은 scripts/tileBandCheck.ts 로 50·100·200 m 를 재어 정했다. style.band 가 있으면 그 값(0 = 이웃 전체, 옛 동작. 디버그 페이지 band=)
 */
const NEIGHBOR_BAND_M = 100

const post = (msg: BuildResponse, transfer: Transferable[] = []) => self.postMessage(msg, { transfer })

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

// ---- 지형 캐시(캐시 통일 C4, 2026-10-23. 계획서 3.4) ----
type TtpFile = ReturnType<typeof parseTtp>
/**
 * 5K 지형 파일 캐시: path → 파싱 결과(LruCache, TTP_CACHE_MAX). 파일 원점이라 공통 원점과 무관해 레이어 데이터 층처럼 select 의 reset 에도
 * 남긴다(D4 를 지형 파일에도 적용). 바이트는 파싱 결과가 gunzip 한 버퍼의 view 라 그 버퍼 크기
 */
const ttpCache = createLruCache<string, Promise<TtpFile>>({ max: TTP_CACHE_MAX, bytesOf: (f) => f.tiles[0]?.lineXY.buffer.byteLength ?? 0 })
/**
 * 5K 지형 파일. 쓸 때마다(남아 있던 파일도) fetched 를 알린다(V6 검토 L1): 조정자는 select 마다 받은 경로를 비우고 같은 경로를 한 번만 세므로,
 * 파일을 reset 에 남긴 뒤에도 상태 표시줄 "지형 받는 중 k/N" 이 C4 전처럼 새 선택의 5K 수까지 찬다
 */
const fetchTtpCached = (path: string) => {
    const p = ttpCache.getOrLoad(path, () => fetchGunzip(`${TTP_BASE}/${path}`).then(parseTtp))
    void p.then(
        () => post({ type: "fetched", path }),
        () => {},
    )
    return p
}

type CachedTin = { positions: Float32Array; indices: Uint32Array; normals?: Float32Array }
/**
 * 도엽별 자른 TIN(+ 매끈한 면 법선) 캐시: `${도엽 id}|${공통 원점}` → 사본. 메인으로 transfer 하는 버퍼와 별개.
 * 선택 도엽(job.extra false)은 고정 칸(상한 없음), 밖 도엽은 LRU(TIN_CACHE_MAX)(D6 (b)). 원점에 묶여 reset 에 둘 다 비운다
 * (키에 원점이 있어 reset 직전 일감이 늦게 끝나도 새 선택에 섞이지 않는다).
 * 적중 수는 get 이 센다: 법선이 필요한데 법선 없는 항목이면(smoothNormals 끔 계단형 → tin 전환) 적중으로 세고도 다시 만든다(드묾. V6 검토 정보)
 */
const tinCache = createPinnedLruCache<string, CachedTin>({
    max: TIN_CACHE_MAX,
    bytesOf: (t) => t.positions.byteLength + t.indices.byteLength + (t.normals?.byteLength ?? 0),
})

/** 메모리 측정(2026-10-15): 이 워커가 만든 도엽 수. 캐시 바이트는 각 LruCache 가 넣을 때(Promise 는 끝났을 때) 잰 값의 합(C5 캐시 표) */
let builtCount = 0

// ---- 레이어 등록(캐시 통일 C3, 2026-10-23. 계획서 3.3) ----

/**
 * 결과 층에서 **선택 밖 도엽**의 상한: 레이어마다 도엽 결과 수(보조 워커 하나당. 계획서 D1-a, 지금 쓰는 도엽 약 42 × 1.5).
 * 선택 도엽은 상한 없이 고정 칸에 둔다(D6 (b) 2026-10-23: 큰 선택의 표현 방식 전환이 상한을 순서대로 훑어 모두 다시 만들던 것을 막음)
 */
const RESULT_CACHE_MAX = 64

/** 레이어가 TileData 에 채우는 필드 */
type LayerFields = Pick<
    TileData,
    | "buildings"
    | "buildingTable"
    | "built"
    | "roads"
    | "roadChunks"
    | "roadTable"
    | "roadStats"
    | "water"
    | "waterChunks"
    | "waterTable"
    | "waterStats"
    | "forestMask"
    | "forestTable"
    | "forestSkipped"
>
/** 레이어를 만들 때 도엽에서 넘겨받는 것 */
type LayerCtx = {
    job: BuildJob
    t: QueryTile
    style: TileStyle
    origin: [number, number]
    /** 도엽 폴리곤(원점 기준 m)과 그 범위 */
    poly: [number, number][]
    bbox: XyBounds
    /** 범위가 도엽 폴리곤의 범위에 닿는지(도로 조각·면 밖 선, 산림 폴리곤. forestMask 의 거르기와 같은 식) */
    touches: (b: XyBounds) => boolean
    /** 이웃을 합친 메쉬와 그 부드러운 법선(필요할 때 한 번만 만든다) */
    mergedMesh: () => TinMesh
    mergedNormals: () => Float32Array
    maxBytes: number
    /** 계단형에도 매끈한 법선을 싣는지(style.smoothNormals) */
    smoothStepped: boolean
}
/**
 * 레이어마다 다른 것(계획서 3.3 LayerBuilder). 캐시 조회·복제·저장·바이트·실패 경고·시간은 registerLayer 의 run 이 맡는다.
 * R = 결과 캐시에 두는 것(공통 원점, 표현 방식과 무관), L = load 가 데이터 층에서 꺼낸 것
 */
type LayerSpec<R, L> = {
    id: DataLayerId
    /** 실패 경고에 쓰는 이름("도엽 X 건물 실패:") */
    label: string
    /** false 면 받지도 만들지도 않는다(forest=0). 없으면 늘 켬 */
    enabled?: (style: TileStyle) => boolean
    /** 결과 캐시 키: 도엽 id + 결과에 영향을 주는 스위치 + 공통 원점(새 선택의 다른 원점 결과가 섞이지 않게) */
    key: (c: LayerCtx) => string
    empty: () => R
    /**
     * 코드표와 도엽이 걸치는 5K 의 데이터 층 항목(job.layers). 던질 수 있는 일(sheetsOf: 조정자가 인덱스를 못 읽은 레이어)을 먼저 하고 받기를 시작한다.
     * 받기를 먼저 시작하고 던지면 그 Promise 를 아무도 기다리지 않아, 받기도 실패할 때 "Uncaught (in promise)" 가 따로 찍힌다(C2 검토 L1)
     */
    load: (c: LayerCtx) => Promise<L>
    /** 결과와 로그용 메모(지형 밖 수·칠하기 시간 등) */
    build: (c: LayerCtx, loaded: L) => { result: R; note: string }
    /** 결과 캐시에 넣을 때와 꺼낼 때의 사본(메인으로 transfer 하는 버퍼와 별개) */
    clone: (r: R) => R
    /** 결과의 typed array 바이트(메모리 보고) */
    bytes: (r: R) => number
    /** 표현 방식마다 다시 만드는 화면 조각(도로·물). 없으면 []. 로그 메모가 있으면 { chunks, note }(도로 판 합치기) */
    display?: (r: R, c: LayerCtx) => MeshChunk[] | { chunks: MeshChunk[]; note: string }
    output: (r: R, chunks: MeshChunk[]) => Partial<LayerFields>
    /** 도엽 로그 한 줄의 이 레이어 조각. ms 는 받기(wait)를 뺀 시간(화면 조각 포함). 형식은 하네스 parseLayerMs·perf-check cacheFlags 가 읽는다 */
    log: (r: R, s: { cached: boolean; note: string; wait: number; ms: number; displayNote: string }) => string
}
/** 등록된 레이어(결과 캐시를 쥐고 도엽마다 run) */
type RegisteredLayer = {
    id: DataLayerId
    run: (c: LayerCtx) => Promise<{ fields: Partial<LayerFields>; log: string }>
    stats: () => PinnedStats
    clear: () => void
}
/**
 * 레이어 하나를 등록한다. run 은 결과 캐시를 보고(적중이면 사본) 없으면 load → build 하고 사본을 넣는다. 화면 조각까지 실패하면 경고하고
 * 그때까지의 결과를 쓴다(C3 전 레이어 블록의 try 와 같은 범위). 결과 캐시는 레이어마다 고정 칸(선택 도엽, 상한 없음) + LRU(밖 도엽,
 * RESULT_CACHE_MAX)(D6 (b)), select 의 reset 에 둘 다 비운다
 */
const registerLayer = <R, L>(spec: LayerSpec<R, L>): RegisteredLayer => {
    /** 결과와 넣을 때 잰 바이트. 꺼낼 때 바이트가 다르면 사본이 아닌 버퍼가 transfer 로 비워진 것(clone 의 slice 누락)으로 보고 다시 만든다 */
    const cache = createPinnedLruCache<string, { r: R; bytes: number }>({ max: RESULT_CACHE_MAX, bytesOf: (v) => v.bytes })
    let warnedDetached = false
    return {
        id: spec.id,
        stats: () => cache.stats(),
        clear: () => cache.clear(),
        run: async (c) => {
            const start = performance.now()
            let result = spec.empty()
            let chunks: MeshChunk[] = []
            let cached = false
            let note = ""
            let displayNote = ""
            /** 코드표·데이터 층을 기다린 시간(ms. 처음 받는 5K 는 네트워크가 대부분) */
            let wait = 0
            if (spec.enabled?.(c.style) !== false) {
                try {
                    const key = spec.key(c)
                    let hit = cache.get(key)
                    if (hit && spec.bytes(hit.r) !== hit.bytes) {
                        // 사본 규율이 깨진 경우(C3 검토 L1): 빈 버퍼를 내보내지 않고 놓침으로 다시 만든다. 정상 동작에서는 생기지 않는다
                        if (!warnedDetached) console.warn(`${spec.label} 결과 캐시 항목의 버퍼가 비었음(clone 의 사본 누락?). 다시 만든다`)
                        warnedDetached = true
                        cache.delete(key)
                        hit = undefined
                    }
                    if (hit) {
                        result = spec.clone(hit.r)
                        cached = true
                        note = "(캐시)"
                    } else {
                        const loaded = await spec.load(c)
                        wait = performance.now() - start
                        const built = spec.build(c, loaded)
                        result = built.result
                        note = built.note
                        const copy = spec.clone(result)
                        // 선택 도엽은 고정 칸, 선택 밖(둘러보기) 도엽은 LRU(D6 (b))
                        cache.set(key, { r: copy, bytes: spec.bytes(copy) }, !c.job.extra)
                    }
                    if (spec.display) {
                        const d = spec.display(result, c)
                        if (Array.isArray(d)) chunks = d
                        else ({ chunks, note: displayNote } = d)
                    }
                } catch (err) {
                    console.warn(`도엽 ${c.t.name} ${spec.label} 실패:`, err)
                }
            }
            const ms = performance.now() - start - wait
            return { fields: spec.output(result, chunks), log: spec.log(result, { cached, note, wait, ms, displayNote }) }
        },
    }
}

const sumBytes = (...xs: ({ byteLength: number } | null | undefined)[]) => xs.reduce((s: number, x) => s + (x?.byteLength ?? 0), 0)
const tableBytes = (bufs: ArrayBuffer[] | null) => bufs?.reduce((s, b) => s + b.byteLength, 0) ?? 0
const fetched = (wait: number) => (wait > 50 ? `받기 ${Math.round(wait)}ms + ` : "")

type BuildingsResult = { buildings: TinMesh | null; buildingTable: BuildingTable | null; built: number }
type RoadsResult = { roads: RoadMesh | null; roadTable: RoadTable | null; stats: TileData["roadStats"] }
type WaterResult = { water: WaterMesh | null; waterTable: WaterTable | null; stats: TileData["waterStats"] }
type ForestResult = { mask: ForestMask | null; table: ForestTable | null; skipped: number }

/** 등록된 레이어(이 순서로 만든다. 로그 조각도 이 순서) */
const LAYERS: RegisteredLayer[] = [
    // 건물: 걸치는 5K 들에서 무게중심이 이 도엽 안인 것만(bbox 로 먼저 거른 뒤 폴리곤). 바닥 높이는 이웃까지 합친 메쉬로. 표현 방식과 무관
    registerLayer<BuildingsResult, [Awaited<ReturnType<typeof loadBuildingCodes>>, Buildings5k[]]>({
        id: "buildings",
        label: "건물",
        key: (c) => `${c.t.map_id}|${c.origin}`,
        empty: () => ({ buildings: null, buildingTable: null, built: 0 }),
        load: (c) => {
            const sheets = sheetsOf(c.job.layers.buildings)
            return Promise.all([loadBuildingCodes(), Promise.all(sheets.map(fetchBuildings5k))])
        },
        build: (c, [codes, entries]) => {
            const { x0, y0, x1, y1 } = c.bbox
            const inside = buildingsInTile(entries, c.origin, (cx, cy) => !(cx < x0 || cx > x1 || cy < y0 || cy > y1) && pointInPolygon(cx, cy, c.poly))
            if (inside.length === 0) return { result: { buildings: null, buildingTable: null, built: 0 }, note: "" }
            const r = buildBuildingsMesh(inside, c.mergedMesh(), codes)
            return { result: { buildings: r.mesh, buildingTable: r.table, built: r.built }, note: "" }
        },
        clone: (r) => ({
            buildings: r.buildings && { ...r.buildings, positions: r.buildings.positions.slice(), indices: r.buildings.indices.slice() },
            buildingTable: r.buildingTable && cloneBuildingTable(r.buildingTable),
            built: r.built,
        }),
        bytes: (r) => sumBytes(r.buildings?.positions, r.buildings?.indices) + tableBytes(r.buildingTable && buildingTableBuffers(r.buildingTable)),
        output: (r) => ({ buildings: r.buildings, buildingTable: r.buildingTable, built: r.built }),
        // 건물은 받기를 따로 적지 않고 받기까지 넣은 시간(C3 전과 같은 형식)
        log: (r, s) => `건물 ${r.built}${s.cached ? "(캐시)" : ""} ${Math.round(s.wait + s.ms)}ms`,
    }),
    // 도로: 걸치는 5K 들에서 도엽 범위에 닿는 조각만(선은 교량 보간·띠용으로 전부 넘긴다). 높이는 이웃까지 합친 메쉬로(roadsMesh A + B).
    // 얹은 메쉬는 표현 방식과 무관해 캐시하고(키에 얹기 스위치 clip·bridge), 화면 조각(띄움·계단화)은 표현 방식마다 만든다
    registerLayer<RoadsResult, [Awaited<ReturnType<typeof loadRoadCodes>>, Roads5k[]]>({
        id: "roads",
        label: "도로",
        key: (c) => {
            const s = c.style.roads ?? {}
            return `${c.t.map_id}|${s.clip !== false}|${s.bridge !== false}|${c.origin}`
        },
        empty: () => ({ roads: null, roadTable: null, stats: { built: 0, bridges: 0, hidden: 0 } }),
        load: (c) => {
            const sheets = sheetsOf(c.job.layers.roads)
            return Promise.all([loadRoadCodes(), Promise.all(sheets.map(fetchRoads5k))])
        },
        build: (c, [codes, entries]) => {
            const s = c.style.roads ?? {}
            // 도엽 범위에 걸치는 조각·면 밖 선을 모두 넘기고 roadsMesh 가 도엽 폴리곤으로 자른다(지형처럼. 2026-10-19 지적 by @nanangqq: 무게중심
            // 기준이면 경계 조각이 도엽 밖으로 길게 튀어나갔다). 경계에 걸친 조각은 양쪽 도엽이 각자 자기 부분만 얹는다. 교량 보간용 선은 전부
            const { faces: inside, lines: linesHere } = roadsInTile(
                entries,
                c.origin,
                (_f, b) => c.touches(b),
                (l, b) => !(l.flags & ROAD_LINE_FLAG.outsideFace) || c.touches(b),
            )
            if (!(inside.length > 0 || linesHere.some((l) => l.flags & ROAD_LINE_FLAG.outsideFace))) {
                return { result: { roads: null, roadTable: null, stats: { built: 0, bridges: 0, hidden: 0 } }, note: "" }
            }
            const r = buildRoadsMesh(inside, linesHere, c.mergedMesh(), codes, { clip: s.clip, bridge: s.bridge, clipTo: c.poly, terrainNormals: c.mergedNormals() })
            const has = r.mesh.indices.length > 0
            return {
                result: { roads: has ? r.mesh : null, roadTable: has ? r.table : null, stats: { built: r.built, bridges: r.bridges, hidden: r.hidden } },
                note: r.skipped ? `(지형 밖 ${r.skipped})` : "",
            }
        },
        clone: (r) => ({
            roads: r.roads && { ...r.roads, positions: r.roads.positions.slice(), indices: r.roads.indices.slice(), normals: r.roads.normals.slice() },
            roadTable: r.roadTable && cloneRoadTable(r.roadTable),
            stats: r.stats,
        }),
        bytes: (r) => sumBytes(r.roads?.positions, r.roads?.indices, r.roads?.normals) + tableBytes(r.roadTable && roadTableBuffers(r.roadTable)),
        display: (r, c) => {
            if (!r.roads || !r.roadTable) return []
            const lift = c.style.roads?.lift ?? ROAD_LIFT_M
            const zAt = c.style.mode === "stepped" ? (() => { const m = c.mergedMesh(); return createTerrainSampler(m.positions, m.indices) })() : null
            // 띄우기 접힘 수정(R1b, liftfix=0 이면 끔)·판 합치기(R1, stepmerge=0 이면 끔): 화면 조각에서만 하므로 결과 캐시 키와 무관하다(화면 조각은 도엽마다 다시 만든다)
            const merge = c.style.roads?.merge !== false
            const liftFix = c.style.roads?.liftFix !== false
            const stepped = c.style.mode === "stepped"
            const stats = merge && stepped ? emptyStepMergeStats() : undefined
            const fixStats = liftFix && stepped ? emptyLiftFixStats() : undefined
            const chunks = roadDisplayChunks(r.roads, r.roadTable, c.style.mode, c.style.step, lift, c.maxBytes, zAt, c.smoothStepped, merge, stats, liftFix, fixStats)
            // 로그 " 접힘 i회(정점 m 버림 k) ms"(접힘 수정 반복 회·옮긴 정점·버린 판 삼각형) + " 판 합침 합치기 전→뒤 판 삼각형(실패 성분) ms".
            // 하네스 parseLayerMs 가 읽는다(쉼표를 넣지 않는다: 조각 구분자)
            const fixNote = fixStats ? ` 접힘 ${fixStats.iterations}회(정점 ${fixStats.moved} 버림 ${fixStats.droppedCw + fixStats.droppedZero}) ${fixStats.ms.toFixed(1)}ms` : ""
            const mergeNote = stats && stats.plateBefore > 0 ? ` 판 합침 ${stats.plateBefore}→${stats.plateAfter}(실패 ${stats.failed}) ${stats.ms.toFixed(1)}ms` : ""
            return { chunks, note: fixNote + mergeNote }
        },
        // 메인 사본에는 법선을 보내지 않는다(쓰는 곳이 없다: 내보내기는 법선을 안 쓰고, 표현 방식 전환의 화면 조각은 워커 캐시에서 다시 만든다.
        // 2026-10-19 지적 by @nanangqq). 법선은 워커 캐시와 매끈한 면 화면 조각에만
        output: (r, chunks) => ({
            roads: r.roads && { origin: r.roads.origin, positions: r.roads.positions, indices: r.roads.indices },
            roadChunks: chunks,
            roadTable: r.roadTable,
            roadStats: r.stats,
        }),
        log: (r, s) => `도로 ${r.stats.built}(교량 ${r.stats.bridges}, 숨김 ${r.stats.hidden})${s.note} ${fetched(s.wait)}${Math.round(s.ms)}ms${s.displayNote}`,
    }),
    // 물: 걸치는 5K 들의 조각·선을 전부 넘기고 waterMesh 가 도엽 범위에 걸친 것만 얹어 도엽 폴리곤으로 자른다(D2. 폴리곤 안 선분 판정에는 조각 전부가
    // 필요하다). 높이는 이웃까지 합친 메쉬로(A + B, D1 경로). 얹은 메쉬는 캐시하고(키에 얹기 스위치 clip·zMode·lines·폭·분위수) 화면 조각(띄움)은 그때마다
    registerLayer<WaterResult, [Awaited<ReturnType<typeof loadWaterCodes>>, Water5k[]]>({
        id: "water",
        label: "물",
        key: (c) => {
            const w = c.style.water ?? {}
            return `${c.t.map_id}|${w.clip !== false}|${w.zMode ?? "flat"}|${w.lines !== false}|${w.ribbonWidth ?? ""}|${w.levelQuantile ?? ""}|${c.origin}`
        },
        empty: () => ({ water: null, waterTable: null, stats: { built: 0, rivers: 0, lakes: 0, ribbons: 0 } }),
        load: (c) => {
            const sheets = sheetsOf(c.job.layers.water)
            return Promise.all([loadWaterCodes(), Promise.all(sheets.map(fetchWater5k))])
        },
        build: (c, [codes, entries]) => {
            const w = c.style.water ?? {}
            const all = waterOfTile(entries, c.origin)
            if (!(all.pieces.length > 0 || all.lines.length > 0)) {
                return { result: { water: null, waterTable: null, stats: { built: 0, rivers: 0, lakes: 0, ribbons: 0 } }, note: "" }
            }
            const r = buildWaterMesh(all.pieces, all.lines, c.mergedMesh(), codes, all.names, {
                clip: w.clip,
                zMode: w.zMode,
                lines: w.lines,
                ribbonWidth: w.ribbonWidth,
                levelQuantile: w.levelQuantile,
                clipTo: c.poly,
                terrainNormals: c.mergedNormals(),
            })
            const has = r.mesh.indices.length > 0
            return {
                result: { water: has ? r.mesh : null, waterTable: has ? r.table : null, stats: { built: r.built, rivers: r.rivers, lakes: r.lakes, ribbons: r.ribbons } },
                note: r.skipped ? `(지형 밖 ${r.skipped})` : "",
            }
        },
        clone: (r) => ({
            water: r.water && { ...r.water, positions: r.water.positions.slice(), indices: r.water.indices.slice(), normals: r.water.normals.slice() },
            waterTable: r.waterTable && cloneWaterTable(r.waterTable),
            stats: r.stats,
        }),
        bytes: (r) => sumBytes(r.water?.positions, r.water?.indices, r.water?.normals) + tableBytes(r.waterTable && waterTableBuffers(r.waterTable)),
        // 수면은 자체 면이라 표현 방식과 무관하게 같은 조각(계단화 없음)
        display: (r, c) => (r.water && r.waterTable ? waterDisplayChunks(r.water, c.style.water?.lift ?? WATER_LIFT_M) : []),
        output: (r, chunks) => ({
            water: r.water && { origin: r.water.origin, positions: r.water.positions, indices: r.water.indices },
            waterChunks: chunks,
            waterTable: r.waterTable,
            waterStats: r.stats,
        }),
        log: (r, s) => `물 ${r.stats.built}(하천 ${r.stats.rivers}, 호소 ${r.stats.lakes}, 띠 ${r.stats.ribbons})${s.note} ${fetched(s.wait)}${Math.round(s.ms)}ms`,
    }),
    // 산림(안 라): 걸치는 5K 들의 임상도 폴리곤을 이 도엽 bbox 격자에 칠한 마스크. 메쉬를 만들지 않고 지형 셰이더가 색만 바꾼다(지형 표현 방식과 무관.
    // 계단형 판·벽도 같은 마스크를 xy 로 읽는다). 키에 픽셀 크기(forestres=). forest=0 이면 받지도 칠하지도 않는다
    registerLayer<ForestResult, [Awaited<ReturnType<typeof loadForestCodes>>, Forest5k[]]>({
        id: "forest",
        label: "산림",
        enabled: (style) => style.forest?.enabled !== false,
        key: (c) => `${c.t.map_id}|${forestResOf(c.style.forest?.res)}|${c.origin}`,
        empty: () => ({ mask: null, table: null, skipped: 0 }),
        load: (c) => {
            const sheets = sheetsOf(c.job.layers.forest)
            return Promise.all([loadForestCodes(), Promise.all(sheets.map(fetchForest5k))])
        },
        build: (c, [codes, entries]) => {
            // buildForestMask 가 맨 먼저 도엽 범위에 닿는 폴리곤만 남기므로 같은 판정으로 미리 골라 그것만 옮긴다(결과는 전부 넘길 때와 같다)
            const r = buildForestMask(forestInTile(entries, c.origin, c.touches), c.poly, forestResOf(c.style.forest?.res), codes)
            return {
                result: { mask: r.mask, table: r.mask ? r.table : null, skipped: r.skipped },
                note: `${r.mask ? `${r.mask.width}×${r.mask.height}` : "없음"} 칠하기 ${r.ms.toFixed(1)}ms`,
            }
        },
        clone: (r) => ({ mask: r.mask && { ...r.mask, data: r.mask.data.slice() }, table: r.table && cloneForestTable(r.table), skipped: r.skipped }),
        bytes: (r) => sumBytes(r.mask?.data) + tableBytes(r.table && forestTableBuffers(r.table)),
        output: (r) => ({ forestMask: r.mask, forestTable: r.table, forestSkipped: r.skipped }),
        log: (r, s) => `산림 ${r.table?.count ?? 0}${r.skipped ? `(건너뜀 ${r.skipped})` : ""} ${s.note} ${fetched(s.wait)}${Math.round(s.ms)}ms`,
    }),
]

/** select 때 원점에 묶인 캐시(자른 TIN·레이어 결과)를 비운다. 파일 원점인 지형 파일·레이어 데이터 층은 남긴다(D4) */
const reset = () => {
    tinCache.clear()
    for (const layer of LAYERS) layer.clear()
}

/**
 * 캐시 메모리 보고(계획서 3.5, C5 2026-10-23): 이 워커의 모든 LruCache 를 한 표로(caches: `층.레이어` → stats()). 이 워커가 쥐는 것은
 * file.terrain(ttp)·result.terrain(자른 TIN)·result.<레이어>(레이어 결과)와 데이터 모듈의 file.<레이어>(데이터 층)·fixed.<레이어>(코드표).
 * 바이트는 typed array(와 JSON 글자 수)만 센다(항목 객체·구멍 배열·이름 문자열은 빠져 실제 힙은 더 크다). 디버그 페이지 memory() 와 50개마다 찍는 로그가 부른다
 */
const memoryStats = async () => {
    const caches: CacheTable = { "file.terrain": ttpCache.stats(), "result.terrain": tinCache.stats(), ...dataCacheTable() }
    for (const l of LAYERS) caches[`result.${l.id}`] = l.stats()
    return { built: builtCount, heap: heapBytes(), caches: sortCacheTable(caches) }
}
export type HelperMemory = Awaited<ReturnType<typeof memoryStats>>
/** 50개마다 콘솔에(메모리 측정 2026-10-15, C5 에서 캐시 표 한 줄로) */
const logMemory = (m: HelperMemory) => console.log(`메모리(보조 워커 캐시): 만든 도엽 ${m.built}, ${cacheTableLine(m.caches)}`)

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
    // 계단형도 먼 거리 조명용 매끈한 법선을 실을 때는 TIN 법선이 필요하다(terrainSteps normals, 2026-10-22). 설정에서 끄면(smoothNormals false)
    // 매끈한 면만 계산한다(C 이전과 같음. 도로·물 얹기는 mergedNormals 를 따로 부른다)
    const smoothStepped = style.smoothNormals !== false
    const needNormals = style.mode === "tin" || smoothStepped
    const band = style.band ?? NEIGHBOR_BAND_M
    /** 이웃을 합친 메쉬(띠 범위만, 외접원 검사로 넓힘). 캐시가 맞으면 만들지 않는다(건물 바닥 높이에 필요하면 그때 만든다) */
    let merged: TinMesh | null = null
    let mergeNote = ""
    const mergedMesh = () => {
        if (!merged) {
            const r = mergeTtpTilesForTile(ttpTiles, origin, poly, band)
            merged = r.mesh
            mergeNote = band > 0 ? `띠 ${r.sides.map((s) => (s === Infinity ? "∞" : s)).join("/")}m ${r.attempts}회` : "전체"
        }
        return merged
    }
    /** 합친 메쉬의 부드러운 정점 법선(매끈한 면의 자른 TIN 과 도로 정점 법선이 같이 쓴다). 필요할 때 한 번만 */
    let mergedNormalsCache: Float32Array | null = null
    const mergedNormals = () => {
        if (!mergedNormalsCache) {
            const m = mergedMesh()
            mergedNormalsCache = smoothVertexNormals(computeVertexNormals(m.positions, m.indices), m.indices, NORMAL_SMOOTH_ITERATIONS)
        }
        return mergedNormalsCache
    }
    const tinKey = `${t.map_id}|${origin}`
    const cachedTin = tinCache.get(tinKey)
    let tin: ClippedMesh
    let fromCache = false
    if (cachedTin && (!needNormals || cachedTin.normals)) {
        tin = { origin, positions: cachedTin.positions.slice(), indices: cachedTin.indices.slice(), normals: cachedTin.normals?.slice() }
        fromCache = true
    } else {
        // 매끈한 면: 법선은 이웃을 합친 메쉬에서 계산한 뒤 자를 때 같이 실어 경계 정점도 이웃 삼각형을 본 법선을 갖는다
        const m = mergedMesh()
        tin = clipMeshToConvexPolygon(m, poly, needNormals ? mergedNormals() : undefined)
        tinCache.set(tinKey, { positions: tin.positions.slice(), indices: tin.indices.slice(), normals: tin.normals?.slice() }, !extra)
    }
    const t1 = performance.now()
    let terrain: MeshChunk[]
    if (style.mode === "stepped" && style.step > 0) {
        terrain = [...buildSteppedMeshChunks(tin, style.step, maxBytes, undefined, { normals: smoothStepped ? tin.normals : undefined })]
    } else {
        terrain = [{ positions: tin.positions, indices: tin.indices, normals: tin.normals! }]
    }
    const t2 = performance.now()

    // 레이어(등록 순서대로. 결과 캐시·실패 경고·시간은 registerLayer 가 맡는다)
    const bbox: XyBounds = {
        x0: Math.min(...poly.map((p) => p[0])),
        y0: Math.min(...poly.map((p) => p[1])),
        x1: Math.max(...poly.map((p) => p[0])),
        y1: Math.max(...poly.map((p) => p[1])),
    }
    const ctx: LayerCtx = {
        job,
        t,
        style,
        origin,
        poly,
        bbox,
        touches: (b) => b.x1 >= bbox.x0 && b.x0 <= bbox.x1 && b.y1 >= bbox.y0 && b.y0 <= bbox.y1,
        mergedMesh,
        mergedNormals,
        maxBytes,
        smoothStepped,
    }
    const fields = {} as LayerFields
    const layerLogs: string[] = []
    for (const layer of LAYERS) {
        const r = await layer.run(ctx)
        Object.assign(fields, r.fields)
        layerLogs.push(r.log)
    }
    console.log(
        `도엽 ${t.name}${extra ? "(밖)" : ""}: ${fromCache ? "캐시" : `이웃 ${ttpTiles.length}개 ${mergeNote} 합침`} ${Math.round(t1 - t0)}ms, ${style.mode} ${Math.round(t2 - t1)}ms, 삼각형 ${tin.indices.length / 3}, ${layerLogs.join(", ")}`,
    )

    builtCount++
    if (builtCount % 50 === 0) void memoryStats().then(logMemory)
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
        // 레이어 필드(등록된 레이어의 output. 메인 사본의 도로·물에는 법선이 없다)
        buildings: fields.buildings,
        buildingTable: fields.buildingTable,
        built: fields.built,
        roads: fields.roads,
        roadChunks: fields.roadChunks,
        roadTable: fields.roadTable,
        roadStats: fields.roadStats,
        water: fields.water,
        waterChunks: fields.waterChunks,
        waterTable: fields.waterTable,
        waterStats: fields.waterStats,
        forestMask: fields.forestMask,
        forestTable: fields.forestTable,
        forestSkipped: fields.forestSkipped,
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
    if (data.roads) {
        set.add(data.roads.positions.buffer as ArrayBuffer)
        set.add(data.roads.indices.buffer as ArrayBuffer)
    }
    for (const ch of data.roadChunks) {
        set.add(ch.positions.buffer as ArrayBuffer)
        set.add(ch.indices.buffer as ArrayBuffer)
        if (ch.normals) set.add(ch.normals.buffer as ArrayBuffer)
    }
    if (data.roadTable) for (const b of roadTableBuffers(data.roadTable)) set.add(b)
    if (data.water) {
        set.add(data.water.positions.buffer as ArrayBuffer)
        set.add(data.water.indices.buffer as ArrayBuffer)
    }
    for (const ch of data.waterChunks) {
        set.add(ch.positions.buffer as ArrayBuffer)
        set.add(ch.indices.buffer as ArrayBuffer)
        if (ch.normals) set.add(ch.normals.buffer as ArrayBuffer)
    }
    if (data.waterTable) for (const b of waterTableBuffers(data.waterTable)) set.add(b)
    if (data.forestMask) set.add(data.forestMask.data.buffer as ArrayBuffer)
    if (data.forestTable) for (const b of forestTableBuffers(data.forestTable)) set.add(b)
    return [...set]
}

self.onmessage = async (e: MessageEvent<BuildRequest>) => {
    const msg = e.data
    if (msg.type === "reset") {
        reset()
        return
    }
    if (msg.type === "memory") {
        msg.port.postMessage(await memoryStats())
        return
    }
    try {
        const { data, transfer } = await buildTile(msg)
        post({ type: "built", jobId: msg.jobId, data }, transfer)
    } catch (err) {
        post({ type: "failed", jobId: msg.jobId, message: err instanceof Error ? err.message : String(err) })
    }
}
