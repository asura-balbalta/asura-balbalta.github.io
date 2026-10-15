import React from "react"

import { BuildingHit } from "../buildingPick"
import { buildingFullName } from "../buildingTable"

/**
 * 둘러보기 중 조준점 오른쪽에 뜨는 건물 정보(화면 시안 없음. 2026-10-15 "아이언맨처럼 대상 옆에 정보" by @nanangqq). 유리 판 없이
 * 조준점에서 나가는 리더 라인(가로선 → 세로 막대)과 accent 색 고정폭 글자만 둔다. 상태 셋:
 * - 바라봄(looked): 제목 "용도 · 건물명 동명" + 요약 한 줄(층수 · 높이) + "클릭 · 상세 보기"
 * - 펼침(pinned, 클릭): 내보내기 속성 가운데 사람이 읽는 8행(이름, 용도, 용도 대분류, 구조, 지상·지하 층수, 높이, id) + "더블클릭 · 고정".
 *   조준점이 다른 건물에 걸리면 접히고 그 건물 요약으로(App)
 * - 고정(locked, 더블클릭): 8행 + "고정됨 · 클릭 · 해제". 조준점이 어디를 봐도 그대로이고 그 건물의 강조도 유지된다(조준점 건물은 따로
 *   강조). 그 건물이든 다른 건물이든 클릭하면 풀리고 그 건물의 펼침이 된다
 * 입력은 받지 않는다. 모양은 ui.css(.ui-target-hud)
 *
 * @param props.looked 조준점이 가리키는 건물(buildingPick)
 * @param props.pinned 클릭으로 펼친 건물
 * @param props.locked 더블클릭으로 고정했는지
 */
export const TargetHud = ({ looked, pinned, locked }: { looked: BuildingHit | null; pinned: BuildingHit | null; locked: boolean }) => {
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
    const cls = `ui-target-hud${pinned ? " ui-target-hud-pinned" : ""}${locked ? " ui-target-hud-locked" : ""}`
    return (
        <div className={cls} role="status" aria-live="polite">
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
                        <div className="ui-target-hud-hint">{locked ? "고정됨 · 클릭 · 해제" : "더블클릭 · 고정"}</div>
                    </>
                ) : (
                    <>
                        <div className="ui-target-hud-summary">{summary || "정보 없음"}</div>
                        <div className="ui-target-hud-hint">클릭 · 상세 보기</div>
                    </>
                )}
            </div>
        </div>
    )
}
