import { ArrowDownloadRegular, LayerRegular, SettingsRegular, SquareRegular } from "@fluentui/react-icons"
import React from "react"

import { PanelId } from "./Rail"

const PANELS: { id: PanelId; label: string; icon: React.ReactElement }[] = [
    { id: "layers", label: "레이어", icon: <LayerRegular fontSize={18} /> },
    { id: "export", label: "내려받기", icon: <ArrowDownloadRegular fontSize={18} /> },
    { id: "settings", label: "설정", icon: <SettingsRegular fontSize={18} /> },
]

/**
 * 모바일 아래 탭 막대(화면 시안 "모바일" 4장): 좌우 12px 을 채운 56px 유리 알약 안에 72×44 버튼 넷, 아이콘 위에 10px 이름.
 * 레일의 모바일 변형이라 props 가 Rail 과 같다. 범위 버튼은 그리기 중이면 강조 채움에 "취소", 열린 패널의 버튼은 옅은 강조
 * 바탕에 굵은 글씨. 모양은 ui.css(.ui-tabbar). Fluent Button 은 아이콘·글자를 세로로 쌓기 어려워 직접 그린다
 *
 * @param props.drawing 범위 그리기 모드가 켜져 있으면 true
 * @param props.onToggleDraw 범위 그리기 버튼을 눌렀을 때
 * @param props.drawDisabled 로딩 중처럼 범위를 새로 그릴 수 없을 때 true
 * @param props.openPanel 열려 있는 패널(없으면 null)
 * @param props.onOpenPanel 패널 버튼을 눌렀을 때. 열린 것을 다시 누르면 null 로 닫는다
 * @param props.panelDisabled 아직 열 수 없는 패널
 */
export const TabBar = ({
    drawing,
    onToggleDraw,
    drawDisabled,
    openPanel,
    onOpenPanel,
    panelDisabled,
}: {
    drawing: boolean
    onToggleDraw: () => void
    drawDisabled?: boolean
    openPanel: PanelId | null
    onOpenPanel: (id: PanelId | null) => void
    panelDisabled?: Partial<Record<PanelId, boolean>>
}) => (
    <nav className="ui-tabbar ui-glass" aria-label="도구">
        <button
            type="button"
            className={drawing ? "ui-tab-button ui-tab-primary" : "ui-tab-button"}
            aria-pressed={drawing}
            disabled={drawDisabled}
            onClick={onToggleDraw}
        >
            <SquareRegular fontSize={18} />
            {drawing ? "취소" : "범위"}
        </button>
        {PANELS.map(({ id, label, icon }) => {
            const open = openPanel === id
            return (
                <button
                    key={id}
                    type="button"
                    className={open ? "ui-tab-button ui-tab-open" : "ui-tab-button"}
                    aria-pressed={open}
                    aria-label={open ? `${label} 패널 닫기` : undefined}
                    disabled={panelDisabled?.[id]}
                    onClick={() => onOpenPanel(open ? null : id)}
                >
                    {icon}
                    {label}
                </button>
            )
        })}
    </nav>
)
