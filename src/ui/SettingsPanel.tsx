import { Button, Checkbox, Input } from "@fluentui/react-components"
import React, { useEffect, useState } from "react"

import { BASEMAP_PROVIDERS, BasemapProvider } from "../basemap"
import { Theme } from "../terrainTheme"
import { WALK_RADIUS_CHOICES } from "../scenePalette"
import type { PaletteStore } from "../usePalettes"
import type { TerrainMode } from "../webgpu/terrainRenderer"
import { PaletteSection } from "./PaletteEditor"

/** 둘 중 하나를 고르는 세그먼트. 고른 쪽은 primary, 나머지는 secondary 버튼 */
const Segment = <T extends string>({
    value,
    options,
    onChange,
    disabled,
    label,
    minWidth,
}: {
    value: T
    options: { value: T; label: string }[]
    onChange: (value: T) => void
    disabled?: boolean
    label: string
    /** 버튼 최소 폭(px). 없으면 Fluent 기본(64). 선택지가 셋이라 한 줄에 안 들어갈 때 줄인다 */
    minWidth?: number
}) => (
    <div className="ui-segment" role="group" aria-label={label}>
        {options.map((o) => (
            <Button
                key={o.value}
                size="small"
                appearance={o.value === value ? "primary" : "secondary"}
                aria-pressed={o.value === value}
                disabled={disabled}
                onClick={() => onChange(o.value)}
                style={minWidth === undefined ? undefined : { minWidth }}
            >
                {o.label}
            </Button>
        ))}
    </div>
)

/** 계단 간격(m)의 허용 범위. 0.1 은 삼각형 메쉬 원형이 드러나 의미가 없어 0.3 부터 */
const STEP_MIN = 0.3
const STEP_MAX = 5

/**
 * 설정 패널의 내용. 테마(톤) · 색상표(PaletteSection) · 바탕 지도 · 보기 모드 · 계단 간격 · 품질. 테마·색상표·바탕 지도·보기·품질은 즉시 적용되고,
 * 계단 간격은 숫자를 바꾼 뒤 "다시 만들기"(또는 Enter)를 눌러야 적용된다(계단형 지형을 다시 만드는 일이라 명시적으로).
 * 테마 버튼은 그 톤의 내장 색상표를 고르는 것이고, 색상표를 고르면 톤이 따라간다(계획서 13절).
 *
 * @param props.paletteStore 색상표·품질 설정(usePalettes)
 * @param props.modeDisabled 아직 3D 지형이 없어 보기 모드를 바꿀 수 없을 때
 * @param props.onAttribution 꼬리말의 "데이터 출처" 를 눌렀을 때(출처 창 열기)
 */
