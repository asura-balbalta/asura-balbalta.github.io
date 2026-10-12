import { LayerId } from "../layers"
import { MeshChunk, TinMesh } from "../terrainData"
import { hexToRgb, STOP_COUNT, stopsToUniform, TerrainTheme } from "../terrainTheme"
import { Camera, cameraEye, cameraViewProj } from "./camera"
import { initWebGPU } from "./device"
import { createBuildingShader, createSmoothTerrainShader, createSteppedTerrainShader } from "./shaders"

const DEPTH_FORMAT: GPUTextureFormat = "depth24plus"

/** 깊이 텍스처 홀더. pass 들이 공유하며, 캔버스 크기가 바뀌면 resizeUpdater 가 안의 텍스처·view 를 바꿔 끼운다 */
type DepthHolder = { texture: GPUTexture; view: GPUTextureView; width: number; height: number }
const NORMAL_SMOOTH_ITERATIONS = 2
const STOPS_OFFSET = 96 // 표고 색표 array<vec4f, STOP_COUNT> 의 시작 (shaders.ts 의 Uniforms 와 같아야 한다)
const BUILDING_COLOR_OFFSET = STOPS_OFFSET + 16 * STOP_COUNT // 건물색 vec4f
const UNIFORM_SIZE = BUILDING_COLOR_OFFSET + 16 // viewProj mat4x4f(0~64) + zRange vec2f(64~72) + eye vec3f(80~92) + stops + buildingColor

/** 지형 표현 방식. tin: 정점 법선으로 부드럽게, stepped: 계단형(면 법선, 법선 버퍼 없음) */
export type TerrainMode = "tin" | "stepped"

/** 지형 밖의 레이어. 메쉬 하나를 통째로 받아 올리고(layerMeshUpdater) 전용 파이프라인으로 그린다 */
export type OverlayLayerId = Exclude<LayerId, "terrain">

/** 메쉬 정점 좌표의 범위. 원점을 뺀 로컬 좌표(m) 기준 */
export type MeshBounds = {
    min: [number, number, number]
    max: [number, number, number]
}

/**
 * 배경 pass 함수를 만든다. 프레임마다 가장 먼저 실행되어 색 버퍼와 깊이 버퍼를 비운다.
 *
 * @param bg 배경색 홀더(0 ~ 1). color 를 바꾸면 다음 프레임부터 반영된다(backgroundUpdater)
 * @param depth 깊이 텍스처 홀더. 뒤이은 pass 들이 같은 view 를 load 해서 쓴다. 캔버스 크기가 바뀌면 resizeUpdater 가 바꿔 끼운다
 * @returns `(encoder, context) => void` pass 함수
 */
const renderBackgroundPassFactory =
    (bg: { color: { r: number; g: number; b: number } }, depth: DepthHolder) =>
    (encoder: GPUCommandEncoder, context: GPUCanvasContext) => {
        const backgroundPass = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: context.getCurrentTexture().createView(),
                    loadOp: "clear",
                    clearValue: { ...bg.color, a: 1 },
                    storeOp: "store",
                },
            ],
            depthStencilAttachment: {
                view: depth.view,
                depthLoadOp: "clear",
                depthClearValue: 1,
                depthStoreOp: "store",
            },
        })
        backgroundPass.end()
    }

/**
 * 정점 법선을 계산한다. 정점에 닿은 삼각형들의 면 법선을 더한 뒤 정규화한다.
 * 면 법선을 정규화하지 않고 더하므로 넓은 삼각형일수록 영향이 크다(면적 가중).
 *
 * 삼각형은 위에서 볼 때 반시계(CCW)라 면 법선이 위(+z)를 향한다.
 * 어떤 삼각형에도 쓰이지 않는 정점은 (0, 0, 1)로 둔다.
 *
 * @param positions 정점 좌표 (x, y, z) 연속 배열
 * @param indices 삼각형 정점 인덱스 (3개씩)
 * @returns positions 와 같은 길이의 정점 법선 (nx, ny, nz) 연속 배열
 */
