import type { Rhino3dmExportRequest, Rhino3dmExportResponse } from "./3dm.worker"
import { copyLayerMeshes, type ExportOptions, type LayerMeshes } from "./stlClient"

/** esbuild 가 src/export/3dm.worker.ts 를 별도 entry 로 묶어 내는 파일. dist/index.js 기준 상대 경로 */
const RHINO3DM_WORKER_URL = "export/3dm.worker.js"

/**
 * 레이어 메쉬들을 Worker 에서 Rhino .3dm 하나로 만든다(rhino3dm, McNeel 공식 openNURBS).
 *
 * @param layers 레이어별 메쉬(원점 기준 좌표). 적어도 하나는 있어야 한다
 * @returns promise(.3dm Blob), cancel(Worker 종료. 이후 promise 는 끝나지 않는다)
 */
export const export3dmInWorker = (layers: LayerMeshes, options: ExportOptions) => {
    if (!Object.values(layers).some((m) => m)) throw new Error("내보낼 레이어가 없음")
    const worker = new Worker(RHINO3DM_WORKER_URL)
    const stop = () => {
        worker.onmessage = null
        worker.onerror = null
        worker.terminate()
    }
    const promise = new Promise<Blob>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<Rhino3dmExportResponse>) => {
            const msg = e.data
            if (msg.type === "progress") {
                options.onProgress?.(msg.ratio)
            } else {
                stop()
                resolve(new Blob([msg.buffer], { type: "model/vnd.3dm" }))
            }
        }
        worker.onerror = (e) => {
            stop()
            reject(new Error(`3DM 생성 Worker 오류: ${e.message}`))
        }
        const transfer: ArrayBuffer[] = []
        const request: Rhino3dmExportRequest = { layers: copyLayerMeshes(layers, transfer), mode: options.mode, step: options.step }
        worker.postMessage(request, transfer)
    })
    return { promise, cancel: stop }
}
