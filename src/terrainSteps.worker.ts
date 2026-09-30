import { MeshChunk, TinMesh } from "./terrainData"
import { buildSteppedMeshChunks } from "./terrainSteps"

/** 메인 → Worker: 계단형 변환 요청. mesh 의 배열은 transfer 로 넘겨받는다 */
export type SteppedMeshRequest = {
    mesh: TinMesh
    step: number
    maxBytes: number
}

/** Worker → 메인: 조각(배열은 transfer), 진행률(처리한 원본 삼각형 비율 0 ~ 1), 완료 */
export type SteppedMeshResponse =
    | { type: "chunk"; chunk: MeshChunk }
    | { type: "progress"; ratio: number }
    | { type: "done" }

const post = (msg: SteppedMeshResponse, transfer: Transferable[] = []) =>
    self.postMessage(msg, { transfer })

/**
 * 계단형 변환(buildSteppedMeshChunks)을 메인 스레드 밖에서 돌린다.
 *
 * 요청 하나를 받아 조각이 만들어질 때마다 바로 보내고, 끝나면 done 을 보낸다.
 * 변환 루프가 동기라 도중에 메시지를 받을 수 없으므로, 취소는 메인에서 terminate 로 한다(요청마다 Worker 를 새로 만든다).
 * 변환 중 오류가 나면 메인의 worker.onerror 로 전달된다.
 */
self.onmessage = (e: MessageEvent<SteppedMeshRequest>) => {
    const { mesh, step, maxBytes } = e.data
    const chunks = buildSteppedMeshChunks(mesh, step, maxBytes, (done, total) =>
        post({ type: "progress", ratio: done / total }),
    )
    for (const chunk of chunks) {
        post({ type: "chunk", chunk }, [
            chunk.positions.buffer as ArrayBuffer,
            chunk.indices.buffer as ArrayBuffer,
        ])
    }
    post({ type: "done" })
}
