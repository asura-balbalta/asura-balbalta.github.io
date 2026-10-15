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
    /** 건물명(names/v1). "" = 없음 */
    name: string
    /** 동명(names/v1, "101동"·"가동" 꼴로 정규화). "" = 없음 */
    dong: string
    /** 이름 출처 비트: 1 = 건물명이 건축물대장 표제부에서 보충, 2 = 동명이 표제부에서 보충, 0 = 둘 다 AL_D010 */
    nameSrc: number
}

/** `{base}/names/v1/{50K}/{5K}.json.gz`: 건물명·동명(id 오름차순 평행 배열). 건물명·동명이 둘 다 빈 건물은 없다 */
type BuildingNamesFile = {
    id5k: string
    n: number
    id: number[]
    name: string[]
    dong: string[]
    src: number[]
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
            name: "",
            dong: "",
            nameSrc: 0,
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
    /** 용도 코드 → 한글 이름(AL_D010 공식 코드표). 뜻을 알 수 없는 코드는 "". 2026-10-12 추가 */
    use_name?: Record<string, string>
    struct_name?: Record<string, string>
    /** 용도 코드 → 대분류(앞 2자리 + 000) 이름. 없으면 "" */
    use_group_name?: Record<string, string>
}

/**
 * codes.json 에서 만든 표. storeyByUse 는 높이 없는 건물의 층수 × 층고 추정용, 이름 표 셋은 파일의 u8 인덱스 → 한글 이름
 * (길이 256, 없으면 ""). 건물 표(BuildingTable)에 함께 실려 내보내기 이름·속성에 쓴다
 */
export type BuildingCodeTable = {
    storeyByUse: Float32Array
    useNames: string[]
    structNames: string[]
    useGroupNames: string[]
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
 * codes.json 을 받아 "용도 u8 인덱스 → 층고(m)" 표와 "u8 인덱스 → 이름" 표 셋을 만든다.
 * 층고 표에 없는 용도(인덱스 0 포함)는 default. 이름 표가 codes.json 에 없으면(옛 파일) 모두 "".
 */
export const loadBuildingCodes = async (): Promise<BuildingCodeTable> => {
    const codes = await fetchJsonCached<BuildingCodes>(`${BUILDINGS_BASE}/index/v1/codes.json`)
    const fallback = codes.storey_height_suggested_m.default ?? DEFAULT_STOREY_HEIGHT_M
    const storeyByUse = new Float32Array(256).fill(fallback)
    const useNames = new Array<string>(256).fill("")
    const useGroupNames = new Array<string>(256).fill("")
    for (const [code, idx] of Object.entries(codes.use)) {
        if (idx >= 256) continue
        const h = codes.storey_height_suggested_m[code.slice(0, 5)]
        if (h !== undefined) storeyByUse[idx] = h
        useNames[idx] = codes.use_name?.[code] ?? ""
        useGroupNames[idx] = codes.use_group_name?.[code] ?? ""
    }
    const structNames = new Array<string>(256).fill("")
    for (const [code, idx] of Object.entries(codes.struct)) if (idx < 256) structNames[idx] = codes.struct_name?.[code] ?? ""
    return { storeyByUse, useNames, structNames, useGroupNames }
}

/** 층고 표만 필요할 때(loadBuildingCodes 의 storeyByUse) */
export const loadStoreyHeights = async (): Promise<Float32Array> => (await loadBuildingCodes()).storeyByUse

/** 파싱한 5K 건물 파일 캐시(path → 결과). 걸어 보기 도엽 스트리밍이 도엽마다 부를 때 같은 5K 를 다시 받지 않게 */
const bfpCache = new Map<string, Promise<ReturnType<typeof parseBfp>>>()
const fetchBfpCached = (path: string) => {
    let p = bfpCache.get(path)
    if (!p) {
        p = fetchGunzip(`${BUILDINGS_BASE}/${path}`).then(parseBfp)
        bfpCache.set(path, p)
        p.catch(() => bfpCache.delete(path))
    }
    return p
}
/** 건물명 파일 캐시(id5k → 파싱 결과) */
const namesCache = new Map<string, Promise<BuildingNamesFile>>()
const fetchNamesCached = (id5k: string) => {
    let p = namesCache.get(id5k)
    if (!p) {
        p = fetchGunzip(`${BUILDINGS_BASE}/names/v1/${id5k.slice(0, 5)}/${id5k}.json.gz`).then(
            (bytes) => JSON.parse(new TextDecoder().decode(bytes)) as BuildingNamesFile,
        )
        namesCache.set(id5k, p)
        p.catch(() => namesCache.delete(id5k))
    }
    return p
}

/**
 * 5K 번호들의 건물명 파일(names/v1)을 받아 id → 이름으로 합친다. 5K 경계에 걸친 건물은 양쪽 파일에 같은 값이 있어
 * 먼저 본 것을 쓴다. 이름 없는 5K 는 n: 0 인 빈 파일이라 존재 여부를 따로 확인하지 않는다
 */
const loadBuildingNames = async (ids5k: string[]) => {
    const files = await Promise.all(ids5k.map(fetchNamesCached))
    const byId = new Map<number, { name: string; dong: string; src: number }>()
    for (const f of files) for (let i = 0; i < f.n; i++) if (!byId.has(f.id[i])) byId.set(f.id[i], { name: f.name[i], dong: f.dong[i], src: f.src[i] })
    return byId
}

/**
 * 선택 범위의 건물을 받아 공통 원점 기준으로 합친다(전달 문서 3절 1~5).
 *
 * 1. ttp 인덱스로 범위에 걸린 5K 번호를 고른다(지형과 같은 번호)
 * 2. 건물 50K 인덱스에서 그 5K 의 path 를 보고 n_buildings > 0 인 것만 받는다
 * 3. 좌표를 공통 원점 mm 로 옮기고, flags 의 duplicated 비트가 있는 건물은 id 로 중복 제거
 * 4. 같은 5K 의 건물명 파일(names/v1)을 받아 id 로 건물명·동명을 붙인다
 * 범위 안팎 선별은 하지 않는다(지형 위에 세울 때 지형 밖 건물이 걸러진다).
 *
 * @param bbox3857 지도에서 고른 범위 (EPSG:3857)
 * @param commonOrigin 지형 메쉬의 원점(정수 m, 5179)
 * @returns 건물 목록(xy 는 공통 원점 mm 의 새 배열)과 받은 파일 수
 */
export const loadBuildings = async (
    bbox3857: Extent,
    commonOrigin: [number, number],
): Promise<{ buildings: Building[]; files: number }> => {
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
    const [files, names] = await Promise.all([
        Promise.all(
            targets.map(async (t) => {
                const file = await fetchBfpCached(t.path)
                return file
            }),
        ),
        loadBuildingNames(targets.map((t) => t.id5k)),
    ])

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
            const nm = names.get(b.id)
            buildings.push(nm ? { ...b, xy, name: nm.name, dong: nm.dong, nameSrc: nm.src } : { ...b, xy })
        }
    }
    return { buildings, files: files.length }
}
