import React, { useEffect, useRef, useState } from "react"
import { FluentProvider } from "@fluentui/react-components"
import { ArrowMaximizeFilled } from "@fluentui/react-icons"
import { Map } from "ol"
import { Extent } from "ol/extent"
import { fromLonLat, toLonLat } from "ol/proj"
import { getDistance } from "ol/sphere"

// Firebase 앱 초기화(부수효과). 값은 아직 쓰지 않는다
import "./fb"
import { basemapAttribution, BasemapProvider } from "./basemap"
import { TerrainViewCanvas } from "./components/TerrainViewCanvas"
import type { ExportKind } from "./export/download"
import { exportableLayers, runExport } from "./export/runExport"
import { INITIAL_LAYER_STATES, LAYER_DEFS, LayerId, LayerStates } from "./layers"
import { applyMapTheme, initOlMap } from "./olmap"
import { SquarePhase, SquareTool } from "./squareTool"
import { createTerrainTiles, TerrainTilesClient, TerrainTilesEvent } from "./terrainTilesClient"
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
import { LIQUID_GLASS_DEFAULT, useLiquidGlass } from "./ui/liquidGlass"
import { WalkControls } from "./ui/WalkControls"
import { WalkHud } from "./ui/WalkHud"
import { OrbitHud } from "./ui/OrbitHud"
import { TargetHud } from "./ui/TargetHud"
import type { BuildingHit } from "./buildingPick"
import { PillPosition, WalkPill } from "./ui/WalkPill"
import { DEFAULT_WALK_PHYSICS, PlayerMove, WalkPhysics } from "./player"
import { clearPlayerMarker, showPlayerMarker } from "./playerMarker"
import { transform } from "ol/proj"
import { SearchBox, SearchStatus } from "./ui/SearchBox"
import { VWORLD_KEY } from "./config"
import { clearSearchPin, showSearchPin } from "./searchPin"
import { SearchHandle, searchPlaces, SearchResult, trimDanglingJamo } from "./vworld"
import { Button, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger } from "@fluentui/react-components"
import { MB_PER_TILE, SELECTION_TILE_LIMITS } from "./terrainIndex"
import { MeshBounds, RenderDebug, TerrainMode } from "./webgpu/terrainRenderer"

/**
 * 초기 상태 프리셋(디버그 페이지 src/debug/walk.tsx 가 주소 해시에서 만들어 넘긴다. 운영은 undefined).
 * 지도가 준비되면 bbox 를 사용자가 그린 것처럼 확정해 같은 로딩 경로를 타고, 3D 가 준비되면(walk) 둘러보기에 자동으로 들어간다.
 * 한 번만 적용한다(해시가 바뀌어도 범위를 다시 만들지 않는다)
 */
export type AppPreset = {
    /** 선택 범위(EPSG:3857 extent: minx, miny, maxx, maxy) */
    bbox?: Extent
    /** 3D 가 준비되면 둘러보기에 자동 진입 */
    walk?: boolean
    /** 둘러보기 시작 xy(메쉬 로컬, m) */
    spawn?: [number, number]
    /** 시작 방향(라디안. 0 = 동쪽, 반시계) */
    yaw?: number
    /** 시작 위아래 시점(라디안, 수평선 위로 +) */
    pitch?: number
}

/** 디버그 페이지에 알리는 앱 상태(준비 신호. 자동 캡처가 "도엽 스트리밍이 멈춤" 을 기다리는 데 쓴다) */
export type AppDebugState = {
    /** 로딩·변환 중(busy) */
    busy: boolean
    /** 둘러보기 중 */
    walking: boolean
    /** 둘러보기 중 들고 있는 주변 도엽 수 */
    tiles: number
}

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
/** 올라온 지형(도엽 집합)의 요약. 도엽이 하나씩 올라올 때마다 갱신된다. 원본 도엽은 TerrainTilesClient 가 든다 */
type TerrainInfo = {
    origin: [number, number]
    /** 선택 도엽의 xy 범위와 지금까지의 z 범위 */
    bounds: MeshBounds
    /** 올라온 선택 도엽 수 / 선택 도엽 수 */
    count: number
    total: number
    triangles: number
    buildings: number
}

