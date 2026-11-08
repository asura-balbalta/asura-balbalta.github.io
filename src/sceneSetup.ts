/**
 * 장면 설정 공용 모듈(docs/headless-check-plan.md H1-c, 2026-11-08). 앱(App·TerrainViewCanvas)과 헤드리스 검사(scripts/render-headless.mjs)가
 * **같은 함수**로 장면을 맞추도록, 주소 파라미터(RenderDebug)·품질 설정·색상표에서 도엽 스타일·카메라·조명·효과·레이어 보기를 정하는 코드와
 * 도엽 이벤트를 렌더러에 옮기는 처리기를 여기에 모았다. DOM·React 를 쓰지 않는다(Node 에서도 돈다). 앱 쪽은 순수 함수 추출만 했고 동작은 그대로다.
 *
 * 흐름(앱이 쓰는 순서):
 * - APP_INITIAL_*: App 의 처음 표현 방식·톤·층 간격
 * - tileStyleOf: 범위 선택·표현 방식 전환이 워커에 보내는 TileStyle(디버그 스위치 roads·water·forest·band·smoothfar 포함)
 * - rendererOptionsOf: 렌더러를 만들 때의 배경색·디버그 설정 / applyPalette·applyLayerVisibility: 색상표·레이어 보기를 렌더러에
 * - createTilesEventHandler: 도엽 집합 이벤트 → GPU 올리기·내리기·첫 도엽 궤도 카메라(initialCamera)·표고 범위·수면 맞추기
 * - 둘러보기: createWalkSampler(높이 조회) → walkSpawnPoint(시작점) → createPlayer(player.ts) / walkLightingOf·walkRadiusOf / residencyPlan·isOutsideResident(상주) /
 *   walkGroundAt·highlightListOf(조준점 건물 강조)
 */
import type { BuildingHit } from "./buildingPick"
import type { LayerStates } from "./layers"
import { LAYER_DEFS } from "./layers"
import type { QualitySettings, ScenePalette } from "./scenePalette"
import { createHeightSampler, HeightSampler, nearestTriangleCentroid } from "./terrainHeight"
import type { TerrainTilesClient, TerrainTilesEvent } from "./terrainTilesClient"
import type { ForestStyle, RoadsStyle, TileData, TileStyle, WaterStyle } from "./terrainTiles.worker"
import { hexToRgb, TERRAIN_THEMES, Theme } from "./terrainTheme"
import type { OrbitCamera } from "./webgpu/camera"
import type { createTerrainRenderFunctionAndUpdateFunctions, MeshBounds, RenderDebug, TerrainMode } from "./webgpu/terrainRenderer"
import { effectiveDebug, WALK_CULL_RADIUS, walkLighting } from "./webgpu/terrainRenderer"

/** 처음 보여 줄 지형 표현 방식. "tin": 삼각형 메쉬 그대로, "stepped": 등고선 모형처럼 계단형. 설정 패널·상태 표시줄에서 바꾼다 */
export const APP_INITIAL_TERRAIN_MODE: TerrainMode = "tin"
/** 처음 색 테마(지도 타일 + 3D + UI). 설정 패널·상태 표시줄에서 바꾼다 */
export const APP_INITIAL_THEME: Theme = "light"
/** 계단형일 때 처음 층 간격(m). 설정 패널에서 0.1 ~ 5 로 바꾼다 */
export const APP_INITIAL_STEP_INTERVAL = 1

/** 걸어 보기 도엽 스트리밍(선택 범위 밖): 로드 반경(m), 도엽 상한, 다시 조회하는 이동 거리(m) */
export const WALK_TILE_RADIUS = 1000
export const WALK_TILE_MAX = 60
export const WALK_TILE_UPDATE_M = 100
/** 상주 반경의 히스테리시스: 이 배수 밖으로 나가야 GPU 에서 내린다(경계에서 들락날락 방지) */
export const RESIDENT_HYSTERESIS = 1.2
/** 둘러보기 조준점의 건물 찾기 사거리(m). 처음 300 은 멀리 있는 건물에 조준경이 반응하지 않아 1 km 로(2026-10-15, by @nanangqq) */
export const PICK_RANGE_M = 1000

type Updaters = Awaited<ReturnType<typeof createTerrainRenderFunctionAndUpdateFunctions>>["updaters"]

// ---- 도엽 스타일 ----

/** 렌더 디버그 설정 중 도로 얹기 스위치(디버그 페이지 roadsclip=0·roadsbridge=0·roadslift=·stepmerge=0·liftfix=0)를 도엽 스타일로 */
export const roadsStyleOf = (debug?: RenderDebug): RoadsStyle | undefined =>
    debug && { clip: debug.roadsClip, bridge: debug.roadsBridge, lift: debug.roadsLift, merge: debug.roadsMerge, liftFix: debug.roadsLiftFix }
