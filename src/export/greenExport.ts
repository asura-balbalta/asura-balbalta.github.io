/**
 * 녹지(OSM) 내보내기 공통(docs/osm-green-layer-plan.md G5, 결정 G1 b-2). 녹지는 따로 메쉬가 없고 지형 메쉬의 삼각형 분류 범위
 * (`mergedMeshes().terrain.greenRanges`)로 존재하므로, 형식마다 지형을 분류별로 나눠 재질을 붙인다. DOM 을 쓰지 않는다(내보내기 Worker 가 import).
 *
 * - 분류 범위·색·이름·출처는 메인이 정해 요청에 싣는다(GreenExport). 녹지를 내보내지 않으면 요청에 없고 지형은 전처럼 한 재질이다.
 * - 색은 화면 색상표의 greenColors(지금 테마) 원색이다. 내보내기는 조명이 없어 표고 색과 섞지 않는다(지형 재질도 고정 원색).
 */

/** 삼각형 단위 분류 범위(osmGreenMesh.ts GreenRange 와 같은 모양. 워커 번들이 polygon-clipping 을 끌고 오지 않게 여기 따로 둔다) */
export type GreenFaceRange = { cls: number; first: number; count: number }

/** 분류 하나의 내보내기 정보 */
export type GreenExportClass = {
    /** 분류 코드(1 ~ 6) */
    cls: number
    /** 재질·그룹·레이어 이름("녹지-숲") */
    name: string
    /** 원색 RGB(0 ~ 255) */
    rgb: [number, number, number]
}

/** 메인 → Worker: 녹지 내보내기 정보. 녹지를 담을 때만 요청에 싣는다 */
export type GreenExport = {
    /** 분류 코드 순(1 ~ 6) */
    classes: GreenExportClass[]
    /** SKP 하위 그룹 속성·3DM user string 에 넣는 출처(서버 인덱스 또는 대체문에서) */
    source: { source: string; source_url: string; license: string }
    /** 파일 메타 문구에 덧붙이는 한 줄("녹지: © OpenStreetMap contributors (ODbL 1.0, https://…)") */
    fileLine: string
}

/** "#RRGGBB" → [r, g, b](0 ~ 255). 잘못된 값은 회색 */
export const hexToRgb = (hex: string): [number, number, number] => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
    if (!m) return [160, 160, 160]
    const n = parseInt(m[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * 범위를 분류별로 모은다(분류 0 = 녹지 아님 포함). 범위 순서는 유지한다
 *
 * @returns 분류 코드 → 그 분류의 범위들. 분류 오름차순
 */
export const rangesByClass = (ranges: GreenFaceRange[]): Map<number, GreenFaceRange[]> => {
    const out = new Map<number, GreenFaceRange[]>()
    for (const r of ranges) {
        if (r.count <= 0) continue
        let list = out.get(r.cls)
        if (!list) out.set(r.cls, (list = []))
        list.push(r)
    }
    return new Map([...out.entries()].sort((a, b) => a[0] - b[0]))
}

/** 녹지 분류(1 이상) 삼각형이 하나라도 있는가 */
export const hasGreenFaces = (ranges: GreenFaceRange[] | undefined) => !!ranges?.some((r) => r.cls > 0 && r.count > 0)

/** 범위들의 삼각형 인덱스를 이어 붙인다(정점 번호는 원래 메쉬 그대로) */
export const indicesOfRanges = (indices: Uint32Array, ranges: GreenFaceRange[]): Uint32Array => {
    let n = 0
    for (const r of ranges) n += r.count * 3
    const out = new Uint32Array(n)
    let at = 0
    for (const r of ranges) {
        out.set(indices.subarray(r.first * 3, (r.first + r.count) * 3), at)
        at += r.count * 3
    }
    return out
}

/**
 * 인덱스가 쓰는 정점만 남긴 메쉬(정점 번호를 새로 매김). 분류별 조각이 전체 정점을 복사하지 않게 한다
 *
 * @param normals 있으면 같은 정점의 법선도 남긴다
 */
export const compactMesh = (positions: Float32Array, indices: Uint32Array, normals?: Float32Array) => {
    const remap = new Int32Array(positions.length / 3).fill(-1)
    let used = 0
    for (let i = 0; i < indices.length; i++) if (remap[indices[i]] < 0) remap[indices[i]] = used++
    const outPositions = new Float32Array(used * 3)
    const outNormals = normals ? new Float32Array(used * 3) : undefined
    for (let v = 0; v < remap.length; v++) {
        const k = remap[v]
        if (k < 0) continue
        outPositions[k * 3] = positions[v * 3]
        outPositions[k * 3 + 1] = positions[v * 3 + 1]
        outPositions[k * 3 + 2] = positions[v * 3 + 2]
        if (outNormals) {
            outNormals[k * 3] = normals![v * 3]
            outNormals[k * 3 + 1] = normals![v * 3 + 1]
            outNormals[k * 3 + 2] = normals![v * 3 + 2]
        }
    }
    const outIndices = new Uint32Array(indices.length)
    for (let i = 0; i < indices.length; i++) outIndices[i] = remap[indices[i]]
    return { positions: outPositions, indices: outIndices, normals: outNormals }
}

/** 원본 삼각형마다 분류 태그(buildSteppedMeshChunks 의 tags 옵션) */
export const tagsOfRanges = (ranges: GreenFaceRange[], triangles: number): Uint8Array => {
    const tags = new Uint8Array(triangles)
    for (const r of ranges) tags.fill(r.cls, r.first, r.first + r.count)
    return tags
}

/** 계단형 조각의 tagRanges((태그, 첫 삼각형, 수) × n) → 범위 목록 */
export const rangesOfTagRanges = (tagRanges: Uint32Array): GreenFaceRange[] => {
    const out: GreenFaceRange[] = []
    for (let k = 0; k < tagRanges.length; k += 3) out.push({ cls: tagRanges[k], first: tagRanges[k + 1], count: tagRanges[k + 2] })
    return out
}
