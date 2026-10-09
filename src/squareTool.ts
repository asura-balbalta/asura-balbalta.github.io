import Feature from "ol/Feature"
import Map from "ol/Map"
import MapBrowserEvent from "ol/MapBrowserEvent"
import { Coordinate } from "ol/coordinate"
import { boundingExtent, Extent, getArea } from "ol/extent"
import { fromExtent } from "ol/geom/Polygon"
import DoubleClickZoom from "ol/interaction/DoubleClickZoom"
import DragBox from "ol/interaction/DragBox"
import VectorLayer from "ol/layer/Vector"
import VectorSource from "ol/source/Vector"

import { getMapOverlay, selectionStyle } from "./mapOverlay"

/** 선택 박스 레이어 이름. applyMapTheme 이 이 이름으로 찾아 테마 색을 다시 입힌다 */
export const SQUARE_RANGE_LAYER_NAME = "squareRangeBox"

/** 클릭 방식의 단계. "idle": 첫 모서리를 기다림, "anchored": 첫 모서리를 찍고 두 번째 클릭을 기다림(안내 문구 갱신용) */
export type SquarePhase = "idle" | "anchored"

/** 사각형 선택 도구. 모드를 켜면 마우스는 클릭·이동·클릭, 터치는 끌기로 사각형을 그리고, 끝나면 범위가 확정된다 */
export type SquareTool = {
    /** 선택 모드 켜기/끄기. 확정되면 저절로 꺼진다 */
    setActive: (active: boolean) => void
    isActive: () => boolean
}

/** 포인터 이벤트가 터치에서 왔는지. OpenLayers 는 pointer 이벤트를 쓰므로 originalEvent 가 PointerEvent 다 */
const isTouch = (e: MapBrowserEvent) => (e.originalEvent as PointerEvent).pointerType === "touch"

/**
 * 지도에 사각형 선택 도구를 단다.
 *
 * 입력 종류로 방식을 고른다. 마우스·펜은 첫 click 으로 기준점을 잡고 pointermove 마다 기준점~포인터 박스를 그리다가 두 번째
 * click 에 확정한다(singleclick 은 더블클릭 판별로 250ms 늦어 click 을 쓰고, 그 대신 모드 중에는 DoubleClickZoom 을 꺼서 두 번째
 * 클릭이 줌을 일으키지 않게 한다). 두 클릭 사이의 끌기는 click 이 아니므로 DragPan 이 그대로 지도를 옮긴다. 터치는 hover 가
 * 없어 그리는 동안 박스가 보이도록 끌기(DragBox)를 유지하며, DragBox 의 condition 을 터치로 좁혀 마우스 끌기는 가로채지 않는다.
 * 프로젝트에 OpenLayers 기본 CSS 가 없어 DragBox 가 만드는 HTML 박스는 보이지 않으므로, 두 방식 모두 벡터 레이어의 피처를
 * 갱신해 테마 색(selectionStyle)으로 그린다. 레이어는 한 번 만들어 유지한다(applyMapTheme 이 이름으로 찾아 재스타일).
 * Escape 는 기준점이 있으면 기준점만 지우고(모드 유지), 없으면 모드를 끈다. 탭만 하고 끌지 않으면(DragBox 의 minArea 미만)
 * boxcancel 이 나고 모드는 유지된다.
 *
 * @param map 사각형을 그릴 지도(오버레이 색이 들어 있어야 함)
 * @param options.onConfirmed 범위가 확정됐을 때 (EPSG:3857 bbox)
 * @param options.onActiveChange 모드가 켜지거나 꺼질 때(버튼 문구 갱신용)
 * @param options.onPhaseChange 클릭 방식의 단계가 바뀔 때(안내 문구 갱신용). 모드가 꺼지면 "idle" 로 돌아간다
 */
export const installSquareTool = (
    map: Map,
    options: {
        onConfirmed: (bbox: Extent) => void
        onActiveChange?: (active: boolean) => void
        onPhaseChange?: (phase: SquarePhase) => void
    },
): SquareTool => {
    const source = new VectorSource<Feature>()
    const layer = new VectorLayer({ source, style: selectionStyle(getMapOverlay(map)) })
    layer.set("name", SQUARE_RANGE_LAYER_NAME)
    map.addLayer(layer)

    const box = new Feature()
    // 기본 className "ol-dragbox" 는 OpenLayers CSS 가 있으면 보이므로, 혹시 들어와도 겹쳐 그려지지 않게 다른 이름을 준다
    const dragBox = new DragBox({ condition: isTouch, className: "selection-dragbox" })
    const doubleClickZoom = map
        .getInteractions()
        .getArray()
        .find((i): i is DoubleClickZoom => i instanceof DoubleClickZoom)
    let active = false
    /** 클릭 방식의 첫 모서리. 없으면 idle */
    let anchor: Coordinate | null = null

    const showBox = () => {
        source.clear()
        box.setGeometry(undefined)
        source.addFeature(box)
    }

    const setAnchor = (next: Coordinate | null) => {
        const phaseBefore: SquarePhase = anchor ? "anchored" : "idle"
        anchor = next
        if (!next) source.clear()
        const phase: SquarePhase = next ? "anchored" : "idle"
        if (phase !== phaseBefore) options.onPhaseChange?.(phase)
    }

    const confirm = (extent: Extent) => {
        setActive(false)
        options.onConfirmed(extent)
    }

    const onClick = (e: MapBrowserEvent) => {
        if (isTouch(e)) return
        if (!anchor) {
            showBox()
            setAnchor(e.coordinate)
            box.setGeometry(fromExtent(boundingExtent([e.coordinate, e.coordinate])))
            return
        }
        const extent = boundingExtent([anchor, e.coordinate])
        // 첫 점과 같은 자리를 다시 누르면 넓이가 0 이라 범위가 못 된다. 기준점을 유지하고 다음 클릭을 기다린다
        if (getArea(extent) === 0) return
        box.setGeometry(fromExtent(extent))
        confirm(extent)
    }

    const onPointerMove = (e: MapBrowserEvent) => {
        if (!anchor || isTouch(e)) return
        box.setGeometry(fromExtent(boundingExtent([anchor, e.coordinate])))
    }

    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key !== "Escape") return
        if (anchor) setAnchor(null)
        else setActive(false)
    }

    const setActive = (next: boolean) => {
        if (next === active) return
        active = next
        const target = map.getTargetElement()
        if (next) {
            map.addInteraction(dragBox)
            doubleClickZoom?.setActive(false)
            map.on("click", onClick)
            map.on("pointermove", onPointerMove)
            document.addEventListener("keydown", onKeyDown)
            if (target) target.style.cursor = "crosshair"
        } else {
            map.removeInteraction(dragBox)
            doubleClickZoom?.setActive(true)
            map.un("click", onClick)
            map.un("pointermove", onPointerMove)
            document.removeEventListener("keydown", onKeyDown)
            if (target) target.style.cursor = ""
            // 확정 직후에는 박스를 남겨야 하므로 피처는 지우지 않고 기준점만 푼다
            if (anchor) {
                anchor = null
                options.onPhaseChange?.("idle")
            }
        }
        options.onActiveChange?.(next)
    }

    dragBox.on("boxstart", showBox)
    dragBox.on("boxdrag", () => box.setGeometry(dragBox.getGeometry()))
    dragBox.on("boxend", () => {
        const geometry = dragBox.getGeometry()
        box.setGeometry(geometry)
        confirm(geometry.getExtent())
    })
    dragBox.on("boxcancel", () => source.clear())

    return { setActive, isActive: () => active }
}