const computeVertexNormals = (positions: Float32Array, indices: Uint32Array) => {
    const normals = new Float32Array(positions.length)
    for (let t = 0; t < indices.length; t += 3) {
        const a = indices[t] * 3
        const b = indices[t + 1] * 3
        const c = indices[t + 2] * 3
        const e1x = positions[b] - positions[a]
        const e1y = positions[b + 1] - positions[a + 1]
        const e1z = positions[b + 2] - positions[a + 2]
        const e2x = positions[c] - positions[a]
        const e2y = positions[c + 1] - positions[a + 1]
        const e2z = positions[c + 2] - positions[a + 2]
        const nx = e1y * e2z - e1z * e2y
        const ny = e1z * e2x - e1x * e2z
        const nz = e1x * e2y - e1y * e2x
        for (const v of [a, b, c]) {
            normals[v] += nx
            normals[v + 1] += ny
            normals[v + 2] += nz
        }
    }
    return normalizeVectors(normals)
}

/**
 * (x, y, z) 연속 배열의 벡터들을 제자리에서 길이 1로 정규화한다. 길이가 0인 벡터는 (0, 0, 1)로 둔다.
 *
 * @param vectors 정규화할 벡터 배열(직접 수정됨)
 * @returns 같은 배열
 */
const normalizeVectors = (vectors: Float32Array) => {
    for (let i = 0; i < vectors.length; i += 3) {
        const len = Math.hypot(vectors[i], vectors[i + 1], vectors[i + 2])
        if (len === 0) {
            vectors[i] = 0
            vectors[i + 1] = 0
            vectors[i + 2] = 1
            continue
        }
        vectors[i] /= len
        vectors[i + 1] /= len
        vectors[i + 2] /= len
    }
    return vectors
}

/**
 * 정점 법선을 이웃 정점의 법선과 섞어 부드럽게 한다. 형상(정점 위치)은 바꾸지 않고 음영만 매끄러워진다.
 *
 * 한 번 반복할 때마다, 각 정점의 법선에 그 정점과 삼각형을 공유하는 이웃 정점들의 법선을 더한 뒤 정규화한다.
 * 등고선 기반 TIN 의 평평한 단과 가파른 턱 사이 음영 차이를 줄이는 용도.
 *
 * @param normals 정점 법선 (nx, ny, nz) 연속 배열
 * @param indices 삼각형 정점 인덱스 (3개씩)
 * @param iterations 반복 횟수. 클수록 넓은 범위가 섞인다
 * @returns 부드럽게 한 정점 법선(새 배열)
 */
const smoothVertexNormals = (
    normals: Float32Array,
    indices: Uint32Array,
    iterations: number,
) => {
    let current = normals
    for (let it = 0; it < iterations; it++) {
        const next = new Float32Array(current)
        for (let t = 0; t < indices.length; t += 3) {
            for (let k = 0; k < 3; k++) {
                const v = indices[t + k] * 3
                const o1 = indices[t + ((k + 1) % 3)] * 3
                const o2 = indices[t + ((k + 2) % 3)] * 3
                next[v] += current[o1] + current[o2]
                next[v + 1] += current[o1 + 1] + current[o2 + 1]
                next[v + 2] += current[o1 + 2] + current[o2 + 2]
            }
        }
        current = normalizeVectors(next)
    }
    return current
}

/**
 * 메쉬 정점 좌표의 범위를 구한다. 카메라 초기 위치와 표고 색 범위에 쓴다.
 *
 * @param mesh 원점 기준 좌표의 메쉬
 * @returns 각 축의 최소·최대
 */
export const meshBounds = (mesh: TinMesh): MeshBounds => {
    const min: [number, number, number] = [Infinity, Infinity, Infinity]
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
    const p = mesh.positions
    for (let i = 0; i < p.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            if (p[i + k] < min[k]) min[k] = p[i + k]
            if (p[i + k] > max[k]) max[k] = p[i + k]
        }
    }
    return { min, max }
}

