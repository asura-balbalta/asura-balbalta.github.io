import React from "react"

import { BuildingHit } from "../buildingPick"
import { buildingFullName } from "../buildingTable"

/**
 * 둘러보기 중 조준점 오른쪽에 뜨는 건물 정보(화면 시안 없음. 2026-10-15 "아이언맨처럼 대상 옆에 정보" by @nanangqq). 유리 판 없이
 * 조준점에서 나가는 리더 라인(가로선 → 세로 막대)과 accent 색 글자만 둔다.
 * - 바라보기만 하면(looked) 제목 "용도 · 건물명 동명" 과 요약 한 줄(층수 · 높이)
 * - 클릭으로 고정하면(pinned) 내보내기 속성 가운데 사람이 읽는 8행(이름, 용도, 용도 대분류, 구조, 지상·지하 층수, 높이, id)과
 *   "클릭 · 고정 해제" 안내. 고정된 동안은 조준점이 다른 곳을 봐도 고정된 건물을 보인다(강조는 조준점을 따른다)
 * 입력은 받지 않는다. 모양은 ui.css(.ui-target-hud)
 *
 * @param props.looked 조준점이 가리키는 건물(buildingPick)
 * @param props.pinned 클릭으로 고정한 건물
 */
export const TargetHud = ({ looked, pinned }: { looked: BuildingHit | null; pinned: BuildingHit | null }) => {
    const hit = pinned ?? looked
    if (!hit) return null
    const { table: t, index: k } = hit
    const name = buildingFullName(t, k)
    const use = t.useNames[t.useCd[k]] || "건물"
    const floors = t.floors[k]
    const under = t.floorsUnder[k]
    const height = t.heights[k] > 0 ? `${t.heights[k].toFixed(1)} m` : Number.isFinite(t.builtHeight[k]) ? `${t.builtHeight[k].toFixed(1)} m (추정)` : ""
    const summary = [floors > 0 ? `${floors}F` : "", under > 0 ? `B${under}` : "", height].filter(Boolean).join(" · ")
    const rows: [string, string][] = [
        ["이름", name],
        ["용도", t.useNames[t.useCd[k]]],
        ["용도 대분류", t.useGroupNames[t.useCd[k]]],
        ["구조", t.structNames[t.structCd[k]]],
        ["지상 층수", floors > 0 ? `${floors}` : ""],
        ["지하 층수", under > 0 ? `${under}` : ""],
        ["높이", height],
        ["id", `${t.ids[k]}`],
    ]
    return (
        <div className={pinned ? "ui-target-hud ui-target-hud-pinned" : "ui-target-hud"} role="status" aria-live="polite">
            <span className="ui-target-hud-lead" />
            <div className="ui-target-hud-body">
                <div className="ui-target-hud-title">{name ? `${use} · ${name}` : use}</div>
                {pinned ? (
                    <>
                        <dl className="ui-target-hud-rows">
                            {rows.map(([label, value]) => (
                                <React.Fragment key={label}>
                                    <dt>{label}</dt>
                                    <dd>{value || "-"}</dd>
                                </React.Fragment>
                            ))}
                        </dl>
                        <div className="ui-target-hud-hint">클릭 · 고정 해제</div>
                    </>
                ) : (
                    <div className="ui-target-hud-summary">{summary || "정보 없음"}</div>
                )}
            </div>
        </div>
    )
}
