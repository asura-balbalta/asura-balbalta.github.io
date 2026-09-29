import React, { useEffect, useId, useRef, useState } from "react"

import { TinMesh } from "../terrainData"
import { OrbitCamera } from "../webgpu/camera"
import {
    createTerrainRenderFunctionAndUpdateFunctions,
    MeshBounds,
} from "../webgpu/terrainRenderer"

type TRenderer = Awaited<
    ReturnType<typeof createTerrainRenderFunctionAndUpdateFunctions>
>

const initialCamera = ({ min, max }: MeshBounds): OrbitCamera => ({
    target: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    distance: Math.max(max[0] - min[0], max[1] - min[1]) * 1.2,
    azimuth: -Math.PI / 2, // 남쪽에서 북쪽을 바라봄
    elevation: 0.6,
    fovY: Math.PI / 4,
})

export const TerrainViewCanvas = ({ mesh }: { mesh: TinMesh }) => {
    const canvasId = `terrain-canvas-${useId()}`
    // 1차: 마운트 시점 창 크기로 고정. canvas 속성은 실제 픽셀 수, style 은 화면 크기
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
        const bounds = renderer.updaters.meshUpdater(mesh)
        cameraRef.current = initialCamera(bounds)
        renderer.updaters.cameraUpdater(cameraRef.current)
    }, [renderer, mesh])

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