/**
 * 메쉬를 "버퍼 하나가 maxBytes 를 넘지 않는" 조각들로 나눈다. 넓은 범위에서 정점·인덱스 버퍼가
 * WebGPU 기본 한도(maxBufferSize, 보통 256MB)를 넘어도 한도를 올리지 않고 그릴 수 있게 하기 위한 것.
 *
 * 삼각형을 순서대로 조각에 담다가, 조각의 정점 수나 인덱스 수가 한도에 닿으면 조각을 끊는다.
 * 조각마다 그 조각이 쓰는 정점만 모아 0부터 다시 번호를 매기므로(globalToLocal), 조각 사이에 정점이 중복될 수 있지만
 * 삼각형은 그대로라 그리는 결과는 같다. 조각은 generator 로 하나씩 만들어 메모리를 한 조각 분량만 더 쓴다.
 * 메쉬 전체가 한도 안이면 복사 없이 그대로 하나의 조각으로 돌려준다.
 *
 * @param positions 정점 좌표 (x, y, z) 연속 배열
 * @param indices 삼각형 인덱스 (3개씩)
 * @param normals 정점 법선(선택). 있으면 조각마다 같이 나눈다
 * @param maxBytes 버퍼 하나의 최대 바이트 수 (device.limits.maxBufferSize)
 */
function* splitMeshIntoChunks(
    positions: Float32Array,
    indices: Uint32Array,
    normals: Float32Array | undefined,
    maxBytes: number,
): Generator<MeshChunk> {
    if (positions.byteLength <= maxBytes && indices.byteLength <= maxBytes) {
        yield { positions, normals, indices }
        return
    }

    const vertexCount = positions.length / 3
    const maxVerts = Math.floor(maxBytes / 12)
    const maxIndices = Math.floor(maxBytes / 4) - (Math.floor(maxBytes / 4) % 3)
    const globalToLocal = new Int32Array(vertexCount).fill(-1)
    const localToGlobal = new Uint32Array(Math.min(maxVerts, vertexCount))

    let start = 0
    while (start < indices.length) {
        const capacity = Math.min(maxIndices, indices.length - start)
        const chunkIndices = new Uint32Array(capacity)
        let localCount = 0
        let n = 0
        // 삼각형 하나가 새 정점을 최대 3개 만들므로, 그만큼 여유가 있을 때만 담는다
        while (n + 3 <= capacity && localCount + 3 <= maxVerts) {
            for (let k = 0; k < 3; k++) {
                const g = indices[start + n + k]
                let l = globalToLocal[g]
                if (l < 0) {
                    l = localCount++
                    globalToLocal[g] = l
                    localToGlobal[l] = g
                }
                chunkIndices[n + k] = l
            }
            n += 3
        }
        if (n === 0) throw new Error("버퍼 한도가 너무 작아 삼각형 하나도 담을 수 없음")

        const chunkPositions = new Float32Array(localCount * 3)
        const chunkNormals = normals ? new Float32Array(localCount * 3) : undefined
        for (let l = 0; l < localCount; l++) {
            const g = localToGlobal[l]
            chunkPositions.set(positions.subarray(g * 3, g * 3 + 3), l * 3)
            chunkNormals?.set(normals!.subarray(g * 3, g * 3 + 3), l * 3)
            globalToLocal[g] = -1
        }
        yield {
            positions: chunkPositions,
            normals: chunkNormals,
            indices: n === capacity ? chunkIndices : chunkIndices.subarray(0, n),
        }
        start += n
    }
}

/** 정점 버퍼 하나에 float32x3 하나가 들어가는 레이아웃 */
const float32x3Layout = (shaderLocation: number): GPUVertexBufferLayout => ({
    arrayStride: 12,
    attributes: [{ format: "float32x3", offset: 0, shaderLocation }],
})

