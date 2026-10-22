/**
 * 물 표. 메인이 건물 표(buildingTable.ts)·도로 표(roadTable.ts)처럼 들고 있는 물 원본으로, 조각(또는 하천선 띠)마다 속성과 "합쳐진 메쉬 안
 * 어디에 얹혔는지"(첫 삼각형 번호·삼각형 수)를 행 번호 k 로 찾는다. 행은 **수역(srcId) 순**으로 놓이지만, 한 수역의 조각은 도엽을 넘어
 * 흩어지므로(5K 경계에서 잘린 조각이 여러 도엽에 얹힘) 도엽 표를 합친 뒤에는 같은 수역의 행이 연속이 아니다. 그래서 내보내기 그룹
 * (waterGroups)은 수역마다 삼각형 범위 **여러 개**를 모은다(도로 그룹은 범위 하나).
 * 모두 typed array 또는 문자열 배열이라 Worker 에서 넘길 수 있다(waterTableBuffers 는 typed array 만 transfer).
 *
 * 이 모듈은 의존성이 없다(내보내기 Worker 번들이 물 받기 코드(proj4)를 끌어오지 않게). 코드 상수도 그래서 여기 둔다.
 * 계획: docs/water-layer-plan.md
 */
import { NOT_BUILT } from "./buildingTable"

/** 조각 kind(안내문 2026-10-22 3절) + 우리가 더한 띠 */
export const WATER_KIND = {
    /** 실폭하천 수면 조각 */
    river: 1,
    /** 호소 수면 조각 */
    lake: 2,
    /** 하천중심선 중 수면 폴리곤 밖 구간을 폭만큼 띠로 만든 것(waterMesh. D3) */
    ribbon: 3,
} as const

/** 조각 flags 비트 */
export const WATER_PIECE_FLAG = {
    /** 5K 경계에서 잘림(srcNPieces > 1) */
    cut: 1,
    /** 원 폴리곤이 해안선 3 m 안에 닿음(하구·간척호) */
    shore: 2,
    /** 원 폴리곤에 구멍 있음(하중도·섬) */
    holes: 4,
} as const

/** 선 flags 비트 */
export const WATER_LINE_FLAG = {
    cut: 1,
} as const

/** 하천 구분(riverSe) 코드 */
export const RIVER_SE = { national: 1, regional: 2, small: 3, other: 4 } as const

/** 코드 값 → 한글 이름 표(길이 256, 없으면 ""). waterData.ts 의 loadWaterCodes 가 채운다 */
export type WaterCodeNames = {
    kindNames: string[]
    riverSeNames: string[]
}

export type WaterTable = {
    count: number
    /** 수역 srcId(kind river·lake) 또는 선 id(kind ribbon). 전국 고유 */
    ids: Uint32Array
    /** WATER_KIND */
    kind: Uint8Array
    /** 이름 표 id(0 = 없음) */
    nameId: Uint32Array
    /** 하천 구분(kind ribbon 에서. 조각은 0) */
    riverSe: Uint8Array
    /** 이 수역의 전국 조각 수(1 = 안 잘림). 띠는 0 */
    srcNPieces: Uint16Array
    /** 조각 flags(WATER_PIECE_FLAG) 또는 선 flags(WATER_LINE_FLAG) */
    flags: Uint8Array
    /** 얹은 행의 첫 삼각형 번호. 못 얹었으면(지형 밖) NOT_BUILT */
    faceBase: Uint32Array
    /** 얹은 행의 삼각형 수 */
    faceCount: Uint32Array
    /** 행마다 이름(이름 파일에서. 없으면 "") */
    names: string[]
    /** 행마다 하천 번호(이름 파일 river_no. 호소·없으면 "") */
    riverNos: string[]
    kindNames: string[]
    riverSeNames: string[]
}

export { NOT_BUILT }

/** 표 한 행의 입력(waterMesh 가 조각·선에서 만든다) */
export type WaterRow = {
    id: number
    kind: number
    nameId: number
    riverSe: number
    srcNPieces: number
    flags: number
    name: string
    riverNo: string
}

