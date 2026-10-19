import type { Extent } from "ol/extent"

import { emptyRoadCodeNames, ROAD_FACE_FLAG, ROAD_LINE_FLAG, RoadCodeNames } from "./roadTable"
import { fetchGunzip } from "./terrainData"
import { getTtpSheetsInBbox } from "./terrainIndex"

/**
 * 도로 레이어(roads, RDS1) base URL. 경로 규칙은 ttp·buildings 와 같고 base 만 다르다(서버 readme 10절, 전달 문서 2026-10-17).
 * 운영(R2 커스텀 도메인)이 기본값. 개발 서버 데이터로 보려면 `${TERRAIN_API}/roads`.
 * 격자(5K bbox·1K corners)는 ttp 인덱스를 그대로 쓰고, roads 인덱스 `{50K}.json` 은 5K 마다 path·크기·조각·선 수만 준다
 */
export const ROADS_BASE = "https://layers.asrbbt.world/roads"

/** 코드 상수(flags 비트·교통시설)는 의존성 없는 roadTable.ts 에 있다(내보내기 Worker 가 proj4 를 끌어오지 않게). 여기서 다시 내보낸다 */
export { ROAD_FACE_FLAG, ROAD_FACILITY, ROAD_LINE_FLAG } from "./roadTable"

/** 도로 면 조각 하나(차도경계면을 도로를 가로질러 20 ~ 60 m 마다 자른 토막). xy 는 공통 원점 기준 mm 정수 */
export type RoadFace = {
    /** 전국 고유 번호 */
    id: number
    /** 이 조각 속성의 출처인 이은 중심선의 id(RoadLine.id). 교량 높이 보간과 내보내기 그룹 단위 */
    lineId: number
    /** 폭(m). 0 이면 없음 */
    roadBt: number
    /** 도로구분 코드(codes.json road_se). 0 = 중심선 없음 */
    roadSe: number
    /** 차로 수 */
    cartrk: number
    /** 교통시설 코드(ROAD_FACILITY) */
    tfceqp: number
    /** 수직위상(교량 1, 터널 −1, 두 층 도로의 위아래) */
    phyLv: number
    /** ROAD_FACE_FLAG 비트 */
    flags: number
    /** 구멍마다 점 수. xy 는 외곽(처음 nPts − Σholes 점) → 구멍 순 */
    holes: number[]
    /** (x, y) 연속, mm 정수. 외곽 CCW, 구멍 CW, 닫는 점 없음 */
    xy: Int32Array
}

/** 이어 붙인 차도중심선 하나. xy 는 공통 원점 기준 mm 정수 */
export type RoadLine = {
    id: number
    /** 도로명 표 id(2차 이름 파일 예정). 0 이면 없음 */
    nameId: number
    roadBt: number
    roadSe: number
    cartrk: number
    /** 포장 코드(codes.json pmtr) */
    pmtr: number
    tfceqp: number
    phyLv: number
    /** 사용상태 코드(codes.json usgstt) */
    usgstt: number
    /** ROAD_LINE_FLAG 비트 */
    flags: number
    /** (x, y) 연속, mm 정수 */
    xy: Int32Array
}

/** RDS1 파일 하나. 좌표는 파일 원점 기준 mm(파일 버퍼의 view) */
export type RdsFile = {
    id5k: string
    /** 파일 원점(ESRI:102080, 정수 m) */
    origin: [number, number]
    genFlags: number
    faces: RoadFace[]
    lines: RoadLine[]
}

/**
 * RDS1 파일(gzip 을 푼 뒤)을 파싱한다. 전달 문서 3절의 참조 구현과 같다.
 *
 * 헤더 40 B(매직, 5K 번호, 원점 x·y, 조각 수 F, 조각 정점 합 V, 구멍 수 합 H, 선 수 L, 선 점 수 합 C, gen_flags) →
 * 조각 헤더 20 B × F → 선 헤더 24 B × L → 구멍 길이 u32 × H → 조각 정점 i32 × 2V → 선 점 i32 × 2C.
 * 2026-10-18 확인: 표본 4개 모두 헤더·배열 크기 합이 파일 길이와 같고 외곽 CCW·구멍 CW 가 지켜진다(docs/roads-layer-plan.md 1절)
 *
 * @param buf 리틀 엔디언 바이너리
 * @returns 파일 원점과 조각·선 목록(xy 는 파일 원점 기준 mm 의 view)
 */
