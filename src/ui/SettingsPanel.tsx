import { Button, Input } from "@fluentui/react-components"
import React, { useEffect, useState } from "react"

import { BASEMAP_PROVIDERS, BasemapProvider } from "../basemap"
import { Theme } from "../terrainTheme"
import type { TerrainMode } from "../webgpu/terrainRenderer"

/** 둘 중 하나를 고르는 세그먼트. 고른 쪽은 primary, 나머지는 secondary 버튼 */
const Segment = <T extends string>({
    value,
    options,
    onChange,
    disabled,
    label,
}: {
    value: T
    options: { value: T; label: string }[]
    onChange: (value: T) => void
    disabled?: boolean
    label: string
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
 * 설정 패널의 내용. 테마 · 바탕 지도 · 보기 모드 · 계단 간격. 테마·바탕 지도·보기는 누르면 즉시 적용되고,
 * 계단 간격은 숫자를 바꾼 뒤 "다시 만들기"(또는 Enter)를 눌러야 적용된다(계단형 지형을 다시 만드는 일이라 명시적으로).
 *
 * @param props.modeDisabled 아직 3D 지형이 없어 보기 모드를 바꿀 수 없을 때
 * @param props.onAttribution 꼬리말의 "데이터 출처" 를 눌렀을 때(출처 창 열기)
 */
export const SettingsPanel = ({
    theme,
    onTheme,
    basemap,
    onBasemap,
    mode,
    onMode,
    modeDisabled,
    stepInterval,
    onStepInterval,
    onAttribution,
}: {
    theme: Theme
    onTheme: (theme: Theme) => void
    basemap: BasemapProvider
    onBasemap: (basemap: BasemapProvider) => void
    mode: TerrainMode
    onMode: (mode: TerrainMode) => void
    modeDisabled?: boolean
    stepInterval: number
    onStepInterval: (step: number) => void
    onAttribution?: () => void
}) => {
    // 입력 중의 글자는 따로 두고, "다시 만들기" 를 눌렀을 때만 부모에 알린다
    const [stepText, setStepText] = useState(String(stepInterval))
    useEffect(() => setStepText(String(stepInterval)), [stepInterval])
    const stepValue = Number(stepText)
    const stepValid = Number.isFinite(stepValue) && stepValue >= STEP_MIN && stepValue <= STEP_MAX
    const stepChanged = stepValid && stepValue !== stepInterval
    const commitStep = () => {
        if (stepChanged) onStepInterval(stepValue)
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
                        style={{ width: 64 }}
                    />
                    <span className="ui-settings-unit">m</span>
                    <Button size="small" appearance={stepChanged ? "primary" : "secondary"} disabled={!stepChanged} onClick={commitStep}>
                        다시 만들기
                    </Button>
                </span>
            </div>
            <div className="ui-panel-footer">
                계단 간격은 {STEP_MIN} ~ {STEP_MAX} m 입니다. 바꾼 뒤 "다시 만들기" 를 누르면 계단형 지형을 다시 만듭니다.
                <div className="ui-panel-footer-line">
                    지형·건물은 공공데이터를 가공한 것입니다.{" "}
                    <button type="button" className="ui-link" onClick={onAttribution}>
                        원본 데이터 출처
                    </button>
                </div>
            </div>
        </>
    )
}