const emptyNames = () => new Array<string>(256).fill("")
/** 이름 표가 없을 때(검증 스크립트 등) */
export const emptyWaterCodeNames = (): WaterCodeNames => ({ kindNames: emptyNames(), riverSeNames: emptyNames() })

const allocate = (count: number, names: WaterCodeNames): WaterTable => ({
    count,
    ids: new Uint32Array(count),
    kind: new Uint8Array(count),
    nameId: new Uint32Array(count),
    riverSe: new Uint8Array(count),
    srcNPieces: new Uint16Array(count),
    flags: new Uint8Array(count),
    faceBase: new Uint32Array(count).fill(NOT_BUILT),
    faceCount: new Uint32Array(count),
    names: new Array<string>(count).fill(""),
    riverNos: new Array<string>(count).fill(""),
    kindNames: names.kindNames,
    riverSeNames: names.riverSeNames,
})

/** 행 목록을 표로 옮긴다(얹은 위치는 아직 NOT_BUILT·0) */
export const createWaterTable = (rows: WaterRow[], names: WaterCodeNames = emptyWaterCodeNames()): WaterTable => {
    const t = allocate(rows.length, names)
    rows.forEach((r, k) => {
        t.ids[k] = r.id
        t.kind[k] = r.kind
        t.nameId[k] = r.nameId
        t.riverSe[k] = r.riverSe
        t.srcNPieces[k] = r.srcNPieces
        t.flags[k] = r.flags
        t.names[k] = r.name
        t.riverNos[k] = r.riverNo
    })
    return t
}

/**
 * 도엽별 물 표를 하나로 합친다(내보내기 때 도엽 메쉬를 이어 붙이므로 표도 같이). faceBase 는 그 도엽 메쉬가 합친 메쉬에서 시작하는
 * 삼각형 번호를 더한다(NOT_BUILT 는 그대로). 이름 표는 도엽마다 같으므로 첫 표의 것
 *
 * @returns 합친 표(새 배열). parts 가 비면 null
 */
export const mergeWaterTables = (parts: { table: WaterTable; faceOffset: number }[]): WaterTable | null => {
    if (parts.length === 0) return null
    const count = parts.reduce((n, p) => n + p.table.count, 0)
    const first = parts[0].table
    const out = allocate(count, { kindNames: first.kindNames.slice(), riverSeNames: first.riverSeNames.slice() })
    let k0 = 0
    for (const { table: t, faceOffset } of parts) {
        out.ids.set(t.ids, k0)
        out.kind.set(t.kind, k0)
        out.nameId.set(t.nameId, k0)
        out.riverSe.set(t.riverSe, k0)
        out.srcNPieces.set(t.srcNPieces, k0)
        out.flags.set(t.flags, k0)
        out.faceCount.set(t.faceCount, k0)
        for (let k = 0; k < t.count; k++) {
            out.faceBase[k0 + k] = t.faceBase[k] === NOT_BUILT ? NOT_BUILT : t.faceBase[k] + faceOffset
            out.names[k0 + k] = t.names[k]
            out.riverNos[k0 + k] = t.riverNos[k]
        }
        k0 += t.count
    }
    return out
}

/** 표의 typed array 버퍼 목록(postMessage 의 transfer 용. 문자열 배열은 구조 복제로 간다) */
export const waterTableBuffers = (t: WaterTable): ArrayBuffer[] =>
    [t.ids, t.kind, t.nameId, t.riverSe, t.srcNPieces, t.flags, t.faceBase, t.faceCount].map((a) => a.buffer as ArrayBuffer)

