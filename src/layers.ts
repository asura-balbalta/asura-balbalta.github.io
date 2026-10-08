/**
 * 3D 화면에 얹는 공간정보 레이어 목록. 지형·건물로 시작하고 앞으로 늘어난다.
 *
 * 레이어마다 "보기"(화면에 그릴지)와 "STL"(내보내기에 넣을지)을 따로 켜고 끈다. 새 레이어를 추가할 때는
 * 여기에 항목을 더하고, 렌더러(layerMeshUpdater)와 STL worker 에 그 레이어의 메쉬를 넘기는 코드를 잇는다.
 */
export type LayerId = "terrain" | "buildings"

export type LayerState = {
    /** 화면에 그린다 */
    visible: boolean
    /** STL 내보내기에 넣는다 */
    export: boolean
}

export type LayerStates = Record<LayerId, LayerState>

export type LayerDef = {
    id: LayerId
    /** 화면에 보일 이름 */
    label: string
}

/** 화면 패널에 보이는 순서 */
export const LAYER_DEFS: LayerDef[] = [
    { id: "terrain", label: "지형" },
    { id: "buildings", label: "건물" },
]

export const INITIAL_LAYER_STATES: LayerStates = {
    terrain: { visible: true, export: true },
    buildings: { visible: true, export: true },
}
