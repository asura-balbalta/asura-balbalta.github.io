import earcut from "earcut"

import { createTerrainSampler, TerrainSampler } from "./terrainSampler"
import type { MeshChunk, TinMesh } from "./terrainData"

/**
 * 2D 다각형을 지형 TIN 위에 "얹는" 공용 기하(2026-10-22 roadsMesh.ts 에서 분리. 도로·물 레이어가 같이 쓴다).
 *
 * 지형 TIN 은 삼각형 안에서 평면이고 변에서만 꺾이므로, 다각형이 그 변마다 같이 꺾이면 지형에 정확히 얹힌다:
 * - A. subdivideRing: 고리의 변마다 지형 삼각형 변과의 교점을 끼워 넣는다 → 가장자리가 지형을 따라 꺾인다.
 * - B. createDrapeBuilder().drape: earcut 로 만든 삼각형을 그 아래 지형 삼각형들로 자른다(clipConvex, Sutherland–Hodgman) → 조각마다 지형
 *   삼각형 하나 위의 평면 조각이 되어 안쪽까지 정확히 얹힌다. z 는 그 지형 삼각형 평면에서, 법선은(지형 법선을 주면) 같은 무게중심 가중치로 보간.
 * 결과 메쉬는 지형과 같은 평면에 놓인 값 그대로(띄움 없음)다. 띄움(liftMesh)·계단화 뒤 벽 밀기(liftSteppedChunk)는 호출자가 화면 조각·내보내기에서 한다.
 *
 * 이 모듈은 proj4 같은 큰 의존성이 없다(내보내기 Worker 가 import 한다. earcut 은 작다)
 */

/** 띠 모서리의 마이터 길이 상한(폭의 배수). 예각에서 모서리가 길게 뻗는 것을 막는다 */
const MITER_LIMIT = 2
/** B 에서 버리는 조각 넓이 하한(m²). 1 cm² */
export const MIN_PIECE_AREA = 1e-4

/** 고리(x, y 쌍, 닫는 점 없음)의 부호 있는 넓이 × 2(반시계 양수) */
export const ringArea2 = (r: number[]) => {
    let s = 0
    const n = r.length / 2
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n
        s += r[2 * i] * r[2 * j + 1] - r[2 * j] * r[2 * i + 1]
    }
    return s
}

/**
 * 선을 폭 w 의 띠로 만든다. 꼭짓점마다 양옆 선분의 법선 평균 방향으로 마이터(길이 w/2 ÷ cos(θ/2), 상한 MITER_LIMIT)를 두어 모서리가
 * 이어지게 하고, 선분마다 [오른쪽 i, 오른쪽 i+1, 왼쪽 i+1, 왼쪽 i] 사각형(반시계)을 낸다. 이웃 사각형은 마이터 점을 공유하므로 틈·겹침이
 * 없다. 선분마다 사각형 하나로 두는 이유: 긴 고리 하나로 두면 earcut 가 낸 길고 가는 삼각형의 bbox 가 커서 B 의 클리핑이 지형 삼각형
 * 수백 개를 훑었다(2026-10-19 남산 등산로에서 도엽당 3초). 점이 2개 미만이거나 길이가 0 이면 빈 배열
 *
 * @param xy (x, y) 연속 mm 정수
 * @param w 폭(m)
 * @param skipSegment 선분 i(점 i → i+1)를 뺄지(물: 수면 폴리곤 안 구간). 없으면 전부
 */
