/**
 * 도로 표. 메인이 건물 표(buildingTable.ts)처럼 들고 있는 도로 원본으로, 조각(또는 면 밖 선의 띠)마다 속성과 "합쳐진 메쉬 안
 * 어디에 얹혔는지"(첫 삼각형 번호·삼각형 수)를 행 번호 k 로 찾는다. 행은 **이은 중심선(lineId) 순**으로 놓여 같은 선의 조각이
 * 메쉬에서도 이어져 있으므로, 내보내기(SKP·3DM·GLB)는 lineId 가 같은 연속 행을 그룹 하나로 묶는다(roadGroups).
 * 모두 typed array 라 Worker 에서 transfer 로 넘긴다(roadTableBuffers).
 *
 * 이 모듈은 의존성이 없다(내보내기 Worker 번들이 도로 받기 코드(proj4)를 끌어오지 않게). 코드 상수도 그래서 여기 둔다
 */
import { NOT_BUILT } from "./buildingTable"

/** 조각 flags 비트(전달 문서 2026-10-17 2절) */
export const ROAD_FACE_FLAG = {
    /** 다른 5K 파일에도 있음 → 합칠 때 id 로 중복 제거 */
    duplicated: 1,
    /** 참조 중심선 없음(속성 0, 전국 84개) */
    noLine: 2,
    /** 도로구분 섞임(교차로) */
    mixed: 4,
    /** 비운영(공사중·건설예정·폐쇄) */
    notInService: 8,
    /** 자동차전용 */
    motorway: 16,
} as const

/** 선 flags 비트 */
export const ROAD_LINE_FLAG = {
    duplicated: 1,
    oneWay: 2,
    median: 4,
    /** 면 밖(소로·면리간 = 차도 면이 없는 단선 도로). 띠로 만들어 얹는다(roadsMesh) */
    outsideFace: 8,
    motorway: 16,
} as const

/** 교통시설(tfceqp) 코드. 높이 규칙이 갈린다(roadsMesh): 교량·고가는 선 보간, 터널·지하차도는 그리지 않음 */
export const ROAD_FACILITY = {
    none: 0,
    plain: 1,
    overpass: 2,
    underpass: 3,
    interchange: 4,
    bridge: 5,
    tunnel: 6,
} as const

/** 표 행의 종류 */
export const ROAD_KIND = {
    /** 차도경계면 조각 */
    face: 0,
    /** 면 밖 선(소로·면리간)을 폭만큼 띠로 만든 것 */
    ribbon: 1,
} as const

/** 교량·고가(선 양끝 보간) 여부 */
export const isElevated = (facility: number) => facility === ROAD_FACILITY.bridge || facility === ROAD_FACILITY.overpass
/** 터널·지하차도(그리지 않음) 여부 */
export const isUnderground = (facility: number) => facility === ROAD_FACILITY.tunnel || facility === ROAD_FACILITY.underpass

/** 코드 값 → 한글 이름 표(길이 256, 없으면 ""). roadsData.ts 의 RoadCodeTable 과 같은 모양 */
export type RoadCodeNames = {
    roadSeNames: string[]
    facilityNames: string[]
    pavementNames: string[]
    statusNames: string[]
}

export type RoadTable = {
    count: number
    /** 조각 id(kind face) 또는 선 id(kind ribbon). 전국 고유 */
    ids: Uint32Array
    /** 이은 중심선 id. 행은 이 값 오름차순 */
    lineIds: Uint32Array
    /** ROAD_KIND */
    kind: Uint8Array
    /** 도로구분 코드 */
    roadSe: Uint8Array
    /** 폭(m). 0 이면 없음 */
    roadBt: Float32Array
    /** 차로 수 */
    cartrk: Uint8Array
    /** 교통시설 코드(ROAD_FACILITY) */
    facility: Uint8Array
    /** 수직위상 */
    phyLv: Int8Array
    /** 포장 코드(선에서. 선을 못 찾으면 0) */
    pavement: Uint8Array
    /** 사용상태 코드(선에서) */
    status: Uint8Array
    /** 조각 flags(kind face) 또는 선 flags(kind ribbon) */
    flags: Uint8Array
    /** 얹은 행의 첫 삼각형 번호. 못 얹었으면(터널·지형 밖) NOT_BUILT */
    faceBase: Uint32Array
    /** 얹은 행의 삼각형 수 */
    faceCount: Uint32Array
    roadSeNames: string[]
    facilityNames: string[]
    pavementNames: string[]
    statusNames: string[]
}

export { NOT_BUILT }

/** 표 한 행의 입력(roadsMesh 가 조각·선에서 만든다) */
export type RoadRow = {
    id: number
    lineId: number
    kind: number
    roadSe: number
    roadBt: number
    cartrk: number
    facility: number
    phyLv: number
    pavement: number
    status: number
    flags: number
}

