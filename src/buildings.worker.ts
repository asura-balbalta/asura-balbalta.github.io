import { BuildingsLoadPhase, loadBuildings, loadStoreyHeights } from "./buildingsData"
import { buildBuildingsMesh, BuildingParts } from "./buildingsMesh"
import type { TinMesh } from "./terrainData"

/** 메인 → Worker: 건물 레이어 요청. terrain 은 메인이 slice() 로 만든 지형 사본이며 그 배열을 transfer 로 넘겨받는다 */
export type BuildingsRequest = {
    /** 지도에서 고른 범위 [minX, minY, maxX, maxY] (EPSG:3857) */
    bbox: number[]
    /** 바닥 높이를 찾을 지형 메쉬(원점 포함) */
    terrain: TinMesh
}

/** Worker → 메인: 진행률, 완료(메쉬·건물별 표 배열은 transfer), 오류 */
export type BuildingsResponse =
    | { type: "progress"; phase: BuildingsLoadPhase; done: number; total: number }
    | { type: "done"; mesh: TinMesh; parts: BuildingParts; built: number; skipped: number; files: number }
    | { type: "error"; message: string }

const post = (msg: BuildingsResponse, transfer: Transferable[] = []) => self.postMessage(msg, { transfer })

/**
 * 건물 받기·합치기·세우기(loadBuildings → buildBuildingsMesh)를 메인 스레드 밖에서 돌린다.
 * 요청 하나를 받아 단계별 진행률을 보내고, 끝나면 메쉬를 transfer 로 넘긴다. 취소는 메인에서 terminate 로 한다.
 */
self.onmessage = async (e: MessageEvent<BuildingsRequest>) => {
    const { bbox, terrain } = e.data
    try {
        const t0 = performance.now()
        const onProgress = (phase: BuildingsLoadPhase, done: number, total: number) =>
            post({ type: "progress", phase, done, total })
        const [storeyByUse, { buildings, files }] = await Promise.all([
            loadStoreyHeights(),
            loadBuildings(bbox, terrain.origin, onProgress),
        ])
        const t1 = performance.now()
        onProgress("build", 0, buildings.length)
        const { mesh, parts, built, skipped } = buildBuildingsMesh(buildings, terrain, storeyByUse, (done, total) =>
            onProgress("build", done, total),
        )
        console.log(
            `건물: 5K 파일 ${files}개, 건물 ${buildings.length}개 중 ${built} 세움·${skipped} 지형 밖, 삼각형 ${mesh.indices.length / 3} (받기 ${Math.round(t1 - t0)}ms + 세우기 ${Math.round(performance.now() - t1)}ms)`,
        )
        post({ type: "done", mesh, parts, built, skipped, files }, [
            mesh.positions.buffer as ArrayBuffer,
            mesh.indices.buffer as ArrayBuffer,
            parts.heads.buffer as ArrayBuffer,
            parts.holeStarts.buffer as ArrayBuffer,
            parts.ids.buffer as ArrayBuffer,
        ])
    } catch (err) {
        post({ type: "error", message: err instanceof Error ? err.message : String(err) })
    }
}
