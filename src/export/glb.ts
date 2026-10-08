/**
 * GLB(바이너리 glTF 2.0) 인코더. 외부 라이브러리 없이 JSON 머리말과 BIN 버퍼를 규격대로 붙인다.
 *
 * 입력 좌표는 TinMesh 와 같은 Z-up 미터(x 동, y 북, z 높이)이고, glTF 는 Y-up 이므로 (x, z, -y) 로 바꿔 넣는다.
 * 파일 전체가 노드 하나·메쉬 하나이고, 메쉬가 조각(primitive) 여러 개를 가진다. 레이어는 조각의 재질로 구분한다.
 * Blender 등은 이것을 오브젝트 하나 + 재질 슬롯 여러 개로 들여오므로 지형·건물이 한 덩어리로 다뤄진다
 * (처음에는 레이어마다 노드를 두었는데, 뷰어에서 별개 오브젝트로 갈라져 보여 합쳤다).
 * 각진 물체(건물·계단형)는 toFlatPrimitive 로 꼭짓점을 삼각형마다 따로 두고 면 법선을 넣는다. 법선 없이 두면 규격상
 * 뷰어가 평면 법선을 계산해야 하지만, Blender 는 스무스 셰이딩으로 들여와 공유 꼭짓점의 모서리가 둥글게 보였다.
 */

/** 재질 하나: 이름(레이어 id), 색(0 ~ 1) */
export type GlbMaterial = { name: string; color: [number, number, number] }

/** 한 조각: Z-up 좌표와 재질 번호. normals 가 있으면 정점 법선(부드러운 음영), 없으면 평면 음영 */
export type GlbPrimitive = { positions: Float32Array; indices: Uint32Array; normals?: Float32Array; material: number }

const GLB_MAGIC = 0x46546c67 // "glTF"
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942
const FLOAT = 5126
const UNSIGNED_INT = 5125
const ARRAY_BUFFER = 34962
const ELEMENT_ARRAY_BUFFER = 34963

const pad4 = (n: number) => (n + 3) & ~3

/**
 * 정점 법선(면 법선을 넓이 가중으로 더해 정규화). Z-up 입력 그대로 계산하고, 변환은 encodeGlb 가 한다.
 * (렌더러의 computeVertexNormals 와 같은 계산이지만 그쪽은 내부 함수라 여기서 따로 둔다)
 */
export const computeVertexNormals = (positions: Float32Array, indices: Uint32Array) => {
    const normals = new Float32Array(positions.length)
    for (let t = 0; t < indices.length; t += 3) {
        const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3
        const e1x = positions[b] - positions[a], e1y = positions[b + 1] - positions[a + 1], e1z = positions[b + 2] - positions[a + 2]
        const e2x = positions[c] - positions[a], e2y = positions[c + 1] - positions[a + 1], e2z = positions[c + 2] - positions[a + 2]
        const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x
        for (const i of [a, b, c]) {
            normals[i] += nx
            normals[i + 1] += ny
            normals[i + 2] += nz
        }
    }
    for (let i = 0; i < normals.length; i += 3) {
        const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1
        normals[i] /= len
        normals[i + 1] /= len
        normals[i + 2] /= len
    }
    return normals
}

/**
 * 인덱스 메쉬를 꼭짓점을 공유하지 않는 평면 음영 조각으로 펼친다. 삼각형마다 꼭짓점 3개와 같은 면 법선 3개를 두므로
 * 데이터는 약 3배가 되지만, 뷰어의 셰이딩 설정과 무관하게 모서리가 각지게 보인다. 넓이 0 삼각형은 법선 (0, 0, 0).
 */
export const toFlatPrimitive = (positions: Float32Array, indices: Uint32Array, material: number): GlbPrimitive => {
    const count = Math.floor(indices.length / 3)
    const flatPositions = new Float32Array(count * 9)
    const normals = new Float32Array(count * 9)
    const flatIndices = new Uint32Array(count * 3)
    for (let t = 0; t < count; t++) {
        const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3
        const o = t * 9
        flatPositions.set(positions.subarray(a, a + 3), o)
        flatPositions.set(positions.subarray(b, b + 3), o + 3)
        flatPositions.set(positions.subarray(c, c + 3), o + 6)
        const e1x = positions[b] - positions[a], e1y = positions[b + 1] - positions[a + 1], e1z = positions[b + 2] - positions[a + 2]
        const e2x = positions[c] - positions[a], e2y = positions[c + 1] - positions[a + 1], e2z = positions[c + 2] - positions[a + 2]
        let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x
        const len = Math.hypot(nx, ny, nz)
        if (len > 0) {
            nx /= len
            ny /= len
            nz /= len
        }
        for (let k = 0; k < 3; k++) {
            normals[o + k * 3] = nx
            normals[o + k * 3 + 1] = ny
            normals[o + k * 3 + 2] = nz
        }
        flatIndices[t * 3] = t * 3
        flatIndices[t * 3 + 1] = t * 3 + 1
        flatIndices[t * 3 + 2] = t * 3 + 2
    }
    return { positions: flatPositions, normals, indices: flatIndices, material }
}

