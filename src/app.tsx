import React, { useEffect, useRef, useState } from "react"
import { FluentProvider } from "@fluentui/react-components"
import { Map } from "ol"
import { Extent } from "ol/extent"
import { fromLonLat, toLonLat } from "ol/proj"
import { getDistance } from "ol/sphere"

// Firebase 앱 초기화(부수효과). 값은 아직 쓰지 않는다
import "./fb"
import { basemapAttribution, BasemapProvider } from "./basemap"
import { BuildingsMesh, loadBuildingsInWorker } from "./buildingsClient"
import { BuildingsLoadPhase } from "./buildingsData"
import { TerrainViewCanvas } from "./components/TerrainViewCanvas"
import type { ExportKind } from "./export/download"
import { exportableLayers, runExport } from "./export/runExport"
import { INITIAL_LAYER_STATES, LAYER_DEFS, LayerId, LayerStates } from "./layers"
import { applyMapTheme, initOlMap } from "./olmap"
import { SquarePhase, SquareTool } from "./squareTool"
import { LoadPhase, TinMesh } from "./terrainData"
import { TerrainSource } from "./terrainLoad.worker"
import { loadTerrainInWorker } from "./terrainLoadClient"
import { TERRAIN_THEMES, Theme } from "./terrainTheme"
import { ExportPanel } from "./ui/ExportPanel"
import { HintPill } from "./ui/HintPill"
import { LayersPanel } from "./ui/LayersPanel"
import { MapFrame } from "./ui/MapFrame"
import { Dock, PanelId } from "./ui/Dock"
import { SettingsPanel } from "./ui/SettingsPanel"
import { DockPanel } from "./ui/DockPanel"
import { StatusBar, StatusMenu } from "./ui/StatusBar"
import { fluentTheme, uiCssVars } from "./ui/theme"
import { AppToaster, useAppToast } from "./ui/Toasts"
import { BottomSheet } from "./ui/BottomSheet"
import { StatusPill } from "./ui/StatusPill"
import { TabBar } from "./ui/TabBar"
import { MOBILE_QUERY, useMediaQuery } from "./ui/useMediaQuery"
import { LIQUID_GLASS_ENABLED, useLiquidGlass } from "./ui/liquidGlass"
import { WalkControls } from "./ui/WalkControls"
import { WalkHud } from "./ui/WalkHud"
import { PillPosition, WalkPill } from "./ui/WalkPill"
import { DEFAULT_WALK_PHYSICS, PlayerMove, WalkPhysics } from "./player"
import { clearPlayerMarker, showPlayerMarker } from "./playerMarker"
import { transform } from "ol/proj"
import { SearchBox, SearchStatus } from "./ui/SearchBox"
import { VWORLD_KEY } from "./config"
import { clearSearchPin, showSearchPin } from "./searchPin"
import { SearchHandle, searchPlaces, SearchResult, trimDanglingJamo } from "./vworld"
import { Button, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger } from "@fluentui/react-components"
import { TerrainMode } from "./webgpu/terrainRenderer"

/** localStorage 의 JSON 값. 없거나 깨졌으면 기본값. 걸어 보기의 테스트용 물리 값·알약 위치 저장에 쓴다 */
const readStored = <T,>(key: string, fallback: T): T => {
    try {
        const raw = localStorage.getItem(key)
        return raw === null ? fallback : (JSON.parse(raw) as T)
    } catch {
        return fallback
    }
}
const writeStored = (key: string, value: unknown) => {
    try {
        localStorage.setItem(key, JSON.stringify(value))
    } catch {
        /* 사생활 보호 모드 등에서 저장이 막히면 이번 세션에서만 유지된다 */
    }
}


/** 처음 보여 줄 지형 표현 방식. "tin": 삼각형 메쉬 그대로, "stepped": 등고선 모형처럼 계단형. 설정 패널·상태 표시줄에서 바꾼다 */
const INITIAL_TERRAIN_MODE: TerrainMode = "tin"
/** 처음 색 테마(지도 타일 + 3D + UI). 설정 패널·상태 표시줄에서 바꾼다 */
const INITIAL_THEME: Theme = "light"
/** 처음 바탕 지도 출처(basemap.ts). 설정에서 바꿀 수 있고, 타일이 안 나오면 자동으로 다음 출처로 넘어간다 */
const INITIAL_BASEMAP: BasemapProvider = "stadia"
/** 계단형일 때 처음 층 간격(m). 설정 패널에서 0.1 ~ 5 로 바꾼다 */
const INITIAL_STEP_INTERVAL = 1
/** 지형 데이터 출처. "ttp": 점·등고선 조각을 받아 프론트가 삼각분할. "ttm"(v1 도엽별 메쉬)은 개발 서버 전용이라 설정에 두지 않는다 */
const TERRAIN_SOURCE: TerrainSource = "ttp"
/** ttm 일 때, 합친 뒤 도엽 경계 없이 다시 삼각분할할지(terrainRetri). ttp 는 항상 삼각분할한다 */
const RETRIANGULATE = true

