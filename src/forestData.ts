import type { Extent } from "ol/extent"

import { emptyForestCodeNames, FOREST_FLAG, ForestCodeNames } from "./forestTable"
import { fetchGunzip } from "./terrainData"
import { getTtpSheetsInBbox } from "./terrainIndex"

/**
 * 산림 레이어(forest, FRS1. 산림청 임상도 1:5000) base URL. 경로 규칙은 ttp·buildings·roads·water 와 같고 base 만 다르다(서버 README 12절).
 * 운영(R2 커스텀 도메인)이 기본값. 개발 서버 데이터로 보려면 `${TERRAIN_API}/forest`(http://localhost:8000/forest).
 * 격자(5K bbox·1K corners)는 ttp 인덱스를 그대로 쓰고, forest 인덱스 `{50K}.json` 은 5K 마다 path·크기·폴리곤·정점 수만 준다.
 * 계획: docs/forest-layer-plan.md
 */
export const FOREST_BASE = "https://layers.asrbbt.world/forest"

/** 코드 상수(flags·frtp)는 의존성 없는 forestTable.ts 에 있다. 여기서 다시 내보낸다 */
export { FOREST_FLAG, FOREST_MISSING, FOREST_TYPE } from "./forestTable"

/**
 * 임상도 폴리곤 하나. 5K 경계에서 **자르지 않고** 걸친 5K 마다 통째로 들어 있다(buildings 와 같은 복제. flags & 1 만 id 로 중복 제거).
 * 간략화·무효 보정을 하지 않은 원본 도형이다(flags & 4 = 원본 무효). xy 는 공통 원점 기준 mm 정수
 */
export type ForestPolygon = {
    /** 원본 행 × 64 + 멀티폴리곤 파트 번호. 전국 고유 */
    id: number
    /** 갱신년도(0 = 없음) */
    year: number
    /** 임목존재: 0 비산림 · 1 입목지 · 2 무립목지 */
    storunst: number
    /** 임종: 0 없음 · 1 인공림 · 2 천연림 */
    fror: number
    /** 임상: 0 무립목지/비산림 · 1 침엽 · 2 활엽 · 3 혼효 · 4 죽림 */
    frtp: number
    /** 수종그룹 코드 */
    koftr: number
    /** 경급(255 = 없음) */
    dmcls: number
    /** 영급(255 = 없음) */
    agcls: number
    /** 밀도(0 = 없음) */
    dnst: number
    /** 임분고 계급(255 = 없음) */
    height: number
    /** FOREST_FLAG 비트 */
    flags: number
    /** 구멍마다 점 수. xy 는 외곽(처음 nPts − Σholes 점) → 구멍 순 */
    holes: number[]
    /** (x, y) 연속, mm 정수. 외곽 CCW, 구멍 CW, 닫는 점 없음 */
    xy: Int32Array
}

/** FRS1 파일 하나. 좌표는 파일 원점 기준 mm(파일 버퍼의 view) */
export type FrsFile = {
    id5k: string
    /** 파일 원점(ESRI:102080, 정수 m) */
    origin: [number, number]
    genFlags: number
    polys: ForestPolygon[]
}

/**
 * FRS1 파일(gzip 을 푼 뒤)을 파싱한다. 서버 README 12.2 의 참조 구현과 같다.
 *
 * 헤더 32 B(매직, 5K 번호, 원점 x·y, 폴리곤 수 P, 정점 합 V, 구멍 수 합 H, genFlags) → 폴리곤 헤더 **24 B** × P(id u32, n_pts u32,
 * n_holes u16, year u16, storunst·fror·frtp·koftr·dmcls·agcls·dnst·height·flags u8, 예약 3 B) → 구멍 길이 u32 × H → 정점 i32 × 2V.
 * 2026-10-22 확인(S1): 다섯 장 모두 헤더·배열 크기 합이 파일 길이와 같고 외곽 CCW·구멍 CW 가 지켜진다(docs/forest-layer-plan.md 1.3절)
 *
 * @param buf 리틀 엔디언 바이너리
 * @returns 파일 원점과 폴리곤 목록(xy 는 파일 원점 기준 mm 의 view)
 */
