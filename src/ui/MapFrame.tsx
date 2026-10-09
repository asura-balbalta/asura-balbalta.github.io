import { ArrowMaximizeRegular, ArrowMinimizeRegular } from "@fluentui/react-icons"
import React, { ReactNode, useEffect, useState } from "react"

/**
 * 지도(#map)를 감싸는 틀. 지도 화면에서는 전체 화면, 3D 화면에서는 오른쪽 위 280×190 미니맵이 된다.
 *
 * OpenLayers 는 처음 받은 #map 요소에 붙어 있으므로 요소가 다시 만들어지면 안 된다. 그래서 두 모드를 다른 컴포넌트로
 * 갈아 끼우지 않고, 같은 자리의 이 틀이 클래스만 바꾼다(children 인 #map 은 React 트리에서 같은 위치를 유지).
 * 미니맵일 때는 왼쪽 아래에 "지도로" 버튼이 붙는다. 바탕 지도 저작권은 타일이 보이는 이 틀 안 오른쪽 아래에 둔다
 * (전체 지도는 상태 표시줄 위, 미니맵은 버튼 오른쪽에 작게). 모양은 ui.css(.ui-map-full, .ui-minimap, .ui-map-attribution).
 *
 * 모바일(collapsible)에서는 미니맵 오른쪽 위 ↘ 로 96px 원으로 접고, 접힌 원을 탭하면 다시 펼친다. 접힌 동안은 "지도로" 와
 * 저작권을 숨긴다(원 안에 들어갈 자리가 없다). 크기가 바뀔 때마다 onResize 를 불러 OpenLayers 가 다시 재게 한다.
 *
 * @param props.mode "full" 전체 화면 지도, "mini" 미니맵
 * @param props.onExpand 미니맵의 "지도로" 버튼
 * @param props.attribution 바탕 지도 저작권 문구(태그 없는 글자)
 * @param props.collapsible 미니맵을 접을 수 있게(모바일)
 * @param props.onResize 틀 크기가 바뀐 뒤(접기·펼치기)
 * @param props.children #map 요소(className "ui-map")
 */
export const MapFrame = ({
    mode,
    onExpand,
    attribution,
    collapsible,
    onResize,
    children,
}: {
    mode: "full" | "mini"
    onExpand?: () => void
    attribution?: string
    collapsible?: boolean
    onResize?: () => void
    children: ReactNode
}) => {
    const [collapsed, setCollapsed] = useState(false)
    // 전체 지도로 돌아가면 접힘을 풀어, 다음에 미니맵이 될 때 펼친 채 시작한다
    useEffect(() => {
        if (mode === "full") setCollapsed(false)
    }, [mode])
    useEffect(() => {
        onResize?.()
    }, [collapsed])

    const mini = mode === "mini"
    const isCollapsed = mini && collapsible && collapsed
    const className = mini ? (isCollapsed ? "ui-minimap ui-minimap-collapsed" : "ui-minimap") : "ui-map-full"
    return (
        <div
            className={className}
            onClick={isCollapsed ? () => setCollapsed(false) : undefined}
            role={isCollapsed ? "button" : undefined}
            aria-label={isCollapsed ? "미니맵 펼치기" : undefined}
        >
            {children}
            {!isCollapsed && attribution && <span className="ui-map-attribution">{attribution}</span>}
            {mini && !isCollapsed && (
                <button type="button" className="ui-minimap-button ui-glass" onClick={onExpand} aria-label="지도 화면으로 이동">
                    <ArrowMaximizeRegular fontSize={12} />
                    지도로
                </button>
            )}
            {mini && collapsible && !isCollapsed && (
                <button
                    type="button"
                    className="ui-minimap-collapse ui-glass"
                    onClick={() => setCollapsed(true)}
                    aria-label="미니맵 접기"
                >
                    <ArrowMinimizeRegular fontSize={14} />
                </button>
            )}
        </div>
    )
}