/**
 * 마우스·트랙패드처럼 정밀한 포인터가 있는 기기인지. 처음 들어오면 범위 그리기 모드를 바로 켜고, 안내 문구를 클릭 방식으로
 * 고르는 데 쓴다(터치 기기는 끌기 안내). 선택 자체는 squareTool 이 입력마다 pointerType 으로 가르므로 터치 가능한 노트북에서도
 * 손가락 끌기는 동작한다
 */
const HAS_FINE_POINTER = typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches

/**
 * 이 브라우저가 WebGPU 를 노출하는지(navigator.gpu). 없으면 3D 지형을 만들 수 없으므로 진입 때 알리고 범위 그리기를 막는다.
 * adapter 까지는 보지 않으므로 adapter 가 없는 환경은 렌더러 생성 실패(TerrainViewCanvas onError)가 받는다.
 * 지원 브라우저에서 미지원 경로를 재현하는 것은 디버그 페이지 `#/debug/app?gpu=0`(AppEnv.webgpu)
 */
const WEBGPU_AVAILABLE = typeof navigator !== "undefined" && !!navigator.gpu

/**
 * 브라우저 환경 흉내(디버그 페이지 `#/debug/app`, src/debug/app.tsx). 없는 항목은 실제 브라우저 판별을 따른다. 운영은 undefined.
 * - webgpu: false 면 WebGPU 미지원 브라우저처럼(안내 토스트·알약, 범위 그리기 막음)
 * - glass: 리퀴드 글래스를 판별과 무관하게 켜거나 끔
 * - glassTint: 리퀴드 글래스 틴트 세기(기본 0.5. liquidGlass.ts)
 */
export type AppEnv = { webgpu?: boolean; glass?: boolean; glassTint?: number }

/** 상태 표시줄 왼쪽에 보일 진행 상태. ratio 가 없으면 진행 막대가 불확정으로 움직인다 */
type Progress = { label: string; ratio?: number }

