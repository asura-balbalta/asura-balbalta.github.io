/// <reference types="@webgpu/types" />

import { TinMesh } from "../terrainData"
import { OrbitCamera, orbitViewProj } from "./camera"
import { initWebGPU } from "./device"
import { createTerrainShader } from "./shaders"

const DEPTH_FORMAT: GPUTextureFormat = "depth24plus"
const UNIFORM_SIZE = 80 // mat4x4f(64) + vec2f(8), 16바이트 정렬

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
    let indexBuffer: GPUBuffer | null = null
    let indexCount = 0

    /**
     * 그릴 메쉬를 교체한다. 이전 정점·인덱스 버퍼는 해제하고 새로 만들어 올린다.
     * 정점 범위를 계산해 표고 최소·최대를 uniform(offset 64)에 쓴다.
     *
     * @param mesh 서버에서 받은 TIN 메쉬(원점을 뺀 xyz, 삼각형 인덱스)
     * @returns 정점 범위. 카메라 초기 위치를 잡는 데 쓴다
     */
    const meshUpdater = (mesh: TinMesh): MeshBounds => {
        vertexBuffer?.destroy()
        indexBuffer?.destroy()

        vertexBuffer = device.createBuffer({
            label: "terrain vertices",
            size: mesh.positions.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        })
        device.queue.writeBuffer(vertexBuffer, 0, mesh.positions)

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
     * 카메라 상태로 viewProj 행렬을 계산해 uniform(offset 0)에 쓴다.
     *
     * @param camera 궤도 카메라 상태
     */
    const cameraUpdater = (camera: OrbitCamera) => {
        device.queue.writeBuffer(uniformBuffer, 0, orbitViewProj(camera, aspect))
    }

    /**
     * 지형을 그리는 pass. 배경 pass 가 비운 색·깊이 버퍼를 load 해서 그 위에 그린다.
     * 아직 meshUpdater 로 메쉬가 들어오지 않았으면 아무것도 하지 않는다.
     *
     * @param encoder 이번 프레임의 command encoder
     * @param context 캔버스 context
     */
    const terrainPass = (encoder: GPUCommandEncoder, context: GPUCanvasContext) => {
        if (!vertexBuffer || !indexBuffer) return

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
