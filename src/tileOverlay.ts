import { Feature, Map } from "ol"
import { Extent } from "ol/extent"
import Point from "ol/geom/Point"
import Polygon from "ol/geom/Polygon"
import VectorLayer from "ol/layer/Vector"
import WebGLVectorLayer from "ol/layer/WebGLVector"
import { getTransform } from "ol/proj"
import { register } from "ol/proj/proj4"
import VectorSource from "ol/source/Vector"
import proj4 from "proj4"

const TERRAIN_API = "http://localhost:8000"
const TILE_LAYER_NAME = "terrainTiles"
const MESH_LAYER_NAME = "terrainMesh"

// 서버 데이터 좌표계 ESRI:102080 은 EPSG:5179 와 같은 정의
proj4.defs(
    "EPSG:5179",
    "+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +units=m +no_defs",
)
register(proj4)

type TilesResponse = {
    crs: string
    bbox: Extent
    origin: [number, number]
    tiles: {
        map_id: string
        name: string
        bbox: Extent
        corners: [number, number][]
    }[]
}

export const showTerrainTiles = async (map: Map, bbox3857: Extent) => {
    const res = await fetch(
        `${TERRAIN_API}/tiles?bbox=${bbox3857.join(",")}&crs=3857`,
    )
    if (!res.ok) throw new Error(`/tiles ${res.status}: ${await res.text()}`)
    const data: TilesResponse = await res.json()
    console.log(`도엽 ${data.tiles.length}개`, data)

    const features = data.tiles.map((tile) => {
        const ring = [...tile.corners, tile.corners[0]]
        const geom = new Polygon([ring]).transform("EPSG:5179", "EPSG:3857")
        return new Feature({ geometry: geom, name: tile.name })
    })

    map.getAllLayers()
        .filter((layer) => layer.get("name") === TILE_LAYER_NAME)
        .forEach((layer) => map.removeLayer(layer))

    const layer = new VectorLayer({
        source: new VectorSource({ features }),
        style: {
            "stroke-color": "#FB923C",
            "stroke-width": 1,
            "text-value": ["get", "name"],
            "text-fill-color": "#FDBA74",
            "text-font": "12px sans-serif",
        },
    })
    layer.set("name", TILE_LAYER_NAME)
    map.addLayer(layer)
}

const parseTin = (buf: ArrayBuffer) => {
    const dv = new DataView(buf)
    const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4))
    if (magic !== "TIN1") throw new Error("TIN 바이너리가 아님")
    const nV = dv.getUint32(4, true)
    const nT = dv.getUint32(8, true)
    const origin = [dv.getFloat64(16, true), dv.getFloat64(24, true)]
    const positions = new Float32Array(buf, 32, nV * 3)
    const indices = new Uint32Array(buf, 32 + nV * 12, nT * 3)
    return { origin, positions, indices }
}

export const showTerrainMesh = async (map: Map, bbox3857: Extent) => {
    const res = await fetch(
        `${TERRAIN_API}/mesh.bin?bbox=${bbox3857.join(",")}&crs=3857`,
    )
    if (!res.ok) throw new Error(`/mesh.bin ${res.status}: ${await res.text()}`)
    const { origin, positions, indices } = parseTin(await res.arrayBuffer())

    const nV = positions.length / 3
    const xy: number[] = new Array(nV * 2)
    let zMin = Infinity
    let zMax = -Infinity
    for (let i = 0; i < nV; i++) {
        xy[2 * i] = positions[3 * i] + origin[0]
        xy[2 * i + 1] = positions[3 * i + 1] + origin[1]
        const z = positions[3 * i + 2]
        if (z < zMin) zMin = z
        if (z > zMax) zMax = z
    }
    getTransform("EPSG:5179", "EPSG:3857")(xy, xy, 2)

    console.log(
        `메쉬: 도엽 ${res.headers.get("X-Tile-Count")}개, 정점 ${nV}, 삼각형 ${indices.length / 3}, 표고 ${zMin.toFixed(1)}~${zMax.toFixed(1)}m, 누락 도엽 [${res.headers.get("X-Missing-Tiles")}]`,
    )

    const features: Feature[] = new Array(nV)
    for (let i = 0; i < nV; i++) {
        features[i] = new Feature({
            geometry: new Point([xy[2 * i], xy[2 * i + 1]]),
            z: positions[3 * i + 2],
        })
    }

    map.getAllLayers()
        .filter((layer) => layer.get("name") === MESH_LAYER_NAME)
        .forEach((layer) => map.removeLayer(layer))

    const zMid = (zMin + zMax) / 2
    const layer = new WebGLVectorLayer({
        source: new VectorSource({ features }),
        style: {
            "circle-radius": 2,
            "circle-fill-color": [
                "interpolate",
                ["linear"],
                ["get", "z"],
                zMin,
                "#2563EB",
                zMid,
                "#FACC15",
                zMax,
                "#DC2626",
            ],
        },
    })
    layer.set("name", MESH_LAYER_NAME)
    map.addLayer(layer)
}
