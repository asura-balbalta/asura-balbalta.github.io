import { TerrainSampler } from "./terrainSampler"
import { compactTriangles, createDrapeBuilder, liftMesh, ribbonQuads, ringArea2 } from "./terrainDrape"
import type { MeshChunk, TinMesh } from "./terrainData"
import type { WaterLine, WaterNames, WaterPiece } from "./waterData"
import { createWaterTable, NOT_BUILT, RIVER_SE, WATER_KIND, WaterCodeNames, WaterGroup, WaterRow, WaterTable } from "./waterTable"

/**
 * 수면 조각·하천선을 지형 위에 얹어 메쉬 하나로 만든다(docs/water-layer-plan.md 2절, 2026-10-22 결정 D1·D2·D3 by @nanangqq).
 *
 * 물 자료는 2D 라 높이는 전부 지형에서 가져온다(z 는 항상 프론트가 만든다). 높이 경로(D1, `waterz=`):
 * - **flat(기본, 2026-10-22 결정 by @nanangqq)**: 수면은 지형과 무관한 **자체 면**이다. 조각을 earcut(구멍 포함)로만 삼각분할하고 1K 도엽 폴리곤으로
 *   자른(D2) 뒤 정점 z 를 정한다. 조각 둘레 정점마다 그 자리 **지형 높이**를 모아 **분위수 LEVEL_QUANTILE(기본 0.5 = 중앙값)** 을 수면 높이로 쓴다
 *   (2026-10-22 결정 3차 by @nanangqq. 처음의 "둘레 ±100 m 하위 10%" 는 등고선 5 m 양자화 때문에 수위가 둑보다 2 m 안팎 낮아 호수 안 계단 판이 수면 위로
 *   솟았다). 호소는 조각 둘레 전체 → 한 높이(평면), 하천은 그 점 반지름 RIVER_SMOOTH_M 안의 둘레 정점 → 양안이 같은 범위에 들어 단면이 평평하고
 *   흐름 방향으로 완만히 기운다. 지형이 그보다 높은 곳(섬·둑)은 묻힌다. 어느 xy 든 같은 조각 정점 집합으로 계산하므로 도엽 경계 양쪽이 같은 값을 준다.
 *   지형 삼각형으로 자르지 않으므로 삼각형이 적고 계단형·매끈한 면 어느 모드에서도 같은 메쉬(계단화 없음). 디버그 waterq= 로 분위수를 바꿔 비교한다.
 *   조각(5K 단위)이 다른 곳에서는 같은 호수라도 높이가 조금 다를 수 있다(수역 전체로 묶기는 다음 단계).
 * - drape(비교용): 도로처럼 A(변 쪼개기) + B(지형 삼각형으로 자르기)로 지형 평면에 얹는다. 둑 높이에 물이 가득 찬 모습이고 지형의 굴곡·삼각형
 *   구조를 그대로 물려받는다(2026-10-22 지적으로 기본에서 뺌 by @nanangqq).
 * 하천선(D3)은 선분 중점이 하천·호소 조각 안이면 건너뛰고 밖인 선분만 riverSe 별 폭(RIBBON_WIDTH_M)의 띠로 만들어 같은 길을 탄다.
 * 결과 메쉬는 띄움 없는 값이다. 띄움(WATER_LIFT_M)은 화면 조각(waterDisplayChunks)과 내보내기가 더한다.
 *
 * 표(WaterTable)의 행은 수역(srcId) 순 → 띠(선 id 순). 한 수역의 조각이 여러 도엽에 흩어지므로 내보내기 그룹은 범위 여러 개를 모은다(waterGroups).
 */