export const parseFrs = (buf: ArrayBuffer): FrsFile => {
    const dv = new DataView(buf)
    if (buf.byteLength < 32 || String.fromCharCode(...new Uint8Array(buf, 0, 4)) !== "FRS1") throw new Error("FRS1 파일이 아님")
    const id5k = String(dv.getUint32(4, true)).padStart(8, "0")
    const origin: [number, number] = [dv.getInt32(8, true), dv.getInt32(12, true)]
    const P = dv.getUint32(16, true), V = dv.getUint32(20, true), H = dv.getUint32(24, true), genFlags = dv.getUint32(28, true)
    let off = 32
    const hdr = off
    off += 24 * P
    const holeOff = off
    off += 4 * H
    const xyOff = off
    off += 8 * V
    if (off !== buf.byteLength) throw new Error(`FRS1 길이 불일치: 헤더 합 ${off} B, 파일 ${buf.byteLength} B`)
    const holeLen = new Uint32Array(buf, holeOff, H)
    const xy = new Int32Array(buf, xyOff, 2 * V)

    const polys: ForestPolygon[] = []
    let v0 = 0, h0 = 0
    for (let k = 0; k < P; k++) {
        const b = hdr + 24 * k
        const nPts = dv.getUint32(b + 4, true)
        const nHoles = dv.getUint16(b + 8, true)
        polys.push({
            id: dv.getUint32(b, true),
            year: dv.getUint16(b + 10, true),
            storunst: dv.getUint8(b + 12),
            fror: dv.getUint8(b + 13),
            frtp: dv.getUint8(b + 14),
            koftr: dv.getUint8(b + 15),
            dmcls: dv.getUint8(b + 16),
            agcls: dv.getUint8(b + 17),
            dnst: dv.getUint8(b + 18),
            height: dv.getUint8(b + 19),
            flags: dv.getUint8(b + 20),
            holes: Array.from(holeLen.subarray(h0, h0 + nHoles)),
            xy: xy.subarray(2 * v0, 2 * (v0 + nPts)),
        })
        v0 += nPts
        h0 += nHoles
    }
    if (v0 !== V || h0 !== H) throw new Error(`FRS1 합 불일치: 정점 ${v0}/${V}, 구멍 ${h0}/${H}`)
    return { id5k, origin, genFlags, polys }
}

/** `{base}/index/v1/codes.json`: 코드 → 한글 이름(키는 코드 값 문자열) */
type ForestCodes = Partial<Record<"frtp" | "koftr" | "storunst" | "fror" | "dmcls" | "agcls" | "dnst" | "height", Record<string, string>>>

/** 출처 한 건(sheets50k.json 의 attribution.sources[]). 라이선스 문구는 하드코딩하지 않고 여기서 읽는다 */
export type ForestAttributionSource = {
    name: string
    provider: string
    asof?: string
    portal?: string
    url?: string
    license?: string
    license_url?: string
    license_note?: string
}

/** `{base}/index/v1/sheets50k.json` */
export type ForestSheets50k = {
    layer: string
    version: string
    generated: string
    n_50k: number
    n_5k: number
    n_poly: number
    gz_bytes: number
    note?: string
    attribution?: { short: string; sources: ForestAttributionSource[]; processing?: string; disclaimer?: string }
    sheets: { id50k: string; path: string; n_5k: number; n_poly: number; gz_bytes: number }[]
}

/** `{base}/index/v1/{50K}.json` 의 5K 항목 */
export type ForestSheet5k = {
    id5k: string
    path: string
    gz_bytes: number
    n_poly: number
    n_pts: number
    n_holes: number
    n_dup: number
    n_multipart: number
    n_invalid: number
    n_conifer: number
    n_broadleaf: number
    n_mixed: number
    n_bamboo: number
    n_nonforest: number
}

/** `{base}/index/v1/{50K}.json` */
type ForestSheet50k = { id50k: string; sheets: ForestSheet5k[] }

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

const namesOf = (codes: Record<string, string> | undefined) => {
    const names = new Array<string>(256).fill("")
    for (const [code, name] of Object.entries(codes ?? {})) {
        const n = Number(code)
        if (Number.isInteger(n) && n >= 0 && n < 256) names[n] = name
    }
    return names
}

/** 이름 표가 없을 때(검증 스크립트 등) 쓰는 빈 코드 표 */
export const emptyForestCodeTable = emptyForestCodeNames

