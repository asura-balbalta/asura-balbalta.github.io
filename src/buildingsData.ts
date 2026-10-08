import type { Extent } from "ol/extent"

import { fetchGunzip } from "./terrainData"
import { getTtpSheetsInBbox } from "./terrainIndex"

/**
 * 건물 레이어(buildings, BFP1) base URL. 경로 규칙은 ttp 와 같고 base 만 다르다(서버 readme 8절, 전달 문서 2026-10-08).
 * 운영(R2 커스텀 도메인)이 기본값. 개발 서버 데이터로 보려면 `${TERRAIN_API}/buildings`,
 * 예비는 `https://pub-afd24bde9df64c64be95d8ef8d8deae7.r2.dev/buildings`
 */
export const BUILDINGS_BASE = "https://layers.asrbbt.world/buildings"

/** flags 비트(전달 문서 5절) */
export const BUILDING_FLAG = {
    /** 다른 5K 파일에도 있음 → 합칠 때 id 로 중복 제거 */
    duplicated: 1,
    /** 등고선이 바닥을 가로지름 → 바닥 z 를 최저점으로 */
    contourCrossed: 2,
    /** 대장 미연계: 용도·층수·높이 모두 없음 */
    noRegister: 4,
} as const

/** 건물 하나(바닥 폴리곤 + 속성). xy 는 공통 원점 기준 mm 정수 */
export type Building = {
    /** 전국 고유 번호 */
    id: number
    /** 높이(m). 0 이면 없음 */
    height: number
    /** 지상 층수. 0 이면 없음 */
    floors: number
    floorsUnder: number
    /** 용도 코드의 u8 인덱스(codes.json 의 use 표). 0 = 없음 */
    useCd: number
    structCd: number
    flags: number
    /** 구멍마다 점 수. xy 는 외곽(처음 nPts − Σholes 점) → 구멍 순 */
    holes: number[]
    /** (x, y) 연속, mm 정수. 외곽 CCW, 구멍 CW, 닫는 점 없음 */
    xy: Int32Array
}

/** BFP1 파일 하나. buildings[].xy 는 파일 원점 기준 mm(파일 버퍼의 view) */
export type BfpFile = {
    id5k: string
    /** 파일 원점(ESRI:102080, 정수 m) */
    origin: [number, number]
    genFlags: number
    buildings: Building[]
}

/**
 * BFP1 파일(gzip 을 푼 뒤)을 파싱한다. 전달 문서 4절의 참조 구현과 같다.
 *
 * @param buf 리틀 엔디언 바이너리
 * @returns 파일 원점과 건물 목록(xy 는 파일 원점 기준 mm 의 view)
 */
export const parseBfp = (buf: ArrayBuffer): BfpFile => {
    const dv = new DataView(buf)
    if (String.fromCharCode(...new Uint8Array(buf, 0, 4)) !== "BFP1") throw new Error("BFP1 파일이 아님")
    const id5k = String(dv.getUint32(4, true)).padStart(8, "0")
    const origin: [number, number] = [dv.getInt32(8, true), dv.getInt32(12, true)]
    const B = dv.getUint32(16, true), V = dv.getUint32(20, true), H = dv.getUint32(24, true)
    const genFlags = dv.getUint32(28, true)
    let off = 32
    const hdrU32 = new Uint32Array(buf, off, 5 * B)
    const hdrF32 = new Float32Array(buf, off, 5 * B)
    const hdrU8 = new Uint8Array(buf, off, 20 * B)
    off += 20 * B
    const holeLen = new Uint32Array(buf, off, H)
    off += 4 * H
    const xy = new Int32Array(buf, off, 2 * V)
    const buildings: Building[] = []
    let v0 = 0, h0 = 0
    for (let k = 0; k < B; k++) {
        const nPts = hdrU32[5 * k + 1]
        const nHoles = hdrU8[20 * k + 16]
        buildings.push({
            id: hdrU32[5 * k],
            height: hdrF32[5 * k + 2],
            floors: hdrU8[20 * k + 12],
            floorsUnder: hdrU8[20 * k + 13],
            useCd: hdrU8[20 * k + 14],
            structCd: hdrU8[20 * k + 15],
            flags: hdrU8[20 * k + 17],
            holes: Array.from(holeLen.subarray(h0, h0 + nHoles)),
            xy: xy.subarray(2 * v0, 2 * (v0 + nPts)),
        })
        v0 += nPts
        h0 += nHoles
    }
    return { id5k, origin, genFlags, buildings }
}

