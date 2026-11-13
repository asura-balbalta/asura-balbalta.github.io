import { boundsAt, dataTier, fetchGunzip, JsonMemo, jsonFetcher, Layer5k, shiftXy, XyBounds, xyBoundsMm } from "./terrainData"

/**
 * 녹지 레이어(osm_green, GRN1. OpenStreetMap 녹지 태그 9종을 분류 6종으로 묶은 것) base URL. 경로 규칙은 ttp·buildings·roads·water·forest 와
 * 같고 base 만 다르다(서버 README 13절). 운영(R2 커스텀 도메인)이 기본값. 개발 서버 데이터로 보려면 `${TERRAIN_API}/osm_green`.
 * 격자(5K bbox·1K corners)는 ttp 인덱스를 그대로 쓰고, osm_green 인덱스 `{50K}.json` 은 5K 마다 path·크기·조각·정점·분류별 수만 준다.
 *
 * 형식 요약(GRN1, 리틀 엔디언, gzip 을 푼 뒤. README 13.1):
 * 헤더 32 B(매직 `GRN1`, 5K 번호 u32, 원점 x·y int32 정수 m(ESRI:102080), 조각 수 P, 정점 합 ΣV, 구멍 수 합 ΣH, genFlags) →
 * 조각 헤더 **16 B** × P(srcId u32, n_pts u32, n_holes u16, class·tag·leaf·flags u8, 예약 u16) → 구멍 길이 u32 × ΣH →
 * 정점 int32 × 2ΣV(파일 원점 기준 mm. 조각마다 외곽 → 구멍, 외곽 CCW·구멍 CW, 닫는 점 없음). 외곽 점 수 = n_pts − Σholes.
 *
 * forest(FRS1)와 다른 점:
 * - 조각 헤더가 24 B 가 아니라 16 B 다(속성이 분류·원 태그·leaf_type 뿐).
 * - 폴리곤이 **5K 경계에서 잘려** 있다(water 방식, 복제 없음). 한 원 폴리곤의 조각들은 같은 srcId 이고 flags bit0 이 켜진다.
 *   그래서 도엽에서 합칠 때 **중복 제거를 하지 않는다**(forest 는 flags & 1 을 id 로 거른다).
 * - OSM 원본 그대로라 같은 자리에 조각이 겹칠 수 있다(natural=wood + landuse=forest, 공원 안 숲). 여기서는 풀지 않고
 *   G2(5K 전처리)의 폴리곤 불리언(같은 분류 합집합 → 우선순위 빼기)이 처리한다.
 * - 파일 원점은 ttp 와 같은 정수 m 규칙이지만 값이 같은 5K 의 ttp 원점과 1–6 m 다르다(계획서 8.1절). 반드시 공통 원점으로 옮겨 쓴다.
 *
 * 출처: 서버 README 13절(`parseGrn` 참조 구현 13.2), 계획 docs/osm-green-layer-plan.md(1절 자료·2절 배관·8.1절 파서 검산).
 * 라이선스 ODbL 1.0. 지도 표시 문구는 인덱스 sheets50k.json 의 attribution.short 를 읽는다(G6, 여기서는 받지 않는다)
 */
export const OSM_GREEN_BASE = "https://layers.asrbbt.world/osm_green"

/** 조각 flags 비트(README 13.1, codes.json flags) */
export const GREEN_FLAG = {
    /** 원 폴리곤이 다른 5K 에도 이어짐(5K 경계에서 잘린 조각, 같은 srcId). 중복이 아니다 */
    continued: 1,
    /** OSM MultiPolygon 을 나눈 파트 */
    multipart: 2,
} as const

/** 분류(class) 코드(codes.json green_class). 0 은 쓰지 않는다 */
export const GREEN_CLASS = {
    forest: 1,
    scrub: 2,
    heath: 3,
    grassland: 4,
    park: 5,
    orchard: 6,
} as const

