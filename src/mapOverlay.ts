import type Map from "ol/Map"
import type { FlatStyle, Rule } from "ol/style/flat"

import { MapOverlayColors } from "./terrainTheme"

/**
 * 지도 위 오버레이(선택 박스·1K 외곽선)의 현재 테마 색.
 * 색은 지도 객체에 넣어 두고(applyMapTheme), 레이어를 만드는 쪽이 그때의 색을 읽는다. 테마가 바뀌면 applyMapTheme 이
 * 이미 그려진 레이어의 스타일도 바꾼다. squareTool·tileOverlay·olmap 이 서로 import 하지 않도록 여기에 모았다
 */
const MAP_OVERLAY_KEY = "mapOverlay"

export const setMapOverlay = (map: Map, colors: MapOverlayColors) => map.set(MAP_OVERLAY_KEY, colors)

export const getMapOverlay = (map: Map): MapOverlayColors => {
    const colors = map.get(MAP_OVERLAY_KEY)
    if (!colors) throw new Error("지도에 오버레이 색이 없음 (applyMapTheme 이 먼저 불려야 함)")
    return colors
}

/** 사각형 선택 박스 스타일 */
export const selectionStyle = (c: MapOverlayColors): FlatStyle => ({
    "fill-color": c.selectionFill,
    "stroke-color": c.selectionStroke,
    "stroke-width": 1.5,
})

/** 주소 검색 핀 스타일: 선택 박스와 같은 강조색 원, 흰 테두리 */
export const pinStyle = (c: MapOverlayColors): FlatStyle => ({
    "circle-radius": 7,
    "circle-fill-color": c.selectionStroke,
    "circle-stroke-color": "#ffffff",
    "circle-stroke-width": 2,
})

/**
 * 걸어 보기 플레이어 표시(playerMarker): kind "dot" 은 검색 핀보다 작은 강조색 원(r 5), "cone" 은 바라보는 방향 부채꼴.
 * 시안은 부채꼴 accent 25% 인데 선택 박스 채움(12%)을 같이 쓴다(색 토큰을 늘리지 않으려고)
 */
export const playerMarkerStyle = (c: MapOverlayColors): Rule[] => [
    { filter: ["==", ["get", "kind"], "cone"], style: { "fill-color": c.selectionFill } },
    {
        filter: ["==", ["get", "kind"], "dot"],
        style: {
            "circle-radius": 5,
            "circle-fill-color": c.selectionStroke,
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 2,
        },
    },
]

/** 1K 도엽 외곽선 + 이름 스타일 */
export const tileOutlineStyle = (c: MapOverlayColors): FlatStyle => ({
    "stroke-color": c.tileStroke,
    "stroke-width": 1,
    "text-value": ["get", "name"],
    "text-fill-color": c.tileText,
    "text-font": "12px sans-serif",
})
