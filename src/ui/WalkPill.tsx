import { GamesRegular } from "@fluentui/react-icons"
import React from "react"

/**
 * 3D 화면 가운데의 "걸어 보기" 진입 알약(화면 시안 "데스크톱 · 3D · 걸어 보기 진입"). 44px 유리 알약, 게임패드 아이콘 + 글자.
 * 데스크톱에서만 보인다(포인터 잠금·키보드가 필요하다). 모양은 ui.css(.ui-walk-pill)
 *
 * @param props.onClick 누르면 걸어 보기를 시작한다
 */
export const WalkPill = ({ onClick }: { onClick: () => void }) => (
    <button type="button" className="ui-walk-pill ui-glass" onClick={onClick}>
        <GamesRegular fontSize={20} />
        걸어 보기
    </button>
)
