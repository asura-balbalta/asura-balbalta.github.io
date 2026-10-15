import { Extent } from "ol/extent"

import type { TinMesh } from "./terrainData"
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
export type TtpTile = {
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

/** 범위 초과 오류 문구(km) */
const extentError = (wMm: number, hMm: number) =>
    new Error(`범위 초과: 가로 ${(wMm / 1e6).toFixed(1)}km × 세로 ${(hMm / 1e6).toFixed(1)}km (한도 134km × 67km)`)

/**
 * 도엽 폴리곤의 범위를 경계 띠 폭만큼 넓힌 범위(mergeTtpTiles 의 keep, L5-C). 보조 워커와 측정 스크립트(scripts/tileBandCheck.ts)가
 * 같은 규칙을 쓴다
 *
 * @param poly 도엽 폴리곤(원점 기준 m)
 * @param band 띠 폭(m)
 */
export const bandExtent = (poly: [number, number][], band: number): Extent => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const [x, y] of poly) {
        if (x < x0) x0 = x
        if (y < y0) y0 = y
        if (x > x1) x1 = x
        if (y > y1) y1 = y
    }
    return [x0 - band, y0 - band, x1 + band, y1 + band]
}

/** 점이 볼록 다각형(반시계 또는 시계) 안에 있는지(경계 포함 안 함) */
const strictlyInsidePolygon = (x: number, y: number, poly: [number, number][]) => {
    let sign = 0
    for (let i = 0; i < poly.length; i++) {
        const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length]
        const s = Math.sign((bx - ax) * (y - ay) - (by - ay) * (x - ax))
        if (s === 0) return false
        if (sign === 0) sign = s
        else if (s !== sign) return false
    }
    return true
}

/**
 * 띠 범위만 합친 삼각분할이 이웃 전체를 합친 것과 같은지 확인하는 값(L5-C). 도엽 폴리곤에 걸친 삼각형마다 외접원을 구해
 * keep 범위 밖으로 나가는 최대 거리(m)를 돌려준다. 0 이면 Delaunay 의 빈 원 조건이 keep 안에서 닫혀 전체 합침과 같은 결과다(제약
 * Delaunay 도 외접원 안의 보이는 점만 보므로 같다). 0 보다 크면 그만큼 띠를 넓혀 다시 만들어야 한다. keep 에 도엽 범위 자체를 주면
 * "이 도엽에 필요한 띠 폭" 이 된다. boundaryOnly 면 도엽 경계를 가로지르는(꼭짓점이 모두 도엽 안은 아닌) 삼각형만 본다: 안쪽 삼각형이
 * 전체와 달라도 이웃 도엽과의 균열은 아니므로, 균열 없음만 보장하려면 이쪽이 싸다.
 *
 * 반환은 변마다(서·남·동·북 = keep 의 minX·minY·maxX·maxY 쪽) 나간 거리라, 성긴 쪽만 넓힐 수 있다. 전체 최대는 Math.max(...).
 *
 * @param mesh 삼각분할된 메쉬(원점 기준 m, 자르기 전)
 * @param poly 도엽 폴리곤(원점 기준 m)
 * @param keep 합친 범위(원점 기준 m)
 * @param boundaryOnly 경계를 가로지르는 삼각형만(기본 false = 도엽에 걸친 모든 삼각형)
 * @returns [서, 남, 동, 북] 쪽으로 나간 최대 거리(m, 0 이상)
 */
