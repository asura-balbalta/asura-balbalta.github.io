import { Button, ProgressBar } from "@fluentui/react-components"
import React from "react"

import type { ExportKind } from "../export/download"
import { EXPORT_KINDS } from "../export/runExport"
import { LAYER_DEFS, LayerId } from "../layers"

/**
 * 내려받기 패널의 내용. 형식마다 한 행(이름·설명·"내려받기" 버튼). 만드는 중인 형식은 그 행에 진행 막대와 퍼센트가 보이고
 * 다른 행의 버튼은 비활성이다. 실제 파일 생성은 app 이 runExport 로 한다.
 *
 * @param props.exporting 만드는 중인 형식과 진행률(없으면 null)
 * @param props.onExport 형식의 "내려받기" 를 눌렀을 때
 * @param props.included 지금 "내보내기" 에 체크돼 파일에 담길 레이어(꼬리말 표시용)
 */
export const ExportPanel = ({
    exporting,
    onExport,
    included,
}: {
    exporting: { kind: ExportKind; ratio?: number } | null
    onExport: (kind: ExportKind) => void
    included: LayerId[]
}) => (
    <>
        {EXPORT_KINDS.map(({ kind, label, description }) => {
            const busy = exporting?.kind === kind
            return (
                <div key={kind} className="ui-row ui-export-row">
                    <div className="ui-export-name">
                        <span>{label}</span>
                        <span className="ui-export-desc">{description}</span>
                    </div>
                    {busy ? (
                        <div className="ui-export-progress">
                            <ProgressBar value={exporting.ratio} max={1} thickness="medium" aria-label={`${label} 만드는 중`} />
                            <span className="ui-export-percent">
                                {exporting.ratio === undefined ? "" : `${Math.floor(exporting.ratio * 100)}%`}
                            </span>
                        </div>
                    ) : (
                        <Button size="small" disabled={exporting !== null} onClick={() => onExport(kind)}>
                            내려받기
                        </Button>
                    )}
                </div>
            )
        })}
        <div className="ui-panel-footer">
            {included.length > 0
                ? `담는 레이어: ${LAYER_DEFS.filter((d) => included.includes(d.id))
                      .map((d) => d.label)
                      .join(" · ")}. 레이어 패널의 "내보내기" 체크를 따릅니다.`
                : '담을 레이어가 없습니다. 레이어 패널에서 "내보내기" 를 하나 이상 체크하세요.'}
        </div>
    </>
)
