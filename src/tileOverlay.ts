import { Feature, Map } from "ol"
import Polygon from "ol/geom/Polygon"
import VectorLayer from "ol/layer/Vector"
import { register } from "ol/proj/proj4"
import VectorSource from "ol/source/Vector"
import proj4 from "proj4"

import { TileInfo } from "./terrainData"

const TILE_LAYER_NAME = "terrainTiles"

// 서버 데이터 좌표계 ESRI:102080 은 EPSG:5179 와 같은 정의
proj4.defs(
    "EPSG:5179",
    "+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +units=m +no_defs",
)
register(proj4)

export const drawTileOutlines = (map: Map, tiles: TileInfo[]) => {
    const features = tiles.map((tile) => {
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
