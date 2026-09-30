import { Extent } from "ol/extent"

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
    indices: Uint32Array
    /** 정점 법선. 있으면 렌더러가 계산·스무딩을 건너뛰고 그대로 쓴다 (계단형 메쉬처럼 모서리를 살려야 할 때) */
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

/** /ttm/sheets 응답: 범위에 걸친 1K 목록과 받아야 할 5K 파일 */
type TtmSheetsInBbox = {
    origin: [number, number]
    tiles: (TileInfo & { id5k: string })[]
    sheets: { id5k: string; path: string; map_ids: string[] }[]
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
}

/**
 * 범위에 걸친 1K 도엽과, 그 1K 들이 들어 있는 5K 파일 경로를 조회한다.
 * 지금은 개발 서버의 /ttm/sheets 를 쓴다. 운영(R2)용 정적 인덱스가 정해지면 이 함수만 교체한다.
 *
 * @param bbox3857 지도에서 고른 범위 [minX, minY, maxX, maxY] (EPSG:3857)
 * @returns 공통 원점, 걸친 1K 목록, 5K 파일 목록
 */
const getTtmSheetsInBbox = async (bbox3857: Extent): Promise<TtmSheetsInBbox> => {
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
const fetchTtm = async (url: string) => {
    const res = await fetch(url)
    if (!res.ok || !res.body) throw new Error(`${res.status} ${url}`)
    const raw = res.body.pipeThrough(new DecompressionStream("gzip"))
    return parseTtm(await new Response(raw).arrayBuffer())
}

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

    let off = 32
    const toc: { mapId: string; nV: number; nT: number }[] = []
    for (let i = 0; i < nTiles; i++, off += 16) {
        toc.push({
            mapId: String(dv.getUint32(off, true)),
            nV: dv.getUint32(off + 4, true),
            nT: dv.getUint32(off + 8, true),
        })
    }
    const xy = new Int32Array(buf, off, 2 * N)
    off += 8 * N
    const z = new Float32Array(buf, off, N)
    off += 4 * N
    const tri = new Uint32Array(buf, off, 3 * K)

    let v = 0
    let t = 0
    const tiles: TtmTile[] = toc.map((e) => {
        const tile = {
            mapId: e.mapId,
            origin,
            xy: xy.subarray(2 * v, 2 * (v + e.nV)),
            z: z.subarray(v, v + e.nV),
            triangles: tri.subarray(3 * t, 3 * (t + e.nT)),
        }
        v += e.nV
        t += e.nT
        return tile
    })
    return { origin, tiles }
}

/**
 * 여러 1K 도엽(다른 5K 파일에서 온 것이 섞여도 됨)을 공통 원점 기준 메쉬 하나로 합친다.
 *
 * 이웃 도엽이 공유하는 경계 정점은 절대 mm 정수와 z 가 정확히 같으므로,
 * (x mm, y mm, z 의 float32 비트)가 같은 정점을 하나로 합친다. 허용 오차 비교가 필요 없다.
 *
 * @param tiles 합칠 1K 도엽들
 * @param commonOrigin 공통 원점(정수 m). 한 장면의 모든 1K 에 같은 값을 써야 한다
 * @returns 렌더러에 그대로 넘길 수 있는 메쉬
 */
const mergeTiles = (tiles: TtmTile[], commonOrigin: [number, number]): TinMesh => {
    const keyToIdx = new Map<string, number>()
    const pos: number[] = []
    const indices: number[] = []
    const zBits = new Uint32Array(1)
    const zF = new Float32Array(zBits.buffer)

    for (const tile of tiles) {
        // 정수 mm 끼리 더하므로 공유 정점은 같은 값이 된다
        const dx = (tile.origin[0] - commonOrigin[0]) * 1000
        const dy = (tile.origin[1] - commonOrigin[1]) * 1000
        const local = new Uint32Array(tile.z.length)
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
        }
        for (const a of tile.triangles) indices.push(local[a])
    }
    return {
        origin: commonOrigin,
        positions: new Float32Array(pos),
        indices: new Uint32Array(indices),
    }
}

/**
 * 지도에서 고른 범위의 지형 메쉬를 5K 정적 파일(terrain_tile_mesh)로 만든다.
 *
 * 1. 범위에 걸친 1K 도엽과 5K 파일 목록 조회
 * 2. 5K 파일들을 병렬로 받아 풀기
 * 3. 파일 안의 1K(보통 25개) 중 범위에 걸친 1K 만 골라 공통 원점으로 합치기
 *
 * @param bbox3857 지도에서 고른 범위 [minX, minY, maxX, maxY] (EPSG:3857)
 * @returns 렌더러에 넘길 메쉬
 */
export const loadTerrainTtm = async (bbox3857: Extent): Promise<TinMesh> => {
    const q = await getTtmSheetsInBbox(bbox3857)
    const files = await Promise.all(
        q.sheets.map((s) => fetchTtm(`${TTM_BASE}/${s.path}`)),
    )
    const want = new Set(q.tiles.map((t) => t.map_id))
    const allTiles = files.flatMap((f) => f.tiles)
    const mesh = mergeTiles(
        allTiles.filter((t) => want.has(t.mapId)),
        q.origin,
    )
    console.log(
        `TTM: 5K 파일 ${files.length}개, 1K ${want.size}/${allTiles.length}개 사용, 정점 ${mesh.positions.length / 3}, 삼각형 ${mesh.indices.length / 3}`,
    )
    return mesh
}
