/**
 * 도엽 출력 동등성 하네스(scripts/tile-golden.mjs)의 메인 스레드 쪽 묶음(docs/cache-refactor-plan.md 6절 V1·C0, 2026-10-23).
 *
 * tile-golden.mjs 가 esbuild 로 이 파일을 Node 용으로 묶어 쓴다. 하는 일은 셋이다.
 * 1. 일감 만들기(sceneJobs): 조정자(src/terrainTiles.worker.ts select·buildTile)와 같은 규칙으로 BuildJob 을 만든다.
 *    선택 bbox → qSel(도엽·원점)·qAll(± 1650 여유) → 가운데에서 가까운 순 → 이웃(neighborReach 와 겹치는 도엽)·5K 경로 →
 *    레이어 5K 목록(C2 2026-10-23: src/layerSheets.ts, 조정자와 같은 함수)
 * 2. 자료 대조(analyzeTile, C0): 도엽 하나에 레이어마다 쓰이는 항목 집합을 (a) 자기 5K 파일만 / (b) 지금 방식(1K bbox 로 ttp 인덱스에서 고른
 *    5K 전부, flags & 1 id 중복 제거) 두 벌로 계산해 비교하고, 다른 항목이 도엽 폴리곤과 실제로 겹치는지(면적·산림은 픽셀 중심)를 가린다.
 *    보조 워커의 거르기 규칙(건물 무게중심, 도로 bbox 닿음·면 밖 선, 물 조각·띠, 산림 bbox 닿음)을 그대로 옮겼다
 * 3. 산림 기준값(forestOracle): 도엽 bbox 에 닿는 산림 폴리곤마다 칠한 픽셀 수(전체·도엽 폴리곤 안). 비교가 허용 차이 2(귀퉁이 행)를 가릴 때 쓴다
 *
 * src 는 고치지 않는다(파서·인덱스 조회·띠 사각형만 가져다 쓴다). fetch 는 tile-golden.mjs 가 로컬 디스크 캐시로 바꿔 둔다.
 */
import type { Extent } from "ol/extent"
import proj4 from "proj4"

import { Building, BUILDINGS_BASE, parseBfp } from "../src/buildingsData"
import { FOREST_BASE, ForestPolygon, parseFrs } from "../src/forestData"
import { parseRds, RoadFace, RoadLine, ROADS_BASE } from "../src/roadsData"
import { DATA_LAYERS, layerSheetsOfTile } from "../src/layerSheets"
import { RIBBON_DEFAULT_WIDTH_M } from "../src/roadsMesh"
import { isElevated, isUnderground, ROAD_LINE_FLAG } from "../src/roadTable"
import { fetchGunzip } from "../src/terrainData"
import { ribbonQuads } from "../src/terrainDrape"
import { getTtpSheetsInBbox, neighborReach } from "../src/terrainIndex"
import type { BuildJob } from "../src/terrainTileBuild.worker"
import type { QueryTile, TileStyle } from "../src/terrainTiles.worker"
import { parseWtr, WATER_BASE, WaterLine, WaterPiece } from "../src/waterData"
import { RIBBON_WIDTH_M } from "../src/waterMesh"
import { RIVER_SE } from "../src/waterTable"

export { getTtpSheetsInBbox, neighborReach }
export { BUILDINGS_BASE, FOREST_BASE, ROADS_BASE, WATER_BASE }

/** 조정자 select 의 이웃 여유(NEIGHBOR_MARGIN 1100 × 1.5) */
const SELECT_MARGIN = 1100 * 1.5
/** 보조 워커의 이웃 합치기 띠 폭(NEIGHBOR_BAND_M). 물 조각이 "지형 bbox 에 걸치는지" 를 자료 수준에서 어림할 때 쓴다 */
const BAND_M = 100

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
const extentsOverlap = (a: Extent, b: Extent) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]
const centroid = (pts: [number, number][]): [number, number] => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length]
const pointInPolygon = (x: number, y: number, poly: [number, number][]) => {
    let inside = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i]
        const [xj, yj] = poly[j]
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
}

/** 도엽 1K 의 3857 bbox(보조 워커가 loadX 에 넘기는 값과 같다: corners → 3857 → 외접) */
export const tileExtent3857 = (corners: [number, number][]) => extentOf(corners.map(to3857))

// ---- 1. 일감 ----

export type ScenePlan = {
    origin: [number, number]
    /** 조정자 순서(가운데에서 가까운 순)의 선택 도엽 */
    tiles: QueryTile[]
    /** 도엽 id → 이웃·5K 경로(BuildJob 에서 jobId·style 을 뺀 것) */
    jobs: Map<string, Omit<BuildJob, "jobId" | "style" | "type">>
}

/**
 * 선택 bbox 하나를 조정자처럼 펼친다(terrainTiles.worker.ts select + buildTile). 원점은 qSel.origin, 이웃은 qAll(± 1650)에서
 * neighborReach 와 겹치는 도엽, sheets 는 그 이웃이 든 5K 의 경로. 순서는 선택 도엽 전체 corners 의 평균에서 가까운 순(정렬이 같으면 인덱스 순)
 *
 * @param bbox3857 선택 범위(EPSG:3857)
 * @param only 이 도엽 id 들만 남긴다(순서는 조정자 순서 그대로). 없으면 전부
 */
