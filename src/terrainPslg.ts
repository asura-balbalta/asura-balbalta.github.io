import { Extent } from "ol/extent"

import { clipMeshToConvexPolygon } from "./terrainClip"
import { fetchGunzip, LoadProgress, TinMesh } from "./terrainData"
import { bboxToPolygon5179, getTtpSheetsInBbox, TTP_BASE } from "./terrainIndex"
import { retriangulate } from "./terrainRetri"

/** 등고선 조각: 한 1K 안에 들어온 한 선(line)의 연속 순번 구간 */
type TtpPiece = {
    lineId: number
    startSeq: number
    nPts: number
    lineNPts: number
    /** 선 높이(m, 정수) */
    height: number
    closed: boolean
}

/** 12B 레코드(x mm, y mm, z m) 구간. xy 는 Int32Array 의 3k, 3k+1, z 는 Float32Array 의 3k+2 */
type TtpPoints = { n: number; xy: Int32Array; z: Float32Array }

/** TTP1 파일 안의 1K 도엽 하나. 배열은 파일 버퍼를 가리키는 view 다 */
type TtpTile = {
    mapId: string
    /** 파일 원점(ESRI:102080, 정수 m) */
    origin: [number, number]
    pieces: TtpPiece[]
    /** 조각 점 x, y(파일 원점 기준 mm). 조각 순서대로 이어져 있다 */
    lineXY: Int32Array
    corners: TtpPoints
    inserted: TtpPoints
    alpt: TtpPoints
}

/**
 * TTP1 바이너리(gzip 을 푼 것)를 1K 단위로 나눈다. 복사 없이 view 로 만든다. 형식: 서버 README 7.1
 *
 * @param buf gzip 을 푼 파일 내용
 * @returns 파일 원점, 생성 옵션 플래그, 1K 목록(목차 순서)
 */
export const parseTtp = (buf: ArrayBuffer) => {
    const dv = new DataView(buf)
    const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4))
    if (magic !== "TTP1") throw new Error("TTP1 파일이 아님")
    const T = dv.getUint32(4, true)
    const origin: [number, number] = [dv.getInt32(8, true), dv.getInt32(12, true)]
    const P = dv.getUint32(16, true)
    const C = dv.getUint32(20, true)
    const Q = dv.getUint32(24, true)
    const genFlags = dv.getUint32(28, true)
    let off = 32
    const toc = new Uint32Array(buf, off, 8 * T)
    off += 32 * T
    const pieceU = new Uint32Array(buf, off, 6 * P)
    const pieceI = new Int32Array(buf, off, 6 * P)
    off += 24 * P
    const lineXY = new Int32Array(buf, off, 2 * C)
    off += 8 * C
    const extraI = new Int32Array(buf, off, 3 * Q)
    const extraF = new Float32Array(buf, off, 3 * Q)

    const tiles: TtpTile[] = []
    let p0 = 0
    let c0 = 0
    let q0 = 0
    for (let i = 0; i < T; i++) {
        const [mapId, nP, nC, nCo, nIns, nAl] = toc.subarray(8 * i, 8 * i + 6)
        const pieces: TtpPiece[] = []
        for (let k = p0; k < p0 + nP; k++) {
            pieces.push({
                lineId: pieceU[6 * k],
                startSeq: pieceU[6 * k + 1],
                nPts: pieceU[6 * k + 2],
                lineNPts: pieceU[6 * k + 3],
                height: pieceI[6 * k + 4],
                closed: (pieceU[6 * k + 5] & 1) === 1,
            })
        }
        const extra = (n: number): TtpPoints => {
            const o = q0
            q0 += n
            return { n, xy: extraI.subarray(3 * o, 3 * (o + n)), z: extraF.subarray(3 * o, 3 * (o + n)) }
        }
        tiles.push({
            mapId: String(mapId).padStart(9, "0"),
            origin,
            pieces,
            lineXY: lineXY.subarray(2 * c0, 2 * (c0 + nC)),
            corners: extra(nCo),
            inserted: extra(nIns),
            alpt: extra(nAl),
        })
        p0 += nP
        c0 += nC
    }
    return { origin, genFlags, tiles }
}

