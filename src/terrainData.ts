import { Extent } from "ol/extent"

/** 개발 서버(terrainDataDev·주석의 서버 데이터 경로용). 운영 데이터는 R2(terrainIndex.TTP_BASE·buildingsData) */
export const TERRAIN_API = "http://localhost:8000"

// 좌표는 모두 ESRI:102080(≈EPSG:5179) 절대좌표
export type TileInfo = {
    map_id: string
    name: string
    bbox: Extent
    corners: [number, number][]
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

/** 파일 전체가 gzip 인 정적 파일(ttp)을 받아 푼다. 전송 압축은 브라우저가, 파일 gzip 은 여기서 푼다 */
export const fetchGunzip = async (url: string) => {
    const res = await fetch(url)
    if (!res.ok || !res.body) throw new Error(`${res.status} ${url}`)
    const raw = res.body.pipeThrough(new DecompressionStream("gzip"))
    return new Response(raw).arrayBuffer()
}

/**
 * 캐시 메모리 측정(2026-10-23, 계획서 19절): 데이터 모듈의 파일·JSON 캐시(지우지 않는다)에 들어간 항목 수와 바이트(gunzip 뒤. JSON 은 글자 수라
 * 대략). 키는 "레이어.종류". 워커·메인 스레드마다 따로 쌓이고 디버그 페이지 memory() 가 읽는다
 */
export const dataCacheStats: Record<string, { count: number; bytes: number }> = {}
/** 캐시 항목 하나가 풀릴 때 적는다. value 를 그대로 돌려줘 then 사슬에 끼운다 */
export const noteCached = <T>(key: string, bytes: number, value: T): T => {
    const s = (dataCacheStats[key] ??= { count: 0, bytes: 0 })
    s.count++
    s.bytes += bytes
    return value
}
/** fetch 응답을 JSON 으로 읽으며 글자 수를 적는다(res.json() 과 같은 결과) */
export const noteJson = async (key: string, res: Response) => {
    const text = await res.text()
    return JSON.parse(noteCached(key, text.length, text))
}
/** 이 스레드의 JS 힙 사용량(Chrome 전용 performance.memory, 거친 값). 없으면 null */
export const heapBytes = () => (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null