export const sceneJobs = async (bbox3857: Extent, only?: string[]): Promise<ScenePlan> => {
    const m = SELECT_MARGIN
    const [qSel, qAll] = await Promise.all([getTtpSheetsInBbox(bbox3857), getTtpSheetsInBbox([bbox3857[0] - m, bbox3857[1] - m, bbox3857[2] + m, bbox3857[3] + m])])
    if (qSel.tiles.length === 0) throw new Error(`선택 범위에 도엽이 없음: ${bbox3857}`)
    const center = centroid(qSel.tiles.flatMap((t) => t.corners))
    const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1])
    let tiles = qSel.tiles
        .map((t) => ({ t, d: dist(center, centroid(t.corners)) }))
        .sort((a, b) => a.d - b.d)
        .map((x) => x.t)
    if (only) {
        const missing = only.filter((id) => !tiles.some((t) => t.map_id === id))
        if (missing.length) throw new Error(`선택 범위에 없는 도엽: ${missing.join(", ")}`)
        tiles = tiles.filter((t) => only.includes(t.map_id))
    }
    const jobs: ScenePlan["jobs"] = new Map()
    for (const t of tiles) {
        const neighbors = qAll.tiles.filter((n) => extentsOverlap(n.bbox, neighborReach(t.bbox)))
        const ids5k = new Set(neighbors.map((n) => n.id5k))
        const sheets = qAll.sheets.filter((s) => ids5k.has(s.id5k)).map((s) => ({ id5k: s.id5k, path: s.path }))
        // 레이어 5K 목록(C2): 조정자 buildTile 과 같은 함수. 산림 끔 설정도 네 레이어를 다 싣는다(보조 워커가 산림을 읽지 않는다)
        const layers = await layerSheetsOfTile(t.corners, DATA_LAYERS)
        jobs.set(t.map_id, { tile: t, neighbors, sheets, layers, origin: qSel.origin, maxBytes: 64 * 1048576, extra: false })
    }
    return { origin: qSel.origin, tiles, jobs }
}

/** 1K 도엽 하나(map_id 앞 5자리 = 50K 의 ttp 인덱스에서) */
export const tileById = async (mapId: string): Promise<QueryTile> => {
    const ix = await fetchJson<{ sheets: { id5k: string; tiles: { map_id: string; name: string; corners: [number, number][] }[] }[] }>(`https://layers.asrbbt.world/ttp/index/v1/${mapId.slice(0, 5)}.json`)
    for (const s of ix.sheets) for (const t of s.tiles) if (t.map_id === mapId) return { map_id: t.map_id, name: t.name, corners: t.corners, bbox: extentOf(t.corners), id5k: s.id5k }
    throw new Error(`ttp 인덱스에 도엽 ${mapId} 없음`)
}
/**
 * 도엽들의 중심(3857)을 잇는 사각형 ± 1. 이것을 선택하면 그 도엽들과 그 사이 도엽만 걸린다(변이 도엽 가운데를 지나므로 바깥 도엽에 닿지 않는다).
 * 장면을 도엽 id 로 적고 선택 범위·원점은 여기서 정한다
 */
export const blockBbox = async (ids: string[]): Promise<Extent> => {
    const cs = (await Promise.all(ids.map(tileById))).map((t) => to3857(centroid(t.corners)))
    const e = extentOf(cs)
    return [e[0] - 1, e[1] - 1, e[2] + 1, e[3] + 1]
}

/** 5K 하나의 1K 25장을 자리(가장자리·모서리·안)와 함께. 원점은 그 5K bbox 를 선택했을 때의 값 */
export const sheetTiles = async (id5k: string) => {
    const bbox = await sheetBbox3857(id5k)
    const q50 = await getTtpSheetsInBbox(bbox)
    const tiles = q50.tiles.filter((t) => t.id5k === id5k)
    if (tiles.length !== 25 || q50.tiles.length !== 25) throw new Error(`5K ${id5k} 선택에 1K ${tiles.length}/${q50.tiles.length}장(25 가 아님)`)
    const e = extentOf(tiles.flatMap((t) => t.corners))
    const w = (e[2] - e[0]) / 5, h = (e[3] - e[1]) / 5
    return {
        bbox,
        origin: q50.origin,
        tiles: tiles.map((t) => {
            const [cx, cy] = centroid(t.corners)
            const col = Math.min(4, Math.floor((cx - e[0]) / w)), row = Math.min(4, Math.floor((cy - e[1]) / h))
            const edge = col === 0 || col === 4 || row === 0 || row === 4
            const corner = (col === 0 || col === 4) && (row === 0 || row === 4)
            return { tile: t, col, row, place: corner ? "corner" : edge ? "edge" : "inner" }
        }),
    }
}
/** 5K 의 bbox_3857(ttp 50K 인덱스). inset 이면 가장자리에서 2 % 안쪽(이웃 5K 의 도엽이 선택에 걸리지 않게) */
const sheetBbox3857 = async (id5k: string, inset = true): Promise<Extent> => {
    const ix = await fetchJson<{ sheets: { id5k: string; bbox_3857: Extent }[] }>(`https://layers.asrbbt.world/ttp/index/v1/${id5k.slice(0, 5)}.json`)
    const s = ix.sheets.find((x) => x.id5k === id5k)
    if (!s) throw new Error(`ttp 인덱스에 5K ${id5k} 없음`)
    if (!inset) return s.bbox_3857
    const [x0, y0, x1, y1] = s.bbox_3857
    const dx = (x1 - x0) * 0.02, dy = (y1 - y0) * 0.02
    return [x0 + dx, y0 + dy, x1 - dx, y1 - dy]
}

