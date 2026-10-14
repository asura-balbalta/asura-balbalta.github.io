import React from "react"

import { BuildingHit } from "../buildingPick"
import { buildingFullName } from "../buildingTable"

/**
 * 둘러보기 중 클릭으로 고정한 건물의 속성 카드(오른쪽 아래, 상태 표시줄 위). 내보내기(SKP·3DM)에 적는 속성 가운데 사람이 읽는
 * 8개만 보인다(코드 값·이름 출처 비트는 뺀다): 이름, 용도, 용도 대분류, 구조, 지상 층수, 지하 층수, 높이, id.
 * 값이 없는 행은 "-". 서버 높이가 없으면 세운 높이에 "(추정)". 모양은 ui.css(.ui-building-card)
 *
 * @param props.hit 고정한 건물(buildingPick 결과)
 * @param props.onClose 닫기(고정 해제)
 */
export const BuildingCard = ({ hit, onClose }: { hit: BuildingHit; onClose: () => void }) => {
    const { table: t, index: k } = hit
    const name = buildingFullName(t, k)
    const use = t.useNames[t.useCd[k]]
    const height = t.heights[k] > 0 ? `${t.heights[k].toFixed(1)} m` : Number.isFinite(t.builtHeight[k]) ? `${t.builtHeight[k].toFixed(1)} m (추정)` : ""
    const rows: [string, string][] = [
        ["이름", name],
        ["용도", use],
        ["용도 대분류", t.useGroupNames[t.useCd[k]]],
        ["구조", t.structNames[t.structCd[k]]],
        ["지상 층수", t.floors[k] > 0 ? `${t.floors[k]}` : ""],
        ["지하 층수", t.floorsUnder[k] > 0 ? `${t.floorsUnder[k]}` : ""],
        ["높이", height],
        ["id", `${t.ids[k]}`],
    ]
    return (
        <div className="ui-building-card ui-panel" role="dialog" aria-label="건물 속성">
            <div className="ui-building-card-header">
                <span className="ui-building-card-title">{use || "건물"}{name ? ` · ${name}` : ""}</span>
                <button type="button" className="ui-building-card-close" onClick={onClose} aria-label="닫기">
                    ×
                </button>
            </div>
            <dl className="ui-building-card-rows">
                {rows.map(([label, value]) => (
                    <React.Fragment key={label}>
                        <dt>{label}</dt>
                        <dd>{value || "-"}</dd>
                    </React.Fragment>
                ))}
            </dl>
        </div>
    )
}