/**
 * 마우스·트랙패드처럼 정밀한 포인터가 있는 기기인지. 처음 들어오면 범위 그리기 모드를 바로 켜고, 안내 문구를 클릭 방식으로
 * 고르는 데 쓴다(터치 기기는 끌기 안내). 선택 자체는 squareTool 이 입력마다 pointerType 으로 가르므로 터치 가능한 노트북에서도
 * 손가락 끌기는 동작한다
 */
const HAS_FINE_POINTER = typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches

/** 상태 표시줄 왼쪽에 보일 진행 상태. ratio 가 없으면 진행 막대가 불확정으로 움직인다 */
type Progress = { label: string; ratio?: number }

/** 지형 로딩 단계 → 진행 상태 문구 */
const loadProgress = (phase: LoadPhase, done: number, total: number): Progress => {
    const ratio = total > 0 ? done / total : undefined
    switch (phase) {
        case "sheets":
            return { label: "도엽 목록 확인 중" }
        case "download":
            return { label: `지형 받는 중 ${done} / ${total}`, ratio }
        case "merge":
            return { label: `도엽 잇는 중 ${done} / ${total}`, ratio }
        case "retriangulate":
            return { label: "지형 다듬는 중" }
    }
}

/** 건물 레이어 로딩 단계 → 진행 상태 문구 */
const buildingsProgress = (phase: BuildingsLoadPhase, done: number, total: number): Progress => {
    const ratio = total > 0 ? done / total : undefined
    switch (phase) {
        case "index":
            return { label: "건물 목록 확인 중" }
        case "download":
            return { label: `건물 받는 중 ${done} / ${total}`, ratio }
        case "build":
            return { label: `건물 만드는 중 ${done} / ${total}`, ratio }
    }
}

/** 선택 범위의 가로·세로를 km 로. EPSG:3857 의 왜곡을 피하려고 경위도로 바꿔 지표 거리를 잰다 */
const extentKmText = (extent: Extent) => {
    const [x1, y1, x2, y2] = extent
    const w = getDistance(toLonLat([x1, y1]), toLonLat([x2, y1]))
    const h = getDistance(toLonLat([x1, y1]), toLonLat([x1, y2]))
    return `범위 ${(w / 1000).toFixed(1)} × ${(h / 1000).toFixed(1)} km`
}

/**
 * 앱 뿌리. 테마를 들고 Fluent Provider 와 CSS 변수(--ui-*)를 건다. 화면 자체는 App 이 그린다.
 * Provider 가 그리는 div 가 지도·캔버스를 가리지 않도록 배경은 투명하게 둔다
 */
export default function AppRoot() {
    const [theme, setTheme] = useState<Theme>(INITIAL_THEME)
    const isMobile = useMediaQuery(MOBILE_QUERY)
    /** 리퀴드 글래스 프로토타입의 루트(유리 요소·3D 캔버스의 부모) */
    const rootRef = useRef<HTMLDivElement | null>(null)
    return (
        <FluentProvider ref={rootRef} theme={fluentTheme(theme)} style={{ ...uiCssVars(theme), background: "transparent" }}>
            <App theme={theme} setTheme={setTheme} isMobile={isMobile} rootRef={rootRef} />
            {/* 모바일은 탭 막대 위(ui.css --ui-above-tabbar: 20 + 56 + 8) */}
            <AppToaster bottom={isMobile ? 84 : 40} />
        </FluentProvider>
    )
}

/**
 * 화면. 지도(또는 3D) 위에 독(아래 가운데) · 독 위 패널 · 상태 표시줄 · 미니맵 · 안내 알약이 뜬다(docs/design-code-plan.md).
 * 모바일(< 768px)은 같은 상태로 그릇만 바꾼다: 독 → 탭 막대, 독 패널 → 바텀 시트, 상태 표시줄 → 상태 알약(작업 중에만),
 * 미니맵은 접을 수 있고 그 아래 보기 모드 빠른 메뉴가 있다.
 *
 * 흐름: 지도 화면 → 범위 그리기 → 로딩(상태 표시줄에 진행) → 3D 화면(지도는 미니맵으로) → 내려받기. 미니맵의 "지도로" 는
 * 3D 를 숨기고 지도 화면으로 돌아가며, 상태 표시줄의 "3D로 돌아가기" 로 되돌아온다. 로딩 중에는 버튼을 숨기지 않고 비활성으로 둔다
 *
 * @param props.isMobile 모바일 그릇을 쓸지
 */
