import { Extent } from "ol/extent"

export const TERRAIN_API = "http://localhost:8000"

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
