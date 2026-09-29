import { TinMesh } from "../terrainData"
import { OrbitCamera, orbitEye, orbitViewProj } from "./camera"
import { initWebGPU } from "./device"
import { createTerrainShader } from "./shaders"

const DEPTH_FORMAT: GPUTextureFormat = "depth24plus"
const NORMAL_SMOOTH_ITERATIONS = 2
const UNIFORM_SIZE = 96 // viewProj mat4x4f(0~64) + zRange vec2f(64~72) + eye vec3f(80~92, vec3f 는 16바이트 정렬), 전체 16바이트 정렬

/** 메쉬 정점 좌표의 범위. 원점을 뺀 로컬 좌표(m) 기준 */
export type MeshBounds = {
    min: [number, number, number]
    max: [number, number, number]
}

/**
 * 배경 pass 함수를 만든다. 프레임마다 가장 먼저 실행되어 색 버퍼와 깊이 버퍼를 비운다.
 *
 * @param bgcolor 배경색(0 ~ 1)
 * @param depthView 깊이 텍스처 view. 뒤이은 pass 들이 같은 view 를 load 해서 쓴다
 * @returns `(encoder, context) => void` pass 함수
 */
const renderBackgroundPassFactory =
    (bgcolor: { r: number; g: number; b: number }, depthView: GPUTextureView) =>
    (encoder: GPUCommandEncoder, context: GPUCanvasContext) => {
        const backgroundPass = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: context.getCurrentTexture().createView(),
                    loadOp: "clear",
                    clearValue: { ...bgcolor, a: 1 },
                    storeOp: "store",
                },
            ],
            depthStencilAttachment: {
                view: depthView,
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
 * 지형 pass 와 그 데이터를 바꾸는 updater 들을 만든다.
 *
 * 셰이더 모듈, 파이프라인(깊이 테스트 포함), uniform 버퍼, 바인드그룹은 여기서 한 번만 만든다.
 * 메쉬와 카메라는 반환하는 updater 로 버퍼만 바꾼다.
 *
 * @param device GPU device
 * @param format 캔버스 텍스처 포맷
 * @param depthView 배경 pass 와 공유하는 깊이 텍스처 view
 * @param aspect 화면 가로/세로 비율(카메라 투영용)
 * @returns terrainPass, meshUpdater, cameraUpdater
 */
const createTerrainDrawingPassAndUpdaters = (
    device: GPUDevice,
    format: GPUTextureFormat,
    depthView: GPUTextureView,
    aspect: number,
) => {
    const shaderModule = device.createShaderModule(createTerrainShader())

    const pipeline = device.createRenderPipeline({
        label: "terrain pipeline",
        layout: "auto",
        vertex: {
            module: shaderModule,
            entryPoint: "vertexMain",
            buffers: [
                {
                    arrayStride: 12,
                    attributes: [
                        { format: "float32x3", offset: 0, shaderLocation: 0 },
                    ],
                },
                {
                    arrayStride: 12,
                    attributes: [
                        { format: "float32x3", offset: 0, shaderLocation: 1 },
                    ],
                },
            ],
        },
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

    const uniformBuffer = device.createBuffer({
        label: "terrain uniforms",
        size: UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    const bindGroup = device.createBindGroup({
        label: "terrain bind group",
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
    })

    let vertexBuffer: GPUBuffer | null = null
    let normalBuffer: GPUBuffer | null = null
    let indexBuffer: GPUBuffer | null = null
    let indexCount = 0

    /**
     * 그릴 메쉬를 교체한다. 이전 정점·법선·인덱스 버퍼는 해제하고 새로 만들어 올린다.
     * 정점 법선은 computeVertexNormals 로 계산하고 smoothVertexNormals 로 부드럽게 한 뒤 올린다(메쉬마다 한 번).
     * 정점 범위를 계산해 표고 최소·최대를 uniform(offset 64)에 쓴다.
     *
     * @param mesh 서버에서 받은 TIN 메쉬(원점을 뺀 xyz, 삼각형 인덱스)
     * @returns 정점 범위. 카메라 초기 위치를 잡는 데 쓴다
     */
    const meshUpdater = (mesh: TinMesh): MeshBounds => {
        vertexBuffer?.destroy()
        normalBuffer?.destroy()
        indexBuffer?.destroy()

        vertexBuffer = device.createBuffer({
            label: "terrain vertices",
            size: mesh.positions.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        })
        device.queue.writeBuffer(vertexBuffer, 0, mesh.positions)

        const normals = smoothVertexNormals(
            computeVertexNormals(mesh.positions, mesh.indices),
            mesh.indices,
            NORMAL_SMOOTH_ITERATIONS,
        )
        normalBuffer = device.createBuffer({
            label: "terrain normals",
            size: normals.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        })
        device.queue.writeBuffer(normalBuffer, 0, normals)

        indexBuffer = device.createBuffer({
            label: "terrain indices",
            size: mesh.indices.byteLength,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        })
        device.queue.writeBuffer(indexBuffer, 0, mesh.indices)
        indexCount = mesh.indices.length

        const min: [number, number, number] = [Infinity, Infinity, Infinity]
        const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
        const p = mesh.positions
        for (let i = 0; i < p.length; i += 3) {
            for (let k = 0; k < 3; k++) {
                if (p[i + k] < min[k]) min[k] = p[i + k]
                if (p[i + k] > max[k]) max[k] = p[i + k]
            }
        }
        device.queue.writeBuffer(
            uniformBuffer,
            64,
            new Float32Array([min[2], max[2]]),
        )
        return { min, max }
    }

    /**
     * 카메라 상태로 viewProj 행렬(uniform offset 0)과 카메라 위치(offset 80, 정반사 계산용)를 쓴다.
     *
     * @param camera 궤도 카메라 상태
     */
    const cameraUpdater = (camera: OrbitCamera) => {
        device.queue.writeBuffer(uniformBuffer, 0, orbitViewProj(camera, aspect))
        device.queue.writeBuffer(uniformBuffer, 80, new Float32Array(orbitEye(camera)))
    }

    /**
     * 지형을 그리는 pass. 배경 pass 가 비운 색·깊이 버퍼를 load 해서 그 위에 그린다.
     * 아직 meshUpdater 로 메쉬가 들어오지 않았으면 아무것도 하지 않는다.
     *
     * @param encoder 이번 프레임의 command encoder
     * @param context 캔버스 context
     */
    const terrainPass = (encoder: GPUCommandEncoder, context: GPUCanvasContext) => {
        if (!vertexBuffer || !normalBuffer || !indexBuffer) return

        const pass = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: context.getCurrentTexture().createView(),
                    loadOp: "load",
                    storeOp: "store",
                },
            ],
            depthStencilAttachment: {
                view: depthView,
                depthLoadOp: "load",
                depthStoreOp: "store",
            },
        })
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, bindGroup)
        pass.setVertexBuffer(0, vertexBuffer)
        pass.setVertexBuffer(1, normalBuffer)
        pass.setIndexBuffer(indexBuffer, "uint32")
        pass.drawIndexed(indexCount)
        pass.end()
    }

    return { terrainPass, meshUpdater, cameraUpdater }
}

