import React, { useEffect, useId, useRef, useState } from "react"

import { TinMesh } from "../terrainData"
import { OrbitCamera } from "../webgpu/camera"
import {
    createTerrainRenderFunctionAndUpdateFunctions,
    MeshBounds,
    TerrainMode,
} from "../webgpu/terrainRenderer"

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
 * - mesh 가 바뀌면 meshUpdater 로 버퍼만 교체하고 카메라를 초기 위치로 되돌린다.
 * - 드래그: 회전(좌우 = azimuth, 상하 = elevation), 휠: 확대·축소(distance)
 * - 1차 구현이라 캔버스 크기는 마운트 시점 창 크기로 고정된다.
 *
 * @param props.mesh 그릴 메쉬
 * @param props.mode 지형 표현 방식. "tin"(부드러운 음영, 표고 색) 또는 "stepped"(계단형, 단색)
 * @param props.maxBufferSize GPU 버퍼 최대 크기 요청(바이트). 생략하면 WebGPU 기본값(256MB)
 */
export const TerrainViewCanvas = ({
    mesh,
    mode = "tin",
    maxBufferSize,
}: {
    mesh: TinMesh
    mode?: TerrainMode
    maxBufferSize?: number
}) => {
    const canvasId = `terrain-canvas-${useId()}`
    // canvas 속성은 실제 픽셀 수(× devicePixelRatio), style 은 화면에 보이는 크기
    const [size] = useState(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
    }))
    const [renderer, setRenderer] = useState<TRenderer | null>(null)
    const cameraRef = useRef<OrbitCamera | null>(null)
    const dragRef = useRef<{ x: number; y: number } | null>(null)

    useEffect(() => {
        let cancelled = false
        let animationFrameId = 0
        let created: TRenderer | null = null

        createTerrainRenderFunctionAndUpdateFunctions({
            canvasId,
            width: Math.round(size.width * size.dpr),
            height: Math.round(size.height * size.dpr),
            backgroundColor: { r: 0.12, g: 0.13, b: 0.15 },
            maxBufferSize,
        })
            .then((r) => {
                if (cancelled) return r.destroy()
                created = r
                const renderLoop = () => {
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

    useEffect(() => {
        if (!renderer) return
        const bounds = renderer.updaters.meshUpdater(mesh, { mode })
        cameraRef.current = initialCamera(bounds)
        renderer.updaters.cameraUpdater(cameraRef.current)
    }, [renderer, mesh, mode])

    /**
     * 현재 카메라에 변경을 적용하고 GPU uniform 에 반영한다.
     * 렌더러나 카메라가 아직 준비되지 않았으면 무시한다.
     *
     * @param change 현재 카메라를 받아 새 카메라를 돌려주는 함수
     */
    const updateCamera = (change: (cam: OrbitCamera) => OrbitCamera) => {
        if (!renderer || !cameraRef.current) return
        cameraRef.current = change(cameraRef.current)
        renderer.updaters.cameraUpdater(cameraRef.current)
    }

    return (
        <canvas
            id={canvasId}
            width={Math.round(size.width * size.dpr)}
            height={Math.round(size.height * size.dpr)}
            style={{
                position: "fixed",
                inset: 0,
                width: size.width,
                height: size.height,
                cursor: "grab",
            }}
            onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId)
                dragRef.current = { x: e.clientX, y: e.clientY }
            }}
            onPointerUp={() => (dragRef.current = null)}
            onPointerMove={(e) => {
                const drag = dragRef.current
                if (!drag) return
                const dx = e.clientX - drag.x
                const dy = e.clientY - drag.y
                dragRef.current = { x: e.clientX, y: e.clientY }
                updateCamera((cam) => ({
                    ...cam,
                    azimuth: cam.azimuth - dx * 0.005,
                    elevation: Math.min(
                        Math.max(cam.elevation + dy * 0.005, 0.05),
                        1.5,
                    ),
                }))
            }}
            onWheel={(e) => {
                updateCamera((cam) => ({
                    ...cam,
                    distance: cam.distance * Math.exp(e.deltaY * 0.001),
                }))
            }}
        />
    )
}
