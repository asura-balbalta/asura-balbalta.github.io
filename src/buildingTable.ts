/**
 * 건물 표. 메인이 지형의 TinMesh 처럼 들고 있는 건물 원본으로, BFP 의 모든 필드와 "합쳐진 메쉬 안 어디에 세워졌는지" 를
 * 건물 번호 k 로 찾는다. 모두 typed array 라 Worker 에서 transfer 로 넘기고(buildingTableBuffers), 건물 수만 동이어도
 * 수 MB 다. SKP·3DM 내보내기가 건물마다 면 그룹·솔리드와 속성을 만들 때, 앞으로 지형 편집 뒤 건물을 다시 앉힐 때 쓴다.
 *
 * 이 모듈은 의존성이 없다(내보내기 Worker 번들이 건물 받기 코드를 끌어오지 않게).
 */
import type { Building, BuildingCodeTable } from "./buildingsData"

/**
 * 건물 k 의 footprint 점은 xy 의 [pointStart[k], pointStart[k+1]) (외곽 → 구멍들 순, 공통 원점 mm 정수), 구멍 점 수는
 * holeLen 의 [holeStart[k], holeStart[k+1]). 세운 건물은 메쉬 정점 vertexBase[k] 부터 점 수만큼이 아래 고리, 이어 같은 수가
 * 위 고리이고(점 순서는 xy 와 같다), 삼각형은 faceBase[k] 부터 다음 세운 건물 전까지다. 지형 밖이라 못 세운 건물은
 * vertexBase·faceBase 가 NOT_BUILT 이고 baseZ·builtHeight 가 NaN 이다
 */
export type BuildingTable = {
    count: number
    /** 전국 고유 번호(BFP u32) */
    ids: Uint32Array
    /** 높이(m). 0 이면 없음 */
    heights: Float32Array
    /** 지상 층수. 0 이면 없음 */
    floors: Uint8Array
    floorsUnder: Uint8Array
    /** 용도 코드의 u8 인덱스(codes.json 의 use 표). 0 = 없음 */
    useCd: Uint8Array
    structCd: Uint8Array
    /** BUILDING_FLAG 비트 */
    flags: Uint8Array
    /** 건물마다 xy 안 점 시작 번호. 길이 count + 1 */
    pointStart: Uint32Array
    /** 모든 건물의 (x, y) 연속, 공통 원점 mm 정수. 파일 규약은 외곽 반시계·구멍 시계지만 다른 고리도 있다 */
    xy: Int32Array
    /** 건물마다 holeLen 안 시작 번호. 길이 count + 1 */
    holeStart: Uint32Array
    /** 구멍마다 점 수 */
    holeLen: Uint32Array
    /** 세운 건물의 첫 정점 번호. 못 세웠으면 NOT_BUILT */
    vertexBase: Uint32Array
    /** 세운 건물의 첫 삼각형 번호. 못 세웠으면 NOT_BUILT */
    faceBase: Uint32Array
    /** 세운 건물의 바닥 z(지형 위, 묻기 전). 메쉬의 아래 고리는 이보다 WALL_SINK_M 낮다 */
    baseZ: Float32Array
    /** 세운 높이(m): height → floors × 층고 → 기본값 순으로 정한 값. 지붕 z = baseZ + builtHeight */
    builtHeight: Float32Array
    /** 건물명(names/v1). "" = 없음. 문자열 배열이라 transfer 는 안 되고 structured clone 으로 복사된다 */
    names: string[]
    /** 동명("101동"·"가동" 꼴). "" = 없음 */
    dongs: string[]
    /** 이름 출처 비트(1 = 건물명 표제부 보충, 2 = 동명 표제부 보충) */
    nameSrc: Uint8Array
    /** u8 인덱스 → 용도·구조·용도 대분류 이름(길이 256, 없으면 ""). codes.json 에서 */
    useNames: string[]
    structNames: string[]
    useGroupNames: string[]
}

/** vertexBase·faceBase 의 "못 세움" 표시 */
export const NOT_BUILT = 0xffffffff

