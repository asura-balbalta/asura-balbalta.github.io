import type { TinMesh } from "./terrainData"
import type { SkpExportRequest, SkpExportResponse } from "./terrainSkp.worker"
import type { StlLayerMeshes } from "./terrainStlClient"
import type { TerrainMode } from "./webgpu/terrainRenderer"

/** esbuild 가 src/terrainSkp.worker.ts 를 별도 entry 로 묶어 내는 파일. index.html 의 index.js 와 같은 폴더(dist)에 있다 */
const SKP_WORKER_URL = "terrainSkp.worker.js"

/**
 * 레이어 메쉬들을 Worker 에서 SketchUp .skp 하나로 만든다(openskp, SDK 없음).
 *
 * 원본 mesh 는 호출자가 계속 쓰므로 slice() 사본을 만들어 그 버퍼만 transfer 한다.
 *
 * @param layers 레이어별 메쉬(원점 기준 좌표). 적어도 하나는 있어야 한다
 * @param options.mode 지형을 "tin" 이면 삼각형 그대로, "stepped" 면 화면과 같은 계단형으로 변환해 넣는다
 * @param options.step stepped 일 때 층 간격(m)
 * @param options.onProgress 진행률(0 ~ 1)
 * @returns promise(.skp Blob), cancel(Worker 종료. 이후 promise 는 끝나지 않는다)
 */
export const exportSkpInWorker = (
    layers: StlLayerMeshes,
    options: { mode: TerrainMode; step: number; onProgress?: (ratio: number) => void },
) => {
    if (!layers.terrain && !layers.buildings) throw new Error("내보낼 레이어가 없음")
    const worker = new Worker(SKP_WORKER_URL)
    const stop = () => {
        worker.onmessage = null
        worker.onerror = null
        worker.terminate()
    }
    const promise = new Promise<Blob>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<SkpExportResponse>) => {
            const msg = e.data
            if (msg.type === "progress") {
                options.onProgress?.(msg.ratio)
            } else {
                stop()
                resolve(new Blob([msg.buffer], { type: "application/vnd.sketchup.skp" }))
            }
        }
        worker.onerror = (e) => {
            stop()
            reject(new Error(`SKP 생성 Worker 오류: ${e.message}`))
        }
        const transfer: ArrayBuffer[] = []
        const copy = (mesh: TinMesh | null): TinMesh | null => {
            if (!mesh) return null
            const c: TinMesh = { origin: mesh.origin, positions: mesh.positions.slice(), indices: mesh.indices.slice() }
            transfer.push(c.positions.buffer as ArrayBuffer, c.indices.buffer as ArrayBuffer)
            return c
        }
        const request: SkpExportRequest = {
            terrain: copy(layers.terrain),
            buildings: copy(layers.buildings),
            mode: options.mode,
            step: options.step,
        }
        worker.postMessage(request, transfer)
    })
    return { promise, cancel: stop }
}