/** mm 정수 (x, y) 를 53비트 키 하나로. 범위는 최소값 기준 x < 2^27 mm(134km), y < 2^26 mm(67km) */
const KEY_X_SPAN = 2 ** 27
const KEY_Y_SPAN = 2 ** 26

/** 범위 초과 오류 문구(km). 받기 전 검사와 합치기 검사가 같은 문구를 쓴다 */
const extentError = (wMm: number, hMm: number) =>
    new Error(`범위 초과: 가로 ${(wMm / 1e6).toFixed(1)}km × 세로 ${(hMm / 1e6).toFixed(1)}km (한도 134km × 67km)`)

/**
 * 인덱스의 1K 꼭짓점(5179 m)만으로 범위를 미리 재서 한도를 넘으면 파일을 받기 전에 막는다. 꼭짓점은 점 좌표를 감싸므로
 * 여기서 통과하면 mergeTtpTiles 의 검사도 통과한다(그쪽은 안전망으로 남긴다)
 *
 * @param tiles 선택 범위에 걸친 1K(corners 는 EPSG:5179 m)
 */
const assertExtentWithinLimit = (tiles: { corners: [number, number][] }[]) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const t of tiles) {
        for (const [x, y] of t.corners) {
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
        }
    }
    if (tiles.length === 0) return
    const wMm = (maxX - minX) * 1000
    const hMm = (maxY - minY) * 1000
    if (wMm >= KEY_X_SPAN || hMm >= KEY_Y_SPAN) throw extentError(wMm, hMm)
}

/**
 * 선택한 1K 들의 점·조각을 공통 원점 기준으로 합쳐 제약 Delaunay 입력을 만들고 삼각분할한다. 규칙: 서버 README 7.2
 *
 * 1. 점 집합 = 조각 점 + 꼭짓점 + 삽입점 + 표고점. (x, y) mm 가 같은 점은 하나로 합친다(경계 공유 점 등).
 *    꼭짓점은 선택 범위 바깥쪽(그 꼭짓점을 쓰는 선택 1K 가 4개 미만)만 넣되, 조각이 0개인 1K(빈 도엽)가 쓰는 꼭짓점은
 *    안쪽이어도 넣는다(그 도엽의 유일한 높이 정보).
 * 2. 제약 선분 = 조각 안의 연속한 점 쌍 + 같은 선의 조각 잇기(다음.startSeq 가 앞.startSeq + 앞.nPts 이거나 그보다 1 작을 때).
 *    닫힌 고리는 원본이 첫 점을 끝에 반복하므로 따로 닫지 않는다.
 * 3. 삼각분할은 mm 정수 좌표(Float64Array)로 하고, GPU 용 positions 는 float32 m 로 따로 만든다.
 *
 * @param tiles 선택 범위에 걸린 1K 들
 * @param commonOrigin 공통 원점(정수 m)
 * @param onProgress 단계별 진행률. "merge" 는 도엽 하나를 합칠 때마다(합친 수, 전체), 재삼각분할 직전에 "retriangulate"
 * @returns 삼각분할된 메쉬(원점 기준 m)
 */
