import type { TinMesh } from "./terrainData"
import { encodeStlHeader } from "./terrainStl"
import type { StlExportRequest, StlExportResponse } from "./terrainStl.worker"
import type { TerrainMode } from "./webgpu/terrainRenderer"

/** esbuild 가 src/terrainStl.worker.ts 를 별도 entry 로 묶어 내는 파일. index.html 의 index.js 와 같은 폴더(dist)에 있다 */
const STL_WORKER_URL = "terrainStl.worker.js"

/**
 * 지형 메쉬를 Worker 에서 바이너리 STL 로 만든다.
 *
 * 원본 mesh 는 호출자가 계속 쓰므로 slice() 사본을 만들어 그 버퍼만 transfer 한다.
 *
 * @param mesh 내보낼 TIN 메쉬(원점 기준 좌표)
 * @param options.mode "tin" 이면 삼각형 그대로, "stepped" 면 화면과 같은 계단형으로 변환해 적는다
 * @param options.step stepped 일 때 층 간격(m)
 * @param options.onProgress 진행률(0 ~ 1)
 * @returns promise(STL Blob), cancel(Worker 종료. 이후 promise 는 끝나지 않는다)
 */
export const exportStlInWorker = (
    mesh: TinMesh,
    options: { mode: TerrainMode; step: number; onProgress?: (ratio: number) => void },
) => {
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
                resolve(new Blob([encodeStlHeader(triangles, mesh.origin), ...parts], { type: "model/stl" }))
            }
        }
        worker.onerror = (e) => {
            stop()
            reject(new Error(`STL 생성 Worker 오류: ${e.message}`))
        }
        const copy: TinMesh = {
            origin: mesh.origin,
            positions: mesh.positions.slice(),
            indices: mesh.indices.slice(),
        }
        const request: StlExportRequest = { mesh: copy, mode: options.mode, step: options.step }
        worker.postMessage(request, [copy.positions.buffer, copy.indices.buffer] as ArrayBuffer[])
    })
    return { promise, cancel: stop }
}

/** 내려받을 STL 파일 이름. 예: terrain-tin-20261006-1630.stl */
export const stlFileName = (mode: TerrainMode, now = new Date()) => {
    const pad = (n: number) => String(n).padStart(2, "0")
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
    return `terrain-${mode}-${stamp}.stl`
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
