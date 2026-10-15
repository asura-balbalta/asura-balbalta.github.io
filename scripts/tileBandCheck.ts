/**
 * 이웃 합치기 경계 띠 폭 측정(docs/design-code-plan.md 7절 L5-C, 2026-10-15).
 *
 * 도엽 하나를 만들 때 이웃 3×3 전체 대신 "도엽 범위를 띠 폭만큼 넓힌 범위" 안의 점만 합쳐 삼각분할하면(mergeTtpTiles 의 keep) 얼마나
 * 빨라지고 결과가 얼마나 달라지는지를 Node 에서 실제 ttp 파일(R2)로 잰다. 보조 워커(terrainTileBuild.worker.ts)와 같은 순서
 * (이웃 합침·재삼각분할 → 법선 → 도엽 폴리곤으로 자르기)를 띠 폭마다 되풀이한다. 띠 0 = 이웃 전체(옛 동작) 가 기준이다.
 *
 * 지표(띠 폭마다):
 * - 시간: 도엽당 합침 + 재삼각분할 + 법선 + 자르기 ms 의 평균·합계(한 스레드. 브라우저 보조 워커와 절대값은 다르나 비율은 같다)
 * - 합친 점 수·삼각형 수·바늘 삼각형(최소 각 < 1°) 수
 * - 경계 균열: 맞닿은 두 도엽의 공유 변을 1 m 간격으로 훑으며 양쪽 도엽 TIN 의 높이(변에서 1 mm 안쪽)를 비교. |Δz| 최대·평균, 1 cm·10 cm 초과 비율
 * - 기준 대비: 띠 0 결과와 같은 자리(도엽 안 격자 grid m 간격 + 변 안쪽 0.2 m 선 0.5 m 간격)의 높이 차. 최대, 1 cm 초과 수, 초과한 자리가
 *   도엽 경계에서 가장 멀리 떨어진 거리(차이가 띠 안쪽 어디까지 미치는지 → 띠 폭 결정의 근거)
 * - 필요한 띠 폭(띠 0 결과에서): 도엽에 걸친 삼각형의 외접원이 도엽 밖으로 나가는 최대 거리(circumcircleOverflow). 도엽별 분포
 * - --adaptive [all|edge]: 띠 결과의 외접원이 띠 밖으로 나가면 나간 쪽만 그 거리만큼 넓혀 다시 만든다(한쪽이 400 m 를 넘으면 그쪽은 제한 없음).
 *   쓴 띠 폭(네 변의 최대)별 도엽 수를 센다. edge 면 경계를 가로지르는 삼각형만 검사(균열 없음만 보장, 안쪽은 전체와 다를 수 있음)
 * - 제약 실패: 재삼각분할 로그의 "실패 n" 합(띠별로 다르면 그 자리의 결과가 다를 수 있다)
 *
 * 사용(esbuild 로 Node 용으로 묶어 실행):
 *   npm run band-check -- --bbox 14135700,4513980,14136500,4514780 [--bands 0,50,100,200] [--grid 5] [--adaptive] [--out docs/render-checks/<오늘>-band]
 * 결과: <out>/band-check-<bbox 해시>.json 과 콘솔 표. docs/render-checks/ 는 git 제외
 */
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import type { Extent } from "ol/extent"

import { computeVertexNormals, NORMAL_SMOOTH_ITERATIONS, smoothVertexNormals } from "../src/meshNormals"
import { ClippedMesh, clipMeshToConvexPolygon } from "../src/terrainClip"
import { fetchGunzip, TinMesh } from "../src/terrainData"
import { createHeightSampler, HeightSampler } from "../src/terrainHeight"
import { getTtpSheetsInBbox, neighborReach, TTP_BASE } from "../src/terrainIndex"
import { bandExtent, circumcircleOverflow, mergeTtpTiles, mergeTtpTilesForTile, parseTtp, TtpTile } from "../src/terrainPslg"

