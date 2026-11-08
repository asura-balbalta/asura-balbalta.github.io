import React, { useEffect, useId, useRef, useState } from "react"

import { INITIAL_LAYER_STATES, LayerStates } from "../layers"
import { createPlayer, Player, PlayerMove, WalkPhysics } from "../player"
import type { TerrainTilesClient } from "../terrainTilesClient"
import type { TileData } from "../terrainTiles.worker"
import { builtinPalette, DEFAULT_QUALITY, QualitySettings, ScenePalette } from "../scenePalette"
import { Theme } from "../terrainTheme"
import { FpsCamera, fpsForward, OrbitCamera } from "../webgpu/camera"
import { BuildingHit, createBuildingPicker } from "../buildingPick"
import {
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
    WALK_TILE_MAX,
    WALK_TILE_RADIUS,
    WALK_TILE_UPDATE_M,
    walkGroundAt,
    walkLightingOf,
    walkRadiusOf,
    WalkStart,
    walkSpawnPoint,
} from "../sceneSetup"
import {
    createTerrainRenderFunctionAndUpdateFunctions,
    DEFAULT_LIGHTING,
    effectiveDebug,
    RenderDebug,
    TerrainMode,
} from "../webgpu/terrainRenderer"

/** 창 크기와 devicePixelRatio. canvas 속성은 width·height × dpr, style 은 width·height */
const readViewportSize = () => ({
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
})

type TRenderer = Awaited<
    ReturnType<typeof createTerrainRenderFunctionAndUpdateFunctions>
>

/** 걸어 보기 시작 상태(디버그 페이지 프리셋). 정의는 장면 설정 공용 모듈(sceneSetup.ts) */
export type { WalkStart }

/** 디버그 페이지 훅(src/debug/hooks.ts, 계획서 19절)이 쓰는 캔버스 손잡이. teleport 는 둘러보기 중이 아니면 false */
export type CanvasDebug = { teleport: (x: number, y: number) => boolean; gpu: () => { tiles: number; bytes: number } | null }