export const ribbonQuads = (xy: Int32Array, w: number, skipSegment?: (i: number, pts: [number, number][]) => boolean): number[][] => {
    const pts: [number, number][] = []
    for (let i = 0; i < xy.length; i += 2) {
        const p: [number, number] = [xy[i] / 1000, xy[i + 1] / 1000]
        const last = pts[pts.length - 1]
        if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-3) pts.push(p)
    }
    const n = pts.length
    if (n < 2) return []
    const half = w / 2
    const left: number[] = [], right: number[] = []
    for (let i = 0; i < n; i++) {
        // 앞·뒤 선분의 단위 법선(왼쪽)
        const dirs: [number, number][] = []
        if (i > 0) dirs.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]])
        if (i + 1 < n) dirs.push([pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]])
        const normals = dirs.map(([dx, dy]) => {
            const len = Math.hypot(dx, dy)
            return [-dy / len, dx / len] as [number, number]
        })
        let nx = 0, ny = 0
        for (const [a, b] of normals) {
            nx += a
            ny += b
        }
        const len = Math.hypot(nx, ny)
        let ox: number, oy: number
        if (len < 1e-9) {
            // 180° 되돌아오는 꺾임: 첫 법선만
            ox = normals[0][0] * half
            oy = normals[0][1] * half
        } else {
            nx /= len
            ny /= len
            // 마이터 길이 = half / cos(θ/2). cos(θ/2) = 평균 법선과 한쪽 법선의 내적
            const cosHalf = Math.max(nx * normals[0][0] + ny * normals[0][1], 1 / MITER_LIMIT)
            ox = (nx * half) / cosHalf
            oy = (ny * half) / cosHalf
        }
        left.push(pts[i][0] + ox, pts[i][1] + oy)
        right.push(pts[i][0] - ox, pts[i][1] - oy)
    }
    const quads: number[][] = []
    for (let i = 0; i + 1 < n; i++) {
        if (skipSegment?.(i, pts)) continue
        const q = [right[2 * i], right[2 * i + 1], right[2 * i + 2], right[2 * i + 3], left[2 * i + 2], left[2 * i + 3], left[2 * i], left[2 * i + 1]]
        if (ringArea2(q) > 1e-6) quads.push(q)
    }
    return quads
}

/**
 * A: 고리의 변마다 지형 삼각형 변과의 교점을 끼워 넣는다. 변 p→q 가 지나는 격자 상자의 삼각형마다 세 변과의 교차 매개변수 t 를 모아
 * 정렬·중복 제거(1 mm 안)하고 그 자리에 점을 더한다. 지형 정점이 변 위에 있으면 양옆 변이 같은 t 를 주므로 중복 제거로 하나가 된다
 */
export const subdivideRing = (ring: number[], sampler: TerrainSampler, P: Float32Array, I: Uint32Array): number[] => {
    const out: number[] = []
    const n = ring.length / 2
    const ts: number[] = []
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n
        const px = ring[2 * i], py = ring[2 * i + 1]
        const qx = ring[2 * j], qy = ring[2 * j + 1]
        out.push(px, py)
        const dx = qx - px, dy = qy - py
        const len = Math.hypot(dx, dy)
        if (len < 1e-6) continue
        ts.length = 0
        sampler.forTrianglesInBox(Math.min(px, qx), Math.min(py, qy), Math.max(px, qx), Math.max(py, qy), (t) => {
            for (let e = 0; e < 3; e++) {
                const a = I[3 * t + e] * 3, b = I[3 * t + ((e + 1) % 3)] * 3
                const ax = P[a], ay = P[a + 1], bx = P[b], by = P[b + 1]
                const ex = bx - ax, ey = by - ay
                const den = dx * ey - dy * ex
                if (Math.abs(den) < 1e-12) continue
                // p + s·d = a + u·e
                const s = ((ax - px) * ey - (ay - py) * ex) / den
                const u = ((ax - px) * dy - (ay - py) * dx) / den
                if (s <= 0 || s >= 1 || u < -1e-9 || u > 1 + 1e-9) continue
                ts.push(s)
            }
        })
        if (ts.length === 0) continue
        ts.sort((a, b) => a - b)
        let last = 0
        for (const s of ts) {
            if ((s - last) * len < 1e-3 || (1 - s) * len < 1e-3) continue
            out.push(px + dx * s, py + dy * s)
            last = s
        }
    }
    return out
}

