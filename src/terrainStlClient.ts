import type { LayerId } from "./layers"
import type { TinMesh } from "./terrainData"
import { encodeStlHeader } from "./terrainStl"
import type { StlExportRequest, StlExportResponse } from "./terrainStl.worker"
import type { TerrainMode } from "./webgpu/terrainRenderer"

/** esbuild 가 src/terrainStl.worker.ts 를 별도 entry 로 묶어 내는 파일. index.html 의 index.js 와 같은 폴더(dist)에 있다 */
const STL_WORKER_URL = "terrainStl.worker.js"

/** 내보낼 레이어별 메쉬. null 이면 그 레이어는 뺀다. 모두 같은 원점이어야 한다 */
export type StlLayerMeshes = {
    terrain: TinMesh | null
    buildings: TinMesh | null
}

/**
 * 레이어 메쉬들을 Worker 에서 바이너리 STL 하나로 만든다.
 *
 * 원본 mesh 는 호출자가 계속 쓰므로 slice() 사본을 만들어 그 버퍼만 transfer 한다.
 *
 * @param layers 레이어별 메쉬(원점 기준 좌표). 적어도 하나는 있어야 한다
 * @param options.mode 지형을 "tin" 이면 삼각형 그대로, "stepped" 면 화면과 같은 계단형으로 변환해 적는다
 * @param options.step stepped 일 때 층 간격(m)
 * @param options.onProgress 진행률(0 ~ 1)
 * @returns promise(STL Blob), cancel(Worker 종료. 이후 promise 는 끝나지 않는다)
 */
export const exportStlInWorker = (
    layers: StlLayerMeshes,
    options: { mode: TerrainMode; step: number; onProgress?: (ratio: number) => void },
) => {
    const origin = (layers.terrain ?? layers.buildings)?.origin
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
        const copy = (mesh: TinMesh | null): TinMesh | null => {
            if (!mesh) return null
            const c: TinMesh = { origin: mesh.origin, positions: mesh.positions.slice(), indices: mesh.indices.slice() }
            transfer.push(c.positions.buffer as ArrayBuffer, c.indices.buffer as ArrayBuffer)
            return c
        }
        const request: StlExportRequest = {
            terrain: copy(layers.terrain),
            buildings: copy(layers.buildings),
            mode: options.mode,
            step: options.step,
        }
        worker.postMessage(request, transfer)
    })
    return { promise, cancel: stop }
}

/** 내려받을 STL 파일 이름. 예: asrbbt-terrain-tin+buildings-20261008-1630.stl */
export const stlFileName = (mode: TerrainMode, layerIds: LayerId[], now = new Date()) => {
    const pad = (n: number) => String(n).padStart(2, "0")
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
    const parts = layerIds.map((id) => (id === "terrain" ? `terrain-${mode}` : id))
    return `asrbbt-${parts.join("+")}-${stamp}.stl`
}

/** Blob 을 브라우저 다운로드로 내려준다 */
export const downloadBlob = (blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    a.remove()
    // 클릭이 처리될 시간을 준 뒤 해제한다
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
