import { Button, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger, ProgressBar } from "@fluentui/react-components"
import { CheckmarkRegular } from "@fluentui/react-icons"
import React, { ReactNode } from "react"

/** 상태 표시줄 오른쪽의 드롭다운 하나(보기 모드·테마·바탕 지도) */
export type StatusMenu = {
    /** 버튼 문구(현재 값) */
    label: string
    items: { label: string; selected?: boolean; onSelect: () => void }[]
}

/**
 * 화면 맨 아래 28px 상태 표시줄(얇은 유리). 왼쪽은 진행 상태와 수치, 오른쪽은 드롭다운과 저작권.
 * 진행 중인 작업이 없으면 왼쪽은 수치만 보인다. 모양은 ui.css(.ui-statusbar).
 *
 * @param props.progress 진행 중인 작업. ratio 가 없으면 진행 막대가 불확정으로 움직인다
 * @param props.stats 수치 항목("범위 2.4 × 2.4 km" 같은 완성된 문구)
 * @param props.menus 오른쪽 드롭다운들
 * @param props.attribution 바탕 지도 저작권 문구(태그 없는 글자)
 * @param props.children 수치 뒤에 둘 추가 항목("3D로 돌아가기" 같은 작은 버튼)
 */
export const StatusBar = ({
    progress,
    stats,
    menus,
    attribution,
    children,
}: {
    progress?: { label: string; ratio?: number } | null
    stats: string[]
    menus: StatusMenu[]
    attribution?: string
    children?: ReactNode
}) => (
    <footer className="ui-statusbar ui-glass-strong">
        {progress && (
            <>
                <span className="ui-statusbar-item" role="status">
                    <span className="ui-statusbar-dot" />
                    {progress.label}
                </span>
                <ProgressBar
                    className="ui-statusbar-progress"
                    value={progress.ratio}
                    max={1}
                    thickness="medium"
                    aria-label={progress.label}
                />
                <span className="ui-statusbar-sep" />
            </>
        )}
        {stats.map((text, i) => (
            <span key={i} className="ui-statusbar-muted">
                {text}
            </span>
        ))}
        {children}
        <span className="ui-statusbar-spacer" />
        {menus.map((menu, i) => (
            <Menu key={i} positioning="above-end">
                <MenuTrigger disableButtonEnhancement>
                    <Button appearance="subtle" size="small" className="ui-statusbar-menu">
                        {menu.label} ▾
                    </Button>
                </MenuTrigger>
                <MenuPopover>
                    <MenuList>
                        {menu.items.map((item) => (
                            <MenuItem
                                key={item.label}
                                icon={item.selected ? <CheckmarkRegular /> : <span style={{ width: 16 }} />}
                                onClick={item.onSelect}
                            >
                                {item.label}
                            </MenuItem>
                        ))}
                    </MenuList>
                </MenuPopover>
            </Menu>
        ))}
        {attribution && <span className="ui-statusbar-attribution">{attribution}</span>}
    </footer>
)
