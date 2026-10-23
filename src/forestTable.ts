/**
 * 산림 표. 메인이 물 표(waterTable.ts)·도로 표(roadTable.ts)처럼 들고 있는 산림 원본으로, 도엽 마스크(forestMask.ts)에 칠한 임상도
 * 폴리곤마다 속성과 칠한 픽셀 수를 행 번호 k 로 찾는다. 행은 **임상(frtp) 순 → id 순**. 패널 통계(도엽 경계에 걸친 폴리곤을 id 로 한 번만
 * 센다)와 2차의 집기·HUD 용이다. 산림은 메쉬가 아니라 지형 셰이더가 마스크로 색을 바꾸므로 삼각형 범위가 없다(계획 3.2절 "안 라").
 * 내보내기는 하지 않는다(계획 F5: 라이선스 확인 중).
 * 모두 typed array 라 Worker 에서 transfer 로 넘긴다(forestTableBuffers).
 *
 * 이 모듈은 의존성이 없다(받기 코드(proj4)를 끌어오지 않게). 코드 상수도 그래서 여기 둔다.
 * 계획: docs/forest-layer-plan.md
 */
/** 폴리곤 flags 비트(서버 README 12.1) */
export const FOREST_FLAG = {
    /** 다른 5K 파일에도 있음 → 합칠 때 id 로 중복 제거 */
    duplicated: 1,
    /** MultiPolygon 을 나눈 파트(같은 원본 행은 id ÷ 64 가 같다) */
    multipart: 2,
    /** 원본 도형이 유효하지 않음(자기교차 등. 그대로 담겼다. 삼각분할 검사에서 걸러진다) */
    invalid: 4,
} as const

/** 임상(frtp) 코드 */
export const FOREST_TYPE = {
    /** 무립목지/비산림 */
    none: 0,
    conifer: 1,
    broadleaf: 2,
    mixed: 3,
    bamboo: 4,
} as const

/** 임상 코드 수(0 ~ 4). 화면 조각·통계 배열의 길이 */
export const FOREST_TYPE_COUNT = 5

/** dmcls·agcls·height 의 "값 없음" */
export const FOREST_MISSING = 255

/** 코드 값 → 한글 이름 표(길이 256, 없으면 ""). forestData.ts 의 loadForestCodes 가 채운다 */
export type ForestCodeNames = {
    frtpNames: string[]
    koftrNames: string[]
    storunstNames: string[]
    frorNames: string[]
    dmclsNames: string[]
    agclsNames: string[]
    dnstNames: string[]
    heightNames: string[]
}

export type ForestTable = {
    count: number
    /** 폴리곤 id(원본 행 × 64 + 파트). 전국 고유 */
    ids: Uint32Array
    /** 임상(FOREST_TYPE). 행은 이 값 오름차순 */
    frtp: Uint8Array
    /** 수종그룹 */
    koftr: Uint8Array
    /** 경급(255 = 없음) */
    dmcls: Uint8Array
    /** 영급(255 = 없음) */
    agcls: Uint8Array
    /** 밀도(0 = 없음) */
    dnst: Uint8Array
    /** 임분고 계급(255 = 없음) */
    height: Uint8Array
    /** 임목존재 */
    storunst: Uint8Array
    /** 임종 */
    fror: Uint8Array
    /** 갱신년도(0 = 없음) */
    year: Uint16Array
    /** FOREST_FLAG 비트 */
    flags: Uint8Array
    /** 이 도엽 마스크에 칠한 픽셀 중 중심이 도엽 폴리곤 안인 수(계획서 3.6, 2026-10-23. bbox 귀퉁이에만 칠한 폴리곤은 행이 없다) */
    pixels: Uint32Array
} & ForestCodeNames

/** 표 한 행의 입력(forestMesh 가 폴리곤에서 만든다) */
export type ForestRow = {
    id: number
    frtp: number
    koftr: number
    dmcls: number
    agcls: number
    dnst: number
    height: number
    storunst: number
    fror: number
    year: number
    flags: number
}

const emptyNames = () => new Array<string>(256).fill("")
/** 이름 표가 없을 때(검증 스크립트 등) */
export const emptyForestCodeNames = (): ForestCodeNames => ({
    frtpNames: emptyNames(),
    koftrNames: emptyNames(),
    storunstNames: emptyNames(),
    frorNames: emptyNames(),
    dmclsNames: emptyNames(),
    agclsNames: emptyNames(),
    dnstNames: emptyNames(),
    heightNames: emptyNames(),
})

const copyNames = (n: ForestCodeNames): ForestCodeNames => ({
    frtpNames: n.frtpNames.slice(),
    koftrNames: n.koftrNames.slice(),
    storunstNames: n.storunstNames.slice(),
    frorNames: n.frorNames.slice(),
    dmclsNames: n.dmclsNames.slice(),
    agclsNames: n.agclsNames.slice(),
    dnstNames: n.dnstNames.slice(),
    heightNames: n.heightNames.slice(),
})