/** 분류 수(1 ~ 6). 분류별 배열은 길이 GREEN_CLASS_COUNT + 1 로 잡고 코드를 그대로 첨자로 쓴다 */
export const GREEN_CLASS_COUNT = 6

/**
 * 녹지 조각 하나(OSM 녹지 폴리곤 파트를 5K 경계에서 자른 것). parseGrn 결과에서는 xy 가 파일 원점 기준 mm 의 view(파일 버퍼),
 * greenInTile 결과에서는 공통 원점 기준 mm 의 새 Int32Array 다
 */
export type GreenPiece = {
    /** 원 폴리곤(파트) 번호. 잘린 조각들이 같은 값. OSM 객체 번호·이름은 서버 대조표에만 있다 */
    srcId: number
    /** 정점 수(외곽 + 구멍, 닫는 점 제외) */
    nPts: number
    /** GREEN_CLASS 코드(1 ~ 6) */
    cls: number
    /** 원 태그 코드(1 ~ 9, codes.json tag) */
    tag: number
    /** leaf_type 코드(0 없음 · 1 broadleaved · 2 needleleaved · 3 mixed · 4 leafless · 5 그 밖. 거의 다 0) */
    leaf: number
    /** GREEN_FLAG 비트 */
    flags: number
    /** 구멍마다 점 수. xy 는 외곽(처음 nPts − Σholes 점) → 구멍 순 */
    holes: number[]
    /** (x, y) 연속, mm 정수. 외곽 CCW, 구멍 CW, 닫는 점 없음 */
    xy: Int32Array
}

/** GRN1 파일 하나. 좌표는 파일 원점 기준 mm(파일 버퍼의 view) */
export type GrnFile = {
    id5k: string
    /** 파일 원점(ESRI:102080, 정수 m). 같은 5K 의 ttp 원점과 1–6 m 다르다 */
    origin: [number, number]
    /** v1 = 1(bit0: 5K 경계로 자름, 1 mm 격자) */
    genFlags: number
    pieces: GreenPiece[]
}

/**
 * GRN1 파일(gzip 을 푼 뒤)을 파싱한다. 서버 README 13.2 의 참조 구현과 같고, parseFrs 처럼 길이 합(32 + 16P + 4ΣH + 8ΣV = 파일 길이)과
 * 끝에서 ΣV·ΣH 를 다시 검사해 어긋나면 던진다. 2026-11-08 확인(G0): 세 장 모두 길이·합·외곽 CCW·구멍 CW·인덱스가 맞다(계획서 8.1절)
 *
 * @param buf 리틀 엔디언 바이너리
 * @returns 파일 원점과 조각 목록(xy 는 파일 원점 기준 mm 의 view)
 */
export const parseGrn = (buf: ArrayBuffer): GrnFile => {
    const dv = new DataView(buf)
    if (buf.byteLength < 32 || String.fromCharCode(...new Uint8Array(buf, 0, 4)) !== "GRN1") throw new Error("GRN1 파일이 아님")
    const id5k = String(dv.getUint32(4, true)).padStart(8, "0")
    const origin: [number, number] = [dv.getInt32(8, true), dv.getInt32(12, true)]
    const P = dv.getUint32(16, true), V = dv.getUint32(20, true), H = dv.getUint32(24, true), genFlags = dv.getUint32(28, true)
    let off = 32
    const hdr = off
    off += 16 * P
    const holeOff = off
    off += 4 * H
    const xyOff = off
    off += 8 * V
    if (off !== buf.byteLength) throw new Error(`GRN1 길이 불일치: 헤더 합 ${off} B, 파일 ${buf.byteLength} B`)
    const holeLen = new Uint32Array(buf, holeOff, H)
    const xy = new Int32Array(buf, xyOff, 2 * V)

    const pieces: GreenPiece[] = []
    let v0 = 0, h0 = 0
    for (let k = 0; k < P; k++) {
        const b = hdr + 16 * k
        const nPts = dv.getUint32(b + 4, true)
        const nHoles = dv.getUint16(b + 8, true)
        pieces.push({
            srcId: dv.getUint32(b, true),
            nPts,
            cls: dv.getUint8(b + 10),
            tag: dv.getUint8(b + 11),
            leaf: dv.getUint8(b + 12),
            flags: dv.getUint8(b + 13),
            holes: Array.from(holeLen.subarray(h0, h0 + nHoles)),
            xy: xy.subarray(2 * v0, 2 * (v0 + nPts)),
        })
        v0 += nPts
        h0 += nHoles
    }
    if (v0 !== V || h0 !== H) throw new Error(`GRN1 합 불일치: 정점 ${v0}/${V}, 구멍 ${h0}/${H}`)
    return { id5k, origin, genFlags, pieces }
}

