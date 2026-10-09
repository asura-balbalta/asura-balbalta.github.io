import { Button } from "@fluentui/react-components"
import { DismissRegular } from "@fluentui/react-icons"
import React, { ReactNode } from "react"

/**
 * 독 위에 팝오버로 뜨는 272px 단색 패널 틀. 머리글(제목 + 닫기)과 내용. 내용이 길면 안에서 스크롤한다.
 * 레이어·내려받기·설정 패널이 이 틀을 공유한다. 모양은 ui.css(.ui-dock-panel). 모바일 변형은 BottomSheet(props 동일).
 *
 * @param props.title 머리글 제목
 * @param props.onClose 닫기 버튼
 * @param props.footer 꼬리말(안내 문장). 없으면 생략
 * @param props.above 모바일 시트가 위에 얹는 요소(상태 알약). 데스크톱에서는 쓰지 않는다
 */
export const DockPanel = ({
    title,
    onClose,
    footer,
    children,
}: {
    title: string
    onClose: () => void
    footer?: ReactNode
    above?: ReactNode
    children: ReactNode
}) => (
    <section className="ui-panel ui-dock-panel" aria-label={title}>
        <header className="ui-panel-header">
            <span className="ui-label">{title}</span>
            <Button appearance="subtle" size="small" icon={<DismissRegular />} aria-label="패널 닫기" onClick={onClose} />
        </header>
        <div className="ui-panel-body">{children}</div>
        {footer && <div className="ui-panel-footer">{footer}</div>}
    </section>
)