/** 볼록 다각형(x, y 쌍)을 반시계 삼각형 (ax, ay, bx, by, cx, cy) 로 자른다(Sutherland–Hodgman). 결과는 x, y 쌍 */
export const clipConvex = (poly: number[], ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number[] =>
    clipByEdges(poly, [
        [ax, ay, bx, by],
        [bx, by, cx, cy],
        [cx, cy, ax, ay],
    ])

/** 볼록 다각형(x, y 쌍)을 반시계 경계의 변 목록(각 변의 왼쪽이 안)으로 자른다(Sutherland–Hodgman) */
export const clipByEdges = (poly: number[], edges: [number, number, number, number][]): number[] => {
    let input = poly
    for (const [ex0, ey0, ex1, ey1] of edges) {
        if (input.length < 6) return []
        const out: number[] = []
        const dx = ex1 - ex0, dy = ey1 - ey0
        const side = (x: number, y: number) => dx * (y - ey0) - dy * (x - ex0)
        const n = input.length / 2
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n
            const x0 = input[2 * i], y0 = input[2 * i + 1]
            const x1 = input[2 * j], y1 = input[2 * j + 1]
            const s0 = side(x0, y0), s1 = side(x1, y1)
            if (s0 >= 0) out.push(x0, y0)
            if ((s0 >= 0) !== (s1 >= 0)) {
                const t = s0 / (s0 - s1)
                out.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)
            }
        }
        input = out
    }
    return input
}

/** 볼록 폴리곤(원점 기준 m)을 반시계로 맞춘 변 목록. 점이 3개 미만이면 null(자르지 않는다) */
export const boundaryEdgesOf = (clipTo: [number, number][] | undefined): [number, number, number, number][] | null => {
    if (!clipTo || clipTo.length < 3) return null
    const pts = [...clipTo]
    let area2 = 0
    for (let i = 0; i < pts.length; i++) {
        const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length]
        area2 += x0 * y1 - x1 * y0
    }
    if (area2 < 0) pts.reverse()
    return pts.map((p, i) => [p[0], p[1], pts[(i + 1) % pts.length][0], pts[(i + 1) % pts.length][1]])
}

/** 평면 고리들(외곽 → 구멍)을 earcut 로 삼각분할해 반시계 삼각형(x, y 쌍 셋) 목록으로. 넓이 0 삼각형은 뺀다 */
export const triangulateRings = (rings: number[][]): number[][] => {
    const flat: number[] = []
    const holeStarts: number[] = []
    for (const r of rings) {
        if (flat.length > 0) holeStarts.push(flat.length / 2)
        flat.push(...r)
    }
    const tris = earcut(flat, holeStarts.length ? holeStarts : undefined, 2)
    const out: number[][] = []
    for (let t = 0; t < tris.length; t += 3) {
        const a = tris[t], b = tris[t + 1], c = tris[t + 2]
        const tri = [flat[2 * a], flat[2 * a + 1], flat[2 * b], flat[2 * b + 1], flat[2 * c], flat[2 * c + 1]]
        if (ringArea2(tri) < 0) [tri[2], tri[3], tri[4], tri[5]] = [tri[4], tri[5], tri[2], tri[3]]
        if (Math.abs(ringArea2(tri)) < 2e-8) continue
        out.push(tri)
    }
    return out
}

export type DrapeOptions = {
    /** false 면 B(지형 삼각형으로 자르기)를 끄고 꼭짓점에서만 높이를 읽는다(디버그) */
    clip?: boolean
    /** 도엽 폴리곤(원점 기준 m, 볼록). 주면 삼각형을 이 안으로 자른다(경계에 걸친 조각은 양쪽 도엽이 각자 자기 부분만) */
    clipTo?: [number, number][]
    /** 지형 정점의 부드러운 법선(positions 와 같은 길이). 주면 B 에서 높이와 같은 가중치로 보간해 정점 법선으로 낸다. 없으면 (0, 0, 1) */
    terrainNormals?: Float32Array
}

/** 얹기 빌더. 삼각형을 모아 메쉬 하나(위치·법선·인덱스)를 만든다 */
export type DrapeBuilder = {
    sampler: TerrainSampler
    /** 삼각형(x, y 쌍 셋) 목록을 도엽 폴리곤으로 잘라(볼록 조각 → 부채꼴) 삼각형 목록으로. 폴리곤이 없으면 그대로 */
    boundTris: (tris: number[][]) => number[][]
    /** = triangulateRings */
    triangulate: (rings: number[][]) => number[][]
    /** 지형 삼각형 t 의 평면에서 (x, y) 의 z 와(지형 법선이 있으면) 같은 가중치로 보간한 법선 [z, nx, ny, nz] */
    planeAt: (t: number, x: number, y: number) => [number, number, number, number]
    /**
     * 삼각형을 넣는다. n 은 세 꼭짓점의 법선(9개, 없으면 위 방향). 위를 향하도록(반시계) 하고, GPU·STL 이 보는 float32 좌표로 넓이를 재서
     * 1 cm² 미만은 버린다. 좌표가 같은(0.1 mm 단위) 정점은 하나로
     */
    pushTri: (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, n?: number[]) => void
    /** 일반 드레이프: 다각형(고리들)마다 A → earcut → B(또는 꼭짓점 높이 읽기). 넣은 삼각형 수 */
    drape: (polys: number[][][], extraZ?: number) => number
    /** 지금까지 넣은 삼각형 수(행의 faceBase 로 쓴다) */
    triangleCount: () => number
    /** 모은 메쉬(원점은 지형 것) */
    finish: () => TinMesh & { normals: Float32Array }
}