/** 도엽 로딩 단계 → 진행 상태 문구 */
const tilesProgress = (phase: "sheets" | "download" | "build", done: number, total: number): Progress => {
    const ratio = total > 0 ? done / total : undefined
    switch (phase) {
        case "sheets":
            return { label: "도엽 목록 확인 중" }
        case "download":
            return { label: `지형 받는 중 ${done} / ${total}`, ratio }
        case "build":
            return { label: `도엽 만드는 중 ${done} / ${total}`, ratio }
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
 *
 * @param props.preset 초기 상태 프리셋(디버그 페이지). 운영은 없음
 * @param props.renderDebug 렌더 디버그 설정(디버그 페이지). 운영은 없음
 * @param props.onDebugState 앱 상태(busy·walking·도엽 수)가 바뀔 때(디버그 페이지의 준비 신호). 운영은 없음
 * @param props.env 브라우저 환경 흉내(디버그 페이지 `#/debug/app`). 운영은 없음
 */
export default function AppRoot({
    preset,
    renderDebug,
    onDebugState,
    env,
}: { preset?: AppPreset; renderDebug?: RenderDebug; onDebugState?: (state: AppDebugState) => void; env?: AppEnv } = {}) {
    const [theme, setTheme] = useState<Theme>(INITIAL_THEME)
    const isMobile = useMediaQuery(MOBILE_QUERY)
    /** 리퀴드 글래스 프로토타입의 루트(유리 요소·3D 캔버스의 부모) */
    const rootRef = useRef<HTMLDivElement | null>(null)
    return (
        <FluentProvider ref={rootRef} theme={fluentTheme(theme)} style={{ ...uiCssVars(theme), background: "transparent" }}>
            <App
                theme={theme}
                setTheme={setTheme}
                isMobile={isMobile}
                rootRef={rootRef}
                preset={preset}
                renderDebug={renderDebug}
                onDebugState={onDebugState}
                env={env}
            />
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
 * @param props.preset 초기 상태 프리셋(AppPreset). 지도 준비 뒤 bbox 확정, 3D 준비 뒤 둘러보기 진입
 * @param props.renderDebug 렌더 디버그 설정. TerrainViewCanvas 로 그대로 넘긴다
 * @param props.onDebugState 앱 상태가 바뀔 때(디버그 페이지의 준비 신호)
 * @param props.env 브라우저 환경 흉내(디버그 페이지). 없는 항목은 실제 판별(WEBGPU_AVAILABLE·LIQUID_GLASS_DEFAULT)
 */
function App({
    theme,
    setTheme,
    isMobile,
    rootRef,
    preset,
    renderDebug,
    onDebugState,
    env,
}: {
    theme: Theme
    setTheme: (theme: Theme) => void
    isMobile: boolean
    rootRef: React.RefObject<HTMLDivElement | null>
    preset?: AppPreset
    renderDebug?: RenderDebug
    onDebugState?: (state: AppDebugState) => void
    env?: AppEnv
}) {
    /** WebGPU 를 쓸 수 있는지. 페이지가 사는 동안 바뀌지 않는다 */
    const webgpuSupported = env?.webgpu ?? WEBGPU_AVAILABLE
    const glassEnabled = env?.glass ?? LIQUID_GLASS_DEFAULT
    const toast = useAppToast()
    // WebGPU 가 없으면 들어오자마자 알린다(닫을 때까지 남는 오류 토스트). 알약·범위 버튼 비활성은 아래 JSX 가 webgpuSupported 로 정한다.
    // AppToaster 는 App 뒤의 형제라 이 effect 시점엔 아직 등록 전이다(그때 띄우면 버려진다). 한 틱 뒤에 띄운다
    useEffect(() => {
        if (webgpuSupported) return
        const id = setTimeout(
            () =>
                toast.error(
                    "이 브라우저는 3D 지형을 볼 수 없습니다",
                    "WebGPU 가 꺼져 있거나 지원되지 않습니다. 최신 Chrome·Edge 또는 Safari 26 이상에서 열어 주세요.",
                ),
            0,
        )
        return () => clearTimeout(id)
    }, [toast, webgpuSupported])
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
    /** 올라온 지형 요약(첫 도엽부터). 없으면 아직 지형이 없다 */
    const [terrain, setTerrain] = useState<TerrainInfo | null>(null)
    /** 지형 도엽 집합(워커). 앱이 평생 하나 든다. 범위 선택·표현 방식 전환·걸어 보기 스트리밍이 모두 이것을 거친다 */
    const tilesRef = useRef<TerrainTilesClient | null>(null)
    if (!tilesRef.current) tilesRef.current = createTerrainTiles()
    const tiles = tilesRef.current
    useEffect(() => () => tiles.terminate(), [tiles])
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
    useLiquidGlass(glassEnabled && view === "3d" && !!terrain, rootRef, { tint: env?.glassTint })

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
        if (view !== "3d" || !terrain || isMobile) setWalking(false)
    }, [view, !!terrain, isMobile])
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
    useEffect(() => {
        onDebugState?.({ busy, walking, tiles: walkTileCount })
    }, [onDebugState, busy, walking, walkTileCount])
    /** 프리셋의 자동 둘러보기 진입을 한 번만 하기 위한 표시 */
    const presetWalkedRef = useRef(false)
    useEffect(() => {
        if (!preset?.walk || presetWalkedRef.current) return
        if (view !== "3d" || !terrainReady || busy || !terrain || isMobile) return
        presetWalkedRef.current = true
        startWalking()
    }, [preset, view, terrainReady, busy, !!terrain, isMobile])
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
    /** 진입 알약의 위치(끌어서 옮긴 것). null 이면 가운데. 새 지형을 만들면 가운데로 돌아간다(저장하지 않는다, 2026-10-13) */
    const [walkPillPos, setWalkPillPos] = useState<PillPosition | null>(null)
    useEffect(() => setWalkPillPos(null), [terrain?.origin])
    const moveWalkPill = (next: PillPosition) => setWalkPillPos(next)
    const stopWalking = () => {
        if (document.pointerLockElement) document.exitPointerLock()
        setWalking(false)
    }
    const onWalkMove = (move: PlayerMove) => {
        const map = mapRef.current
        if (!map || !terrain) return
        // 메쉬 좌표는 EPSG:5179(origin 을 뺀 m), 지도는 EPSG:3857. 5179 는 tileOverlay 가 OpenLayers 에 등록해 두었다
        const coord = transform([move.x + terrain.origin[0], move.y + terrain.origin[1]], "EPSG:5179", "EPSG:3857") as [number, number]
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
    /** 만드는 중인 내보내기 형식과 진행률 */
    const [exporting, setExporting] = useState<{ kind: ExportKind; ratio?: number } | null>(null)
    /** 걸어 보기 중 조준점이 가리키는 건물(TargetHud 요약·조준경 반응)과 클릭으로 고정한 건물(TargetHud 8행). 강조는 렌더러가 직접 */
    const [lookedBuilding, setLookedBuilding] = useState<BuildingHit | null>(null)
    const [pinnedBuilding, setPinnedBuilding] = useState<BuildingHit | null>(null)
    /** 펼친 정보를 더블클릭으로 고정했는지. 고정 중엔 조준점이 어디를 봐도 그대로이고 클릭도 무시한다(빈 곳 클릭·나가기는 해제) */
    const [buildingLocked, setBuildingLocked] = useState(false)
    // 펼친 상태(고정 아님)에서 조준점이 다른 건물에 걸리면 접고 그 건물 요약을 보인다(2026-10-15, by @nanangqq). 아무것도 안 보면 유지
    useEffect(() => {
        if (buildingLocked || !pinnedBuilding || !lookedBuilding) return
        if (lookedBuilding.tileId !== pinnedBuilding.tileId || lookedBuilding.index !== pinnedBuilding.index) setPinnedBuilding(null)
    }, [lookedBuilding])
    /** 클릭: 건물을 펼친다. 빈 곳(null)이면 접는다. 고정 중이면 그 건물이든 다른 건물이든 클릭으로 고정이 풀리고 그 건물의 펼침이 된다 */
    const pinBuilding = (hit: BuildingHit | null) => {
        setBuildingLocked(false)
        setPinnedBuilding(hit)
    }
    /** 더블클릭(클릭 뒤 350 ms 안 클릭): 펼친 정보가 있으면 고정한다. 고정 중이면 첫 클릭이 이미 풀었으므로 다시 건다 */
    const toggleBuildingLock = () => {
        if (pinnedBuilding) setBuildingLocked(true)
    }

    /**
     * 범위의 지형을 도엽 단위로 받아 올린다. 사각형 확정이 부른다. 진행·도엽·완료는 아래 구독이 받는다.
     * 이전 선택의 작업은 워커가 버린다(generation)
     */
    const startTerrainLoad = (bbox: Extent) => {
        setBusy(true)
        setTerrainProgress(null)
        setSelection(bbox)
        setSheetCount(null)
        tiles.select(bbox, { mode, step: stepInterval, band: renderDebug?.band })
    }
    /** 도엽 집합의 일을 상태로 옮긴다. 구독은 한 번만 하고, 처리 함수는 최신 상태를 보도록 ref 로 */
    const onTilesEventRef = useRef<(event: TerrainTilesEvent) => void>(() => {})
    onTilesEventRef.current = (event) => {
        if (event.type === "progress") {
            setTerrainProgress(tilesProgress(event.phase, event.done, event.total))
        } else if (event.type === "tile") {
            const stats = tiles.stats()
            if (tiles.origin && tiles.bounds) {
                setTerrain({
                    origin: tiles.origin,
                    bounds: tiles.bounds,
                    count: stats.count,
                    total: tiles.selectionCount,
                    triangles: stats.triangles,
                    buildings: stats.buildings,
                })
            }
            if (event.first) showTerrain()
        } else if (event.type === "done") {
            setBusy(false)
            setTerrainProgress(null)
        } else if (event.type === "selection") {
            // 메모리 M-C: 넓은 범위는 알리고 진행한다(상한 초과는 워커가 error kind "too-large" 로 거부)
            if (event.tiles.length >= SELECTION_TILE_LIMITS.warn) {
                toast.warning(
                    "넓은 범위입니다",
                    `1K 도엽 ${event.tiles.length.toLocaleString()}개. 만드는 데 몇 분이 걸리고 메모리를 약 ${((event.tiles.length * MB_PER_TILE) / 1024).toFixed(1)} GB 씁니다(상한 ${SELECTION_TILE_LIMITS.max.toLocaleString()}개).`,
                )
            }
        } else if (event.type === "error") {
            console.error(event.message)
            setBusy(false)
            setTerrainProgress(null)
            if (event.kind === "too-large") toast.error("범위가 너무 넓습니다", event.message)
            else toast.error("지형 데이터를 받지 못했습니다", event.message)
        }
    }
    useEffect(() => tiles.subscribe((event) => onTilesEventRef.current(event)), [tiles])

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
            // 데스크톱은 첫 할 일이 범위 그리기이므로 모드를 켜 둔 채 시작한다. 터치 기기는 레일 버튼으로 켠다. WebGPU 가 없으면 켜지 않는다
            if (HAS_FINE_POINTER && webgpuSupported) squareTool.setActive(true)
            // #map 의 높이는 CSS(.ui-map 100%)로 정해져 지도 생성 시점에 아직 0 일 수 있다. 다음 프레임에 크기를 다시 잰다
            requestAnimationFrame(() => map.updateSize())
            // 프리셋 범위(디버그 페이지): 사용자가 그린 것과 같은 확정 경로(도엽 외곽선 → startTerrainLoad)를 탄다
            const bbox = presetRef.current?.bbox
            if (bbox) {
                map.getView().fit(bbox, { padding: [20, 20, 20, 20] })
                squareTool.confirm(bbox)
            }
        })
    }, [])
    /** 지도 준비 콜백(마운트 때 한 번)이 최신 프리셋을 읽도록 ref 로 */
    const presetRef = useRef(preset)
    presetRef.current = preset

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

    /** 레이어 하나의 보기 또는 내보내기 포함을 바꾼다 */
    const setLayerFlag = (id: LayerId, key: "visible" | "export", value: boolean) =>
        setLayers((prev) => ({ ...prev, [id]: { ...prev[id], [key]: value } }))

    /** 표현 방식을 바꾼다. 지형이 있으면 도엽을 다시 만들어 교체하는 동안 busy 로 두고, 끝나면(done) 구독이 푼다 */
    const changeMode = (next: TerrainMode) => {
        if (next === mode) return
        setMode(next)
        if (terrain) {
            setBusy(true)
            setTerrainProgress(null)
            tiles.setStyle({ mode: next, step: stepInterval, band: renderDebug?.band })
        }
    }

    /** 계단 간격을 바꾼다. 계단형이면 도엽을 다시 만든다 */
    const changeStepInterval = (next: number) => {
        if (next === stepInterval) return
        setStepInterval(next)
        if (terrain && mode === "stepped") {
            setBusy(true)
            setTerrainProgress(null)
            tiles.setStyle({ mode, step: next, band: renderDebug?.band })
        }
    }

    /** 3D 가 준비됐을 때: 레이어·내려받기를 열고 3D 화면으로 */
    const showTerrain = () => {
        setTerrainReady(true)
        setView("3d")
    }

    /** "내보내기" 에 체크된 레이어를 한 파일로 만들어 내려받는다. 결과는 토스트로 알린다 */
    const startExport = (kind: ExportKind) => {
        if (exporting || !terrain) return
        const label = kind.toUpperCase()
        // 도엽을 하나로 합쳐 내보낸다(건물 속성 표는 아직 합치지 않는다. 계획서 L3)
        const meshes = tiles.mergedMeshes()
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
                    !included.includes("buildings") && layers.buildings.export && busy
                        ? "지형만 담았습니다. 건물은 아직 올라오는 중입니다."
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
          : null
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
    if (terrain) layerNotes.terrain = `삼각형 ${terrain.triangles.toLocaleString()}` + (terrain.count < terrain.total ? ` (도엽 ${terrain.count} / ${terrain.total})` : "")
    if (terrain) layerNotes.buildings = `${terrain.buildings.toLocaleString()} 동`

    const included = terrain ? exportableLayers({ terrain: true, buildings: terrain.buildings > 0 }, layers) : []

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
            {terrain && (
                <TerrainViewCanvas
                    tiles={tiles}
                    layers={layers}
                    mode={mode}
                    stepInterval={stepInterval}
                    theme={theme}
                    hidden={view === "map"}
                    walking={walking}
                    walkFocused={walkFocused}
                    onWalkMove={onWalkMove}
                    onWalkFocusChange={onWalkFocusChange}
                    walkPhysics={walkPhysics}
                    onWalkFrameTime={setWalkFrameMs}
                    onWalkTileCount={setWalkTileCount}
                    renderDebug={renderDebug}
                    walkStart={preset && { spawn: preset.spawn, yaw: preset.yaw, pitch: preset.pitch }}
                    onBuildingLook={setLookedBuilding}
                    onBuildingPin={pinBuilding}
                    onBuildingLock={toggleBuildingLock}
                    lockedBuilding={buildingLocked ? pinnedBuilding : null}
                    onError={(err) => {
                        // 렌더러를 못 만들면(어댑터 없음 등) 도엽은 받아도 올릴 곳이 없다. 원인을 보이고 잠금을 푼다
                        setBusy(false)
                        setTerrainProgress(null)
                        toast.error("3D 지형을 만들지 못했습니다", err.message)
                    }}
                />
            )}
            {/* 독(탭 막대)이 지도 틀보다 앞에 와야 Tab 키가 도구부터 닿는다. 겹침은 z-index 가 정한다. 걸어 보기 중에는 숨긴다 */}
            {!walking && (
                <Toolbar
                    drawing={selecting}
                    onToggleDraw={() => squareToolRef.current?.setActive(!selecting)}
                    drawDisabled={busy || !webgpuSupported}
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
            {/* 데스크톱 3D 화면: 미니맵 바로 아래 "지도로 돌아가기". 미니맵 틀 밖에 두어야 리퀴드 글래스가 그린다(MapFrame.tsx 머리말) */}
            {!isMobile && view === "3d" && (
                <button type="button" className="ui-minimap-return ui-glass" onClick={() => setView("map")} aria-label="지도 화면으로 돌아가기">
                    <ArrowMaximizeFilled fontSize={16} />
                    지도로 돌아가기
                </button>
            )}
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
            {/* 궤도 보기 중 위 가운데 마우스 조작 안내. 걸어 보기에 들어가면 같은 자리에 WalkHud 가 선다 */}
            {!isMobile && view === "3d" && terrainReady && !walking && <OrbitHud />}
            {walking && (
                <WalkHud
                    focused={walkFocused}
                    showEscHint={escHint}
                    onExit={stopWalking}
                    targeting={!!lookedBuilding}
                />
            )}
            {/* 둘러보기 중 조준점 오른쪽의 건물 정보(바라보면 요약, 클릭으로 고정하면 8행). 캔버스가 걸어 보기에서 나가면 둘 다 null */}
            {walking && walkFocused && <TargetHud looked={lookedBuilding} pinned={pinnedBuilding} locked={buildingLocked} />}
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
                        loading={{ buildings: busy && !!terrain && terrain.count < terrain.total }}
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

            {/* WebGPU 가 없으면 지도 화면에 상시 안내. 범위 버튼이 막혀 있어 아래 안내들은 뜨지 않는다 */}
            {!webgpuSupported && view === "map" && <HintPill text="이 브라우저는 3D 지형을 볼 수 없습니다." />}
            {/* 모바일 지도 화면에서 아무것도 안 하고 있을 때: 첫 할 일 안내(화면 시안 "모바일 · 지도") */}
            {webgpuSupported && isMobile && !selecting && view === "map" && !busy && (
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
                <StatusBar progress={progress} status={walking ? "둘러보는 중" : undefined} stats={stats} menus={menus}>
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
