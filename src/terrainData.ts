import { Extent } from "ol/extent"

import { createLruCache, LruCache, LruStats } from "./lruCache"

/** 개발 서버(terrainDataDev·주석의 서버 데이터 경로용). 운영 데이터는 R2(terrainIndex.TTP_BASE·buildingsData) */
export const TERRAIN_API = "http://localhost:8000"

// 좌표는 모두 ESRI:102080(≈EPSG:5179) 절대좌표
export type TileInfo = {
    map_id: string
    name: string
    bbox: Extent
    corners: [number, number][]
}

// positions 는 origin 을 뺀 (x, y, z) 연속 배열
export type TinMesh = {
    origin: [number, number]
    positions: Float32Array
    /**
     * 삼각형 정점 인덱스(3개씩). **위에서 볼 때 반시계(CCW)** 가 규약이다(서버 TIN 과 같음).
     * tin 모드의 정점 법선(computeVertexNormals)이 이 방향을 전제로 외적을 구하므로, 삼각형을 새로 만드는 코드는
     * 반드시 이 방향으로 맞춰야 한다(terrainRetri 의 countClockwise 로 검사)
     */
    indices: Uint32Array
    /**
     * 등고선 제약 선분(정점 인덱스 쌍, 2개씩). TTM 의 segments 에서 도엽 외곽 체인을 뺀 것.
     * 재삼각분할(terrainRetri) 때 이 선분을 삼각형 변으로 강제한다. 없으면 재삼각분할하지 않는다
     */
    segments?: Uint32Array
}

/**
 * GPU 버퍼 한도 안에 들어가는 메쉬 조각. 정점은 조각 안에서 0부터 번호를 매긴 것이며,
 * 조각 사이에 같은 정점이 중복될 수 있다. 렌더러는 조각마다 버퍼를 만들어 차례로 그린다.
 */
export type MeshChunk = {
    positions: Float32Array
    indices: Uint32Array
    normals?: Float32Array
}

export const parseTin = (buf: ArrayBuffer): TinMesh => {
    const dv = new DataView(buf)
    const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4))
    if (magic !== "TIN1") throw new Error("TIN 바이너리가 아님")
    const nV = dv.getUint32(4, true)
    const nT = dv.getUint32(8, true)
    return {
        origin: [dv.getFloat64(16, true), dv.getFloat64(24, true)],
        positions: new Float32Array(buf, 32, nV * 3),
        indices: new Uint32Array(buf, 32 + nV * 12, nT * 3),
    }
}

/** 파일 전체가 gzip 인 정적 파일(ttp)을 받아 푼다. 전송 압축은 브라우저가, 파일 gzip 은 여기서 푼다 */
export const fetchGunzip = async (url: string) => {
    const res = await fetch(url)
    if (!res.ok || !res.body) throw new Error(`${res.status} ${url}`)
    const raw = res.body.pipeThrough(new DecompressionStream("gzip"))
    return new Response(raw).arrayBuffer()
}

// ---- 레이어 데이터 층(캐시 통일 C2, 2026-10-23. 계획서 3.2 안 가) ----

/**
 * 도엽 하나가 쓰는 레이어 5K 파일 하나(조정자가 레이어 50K 인덱스에서 골라 BuildJob 에 싣는다. layerSheets.ts).
 * path·names 는 레이어 base 아래 상대 경로(names 는 이름 파일. 없는 레이어·5K 는 비움)
 */
export type Layer5k = { id5k: string; path: string; names?: string }
/** 한 레이어의 5K 목록(조정자 순서 = C2 전 loadX 의 targets 순서), 또는 조정자가 인덱스를 못 읽었을 때 그 메시지 */
export type LayerSheets = Layer5k[] | { error: string }
/** 보조 워커: 일감의 레이어 목록. 없거나 실패면 던져 그 레이어만 실패로 둔다(C2 전 loadX 가 던지던 자리와 같다) */
export const sheetsOf = (s: LayerSheets | undefined): Layer5k[] => {
    if (!s) throw new Error("레이어 5K 목록이 일감에 없음")
    if ("error" in s) throw new Error(s.error)
    return s
}

/**
 * 데이터 층 상한: 레이어마다 5K 파일 수(보조 워커 하나당. 계획서 D1-b 고침 2026-10-23: 처음 값 12(둘러보기 live 5K 8 × 1.5)는 선택 생성에서
 * 경계 도엽이 이웃 5K 를 쓰고 나선 순서가 5K 를 돌아 순환하며 밀려났다. 32 는 보조 워커 셋으로 약 950 도엽까지 다시 받지 않는 하한)
 */