const emptyNames = () => new Array<string>(256).fill("")
/** 이름 표가 없을 때(검증 스크립트 등) */
export const emptyRoadCodeNames = (): RoadCodeNames => ({
    roadSeNames: emptyNames(),
    facilityNames: emptyNames(),
    pavementNames: emptyNames(),
    statusNames: emptyNames(),
})

/** 행 목록을 표로 옮긴다(얹은 위치는 아직 NOT_BUILT·0) */
export const createRoadTable = (rows: RoadRow[], names: RoadCodeNames = emptyRoadCodeNames()): RoadTable => {
    const count = rows.length
    const t: RoadTable = {
        count,
        ids: new Uint32Array(count),
        lineIds: new Uint32Array(count),
        kind: new Uint8Array(count),
        roadSe: new Uint8Array(count),
        roadBt: new Float32Array(count),
        cartrk: new Uint8Array(count),
        facility: new Uint8Array(count),
        phyLv: new Int8Array(count),
        pavement: new Uint8Array(count),
        status: new Uint8Array(count),
        flags: new Uint8Array(count),
        faceBase: new Uint32Array(count).fill(NOT_BUILT),
        faceCount: new Uint32Array(count),
        roadSeNames: names.roadSeNames,
        facilityNames: names.facilityNames,
        pavementNames: names.pavementNames,
        statusNames: names.statusNames,
    }
    rows.forEach((r, k) => {
        t.ids[k] = r.id
        t.lineIds[k] = r.lineId
        t.kind[k] = r.kind
        t.roadSe[k] = r.roadSe
        t.roadBt[k] = r.roadBt
        t.cartrk[k] = r.cartrk
        t.facility[k] = r.facility
        t.phyLv[k] = r.phyLv
        t.pavement[k] = r.pavement
        t.status[k] = r.status
        t.flags[k] = r.flags
    })
    return t
}

/**
 * 도엽별 도로 표를 하나로 합친다(내보내기 때 도엽 메쉬를 이어 붙이므로 표도 같이). faceBase 는 그 도엽 메쉬가 합친 메쉬에서
 * 시작하는 삼각형 번호를 더한다(NOT_BUILT 는 그대로). 이름 표는 도엽마다 같으므로 첫 표의 것
 *
 * @returns 합친 표(새 배열). parts 가 비면 null
 */
export const mergeRoadTables = (parts: { table: RoadTable; faceOffset: number }[]): RoadTable | null => {
    if (parts.length === 0) return null
    const count = parts.reduce((n, p) => n + p.table.count, 0)
    const first = parts[0].table
    const out: RoadTable = {
        count,
        ids: new Uint32Array(count),
        lineIds: new Uint32Array(count),
        kind: new Uint8Array(count),
        roadSe: new Uint8Array(count),
        roadBt: new Float32Array(count),
        cartrk: new Uint8Array(count),
        facility: new Uint8Array(count),
        phyLv: new Int8Array(count),
        pavement: new Uint8Array(count),
        status: new Uint8Array(count),
        flags: new Uint8Array(count),
        faceBase: new Uint32Array(count),
        faceCount: new Uint32Array(count),
        roadSeNames: first.roadSeNames.slice(),
        facilityNames: first.facilityNames.slice(),
        pavementNames: first.pavementNames.slice(),
        statusNames: first.statusNames.slice(),
    }
    let k0 = 0
    for (const { table: t, faceOffset } of parts) {
        out.ids.set(t.ids, k0)
        out.lineIds.set(t.lineIds, k0)
        out.kind.set(t.kind, k0)
        out.roadSe.set(t.roadSe, k0)
        out.roadBt.set(t.roadBt, k0)
        out.cartrk.set(t.cartrk, k0)
        out.facility.set(t.facility, k0)
        out.phyLv.set(t.phyLv, k0)
        out.pavement.set(t.pavement, k0)
        out.status.set(t.status, k0)
        out.flags.set(t.flags, k0)
        out.faceCount.set(t.faceCount, k0)
        for (let k = 0; k < t.count; k++) out.faceBase[k0 + k] = t.faceBase[k] === NOT_BUILT ? NOT_BUILT : t.faceBase[k] + faceOffset
        k0 += t.count
    }
    return out
}

/** 표의 typed array 버퍼 목록(postMessage 의 transfer 용) */
export const roadTableBuffers = (t: RoadTable): ArrayBuffer[] =>
    [t.ids, t.lineIds, t.kind, t.roadSe, t.roadBt, t.cartrk, t.facility, t.phyLv, t.pavement, t.status, t.flags, t.faceBase, t.faceCount].map(
        (a) => a.buffer as ArrayBuffer,
    )

