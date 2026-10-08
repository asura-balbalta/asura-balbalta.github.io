import type { GlbExportRequest, GlbExportResponse } from "./glb.worker"
import { copyLayerMeshes, type ExportOptions, type LayerMeshes } from "./stlClient"

/** esbuild 가 src/export/glb.worker.ts 를 별도 entry 로 묶어 내는 파일. dist/index.js 기준 상대 경로 */
const GLB_WORKER_URL = "export/glb.worker.js"

/**
 * 레이어 메쉬들을 Worker 에서 GLB(바이너리 glTF 2.0) 하나로 만든다. 외부 라이브러리 없음.
 *
 * @param layers 레이어별 메쉬(원점 기준 좌표). 적어도 하나는 있어야 한다
 * @returns promise(.glb Blob), cancel(Worker 종료. 이후 promise 는 끝나지 않는다)
 */
export const exportGlbInWorker = (layers: LayerMeshes, options: ExportOptions) => {
    if (!Object.values(layers).some((m) => m)) throw new Error("내보낼 레이어가 없음")
    const worker = new Worker(GLB_WORKER_URL)
    const stop = () => {
        worker.onmessage = null
        worker.onerror = null
        worker.terminate()
    }
    const promise = new Promise<Blob>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<GlbExportResponse>) => {
            const msg = e.data
            if (msg.type === "progress") {
                options.onProgress?.(msg.ratio)
            } else {
                stop()
                resolve(new Blob([msg.buffer], { type: "model/gltf-binary" }))
            }
        }
        worker.onerror = (e) => {
            stop()
            reject(new Error(`GLB 생성 Worker 오류: ${e.message}`))
        }
        const transfer: ArrayBuffer[] = []
        const request: GlbExportRequest = { layers: copyLayerMeshes(layers, transfer), mode: options.mode, step: options.step }
        worker.postMessage(request, transfer)
    })
    return { promise, cancel: stop }
}