export const parseRds = (buf: ArrayBuffer): RdsFile => {
    const dv = new DataView(buf)
    if (String.fromCharCode(...new Uint8Array(buf, 0, 4)) !== "RDS1") throw new Error("RDS1 파일이 아님")
    const id5k = String(dv.getUint32(4, true)).padStart(8, "0")
    const origin: [number, number] = [dv.getInt32(8, true), dv.getInt32(12, true)]
    const F = dv.getUint32(16, true), V = dv.getUint32(20, true), H = dv.getUint32(24, true)
    const L = dv.getUint32(28, true), C = dv.getUint32(32, true), genFlags = dv.getUint32(36, true)
    let off = 40
    const faceHdr = off
    off += 20 * F
    const lineHdr = off
    off += 24 * L
    const holeLen = new Uint32Array(buf, off, H)
    off += 4 * H
    const faceXY = new Int32Array(buf, off, 2 * V)
    off += 8 * V
    const lineXY = new Int32Array(buf, off, 2 * C)
    off += 8 * C
    if (off !== buf.byteLength) throw new Error(`RDS1 길이 불일치: 헤더 합 ${off} B, 파일 ${buf.byteLength} B`)

    const faces: RoadFace[] = []
    let v0 = 0, h0 = 0
    for (let k = 0; k < F; k++) {
        const o = faceHdr + 20 * k
        const nPts = dv.getUint32(o + 4, true)
        const nHoles = dv.getUint8(o + 18)
        faces.push({
            id: dv.getUint32(o, true),
            lineId: dv.getUint32(o + 8, true),
            roadBt: dv.getUint16(o + 12, true) / 10,
            roadSe: dv.getUint8(o + 14),
            cartrk: dv.getUint8(o + 15),
            tfceqp: dv.getUint8(o + 16),
            phyLv: dv.getInt8(o + 17),
            flags: dv.getUint8(o + 19),
            holes: Array.from(holeLen.subarray(h0, h0 + nHoles)),
            xy: faceXY.subarray(2 * v0, 2 * (v0 + nPts)),
        })
        v0 += nPts
        h0 += nHoles
    }
    const lines: RoadLine[] = []
    let c0 = 0
    for (let k = 0; k < L; k++) {
        const o = lineHdr + 24 * k
        const nPts = dv.getUint32(o + 4, true)
        lines.push({
            id: dv.getUint32(o, true),
            nameId: dv.getUint32(o + 8, true),
            roadBt: dv.getUint16(o + 12, true) / 10,
            roadSe: dv.getUint8(o + 14),
            cartrk: dv.getUint8(o + 15),
            pmtr: dv.getUint8(o + 16),
            tfceqp: dv.getUint8(o + 17),
            phyLv: dv.getInt8(o + 18),
            usgstt: dv.getUint8(o + 19),
            flags: dv.getUint8(o + 20),
            xy: lineXY.subarray(2 * c0, 2 * (c0 + nPts)),
        })
        c0 += nPts
    }
    return { id5k, origin, genFlags, faces, lines }
}

/** `{base}/index/v1/codes.json`: 코드 → 한글 이름 */
type RoadCodes = {
    road_se: Record<string, string>
    tfceqp: Record<string, string>
    pmtr: Record<string, string>
    usgstt: Record<string, string>
    face_flags?: Record<string, string>
    line_flags?: Record<string, string>
}

/** codes.json 에서 만든 이름 표(코드 값 → 한글 이름, 길이 256, 없으면 ""). 도로 표(RoadTable)에 실려 내보내기 속성에 쓴다 */
export type RoadCodeTable = RoadCodeNames

/** `{base}/index/v1/{50K}.json` */
type RoadsSheet50k = {
    id50k: string
    sheets: { id5k: string; path: string; gz_bytes: number; n_faces: number; n_lines: number }[]
}

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
export const emptyRoadCodeTable = emptyRoadCodeNames

