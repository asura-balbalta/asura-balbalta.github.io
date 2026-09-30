import React, { CSSProperties, useEffect, useRef, useState } from "react"
import { Map } from "ol"
import { Extent } from "ol/extent"

import { firebaseApp } from "./fb"
import { initOlMap } from "./olmap"
import { loadTerrainTtm, TinMesh } from "./terrainData"
import { TerrainViewCanvas } from "./components/TerrainViewCanvas"
import { TerrainMode } from "./webgpu/terrainRenderer"

/** 지형 표현 방식. "tin": 삼각형 메쉬 그대로, "stepped": 등고선 모형처럼 계단형 */
const TERRAIN_MODE: TerrainMode = "stepped"
/** 계단형일 때 층 간격(m). 0.1 ~ 5 정도로 조정 */
const STEP_INTERVAL = 1

// 3D 캔버스(position: fixed)가 준비되기 전까지 지도가 그 위에 보이도록 지도에 z-index 를 준다
const fullMapStyle: CSSProperties = {
    position: "relative",
    zIndex: 10,
    width: "100%",
    height: "100vh",
}

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

const busyBadgeStyle: CSSProperties = {
    position: "fixed",
    top: 16,
    left: 16,
    zIndex: 20,
    padding: "8px 12px",
    borderRadius: 6,
    background: "rgba(0, 0, 0, 0.65)",
    color: "#fff",
    font: "14px sans-serif",
}

export default function App() {
    const mapRef = useRef<Map | null>(null)
    /** 사각형 확정마다 1씩 오르는 번호. 늦게 돌아온 이전 선택의 결과를 버리는 데 쓴다 */
    const generationRef = useRef(0)
    /** 다운로드~3D 업로드 완료까지 true. 그동안 지도 클릭을 무시한다 */
    const busyRef = useRef(false)
    /** 이 시각보다 먼저 발생한 클릭은 무시한다. 계산으로 멈춰 있던 동안 큐에 쌓인 클릭을 걸러내는 용도 */
    const ignoreClicksBeforeRef = useRef(0)
    const [busy, setBusy] = useState(false)
    const [selection, setSelection] = useState<Extent | null>(null)
    const [mesh, setMesh] = useState<TinMesh | null>(null)
    /** 3D 지형이 화면에 올라간 뒤 true. 이때부터 지도를 미니맵으로 옮긴다 */
    const [terrainReady, setTerrainReady] = useState(false)

    const setBusyBoth = (value: boolean) => {
        busyRef.current = value
        setBusy(value)
    }

    useEffect(() => {
        initOlMap(
            (bbox) => {
                const generation = ++generationRef.current
                setBusyBoth(true)
                setSelection(bbox)
                loadTerrainTtm(bbox)
                    .then((loaded) => {
                        if (generation !== generationRef.current) return
                        setMesh(loaded)
                    })
                    .catch((err) => {
                        console.error(err)
                        if (generation === generationRef.current) setBusyBoth(false)
                    })
            },
            (ev) =>
                busyRef.current ||
                ev.originalEvent.timeStamp < ignoreClicksBeforeRef.current,
        ).then((map) => (mapRef.current = map))
    }, [])

    useEffect(() => {
        const map = mapRef.current
        if (!map) return
        // 지도 div 크기가 바뀌면 OpenLayers 에 알려야 다시 그린다
        map.updateSize()
        if (terrainReady && selection) {
            map.getView().fit(selection, { padding: [20, 20, 20, 20] })
        }
    }, [terrainReady, selection])

    const onTerrainDone = (ok: boolean) => {
        ignoreClicksBeforeRef.current = performance.now()
        setBusyBoth(false)
        if (ok) setTerrainReady(true)
    }

    return (
        <>
            {mesh && (
                <TerrainViewCanvas
                    mesh={mesh}
                    mode={TERRAIN_MODE}
                    stepInterval={STEP_INTERVAL}
                    onDone={onTerrainDone}
                />
            )}
            <div id="map" style={terrainReady ? miniMapStyle : fullMapStyle}></div>
            {busy && <div style={busyBadgeStyle}>지형 생성 중…</div>}
        </>
    )
}
