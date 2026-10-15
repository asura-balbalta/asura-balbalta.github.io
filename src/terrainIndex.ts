import type { Extent } from "ol/extent"
import proj4 from "proj4"

import { TileInfo } from "./terrainData"

/**
 * terrain_tile_pslg(ttp) 운영 base URL(R2 버킷 asrbbt-layers 의 커스텀 도메인, 운영·로컬 개발 공통 기본값).
 * 인덱스는 `{base}/index/v1/...`, 5K 파일은 `{base}/v1/{50K}/{5K}.ttp`.
 * 예비: r2.dev 공개 주소 `https://pub-afd24bde9df64c64be95d8ef8d8deae7.r2.dev/ttp`(같은 파일, 커스텀 도메인 문제일 때만).
 * 개발 서버가 같은 파일을 같은 경로로 서빙하므로 서버 데이터로 보려면 `${TERRAIN_API}/ttp` 로 바꾸면 된다(서버 readme 7·7.5).
 */
export const TTP_BASE = "https://layers.asrbbt.world/ttp"

/** 서버 데이터 좌표계 ESRI:102080 은 EPSG:5179 와 같은 정의(단위 m) */
export const EPSG5179_DEF =
    "+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +units=m +no_defs"
proj4.defs("EPSG:5179", EPSG5179_DEF)

/** `{base}/index/v1/sheets50k.json`: 50K 도엽 목록(필요한 필드만) */
type Sheets50kIndex = {
    sheets: { id50k: string; path: string; bbox: Extent; bbox_3857: Extent; n_5k: number; n_1k: number }[]
}

/** `{base}/index/v1/{50K}.json`: 그 50K 의 5K 목록과 각 5K 의 1K 25개(필요한 필드만) */
type Sheet50kIndex = {
    id50k: string
    sheets: {
        id5k: string
        /** `v1/{50K}/{5K}.ttp` */
        path: string
        gz_bytes: number
        bbox: Extent
        bbox_3857: Extent
        tiles: { map_id: string; name: string; corners: [number, number][] }[]
    }[]
}

/** 범위 조회 결과(옛 개발 서버 `/ttm/sheets` 응답과 같은 모양) */
export type TtpSheetsInBbox = {
    /** 공통 원점(정수 m, 5179). 서버 규칙과 같게 선택 범위를 5179 로 바꾼 외접 bbox 의 남서 모서리를 내린 값 */
    origin: [number, number]
    /** 선택 범위와 실제로 겹치는 1K */
    tiles: (TileInfo & { id5k: string })[]
    /** 받아야 할 5K 파일(걸린 1K 가 하나라도 있는 것) */
    sheets: { id5k: string; path: string; gzBytes: number }[]
}

/** 같은 인덱스 JSON 을 한 번만 받는다(모듈 수명 동안. Worker 는 요청마다 새로 만들어지므로 그 안에서만 유효) */
const jsonCache = new Map<string, Promise<unknown>>()
const fetchJsonCached = <T>(url: string): Promise<T> => {
    let p = jsonCache.get(url)
    if (!p) {
        p = fetch(url).then(async (res) => {
            if (!res.ok) throw new Error(`${res.status} ${url}`)
            return res.json()
        })
        jsonCache.set(url, p)
        p.catch(() => jsonCache.delete(url))
    }
    return p as Promise<T>
}

const extentsOverlap = (a: Extent, b: Extent) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]

/**
 * 도엽 bbox 를 자기 크기 + 1 m 만큼 넓힌 범위. 이것과 bbox 가 겹치는 도엽이 이웃 두 겹(5×5)이다(세 겹째는 한 변 크기만큼 더 멀다).
 * 조정자(terrainTiles.worker)와 측정 스크립트(scripts/tileBandCheck.ts)가 같은 규칙을 쓴다
 */
export const neighborReach = (bbox: Extent): Extent => {
    const w = bbox[2] - bbox[0] + 1, h = bbox[3] - bbox[1] + 1
    return [bbox[0] - w, bbox[1] - h, bbox[2] + w, bbox[3] + h]
}