// ---- 자료 받기(로컬 캐시 fetch 를 거친다) ----

const jsonCache = new Map<string, Promise<unknown>>()
const fetchJson = <T>(url: string): Promise<T> => {
    let p = jsonCache.get(url)
    if (!p) {
        p = fetch(url).then((r) => {
            if (!r.ok) throw new Error(`${r.status} ${url}`)
            return r.json()
        })
        jsonCache.set(url, p)
    }
    return p as Promise<T>
}
const fileCache = new Map<string, Promise<unknown>>()
const fetchParsed = <T>(url: string, parse: (buf: ArrayBuffer) => T): Promise<T> => {
    let p = fileCache.get(url)
    if (!p) {
        p = fetchGunzip(url).then(parse)
        fileCache.set(url, p)
    }
    return p as Promise<T>
}
/** 메모리 정리(C0 를 많은 5K 에 돌릴 때 5K 묶음마다) */
export const clearDataCache = () => fileCache.clear()

type LayerKey = "buildings" | "roads" | "water" | "forest"
type IndexEntry = { id5k: string; path: string; names_path?: string; n_buildings?: number; n_faces?: number; n_lines?: number; n_pieces?: number; n_poly?: number }
const LAYERS: Record<LayerKey, { base: string; nonEmpty: (e: IndexEntry) => boolean }> = {
    buildings: { base: BUILDINGS_BASE, nonEmpty: (e) => (e.n_buildings ?? 0) > 0 },
    roads: { base: ROADS_BASE, nonEmpty: (e) => (e.n_faces ?? 0) > 0 || (e.n_lines ?? 0) > 0 },
    water: { base: WATER_BASE, nonEmpty: (e) => (e.n_pieces ?? 0) > 0 || (e.n_lines ?? 0) > 0 },
    forest: { base: FOREST_BASE, nonEmpty: (e) => (e.n_poly ?? 0) > 0 },
}
/** 레이어 50K 인덱스에서 5K 항목(loadX 의 targets 와 같은 거르기: 비었으면 null) */
const layerEntry = async (layer: LayerKey, id5k: string): Promise<IndexEntry | null> => {
    const ix = await fetchJson<{ sheets: IndexEntry[] }>(`${LAYERS[layer].base}/index/v1/${id5k.slice(0, 5)}.json`)
    const e = ix.sheets.find((s) => String(s.id5k) === id5k)
    return e && LAYERS[layer].nonEmpty(e) ? e : null
}

// ---- 기하 ----

type Pt = [number, number]
/** 고리(닫는 점 없음)의 부호 있는 면적(반시계 양수) */
const ringArea = (r: Pt[]) => {
    let a = 0
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1])
    return a / 2
}
/** 고리를 볼록 다각형(반시계)으로 자른다(Sutherland–Hodgman). 오목 고리도 면적은 맞다 */
const clipRing = (ring: Pt[], clip: Pt[]): Pt[] => {
    let out = ring
    for (let i = 0; i < clip.length && out.length > 0; i++) {
        const a = clip[i], b = clip[(i + 1) % clip.length]
        const side = (p: Pt) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
        const input = out
        out = []
        for (let k = 0; k < input.length; k++) {
            const p = input[k], q = input[(k + 1) % input.length]
            const sp = side(p), sq = side(q)
            if (sp >= 0) out.push(p)
            if ((sp >= 0) !== (sq >= 0)) {
                const t = sp / (sp - sq)
                out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t])
            }
        }
    }
    return out
}
/** 점에서 볼록 다각형 변까지의 최소 거리 */
const distToEdges = (p: Pt, poly: Pt[]) => {
    let best = Infinity
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length]
        const dx = b[0] - a[0], dy = b[1] - a[1]
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
        best = Math.min(best, Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)))
    }
    return best
}
/**
 * 고리들(외곽 → 구멍)과 볼록 도엽 폴리곤의 겹침: 면적(m²)과 깊이(겹친 외곽의 꼭짓점이 도엽 변에서 안쪽으로 들어간 최대 거리, m).
 * 5K 경계에서 잘린 이웃 조각은 경계 좌표의 mm 반올림 때문에 면적이 0 이 아닌 아주 가는 띠로 겹칠 수 있어 깊이로 가린다
 */
const overlap = (rings: Pt[][], clip: Pt[]) => {
    let area = 0, depth = 0
    rings.forEach((r, k) => {
        const c = clipRing(r, clip)
        const ar = c.length >= 3 ? Math.abs(ringArea(c)) : 0
        area += k === 0 ? ar : -ar
        if (k === 0 && ar > 0) for (const p of c) depth = Math.max(depth, distToEdges(p, clip))
    })
    return { area: Math.max(0, area), depth }
}
/** xy(공통 원점 mm) → m 고리들(외곽 → 구멍) */
const ringsOfXy = (xy: Int32Array, holes: number[]): Pt[][] => {
    const n = xy.length / 2
    const outerN = n - holes.reduce((s, h) => s + h, 0)
    const rings: Pt[][] = []
    let start = 0
    for (const len of [outerN, ...holes]) {
        const r: Pt[] = []
        for (let i = start; i < start + len; i++) r.push([xy[2 * i] / 1000, xy[2 * i + 1] / 1000])
        rings.push(r)
        start += len
    }
    return rings
}
const boundsOfXy = (xy: Int32Array) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (let i = 0; i < xy.length; i += 2) {
        const x = xy[i] / 1000, y = xy[i + 1] / 1000
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
    }
    return { x0, y0, x1, y1 }
}
/**
 * 폴리곤 안 판정 문턱: 면적 > AREA_EPS(m²) 이고 깊이 > DEPTH_EPS(m). 깊이가 이보다 얕은 겹침은 "경계 실금"(sliver)으로 따로 센다
 * (5K 경계에서 잘린 이웃 조각과 1K corners 의 mm 반올림 차이. 2026-10-23 C0 에서 소양호 조각 0.0258 m² 로 발견)
 */