const mergeTtpTiles = (
    tiles: TtpTile[],
    commonOrigin: [number, number],
    onProgress?: LoadProgress,
): TinMesh => {
    const t0 = performance.now()
    /** 파일 원점 기준 mm → 공통 원점 기준 mm 로 옮기는 오프셋 */
    const shift = (tile: TtpTile) => [(tile.origin[0] - commonOrigin[0]) * 1000, (tile.origin[1] - commonOrigin[1]) * 1000]

    // 1) 범위와 점 수 상한, 꼭짓점 사용 집계
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    let capacity = 0
    const cornerUse = new Map<string, { count: number; anyEmpty: boolean }>()
    const extend = (x: number, y: number) => {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
    }
    for (const tile of tiles) {
        const [dx, dy] = shift(tile)
        const xy = tile.lineXY
        for (let i = 0; i < xy.length; i += 2) extend(xy[i] + dx, xy[i + 1] + dy)
        for (const pts of [tile.corners, tile.inserted, tile.alpt]) {
            for (let k = 0; k < pts.n; k++) extend(pts.xy[3 * k] + dx, pts.xy[3 * k + 1] + dy)
        }
        capacity += xy.length / 2 + tile.corners.n + tile.inserted.n + tile.alpt.n
        const empty = tile.pieces.length === 0
        for (let k = 0; k < tile.corners.n; k++) {
            const key = `${tile.corners.xy[3 * k] + dx},${tile.corners.xy[3 * k + 1] + dy}`
            const use = cornerUse.get(key) ?? { count: 0, anyEmpty: false }
            use.count++
            use.anyEmpty ||= empty
            cornerUse.set(key, use)
        }
    }
    if (capacity === 0) throw new Error("선택 범위에 점이 없음")
    if (maxX - minX >= KEY_X_SPAN || maxY - minY >= KEY_Y_SPAN) throw extentError(maxX - minX, maxY - minY)

    // 2) 점 합치기
    const coords = new Float64Array(2 * capacity)
    const zs = new Float32Array(capacity)
    const keyToIdx = new Map<number, number>()
    let n = 0
    let heightConflicts = 0
    /** 같은 (x, y) 면 기존 인덱스를, 아니면 새 점을 만들어 인덱스를 돌려준다 */
    const vertexOf = (x: number, y: number, z: number) => {
        const key = (x - minX) * KEY_Y_SPAN + (y - minY)
        let idx = keyToIdx.get(key)
        if (idx === undefined) {
            idx = n++
            keyToIdx.set(key, idx)
            coords[2 * idx] = x
            coords[2 * idx + 1] = y
            zs[idx] = z
        } else if (zs[idx] !== z) {
            heightConflicts++
        }
        return idx
    }
    const segments: number[] = []
    /** 조각 잇기용: 선 ID 별 조각의 양 끝 정점 */
    const pieceEnds: { lineId: number; startSeq: number; nPts: number; first: number; last: number }[] = []
    let cornersUsed = 0
    for (const [tileIndex, tile] of tiles.entries()) {
        const [dx, dy] = shift(tile)
        const xy = tile.lineXY
        let c = 0
        for (const piece of tile.pieces) {
            let prev = -1
            let first = -1
            for (let k = 0; k < piece.nPts; k++, c++) {
                const idx = vertexOf(xy[2 * c] + dx, xy[2 * c + 1] + dy, piece.height)
                if (first < 0) first = idx
                if (prev >= 0 && prev !== idx) segments.push(prev, idx)
                prev = idx
            }
            if (first >= 0) pieceEnds.push({ lineId: piece.lineId, startSeq: piece.startSeq, nPts: piece.nPts, first, last: prev })
        }
        const empty = tile.pieces.length === 0
        for (let k = 0; k < tile.corners.n; k++) {
            const x = tile.corners.xy[3 * k] + dx, y = tile.corners.xy[3 * k + 1] + dy
            const use = cornerUse.get(`${x},${y}`)!
            if (use.count >= 4 && !use.anyEmpty && !empty) continue
            vertexOf(x, y, tile.corners.z[3 * k + 2])
            cornersUsed++
        }
        for (const pts of [tile.inserted, tile.alpt]) {
            for (let k = 0; k < pts.n; k++) vertexOf(pts.xy[3 * k] + dx, pts.xy[3 * k + 1] + dy, pts.z[3 * k + 2])
        }
        // 처리가 끝난 뒤에 보고해야 마지막이 (전체, 전체)가 된다(앞에서 보고하면 전체−1 에서 멈춘 것처럼 보인다)
        onProgress?.("merge", tileIndex + 1, tiles.length)
    }

    // 3) 같은 선의 조각 잇기
    pieceEnds.sort((a, b) => a.lineId - b.lineId || a.startSeq - b.startSeq)
    let joins = 0
    for (let i = 1; i < pieceEnds.length; i++) {
        const prev = pieceEnds[i - 1], next = pieceEnds[i]
        if (prev.lineId !== next.lineId) continue
        const gap = next.startSeq - (prev.startSeq + prev.nPts)
        if (gap !== 0 && gap !== -1) continue
        if (prev.last !== next.first) segments.push(prev.last, next.first)
        joins++
    }

    const positions = new Float32Array(3 * n)
    for (let i = 0; i < n; i++) {
        positions[3 * i] = coords[2 * i] / 1000
        positions[3 * i + 1] = coords[2 * i + 1] / 1000
        positions[3 * i + 2] = zs[i]
    }
    console.log(
        `ttp 합치기: 1K ${tiles.length}개, 점 ${n}(상한 ${capacity}), 꼭짓점 사용 ${cornersUsed}, 조각 잇기 ${joins}, 높이 충돌 ${heightConflicts}, 제약 선분 ${segments.length / 2}, ${Math.round(performance.now() - t0)}ms`,
    )
    const merged: TinMesh = {
        origin: commonOrigin,
        positions,
        indices: new Uint32Array(0),
        segments: new Uint32Array(segments),
    }
    const tilePolygons = tiles.map((tile) => {
        const [dx, dy] = shift(tile)
        const poly: [number, number][] = []
        for (let k = 0; k < tile.corners.n; k++) {
            poly.push([(tile.corners.xy[3 * k] + dx) / 1000, (tile.corners.xy[3 * k + 1] + dy) / 1000])
        }
        return poly
    })
    onProgress?.("retriangulate", 0, 1)
    return retriangulate(merged, tilePolygons, coords.subarray(0, 2 * n))
}