/**
 * 3D 지형을 전체화면 canvas 에 그리는 컴포넌트.
 *
 * - 마운트할 때 렌더러(WebGPU device, 파이프라인)를 한 번 만들고 requestAnimationFrame 루프를 돌린다.
 *   언마운트하면 루프를 멈추고 device 를 해제한다.
 * - 지형은 도엽 집합(terrainTilesClient)을 구독해 올린다(2026-10-14 L1. 전에는 mesh 하나를 통째로·조각으로 받았다).
 *   새 선택(selection)이 오면 첫 도엽이 올라올 때 이전 도엽을 모두 내리고 카메라를 선택 범위에 맞춘다. 그때까지는 이전 지형이
 *   그대로 보인다. 도엽(tile)은 바로 GPU 에 올리고(교체 포함), remove 는 내린다. bounds 는 표고 색 범위.
 *   표현 방식·층 간격 전환은 부모가 client.setStyle 로 하고, 도엽이 새 조각으로 교체되어 들어온다(카메라는 그대로).
 * - layers 가 바뀌면 레이어별 보이기만 바꾼다(layerVisibilityUpdater).
 * - theme 이 바뀌면 표고 색표·건물색과 배경색 uniform 만 다시 쓴다.
 * - 드래그: 회전(좌우 = azimuth, 상하 = elevation), 휠·트랙패드 핀치·두 손가락: 확대·축소(distance)
 *
 * @param props.tiles 지형 도엽 집합(앱이 평생 하나 든다)
 * @param props.layers 레이어별 보이기 상태
 * @param props.mode 지형 표현 방식(걸어 보기 발 높이를 층 바닥에 맞출지 정하는 데만 쓴다. 그리기는 도엽이 들고 온 모드)
 * @param props.stepInterval stepped 모드의 층 간격(m)
 * @param props.theme 색 테마(terrainTheme). 기본 "light"
 * @param props.hidden true 면 캔버스를 보이지 않게 한다(지도 화면으로 돌아갔을 때). 렌더러·도엽은 그대로라 다시 보이면 즉시 그려진다
 * @param props.walking 걸어 보기(1인칭, player.ts). 켜지면 포인터 잠금을 요청하고 렌더 루프가 프레임마다 플레이어를 진행해
 *   1인칭 카메라를 쓴다. 끌어서 회전·휠 확대는 그동안 막고, 캔버스 클릭은 다시 포커스(잠금)가 된다. 꺼지면 직전 궤도 카메라로 돌아간다.
 *   발 높이는 모든 도엽(선택 + 스트리밍)의 TIN 과 건물 지붕에서 찾고, 선택 범위 밖은 client 가 반경 안 도엽을 스트리밍한다
 * @param props.walkFocused 포커스(포인터 잠금) 중인지. 커서를 숨긴다
 * @param props.onWalkMove 플레이어 위치가 바뀔 때(약 10 Hz, 미니맵·상태 표시줄용)
 * @param props.onWalkFocusChange 포커스가 잡히거나 풀렸을 때(Esc 등). 부모가 안내 문구를 바꾼다
 * @param props.walkPhysics 걸어 보기 물리 값(중력·속도·점프·대시). 바뀌면 바로 플레이어에 반영
 * @param props.onWalkFrameTime 걸어 보기 중 프레임 간격(ms, 최근 평균)을 0.5초마다. rAF 간격이라 GPU 가 병목이면 그만큼 늘어난다
 * @param props.onWalkTileCount 스트리밍으로 들고 있는 선택 범위 밖 도엽 수가 바뀔 때
 * @param props.renderDebug 렌더 디버그 설정(디버그 페이지). 둘러보기 조명(SSAO·그림자·하늘·외곽선)·태양 고도·AO 디버그 출력·잠금 흉내.
 *   바뀌면 새로고침 없이 반영된다(렌더러 debugUpdater + 걸어 보기 중이면 조명 다시 쓰기). 운영은 undefined
 * @param props.walkStart 걸어 보기 시작점·yaw·pitch(디버그 페이지 프리셋). 들어갈 때 한 번 읽는다
 * @param props.onError 렌더러를 만들지 못했을 때(WebGPU 미지원·어댑터 없음 등). 부모가 토스트로 알리고 busy 를 푼다
 * @param props.onBuildingLook 걸어 보기 중 조준점이 가리키는 건물이 바뀔 때(buildingPick.ts, 10 Hz. 없으면 null). 강조는 렌더러가 직접
 * @param props.onBuildingPin 포커스 중 클릭했을 때 그 건물(없는 곳을 클릭하면 null). 걸어 보기에서 나가면 null
 * @param props.onBuildingLock 포커스 중 더블클릭(350 ms 안 두 번)했을 때. 부모가 펼친 정보의 고정을 켠다
 * @param props.lockedBuilding 더블클릭으로 고정한 건물(부모 상태). 조준점이 어디를 봐도 이 건물은 계속 강조한다
 * @param props.debugRef 디버그 페이지 훅에 줄 손잡이(순간 이동·GPU 상주)를 채울 곳. 운영은 없음
 */