/** `{base}/index/v1/codes.json`: 코드 → 이름(키는 코드 값 문자열). tag_class 는 원 태그 → 분류 코드 */
type GreenCodes = {
    green_class?: Record<string, string>
    tag?: Record<string, string>
    tag_class?: Record<string, number>
    leaf?: Record<string, string>
}

/** 코드 값 → 이름 표(길이 256, 없으면 ""). loadGreenCodes 가 채운다 */
export type GreenCodeNames = {
    /** 분류 이름(1 숲 · 2 관목 · 3 황야 · 4 초지 · 5 공원 · 6 과수원) */
    classNames: string[]
    /** 원 태그(`natural=wood` 등) */
    tagNames: string[]
    /** leaf_type 이름 */
    leafNames: string[]
}

/** `{base}/index/v1/{50K}.json` 의 5K 항목(README 13.3) */
export type GreenSheet5kEntry = {
    id5k: string
    path: string
    gz_bytes: number
    n_pieces: number
    n_pts: number
    n_holes: number
    n_cut: number
    n_class1: number
    n_class2: number
    n_class3: number
    n_class4: number
    n_class5: number
    n_class6: number
    area_m2: number
}

/** `{base}/index/v1/{50K}.json` */
type GreenSheet50k = { id50k: string; sheets: GreenSheet5kEntry[] }

/** 도엽이 쓸 녹지 5K 하나(Layer5k 에 인덱스의 조각 수·gzip 크기를 덧붙인 것. 조정자 → 보조 워커 일감에 그대로 실린다) */
export type GreenSheet = Layer5k & { nPieces: number; gzBytes: number }

const fetchJson = jsonFetcher("osm_green")

const namesOf = (codes: Record<string, string> | undefined) => {
    const names = new Array<string>(256).fill("")
    for (const [code, name] of Object.entries(codes ?? {})) {
        const n = Number(code)
        if (Number.isInteger(n) && n >= 0 && n < 256) names[n] = name
    }
    return names
}

/** 이름 표가 없을 때(검증 스크립트 등) 쓰는 빈 코드 표 */
export const emptyGreenCodeTable = (): GreenCodeNames => ({
    classNames: new Array<string>(256).fill(""),
    tagNames: new Array<string>(256).fill(""),
    leafNames: new Array<string>(256).fill(""),
})

/** codes.json 을 받아 코드 값 → 이름 표를 만든다(모듈 캐시. 한 번만 받는다) */
export const loadGreenCodes = async (): Promise<GreenCodeNames> => {
    const codes = await fetchJson.fixed<GreenCodes>(`${OSM_GREEN_BASE}/index/v1/codes.json`)
    return { classNames: namesOf(codes.green_class), tagNames: namesOf(codes.tag), leafNames: namesOf(codes.leaf) }
}

/**
 * 도엽이 쓸 녹지 5K(조정자가 도엽마다 부른다. layerSheets.ts 의 SHEETS_OF 규약, forestSheetsOf 와 같은 시그니처). sheets 는 도엽 3857 bbox 로
 * ttp 인덱스에서 고른 5K(그 순서). 녹지 50K 인덱스에서 `n_pieces > 0` 인 것만 같은 순서로 남긴다(녹지 없는 5K 710개는 32 B 헤더만).
 * memo 는 조정자의 묶음 동안 인덱스를 쥐는 곳
 */
