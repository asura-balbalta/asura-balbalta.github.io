import { Extent } from "ol/extent"

import { retriangulate } from "./terrainRetri"

export const TERRAIN_API = "http://localhost:8000"
/** terrain_tile_mesh(5K 정적 파일) base URL. 운영에서는 R2 공개 주소로 바꾼다 */
export const TTM_BASE = `${TERRAIN_API}/ttm`

// 좌표는 모두 ESRI:102080(≈EPSG:5179) 절대좌표
export type TileInfo = {
    map_id: string
    name: string
    bbox: Extent
    corners: [number, number][]
}

export type TilesInBbox = {
    origin: [number, number]
    tiles: TileInfo[]
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

export const getTilesInBbox = async (
    bbox3857: Extent,
): Promise<TilesInBbox> => {
    const res = await fetch(
        `${TERRAIN_API}/tiles?bbox=${bbox3857.join(",")}&crs=3857`,
    )
    if (!res.ok) throw new Error(`/tiles ${res.status}: ${await res.text()}`)
    const { origin, tiles } = await res.json()
    console.log(`도엽 ${tiles.length}개`, tiles)
    return { origin, tiles }
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

/** /ttm/sheets 응답: 범위에 걸친 1K 목록과 받아야 할 5K 파일. path 는 ttm v1, ttp_path 는 ttp(terrainPslg) 파일 */
export type TtmSheetsInBbox = {
    origin: [number, number]
    tiles: (TileInfo & { id5k: string })[]
    sheets: { id5k: string; path: string; ttp_path: string; map_ids: string[] }[]
}

/** TTM1 파일 안의 1K 도엽 하나. 배열은 파일 버퍼를 가리키는 view 다 */
type TtmTile = {
    mapId: string
    /** 파일 원점 (ESRI:102080, 정수 m) */
    origin: [number, number]
    /** 정점 x, y: 파일 원점 기준 mm 정수 */
    xy: Int32Array
    /** 정점 표고(m) */
    z: Float32Array
    /** 삼각형: 이 1K 안의 지역 인덱스, CCW */
    triangles: Uint32Array
    /** 제약 선분(지역 인덱스 쌍): 도엽 외곽 체인 + 등고선. 둘을 구분하는 표시는 없다(v1) */
    segments: Uint32Array
}

/**
 * 범위에 걸친 1K 도엽과, 그 1K 들이 들어 있는 5K 파일 경로를 조회한다.
 * 개발 서버의 /ttm/sheets 를 쓴다(ttm 경로 전용). ttp 경로는 운영 정적 인덱스(terrainIndex.getTtpSheetsInBbox)를 쓴다.
 *
 * @param bbox3857 지도에서 고른 범위 [minX, minY, maxX, maxY] (EPSG:3857)
 * @returns 공통 원점, 걸친 1K 목록, 5K 파일 목록
 */
export const getTtmSheetsInBbox = async (bbox3857: Extent): Promise<TtmSheetsInBbox> => {
    const res = await fetch(
        `${TERRAIN_API}/ttm/sheets?bbox=${bbox3857.join(",")}&crs=3857`,
    )
    if (!res.ok) throw new Error(`/ttm/sheets ${res.status}: ${await res.text()}`)
    return res.json()
}

/**
 * 5K 파일(TTM1, 파일 전체가 gzip)을 받아 풀고 파싱한다.
 * 전송 압축(Content-Encoding)은 브라우저가 풀어 주고, 파일 자체의 gzip 은 여기서 DecompressionStream 으로 푼다.
 *
 * @param url 파일 URL ({TTM_BASE}/v1/{50K}/{5K}.ttm)
 * @returns 파일 원점과 1K 도엽 목록
 */
/** 지형 로딩의 단계. onProgress 로 알린다 */
export type LoadPhase = "sheets" | "download" | "merge" | "retriangulate"
export type LoadProgress = (phase: LoadPhase, done: number, total: number) => void

/** 파일 전체가 gzip 인 정적 파일을 받아 푼다(ttm·ttp 공용). 전송 압축은 브라우저가, 파일 gzip 은 여기서 푼다 */
export const fetchGunzip = async (url: string) => {
    const res = await fetch(url)
    if (!res.ok || !res.body) throw new Error(`${res.status} ${url}`)
    const raw = res.body.pipeThrough(new DecompressionStream("gzip"))
    return new Response(raw).arrayBuffer()
}

const fetchTtm = async (url: string) => parseTtm(await fetchGunzip(url))

/**
 * TTM1 바이너리를 1K 도엽 단위로 나눈다. 복사 없이 버퍼의 view 로 만든다.
 * 형식: 헤더 32B → 1K 목차(16B × T) → 정점 xy(int32 mm) → 정점 z(float32) → 삼각형(uint32) → segments(uint32)
 *
 * @param buf gzip 을 푼 파일 내용
 * @returns 파일 원점과 1K 도엽 목록(목차 순서)
 */
const parseTtm = (buf: ArrayBuffer) => {
    const dv = new DataView(buf)
    const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4))
    if (magic !== "TTM1") throw new Error("TTM1 파일이 아님")
    const nTiles = dv.getUint32(4, true)
    const N = dv.getUint32(8, true)
    const K = dv.getUint32(12, true)
    const origin: [number, number] = [dv.getInt32(20, true), dv.getInt32(24, true)]

    const M = dv.getUint32(16, true)
    let off = 32
    const toc: { mapId: string; nV: number; nT: number; nS: number }[] = []
    for (let i = 0; i < nTiles; i++, off += 16) {
        toc.push({
            mapId: String(dv.getUint32(off, true)),
            nV: dv.getUint32(off + 4, true),
            nT: dv.getUint32(off + 8, true),
            nS: dv.getUint32(off + 12, true),
        })
    }
    const xy = new Int32Array(buf, off, 2 * N)
    off += 8 * N
    const z = new Float32Array(buf, off, N)
    off += 4 * N
    const tri = new Uint32Array(buf, off, 3 * K)
    off += 12 * K
    const seg = new Uint32Array(buf, off, 2 * M)

    let v = 0
    let t = 0
    let s = 0
    const tiles: TtmTile[] = toc.map((e) => {
        const tile = {
            mapId: e.mapId,
            origin,
            xy: xy.subarray(2 * v, 2 * (v + e.nV)),
            z: z.subarray(v, v + e.nV),
            triangles: tri.subarray(3 * t, 3 * (t + e.nT)),
            segments: seg.subarray(2 * s, 2 * (s + e.nS)),
        }
        v += e.nV
        t += e.nT
        s += e.nS
        return tile
    })
    return { origin, tiles }
}

