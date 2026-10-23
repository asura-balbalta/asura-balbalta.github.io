import { dataTier, fetchGunzip, JsonMemo, jsonFetcher, Layer5k, shiftXy } from "./terrainData"
import { emptyWaterCodeNames, WaterCodeNames } from "./waterTable"

/**
 * 물 레이어(water, WTR1) base URL. 경로 규칙은 ttp·buildings·roads 와 같고 base 만 다르다(안내문 2026-10-22 1절).
 * 운영(R2 커스텀 도메인)이 기본값. 개발 서버 데이터로 보려면 `${TERRAIN_API}/water`.
 * 격자(5K bbox·1K corners)는 ttp 인덱스를 그대로 쓰고, water 인덱스 `{50K}.json` 은 5K 마다 path·names_path·크기·조각·선 수만 준다.
 * 계획: docs/water-layer-plan.md
 */
export const WATER_BASE = "https://layers.asrbbt.world/water"

/** 코드 상수(kind·flags)는 의존성 없는 waterTable.ts 에 있다(내보내기 Worker 가 proj4 를 끌어오지 않게). 여기서 다시 내보낸다 */
export { RIVER_SE, WATER_KIND, WATER_LINE_FLAG, WATER_PIECE_FLAG } from "./waterTable"

/**
 * 수면 조각 하나(실폭하천·호소 폴리곤을 5K 경계에서 자른 것). 한 수역(srcId)은 걸친 5K 마다 조각으로 나뉘고 **복제가 없다**(bfp·rds 와 다름.
 * 합칠 때 중복 제거를 하지 않는다). xy 는 공통 원점 기준 mm 정수
 */
export type WaterPiece = {
    /** 수역(원 폴리곤) 전국 고유 번호. 잘린 조각들이 같은 값 */
    srcId: number
    /** 이름 표 id(0 = 없음. 호소 이름) */
    nameId: number
    /** WATER_KIND river(1) · lake(2) */
    kind: number
    /** WATER_PIECE_FLAG 비트 */
    flags: number
    /** 이 수역의 전국 조각 수(1 = 안 잘림) */
    srcNPieces: number
    /** 구멍마다 점 수. xy 는 외곽(처음 nPts − Σholes 점) → 구멍 순 */
    holes: number[]
    /** (x, y) 연속, mm 정수. 외곽 CCW, 구멍 CW, 닫는 점 없음 */
    xy: Int32Array
}

/** 하천중심선 하나(국가·지방·소하천·기타. 이름·등급용. 5K 경계에서 잘림). xy 는 공통 원점 기준 mm 정수 */
export type WaterLine = {
    id: number
    /** 이름 표 id(하천 이름·번호) */
    nameId: number
    /** RIVER_SE 코드 */
    riverSe: number
    /** WATER_LINE_FLAG 비트 */
    flags: number
    /** (x, y) 연속, mm 정수 */
    xy: Int32Array
}

/** WTR1 파일 하나. 좌표는 파일 원점 기준 mm(파일 버퍼의 view) */
export type WtrFile = {
    id5k: string
    /** 파일 원점(ESRI:102080, 정수 m) */
    origin: [number, number]
    genFlags: number
    pieces: WaterPiece[]
    lines: WaterLine[]
}

/**
 * WTR1 파일(gzip 을 푼 뒤)을 파싱한다. 안내문 3절의 참조 구현과 같다.
 *
 * 헤더 40 B(매직, 5K 번호, 원점 x·y, 조각 수 P, 조각 정점 합 V, 구멍 수 합 H, 선 수 L, 선 점 수 합 C, genFlags) →
 * 조각 헤더 24 B × P → 선 헤더 16 B × L → 구멍 길이 u32 × H → 조각 정점 i32 × 2V → 선 점 i32 × 2C.
 * 2026-10-22 확인: 서울 표본의 헤더·배열 크기 합이 파일 길이와 같고 외곽 CCW·구멍 CW 가 지켜진다(docs/water-layer-plan.md 1절).
 * 조각 헤더의 waterZ(f32, v1 은 전부 NaN)는 읽지 않는다(높이는 프론트가 지형에서 잰다. 2026-10-22 결정 by @nanangqq)
 *
 * @param buf 리틀 엔디언 바이너리
 * @returns 파일 원점과 조각·선 목록(xy 는 파일 원점 기준 mm 의 view)
 */