/**
 * 지형 pass 와 그 데이터를 바꾸는 updater 들을 만든다.
 *
 * 셰이더 모듈, 파이프라인(깊이 테스트 포함), uniform 버퍼, 바인드그룹은 여기서 한 번만 만든다.
 * 파이프라인은 셋이다: 지형 tin(좌표 + 정점 법선, 부드러운 음영), 지형 stepped(좌표만, 셰이더에서 면 법선),
 * buildings(좌표만, 면 법선, 건물색). uniform 버퍼는 모두 같이 쓰고, 바인드그룹만 파이프라인마다 만든다(layout "auto" 라서).
 * GPU 조각은 레이어별로 들고 있고(layerChunks), pass 는 보이는 레이어만 그린다(layerVisibilityUpdater).
 * 메쉬와 카메라는 반환하는 updater 로 버퍼만 바꾼다.
 *
 * @param device GPU device
 * @param format 캔버스 텍스처 포맷
 * @param depth 배경 pass 와 공유하는 깊이 텍스처 홀더
 * @param initialAspect 처음 화면 가로/세로 비율(카메라 투영용). 캔버스 크기가 바뀌면 aspectUpdater 로 갱신한다
 * @returns scenePass 와 updater 들
 */
const createTerrainDrawingPassAndUpdaters = (
    device: GPUDevice,
    format: GPUTextureFormat,
    depth: DepthHolder,
    initialAspect: number,
) => {
    let aspect = initialAspect
    /** 마지막으로 올린 카메라. 비율이 바뀌면 같은 카메라로 viewProj 를 다시 쓴다 */
    let lastCamera: Camera | null = null
    const uniformBuffer = device.createBuffer({
        label: "terrain uniforms",
        size: UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    /** 파이프라인과 그 바인드그룹을 만든다 */
    const createPipelineSet = (
        name: string,
        shader: GPUShaderModuleDescriptor,
        buffers: GPUVertexBufferLayout[],
    ) => {
        const shaderModule = device.createShaderModule(shader)
        const pipeline = device.createRenderPipeline({
            label: `pipeline (${name})`,
            layout: "auto",
            vertex: { module: shaderModule, entryPoint: "vertexMain", buffers },
            fragment: {
                module: shaderModule,
                entryPoint: "fragmentMain",
                targets: [{ format }],
            },
            primitive: { topology: "triangle-list", cullMode: "none" },
            depthStencil: {
                format: DEPTH_FORMAT,
                depthWriteEnabled: true,
                depthCompare: "less",
            },
        })
        const bindGroup = device.createBindGroup({
            label: `bind group (${name})`,
            layout: pipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
        })
        return { pipeline, bindGroup }
    }

    const pipelines: Record<TerrainMode | OverlayLayerId, ReturnType<typeof createPipelineSet>> = {
        tin: createPipelineSet("terrain tin", createSmoothTerrainShader(), [
            float32x3Layout(0),
            float32x3Layout(1),
        ]),
        stepped: createPipelineSet("terrain stepped", createSteppedTerrainShader(), [
            float32x3Layout(0),
        ]),
        buildings: createPipelineSet("buildings", createBuildingShader(), [float32x3Layout(0)]),
    }

    let mode: TerrainMode = "tin"
    type GpuChunk = {
        vertexBuffer: GPUBuffer
        normalBuffer: GPUBuffer | null
        indexBuffer: GPUBuffer
        indexCount: number
    }
    /** 레이어별로 GPU 에 올라간 메쉬 조각들. 한 프레임에 보이는 레이어의 조각 수만큼 drawIndexed 한다 */
    const layerChunks: Record<LayerId, GpuChunk[]> = { terrain: [], buildings: [] }
    const layerVisible: Record<LayerId, boolean> = { terrain: true, buildings: true }

    const destroyChunks = (chunks: GpuChunk[]) => {
        for (const c of chunks) {
            c.vertexBuffer.destroy()
            c.normalBuffer?.destroy()
            c.indexBuffer.destroy()
        }
    }

    /** 버퍼를 만들고 데이터를 써서 돌려준다 */
    const uploadBuffer = (label: string, usage: GPUBufferUsageFlags, data: Float32Array | Uint32Array) => {
        const buffer = device.createBuffer({ label, size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST })
        device.queue.writeBuffer(buffer, 0, data)
        return buffer
    }

    /** 조각을 GPU 버퍼로 올린 GpuChunk 를 만든다 */
    const uploadChunk = (label: string, chunk: MeshChunk): GpuChunk => ({
        vertexBuffer: uploadBuffer(`${label} vertices`, GPUBufferUsage.VERTEX, chunk.positions),
        normalBuffer: chunk.normals ? uploadBuffer(`${label} normals`, GPUBufferUsage.VERTEX, chunk.normals) : null,
        indexBuffer: uploadBuffer(`${label} indices`, GPUBufferUsage.INDEX, chunk.indices),
        indexCount: chunk.indices.length,
    })

    /**
     * 조각 단위 메쉬 교체를 시작한다. 조각을 하나씩 받아 올리는 함수들을 돌려주며, 조각이 나중에(Worker 메시지 등으로)
     * 하나씩 도착해도 된다. 올라간 조각은 다음 프레임부터 바로 그려지므로 조각이 쌓이는 과정이 화면에 보인다.
     *
     * 이전 메쉬는 첫 조각이 올라갈 때(조각이 하나도 없으면 finish 때) 교체한다. 그때까지는 이전 지형이 그대로 보인다.
     * 교체할 때 이전 조각들의 버퍼를 해제하고, 모드와 표고 범위(uniform offset 64)를 기록한다.
     *
     * @param options.mode 지형 표현 방식. tin 이면 조각에 normals 가 있어야 한다
     * @param options.bounds 메쉬 전체의 정점 범위(표고 색 범위용)
     * @returns maxBytes(조각의 버퍼 하나가 넘으면 안 되는 바이트 수), addChunk(조각 하나를 GPU 에 올림), finish(끝났음을 기록)
     */
    const meshStreamStarter = ({
        mode: newMode,
        bounds,
    }: {
        mode: TerrainMode
        bounds: MeshBounds
    }) => {
        const maxBytes = device.limits.maxBufferSize
        let started = false
        let vertices = 0
        let indices = 0
        /** 실제로 올라간 조각 중 가장 큰 버퍼(바이트). 받는 쪽이 maxBytes 보다 작은 상한으로 끊었을 수 있어 로그에 같이 찍는다 */
        let largestChunkBytes = 0

        /** 이전 메쉬를 버리고 새 메쉬의 모드·표고 범위로 바꾼다. 첫 조각(또는 finish)에서 한 번만 실행된다 */
        const start = () => {
            started = true
            mode = newMode
            destroyChunks(layerChunks.terrain)
            layerChunks.terrain = []
            device.queue.writeBuffer(
                uniformBuffer,
                64,
                new Float32Array([bounds.min[2], bounds.max[2]]),
            )
        }

        const addChunk = (chunk: MeshChunk) => {
            if (!started) start()
            if (mode === "tin" && !chunk.normals) throw new Error("tin 모드 조각에는 normals 가 필요함")
            layerChunks.terrain.push(uploadChunk("terrain", chunk))
            vertices += chunk.positions.length / 3
            indices += chunk.indices.length
            largestChunkBytes = Math.max(largestChunkBytes, chunk.positions.byteLength, chunk.indices.byteLength)
        }
        const finish = () => {
            if (!started) start()
            console.log(
                `GPU 버퍼(지형): ${layerChunks.terrain.length}조각 (가장 큰 조각 ${Math.round(largestChunkBytes / 1048576)}MB, device 한도 ${Math.round(maxBytes / 1048576)}MB, 정점 ${vertices}, 인덱스 ${indices})`,
            )
        }
        return { maxBytes, addChunk, finish }
    }

    /**
     * 지형 밖 레이어(건물 등)의 메쉬를 통째로 교체한다. 이전 조각을 해제하고, 버퍼 한도 안의 조각으로 나눠 올린다.
     * 법선 버퍼는 쓰지 않는다(레이어 셰이더가 면 법선을 화면 미분으로 구함).
     *
     * @param id 레이어
     * @param mesh 그릴 메쉬(지형과 같은 원점의 xyz). null 이면 비운다
     */
    const layerMeshUpdater = (id: OverlayLayerId, mesh: TinMesh | null) => {
        destroyChunks(layerChunks[id])
        layerChunks[id] = []
        if (!mesh) return
        for (const chunk of splitMeshIntoChunks(mesh.positions, mesh.indices, undefined, device.limits.maxBufferSize)) {
            layerChunks[id].push(uploadChunk(id, chunk))
        }
        console.log(`GPU 버퍼(${id}): ${layerChunks[id].length}조각, 정점 ${mesh.positions.length / 3}, 인덱스 ${mesh.indices.length}`)
    }

    /**
     * 레이어를 그릴지 정한다(다음 프레임부터). 메쉬·버퍼는 그대로 두므로 바로 켜고 끌 수 있다.
     *
     * @param id 레이어
     * @param visible true 면 그린다
     */
    const layerVisibilityUpdater = (id: LayerId, visible: boolean) => {
        layerVisible[id] = visible
    }

    /**
     * 조각을 동기로 내보내는 함수를 받아 메쉬를 교체한다(meshStreamStarter 를 한 번에 끝까지 돌리는 형태).
     * 조각은 device.limits.maxBufferSize 안이어야 하므로 그 값을 chunks 함수에 넘겨 준다.
     * 받는 즉시 올리고 버리므로 브라우저 메모리는 조각 하나 분량만 쓴다.
     *
     * @param options.mode 지형 표현 방식. tin 이면 조각에 normals 가 있어야 한다
     * @param options.bounds 메쉬 전체의 정점 범위(표고 색 범위용)
     * @param options.chunks 버퍼 최대 바이트 수를 받아 조각을 차례로 내보내는 함수
     */
    const streamedMeshUpdater = ({
        mode,
        bounds,
        chunks,
    }: {
        mode: TerrainMode
        bounds: MeshBounds
        chunks: (maxBytes: number) => Iterable<MeshChunk>
    }) => {
        const stream = meshStreamStarter({ mode, bounds })
        for (const chunk of chunks(stream.maxBytes)) stream.addChunk(chunk)
        stream.finish()
    }

    /**
     * 메쉬 하나를 통째로 받아 교체한다. tin 모드에서는 정점 법선을 computeVertexNormals 로 계산해
     * smoothVertexNormals 로 부드럽게 한 뒤(전체 인접 관계가 필요해서 통째로 한다), splitMeshIntoChunks 로
     * 버퍼 한도 안의 조각들로 나눠 streamedMeshUpdater 에 넘긴다.
     *
     * @param mesh 그릴 메쉬(원점을 뺀 xyz, 삼각형 인덱스)
     * @param options.mode 지형 표현 방식. 기본 "tin"
     * @returns 정점 범위. 카메라 초기 위치를 잡는 데 쓴다
     */
    const meshUpdater = (
        mesh: TinMesh,
        options: { mode?: TerrainMode } = {},
    ): MeshBounds => {
        const newMode = options.mode ?? "tin"
        const normals =
            newMode === "tin"
                ? smoothVertexNormals(
                      computeVertexNormals(mesh.positions, mesh.indices),
                      mesh.indices,
                      NORMAL_SMOOTH_ITERATIONS,
                  )
                : undefined
        const bounds = meshBounds(mesh)
        streamedMeshUpdater({
            mode: newMode,
            bounds,
            chunks: (maxBytes) => splitMeshIntoChunks(mesh.positions, mesh.indices, normals, maxBytes),
        })
        return bounds
    }

    /**
     * 카메라 상태로 viewProj 행렬(uniform offset 0)과 카메라 위치(offset 80, 정반사 계산용)를 쓴다.
     *
     * @param camera 궤도 카메라 또는 1인칭 카메라(걸어 보기)
     */
    const cameraUpdater = (camera: Camera) => {
        lastCamera = camera
        device.queue.writeBuffer(uniformBuffer, 0, cameraViewProj(camera, aspect))
        device.queue.writeBuffer(uniformBuffer, 80, new Float32Array(cameraEye(camera)))
    }

    /**
     * 화면 가로/세로 비율을 바꾼다(캔버스 크기 변경). 카메라가 이미 있으면 같은 카메라로 투영을 다시 쓴다.
     *
     * @param next 새 비율(너비 / 높이)
     */
    const aspectUpdater = (next: number) => {
        if (next === aspect) return
        aspect = next
        if (lastCamera) cameraUpdater(lastCamera)
    }

    /**
     * 표고 색표(uniform offset STOPS_OFFSET)와 건물색(BUILDING_COLOR_OFFSET)을 쓴다. 테마 전환 때 부른다.
     * 셰이더·파이프라인은 그대로다.
     *
     * @param theme 색표 단계 STOP_COUNT 개(높이 오름차순)와 건물색을 가진 테마
     */
    const paletteUpdater = (theme: Pick<TerrainTheme, "stops" | "buildingColor">) => {
        device.queue.writeBuffer(uniformBuffer, STOPS_OFFSET, stopsToUniform(theme.stops))
        const { r, g, b } = hexToRgb(theme.buildingColor)
        device.queue.writeBuffer(uniformBuffer, BUILDING_COLOR_OFFSET, new Float32Array([r, g, b, 1]))
    }

    /**
     * 장면을 그리는 pass. 배경 pass 가 비운 색·깊이 버퍼를 load 해서 그 위에 그린다.
     * 보이는 레이어마다 파이프라인을 바꾸고(지형은 meshUpdater 가 정한 모드, 그 밖은 레이어 전용), 조각마다 버퍼를
     * 바꿔 가며 drawIndexed 한다(tin 모드에서만 법선 버퍼 바인딩). 그릴 조각이 없으면 아무것도 하지 않는다.
     *
     * @param encoder 이번 프레임의 command encoder
     * @param context 캔버스 context
     */
    const scenePass = (encoder: GPUCommandEncoder, context: GPUCanvasContext) => {
        const draws: { chunks: GpuChunk[]; set: ReturnType<typeof createPipelineSet> }[] = []
        if (layerVisible.terrain && layerChunks.terrain.length > 0) {
            draws.push({ chunks: layerChunks.terrain, set: pipelines[mode] })
        }
        if (layerVisible.buildings && layerChunks.buildings.length > 0) {
            draws.push({ chunks: layerChunks.buildings, set: pipelines.buildings })
        }
        if (draws.length === 0) return

        const pass = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: context.getCurrentTexture().createView(),
                    loadOp: "load",
                    storeOp: "store",
                },
            ],
            depthStencilAttachment: {
                view: depth.view,
                depthLoadOp: "load",
                depthStoreOp: "store",
            },
        })
        for (const { chunks, set } of draws) {
            pass.setPipeline(set.pipeline)
            pass.setBindGroup(0, set.bindGroup)
            for (const c of chunks) {
                pass.setVertexBuffer(0, c.vertexBuffer)
                if (c.normalBuffer) pass.setVertexBuffer(1, c.normalBuffer)
                pass.setIndexBuffer(c.indexBuffer, "uint32")
                pass.drawIndexed(c.indexCount)
            }
        }
        pass.end()
    }

    return {
        scenePass,
        meshUpdater,
        meshStreamStarter,
        streamedMeshUpdater,
        layerMeshUpdater,
        layerVisibilityUpdater,
        cameraUpdater,
        aspectUpdater,
        paletteUpdater,
    }
}

