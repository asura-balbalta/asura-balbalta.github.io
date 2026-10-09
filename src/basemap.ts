import { StadiaMaps, XYZ } from "ol/source"
import type TileSource from "ol/source/Tile"

/**
 * 바탕 지도 타일 출처. 모두 OSM 기반의 밝은 회색(라이트)·어두운(다크) 스타일이다.
 * - stadia: Alidade Smooth / Smooth Dark. 무료 플랜은 월 200,000 크레딧·비상업용이고 넘으면 429 로 차단된다
 * - carto: Positron(light_all) / Dark Matter(dark_all) 래스터. 무료 키로 월 500만(비상업)·100만(상업) 요청.
 *   키가 없으면 타일에 "API KEY REQUIRED" 워터마크가 찍힌다(https://carto.com/basemaps/apikey/)
 * 타일 로딩이 연속으로 실패하면(한도 초과 등) watchTileErrors 가 다음 출처로 넘기도록 알린다.
 */
export type BasemapProvider = "stadia" | "carto"
/** 테마가 정하는 지도 톤. 출처마다 이 톤에 맞는 스타일을 고른다 */
export type BasemapTone = "light" | "dark"

/**
 * CARTO Basemaps API 키(2026-10-08 발급, 관리: https://dashboard.basemaps.carto.com). 클라이언트 번들에 들어가는 공개 키이며,
 * 대시보드에서 사용 도메인을 제한할 수 있다. 비어 있으면 워터마크만 있는 빈 타일이 온다
 */
export const CARTO_API_KEY = "cb1_4duu_1_716b63b33f6b73c64c9a7246"

/** 화면에 보이는 순서이자 자동 대체 순서 */
export const BASEMAP_PROVIDERS: { id: BasemapProvider; label: string }[] = [
    { id: "stadia", label: "Stadia" },
    { id: "carto", label: "CARTO" },
]

/**
 * 출처별 저작권 문구(상태 표시줄용, 태그 없는 글자). Stadia 는 Stadia Maps·OpenMapTiles·OSM, CARTO 는 OSM·CARTO 를
 * 표기해야 한다. 링크는 두지 않고 글자만 보인다
 */
export const basemapAttribution = (provider: BasemapProvider): string =>
    provider === "stadia" ? "© Stadia Maps · © OpenMapTiles · © OpenStreetMap" : "© OpenStreetMap · © CARTO"

/** 목록에서 다음 출처(마지막이면 처음으로) */
export const nextBasemapProvider = (id: BasemapProvider): BasemapProvider => {
    const i = BASEMAP_PROVIDERS.findIndex((p) => p.id === id)
    return BASEMAP_PROVIDERS[(i + 1) % BASEMAP_PROVIDERS.length].id
}

/**
 * 출처와 톤에 맞는 타일 소스를 만든다.
 *
 * @param provider 출처
 * @param tone 라이트/다크
 */
export const createBasemapSource = (provider: BasemapProvider, tone: BasemapTone): TileSource => {
    switch (provider) {
        case "stadia":
            return new StadiaMaps({ layer: tone === "dark" ? "alidade_smooth_dark" : "alidade_smooth", retina: true })
        case "carto": {
            const style = tone === "dark" ? "dark_all" : "light_all"
            const key = CARTO_API_KEY ? `?key=${encodeURIComponent(CARTO_API_KEY)}` : ""
            return new XYZ({
                url: `https://{a-d}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}@2x.png${key}`,
                tilePixelRatio: 2,
                maxZoom: 20,
                attributions:
                    '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, © <a href="https://carto.com/attributions">CARTO</a>',
            })
        }
    }
}

/** 이 횟수만큼 타일 로딩이 연속 실패하면 출처가 죽은 것으로 본다(한도 초과 429, 네트워크 차단 등) */
const FAIL_THRESHOLD = 6

/**
 * 타일 로딩 실패를 세어 연속 FAIL_THRESHOLD 번 실패하면 한 번만 onDead 를 부른다. 성공이 섞이면 다시 센다.
 *
 * @param source 감시할 타일 소스
 * @param onDead 출처가 죽었다고 판단했을 때
 */
export const watchTileErrors = (source: TileSource, onDead: () => void) => {
    let failures = 0
    let fired = false
    source.on("tileloadend", () => (failures = 0))
    source.on("tileloaderror", () => {
        failures++
        if (failures >= FAIL_THRESHOLD && !fired) {
            fired = true
            onDead()
        }
    })
}
