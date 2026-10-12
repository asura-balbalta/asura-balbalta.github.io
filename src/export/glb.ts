/**
 * GLB(바이너리 glTF 2.0) 인코더. 외부 라이브러리 없이 JSON 머리말과 BIN 버퍼를 규격대로 붙인다.
 *
 * 입력 좌표는 TinMesh 와 같은 Z-up 미터(x 동, y 북, z 높이)이고, glTF 는 Y-up 이므로 (x, z, -y) 로 바꿔 넣는다.
 * 파일은 노드 트리(GlbNode)다. 노드마다 조각(primitive) 여러 개를 가진 메쉬 하나를 둘 수 있고, extras 는 노드에 붙는다.
 * 레이어는 조각의 재질로 구분한다. 호출자(glb.worker)는 지형을 노드 하나로, 건물은 건물마다 노드(이름 = 번호, extras = 속성)로
 * 두어 Blender 에서 건물 오브젝트의 custom property 로 속성이 보이게 한다. (한때 전체를 노드 하나로 합쳤던 것은 지형과
 * 건물이 별개 오브젝트로 갈라지는 게 싫어서였는데, 건물별 속성을 넣으려면 건물마다 노드여야 해서 되돌렸다.)
 * 각진 물체(건물·계단형)는 toFlatPrimitive 로 면 법선을 붙이고 (좌표, 법선)이 같은 꼭짓점만 공유한다. 법선 없이 두면 규격상
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

/** 꼭짓점 공유 판정에서 법선을 이 단위로 반올림한다. 같은 벽의 삼각형 둘은 변 조합이 달라 법선이 마지막 비트만 다를 수 있다 */
const NORMAL_KEY_SCALE = 1e5

/**
 * 인덱스 메쉬를 평면 음영 조각으로 만든다. 삼각형마다 면 법선을 구해 꼭짓점에 붙이되, (좌표, 법선)이 같은 꼭짓점은
 * 한 번만 적고 번호를 재사용한다. 같은 판 위의 삼각형들은 법선이 같아 꼭짓점을 공유하고, 판과 벽처럼 법선이 다른 자리는
 * 따로 두므로 뷰어의 셰이딩 설정과 무관하게 모서리가 각지게 보인다. 넓이 0 삼각형은 법선 (0, 0, 0).
 * (처음에는 삼각형마다 꼭짓점 3개를 새로 적어 정점이 삼각형 수의 3배였다. 1km² 계단형 실측으로 공유하면 정점이 절반,
 * 파일이 35MB → 20MB 가 된다.)
 */
