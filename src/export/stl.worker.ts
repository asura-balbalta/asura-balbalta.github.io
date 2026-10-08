import { LAYER_DEFS } from "../layers"
import type { TinMesh } from "../terrainData"
import { buildSteppedMeshChunks } from "../terrainSteps"
import type { TerrainMode } from "../webgpu/terrainRenderer"
import { encodeStlTriangles } from "./stl"
import type { LayerMeshes } from "./stlClient"

/**
 * 메인 → Worker: STL 생성 요청. 레이어마다 넣을지 말지를 메인이 정해 메쉬를 주거나(null 이면 뺌) 만다.
 * 메쉬는 메인이 slice() 로 만든 사본이며 그 배열을 transfer 로 넘겨받는다
 */
export type StlExportRequest = {
    layers: LayerMeshes
    /** 지형(terrain)을 "tin" 이면 삼각형 그대로, "stepped" 면 화면과 같은 계단형으로 변환해 적는다. 다른 레이어는 그대로 */
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
/** 삼각형 메쉬는 이 삼각형 수씩 나누어 보낸다(진행률 표시와 메모리 분산) */
const PART_TRIANGLES = 200_000

const post = (msg: StlExportResponse, transfer: Transferable[] = []) => self.postMessage(msg, { transfer })

const postPart = (buffer: ArrayBuffer, triangles: number) => post({ type: "part", buffer, triangles }, [buffer])

/**
 * STL 인코딩을 메인 스레드 밖에서 돌린다.
 *
 * 요청 하나를 받아 LAYER_DEFS 순서로 조각이 만들어질 때마다 바로 보내고, 끝나면 done 을 보낸다. 머리말은
 * 삼각형 총수를 알아야 하므로 메인이 done 을 받은 뒤 만든다. 진행률은 레이어의 원본 삼각형 수로 가중해 0 ~ 1 로 낸다.
 * 취소는 메인에서 terminate 로 한다(요청마다 Worker 를 새로 만든다). 변환 중 오류가 나면 메인의 worker.onerror 로 전달된다.
 */
self.onmessage = (e: MessageEvent<StlExportRequest>) => {
    const { layers, mode, step } = e.data
    const weight = (m: TinMesh | null) => (m ? m.indices.length / 3 : 0)
    const total = Object.values(layers).reduce((sum, m) => sum + weight(m), 0) || 1
    let doneBefore = 0
    const progress = (ratioInLayer: number, layerWeight: number) =>
        post({ type: "progress", ratio: (doneBefore + ratioInLayer * layerWeight) / total })

    /** 삼각형 메쉬를 PART_TRIANGLES 씩 그대로 적는다 */
    const encodePlain = (mesh: TinMesh) => {
        const count = Math.floor(mesh.indices.length / 3)
        for (let start = 0; start < count; start += PART_TRIANGLES) {
            const end = Math.min(count, start + PART_TRIANGLES)
            postPart(encodeStlTriangles(mesh.positions, mesh.indices.subarray(start * 3, end * 3)), end - start)
            progress(end / count, count)
        }
    }

    for (const { id } of LAYER_DEFS) {
        const mesh = layers[id]
        if (!mesh) continue
        if (id === "terrain" && mode === "stepped") {
            const w = weight(mesh)
            const chunks = buildSteppedMeshChunks(mesh, step, STEPPED_CHUNK_BYTES, (done, all) => progress(done / all, w))
            for (const chunk of chunks) {
                postPart(encodeStlTriangles(chunk.positions, chunk.indices), Math.floor(chunk.indices.length / 3))
            }
        } else {
            encodePlain(mesh)
        }
        doneBefore += weight(mesh)
    }
    post({ type: "done" })
}
