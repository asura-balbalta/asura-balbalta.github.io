/// <reference types="@webgpu/types" />

export const initWebGPU = async (canvasId: string) => {
    if (!navigator.gpu) throw new Error("이 브라우저는 WebGPU를 지원하지 않음")

    const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null
    if (!canvas) throw new Error(`canvas 없음: ${canvasId}`)

    const context = canvas.getContext("webgpu")
    if (!context) throw new Error("webgpu context 생성 실패")

    const adapter = await navigator.gpu.requestAdapter()
    const device = await adapter?.requestDevice()
    if (!device) throw new Error("GPU device 생성 실패")

    const format = navigator.gpu.getPreferredCanvasFormat()
    context.configure({ device, format })

    return { canvas, context, device, format }
}