/**
 * 3D 지형 렌더러를 조립한다. (Doe 의 createAe12RenderFunctionAndUpdateFunctions 와 같은 구조)
 *
 * 1. initWebGPU 로 device·context 준비
 * 2. 캔버스 크기의 깊이 텍스처 생성
 * 3. 배경 pass, 지형 pass·updater 생성
 *
 * @param options.canvasId 대상 canvas 요소의 id
 * @param options.width 캔버스 실제 픽셀 너비(canvas width 속성과 같아야 한다)
 * @param options.height 캔버스 실제 픽셀 높이
 * @param options.backgroundColor 배경색(0 ~ 1)
 * @returns render(한 프레임 그리기), updaters(meshUpdater, cameraUpdater), destroy(device 해제)
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

    const depthView = device
        .createTexture({
            size: [width, height],
            format: DEPTH_FORMAT,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        })
        .createView()

    const backgroundPass = renderBackgroundPassFactory(backgroundColor, depthView)
    const { terrainPass, meshUpdater, cameraUpdater } =
        createTerrainDrawingPassAndUpdaters(device, format, depthView, width / height)

    /** 한 프레임을 그린다: 배경 pass → 지형 pass 순으로 기록해 제출한다 */
    const render = () => {
        const encoder = device.createCommandEncoder()
        backgroundPass(encoder, context)
        terrainPass(encoder, context)
        device.queue.submit([encoder.finish()])
    }

    const updaters = { meshUpdater, cameraUpdater }

    /** GPU device 와 그에 속한 버퍼·텍스처를 모두 해제한다. 컴포넌트 언마운트 때 호출 */
    const destroy = () => device.destroy()

    return { render, updaters, destroy }
}
