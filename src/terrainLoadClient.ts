import type { LoadProgress, TinMesh } from "./terrainData"
import type { TerrainLoadRequest, TerrainLoadResponse } from "./terrainLoad.worker"

/** esbuild 가 src/terrainLoad.worker.ts 를 별도 entry 로 묶어 내는 파일. index.html 의 index.js 와 같은 폴더(dist)에 있다 */
const LOAD_WORKER_URL = "terrainLoad.worker.js"

/**
 * 지형 로딩을 Worker 에서 시작한다.
 *
 * @param bbox 지도에서 고른 범위 [minX, minY, maxX, maxY] (EPSG:3857)
 * @param options.retriangulate 합친 뒤 도엽 경계 없이 다시 삼각분할할지
 * @param options.onProgress 단계별 진행률(loadTerrainTtm 과 같음)
 * @returns promise(메쉬. 배열은 Worker 에서 transfer 되어 온 것), cancel(Worker 종료. 이후 promise 는 끝나지 않는다)
 */
export const loadTerrainInWorker = (
    bbox: number[],
    options: { retriangulate: boolean; onProgress?: LoadProgress },
) => {
    const worker = new Worker(LOAD_WORKER_URL)
    const stop = () => {
        worker.onmessage = null
        worker.onerror = null
        worker.terminate()
    }
    const promise = new Promise<TinMesh>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<TerrainLoadResponse>) => {
            const msg = e.data
            if (msg.type === "progress") {
                options.onProgress?.(msg.phase, msg.done, msg.total)
            } else if (msg.type === "done") {
                stop()
                resolve(msg.mesh)
            } else {
                stop()
                reject(new Error(msg.message))
            }
        }
        worker.onerror = (e) => {
            stop()
            reject(new Error(`지형 로딩 Worker 오류: ${e.message}`))
        }
        const request: TerrainLoadRequest = { bbox, retriangulate: options.retriangulate }
        worker.postMessage(request)
    })
    return { promise, cancel: stop }
}
