import { Feature, Map } from "ol"
import Point from "ol/geom/Point"
import Polygon from "ol/geom/Polygon"
import VectorLayer from "ol/layer/Vector"
import WebGLVectorLayer from "ol/layer/WebGLVector"
import { getTransform } from "ol/proj"
import { register } from "ol/proj/proj4"
import VectorSource from "ol/source/Vector"
import proj4 from "proj4"

import { TileInfo, TinMesh } from "./terrainData"

const TILE_LAYER_NAME = "terrainTiles"
const MESH_LAYER_NAME = "terrainMesh"

// 서버 데이터 좌표계 ESRI:102080 은 EPSG:5179 와 같은 정의
proj4.defs(
    "EPSG:5179",
    "+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +units=m +no_defs",
)
register(proj4)

const removeLayersByName = (map: Map, name: string) => {
    map.getAllLayers()
        .filter((layer) => layer.get("name") === name)
        .forEach((layer) => map.removeLayer(layer))
}

export const drawTileOutlines = (map: Map, tiles: TileInfo[]) => {
    const features = tiles.map((tile) => {
        const ring = [...tile.corners, tile.corners[0]]
        const geom = new Polygon([ring]).transform("EPSG:5179", "EPSG:3857")
        return new Feature({ geometry: geom, name: tile.name })
    })

    removeLayersByName(map, TILE_LAYER_NAME)
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

export const drawMeshPoints = (map: Map, mesh: TinMesh) => {
    const { origin, positions } = mesh
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
    console.log(`표고 ${zMin.toFixed(1)}~${zMax.toFixed(1)}m`)

    const features: Feature[] = new Array(nV)
    for (let i = 0; i < nV; i++) {
        features[i] = new Feature({
            geometry: new Point([xy[2 * i], xy[2 * i + 1]]),
            z: positions[3 * i + 2],
        })
    }

    removeLayersByName(map, MESH_LAYER_NAME)
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
