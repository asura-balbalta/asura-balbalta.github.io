import Feature from "ol/Feature"
import Map from "ol/Map"
import Point from "ol/geom/Point"
import Polygon from "ol/geom/Polygon"
import VectorLayer from "ol/layer/Vector"
import VectorSource from "ol/source/Vector"
import { containsCoordinate } from "ol/extent"

import { getMapOverlay, playerMarkerStyle } from "./mapOverlay"

/** 플레이어 표시 레이어 이름. applyMapTheme 이 이 이름으로 찾아 테마 색을 다시 입힌다 */
export const PLAYER_MARKER_LAYER_NAME = "playerMarker"
const STATE_KEY = "playerMarkerState"
/** 방향 부채꼴 반지름(화면 px)과 반각 */
const CONE_RADIUS_PX = 20
const CONE_HALF_ANGLE = (35 * Math.PI) / 180
const CONE_ARC_STEPS = 8

type MarkerState = { source: VectorSource<Feature>; dot: Feature<Point>; cone: Feature<Polygon> }

/** 레이어와 점·부채꼴 피처를 지도에 한 번 만들어 둔다 */
const getState = (map: Map): MarkerState => {
    const existing = map.get(STATE_KEY) as MarkerState | undefined
    if (existing) return existing
    const source = new VectorSource<Feature>()
    const layer = new VectorLayer({ source, style: playerMarkerStyle(getMapOverlay(map)) })
    layer.set("name", PLAYER_MARKER_LAYER_NAME)
    map.addLayer(layer)
    const dot = new Feature<Point>()
    dot.set("kind", "dot")
    const cone = new Feature<Polygon>()
    cone.set("kind", "cone")
    const state: MarkerState = { source, dot, cone }
    map.set(STATE_KEY, state)
    return state
}

/**
 * 걸어 보기 플레이어의 위치(점)와 바라보는 방향(부채꼴)을 미니맵에 그린다. 점이 보이는 범위 밖으로 나가면 지도 중심을 옮긴다.
 *
 * @param map 지도
 * @param coord 플레이어 위치(EPSG:3857)
 * @param yaw 바라보는 방향(라디안, 0 = 동쪽, 반시계)
 */
export const showPlayerMarker = (map: Map, coord: [number, number], yaw: number) => {
    const s = getState(map)
    const view = map.getView()
    const r = CONE_RADIUS_PX * (view.getResolution() ?? 1)
    const ring: number[][] = [coord]
    for (let i = 0; i <= CONE_ARC_STEPS; i++) {
        const a = yaw - CONE_HALF_ANGLE + (2 * CONE_HALF_ANGLE * i) / CONE_ARC_STEPS
        ring.push([coord[0] + r * Math.cos(a), coord[1] + r * Math.sin(a)])
    }
    ring.push(coord)
    s.cone.setGeometry(new Polygon([ring]))
    s.dot.setGeometry(new Point(coord))
    if (s.source.getFeatures().length === 0) s.source.addFeatures([s.cone, s.dot])
    const size = map.getSize()
    if (size && !containsCoordinate(view.calculateExtent(size), coord)) view.setCenter(coord)
}

/** 플레이어 표시를 지운다 */
export const clearPlayerMarker = (map: Map) => {
    const s = map.get(STATE_KEY) as MarkerState | undefined
    s?.source.clear()
}
