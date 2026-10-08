/** 화면 테마. 지도 타일(Stadia alidade_smooth / _dark)과 3D 지형의 색을 함께 바꾼다 */
export type Theme = "light" | "dark"

/** 표고(m, 절대값) → 바탕색 단계. 단계 사이는 선형 보간, 양 끝 밖은 끝 색 */
export type ElevationStop = { z: number; hex: string }

/** 색표 단계 수. 셰이더의 uniform 배열 크기와 같아야 한다(shaders.ts, terrainRenderer.ts) */
export const STOP_COUNT = 6

/** 지도 위 오버레이(사각형 선택 박스·1K 도엽 외곽선) 색. 바탕 타일 톤에 맞춰 테마마다 다르다 */
export type MapOverlayColors = {
    /** 선택 박스 테두리 */
    selectionStroke: string
    /** 선택 박스 채움(반투명) */
    selectionFill: string
    /** 1K 도엽 외곽선 */
    tileStroke: string
    /** 1K 도엽 이름 글자 */
    tileText: string
}

export type TerrainTheme = {
    /** StadiaMaps 레이어 이름 */
    mapLayer: "alidade_smooth" | "alidade_smooth_dark"
    /** 지도 위 오버레이 색 */
    mapOverlay: MapOverlayColors
    /** 3D 화면 배경색(0 ~ 1). 지형 가장자리가 또렷하도록 지형 색과 차이를 둔다 */
    background: { r: number; g: number; b: number }
    /** 표고 색표. 지도 타일의 톤에 맞춘 것. 같은 높이는 선택 범위와 무관하게 같은 색 */
    stops: ElevationStop[]
    /** 건물 레이어 색("#RRGGBB"). 지붕 기준이고 벽은 셰이더가 25% 어둡게 한다 */
    buildingColor: string
}

/** "#RRGGBB" → 0 ~ 1 rgb */
export const hexToRgb = (hex: string) => {
    const n = parseInt(hex.slice(1), 16)
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }
}

/**
 * 테마별 설정. 수면은 서울 한강 EL 2~3m(서버는 강 위 꼭짓점을 2.5m 로 둠)라 3m 까지, 평지 8~60m 는 한 색, 그 위로 갈수록
 * 라이트는 짙게·다크는 밝게. 색은 각 지도 타일의 물·땅·도로 색에서 뽑았다. 지역에 따라 단계 값을 조정한다.
 */
export const TERRAIN_THEMES: Record<Theme, TerrainTheme> = {
    light: {
        mapLayer: "alidade_smooth",
        // 밝은 회백색 타일 위라 연한 색은 묻힌다. 선택 박스는 진한 하늘색, 도엽은 진한 주황
        mapOverlay: {
            selectionStroke: "#0369A1",
            selectionFill: "rgba(3, 105, 161, 0.12)",
            tileStroke: "#EA580C",
            tileText: "#9A3412",
        },
        background: hexToRgb("#5B6064"),
        stops: [
            { z: 3, hex: "#B3BDC1" }, // 수면
            { z: 8, hex: "#EEEFED" }, // 강변 평지
            { z: 60, hex: "#EEEFED" }, // 시가지 평지
            { z: 200, hex: "#CDD1D0" }, // 구릉
            { z: 500, hex: "#A8ADAE" }, // 산지
            { z: 1000, hex: "#7E8486" }, // 고산
        ],
        buildingColor: "#CFC9C0", // 평지(#EEEFED)보다 조금 어두운 따뜻한 회색
    },
    dark: {
        mapLayer: "alidade_smooth_dark",
        // 어두운 타일 위라 연한 색이 잘 보인다
        mapOverlay: {
            selectionStroke: "#BAE6FD",
            selectionFill: "rgba(186, 230, 253, 0.1)",
            tileStroke: "#FB923C",
            tileText: "#FDBA74",
        },
        background: hexToRgb("#0B0C0E"),
        stops: [
            { z: 3, hex: "#15171A" }, // 수면
            { z: 8, hex: "#313335" }, // 강변 평지
            { z: 60, hex: "#313335" }, // 시가지 평지
            { z: 200, hex: "#44474A" }, // 구릉
            { z: 500, hex: "#5B5F62" }, // 산지
            { z: 1000, hex: "#787D80" }, // 고산
        ],
        buildingColor: "#6B7075", // 평지(#313335)보다 밝은 회색
    },
}

/**
 * 색표를 셰이더 uniform 배열(vec4f × STOP_COUNT: z, r, g, b)로 만든다.
 *
 * @param stops 단계 STOP_COUNT 개(높이 오름차순)
 */
export const stopsToUniform = (stops: ElevationStop[]) => {
    if (stops.length !== STOP_COUNT) throw new Error(`색표 단계는 ${STOP_COUNT}개여야 함 (${stops.length}개)`)
    const out = new Float32Array(4 * STOP_COUNT)
    stops.forEach((s, i) => {
        const { r, g, b } = hexToRgb(s.hex)
        out.set([s.z, r, g, b], 4 * i)
    })
    return out
}
