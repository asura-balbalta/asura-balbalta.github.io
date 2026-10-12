import type { BuildingsProgress } from "./buildingsData"
import type { BuildingTable } from "./buildingTable"
import type { BuildingsRequest, BuildingsResponse } from "./buildings.worker"
import type { TinMesh } from "./terrainData"

/** 건물 레이어 메쉬 + 건물 표. 렌더러는 TinMesh 로 쓰고, 내보내기·편집은 table 로 건물 하나씩을 다룬다 */
export type BuildingsMesh = TinMesh & { table: BuildingTable }

/** esbuild 가 src/buildings.worker.ts 를 별도 entry 로 묶어 내는 파일. index.html 의 index.js 와 같은 폴더(dist)에 있다 */
const BUILDINGS_WORKER_URL = "buildings.worker.js"

/**
 * 선택 범위의 건물 레이어 메쉬를 Worker 에서 만든다.
 *
 * 지형 mesh 는 호출자가 계속 쓰므로 slice() 사본을 만들어 그 버퍼만 transfer 한다.
 *
 * @param bbox 지도에서 고른 범위 (EPSG:3857)
 * @param terrain 바닥 높이를 찾을 지형 메쉬(원점 기준 좌표)
 * @param options.onProgress 단계별 진행률
 * @returns promise(지형과 같은 원점의 건물 메쉬(건물 표 포함)와 집계), cancel(Worker 종료. 이후 promise 는 끝나지 않는다)
 */
export const loadBuildingsInWorker = (
    bbox: number[],
    terrain: TinMesh,
    options: { onProgress?: BuildingsProgress } = {},
) => {
    const worker = new Worker(BUILDINGS_WORKER_URL)
    const stop = () => {
        worker.onmessage = null
        worker.onerror = null
        worker.terminate()
    }
    const promise = new Promise<{ mesh: BuildingsMesh; built: number; skipped: number; files: number }>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<BuildingsResponse>) => {
            const msg = e.data
            if (msg.type === "progress") {
                options.onProgress?.(msg.phase, msg.done, msg.total)
            } else if (msg.type === "done") {
                stop()
                resolve({ mesh: { ...msg.mesh, table: msg.table }, built: msg.built, skipped: msg.skipped, files: msg.files })
            } else {
                stop()
                reject(new Error(msg.message))
            }
        }
        worker.onerror = (e) => {
            stop()
            reject(new Error(`건물 레이어 Worker 오류: ${e.message}`))
        }
        const copy: TinMesh = {
            origin: terrain.origin,
            positions: terrain.positions.slice(),
            indices: terrain.indices.slice(),
        }
        const request: BuildingsRequest = { bbox, terrain: copy }
        worker.postMessage(request, [copy.positions.buffer, copy.indices.buffer] as ArrayBuffer[])
    })
    return { promise, cancel: stop }
}
