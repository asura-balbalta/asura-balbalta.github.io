/**
 * 헤드리스 검사(scripts/render-headless.mjs, docs/headless-check-plan.md H1-c)의 장면 준비. render-headless.mjs 가 esbuild 로 Node 용으로 묶어
 * 메인 스레드에서 돌린다. 앱의 디버그 페이지(#/debug/walk?…)가 빈 프로필로 열렸을 때와 같은 순서로, **앱과 같은 함수**(src/sceneSetup.ts·
 * src/debug/walkParams.ts·src/terrainTilesClient.ts·src/player.ts·src/buildingPick.ts)를 불러 장면을 준비하고, 렌더러에 하는 updater 호출을
 * 기록한다(기록 = 덤프. 그리기는 render-headless.mjs 가 Dawn 렌더러에 같은 호출을 되풀이한다).
 *
 * 앱과 같은 순서(App · TerrainViewCanvas):
 * 1. 주소 → parseWalkParams(프리셋·렌더 디버그). 색상표·품질은 빈 localStorage 의 usePalettes 와 같게 내장 라이트·sanitizeQuality(null)
 * 2. select(bbox, tileStyleOf(tin…)) — 지도의 범위 확정(squareTool.confirm → startTerrainLoad)
 * 3. 첫 도엽이 오면 캔버스가 붙는다(App 은 terrain 이 생긴 뒤 TerrainViewCanvas 를 그린다) → 렌더러 생성 옵션(rendererOptionsOf)과 effect 순서대로
 *    강조 비움 → 색상표 → 레이어 보기 → 도엽 구독(createTilesEventHandler. 이미 온 도엽은 subscribe 가 되풀이) → 디버그 설정 → 층 간격
 * 4. done → walk 이면 startWalking: setStyle(stepped) → 둘러보기 effect: createWalkSampler·walkSpawnPoint → updateWalk(반경 1 km) →
 *    residencyPlan → createPlayer → 조명·거리 거르기
 * 5. 조정자가 쉬고(memory: running false·pending 0) 도엽 이벤트가 settle ms 동안 없으면 끝(수면 맞추기 400 ms 타이머 포함) →
 *    플레이어 step 으로 1인칭 카메라 → 조준점 건물 강조(createBuildingPicker · walkGroundAt · highlightListOf)
 * 렌더러 호출 기록은 마지막 상태가 같도록 줄인다(같은 도엽을 나중에 다시 올리거나 비우면 앞의 올리기는 지운다. 렌더러가 교체 때 지우고 다시 넣으므로
 * 그리는 순서도 같다)
 */
import { createBuildingPicker } from "../../src/buildingPick"
import { parseWalkParams } from "../../src/debug/walkParams"
import { INITIAL_LAYER_STATES } from "../../src/layers"
import { createPlayer, DEFAULT_WALK_PHYSICS } from "../../src/player"
import { builtinPalette, sanitizeQuality } from "../../src/scenePalette"
import {
    APP_INITIAL_STEP_INTERVAL,
    APP_INITIAL_TERRAIN_MODE,
    APP_INITIAL_THEME,
    applyLayerVisibility,
    applyPalette,
    createTilesEventHandler,
    createWalkSampler,
    highlightListOf,
    isOutsideResident,
    PICK_RANGE_M,
    rendererOptionsOf,
    residencyPlan,
    residentRadiusOf,
    smoothFarOf,
    tileStyleOf,
    WALK_TILE_MAX,
    WALK_TILE_RADIUS,
    walkGroundAt,
    walkLightingOf,
    walkRadiusOf,
    walkSpawnPoint,
} from "../../src/sceneSetup"
import { createTerrainTiles, TerrainTilesEvent } from "../../src/terrainTilesClient"
import { fpsForward, FpsCamera, OrbitCamera } from "../../src/webgpu/camera"
import type { TileData } from "../../src/terrainTiles.worker"