export const circumcircleOverflow = (mesh: TinMesh, poly: [number, number][], keep: Extent, boundaryOnly = false): [number, number, number, number] => {
    const p = mesh.positions, idx = mesh.indices
    const tile = bandExtent(poly, 0)
    const overflow: [number, number, number, number] = [0, 0, 0, 0]
    for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
        const ax = p[a], ay = p[a + 1], bx = p[b], by = p[b + 1], cx = p[c], cy = p[c + 1]
        if (Math.max(ax, bx, cx) < tile[0] || Math.min(ax, bx, cx) > tile[2] || Math.max(ay, by, cy) < tile[1] || Math.min(ay, by, cy) > tile[3]) continue
        if (boundaryOnly && strictlyInsidePolygon(ax, ay, poly) && strictlyInsidePolygon(bx, by, poly) && strictlyInsidePolygon(cx, cy, poly)) continue
        const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
        if (d === 0) continue
        const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy
        const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d
        const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d
        const r = Math.hypot(ax - ux, ay - uy)
        overflow[0] = Math.max(overflow[0], keep[0] - (ux - r))
        overflow[1] = Math.max(overflow[1], keep[1] - (uy - r))
        overflow[2] = Math.max(overflow[2], ux + r - keep[2])
        overflow[3] = Math.max(overflow[3], uy + r - keep[3])
    }
    return overflow
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
 * keep 을 주면(도엽 생성의 경계 띠, 2026-10-15 L5-C) 그 범위 밖의 점은 넣지 않는다: 도엽 하나를 만들 때 이웃 3×3 전체 대신
 * "자기 도엽 범위를 띠 폭만큼 넓힌 범위" 안의 점만 합쳐 삼각분할 일을 줄인다. 범위를 가로지르는 조각 선분은 버리지 않고 범위 경계에서
 * 잘라 넣는다(잘린 점의 높이는 등고선 높이 그대로라 정확하다. 평지의 긴 선분이 통째로 빠지면 도엽 안 제약이 사라지기 때문). 같은 선의
 * 조각 잇기는 앞 조각의 진짜 끝점과 뒤 조각의 진짜 첫점이 모두 남았을 때만 잇는다. 1K 꼭짓점은 keep 밖이라도 넣는다(3×3 에 16개뿐):
 * 점이 성긴 곳(농지·강)은 띠 안에 점이 없어 볼록 껍질이 도엽 가장자리에 못 미쳐 구멍이 났다(충주 330개에서 경계 표본 1 ~ 5 % 가 빈 곳).
 * 결과가 전체 합침과 같은지는 circumcircleOverflow 로 확인한다(도엽에 걸친 삼각형의 외접원이 keep 안에 들면 Delaunay 의 빈 원 조건이
 * 국소적이라 전체와 같다).
 *
 * @param tiles 선택 범위에 걸린 1K 들
 * @param commonOrigin 공통 원점(정수 m)
 * @param keep 이 범위(공통 원점 기준 m, [minX, minY, maxX, maxY]) 안의 점만 넣는다(선택). 없으면 모두
 * @returns 삼각분할된 메쉬(원점 기준 m)
 */