/**
 * 지형 위에 얹는 빌더를 만든다. 도로(roadsMesh)·물(waterMesh)이 조각마다 drape 를 부르고 끝에 finish 로 메쉬를 받는다
 *
 * @param terrain 공통 원점의 지형 메쉬(이웃까지 합친 것)
 */
export const createDrapeBuilder = (terrain: TinMesh, options: DrapeOptions = {}): DrapeBuilder => {
    const P = terrain.positions, I = terrain.indices
    const sampler = createTerrainSampler(P, I)
    const clip = options.clip !== false
    const boundaryEdges = boundaryEdgesOf(options.clipTo)
    const boundTris = (tris: number[][]) => {
        if (!boundaryEdges) return tris
        const out: number[][] = []
        for (const tri of tris) {
            const p = clipByEdges(tri, boundaryEdges)
            const n = p.length / 2
            for (let i = 1; i + 1 < n; i++) {
                const piece = [p[0], p[1], p[2 * i], p[2 * i + 1], p[2 * i + 2], p[2 * i + 3]]
                if (Math.abs(ringArea2(piece)) >= 2e-8) out.push(piece)
            }
        }
        return out
    }

    const positions: number[] = []
    const normals: number[] = []
    const indices: number[] = []
    /** 좌표가 같은(0.1 mm 단위) 정점은 하나로. 이웃 지형 삼각형에서 각각 잘린 조각이 변의 점을 공유하므로 정점이 약 1/3 로 준다 */
    const vertexIds = new Map<string, number>()
    const vertexOf = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
        const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`
        let id = vertexIds.get(key)
        if (id === undefined) {
            id = positions.length / 3
            vertexIds.set(key, id)
            positions.push(x, y, z)
            normals.push(nx, ny, nz)
        }
        return id
    }
    const UP = [0, 0, 1, 0, 0, 1, 0, 0, 1]
    const pushTri: DrapeBuilder["pushTri"] = (ax, ay, az, bx, by, bz, cx, cy, cz, n = UP) => {
        const f = Math.fround
        const area2 = (f(bx) - f(ax)) * (f(cy) - f(ay)) - (f(by) - f(ay)) * (f(cx) - f(ax))
        if (Math.abs(area2) < 2e-4) return
        const a = vertexOf(ax, ay, az, n[0], n[1], n[2]), b = vertexOf(bx, by, bz, n[3], n[4], n[5]), c = vertexOf(cx, cy, cz, n[6], n[7], n[8])
        if (a === b || b === c || a === c) return
        if (area2 > 0) indices.push(a, b, c)
        else indices.push(a, c, b)
    }

    const N = options.terrainNormals
    const planeAt: DrapeBuilder["planeAt"] = (t, x, y) => {
        const a = I[3 * t] * 3, b = I[3 * t + 1] * 3, c = I[3 * t + 2] * 3
        const ax = P[a], ay = P[a + 1], bx = P[b], by = P[b + 1], cx = P[c], cy = P[c + 1]
        const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
        const l1 = ((bx - x) * (cy - y) - (cx - x) * (by - y)) / det
        const l2 = ((cx - x) * (ay - y) - (ax - x) * (cy - y)) / det
        const l3 = 1 - l1 - l2
        const z = l1 * P[a + 2] + l2 * P[b + 2] + l3 * P[c + 2]
        if (!N) return [z, 0, 0, 1]
        return [z, l1 * N[a] + l2 * N[b] + l3 * N[c], l1 * N[a + 1] + l2 * N[b + 1] + l3 * N[c + 1], l1 * N[a + 2] + l2 * N[b + 2] + l3 * N[c + 2]]
    }

    const drapePolygon = (rings: number[][], extraZ: number) => {
        const prepared = clip ? rings.map((r) => subdivideRing(r, sampler, P, I)) : rings
        for (const tri of boundTris(triangulateRings(prepared))) {
            if (!clip) {
                const za = sampler(tri[0], tri[1]), zb = sampler(tri[2], tri[3]), zc = sampler(tri[4], tri[5])
                if (za === null || zb === null || zc === null) continue
                pushTri(tri[0], tri[1], za + extraZ, tri[2], tri[3], zb + extraZ, tri[4], tri[5], zc + extraZ)
                continue
            }
            const x0 = Math.min(tri[0], tri[2], tri[4]), x1 = Math.max(tri[0], tri[2], tri[4])
            const y0 = Math.min(tri[1], tri[3], tri[5]), y1 = Math.max(tri[1], tri[3], tri[5])
            sampler.forTrianglesInBox(x0, y0, x1, y1, (t) => {
                const a = I[3 * t] * 3, b = I[3 * t + 1] * 3, c = I[3 * t + 2] * 3
                let ax = P[a], ay = P[a + 1], bx = P[b], by = P[b + 1]
                const cx = P[c], cy = P[c + 1]
                // 지형 삼각형 bbox 가 안 겹치면 건너뜀
                if (Math.max(ax, bx, cx) < x0 || Math.min(ax, bx, cx) > x1 || Math.max(ay, by, cy) < y0 || Math.min(ay, by, cy) > y1) return
                if ((bx - ax) * (cy - ay) - (cx - ax) * (by - ay) < 0) [ax, ay, bx, by] = [bx, by, ax, ay]
                const poly = clipConvex(tri, ax, ay, bx, by, cx, cy)
                if (poly.length < 6 || Math.abs(ringArea2(poly)) < 2 * MIN_PIECE_AREA) return
                const n = poly.length / 2
                for (let i = 1; i + 1 < n; i++) {
                    const px = poly[0], py = poly[1], qx = poly[2 * i], qy = poly[2 * i + 1], rx = poly[2 * i + 2], ry = poly[2 * i + 3]
                    if (Math.abs((qx - px) * (ry - py) - (qy - py) * (rx - px)) < 2e-8) continue
                    const pa = planeAt(t, px, py), pb = planeAt(t, qx, qy), pc = planeAt(t, rx, ry)
                    pushTri(px, py, pa[0] + extraZ, qx, qy, pb[0] + extraZ, rx, ry, pc[0] + extraZ, [pa[1], pa[2], pa[3], pb[1], pb[2], pb[3], pc[1], pc[2], pc[3]])
                }
            })
        }
    }
    const drape: DrapeBuilder["drape"] = (polys, extraZ = 0) => {
        const before = indices.length
        for (const rings of polys) drapePolygon(rings, extraZ)
        return (indices.length - before) / 3
    }

    return {
        sampler,
        boundTris,
        triangulate: triangulateRings,
        planeAt,
        pushTri,
        drape,
        triangleCount: () => indices.length / 3,
        finish: () => ({
            origin: terrain.origin,
            positions: new Float32Array(positions),
            indices: new Uint32Array(indices),
            normals: new Float32Array(normals),
        }),
    }
}

/** 메쉬 사본의 z 에 lift 를 더한다 */
export const liftMesh = (positions: Float32Array, lift: number) => {
    const out = positions.slice()
    for (let i = 2; i < out.length; i += 3) out[i] += lift
    return out
}

/**
 * 계단형 조각의 벽을 아래층 쪽으로 lift 만큼 수평 이동하고 전체를 lift 만큼 올린다(도로 계획서 2.1절: 얹은 판은 지형 판 + lift, 벽은 지형 벽과
 * xy 가 같아 수직면끼리 겹치므로 아래층 쪽으로 밀어 lift 두께의 껍질처럼 둔다). 벽 삼각형(법선의 z ≈ 0)마다 가운데 점 양옆의 지형 높이를
 * 읽어 낮은 쪽을 고르고, 그 방향을 세 꼭짓점에 쌓아(판과 공유하는 꼭짓점도 같이 움직여 판이 그만큼 늘고 준다) 평균 방향으로 민다.
 * zAt 이 없으면(내보내기에 지형이 없을 때) 벽은 옮기지 않고 올리기만 한다. 정점 법선(매끈한 법선, terrainSteps)이 있으면 그대로 싣는다.
 *
 * 접힘 수정(options.fixFolds, 기본 켬. docs/stepped-merge-plan.md 7절 R1b): 벽 밀기는 벽에 붙은 판 정점만 옮기므로 폭이 lift 보다 좁은 판 삼각형은
 * 위에서 본 방향이 뒤집힌다(접힘, R0 덤프 37도엽 498 m²). 판 삼각형(세 z 가 같은 것) 중 시계 방향이 된 것마다, 아직 옮기지 않은 정점(벽이 쓰지
 * 않는 것)에 이미 옮긴 정점의 이동을 준다(여럿이면 평균. 한 회에 여러 삼각형에서 받으면 그것도 평균). 새로 옮긴 정점이 이웃을 뒤집을 수 있어
 * FOLD_FIX_ITERATIONS 회까지 되풀이하고, 끝에 남은 시계 방향·넓이 0 판 삼각형은 버린다(폭 lift 미만의 좁은 턱). 벽 삼각형의 정점은 옮기지 않는다
 * (벽은 벽 밀기가 옮긴 그대로). 정점은 옮기기만 하고 번호를 바꾸지 않으므로 normals 는 그대로 맞고, 버리기는 인덱스만 줄인다
 */
export type LiftFixStats = {
    /** 접힘 수정을 돌린 회 수(조각별 합. 접힘이 없으면 0) */
    iterations: number
    /** 접힘 수정으로 옮긴 정점 수 */
    moved: number
    /** 버린 판 삼각형: 끝까지 시계 방향 / 넓이 0 */
    droppedCw: number
    droppedZero: number
    /** 벽 밀기 직후 시계 방향이었던 판 삼각형 수(수정 전) */
    foldedBefore: number
    ms: number
}
export const emptyLiftFixStats = (): LiftFixStats => ({ iterations: 0, moved: 0, droppedCw: 0, droppedZero: 0, foldedBefore: 0, ms: 0 })
/** 접힘 수정 반복 상한 */
const FOLD_FIX_ITERATIONS = 8

export const liftSteppedChunk = (
    chunk: MeshChunk,
    lift: number,
    zAt: ((x: number, y: number) => number | null) | null,
    options: { fixFolds?: boolean; stats?: LiftFixStats } = {},
): MeshChunk => {
    const p = chunk.positions.slice()
    let idx = chunk.indices
    const nV = p.length / 3
    if (zAt) {
        const disp = new Float32Array(2 * nV)
        const cnt = new Uint16Array(nV)
        for (let t = 0; t < idx.length; t += 3) {
            const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
            const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2]
            const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2]
            const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
            const len = Math.hypot(nx, ny, nz)
            if (len < 1e-12 || Math.abs(nz) > 1e-6 * len) continue
            let hx = nx / len, hy = ny / len
            const mx = (p[a] + p[b] + p[c]) / 3, my = (p[a + 1] + p[b + 1] + p[c + 1]) / 3
            const zp = zAt(mx + hx * 0.05, my + hy * 0.05), zm = zAt(mx - hx * 0.05, my - hy * 0.05)
            if (zp === null && zm === null) continue
            if ((zp ?? Infinity) > (zm ?? Infinity)) {
                hx = -hx
                hy = -hy
            }
            for (const v of [a / 3, b / 3, c / 3]) {
                disp[2 * v] += hx
                disp[2 * v + 1] += hy
                cnt[v]++
            }
        }
        /** 정점별 실제 이동(xy). 접힘 수정이 옮긴 정점의 출처 */
        const moved = new Float64Array(2 * nV)
        const has = new Uint8Array(nV)
        for (let v = 0; v < nV; v++) {
            if (cnt[v] === 0) continue
            const dx = disp[2 * v] / cnt[v], dy = disp[2 * v + 1] / cnt[v]
            const len = Math.hypot(dx, dy)
            if (len < 1e-9) continue
            moved[2 * v] = (dx / len) * lift
            moved[2 * v + 1] = (dy / len) * lift
            has[v] = 1
            p[3 * v] += moved[2 * v]
            p[3 * v + 1] += moved[2 * v + 1]
        }
        if (options.fixFolds !== false) idx = fixPlateFolds(chunk.positions, p, idx, moved, has, options.stats)
    }
    for (let i = 2; i < p.length; i += 3) p[i] += lift
    return { positions: p, indices: idx, ...(chunk.normals ? { normals: chunk.normals } : {}) }
}

/**
 * liftSteppedChunk 의 접힘 수정(위 설명). p 를 고치고 버린 판 삼각형을 뺀 인덱스를 돌려준다(버린 것이 없으면 받은 인덱스 그대로).
 * @param p0 벽 밀기 전 좌표(판 판정: 세 z 같음)
 * @param p 벽 밀기 뒤 좌표(고친다)
 * @param moved 정점별 이동(xy, 고친다)
 * @param has 이동이 있는 정점(고친다)
 */
const fixPlateFolds = (p0: Float32Array, p: Float32Array, idx: Uint32Array, moved: Float64Array, has: Uint8Array, stats?: LiftFixStats): Uint32Array => {
    const started = performance.now()
    const nT = idx.length / 3
    const nV = p.length / 3
    // 판 삼각형과, 옮기지 않는 정점: 벽 삼각형이 쓰는 것(벽은 벽 밀기가 옮긴 그대로) + 판 경계(반대 방향 판 변이 없는 변) 위의 것(도로 가장자리·도엽
    // 경계. 도엽 경계 정점을 옮기면 이웃 도엽과 따로 고쳐져 틈이 난다 — R0 덤프에서 경계도 옮기면 554개가 도엽 경계에 있었다)
    const plate = new Uint8Array(nT)
    const locked = new Uint8Array(nV)
    // 판 방향 변 CSR(시작 정점별 끝 정점)
    const outStart = new Int32Array(nV + 1)
    for (let t = 0; t < nT; t++) {
        const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2]
        const z = p0[3 * a + 2]
        if (p0[3 * b + 2] === z && p0[3 * c + 2] === z) {
            plate[t] = 1
            outStart[a + 1]++
            outStart[b + 1]++
            outStart[c + 1]++
        } else locked[a] = locked[b] = locked[c] = 1
    }
    for (let v = 0; v < nV; v++) outStart[v + 1] += outStart[v]
    const outTo = new Int32Array(outStart[nV])
    const cur = outStart.slice(0, nV)
    for (let t = 0; t < nT; t++) if (plate[t]) for (let k = 0; k < 3; k++) outTo[cur[idx[3 * t + k]]++] = idx[3 * t + ((k + 1) % 3)]
    for (let t = 0; t < nT; t++) {
        if (!plate[t]) continue
        for (let k = 0; k < 3; k++) {
            const a = idx[3 * t + k], b = idx[3 * t + ((k + 1) % 3)]
            let twin = false
            for (let j = outStart[b]; j < outStart[b + 1] && !twin; j++) twin = outTo[j] === a
            if (!twin) locked[a] = locked[b] = 1
        }
    }
    const area2 = (t: number) => {
        const a = 3 * idx[3 * t], b = 3 * idx[3 * t + 1], c = 3 * idx[3 * t + 2]
        return (p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a])
    }
    const acc = new Float64Array(2 * nV)
    const accN = new Uint16Array(nV)
    const touched: number[] = []
    let iterations = 0, movedCount = 0, foldedBefore = 0
    for (let it = 0; it < FOLD_FIX_ITERATIONS; it++) {
        let folded = 0
        touched.length = 0
        for (let t = 0; t < nT; t++) {
            if (!plate[t] || !(area2(t) < 0)) continue
            folded++
            // 이 삼각형에서 옮긴 정점들의 평균 이동을 아직 안 옮긴(벽이 안 쓰는) 정점에
            let sx = 0, sy = 0, sn = 0
            for (let k = 0; k < 3; k++) {
                const v = idx[3 * t + k]
                if (has[v]) {
                    sx += moved[2 * v]
                    sy += moved[2 * v + 1]
                    sn++
                }
            }
            if (sn === 0 || sn === 3) continue
            for (let k = 0; k < 3; k++) {
                const v = idx[3 * t + k]
                if (has[v] || locked[v]) continue
                if (accN[v] === 0) touched.push(v)
                acc[2 * v] += sx / sn
                acc[2 * v + 1] += sy / sn
                accN[v]++
            }
        }
        if (it === 0) foldedBefore = folded
        if (touched.length === 0) break
        iterations++
        for (const v of touched) {
            moved[2 * v] = acc[2 * v] / accN[v]
            moved[2 * v + 1] = acc[2 * v + 1] / accN[v]
            p[3 * v] = p0[3 * v] + moved[2 * v]
            p[3 * v + 1] = p0[3 * v + 1] + moved[2 * v + 1]
            has[v] = 1
            acc[2 * v] = acc[2 * v + 1] = 0
            accN[v] = 0
        }
        movedCount += touched.length
    }
    // 남은 시계 방향·넓이 0 판 삼각형은 버린다(R0 덤프에서 남은 것의 대부분은 세 정점이 다 옮겨진 것 = 폭 lift 미만의 좁은 턱이 접힌 것). 판 안쪽의
    // 접힘은 이웃 판이 그 자리를 겹쳐 덮고 있어 빼도 틈이 생기지 않는다
    const out = dropPlates(p, idx, stats)
    if (stats) {
        stats.iterations += iterations
        stats.moved += movedCount
        stats.foldedBefore += foldedBefore
        stats.ms += performance.now() - started
    }
    return out
}

/** 판 삼각형(세 z 같음) 중 위에서 본 넓이가 0 이하인 것을 뺀 인덱스. 뺀 것이 없으면 받은 인덱스 그대로 */
const dropPlates = (P: Float32Array, idx: Uint32Array, stats?: LiftFixStats): Uint32Array => {
    const nT = idx.length / 3
    const keep = new Uint8Array(nT)
    let droppedCw = 0, droppedZero = 0
    for (let t = 0; t < nT; t++) {
        const a = 3 * idx[3 * t], b = 3 * idx[3 * t + 1], c = 3 * idx[3 * t + 2]
        if (P[b + 2] !== P[a + 2] || P[c + 2] !== P[a + 2]) {
            keep[t] = 1
            continue
        }
        const a2 = (P[b] - P[a]) * (P[c + 1] - P[a + 1]) - (P[b + 1] - P[a + 1]) * (P[c] - P[a])
        if (a2 > 0) keep[t] = 1
        else if (a2 < 0) droppedCw++
        else droppedZero++
    }
    if (stats) {
        stats.droppedCw += droppedCw
        stats.droppedZero += droppedZero
    }
    if (droppedCw + droppedZero === 0) return idx
    const out = new Uint32Array(idx.length - 3 * (droppedCw + droppedZero))
    let n = 0
    for (let t = 0; t < nT; t++) {
        if (!keep[t]) continue
        out[n++] = idx[3 * t]
        out[n++] = idx[3 * t + 1]
        out[n++] = idx[3 * t + 2]
    }
    return out
}

/** 삼각형 범위가 참조하는 정점만 모은 작은 메쉬(내보내기 그룹용). lift 를 z 에 더하고, 정점 법선이 있으면 같이 옮긴다 */
export const compactTriangles = (positions: Float32Array, indices: Uint32Array, lift = 0, normals?: Float32Array): MeshChunk => {
    const map = new Map<number, number>()
    const out = new Uint32Array(indices.length)
    const pts: number[] = []
    const nrm: number[] = []
    for (let i = 0; i < indices.length; i++) {
        const v = indices[i]
        let j = map.get(v)
        if (j === undefined) {
            j = pts.length / 3
            map.set(v, j)
            pts.push(positions[3 * v], positions[3 * v + 1], positions[3 * v + 2] + lift)
            if (normals) nrm.push(normals[3 * v], normals[3 * v + 1], normals[3 * v + 2])
        }
        out[i] = j
    }
    return { positions: new Float32Array(pts), indices: out, normals: normals ? new Float32Array(nrm) : undefined }
}

/** 내보내기의 벽 방향 판정용 지형 조회기. 지형 레이어가 파일에 없으면 null(벽을 옮기지 않는다) */
export const exportSampler = (terrain: TinMesh | null) => (terrain ? createTerrainSampler(terrain.positions, terrain.indices) : null)
