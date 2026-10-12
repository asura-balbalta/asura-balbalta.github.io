import React, { useEffect, useId, useRef, useState } from "react"

import { INITIAL_LAYER_STATES, LAYER_DEFS, LayerStates } from "../layers"
import { createPlayer, Player, PlayerMove, USE_POINTER_LOCK, WalkPhysics } from "../player"
import { TinMesh } from "../terrainData"
import { createHeightSampler, HeightSampler } from "../terrainHeight"
import { TERRAIN_THEMES, Theme } from "../terrainTheme"
import type { SteppedMeshRequest, SteppedMeshResponse } from "../terrainSteps.worker"
import { OrbitCamera } from "../webgpu/camera"
import {
    createTerrainRenderFunctionAndUpdateFunctions,
    DEFAULT_LIGHTING,
    MeshBounds,
    meshBounds,
    TerrainMode,
    WALK_LIGHTING,
} from "../webgpu/terrainRenderer"

/** esbuild 가 src/terrainSteps.worker.ts 를 별도 entry 로 묶어 내는 파일. index.html 의 index.js 와 같은 폴더(dist)에 있다 */
const STEPS_WORKER_URL = "terrainSteps.worker.js"
/**
 * 계단형 조각의 버퍼 상한(바이트). GPU 한도(보통 256MB)보다 작게 잡는 이유:
 * Worker 가 조각 하나를 만드는 동안 정점 합치기 Map 과 벽 집합을 들고 있는데, 그 크기가 조각 크기에 비례해서
 * 256MB 조각이면 수 GB 에 이른다. 조각을 작게 하면 Worker 메모리가 줄고, 첫 조각도 빨리 올라온다.
 * 비용은 draw call 수와 조각 경계의 중복 정점(1% 미만)뿐이다
 */
const STEPPED_CHUNK_BYTES = 64 * 1048576

/** 창 크기와 devicePixelRatio. canvas 속성은 width·height × dpr, style 은 width·height */
const readViewportSize = () => ({
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
})

type TRenderer = Awaited<
    ReturnType<typeof createTerrainRenderFunctionAndUpdateFunctions>
>

/**
 * 메쉬 범위에 맞춘 초기 카메라를 만든다.
 * 메쉬 중심을 바라보고, 남쪽에서 약 34° 높이로 내려다보며, 메쉬 가로·세로 중 긴 쪽의 1.2배 거리에 둔다.
 *
 * @param bounds meshUpdater 가 돌려준 정점 범위
 * @returns 궤도 카메라 초기 상태
 */
const initialCamera = ({ min, max }: MeshBounds): OrbitCamera => ({
    target: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    distance: Math.max(max[0] - min[0], max[1] - min[1]) * 1.2,
    azimuth: -Math.PI / 2,
    elevation: 0.6,
    fovY: Math.PI / 4,
})