/**
 * 3D 지형 렌더러를 조립한다. (Doe 의 createAe12RenderFunctionAndUpdateFunctions 와 같은 구조)
 *
 * 1. initWebGPU 로 device·context 준비
 * 2. 캔버스 크기의 깊이 텍스처 생성
 * 3. 배경 pass, 장면 pass·updater 생성
 *
 * 캔버스 크기가 바뀌면 resizeUpdater 로 알린다. 색 텍스처는 WebGPU 가 canvas 속성 크기를 따라 다시 잡지만, 깊이 텍스처와
 * 투영 비율은 여기서 직접 다시 만들어야 한다.
 *
 * @param options.canvasId 대상 canvas 요소의 id
 * @param options.width 캔버스 실제 픽셀 너비(canvas width 속성과 같아야 한다)
 * @param options.height 캔버스 실제 픽셀 높이
 * @param options.backgroundColor 처음 배경색(0 ~ 1). backgroundUpdater 로 바꿀 수 있다
 * @returns render(한 프레임 그리기), updaters(meshUpdater, meshStreamStarter, streamedMeshUpdater, layerMeshUpdater,
 *   layerVisibilityUpdater, cameraUpdater, paletteUpdater, backgroundUpdater, resizeUpdater), destroy(device 해제)
 */