export const toFlatPrimitive = (positions: Float32Array, indices: Uint32Array, material: number): GlbPrimitive => {
    const count = Math.floor(indices.length / 3)
    const outPositions = new Float32Array(count * 9)
    const outNormals = new Float32Array(count * 9)
    const outIndices = new Uint32Array(count * 3)
    const slot = new Map<string, number>()
    let used = 0
    for (let t = 0; t < count; t++) {
        const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3
        const e1x = positions[b] - positions[a], e1y = positions[b + 1] - positions[a + 1], e1z = positions[b + 2] - positions[a + 2]
        const e2x = positions[c] - positions[a], e2y = positions[c + 1] - positions[a + 1], e2z = positions[c + 2] - positions[a + 2]
        let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x
        const len = Math.hypot(nx, ny, nz)
        if (len > 0) {
            nx /= len
            ny /= len
            nz /= len
        }
        const normalKey = `${Math.round(nx * NORMAL_KEY_SCALE)},${Math.round(ny * NORMAL_KEY_SCALE)},${Math.round(nz * NORMAL_KEY_SCALE)}`
        for (let k = 0; k < 3; k++) {
            const v = k === 0 ? a : k === 1 ? b : c
            const key = `${positions[v]},${positions[v + 1]},${positions[v + 2]}|${normalKey}`
            let index = slot.get(key)
            if (index === undefined) {
                index = used++
                slot.set(key, index)
                outPositions[index * 3] = positions[v]
                outPositions[index * 3 + 1] = positions[v + 1]
                outPositions[index * 3 + 2] = positions[v + 2]
                outNormals[index * 3] = nx
                outNormals[index * 3 + 1] = ny
                outNormals[index * 3 + 2] = nz
            }
            outIndices[t * 3 + k] = index
        }
    }
    return { positions: outPositions.slice(0, used * 3), normals: outNormals.slice(0, used * 3), indices: outIndices, material }
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
 * 노드 하나. 조각이 있으면 같은 이름의 메쉬 하나를 갖고, extras 는 노드의 extras 로 들어간다
 * (Blender 는 오브젝트 custom property, three.js 는 userData 로 들여온다). children 으로 트리를 만든다
 */
export type GlbNode = {
    name: string
    primitives?: GlbPrimitive[]
    extras?: Record<string, unknown>
    children?: GlbNode[]
}

/**
 * 노드 트리를 GLB 파일 바이트로 만든다.
 *
 * 모든 조각의 좌표·법선·인덱스는 종류별로 bufferView 하나씩(POSITION, NORMAL, INDEX)에 이어 붙이고 접근자가 오프셋으로
 * 가리킨다. 조각마다 bufferView 를 두면 건물 수만 동일 때 JSON 이 수 MB 더 커지고 뷰어도 느려진다.
 *
 * @param root 루트 노드(장면에 이것 하나를 둔다)
 * @param materials 재질 목록(단색, 양면). 조각의 material 이 이 배열의 번호다
 * @param extras asset.extras 에 넣을 메타데이터(원점·좌표계 등). 뷰어는 무시하고 파일에만 남는다
 */
export const encodeGlb = (root: GlbNode, materials: GlbMaterial[], extras: Record<string, unknown> = {}): ArrayBuffer => {
    // 1) 조각을 트리 순서로 모아 종류별 총 길이를 센다
    const prims: GlbPrimitive[] = []
    const walk = (node: GlbNode) => {
        for (const p of node.primitives ?? []) prims.push(p)
        for (const c of node.children ?? []) walk(c)
    }
    walk(root)
    let posLen = 0, nrmLen = 0, idxLen = 0
    for (const p of prims) {
        posLen += p.positions.length
        if (p.normals) nrmLen += p.normals.length
        idxLen += p.indices.length
    }
    const positions = new Float32Array(posLen)
    const normals = new Float32Array(nrmLen)
    const indices = new Uint32Array(idxLen)

    // 2) 이어 붙이며 접근자를 만든다. bufferView 번호: 0 POSITION, 1 NORMAL(없으면 생략), 2 INDEX
    const hasNormals = nrmLen > 0
    const INDEX_VIEW = hasNormals ? 2 : 1
    const accessors: object[] = []
    const primJson = new Map<GlbPrimitive, object>()
    let posAt = 0, nrmAt = 0, idxAt = 0
    for (const p of prims) {
        const pos = toYUp(p.positions)
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
        for (let i = 0; i < pos.length; i += 3)
            for (let k = 0; k < 3; k++) {
                if (pos[i + k] < min[k]) min[k] = pos[i + k]
                if (pos[i + k] > max[k]) max[k] = pos[i + k]
            }
        positions.set(pos, posAt)
        const attributes: Record<string, number> = {}
        accessors.push({ bufferView: 0, byteOffset: posAt * 4, componentType: FLOAT, count: pos.length / 3, type: "VEC3", min, max })
        attributes.POSITION = accessors.length - 1
        posAt += pos.length
        if (p.normals) {
            normals.set(toYUp(p.normals), nrmAt)
            accessors.push({ bufferView: 1, byteOffset: nrmAt * 4, componentType: FLOAT, count: p.normals.length / 3, type: "VEC3" })
            attributes.NORMAL = accessors.length - 1
            nrmAt += p.normals.length
        }
        indices.set(p.indices, idxAt)
        accessors.push({ bufferView: INDEX_VIEW, byteOffset: idxAt * 4, componentType: UNSIGNED_INT, count: p.indices.length, type: "SCALAR" })
        primJson.set(p, { attributes, indices: accessors.length - 1, material: p.material, mode: 4 })
        idxAt += p.indices.length
    }
    const parts: ArrayBufferView[] = []
    const bufferViews: object[] = []
    let binLength = 0
    const addView = (data: ArrayBufferView, target: number) => {
        parts.push(data)
        bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: data.byteLength, target })
        binLength = pad4(binLength + data.byteLength)
    }
    addView(positions, ARRAY_BUFFER)
    if (hasNormals) addView(normals, ARRAY_BUFFER)
    addView(indices, ELEMENT_ARRAY_BUFFER)

    // 3) 노드·메쉬
    const materialsJson = materials.map(({ name, color }) => ({
        name,
        doubleSided: true,
        pbrMetallicRoughness: { baseColorFactor: [...color, 1], metallicFactor: 0, roughnessFactor: 1 },
    }))
    const nodes: object[] = []
    const meshes: object[] = []
    const addNode = (node: GlbNode): number => {
        const index = nodes.length
        const json: Record<string, unknown> = { name: node.name }
        nodes.push(json)
        if (node.primitives && node.primitives.length > 0) {
            meshes.push({ name: node.name, primitives: node.primitives.map((p) => primJson.get(p)) })
            json.mesh = meshes.length - 1
        }
        if (node.extras) json.extras = node.extras
        if (node.children && node.children.length > 0) json.children = node.children.map(addNode)
        return index
    }
    addNode(root)
    const json = {
        asset: { version: "2.0", generator: "asrbbt", extras },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes,
        meshes,
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
