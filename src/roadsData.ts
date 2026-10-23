import { emptyRoadCodeNames, ROAD_FACE_FLAG, ROAD_LINE_FLAG, RoadCodeNames } from "./roadTable"
import { boundsAt, dataTier, fetchGunzip, JsonMemo, jsonFetcher, Layer5k, shiftXy, XyBounds, xyBoundsMm } from "./terrainData"

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

const fetchJson = jsonFetcher("roads")

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
    const codes = await fetchJson.fixed<RoadCodes>(`${ROADS_BASE}/index/v1/codes.json`)
    return {
        roadSeNames: namesOf(codes.road_se),
        facilityNames: namesOf(codes.tfceqp),
        pavementNames: namesOf(codes.pmtr),
        statusNames: namesOf(codes.usgstt),
    }
}

/**
 * 도엽이 쓸 도로 5K(조정자가 도엽마다 부른다. layerSheets.ts, C2 2026-10-23). sheets 는 도엽 3857 bbox 로 ttp 인덱스에서 고른 5K(그 순서).
 * 도로 50K 인덱스에서 조각·선이 하나라도 있는 것만 같은 순서로 남긴다(C2 전 loadRoads 의 targets 와 같다). memo 는 조정자의 묶음 동안 인덱스를 쥐는 곳
 */
export const roadsSheetsOf = async (sheets: { id5k: string }[], memo?: JsonMemo): Promise<Layer5k[]> => {
    const ids50k = [...new Set(sheets.map((s) => s.id5k.slice(0, 5)))]
    const indexes = await Promise.all(ids50k.map((id50k) => fetchJson.index50k<RoadsSheet50k>(`${ROADS_BASE}/index/v1/${id50k}.json`, memo)))
    const entryById5k = new Map(indexes.flatMap((ix) => ix.sheets.map((s) => [String(s.id5k), s] as const)))
    return sheets
        .map((s) => entryById5k.get(s.id5k))
        .filter((e): e is NonNullable<typeof e> => !!e && (e.n_faces > 0 || e.n_lines > 0))
        .map((e) => ({ id5k: String(e.id5k), path: e.path }))
}

/** 도로 데이터 층 항목(5K 하나, 파일 원점). faceBounds·lineBounds 는 조각·선마다 파일 mm 범위(xyBoundsMm) */
export type Roads5k = { file: RdsFile; faceBounds: Float64Array; lineBounds: Float64Array; bytes: number }
const roadsTier = dataTier<Roads5k>("roads")
/** 도로 5K 파일을 받아 파싱·전처리(데이터 층. 같은 5K 는 다시 받지 않는다) */
export const fetchRoads5k = (s: Layer5k) =>
    roadsTier(s.path, async () => {
        const buf = await fetchGunzip(`${ROADS_BASE}/${s.path}`)
        const file = parseRds(buf)
        const faceBounds = xyBoundsMm(file.faces)
        const lineBounds = xyBoundsMm(file.lines)
        return { file, faceBounds, lineBounds, bytes: buf.byteLength + faceBounds.byteLength + lineBounds.byteLength }
    })

/**
 * 도엽의 도로 조각·선(전달 문서 4절 1, C2 2026-10-23). entries 는 도엽이 걸치는 5K 들(조정자 순서). 그 순서로 합치며 flags 의 duplicated
 * 비트가 있는 조각·선은 id 로 처음 것만 남기고(조각·선 따로. 도엽 밖 것도 중복 판정에는 들어간다), keepFace·keepLine 이 고른 것만 공통 원점 mm 로
 * 옮긴다. 판정에 주는 범위는 공통 원점 m(C2 전 5K 목록의 xyBounds 와 같은 값. boundsAt). C2 전 loadRoads + buildTile 거르기와 같은 결과·순서
 *
 * @param commonOrigin 지형 메쉬의 원점(정수 m, 5179)
 */
export const roadsInTile = (
    entries: Roads5k[],
    commonOrigin: [number, number],
    keepFace: (f: RoadFace, b: XyBounds) => boolean,
    keepLine: (l: RoadLine, b: XyBounds) => boolean,
): { faces: RoadFace[]; lines: RoadLine[] } => {
    const seenFaces = new Set<number>()
    const seenLines = new Set<number>()
    const faces: RoadFace[] = []
    const lines: RoadLine[] = []
    for (const { file, faceBounds, lineBounds } of entries) {
        const dx = (file.origin[0] - commonOrigin[0]) * 1000
        const dy = (file.origin[1] - commonOrigin[1]) * 1000
        file.faces.forEach((f, k) => {
            if (f.flags & ROAD_FACE_FLAG.duplicated) {
                if (seenFaces.has(f.id)) return
                seenFaces.add(f.id)
            }
            if (keepFace(f, boundsAt(faceBounds, k, dx, dy))) faces.push({ ...f, xy: shiftXy(f.xy, dx, dy) })
        })
        file.lines.forEach((l, k) => {
            if (l.flags & ROAD_LINE_FLAG.duplicated) {
                if (seenLines.has(l.id)) return
                seenLines.add(l.id)
            }
            if (keepLine(l, boundsAt(lineBounds, k, dx, dy))) lines.push({ ...l, xy: shiftXy(l.xy, dx, dy) })
        })
    }
    return { faces, lines }
}