/** `{base}/index/v1/codes.json` */
type BuildingCodes = {
    /** AL 5자리 용도 코드 → 파일의 u8 인덱스 */
    use: Record<string, number>
    struct: Record<string, number>
    /** 용도 코드(앞 5자리) → 층고(m). "default" 포함 */
    storey_height_suggested_m: Record<string, number>
}

/** `{base}/index/v1/{50K}.json` */
type BuildingsSheet50k = {
    id50k: string
    sheets: { id5k: string; path: string; gz_bytes: number; n_buildings: number }[]
}

export const DEFAULT_STOREY_HEIGHT_M = 4

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

/**
 * codes.json 을 받아 "용도 u8 인덱스 → 층고(m)" 표로 만든다. 높이가 없는 건물의 층수 × 층고 추정에 쓴다.
 * 표에 없는 용도(인덱스 0 포함)는 default.
 *
 * @returns 길이 256 의 층고 표
 */
export const loadStoreyHeights = async (): Promise<Float32Array> => {
    const codes = await fetchJsonCached<BuildingCodes>(`${BUILDINGS_BASE}/index/v1/codes.json`)
    const fallback = codes.storey_height_suggested_m.default ?? DEFAULT_STOREY_HEIGHT_M
    const table = new Float32Array(256).fill(fallback)
    for (const [code, idx] of Object.entries(codes.use)) {
        const h = codes.storey_height_suggested_m[code.slice(0, 5)]
        if (h !== undefined && idx < 256) table[idx] = h
    }
    return table
}

export type BuildingsLoadPhase = "index" | "download" | "build"
export type BuildingsProgress = (phase: BuildingsLoadPhase, done: number, total: number) => void

/**
 * 선택 범위의 건물을 받아 공통 원점 기준으로 합친다(전달 문서 3절 1~5).
 *
 * 1. ttp 인덱스로 범위에 걸린 5K 번호를 고른다(지형과 같은 번호)
 * 2. 건물 50K 인덱스에서 그 5K 의 path 를 보고 n_buildings > 0 인 것만 받는다
 * 3. 좌표를 공통 원점 mm 로 옮기고, flags 의 duplicated 비트가 있는 건물은 id 로 중복 제거
 * 범위 안팎 선별은 하지 않는다(지형 위에 세울 때 지형 밖 건물이 걸러진다).
 *
 * @param bbox3857 지도에서 고른 범위 (EPSG:3857)
 * @param commonOrigin 지형 메쉬의 원점(정수 m, 5179)
 * @param onProgress 단계별 진행률
 * @returns 건물 목록(xy 는 공통 원점 mm 의 새 배열)과 받은 파일 수
 */
export const loadBuildings = async (
    bbox3857: Extent,
    commonOrigin: [number, number],
    onProgress?: BuildingsProgress,
): Promise<{ buildings: Building[]; files: number }> => {
    onProgress?.("index", 0, 1)
    const q = await getTtpSheetsInBbox(bbox3857)
    const ids50k = [...new Set(q.sheets.map((s) => s.id5k.slice(0, 5)))]
    const indexes = await Promise.all(
        ids50k.map((id50k) => fetchJsonCached<BuildingsSheet50k>(`${BUILDINGS_BASE}/index/v1/${id50k}.json`)),
    )
    const entryById5k = new Map(indexes.flatMap((ix) => ix.sheets.map((s) => [s.id5k, s] as const)))
    const targets = q.sheets
        .map((s) => entryById5k.get(s.id5k))
        .filter((e): e is NonNullable<typeof e> => !!e && e.n_buildings > 0)

    let downloaded = 0
    onProgress?.("download", 0, targets.length)
    const files = await Promise.all(
        targets.map(async (t) => {
            const file = parseBfp(await fetchGunzip(`${BUILDINGS_BASE}/${t.path}`))
            onProgress?.("download", ++downloaded, targets.length)
            return file
        }),
    )

    const seen = new Set<number>()
    const buildings: Building[] = []
    for (const file of files) {
        const dx = (file.origin[0] - commonOrigin[0]) * 1000
        const dy = (file.origin[1] - commonOrigin[1]) * 1000
        for (const b of file.buildings) {
            if (b.flags & BUILDING_FLAG.duplicated) {
                if (seen.has(b.id)) continue
                seen.add(b.id)
            }
            const xy = new Int32Array(b.xy.length)
            for (let i = 0; i < xy.length; i += 2) {
                xy[i] = b.xy[i] + dx
                xy[i + 1] = b.xy[i + 1] + dy
            }
            buildings.push({ ...b, xy })
        }
    }
    return { buildings, files: files.length }
}