/** 이 거리(mm) 안에 양 끝이 있는 segment 는 도엽 외곽 체인으로 본다. 서버의 경계 정점 허용치(2mm)와 같다 */
const BORDER_TOL_MM = 2

/**
 * 절대좌표(mm)의 점에서 도엽 폴리곤 둘레까지의 거리(mm).
 *
 * @param xmm 점 x (ESRI:102080, mm)
 * @param ymm 점 y
 * @param corners 도엽 꼭지점(절대 m, 둘레 순서, /ttm/sheets 의 corners)
 */
const distToTileBorderMm = (xmm: number, ymm: number, corners: [number, number][]) => {
    let best = Infinity
    for (let i = 0; i < corners.length; i++) {
        const [ax, ay] = corners[i]
        const [bx, by] = corners[(i + 1) % corners.length]
        const AX = ax * 1000, AY = ay * 1000
        const dx = bx * 1000 - AX, dy = by * 1000 - AY
        let t = ((xmm - AX) * dx + (ymm - AY) * dy) / (dx * dx + dy * dy)
        t = Math.max(0, Math.min(1, t))
        best = Math.min(best, Math.hypot(xmm - (AX + t * dx), ymm - (AY + t * dy)))
    }
    return best
}

/**
 * 여러 1K 도엽(다른 5K 파일에서 온 것이 섞여도 됨)을 공통 원점 기준 메쉬 하나로 합친다.
 *
 * 이웃 도엽이 공유하는 경계 정점은 절대 mm 정수와 z 가 정확히 같으므로,
 * (x mm, y mm, z 의 float32 비트)가 같은 정점을 하나로 합친다. 허용 오차 비교가 필요 없다.
 *
 * segments 는 도엽 외곽 체인(양 끝이 그 도엽 폴리곤 변에서 BORDER_TOL_MM 안)을 빼고 등고선 선분만 모은다.
 * TTM v1 에는 둘을 구분하는 표시가 없어 기하로 판정한다. 변을 따라 붙어 달리는 등고선은 외곽으로 오인될 수 있다.
 * 재삼각분할(terrainRetri)이 이 등고선 선분을 제약으로 쓰면서 도엽 경계는 제약에서 빠져, 경계를 따라 생기던 골이 없어진다.
 *
 * @param tiles 합칠 1K 도엽들
 * @param commonOrigin 공통 원점(정수 m). 한 장면의 모든 1K 에 같은 값을 써야 한다
 * @param cornersById 1K 번호 → 도엽 꼭지점(절대 m). 없는 도엽의 segment 는 모두 등고선으로 본다
 * @returns 렌더러에 그대로 넘길 수 있는 메쉬(+ 등고선 제약 선분)
 */
