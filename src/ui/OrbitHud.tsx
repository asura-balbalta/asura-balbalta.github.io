import { PhoneVerticalScrollFilled } from "@fluentui/react-icons"
import React from "react"

/**
 * 궤도 보기(3D 화면, 걸어 보기 전)의 마우스 조작 안내: 위 가운데 36px 유리 알약에 "[왼쪽 버튼] pan | [오른쪽 버튼] orbit | [휠] zoom".
 * 걸어 보기 중의 키 안내(WalkHud)와 같은 자리·같은 꼴이라 둘이 번갈아 선다. 입력은 받지 않는다(안내만).
 * 모양은 ui.css(.ui-orbit-hud 는 .ui-walk-hud 와 규칙을 나눠 쓴다, .ui-mouse-icon). 데스크톱만(터치는 한 손가락 회전·두 손가락 확대)
 *
 * 마우스 버튼 아이콘은 Phosphor Icons 의 mouse-left-click / mouse-right-click (fill 변형) path 를 그대로 가져왔다
 * (https://github.com/phosphor-icons/core, MIT License, Copyright (c) 2023 Phosphor Icons). Fluent 에는 버튼을 가른 마우스 아이콘이
 * 없고, 윤곽선만 그린 자작 아이콘은 옛 스타일로 보였다(2026-10-14, by @nanangqq). 휠은 Fluent 의 PhoneVerticalScrollFilled
 */

/** Phosphor mouse-left-click-fill / mouse-right-click-fill (viewBox 0 0 256 256) */
const PHOSPHOR_MOUSE: Record<"left" | "right", string> = {
    left: "M144,16H112A64.07,64.07,0,0,0,48,80v96a64.07,64.07,0,0,0,64,64h32a64.07,64.07,0,0,0,64-64V80A64.07,64.07,0,0,0,144,16Zm48,64v24H128V32h16A48.05,48.05,0,0,1,192,80ZM144,224H112a48.05,48.05,0,0,1-48-48V120H192v56A48.05,48.05,0,0,1,144,224Z",
    right: "M144,16H112A64.07,64.07,0,0,0,48,80v96a64.07,64.07,0,0,0,64,64h32a64.07,64.07,0,0,0,64-64V80A64.07,64.07,0,0,0,144,16ZM112,32h16v72H64V80A48.05,48.05,0,0,1,112,32Zm32,192H112a48.05,48.05,0,0,1-48-48V120H192v56A48.05,48.05,0,0,1,144,224Z",
}

/**
 * 마우스 아이콘(18px). 몸통은 채우고 누르는 버튼 쪽만 파여 있다
 *
 * @param props.part 강조할 버튼
 */
const MouseIcon = ({ part }: { part: "left" | "right" }) => (
    <svg className="ui-mouse-icon" width="18" height="18" viewBox="0 0 256 256" aria-hidden="true">
        <path d={PHOSPHOR_MOUSE[part]} />
    </svg>
)

/** 조작 항목: [아이콘, 뜻] */
const ITEMS: [key: string, icon: React.ReactElement, label: string][] = [
    ["left", <MouseIcon part="left" />, "pan"],
    ["right", <MouseIcon part="right" />, "orbit"],
    ["wheel", <PhoneVerticalScrollFilled fontSize={18} />, "zoom"],
]

export const OrbitHud = () => (
    <div className="ui-orbit-hud ui-glass" role="status" aria-label="마우스 조작: 왼쪽 끌기 pan, 오른쪽 끌기 orbit, 휠 zoom">
        {ITEMS.map(([key, icon, label], i) => (
            <React.Fragment key={key}>
                {i > 0 && <span className="ui-walk-hud-sep" />}
                <span className="ui-walk-key">
                    {icon}
                    {label}
                </span>
            </React.Fragment>
        ))}
    </div>
)