type Args = { bbox: Extent; bands: number[]; grid: number; out: string; adaptive: "" | "all" | "edge" }
const parseArgs = (argv: string[]): Args => {
    const args: Args = { bbox: [0, 0, 0, 0], bands: [0, 50, 100, 200], grid: 5, out: `docs/render-checks/${new Date().toISOString().slice(0, 10)}-band`, adaptive: "" }
    let hasBbox = false
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i]
        const take = () => {
            const v = argv[++i]
            if (v === undefined) throw new Error(`${key} 에 값이 없습니다`)
            return v
        }
        switch (key) {
            case "--bbox": {
                const v = take().split(",").map(Number)
                if (v.length !== 4 || v.some((x) => !Number.isFinite(x))) throw new Error("bbox 는 minx,miny,maxx,maxy")
                args.bbox = v as Extent
                hasBbox = true
                break
            }
            case "--bands": args.bands = take().split(",").map(Number); break
            case "--grid": args.grid = Number(take()); break
            case "--out": args.out = take(); break
            case "--adaptive": args.adaptive = argv[i + 1] === "edge" ? (i++, "edge") : argv[i + 1] === "all" ? (i++, "all") : "all"; break
            default: throw new Error(`모르는 옵션 ${key}`)
        }
    }
    if (!hasBbox) throw new Error("--bbox 가 필요합니다")
    return args
}

const extentsOverlap = (a: Extent, b: Extent) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]
const pointInPolygon = (x: number, y: number, poly: [number, number][]) => {
    let inside = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i]
        const [xj, yj] = poly[j]
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
}
/** 점에서 다각형 둘레(변)까지의 최소 거리 */
const distanceToEdges = (x: number, y: number, poly: [number, number][]) => {
    let best = Infinity
    for (let i = 0; i < poly.length; i++) {
        const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length]
        const dx = bx - ax, dy = by - ay
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
        best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)))
    }
    return best
}
/** 최소 각이 degrees 보다 작은 삼각형 수 */
const countNeedles = (mesh: ClippedMesh, degrees: number) => {
    const p = mesh.positions, idx = mesh.indices
    const limit = (degrees * Math.PI) / 180
    let n = 0
    for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
        const ab = Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1])
        const bc = Math.hypot(p[c] - p[b], p[c + 1] - p[b + 1])
        const ca = Math.hypot(p[a] - p[c], p[a + 1] - p[c + 1])
        if (ab === 0 || bc === 0 || ca === 0) continue
        const angleA = Math.acos(Math.max(-1, Math.min(1, (ab * ab + ca * ca - bc * bc) / (2 * ab * ca))))
        const angleB = Math.acos(Math.max(-1, Math.min(1, (ab * ab + bc * bc - ca * ca) / (2 * ab * bc))))
        const angleC = Math.PI - angleA - angleB
        if (Math.min(angleA, angleB, angleC) < limit) n++
    }
    return n
}

type Built = {
    id: string
    name: string
    poly: [number, number][]
    tin: ClippedMesh
    sampler: HeightSampler
    /** 합침 + 재삼각분할 ms */
    mergeMs: number
    /** 법선 + 자르기 ms */
    restMs: number
    /** 합친 점 수(삼각분할 입력) */
    points: number
    needles: number
    /** 실제로 쓴 띠 폭(adaptive 로 넓혔으면 커진다. 0 = 전체) */
    usedBand: number
    /** 띠 0 일 때: 이 도엽에 필요한 띠 폭(외접원이 도엽 밖으로 나가는 최대 거리, m) */
    requiredBand: number
    /** 띠 0 일 때: 경계를 가로지르는 삼각형만 본 필요한 띠 폭 */
    requiredBandEdge: number
}

/** 누적 통계(|Δz|) */
class Stat {
    n = 0
    sum = 0
    max = 0
    over1cm = 0
    over10cm = 0
    add(dz: number) {
        const a = Math.abs(dz)
        this.n++
        this.sum += a
        if (a > this.max) this.max = a
        if (a > 0.01) this.over1cm++
        if (a > 0.1) this.over10cm++
    }
    summary() {
        return { samples: this.n, maxM: round(this.max, 4), meanM: this.n ? round(this.sum / this.n, 5) : 0, over1cm: this.over1cm, over10cm: this.over10cm }
    }
}
const round = (v: number, digits: number) => Number(v.toFixed(digits))

