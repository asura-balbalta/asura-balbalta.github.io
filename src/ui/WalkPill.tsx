import { GamesRegular } from "@fluentui/react-icons"
import React, { useRef } from "react"

/** 이 거리(px)보다 적게 움직이면 끌기가 아니라 클릭 */
const DRAG_THRESHOLD = 4
/** 알약이 화면 밖으로 나가지 않게 두는 여유(px, 알약 중심 기준) */
const EDGE_MARGIN = 40

/** 알약의 위치(화면 px, 알약 중심). null 이면 화면 가운데 */
export type PillPosition = { x: number; y: number }

/**
 * 3D 화면 가운데의 "걸어 보기" 진입 알약(화면 시안 "데스크톱 · 3D · 걸어 보기 진입"). 44px 유리 알약, 게임패드 아이콘 + 글자.
 * 데스크톱에서만 보인다(포인터 잠금·키보드가 필요하다). 끌어서 옮길 수 있다(가운데가 걸리적거리는 사람용. 위치는 부모가 들고
 * 새 지형을 만들면 가운데로 돌아간다). 4px 미만 움직임은 클릭으로 본다. 가장자리 5px 띠는 이동 커서, 안쪽은 클릭 커서.
 * 모양은 ui.css(.ui-walk-pill, .ui-walk-pill-inner)
 *
 * @param props.position 알약 중심 위치. null 이면 화면 가운데
 * @param props.onMove 끌어서 옮겼을 때(놓을 때까지 계속)
 * @param props.onClick 누르면 걸어 보기를 시작한다
 */
export const WalkPill = ({
    position,
    onMove,
    onClick,
}: {
    position: PillPosition | null
    onMove: (next: PillPosition) => void
    onClick: () => void
}) => {
    const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null)
    const style: React.CSSProperties | undefined = position
        ? { left: position.x, top: position.y }
        : undefined
    return (
        <button
            type="button"
            className="ui-walk-pill ui-glass"
            style={style}
            onPointerDown={(e) => {
                if (e.button !== 0) return
                const rect = e.currentTarget.getBoundingClientRect()
                dragRef.current = {
                    startX: e.clientX,
                    startY: e.clientY,
                    originX: rect.left + rect.width / 2,
                    originY: rect.top + rect.height / 2,
                    moved: false,
                }
                // 알약 밖으로 나가도 move/up 을 계속 받기 위해. 포인터가 이미 끝났으면 예외가 나므로 무시(캔버스와 같은 처리)
                try {
                    e.currentTarget.setPointerCapture(e.pointerId)
                } catch {
                    /* 캡처 없이도 알약 안에서는 동작한다 */
                }
            }}
            onPointerMove={(e) => {
                const d = dragRef.current
                if (!d) return
                const dx = e.clientX - d.startX
                const dy = e.clientY - d.startY
                if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
                d.moved = true
                onMove({
                    x: Math.min(window.innerWidth - EDGE_MARGIN, Math.max(EDGE_MARGIN, d.originX + dx)),
                    y: Math.min(window.innerHeight - EDGE_MARGIN, Math.max(EDGE_MARGIN, d.originY + dy)),
                })
            }}
            onPointerUp={(e) => {
                const d = dragRef.current
                dragRef.current = null
                try {
                    e.currentTarget.releasePointerCapture(e.pointerId)
                } catch {
                    /* 캡처가 없었던 경우 */
                }
                if (d && !d.moved) onClick()
            }}
            onPointerCancel={() => {
                dragRef.current = null
            }}
            onKeyDown={(e) => {
                // 마우스 클릭은 pointerup 에서 처리하므로 키보드(Enter·Space)만 여기서
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    onClick()
                }
            }}
        >
            <span className="ui-walk-pill-inner">
                <GamesRegular fontSize={24} />
                걸어 보기
            </span>
        </button>
    )
}