/** 표의 사본(배열마다 slice). 원본을 계속 쓰면서 사본을 transfer 할 때 */
export const cloneWaterTable = (t: WaterTable): WaterTable => ({
    count: t.count,
    ids: t.ids.slice(),
    kind: t.kind.slice(),
    nameId: t.nameId.slice(),
    riverSe: t.riverSe.slice(),
    srcNPieces: t.srcNPieces.slice(),
    flags: t.flags.slice(),
    faceBase: t.faceBase.slice(),
    faceCount: t.faceCount.slice(),
    names: t.names.slice(),
    riverNos: t.riverNos.slice(),
    kindNames: t.kindNames.slice(),
    riverSeNames: t.riverSeNames.slice(),
})

/**
 * 내보내기 그룹: 같은 수역(srcId) 또는 같은 하천선(id)의 행들과 메쉬 안 삼각형 범위들 [from, to). 행이 도엽을 넘어 흩어져 있어도
 * 한 그룹으로 모은다(2026-10-22 결정 D5 by @nanangqq: 그룹 단위는 수역, 선택 범위로 자른 것만). 얹은 행이 하나도 없는 그룹은 뺀다
 */
export type WaterGroup = { kind: number; id: number; k0: number; rows: number[]; ranges: [number, number][] }

/** 표를 수역(또는 하천선)별 그룹으로 묶는다. 순서는 첫 행이 나타난 순 */
export const waterGroups = (t: WaterTable): WaterGroup[] => {
    const byKey = new Map<string, WaterGroup>()
    for (let k = 0; k < t.count; k++) {
        if (t.faceBase[k] === NOT_BUILT || t.faceCount[k] === 0) continue
        const key = `${t.kind[k] === WATER_KIND.ribbon ? "l" : "p"}:${t.ids[k]}`
        let g = byKey.get(key)
        if (!g) {
            g = { kind: t.kind[k], id: t.ids[k], k0: k, rows: [], ranges: [] }
            byKey.set(key, g)
        }
        g.rows.push(k)
        g.ranges.push([t.faceBase[k], t.faceBase[k] + t.faceCount[k]])
    }
    return [...byKey.values()]
}

/**
 * 내보내기 파일에서 그룹을 가리키는 이름. 이름이 있으면 그 이름("한강", "소양호"), 없으면 "하천 12345" / "호소 12345".
 * 띠는 "하천선 (국가하천) 12345" 꼴에 이름이 있으면 앞에 붙인다
 */
export const waterLabel = (t: WaterTable, k: number) => {
    const kind = t.kind[k]
    const name = t.names[k]
    if (kind === WATER_KIND.ribbon) {
        const se = t.riverSeNames[t.riverSe[k]]
        return `${name ? `${name} ` : ""}하천선${se ? ` (${se})` : ""} ${t.ids[k]}`
    }
    if (name) return name
    return `${t.kindNames[kind] || (kind === WATER_KIND.lake ? "호소" : "하천")} ${t.ids[k]}`
}

/**
 * 내보내기 파일에 적을 그룹의 속성(키는 파일 안 이름). 수역 단위 속성은 첫 행에서, 조각 수는 행을 세어 적는다.
 * src_pieces 는 전국 조각 수, pieces 는 이 파일에 담긴(선택 범위 안) 조각 수 — 같으면 수역이 통째로 들어온 것
 */
export const waterAttributes = (t: WaterTable, g: WaterGroup): Record<string, number | string> => {
    const k = g.k0
    const ribbon = t.kind[k] === WATER_KIND.ribbon
    return {
        src_id: t.ids[k],
        kind: ribbon ? "line" : t.kind[k] === WATER_KIND.lake ? "lake" : "river",
        kind_name: ribbon ? "하천선" : t.kindNames[t.kind[k]] || "",
        name: t.names[k],
        river_no: t.riverNos[k],
        river_se: t.riverSe[k],
        river_se_name: t.riverSeNames[t.riverSe[k]] || "",
        pieces: g.rows.length,
        src_pieces: t.srcNPieces[k],
        flags: t.flags[k],
        cut: t.flags[k] & (ribbon ? WATER_LINE_FLAG.cut : WATER_PIECE_FLAG.cut) ? 1 : 0,
        shore: !ribbon && t.flags[k] & WATER_PIECE_FLAG.shore ? 1 : 0,
    }
}
