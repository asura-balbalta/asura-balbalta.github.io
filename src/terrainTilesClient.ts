import type { Extent } from "ol/extent"

import { BuildingTable, buildingTableBuffers, mergeBuildingTables } from "./buildingTable"
import type { TinMesh } from "./terrainData"
import type { TerrainTilesRequest, TerrainTilesResponse, TileData, TileStyle, TileSummary } from "./terrainTiles.worker"
import type { MeshBounds } from "./webgpu/terrainRenderer"

/** esbuild 가 src/terrainTiles.worker.ts 를 별도 entry 로 묶어 내는 파일. index.html 의 index.js 와 같은 폴더(dist)에 있다 */
const TERRAIN_TILES_WORKER_URL = "terrainTiles.worker.js"
/**
 * 계단형 조각의 버퍼 상한(바이트). 도엽 하나는 이보다 훨씬 작지만 GPU 한도(보통 256MB)보다 작게 두는 규칙은 유지한다
 */
const CHUNK_BYTES = 64 * 1048576

/** 도엽 집합에서 일어나는 일. 구독자(App 의 상태, 캔버스의 GPU 올리기)가 받는다 */
export type TerrainTilesEvent =
    | { type: "selection"; origin: [number, number]; tiles: TileSummary[]; sheets: number; center: [number, number] }
    | { type: "progress"; phase: "sheets" | "download" | "build"; done: number; total: number }
    | { type: "tile"; tile: TileData; first: boolean }
    | { type: "remove"; id: string }
    /** 표고 범위가 넓어졌을 때(도엽이 올라오며) */
    | { type: "bounds"; bounds: MeshBounds }
    | { type: "done" }
    | { type: "error"; message: string }

export type TerrainTilesClient = ReturnType<typeof createTerrainTiles>

/**
 * 지형 도엽 집합(terrainTiles.worker.ts 의 메인 쪽). 앱이 하나 만들어 평생 쓴다: 범위를 고르면 select, 표현 방식을 바꾸면
 * setStyle, 걸어 보기는 startWalk / updateWalk / stopWalk. 받은 도엽은 tiles 에 들고 있고(높이 조회·내보내기·통계),
 * 구독자에게 일어난 일을 알린다. 구독하면 이미 있는 선택·도엽·범위를 먼저 되풀이해 준다(늦게 붙은 캔버스도 같은 상태가 되게)
 */
/** 도엽 하나가 메인 스레드에 차지하는 바이트(지형 조각·원본 TIN·건물 메쉬·건물 표). 메모리 측정(2026-10-15) */
const tileBytes = (t: TileData) => {
    let chunks = 0
    for (const c of t.terrain) chunks += c.positions.byteLength + c.indices.byteLength + (c.normals?.byteLength ?? 0)
    const tin = t.tin.positions.byteLength + t.tin.indices.byteLength
    const buildings = t.buildings ? t.buildings.positions.byteLength + t.buildings.indices.byteLength : 0
    let table = 0
    if (t.buildingTable) for (const b of buildingTableBuffers(t.buildingTable)) table += b.byteLength
    return { chunks, tin, buildings, table }
}

