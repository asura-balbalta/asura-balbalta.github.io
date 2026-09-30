import React, { CSSProperties, useEffect, useRef, useState } from "react"
import { Map } from "ol"
import { Extent } from "ol/extent"

import { firebaseApp } from "./fb"
import { initOlMap } from "./olmap"
import { loadTerrainTtm, TinMesh } from "./terrainData"
import { buildSteppedMesh } from "./terrainSteps"
import { TerrainViewCanvas } from "./components/TerrainViewCanvas"
import { TerrainMode } from "./webgpu/terrainRenderer"

/** 지형 표현 방식. "tin": 삼각형 메쉬 그대로, "stepped": 등고선 모형처럼 계단형 */
const TERRAIN_MODE: TerrainMode = "stepped"
/** 계단형일 때 층 간격(m). 0.1 ~ 5 정도로 조정 */
const STEP_INTERVAL = 1
/** GPU 버퍼 최대 크기 요청(MB). WebGPU 기본값은 256. 넓은 범위의 인덱스 버퍼가 이를 넘으면 올린다 */
const GPU_MAX_BUFFER_MB = 256

const fullMapStyle: CSSProperties = { width: "100%", height: "100vh" }

const miniMapStyle: CSSProperties = {
    position: "fixed",
    top: 16,
    right: 16,
    width: 320,
    height: 220,
    zIndex: 10,
    borderRadius: 8,
    overflow: "hidden",
    border: "2px solid rgba(255, 255, 255, 0.35)",
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.5)",
}

export default function App() {
    const mapRef = useRef<Map | null>(null)
    const [selection, setSelection] = useState<Extent | null>(null)
    const [mesh, setMesh] = useState<TinMesh | null>(null)

    useEffect(() => {
        initOlMap((bbox) => {
            setSelection(bbox)
            // 서버에서 바로 합친 메쉬로 확인하려면 fetchMergedMeshDev(./terrainDataDev) 로 바꾼다
            loadTerrainTtm(bbox)
                .then((mesh) =>
                    setMesh(
                        TERRAIN_MODE === "stepped"
                            ? buildSteppedMesh(mesh, STEP_INTERVAL)
                            : mesh,
                    ),
                )
                .catch((err) => console.error(err))
        }).then((map) => (mapRef.current = map))
    }, [])

    const isMiniMap = mesh !== null

    useEffect(() => {
        const map = mapRef.current
        if (!map) return
        // 지도 div 크기가 바뀌면 OpenLayers 에 알려야 다시 그린다
        map.updateSize()
        if (isMiniMap && selection) {
            map.getView().fit(selection, { padding: [20, 20, 20, 20] })
        }
    }, [isMiniMap, selection])

    return (
        <>
            {mesh && (
                <TerrainViewCanvas
                    mesh={mesh}
                    mode={TERRAIN_MODE}
                    maxBufferSize={GPU_MAX_BUFFER_MB * 1048576}
                />
            )}
            <div id="map" style={isMiniMap ? miniMapStyle : fullMapStyle}></div>
        </>
    )
}