export const parseWtr = (buf: ArrayBuffer): WtrFile => {
    const dv = new DataView(buf)
    if (String.fromCharCode(...new Uint8Array(buf, 0, 4)) !== "WTR1") throw new Error("WTR1 파일이 아님")
    const id5k = String(dv.getUint32(4, true)).padStart(8, "0")
    const origin: [number, number] = [dv.getInt32(8, true), dv.getInt32(12, true)]
    const P = dv.getUint32(16, true), V = dv.getUint32(20, true), H = dv.getUint32(24, true)
    const L = dv.getUint32(28, true), C = dv.getUint32(32, true), genFlags = dv.getUint32(36, true)
    let off = 40
    const pieceHdr = off
    off += 24 * P
    const lineHdr = off
    off += 16 * L
    const holeLen = new Uint32Array(buf, off, H)
    off += 4 * H
    const pieceXY = new Int32Array(buf, off, 2 * V)
    off += 8 * V
    const lineXY = new Int32Array(buf, off, 2 * C)
    off += 8 * C
    if (off !== buf.byteLength) throw new Error(`WTR1 길이 불일치: 헤더 합 ${off} B, 파일 ${buf.byteLength} B`)

    const pieces: WaterPiece[] = []
    let v0 = 0, h0 = 0
    for (let k = 0; k < P; k++) {
        const o = pieceHdr + 24 * k
        const nPts = dv.getUint32(o + 4, true)
        const nHoles = dv.getUint8(o + 19)
        pieces.push({
            srcId: dv.getUint32(o, true),
            nameId: dv.getUint32(o + 8, true),
            srcNPieces: dv.getUint16(o + 16, true),
            kind: dv.getUint8(o + 18),
            flags: dv.getUint8(o + 20),
            holes: Array.from(holeLen.subarray(h0, h0 + nHoles)),
            xy: pieceXY.subarray(2 * v0, 2 * (v0 + nPts)),
        })
        v0 += nPts
        h0 += nHoles
    }
    const lines: WaterLine[] = []
    let c0 = 0
    for (let k = 0; k < L; k++) {
        const o = lineHdr + 16 * k
        const nPts = dv.getUint32(o + 4, true)
        lines.push({
            id: dv.getUint32(o, true),
            nameId: dv.getUint32(o + 8, true),
            riverSe: dv.getUint8(o + 12),
            flags: dv.getUint8(o + 13),
            xy: lineXY.subarray(2 * c0, 2 * (c0 + nPts)),
        })
        c0 += nPts
    }
    return { id5k, origin, genFlags, pieces, lines }
}

/** `{base}/index/v1/codes.json`: 코드 → 한글 이름 */
type WaterCodes = {
    kind?: Record<string, string>
    river_se?: Record<string, string>
    piece_flags?: Record<string, string>
    line_flags?: Record<string, string>
}

/** `{base}/index/v1/{50K}.json` */
type WaterSheet50k = {
    id50k: string
    sheets: { id5k: string; path: string; names_path?: string; gz_bytes: number; n_pieces: number; n_lines: number }[]
}

/** `{base}/names/v1/{50K}/{5K}.json.gz`(gzip JSON 평행 배열. 그 5K 의 조각·선이 참조하는 nameId 만) */
type WaterNamesFile = { id5k: string; n: number; name_id: number[]; name: string[]; river_no: string[] }

/** 이름 표: nameId → 이름·하천 번호(호소는 river_no 가 빈 문자열). 5K 마다 받아 합친다(같은 id 는 같은 이름) */
export type WaterNames = Map<number, { name: string; riverNo: string }>

const fetchJson = jsonFetcher("water")

const namesOf = (codes: Record<string, string> | undefined) => {
    const names = new Array<string>(256).fill("")
    for (const [code, name] of Object.entries(codes ?? {})) {
        const n = Number(code)
        if (Number.isInteger(n) && n >= 0 && n < 256) names[n] = name
    }
    return names
}

/** 이름 표가 없을 때(검증 스크립트 등) 쓰는 빈 코드 표 */
export const emptyWaterCodeTable = emptyWaterCodeNames

/** codes.json 을 받아 코드 값 → 한글 이름 표를 만든다(모듈 캐시) */
export const loadWaterCodes = async (): Promise<WaterCodeNames> => {
    const codes = await fetchJson.fixed<WaterCodes>(`${WATER_BASE}/index/v1/codes.json`)
    return { kindNames: namesOf(codes.kind), riverSeNames: namesOf(codes.river_se) }
}