/** 물을 지형 위로 띄우는 높이(m). 도로(0.1)보다 낮게 두어 강을 건너는 일반차도가 물 위에 오게. 디버그 waterlift= */
export const WATER_LIFT_M = 0.05
/** 하천선 띠 폭(m, riverSe 별. 자료에 폭이 없다). 값은 Chrome 비교로(계획 2.3절). 디버그 waterwidth= 는 전부에 같은 값 */
export const RIBBON_WIDTH_M: Record<number, number> = { [RIVER_SE.national]: 8, [RIVER_SE.regional]: 5, [RIVER_SE.small]: 3, [RIVER_SE.other]: 2 }
/** flat 경로: 둘레 정점 지형 높이의 분위수(0 최저 ~ 1 최고). 0.5 = 중앙값. 디버그 waterq= */
export const LEVEL_QUANTILE = 0.5
/** 하천 수면 높이를 정할 때 보는 둘레 정점의 반지름(m). 강 폭(100 m 안팎)보다 커야 양안이 같이 들어가 단면이 평평하다 */
export const RIVER_SMOOTH_M = 200

export type WaterZMode = "flat" | "drape"

export type WaterBuildOptions = {
    /** false 면 B(지형 삼각형으로 자르기)를 끄고 꼭짓점에서만 높이를 읽는다(디버그 waterclip=0) */
    clip?: boolean
    /** 높이 경로(디버그 waterz=). 없으면 flat */
    zMode?: WaterZMode
    /** false 면 하천선 띠를 만들지 않는다(디버그 waterlines=0) */
    lines?: boolean
    /** 띠 폭(m). 주면 riverSe 와 무관하게 전부 이 값(디버그 waterwidth=) */
    ribbonWidth?: number
    /** 수면 높이 분위수(0 ~ 1. 디버그 waterq=). 없으면 LEVEL_QUANTILE */
    levelQuantile?: number
    /** 도엽 폴리곤(원점 기준 m, 볼록). 주면 삼각형을 이 안으로 자른다(D2) */
    clipTo?: [number, number][]
    /** 지형 정점의 부드러운 법선. 주면 정점 법선으로 보간해 낸다(매끈한 면 셰이더) */
    terrainNormals?: Float32Array
}

/** 물 메쉬: 지형 TinMesh + 정점 법선 */
export type WaterMesh = TinMesh & { normals: Float32Array }

export type WaterBuildResult = {
    /** 지형과 같은 원점. 띄움 없음 */
    mesh: WaterMesh
    table: WaterTable
    /** 얹은 행 수(조각 + 띠) */
    built: number
    /** 그중 하천·호소 조각 수 */
    rivers: number
    lakes: number
    /** 그중 하천선 띠 수 */
    ribbons: number
    /** 지형 밖(지형 구멍)이라 못 얹은 수 */
    skipped: number
    /** 지형 bbox 와 겹치지 않아 표에서 뺀 수 */
    outside: number
    sampler: TerrainSampler
}

/** 얹을 단위 하나: 조각(다각형 하나, 구멍 포함) 또는 띠(선분마다 사각형) */
type Unit = { row: WaterRow; polys: number[][][] }

/** 점이 고리(x, y 쌍) 안인지(짝홀 규칙) */
const pointInRing = (x: number, y: number, r: number[]) => {
    let inside = false
    const n = r.length / 2
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = r[2 * i], yi = r[2 * i + 1], xj = r[2 * j], yj = r[2 * j + 1]
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
}

/** 조각의 고리들(m 단위, 외곽 → 구멍)과 bbox */
const ringsOf = (p: WaterPiece): { rings: number[][]; x0: number; y0: number; x1: number; y1: number } | null => {
    const n = p.xy.length / 2
    const holesTotal = p.holes.reduce((s, h) => s + h, 0)
    const outerN = n - holesTotal
    if (outerN < 3) return null
    const rings: number[][] = []
    let start = 0
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const len of [outerN, ...p.holes]) {
        const r: number[] = []
        for (let i = start; i < start + len; i++) {
            const x = p.xy[2 * i] / 1000, y = p.xy[2 * i + 1] / 1000
            r.push(x, y)
            if (rings.length === 0) {
                if (x < x0) x0 = x
                if (x > x1) x1 = x
                if (y < y0) y0 = y
                if (y > y1) y1 = y
            }
        }
        rings.push(r)
        start += len
    }
    return { rings, x0, y0, x1, y1 }
}