/** 렌더 디버그 설정 중 물 얹기 스위치(waterclip=0·waterz=·waterlines=0·waterlift=·waterwidth=)를 도엽 스타일로 */
export const waterStyleOf = (debug?: RenderDebug): WaterStyle | undefined =>
    debug && { clip: debug.waterClip, zMode: debug.waterZ, lines: debug.waterLines, lift: debug.waterLift, ribbonWidth: debug.waterWidth, levelQuantile: debug.waterQ }
/** 렌더 디버그 설정 중 산림 스위치(forest=0·forestres=)를 도엽 스타일로 */
export const forestStyleOf = (debug?: RenderDebug): ForestStyle | undefined => debug && { enabled: debug.forest, res: debug.forestRes }
/** 먼 거리 계단 부드럽게(품질 설정. 디버그 smoothfar= 가 우선) */
export const smoothFarOf = (debug: RenderDebug | undefined, quality: QualitySettings) => debug?.smoothFar ?? quality.smoothFar
/**
 * 도엽 스타일(범위 선택·표현 방식·층 간격 변경이 같이 쓴다. App nextTileStyle)
 *
 * @param mode 지형 표현 방식
 * @param step 계단형 층 간격(m)
 * @param debug 렌더 디버그 설정(디버그 페이지). 운영은 undefined
 * @param smoothFar 먼 거리 계단 부드럽게(smoothFarOf)
 */
export const tileStyleOf = (mode: TerrainMode, step: number, debug: RenderDebug | undefined, smoothFar: boolean): TileStyle => ({
    mode,
    step,
    band: debug?.band,
    roads: roadsStyleOf(debug),
    water: waterStyleOf(debug),
    forest: forestStyleOf(debug),
    smoothNormals: smoothFar,
})

// ---- 렌더러 설정 ----

/** 렌더러를 만들 때의 배경색(= 안개색)과 디버그 설정(품질 설정을 합친 것) */
export const rendererOptionsOf = (palette: ScenePalette, debug: RenderDebug | undefined, quality: QualitySettings) => ({
    backgroundColor: hexToRgb(palette.background),
    debug: effectiveDebug(debug, quality),
})
/** 색상표(색표·건물색·도로색·태양 고도)와 톤의 강조색, 배경색을 렌더러에 쓴다 */
export const applyPalette = (updaters: Pick<Updaters, "paletteUpdater" | "backgroundUpdater">, palette: ScenePalette, theme: Theme) => {
    updaters.paletteUpdater(palette, TERRAIN_THEMES[theme].ui.accent)
    updaters.backgroundUpdater(hexToRgb(palette.background))
}
/** 레이어별 보기를 렌더러에 쓴다 */
export const applyLayerVisibility = (updaters: Pick<Updaters, "layerVisibilityUpdater">, layers: LayerStates) => {
    for (const { id } of LAYER_DEFS) updaters.layerVisibilityUpdater(id, layers[id].visible)
}
/** 둘러보기 조명: 디버그 설정 + 품질 설정 + 색상표의 세기 */
export const walkLightingOf = (debug: RenderDebug | undefined, quality: QualitySettings, palette: ScenePalette) =>
    walkLighting(effectiveDebug(debug, quality), palette.walkLighting)
/** 둘러보기 보이는 거리(m): 디버그 walkradius= > 품질 설정(보이는 거리) > WALK_CULL_RADIUS. 그리는 반경이자 상주 반경의 기본값 */
export const walkRadiusOf = (debug: RenderDebug | undefined, quality: QualitySettings) => debug?.walkRadius ?? quality.walkRadius ?? WALK_CULL_RADIUS

// ---- 궤도 카메라 ----

/**
 * 메쉬 범위에 맞춘 초기 카메라를 만든다.
 * 메쉬 중심을 바라보고, 남쪽에서 약 34° 높이로 내려다보며, 메쉬 가로·세로 중 긴 쪽의 1.2배 거리에 둔다.
 *
 * @param bounds 정점 범위(선택 xy + 첫 도엽 z)
 * @returns 궤도 카메라 초기 상태
 */
export const initialCamera = ({ min, max }: MeshBounds): OrbitCamera => ({
    target: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    distance: Math.max(max[0] - min[0], max[1] - min[1]) * 1.2,
    azimuth: -Math.PI / 2,
    elevation: 0.6,
    fovY: Math.PI / 4,
})

// ---- 도엽 이벤트 → 렌더러 ----

