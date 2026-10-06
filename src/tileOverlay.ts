import { Feature, Map } from "ol"
import Polygon from "ol/geom/Polygon"
import VectorLayer from "ol/layer/Vector"
import { register } from "ol/proj/proj4"
import VectorSource from "ol/source/Vector"
import proj4 from "proj4"

import { getMapOverlay, tileOutlineStyle } from "./mapOverlay"
import { TileInfo } from "./terrainData"
import { EPSG5179_DEF } from "./terrainIndex"

/** 1K 도엽 외곽선 레이어 이름. applyMapTheme 이 이 이름으로 찾아 테마 색을 다시 입힌다 */
export const TILE_LAYER_NAME = "terrainTiles"

// 서버 데이터 좌표계 ESRI:102080 은 EPSG:5179 와 같은 정의. OpenLayers 의 transform 이 쓰도록 등록한다
proj4.defs("EPSG:5179", EPSG5179_DEF)
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
        style: tileOutlineStyle(getMapOverlay(map)),
    })
    layer.set("name", TILE_LAYER_NAME)
    map.addLayer(layer)
}