/**
 * 조각·선을 지형 위에 얹어 메쉬 하나와 표를 만든다.
 *
 * @param pieces 공통 원점 mm 좌표의 수면 조각들(이 도엽 범위에 걸친 것)
 * @param lines 같은 원점의 하천선들(띠용. 폴리곤 안 구간 판정에는 pieces 전부를 쓴다)
 * @param terrain 같은 원점의 지형 메쉬(이웃까지 합친 것)
 * @param codes codes.json 이름 표
 * @param names nameId → 이름·하천 번호
 */
export const buildWaterMesh = (
    pieces: WaterPiece[],
    lines: WaterLine[],
    terrain: TinMesh,
    codes: WaterCodeNames,
    names: WaterNames,
    options: WaterBuildOptions = {},
): WaterBuildResult => {
    const builder = createDrapeBuilder(terrain, { clip: options.clip, clipTo: options.clipTo, terrainNormals: options.terrainNormals })
    const { sampler } = builder
    const P = terrain.positions
    const zMode: WaterZMode = options.zMode ?? "flat"
    const flatMode = zMode === "flat"
    const q = Math.min(1, Math.max(0, options.levelQuantile ?? LEVEL_QUANTILE))

    // 지형 bbox(m)에 걸치는 단위만
    let tx0 = Infinity, ty0 = Infinity, tx1 = -Infinity, ty1 = -Infinity
    for (let i = 0; i < P.length; i += 3) {
        tx0 = Math.min(tx0, P[i]); tx1 = Math.max(tx1, P[i])
        ty0 = Math.min(ty0, P[i + 1]); ty1 = Math.max(ty1, P[i + 1])
    }
    const overlapsBox = (x0: number, y0: number, x1: number, y1: number) => x1 >= tx0 && x0 <= tx1 && y1 >= ty0 && y0 <= ty1

    const nameOf = (id: number) => names.get(id) ?? { name: "", riverNo: "" }
    const units: Unit[] = []
    let outside = 0
    /** 선분 중점의 "수면 안" 판정용: 모든 조각의 고리와 bbox(이 도엽 밖 조각도 포함해야 경계 근처 선분을 옳게 거른다) */
    const covers: { rings: number[][]; x0: number; y0: number; x1: number; y1: number }[] = []
    for (const p of pieces) {
        const r = ringsOf(p)
        if (!r) continue
        covers.push(r)
        if (!overlapsBox(r.x0, r.y0, r.x1, r.y1)) {
            outside++
            continue
        }
        const nm = nameOf(p.nameId)
        units.push({
            row: { id: p.srcId, kind: p.kind, nameId: p.nameId, riverSe: 0, srcNPieces: p.srcNPieces, flags: p.flags, name: nm.name, riverNo: nm.riverNo },
            polys: [r.rings],
        })
    }
    const insideWater = (x: number, y: number) => {
        for (const c of covers) {
            if (x < c.x0 || x > c.x1 || y < c.y0 || y > c.y1) continue
            if (!pointInRing(x, y, c.rings[0])) continue
            let inHole = false
            for (let h = 1; h < c.rings.length && !inHole; h++) inHole = pointInRing(x, y, c.rings[h])
            if (!inHole) return true
        }
        return false
    }
    if (options.lines !== false) {
        for (const l of lines) {
            const w = options.ribbonWidth ?? RIBBON_WIDTH_M[l.riverSe] ?? RIBBON_WIDTH_M[RIVER_SE.other]
            // 수면 폴리곤 안 구간(중점 기준)은 건너뛴다(D3: 폴리곤 밖 선분만 띠)
            const quads = ribbonQuads(l.xy, w, (i, pts) => insideWater((pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2))
            if (quads.length === 0) continue
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
            for (const q of quads) {
                for (let i = 0; i < q.length; i += 2) {
                    if (q[i] < x0) x0 = q[i]
                    if (q[i] > x1) x1 = q[i]
                    if (q[i + 1] < y0) y0 = q[i + 1]
                    if (q[i + 1] > y1) y1 = q[i + 1]
                }
            }
            if (!overlapsBox(x0, y0, x1, y1)) {
                outside++
                continue
            }
            const nm = nameOf(l.nameId)
            units.push({
                row: { id: l.id, kind: WATER_KIND.ribbon, nameId: l.nameId, riverSe: l.riverSe, srcNPieces: 0, flags: l.flags, name: nm.name, riverNo: nm.riverNo },
                polys: quads.map((q) => [q]),
            })
        }
    }
    // 수역(srcId) 순 → 띠(선 id 순). 같은 수역의 조각이 메쉬에서 이어진다
    units.sort((a, b) => (a.row.kind === WATER_KIND.ribbon ? 1 : 0) - (b.row.kind === WATER_KIND.ribbon ? 1 : 0) || a.row.id - b.row.id)
    const table = createWaterTable(units.map((u) => u.row), codes)

    let built = 0, rivers = 0, lakes = 0, ribbons = 0, skipped = 0
    const UP = [0, 0, 1, 0, 0, 1, 0, 0, 1]
    /** 값들의 분위수 q(정렬 뒤 선형 보간) */
    const quantile = (values: number[]) => {
        values.sort((a, b) => a - b)
        const pos = (values.length - 1) * q
        const i = Math.floor(pos), f = pos - i
        return i + 1 < values.length ? values[i] * (1 - f) + values[i + 1] * f : values[i]
    }
    /**
     * flat: 단위(조각 또는 띠)의 모든 고리 정점에 그 자리 지형 높이를 붙이고, 수면 높이 함수 zAt(x, y) 를 만든다 — 호소는 둘레 전체의 분위수 한 값,
     * 하천·띠는 (x, y) 반지름 RIVER_SMOOTH_M 안 정점의 분위수(없으면 가장 가까운 정점 값). 지형 밖인 정점은 뺀다. 그 뒤 earcut → 도엽 자르기 → pushTri
     */
    const flat = (polys: number[][][], kind: number) => {
        const pts: { x: number; y: number; z: number }[] = []
        for (const rings of polys) {
            for (const r of rings) {
                for (let i = 0; i < r.length; i += 2) {
                    const z = sampler(r[i], r[i + 1])
                    if (z !== null) pts.push({ x: r[i], y: r[i + 1], z })
                }
            }
        }
        if (pts.length === 0) return 0
        let zAt: (x: number, y: number) => number
        if (kind === WATER_KIND.lake) {
            const level = quantile(pts.map((p) => p.z))
            zAt = () => level
        } else {
            const r2 = RIVER_SMOOTH_M * RIVER_SMOOTH_M
            const cache = new Map<string, number>()
            zAt = (x, y) => {
                const key = `${Math.round(x * 1000)},${Math.round(y * 1000)}`
                const hit = cache.get(key)
                if (hit !== undefined) return hit
                const near: number[] = []
                let best = Infinity, bestZ = pts[0].z
                for (const p of pts) {
                    const d2 = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y)
                    if (d2 <= r2) near.push(p.z)
                    if (d2 < best) {
                        best = d2
                        bestZ = p.z
                    }
                }
                const z = near.length > 0 ? quantile(near) : bestZ
                cache.set(key, z)
                return z
            }
        }
        const before = builder.triangleCount()
        for (const rings of polys) {
            for (const tri of builder.boundTris(builder.triangulate(rings))) {
                builder.pushTri(tri[0], tri[1], zAt(tri[0], tri[1]), tri[2], tri[3], zAt(tri[2], tri[3]), tri[4], tri[5], zAt(tri[4], tri[5]), UP)
            }
        }
        return builder.triangleCount() - before
    }
    units.forEach((u, k) => {
        const first = builder.triangleCount()
        const count = flatMode ? flat(u.polys, u.row.kind) : builder.drape(u.polys, 0)
        if (count === 0) {
            skipped++
            return
        }
        table.faceBase[k] = first
        table.faceCount[k] = count
        built++
        if (u.row.kind === WATER_KIND.river) rivers++
        else if (u.row.kind === WATER_KIND.lake) lakes++
        else ribbons++
    })

    const mesh = builder.finish()
    return { mesh, table, built, rivers, lakes, ribbons, skipped, outside, sampler }
}