export const LAYER_5K_CACHE_MAX = 32
/** 레이어 → 그 데이터 층. 처음 쓸 때 만든다(조정자처럼 이 층을 안 쓰는 스레드의 보고에 빈 칸이 안 나오게) */
const tierCaches = new Map<string, LruCache<string, Promise<{ bytes: number }>>>()
/**
 * 레이어 데이터 층 하나를 만든다: 5K 파일 경로 → 받아 파싱하고 파일 원점으로 전처리한 항목(LruCache, 상한 LAYER_5K_CACHE_MAX).
 * 원점과 무관하므로 select 의 reset 에도 비우지 않는다(D4). 공통 원점으로 옮긴 사본은 두지 않고 도엽마다 필요한 것만 옮긴다.
 * 캐시 표 키는 `file.${layer}`, 바이트는 항목의 bytes(gunzip 한 파일·이름 파일 + 전처리 배열)
 */
export const dataTier =
    <V extends { bytes: number }>(layer: string) =>
    (path: string, load: () => Promise<V>): Promise<V> => {
        let cache = tierCaches.get(layer)
        if (!cache) tierCaches.set(layer, (cache = createLruCache<string, Promise<{ bytes: number }>>({ max: LAYER_5K_CACHE_MAX, bytesOf: (v) => v.bytes })))
        return cache.getOrLoad(path, load) as Promise<V>
    }

/** 파일 원점 mm 좌표를 공통 원점 기준으로 옮긴 새 배열(dx·dy 는 원점 차 × 1000) */
export const shiftXy = (xy: Int32Array, dx: number, dy: number) => {
    const out = new Int32Array(xy.length)
    for (let i = 0; i < xy.length; i += 2) {
        out[i] = xy[i] + dx
        out[i + 1] = xy[i + 1] + dy
    }
    return out
}
/** 항목마다 파일 mm 좌표의 [minX, minY, maxX, maxY](4개씩. 점이 없으면 ±Infinity) */
export const xyBoundsMm = (items: { xy: Int32Array }[]) => {
    const out = new Float64Array(items.length * 4)
    items.forEach((item, k) => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
        for (let i = 0; i < item.xy.length; i += 2) {
            const x = item.xy[i], y = item.xy[i + 1]
            if (x < x0) x0 = x
            if (x > x1) x1 = x
            if (y < y0) y0 = y
            if (y > y1) y1 = y
        }
        out.set([x0, y0, x1, y1], 4 * k)
    })
    return out
}
/** 공통 원점 m 범위 */
export type XyBounds = { x0: number; y0: number; x1: number; y1: number }
/**
 * xyBoundsMm 의 k 번째를 공통 원점 m 로. C2 전에는 옮긴 정수 mm 를 하나씩 1000 으로 나눈 최소·최대였는데, 정수 원점 차를 더한 정수의 최소를
 * 1000 으로 나눈 것과 같은 double 이다(나눗셈 반올림이 단조라서)
 */
export const boundsAt = (b: Float64Array, k: number, dx: number, dy: number): XyBounds => ({
    x0: (b[4 * k] + dx) / 1000,
    y0: (b[4 * k + 1] + dy) / 1000,
    x1: (b[4 * k + 2] + dx) / 1000,
    y1: (b[4 * k + 3] + dy) / 1000,
})

/**
 * 50K 인덱스 JSON 캐시의 상한(이름공간마다 개. 계획서 D3 고침 2026-10-23: 큰 선택이 50K 최대 9장에 걸침 × 1.5). 위치에 따라 늘어나는 것만
 * 상한을 두고, 이름공간마다 하나로 고정된 codes.json·sheets50k.json 은 상한 없는 칸에 따로 둔다(계획서 2절 "키가 늘어나는지 먼저 가른다")
 */
export const JSON_50K_CACHE_MAX = 14
/** 파싱한 JSON 과 글자 수(메모리 보고의 바이트. 대략) */
type JsonEntry = { json: unknown; chars: number }
/** `fixed.${ns}`·`index.${ns}`(캐시 표 키) → 그 JSON 캐시. 처음 받을 때 만든다(보고에 쓴 칸만 나오게) */
const jsonCaches = new Map<string, LruCache<string, Promise<JsonEntry>>>()

/**
 * 묶음(조정자의 선택 한 번·걸어 보기 갱신 한 번) 동안 인덱스 JSON 을 쥐는 곳(C1 검토 M1, 2026-10-23): URL → 받은 Promise. 묶음 안에서는
 * 이름공간 캐시가 밀어내도 다시 받지 않는다(넓은 선택이 50K 를 상한보다 많이 걸칠 때 도엽마다 다시 받지 않게). 묶음이 끝나면 버린다
 */
export type JsonMemo = Map<string, Promise<unknown>>

