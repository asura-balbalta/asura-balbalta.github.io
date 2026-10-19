/**
 * 공공데이터 출처 표시(2026-10-16, 데이터 서버 → fb_web 안내문. docs/design-code-plan.md 의 출처 표시 절).
 *
 * 서빙 중인 레이어의 원자료는 모두 "출처만 표시하면 상업 이용·가공 가능" 조건이라 웹이 할 일은 둘이다:
 * 1. 지도 화면 구석에 한 줄(ATTRIBUTION_SHORT)을 항상 표시(데스크톱 상태 표시줄, 모바일 탭 막대 아래).
 * 2. 출처 창·페이지(#/attribution)에 자료별 전체 표시문. 문구는 서버 인덱스의 `attribution` 을 받아 쓰고, 못 받으면
 *    여기 적힌 대체문(FALLBACK_SOURCES)을 쓴다. 기준일(asof)·가공 내용이 바뀌면 서버가 인덱스만 다시 내면 된다.
 * 3. 내려받기 파일(SKP·3DM·GLB)에도 같은 한 줄과 페이지 주소를 메타데이터로 남긴다(attributionFileText).
 *
 * 레이어 패널의 "출처보기" 는 그 레이어의 인덱스만 받아 그 자료만 보인다(fetchLayerAttribution). 통합 창은 전 레이어를 합친다(fetchAttribution).
 *
 * 이 모듈은 DOM·React 를 쓰지 않는다(내보내기 Worker 가 import 한다). 서버 base URL 은 terrainIndex.ts(TTP_BASE)·
 * buildingsData.ts(BUILDINGS_BASE)와 같은 값인데, 그 모듈들이 proj4·ol 을 끌고 와 Worker 번들이 커지므로 여기 따로 적는다.
 */

import { LAYER_DEFS, LayerId } from "./layers"

/** 레이어 버킷(R2 커스텀 도메인). terrainIndex.ts TTP_BASE·buildingsData.ts BUILDINGS_BASE 의 공통 부분 */
const LAYERS_BASE = "https://layers.asrbbt.world"

/**
 * 레이어별로 `attribution` 이 실려 오는 서버 인덱스(2026-10-16 안내문 2.1절: 레이어마다 sheets50k.json). 새 레이어는 여기에 더한다.
 * 합본 JSON 은 요청하지 않기로 했다(계획서 11절. 창을 열 때만 받고 HTTP 캐시 1시간이라 비용이 작다)
 */
const LAYER_INDEX_URLS: Record<LayerId, string> = {
    terrain: `${LAYERS_BASE}/ttp/index/v1/sheets50k.json`,
    buildings: `${LAYERS_BASE}/buildings/index/v1/sheets50k.json`,
    roads: `${LAYERS_BASE}/roads/index/v1/sheets50k.json`,
}

/** 버킷 루트의 사람이 읽는 전체 표시문(텍스트). 출처 창에서 링크한다 */
export const ATTRIBUTION_TXT_URL = `${LAYERS_BASE}/ATTRIBUTION.txt`

/**
 * 지도 구석 한 줄. 안내문 4절의 "© 기관명" 은 사이트 저작권이 그 기관에 있는 것처럼 읽히고(공공누리의 "기관과 특수 관계로 오인하게
 * 하는 표시 금지" 조항과도 어긋날 소지), CC BY 4.0 3(a)·공공누리 모두 © 기호나 자리를 요구하지 않으므로 "출처" 로 적는다
 * (2026-10-16 결정 by @nanangqq). 긴 문구는 상태 표시줄이 좁은 창에서 잘라 버리는데, 전체는 출처 창에 있으니 약관상 문제 없다
 */