/**
 * 화면(또는 내보내기)용 물 조각: 띄운 메쉬 하나(정점 법선 포함). 수면은 자체 면이라 **계단형에서도 계단화하지 않는다**(2026-10-22 결정 by @nanangqq)
 *
 * @param mesh buildWaterMesh 의 메쉬(띄움 없음)
 * @param lift 띄움(m)
 */
export const waterDisplayChunks = (mesh: TinMesh & { normals?: Float32Array }, lift: number): MeshChunk[] =>
    mesh.indices.length === 0 ? [] : [{ positions: liftMesh(mesh.positions, lift), indices: mesh.indices.slice(), normals: mesh.normals?.slice() }]

/** 내보내기: 물 레이어 전체를 띄운 조각으로(STL 처럼 그룹이 없는 형식). 계단화하지 않는다 */
export const waterExportChunks = (mesh: TinMesh) => waterDisplayChunks(mesh, WATER_LIFT_M)

/**
 * 정수 mm 좌표가 같은 정점을 하나로 합친다(weld). 같은 수역의 조각이 여러 도엽에서 각각 얹혀 절단선 위 정점이 중복되므로, 수역 그룹을
 * 한 메쉬로 낼 때 틈 없이 붙게 한다(안내문 2절 2: 절단선 위 정점은 이웃 조각과 정수 mm 로 비트 일치)
 */
