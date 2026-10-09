import { Button, Input } from "@fluentui/react-components"
import React, { useEffect, useState } from "react"

import { BASEMAP_PROVIDERS, BasemapProvider } from "../basemap"
import type { TerrainSource } from "../terrainLoad.worker"
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

/**
 * 설정 패널의 내용. 테마 · 바탕 지도 · 보기 모드 · 계단 간격 · 지형 데이터 출처. 값을 바꾸면 즉시 적용된다.
 * 계단 간격과 출처는 지형을 다시 만들므로 app 이 그 처리를 맡는다.
 *
 * @param props.modeDisabled 아직 3D 지형이 없어 보기 모드를 바꿀 수 없을 때
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
    terrainSource,
    onTerrainSource,
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
    terrainSource: TerrainSource
    onTerrainSource: (source: TerrainSource) => void
}) => {
    // 입력 중의 글자는 따로 두고, 유효한 숫자(0.1 ~ 5)일 때만 부모에 알린다
    const [stepText, setStepText] = useState(String(stepInterval))
    useEffect(() => setStepText(String(stepInterval)), [stepInterval])
    const commitStep = () => {
        const v = Number(stepText)
        if (Number.isFinite(v) && v >= 0.1 && v <= 5) onStepInterval(v)
        else setStepText(String(stepInterval))
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
                        min={0.1}
                        max={5}
                        step={0.1}
                        value={stepText}
                        onChange={(_, data) => setStepText(data.value)}
                        onBlur={commitStep}
                        onKeyDown={(e) => e.key === "Enter" && commitStep()}
                        style={{ width: 64 }}
                    />
                    <span className="ui-settings-unit">m</span>
                </span>
            </div>
            <div className="ui-settings-row">
                <span>데이터 출처</span>
                <Segment
                    label="지형 데이터 출처"
                    value={terrainSource}
                    options={[
                        { value: "ttp", label: "ttp" },
                        { value: "ttm", label: "ttm" },
                    ]}
                    onChange={onTerrainSource}
                />
            </div>
            <div className="ui-panel-footer">계단 간격은 계단형 지형을, 출처는 지형 전체를 다시 만든다.</div>
        </>
    )
}