const mergeTiles = (
    tiles: TtmTile[],
    commonOrigin: [number, number],
    cornersById: Map<string, [number, number][]>,
    onProgress?: (done: number, total: number) => void,
): TinMesh => {
    const keyToIdx = new Map<string, number>()
    const pos: number[] = []
    const indices: number[] = []
    const segments: number[] = []
    const zBits = new Uint32Array(1)
    const zF = new Float32Array(zBits.buffer)
    let borderSegments = 0

    for (const [tileIndex, tile] of tiles.entries()) {
        onProgress?.(tileIndex, tiles.length)
        // 정수 mm 끼리 더하므로 공유 정점은 같은 값이 된다
        const dx = (tile.origin[0] - commonOrigin[0]) * 1000
        const dy = (tile.origin[1] - commonOrigin[1]) * 1000
        const corners = cornersById.get(tile.mapId)
        const local = new Uint32Array(tile.z.length)
        /** 정점이 도엽 외곽 체인 위에 있는지(외곽 segment 판정용) */
        const onBorder = new Uint8Array(tile.z.length)
        for (let i = 0; i < tile.z.length; i++) {
            const x = tile.xy[2 * i] + dx
            const y = tile.xy[2 * i + 1] + dy
            zF[0] = tile.z[i]
            const key = `${x},${y},${zBits[0]}`
            let idx = keyToIdx.get(key)
            if (idx === undefined) {
                idx = pos.length / 3
                keyToIdx.set(key, idx)
                pos.push(x / 1000, y / 1000, tile.z[i])
            }
            local[i] = idx
            if (corners) {
                const d = distToTileBorderMm(
                    tile.xy[2 * i] + tile.origin[0] * 1000,
                    tile.xy[2 * i + 1] + tile.origin[1] * 1000,
                    corners,
                )
                onBorder[i] = d <= BORDER_TOL_MM ? 1 : 0
            }
        }
        for (const a of tile.triangles) indices.push(local[a])
        for (let s = 0; s < tile.segments.length; s += 2) {
            const a = tile.segments[s]
            const b = tile.segments[s + 1]
            if (onBorder[a] && onBorder[b]) {
                borderSegments++
                continue
            }
            segments.push(local[a], local[b])
        }
    }
    console.log(`segments: 등고선 ${segments.length / 2}, 도엽 외곽(제외) ${borderSegments}`)
    return {
        origin: commonOrigin,
        positions: new Float32Array(pos),
        indices: new Uint32Array(indices),
        segments: new Uint32Array(segments),
    }
}

/**
 * 지도에서 고른 범위의 지형 메쉬를 5K 정적 파일(terrain_tile_mesh)로 만든다.
 *
 * 1. 범위에 걸친 1K 도엽과 5K 파일 목록 조회
 * 2. 5K 파일들을 병렬로 받아 풀기
 * 3. 파일 안의 1K(보통 25개) 중 범위에 걸친 1K 만 골라 공통 원점으로 합치기(등고선 제약 선분도 함께)
 * 4. (선택) 도엽 경계 없이 다시 삼각분할(terrainRetri). 도엽 폴리곤을 넘겨 범위 밖 삼각형은 버린다.
 *    이 메쉬를 tin·stepped 모든 표현이 공유한다
 *
 * 메인 스레드에서 불러도 되지만 넓은 범위에서는 합치기·재삼각분할이 수 초 걸리므로 보통 terrainLoad.worker 가 부른다.
 *
 * @param bbox3857 지도에서 고른 범위 [minX, minY, maxX, maxY] (EPSG:3857)
 * @param options.retriangulate true 면 합친 뒤 재삼각분할한다. 기본 false
 * @param options.onProgress 단계별 진행률. download 는 받은 파일 수, merge 는 합친 도엽 수, 나머지는 (0, 1)
 * @returns 렌더러에 넘길 메쉬
 */
export const loadTerrainTtm = async (
    bbox3857: Extent,
    options: { retriangulate?: boolean; onProgress?: LoadProgress } = {},
): Promise<TinMesh> => {
    const { onProgress } = options
    const t0 = performance.now()
    onProgress?.("sheets", 0, 1)
    const q = await getTtmSheetsInBbox(bbox3857)
    const t1 = performance.now()
    let downloaded = 0
    onProgress?.("download", 0, q.sheets.length)
    const files = await Promise.all(
        q.sheets.map(async (s) => {
            const file = await fetchTtm(`${TTM_BASE}/${s.path}`)
            onProgress?.("download", ++downloaded, q.sheets.length)
            return file
        }),
    )
    const t2 = performance.now()
    const want = new Set(q.tiles.map((t) => t.map_id))
    const allTiles = files.flatMap((f) => f.tiles)
    const merged = mergeTiles(
        allTiles.filter((t) => want.has(t.mapId)),
        q.origin,
        new Map(q.tiles.map((t) => [t.map_id, t.corners])),
        (done, total) => onProgress?.("merge", done, total),
    )
    const t3 = performance.now()
    console.log(
        `TTM: 5K 파일 ${files.length}개, 1K ${want.size}/${allTiles.length}개 사용, 정점 ${merged.positions.length / 3}, 삼각형 ${merged.indices.length / 3} ` +
            `(조회 ${Math.round(t1 - t0)}ms, 받기 ${Math.round(t2 - t1)}ms, 합치기 ${Math.round(t3 - t2)}ms)`,
    )
    if (!options.retriangulate) return merged
    onProgress?.("retriangulate", 0, 1)
    const [ox, oy] = q.origin
    const tilePolygons = q.tiles.map((t) => t.corners.map(([x, y]) => [x - ox, y - oy] as [number, number]))
    return retriangulate(merged, tilePolygons)
}