export const TerrainViewCanvas = ({
    tiles,
    layers = INITIAL_LAYER_STATES,
    mode = "tin",
    stepInterval = 1,
    theme = "light",
    palette = builtinPalette(theme),
    quality = DEFAULT_QUALITY,
    hidden = false,
    walking = false,
    walkFocused = false,
    onWalkMove,
    onWalkFocusChange,
    walkPhysics,
    onWalkFrameTime,
    onWalkTileCount,
    renderDebug,
    walkStart,
    onError,
    onBuildingLook,
    onBuildingPin,
    onBuildingLock,
    lockedBuilding = null,
    debugRef,
}: {
    tiles: TerrainTilesClient
    layers?: LayerStates
    mode?: TerrainMode
    stepInterval?: number
    theme?: Theme
    /** 장면 색상표(scenePalette). 기본은 톤의 내장 색상표. 바뀌면 uniform 만 다시 쓴다 */
    palette?: ScenePalette
    /** 품질 설정(그림자·SSAO·하늘·외곽선·먼 거리 계단 부드럽게). 둘러보기 조명과 렌더 디버그 설정에 합친다(effectiveDebug) */
    quality?: QualitySettings
    hidden?: boolean
    walking?: boolean
    walkFocused?: boolean
    onWalkMove?: (move: PlayerMove) => void
    onWalkFocusChange?: (focused: boolean) => void
    walkPhysics?: Partial<WalkPhysics>
    onWalkFrameTime?: (ms: number) => void
    onWalkTileCount?: (count: number) => void
    renderDebug?: RenderDebug
    walkStart?: WalkStart
    onError?: (err: Error) => void
    onBuildingLook?: (hit: BuildingHit | null) => void
    onBuildingPin?: (hit: BuildingHit | null) => void
    onBuildingLock?: () => void
    lockedBuilding?: BuildingHit | null
    debugRef?: React.RefObject<CanvasDebug | null>
}) => {
    // 콜백이 렌더마다 새로 만들어져도 effect 를 다시 돌리지 않도록 ref 로 받는다
    const onWalkMoveRef = useRef(onWalkMove)
    onWalkMoveRef.current = onWalkMove
    const onWalkFocusChangeRef = useRef(onWalkFocusChange)
    onWalkFocusChangeRef.current = onWalkFocusChange
    const onWalkFrameTimeRef = useRef(onWalkFrameTime)
    onWalkFrameTimeRef.current = onWalkFrameTime
    const onWalkTileCountRef = useRef(onWalkTileCount)
    onWalkTileCountRef.current = onWalkTileCount
    const renderDebugRef = useRef(renderDebug)
    renderDebugRef.current = renderDebug
    const paletteRef = useRef(palette)
    paletteRef.current = palette
    const qualityRef = useRef(quality)
    qualityRef.current = quality
    /** 둘러보기 조명: 디버그 설정 + 품질 설정 + 색상표의 세기 */
    const currentWalkLighting = () => walkLightingOf(renderDebugRef.current, qualityRef.current, paletteRef.current)
    const onErrorRef = useRef(onError)
    onErrorRef.current = onError
    const onBuildingLookRef = useRef(onBuildingLook)
    onBuildingLookRef.current = onBuildingLook
    const onBuildingPinRef = useRef(onBuildingPin)
    onBuildingPinRef.current = onBuildingPin
    const onBuildingLockRef = useRef(onBuildingLock)
    onBuildingLockRef.current = onBuildingLock
    /** 걸어 보기 중 마지막 클릭 시각(더블클릭 판정용). 포인터 잠금 중엔 dblclick 이벤트에 기대지 않고 pointerdown 간격으로 본다 */
    const lastWalkClickRef = useRef(0)
    /** 걸어 보기 중 마지막 프레임의 1인칭 카메라(조준점 건물 찾기가 눈·시선으로 쓴다) */
    const walkCameraRef = useRef<FpsCamera | null>(null)
    /** 지금 조준점이 가리키는 건물(클릭하면 이것을 고정한다) */
    const lookedRef = useRef<BuildingHit | null>(null)
    const walkStartRef = useRef(walkStart)
    walkStartRef.current = walkStart
    /** 걸어 보기 중인 플레이어. 렌더 루프가 프레임마다 step 해 카메라를 쓴다 */
    const walkRef = useRef<Player | null>(null)
    const canvasId = `terrain-canvas-${useId()}`
    const canvasRef = useRef<HTMLCanvasElement | null>(null)
    // canvas 속성은 실제 픽셀 수(× devicePixelRatio), style 은 화면에 보이는 크기. 창 크기가 바뀌면 다시 잰다
    const [size, setSize] = useState(readViewportSize)
    const [renderer, setRenderer] = useState<TRenderer | null>(null)
    const lockedRef = useRef<BuildingHit | null>(lockedBuilding)
    lockedRef.current = lockedBuilding
    /** 렌더러 강조 목록을 다시 쓴다: 고정한 건물 + 조준점 건물(같은 건물이면 하나) */
    const pushHighlight = () => {
        renderer?.updaters.highlightUpdater(highlightListOf(lockedRef.current, lookedRef.current))
    }
    const pushHighlightRef = useRef(pushHighlight)
    pushHighlightRef.current = pushHighlight
    // 고정이 바뀌면(걸거나 풀면) 강조 목록을 바로 다시 쓴다
    useEffect(() => {
        pushHighlightRef.current()
    }, [lockedBuilding, renderer])
    // 디버그 페이지 훅(계획서 19절). teleport 는 평소 이동처럼 onMove → 주변 도엽 스트리밍·상주 갱신을 탄다
    useEffect(() => {
        if (!debugRef) return
        debugRef.current = {
            teleport: (x, y) => (walkRef.current ? (walkRef.current.teleport(x, y), true) : false),
            gpu: () => renderer?.updaters.residentStats() ?? null,
        }
        return () => {
            debugRef.current = null
        }
    }, [debugRef, renderer])
    const cameraRef = useRef<OrbitCamera | null>(null)
    /**
     * 눌려 있는 포인터(마우스 버튼·손가락)의 pointerId → 마지막 위치. 하나면 끌어서 회전, 둘이면 두 점 거리 변화로 확대·축소.
     * 브라우저가 제스처를 가져가며 pointercancel 을 보내면 거기서도 지워 상태가 남지 않게 한다
     */
    /** 누르고 있는 포인터. 마우스는 button(0 왼쪽 = 이동, 2 오른쪽 = 회전)으로 가르고, 터치·펜은 한 손가락 회전·두 손가락 확대 */
    const pointersRef = useRef(new Map<number, { x: number; y: number; button: number; pointerType: string }>())

    useEffect(() => {
        let cancelled = false
        let animationFrameId = 0
        let created: TRenderer | null = null

        createTerrainRenderFunctionAndUpdateFunctions({
            canvasId,
            width: Math.round(size.width * size.dpr),
            height: Math.round(size.height * size.dpr),
            ...rendererOptionsOf(paletteRef.current, renderDebugRef.current, qualityRef.current),
        })
            .then((r) => {
                if (cancelled) return r.destroy()
                created = r
                let last = performance.now()
                /** 걸어 보기 중 프레임 시간 측정: 0.5초 동안의 평균 간격을 알린다 */
                let frameSum = 0
                let frameCount = 0
                let frameReportAt = last
                const renderLoop = (now: number) => {
                    const player = walkRef.current
                    const dt = now - last
                    if (player) {
                        const cam = player.step(dt / 1000)
                        walkCameraRef.current = cam
                        r.updaters.cameraUpdater(cam)
                        frameSum += dt
                        frameCount++
                        if (now - frameReportAt >= 500) {
                            onWalkFrameTimeRef.current?.(frameSum / frameCount)
                            frameSum = 0
                            frameCount = 0
                            frameReportAt = now
                        }
                    }
                    last = now
                    r.render()
                    animationFrameId = window.requestAnimationFrame(renderLoop)
                }
                animationFrameId = window.requestAnimationFrame(renderLoop)
                setRenderer(r)
            })
            .catch((err) => {
                console.error(err)
                if (!cancelled) onErrorRef.current?.(err instanceof Error ? err : new Error(String(err)))
            })

        return () => {
            cancelled = true
            window.cancelAnimationFrame(animationFrameId)
            created?.destroy()
        }
    }, [])

    // 창 크기(개발자 도구 열기, 창 조절, 다른 화면으로 이동에 따른 devicePixelRatio 변화)를 따라간다
    useEffect(() => {
        const onResize = () => {
            const next = readViewportSize()
            setSize((prev) =>
                prev.width === next.width && prev.height === next.height && prev.dpr === next.dpr ? prev : next,
            )
        }
        window.addEventListener("resize", onResize)
        return () => window.removeEventListener("resize", onResize)
    }, [])

    // size 가 바뀌면 React 가 canvas 의 width·height 속성을 먼저 바꾸고, 그 뒤 이 effect 가 깊이 텍스처와 투영 비율을 맞춘다
    useEffect(() => {
        if (!renderer) return
        renderer.updaters.resizeUpdater(Math.round(size.width * size.dpr), Math.round(size.height * size.dpr))
    }, [renderer, size])

    useEffect(() => {
        if (!renderer) return
        applyPalette(renderer.updaters, palette, theme)
        // 둘러보기 중이면 색상표의 조명 세기도 바로
        if (walkRef.current) renderer.updaters.lightingUpdater(currentWalkLighting())
    }, [renderer, theme, palette])
    // 품질 설정이 바뀌면 둘러보기 조명(효과 켜고 끄기)을 다시 쓴다
    useEffect(() => {
        if (!renderer || !walkRef.current) return
        renderer.updaters.lightingUpdater(currentWalkLighting())
    }, [renderer, quality])

    useEffect(() => {
        if (!renderer) return
        applyLayerVisibility(renderer.updaters, layers)
    }, [renderer, layers])
    /** GPU 에 올라가 있는 도엽 id(메모리 M-B: 둘러보기 중 상주 반경 밖은 내린다) */
    const residentRef = useRef(new Set<string>())
    /**
     * 둘러보기 중 상주 반경에 맞춰 선택 도엽을 GPU 에서 내리고(반경 × RESIDENT_HYSTERESIS 밖) 들어온 도엽은 워커에 다시 요청한다.
     * 밖 도엽(extra)은 조정자가 반경으로 관리하므로 건드리지 않는다. 반경이 Infinity 면 아무것도 하지 않는다
     *
     * @param center 플레이어 위치(메쉬 로컬 m)
     */
    /** 둘러보기 보이는 거리(m): 디버그 walkradius= > 품질 설정(보이는 거리) > WALK_CULL_RADIUS. 그리는 반경이자 상주 반경의 기본값 */
    const walkRadiusNow = () => walkRadiusOf(renderDebugRef.current, qualityRef.current)
    /** 상주 반경(m). 디버그 resident= 가 없으면 보이는 거리와 같다. 둘러보기 중이 아니거나 반경이 무한이면 Infinity */
    const residentRadius = () => {
        if (!walkRef.current) return Infinity
        return residentRadiusOf(renderDebugRef.current, qualityRef.current)
    }
    /** 둘러보기 중 선택 도엽이 상주 반경(× 히스테리시스) 밖인지. 밖 도엽(extra)은 조정자가 관리하므로 false(sceneSetup.ts isOutsideResident) */
    const outsideResident = (tile: TileData) => {
        const cam = walkCameraRef.current
        return isOutsideResident(tile, cam ? [cam.eye[0], cam.eye[1]] : null, residentRadius())
    }
    const updateResidency = (center: [number, number]) => {
        const r = renderer
        if (!r) return
        const radius = residentRadiusOf(renderDebugRef.current, qualityRef.current)
        if (!Number.isFinite(radius)) return
        // 내릴 것·다시 요청할 것은 sceneSetup.ts residencyPlan(헤드리스 검사와 같은 함수)
        const { drop, wanted } = residencyPlan(tiles.tiles.values(), residentRef.current, center, radius)
        for (const id of drop) {
            r.updaters.streamTileUpdater(id, null)
            residentRef.current.delete(id)
        }
        const dropped = drop.length
        tiles.rebuild(wanted)
        const stats = r.updaters.residentStats()
        console.log(`GPU 상주: 도엽 ${stats.tiles}, ${(stats.bytes / 1048576).toFixed(1)} MB (내림 ${dropped}, 다시 요청 ${wanted.length}, 반경 ${radius} m)`)
    }
    // 도엽 집합 구독: 도엽을 GPU 에 올리고 내린다. 새 선택의 첫 도엽에서 이전 도엽을 모두 내리고 카메라를 맞춘다(걸어 보기 중이 아닐 때)
    useEffect(() => {
        if (!renderer) return
        // 처리 본문은 장면 설정 공용 모듈(sceneSetup.ts createTilesEventHandler). 헤드리스 검사도 같은 함수를 쓴다
        const unsubscribe = tiles.subscribe(
            createTilesEventHandler({
                updaters: renderer.updaters,
                tiles,
                resident: residentRef.current,
                getDebug: () => renderDebugRef.current,
                isWalking: () => !!walkRef.current,
                outsideResident,
                onOrbitCamera: (camera) => {
                    cameraRef.current = camera
                },
            }),
        )
        return unsubscribe
    }, [renderer, tiles])

        // 걸어 보기: 켜지면 지형 중앙에 플레이어를 세우고 그림자·안개 조명으로 바꾼다. 꺼지면(또는 mesh 가 바뀌면) 떼고
    // 궤도 카메라·기본 조명으로 복귀. 물리 값·층 간격은 아래 effect 가 따라 바꾼다
    useEffect(() => {
        const canvas = canvasRef.current
        const origin = tiles.origin
        const selectionBounds = tiles.bounds
        if (!walking || !renderer || !canvas || !origin || !selectionBounds) return
        // 높이 조회: 모든 도엽(선택 + 스트리밍)의 TIN 과 건물 지붕. 도엽이 오갈 때 범위를 다시 잰다(sceneSetup.ts createWalkSampler)
        const { combined, refit } = createWalkSampler(tiles, selectionBounds)
        refit()
        const unsubscribe = tiles.subscribe((event) => {
            if (event.type !== "tile" && event.type !== "remove") return
            refit()
            onWalkTileCountRef.current?.(tiles.extraCount)
        })
        // 시작점: 프리셋(디버그 페이지)이 있으면 그 자리, 아니면 선택 사각형 가운데. 메쉬가 없으면 가장 가까운 삼각형 위로(sceneSetup.ts walkSpawnPoint)
        const start = walkStartRef.current
        const spawn = walkSpawnPoint(tiles, start, selectionBounds, combined)
        // 주변 도엽 스트리밍(선택 범위 밖). 100 m 움직일 때마다 새 중심을 알린다
        let lastCenter: [number, number] = [spawn[0] + origin[0], spawn[1] + origin[1]]
        tiles.updateWalk(lastCenter, WALK_TILE_RADIUS, WALK_TILE_MAX)
        updateResidency(spawn)
        const player = createPlayer({
            sampler: combined,
            spawn,
            yaw: start?.yaw,
            pitch: start?.pitch,
            pointerLock: renderDebugRef.current?.pointerLock !== false,
            mouseLook: renderDebugRef.current?.mouseLook !== false,
            onFocusChange: (focused) => onWalkFocusChangeRef.current?.(focused),
            onMove: (move) => {
                onWalkMoveRef.current?.(move)
                const center: [number, number] = [move.x + origin[0], move.y + origin[1]]
                if (Math.hypot(center[0] - lastCenter[0], center[1] - lastCenter[1]) >= WALK_TILE_UPDATE_M) {
                    lastCenter = center
                    tiles.updateWalk(center, WALK_TILE_RADIUS, WALK_TILE_MAX)
                    updateResidency([move.x, move.y])
                }
            },
            physics: walkPhysicsRef.current,
            groundStep: groundStepRef.current,
            hoverHeight: start?.hover,
        })
        walkRef.current = player
        pointersRef.current.clear()
        renderer.updaters.lightingUpdater(currentWalkLighting())
        // 거리 거르기(L4): 반경 밖 도엽은 그리지 않는다. 궤도 보기로 돌아가면 끈다
        renderer.updaters.cullRadiusUpdater(walkRadiusNow())
        player.attach(canvas)
        // 조준점 건물 찾기(10 Hz, 사거리 PICK_RANGE_M): 바뀌면 렌더러 강조와 부모(onBuildingLook)에 알린다. pick=0 이면 끈다
        const picker = createBuildingPicker()
        const pickTimer =
            renderDebugRef.current?.pick === false
                ? 0
                : window.setInterval(() => {
                      const cam = walkCameraRef.current
                      if (!cam) return
                      // 지형이 가로막은 건물은 고르지 않도록 지표 높이를 넘긴다(계단형이면 층 바닥. sceneSetup.ts walkGroundAt)
                      const groundAt = walkGroundAt(combined, groundStepRef.current)
                      const hit = picker.pick(tiles.tiles.values(), cam.eye, fpsForward(cam), PICK_RANGE_M, groundAt)
                      const prev = lookedRef.current
                      if (hit?.tileId === prev?.tileId && hit?.index === prev?.index) return
                      lookedRef.current = hit
                      pushHighlightRef.current()
                      onBuildingLookRef.current?.(hit)
                  }, 100)
        return () => {
            window.clearInterval(pickTimer)
            lookedRef.current = null
            walkCameraRef.current = null
            renderer.updaters.highlightUpdater([])
            onBuildingLookRef.current?.(null)
            onBuildingPinRef.current?.(null)
            walkRef.current = null
            player.detach()
            unsubscribe()
            tiles.stopWalk()
            // 반경 밖이라 내렸던 선택 도엽을 다시 올린다(M-B). 앱이 표현 방식을 바꿔 전체를 다시 만들면 큐에서 한 번만 만들어진다
            const missing = [...tiles.tiles.values()].filter((t) => !t.extra && !residentRef.current.has(t.id)).map((t) => t.id)
            tiles.rebuild(missing)
            onWalkTileCountRef.current?.(0)
            renderer.updaters.cullRadiusUpdater(null)
            renderer.updaters.lightingUpdater(DEFAULT_LIGHTING)
            if (cameraRef.current) renderer.updaters.cameraUpdater(cameraRef.current)
        }
    }, [walking, renderer, tiles])
    const walkPhysicsRef = useRef(walkPhysics)
    walkPhysicsRef.current = walkPhysics
    useEffect(() => {
        if (walkPhysics) walkRef.current?.setPhysics(walkPhysics)
    }, [walkPhysics])
    // 렌더 디버그 설정이 바뀌면(디버그 페이지에서 해시를 고침) 새로고침 없이 반영: 태양·AO 출력은 렌더러에, 조명 항목은 걸어 보기 중일 때 다시 쓴다.
    // 품질 설정을 합친 값을 넘긴다(먼 거리 계단 부드럽게는 궤도 보기에도 바로 적용)
    useEffect(() => {
        if (!renderer) return
        renderer.updaters.debugUpdater(effectiveDebug(renderDebug, quality))
        if (walkRef.current) renderer.updaters.lightingUpdater(currentWalkLighting())
    }, [renderer, renderDebug, quality])
    // 보이는 거리(품질 설정 또는 디버그 walkradius=)가 둘러보기 중에 바뀌면 바로 반영: 그리는 반경을 바꾸고, 지금 자리에서 상주를 다시 맞춘다
    // (줄이면 먼 도엽을 GPU 에서 내리고, 늘리면 다시 요청한다). 둘러보기를 시작할 때는 시작 효과가 같은 값을 쓰므로, 값이 바뀌었을 때만
    // 움직인다(시작과 같은 커밋에서 한 번 더 돌아 아직 오는 중인 도엽을 다시 요청하지 않도록)
    const walkRadius = walkRadiusOf(renderDebug, quality)
    const appliedWalkRadiusRef = useRef(walkRadius)
    useEffect(() => {
        if (appliedWalkRadiusRef.current === walkRadius) return
        appliedWalkRadiusRef.current = walkRadius
        if (!renderer || !walkRef.current) return
        renderer.updaters.cullRadiusUpdater(walkRadius)
        const cam = walkCameraRef.current
        if (cam) updateResidency([cam.eye[0], cam.eye[1]])
    }, [renderer, walkRadius])
    /** 계단형이면 층 간격, 아니면 null. 플레이어 발 높이를 계단 바닥에 맞추는 데 쓴다 */
    const groundStep = mode === "stepped" ? stepInterval : null
    const groundStepRef = useRef(groundStep)
    groundStepRef.current = groundStep
    useEffect(() => {
        walkRef.current?.setGroundStep(groundStep)
    }, [groundStep])
    // 계단형 벽 음영·외곽선의 먼 거리 감쇠가 "한 층의 화면 px" 를 재는 층 간격
    useEffect(() => {
        renderer?.updaters.stepIntervalUpdater(stepInterval)
    }, [renderer, stepInterval])

    /**
     * 현재 카메라에 변경을 적용하고 GPU uniform 에 반영한다.
     * 렌더러나 카메라가 아직 준비되지 않았으면 무시한다. 걸어 보기 중에는 무시한다(1인칭 카메라가 쓰고 있다)
     *
     * @param change 현재 카메라를 받아 새 카메라를 돌려주는 함수
     */
    const updateCamera = (change: (cam: OrbitCamera) => OrbitCamera) => {
        if (!renderer || !cameraRef.current || walkRef.current) return
        cameraRef.current = change(cameraRef.current)
        renderer.updaters.cameraUpdater(cameraRef.current)
    }
    const updateCameraRef = useRef(updateCamera)
    updateCameraRef.current = updateCamera

    // 휠·트랙패드 확대/축소. React 의 onWheel 은 passive 리스너라 preventDefault 가 듣지 않으므로 직접 단다.
    // 트랙패드 핀치는 브라우저가 ctrlKey 가 켜진 wheel 로 보내는데, 막지 않으면 페이지 자체가 확대된다(모바일 핀치는
    // 터치라 touch-action 으로 막히지만 이 경로는 아님). 핀치는 deltaY 가 작아 배율을 10배로 둔다
    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        const onWheel = (e: WheelEvent) => {
            e.preventDefault()
            const rate = e.ctrlKey ? 0.01 : 0.001
            updateCameraRef.current((cam) => ({ ...cam, distance: cam.distance * Math.exp(e.deltaY * rate) }))
        }
        canvas.addEventListener("wheel", onWheel, { passive: false })
        return () => canvas.removeEventListener("wheel", onWheel)
    }, [])

    return (
        <canvas
            ref={canvasRef}
            id={canvasId}
            width={Math.round(size.width * size.dpr)}
            height={Math.round(size.height * size.dpr)}
            style={{
                position: "fixed",
                inset: 0,
                width: size.width,
                height: size.height,
                visibility: hidden ? "hidden" : "visible",
                // 걸어 보기 중 커서는 포커스(포인터 잠금) 중일 때만 숨긴다
                cursor: walking ? (walkFocused ? "none" : "default") : "grab",
                // 터치를 브라우저의 스크롤·핀치 제스처로 넘기지 않는다. 없으면 세로 끌기에 주소 표시줄이 반응하며
                // pointercancel 로 입력이 끊기고, 두 손가락 벌리기는 페이지 확대가 된다
                touchAction: "none",
            }}
            onPointerDown={(e) => {
                if (walkRef.current) {
                    // 걸어 보기 중 클릭: 포커스가 풀려 있으면 다시 잠금. 포커스 중이면 조준점의 건물을 펼치고(없으면 접음),
                    // 350 ms 안에 다시 누르면 더블클릭으로 보고 고정을 켜고 끈다
                    if (walkFocused) {
                        const now = performance.now()
                        if (now - lastWalkClickRef.current < 350) onBuildingLockRef.current?.()
                        else onBuildingPinRef.current?.(lookedRef.current)
                        lastWalkClickRef.current = now
                    } else walkRef.current.focus()
                    return
                }
                pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button, pointerType: e.pointerType })
                // 캔버스 밖으로 나가도 move/up 을 계속 받기 위해. 포인터가 이미 끝났으면(합성 이벤트, 즉시 취소) 예외가 나므로 무시
                try {
                    e.currentTarget.setPointerCapture(e.pointerId)
                } catch {
                    /* 캡처 없이도 캔버스 안에서는 동작한다 */
                }
            }}
            // 오른쪽 끌기가 회전이므로 컨텍스트 메뉴를 막는다(macOS 는 누르는 순간 뜬다)
            onContextMenu={(e) => e.preventDefault()}
            onPointerUp={(e) => pointersRef.current.delete(e.pointerId)}
            onPointerCancel={(e) => pointersRef.current.delete(e.pointerId)}
            onPointerLeave={(e) => pointersRef.current.delete(e.pointerId)}
            onPointerMove={(e) => {
                const pointers = pointersRef.current
                const prev = pointers.get(e.pointerId)
                if (!prev) return
                const next = { ...prev, x: e.clientX, y: e.clientY }
                if (pointers.size === 1) {
                    const dx = next.x - prev.x
                    const dy = next.y - prev.y
                    if (prev.pointerType === "mouse" && prev.button !== 2) {
                        // 마우스 왼쪽(가운데) 끌기: 이동(pan). 커서가 잡은 지면이 커서를 따라오도록 target 깊이의 지면 m/px 로 환산한다.
                        // 화면 가로는 카메라 오른쪽, 세로는 카메라 앞(수평 투영) 방향. 세로는 내려다보는 각이 낮을수록 지면이 눌려 보여
                        // sin(elevation) 으로 나누되, 아주 낮은 각에서 폭주하지 않게 0.3 아래로는 두지 않는다
                        updateCamera((cam) => {
                            const metersPerPixel = (2 * cam.distance * Math.tan(cam.fovY / 2)) / Math.max(size.height, 1)
                            const forward = [-Math.cos(cam.azimuth), -Math.sin(cam.azimuth)]
                            const right = [-Math.sin(cam.azimuth), Math.cos(cam.azimuth)]
                            const sx = -dx * metersPerPixel
                            const sy = (dy * metersPerPixel) / Math.max(Math.sin(cam.elevation), 0.3)
                            return {
                                ...cam,
                                target: [
                                    cam.target[0] + right[0] * sx + forward[0] * sy,
                                    cam.target[1] + right[1] * sx + forward[1] * sy,
                                    cam.target[2],
                                ],
                            }
                        })
                    } else {
                        // 마우스 오른쪽 끌기, 터치·펜 한 손가락: 회전(orbit)
                        updateCamera((cam) => ({
                            ...cam,
                            azimuth: cam.azimuth - dx * 0.005,
                            elevation: Math.min(Math.max(cam.elevation + dy * 0.005, 0.05), 1.5),
                        }))
                    }
                } else if (pointers.size === 2) {
                    // 두 손가락: 두 점 사이 거리가 늘면 가까이(확대), 줄면 멀리(축소)
                    const other = [...pointers].find(([id]) => id !== e.pointerId)![1]
                    const before = Math.hypot(prev.x - other.x, prev.y - other.y)
                    const after = Math.hypot(next.x - other.x, next.y - other.y)
                    if (before > 0 && after > 0) {
                        updateCamera((cam) => ({ ...cam, distance: (cam.distance * before) / after }))
                    }
                }
                pointers.set(e.pointerId, next)
            }}
        />
    )
}
