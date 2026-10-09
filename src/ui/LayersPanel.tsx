import { Checkbox } from "@fluentui/react-components"
import React from "react"

import { LAYER_DEFS, LayerId, LayerStates } from "../layers"

/**
 * 레이어 패널의 내용. 레이어마다 한 행: 이름 · 보기 체크 · 내보내기 체크. 레이어가 늘면 행이 쌓이고 패널 안에서 스크롤한다.
 *
 * @param props.layers 레이어별 보기·내보내기 상태
 * @param props.onChange 체크를 바꿨을 때
 * @param props.loading 아직 받는 중인 레이어(이름 옆에 "받는 중")
 */
export const LayersPanel = ({
    layers,
    onChange,
    loading,
}: {
    layers: LayerStates
    onChange: (id: LayerId, key: "visible" | "export", value: boolean) => void
    loading?: Partial<Record<LayerId, boolean>>
}) => (
    <>
        <div className="ui-layer-head">
            <span />
            <span>보기</span>
            <span>내보내기</span>
        </div>
        {LAYER_DEFS.map(({ id, label }) => (
            <div key={id} className="ui-row ui-layer-row">
                <span>
                    {label}
                    {loading?.[id] && <span className="ui-layer-note">받는 중</span>}
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
            </div>
        ))}
        <div className="ui-panel-footer">내려받기는 "내보내기" 에 체크한 레이어만 담는다.</div>
    </>
)
