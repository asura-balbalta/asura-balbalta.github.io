import React from "react"

/** 키 안내 항목: [키, 뜻] */
const KEYS: [string, string][] = [
    ["W A S D", "이동"],
    ["마우스", "시점"],
    ["Space", "점프"],
    ["W W", "대시"],
]

/**
 * 걸어 보기 중의 화면 요소(화면 시안 "데스크톱 · 걸어 보기 중"): 위 가운데 36px 유리 알약의 키 안내와 화면 가운데 조준점.
 * 모양은 ui.css(.ui-walk-hud, .ui-crosshair)
 */
export const WalkHud = () => (
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
                나가기
            </span>
        </div>
        <svg className="ui-crosshair" width="22" height="22" viewBox="0 0 22 22" role="img" aria-label="조준점">
            <path d="M11 3v5M11 14v5M3 11h5M14 11h5" className="ui-crosshair-halo" strokeWidth="3" strokeLinecap="round" />
            <path d="M11 3v5M11 14v5M3 11h5M14 11h5" className="ui-crosshair-line" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
    </>
)
