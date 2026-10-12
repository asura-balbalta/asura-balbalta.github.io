import { Slider } from "@fluentui/react-components"
import React from "react"

import { DEFAULT_WALK_PHYSICS, WalkPhysics } from "../player"

/** 슬라이더 하나의 정의: 키, 이름, 범위, 단위 */
const CONTROLS: { key: keyof WalkPhysics; label: string; min: number; max: number; step: number; unit: string }[] = [
    { key: "gravity", label: "중력", min: 2, max: 40, step: 1, unit: "m/s²" },
    { key: "walkSpeed", label: "이동 속도", min: 2, max: 40, step: 1, unit: "m/s" },
    { key: "jumpSpeed", label: "점프", min: 2, max: 30, step: 1, unit: "m/s" },
    { key: "dashFactor", label: "대시 배속", min: 1, max: 10, step: 0.5, unit: "배" },
]

/**
 * 걸어 보기 중 물리 값을 바꾸는 테스트용 패널(미니맵 아래 오른쪽). 값은 바꾸는 즉시 플레이어에 반영되고 부모가 저장한다.
 * 초기값을 정하면 player.ts 의 DEFAULT_WALK_PHYSICS 로 옮긴다. 모양은 ui.css(.ui-walk-controls)
 *
 * @param props.physics 현재 값
 * @param props.onChange 값이 바뀔 때(부분 객체)
 * @param props.onReset 기본값으로 되돌리기
 */
export const WalkControls = ({
    physics,
    onChange,
    onReset,
}: {
    physics: WalkPhysics
    onChange: (next: Partial<WalkPhysics>) => void
    onReset: () => void
}) => (
    <div className="ui-walk-controls ui-panel">
        <div className="ui-walk-controls-header">
            <span className="ui-walk-controls-title">조절 (테스트용)</span>
            <button type="button" className="ui-walk-controls-reset" onClick={onReset}>
                기본값
            </button>
        </div>
        {CONTROLS.map(({ key, label, min, max, step, unit }) => (
            <label key={key} className="ui-walk-control">
                <span className="ui-walk-control-label">{label}</span>
                <Slider
                    size="small"
                    min={min}
                    max={max}
                    step={step}
                    value={physics[key]}
                    onChange={(_, data) => onChange({ [key]: data.value })}
                />
                <span className="ui-walk-control-value">
                    {physics[key]} {unit}
                </span>
            </label>
        ))}
        <div className="ui-walk-controls-note">
            기본값 중력 {DEFAULT_WALK_PHYSICS.gravity} · 이동 {DEFAULT_WALK_PHYSICS.walkSpeed} · 점프 {DEFAULT_WALK_PHYSICS.jumpSpeed} ·
            대시 {DEFAULT_WALK_PHYSICS.dashFactor}배
        </div>
    </div>
)