export const ATTRIBUTION_SHORT = "원본 데이터 출처: 국토지리정보원 · 국토교통부 · 브이월드"
/** 파일 메타데이터용 출처 한 줄(안내문 4절의 권장 문구에서 © 를 뺀 것. "가공" 은 CC BY 4.0 의 명시 요건) */
export const ATTRIBUTION_LINE = "국토지리정보원·국토교통부 (공공누리 제1유형, 가공) · 브이월드 · 건축물대장"
/** 면책(브이월드 답변: 수정·편집해 서비스하면 오류 책임이 이용자에게 귀속될 수 있다) */
export const ATTRIBUTION_DISCLAIMER = "가공 과정에서 생긴 오류의 책임은 원 제공기관에 있지 않습니다."

export const KOGL_URL = "https://www.kogl.or.kr/info/license.do"
export const CC_BY_URL = "https://creativecommons.org/licenses/by/4.0/deed.ko"

/** 서버 인덱스 `attribution.sources[]` 한 항목(안내문 2.1절). 대체문도 같은 모양 */
export type AttributionSource = {
    name: string
    provider: string
    /** 자료 기준일("2025-02"). 없으면 표시 안 함 */
    asof?: string
    portal?: string
    url?: string
    license: string
    license_url?: string
    license_note?: string
    /** 가공 내용. 서버는 레이어 단위 `processing` 으로 주므로 받은 뒤 각 source 에 붙인다 */
    processing?: string
}

/** 서버 인덱스의 `attribution` 키(안내문 2.1절) */
type IndexAttribution = {
    short?: string
    sources?: AttributionSource[]
    processing?: string
    disclaimer?: string
}

/** 레이어 하나의 출처(레이어 패널 "출처보기" 창) */
export type LayerAttribution = {
    /** 원자료(서버 인덱스 또는 대체문) */
    sources: AttributionSource[]
    disclaimer: string
    /** 서버에서 받았으면 true, 대체문이면 false(창에 작게 표시) */
    fromServer: boolean
}

/** 통합 출처 창·페이지가 그리는 내용(전 레이어 + 레이어 밖) */
export type Attribution = LayerAttribution & {
    /** 레이어 밖의 것(검색·바탕 지도). fb_web 이 직접 쓰므로 여기서 관리한다 */
    extras: AttributionSource[]
}

/** 서버를 못 받을 때의 레이어별 대체문(안내문 5절. 도로는 2026-10-17 roads 안내문과 인덱스 `attribution` 의 문구) */
const FALLBACK_SOURCES: Record<LayerId, AttributionSource[]> = {
    terrain: [
        {
            name: "지형 (등고선·표고점·하천경계·도엽인덱스)",
            provider: "국토지리정보원",
            asof: "2025-02",
            portal: "브이월드 데이터마켓",
            url: "https://www.vworld.kr/dtmk/dtmk_ntads_s002.do?svcCde=MK&dsId=20250121DS00013",
            license: "공공누리 제1유형 (출처표시)",
            license_url: KOGL_URL,
            processing: "좌표 변환, 도엽 단위 분할, 삼각분할 입력 형식으로 변환",
        },
    ],
    buildings: [
    {
        name: "건물 도형·용도·구조 (GIS건물통합정보)",
        provider: "국토교통부 국가공간정보센터",
        asof: "2026-09",
        portal: "브이월드 데이터마켓 / 공공데이터포털",
        url: "https://www.vworld.kr",
        license: "CC BY (저작자표시)",
        license_url: CC_BY_URL,
        processing: "좌표 변환, 도엽 단위 분할, 형식 변환",
    },
    {
        name: "건물 높이·층수·이름 보충 (건축물대장 표제부·총괄표제부)",
        provider: "국토교통부",
        asof: "2026-08",
        portal: "공공데이터포털",
        url: "https://www.data.go.kr",
        license: "이용허락범위 제한 없음",
        processing: "건물 도형과 필지 단위 연계, 오류 값 정제",
    },
    ],
    roads: [
        {
            name: "도로 (국가기본도 차도경계면·차도중심선)",
            provider: "국토지리정보원 (국토교통부)",
            asof: "2025-02",
            portal: "브이월드 데이터마켓",
            url: "https://www.vworld.kr/dtmk/dtmk_ntads_s002.do?svcCde=MK&dsId=20250122DS00013",
            license: "공공누리 제1유형 (출처표시)",
            license_url: KOGL_URL,
            processing: "좌표 변환, 도엽 단위 분할, 형식 변환, 중심선 이어 붙임, 조각에 중심선 속성 연결",
        },
    ],
}