const run = async () => {
    const args = parseArgs(process.argv.slice(2))
    const realLog = console.log
    /** 묶인 함수의 로그를 삼키되 재삼각분할의 제약 실패 수는 모은다 */
    let constraintFailures = 0
    let retries = 0
    const quiet = <T>(fn: () => T): T => {
        console.log = (...parts: unknown[]) => {
            const m = /제약 선분 \d+\(실패 (\d+)/.exec(String(parts[0]))
            if (m) constraintFailures += Number(m[1])
        }
        try {
            return fn()
        } finally {
            console.log = realLog
        }
    }

    // 1) 조회: 선택 도엽과 이웃(조정자 select 와 같은 여유)
    const margin = 1650
    const [qSel, qAll] = await Promise.all([
        getTtpSheetsInBbox(args.bbox),
        getTtpSheetsInBbox([args.bbox[0] - margin, args.bbox[1] - margin, args.bbox[2] + margin, args.bbox[3] + margin]),
    ])
    if (qSel.tiles.length === 0) throw new Error("선택 범위에 도엽이 없습니다")
    const origin = qSel.origin
    const [ox, oy] = origin
    realLog(`선택 도엽 ${qSel.tiles.length}, 이웃 포함 ${qAll.tiles.length}, 5K 파일 ${qAll.sheets.length}, 원점 ${origin}`)

    // 2) 5K 파일 받기
    const tFetch = performance.now()
    const ttpById = new Map<string, TtpTile>()
    await Promise.all(
        qAll.sheets.map(async (s) => {
            const file = parseTtp(await fetchGunzip(`${TTP_BASE}/${s.path}`))
            for (const t of file.tiles) ttpById.set(t.mapId, t)
        }),
    )
    realLog(`받기 ${Math.round(performance.now() - tFetch)} ms`)

    // 3) 띠 폭마다 선택 도엽 전부 만들기(보조 워커와 같은 순서)
    const buildOne = (t: (typeof qSel.tiles)[number], band: number): Built => {
        const neighbors = qAll.tiles.filter((n) => extentsOverlap(n.bbox, neighborReach(t.bbox)))
        const ttpTiles = neighbors.map((n) => ttpById.get(n.map_id)).filter((x): x is TtpTile => !!x)
        const poly = t.corners.map(([x, y]) => [x - ox, y - oy] as [number, number])
        const tileExtent = bandExtent(poly, 0)
        const edgeOnly = args.adaptive === "edge"
        const t0 = performance.now()
        let usedBand = band
        let merged: TinMesh
        if (args.adaptive && band > 0) {
            // 보조 워커와 같은 함수: 외접원이 띠 밖으로 나간 쪽만 넓혀 다시(400 m 를 넘으면 그쪽은 제한 없음)
            const r = quiet(() => mergeTtpTilesForTile(ttpTiles, origin, poly, band, edgeOnly))
            merged = r.mesh
            retries += r.attempts - 1
            usedBand = Math.max(...r.sides)
        } else {
            merged = quiet(() => mergeTtpTiles(ttpTiles, origin, band > 0 ? bandExtent(poly, band) : undefined))
        }
        const requiredBand = band === 0 ? Math.max(...circumcircleOverflow(merged, poly, tileExtent)) : 0
        const requiredBandEdge = band === 0 ? Math.max(...circumcircleOverflow(merged, poly, tileExtent, true)) : 0
        const t1 = performance.now()
        const normals = smoothVertexNormals(computeVertexNormals(merged.positions, merged.indices), merged.indices, NORMAL_SMOOTH_ITERATIONS)
        const tin = quiet(() => clipMeshToConvexPolygon(merged, poly, normals))
        const t2 = performance.now()
        return {
            id: t.map_id,
            name: t.name,
            poly,
            tin,
            sampler: createHeightSampler(tin),
            mergeMs: t1 - t0,
            restMs: t2 - t1,
            points: merged.positions.length / 3,
            needles: countNeedles(tin, 1),
            usedBand,
            requiredBand,
            requiredBandEdge,
        }
    }
    // JIT 예열: 처음 몇 도엽은 느리게 나오므로 버린다
    for (const t of qSel.tiles.slice(0, Math.min(3, qSel.tiles.length))) buildOne(t, 0)

    const results: Record<string, unknown>[] = []
    let reference: Map<string, Built> | null = null
    for (const band of args.bands) {
        const built = new Map<string, Built>()
        constraintFailures = 0
        retries = 0
        const tBand = performance.now()
        for (const t of qSel.tiles) built.set(t.map_id, buildOne(t, band))
        const wall = performance.now() - tBand
        const list = [...built.values()]
        const list_ = list
        const mergeMs = list.reduce((s, b) => s + b.mergeMs, 0)
        const restMs = list.reduce((s, b) => s + b.restMs, 0)
        const points = list.reduce((s, b) => s + b.points, 0)
        const triangles = list.reduce((s, b) => s + b.tin.indices.length / 3, 0)
        const needles = list.reduce((s, b) => s + b.needles, 0)

        // 경계 균열: 꼭짓점 둘을 공유하는 도엽 쌍의 변을 훑는다
        const seam = new Stat()
        let seamMisses = 0
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
                const a = list[i], b = list[j]
                const shared = a.poly.filter(([x, y]) => b.poly.some(([u, v]) => Math.abs(u - x) < 1e-3 && Math.abs(v - y) < 1e-3))
                if (shared.length !== 2) continue
                const [p, q] = shared
                const len = Math.hypot(q[0] - p[0], q[1] - p[1])
                const samples = Math.max(1, Math.floor(len))
                const ca = centroid(a.poly), cb = centroid(b.poly)
                // 변에 수직인 단위 벡터. 각 도엽 중심 쪽으로 1 mm 들어간 자리에서 잰다
                const ex = (q[0] - p[0]) / len, ey = (q[1] - p[1]) / len
                const nx = -ey, ny = ex
                const mid: [number, number] = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]
                const signA = Math.sign((ca[0] - mid[0]) * nx + (ca[1] - mid[1]) * ny) || 1
                const signB = Math.sign((cb[0] - mid[0]) * nx + (cb[1] - mid[1]) * ny) || -1
                const inset = 0.001
                for (let k = 0; k < samples; k++) {
                    const s = (k + 0.5) / samples
                    const x = p[0] + (q[0] - p[0]) * s, y = p[1] + (q[1] - p[1]) * s
                    const za = a.sampler.heightAt(x + nx * inset * signA, y + ny * inset * signA)
                    const zb = b.sampler.heightAt(x + nx * inset * signB, y + ny * inset * signB)
                    if (za === null || zb === null) {
                        seamMisses++
                        continue
                    }
                    seam.add(za - zb)
                }
            }
        }

        // 기준(띠 0) 대비: 도엽 안 격자 + 변 안쪽 선
        let reference_ = reference
        const diff = new Stat()
        const debugDiffs: Record<string, unknown>[] = []
        let diffMisses = 0
        let farthestDiffM = 0
        if (reference_) {
            for (const b of list) {
                const ref = reference_.get(b.id)!
                const samplePoint = (x: number, y: number) => {
                    if (!pointInPolygon(x, y, b.poly)) return
                    const z0 = ref.sampler.heightAt(x, y), z1 = b.sampler.heightAt(x, y)
                    if (z0 === null || z1 === null) {
                        diffMisses++
                        return
                    }
                    diff.add(z1 - z0)
                    if (Math.abs(z1 - z0) > 0.01) farthestDiffM = Math.max(farthestDiffM, distanceToEdges(x, y, b.poly))
                    if (process.env.BAND_DEBUG && Math.abs(z1 - z0) > 0.5) debugDiffs.push({ tile: b.name, x: round(x, 1), y: round(y, 1), dz: round(z1 - z0, 2), edgeM: round(distanceToEdges(x, y, b.poly), 1), band: b.usedBand })
                }
                const xs = b.poly.map((p) => p[0]), ys = b.poly.map((p) => p[1])
                for (let y = Math.min(...ys) + args.grid / 2; y < Math.max(...ys); y += args.grid) {
                    for (let x = Math.min(...xs) + args.grid / 2; x < Math.max(...xs); x += args.grid) samplePoint(x, y)
                }
                const c = centroid(b.poly)
                for (let i = 0; i < b.poly.length; i++) {
                    const p = b.poly[i], q = b.poly[(i + 1) % b.poly.length]
                    const len = Math.hypot(q[0] - p[0], q[1] - p[1])
                    const ex = (q[0] - p[0]) / len, ey = (q[1] - p[1]) / len
                    let nx = -ey, ny = ex
                    const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]
                    if ((c[0] - mid[0]) * nx + (c[1] - mid[1]) * ny < 0) {
                        nx = -nx
                        ny = -ny
                    }
                    for (let s = 0.25; s < len; s += 0.5) samplePoint(p[0] + ex * s + nx * 0.2, p[1] + ey * s + ny * 0.2)
                }
            }
        } else {
            reference = built
            reference_ = built
        }

        if (process.env.BAND_DEBUG && debugDiffs.length > 0) {
            const byTile = new Map<string, Record<string, unknown>[]>()
            for (const d of debugDiffs) byTile.set(String(d.tile), [...(byTile.get(String(d.tile)) ?? []), d])
            for (const [name, list] of byTile) {
                realLog(`  [debug] ${name}: >0.5 m 표본 ${list.length}, 예 ${JSON.stringify(list.slice(0, 3))}`)
                // 자른 TIN 의 삼각형 집합을 전체 결과와 비교(꼭짓점 좌표 mm 키)
                const b = list_.find((x) => x.name === name)!
                const ref = reference_!.get(b.id)!
                const keyOf = (m: ClippedMesh, t: number) => [0, 1, 2].map((k) => { const v = m.indices[t + k] * 3; return `${Math.round(m.positions[v] * 1000)},${Math.round(m.positions[v + 1] * 1000)}` }).sort().join("|")
                const setOf = (m: ClippedMesh) => { const s = new Set<string>(); for (let t = 0; t < m.indices.length; t += 3) s.add(keyOf(m, t)); return s }
                const sa = setOf(b.tin), sb = setOf(ref.tin)
                const onlyBand = [...sa].filter((k) => !sb.has(k)), onlyFull = [...sb].filter((k) => !sa.has(k))
                realLog(`  [debug] ${name}: 삼각형 띠 ${sa.size} 전체 ${sb.size}, 띠에만 ${onlyBand.length}, 전체에만 ${onlyFull.length}, 쓴 띠 ${b.usedBand}; 띠에만 예 ${onlyBand.slice(0, 2).join(" ; ")}; 전체에만 예 ${onlyFull.slice(0, 2).join(" ; ")}`)
            }
        }
        const usedBands = new Map<string, number>()
        for (const b of list) {
            const key = b.usedBand === Infinity ? "한쪽 무한" : b.usedBand <= band ? `${band}` : b.usedBand <= 200 ? "~200" : "~400"
            usedBands.set(key, (usedBands.get(key) ?? 0) + 1)
        }
        const summarize = (required: number[]) => {
            required.sort((a, b) => a - b)
            const percentile = (q: number) => round(required[Math.min(required.length - 1, Math.floor(q * required.length))], 1)
            return { medianM: percentile(0.5), p90M: percentile(0.9), maxM: round(required[required.length - 1], 1), within50: required.filter((r) => r <= 50).length, within100: required.filter((r) => r <= 100).length, within200: required.filter((r) => r <= 200).length }
        }
        const requiredSummary = band === 0 ? summarize(list.map((b) => b.requiredBand)) : null
        const requiredEdgeSummary = band === 0 ? summarize(list.map((b) => b.requiredBandEdge)) : null
        const row = {
            band,
            adaptive: args.adaptive,
            usedBands: Object.fromEntries(usedBands),
            requiredBand: requiredSummary,
            requiredBandEdge: requiredEdgeSummary,
            tiles: list.length,
            constraintFailures,
            retries,
            wallMs: Math.round(wall),
            mergeMs: Math.round(mergeMs),
            mergeMsPerTile: round(mergeMs / list.length, 1),
            restMs: Math.round(restMs),
            pointsPerTile: Math.round(points / list.length),
            triangles,
            needles,
            seam: { ...seam.summary(), misses: seamMisses },
            vsFull: band === 0 ? null : { ...diff.summary(), misses: diffMisses, farthestDiffM: round(farthestDiffM, 1) },
        }
        results.push(row)
        realLog(
            `띠 ${band === 0 ? "전체" : `${band} m`}${args.adaptive && band > 0 ? `(적응 ${args.adaptive}: 쓴 띠 ${JSON.stringify(row.usedBands)}, 재시도 ${retries})` : ""}: 도엽 ${row.tiles}, 제약 실패 ${constraintFailures}, 합침+삼각분할 ${row.mergeMs} ms(도엽당 ${row.mergeMsPerTile}), 법선+자르기 ${row.restMs} ms, 점/도엽 ${row.pointsPerTile}, 삼각형 ${triangles}, 바늘(<1°) ${needles}` +
                (requiredSummary ? `\n  필요한 띠 폭(도엽별): 중앙값 ${requiredSummary.medianM} m, p90 ${requiredSummary.p90M} m, 최대 ${requiredSummary.maxM} m, ≤50 m ${requiredSummary.within50}, ≤100 m ${requiredSummary.within100}, ≤200 m ${requiredSummary.within200} / ${row.tiles}` : "") +
                (requiredEdgeSummary ? `\n  필요한 띠 폭(경계 삼각형만): 중앙값 ${requiredEdgeSummary.medianM} m, p90 ${requiredEdgeSummary.p90M} m, 최대 ${requiredEdgeSummary.maxM} m, ≤50 m ${requiredEdgeSummary.within50}, ≤100 m ${requiredEdgeSummary.within100}, ≤200 m ${requiredEdgeSummary.within200} / ${row.tiles}` : "") +
                `\n  경계 균열: 표본 ${row.seam.samples}(실패 ${seamMisses}), 최대 ${row.seam.maxM} m, 평균 ${row.seam.meanM} m, >1cm ${row.seam.over1cm}, >10cm ${row.seam.over10cm}` +
                (row.vsFull
                    ? `\n  기준(전체) 대비: 표본 ${row.vsFull.samples}(실패 ${diffMisses}), 최대 ${row.vsFull.maxM} m, 평균 ${row.vsFull.meanM} m, >1cm ${row.vsFull.over1cm}, >10cm ${row.vsFull.over10cm}, >1cm 자리의 경계 거리 최대 ${row.vsFull.farthestDiffM} m`
                    : ""),
        )
    }

    await mkdir(args.out, { recursive: true })
    const hash = createHash("sha1").update(args.bbox.join(",")).digest("hex").slice(0, 6)
    const file = path.join(args.out, `band-check-${hash}.json`)
    await writeFile(file, JSON.stringify({ createdAt: new Date().toISOString(), bbox: args.bbox, grid: args.grid, node: process.version, tiles: qSel.tiles.length, results }, null, 2))
    realLog(`끝. ${file}`)
}

const centroid = (pts: [number, number][]): [number, number] => [
    pts.reduce((s, p) => s + p[0], 0) / pts.length,
    pts.reduce((s, p) => s + p[1], 0) / pts.length,
]

run().catch((err) => {
    console.error(err)
    process.exit(1)
})
