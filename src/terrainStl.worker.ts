import type { TinMesh } from "./terrainData"
import { buildSteppedMeshChunks } from "./terrainSteps"
import { encodeStlTriangles } from "./terrainStl"
import type { TerrainMode } from "./webgpu/terrainRenderer"

/** 메인 → Worker: STL 생성 요청. mesh 는 메인이 slice() 로 만든 사본이며 그 배열을 transfer 로 넘겨받는다 */
export type StlExportRequest = {
    mesh: TinMesh
    /** "tin" 이면 삼각형 그대로, "stepped" 면 화면과 같은 계단형으로 변환해 적는다 */
    mode: TerrainMode
    /** stepped 일 때 층 간격(m) */
    step: number
}

/** Worker → 메인: 삼각형 레코드 조각(버퍼는 transfer), 진행률(0 ~ 1), 완료 */
export type StlExportResponse =
    | { type: "part"; buffer: ArrayBuffer; triangles: number }
    | { type: "progress"; ratio: number }
    | { type: "done" }

/** 계단형 변환 조각의 정점·인덱스 버퍼 최대 바이트. GPU 한도와 무관하므로 Worker 메모리만 고려해 정한다 */
const STEPPED_CHUNK_BYTES = 64 * 1048576
/** TIN 은 이 삼각형 수씩 나누어 보낸다(진행률 표시와 메모리 분산) */
const TIN_PART_TRIANGLES = 200_000

const post = (msg: StlExportResponse, transfer: Transferable[] = []) => self.postMessage(msg, { transfer })

const postPart = (buffer: ArrayBuffer, triangles: number) => post({ type: "part", buffer, triangles }, [buffer])

/**
 * STL 인코딩을 메인 스레드 밖에서 돌린다.
 *
 * 요청 하나를 받아 조각이 만들어질 때마다 바로 보내고, 끝나면 done 을 보낸다. 머리말은 삼각형 총수를 알아야 하므로
 * 메인이 done 을 받은 뒤 만든다. 취소는 메인에서 terminate 로 한다(요청마다 Worker 를 새로 만든다).
 * 변환 중 오류가 나면 메인의 worker.onerror 로 전달된다.
 */
self.onmessage = (e: MessageEvent<StlExportRequest>) => {
    const { mesh, mode, step } = e.data
    if (mode === "stepped") {
        const chunks = buildSteppedMeshChunks(mesh, step, STEPPED_CHUNK_BYTES, (done, total) =>
            post({ type: "progress", ratio: done / total }),
        )
        for (const chunk of chunks) {
            postPart(encodeStlTriangles(chunk.positions, chunk.indices), Math.floor(chunk.indices.length / 3))
        }
    } else {
        const total = Math.floor(mesh.indices.length / 3)
        for (let start = 0; start < total; start += TIN_PART_TRIANGLES) {
            const end = Math.min(total, start + TIN_PART_TRIANGLES)
            postPart(encodeStlTriangles(mesh.positions, mesh.indices.subarray(start * 3, end * 3)), end - start)
            post({ type: "progress", ratio: end / total })
        }
    }
    post({ type: "done" })
}