/**
 * 도엽이 쓸 물 5K(조정자가 도엽마다 부른다. layerSheets.ts, C2 2026-10-23). sheets 는 도엽 3857 bbox 로 ttp 인덱스에서 고른 5K(그 순서).
 * 물 50K 인덱스에서 조각·선이 하나라도 있는 것만 같은 순서로 남긴다(`n_pieces == 0 && n_lines == 0` 은 40 B 빈 파일). 이름 파일(names_path)이
 * 있으면 같이 싣는다(C2 전 loadWater 의 targets 와 같다). memo 는 조정자의 묶음 동안 인덱스를 쥐는 곳
 */
export const waterSheetsOf = async (sheets: { id5k: string }[], memo?: JsonMemo): Promise<Layer5k[]> => {
    const ids50k = [...new Set(sheets.map((s) => s.id5k.slice(0, 5)))]
    const indexes = await Promise.all(ids50k.map((id50k) => fetchJson.index50k<WaterSheet50k>(`${WATER_BASE}/index/v1/${id50k}.json`, memo)))
    const entryById5k = new Map(indexes.flatMap((ix) => ix.sheets.map((s) => [String(s.id5k), s] as const)))
    return sheets
        .map((s) => entryById5k.get(s.id5k))
        .filter((e): e is NonNullable<typeof e> => !!e && (e.n_pieces > 0 || e.n_lines > 0))
        .map((e) => (e.names_path ? { id5k: String(e.id5k), path: e.path, names: e.names_path } : { id5k: String(e.id5k), path: e.path }))
}

/** 물 데이터 층 항목(5K 하나, 파일 원점). names 는 그 5K 이름 파일의 nameId 표(없으면 null) */
export type Water5k = { file: WtrFile; names: WaterNames | null; bytes: number }
const waterTier = dataTier<Water5k>("water")
/** 물 5K 파일(과 이름 파일)을 받아 파싱(데이터 층. 같은 5K 는 다시 받지 않는다) */
export const fetchWater5k = (s: Layer5k) =>
    waterTier(s.path, async () => {
        const [buf, namesBuf] = await Promise.all([fetchGunzip(`${WATER_BASE}/${s.path}`), s.names ? fetchGunzip(`${WATER_BASE}/${s.names}`) : null])
        let names: WaterNames | null = null
        if (namesBuf) {
            const json = JSON.parse(new TextDecoder().decode(namesBuf)) as WaterNamesFile
            names = new Map()
            for (let i = 0; i < json.name_id.length; i++) names.set(json.name_id[i], { name: json.name[i] ?? "", riverNo: json.river_no?.[i] ?? "" })
        }
        return { file: parseWtr(buf), names, bytes: buf.byteLength + (namesBuf?.byteLength ?? 0) }
    })

/**
 * 도엽의 수면 조각·하천선(안내문 4절 1, C2 2026-10-23). entries 는 도엽이 걸치는 5K 들(조정자 순서). 그 순서로 모두 공통 원점 mm 로 옮긴다.
 * **중복 제거는 하지 않는다**(조각은 5K 경계에서 잘려 있고 복제가 없다). 이름 표는 5K 마다의 표를 합친다(같은 id 는 앞 5K 의 것).
 * 범위 안팎 선별은 하지 않는다(waterMesh 가 도엽 폴리곤으로 자르고, 폴리곤 안 선분 판정에 조각 전부가 필요하다). C2 전 loadWater 와 같은 결과·순서
 *
 * @param commonOrigin 지형 메쉬의 원점(정수 m, 5179)
 */
export const waterOfTile = (entries: Water5k[], commonOrigin: [number, number]): { pieces: WaterPiece[]; lines: WaterLine[]; names: WaterNames } => {
    const pieces: WaterPiece[] = []
    const lines: WaterLine[] = []
    for (const { file } of entries) {
        const dx = (file.origin[0] - commonOrigin[0]) * 1000
        const dy = (file.origin[1] - commonOrigin[1]) * 1000
        for (const p of file.pieces) pieces.push({ ...p, xy: shiftXy(p.xy, dx, dy) })
        for (const l of file.lines) lines.push({ ...l, xy: shiftXy(l.xy, dx, dy) })
    }
    const names: WaterNames = new Map()
    for (const e of entries) if (e.names) for (const [id, v] of e.names) if (!names.has(id)) names.set(id, v)
    return { pieces, lines, names }
}