/** 도엽을 GPU 에 올릴 때의 인자(streamTileUpdater) */
export const tileUploadOf = (tile: TileData) => ({
    terrain: tile.terrain,
    buildings: tile.buildings,
    roads: tile.roadChunks,
    water: tile.waterChunks,
    forest: tile.forestMask,
    mode: tile.mode,
    bounds: { min: [tile.bounds.min[0], tile.bounds.min[1]] as [number, number], max: [tile.bounds.max[0], tile.bounds.max[1]] as [number, number] },
})

/**
 * 도엽 집합 구독 처리기(TerrainViewCanvas 의 구독 effect 에서 뽑음): 도엽을 GPU 에 올리고 내린다. 새 선택의 첫 도엽에서 이전 도엽을 모두 내리고
 * 카메라를 맞춘다(걸어 보기 중이 아닐 때). 오류는 콘솔에 적고 삼킨다
 *
 * @param sink.updaters 렌더러 updater
 * @param sink.tiles 도엽 집합(terrainTilesClient)
 * @param sink.resident GPU 에 올라가 있는 도엽 id(처리기가 더하고 뺀다)
 * @param sink.getDebug 지금 렌더 디버그 설정(orbitZ·waterLift)
 * @param sink.isWalking 걸어 보기 중인지(첫 도엽에서 궤도 카메라를 맞추지 않는다)
 * @param sink.outsideResident 둘러보기 중 상주 반경 밖 선택 도엽인지(올리지 않는다)
 * @param sink.onOrbitCamera 첫 도엽에서 맞춘 궤도 카메라(부모가 들고 있다가 끌기·휠에 쓴다). 렌더러에는 처리기가 쓴다
 */
export const createTilesEventHandler = (sink: {
    updaters: Pick<Updaters, "streamTileUpdater" | "streamClearUpdater" | "cameraUpdater" | "waterTileUpdater" | "elevationRangeUpdater" | "residentStats">
    tiles: Pick<TerrainTilesClient, "stats" | "bounds" | "releaseTerrain" | "waterChunks">
    resident: Set<string>
    getDebug: () => RenderDebug | undefined
    isWalking: () => boolean
    outsideResident: (tile: TileData) => boolean
    onOrbitCamera: (camera: OrbitCamera) => void
}) => {
    const { updaters, tiles, resident } = sink
    let pendingClear = false
    return (event: TerrainTilesEvent) => {
        try {
            if (event.type === "selection") {
                pendingClear = true
            } else if (event.type === "tile") {
                // 메모리 측정(2026-10-15): 50개마다 GPU 상주 바이트
                if (tiles.stats().count % 50 === 0 || event.first) {
                    const r = updaters.residentStats()
                    console.log(`메모리(GPU 상주): 도엽 ${r.tiles}, ${(r.bytes / 1048576).toFixed(1)} MB`)
                }
                if (pendingClear) {
                    pendingClear = false
                    updaters.streamClearUpdater()
                    resident.clear()
                    if (!sink.isWalking() && tiles.bounds) {
                        // 카메라는 선택 도엽의 xy 범위와 **첫 도엽**의 z 범위로. 누적 z 범위를 쓰면 캔버스가 붙는 순간까지 도착한 도엽 수에
                        // 따라 높이가 달라져 같은 주소라도 캡처가 미세하게 달랐다(2026-10-14 L2 비교에서 발견)
                        // 디버그 orbitz= 가 있으면 그 높이로 고정한다(5K 가 여럿이면 첫 도엽이 보조 워커 경쟁으로 실행마다 달라서. 2026-10-23)
                        const xy = tiles.bounds
                        const zMin = sink.getDebug()?.orbitZ ?? event.tile.bounds.min[2]
                        const zMax = sink.getDebug()?.orbitZ ?? event.tile.bounds.max[2]
                        const camera = initialCamera({ min: [xy.min[0], xy.min[1], zMin], max: [xy.max[0], xy.max[1], zMax] })
                        sink.onOrbitCamera(camera)
                        updaters.cameraUpdater(camera)
                    }
                }
                if (event.tile.terrain.length > 0 && sink.outsideResident(event.tile)) {
                    // 둘러보기 중 상주 반경 밖 선택 도엽(표현 방식 전환으로 다시 온 것)은 올리지 않는다. 반경에 들어오면 rebuild 로 다시 온다
                    tiles.releaseTerrain(event.tile.id)
                } else if (event.tile.terrain.length > 0) {
                    updaters.streamTileUpdater(event.tile.id, tileUploadOf(event.tile))
                    resident.add(event.tile.id)
                    // GPU 에 올렸으면 메인 사본의 조각은 버린다(메모리 M-A). 조각이 없는 도엽(되풀이)은 워커가 다시 만들어 보낸다
                    tiles.releaseTerrain(event.tile.id)
                }
            } else if (event.type === "water") {
                // 수면 맞추기로 물 메쉬가 바뀐 도엽: GPU 에 있는 것만 물 조각을 다시 올린다
                for (const id of event.ids) {
                    if (resident.has(id)) updaters.waterTileUpdater(id, tiles.waterChunks(id, sink.getDebug()?.waterLift))
                }
            } else if (event.type === "remove") {
                updaters.streamTileUpdater(event.id, null)
                resident.delete(event.id)
            } else if (event.type === "bounds") {
                updaters.elevationRangeUpdater(event.bounds.min[2], event.bounds.max[2])
            }
        } catch (err) {
            console.error(err)
        }
    }
}