const allocate = (count: number, names: ForestCodeNames): ForestTable => ({
    count,
    ids: new Uint32Array(count),
    frtp: new Uint8Array(count),
    koftr: new Uint8Array(count),
    dmcls: new Uint8Array(count),
    agcls: new Uint8Array(count),
    dnst: new Uint8Array(count),
    height: new Uint8Array(count),
    storunst: new Uint8Array(count),
    fror: new Uint8Array(count),
    year: new Uint16Array(count),
    flags: new Uint8Array(count),
    pixels: new Uint32Array(count),
    ...names,
})

/** 표의 행 단위 typed array 들(합치기·transfer·사본이 같은 목록을 돈다) */
const columns = (t: ForestTable) => [t.ids, t.frtp, t.koftr, t.dmcls, t.agcls, t.dnst, t.height, t.storunst, t.fror, t.year, t.flags, t.pixels]

/** 행 목록을 표로 옮긴다(픽셀 수는 아직 0) */
export const createForestTable = (rows: ForestRow[], names: ForestCodeNames = emptyForestCodeNames()): ForestTable => {
    const t = allocate(rows.length, names)
    rows.forEach((r, k) => {
        t.ids[k] = r.id
        t.frtp[k] = r.frtp
        t.koftr[k] = r.koftr
        t.dmcls[k] = r.dmcls
        t.agcls[k] = r.agcls
        t.dnst[k] = r.dnst
        t.height[k] = r.height
        t.storunst[k] = r.storunst
        t.fror[k] = r.fror
        t.year[k] = r.year
        t.flags[k] = r.flags
    })
    return t
}

/**
 * 도엽별 산림 표를 하나로 합친다(도엽 순으로 이어 붙임. 같은 폴리곤이 여러 도엽에 있으면 행도 여럿). 이름 표는 첫 표의 것
 *
 * @returns 합친 표(새 배열). parts 가 비면 null
 */
export const mergeForestTables = (parts: ForestTable[]): ForestTable | null => {
    if (parts.length === 0) return null
    const count = parts.reduce((n, t) => n + t.count, 0)
    const out = allocate(count, copyNames(parts[0]))
    const outCols = columns(out)
    let k0 = 0
    for (const t of parts) {
        columns(t).forEach((col, c) => (outCols[c] as { set: (a: ArrayLike<number>, offset: number) => void }).set(col, k0))
        k0 += t.count
    }
    return out
}

/** 표의 typed array 버퍼 목록(postMessage 의 transfer 용. 이름 표 문자열 배열은 구조 복제로 간다) */
export const forestTableBuffers = (t: ForestTable): ArrayBuffer[] => columns(t).map((a) => a.buffer as ArrayBuffer)

/** 표의 사본(배열마다 slice). 원본을 계속 쓰면서 사본을 transfer 할 때 */
export const cloneForestTable = (t: ForestTable): ForestTable => ({
    count: t.count,
    ids: t.ids.slice(),
    frtp: t.frtp.slice(),
    koftr: t.koftr.slice(),
    dmcls: t.dmcls.slice(),
    agcls: t.agcls.slice(),
    dnst: t.dnst.slice(),
    height: t.height.slice(),
    storunst: t.storunst.slice(),
    fror: t.fror.slice(),
    year: t.year.slice(),
    flags: t.flags.slice(),
    pixels: t.pixels.slice(),
    ...copyNames(t),
})

/**
 * 패널 통계: 칠한 폴리곤 수를 임상별로(길이 FOREST_TYPE_COUNT). 여러 도엽의 표를 받아 **id 로 한 번만** 센다(폴리곤은 도엽 경계에서 잘리지
 * 않고 걸친 도엽마다 칠해진다)
 */
export const forestTypeCounts = (tables: Iterable<ForestTable>): number[] => {
    const counts = new Array<number>(FOREST_TYPE_COUNT).fill(0)
    const seen = new Set<number>()
    for (const t of tables) {
        for (let k = 0; k < t.count; k++) {
            if (t.pixels[k] === 0 || t.frtp[k] >= FOREST_TYPE_COUNT || seen.has(t.ids[k])) continue
            seen.add(t.ids[k])
            counts[t.frtp[k]]++
        }
    }
    return counts
}

/** 집기·HUD 용 이름: "침엽수림 (소나무, 3영급)" 꼴. 값 없음(255)·빈 이름은 뺀다 */
export const forestLabel = (t: ForestTable, k: number) => {
    const type = t.frtpNames[t.frtp[k]] || "산림"
    const parts: string[] = []
    if (t.koftrNames[t.koftr[k]]) parts.push(t.koftrNames[t.koftr[k]])
    if (t.agcls[k] !== FOREST_MISSING && t.agclsNames[t.agcls[k]]) parts.push(t.agclsNames[t.agcls[k]])
    return parts.length ? `${type} (${parts.join(", ")})` : type
}
