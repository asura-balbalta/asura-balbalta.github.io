import type { Extent } from "ol/extent"
import proj4 from "proj4"

import { buildingsSheetsOf } from "./buildingsData"
import { forestSheetsOf } from "./forestData"
import { roadsSheetsOf } from "./roadsData"
import type { JsonMemo, Layer5k, LayerSheets } from "./terrainData"
import { getTtpSheetsInBbox } from "./terrainIndex"
import { waterSheetsOf } from "./waterData"

/**
 * 도엽마다 레이어 5K 목록을 정한다(캐시 통일 C2, 2026-10-23. 계획서 3.2 안 가). 조정자(terrainTiles.worker.ts)가 일감(BuildJob.layers)에 싣고,
 * 하네스(scripts/tileGolden.ts sceneJobs)도 같은 함수를 쓴다. 보조 워커는 ttp·레이어 인덱스를 읽지 않는다.
 *
 * 규칙은 C2 전 보조 워커의 loadX(도엽 3857 bbox)를 "도엽마다 새 워커" 로 돌린 것과 같다: 도엽 corners 를 3857 로 바꾼 외접 bbox 로 ttp 인덱스에서
 * 5K 를 고르고(getTtpSheetsInBbox 의 sheets 순서), 레이어 50K 인덱스에서 비지 않은 것만 그 순서로 남긴다. C2 전에는 5K 목록을 그 5K 의 첫 도엽
 * bbox 로 채워 결과가 도엽 순서에 따라 달랐다(계획서 1.1-3)
 */
export type DataLayerId = "buildings" | "roads" | "water" | "forest"
export const DATA_LAYERS: DataLayerId[] = ["buildings", "roads", "water", "forest"]
/** 도엽 하나의 레이어별 5K 목록. 계산하지 않은 레이어(산림 끔)는 빠진다 */
export type TileLayerSheets = Partial<Record<DataLayerId, LayerSheets>>

const SHEETS_OF: Record<DataLayerId, (sheets: { id5k: string }[], memo?: JsonMemo) => Promise<Layer5k[]>> = {
    buildings: buildingsSheetsOf,
    roads: roadsSheetsOf,
    water: waterSheetsOf,
    forest: forestSheetsOf,
}

/** 5179 m 좌표를 3857 로(보조 워커가 C2 전 loadX 에 넘기던 bbox 와 같은 계산) */
const to3857 = ([x, y]: [number, number]) => proj4("EPSG:5179", "EPSG:3857", [x, y]) as [number, number]
const extentOf = (pts: [number, number][]): Extent => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const [x, y] of pts) {
        if (x < x0) x0 = x
        if (y < y0) y0 = y
        if (x > x1) x1 = x
        if (y > y1) y1 = y
    }
    return [x0, y0, x1, y1]
}
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * 도엽 하나의 레이어별 5K 목록. 인덱스를 못 읽으면 그 레이어(ttp 인덱스면 전부)를 { error } 로 둔다(보조 워커가 그 레이어만 실패로 경고. C2 전과 같은 자리)
 *
 * @param corners 도엽 corners(5179)
 * @param layers 계산할 레이어
 * @param memo 묶음 동안 인덱스를 쥐는 곳(조정자). 없으면 이름공간 캐시만
 */
export const layerSheetsOfTile = async (corners: [number, number][], layers: DataLayerId[], memo?: JsonMemo): Promise<TileLayerSheets> => {
    const out: TileLayerSheets = {}
    let sheets: { id5k: string }[]
    try {
        sheets = (await getTtpSheetsInBbox(extentOf(corners.map(to3857)), memo)).sheets
    } catch (err) {
        for (const k of layers) out[k] = { error: messageOf(err) }
        return out
    }
    await Promise.all(
        layers.map(async (k) => {
            try {
                out[k] = await SHEETS_OF[k](sheets, memo)
            } catch (err) {
                out[k] = { error: messageOf(err) }
            }
        }),
    )
    return out
}

/**
 * 조정자의 묶음(선택 한 번, 걸어 보기 갱신 한 번. C1 검토 M1): 묶음 동안 인덱스 JSON 을 쥐고(memo) 도엽마다 목록을 한 번만 계산한다(tiles).
 * 넓은 선택이 50K 를 이름공간 상한보다 많이 걸쳐도 묶음 안에서는 인덱스를 다시 받지 않는다. 다음 묶음이 시작되면 버린다
 */
export type SheetsBatch = { memo: JsonMemo; tiles: Map<string, Promise<TileLayerSheets>> }
export const createSheetsBatch = (): SheetsBatch => ({ memo: new Map(), tiles: new Map() })
/** 묶음 안에서 도엽 하나의 목록(같은 도엽·레이어 조합은 한 번만 계산. 실패가 섞인 결과는 쥐지 않아 다음에 다시 읽는다) */
export const batchLayerSheets = (batch: SheetsBatch, tile: { map_id: string; corners: [number, number][] }, layers: DataLayerId[]) => {
    const key = `${tile.map_id}|${layers.join(",")}`
    let p = batch.tiles.get(key)
    if (!p) {
        const q = layerSheetsOfTile(tile.corners, layers, batch.memo)
        batch.tiles.set(key, q)
        void q.then((r) => {
            if (Object.values(r).some((s) => s && "error" in s) && batch.tiles.get(key) === q) batch.tiles.delete(key)
        })
        p = q
    }
    return p
}