// ---- 둘러보기 ----

/** 둘러보기 중 GPU 에 올려 둘 반경(m). 디버그 resident= 가 없으면 보이는 거리(walkRadiusOf)와 같다. Infinity 면 내리지 않음 */
export const residentRadiusOf = (debug: RenderDebug | undefined, quality: QualitySettings) => debug?.residentRadius ?? walkRadiusOf(debug, quality)
/** 점(로컬 m)에서 도엽 xy 범위까지의 거리(안이면 0) */
export const distanceToTile = (center: [number, number], tile: Pick<TileData, "bounds">) => {
    const b = tile.bounds
    return Math.hypot(Math.max(b.min[0] - center[0], 0, center[0] - b.max[0]), Math.max(b.min[1] - center[1], 0, center[1] - b.max[1]))
}
/**
 * 둘러보기 중 선택 도엽이 상주 반경(× 히스테리시스) 밖인지. 밖 도엽(extra)은 조정자가 관리하므로 false
 *
 * @param eye 지금 1인칭 카메라 눈의 xy(없으면 false)
 * @param radius 상주 반경(둘러보기 중이 아니면 Infinity → false)
 */
export const isOutsideResident = (tile: TileData, eye: [number, number] | null, radius: number) => {
    if (tile.extra || !eye || !Number.isFinite(radius)) return false
    return distanceToTile(eye, tile) > radius * RESIDENT_HYSTERESIS
}
/**
 * 둘러보기 중 상주 반경에 맞춰 GPU 에서 내릴 선택 도엽(반경 × RESIDENT_HYSTERESIS 밖)과 워커에 다시 요청할 도엽(반경 안인데 GPU 에 없음).
 * 밖 도엽(extra)은 조정자가 반경으로 관리하므로 건드리지 않는다
 *
 * @param center 플레이어 위치(메쉬 로컬 m)
 * @param radius 상주 반경(m, 유한)
 */
export const residencyPlan = (tiles: Iterable<TileData>, resident: Set<string>, center: [number, number], radius: number) => {
    const drop: string[] = []
    const wanted: string[] = []
    for (const tile of tiles) {
        if (tile.extra) continue
        const d = distanceToTile(center, tile)
        if (resident.has(tile.id)) {
            if (d > radius * RESIDENT_HYSTERESIS) drop.push(tile.id)
        } else if (d <= radius) {
            wanted.push(tile.id)
        }
    }
    return { drop, wanted }
}
/** 렌더러 강조 목록: 고정한 건물 + 조준점 건물(같은 건물이면 하나) */
export const highlightListOf = (locked: BuildingHit | null, looked: BuildingHit | null) => {
    const list: { tileId: string; faceStart: number; faceEnd: number }[] = []
    if (locked) list.push({ tileId: locked.tileId, faceStart: locked.faceStart, faceEnd: locked.faceEnd })
    if (looked && !(locked && looked.tileId === locked.tileId && looked.index === locked.index))
        list.push({ tileId: looked.tileId, faceStart: looked.faceStart, faceEnd: looked.faceEnd })
    return list
}

/** 걸어 보기 시작 상태(디버그 페이지 프리셋). 없는 항목은 기본 규칙(범위 가운데, 북쪽, 수평) */
export type WalkStart = {
    /** 시작 xy(메쉬 로컬, m). 거기에 메쉬가 없으면 가장 가까운 삼각형 위로 */
    spawn?: [number, number]
    /** 시작 방향(라디안. 0 = 동쪽, 반시계) */
    yaw?: number
    /** 시작 위아래 시점(라디안, 수평선 위로 +) */
    pitch?: number
    /** 지표 위 이 높이(m)에서 공중 정지한 채 시작(player.ts hoverHeight) */
    hover?: number
}