const AREA_EPS = 1e-3
const DEPTH_EPS = 0.01

/**
 * 산림 마스크와 같은 규칙(픽셀 중심, 주사선 짝홀, 반열린 행)으로 폴리곤 하나를 도엽 bbox 격자에 칠했을 때 픽셀 수: 전체와 도엽 폴리곤 안.
 * forestMask.ts buildForestMask 의 칠하기를 옮긴 것(그 함수가 바뀌어도 기준값이 따라 바뀌지 않게 따로 둔다)
 */
export const forestPixels = (p: { xy: Int32Array; holes: number[] }, tilePoly: Pt[], res = 1) => {
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity
    for (const [x, y] of tilePoly) {
        if (x < bx0) bx0 = x
        if (x > bx1) bx1 = x
        if (y < by0) by0 = y
        if (y > by1) by1 = y
    }
    const width = Math.max(1, Math.ceil((bx1 - bx0) / res))
    const height = Math.max(1, Math.ceil((by1 - by0) / res))
    const n = p.xy.length / 2
    const outerN = n - p.holes.reduce((s, h) => s + h, 0)
    if (outerN < 3) return { total: 0, inside: 0 }
    const b = boundsOfXy(p.xy)
    const j0 = Math.max(0, Math.ceil((b.y0 - by0) / res - 0.5))
    const j1 = Math.min(height - 1, Math.floor((b.y1 - by0) / res - 0.5))
    let total = 0, inside = 0
    for (let j = j0; j <= j1; j++) {
        const yc = by0 + (j + 0.5) * res
        const xs: number[] = []
        let start = 0
        for (const len of [outerN, ...p.holes]) {
            for (let i = 0; i < len; i++) {
                const a = start + i, c = start + ((i + 1) % len)
                const ax = p.xy[2 * a] / 1000, ay = p.xy[2 * a + 1] / 1000
                const qx = p.xy[2 * c] / 1000, qy = p.xy[2 * c + 1] / 1000
                if (ay === qy) continue
                const lo = Math.min(ay, qy), hi = Math.max(ay, qy)
                const ja = Math.ceil((lo - by0) / res - 0.5), jb = Math.ceil((hi - by0) / res - 0.5) - 1
                if (j < ja || j > jb) continue
                xs.push(ax + ((yc - ay) * (qx - ax)) / (qy - ay))
            }
            start += len
        }
        if (xs.length < 2) continue
        xs.sort((u, v) => u - v)
        for (let k = 0; k + 1 < xs.length; k += 2) {
            const i0 = Math.max(0, Math.ceil((xs[k] - bx0) / res - 0.5))
            const i1 = Math.min(width - 1, Math.floor((xs[k + 1] - bx0) / res - 0.5))
            for (let i = i0; i <= i1; i++) {
                total++
                if (pointInPolygon(bx0 + (i + 0.5) * res, yc, tilePoly)) inside++
            }
        }
    }
    return { total, inside }
}

// ---- 2. C0 자료 대조 ----

/** 파일 원점 mm → 공통 원점 mm(loadX 의 shiftXy 와 같다) */
const shift = (xy: Int32Array, fileOrigin: [number, number], origin: [number, number]) => {
    const dx = (fileOrigin[0] - origin[0]) * 1000, dy = (fileOrigin[1] - origin[1]) * 1000
    const out = new Int32Array(xy.length)
    for (let i = 0; i < xy.length; i += 2) {
        out[i] = xy[i] + dx
        out[i + 1] = xy[i + 1] + dy
    }
    return out
}
const sameXy = (a: Int32Array, b: Int32Array) => a.length === b.length && a.every((v, i) => v === b[i])

type Sourced<T> = { item: T; src: string }
/** 한 레이어의 5K 파일들을 loadX 와 같은 순서·중복 제거로 합친다(dedup 이 true 면 flags & 1 인 항목을 id 로 한 번만) */
const mergeFiles = <T extends { flags: number; xy: Int32Array }>(
    files: { id5k: string; origin: [number, number]; items: T[] }[],
    origin: [number, number],
    idOf: ((x: T) => number) | null,
) => {
    const seen = new Set<number>()
    const out: Sourced<T>[] = []
    for (const f of files) {
        for (const it of f.items) {
            if (idOf && it.flags & 1) {
                const id = idOf(it)
                if (seen.has(id)) continue
                seen.add(id)
            }
            out.push({ item: { ...it, xy: shift(it.xy, f.origin, origin) }, src: f.id5k })
        }
    }
    return out
}

/** 항목 키 → 서명·폴리곤 안 여부·겹친 면적(산림은 폴리곤 안 픽셀 수)·출처 5K */
type Used = Map<string, { sig: string; inPoly: boolean; area: number; depth: number; src: string }>

