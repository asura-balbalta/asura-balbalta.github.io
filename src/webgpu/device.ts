/**
 * canvas 에 WebGPU 를 연결하고 렌더링에 필요한 객체를 준비한다.
 *
 * 1. 브라우저의 WebGPU 지원 여부 확인
 * 2. canvas 에서 webgpu context 획득
 * 3. adapter → device 요청
 * 4. 브라우저가 권장하는 텍스처 포맷으로 context 설정
 *
 * @param canvasId 대상 canvas 요소의 id
 * @returns canvas, context, device, format(캔버스 텍스처 포맷. 파이프라인 fragment target 에 같은 값을 써야 한다)
 * @throws WebGPU 미지원, canvas 없음, context·device 생성 실패 시
 */
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
