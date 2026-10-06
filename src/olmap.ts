import Map from "ol/Map"
import View from "ol/View"
import TileLayer from "ol/layer/Tile"
import { StadiaMaps, XYZ } from "ol/source"
import { Projection, transform } from "ol/proj"
import Feature, { FeatureLike } from "ol/Feature"
import Point from "ol/geom/Point"
import VectorLayer from "ol/layer/Vector"
import VectorSource from "ol/source/Vector"
import { Coordinate } from "ol/coordinate"
import GeoJSON from "ol/format/GeoJSON.js"
import { MapBrowserEvent, MapEvent } from "ol"

import { Extent } from "ol/extent"

import { selectionStyle, setMapOverlay, tileOutlineStyle } from "./mapOverlay"
import { installSquareTool, SQUARE_RANGE_LAYER_NAME, SquareTool } from "./squareTool"
import { getTtpSheetsInBbox } from "./terrainIndex"
import { TerrainTheme } from "./terrainTheme"
import { drawTileOutlines, TILE_LAYER_NAME } from "./tileOverlay"

/** 바탕 지도 타일 레이어 이름. 갤러리: https://docs.stadiamaps.com/themes/ */
export type BaseLayerName = "alidade_smooth" | "alidade_smooth_dark"

/** 바탕 지도 타일 소스 */
const baseSource = (layer: BaseLayerName) =>
    new StadiaMaps({
        layer,
        retina: true, // Set to false for stamen_watercolor
    })

/**
 * 지도에 테마를 적용한다(초기화·테마 전환). 바탕 타일을 바꾸고, 오버레이 색을 지도에 넣어 두며, 이미 그려진
 * 선택 박스·1K 외곽선 레이어가 있으면 그 색으로 다시 입힌다. 레이어 목록의 첫 TileLayer 가 바탕 지도라는 전제
 *
 * @param map initOlMap 이 만든 지도
 * @param theme 적용할 테마
 */
export const applyMapTheme = (map: Map, theme: TerrainTheme) => {
    const base = map.getLayers().item(0)
    if (!(base instanceof TileLayer)) throw new Error("첫 레이어가 바탕 타일 레이어가 아님")
    base.setSource(baseSource(theme.mapLayer))
    setMapOverlay(map, theme.mapOverlay)
    for (const layer of map.getAllLayers()) {
        if (!(layer instanceof VectorLayer)) continue
        const name = layer.get("name")
        if (name === SQUARE_RANGE_LAYER_NAME) layer.setStyle(selectionStyle(theme.mapOverlay))
        else if (name === TILE_LAYER_NAME) layer.setStyle(tileOutlineStyle(theme.mapOverlay))
    }
}

/**
 * 지도를 만들고 사각형 선택 도구를 단다.
 *
 * @param onSquareConfirmed 사각형이 확정됐을 때 (EPSG:3857 bbox)
 * @param theme 처음 테마(바탕 지도·오버레이 색)
 * @param onSelectingChange 선택 모드가 켜지거나 꺼질 때
 * @returns 지도와 선택 도구(모드 켜고 끄기)
 */
export const initOlMap = async (
    onSquareConfirmed: (bbox: Extent) => void,
    theme: TerrainTheme,
    onSelectingChange?: (active: boolean) => void,
): Promise<{ map: Map; squareTool: SquareTool }> => {
    let center = [14136104.293764262, 4514380.225694263] // 위치정보 허용 안할 경우 기본 좌표 (녹사평역 인근)
    const map = new Map({
        target: "map",
        layers: [
            new TileLayer({ source: baseSource(theme.mapLayer) }),

            // osm
            // new TileLayer({
            //     source: new XYZ({
            //         url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
            //     }),
            // }),
        ],
        view: new View({
            center: center,
            zoom: 15,
            minZoom: 10,
            maxZoom: 18,
            projection: "EPSG:3857",
            // rotation: Math.PI / 2 // 시계방향 90
        }),
        controls: [],
    })
    setMapOverlay(map, theme.mapOverlay)

    if ("geolocation" in navigator) {
        /* geolocation is available */
        navigator.geolocation.getCurrentPosition((position) => {
            console.log(position.coords.longitude, position.coords.latitude)
            const metricCoords = transform(
                [position.coords.longitude, position.coords.latitude],
                "EPSG:4326",
                "EPSG:3857",
            )
            map.getView().setCenter(metricCoords)
        })
    } else {
        /* geolocation IS NOT available */
        // console.log('geolocation IS NOT available')
        // map.getView().setCenter([14136104.293764262, 4514380.225694263])
    }

    const squareTool = installSquareTool(map, {
        onConfirmed: (bbox) => {
            // 도엽 외곽선도 지형과 같은 정적 인덱스(R2)에서 찾아 개발 서버 없이 동작한다
            getTtpSheetsInBbox(bbox)
                .then(({ tiles }) => drawTileOutlines(map, tiles))
                .catch((err) => console.error(err))
            onSquareConfirmed(bbox)
        },
        onActiveChange: onSelectingChange,
    })

    return { map, squareTool }
}
