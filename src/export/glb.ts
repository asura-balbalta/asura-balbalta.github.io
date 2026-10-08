/**
 * GLB(바이너리 glTF 2.0) 인코더. 외부 라이브러리 없이 JSON 머리말과 BIN 버퍼를 규격대로 붙인다.
 *
 * 입력 좌표는 TinMesh 와 같은 Z-up 미터(x 동, y 북, z 높이)이고, glTF 는 Y-up 이므로 (x, z, -y) 로 바꿔 넣는다.
 * 노드 하나가 레이어 하나이며, 노드의 메쉬는 조각(primitive) 여러 개를 가질 수 있다(계단형 변환 조각 등).
 * 법선이 없는 조각은 뷰어가 규격대로 면 법선을 계산한다(평면 음영).
 */

/** 한 조각: Z-up 좌표. normals 가 있으면 정점 법선(부드러운 음영), 없으면 평면 음영 */
export type GlbPrimitive = { positions: Float32Array; indices: Uint32Array; normals?: Float32Array }

/** 노드(레이어) 하나: 이름, 색(0 ~ 1), 조각들 */
export type GlbNode = { name: string; color: [number, number, number]; primitives: GlbPrimitive[] }

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
 * 노드들을 GLB 파일 바이트로 만든다.
 *
 * @param nodes 레이어별 노드. 재질은 노드마다 하나(단색, 양면)
 * @param extras asset.extras 에 넣을 메타데이터(원점·좌표계 등). 뷰어는 무시하고 파일에만 남는다
 */
export const encodeGlb = (nodes: GlbNode[], extras: Record<string, unknown> = {}): ArrayBuffer => {
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

    const materials = nodes.map(({ name, color }) => ({
        name,
        doubleSided: true,
        pbrMetallicRoughness: { baseColorFactor: [...color, 1], metallicFactor: 0, roughnessFactor: 1 },
    }))
    const meshes = nodes.map(({ name, primitives }, m) => ({
        name,
        primitives: primitives.map((p) => {
            const attributes: Record<string, number> = { POSITION: addVec3(toYUp(p.positions), true) }
            if (p.normals) attributes.NORMAL = addVec3(toYUp(p.normals), false)
            return { attributes, indices: addIndices(p.indices), material: m, mode: 4 }
        }),
    }))
    const json = {
        asset: { version: "2.0", generator: "asrbbt", extras },
        scene: 0,
        scenes: [{ nodes: nodes.map((_, i) => i) }],
        nodes: nodes.map(({ name }, i) => ({ name, mesh: i })),
        meshes,
        materials,
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