/** 레이어 밖의 출처. 검색은 VWorld 통합 검색 API(vworld.ts), 바탕 지도는 basemap.ts 의 타일 출처 */
const EXTRA_SOURCES: AttributionSource[] = [
    {
        name: "주소·장소 검색",
        provider: "브이월드 통합 검색 API (국토교통부)",
        portal: "브이월드 오픈 API",
        url: "https://www.vworld.kr/dev/v4dv_apiguide_s001.do",
        license: "브이월드 오픈 API 이용약관",
    },
    {
        name: "바탕 지도 타일",
        provider: "© OpenStreetMap contributors · © CARTO · © Stadia Maps · © OpenMapTiles",
        portal: "OpenStreetMap 저작권 안내",
        url: "https://www.openstreetmap.org/copyright",
        license: "ODbL (OpenStreetMap) · 각 타일 제공자 약관",
    },
]

/** 출처 페이지 주소. 메인·Worker 공통(self.location 은 둘 다 있다). 정적 호스팅이라 해시 라우트 */
export const attributionPageUrl = () => `${self.location.origin}/#/attribution`

/**
 * 내려받기 파일 메타데이터에 적는 문구(여러 줄). GLB asset.copyright, 3DM 문서 문자열, SKP 그룹 속성에 같은 글을 넣는다
 */
export const attributionFileText = () =>
    `지형·건물·도로 데이터 출처: ${ATTRIBUTION_LINE}\n출처 전체: ${attributionPageUrl()} · ${ATTRIBUTION_TXT_URL}\n${ATTRIBUTION_DISCLAIMER}`

const layerCache = new Map<LayerId, Promise<LayerAttribution>>()

/**
 * 레이어 하나의 서버 인덱스에서 `attribution` 을 받는다(레이어마다 모듈 수명 동안 캐시). 못 받거나(R2 재업로드 전·캐시·오프라인)
 * 비어 있으면 그 레이어의 대체문. 서버는 가공 내용을 레이어 단위 `processing` 으로 주므로 source 마다 붙인다
 */
export const fetchLayerAttribution = (id: LayerId): Promise<LayerAttribution> => {
    let p = layerCache.get(id)
    if (p) return p
    p = fetch(LAYER_INDEX_URLS[id])
        .then((res) => (res.ok ? (res.json() as Promise<{ attribution?: IndexAttribution }>) : null))
        .then((json) => json?.attribution ?? null)
        .catch(() => null)
        .then((a): LayerAttribution => {
            if (!a?.sources?.length) return { sources: FALLBACK_SOURCES[id], disclaimer: ATTRIBUTION_DISCLAIMER, fromServer: false }
            return {
                sources: a.sources.map((s) => ({ ...s, processing: s.processing ?? a.processing })),
                disclaimer: a.disclaimer || ATTRIBUTION_DISCLAIMER,
                fromServer: true,
            }
        })
    layerCache.set(id, p)
    return p
}

/**
 * 전 레이어의 출처를 합친다(통합 창·페이지). 레이어별 결과(fetchLayerAttribution, 캐시 공유)를 패널 순서로 이어 붙이고 같은 이름의
 * source 는 한 번만 싣는다. 하나라도 서버에서 받았으면 fromServer
 */
export const fetchAttribution = async (): Promise<Attribution> => {
    const list = await Promise.all(LAYER_DEFS.map((d) => fetchLayerAttribution(d.id)))
    const sources: AttributionSource[] = []
    for (const a of list) for (const s of a.sources) if (!sources.some((x) => x.name === s.name)) sources.push(s)
    return {
        sources,
        extras: EXTRA_SOURCES,
        disclaimer: list.find((a) => a.fromServer)?.disclaimer ?? ATTRIBUTION_DISCLAIMER,
        fromServer: list.some((a) => a.fromServer),
    }
}