/** 렌더러 updater 호출 하나: [이름, 인자] */
export type Call = [string, unknown[]]

export type SceneRun = {
    /** 렌더러 생성 옵션(width·height 는 그리는 쪽이 정한다) */
    create: ReturnType<typeof rendererOptionsOf>
    /** 줄인 updater 호출(되풀이하면 앱의 마지막 상태) */
    calls: Call[]
    info: {
        walk: boolean
        tiles: number
        extra: number
        uploads: number
        callsRaw: number
        spawn: [number, number] | null
        camera: FpsCamera | OrbitCamera | null
        highlight: string | null
        firstTile: string | null
        events: Record<string, number>
        ms: { select: number; walk: number; total: number }
        notes: string[]
    }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** updater 호출을 마지막 상태가 같은 최소 목록으로: 나중에 같은 도엽을 올리거나(streamTileUpdater) 모두 비우면(streamClearUpdater) 앞의 도엽 호출은 지운다 */
const compact = (calls: Call[]): Call[] => {
    const keep = calls.map(() => true)
    const lastTile = new Map<string, number>()
    let lastClear = -1
    calls.forEach(([name, args], i) => {
        if (name === "streamClearUpdater") lastClear = i
        if (name === "streamTileUpdater") lastTile.set(args[0] as string, i)
    })
    calls.forEach(([name, args], i) => {
        const tileCall = name === "streamTileUpdater" || name === "waterTileUpdater"
        if (!tileCall && name !== "streamClearUpdater") return
        if (name === "streamClearUpdater") keep[i] = i === lastClear
        else if (i < lastClear) keep[i] = false
        else if ((lastTile.get(args[0] as string) ?? -1) > i) keep[i] = false
    })
    return calls.filter((_, i) => keep[i])
}

/**
 * 장면 하나를 준비하고 렌더러 호출을 기록한다.
 *
 * @param query 디버그 페이지 해시 쿼리(verify-scenes.json params 를 펼친 것. lock=0·look=0 은 render-check 처럼 붙인다)
 * @param opts.settle 조정자가 쉰 뒤 도엽 이벤트가 이만큼(ms) 없으면 끝(수면 맞추기 타이머 400 ms 보다 길게)
 * @param opts.timeout 이보다 오래 걸리면 실패
 * @param opts.log 진행 출력
 */
export const runScene = async (query: string, opts: { settle?: number; timeout?: number; log?: (s: string) => void } = {}): Promise<SceneRun> => {
    const settle = opts.settle ?? 700
    const timeout = opts.timeout ?? 180000
    const log = opts.log ?? (() => {})
    const t0 = performance.now()
    const q = new URLSearchParams(query)
    if (!q.has("lock")) q.set("lock", "0")
    if (!q.has("look")) q.set("look", "0")
    const { preset, renderDebug, notes } = parseWalkParams(q)
    if (!preset.bbox) throw new Error(`bbox 가 없습니다: ${query}`)
    // 빈 프로필의 usePalettes: 저장된 선택이 없으면 처음 톤의 내장 색상표, 품질은 기본값
    const palette = builtinPalette(APP_INITIAL_THEME)
    const theme = palette.tone
    const quality = sanitizeQuality(null)
    let mode = APP_INITIAL_TERRAIN_MODE
    const stepInterval = APP_INITIAL_STEP_INTERVAL
    const layers = INITIAL_LAYER_STATES
    const smoothFar = smoothFarOf(renderDebug, quality)

    const raw: Call[] = []
    const record = (name: string) => (...args: unknown[]) => {
        raw.push([name, structuredClone(args)])
    }
    // 렌더러 updater 기록기. residentStats 는 앱이 콘솔 출력에만 쓴다
    const updaters = new Proxy({} as Record<string, (...a: unknown[]) => unknown>, {
        get: (_, name: string) => (name === "residentStats" ? () => ({ tiles: 0, bytes: 0 }) : record(name)),
    }) as never

    const tiles = createTerrainTiles()
    const events: Record<string, number> = {}
    let lastEventAt = performance.now()
    let done = false
    let errorMessage: string | null = null
    let firstTile: string | null = null
    let attached = false
    const resident = new Set<string>()
    let walkCamera: FpsCamera | null = null
    let walking = false
    let orbitCamera: OrbitCamera | null = null

    /** 3) 캔버스가 붙음: 렌더러 effect 순서대로 */
    const attachCanvas = () => {
        attached = true
        updaters.highlightUpdater?.([])
        applyPalette(updaters, palette, theme)
        applyLayerVisibility(updaters, layers)
        tiles.subscribe(
            createTilesEventHandler({
                updaters,
                tiles,
                resident,
                getDebug: () => renderDebug,
                isWalking: () => walking,
                outsideResident: (tile: TileData) =>
                    isOutsideResident(tile, walkCamera ? [walkCamera.eye[0], walkCamera.eye[1]] : null, walking ? residentRadiusOf(renderDebug, quality) : Infinity),
                onOrbitCamera: (camera) => {
                    orbitCamera = camera
                },
            }),
        )
        ;(updaters as Record<string, (...a: unknown[]) => void>).debugUpdater(rendererOptionsOf(palette, renderDebug, quality).debug)
        ;(updaters as Record<string, (...a: unknown[]) => void>).stepIntervalUpdater(stepInterval)
    }
    tiles.subscribe((event: TerrainTilesEvent) => {
        events[event.type] = (events[event.type] ?? 0) + 1
        lastEventAt = performance.now()
        if (event.type === "tile" && event.first) firstTile = event.tile.id
        // App 은 첫 도엽(terrain 상태)이 생긴 뒤 캔버스를 그리고, 렌더러는 비동기로 만들어진다. 붙는 순간까지 온 도엽은 subscribe 가 되풀이한다
        if (event.type === "tile" && !attached) setTimeout(attachCanvas, 0)
        if (event.type === "done") done = true
        if (event.type === "error") errorMessage = event.message
    })

    // 2) 범위 확정
    tiles.select(preset.bbox, tileStyleOf(mode, stepInterval, renderDebug, smoothFar))
    const waitFor = async (cond: () => boolean, what: string) => {
        while (!cond()) {
            if (errorMessage) throw new Error(`도엽 오류: ${errorMessage}`)
            if (performance.now() - t0 > timeout) throw new Error(`시간 초과(${what})`)
            await sleep(20)
        }
    }
    await waitFor(() => done && attached, "선택 도엽")
    const selectMs = performance.now() - t0
    log(`선택 도엽 ${tiles.tiles.size}개 ${Math.round(selectMs)} ms`)

    // 4) 둘러보기 진입(startWalking → 계단형, TerrainViewCanvas 둘러보기 effect)
    let spawn: [number, number] | null = null
    let player: ReturnType<typeof createPlayer> | null = null
    let combinedSampler: ReturnType<typeof createWalkSampler>["combined"] | null = null
    const tWalk = performance.now()
    if (preset.walk) {
        if (mode !== "stepped") {
            mode = "stepped"
            tiles.setStyle(tileStyleOf(mode, stepInterval, renderDebug, smoothFar))
        }
        const origin = tiles.origin!
        const selectionBounds = tiles.bounds!
        const { combined, refit } = createWalkSampler(tiles, selectionBounds)
        combinedSampler = combined
        refit()
        tiles.subscribe((event) => {
            if (event.type === "tile" || event.type === "remove") refit()
        })
        const start = { spawn: preset.spawn, yaw: preset.yaw, pitch: preset.pitch, hover: preset.hover }
        spawn = walkSpawnPoint(tiles, start, selectionBounds, combined)
        tiles.updateWalk([spawn[0] + origin[0], spawn[1] + origin[1]], WALK_TILE_RADIUS, WALK_TILE_MAX)
        const radius = residentRadiusOf(renderDebug, quality)
        if (Number.isFinite(radius)) {
            const plan = residencyPlan(tiles.tiles.values(), resident, spawn, radius)
            for (const id of plan.drop) {
                ;(updaters as Record<string, (...a: unknown[]) => void>).streamTileUpdater(id, null)
                resident.delete(id)
            }
            tiles.rebuild(plan.wanted)
            if (plan.drop.length || plan.wanted.length) notes.push(`상주 시작: 내림 ${plan.drop.length}, 다시 요청 ${plan.wanted.length}`)
        }
        player = createPlayer({
            sampler: combined,
            spawn,
            yaw: start.yaw,
            pitch: start.pitch,
            pointerLock: renderDebug.pointerLock !== false,
            mouseLook: renderDebug.mouseLook !== false,
            physics: DEFAULT_WALK_PHYSICS,
            groundStep: mode === "stepped" ? stepInterval : null,
            hoverHeight: start.hover,
        })
        walking = true
        ;(updaters as Record<string, (...a: unknown[]) => void>).lightingUpdater(walkLightingOf(renderDebug, quality, palette))
        ;(updaters as Record<string, (...a: unknown[]) => void>).cullRadiusUpdater(walkRadiusOf(renderDebug, quality))
        // 렌더 루프의 첫 프레임 카메라(상주 판정이 눈 위치를 쓴다)
        walkCamera = player.step(1 / 60)
        ;(updaters as Record<string, (...a: unknown[]) => void>).cameraUpdater(walkCamera)
    }

    // 5) 쉼: 조정자 running false·pending 0 을 두 번(그 사이 이벤트 없음) + 마지막 이벤트 뒤 settle ms
    let idleSince: number | null = null
    for (;;) {
        if (errorMessage) throw new Error(`도엽 오류: ${errorMessage}`)
        if (performance.now() - t0 > timeout) throw new Error("시간 초과(쉼 대기)")
        const before = lastEventAt
        const m = await tiles.workerMemory()
        const idle = !m.coordinator.running && m.coordinator.pending === 0 && before === lastEventAt
        if (idle && performance.now() - lastEventAt >= settle) {
            if (idleSince !== null) break
            idleSince = performance.now()
        } else idleSince = null
        await sleep(100)
    }
    const walkMs = performance.now() - tWalk

    let highlight: string | null = null
    if (player && combinedSampler) {
        // 렌더 루프: 플레이어를 몇 프레임 진행(서 있으면 카메라가 그대로) → 조준점 건물 강조(10 Hz 타이머의 마지막 값)
        for (let i = 0; i < 3; i++) walkCamera = player.step(1 / 60)
        ;(updaters as Record<string, (...a: unknown[]) => void>).cameraUpdater(walkCamera)
        const picker = createBuildingPicker()
        const cam = walkCamera!
        const hit = renderDebug.pick === false ? null : picker.pick(tiles.tiles.values(), cam.eye, fpsForward(cam), PICK_RANGE_M, walkGroundAt(combinedSampler, mode === "stepped" ? stepInterval : null))
        highlight = hit ? `${hit.tileId}#${hit.index}` : null
        ;(updaters as Record<string, (...a: unknown[]) => void>).highlightUpdater(highlightListOf(null, hit))
    }
    const calls = compact(raw)
    const extra = [...tiles.tiles.values()].filter((t) => t.extra).length
    const info = {
        walk: !!preset.walk,
        tiles: tiles.tiles.size,
        extra,
        uploads: calls.filter(([n, a]) => n === "streamTileUpdater" && a[1] !== null).length,
        callsRaw: raw.length,
        spawn,
        camera: walkCamera ?? orbitCamera,
        highlight,
        firstTile,
        events,
        ms: { select: Math.round(selectMs), walk: Math.round(walkMs), total: Math.round(performance.now() - t0) },
        notes,
    }
    tiles.terminate()
    return { create: rendererOptionsOf(palette, renderDebug, quality), calls, info }
}