export const mergeTtpTiles = (
    tiles: TtpTile[],
    commonOrigin: [number, number],
    keep?: Extent,
): TinMesh => {
    const t0 = performance.now()
    /** 파일 원점 기준 mm → 공통 원점 기준 mm 로 옮기는 오프셋 */
    const shift = (tile: TtpTile) => [(tile.origin[0] - commonOrigin[0]) * 1000, (tile.origin[1] - commonOrigin[1]) * 1000]
    /** 공통 원점 기준 mm 점을 넣을지(keep 범위 안인지). keep 이 없으면 모두. 변이 Infinity 면 그쪽은 제한 없음 */
    const keepMm = keep && keep.map((v) => v * 1000)
    const inside = (x: number, y: number) => !keepMm || (x >= keepMm[0] && x <= keepMm[2] && y >= keepMm[1] && y <= keepMm[3])

    // 1) 범위와 점 수 상한, 꼭짓점 사용 집계
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    let capacity = 0
    const cornerUse = new Map<string, { count: number; anyEmpty: boolean }>()
    /** 모든 점의 범위(keep 과 무관. keep 을 이 안으로 묶는 데 쓴다) */
    let allMinX = Infinity, allMinY = Infinity, allMaxX = -Infinity, allMaxY = -Infinity
    const extend = (x: number, y: number, always = false) => {
        if (x < allMinX) allMinX = x
        if (x > allMaxX) allMaxX = x
        if (y < allMinY) allMinY = y
        if (y > allMaxY) allMaxY = y
        if (!always && !inside(x, y)) return
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
    }
    for (const tile of tiles) {
        const [dx, dy] = shift(tile)
        const xy = tile.lineXY
        for (let i = 0; i < xy.length; i += 2) extend(xy[i] + dx, xy[i + 1] + dy)
        for (const pts of [tile.inserted, tile.alpt]) {
            for (let k = 0; k < pts.n; k++) extend(pts.xy[3 * k] + dx, pts.xy[3 * k + 1] + dy)
        }
        for (let k = 0; k < tile.corners.n; k++) extend(tile.corners.xy[3 * k] + dx, tile.corners.xy[3 * k + 1] + dy, true)
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
    if (keepMm) {
        // keep 을 점 범위 안으로 묶고(변이 Infinity 일 수 있다), 경계에서 잘린 점이 keep 범위 위 어디든 올 수 있으므로 키 계산의 기준을 keep 까지 넓힌다
        keepMm[0] = Math.max(keepMm[0], allMinX)
        keepMm[1] = Math.max(keepMm[1], allMinY)
        keepMm[2] = Math.min(keepMm[2], allMaxX)
        keepMm[3] = Math.min(keepMm[3], allMaxY)
        minX = Math.min(minX, Math.ceil(keepMm[0]))
        minY = Math.min(minY, Math.ceil(keepMm[1]))
        maxX = Math.max(maxX, Math.floor(keepMm[2]))
        maxY = Math.max(maxY, Math.floor(keepMm[3]))
    }
    if (maxX - minX >= KEY_X_SPAN || maxY - minY >= KEY_Y_SPAN) throw extentError(maxX - minX, maxY - minY)
    /**
     * 선분 (ax, ay)-(bx, by) 를 keep 범위로 자른다(Liang–Barsky). 잘린 끝점은 mm 정수로 반올림해 범위 안으로 묶는다.
     * 반환은 [x0, y0, x1, y1] 또는 null(범위를 안 지남)
     */
    const clipToKeep = (ax: number, ay: number, bx: number, by: number) => {
        const [kx0, ky0, kx1, ky1] = keepMm!
        const dx = bx - ax, dy = by - ay
        let t0 = 0, t1 = 1
        for (const [p, q] of [[-dx, ax - kx0], [dx, kx1 - ax], [-dy, ay - ky0], [dy, ky1 - ay]]) {
            if (p === 0) {
                if (q < 0) return null
                continue
            }
            const r = q / p
            if (p < 0) {
                if (r > t1) return null
                if (r > t0) t0 = r
            } else {
                if (r < t0) return null
                if (r < t1) t1 = r
            }
        }
        const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, Math.ceil(lo)), Math.floor(hi))
        return [
            clamp(Math.round(ax + dx * t0), kx0, kx1), clamp(Math.round(ay + dy * t0), ky0, ky1),
            clamp(Math.round(ax + dx * t1), kx0, kx1), clamp(Math.round(ay + dy * t1), ky0, ky1),
        ]
    }

    // 2) 점 합치기
    const coords = new Float64Array(2 * capacity)
    const zs = new Float32Array(capacity)
    const keyToIdx = new Map<number, number>()
    let n = 0
    let heightConflicts = 0
    /** 같은 (x, y) 면 기존 인덱스를, 아니면 새 점을 만들어 인덱스를 돌려준다. keep 밖이면 -1(always 면 keep 과 무관하게 넣는다) */
    const vertexOf = (x: number, y: number, z: number, always = false) => {
        if (!always && !inside(x, y)) return -1
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
    /** 조각 잇기용: 선 ID 별 조각의 양 끝 정점(남은 것 기준). wholeFirst·wholeLast 는 조각의 진짜 첫·끝점이 남았는지(keep 때문에 빠졌으면 false) */
    const pieceEnds: { lineId: number; startSeq: number; nPts: number; first: number; last: number; wholeFirst: boolean; wholeLast: boolean }[] = []
    let cornersUsed = 0
    for (const tile of tiles) {
        const [dx, dy] = shift(tile)
        const xy = tile.lineXY
        let c = 0
        for (const piece of tile.pieces) {
            let prev = -1
            let prevX = 0, prevY = 0
            let first = -1
            let last = -1
            let wholeFirst = false
            let wholeLast = false
            for (let k = 0; k < piece.nPts; k++, c++) {
                const x = xy[2 * c] + dx, y = xy[2 * c + 1] + dy
                const idx = vertexOf(x, y, piece.height)
                if (k > 0) {
                    if (idx >= 0 && prev >= 0) {
                        if (prev !== idx) segments.push(prev, idx)
                    } else if (keepMm) {
                        // 한쪽(또는 양쪽)이 keep 밖: 범위를 지나는 부분만 잘라 넣는다(높이는 등고선 높이)
                        const clipped = clipToKeep(prevX, prevY, x, y)
                        if (clipped) {
                            const i0 = prev >= 0 ? prev : vertexOf(clipped[0], clipped[1], piece.height)
                            const i1 = idx >= 0 ? idx : vertexOf(clipped[2], clipped[3], piece.height)
                            if (i0 >= 0 && i1 >= 0 && i0 !== i1) segments.push(i0, i1)
                        }
                    }
                }
                prev = idx
                prevX = x
                prevY = y
                if (idx < 0) continue
                if (first < 0) {
                    first = idx
                    wholeFirst = k === 0
                }
                last = idx
                wholeLast = k === piece.nPts - 1
            }
            if (first >= 0) pieceEnds.push({ lineId: piece.lineId, startSeq: piece.startSeq, nPts: piece.nPts, first, last, wholeFirst, wholeLast })
        }
        const empty = tile.pieces.length === 0
        for (let k = 0; k < tile.corners.n; k++) {
            const x = tile.corners.xy[3 * k] + dx, y = tile.corners.xy[3 * k + 1] + dy
            const use = cornerUse.get(`${x},${y}`)!
            if (use.count >= 4 && !use.anyEmpty && !empty) continue
            vertexOf(x, y, tile.corners.z[3 * k + 2], true)
            cornersUsed++
        }
        for (const pts of [tile.inserted, tile.alpt]) {
            for (let k = 0; k < pts.n; k++) vertexOf(pts.xy[3 * k] + dx, pts.xy[3 * k + 1] + dy, pts.z[3 * k + 2])
        }
    }

    // 3) 같은 선의 조각 잇기. startSeq 가 같은 조각(도엽 모서리에 걸친 한 점짜리 조각 등)은 짧은 것을 앞에 둬 순서를 고정한다
    //    (2026-10-15 L5-C 에서 발견: 입력 순서에 따라 긴 조각이 앞에 오면 gap 이 안 맞아 잇기가 빠지고, 그 선분이 제약에서 빠져 이웃
    //    도엽과 삼각형이 달라졌다. 충주 330개의 기존 균열 일부가 이것)
    pieceEnds.sort((a, b) => a.lineId - b.lineId || a.startSeq - b.startSeq || a.nPts - b.nPts)
    let joins = 0
    for (let i = 1; i < pieceEnds.length; i++) {
        const prev = pieceEnds[i - 1], next = pieceEnds[i]
        if (prev.lineId !== next.lineId) continue
        const gap = next.startSeq - (prev.startSeq + prev.nPts)
        if (gap !== 0 && gap !== -1) continue
        if (!prev.wholeLast || !next.wholeFirst) continue
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
        `ttp 합치기: 1K ${tiles.length}개${keep ? "(띠 범위만)" : ""}, 점 ${n}(상한 ${capacity}), 꼭짓점 사용 ${cornersUsed}, 조각 잇기 ${joins}, 높이 충돌 ${heightConflicts}, 제약 선분 ${segments.length / 2}, ${Math.round(performance.now() - t0)}ms`,
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
    return retriangulate(merged, tilePolygons, coords.subarray(0, 2 * n))
}

/** 적응 띠에서 한쪽 띠 폭이 이 값(m) 이상이 되면 그쪽은 제한을 푼다(이웃 두 겹(5×5)은 800 ~ 1000 m 까지라 더 넓혀도 같다) */
const BAND_MAX = 900
/** 적응 띠를 넓힐 때 나간 거리에 곱하는 배수. 2 로 해도 재시도가 줄지 않고(충주 330개 233 → 230) 한쪽 무한이 늘어 더 느렸다 → 1 */
const BAND_GROW = 1

/**
 * 도엽 하나를 위한 이웃 합치기·삼각분할(L5-C, 2026-10-15). 도엽 범위를 띠 폭 band 만큼 넓힌 범위의 점만 합쳐 삼각분할하고
 * (mergeTtpTiles 의 keep), 도엽에 걸친 삼각형의 외접원이 그 범위 밖으로 나가면(circumcircleOverflow) 나간 쪽만 그 거리만큼 넓혀
 * 다시 한다. 한쪽이 BAND_MAX 를 넘으면 그쪽은 제한 없음. 결과는 넘긴 이웃(5×5) 전체를 합친 것과 같다(빈 원 조건이 범위 안에서 닫히므로).
 * band 가 0 이면 이웃 전체를 한 번에 합친다(옛 동작. 5×5 라 느리다).
 *
 * 고정 띠만으로는 안 되는 이유(측정, scripts/tileBandCheck.ts): 점이 성긴 곳(농지·강)은 띠 안에 점이 없어 꼭짓점끼리 큰 삼각형으로
 * 메워진다(충주 330개 띠 200 m: 전체 대비 최대 52 m). 서울 도심처럼 점이 촘촘한 곳은 100 m 로 충분하다.
 *
 * @param tiles 도엽과 이웃(5×5)의 ttp 1K
 * @param commonOrigin 공통 원점(정수 m)
 * @param poly 도엽 폴리곤(원점 기준 m)
 * @param band 띠 폭(m). 0 이면 이웃 전체
 * @param boundaryOnly 외접원 검사를 경계를 가로지르는 삼각형만(균열 없음만 보장). 기본 false = 도엽에 걸친 모든 삼각형(전체와 같음 보장)
 * @returns 삼각분할된 메쉬(자르기 전), 실제 쓴 변별 띠 폭(서·남·동·북, Infinity = 제한 없음), 삼각분할 횟수
 */
export const mergeTtpTilesForTile = (
    tiles: TtpTile[],
    commonOrigin: [number, number],
    poly: [number, number][],
    band: number,
    boundaryOnly = false,
): { mesh: TinMesh; sides: [number, number, number, number]; attempts: number } => {
    const tile = bandExtent(poly, 0)
    const sides: [number, number, number, number] = band > 0 ? [band, band, band, band] : [Infinity, Infinity, Infinity, Infinity]
    const keepOf = (): Extent => [tile[0] - sides[0], tile[1] - sides[1], tile[2] + sides[2], tile[3] + sides[3]]
    let attempts = 0
    for (;;) {
        attempts++
        const mesh = mergeTtpTiles(tiles, commonOrigin, band > 0 ? keepOf() : undefined)
        if (band <= 0) return { mesh, sides, attempts }
        const overflow = circumcircleOverflow(mesh, poly, keepOf(), boundaryOnly)
        if (overflow.every((v) => v <= 0)) return { mesh, sides, attempts }
        for (let s = 0; s < 4; s++) {
            if (overflow[s] <= 0 || sides[s] === Infinity) continue
            // 나간 거리의 BAND_GROW 배 + 10 m 여유를 10 m 단위로(꼭 맞게만 넓히면 새로 들어온 점이 또 나가 재시도가 길어진다)
            sides[s] = Math.ceil((sides[s] + overflow[s] * BAND_GROW + 10) / 10) * 10
            if (sides[s] >= BAND_MAX) sides[s] = Infinity
        }
    }
}
