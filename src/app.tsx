import React, { CSSProperties, useEffect, useRef, useState } from "react"
import { Map } from "ol"
import { Extent } from "ol/extent"

import { firebaseApp } from "./fb"
import { applyMapTheme, initOlMap } from "./olmap"
import { SquareTool } from "./squareTool"
import { TERRAIN_THEMES, Theme } from "./terrainTheme"
import { LoadPhase, TinMesh } from "./terrainData"
import { loadTerrainInWorker } from "./terrainLoadClient"
import { downloadBlob, exportStlInWorker, stlFileName } from "./terrainStlClient"
import { STL_HEADER_BYTES, STL_TRIANGLE_BYTES } from "./terrainStl"
import { TerrainSource } from "./terrainLoad.worker"
import { TerrainViewCanvas } from "./components/TerrainViewCanvas"
import { TerrainMode } from "./webgpu/terrainRenderer"

/** 처음 보여 줄 지형 표현 방식. "tin": 삼각형 메쉬 그대로, "stepped": 등고선 모형처럼 계단형. 화면의 버튼으로 바꿀 수 있다 */
const INITIAL_TERRAIN_MODE: TerrainMode = "tin"
/** 처음 색 테마(지도 타일 + 3D). 화면의 버튼으로 바꿀 수 있다 */
const INITIAL_THEME: Theme = "light"
/** 계단형일 때 층 간격(m). 0.1 ~ 5 정도로 조정 */
const STEP_INTERVAL = 1
/** 지형 데이터 출처. "ttp": 점·등고선 조각을 받아 프론트가 삼각분할(기본), "ttm": v1 도엽별 메쉬(비교용) */
const TERRAIN_SOURCE: TerrainSource = "ttp"
/** ttm 일 때, 합친 뒤 도엽 경계 없이 다시 삼각분할할지(terrainRetri). ttp 는 항상 삼각분할한다 */
const RETRIANGULATE = true
/** 지형 생성 완료 후 지도 클릭을 계속 무시하는 시간(ms). OpenLayers 가 클릭을 250ms 늦게 발생시키는 것보다 넉넉하게 */
/** 로딩 단계를 배지 문구로 */
const loadStatusText = (phase: LoadPhase, done: number, total: number) => {
    switch (phase) {
        case "sheets":
            return "도엽 목록 조회 중"
        case "download":
            return `지형 데이터 받는 중 ${done}/${total}`
        case "merge":
            return `도엽 합치는 중 ${done}/${total}`
        case "retriangulate":
            return "재삼각분할 중"
    }
}

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

/** 왼쪽 위에 가로로 놓이는 배지·버튼 줄 */
const topLeftBarStyle: CSSProperties = {
    position: "fixed",
    top: 16,
    left: 16,
    zIndex: 20,
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
}

const busyBadgeStyle: CSSProperties = {
    padding: "8px 12px",
    borderRadius: 6,
    background: "rgba(0, 0, 0, 0.65)",
    color: "#fff",
    font: "14px sans-serif",
}

/** 배지와 같은 모양의 버튼(표현 방식·테마 전환) */
const barButtonStyle: CSSProperties = {
    ...busyBadgeStyle,
    border: "1px solid rgba(255, 255, 255, 0.35)",
    cursor: "pointer",
}