export const createTerrainTiles = () => {
    const worker = new Worker(TERRAIN_TILES_WORKER_URL)
    const listeners = new Set<(event: TerrainTilesEvent) => void>()
    /** 로드된 도엽(선택 도엽 + 걸어 보기 밖 도엽) */
    const tiles = new Map<string, TileData>()
    let origin: [number, number] | null = null
    let summaries: TileSummary[] = []
    let sheets = 0
    /** 선택 사각형의 중심(원점 기준 m) */
    let center: [number, number] | null = null
    /** 선택 도엽의 xy 범위 + 지금까지 올라온 도엽의 z 범위 */
    let bounds: MeshBounds | null = null
    let receivedFirst = false
    let extraCount = 0

    const dispatch = (event: TerrainTilesEvent) => {
        for (const l of listeners) l(event)
    }
    const send = (msg: TerrainTilesRequest) => worker.postMessage(msg)
    /** 마지막 표현 방식(select·setStyle). 늦게 붙은 구독자에게 조각이 없는 도엽을 다시 만들어 줄 때 쓴다 */
    let currentStyle: TileStyle | null = null
    /** 들고 있는 도엽 사본의 바이트 합(선택 도엽·밖 도엽 수 포함) */
    const memoryStats = () => {
        const sum = { tiles: 0, extra: 0, chunks: 0, tin: 0, buildings: 0, table: 0 }
        for (const t of tiles.values()) {
            const b = tileBytes(t)
            sum.tiles++
            if (t.extra) sum.extra++
            sum.chunks += b.chunks
            sum.tin += b.tin
            sum.buildings += b.buildings
            sum.table += b.table
        }
        return { ...sum, total: sum.chunks + sum.tin + sum.buildings + sum.table }
    }
    const mb = (n: number) => (n / 1048576).toFixed(1)
    const logMemory = () => {
        const m = memoryStats()
        console.log(`메모리(메인 도엽 사본): 도엽 ${m.tiles}(밖 ${m.extra}), ${mb(m.total)} MB = 조각 ${mb(m.chunks)} + TIN ${mb(m.tin)} + 건물 ${mb(m.buildings)} + 표 ${mb(m.table)}`)
    }

    worker.onmessage = (e: MessageEvent<TerrainTilesResponse>) => {
        const msg = e.data
        if (msg.type === "selection") {
            tiles.clear()
            extraCount = 0
            origin = msg.origin
            summaries = msg.tiles
            sheets = msg.sheets
            center = msg.center
            receivedFirst = false
            const min: [number, number, number] = [Infinity, Infinity, Infinity]
            const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
            for (const t of msg.tiles) {
                min[0] = Math.min(min[0], t.bounds.min[0])
                min[1] = Math.min(min[1], t.bounds.min[1])
                max[0] = Math.max(max[0], t.bounds.max[0])
                max[1] = Math.max(max[1], t.bounds.max[1])
            }
            bounds = { min, max }
            dispatch({ type: "selection", origin: msg.origin, tiles: msg.tiles, sheets: msg.sheets, center: msg.center })
        } else if (msg.type === "tile") {
            const prev = tiles.get(msg.tile.id)
            if (prev?.extra) extraCount--
            tiles.set(msg.tile.id, msg.tile)
            if (msg.tile.extra) extraCount++
            // 메모리 측정(2026-10-15): 50개마다 메인 스레드가 든 도엽 사본의 바이트
            if (tiles.size % 50 === 0) logMemory()
            const first = !receivedFirst
            receivedFirst = true
            // z 범위는 도엽이 올라오며 넓어진다. 첫 도엽이면 z 가 비어 있으므로 반드시 알린다
            let widened = first
            if (bounds) {
                if (msg.tile.bounds.min[2] < bounds.min[2]) {
                    bounds.min[2] = msg.tile.bounds.min[2]
                    widened = true
                }
                if (msg.tile.bounds.max[2] > bounds.max[2]) {
                    bounds.max[2] = msg.tile.bounds.max[2]
                    widened = true
                }
            }
            if (widened && bounds) dispatch({ type: "bounds", bounds: { min: [...bounds.min], max: [...bounds.max] } })
            dispatch({ type: "tile", tile: msg.tile, first })
        } else if (msg.type === "remove") {
            const prev = tiles.get(msg.id)
            if (prev?.extra) extraCount--
            tiles.delete(msg.id)
            dispatch({ type: "remove", id: msg.id })
        } else if (msg.type === "progress") {
            dispatch(msg)
        } else if (msg.type === "done") {
            dispatch({ type: "done" })
        } else {
            dispatch({ type: "error", message: msg.message })
        }
    }
    worker.onerror = (e) => dispatch({ type: "error", message: `지형 도엽 Worker 오류: ${e.message}` })

    return {
        /** 로드된 도엽(id → 도엽). 바꾸지 말 것 */
        tiles,
        get origin() {
            return origin
        },
        /** 선택 도엽의 xy 범위와 지금까지의 z 범위. 선택 전이면 null */
        get bounds() {
            return bounds
        },
        /** 선택 도엽 수(목록 기준) */
        get selectionCount() {
            return summaries.length
        },
        get sheetCount() {
            return sheets
        },
        /** 선택 사각형의 중심(원점 기준 m). 걸어 보기 시작점. 선택 전이면 null */
        get selectionCenter() {
            return center
        },
        /** 걸어 보기 밖 도엽 수 */
        get extraCount() {
            return extraCount
        },
        /**
         * 일어나는 일을 받는다. 이미 선택이 있으면 selection·bounds·tile(첫 도엽 first) 을 먼저 되풀이한다
         *
         * @returns 구독 해제 함수
         */
        subscribe: (listener: (event: TerrainTilesEvent) => void) => {
            listeners.add(listener)
            if (origin && bounds && center) {
                listener({ type: "selection", origin, tiles: summaries, sheets, center })
                if (receivedFirst) listener({ type: "bounds", bounds: { min: [...bounds.min], max: [...bounds.max] } })
                let first = true
                let released = false
                for (const tile of tiles.values()) {
                    listener({ type: "tile", tile, first })
                    first = false
                    if (tile.terrain.length === 0) released = true
                }
                // 지형 조각을 이미 버린 도엽(releaseTerrain)은 되풀이로 올릴 수 없으므로 워커에 다시 만들어 달라고 한다(캐시라 빠르다)
                if (released && currentStyle) send({ type: "style", style: currentStyle })
            }
            return () => {
                listeners.delete(listener)
            }
        },
        /** 범위를 골랐을 때. 도엽 목록을 찾고 5K 파일을 받은 뒤 중심에서 가까운 순으로 도엽을 만든다. bbox 는 콘솔에 디버그 주소와 함께 찍는다 */
        select: (bbox: Extent, style: TileStyle) => {
            const text = bbox.map((v) => Math.round(v)).join(",")
            console.log(`선택 범위 bbox(3857): ${text}\n디버그 주소: ${location.origin}${location.pathname}#/debug/walk?bbox=${text}`)
            currentStyle = style
            send({ type: "select", bbox, style, maxBytes: CHUNK_BYTES })
        },
        /** 표현 방식·층 간격을 바꾼다. 들고 있는 도엽을 다시 만들어 교체한다(끝나면 done) */
        setStyle: (style: TileStyle) => {
            currentStyle = style
            send({ type: "style", style })
        },
        /**
         * 도엽의 지형 조각 사본을 버린다(메모리 M-A, 2026-10-15). 캔버스가 GPU 에 올린 뒤 부른다. 높이 조회·내보내기는 원본 TIN 만 쓰므로
         * 조각은 메인 스레드에 둘 이유가 없다(계단형 조각은 TIN 의 약 13배라 1364개 둘러보기에서 2.3 GB 였다). 다시 필요하면 워커가 캐시로 만든다
         */
        releaseTerrain: (id: string) => {
            const t = tiles.get(id)
            if (t) t.terrain = []
        },
        /** 도엽 id 목록을 워커가 다시 만들어 보내게 한다(GPU 에서 내렸던 도엽을 다시 올릴 때. 캐시라 빠르다) */
        rebuild: (ids: string[]) => {
            if (ids.length > 0) send({ type: "rebuild", ids })
        },
        /** 걸어 보기 시작·위치 갱신(5179 m). 선택 범위 밖 도엽을 반경 안에서 더한다 */
        updateWalk: (center: [number, number], radius: number, maxTiles: number) => send({ type: "walk", center, radius, maxTiles }),
        /** 걸어 보기 끝. 밖 도엽을 모두 뺀다 */
        stopWalk: () => send({ type: "walk", center: null, radius: 0, maxTiles: 0 }),
        /** 통계: 선택 도엽 수·삼각형·건물(밖 도엽 제외) */
        stats: () => {
            let triangles = 0
            let buildings = 0
            let count = 0
            for (const t of tiles.values()) {
                if (t.extra) continue
                count++
                triangles += t.tin.indices.length / 3
                buildings += t.built
            }
            return { count, triangles, buildings }
        },
        memory: memoryStats,
        /**
         * 선택 도엽(밖 도엽 제외)의 TIN·건물을 각각 한 메쉬로 합친다(내보내기용). 도엽 경계의 정점은 중복되지만 파일에는 무해하다.
         * 건물 메쉬에는 도엽별 건물 표를 정점·삼각형 오프셋에 맞춰 합친 표(table)를 붙여 SKP·3DM 이 건물마다 그룹·속성을 만들 수 있게 한다(L3)
         */
        mergedMeshes: (): { terrain: TinMesh | null; buildings: (TinMesh & { table?: BuildingTable }) | null } => {
            if (!origin) return { terrain: null, buildings: null }
            /** 메쉬들을 잇고 각 조각이 시작하는 정점·삼각형 번호를 돌려준다 */
            const concat = (parts: TinMesh[]): { mesh: TinMesh; offsets: { vertex: number; face: number }[] } | null => {
                if (parts.length === 0) return null
                let nv = 0
                let ni = 0
                for (const m of parts) {
                    nv += m.positions.length
                    ni += m.indices.length
                }
                const positions = new Float32Array(nv)
                const indices = new Uint32Array(ni)
                const offsets: { vertex: number; face: number }[] = []
                let ov = 0
                let oi = 0
                for (const m of parts) {
                    offsets.push({ vertex: ov / 3, face: oi / 3 })
                    positions.set(m.positions, ov)
                    const base = ov / 3
                    for (let i = 0; i < m.indices.length; i++) indices[oi + i] = m.indices[i] + base
                    ov += m.positions.length
                    oi += m.indices.length
                }
                return { mesh: { origin: origin!, positions, indices }, offsets }
            }
            const selected = [...tiles.values()].filter((t) => !t.extra)
            const withBuildings = selected.filter((t): t is TileData & { buildings: TinMesh } => !!t.buildings)
            const terrain = concat(selected.map((t) => t.tin))
            const buildings = concat(withBuildings.map((t) => t.buildings))
            let table: BuildingTable | null = null
            if (buildings && withBuildings.every((t) => t.buildingTable)) {
                table = mergeBuildingTables(
                    withBuildings.map((t, i) => ({ table: t.buildingTable!, vertexOffset: buildings.offsets[i].vertex, faceOffset: buildings.offsets[i].face })),
                )
            }
            return {
                terrain: terrain?.mesh ?? null,
                buildings: buildings ? (table ? { ...buildings.mesh, table } : buildings.mesh) : null,
            }
        },
        terminate: () => {
            worker.onmessage = null
            worker.onerror = null
            worker.terminate()
            listeners.clear()
        },
    }
}