export const weldChunk = (chunk: MeshChunk): MeshChunk => {
    const ids = new Map<string, number>()
    const remap = new Uint32Array(chunk.positions.length / 3)
    const pts: number[] = []
    const nrm: number[] = []
    for (let v = 0; v < remap.length; v++) {
        const x = chunk.positions[3 * v], y = chunk.positions[3 * v + 1], z = chunk.positions[3 * v + 2]
        const key = `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`
        let id = ids.get(key)
        if (id === undefined) {
            id = pts.length / 3
            ids.set(key, id)
            pts.push(x, y, z)
            if (chunk.normals) nrm.push(chunk.normals[3 * v], chunk.normals[3 * v + 1], chunk.normals[3 * v + 2])
        }
        remap[v] = id
    }
    const indices = new Uint32Array(chunk.indices.length)
    let n = 0
    for (let i = 0; i < chunk.indices.length; i += 3) {
        const a = remap[chunk.indices[i]], b = remap[chunk.indices[i + 1]], c = remap[chunk.indices[i + 2]]
        if (a === b || b === c || a === c) continue
        indices[n++] = a
        indices[n++] = b
        indices[n++] = c
    }
    return { positions: new Float32Array(pts), indices: indices.subarray(0, n), normals: chunk.normals ? new Float32Array(nrm) : undefined }
}

/**
 * 내보내기: 수역(또는 하천선) 그룹 하나의 삼각형(여러 범위)을 모아 weld 하고 띄운 조각으로. 계단화하지 않는다
 *
 * @param normals 물 메쉬 전체의 정점 법선(GLB 가 매끈한 면 지형처럼 넣을 때)
 */
export const waterGroupExportChunks = (mesh: TinMesh, group: WaterGroup, normals?: Float32Array): MeshChunk[] => {
    let total = 0
    for (const [from, to] of group.ranges) total += 3 * (to - from)
    const range = new Uint32Array(total)
    let o = 0
    for (const [from, to] of group.ranges) {
        range.set(mesh.indices.subarray(3 * from, 3 * to), o)
        o += 3 * (to - from)
    }
    return [weldChunk(compactTriangles(mesh.positions, range, WATER_LIFT_M, normals))]
}

/** 디버그·통계용: 수역 수(srcId 기준) */
export const countBasins = (table: WaterTable) => {
    const ids = new Set<number>()
    for (let k = 0; k < table.count; k++) if (table.kind[k] !== WATER_KIND.ribbon && table.faceBase[k] !== NOT_BUILT) ids.add(table.ids[k])
    return ids.size
}

/** 넓이 0 고리 방어용 재수출(검증 스크립트) */
export { ringArea2 }