/** codes.json 을 받아 코드 값 → 한글 이름 표 넷을 만든다(모듈 캐시) */
export const loadRoadCodes = async (): Promise<RoadCodeTable> => {
    const codes = await fetchJsonCached<RoadCodes>(`${ROADS_BASE}/index/v1/codes.json`)
    return {
        roadSeNames: namesOf(codes.road_se),
        facilityNames: namesOf(codes.tfceqp),
        pavementNames: namesOf(codes.pmtr),
        statusNames: namesOf(codes.usgstt),
    }
}

/** 파싱한 5K 도로 파일 캐시(path → 결과). 도엽 스트리밍이 도엽마다 부를 때 같은 5K 를 다시 받지 않게 */
const rdsCache = new Map<string, Promise<RdsFile>>()
const fetchRdsCached = (path: string) => {
    let p = rdsCache.get(path)
    if (!p) {
        p = fetchGunzip(`${ROADS_BASE}/${path}`).then(parseRds)
        rdsCache.set(path, p)
        p.catch(() => rdsCache.delete(path))
    }
    return p
}

/** 파일 원점 기준 mm 좌표를 공통 원점 기준으로 옮긴 새 배열 */
const shiftXy = (xy: Int32Array, dx: number, dy: number) => {
    const out = new Int32Array(xy.length)
    for (let i = 0; i < xy.length; i += 2) {
        out[i] = xy[i] + dx
        out[i + 1] = xy[i + 1] + dy
    }
    return out
}

/**
 * 선택 범위의 도로 조각·선을 받아 공통 원점 기준으로 합친다(전달 문서 4절 1).
 *
 * 1. ttp 인덱스로 범위에 걸린 5K 번호를 고른다(지형·건물과 같은 번호)
 * 2. 도로 50K 인덱스에서 그 5K 의 path 를 보고 조각·선이 하나라도 있는 것만 받는다
 * 3. 좌표를 공통 원점 mm 로 옮기고, flags 의 duplicated 비트가 있는 조각·선은 id 로 중복 제거
 * 범위 안팎 선별은 하지 않는다(지형 위에 얹을 때 지형 밖 조각이 걸러진다).
 *
 * @param bbox3857 지도에서 고른 범위 (EPSG:3857)
 * @param commonOrigin 지형 메쉬의 원점(정수 m, 5179)
 * @returns 조각·선 목록(xy 는 공통 원점 mm 의 새 배열)과 받은 파일 수
 */
export const loadRoads = async (
    bbox3857: Extent,
    commonOrigin: [number, number],
): Promise<{ faces: RoadFace[]; lines: RoadLine[]; files: number }> => {
    const q = await getTtpSheetsInBbox(bbox3857)
    const ids50k = [...new Set(q.sheets.map((s) => s.id5k.slice(0, 5)))]
    const indexes = await Promise.all(ids50k.map((id50k) => fetchJsonCached<RoadsSheet50k>(`${ROADS_BASE}/index/v1/${id50k}.json`)))
    const entryById5k = new Map(indexes.flatMap((ix) => ix.sheets.map((s) => [String(s.id5k), s] as const)))
    const targets = q.sheets
        .map((s) => entryById5k.get(s.id5k))
        .filter((e): e is NonNullable<typeof e> => !!e && (e.n_faces > 0 || e.n_lines > 0))
    const files = await Promise.all(targets.map((t) => fetchRdsCached(t.path)))

    const seenFaces = new Set<number>()
    const seenLines = new Set<number>()
    const faces: RoadFace[] = []
    const lines: RoadLine[] = []
    for (const file of files) {
        const dx = (file.origin[0] - commonOrigin[0]) * 1000
        const dy = (file.origin[1] - commonOrigin[1]) * 1000
        for (const f of file.faces) {
            if (f.flags & ROAD_FACE_FLAG.duplicated) {
                if (seenFaces.has(f.id)) continue
                seenFaces.add(f.id)
            }
            faces.push({ ...f, xy: shiftXy(f.xy, dx, dy) })
        }
        for (const l of file.lines) {
            if (l.flags & ROAD_LINE_FLAG.duplicated) {
                if (seenLines.has(l.id)) continue
                seenLines.add(l.id)
            }
            lines.push({ ...l, xy: shiftXy(l.xy, dx, dy) })
        }
    }
    return { faces, lines, files: files.length }
}