type LayerDiff = {
    /** 지금 방식(b)·자기 5K(a)에서 쓰이는 항목 수 */
    cur: number
    own: number
    /** b 에만 있는 항목: 도엽 폴리곤과 겹침 / bbox 귀퉁이에만 */
    onlyCurIn: string[]
    onlyCurBbox: string[]
    /** a 에만 있는 항목(있으면 이상) */
    onlyOwnIn: string[]
    onlyOwnBbox: string[]
    /** 양쪽에 있으나 도형·속성·파생값(선 찾기·이름·띠)이 다른 항목 */
    changed: string[]
    /** bbox 에만 닿는 항목(양쪽 합집합 중 폴리곤과 안 겹침). 비교의 허용 판정에 쓴다 */
    bboxOnly: string[]
    /** 참고: b 에만 있는 bbox 귀퉁이 항목의 최대 겹침 면적(m²) */
    maxBboxArea: number
    /** 다른 항목마다 "출처 5K 면적 깊이" */
    detail: Record<string, string>
    /** b 에만 있는 항목 중 면적은 있으나 깊이 DEPTH_EPS 이하(경계 실금) 수와 최대 깊이(m) */
    slivers: number
    maxSliverDepth: number
}
const emptyDiff = (): LayerDiff => ({ cur: 0, own: 0, onlyCurIn: [], onlyCurBbox: [], onlyOwnIn: [], onlyOwnBbox: [], changed: [], bboxOnly: [], maxBboxArea: 0, detail: {}, slivers: 0, maxSliverDepth: 0 })

/**
 * 키 → (서명, 폴리곤 안 여부) 두 벌을 비교한다. 서명은 그 항목이 결과에 주는 모든 입력(도형·속성·파생값)을 문자열로 묶은 것
 */
const diffSets = (cur: Used, own: Used): LayerDiff => {
    const d = emptyDiff()
    d.cur = cur.size
    d.own = own.size
    const note = (k: string, v: { area: number; depth: number; src: string }) => (d.detail[k] = `${v.src} 면적 ${Math.round(v.area * 1e4) / 1e4} 깊이 ${Math.round(v.depth * 1e5) / 1e5}`)
    for (const [k, v] of cur) {
        if (!v.inPoly) d.bboxOnly.push(k)
        const o = own.get(k)
        if (o && o.sig !== v.sig) {
            note(k, v)
            // 서명의 어느 칸이 다른지(도로 조각: 마지막 셋이 포장·상태 / 고가 선 / 지하)
            const a = v.sig.split(";"), b = o.sig.split(";")
            const diff = a.map((x, i) => (x === b[i] ? null : `칸 ${i}: 지금 ${x.slice(0, 40)} / 자기 ${(b[i] ?? "").slice(0, 40)}`)).filter(Boolean)
            d.detail[k] += ` (${diff.join(", ")})`
        }
        if (!o) {
            note(k, v)
            if (v.inPoly) d.onlyCurIn.push(k)
            else {
                d.onlyCurBbox.push(k)
                d.maxBboxArea = Math.max(d.maxBboxArea, v.area)
                if (v.area > AREA_EPS) {
                    d.slivers++
                    d.maxSliverDepth = Math.max(d.maxSliverDepth, v.depth)
                }
            }
        } else if (o.sig !== v.sig) d.changed.push(k)
    }
    for (const [k, v] of own) {
        if (cur.has(k)) continue
        note(k, v)
        if (!v.inPoly) d.bboxOnly.push(k)
        if (v.inPoly) d.onlyOwnIn.push(k)
        else d.onlyOwnBbox.push(k)
    }
    return d
}

export type TileAnalysis = {
    tile: string
    id5k: string
    /** 지금 방식의 5K 목록(1K bbox 로 ttp 인덱스에서 고른 것, 인덱스 순) */
    sheetsCur: string[]
    layers: Record<LayerKey, LayerDiff>
    /** 산림: bbox 에 닿는 폴리곤 id → [전체 픽셀, 도엽 폴리곤 안 픽셀](b 기준. 같은 id 는 같은 도형이라 a 도 같음) */
    forestPixels: Record<string, [number, number]>
}

/**
 * C0: 도엽 하나에 레이어마다 쓰이는 항목을 "자기 5K 파일만"(a) 과 "지금 방식"(b) 으로 계산해 비교한다.
 * 쓰이는 항목(보조 워커 buildTile 과 각 *Mesh 의 거르기):
 * - 건물: 무게중심(정점 평균)이 도엽 bbox → 폴리곤 안. 이름은 대상 5K 이름 파일을 먼저 본 것
 * - 도로: bbox 에 닿는 조각(+ 조각의 lineId 선에서 온 포장·상태, 교량·고가면 id 또는 가장 가까운 고가 선), bbox 에 닿는 면 밖 선(띠).
 *   면 밖이 아닌 선은 전부 넘어가지만 쓰임은 lineId 조회·고가 선 찾기뿐이라 그 결과로 비교한다
 * - 물: 조각 전부가 "수면 안" 판정에 쓰이고, 지형 bbox(여기서는 도엽 bbox ± 띠 100 m 로 어림)에 걸친 조각·띠가 표에 오른다. 띠는 수면 안 선분을 뺀 사각형
 * - 산림: bbox 에 닿는 폴리곤
 * 폴리곤 안 판정: 면적 > 1e-3 m²(건물은 무게중심이 안이므로 늘 안), 산림은 칠한 픽셀 중심이 도엽 폴리곤 안인 것이 하나라도 있으면
 *
 * @param tile 도엽(5179 corners)
 * @param origin 공통 원점(보조 워커와 같은 값을 주면 부동소수 판정까지 같다)
 * @param opts.wide golden 기준값용: (b) 를 "자기 5K bbox 에 걸리는 5K 전부" 로 넓히고 물의 지형 bbox 거르기를 끈다(어떤 순서에서든 섞일 수 있는 항목 전부)
 */
