import React from "react"

import { HintPill } from "./HintPill"

/** 키 안내 항목: [키, 뜻] */
const KEYS: [string, string][] = [
    ["W A S D", "이동"],
    ["마우스", "시점"],
    ["Space", "점프"],
    ["W W", "대시"],
]

/**
 * 조준경(화면 가운데). 평소엔 작은 십자(가운데 점 + 팔 네 개)만. 건물이 걸리면(targeting) 십자가 1.35배 벌어지며 팔에 걸치는
 * 원(반지름 7px. 11 → 8 → 7 로 Chrome 에서 줄임 by @nanangqq)이 나타나고 전체가 accent 색으로 바뀐다(CSS transition. 2026-10-15: 꺾쇠·원 두 안을 본 뒤 "십자 → 걸리면 원" by @nanangqq).
 * 선은 흐린 테두리(halo) 위에 그려 밝은 지형 위에서도 보인다. 모양은 ui.css(.ui-crosshair, .ui-reticle-*)
 *
 * @param props.targeting 조준점에 건물이 걸려 있는지
 */
const Reticle = ({ targeting }: { targeting: boolean }) => {
    const cls = `ui-crosshair${targeting ? " ui-reticle-targeting" : ""}`
    // 팔 네 개: 가운데서 3px 띄워 9px 까지. 벌어지면(1.35배) 4 ~ 12px 라 반지름 11 의 원과 겹친다
    const arms = "M0 -9V-3M0 3V9M-9 0H-3M3 0H9"
    return (
        <svg className={cls} width="44" height="44" viewBox="-22 -22 44 44" role="img" aria-label="조준점">
            <g className="ui-reticle-ring">
                <circle r="7" className="ui-reticle-halo" fill="none" />
                <circle r="7" className="ui-reticle-line" fill="none" />
            </g>
            <g className="ui-reticle-arms">
                <path d={arms} className="ui-reticle-halo" fill="none" strokeLinecap="round" />
                <path d={arms} className="ui-reticle-line" fill="none" strokeLinecap="round" />
            </g>
            <circle r="2.4" className="ui-reticle-dot-halo" />
            <circle r="1.4" className="ui-reticle-dot" />
        </svg>
    )
}

/**
 * 걸어 보기 중의 화면 요소(화면 시안 "데스크톱 · 걸어 보기 중"에서 Esc 의 뜻과 나가기 버튼이 바뀜): 위 가운데 36px 유리 알약의
 * 키 안내("Esc 마우스 보이기" + "나가기" 버튼), 포커스 중이면 화면 가운데 조준경. 안내 알약(HintPill 자리): 포커스가 잡힌 직후
 * 잠깐 "Esc 를 누르면 마우스 포인터가 나타납니다", 풀려 있으면 "화면을 클릭하면 다시 조작합니다".
 * 모양은 ui.css(.ui-walk-hud, .ui-walk-exit, .ui-crosshair)
 *
 * @param props.focused 포커스(포인터 잠금) 중인지
 * @param props.showEscHint 포커스 직후의 Esc 안내를 보일지(부모가 몇 초 뒤 끈다)
 * @param props.onExit "나가기" — 궤도 보기로 돌아간다
 * @param props.targeting 조준점에 건물이 걸려 있는지(조준경이 벌어지며 원이 생기고 accent 색)
 */
export const WalkHud = ({
    focused,
    showEscHint,
    onExit,
    targeting = false,
}: {
    focused: boolean
    showEscHint: boolean
    onExit: () => void
    targeting?: boolean
}) => (
    <>
        <div className="ui-walk-hud ui-glass" role="status">
            {KEYS.map(([key, label]) => (
                <span key={key} className="ui-walk-key">
                    <kbd>{key}</kbd>
                    {label}
                </span>
            ))}
            <span className="ui-walk-hud-sep" />
            <span className="ui-walk-key">
                <kbd>Esc</kbd>
                마우스 보이기
            </span>
            <button type="button" className="ui-walk-exit" onClick={onExit}>
                나가기
            </button>
        </div>
        {focused && <Reticle targeting={targeting} />}
        {focused && showEscHint && <HintPill text="Esc 를 누르면 마우스 포인터가 나타납니다" />}
        {!focused && <HintPill text="화면을 클릭하면 다시 조작합니다" hint="나가기는 위 알약 또는 상태 표시줄" />}
    </>
)
