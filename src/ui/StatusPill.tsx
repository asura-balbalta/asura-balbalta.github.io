import { ProgressBar } from "@fluentui/react-components"
import React from "react"

/**
 * 모바일에서 상태 표시줄 대신 쓰는 상태 알약. 작업 중에만 탭 막대 위 왼쪽에 뜬다: 진행 점 + 문구 + 진행 막대.
 * 모양은 ui.css(.ui-status-pill).
 *
 * @param props.label 진행 문구("지형 받는 중 3 / 9")
 * @param props.ratio 진행률 0 ~ 1. 없으면 막대가 불확정으로 움직인다
 */
export const StatusPill = ({ label, ratio }: { label: string; ratio?: number }) => (
    <div className="ui-status-pill ui-glass" role="status">
        <span className="ui-statusbar-dot" />
        {label}
        <ProgressBar className="ui-status-pill-progress" value={ratio} max={1} thickness="medium" aria-label={label} />
    </div>
)