export const createTerrainRenderFunctionAndUpdateFunctions = async ({
    canvasId,
    width,
    height,
    backgroundColor,
}: {
    canvasId: string
    width: number
    height: number
    backgroundColor: { r: number; g: number; b: number }
}) => {
    const { context, device, format } = await initWebGPU(canvasId)

    /** 캔버스 픽셀 크기의 깊이 텍스처를 만든다 */
    const createDepth = (w: number, h: number): DepthHolder => {
        const texture = device.createTexture({
            size: [w, h],
            format: DEPTH_FORMAT,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        })
        return { texture, view: texture.createView(), width: w, height: h }
    }
    const first = createDepth(width, height)
    // pass 들은 이 홀더를 붙들고 그릴 때마다 view 를 읽는다. 크기가 바뀌면 안의 텍스처만 바꿔 끼운다
    const depth: DepthHolder = { ...first }

    const background = { color: backgroundColor }
    const backgroundPass = renderBackgroundPassFactory(background, depth)
    const { scenePass, aspectUpdater, ...sceneUpdaters } = createTerrainDrawingPassAndUpdaters(
        device,
        format,
        depth,
        width / height,
    )
    /** 배경색을 바꾼다(다음 프레임부터). 테마 전환용 */
    const backgroundUpdater = (color: { r: number; g: number; b: number }) => {
        background.color = color
    }

    /**
     * 캔버스 픽셀 크기가 바뀌었을 때. 깊이 텍스처를 새 크기로 다시 만들고(이전 것은 해제) 투영 비율을 갱신한다.
     * canvas 의 width·height 속성을 먼저 바꾼 뒤 불러야 색 텍스처와 깊이 텍스처 크기가 맞는다. 같은 크기면 아무것도 안 한다
     *
     * @param w 캔버스 실제 픽셀 너비
     * @param h 캔버스 실제 픽셀 높이
     */
    const resizeUpdater = (w: number, h: number) => {
        if (w === depth.width && h === depth.height) return
        if (w <= 0 || h <= 0) return
        const next = createDepth(w, h)
        depth.texture.destroy()
        Object.assign(depth, next)
        aspectUpdater(w / h)
    }

    /** 한 프레임을 그린다: 배경 pass → 장면 pass 순으로 기록해 제출한다 */
    const render = () => {
        const encoder = device.createCommandEncoder()
        backgroundPass(encoder, context)
        scenePass(encoder, context)
        device.queue.submit([encoder.finish()])
    }

    const updaters = { ...sceneUpdaters, backgroundUpdater, resizeUpdater }

    /** GPU device 와 그에 속한 버퍼·텍스처를 모두 해제한다. 컴포넌트 언마운트 때 호출 */
    const destroy = () => device.destroy()

    return { render, updaters, destroy }
}