/** Z-up (x, y, z) 배열을 glTF Y-up (x, z, -y) 로 바꾼 새 배열 */
const toYUp = (src: Float32Array) => {
    const out = new Float32Array(src.length)
    for (let i = 0; i < src.length; i += 3) {
        out[i] = src[i]
        out[i + 1] = src[i + 2]
        out[i + 2] = -src[i + 1]
    }
    return out
}

/**
 * 조각들을 노드 하나·메쉬 하나의 GLB 파일 바이트로 만든다.
 *
 * @param name 노드·메쉬 이름
 * @param materials 재질 목록(단색, 양면). 조각의 material 이 이 배열의 번호다
 * @param primitives 조각들
 * @param extras asset.extras 에 넣을 메타데이터(원점·좌표계 등). 뷰어는 무시하고 파일에만 남는다
 */
export const encodeGlb = (
    name: string,
    materials: GlbMaterial[],
    primitives: GlbPrimitive[],
    extras: Record<string, unknown> = {},
): ArrayBuffer => {
    const bufferViews: object[] = []
    const accessors: object[] = []
    const parts: ArrayBufferView[] = []
    let binLength = 0

    /** 배열을 BIN 에 4바이트 정렬로 붙이고 bufferView 번호를 돌려준다 */
    const addView = (data: ArrayBufferView, target: number) => {
        parts.push(data)
        const index = bufferViews.length
        bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: data.byteLength, target })
        binLength = pad4(binLength + data.byteLength)
        return index
    }
    const addVec3 = (data: Float32Array, withMinMax: boolean) => {
        const count = data.length / 3
        const acc: Record<string, unknown> = { bufferView: addView(data, ARRAY_BUFFER), componentType: FLOAT, count, type: "VEC3" }
        if (withMinMax) {
            const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
            for (let i = 0; i < data.length; i += 3)
                for (let k = 0; k < 3; k++) {
                    if (data[i + k] < min[k]) min[k] = data[i + k]
                    if (data[i + k] > max[k]) max[k] = data[i + k]
                }
            acc.min = min
            acc.max = max
        }
        accessors.push(acc)
        return accessors.length - 1
    }
    const addIndices = (data: Uint32Array) => {
        accessors.push({ bufferView: addView(data, ELEMENT_ARRAY_BUFFER), componentType: UNSIGNED_INT, count: data.length, type: "SCALAR" })
        return accessors.length - 1
    }

    const materialsJson = materials.map(({ name, color }) => ({
        name,
        doubleSided: true,
        pbrMetallicRoughness: { baseColorFactor: [...color, 1], metallicFactor: 0, roughnessFactor: 1 },
    }))
    const mesh = {
        name,
        primitives: primitives.map((p) => {
            const attributes: Record<string, number> = { POSITION: addVec3(toYUp(p.positions), true) }
            if (p.normals) attributes.NORMAL = addVec3(toYUp(p.normals), false)
            return { attributes, indices: addIndices(p.indices), material: p.material, mode: 4 }
        }),
    }
    const json = {
        asset: { version: "2.0", generator: "asrbbt", extras },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ name, mesh: 0 }],
        meshes: [mesh],
        materials: materialsJson,
        accessors,
        bufferViews,
        buffers: [{ byteLength: binLength }],
    }
    const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
    const jsonLength = pad4(jsonBytes.length)
    const total = 12 + 8 + jsonLength + 8 + binLength
    const out = new ArrayBuffer(total)
    const view = new DataView(out)
    const bytes = new Uint8Array(out)
    view.setUint32(0, GLB_MAGIC, true)
    view.setUint32(4, 2, true)
    view.setUint32(8, total, true)
    view.setUint32(12, jsonLength, true)
    view.setUint32(16, CHUNK_JSON, true)
    bytes.set(jsonBytes, 20)
    bytes.fill(0x20, 20 + jsonBytes.length, 20 + jsonLength) // JSON 은 공백으로 채운다
    const binStart = 20 + jsonLength
    view.setUint32(binStart, binLength, true)
    view.setUint32(binStart + 4, CHUNK_BIN, true)
    let offset = binStart + 8
    for (const part of parts) {
        bytes.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), offset)
        offset = binStart + 8 + pad4(offset - (binStart + 8) + part.byteLength)
    }
    return out
}