function App({
    theme,
    setTheme,
    isMobile,
    rootRef,
}: {
    theme: Theme
    setTheme: (theme: Theme) => void
    isMobile: boolean
    rootRef: React.RefObject<HTMLDivElement | null>
}) {
    const toast = useAppToast()
    const mapRef = useRef<Map | null>(null)
    /** 사각형 선택 도구. 레일 맨 위 버튼으로 모드를 켜고 끈다 */
    const squareToolRef = useRef<SquareTool | null>(null)
    /** 선택 모드가 켜져 있으면 true(레일 버튼 강조·안내 알약) */
    const [selecting, setSelecting] = useState(false)
    /** 클릭 방식 선택의 단계. 첫 모서리를 찍었으면 "anchored"(안내 문구가 바뀐다) */
    const [selectPhase, setSelectPhase] = useState<SquarePhase>("idle")
    /** 사각형 확정마다 1씩 오르는 번호. 늦게 돌아온 이전 선택의 결과를 버리는 데 쓴다 */
    const generationRef = useRef(0)
    /** 다운로드~3D 업로드 완료까지 true. 그동안 레일의 범위 그리기와 보기 모드 전환을 막는다 */
    const [busy, setBusy] = useState(false)
    const [selection, setSelection] = useState<Extent | null>(null)
    /** 선택 범위에 걸치는 1K 도엽 수(olmap 이 비동기로 알려 준다) */
    const [sheetCount, setSheetCount] = useState<number | null>(null)
    const [mesh, setMesh] = useState<TinMesh | null>(null)
    /** 건물 레이어 메쉬(지형과 같은 원점). 지형이 바뀌면 null 로 비우고 다시 만든다 */
    const [buildings, setBuildings] = useState<BuildingsMesh | null>(null)
    /** 세운 건물 수(상태 표시줄 표시용) */
    const [buildingCount, setBuildingCount] = useState<number | null>(null)
    /** 건물 레이어 로딩 진행. 지형과 별개로 진행되므로 따로 든다 */
    const [buildingsLoading, setBuildingsLoading] = useState<Progress | null>(null)
    /** 진행 중인 건물 로딩. 새 지형이 오면 취소한다 */
    const buildingsLoadingRef = useRef<{ cancel: () => void } | null>(null)
    /** 레이어별 보기·내보내기 포함 상태 */
    const [layers, setLayers] = useState<LayerStates>(INITIAL_LAYER_STATES)
    /** 현재 지형 표현 방식. 바꾸면 같은 mesh 를 다시 올린다 */
    const [mode, setMode] = useState<TerrainMode>(INITIAL_TERRAIN_MODE)
    /** 계단형 층 간격(m). 바꾸면 계단형 지형을 다시 만든다 */
    const [stepInterval, setStepInterval] = useState(INITIAL_STEP_INTERVAL)
    /** 바탕 지도 출처. 설정으로 바꾸거나, 타일 로딩이 계속 실패하면(무료 한도 초과) 자동으로 다음 출처로 넘어간다 */
    const [basemap, setBasemap] = useState<BasemapProvider>(INITIAL_BASEMAP)
    /** 3D 지형이 한 번이라도 화면에 올라갔으면 true. 레이어·내려받기 패널과 보기 모드 전환을 연다 */
    const [terrainReady, setTerrainReady] = useState(false)
    /** 보이는 화면. 3D 가 준비되면 "3d" 로 넘어가고, 미니맵의 "지도로" 가 "map" 으로 되돌린다 */
    const [view, setView] = useState<"map" | "3d">("map")
    /** 열려 있는 패널(독 팝오버 또는 바텀 시트) */
    const [openPanel, setOpenPanel] = useState<PanelId | null>(null)
    /** 모바일 미니맵이 접혀 있는지. 지도 화면으로 돌아가면 풀어, 다음에 미니맵이 될 때 펼친 채 시작한다 */
    const [minimapCollapsed, setMinimapCollapsed] = useState(false)
    useEffect(() => {
        if (view === "map") setMinimapCollapsed(false)
    }, [view])
    // 리퀴드 글래스(?glass=0 으로 끔): 3D 화면에서만
    useLiquidGlass(LIQUID_GLASS_ENABLED && view === "3d" && !!mesh, rootRef)

    // ---- 걸어 보기(게임 모드, 계획 문서 6절) ----
    /** 1인칭으로 지형 위를 걷는 중. 3D 화면·데스크톱에서만. 지도로 돌아가거나 지형이 바뀌면 끝난다 */
    const [walking, setWalking] = useState(false)
    /** 플레이어 발 아래 지표 높이(상태 표시줄 "표고") */
    const [walkGround, setWalkGround] = useState<number | null>(null)
    /** 걸어 보기 중 프레임 간격(ms). 렌더링 비용 확인용으로 상태 표시줄에 보인다 */
    const [walkFrameMs, setWalkFrameMs] = useState<number | null>(null)
    /** 걸어 보기 중 스트리밍으로 들고 있는 주변 도엽 수 */
    const [walkTileCount, setWalkTileCount] = useState(0)
    useEffect(() => {
        if (view !== "3d" || !mesh || isMobile) setWalking(false)
    }, [view, mesh, isMobile])
    useEffect(() => {
        const map = mapRef.current
        if (walking || !map) return
        // 끝나면 플레이어 표시를 지우고 미니맵을 범위에 다시 맞춘다(따라가느라 옮겨졌을 수 있다)
        clearPlayerMarker(map)
        if (view === "3d" && selection) map.getView().fit(selection, { padding: [20, 20, 20, 20] })
    }, [walking])
    /** 걸어 보기에 들어가기 전의 지형 표현 방식. 들어가면 계단형으로 바꾸고 나올 때 되돌린다 */
    const walkPrevModeRef = useRef<TerrainMode | null>(null)
    const startWalking = () => {
        setOpenPanel(null)
        walkPrevModeRef.current = mode
        if (mode !== "stepped") changeMode("stepped")
        setWalkFocused(false)
        setEscHint(false)
        escHintShownRef.current = false
        setWalking(true)
    }
    /** 포커스(포인터 잠금) 중인지. Esc 로 풀리면 커서가 보이고 "클릭하면 다시 조작" 안내 */
    const [walkFocused, setWalkFocused] = useState(false)
    /** 포커스가 처음 잡힌 직후 몇 초 보이는 "Esc 를 누르면 마우스 포인터가 나타납니다" 안내 */
    const [escHint, setEscHint] = useState(false)
    const escHintShownRef = useRef(false)
    const onWalkFocusChange = (focused: boolean) => {
        setWalkFocused(focused)
        if (focused && !escHintShownRef.current) {
            escHintShownRef.current = true
            setEscHint(true)
            window.setTimeout(() => setEscHint(false), 4000)
        }
    }
    useEffect(() => {
        if (walking) return
        const prev = walkPrevModeRef.current
        walkPrevModeRef.current = null
        if (prev && prev !== mode) changeMode(prev)
    }, [walking])
    /** 테스트용 물리 값. 브라우저에 저장해 새로고침해도 유지한다 */
    // 저장된 값에 없는 항목(나중에 추가된 대시 속도·감속 등)은 기본값으로 채운다
    const [walkPhysics, setWalkPhysics] = useState<WalkPhysics>(() => ({
        ...DEFAULT_WALK_PHYSICS,
        ...readStored<Partial<WalkPhysics>>("walkPhysics", {}),
    }))
    const changeWalkPhysics = (next: Partial<WalkPhysics>) => {
        const merged = { ...walkPhysics, ...next }
        setWalkPhysics(merged)
        writeStored("walkPhysics", merged)
    }
    /** 진입 알약의 위치(끌어서 옮긴 것). null 이면 가운데 */
    const [walkPillPos, setWalkPillPos] = useState<PillPosition | null>(() => readStored<PillPosition | null>("walkPillPos", null))
    const moveWalkPill = (next: PillPosition) => {
        setWalkPillPos(next)
        writeStored("walkPillPos", next)
    }
    const stopWalking = () => {
        if (document.pointerLockElement) document.exitPointerLock()
        setWalking(false)
    }
    const onWalkMove = (move: PlayerMove) => {
        const map = mapRef.current
        if (!map || !mesh) return
        // 메쉬 좌표는 EPSG:5179(origin 을 뺀 m), 지도는 EPSG:3857. 5179 는 tileOverlay 가 OpenLayers 에 등록해 두었다
        const coord = transform([move.x + mesh.origin[0], move.y + mesh.origin[1]], "EPSG:5179", "EPSG:3857") as [number, number]
        showPlayerMarker(map, coord, move.yaw)
        setWalkGround(move.ground)
    }

    // ---- 주소 검색 ----
    /** 검색 알약의 글자 */
    const [query, setQuery] = useState("")
    const [searchStatus, setSearchStatus] = useState<SearchStatus>({ kind: "idle" })
    /** 결과를 골라 핀을 찍은 상태면 그 이름. 글자가 이 이름 그대로면 다시 검색하지 않는다 */
    const [pinnedName, setPinnedName] = useState<string | null>(null)
    const searchRef = useRef<SearchHandle | null>(null)
    useEffect(() => {
        searchRef.current?.cancel()
        // 조합 중인 자모("이태ㅇ")는 빼고 본다. 빼고 나서 비면 검색하지 않는다
        const q = trimDanglingJamo(query.trim())
        if (!q || q === pinnedName) {
            setSearchStatus({ kind: "idle" })
            return
        }
        setSearchStatus({ kind: "loading" })
        // 300ms 디바운스. 그 안에 글자가 또 바뀌면 이전 타이머는 취소된다
        const timer = window.setTimeout(() => {
            const center = mapRef.current?.getView().getCenter() as [number, number] | undefined
            const handle = searchPlaces(q, VWORLD_KEY, center)
            searchRef.current = handle
            handle.promise
                .then((results) => setSearchStatus({ kind: "done", results }))
                .catch((err: Error) => setSearchStatus({ kind: "error", message: err.message }))
        }, 300)
        return () => window.clearTimeout(timer)
    }, [query, pinnedName])

    /**
     * 지도를 그 자리로 옮긴다(줌은 16 이상으로). 멀면 OpenLayers 의 "fly" 방식: 중심은 직선으로 가고, 줌은 두 지점이 한 화면에
     * 들어오는 수준(최소 10)까지 빠졌다가 목표 줌으로 들어온다. 줌 16 그대로 직선 이동하면 경로 위의 줌 16 타일이 프레임마다
     * 요청되어 목적지 타일이 뒤로 밀렸다(OpenLayers 10 은 애니메이션 중에도 타일을 받고, 시작된 요청은 취소하지 않는다).
     * 화면 폭 안쪽의 가까운 거리면 그냥 이동만 한다
     */
    const flyTo = (coord: [number, number]) => {
        const map = mapRef.current
        const view = map?.getView()
        const center = view?.getCenter()
        const size = map?.getSize()
        if (!map || !view || !center || !size) return
        const targetZoom = Math.max(view.getZoom() ?? 16, 16)
        const distance = Math.hypot(coord[0] - center[0], coord[1] - center[1])
        const resolution = view.getResolution() ?? 1
        const viewportPx = Math.min(size[0], size[1])
        if (distance < resolution * viewportPx) {
            view.animate({ center: coord, zoom: targetZoom, duration: 500 })
            return
        }
        // 두 지점(거리 d)이 화면의 짧은 변 안에 여유 있게 들어오는 해상도 → 그 줌까지 빠진다
        const outResolution = (distance * 1.5) / viewportPx
        const outZoom = Math.max(10, Math.min(view.getZoomForResolution(outResolution) ?? 10, targetZoom - 1))
        const duration = Math.min(1200, Math.max(600, distance / resolution / 2))
        view.animate({ center: coord, duration })
        view.animate({ zoom: outZoom, duration: duration / 2 }, { zoom: targetZoom, duration: duration / 2 })
    }
    const selectSearchResult = (r: SearchResult) => {
        setQuery(r.name)
        setPinnedName(r.name)
        flyTo(r.coord)
        if (mapRef.current) showSearchPin(mapRef.current, r.coord, r.name, r.address)
    }
    const clearSearch = () => {
        setQuery("")
        setPinnedName(null)
        if (mapRef.current) clearSearchPin(mapRef.current)
    }
    const changeQuery = (next: string) => {
        setQuery(next)
        if (pinnedName !== null && next !== pinnedName) {
            setPinnedName(null)
            if (mapRef.current) clearSearchPin(mapRef.current)
        }
    }
    /**
     * "현재 위치로 이동": 브라우저 위치 정보로 지도만 옮긴다(핀 없음).
     * 브라우저는 한 번 "차단" 한 사이트에는 다시 묻지 않고 즉시 거부하므로, 권한 상태를 먼저 조회해 차단이면 사이트 설정에서
     * 허용하는 방법을 안내한다. 미정이면 브라우저가 묻고, 거절하면 경고 토스트(5초 뒤 사라짐)
     */
    const locateMe = async () => {
        if (!("geolocation" in navigator)) {
            toast.warning("현재 위치를 가져오지 못했습니다", "이 브라우저는 위치 정보를 지원하지 않습니다.")
            return
        }
        try {
            const status = await navigator.permissions?.query({ name: "geolocation" })
            if (status?.state === "denied") {
                toast.warning(
                    "위치 정보가 차단되어 있습니다",
                    "브라우저 주소창의 사이트 설정에서 위치 정보를 허용한 뒤 다시 눌러 주세요.",
                )
                return
            }
        } catch {
            // permissions API 가 없거나 geolocation 을 모르는 브라우저(Safari 일부). 바로 요청해 본다
        }
        navigator.geolocation.getCurrentPosition(
            (pos) => flyTo(fromLonLat([pos.coords.longitude, pos.coords.latitude]) as [number, number]),
            (err) => {
                if (err.code === err.PERMISSION_DENIED) {
                    toast.warning("위치 정보 사용을 허용하지 않았습니다", "허용하면 현재 위치로 이동합니다.")
                } else {
                    toast.warning("현재 위치를 가져오지 못했습니다", err.message)
                }
            },
            { timeout: 10_000 },
        )
    }
    /** 지형 로딩·생성 진행. busy 인데 단계가 없으면(모드 전환 직후 등) 기본 문구를 쓴다 */
    const [terrainProgress, setTerrainProgress] = useState<Progress | null>(null)
    /** 진행 중인 지형 로딩. 새 선택이 오면 취소한다 */
    const loadingRef = useRef<{ cancel: () => void } | null>(null)
    /** 만드는 중인 내보내기 형식과 진행률 */
    const [exporting, setExporting] = useState<{ kind: ExportKind; ratio?: number } | null>(null)

    /**
     * 범위의 지형을 Worker 로 받아 mesh 로 만든다. 사각형 확정이 부른다.
     * 이전 로딩은 취소하고, 늦게 돌아온 결과는 generation 으로 버린다
     */
    const startTerrainLoad = (bbox: Extent) => {
        const generation = ++generationRef.current
        setBusy(true)
        setTerrainProgress(null)
        setSelection(bbox)
        setSheetCount(null)
        loadingRef.current?.cancel()
        const loading = loadTerrainInWorker(bbox, {
            source: TERRAIN_SOURCE,
            retriangulate: RETRIANGULATE,
            onProgress: (phase, done, total) => {
                if (generation === generationRef.current) setTerrainProgress(loadProgress(phase, done, total))
            },
        })
        loadingRef.current = loading
        loading.promise
            .then((loaded) => {
                if (generation !== generationRef.current) return
                setTerrainProgress(null)
                setMesh(loaded)
                loadBuildingsLayer(bbox, loaded, generation)
            })
            .catch((err) => {
                console.error(err)
                if (generation !== generationRef.current) return
                setBusy(false)
                setTerrainProgress(null)
                toast.error("지형 데이터를 받지 못했습니다", err.message)
            })
    }

    useEffect(() => {
        initOlMap({
            onSquareConfirmed: startTerrainLoad,
            onSheets: setSheetCount,
            theme: TERRAIN_THEMES[INITIAL_THEME],
            basemap: INITIAL_BASEMAP,
            onSelectingChange: setSelecting,
            onSelectPhaseChange: setSelectPhase,
            onBasemapFallback: setBasemap,
        }).then(({ map, squareTool }) => {
            mapRef.current = map
            squareToolRef.current = squareTool
            // 데스크톱은 첫 할 일이 범위 그리기이므로 모드를 켜 둔 채 시작한다. 터치 기기는 레일 버튼으로 켠다
            if (HAS_FINE_POINTER) squareTool.setActive(true)
            // #map 의 높이는 CSS(.ui-map 100%)로 정해져 지도 생성 시점에 아직 0 일 수 있다. 다음 프레임에 크기를 다시 잰다
            requestAnimationFrame(() => map.updateSize())
        })
    }, [])

    useEffect(() => {
        const map = mapRef.current
        if (!map) return
        applyMapTheme(map, TERRAIN_THEMES[theme], basemap, setBasemap)
    }, [theme, basemap])

    useEffect(() => {
        const map = mapRef.current
        if (!map) return
        // 지도 div 크기가 바뀌면(전체 ↔ 미니맵) OpenLayers 에 알려야 다시 그린다
        map.updateSize()
        if (view === "3d" && selection) {
            map.getView().fit(selection, { padding: [20, 20, 20, 20] })
        }
    }, [view, selection])

    /**
     * 지형이 올라온 뒤 그 위에 세울 건물 레이어를 Worker 로 만든다. 지형과 별개로 진행되어 지형이 먼저 보이고
     * 건물은 준비되는 대로 얹힌다. 이전 건물 로딩은 취소하고, 늦게 돌아온 결과는 generation 으로 버린다
     */
    const loadBuildingsLayer = (bbox: Extent, terrain: TinMesh, generation: number) => {
        buildingsLoadingRef.current?.cancel()
        setBuildings(null)
        setBuildingCount(null)
        const started = performance.now()
        const loading = loadBuildingsInWorker(bbox, terrain, {
            onProgress: (phase, done, total) => {
                if (generation === generationRef.current) setBuildingsLoading(buildingsProgress(phase, done, total))
            },
        })
        buildingsLoadingRef.current = loading
        loading.promise
            .then((result) => {
                if (generation !== generationRef.current) return
                console.log(
                    `건물 레이어: ${result.built}개 세움(지형 밖 ${result.skipped}), 삼각형 ${(result.mesh.indices.length / 3).toLocaleString()}, ${Math.round(performance.now() - started)}ms`,
                )
                setBuildings(result.mesh)
                setBuildingCount(result.built)
            })
            .catch((err) => {
                console.error("건물 레이어 실패:", err)
                if (generation === generationRef.current) toast.warning("건물 데이터를 받지 못했습니다", "지형만 보입니다.")
            })
            .finally(() => {
                if (generation === generationRef.current) setBuildingsLoading(null)
            })
    }

    /** 레이어 하나의 보기 또는 내보내기 포함을 바꾼다 */
    const setLayerFlag = (id: LayerId, key: "visible" | "export", value: boolean) =>
        setLayers((prev) => ({ ...prev, [id]: { ...prev[id], [key]: value } }))

    /** 표현 방식을 바꾼다. 다시 올리는 동안 busy 로 두고, 끝나면 onTerrainDone 이 푼다 */
    const changeMode = (next: TerrainMode) => {
        if (next === mode) return
        if (mesh) {
            setBusy(true)
            setTerrainProgress(null)
        }
        setMode(next)
    }

    /** 계단 간격을 바꾼다. 계단형이면 TerrainViewCanvas 가 같은 mesh 를 다시 변환한다 */
    const changeStepInterval = (next: number) => {
        if (next === stepInterval) return
        if (mesh && mode === "stepped") {
            setBusy(true)
            setTerrainProgress(null)
        }
        setStepInterval(next)
    }

    const onTerrainDone = (ok: boolean) => {
        setBusy(false)
        setTerrainProgress(null)
        // stepped 모드는 첫 조각에서 이미 전환됐고(onFirstChunk), tin 모드는 여기서 전환한다
        if (ok) showTerrain()
        else toast.error("3D 지형을 만들지 못했습니다")
    }

    /** 3D 가 준비됐을 때: 레이어·내려받기를 열고 3D 화면으로 */
    const showTerrain = () => {
        setTerrainReady(true)
        setView("3d")
    }

    /** "내보내기" 에 체크된 레이어를 한 파일로 만들어 내려받는다. 결과는 토스트로 알린다 */
    const startExport = (kind: ExportKind) => {
        if (exporting || !mesh) return
        const label = kind.toUpperCase()
        const meshes = { terrain: mesh, buildings }
        if (exportableLayers(meshes, layers).length === 0) {
            toast.warning(`${label} 에 넣을 레이어가 없습니다`, '레이어 패널에서 "내보내기" 를 하나 이상 체크하세요.')
            return
        }
        setExporting({ kind })
        runExport(kind, meshes, layers, {
            mode,
            step: stepInterval,
            onProgress: (ratio) => setExporting({ kind, ratio }),
        })
            .then(({ included }) => {
                const names = LAYER_DEFS.filter((d) => included.includes(d.id)).map((d) => d.label)
                const note =
                    !included.includes("buildings") && layers.buildings.export && buildingsLoading
                        ? "지형만 담았습니다. 건물은 받는 중입니다."
                        : `${names.join(" · ")} 를 담았습니다.`
                toast.success(`${label} 파일을 내려받았습니다`, note)
            })
            .catch((err) => {
                console.error(err)
                toast.error(`${label} 파일을 만들지 못했습니다`, err.message)
            })
            .finally(() => setExporting(null))
    }

    // ---- 상태 표시줄 내용 ----
    const exportLabel = exporting ? `${exporting.kind.toUpperCase()} 만드는 중` : null
    const progress: Progress | null = busy
        ? (terrainProgress ?? { label: "3D 지형 만드는 중" })
        : exporting
          ? { label: exportLabel! + (exporting.ratio === undefined ? "" : ` ${Math.floor(exporting.ratio * 100)}%`), ratio: exporting.ratio }
          : buildingsLoading
    // 수치는 선택에 관한 것(범위·도엽)만. 삼각형·건물 수는 레이어 패널의 행에 보인다
    const stats: string[] = []
    if (selection) stats.push(extentKmText(selection))
    if (sheetCount !== null) stats.push(`도엽 ${sheetCount}`)
    if (walking && walkGround !== null) stats.push(`표고 ${walkGround.toFixed(1)} m`)
    if (walking && walkFrameMs !== null) stats.push(`프레임 ${walkFrameMs.toFixed(1)} ms`)
    if (walking && walkTileCount > 0) stats.push(`주변 도엽 ${walkTileCount}`)
    if (stats.length === 0 && !selecting) stats.push("범위 없음")
    if (selecting) stats.unshift("범위 그리는 중")

    // 오른쪽 메뉴는 설정 패널과 겹쳐 비워 둔다. 나중에 다른 정보나 메뉴가 들어갈 자리
    const menus: StatusMenu[] = []

    /** 레이어 패널 행의 보조 문구 */
    const layerNotes: Partial<Record<LayerId, string>> = {}
    if (mesh) layerNotes.terrain = `삼각형 ${(mesh.indices.length / 3).toLocaleString()}`
    if (buildingCount !== null) layerNotes.buildings = `${buildingCount.toLocaleString()} 동`

    const included = mesh ? exportableLayers({ terrain: mesh, buildings }, layers) : []

    // 폭에 따라 그릇만 바꾼다. props 는 같다
    const Toolbar = isMobile ? TabBar : Dock
    const Panel = isMobile ? BottomSheet : DockPanel

    /**
     * 모바일에서 탭 막대 위 왼쪽에 서는 알약: 작업 중이면 상태 알약, 아니면 지도 화면에서 "3D로 돌아가기".
     * 시트가 열려 있으면 시트 위에 한 묶음으로 얹고(above), 아니면 혼자 선다
     */
    const mobilePill = progress ? (
        <StatusPill label={progress.label} ratio={progress.ratio} />
    ) : view === "map" && terrainReady && !busy ? (
        <button type="button" className="ui-status-pill ui-glass" onClick={() => setView("3d")}>
            3D로 돌아가기
        </button>
    ) : null
    const panelAbove = isMobile ? mobilePill : undefined

    return (
        <>
            {mesh && (
                <TerrainViewCanvas
                    mesh={mesh}
                    buildings={buildings}
                    layers={layers}
                    mode={mode}
                    stepInterval={stepInterval}
                    theme={theme}
                    hidden={view === "map"}
                    onDone={onTerrainDone}
                    onProgress={(ratio) =>
                        setTerrainProgress({ label: `3D 지형 만드는 중 ${Math.floor(ratio * 100)}%`, ratio })
                    }
                    onFirstChunk={showTerrain}
                    walking={walking}
                    walkFocused={walkFocused}
                    onWalkMove={onWalkMove}
                    onWalkFocusChange={onWalkFocusChange}
                    walkPhysics={walkPhysics}
                    onWalkFrameTime={setWalkFrameMs}
                    walkSelection={selection ?? undefined}
                    onWalkTileCount={setWalkTileCount}
                />
            )}
            {/* 독(탭 막대)이 지도 틀보다 앞에 와야 Tab 키가 도구부터 닿는다. 겹침은 z-index 가 정한다. 걸어 보기 중에는 숨긴다 */}
            {!walking && (
                <Toolbar
                    drawing={selecting}
                    onToggleDraw={() => squareToolRef.current?.setActive(!selecting)}
                    drawDisabled={busy}
                    openPanel={openPanel}
                    onOpenPanel={setOpenPanel}
                    panelDisabled={{ layers: !terrainReady, export: !terrainReady }}
                />
            )}
            <MapFrame
                mode={view === "3d" ? "mini" : "full"}
                onExpand={() => setView("map")}
                attribution={basemapAttribution(basemap)}
                collapsible={isMobile}
                collapsed={minimapCollapsed}
                onCollapsedChange={setMinimapCollapsed}
                onResize={() => mapRef.current?.updateSize()}
            >
                <div id="map" className="ui-map"></div>
            </MapFrame>
            {/* 모바일 3D 화면의 빠른 메뉴(화면 시안 "모바일 · 3D"): 미니맵 아래에서 보기 모드를 바꾼다 */}
            {isMobile && view === "3d" && terrainReady && (
                <Menu positioning="below-end">
                    <MenuTrigger disableButtonEnhancement>
                        <button
                            type="button"
                            className={`ui-quick-menu ui-glass${minimapCollapsed ? " ui-quick-menu-collapsed" : ""}`}
                            disabled={busy}
                        >
                            {mode === "stepped" ? "계단형" : "매끈한 면"} ▾
                        </button>
                    </MenuTrigger>
                    <MenuPopover>
                        <MenuList>
                            <MenuItem onClick={() => changeMode("stepped")}>{mode === "stepped" ? "✓ " : ""}계단형</MenuItem>
                            <MenuItem onClick={() => changeMode("tin")}>{mode === "tin" ? "✓ " : ""}매끈한 면</MenuItem>
                        </MenuList>
                    </MenuPopover>
                </Menu>
            )}

            {/* 걸어 보기: 데스크톱 3D 화면 가운데 진입 알약, 들어가면 키 안내와 조준점(화면 시안 "걸어 보기") */}
            {!isMobile && view === "3d" && terrainReady && !busy && !walking && (
                <WalkPill position={walkPillPos} onMove={moveWalkPill} onClick={startWalking} />
            )}
            {walking && <WalkHud focused={walkFocused} showEscHint={escHint} onExit={stopWalking} />}
            {walking && (
                <WalkControls
                    physics={walkPhysics}
                    onChange={changeWalkPhysics}
                    onReset={() => {
                        setWalkPhysics(DEFAULT_WALK_PHYSICS)
                        writeStored("walkPhysics", DEFAULT_WALK_PHYSICS)
                    }}
                />
            )}

            {openPanel === "layers" && (
                <Panel title="레이어" onClose={() => setOpenPanel(null)} above={panelAbove}>
                    <LayersPanel
                        layers={layers}
                        onChange={setLayerFlag}
                        loading={{ buildings: !!buildingsLoading }}
                        notes={layerNotes}
                    />
                </Panel>
            )}
            {openPanel === "export" && (
                <Panel title="내려받기" onClose={() => setOpenPanel(null)} above={panelAbove}>
                    <ExportPanel exporting={exporting} onExport={startExport} included={included} />
                </Panel>
            )}
            {openPanel === "settings" && (
                <Panel title="설정" onClose={() => setOpenPanel(null)} above={panelAbove}>
                    <SettingsPanel
                        theme={theme}
                        onTheme={setTheme}
                        basemap={basemap}
                        onBasemap={setBasemap}
                        mode={mode}
                        onMode={changeMode}
                        modeDisabled={!terrainReady || busy}
                        stepInterval={stepInterval}
                        onStepInterval={changeStepInterval}
                    />
                </Panel>
            )}

            {/* 주소 검색은 지도 화면에서만. 3D 화면에서는 미니맵이 그 자리를 쓴다 */}
            {view === "map" && (
                <SearchBox
                    query={query}
                    onQueryChange={changeQuery}
                    status={searchStatus}
                    onSelect={selectSearchResult}
                    onLocate={locateMe}
                    onClear={clearSearch}
                />
            )}

            {/* 모바일 지도 화면에서 아무것도 안 하고 있을 때: 첫 할 일 안내(화면 시안 "모바일 · 지도") */}
            {isMobile && !selecting && view === "map" && !busy && (
                <HintPill text='아래 "범위"를 누르고 지도를 끌어 그리세요' />
            )}
            {selecting && view === "map" && (
                !HAS_FINE_POINTER ? (
                    <HintPill text="지도를 끌어 범위를 그리세요" />
                ) : selectPhase === "anchored" ? (
                    <HintPill text="다시 클릭하면 범위가 정해집니다" hint="Esc 취소" />
                ) : (
                    <HintPill text="지도를 클릭해 범위의 첫 모서리를 찍으세요" />
                )
            )}

            {isMobile ? (
                // 시트가 열려 있으면 알약은 시트 위에 얹혀 있다(above)
                openPanel ? null : mobilePill
            ) : (
                <StatusBar progress={progress} status={walking ? "걸어 보기 중" : undefined} stats={stats} menus={menus}>
                    {walking && (
                        <Button appearance="subtle" size="small" className="ui-statusbar-action" onClick={stopWalking}>
                            나가기
                        </Button>
                    )}
                    {view === "map" && terrainReady && !busy && (
                        <Button appearance="subtle" size="small" className="ui-statusbar-action" onClick={() => setView("3d")}>
                            3D로 돌아가기
                        </Button>
                    )}
                </StatusBar>
            )}
        </>
    )
}
