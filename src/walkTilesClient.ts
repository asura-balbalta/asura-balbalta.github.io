import type { Extent } from "ol/extent"

import type { WalkTileData, WalkTilesRequest, WalkTilesResponse } from "./walkTiles.worker"

/** esbuild 가 src/walkTiles.worker.ts 를 별도 entry 로 묶어 내는 파일. index.html 의 index.js 와 같은 폴더(dist)에 있다 */
const WALK_TILES_WORKER_URL = "walkTiles.worker.js"

/**
 * 걸어 보기 도엽 스트리밍 Worker 를 시작한다(walkTiles.worker.ts). 걸어 보기에 들어갈 때 만들고 나갈 때 terminate 한다.
 *
 * @param options.origin 선택 범위 메쉬의 원점(5179 m)
 * @param options.selection 선택 범위(3857)
 * @param options.step 계단형 층 간격(m)
 * @param options.maxBytes 조각 버퍼 상한
 * @param options.radius 로드 반경(m)
 * @param options.maxTiles 도엽 상한
 * @param options.onTile 도엽이 만들어졌을 때(배열은 transfer 되어 온 것)
 * @param options.onRemove 멀어진 도엽을 뺄 때
 * @param options.onCovers 선택 범위 도엽이 모두 로드됐는지 바뀔 때
 * @param options.onError Worker 오류(스트리밍만 멈춘다. 걸어 보기는 선택 범위 안에서 계속)
 * @returns update(플레이어 위치 5179 m), terminate
 */
export const startWalkTiles = (options: {
    origin: [number, number]
    selection: Extent
    step: number
    maxBytes: number
    radius: number
    maxTiles: number
    onTile: (tile: WalkTileData) => void
    onRemove: (id: string) => void
    onCovers: (covers: boolean) => void
    onError?: (message: string) => void
}) => {
    const worker = new Worker(WALK_TILES_WORKER_URL)
    worker.onmessage = (e: MessageEvent<WalkTilesResponse>) => {
        const msg = e.data
        if (msg.type === "tile") options.onTile(msg.tile)
        else if (msg.type === "remove") options.onRemove(msg.id)
        else if (msg.type === "covers") options.onCovers(msg.covers)
        else options.onError?.(msg.message)
    }
    worker.onerror = (e) => options.onError?.(`도엽 스트리밍 Worker 오류: ${e.message}`)
    const send = (msg: WalkTilesRequest) => worker.postMessage(msg)
    send({
        type: "init",
        origin: options.origin,
        selection: options.selection,
        step: options.step,
        maxBytes: options.maxBytes,
        radius: options.radius,
        maxTiles: options.maxTiles,
    })
    return {
        update: (center: [number, number]) => send({ type: "update", center }),
        terminate: () => {
            worker.onmessage = null
            worker.onerror = null
            worker.terminate()
        },
    }
}