/**
 * 둘러보기 높이 조회: 모든 도엽(선택 + 스트리밍)의 TIN 과 건물 지붕. 도엽마다 조회기를 한 번 만들어 둔다(도엽 객체가 바뀌면 다시).
 * refit 은 도엽이 오갈 때 범위를 다시 잰다(플레이어가 매 프레임 읽어 범위 밖으로 못 나가게)
 *
 * @param tiles 도엽 집합
 * @param selectionBounds 선택 도엽 범위(처음 범위)
 */
export const createWalkSampler = (tiles: Pick<TerrainTilesClient, "tiles">, selectionBounds: MeshBounds) => {
    const samplerCache = new WeakMap<TileData, { ground: HeightSampler; roof: HeightSampler | null }>()
    const samplersOf = (tile: TileData) => {
        let s = samplerCache.get(tile)
        if (!s) {
            s = {
                ground: createHeightSampler(tile.tin),
                roof: tile.buildings ? createHeightSampler(tile.buildings, { highest: true }) : null,
            }
            samplerCache.set(tile, s)
        }
        return s
    }
    const inTile = (tile: TileData, x: number, y: number) =>
        x >= tile.bounds.min[0] && x <= tile.bounds.max[0] && y >= tile.bounds.min[1] && y <= tile.bounds.max[1]
    const combined: HeightSampler = {
        heightAt: (x, y) => {
            for (const tile of tiles.tiles.values()) {
                if (!inTile(tile, x, y)) continue
                const h = samplersOf(tile).ground.heightAt(x, y)
                if (h !== null) return h
            }
            return null
        },
        roofAt: (x, y) => {
            let best: number | null = null
            for (const tile of tiles.tiles.values()) {
                if (!inTile(tile, x, y)) continue
                const roof = samplersOf(tile).roof
                if (!roof) continue
                const h = roof.heightAt(x, y)
                if (h !== null && (best === null || h > best)) best = h
            }
            return best
        },
        min: [...selectionBounds.min],
        max: [...selectionBounds.max],
    }
    const refit = () => {
        const mn: [number, number, number] = [Infinity, Infinity, Infinity]
        const mx: [number, number, number] = [-Infinity, -Infinity, -Infinity]
        for (const tile of tiles.tiles.values()) {
            for (let k = 0; k < 3; k++) {
                mn[k] = Math.min(mn[k], tile.bounds.min[k])
                mx[k] = Math.max(mx[k], tile.bounds.max[k])
            }
        }
        if (mn[0] !== Infinity) {
            combined.min = mn
            combined.max = mx
        }
    }
    return { combined, refit }
}

/**
 * 둘러보기 시작점: 프리셋(디버그 페이지)이 있으면 그 자리, 아니면 선택 사각형 가운데. 거기에 메쉬가 없으면(도엽 없는 바다 등) 가장 가까운 삼각형 위로
 *
 * @returns 시작 xy(메쉬 로컬 m)
 */
export const walkSpawnPoint = (
    tiles: Pick<TerrainTilesClient, "tiles" | "selectionCenter">,
    start: WalkStart | undefined,
    selectionBounds: MeshBounds,
    combined: HeightSampler,
): [number, number] => {
    const center: [number, number] = start?.spawn ??
        tiles.selectionCenter ?? [(selectionBounds.min[0] + selectionBounds.max[0]) / 2, (selectionBounds.min[1] + selectionBounds.max[1]) / 2]
    let spawn = center
    if (combined.heightAt(center[0], center[1]) === null) {
        let bestDist = Infinity
        for (const tile of tiles.tiles.values()) {
            const c = nearestTriangleCentroid(tile.tin, center[0], center[1])
            if (!c) continue
            const d = Math.hypot(c[0] - center[0], c[1] - center[1])
            if (d < bestDist) {
                bestDist = d
                spawn = c
            }
        }
    }
    return spawn
}

/**
 * 조준점 건물 찾기의 지표 높이. 지형이 가로막은 건물은 고르지 않도록 지표 높이를 넘긴다. 계단형이면 그려진 면은 층 바닥(floor(z / step) · step)이라
 * 매끈한 TIN 보다 낮다. TIN 그대로 쓰면 계단 윗면을 스치는 시선이 "지형에 막힘" 으로 잘못 걸린다(플레이어 발 높이와 같은 규칙)
 *
 * @param combined 둘러보기 높이 조회(createWalkSampler)
 * @param step 계단형이면 층 간격, 아니면 null
 */
export const walkGroundAt = (combined: HeightSampler, step: number | null) => (x: number, y: number) => {
    const g = combined.heightAt(x, y)
    return g === null || step === null ? g : Math.floor(g / step) * step
}