/**
 * 3D 지형을 전체화면 canvas 에 그리는 컴포넌트.
 *
 * - 마운트할 때 렌더러(WebGPU device, 파이프라인)를 한 번 만들고 requestAnimationFrame 루프를 돌린다.
 *   언마운트하면 루프를 멈추고 device 를 해제한다.
 * - mesh 가 바뀌면 GPU 버퍼를 교체하고 카메라를 초기 위치로 되돌린다. mesh 는 같고 mode·stepInterval 만 바뀌면
 *   버퍼만 교체하고 카메라는 그대로 둔다(표현 방식 전환 때 시점이 튀지 않게).
 *   tin 모드는 메쉬를 통째로 넘긴다(meshUpdater, 동기).
 *   stepped 모드는 Worker(terrainSteps.worker.ts)가 buildSteppedMeshChunks 로 만드는 조각을 메시지로 받는 즉시
 *   올린다(meshStreamStarter). 변환 중에도 메인 스레드는 멈추지 않고, 계단형 메쉬 전체를 메모리에 두지 않는다.
 *   Worker 에는 원본의 사본(slice)을 transfer 하므로 원본 mesh 는 부모가 계속 들고 있다가 모드·층 간격을 바꿔 다시 쓸 수 있다.
 *   첫 조각이 올라갈 때 이전 지형을 교체하고 카메라를 맞춘다(onFirstChunk). 그때까지는 이전 지형이 그대로 보인다.
 * - buildings(건물 레이어 메쉬)가 바뀌면 그 레이어의 GPU 버퍼만 교체한다(layerMeshUpdater). 카메라는 그대로.
 * - layers 가 바뀌면 레이어별 보이기만 바꾼다(layerVisibilityUpdater). 버퍼는 그대로.
 * - theme 이 바뀌면 표고 색표·건물색과 배경색 uniform 만 다시 쓴다(셰이더·메쉬 그대로).
 * - 드래그: 회전(좌우 = azimuth, 상하 = elevation), 휠·트랙패드 핀치·두 손가락: 확대·축소(distance)
 * - 1차 구현이라 캔버스 크기는 마운트 시점 창 크기로 고정된다.
 *
 * @param props.mesh 원본 TIN 메쉬
 * @param props.buildings 건물 레이어 메쉬(지형과 같은 원점). null 이면 비운다
 * @param props.layers 레이어별 보이기 상태
 * @param props.mode 지형 표현 방식. "tin"(부드러운 음영, 표고 색) 또는 "stepped"(계단형, 단색)
 * @param props.stepInterval stepped 모드의 층 간격(m)
 * @param props.theme 색 테마(terrainTheme). 기본 "light"
 * @param props.onDone 메쉬를 GPU 에 올리는 작업이 끝났을 때(성공 true, 실패 false). 부모가 레이아웃 전환·잠금 해제에 쓴다
 * @param props.onProgress stepped 모드의 변환 진행률(처리한 원본 삼각형 비율 0 ~ 1). 약 100ms 간격으로 불리고 끝에 1 이 온다
 * @param props.onFirstChunk stepped 모드에서 첫 조각이 화면에 올라갔을 때. 부모가 지도를 미니맵으로 옮기는 데 쓴다
 * @param props.hidden true 면 캔버스를 보이지 않게 한다(지도 화면으로 돌아갔을 때). 렌더러·메쉬는 그대로라 다시 보이면 즉시 그려진다
 * @param props.walking 걸어 보기(1인칭, player.ts). 켜지면 렌더 루프가 프레임마다 플레이어를 진행해
 *   1인칭 카메라를 쓴다(포인터 잠금은 ?lock=1 일 때만). 끌어서 회전·휠 확대는 그동안 막는다. 꺼지면 직전 궤도 카메라로 돌아간다
 * @param props.onWalkMove 플레이어 위치가 바뀔 때(약 10 Hz, 미니맵·상태 표시줄용)
 * @param props.onWalkExit 포인터 잠금이 풀렸을 때(Esc 등). 부모가 walking 을 끈다
 * @param props.walkPhysics 걸어 보기 물리 값(중력·속도·점프·대시). 바뀌면 바로 플레이어에 반영
 */
