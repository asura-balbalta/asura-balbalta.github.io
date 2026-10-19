/** 화면 테마. 지도 타일 톤(라이트/다크, 출처는 basemap.ts)과 3D 지형의 색을 함께 바꾼다 */
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

/**
 * UI(레일·패널·상태 표시줄·토스트 등) 색 토큰. 이름은 디자인 시스템 "아수라발발타 UI" 의 tokens.json 과 같고,
 * 값의 원본은 이 파일이다(tokens.json 은 거울). 라이트는 Fluent UI v9 webLightTheme 값 그대로, 다크는 webDarkTheme 에서
 * accent 계열만 연한 하늘색으로 덮어쓴 것. 그릇 컴포넌트는 CSS 변수(--ui-<이름>, ui/theme.ts)로, Fluent 컨트롤은
 * 테마 객체(ui/theme.ts fluentTheme)로 이 값을 받는다. 디자인 근거는 docs/design-system-plan.md
 */
export type UiToken =
    | "text"
    | "text-secondary"
    | "text-on-glass-secondary"
    | "text-disabled"
    | "text-on-accent"
    | "accent"
    | "accent-hover"
    | "accent-pressed"
    | "accent-text"
    | "accent-tint"
    | "success"
    | "warning"
    | "danger"
    | "panel"
    | "panel-2"
    | "hover"
    | "selected"
    | "disabled-bg"
    | "border"
    | "divider"
    | "border-disabled"
    | "focus"
    | "focus-inner"
    | "glass"
    | "glass-strong"
    | "glass-edge"
    | "glass-highlight"

export type UiColors = Record<UiToken, string>

export type TerrainTheme = {
    /** 바탕 지도 톤. 출처(Stadia·CARTO 등)마다 이 톤의 스타일을 고른다(basemap.ts) */
    basemap: "light" | "dark"
    /** 지도 위 오버레이 색 */
    mapOverlay: MapOverlayColors
    /** UI 색 토큰 */
    ui: UiColors
    /** 3D 화면 배경색(0 ~ 1). 지형 가장자리가 또렷하도록 지형 색과 차이를 둔다 */
    background: { r: number; g: number; b: number }
    /** 표고 색표. 지도 타일의 톤에 맞춘 것. 같은 높이는 선택 범위와 무관하게 같은 색 */
    stops: ElevationStop[]
    /** 건물 레이어 색("#RRGGBB"). 지붕 기준이고 벽은 셰이더가 25% 어둡게 한다 */
    buildingColor: string
    /**
     * 도로 레이어 색("#RRGGBB", 종류 구분 없이 한 색. 2026-10-19 결정 by @nanangqq). 바탕 지도 타일(Positron·Dark Matter·Alidade)이 두 톤 모두
     * 도로를 땅보다 밝게 그리므로 같은 규칙: 평지보다 밝게. 타일 픽셀을 재서 뽑은 값은 아니라 디버그 roadscolor= 로 Chrome 비교 뒤 정한다
     */
    roadColor: string
    /** 둘러보기 하늘의 태양 고도(°). 방위각은 그림자 빛(남동)과 같다. 음수면 지평선 아래(저녁) */
    sunAltitude: number
}

/** "#RRGGBB" → 0 ~ 1 rgb */
export const hexToRgb = (hex: string) => {
    const n = parseInt(hex.slice(1), 16)
    return {
        r: ((n >> 16) & 255) / 255,
        g: ((n >> 8) & 255) / 255,
        b: (n & 255) / 255,
    }
}

/**
 * 테마별 설정. 수면은 서울 한강 EL 2~3m(서버는 강 위 꼭짓점을 2.5m 로 둠)라 3m 까지, 평지 8~60m 는 한 색, 그 위로 갈수록
 * 라이트는 짙게·다크는 밝게. 색은 각 지도 타일의 물·땅·도로 색에서 뽑았다. 지역에 따라 단계 값을 조정한다.
 */
