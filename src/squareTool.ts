import Feature from "ol/Feature"
import Map from "ol/Map"
import { always } from "ol/events/condition"
import { Extent } from "ol/extent"
import DragBox from "ol/interaction/DragBox"
import VectorLayer from "ol/layer/Vector"
import VectorSource from "ol/source/Vector"

import { getMapOverlay, selectionStyle } from "./mapOverlay"

/** 선택 박스 레이어 이름. applyMapTheme 이 이 이름으로 찾아 테마 색을 다시 입힌다 */
export const SQUARE_RANGE_LAYER_NAME = "squareRangeBox"

/** 사각형 선택 도구. 모드를 켜면 한 손가락(마우스) 끌기가 지도 이동 대신 사각형을 그리고, 끌기를 끝내면 범위가 확정된다 */
export type SquareTool = {
    /** 선택 모드 켜기/끄기. 확정되면 저절로 꺼진다 */
    setActive: (active: boolean) => void
    isActive: () => boolean
}

/**
 * 지도에 사각형 선택 도구를 단다.
 *
 * 마우스 hover 가 없는 터치 화면에서도 그리는 동안 박스가 보이도록 두 번 클릭 대신 끌기(DragBox)로 그린다. 모드가 켜진
 * 동안만 DragBox interaction 이 지도에 붙어 pointer down 을 가로채므로 지도 끌기(DragPan)는 그동안 동작하지 않는다.
 * 프로젝트에 OpenLayers 기본 CSS 가 없어 DragBox 가 만드는 HTML 박스는 보이지 않으므로, 끄는 동안 벡터 레이어의 피처를
 * 갱신해 테마 색(selectionStyle)으로 그린다. 레이어는 한 번 만들어 유지한다(applyMapTheme 이 이름으로 찾아 재스타일).
 * 탭만 하고 끌지 않으면(DragBox 의 minArea 미만) boxcancel 이 나고 모드는 유지된다.
 *
 * @param map 사각형을 그릴 지도(오버레이 색이 들어 있어야 함)
 * @param options.onConfirmed 끌기를 끝내 범위가 확정됐을 때 (EPSG:3857 bbox)
 * @param options.onActiveChange 모드가 켜지거나 꺼질 때(버튼 문구 갱신용)
 */
export const installSquareTool = (
    map: Map,
    options: { onConfirmed: (bbox: Extent) => void; onActiveChange?: (active: boolean) => void },
): SquareTool => {
    const source = new VectorSource<Feature>()
    const layer = new VectorLayer({ source, style: selectionStyle(getMapOverlay(map)) })
    layer.set("name", SQUARE_RANGE_LAYER_NAME)
    map.addLayer(layer)

    const box = new Feature()
    // 기본 className "ol-dragbox" 는 OpenLayers CSS 가 있으면 보이므로, 혹시 들어와도 겹쳐 그려지지 않게 다른 이름을 준다
    const dragBox = new DragBox({ condition: always, className: "selection-dragbox" })
    let active = false

    const setActive = (next: boolean) => {
        if (next === active) return
        active = next
        if (next) map.addInteraction(dragBox)
        else map.removeInteraction(dragBox)
        options.onActiveChange?.(next)
    }

    dragBox.on("boxstart", () => {
        source.clear()
        box.setGeometry(undefined)
        source.addFeature(box)
    })
    dragBox.on("boxdrag", () => box.setGeometry(dragBox.getGeometry()))
    dragBox.on("boxend", () => {
        const geometry = dragBox.getGeometry()
        box.setGeometry(geometry)
        setActive(false)
        options.onConfirmed(geometry.getExtent())
    })
    dragBox.on("boxcancel", () => source.clear())

    return { setActive, isActive: () => active }
}