/** 이름 표가 없을 때(검증 스크립트 등) 쓰는 빈 코드 표 */
export const emptyCodeNames = (): Pick<BuildingCodeTable, "useNames" | "structNames" | "useGroupNames"> => ({
    useNames: new Array<string>(256).fill(""),
    structNames: new Array<string>(256).fill(""),
    useGroupNames: new Array<string>(256).fill(""),
})

/** Building[] 의 모든 필드를 표로 옮긴다(세운 위치는 아직 NOT_BUILT·NaN) */
export const createBuildingTable = (
    buildings: Building[],
    codeNames: Pick<BuildingCodeTable, "useNames" | "structNames" | "useGroupNames"> = emptyCodeNames(),
): BuildingTable => {
    const count = buildings.length
    const pointStart = new Uint32Array(count + 1)
    const holeStart = new Uint32Array(count + 1)
    for (let k = 0; k < count; k++) {
        pointStart[k + 1] = pointStart[k] + buildings[k].xy.length / 2
        holeStart[k + 1] = holeStart[k] + buildings[k].holes.length
    }
    const table: BuildingTable = {
        count,
        ids: new Uint32Array(count),
        heights: new Float32Array(count),
        floors: new Uint8Array(count),
        floorsUnder: new Uint8Array(count),
        useCd: new Uint8Array(count),
        structCd: new Uint8Array(count),
        flags: new Uint8Array(count),
        pointStart,
        xy: new Int32Array(2 * pointStart[count]),
        holeStart,
        holeLen: new Uint32Array(holeStart[count]),
        vertexBase: new Uint32Array(count).fill(NOT_BUILT),
        faceBase: new Uint32Array(count).fill(NOT_BUILT),
        baseZ: new Float32Array(count).fill(NaN),
        builtHeight: new Float32Array(count).fill(NaN),
        names: new Array<string>(count),
        dongs: new Array<string>(count),
        nameSrc: new Uint8Array(count),
        useNames: codeNames.useNames,
        structNames: codeNames.structNames,
        useGroupNames: codeNames.useGroupNames,
    }
    for (let k = 0; k < count; k++) {
        const b = buildings[k]
        table.names[k] = b.name
        table.dongs[k] = b.dong
        table.nameSrc[k] = b.nameSrc
        table.ids[k] = b.id
        table.heights[k] = b.height
        table.floors[k] = b.floors
        table.floorsUnder[k] = b.floorsUnder
        table.useCd[k] = b.useCd
        table.structCd[k] = b.structCd
        table.flags[k] = b.flags
        table.xy.set(b.xy, 2 * pointStart[k])
        table.holeLen.set(b.holes, holeStart[k])
    }
    return table
}

/**
 * 도엽별 건물 표를 하나로 합친다(2026-10-14 L3. 데이터 단위가 1K 도엽이 되면서 내보내기 때 도엽 메쉬를 이어 붙이므로 표도 같이 잇는다).
 * 건물 단위 배열은 순서대로 잇고, 안에서 가리키는 번호는 오프셋을 더한다: pointStart·holeStart 는 앞 표들의 점 수(xy 길이의 절반)·구멍 수,
 * vertexBase·faceBase 는 그 도엽 메쉬가 합친 메쉬에서 시작하는 정점·삼각형 번호(못 세운 건물의 NOT_BUILT 는 그대로).
 * 코드 이름 표(useNames·structNames·useGroupNames)는 도엽마다 같으므로 첫 표의 것을 쓴다.
 *
 * @param parts 도엽 순서대로. vertexOffset·faceOffset 은 그 도엽 건물 메쉬가 합친 메쉬에서 시작하는 정점·삼각형 번호
 * @returns 합친 표(새 배열). parts 가 비면 null
 */
