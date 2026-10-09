import { Button } from "@fluentui/react-components"
import { DismissRegular } from "@fluentui/react-icons"
import React, { ReactNode, useEffect, useRef, useState } from "react"

/** 반쯤 높이보다 이만큼 더 아래로 끌어 내리면 닫는다 */
const CLOSE_DRAG_PX = 80
/** 이보다 조금 움직이면 끌기가 아니라 탭으로 본다(반쯤 ↔ 전체 전환) */
const TAP_PX = 8
/** 전체 상태에서 시트 묶음 위에 남기는 여백(px). safe-area 는 따로 더한다 */
const TOP_GAP_PX = 12

/**
 * 모바일에서 독 패널 대신 쓰는 바텀 시트(화면 시안 "모바일 · 3D"): 탭 막대 위에 뜬 카드이고, 위에 상태 알약을 한 묶음으로
 * 얹는다(above). DockPanel 과 props 가 같아 app 이 폭에 따라 갈아 끼운다.
 *
 * 두 멈춤 위치: "반쯤"(내용 높이, 최대 화면 절반)과 "전체"(화면 위 여백까지). 손잡이와 머리글에서만 끌 수 있고
 * 내용 영역은 스크롤한다(3D 조작·스크롤과 겹치지 않게). 끄는 동안은 카드를 옮기지 않고 높이를 바꾼다: 위로 올리면
 * 시작 높이에서 그만큼 커지고(전체까지), 반쯤 높이 아래로 내리면 그때부터 아래로 따라간다(닫기 제스처). 놓으면 반쯤과
 * 전체의 중간을 기준으로 가까운 쪽으로 가고, 반쯤보다 CLOSE_DRAG_PX 넘게 내렸으면 닫힌다. 손잡이를 탭하면 반쯤 ↔ 전체.
 * 전체 높이는 보이는 영역(visualViewport) 기준으로 재므로 iOS 의 주소창이 접혔든 아니든 화면에 맞는다. 모양은 ui.css(.ui-sheet).
 *
 * @param props.title 머리글 제목
 * @param props.onClose 닫기 버튼·아래로 끌기
 * @param props.footer 꼬리말. 없으면 생략
 * @param props.above 카드 위에 얹을 요소(상태 알약·"3D로 돌아가기")
 */
export const BottomSheet = ({
    title,
    onClose,
    footer,
    above,
    children,
}: {
    title: string
    onClose: () => void
    footer?: ReactNode
    above?: ReactNode
    children: ReactNode
}) => {
    const [expanded, setExpanded] = useState(false)
    /** 끄는 중의 모양. height 는 카드 높이, offset 은 반쯤 높이 아래로 더 내린 양(px). 아니면 null */
    const [drag, setDrag] = useState<{ height: number; offset: number } | null>(null)
    /** 전체 상태의 카드 높이(px). 펼칠 때와 창 크기가 바뀔 때 다시 잰다 */
    const [fullHeight, setFullHeight] = useState<number | null>(null)
    const stackRef = useRef<HTMLDivElement | null>(null)
    const cardRef = useRef<HTMLElement | null>(null)
    /** 마지막으로 잰 반쯤 높이. 전체 상태에서 끌 때 기준으로 쓴다 */
    const peekHeightRef = useRef<number | null>(null)
    const startRef = useRef<{ y: number; id: number; height: number } | null>(null)

    /** 전체 상태의 카드 높이: 카드 아래 끝에서 화면 위 여백까지, 위에 얹은 요소(상태 알약)만큼 뺀 값 */
    const measureFull = () => {
        const stack = stackRef.current?.getBoundingClientRect()
        const card = cardRef.current?.getBoundingClientRect()
        if (!stack || !card) return window.innerHeight / 2
        const safeTop = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-safe-top")) || 0
        const aboveSpace = stack.height - card.height
        return Math.max(160, card.bottom - TOP_GAP_PX - safeTop - aboveSpace)
    }
    useEffect(() => {
        if (!expanded) return
        const update = () => setFullHeight(measureFull())
        update()
        window.addEventListener("resize", update)
        window.visualViewport?.addEventListener("resize", update)
        return () => {
            window.removeEventListener("resize", update)
            window.visualViewport?.removeEventListener("resize", update)
        }
    }, [expanded])

    const onPointerDown = (e: React.PointerEvent) => {
        const height = cardRef.current?.getBoundingClientRect().height ?? 0
        if (!expanded) peekHeightRef.current = height
        startRef.current = { y: e.clientY, id: e.pointerId, height }
        e.currentTarget.setPointerCapture(e.pointerId)
        setDrag({ height, offset: 0 })
    }
    /** 손가락 위치에 맞는 높이·내림량 */
    const shapeFor = (dy: number) => {
        const start = startRef.current!
        const peek = peekHeightRef.current ?? Math.min(start.height, window.innerHeight / 2)
        const target = start.height - dy
        if (target >= peek) return { height: Math.min(target, measureFull()), offset: 0 }
        return { height: peek, offset: peek - target }
    }
    const onPointerMove = (e: React.PointerEvent) => {
        const start = startRef.current
        if (!start || start.id !== e.pointerId) return
        setDrag(shapeFor(e.clientY - start.y))
    }
    const onPointerUp = (e: React.PointerEvent) => {
        const start = startRef.current
        if (!start || start.id !== e.pointerId) return
        const dy = e.clientY - start.y
        // shapeFor 가 startRef 를 읽으므로 비우기 전에 계산한다
        const shape = shapeFor(dy)
        startRef.current = null
        setDrag(null)
        if (Math.abs(dy) < TAP_PX) {
            setExpanded((prev) => !prev)
            return
        }
        if (shape.offset > CLOSE_DRAG_PX) {
            onClose()
            return
        }
        const peek = peekHeightRef.current ?? shape.height
        setExpanded(shape.offset === 0 && shape.height > (peek + measureFull()) / 2)
    }
    const gripHandlers = { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp }

    const className = `ui-panel ui-sheet${drag ? " ui-sheet-dragging" : expanded ? " ui-sheet-expanded" : ""}`
    const style = drag
        ? { height: drag.height, transform: drag.offset ? `translateY(${drag.offset}px)` : undefined }
        : expanded && fullHeight !== null
          ? { height: fullHeight }
          : undefined

    return (
        <div ref={stackRef} className="ui-sheet-stack">
            {above}
            <section ref={cardRef} className={className} style={style} aria-label={title}>
                <div className="ui-sheet-grip" {...gripHandlers}>
                    <div className="ui-sheet-handle" />
                </div>
                <header className="ui-panel-header" {...gripHandlers}>
                    <span className="ui-label">{title}</span>
                    <span className="ui-sheet-header-right">
                        {!expanded && <span className="ui-sheet-hint">위로 끌면 전체</span>}
                        <Button
                            appearance="subtle"
                            size="small"
                            icon={<DismissRegular />}
                            aria-label="패널 닫기"
                            onClick={onClose}
                            onPointerDown={(e) => e.stopPropagation()}
                        />
                    </span>
                </header>
                <div className="ui-panel-body">{children}</div>
                {footer && <div className="ui-panel-footer">{footer}</div>}
            </section>
        </div>
    )
}