export const greenSheetsOf = async (sheets: { id5k: string }[], memo?: JsonMemo): Promise<GreenSheet[]> => {
    const ids50k = [...new Set(sheets.map((s) => s.id5k.slice(0, 5)))]
    const indexes = await Promise.all(ids50k.map((id50k) => fetchJson.index50k<GreenSheet50k>(`${OSM_GREEN_BASE}/index/v1/${id50k}.json`, memo)))
    const entryById5k = new Map(indexes.flatMap((ix) => ix.sheets.map((s) => [String(s.id5k), s] as const)))
    return sheets
        .map((s) => entryById5k.get(s.id5k))
        .filter((e): e is GreenSheet5kEntry => !!e && e.n_pieces > 0)
        .map((e) => ({ id5k: String(e.id5k), path: e.path, nPieces: e.n_pieces, gzBytes: e.gz_bytes }))
}

/** 녹지 데이터 층 항목(5K 하나, 파일 원점). bounds 는 조각마다 파일 mm 범위(xyBoundsMm, 4개씩) */
export type Green5k = { file: GrnFile; bounds: Float64Array; bytes: number }
const greenTier = dataTier<Green5k>("osm_green")
/** 녹지 5K 파일을 받아 파싱·전처리(데이터 층. 같은 5K 는 다시 받지 않는다). 바이트는 forest 와 같게 gunzip 한 파일 + bounds */
export const fetchGreen5k = (s: Layer5k) =>
    greenTier(s.path, async () => {
        const buf = await fetchGunzip(`${OSM_GREEN_BASE}/${s.path}`)
        const file = parseGrn(buf)
        const bounds = xyBoundsMm(file.pieces)
        return { file, bounds, bytes: buf.byteLength + bounds.byteLength }
    })

/**
 * 도엽의 녹지 조각. entries 는 도엽이 걸치는 5K 들(조정자 순서). 그 순서로 합치며 **중복 제거는 하지 않는다**(조각은 5K 경계에서 잘려 있고
 * 복제가 없다. water 와 같음. 같은 srcId 가 여러 조각이어도 각각 다른 자리다). touches 가 고른 것만(도엽 bbox 에 닿는 조각) 공통 원점으로 옮긴다.
 * 판정에 주는 범위는 공통 원점 m(boundsAt). 겹침(OSM 원본의 같은 자리 폴리곤)은 풀지 않는다(G2 의 불리언).
 *
 * 반환 좌표: **공통 원점 기준 mm 정수 Int32Array**(GreenPiece.xy 를 옮긴 새 배열. 다른 레이어의 InTile 과 같다). 파일 원점과 공통 원점이 모두
 * 정수 m 이라 이동이 정확하다(dx = (file.origin − commonOrigin) × 1000). m 로 쓸 때는 1000 으로 나눈다. 고리 구성은 GreenPiece 와 같다
 * (처음 nPts − Σholes 점이 외곽 CCW, 이어서 holes[i] 점씩 구멍 CW)
 *
 * @param commonOrigin 지형 메쉬의 원점(정수 m, 5179)
 * @param touches 조각 bbox(공통 원점 m)가 도엽에 닿는지
 */
export const greenInTile = (entries: Green5k[], commonOrigin: [number, number], touches: (b: XyBounds) => boolean): GreenPiece[] => {
    const pieces: GreenPiece[] = []
    for (const { file, bounds } of entries) {
        const dx = (file.origin[0] - commonOrigin[0]) * 1000
        const dy = (file.origin[1] - commonOrigin[1]) * 1000
        file.pieces.forEach((p, k) => {
            if (touches(boundsAt(bounds, k, dx, dy))) pieces.push({ ...p, xy: shiftXy(p.xy, dx, dy) })
        })
    }
    return pieces
}