/** 캐시 칸 하나에서 URL 의 JSON(memo 를 주면 거기 있는 것을 먼저 쓰고 받은 것을 거기에도 둔다. 실패하면 memo 에서도 지운다) */
const loadJson = <T>(key: string, max: number, url: string, memo?: JsonMemo): Promise<T> => {
    const held = memo?.get(url)
    if (held) return held as Promise<T>
    let cache = jsonCaches.get(key)
    if (!cache) jsonCaches.set(key, (cache = createLruCache<string, Promise<JsonEntry>>({ max, bytesOf: (v) => v.chars })))
    const p = cache
        .getOrLoad(url, async () => {
            const res = await fetch(url)
            if (!res.ok) throw new Error(`${res.status} ${url}`)
            const text = await res.text()
            return { json: JSON.parse(text), chars: text.length }
        })
        .then((v) => v.json as T)
    if (memo) {
        memo.set(url, p)
        p.catch(() => memo.get(url) === p && memo.delete(url))
    }
    return p
}

/**
 * 이름공간 하나의 JSON 받기(C1 2026-10-23: 다섯 모듈에 있던 같은 fetchJsonCached 를 하나로. C2 에서 D3 고침에 따라 칸을 둘로).
 * - fixed: 이름공간마다 하나로 고정된 파일(codes.json·sheets50k.json). 상한 없이 들고 있는다. 캐시 표 키 `fixed.${ns}`
 * - index50k: 50K 인덱스(`index/v1/{50K}.json`). 위치에 따라 늘어나므로 최근 JSON_50K_CACHE_MAX 개. 캐시 표 키 `index.${ns}`
 * 밀려난 JSON 은 다음에 다시 받는다(같은 내용이라 결과는 같다). 실패한 받기는 남지 않는다. 돌려준 객체는 캐시와 같은 것이므로 고치지 않는다
 *
 * @param ns 이름공간 = 캐시 표의 레이어(지형 ttp 인덱스 "terrain", 레이어는 "buildings"·"roads"·"water"·"forest")
 */
export const jsonFetcher = (ns: string) => ({
    fixed: <T>(url: string, memo?: JsonMemo) => loadJson<T>(`fixed.${ns}`, Infinity, url, memo),
    index50k: <T>(url: string, memo?: JsonMemo) => loadJson<T>(`index.${ns}`, JSON_50K_CACHE_MAX, url, memo),
})

/**
 * 캐시 표(캐시 통일 C5, 2026-10-23. 계획서 3.5): 스레드마다 모든 LruCache 를 `층.레이어` → stats()(count·bytes·max·hits·misses·evictions) 한 표로.
 * 층은 fixed(codes.json·sheets50k.json, 상한 없음) · index(50K 인덱스) · file(5K 파일: 지형 ttp·레이어 데이터 층) · result(도엽 결과: 자른 TIN·
 * 레이어 결과), 레이어는 terrain·buildings·roads·water·forest. 디버그 페이지 memory()·보조 워커 50개마다 로그·perf-check 가 읽는다
 */
/** 행: LruCache.stats(). 고정 칸이 있는 캐시(result.*, D6 (b))는 개수·바이트·적중이 합계이고 pinned·pinnedBytes 가 고정 칸(max 는 LRU 쪽) */
export type CacheTable = Record<string, LruStats & { pinned?: number; pinnedBytes?: number }>
const TIERS = ["fixed", "index", "file", "result"]
/** 레이어 이름공간 순서. 녹지는 서버 경로와 같은 이름공간 "osm_green"(LayerId "osmGreen" 과 섞지 않는다. 결과 층의 5K 전처리 행도 result.osm_green) */
const LAYER_ORDER = ["terrain", "buildings", "roads", "water", "forest", "osm_green"]
/** 표를 층 → 레이어 순으로(로그·보고가 늘 같은 순서) */
export const sortCacheTable = (t: CacheTable): CacheTable => {
    const rank = (k: string) => {
        const [tier, layer] = k.split(".")
        return TIERS.indexOf(tier) * 10 + LAYER_ORDER.indexOf(layer)
    }
    return Object.fromEntries(Object.entries(t).sort(([a], [b]) => rank(a) - rank(b)))
}
/** 이 스레드의 데이터 모듈 캐시 행(레이어 데이터 층 `file.<layer>`, 고정 JSON `fixed.<ns>`, 50K 인덱스 `index.<ns>`). 부를 때마다 새 객체 */
export const dataCacheTable = (): CacheTable => {
    const out: CacheTable = {}
    for (const [layer, c] of tierCaches) out[`file.${layer}`] = c.stats()
    for (const [key, c] of jsonCaches) out[key] = c.stats()
    return sortCacheTable(out)
}
/** 캐시 표 한 줄(로그용): `층.레이어 개수/상한 MB(적중·놓침·밀려남)` */
export const cacheTableLine = (t: CacheTable) =>
    Object.entries(t)
        .map(
            ([k, s]) =>
                `${k} ${s.count}/${s.max === Infinity ? "∞" : s.max}${s.pinned ? `(고정 ${s.pinned})` : ""} ${(s.bytes / 1048576).toFixed(1)}MB(${s.hits}·${s.misses}·${s.evictions})`,
        )
        .join(", ")
/** 이 스레드의 JS 힙 사용량(Chrome 전용 performance.memory, 거친 값). 없으면 null */
export const heapBytes = () => (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null

