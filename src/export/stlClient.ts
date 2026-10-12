import { BuildingTable, buildingTableBuffers, cloneBuildingTable } from "../buildingTable"
import type { LayerId } from "../layers"
import type { TinMesh } from "../terrainData"
import type { TerrainMode } from "../webgpu/terrainRenderer"
import { encodeStlHeader } from "./stl"
import type { StlExportRequest, StlExportResponse } from "./stl.worker"

/** esbuild 가 src/export/stl.worker.ts 를 별도 entry 로 묶어 내는 파일. dist/index.js 기준 상대 경로 */
const STL_WORKER_URL = "export/stl.worker.js"

/** 내보낼 메쉬. 건물 레이어는 table(건물 표)을 함께 주면 SKP·3DM 이 건물마다 면 그룹·솔리드와 속성을 만든다. 다른 형식은 무시한다 */
export type ExportMesh = TinMesh & { table?: BuildingTable }

/** 내보낼 레이어별 메쉬. null 이면 그 레이어는 뺀다. 모두 같은 원점이어야 한다 */
export type LayerMeshes = Record<LayerId, ExportMesh | null>

/** 내보내기 공통 옵션 */
export type ExportOptions = {
    /** 지형을 "tin" 이면 삼각형 그대로, "stepped" 면 화면과 같은 계단형으로 변환해 적는다 */
    mode: TerrainMode
    /** stepped 일 때 층 간격(m) */
    step: number
    /** 진행률(0 ~ 1) */
    onProgress?: (ratio: number) => void
}

/** 원본 mesh 는 호출자가 계속 쓰므로 slice() 사본을 만들고, 그 버퍼를 transfer 목록에 모은다 */
export const copyLayerMeshes = (layers: LayerMeshes, transfer: ArrayBuffer[]): LayerMeshes => {
    const out = {} as LayerMeshes
    for (const id of Object.keys(layers) as LayerId[]) {
        const mesh = layers[id]
        if (!mesh) {
            out[id] = null
            continue
        }
        const c: ExportMesh = { origin: mesh.origin, positions: mesh.positions.slice(), indices: mesh.indices.slice() }
        transfer.push(c.positions.buffer as ArrayBuffer, c.indices.buffer as ArrayBuffer)
        if (mesh.table) {
            c.table = cloneBuildingTable(mesh.table)
            transfer.push(...buildingTableBuffers(c.table))
        }
        out[id] = c
    }
    return out
}

/**
 * 레이어 메쉬들을 Worker 에서 바이너리 STL 하나로 만든다.
 *
 * @param layers 레이어별 메쉬(원점 기준 좌표). 적어도 하나는 있어야 한다
 * @returns promise(STL Blob), cancel(Worker 종료. 이후 promise 는 끝나지 않는다)
 */
export const exportStlInWorker = (layers: LayerMeshes, options: ExportOptions) => {
    const origin = Object.values(layers).find((m) => m)?.origin
    if (!origin) throw new Error("내보낼 레이어가 없음")
    const worker = new Worker(STL_WORKER_URL)
    const stop = () => {
        worker.onmessage = null
        worker.onerror = null
        worker.terminate()
    }
    const promise = new Promise<Blob>((resolve, reject) => {
        const parts: ArrayBuffer[] = []
        let triangles = 0
        worker.onmessage = (e: MessageEvent<StlExportResponse>) => {
            const msg = e.data
            if (msg.type === "part") {
                parts.push(msg.buffer)
                triangles += msg.triangles
            } else if (msg.type === "progress") {
                options.onProgress?.(msg.ratio)
            } else {
                stop()
                resolve(new Blob([encodeStlHeader(triangles, origin), ...parts], { type: "model/stl" }))
            }
        }
        worker.onerror = (e) => {
            stop()
            reject(new Error(`STL 생성 Worker 오류: ${e.message}`))
        }
        const transfer: ArrayBuffer[] = []
        const request: StlExportRequest = { layers: copyLayerMeshes(layers, transfer), mode: options.mode, step: options.step }
        worker.postMessage(request, transfer)
    })
    return { promise, cancel: stop }
}
