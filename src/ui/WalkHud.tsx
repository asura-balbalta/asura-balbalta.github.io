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
 * 걸어 보기 중의 화면 요소(화면 시안 "데스크톱 · 걸어 보기 중"에서 Esc 의 뜻과 나가기 버튼이 바뀜): 위 가운데 36px 유리 알약의
 * 키 안내("Esc 마우스 보이기" + "나가기" 버튼), 포커스 중이면 화면 가운데 조준점. 안내 알약(HintPill 자리): 포커스가 잡힌 직후
 * 잠깐 "Esc 를 누르면 마우스 포인터가 나타납니다", 풀려 있으면 "화면을 클릭하면 다시 조작합니다".
 * 모양은 ui.css(.ui-walk-hud, .ui-walk-exit, .ui-crosshair)
 *
 * @param props.focused 포커스(포인터 잠금) 중인지
 * @param props.showEscHint 포커스 직후의 Esc 안내를 보일지(부모가 몇 초 뒤 끈다)
 * @param props.onExit "나가기" — 궤도 보기로 돌아간다
 */
export const WalkHud = ({ focused, showEscHint, onExit }: { focused: boolean; showEscHint: boolean; onExit: () => void }) => (
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
        {focused && (
            <svg className="ui-crosshair" width="22" height="22" viewBox="0 0 22 22" role="img" aria-label="조준점">
                <path d="M11 3v5M11 14v5M3 11h5M14 11h5" className="ui-crosshair-halo" strokeWidth="3" strokeLinecap="round" />
                <path d="M11 3v5M11 14v5M3 11h5M14 11h5" className="ui-crosshair-line" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
        )}
        {focused && showEscHint && <HintPill text="Esc 를 누르면 마우스 포인터가 나타납니다" />}
        {!focused && <HintPill text="화면을 클릭하면 다시 조작합니다" hint="나가기는 위 알약 또는 상태 표시줄" />}
    </>
)