export default function App() {
    const mapRef = useRef<Map | null>(null)
    /** 사각형 선택 도구. "영역 선택" 버튼으로 모드를 켜고 끈다 */
    const squareToolRef = useRef<SquareTool | null>(null)
    /** 선택 모드가 켜져 있으면 true(버튼 문구·안내 배지용) */
    const [selecting, setSelecting] = useState(false)
    /** 사각형 확정마다 1씩 오르는 번호. 늦게 돌아온 이전 선택의 결과를 버리는 데 쓴다 */
    const generationRef = useRef(0)
    /** 다운로드~3D 업로드 완료까지 true. 그동안 배지를 보이고 버튼을 감춘다 */
    const [busy, setBusy] = useState(false)
    const [selection, setSelection] = useState<Extent | null>(null)
    const [mesh, setMesh] = useState<TinMesh | null>(null)
    /** 현재 지형 표현 방식. 버튼으로 바꾸면 같은 mesh 를 다시 올린다 */
    const [mode, setMode] = useState<TerrainMode>(INITIAL_TERRAIN_MODE)
    /** 색 테마. 지도 타일과 3D 색표·배경을 함께 바꾼다 */
    const [theme, setTheme] = useState<Theme>(INITIAL_THEME)
    /** 3D 지형이 화면에 올라간 뒤 true. 이때부터 지도를 미니맵으로 옮긴다 */
    const [terrainReady, setTerrainReady] = useState(false)
    /** 배지에 보일 진행 문구. 단계가 없으면(모드 전환 직후 등) null 이고 기본 문구를 쓴다 */
    const [status, setStatus] = useState<string | null>(null)
    /** 진행 중인 지형 로딩. 새 선택이 오면 취소한다 */
    const loadingRef = useRef<{ cancel: () => void } | null>(null)
    /** STL 생성 중이면 배지에 보일 문구, 아니면 null. 생성 중에는 내려받기 버튼 대신 배지를 보인다 */
    const [exporting, setExporting] = useState<string | null>(null)

    useEffect(() => {
        initOlMap(
            (bbox) => {
                const generation = ++generationRef.current
                setBusy(true)
                setStatus(null)
                setSelection(bbox)
                loadingRef.current?.cancel()
                const loading = loadTerrainInWorker(bbox, {
                    source: TERRAIN_SOURCE,
                    retriangulate: RETRIANGULATE,
                    onProgress: (phase, done, total) => {
                        if (generation === generationRef.current) setStatus(loadStatusText(phase, done, total))
                    },
                })
                loadingRef.current = loading
                loading.promise
                    .then((loaded) => {
                        if (generation !== generationRef.current) return
                        setStatus(null)
                        setMesh(loaded)
                    })
                    .catch((err) => {
                        console.error(err)
                        if (generation === generationRef.current) setBusy(false)
                    })
            },
            TERRAIN_THEMES[INITIAL_THEME],
            setSelecting,
        ).then(({ map, squareTool }) => {
            mapRef.current = map
            squareToolRef.current = squareTool
        })
    }, [])

    useEffect(() => {
        const map = mapRef.current
        if (!map) return
        applyMapTheme(map, TERRAIN_THEMES[theme])
    }, [theme])

    useEffect(() => {
        const map = mapRef.current
        if (!map) return
        // 지도 div 크기가 바뀌면 OpenLayers 에 알려야 다시 그린다
        map.updateSize()
        if (terrainReady && selection) {
            map.getView().fit(selection, { padding: [20, 20, 20, 20] })
        }
    }, [terrainReady, selection])

    /** 표현 방식을 바꾼다. 다시 올리는 동안 busy 로 두고, 끝나면 onTerrainDone 이 푼다 */
    const toggleMode = () => {
        setBusy(true)
        setStatus(null)
        setMode((m) => (m === "stepped" ? "tin" : "stepped"))
    }

    /**
     * 현재 지형을 STL 로 만들어 내려받는다. 현재 표현 방식(tin/stepped)대로 적는다.
     * Worker 가 메쉬 사본으로 일하므로, 생성 중에 다른 지역을 골라도 먼저 시작한 내보내기는 그대로 끝난다
     */
    const exportStl = () => {
        if (!mesh || exporting) return
        setExporting("STL 생성 중…")
        const started = performance.now()
        const { promise } = exportStlInWorker(mesh, {
            mode,
            step: STEP_INTERVAL,
            onProgress: (ratio) => setExporting(`STL 생성 중… ${Math.floor(ratio * 100)}%`),
        })
        promise
            .then((blob) => {
                const triangles = (blob.size - STL_HEADER_BYTES) / STL_TRIANGLE_BYTES
                console.log(
                    `STL 생성 (${mode}) ${(performance.now() - started).toFixed(0)}ms: ` +
                        `삼각형 ${triangles.toLocaleString()}개, ${(blob.size / 1048576).toFixed(1)}MB`,
                )
                downloadBlob(blob, stlFileName(mode))
            })
            .catch((err) => {
                console.error(err)
                window.alert(`STL 생성에 실패했습니다: ${err.message}`)
            })
            .finally(() => setExporting(null))
    }

    // 예전에는 계산으로 멈춘 동안 큐에 쌓인 지도 클릭이 새 선택을 만들지 않도록 완료 뒤 잠시 클릭을 걸렀다.
    // 지금은 선택이 "영역 선택" 모드에서 끌기로만 만들어지므로 그런 클릭은 아무 일도 하지 않아 잠금이 필요 없다
    const onTerrainDone = (ok: boolean) => {
        setBusy(false)
        setStatus(null)
        // stepped 모드는 첫 조각에서 이미 전환됐고(onFirstChunk), tin 모드는 여기서 전환한다
        if (ok) setTerrainReady(true)
    }

    return (
        <>
            {mesh && (
                <TerrainViewCanvas
                    mesh={mesh}
                    mode={mode}
                    stepInterval={STEP_INTERVAL}
                    theme={theme}
                    onDone={onTerrainDone}
                    onProgress={(ratio) => setStatus(`지형 생성 중… ${Math.floor(ratio * 100)}%`)}
                    onFirstChunk={() => setTerrainReady(true)}
                />
            )}
            <div id="map" style={terrainReady ? miniMapStyle : fullMapStyle}></div>
            <div style={topLeftBarStyle}>
                {busy ? (
                    <div style={busyBadgeStyle}>{status ?? "지형 생성 중…"}</div>
                ) : (
                    <>
                        <button style={barButtonStyle} onClick={() => squareToolRef.current?.setActive(!selecting)}>
                            {selecting ? "선택 취소" : "영역 선택"}
                        </button>
                        {selecting && <div style={busyBadgeStyle}>지도를 끌어 사각형을 그리세요</div>}
                        {terrainReady && (
                            <>
                                <button style={barButtonStyle} onClick={toggleMode}>
                                    {mode === "stepped" ? "삼각 메쉬로 보기" : "계단형으로 보기"}
                                </button>
                                {!exporting && (
                                    <button style={barButtonStyle} onClick={exportStl}>
                                        STL 내려받기
                                    </button>
                                )}
                            </>
                        )}
                    </>
                )}
                {exporting && <div style={busyBadgeStyle}>{exporting}</div>}
                <button style={barButtonStyle} onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}>
                    {theme === "dark" ? "라이트 테마" : "다크 테마"}
                </button>
            </div>
        </>
    )
}