export const SettingsPanel = ({
    theme,
    onTheme,
    paletteStore,
    basemap,
    onBasemap,
    mode,
    onMode,
    modeDisabled,
    stepInterval,
    onStepInterval,
    rebuildPending,
    onAttribution,
}: {
    theme: Theme
    onTheme: (theme: Theme) => void
    paletteStore: PaletteStore
    basemap: BasemapProvider
    onBasemap: (basemap: BasemapProvider) => void
    mode: TerrainMode
    onMode: (mode: TerrainMode) => void
    modeDisabled?: boolean
    stepInterval: number
    onStepInterval: (step: number) => void
    /** 간격 말고도 다시 만들어야 반영되는 설정이 바뀌었으면 true("먼 거리 계단 부드럽게" 생성 쪽). "다시 만들기" 를 켠다 */
    rebuildPending?: boolean
    onAttribution?: () => void
}) => {
    // 입력 중의 글자는 따로 두고, "다시 만들기" 를 눌렀을 때만 부모에 알린다
    const [stepText, setStepText] = useState(String(stepInterval))
    useEffect(() => setStepText(String(stepInterval)), [stepInterval])
    const stepValue = Number(stepText)
    const stepValid = Number.isFinite(stepValue) && stepValue >= STEP_MIN && stepValue <= STEP_MAX
    const stepChanged = stepValid && stepValue !== stepInterval
    // 지형을 만드는 중(또는 준비 전)에는 보기 모드처럼 계단 간격도 바꾸지 않는다(생성 중 스타일이 바뀌면 일부 도엽이 옛 간격으로 남는다. 2026-10-23)
    const canRebuild = !modeDisabled && (stepChanged || (stepValid && !!rebuildPending))
    const commitStep = () => {
        if (canRebuild) onStepInterval(stepValue)
    }
    return (
        <>
            <div className="ui-settings-row">
                <span>테마</span>
                <Segment
                    label="테마"
                    value={theme}
                    options={[
                        { value: "light", label: "라이트" },
                        { value: "dark", label: "다크" },
                    ]}
                    onChange={onTheme}
                />
            </div>
            <PaletteSection store={paletteStore} />
            <div className="ui-settings-row">
                <span>바탕 지도</span>
                <Segment
                    label="바탕 지도"
                    value={basemap}
                    options={BASEMAP_PROVIDERS.map((p) => ({ value: p.id, label: p.label }))}
                    onChange={onBasemap}
                />
            </div>
            <div className="ui-settings-divider" />
            <div className="ui-settings-head ui-label">지형</div>
            <div className="ui-settings-row">
                <span>보기</span>
                <Segment
                    label="보기 모드"
                    value={mode}
                    options={[
                        { value: "stepped", label: "계단형" },
                        { value: "tin", label: "매끈한 면" },
                    ]}
                    onChange={onMode}
                    disabled={modeDisabled}
                />
            </div>
            <div className="ui-settings-row">
                <label htmlFor="setting-step">계단 간격</label>
                <span className="ui-settings-input">
                    <Input
                        id="setting-step"
                        size="small"
                        type="number"
                        min={STEP_MIN}
                        max={STEP_MAX}
                        step={0.1}
                        value={stepText}
                        onChange={(_, data) => setStepText(data.value)}
                        onKeyDown={(e) => e.key === "Enter" && commitStep()}
                        aria-invalid={!stepValid}
                        disabled={modeDisabled}
                        style={{ width: 64 }}
                    />
                    <span className="ui-settings-unit">m</span>
                    <Button size="small" appearance={canRebuild ? "primary" : "secondary"} disabled={!canRebuild} onClick={commitStep}>
                        다시 만들기
                    </Button>
                </span>
            </div>
            <div className="ui-settings-row">
                {/* 먼 거리 계단 부드럽게(2026-10-22): 궤도 보기에도 적용되므로 "품질(둘러보기)" 가 아니라 지형 절에 둔다 */}
                <Checkbox
                    size="medium"
                    label="먼 거리 계단 부드럽게"
                    checked={paletteStore.quality.smoothFar}
                    onChange={(_, data) => paletteStore.setQuality({ smoothFar: data.checked === true })}
                />
            </div>
            <div className="ui-settings-divider" />
            <div className="ui-settings-head ui-label">품질 (둘러보기)</div>
            <div className="ui-quality-grid">
                {(
                    [
                        ["shadows", "그림자"],
                        ["ao", "주변광 차폐"],
                        ["sky", "하늘"],
                        ["edge", "외곽선"],
                    ] as const
                ).map(([key, label]) => (
                    <Checkbox
                        key={key}
                        size="medium"
                        label={label}
                        checked={paletteStore.quality[key]}
                        onChange={(_, data) => paletteStore.setQuality({ [key]: data.checked === true })}
                    />
                ))}
            </div>
            <div className="ui-settings-row">
                <span style={{ whiteSpace: "nowrap" }}>보이는 거리</span>
                <Segment
                    label="둘러보기 보이는 거리"
                    minWidth={52}
                    value={String(paletteStore.quality.walkRadius)}
                    options={WALK_RADIUS_CHOICES.map((m) => ({ value: String(m), label: `${m / 1000} km` }))}
                    onChange={(v) => paletteStore.setQuality({ walkRadius: Number(v) })}
                />
            </div>
            <div className="ui-panel-footer">
                계단 간격은 {STEP_MIN} ~ {STEP_MAX} m 입니다. 바꾼 뒤 "다시 만들기" 를 누르면 계단형 지형을 다시 만듭니다. 내장 그래픽처럼 느린
                기기에서 둘러보기 프레임이 낮으면 품질의 그림자·주변광 차폐부터 끄세요. 도엽 만들기가 느리면 "먼 거리 계단 부드럽게" 를 끄고 "다시
                만들기" 를 누르세요(화면은 바로 바뀌고, 생성 시간·메모리는 다시 만든 뒤부터 줄어듭니다). 보이는 거리를 줄이면 프레임이 빨라지고 GPU
                메모리가 줄지만, 먼 지형이 더 가까이 와서야 나타납니다.
                <div className="ui-panel-footer-line">
                    지형·건물·도로·물은 공공데이터를, 녹지는 OpenStreetMap 을 가공한 것입니다.{" "}
                    <button type="button" className="ui-link" onClick={onAttribution}>
                        원본 데이터 출처
                    </button>
                </div>
            </div>
        </>
    )
}
