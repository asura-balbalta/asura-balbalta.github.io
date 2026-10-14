import { ArrowMaximizeRegular, ArrowMinimizeRegular } from "@fluentui/react-icons"
import React, { ReactNode, useEffect } from "react"

/**
 * 지도(#map)를 감싸는 틀. 지도 화면에서는 전체 화면, 3D 화면에서는 오른쪽 위 미니맵(데스크톱 280×190, 모바일 220×150)이 된다.
 *
 * OpenLayers 는 처음 받은 #map 요소에 붙어 있으므로 요소가 다시 만들어지면 안 된다. 그래서 두 모드를 다른 컴포넌트로
 * 갈아 끼우지 않고, 같은 자리의 이 틀이 클래스만 바꾼다(children 인 #map 은 React 트리에서 같은 위치를 유지).
 * 데스크톱 미니맵의 "지도로 돌아가기" 는 이 틀 밖(App, .ui-minimap-return)에 둔다: 틀 안의 .ui-glass 는 리퀴드 글래스가 켜진 동안
 * CSS 유리가 꺼지는데 WebGL 유리 대상(루트 직계 자식)도 아니라 투명해져 안 보였다(2026-10-14). 모바일(collapsible, 화면 시안
 * "모바일 · 3D")은 32px 아이콘 버튼 둘(시안 28px 보다 키움)(왼쪽 아래 지도로, 오른쪽 아래 접기)이고, 접으면 96px 원이 되며
 * 탭하면 펼친다. 접힘 상태는 부모가 든다(빠른 메뉴 등 다른 요소의 자리가 따라 움직이므로). 접힌 동안은 "지도로" 와 저작권을
 * 숨긴다. 크기가 바뀔 때마다 onResize 를 불러 OpenLayers 가 다시 재게 한다. 바탕 지도 저작권은 타일이 보이는 이 틀 안에 둔다.
 * 모양은 ui.css(.ui-map-full, .ui-minimap, .ui-map-attribution).
 *
 * @param props.mode "full" 전체 화면 지도, "mini" 미니맵
 * @param props.onExpand 모바일 미니맵의 "지도로" 아이콘 버튼
 * @param props.attribution 바탕 지도 저작권 문구(태그 없는 글자)
 * @param props.collapsible 미니맵을 접을 수 있게(모바일). 아이콘 버튼으로 바뀐다
 * @param props.collapsed 접혀 있는지(collapsible 일 때)
 * @param props.onCollapsedChange 접기·펼치기 버튼을 눌렀을 때
 * @param props.onResize 틀 크기가 바뀐 뒤(접기·펼치기)
 * @param props.children #map 요소(className "ui-map")
 */
export const MapFrame = ({
    mode,
    onExpand,
    attribution,
    collapsible,
    collapsed,
    onCollapsedChange,
    onResize,
    children,
}: {
    mode: "full" | "mini"
    onExpand?: () => void
    attribution?: string
    collapsible?: boolean
    collapsed?: boolean
    onCollapsedChange?: (collapsed: boolean) => void
    onResize?: () => void
    children: ReactNode
}) => {
    const mini = mode === "mini"
    const isCollapsed = mini && !!collapsible && !!collapsed
    useEffect(() => {
        onResize?.()
    }, [isCollapsed])

    const className = mini ? (isCollapsed ? "ui-minimap ui-minimap-collapsed" : "ui-minimap") : "ui-map-full"
    return (
        <div
            className={className}
            onClick={isCollapsed ? () => onCollapsedChange?.(false) : undefined}
            role={isCollapsed ? "button" : undefined}
            aria-label={isCollapsed ? "미니맵 펼치기" : undefined}
        >
            {children}
            {!isCollapsed && attribution && <span className="ui-map-attribution">{attribution}</span>}
            {mini && !isCollapsed && collapsible && (
                <>
                    <button
                        type="button"
                        className="ui-minimap-icon ui-minimap-icon-left ui-glass"
                        onClick={onExpand}
                        aria-label="지도 화면으로 이동"
                    >
                        <ArrowMaximizeRegular fontSize={16} />
                    </button>
                    <button
                        type="button"
                        className="ui-minimap-icon ui-minimap-icon-right ui-glass"
                        onClick={() => onCollapsedChange?.(true)}
                        aria-label="미니맵 접기"
                    >
                        <ArrowMinimizeRegular fontSize={16} />
                    </button>
                </>
            )}
        </div>
    )
}