export const mergeBuildingTables = (parts: { table: BuildingTable; vertexOffset: number; faceOffset: number }[]): BuildingTable | null => {
    if (parts.length === 0) return null
    const count = parts.reduce((n, p) => n + p.table.count, 0)
    const xyLength = parts.reduce((n, p) => n + p.table.xy.length, 0)
    const holeCount = parts.reduce((n, p) => n + p.table.holeLen.length, 0)
    const first = parts[0].table
    const out: BuildingTable = {
        count,
        ids: new Uint32Array(count),
        heights: new Float32Array(count),
        floors: new Uint8Array(count),
        floorsUnder: new Uint8Array(count),
        useCd: new Uint8Array(count),
        structCd: new Uint8Array(count),
        flags: new Uint8Array(count),
        pointStart: new Uint32Array(count + 1),
        xy: new Int32Array(xyLength),
        holeStart: new Uint32Array(count + 1),
        holeLen: new Uint32Array(holeCount),
        vertexBase: new Uint32Array(count),
        faceBase: new Uint32Array(count),
        baseZ: new Float32Array(count),
        builtHeight: new Float32Array(count),
        names: [],
        dongs: [],
        nameSrc: new Uint8Array(count),
        useNames: first.useNames.slice(),
        structNames: first.structNames.slice(),
        useGroupNames: first.useGroupNames.slice(),
    }
    let k0 = 0
    let point0 = 0
    let hole0 = 0
    for (const { table: t, vertexOffset, faceOffset } of parts) {
        const n = t.count
        out.ids.set(t.ids, k0)
        out.heights.set(t.heights, k0)
        out.floors.set(t.floors, k0)
        out.floorsUnder.set(t.floorsUnder, k0)
        out.useCd.set(t.useCd, k0)
        out.structCd.set(t.structCd, k0)
        out.flags.set(t.flags, k0)
        out.baseZ.set(t.baseZ, k0)
        out.builtHeight.set(t.builtHeight, k0)
        out.nameSrc.set(t.nameSrc, k0)
        out.xy.set(t.xy, 2 * point0)
        out.holeLen.set(t.holeLen, hole0)
        for (let k = 0; k < n; k++) {
            out.pointStart[k0 + k] = t.pointStart[k] + point0
            out.holeStart[k0 + k] = t.holeStart[k] + hole0
            out.vertexBase[k0 + k] = t.vertexBase[k] === NOT_BUILT ? NOT_BUILT : t.vertexBase[k] + vertexOffset
            out.faceBase[k0 + k] = t.faceBase[k] === NOT_BUILT ? NOT_BUILT : t.faceBase[k] + faceOffset
        }
        out.names.push(...t.names)
        out.dongs.push(...t.dongs)
        k0 += n
        point0 += t.xy.length / 2
        hole0 += t.holeLen.length
    }
    out.pointStart[count] = point0
    out.holeStart[count] = hole0
    return out
}

/** 표의 typed array 버퍼 목록(postMessage 의 transfer 용). 문자열 배열은 transfer 대상이 아니라 복사된다 */
export const buildingTableBuffers = (t: BuildingTable): ArrayBuffer[] =>
    [t.ids, t.heights, t.floors, t.floorsUnder, t.useCd, t.structCd, t.flags, t.pointStart, t.xy, t.holeStart, t.holeLen, t.vertexBase, t.faceBase, t.baseZ, t.builtHeight, t.nameSrc].map(
        (a) => a.buffer as ArrayBuffer,
    )

/** 표의 사본(배열마다 slice). 원본을 계속 쓰면서 사본을 transfer 할 때 */
export const cloneBuildingTable = (t: BuildingTable): BuildingTable => ({
    count: t.count,
    ids: t.ids.slice(),
    heights: t.heights.slice(),
    floors: t.floors.slice(),
    floorsUnder: t.floorsUnder.slice(),
    useCd: t.useCd.slice(),
    structCd: t.structCd.slice(),
    flags: t.flags.slice(),
    pointStart: t.pointStart.slice(),
    xy: t.xy.slice(),
    holeStart: t.holeStart.slice(),
    holeLen: t.holeLen.slice(),
    vertexBase: t.vertexBase.slice(),
    faceBase: t.faceBase.slice(),
    baseZ: t.baseZ.slice(),
    builtHeight: t.builtHeight.slice(),
    names: t.names.slice(),
    dongs: t.dongs.slice(),
    nameSrc: t.nameSrc.slice(),
    useNames: t.useNames.slice(),
    structNames: t.structNames.slice(),
    useGroupNames: t.useGroupNames.slice(),
})

