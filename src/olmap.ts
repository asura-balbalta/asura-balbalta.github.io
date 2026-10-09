import Map from "ol/Map"
import View from "ol/View"
import TileLayer from "ol/layer/Tile"
import { transform } from "ol/proj"
import VectorLayer from "ol/layer/Vector"
import { Extent } from "ol/extent"

import { BasemapProvider, createBasemapSource, nextBasemapProvider, watchTileErrors } from "./basemap"
import { selectionStyle, setMapOverlay, tileOutlineStyle } from "./mapOverlay"
import { installSquareTool, SQUARE_RANGE_LAYER_NAME, SquarePhase, SquareTool } from "./squareTool"
import { getTtpSheetsInBbox } from "./terrainIndex"
import { TerrainTheme } from "./terrainTheme"
import { drawTileOutlines, TILE_LAYER_NAME } from "./tileOverlay"

/**
 * 지도에 테마와 바탕 지도 출처를 적용한다(초기화·테마 전환·출처 전환). 바탕 타일을 바꾸고, 오버레이 색을 지도에 넣어
 * 두며, 이미 그려진 선택 박스·1K 외곽선 레이어가 있으면 그 색으로 다시 입힌다. 레이어 목록의 첫 TileLayer 가 바탕
 * 지도라는 전제. 바탕 타일 로딩이 연속 실패하면(무료 한도 초과 등) onBasemapFallback 에 다음 출처를 알린다
 *
 * @param map initOlMap 이 만든 지도
 * @param theme 적용할 테마(지도 톤·오버레이 색)
 * @param provider 바탕 지도 출처
 * @param onBasemapFallback 이 출처가 죽었을 때 넘어갈 다음 출처를 받는 콜백. 받는 쪽이 provider 를 바꿔 다시 부른다
 */
export const applyMapTheme = (
    map: Map,
    theme: TerrainTheme,
    provider: BasemapProvider,
    onBasemapFallback?: (next: BasemapProvider) => void,
) => {
    const base = map.getLayers().item(0)
    if (!(base instanceof TileLayer)) throw new Error("첫 레이어가 바탕 타일 레이어가 아님")
    const source = createBasemapSource(provider, theme.basemap)
    watchTileErrors(source, () => {
        console.warn(`바탕 지도(${provider}) 타일 로딩이 계속 실패해 다음 출처로 넘깁니다`)
        onBasemapFallback?.(nextBasemapProvider(provider))
    })
    base.setSource(source)
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
 * @param options.onSquareConfirmed 사각형이 확정됐을 때 (EPSG:3857 bbox)
 * @param options.onSheets 확정된 범위에 걸치는 1K 도엽 수를 알았을 때(상태 표시줄 표시용). 확정 뒤 비동기로 온다
 * @param options.theme 처음 테마(지도 톤·오버레이 색)
 * @param options.basemap 처음 바탕 지도 출처
 * @param options.onSelectingChange 선택 모드가 켜지거나 꺼질 때
 * @param options.onSelectPhaseChange 클릭 방식 선택의 단계(첫 모서리 전·후)가 바뀔 때(안내 문구용)
 * @param options.onBasemapFallback 바탕 지도 출처가 죽었을 때 다음 출처를 받는 콜백(applyMapTheme 참고)
 * @returns 지도와 선택 도구(모드 켜고 끄기)
 */
export const initOlMap = async ({
    onSquareConfirmed,
    onSheets,
    theme,
    basemap,
    onSelectingChange,
    onSelectPhaseChange,
    onBasemapFallback,
}: {
    onSquareConfirmed: (bbox: Extent) => void
    onSheets?: (count: number) => void
    theme: TerrainTheme
    basemap: BasemapProvider
    onSelectingChange?: (active: boolean) => void
    onSelectPhaseChange?: (phase: SquarePhase) => void
    onBasemapFallback?: (next: BasemapProvider) => void
}): Promise<{ map: Map; squareTool: SquareTool }> => {
    let center = [14136104.293764262, 4514380.225694263] // 위치정보 허용 안할 경우 기본 좌표 (녹사평역 인근)
    const map = new Map({
        target: "map",
        layers: [
            // 소스는 아래 applyMapTheme 이 출처·톤에 맞춰 넣는다
            new TileLayer(),

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
        // 저작권 표시는 OpenLayers 컨트롤 대신 앱의 상태 표시줄이 맡는다(basemap.ts basemapAttribution). 컨트롤 없음
        controls: [],
    })
    applyMapTheme(map, theme, basemap, onBasemapFallback)

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
                .then(({ tiles }) => {
                    drawTileOutlines(map, tiles)
                    onSheets?.(tiles.length)
                })
                .catch((err) => console.error(err))
            onSquareConfirmed(bbox)
        },
        onActiveChange: onSelectingChange,
        onPhaseChange: onSelectPhaseChange,
    })

    return { map, squareTool }
}