/** codes.json 을 받아 코드 값 → 한글 이름 표를 만든다(모듈 캐시. 한 번만 받는다) */
export const loadForestCodes = async (): Promise<ForestCodeNames> => {
    const codes = await fetchJsonCached<ForestCodes>(`${FOREST_BASE}/index/v1/codes.json`)
    return {
        frtpNames: namesOf(codes.frtp),
        koftrNames: namesOf(codes.koftr),
        storunstNames: namesOf(codes.storunst),
        frorNames: namesOf(codes.fror),
        dmclsNames: namesOf(codes.dmcls),
        agclsNames: namesOf(codes.agcls),
        dnstNames: namesOf(codes.dnst),
        heightNames: namesOf(codes.height),
    }
}

/** sheets50k.json(50K 목록 + attribution). 출처 표시(attribution.ts)가 라이선스 문구를 여기서 읽는다 */
export const loadForestIndex = () => fetchJsonCached<ForestSheets50k>(`${FOREST_BASE}/index/v1/sheets50k.json`)

/** 50K 인덱스에서 5K 항목들(id5k → 항목). 크기·폴리곤 수를 받기 전에 본다 */
export const loadForestSheets = async (ids50k: string[]): Promise<Map<string, ForestSheet5k>> => {
    const indexes = await Promise.all(ids50k.map((id50k) => fetchJsonCached<ForestSheet50k>(`${FOREST_BASE}/index/v1/${id50k}.json`)))
    return new Map(indexes.flatMap((ix) => ix.sheets.map((s) => [String(s.id5k), s] as const)))
}

/** 파싱한 5K 산림 파일 캐시(path → 결과). 도엽 스트리밍이 도엽마다 부를 때 같은 5K 를 다시 받지 않게 */
const frsCache = new Map<string, Promise<FrsFile>>()
const fetchFrsCached = (path: string) => {
    let p = frsCache.get(path)
    if (!p) {
        p = fetchGunzip(`${FOREST_BASE}/${path}`).then(parseFrs)
        frsCache.set(path, p)
        p.catch(() => frsCache.delete(path))
    }
    return p
}

/**
 * 선택 범위의 임상도 폴리곤을 받아 공통 원점 기준으로 합친다(서버 README 12.3).
 *
 * 1. ttp 인덱스로 범위에 걸린 5K 번호를 고른다(지형·건물·도로·물과 같은 번호)
 * 2. 산림 50K 인덱스에서 그 5K 의 path 를 보고 `n_poly > 0` 인 것만 받는다(산림 없는 5K 는 32 B 헤더만)
 * 3. 좌표를 공통 원점 mm 로 옮기고, **flags & 1(duplicated) 인 폴리곤만 id 로 중복 제거**(폴리곤은 걸친 5K 마다 통째로 복제돼 있다)
 * 범위 안팎 선별은 하지 않는다(지형 위에 얹을 때 도엽 폴리곤으로 잘린다).
 *
 * @param bbox3857 지도에서 고른 범위 (EPSG:3857)
 * @param commonOrigin 지형 메쉬의 원점(정수 m, 5179)
 * @returns 폴리곤 목록(xy 는 공통 원점 mm 의 새 배열), 받은 파일 수, 중복으로 뺀 수
 */
export const loadForest = async (
    bbox3857: Extent,
    commonOrigin: [number, number],
): Promise<{ polys: ForestPolygon[]; files: number; duplicates: number }> => {
    const q = await getTtpSheetsInBbox(bbox3857)
    const entryById5k = await loadForestSheets([...new Set(q.sheets.map((s) => s.id5k.slice(0, 5)))])
    const targets = q.sheets.map((s) => entryById5k.get(s.id5k)).filter((e): e is ForestSheet5k => !!e && e.n_poly > 0)
    const files = await Promise.all(targets.map((t) => fetchFrsCached(t.path)))

    const seen = new Set<number>()
    const polys: ForestPolygon[] = []
    let duplicates = 0
    for (const file of files) {
        const dx = (file.origin[0] - commonOrigin[0]) * 1000
        const dy = (file.origin[1] - commonOrigin[1]) * 1000
        for (const p of file.polys) {
            if (p.flags & FOREST_FLAG.duplicated) {
                if (seen.has(p.id)) {
                    duplicates++
                    continue
                }
                seen.add(p.id)
            }
            const xy = new Int32Array(p.xy.length)
            for (let i = 0; i < xy.length; i += 2) {
                xy[i] = p.xy[i] + dx
                xy[i + 1] = p.xy[i + 1] + dy
            }
            polys.push({ ...p, xy })
        }
    }
    return { polys, files: files.length, duplicates }
}
