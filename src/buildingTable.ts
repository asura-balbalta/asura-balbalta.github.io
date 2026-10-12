/**
 * 건물 표. 메인이 지형의 TinMesh 처럼 들고 있는 건물 원본으로, BFP 의 모든 필드와 "합쳐진 메쉬 안 어디에 세워졌는지" 를
 * 건물 번호 k 로 찾는다. 모두 typed array 라 Worker 에서 transfer 로 넘기고(buildingTableBuffers), 건물 수만 동이어도
 * 수 MB 다. SKP·3DM 내보내기가 건물마다 면 그룹·솔리드와 속성을 만들 때, 앞으로 지형 편집 뒤 건물을 다시 앉힐 때 쓴다.
 *
 * 이 모듈은 의존성이 없다(내보내기 Worker 번들이 건물 받기 코드를 끌어오지 않게).
 */
import type { Building } from "./buildingsData"

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
}

/** vertexBase·faceBase 의 "못 세움" 표시 */
export const NOT_BUILT = 0xffffffff

/** Building[] 의 모든 필드를 표로 옮긴다(세운 위치는 아직 NOT_BUILT·NaN) */
export const createBuildingTable = (buildings: Building[]): BuildingTable => {
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
    }
    for (let k = 0; k < count; k++) {
        const b = buildings[k]
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

/** 표의 typed array 버퍼 목록(postMessage 의 transfer 용) */
export const buildingTableBuffers = (t: BuildingTable): ArrayBuffer[] =>
    [t.ids, t.heights, t.floors, t.floorsUnder, t.useCd, t.structCd, t.flags, t.pointStart, t.xy, t.holeStart, t.holeLen, t.vertexBase, t.faceBase, t.baseZ, t.builtHeight].map(
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

/**
 * 내보내기 파일에서 건물 k 를 가리키는 이름: "번호 (층수F, 높이m)". 층수가 없으면 높이만, 서버 높이가 없으면 세운 높이를
 * 적는다. SketchUp 웹처럼 속성 사전을 못 보는 뷰어에서도 Entity Info·Outliner 로 층수·높이가 보이게 하기 위한 것
 */
export const buildingLabel = (t: BuildingTable, k: number) => {
    const floors = t.floors[k]
    const height = t.heights[k] > 0 ? t.heights[k] : t.builtHeight[k]
    const parts = [floors > 0 ? `${floors}F` : "", Number.isFinite(height) ? `${height.toFixed(1)}m` : ""].filter(Boolean)
    return parts.length ? `${t.ids[k]} (${parts.join(", ")})` : String(t.ids[k])
}

/** 내보내기 파일에 적을 건물 k 의 속성(키는 파일 안 이름). 모두 숫자 */
export const buildingAttributes = (t: BuildingTable, k: number): Record<string, number> => ({
    id: t.ids[k],
    height_m: t.heights[k],
    floors: t.floors[k],
    floors_under: t.floorsUnder[k],
    use_cd: t.useCd[k],
    struct_cd: t.structCd[k],
    flags: t.flags[k],
})
