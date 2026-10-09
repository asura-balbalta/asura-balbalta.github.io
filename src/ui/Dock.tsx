import { Button } from "@fluentui/react-components"
import { ArrowDownloadRegular, LayerRegular, SettingsRegular, SquareRegular } from "@fluentui/react-icons"
import React from "react"

/** 독·탭 막대에서 여는 패널. 한 번에 하나만 열린다 */
export type PanelId = "layers" | "export" | "settings"

const PANELS: { id: PanelId; label: string; icon: React.ReactElement }[] = [
    { id: "layers", label: "레이어", icon: <LayerRegular /> },
    { id: "export", label: "내려받기", icon: <ArrowDownloadRegular /> },
    { id: "settings", label: "설정", icon: <SettingsRegular /> },
]

/**
 * 데스크톱 아래 가운데 독(48px 유리 틀, 상태 표시줄 위). 맨 앞은 범위 그리기 모드 토글, 구분선 뒤는 패널을 여는 버튼 셋.
 * 패널은 독 위에 팝오버(DockPanel)로 뜬다. 모양은 ui.css(.ui-dock), 버튼은 Fluent Button(size large = 40px).
 *
 * @param props.drawing 범위 그리기 모드가 켜져 있으면 true(버튼이 강조색으로 채워진다)
 * @param props.onToggleDraw 범위 그리기 버튼을 눌렀을 때
 * @param props.drawDisabled 로딩 중처럼 범위를 새로 그릴 수 없을 때 true
 * @param props.openPanel 열려 있는 패널(없으면 null)
 * @param props.onOpenPanel 패널 버튼을 눌렀을 때. 열린 것을 다시 누르면 null 로 닫는다
 * @param props.panelDisabled 아직 열 수 없는 패널(3D 준비 전의 레이어·내려받기 등)
 */
export const Dock = ({
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
    <nav className="ui-dock ui-glass" aria-label="도구">
        <Button
            className="ui-dock-button"
            appearance={drawing ? "primary" : "subtle"}
            size="large"
            icon={<SquareRegular />}
            aria-label={drawing ? "그리기 취소" : "범위 그리기"}
            title={drawing ? "그리기 취소" : "범위 그리기"}
            aria-pressed={drawing}
            disabled={drawDisabled}
            onClick={onToggleDraw}
        />
        <div className="ui-dock-divider" />
        {PANELS.map(({ id, label, icon }) => {
            const open = openPanel === id
            return (
                <Button
                    key={id}
                    className={open ? "ui-dock-button ui-dock-open" : "ui-dock-button"}
                    appearance="subtle"
                    size="large"
                    icon={icon}
                    aria-label={open ? `${label} 패널 닫기` : label}
                    title={label}
                    aria-pressed={open}
                    disabled={panelDisabled?.[id]}
                    onClick={() => onOpenPanel(open ? null : id)}
                />
            )
        })}
    </nav>
)
