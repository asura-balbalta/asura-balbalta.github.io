import type { Extent } from "ol/extent"

import type { AppDebugApi } from "../app.tsx"
import { dataCacheTable, heapBytes } from "../terrainData"

/**
 * 디버그 페이지 전용 window.__asrbbtDebug(2026-10-23, 계획서 19절). walk·app 페이지가 AppRoot 의 onDebugApi 로 받아 설치하고, 페이지를
 * 떠나면(null) 지운다. 운영 주소에서는 이 함수가 불리지 않는다(App 은 onDebugApi 가 있을 때만 손잡이를 만든다)
 *
 * - memory(): 캐시 메모리 보고 Promise. 스레드마다 캐시 표 caches(`층.레이어` → LruCache.stats(), 층 fixed·index·file·result. VERIFY.md 4절).
 *   workers.helpers = 보조 워커별 built·heap·caches, workers.coordinator = caches(인덱스 JSON)·로드된 도엽·live5k·running·pending,
 *   main = 메인 도엽 사본·caches(외곽선용 ttp 인덱스)·JS 힙, gpu = GPU 상주 도엽·바이트
 * - teleport(x, y): 둘러보기 플레이어를 메쉬 로컬 m(spawn= 과 같은 좌표)으로 옮긴다. 평소 이동처럼 주변 도엽 스트리밍이 따라온다
 * - select(bbox3857): 지도에서 범위를 확정한 것과 같은 경로(워커 캐시 reset 포함). 끝은 data-busy 0 또는 memory() 의 running false 로 본다
 */
export const installDebugHooks = (api: AppDebugApi | null) => {
    const w = window as unknown as { __asrbbtDebug?: unknown }
    if (!api) {
        delete w.__asrbbtDebug
        return
    }
    w.__asrbbtDebug = {
        memory: async () => ({
            at: new Date().toISOString(),
            workers: await api.tiles.workerMemory(),
            main: { origin: api.tiles.origin, tiles: api.tiles.memory(), caches: dataCacheTable(), heap: heapBytes() },
            gpu: api.canvas()?.gpu() ?? null,
        }),
        teleport: (x: number, y: number) => {
            if (!api.canvas()?.teleport(x, y)) throw new Error("둘러보기 중이 아닙니다")
        },
        select: (bbox: Extent) => api.select(bbox),
    }
}
