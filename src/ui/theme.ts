import { Theme as FluentTheme, webDarkTheme, webLightTheme } from "@fluentui/react-components"
import { CSSProperties } from "react"

import { TERRAIN_THEMES, Theme } from "../terrainTheme"

/**
 * UI 글꼴. 웹폰트 없이 운영체제 글꼴(VS Code 와 같은 방식). macOS 는 Apple SD Gothic Neo, Windows 는 Segoe UI 와
 * 맑은 고딕으로 나온다. 바꾸려면 여기와 index.tsx 전역 CSS 를 함께 고친다
 */
export const UI_FONT_FAMILY =
    "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', sans-serif"

/**
 * 테마의 UI 색을 CSS 변수(--ui-<토큰 이름>)로 만든다. App 루트 요소의 style 에 걸어 두면 직접 그리는 그릇(레일·패널·
 * 상태 표시줄 등)이 var(--ui-text) 처럼 쓴다. 테마가 바뀌면 변수만 바뀌고 그릇은 다시 그려진다
 *
 * @param theme 색 테마
 */
export const uiCssVars = (theme: Theme): CSSProperties => {
    const vars: Record<string, string> = {}
    for (const [name, value] of Object.entries(TERRAIN_THEMES[theme].ui)) vars[`--ui-${name}`] = value
    return vars as CSSProperties
}

/**
 * Fluent UI 컨트롤(Button·Checkbox·Menu·Toast 등)에 넘길 테마. 라이트는 webLightTheme 그대로, 다크는 webDarkTheme 에서
 * 브랜드(강조) 계열만 terrainTheme 의 연한 하늘색으로 덮어쓴다. 글꼴은 둘 다 UI_FONT_FAMILY. 색의 원본은 terrainTheme.ts 라
 * 여기서는 값을 적지 않고 ui 블록에서 가져온다
 *
 * @param theme 색 테마
 */
export const fluentTheme = (theme: Theme): FluentTheme => {
    if (theme === "light") return { ...webLightTheme, fontFamilyBase: UI_FONT_FAMILY }
    const ui = TERRAIN_THEMES.dark.ui
    return {
        ...webDarkTheme,
        fontFamilyBase: UI_FONT_FAMILY,
        // 강조 채움(primary 버튼, 토글 켬)과 그 위 글자
        colorBrandBackground: ui.accent,
        colorBrandBackgroundHover: ui["accent-hover"],
        colorBrandBackgroundPressed: ui["accent-pressed"],
        colorBrandBackgroundSelected: ui["accent-pressed"],
        colorNeutralForegroundOnBrand: ui["text-on-accent"],
        // 강조색 글자·링크
        colorBrandForeground1: ui["accent-text"],
        colorBrandForeground2: ui["accent-text"],
        colorBrandForegroundLink: ui["accent-text"],
        colorBrandForegroundLinkHover: ui["accent-hover"],
        colorBrandForegroundLinkPressed: ui["accent-pressed"],
        // 체크박스·스위치·진행 막대가 쓰는 compound 브랜드
        colorCompoundBrandBackground: ui.accent,
        colorCompoundBrandBackgroundHover: ui["accent-hover"],
        colorCompoundBrandBackgroundPressed: ui["accent-pressed"],
        colorCompoundBrandForeground1: ui["accent-text"],
        colorCompoundBrandForeground1Hover: ui["accent-hover"],
        colorCompoundBrandForeground1Pressed: ui["accent-pressed"],
        colorCompoundBrandStroke: ui.accent,
        colorCompoundBrandStrokeHover: ui["accent-hover"],
        colorCompoundBrandStrokePressed: ui["accent-pressed"],
        colorBrandStroke1: ui.accent,
        colorBrandStroke2: ui["accent-tint"],
    }
}