/** 표의 사본(배열마다 slice). 원본을 계속 쓰면서 사본을 transfer 할 때 */
export const cloneRoadTable = (t: RoadTable): RoadTable => ({
    count: t.count,
    ids: t.ids.slice(),
    lineIds: t.lineIds.slice(),
    kind: t.kind.slice(),
    roadSe: t.roadSe.slice(),
    roadBt: t.roadBt.slice(),
    cartrk: t.cartrk.slice(),
    facility: t.facility.slice(),
    phyLv: t.phyLv.slice(),
    pavement: t.pavement.slice(),
    status: t.status.slice(),
    flags: t.flags.slice(),
    faceBase: t.faceBase.slice(),
    faceCount: t.faceCount.slice(),
    roadSeNames: t.roadSeNames.slice(),
    facilityNames: t.facilityNames.slice(),
    pavementNames: t.pavementNames.slice(),
    statusNames: t.statusNames.slice(),
})

/** 내보내기 그룹: 같은 lineId 의 연속 행 [k0, k1) 과 메쉬 안 삼각형 범위 [from, to). 얹은 행이 하나도 없는 그룹은 뺀다 */
export type RoadGroup = { k0: number; k1: number; from: number; to: number }

/**
 * 표를 lineId 가 같은 연속 행으로 묶어 그룹 목록을 만든다(2026-10-19 결정 by @nanangqq: 내보내기 그룹 단위는 이은 중심선).
 * 행이 lineId 순이고 메쉬도 행 순으로 얹혔으므로 그룹의 삼각형은 [첫 얹은 행의 faceBase, 마지막 얹은 행의 faceBase + faceCount) 로 이어진다
 */
export const roadGroups = (t: RoadTable): RoadGroup[] => {
    const groups: RoadGroup[] = []
    let k0 = 0
    while (k0 < t.count) {
        let k1 = k0 + 1
        while (k1 < t.count && t.lineIds[k1] === t.lineIds[k0]) k1++
        let from = Infinity, to = -Infinity
        for (let k = k0; k < k1; k++) {
            if (t.faceBase[k] === NOT_BUILT) continue
            from = Math.min(from, t.faceBase[k])
            to = Math.max(to, t.faceBase[k] + t.faceCount[k])
        }
        if (from < to) groups.push({ k0, k1, from, to })
        k0 = k1
    }
    return groups
}

/**
 * 내보내기 파일에서 그룹을 가리키는 이름: "도로구분 (폭m, N차로, 교통시설)". 교통시설은 일반차도가 아닐 때만.
 * 예: "구도 (8.0m, 2차로)", "고속국도 (40.4m, 8차로, 교량)", "소로 (2.0m, 면 밖 선)"
 */
export const roadLabel = (t: RoadTable, k: number) => {
    const se = t.roadSeNames[t.roadSe[k]] || "도로"
    const parts: string[] = []
    if (t.roadBt[k] > 0) parts.push(`${t.roadBt[k].toFixed(1)}m`)
    if (t.cartrk[k] > 0) parts.push(`${t.cartrk[k]}차로`)
    if (t.facility[k] !== ROAD_FACILITY.plain && t.facilityNames[t.facility[k]]) parts.push(t.facilityNames[t.facility[k]])
    if (t.kind[k] === ROAD_KIND.ribbon) parts.push("면 밖 선")
    return parts.length ? `${se} (${parts.join(", ")})` : se
}

/**
 * 내보내기 파일에 적을 그룹 [k0, k1) 의 속성(키는 파일 안 이름). 선 단위 속성은 첫 행에서, 조각 수·교차로 수는 행을 세어 적는다.
 * line_id 는 이은 중심선의 전국 고유 번호, ids 는 조각(또는 선) id 를 쉼표로 이은 것
 */
export const roadAttributes = (t: RoadTable, k0: number, k1: number): Record<string, number | string> => {
    let mixed = 0
    const ids: number[] = []
    for (let k = k0; k < k1; k++) {
        if (t.kind[k] === ROAD_KIND.face && t.flags[k] & ROAD_FACE_FLAG.mixed) mixed++
        ids.push(t.ids[k])
    }
    return {
        line_id: t.lineIds[k0],
        kind: t.kind[k0] === ROAD_KIND.ribbon ? "line" : "face",
        road_se: t.roadSe[k0],
        road_se_name: t.roadSeNames[t.roadSe[k0]],
        width_m: t.roadBt[k0],
        lanes: t.cartrk[k0],
        facility: t.facility[k0],
        facility_name: t.facilityNames[t.facility[k0]],
        phy_lv: t.phyLv[k0],
        pavement: t.pavement[k0],
        pavement_name: t.pavementNames[t.pavement[k0]],
        status: t.status[k0],
        status_name: t.statusNames[t.status[k0]],
        flags: t.flags[k0],
        faces: k1 - k0,
        intersections: mixed,
        ids: ids.join(","),
    }
}
