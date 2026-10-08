import React from "react"

/**
 * 화면 위 가운데 유리 알약. 범위 그리기 모드의 안내 문구처럼 지금 할 일 한 줄을 보인다.
 * 모양은 ui.css(.ui-pill).
 *
 * @param props.text 본문("지도를 클릭해 범위의 첫 모서리를 찍으세요")
 * @param props.hint 뒤에 붙는 보조 문구("Esc 취소"). 없으면 생략
 */
export const HintPill = ({ text, hint }: { text: string; hint?: string }) => (
    <div className="ui-pill ui-glass" role="status">
        {text}
        {hint && <span className="ui-pill-hint">{hint}</span>}
    </div>
)