/**
 * 지도에서 고른 범위의 지형 메쉬를 ttp(terrain_tile_pslg) 파일로 만든다. loadTerrainTtm 의 ttp 판.
 *
 * 1. 정적 인덱스(R2, terrainIndex)로 범위에 걸친 1K 와 5K 파일(path) 조회. 1K 꼭짓점으로 범위 한도를 먼저 검사
 * 2. 5K 파일들을 병렬로 받아 풀기
 * 3. 범위에 걸친 1K 만 골라 공통 원점으로 합치고 재삼각분할(mergeTtpTiles)
 * 4. 선택 사각형(5179 로 바꾼 네 모서리)으로 잘라 그린 범위만 남김(clipMeshToConvexPolygon)
 *
 * @param bbox3857 지도에서 고른 범위 [minX, minY, maxX, maxY] (EPSG:3857)
 * @param options.onProgress 단계별 진행률(loadTerrainTtm 과 같은 단계)
 * @returns 렌더러에 넘길 메쉬(선택 범위 안)
 */
export const loadTerrainTtp = async (
    bbox3857: Extent,
    options: { onProgress?: LoadProgress } = {},
): Promise<TinMesh> => {
    const { onProgress } = options
    const t0 = performance.now()
    onProgress?.("sheets", 0, 1)
    const q = await getTtpSheetsInBbox(bbox3857)
    // 범위 한도는 파일을 받기 전에 인덱스의 꼭짓점으로 미리 잰다(받고 나서 알려 주면 그 시간이 아깝다)
    assertExtentWithinLimit(q.tiles)
    const t1 = performance.now()
    let downloaded = 0
    onProgress?.("download", 0, q.sheets.length)
    const files = await Promise.all(
        q.sheets.map(async (s) => {
            const file = parseTtp(await fetchGunzip(`${TTP_BASE}/${s.path}`))
            onProgress?.("download", ++downloaded, q.sheets.length)
            return file
        }),
    )
    const t2 = performance.now()
    const want = new Set(q.tiles.map((t) => t.map_id))
    const allTiles = files.flatMap((f) => f.tiles)
    const selected = allTiles.filter((t) => want.has(t.mapId))
    console.log(
        `TTP: 5K 파일 ${files.length}개(gen_flags ${files[0]?.genFlags}), 1K ${selected.length}/${allTiles.length}개 사용 (조회 ${Math.round(t1 - t0)}ms, 받기 ${Math.round(t2 - t1)}ms)`,
    )
    onProgress?.("merge", 0, selected.length)
    const merged = mergeTtpTiles(selected, q.origin, onProgress)
    // 걸친 1K 전체가 아니라 지도에서 그린 사각형만 남긴다(도엽 가장자리의 바늘 삼각형 제거, terrainClip 참고)
    const [ox, oy] = q.origin
    const selection = bboxToPolygon5179(bbox3857).map(([x, y]) => [x - ox, y - oy] as [number, number])
    const t3 = performance.now()
    const clipped = clipMeshToConvexPolygon(merged, selection)
    console.log(`자르기 ${Math.round(performance.now() - t3)}ms`)
    return clipped
}
