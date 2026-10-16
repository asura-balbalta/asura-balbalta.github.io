import { Checkbox } from "@fluentui/react-components"
import React from "react"

import { LAYER_DEFS, LayerId, LayerStates } from "../layers"

/**
 * 레이어 패널의 내용. 레이어마다 한 행: 이름 · 보기 체크 · 내보내기 체크 · "출처보기". 레이어가 늘면 행이 쌓이고 패널 안에서 스크롤한다.
 * "출처보기"(머리글 없음, 11px 글자 버튼)는 열이 더 늘어도 **항상 맨 끝**에 둔다(2026-10-16 결정 by @nanangqq). 누르면 그 레이어의 출처만
 * 받아 보이는 출처 창이 뜬다(AttributionDialog 의 layer).
 *
 * @param props.layers 레이어별 보기·내보내기 상태
 * @param props.onChange 체크를 바꿨을 때
 * @param props.loading 아직 받는 중인 레이어(이름 옆에 "받는 중")
 * @param props.notes 레이어별 보조 문구("삼각형 895,264", "51,075 동"). 받는 중이면 "받는 중" 이 우선
 * @param props.onAttribution "출처보기" 를 눌렀을 때(레이어 id)
 */
export const LayersPanel = ({
    layers,
    onChange,
    loading,
    notes,
    onAttribution,
}: {
    layers: LayerStates
    onChange: (id: LayerId, key: "visible" | "export", value: boolean) => void
    loading?: Partial<Record<LayerId, boolean>>
    notes?: Partial<Record<LayerId, string>>
    onAttribution?: (id: LayerId) => void
}) => (
    <>
        <div className="ui-layer-head">
            <span />
            <span>보기</span>
            <span>내보내기</span>
            <span />
        </div>
        {LAYER_DEFS.map(({ id, label }) => (
            <div key={id} className="ui-row ui-layer-row">
                <span>
                    {label}
                    {loading?.[id] ? (
                        <span className="ui-layer-note">받는 중</span>
                    ) : (
                        notes?.[id] && <span className="ui-layer-note">{notes[id]}</span>
                    )}
                </span>
                <Checkbox
                    checked={layers[id].visible}
                    aria-label={`${label} 보기`}
                    onChange={(_, data) => onChange(id, "visible", data.checked === true)}
                />
                <Checkbox
                    checked={layers[id].export}
                    aria-label={`${label} 내보내기`}
                    onChange={(_, data) => onChange(id, "export", data.checked === true)}
                />
                <button type="button" className="ui-link ui-layer-source" onClick={() => onAttribution?.(id)} aria-label={`${label} 출처 보기`}>
                    출처보기
                </button>
            </div>
        ))}
        <div className="ui-panel-footer">내려받기 파일에는 "내보내기" 에 체크한 레이어만 담깁니다.</div>
    </>
)
