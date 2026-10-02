import { loadTerrainTtm, LoadPhase, TinMesh } from "./terrainData"

/** 메인 → Worker: 지형 로딩 요청. bbox 는 지도에서 고른 범위 [minX, minY, maxX, maxY] (EPSG:3857) */
export type TerrainLoadRequest = {
    bbox: number[]
    retriangulate: boolean
}

/** Worker → 메인: 진행률, 완료(메쉬 배열은 transfer), 오류 */
export type TerrainLoadResponse =
    | { type: "progress"; phase: LoadPhase; done: number; total: number }
    | { type: "done"; mesh: TinMesh }
    | { type: "error"; message: string }

const post = (msg: TerrainLoadResponse, transfer: Transferable[] = []) =>
    self.postMessage(msg, { transfer })

/**
 * 받기·합치기·재삼각분할(loadTerrainTtm)을 메인 스레드 밖에서 돌린다.
 *
 * 요청 하나를 받아 단계별 진행률을 보내고, 끝나면 메쉬를 transfer 로 넘긴다(복사 없음).
 * 취소는 메인에서 terminate 로 한다(요청마다 Worker 를 새로 만든다).
 */
self.onmessage = async (e: MessageEvent<TerrainLoadRequest>) => {
    const { bbox, retriangulate } = e.data
    try {
        const mesh = await loadTerrainTtm(bbox, {
            retriangulate,
            onProgress: (phase, done, total) => post({ type: "progress", phase, done, total }),
        })
        const transfer: Transferable[] = [mesh.positions.buffer as ArrayBuffer, mesh.indices.buffer as ArrayBuffer]
        if (mesh.segments) transfer.push(mesh.segments.buffer as ArrayBuffer)
        post({ type: "done", mesh }, transfer)
    } catch (err) {
        post({ type: "error", message: err instanceof Error ? err.message : String(err) })
    }
}