/**
 * 표에서 건물 k 의 고리들을 m 단위 평면 좌표로 꺼낸다. 첫 고리가 외곽, 나머지가 구멍이며, 외곽은 반시계·구멍은 시계로
 * 맞춘다(파일 규약과 다른 고리는 뒤집는다). 점이 3개 미만인 고리는 뺀다. 외곽이 없으면 빈 배열
 */
export const buildingRings = (t: BuildingTable, k: number): [number, number][][] => {
    const p0 = t.pointStart[k], p1 = t.pointStart[k + 1]
    let outerEnd = p1
    for (let h = t.holeStart[k]; h < t.holeStart[k + 1]; h++) outerEnd -= t.holeLen[h]
    const starts = [p0]
    let s = outerEnd
    for (let h = t.holeStart[k]; h < t.holeStart[k + 1]; h++) {
        starts.push(s)
        s += t.holeLen[h]
    }
    starts.push(p1)
    const rings: [number, number][][] = []
    for (let r = 0; r + 1 < starts.length; r++) {
        const ring: [number, number][] = []
        for (let i = starts[r]; i < starts[r + 1]; i++) ring.push([t.xy[2 * i] / 1000, t.xy[2 * i + 1] / 1000])
        if (ring.length < 3) {
            if (r === 0) return []
            continue
        }
        let area2 = 0
        for (let i = 0; i < ring.length; i++) {
            const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length]
            area2 += x0 * y1 - x1 * y0
        }
        if ((r === 0 && area2 < 0) || (r > 0 && area2 > 0)) ring.reverse()
        rings.push(ring)
    }
    return rings
}

/** 건물명과 동명을 "건물명 동명" 으로 잇는다. 동명이 건물명과 같거나 없으면 한 번만. 둘 다 없으면 "" */
export const buildingFullName = (t: BuildingTable, k: number) => {
    const name = t.names[k], dong = t.dongs[k]
    if (name && dong && dong !== name) return `${name} ${dong}`
    return name || dong
}

/**
 * 내보내기 파일에서 건물 k 를 가리키는 이름: "용도명 (건물명 동명, 층수F, 높이m)". 사람이 읽는 용도라 레이어 고유 번호는
 * 넣지 않는다(속성 id 에 있다). 용도명이 없으면 "건물", 건물명·동명이 없으면 그 자리를 비우고, 층수가 없으면 높이만,
 * 서버 높이가 없으면 세운 높이를 적는다. SketchUp 웹처럼 속성 사전을 못 보는 뷰어의 Entity Info·Outliner 용.
 * 예: "공동주택 (상록아파트 105동, 15F, 45.0m)", "단독주택 (2F, 6.0m)", "건물 (12.0m)"
 */
export const buildingLabel = (t: BuildingTable, k: number) => {
    const use = t.useNames[t.useCd[k]] || "건물"
    const floors = t.floors[k]
    const height = t.heights[k] > 0 ? t.heights[k] : t.builtHeight[k]
    const parts = [buildingFullName(t, k), floors > 0 ? `${floors}F` : "", Number.isFinite(height) ? `${height.toFixed(1)}m` : ""].filter(Boolean)
    return parts.length ? `${use} (${parts.join(", ")})` : use
}

/**
 * 내보내기 파일에 적을 건물 k 의 속성(키는 파일 안 이름). 숫자 7개 + 문자열 6개.
 * id 는 서버가 전국 대조표 행 순서로 매긴 레이어 고유 번호(AL gis_id·대장 관리번호가 아님). name_src 는 이름 출처 비트
 */
export const buildingAttributes = (t: BuildingTable, k: number): Record<string, number | string> => ({
    id: t.ids[k],
    height_m: t.heights[k],
    floors: t.floors[k],
    floors_under: t.floorsUnder[k],
    use_cd: t.useCd[k],
    struct_cd: t.structCd[k],
    flags: t.flags[k],
    name: t.names[k],
    dong: t.dongs[k],
    name_src: t.nameSrc[k],
    use_name: t.useNames[t.useCd[k]],
    use_group_name: t.useGroupNames[t.useCd[k]],
    struct_name: t.structNames[t.structCd[k]],
})
