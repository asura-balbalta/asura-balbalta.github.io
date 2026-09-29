/// <reference types="@webgpu/types" />

import { TinMesh } from "../terrainData"
import { OrbitCamera, orbitViewProj } from "./camera"
import { initWebGPU } from "./device"
import { createTerrainShader } from "./shaders"

const DEPTH_FORMAT: GPUTextureFormat = "depth24plus"
const UNIFORM_SIZE = 80 // mat4x4f(64) + vec2f(8), 16바이트 정렬

export type MeshBounds = {
    min: [number, number, number]
    max: [number, number, number]
}

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

    const cameraUpdater = (camera: OrbitCamera) => {
        device.queue.writeBuffer(uniformBuffer, 0, orbitViewProj(camera, aspect))
    }

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

    const render = () => {
        const encoder = device.createCommandEncoder()
        backgroundPass(encoder, context)
        terrainPass(encoder, context)
        device.queue.submit([encoder.finish()])
    }

    const updaters = { meshUpdater, cameraUpdater }
    const destroy = () => device.destroy()

    return { render, updaters, destroy }
}