export const analyzeTile = async (tile: QueryTile, origin: [number, number], opts: { wide?: boolean } = {}): Promise<TileAnalysis> => {
    const [ox, oy] = origin
    const poly: Pt[] = tile.corners.map(([x, y]) => [x - ox, y - oy])
    if (ringArea(poly) < 0) poly.reverse()
    const bx0 = Math.min(...poly.map((p) => p[0])), bx1 = Math.max(...poly.map((p) => p[0]))
    const by0 = Math.min(...poly.map((p) => p[1])), by1 = Math.max(...poly.map((p) => p[1]))
    const touches = (b: { x0: number; y0: number; x1: number; y1: number }) => b.x1 >= bx0 && b.x0 <= bx1 && b.y1 >= by0 && b.y0 <= by1
    // wide(golden 기준값): 지금 코드의 5K 목록은 그 5K 의 "첫 도엽" bbox 로 채워지므로 어떤 순서에서든 섞일 수 있는 5K 전부(자기 5K bbox 에 걸리는 5K)를 본다
    const q = await getTtpSheetsInBbox(opts.wide ? await sheetBbox3857(tile.id5k, false) : tileExtent3857(tile.corners))
    const sheetsCur = q.sheets.map((s) => s.id5k)
    if (!sheetsCur.includes(tile.id5k)) throw new Error(`도엽 ${tile.map_id} 의 1K bbox 조회에 자기 5K ${tile.id5k} 가 없음`)
    const ownSheets = [tile.id5k]

    const result: TileAnalysis = { tile: tile.map_id, id5k: tile.id5k, sheetsCur, layers: { buildings: emptyDiff(), roads: emptyDiff(), water: emptyDiff(), forest: emptyDiff() }, forestPixels: {} }

    // 건물
    {
        const load = async (sheets: string[]) => {
            const entries = (await Promise.all(sheets.map((s) => layerEntry("buildings", s)))).filter((e): e is IndexEntry => !!e)
            const files = await Promise.all(entries.map((e) => fetchParsed(`${BUILDINGS_BASE}/${e.path}`, parseBfp)))
            const names = await Promise.all(
                entries.map((e) => fetchParsed(`${BUILDINGS_BASE}/names/v1/${e.id5k.slice(0, 5)}/${e.id5k}.json.gz`, (b) => JSON.parse(new TextDecoder().decode(b)) as { n: number; id: number[]; name: string[]; dong: string[]; src: number[] })),
            )
            const byId = new Map<number, string>()
            for (const f of names) for (let i = 0; i < f.n; i++) if (!byId.has(f.id[i])) byId.set(f.id[i], `${f.name[i]}|${f.dong[i]}|${f.src[i]}`)
            const merged = mergeFiles(files.map((f) => ({ id5k: f.id5k, origin: f.origin, items: f.buildings })), origin, (b: Building) => b.id)
            const used: Used = new Map()
            for (const { item: b, src } of merged) {
                let sx = 0, sy = 0
                const n = b.xy.length / 2
                for (let i = 0; i < b.xy.length; i += 2) {
                    sx += b.xy[i]
                    sy += b.xy[i + 1]
                }
                const cx = sx / n / 1000, cy = sy / n / 1000
                if (cx < bx0 || cx > bx1 || cy < by0 || cy > by1 || !pointInPolygon(cx, cy, poly)) continue
                const sig = [b.height, b.floors, b.floorsUnder, b.useCd, b.structCd, b.flags, b.holes.join("/"), Array.from(b.xy).join(","), byId.get(b.id) ?? ""].join(";")
                used.set(`b${b.id}`, { sig, inPoly: true, area: 0, depth: 0, src })
            }
            return used
        }
        result.layers.buildings = diffSets(await load(sheetsCur), await load(ownSheets))
    }

    // 도로
    {
        const load = async (sheets: string[]) => {
            const entries = (await Promise.all(sheets.map((s) => layerEntry("roads", s)))).filter((e): e is IndexEntry => !!e)
            const files = await Promise.all(entries.map((e) => fetchParsed(`${ROADS_BASE}/${e.path}`, parseRds)))
            const faces = mergeFiles(files.map((f) => ({ id5k: f.id5k, origin: f.origin, items: f.faces })), origin, (x: RoadFace) => x.id)
            const lines = mergeFiles(files.map((f) => ({ id5k: f.id5k, origin: f.origin, items: f.lines })), origin, (x: RoadLine) => x.id)
            // 보조 워커: 면 밖이 아닌 선은 전부, 면 밖 선은 bbox 에 닿는 것만
            const srcOfLine = new Map(lines.map((l) => [l.item, l.src]))
            const linesHere = lines.map((l) => l.item).filter((l) => !(l.flags & ROAD_LINE_FLAG.outsideFace) || touches(boundsOfXy(l.xy)))
            const lineById = new Map<number, RoadLine>()
            for (const l of linesHere) lineById.set(l.id, l)
            const elevatedLines = linesHere.filter((l) => isElevated(l.tfceqp))
            const distanceToLine = (l: RoadLine, x: number, y: number) => {
                let best = Infinity
                for (let i = 0; i + 2 < l.xy.length; i += 2) {
                    const ax = l.xy[i] / 1000, ay = l.xy[i + 1] / 1000, bx = l.xy[i + 2] / 1000, by = l.xy[i + 3] / 1000
                    const dx = bx - ax, dy = by - ay
                    const len2 = dx * dx + dy * dy
                    const u = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0
                    best = Math.min(best, Math.hypot(ax + dx * u - x, ay + dy * u - y))
                }
                return best
            }
            const used: Used = new Map()
            for (const { item: f, src } of faces) {
                if (!touches(boundsOfXy(f.xy))) continue
                const rings = ringsOfXy(f.xy, f.holes)
                if (rings[0].length < 3) continue
                const { area, depth } = overlap(rings, poly)
                const line = lineById.get(f.lineId)
                // 교량·고가: id 로 못 찾으면 무게중심에서 가장 가까운 고가 선(폭의 절반 + 2 m 안). roadsMesh findElevatedLine 과 같다
                let elev = ""
                if (isElevated(f.tfceqp)) {
                    let found = line
                    if (!found) {
                        const outer = rings[0]
                        let cx = 0, cy = 0
                        for (const [x, y] of outer) {
                            cx += x / outer.length
                            cy += y / outer.length
                        }
                        let bestD = Math.max(f.roadBt / 2, 1) + 2
                        for (const l of elevatedLines) {
                            const d = distanceToLine(l, cx, cy)
                            if (d < bestD) {
                                bestD = d
                                found = l
                            }
                        }
                    }
                    elev = found ? `${found.id}:${Array.from(found.xy).join(",")}` : "none"
                }
                const sig = [f.lineId, f.roadBt, f.roadSe, f.cartrk, f.tfceqp, f.phyLv, f.flags, f.holes.join("/"), Array.from(f.xy).join(","), line ? `${line.pmtr}/${line.usgstt}` : "-", elev, isUnderground(f.tfceqp) ? "U" : ""].join(";")
                used.set(`f${f.id}`, { sig, inPoly: area > AREA_EPS && depth > DEPTH_EPS, area, depth, src })
            }
            for (const l of linesHere) {
                if (!(l.flags & ROAD_LINE_FLAG.outsideFace)) continue
                const quads = ribbonQuads(l.xy, l.roadBt > 0 ? l.roadBt : RIBBON_DEFAULT_WIDTH_M)
                if (quads.length === 0) continue
                let area = 0, depth = 0
                for (const qd of quads) {
                    const r: Pt[] = []
                    for (let i = 0; i < qd.length; i += 2) r.push([qd[i], qd[i + 1]])
                    if (ringArea(r) < 0) r.reverse()
                    const o = overlap([r], poly)
                    area += o.area
                    depth = Math.max(depth, o.depth)
                }
                const sig = [l.roadBt, l.roadSe, l.cartrk, l.pmtr, l.tfceqp, l.phyLv, l.usgstt, l.flags, Array.from(l.xy).join(",")].join(";")
                used.set(`r${l.id}`, { sig, inPoly: area > AREA_EPS && depth > DEPTH_EPS, area, depth, src: srcOfLine.get(l) ?? "" })
            }
            return used
        }
        result.layers.roads = diffSets(await load(sheetsCur), await load(ownSheets))
    }

    // 물
    {
        const load = async (sheets: string[]) => {
            const entries = (await Promise.all(sheets.map((s) => layerEntry("water", s)))).filter((e): e is IndexEntry => !!e)
            const files = await Promise.all(entries.map((e) => fetchParsed(`${WATER_BASE}/${e.path}`, parseWtr)))
            const nameFiles = await Promise.all(
                entries.filter((e) => e.names_path).map((e) => fetchParsed(`${WATER_BASE}/${e.names_path}`, (b) => JSON.parse(new TextDecoder().decode(b)) as { name_id: number[]; name: string[]; river_no?: string[] })),
            )
            const names = new Map<number, string>()
            for (const f of nameFiles) for (let i = 0; i < f.name_id.length; i++) if (!names.has(f.name_id[i])) names.set(f.name_id[i], `${f.name[i] ?? ""}|${f.river_no?.[i] ?? ""}`)
            const pieces = mergeFiles(files.map((f) => ({ id5k: f.id5k, origin: f.origin, items: f.pieces })), origin, null) as Sourced<WaterPiece>[]
            const lines = mergeFiles(files.map((f) => ({ id5k: f.id5k, origin: f.origin, items: f.lines })), origin, null) as Sourced<WaterLine>[]
            // 지형 bbox 의 어림(도엽 bbox ± 띠). 실제 합친 메쉬 bbox 는 띠를 넓히면 더 크다
            const tx0 = bx0 - BAND_M, tx1 = bx1 + BAND_M, ty0 = by0 - BAND_M, ty1 = by1 + BAND_M
            // wide 면 지형 bbox 어림을 쓰지 않는다(띠를 넓힌 합친 메쉬는 bbox 가 훨씬 클 수 있어 표 행이 멀리 있는 조각에도 생긴다)
            const overlapsBox = (x0: number, y0: number, x1: number, y1: number) => !!opts.wide || (x1 >= tx0 && x0 <= tx1 && y1 >= ty0 && y0 <= ty1)
            const covers: { rings: Pt[][]; b: ReturnType<typeof boundsOfXy> }[] = []
            const used: Used = new Map()
            for (const { item: p, src } of pieces) {
                const rings = ringsOfXy(p.xy, p.holes)
                if (rings[0].length < 3) continue
                const b = boundsOfXy(p.xy.subarray(0, rings[0].length * 2))
                covers.push({ rings, b })
                if (!overlapsBox(b.x0, b.y0, b.x1, b.y1)) continue
                const { area, depth } = overlap(rings, poly)
                const key = `p${p.srcId}@${p.xy[0]},${p.xy[1]}`
                const sig = [p.nameId, p.kind, p.flags, p.srcNPieces, p.holes.join("/"), Array.from(p.xy).join(","), names.get(p.nameId) ?? ""].join(";")
                used.set(key, { sig, inPoly: area > AREA_EPS && depth > DEPTH_EPS, area, depth, src })
            }
            const ringIn = (x: number, y: number, r: Pt[]) => {
                let inside = false
                for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
                    const [xi, yi] = r[i], [xj, yj] = r[j]
                    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
                }
                return inside
            }
            const insideWater = (x: number, y: number) => {
                for (const c of covers) {
                    if (x < c.b.x0 || x > c.b.x1 || y < c.b.y0 || y > c.b.y1) continue
                    if (!ringIn(x, y, c.rings[0])) continue
                    let inHole = false
                    for (let h = 1; h < c.rings.length && !inHole; h++) inHole = ringIn(x, y, c.rings[h])
                    if (!inHole) return true
                }
                return false
            }
            for (const { item: l, src } of lines) {
                const w = RIBBON_WIDTH_M[l.riverSe] ?? RIBBON_WIDTH_M[RIVER_SE.other]
                const quads = ribbonQuads(l.xy, w, (i, pts) => insideWater((pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2))
                if (quads.length === 0) continue
                let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
                let area = 0, depth = 0
                for (const qd of quads) {
                    const r: Pt[] = []
                    for (let i = 0; i < qd.length; i += 2) {
                        r.push([qd[i], qd[i + 1]])
                        x0 = Math.min(x0, qd[i]); x1 = Math.max(x1, qd[i])
                        y0 = Math.min(y0, qd[i + 1]); y1 = Math.max(y1, qd[i + 1])
                    }
                    if (ringArea(r) < 0) r.reverse()
                    const o = overlap([r], poly)
                    area += o.area
                    depth = Math.max(depth, o.depth)
                }
                if (!overlapsBox(x0, y0, x1, y1)) continue
                const sig = [l.nameId, l.riverSe, l.flags, quads.map((qd) => qd.map((v) => v.toFixed(4)).join(",")).join("|"), names.get(l.nameId) ?? ""].join(";")
                used.set(`l${l.id}@${l.xy[0]},${l.xy[1]}`, { sig, inPoly: area > AREA_EPS && depth > DEPTH_EPS, area, depth, src })
            }
            return used
        }
        result.layers.water = diffSets(await load(sheetsCur), await load(ownSheets))
    }

    // 산림
    {
        const load = async (sheets: string[]) => {
            const entries = (await Promise.all(sheets.map((s) => layerEntry("forest", s)))).filter((e): e is IndexEntry => !!e)
            const files = await Promise.all(entries.map((e) => fetchParsed(`${FOREST_BASE}/${e.path}`, parseFrs)))
            const merged = mergeFiles(files.map((f) => ({ id5k: f.id5k, origin: f.origin, items: f.polys })), origin, (p: ForestPolygon) => p.id)
            const used: Used = new Map()
            for (const { item: p, src } of merged) {
                if (!touches(boundsOfXy(p.xy))) continue
                const px = forestPixels(p, poly)
                result.forestPixels[String(p.id)] = [px.total, px.inside]
                const sig = [p.frtp, p.koftr, p.dmcls, p.agcls, p.dnst, p.height, p.storunst, p.fror, p.year, p.flags, p.holes.join("/"), Array.from(p.xy).join(",")].join(";")
                used.set(`s${p.id}`, { sig, inPoly: px.inside > 0, area: px.inside, depth: 0, src })
            }
            return used
        }
        result.layers.forest = diffSets(await load(sheetsCur), await load(ownSheets))
    }
    return result
}