const extentOf = (pts: [number, number][]): Extent => {
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
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

/** 세 점의 방향: 양수면 반시계, 음수면 시계, 0 이면 일직선 */
const orient = (a: [number, number], b: [number, number], c: [number, number]) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

/** 선분 ab 와 cd 가 만나는지(끝점이 닿는 경우 포함, 일직선 겹침은 다각형 교차에서는 꼭짓점 포함 검사가 잡으므로 다루지 않음) */
const segmentsCross = (a: [number, number], b: [number, number], c: [number, number], d: [number, number]) => {
    const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b)
    return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))
}

/**
 * 두 다각형이 겹치는지(한쪽 꼭짓점이 다른 쪽 안에 있거나 변이 교차). 1K corners 와 선택 사각형은 둘 다 볼록 사각형이라
 * 이 두 조건이 교차를 빠짐없이 잡는다. 서버 `/ttm/sheets` 의 shapely intersects 와 같은 뜻
 */
const polygonsIntersect = (a: [number, number][], b: [number, number][]) => {
    if (a.some(([x, y]) => pointInPolygon(x, y, b)) || b.some(([x, y]) => pointInPolygon(x, y, a))) return true
    for (let i = 0; i < a.length; i++) {
        for (let j = 0; j < b.length; j++) {
            if (segmentsCross(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true
        }
    }
    return false
}

/** 선택 bbox(3857)의 네 모서리를 5179 로 바꾼 사각형(둘레 순서). 3857 사각형은 5179 평면에서 조금 기울어진다 */
export const bboxToPolygon5179 = (bbox3857: Extent): [number, number][] => {
    const [x0, y0, x1, y1] = bbox3857
    const corners3857: [number, number][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    return corners3857.map(([x, y]) => proj4("EPSG:3857", "EPSG:5179", [x, y]) as [number, number])
}

/**
 * 지도에서 고른 범위에 걸린 1K 도엽과 받아야 할 5K ttp 파일을 정적 인덱스(R2)에서 찾는다. 서버 readme 7.5 의 흐름이다.
 *
 * 1. sheets50k.json 에서 `bbox_3857` 이 겹치는 50K 를 고른다(한 번 받아 캐시)
 * 2. 그 50K 의 {50K}.json 을 받아 5K 를 `bbox_3857` 로 1차 선별한다
 * 3. 1K `corners`(5179)와 5179 로 바꾼 선택 사각형의 교차로 쓸 1K 를 고른다. `bbox_3857` 은 기울어진 도엽의 외접 bbox 라
 *    선별 전용이고, 정확한 판정은 corners 로 한다
 *
 * @param bbox3857 지도에서 고른 범위 [minX, minY, maxX, maxY] (EPSG:3857)
 * @returns 공통 원점, 걸친 1K 목록, 5K 파일 목록
 */
export const getTtpSheetsInBbox = async (bbox3857: Extent): Promise<TtpSheetsInBbox> => {
    const selection = bboxToPolygon5179(bbox3857)
    const selectionExtent = extentOf(selection)
    const index = await fetchJsonCached<Sheets50kIndex>(`${TTP_BASE}/index/v1/sheets50k.json`)
    const hit50k = index.sheets.filter((s) => extentsOverlap(s.bbox_3857, bbox3857))
    const sheets50k = await Promise.all(hit50k.map((s) => fetchJsonCached<Sheet50kIndex>(`${TTP_BASE}/${s.path}`)))
    const tiles: TtpSheetsInBbox["tiles"] = []
    const sheets: TtpSheetsInBbox["sheets"] = []
    for (const sheet50k of sheets50k) {
        for (const s of sheet50k.sheets) {
            if (!extentsOverlap(s.bbox_3857, bbox3857)) continue
            const picked = s.tiles.filter((t) => polygonsIntersect(t.corners, selection))
            if (picked.length === 0) continue
            sheets.push({ id5k: s.id5k, path: s.path, gzBytes: s.gz_bytes })
            for (const t of picked) {
                tiles.push({ map_id: t.map_id, name: t.name, corners: t.corners, bbox: extentOf(t.corners), id5k: s.id5k })
            }
        }
    }
    return {
        origin: [Math.floor(selectionExtent[0]), Math.floor(selectionExtent[1])],
        tiles,
        sheets,
    }
}
