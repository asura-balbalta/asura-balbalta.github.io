import React from "react"

/**
 * 궤도 보기(3D 화면, 걸어 보기 전)의 마우스 조작 안내: 위 가운데 36px 유리 알약에 "[왼쪽 버튼] 이동 | [오른쪽 버튼] 회전 | [휠] 확대".
 * 걸어 보기 중의 키 안내(WalkHud)와 같은 자리·같은 꼴이라 둘이 번갈아 선다. 입력은 받지 않는다(안내만).
 * 모양은 ui.css(.ui-orbit-hud 는 .ui-walk-hud 와 규칙을 나눠 쓴다, .ui-mouse-icon). 데스크톱만(터치는 한 손가락 회전·두 손가락 확대)
 */

/** 조작 항목: [마우스 부위, 뜻] */
const ITEMS: [part: "left" | "right" | "wheel", label: string][] = [
    ["left", "이동"],
    ["right", "회전"],
    ["wheel", "확대·축소"],
]

/**
 * 마우스 아이콘(14×20). 몸통 윤곽에 위쪽 두 버튼을 가르는 선, part 가 가리키는 부위만 채운다(휠은 가운데 작은 막대)
 *
 * @param props.part 강조할 부위
 */
const MouseIcon = ({ part }: { part: "left" | "right" | "wheel" }) => (
    <svg className="ui-mouse-icon" width="14" height="20" viewBox="0 0 14 20" aria-hidden="true">
        {part === "left" && <path d="M1 7A6 6 0 0 1 7 1V9H1Z" className="ui-mouse-fill" />}
        {part === "right" && <path d="M7 1A6 6 0 0 1 13 7V9H7Z" className="ui-mouse-fill" />}
        <rect x="1" y="1" width="12" height="18" rx="6" className="ui-mouse-line" />
        <path d="M1 9H13M7 1V9" className="ui-mouse-line" />
        {part === "wheel" && <rect x="6" y="3.5" width="2" height="4" rx="1" className="ui-mouse-fill" />}
    </svg>
)

export const OrbitHud = () => (
    <div className="ui-orbit-hud ui-glass" role="status" aria-label="마우스 조작: 왼쪽 끌기 이동, 오른쪽 끌기 회전, 휠 확대·축소">
        {ITEMS.map(([part, label], i) => (
            <React.Fragment key={part}>
                {i > 0 && <span className="ui-walk-hud-sep" />}
                <span className="ui-walk-key">
                    <MouseIcon part={part} />
                    {label}
                </span>
            </React.Fragment>
        ))}
    </div>
)