export const TERRAIN_THEMES: Record<Theme, TerrainTheme> = {
    light: {
        basemap: "light",
        // 밝은 회백색 타일 위라 연한 색은 묻힌다. 선택 박스는 UI 강조색(ui.accent)과 같은 파랑, 도엽은 진한 주황
        mapOverlay: {
            selectionStroke: "#0f6cbd",
            selectionFill: "rgba(15, 108, 189, 0.12)",
            tileStroke: "#EA580C",
            tileText: "#9A3412",
        },
        ui: {
            text: "#242424",
            "text-secondary": "#616161",
            "text-on-glass-secondary": "#424242",
            "text-disabled": "#bdbdbd",
            "text-on-accent": "#ffffff",
            accent: "#0f6cbd",
            "accent-hover": "#115ea3",
            "accent-pressed": "#0c3b5e",
            "accent-text": "#0f6cbd",
            "accent-tint": "rgba(15, 108, 189, 0.1)",
            success: "#0e700e",
            warning: "#bc4b09",
            danger: "#b10e1c",
            panel: "#ffffff",
            "panel-2": "#fafafa",
            hover: "#f5f5f5",
            selected: "#ebebeb",
            "disabled-bg": "#f0f0f0",
            border: "#d1d1d1",
            divider: "#e0e0e0",
            "border-disabled": "#e0e0e0",
            focus: "#000000",
            "focus-inner": "#ffffff",
            // 옅은 하늘색(accent 와 같은 색상 약 208°): 3D 화면의 WebGL 유리 틴트(liquidGlass.ts)와 같은 톤. 무색 흰색은 회색 건물 위에서 묻혔다
            glass: "rgba(212, 233, 251, 0.3)",
            "glass-strong": "rgba(255, 255, 255, 0.8)",
            "glass-edge": "rgba(255, 255, 255, 0.45)",
            "glass-highlight": "rgba(255, 255, 255, 0.55)",
        },
        background: hexToRgb("#5B6064"),
        sunAltitude: 60,
        stops: [
            { z: 3, hex: "#B3BDC1" }, // 수면
            { z: 8, hex: "#EEEFED" }, // 강변 평지
            { z: 60, hex: "#EEEFED" }, // 시가지 평지
            { z: 200, hex: "#CDD1D0" }, // 구릉
            { z: 500, hex: "#A8ADAE" }, // 산지
            { z: 1000, hex: "#7E8486" }, // 고산
        ],
        buildingColor: "#CFC9C0", // 평지(#EEEFED)보다 조금 어두운 따뜻한 회색
        roadColor: "#FAFAF8", // 평지(#EEEFED)보다 밝은 흰색에 가까운 회색(건물보다 밝아 구분)
    },
    dark: {
        basemap: "dark",
        // 어두운 타일 위라 연한 색이 잘 보인다
        mapOverlay: {
            selectionStroke: "#BAE6FD",
            selectionFill: "rgba(186, 230, 253, 0.1)",
            tileStroke: "#FB923C",
            tileText: "#FDBA74",
        },
        ui: {
            text: "#ffffff",
            "text-secondary": "#adadad",
            "text-on-glass-secondary": "#d6d6d6",
            "text-disabled": "#5c5c5c",
            "text-on-accent": "#242424",
            accent: "#bae6fd",
            "accent-hover": "#a9d5ec",
            "accent-pressed": "#99c4db",
            "accent-text": "#bae6fd",
            "accent-tint": "rgba(186, 230, 253, 0.14)",
            success: "#54b054",
            warning: "#faa06b",
            danger: "#dc626d",
            panel: "#292929",
            "panel-2": "#1f1f1f",
            hover: "#3d3d3d",
            selected: "#383838",
            "disabled-bg": "#141414",
            border: "#666666",
            divider: "#525252",
            "border-disabled": "#424242",
            focus: "#ffffff",
            "focus-inner": "#000000",
            glass: "rgba(18, 32, 46, 0.35)",
            "glass-strong": "rgba(31, 31, 31, 0.7)",
            "glass-edge": "rgba(255, 255, 255, 0.1)",
            "glass-highlight": "rgba(255, 255, 255, 0.08)",
        },
        background: hexToRgb("#0B0C0E"),
        sunAltitude: -4,
        stops: [
            { z: 3, hex: "#15171A" }, // 수면
            { z: 8, hex: "#313335" }, // 강변 평지
            { z: 60, hex: "#313335" }, // 시가지 평지
            { z: 200, hex: "#44474A" }, // 구릉
            { z: 500, hex: "#5B5F62" }, // 산지
            { z: 1000, hex: "#787D80" }, // 고산
        ],
        buildingColor: "#6B7075", // 평지(#313335)보다 밝은 회색
        roadColor: "#44484C", // 평지보다 밝고 건물보다 어두운 회색
    },
}

/**
 * 색표를 셰이더 uniform 배열(vec4f × STOP_COUNT: z, r, g, b)로 만든다.
 *
 * @param stops 단계 STOP_COUNT 개(높이 오름차순)
 */
export const stopsToUniform = (stops: ElevationStop[]) => {
    if (stops.length !== STOP_COUNT)
        throw new Error(
            `색표 단계는 ${STOP_COUNT}개여야 함 (${stops.length}개)`,
        )
    const out = new Float32Array(4 * STOP_COUNT)
    stops.forEach((s, i) => {
        const { r, g, b } = hexToRgb(s.hex)
        out.set([s.z, r, g, b], 4 * i)
    })
    return out
}