export const TerrainViewCanvas = ({
    mesh,
    buildings = null,
    layers = INITIAL_LAYER_STATES,
    mode = "tin",
    stepInterval = 1,
    theme = "light",
    onDone,
    onProgress,
    onFirstChunk,
    hidden = false,
    walking = false,
    onWalkMove,
    onWalkExit,
    walkPhysics,
}: {
    mesh: TinMesh
    buildings?: TinMesh | null
    layers?: LayerStates
    mode?: TerrainMode
    stepInterval?: number
    theme?: Theme
    onDone?: (ok: boolean) => void
    onProgress?: (ratio: number) => void
    onFirstChunk?: () => void
    hidden?: boolean
    walking?: boolean
    onWalkMove?: (move: PlayerMove) => void
    onWalkExit?: () => void
    walkPhysics?: Partial<WalkPhysics>
}) => {
    // 콜백이 렌더마다 새로 만들어져도 메쉬 effect 를 다시 돌리지 않도록 ref 로 받는다
    const onDoneRef = useRef(onDone)
    onDoneRef.current = onDone
    const onProgressRef = useRef(onProgress)
    onProgressRef.current = onProgress
    const onFirstChunkRef = useRef(onFirstChunk)
    onFirstChunkRef.current = onFirstChunk
    const onWalkMoveRef = useRef(onWalkMove)
    onWalkMoveRef.current = onWalkMove
    const onWalkExitRef = useRef(onWalkExit)
    onWalkExitRef.current = onWalkExit
    /** 걸어 보기 중인 플레이어. 렌더 루프가 프레임마다 step 해 카메라를 쓴다 */
    const walkRef = useRef<Player | null>(null)
    /** mesh 별 지형 높이 조회기(걸어 보기에 들어갈 때 만들고 같은 mesh 면 다시 쓴다) */
    const samplerRef = useRef<{ mesh: TinMesh; sampler: HeightSampler } | null>(null)
    const canvasId = `terrain-canvas-${useId()}`
    const canvasRef = useRef<HTMLCanvasElement | null>(null)
    // canvas 속성은 실제 픽셀 수(× devicePixelRatio), style 은 화면에 보이는 크기. 창 크기가 바뀌면 다시 잰다
    const [size, setSize] = useState(readViewportSize)
    const [renderer, setRenderer] = useState<TRenderer | null>(null)
    const cameraRef = useRef<OrbitCamera | null>(null)
    /** 직전 effect 가 올린 mesh. 같은 mesh 로 다시 돌면(mode 전환) 카메라를 유지한다 */
    const lastMeshRef = useRef<TinMesh | null>(null)
    /**
     * 눌려 있는 포인터(마우스 버튼·손가락)의 pointerId → 마지막 위치. 하나면 끌어서 회전, 둘이면 두 점 거리 변화로 확대·축소.
     * 브라우저가 제스처를 가져가며 pointercancel 을 보내면 거기서도 지워 상태가 남지 않게 한다
     */
    const pointersRef = useRef(new Map<number, { x: number; y: number }>())

    useEffect(() => {
        let cancelled = false
        let animationFrameId = 0
        let created: TRenderer | null = null

        createTerrainRenderFunctionAndUpdateFunctions({
            canvasId,
            width: Math.round(size.width * size.dpr),
            height: Math.round(size.height * size.dpr),
            backgroundColor: TERRAIN_THEMES[theme].background,
        })
            .then((r) => {
                if (cancelled) return r.destroy()
                created = r
                let last = performance.now()
                const renderLoop = (now: number) => {
                    const player = walkRef.current
                    if (player) r.updaters.cameraUpdater(player.step((now - last) / 1000))
                    last = now
                    r.render()
                    animationFrameId = window.requestAnimationFrame(renderLoop)
                }
                animationFrameId = window.requestAnimationFrame(renderLoop)
                setRenderer(r)
            })
            .catch((err) => console.error(err))

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
        renderer.updaters.paletteUpdater(TERRAIN_THEMES[theme])
        renderer.updaters.backgroundUpdater(TERRAIN_THEMES[theme].background)
    }, [renderer, theme])

    useEffect(() => {
        if (!renderer) return
        try {
            renderer.updaters.layerMeshUpdater("buildings", buildings)
        } catch (err) {
            console.error(err)
        }
    }, [renderer, buildings])

    useEffect(() => {
        if (!renderer) return
        for (const { id } of LAYER_DEFS) renderer.updaters.layerVisibilityUpdater(id, layers[id].visible)
    }, [renderer, layers])

    useEffect(() => {
        if (!renderer) return
        const resetCamera = lastMeshRef.current !== mesh || !cameraRef.current
        lastMeshRef.current = mesh
        /** 새 mesh 면 범위에 맞춰 카메라를 초기화하고, 같은 mesh 면 현재 카메라를 유지한다 */
        const placeCamera = (bounds: MeshBounds) => {
            if (resetCamera) cameraRef.current = initialCamera(bounds)
            renderer.updaters.cameraUpdater(cameraRef.current!)
        }
        if (mode !== "stepped") {
            let ok = true
            try {
                placeCamera(renderer.updaters.meshUpdater(mesh, { mode }))
            } catch (err) {
                console.error(err)
                ok = false
            }
            onDoneRef.current?.(ok)
            return
        }

        // stepped: 변환은 Worker 가 하고, 여기서는 도착하는 조각을 GPU 에 올리기만 한다.
        // 첫 조각이 올라갈 때 이전 지형이 교체되고 카메라를 맞춘다. 도중에 실패하면 그때까지 올라간 조각은 그대로 둔다
        let worker: Worker | null = null
        let first = true
        /** Worker 를 멈추고 결과를 알린다. 이미 큐에 들어온 메시지도 더 처리하지 않게 핸들러를 뗀다 */
        const stop = (ok?: boolean) => {
            if (worker) {
                worker.onmessage = null
                worker.onerror = null
                worker.terminate()
                worker = null
            }
            if (ok !== undefined) onDoneRef.current?.(ok)
        }
        try {
            // 계단형은 x·y·z 범위가 원본 TIN 과 같으므로(층 바닥으로 누르기만 함) 원본 범위를 그대로 쓴다
            const bounds = meshBounds(mesh)
            const stream = renderer.updaters.meshStreamStarter({ mode, bounds })

            worker = new Worker(STEPS_WORKER_URL)
            worker.onmessage = (e: MessageEvent<SteppedMeshResponse>) => {
                const msg = e.data
                try {
                    if (msg.type === "chunk") {
                        stream.addChunk(msg.chunk)
                        if (first) {
                            first = false
                            placeCamera(bounds)
                            onFirstChunkRef.current?.()
                        }
                    } else if (msg.type === "progress") {
                        onProgressRef.current?.(msg.ratio)
                    } else {
                        stream.finish()
                        stop(true)
                    }
                } catch (err) {
                    console.error(err)
                    stop(false)
                }
            }
            worker.onerror = (e) => {
                console.error("계단형 변환 Worker 오류:", e.message)
                stop(false)
            }
            // 원본 mesh 는 부모가 계속 들고 있어야 하므로(모드·층 간격을 바꿔 같은 mesh 로 다시 변환) 원본을 넘기지 않는다.
            // slice() 로 사본을 만들고(복사 1회) 그 사본의 버퍼만 transfer 한다. 사본은 이 뒤로 메인에서 쓰지 않는다
            const copy: TinMesh = {
                origin: mesh.origin,
                positions: mesh.positions.slice(),
                indices: mesh.indices.slice(),
                segments: mesh.segments?.slice(),
            }
            const request: SteppedMeshRequest = {
                mesh: copy,
                step: stepInterval,
                maxBytes: Math.min(stream.maxBytes, STEPPED_CHUNK_BYTES),
            }
            const transfer = [copy.positions.buffer, copy.indices.buffer]
            if (copy.segments) transfer.push(copy.segments.buffer)
            worker.postMessage(request, transfer as ArrayBuffer[])
        } catch (err) {
            console.error(err)
            stop(false)
        }
        // mesh 가 바뀌거나 언마운트되면 진행 중인 변환을 취소한다(결과는 알리지 않는다)
        return () => stop()
    }, [renderer, mesh, mode, stepInterval])

    // 걸어 보기: 켜지면 지형 중앙에 플레이어를 세우고 그림자·안개 조명으로 바꾼다. 꺼지면(또는 mesh 가 바뀌면) 떼고
    // 궤도 카메라·기본 조명으로 복귀. 물리 값·층 간격은 아래 effect 가 따라 바꾼다
    useEffect(() => {
        const canvas = canvasRef.current
        if (!walking || !renderer || !canvas) return
        if (samplerRef.current?.mesh !== mesh) samplerRef.current = { mesh, sampler: createHeightSampler(mesh) }
        const { sampler } = samplerRef.current
        const player = createPlayer({
            sampler,
            spawn: [(sampler.min[0] + sampler.max[0]) / 2, (sampler.min[1] + sampler.max[1]) / 2],
            onExit: () => onWalkExitRef.current?.(),
            onMove: (move) => onWalkMoveRef.current?.(move),
            physics: walkPhysicsRef.current,
            groundStep: groundStepRef.current,
        })
        walkRef.current = player
        pointersRef.current.clear()
        renderer.updaters.lightingUpdater(WALK_LIGHTING)
        player.attach(canvas)
        return () => {
            walkRef.current = null
            player.detach()
            renderer.updaters.lightingUpdater(DEFAULT_LIGHTING)
            if (cameraRef.current) renderer.updaters.cameraUpdater(cameraRef.current)
        }
    }, [walking, renderer, mesh])
    const walkPhysicsRef = useRef(walkPhysics)
    walkPhysicsRef.current = walkPhysics
    useEffect(() => {
        if (walkPhysics) walkRef.current?.setPhysics(walkPhysics)
    }, [walkPhysics])
    /** 계단형이면 층 간격, 아니면 null. 플레이어 발 높이를 계단 바닥에 맞추는 데 쓴다 */
    const groundStep = mode === "stepped" ? stepInterval : null
    const groundStepRef = useRef(groundStep)
    groundStepRef.current = groundStep
    useEffect(() => {
        walkRef.current?.setGroundStep(groundStep)
    }, [groundStep])

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
                // 걸어 보기 중 커서는 포인터 잠금일 때만 숨긴다. 잠금이 없으면 가장자리에 닿아 회전이 멈추는 것을 볼 수 있어야 한다
                cursor: walking ? (USE_POINTER_LOCK ? "none" : "default") : "grab",
                // 터치를 브라우저의 스크롤·핀치 제스처로 넘기지 않는다. 없으면 세로 끌기에 주소 표시줄이 반응하며
                // pointercancel 로 입력이 끊기고, 두 손가락 벌리기는 페이지 확대가 된다
                touchAction: "none",
            }}
            onPointerDown={(e) => {
                if (walkRef.current) return
                pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
                // 캔버스 밖으로 나가도 move/up 을 계속 받기 위해. 포인터가 이미 끝났으면(합성 이벤트, 즉시 취소) 예외가 나므로 무시
                try {
                    e.currentTarget.setPointerCapture(e.pointerId)
                } catch {
                    /* 캡처 없이도 캔버스 안에서는 동작한다 */
                }
            }}
            onPointerUp={(e) => pointersRef.current.delete(e.pointerId)}
            onPointerCancel={(e) => pointersRef.current.delete(e.pointerId)}
            onPointerLeave={(e) => pointersRef.current.delete(e.pointerId)}
            onPointerMove={(e) => {
                const pointers = pointersRef.current
                const prev = pointers.get(e.pointerId)
                if (!prev) return
                const next = { x: e.clientX, y: e.clientY }
                if (pointers.size === 1) {
                    // 한 손가락(마우스): 끌어서 회전
                    const dx = next.x - prev.x
                    const dy = next.y - prev.y
                    updateCamera((cam) => ({
                        ...cam,
                        azimuth: cam.azimuth - dx * 0.005,
                        elevation: Math.min(Math.max(cam.elevation + dy * 0.005, 0.05), 1.5),
                    }))
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
