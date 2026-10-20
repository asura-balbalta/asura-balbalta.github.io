import { ElevationStop, STOP_COUNT, Theme } from "./terrainTheme"

/**
 * 장면 색상표(2026-10-20, 계획서 13절). 셰이더 uniform 으로 가는 3D 장면의 색과 분위기를 한 묶음으로 두어 사용자가 고르고 편집한다.
 * UI 토큰·지도 오버레이·바탕 지도 톤은 여기 없고 라이트/다크 톤(terrainTheme.ts TERRAIN_THEMES)에 남는다. 색상표마다 어울리는 톤(tone)을
 * 적어 두어 색상표를 고르면 톤이 따라간다.
 *
 * 내장 색상표 둘(light·dark)은 전에 TERRAIN_THEMES 에 있던 값 그대로다. 사용자 색상표는 localStorage(키 STORAGE_KEYS)에 배열로 저장한다.
 * 이 모듈은 DOM·React 를 쓰지 않는다
 */

/** 둘러보기 조명 세기. 궤도 보기 조명(terrainRenderer DEFAULT_LIGHTING)은 색상표와 무관하게 고정이다 */
export type WalkLightingStrength = {
    /** 주변광(0 ~ 1) */
    ambient: number
    /** 난반사(0 ~ 1) */
    diffuse: number
    /** 반구 조명 세기(0 ~ 1). 수직면의 주변광이 이만큼 줄어든다 */
    hemisphere: number
    /** 안개 밀도(1/m). 0 이면 없음 */
    fogDensity: number
}

export type ScenePalette = {
    /** "light" | "dark"(내장) 또는 "user-<시각>" */
    id: string
    /** 패널에 보이는 이름 */
    name: string
    /** 어울리는 UI·지도 톤 */
    tone: Theme
    /** 3D 배경색(= 안개색) "#RRGGBB" */
    background: string
    /** 표고 색표. 정확히 STOP_COUNT 단계, z 오름차순 */
    stops: ElevationStop[]
    buildingColor: string
    roadColor: string
    /** 하늘·그림자 빛의 태양 고도(°). 음수면 지평선 아래(저녁) */
    sunAltitude: number
    walkLighting: WalkLightingStrength
}

/** 효과 켜고 끄기(품질 설정. 내장 그래픽에서 프레임을 떨어뜨리는 pass 들). 색상표가 아니라 따로 저장한다 */
export type QualitySettings = {
    shadows: boolean
    ao: boolean
    sky: boolean
    edge: boolean
}
export const DEFAULT_QUALITY: QualitySettings = { shadows: true, ao: true, sky: true, edge: true }

/** 둘러보기 조명 세기 기본값(전 walkLighting 상수) */
export const DEFAULT_WALK_LIGHTING: WalkLightingStrength = { ambient: 0.5, diffuse: 0.5, hemisphere: 0.35, fogDensity: 1 / 1200 }

/** 내장 색상표. 값은 2026-10-20 까지 TERRAIN_THEMES 에 있던 것 그대로(라이트: 지도 타일 톤, 다크: 어두운 타일 위) */
export const BUILTIN_PALETTES: ScenePalette[] = [
    {
        id: "light",
        name: "라이트",
        tone: "light",
        background: "#5B6064",
        sunAltitude: 60,
        // 수면은 서울 한강 EL 2~3m(서버는 강 위 꼭짓점을 2.5m 로 둠)라 3m 까지, 평지 8~60m 는 한 색, 그 위로 갈수록 짙게
        stops: [
            { z: 3, hex: "#B3BDC1" }, // 수면
            { z: 8, hex: "#EEEFED" }, // 강변 평지
            { z: 60, hex: "#EEEFED" }, // 시가지 평지
            { z: 200, hex: "#CDD1D0" }, // 구릉
            { z: 500, hex: "#A8ADAE" }, // 산지
            { z: 1000, hex: "#7E8486" }, // 고산
        ],
        buildingColor: "#CFC9C0", // 평지(#EEEFED)보다 조금 어두운 따뜻한 회색
        roadColor: "#FAFAF8", // 평지보다 밝은 흰색에 가까운 회색(후보. 평평한 시가지에서 묻히면 #E4E6E3 같은 어두운 쪽을 견준다)
        walkLighting: DEFAULT_WALK_LIGHTING,
    },
    {
        id: "dark",
        name: "다크",
        tone: "dark",
        background: "#0B0C0E",
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
        walkLighting: DEFAULT_WALK_LIGHTING,
    },
]

