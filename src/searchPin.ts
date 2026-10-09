import Feature from "ol/Feature"
import Map from "ol/Map"
import Overlay from "ol/Overlay"
import Point from "ol/geom/Point"
import VectorLayer from "ol/layer/Vector"
import VectorSource from "ol/source/Vector"

import { getMapOverlay, pinStyle } from "./mapOverlay"

/** 검색 핀 레이어 이름. applyMapTheme 이 이 이름으로 찾아 테마 색을 다시 입힌다 */
export const SEARCH_PIN_LAYER_NAME = "searchPin"
const STATE_KEY = "searchPinState"

type PinState = { layer: VectorLayer; source: VectorSource<Feature>; overlay: Overlay; name: HTMLElement; address: HTMLElement }

/** 핀 레이어와 이름 칩 오버레이를 지도에 한 번 만들어 둔다 */
const getState = (map: Map): PinState => {
    const existing = map.get(STATE_KEY) as PinState | undefined
    if (existing) return existing
    const source = new VectorSource<Feature>()
    const layer = new VectorLayer({ source, style: pinStyle(getMapOverlay(map)) })
    layer.set("name", SEARCH_PIN_LAYER_NAME)
    map.addLayer(layer)

    const el = document.createElement("div")
    el.className = "ui-panel ui-map-chip"
    const name = document.createElement("span")
    name.className = "ui-map-chip-name"
    const address = document.createElement("span")
    address.className = "ui-map-chip-address"
    el.append(name, address)
    const overlay = new Overlay({ element: el, positioning: "center-left", offset: [14, 0], stopEvent: false })
    map.addOverlay(overlay)

    const state: PinState = { layer, source, overlay, name, address }
    map.set(STATE_KEY, state)
    return state
}

/**
 * 검색한 위치에 핀(강조색 원)과 이름 칩을 찍는다. 이전 핀은 지운다.
 *
 * @param map 지도
 * @param coord EPSG:3857
 * @param name 장소 이름
 * @param address 보조 줄(없으면 생략)
 */
export const showSearchPin = (map: Map, coord: [number, number], name: string, address?: string) => {
    const s = getState(map)
    s.source.clear()
    s.source.addFeature(new Feature(new Point(coord)))
    s.name.textContent = name
    s.address.textContent = address ?? ""
    s.address.style.display = address ? "" : "none"
    s.overlay.setPosition(coord)
}

/** 핀과 이름 칩을 지운다 */
export const clearSearchPin = (map: Map) => {
    const s = map.get(STATE_KEY) as PinState | undefined
    if (!s) return
    s.source.clear()
    s.overlay.setPosition(undefined)
}