// ---- 3. 재검증용 입력 흔들기 ----

/**
 * 도엽 하나의 자기 5K 건물 파일에서 무게중심이 도엽 폴리곤 안이고 중복 비트가 없는 건물 하나를 골라, 그 첫 정점 x 의 위치(gunzip 한 버퍼 안 바이트)를 준다.
 * tile-golden.mjs 가 그 자리 int32 에 +1(1 mm)을 더해 다시 gzip 해 내준다
 */
export const perturbTarget = async (tile: QueryTile) => {
    const e = await layerEntry("buildings", tile.id5k)
    if (!e) throw new Error(`5K ${tile.id5k} 에 건물이 없어 흔들 수 없음`)
    const url = `${BUILDINGS_BASE}/${e.path}`
    const f = parseBfp(await fetchGunzip(url))
    for (const b of f.buildings) {
        if (b.flags & 1) continue
        let sx = 0, sy = 0
        const n = b.xy.length / 2
        for (let i = 0; i < b.xy.length; i += 2) {
            sx += b.xy[i]
            sy += b.xy[i + 1]
        }
        const cx = sx / n / 1000 + f.origin[0], cy = sy / n / 1000 + f.origin[1]
        if (pointInPolygon(cx, cy, tile.corners)) return { url, byteOffset: b.xy.byteOffset, id: b.id }
    }
    throw new Error(`도엽 ${tile.map_id} 안에 흔들 건물이 없음`)
}

export type { BuildJob, QueryTile, TileStyle }