/** 톤의 내장 색상표 */
export const builtinPalette = (tone: Theme): ScenePalette => BUILTIN_PALETTES.find((p) => p.id === tone) ?? BUILTIN_PALETTES[0]
export const isBuiltinPalette = (id: string) => BUILTIN_PALETTES.some((p) => p.id === id)

/** localStorage 키 */
export const PALETTE_STORAGE_KEYS = {
    /** 고른 색상표 id */
    selected: "fb_web.palette.selected",
    /** 사용자 색상표 배열(ScenePalette[]) */
    user: "fb_web.palettes.user",
    /** 품질 설정(QualitySettings) */
    quality: "fb_web.quality",
} as const

/** 깊은 복사 */
export const clonePalette = (p: ScenePalette): ScenePalette => ({
    ...p,
    stops: p.stops.map((s) => ({ ...s })),
    walkLighting: { ...p.walkLighting },
})

/** 사용자 색상표 새 id */
export const newPaletteId = () => `user-${Date.now().toString(36)}`

const HEX = /^#[0-9a-fA-F]{6}$/
const isHex = (v: unknown): v is string => typeof v === "string" && HEX.test(v)
const num = (v: unknown, fallback: number, min = -Infinity, max = Infinity) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback

/**
 * localStorage(나중에는 JSON 파일)에서 읽은 값을 색상표로 정리한다. 모양이 틀리면 null, 항목이 빠지거나 범위를 벗어나면 내장 값으로 메운다.
 * 색표는 정확히 STOP_COUNT 단계로 맞추고 z 오름차순으로 정렬한다
 */
export const sanitizePalette = (raw: unknown): ScenePalette | null => {
    if (!raw || typeof raw !== "object") return null
    const r = raw as Record<string, unknown>
    if (typeof r.id !== "string" || r.id.length === 0) return null
    const tone: Theme = r.tone === "dark" ? "dark" : "light"
    const base = builtinPalette(tone)
    const stopsRaw = Array.isArray(r.stops) ? r.stops : []
    const stops: ElevationStop[] = []
    for (let i = 0; i < STOP_COUNT; i++) {
        const s = (stopsRaw[i] ?? {}) as Record<string, unknown>
        stops.push({ z: num(s.z, base.stops[i].z, -500, 10000), hex: isHex(s.hex) ? s.hex : base.stops[i].hex })
    }
    stops.sort((a, b) => a.z - b.z)
    const wl = (r.walkLighting ?? {}) as Record<string, unknown>
    return {
        id: r.id,
        name: typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 40) : base.name,
        tone,
        background: isHex(r.background) ? r.background : base.background,
        stops,
        buildingColor: isHex(r.buildingColor) ? r.buildingColor : base.buildingColor,
        roadColor: isHex(r.roadColor) ? r.roadColor : base.roadColor,
        sunAltitude: num(r.sunAltitude, base.sunAltitude, -30, 90),
        walkLighting: {
            ambient: num(wl.ambient, base.walkLighting.ambient, 0, 1),
            diffuse: num(wl.diffuse, base.walkLighting.diffuse, 0, 1),
            hemisphere: num(wl.hemisphere, base.walkLighting.hemisphere, 0, 1),
            fogDensity: num(wl.fogDensity, base.walkLighting.fogDensity, 0, 0.01),
        },
    }
}

/** 품질 설정 읽기 정리 */
export const sanitizeQuality = (raw: unknown): QualitySettings => {
    const r = (raw ?? {}) as Record<string, unknown>
    const b = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback)
    return {
        shadows: b(r.shadows, DEFAULT_QUALITY.shadows),
        ao: b(r.ao, DEFAULT_QUALITY.ao),
        sky: b(r.sky, DEFAULT_QUALITY.sky),
        edge: b(r.edge, DEFAULT_QUALITY.edge),
    }
}
