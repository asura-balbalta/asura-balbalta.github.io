#!/usr/bin/env node
/**
 * 도엽 출력 동등성 하네스(docs/cache-refactor-plan.md 6절 V1·V4(a)·C0, 2026-10-23).
 *
 * 실제 보조 워커 모듈(src/terrainTileBuild.worker.ts)을 esbuild 로 Node 용으로 묶어 worker_threads 안에서 `self` 흉내로 돌린다. 메시지 규약
 * (BuildJob → built/failed/fetched)은 브라우저와 같고, 메시지는 구조화 복제·버퍼 transfer 로 오간다. 도엽 일감은 조정자와 같은 규칙으로
 * 만든다(scripts/tileGolden.ts sceneJobs). 자료(R2 https://layers.asrbbt.world/...)는 처음 한 번 받아 git 제외 폴더
 * docs/render-checks/tile-golden-cache/ 에 두고 다음부터 디스크에서 내준다(주소마다 요청 수를 센다).
 * 테스트 프레임워크는 쓰지 않는다. 비교·판정·기록은 이 스크립트가 한다(fb_web/CLAUDE.md 검증 시스템의 원칙).
 *
 * 흐름(함수):
 * - bundle: esbuild 로 보조 워커와 tileGolden.ts 를 node_modules/.cache/fb_web/tile-golden/ 에 묶는다(dist 는 건드리지 않음)
 * - installFetch: fetch 를 로컬 디스크 캐시로 바꾼다(없으면 R2 에서 받아 저장). 워커 스레드·메인 스레드 둘 다
 * - workerMain: 워커 스레드 쪽. self 흉내·로그 잡기·시간 재기 뒤 보조 워커 묶음을 import
 * - Helper: 메인 쪽 워커 하나(일감 하나씩 보내고 결과를 기다림. 조정자가 보조 워커에 하듯이)
 * - loadPlan: tile-golden.tiles.json 의 장면(선택 bbox)을 일감으로 펼친다
 * - runGolden: 설정 × 장면 × 도엽을 정한 순서로 만들어 digestTile → golden.json·timing.json
 * - digestTile: TileData 의 모든 필드 정규화 해시 + 순서 무관 해시(삼각형·표 행 정렬) + 산림 마스크 도엽 폴리곤 안 해시
 * - compareGoldens: 필드별 비교와 분류(같음 / 순서만 / 산림 폴리곤 밖만(허용 1) / 산림 귀퉁이 행(허용 2) / 폴리곤 밖 항목 표 행 / 다름)
 * - runTiming: 차가운(새 워커)·데운(같은 워커, reset 뒤 다시) 시간 5회 → 중앙값·p95
 * - runC0: 5K 가장자리 도엽마다 자료 대조(tileGolden.ts analyzeTile) + 결과 대조(자기 5K 만 vs 지금 방식, 실제 워커)
 *
 * 사용:
 *   npm run tile-golden -- [--label before] [--order baseline|reverse|shuffle:<seed>|fresh|switch] [--configs tin,stepped,forest0,roadsclip0]
 *                          [--perturb vertex|mask|mask-outside|tri-order|tri-flip] [--out <dir>] [--logs(도엽 로그 줄 → logs.json)]
 *   npm run tile-golden -- --compare <a> <b> [--allow bbox-rows] [--common]   # 폴더 또는 golden.json. 실패가 있으면 종료 코드 1. --common 은 양쪽에 다 있는 기록만.
 *                                                                              # a = 기준(전), b = 새 코드(산림 허용 2 는 이 방향만 통과)
 *                                                    [--fresh <dir>]            # 허용 6: a 와 다르지만 b 가 fresh 기준(도엽마다 새 워커)과 같은 묶음은 fresh-6
 *   npm run tile-golden -- --timing [--runs 5] [--configs tin,stepped] [--label timing-before]
 *   npm run tile-golden -- --c0 [--sheets 37608033,...] [--no-result]
 *   npm run tile-golden -- --describe <id5k | x0,y0,x1,y1>  # 5K 의 1K 25장(자리·3857 범위), 또는 선택 bbox 에 걸리는 도엽. 도엽 고를 때
 *   npm run tile-golden -- --analyze <map_id>          # 도엽 하나의 C0 자료 대조를 항목까지
 *   npm run tile-golden -- --c0-tile <map_id>          # 도엽 하나를 지금 방식·자기 5K 만으로 만들어 한쪽에만 있는 삼각형(넓이·깊이)과 표 행
 * 결과: docs/render-checks/<오늘>-golden-<label>/golden.json·timing.json, C0 는 docs/render-checks/<오늘>-c0/c0.json. 폴더는 git 제외
 */
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { format } from "node:util"
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads"
import { gunzipSync, gzipSync } from "node:zlib"

const SELF_FILE = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(SELF_FILE), "..")
const CACHE_DIR = path.join(ROOT, "docs/render-checks/tile-golden-cache")
const BUNDLE_DIR = path.join(ROOT, "node_modules/.cache/fb_web/tile-golden")
const TILES_FILE = path.join(ROOT, "scripts/tile-golden.tiles.json")
const R2 = "https://layers.asrbbt.world/"
const NOT_BUILT = 0xffffffff
const WATER_RIBBON = 3
const ROAD_RIBBON = 1

// ---- fetch → 로컬 디스크 캐시 ----

/** 주소마다 내준 횟수와 실제로 네트워크에서 받은 수(이 스레드 몫) */
const fetchCounts = new Map()
let networkFetches = 0
/**
 * fetch 를 R2 디스크 캐시로 바꾼다. R2 밖 주소는 막는다(하네스가 다른 곳에 닿지 않게). transform(url, bytes) 은 내주기 전에 바이트를 바꾼다
 * (재검증 흔들기·자기 5K 만 거르기). 실패 응답(404 등)은 `<파일>.status` 로 기억한다
 */
const installFetch = (transform = null) => {
    const realFetch = globalThis.fetch
    globalThis.fetch = async (input) => {
        const url = typeof input === "string" ? input : input.url
        if (!url.startsWith(R2)) throw new Error(`tile-golden: R2 밖 주소는 받지 않음 ${url}`)
        const rel = url.slice(R2.length)
        if (rel.includes("..") || rel.includes("?") || rel.includes("#")) throw new Error(`tile-golden: 허용하지 않는 경로 ${url}`)
        const file = path.join(CACHE_DIR, "layers.asrbbt.world", rel)
        fetchCounts.set(url, (fetchCounts.get(url) ?? 0) + 1)
        let bytes = null
        let status = 200
        if (existsSync(file)) bytes = await readFile(file)
        else if (existsSync(`${file}.status`)) status = Number(await readFile(`${file}.status`, "utf8"))
        else {
            networkFetches++
            const res = await realFetch(url)
            await mkdir(path.dirname(file), { recursive: true })
            if (res.ok) {
                bytes = Buffer.from(await res.arrayBuffer())
                await writeFile(file, bytes)
            } else {
                status = res.status
                await writeFile(`${file}.status`, String(status))
            }
        }
        if (status !== 200) return new Response(null, { status })
        if (transform) bytes = transform(url, bytes)
        return new Response(bytes, { status: 200 })
    }
}
const takeFetchCounts = () => {
    const out = Object.fromEntries(fetchCounts)
    fetchCounts.clear()
    const network = networkFetches
    networkFetches = 0
    return { urls: out, network }
}

/** C0 결과 대조: 레이어 50K 인덱스에서 자기 5K 가 아닌 항목의 개수를 0 으로 → loadX 가 그 5K 를 건너뛴다(src 수정 없이 "자기 5K 만") */
const own5kTransform = (own5k) => (url, bytes) => {
    if (!/^https:\/\/layers\.asrbbt\.world\/(buildings|roads|water|forest)\/index\/v1\/\d{5}\.json$/.test(url)) return bytes
    const ix = JSON.parse(bytes.toString("utf8"))
    for (const s of ix.sheets ?? []) {
        if (String(s.id5k) === own5k) continue
        for (const k of ["n_buildings", "n_faces", "n_lines", "n_pieces", "n_poly"]) if (k in s) s[k] = 0
    }
    return Buffer.from(JSON.stringify(ix))
}
/** 재검증: 건물 파일 하나의 정점 x 하나에 1 mm 를 더해 다시 gzip */
const vertexTransform = ({ url: target, byteOffset }) => (url, bytes) => {
    if (url !== target) return bytes
    const raw = Buffer.from(gunzipSync(bytes))
    raw.writeInt32LE(raw.readInt32LE(byteOffset) + 1, byteOffset)
    return gzipSync(raw)
}

// ---- 워커 스레드 ----

const cpuMs = () => {
    const u = process.threadCpuUsage ? process.threadCpuUsage() : process.cpuUsage()
    return (u.user + u.system) / 1000
}

/** 워커 스레드: self 흉내를 깔고 보조 워커 묶음을 import 한 뒤 메인의 메시지를 그 onmessage 로 넘긴다 */
const workerMain = async ({ bundle, own5k, perturbVertex }) => {
    installFetch(own5k ? own5kTransform(own5k) : perturbVertex ? vertexTransform(perturbVertex) : null)
    let logs = []
    for (const k of ["log", "info", "warn", "error"]) console[k] = (...a) => logs.push(`${k === "log" || k === "info" ? "" : `${k}: `}${format(...a)}`)
    let job = null
    globalThis.self = {
        onmessage: null,
        postMessage: (msg, opts) => {
            if (msg.type === "fetched") {
                parentPort.postMessage({ kind: "fetched", path: msg.path })
                return
            }
            const wall = performance.now() - job.t0
            const cpu = cpuMs() - job.cpu0
            parentPort.postMessage({ kind: "result", msg, logs, wall, cpu, fetches: takeFetchCounts() }, opts?.transfer ?? [])
            logs = []
        },
    }
    await import(pathToFileURL(bundle).href)
    parentPort.on("message", (m) => {
        if (m.type === "build") {
            logs = []
            job = { t0: performance.now(), cpu0: cpuMs() }
        }
        globalThis.self.onmessage({ data: m })
        if (m.type === "reset") parentPort.postMessage({ kind: "reset-done", logs: logs.splice(0) })
    })
    parentPort.postMessage({ kind: "ready" })
}

// ---- 메인 ----

async function bundle() {
    const { build } = await import("esbuild")
    await mkdir(BUNDLE_DIR, { recursive: true })
    const r = await build({
        entryPoints: { worker: path.join(ROOT, "src/terrainTileBuild.worker.ts"), lib: path.join(ROOT, "scripts/tileGolden.ts") },
        bundle: true,
        platform: "node",
        format: "esm",
        outdir: BUNDLE_DIR,
        outExtension: { ".js": ".mjs" },
        logLevel: "warning",
        metafile: true,
    })
    // 보조 워커 묶음에 실제로 들어간 src 파일(기록의 "어느 코드로 만들었나" 근거. 커밋과 다른 파일이 있으면 적는다)
    const out = Object.entries(r.metafile.outputs).find(([f]) => f.endsWith("worker.mjs"))[1]
    workerInputs = Object.keys(out.inputs).filter((f) => !f.includes("node_modules")).map((f) => path.relative(ROOT, path.resolve(process.cwd(), f)))
    return { worker: path.join(BUNDLE_DIR, "worker.mjs"), lib: path.join(BUNDLE_DIR, "lib.mjs") }
}
/** 보조 워커 묶음에 들어간 src 파일(bundle 이 채운다) */
let workerInputs = []

/** 메인 쪽 보조 워커 하나. 요청 하나씩 보내고 답을 기다린다 */
class Helper {
    constructor(data) {
        this.worker = new Worker(SELF_FILE, { workerData: data })
        /** C0 "자기 5K 만": C2 뒤 보조 워커는 레이어 인덱스를 읽지 않으므로 buildOne 이 일감의 레이어 목록을 이 5K 로 거른다 */
        this.own5k = data.own5k ?? null
        this.waiters = []
        this.fetched = []
        this.worker.on("message", (m) => {
            if (m.kind === "fetched") {
                this.fetched.push(m.path)
                return
            }
            this.waiters.shift()?.resolve(m)
        })
        this.worker.on("error", (e) => {
            for (const w of this.waiters.splice(0)) w.reject(e)
        })
        this.ready = new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
    }
    request(msg) {
        return new Promise((resolve, reject) => {
            this.waiters.push({ resolve, reject })
            this.worker.postMessage(msg)
        })
    }
    terminate() {
        return this.worker.terminate()
    }
}

const today = () => new Date().toISOString().slice(0, 10)
const H = (data) => createHash("sha256").update(data).digest("hex").slice(0, 32)
const isTA = (v) => ArrayBuffer.isView(v) && !(v instanceof DataView)
const taBytes = (ta) => Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength)
const numStr = (v) => (Object.is(v, -0) ? "-0" : String(v))

function parseArgs(argv) {
    const a = { label: "golden", order: "baseline", configs: null, perturb: null, out: null, compare: null, timing: false, runs: 5, c0: false, sheets: null, result: true, describe: null, analyze: null, allow: [], common: false, c0tile: null, logs: false }
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i]
        const take = () => {
            const v = argv[++i]
            if (v === undefined) throw new Error(`${k} 에 값이 없습니다`)
            return v
        }
        switch (k) {
            case "--label": a.label = take(); break
            case "--order": a.order = take(); break
            case "--configs": a.configs = take().split(","); break
            case "--perturb": a.perturb = take(); break
            case "--out": a.out = take(); break
            case "--compare": a.compare = [take(), take()]; break
            case "--allow": a.allow = take().split(","); break
            case "--common": a.common = true; break
            case "--fresh": a.fresh = take(); break
            case "--logs": a.logs = true; break
            case "--timing": a.timing = true; break
            case "--runs": a.runs = Number(take()); break
            case "--c0": a.c0 = true; break
            case "--sheets": a.sheets = take().split(","); break
            case "--no-result": a.result = false; break
            case "--describe": a.describe = take(); break
            case "--analyze": a.analyze = take(); break
            case "--c0-tile": a.c0tile = take(); break
            default: throw new Error(`모르는 옵션 ${k}`)
        }
    }
    return a
}

async function main() {
    const args = parseArgs(process.argv.slice(2))
    if (args.compare) {
        const code = await compareGoldens(...args.compare, args.allow, args.common, args.fresh)
        process.exit(code)
    }
    installFetch()
    const bundles = await bundle()
    const lib = await import(pathToFileURL(bundles.lib).href)
    if (args.describe) return describe(lib, args.describe)
    if (args.analyze) return analyzeOne(lib, args.analyze)
    if (args.c0tile) return c0Tile(lib, bundles, args.c0tile)
    if (args.c0) return runC0(lib, bundles, args)
    if (args.timing) return runTiming(lib, bundles, args)
    return runGolden(lib, bundles, args)
}

/** 도엽 하나의 C0 자료 대조를 자세히(차이 항목·출처 5K·면적). 원점은 그 도엽이 든 장면, 없으면 그 5K 를 선택했을 때 */
async function analyzeOne(lib, mapId) {
    const spec = JSON.parse(await readFile(TILES_FILE, "utf8"))
    const scene = spec.scenes.find((s) => mapId in s.tiles)
    const tile = await lib.tileById(mapId)
    const origin = scene ? (await lib.sceneJobs(await lib.blockBbox(Object.keys(scene.tiles)))).origin : (await lib.sheetTiles(tile.id5k)).origin
    const a = await lib.analyzeTile(tile, origin)
    console.log(`도엽 ${mapId}(5K ${a.id5k}) 원점 ${origin}${scene ? `(장면 ${scene.name})` : ""}, 지금 방식 5K ${a.sheetsCur.join(" ")}`)
    for (const [l, d] of Object.entries(a.layers)) {
        console.log(`  ${l}: 지금 ${d.cur}, 자기 5K ${d.own}, 지금만(안 ${d.onlyCurIn.length}, 귀퉁이 ${d.onlyCurBbox.length}), 자기만(안 ${d.onlyOwnIn.length}, 귀퉁이 ${d.onlyOwnBbox.length}), 값 다름 ${d.changed.length}`)
        for (const [k, v] of Object.entries(d.detail)) {
            const tag = d.onlyCurIn.includes(k) ? "지금만·안" : d.onlyOwnIn.includes(k) ? "자기만·안" : d.changed.includes(k) ? "값 다름" : d.onlyCurBbox.includes(k) ? "지금만·귀퉁이" : "자기만·귀퉁이"
            console.log(`    ${tag} ${k} (출처 ${v})`)
        }
    }
}

/**
 * 두 TileData 의 메쉬(tin·buildings·roads·water)마다 한쪽에만 있는 삼각형(xy 무관 정점 키 집합)의 수·넓이 합(xy 투영)·최대 깊이
 * (삼각형 꼭짓점이 도엽 변에서 안쪽으로 들어간 거리의 최댓값. 경계 실금은 mm 이하)
 */
const meshDiff = (da, db, job) => {
    const [ox, oy] = job.origin
    const poly = job.tile.corners.map(([x, y]) => [x - ox, y - oy])
    const depthOf = (x, y) => {
        let best = Infinity
        for (let i = 0; i < poly.length; i++) {
            const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length]
            const dx = bx - ax, dy = by - ay
            const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
            best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)))
        }
        return best
    }
    const tris = (m) => {
        const out = new Map()
        if (!m) return out
        const vk = vertexKeys(m.positions)
        const P = m.positions, I = m.indices
        for (let t = 0; t < I.length / 3; t++) {
            const [i, j, k] = [I[3 * t], I[3 * t + 1], I[3 * t + 2]]
            const key = [vk[i], vk[j], vk[k]].sort().join("")
            const e = out.get(key)
            if (e) {
                e.n++
                continue
            }
            const area = Math.abs((P[3 * j] - P[3 * i]) * (P[3 * k + 1] - P[3 * i + 1]) - (P[3 * k] - P[3 * i]) * (P[3 * j + 1] - P[3 * i + 1])) / 2
            out.set(key, { n: 1, area, depth: Math.max(...[i, j, k].map((v) => depthOf(P[3 * v], P[3 * v + 1]))) })
        }
        return out
    }
    const side = (X, Y) => {
        let n = 0, area = 0, depth = 0
        for (const [k, e] of X) {
            const d = e.n - (Y.get(k)?.n ?? 0)
            if (d <= 0) continue
            n += d
            area += e.area * d
            depth = Math.max(depth, e.depth)
        }
        return { n, area, depth }
    }
    const out = {}
    for (const f of ["tin", "buildings", "roads", "water"]) {
        const A = tris(da[f]), B = tris(db[f])
        out[f] = { onlyA: side(A, B), onlyB: side(B, A) }
    }
    return out
}

/**
 * C0 결과 차이 자세히: 도엽 하나를 지금 방식(새 워커)과 자기 5K 만(레이어 인덱스에서 이웃을 비운 워커)으로 만들어 메쉬마다 한쪽에만 있는
 * 삼각형의 수·넓이 합·도엽 변에서 안쪽으로 들어간 최대 깊이를 보인다(경계 실금인지 실제 면인지 가리는 수치)
 */
async function c0Tile(lib, bundles, mapId) {
    const spec = JSON.parse(await readFile(TILES_FILE, "utf8"))
    const tile = await lib.tileById(mapId)
    const { bbox } = await lib.sheetTiles(tile.id5k)
    const plan = await lib.sceneJobs(bbox)
    const scene = { name: "c0", origin: plan.origin, jobs: plan.jobs }
    const style = { ...STYLE_DEFAULT, ...spec.configs.tin }
    const cur = new Helper({ bundle: bundles.worker })
    const own = new Helper({ bundle: bundles.worker, own5k: tile.id5k })
    await Promise.all([cur.ready, own.ready])
    const [a, b] = [await buildOne(cur, scene, mapId, style), await buildOne(own, scene, mapId, style)]
    await Promise.all([cur.terminate(), own.terminate()])
    console.log(`도엽 ${mapId}(5K ${tile.id5k}) 지금 방식 vs 자기 5K 만`)
    const md = meshDiff(a.msg.data, b.msg.data, a.job)
    const fmt = (x) => `${x.n}개 넓이 ${x.area.toFixed(6)} m² 최대 깊이 ${x.depth.toFixed(5)} m`
    for (const [f, d] of Object.entries(md)) console.log(`  ${f.padEnd(9)} 지금 방식에만 ${fmt(d.onlyA)} · 자기 5K 에만 ${fmt(d.onlyB)}`)
    for (const t of ["roadTable", "waterTable"]) {
        const d = multisetDiff(digestTile(a.msg.data, a.job).rows[t], digestTile(b.msg.data, b.job).rows[t])
        console.log(`  ${t} 지금 방식에만 ${d.onlyA.join(" ") || "-"} · 자기 5K 에만 ${d.onlyB.join(" ") || "-"}`)
    }
    console.log(`  통계 지금 ${JSON.stringify([a.msg.data.roadStats, a.msg.data.waterStats])} 자기 ${JSON.stringify([b.msg.data.roadStats, b.msg.data.waterStats])}`)
}

/** 선택 bbox(3857)에 걸리는 도엽을 5K·자리와 함께(장면 도엽을 고를 때) */
async function describeBbox(lib, bbox) {
    const q = await lib.getTtpSheetsInBbox(bbox)
    const places = new Map()
    for (const s of q.sheets) for (const t of (await lib.sheetTiles(s.id5k)).tiles) places.set(t.tile.map_id, `${t.place} 행 ${t.row} 열 ${t.col}`)
    console.log(`원점 ${q.origin}, 도엽 ${q.tiles.length}, 5K ${q.sheets.map((s) => s.id5k).join(" ")}`)
    for (const t of q.tiles) console.log(`${t.map_id} ${t.name} 5K ${t.id5k} ${places.get(t.map_id)}`)
}

async function describe(lib, id5k) {
    if (id5k.includes(",")) return describeBbox(lib, id5k.split(",").map(Number))
    const { origin, tiles, bbox } = await lib.sheetTiles(id5k)
    console.log(`5K ${id5k} 원점 ${origin} 선택 bbox ${bbox.map((v) => Math.round(v)).join(",")}`)
    for (const t of tiles.sort((a, b) => b.row - a.row || a.col - b.col)) {
        const e = lib.tileExtent3857(t.tile.corners)
        console.log(`${t.tile.map_id} ${t.tile.name} 행 ${t.row} 열 ${t.col} ${t.place.padEnd(6)} 3857 ${e.map((v) => Math.round(v)).join(",")}`)
    }
}

// ---- 일감 ----

/** tile-golden.tiles.json 을 읽어 장면마다 조정자 순서의 일감으로 펼친다 */
async function loadPlan(lib) {
    const spec = JSON.parse(await readFile(TILES_FILE, "utf8"))
    const scenes = []
    for (const s of spec.scenes) {
        const ids = Object.keys(s.tiles)
        const bbox = s.bbox3857 ?? (await lib.blockBbox(ids))
        const plan = await lib.sceneJobs(bbox, ids)
        scenes.push({ name: s.name, bbox, origin: plan.origin, tiles: plan.tiles.map((t) => t.map_id), jobs: plan.jobs })
    }
    return { spec, scenes }
}

/** 시드가 있는 섞기(mulberry32) */
const shuffled = (arr, seed) => {
    let s = seed >>> 0
    const rnd = () => {
        s = (s + 0x6d2b79f5) >>> 0
        let t = s
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const out = arr.slice()
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1))
        ;[out[i], out[j]] = [out[j], out[i]]
    }
    return out
}

/** 순서 방식에 따라 (장면, 도엽 순서) 목록 */
const orderScenes = (scenes, order) => {
    if (order === "reverse") return scenes.slice().reverse().map((s) => ({ ...s, tiles: s.tiles.slice().reverse() }))
    if (order.startsWith("shuffle")) {
        const seed = Number(order.split(":")[1] ?? 1)
        return shuffled(scenes, seed).map((s, k) => ({ ...s, tiles: shuffled(s.tiles, seed + k + 1) }))
    }
    return scenes
}

/** 보조 워커 로그 한 줄에서 단계별 ms(합침·모드·건물·도로·물·산림. 도로·물·산림은 "받기" 를 더한 값). 형식이 바뀌면 여기를 고친다 */
const parseLayerMs = (line) => {
    const n = (re) => {
        const m = re.exec(line)
        return m ? m.slice(1).reduce((s, v) => s + (v ? Number(v) : 0), 0) : null
    }
    return {
        merge: n(/: (?:캐시|이웃 .*? 합침) (\d+)ms, /),
        mode: n(/, (?:tin|stepped) (\d+)ms, 삼각형/),
        buildings: n(/, 건물 \d+(?:\(캐시\))? (\d+)ms, 도로/),
        roads: n(/, 도로 \d+\(교량 \d+, 숨김 \d+\)(?:\([^)]*\))? (?:받기 (\d+)ms \+ )?(\d+)ms, 물/),
        water: n(/, 물 \d+\(하천 \d+, 호소 \d+, 띠 \d+\)(?:\([^)]*\))? (?:받기 (\d+)ms \+ )?(\d+)ms, 산림/),
        // 산림이 끝 조각이 아니어도 읽게(C3 검토 L3): 다음 ", " 또는 줄 끝 앞의 "(받기 Nms + )Nms"
        forest: n(/, 산림 \d+(?:\(건너뜀 \d+\))? .*?(?:받기 (\d+)ms \+ )?(\d+)ms(?:, |$)/),
    }
}

let nextJobId = 1
/** 일감 하나를 보내고 결과를 받는다. 실패·경고는 그대로 돌려준다 */
async function buildOne(helper, scene, tileId, style) {
    const base = scene.jobs.get(tileId)
    const job = { type: "build", jobId: nextJobId++, ...base, style }
    // C0 자기 5K 만(C2 뒤): own5kTransform 이 레이어 인덱스에서 이웃 5K 를 비우던 것과 같은 거르기를 일감에서 한다
    if (helper.own5k) job.layers = Object.fromEntries(Object.entries(job.layers).map(([k, v]) => [k, Array.isArray(v) ? v.filter((s) => s.id5k === helper.own5k) : v]))
    const r = await helper.request(job)
    if (r.kind !== "result") throw new Error(`예상 밖 응답 ${r.kind}`)
    const line = r.logs.find((l) => l.startsWith("도엽 ")) ?? ""
    return { job, msg: r.msg, logs: r.logs, warnings: r.logs.filter((l) => l.startsWith("warn") || l.startsWith("error")), wall: r.wall, cpu: r.cpu, layers: parseLayerMs(line), fetches: r.fetches }
}

// ---- 정규화 해시 ----

/** 모든 필드를 경로 → 해시로(typed array 는 바이트 sha256, 숫자는 정확한 문자열, 배열·객체는 펼침) */
const walk = (v, p, out) => {
    if (v === null || v === undefined) {
        out[p] = String(v)
        return
    }
    if (isTA(v)) {
        out[p] = `${v.constructor.name}:${v.length}:${H(taBytes(v))}`
        return
    }
    if (Array.isArray(v)) {
        if (v.every((x) => x === null || typeof x !== "object")) {
            const flat = v.map((x) => (typeof x === "number" ? numStr(x) : x))
            out[p] = v.length <= 4 ? `arr:${JSON.stringify(flat)}` : `arr:${v.length}:${H(JSON.stringify(flat))}`
            return
        }
        out[`${p}.length`] = String(v.length)
        v.forEach((x, i) => walk(x, `${p}[${i}]`, out))
        return
    }
    if (typeof v === "object") {
        for (const k of Object.keys(v).sort()) walk(v[k], p ? `${p}.${k}` : k, out)
        return
    }
    out[p] = typeof v === "number" ? numStr(v) : JSON.stringify(v)
}

/** 정점 키(위치 f32 바이트 + 있으면 법선 f32 바이트의 16진) */
const vertexKeys = (positions, normals) => {
    const n = positions.length / 3
    const pb = taBytes(positions)
    const nb = normals ? taBytes(normals) : null
    const keys = new Array(n)
    for (let v = 0; v < n; v++) keys[v] = pb.toString("hex", v * 12, v * 12 + 12) + (nb ? nb.toString("hex", v * 12, v * 12 + 12) : "")
    return keys
}
/** 삼각형 키(가장 작은 정점부터 돌려 감김 방향은 지킴) [from, to) */
const triKeys = (vk, indices, from = 0, to = indices.length / 3) => {
    const out = []
    for (let t = from; t < to; t++) {
        const a = vk[indices[3 * t]], b = vk[indices[3 * t + 1]], c = vk[indices[3 * t + 2]]
        out.push(a <= b && a <= c ? a + b + c : b <= a && b <= c ? b + c + a : c + a + b)
    }
    return out
}
const meshUnordered = (meshes) => {
    const keys = []
    for (const m of meshes) if (m) for (const k of triKeys(vertexKeys(m.positions, m.normals), m.indices)) keys.push(k)
    keys.sort()
    return `${keys.length}:${H(keys.join("\n"))}`
}
const rowsDigest = (rows, consts) => H(rows.slice().sort().join("\n") + "\n" + consts)

const buildingRows = (t, mesh) => {
    if (!t) return []
    const built = [...Array(t.count).keys()].filter((i) => t.faceBase[i] !== NOT_BUILT).sort((a, b) => t.faceBase[a] - t.faceBase[b])
    const end = new Map()
    built.forEach((i, k) => end.set(i, k + 1 < built.length ? t.faceBase[built[k + 1]] : mesh.indices.length / 3))
    const vk = mesh ? vertexKeys(mesh.positions) : null
    const rows = []
    for (let i = 0; i < t.count; i++) {
        const cols = ["ids", "heights", "floors", "floorsUnder", "useCd", "structCd", "flags", "baseZ", "builtHeight", "nameSrc"].map((c) => numStr(t[c][i]))
        const xy = Array.from(t.xy.subarray(2 * t.pointStart[i], 2 * t.pointStart[i + 1])).join(",")
        const holes = Array.from(t.holeLen.subarray(t.holeStart[i], t.holeStart[i + 1])).join(",")
        const nb = t.faceBase[i] === NOT_BUILT
        const tris = nb ? "nb" : triKeys(vk, mesh.indices, t.faceBase[i], end.get(i)).sort().join("")
        rows.push(`b${t.ids[i]}:${nb ? "nb" : end.get(i) - t.faceBase[i]}:${H([cols.join(","), t.names[i], t.dongs[i], xy, holes, tris].join("|")).slice(0, 12)}`)
    }
    return rows
}
const rangeRows = (t, mesh, cols, strCols, prefixOf) => {
    if (!t) return []
    const vk = mesh ? vertexKeys(mesh.positions) : null
    const rows = []
    for (let i = 0; i < t.count; i++) {
        const nb = t.faceBase[i] === NOT_BUILT || t.faceCount[i] === 0
        const tris = nb ? "nb" : triKeys(vk, mesh.indices, t.faceBase[i], t.faceBase[i] + t.faceCount[i]).sort().join("")
        const body = [cols.map((c) => numStr(t[c][i])).join(","), strCols.map((c) => t[c][i]).join("|"), tris].join("|")
        rows.push(`${prefixOf(t, i)}${t.ids[i]}:${nb ? "nb" : t.faceCount[i]}:${H(body).slice(0, 12)}`)
    }
    return rows
}
const roadRows = (t, mesh) =>
    rangeRows(t, mesh, ["ids", "lineIds", "kind", "roadSe", "roadBt", "cartrk", "facility", "phyLv", "pavement", "status", "flags", "faceCount"], [], (tb, i) => (tb.kind[i] === ROAD_RIBBON ? "r" : "f"))
const waterRows = (t, mesh) =>
    rangeRows(t, mesh, ["ids", "kind", "nameId", "riverSe", "srcNPieces", "flags", "faceCount"], ["names", "riverNos"], (tb, i) => (tb.kind[i] === WATER_RIBBON ? "l" : "p"))
const forestRows = (t) => {
    if (!t) return []
    const rows = []
    for (let i = 0; i < t.count; i++) {
        const cols = ["ids", "frtp", "koftr", "dmcls", "agcls", "dnst", "height", "storunst", "fror", "year", "flags"].map((c) => numStr(t[c][i]))
        rows.push(`s${t.ids[i]}:${t.pixels[i]}:${H(cols.join(",")).slice(0, 12)}`)
    }
    return rows
}
const namesConst = (t, keys) => (t ? keys.map((k) => H(JSON.stringify(t[k]))).join(",") : "null")

/** 산림 마스크에서 픽셀 중심이 도엽 폴리곤 안인 0 아닌 픽셀(자리·값)의 해시와 안·밖 0 아닌 픽셀 수. 마스크가 없으면 전부 0 으로 본다 */
const forestInside = (mask, poly) => {
    if (!mask) return { inside: H(""), insideNonzero: 0, outsideNonzero: 0 }
    const pip = (x, y) => {
        let inside = false
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const [xi, yi] = poly[i], [xj, yj] = poly[j]
            if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
        }
        return inside
    }
    const parts = []
    let insideNonzero = 0, outsideNonzero = 0
    for (let j = 0; j < mask.height; j++) {
        const yc = mask.y0 + (j + 0.5) * mask.res
        for (let i = 0; i < mask.width; i++) {
            const v = mask.data[j * mask.width + i]
            const xc = mask.x0 + (i + 0.5) * mask.res
            const inPoly = pip(xc, yc)
            if (v === 0) continue
            if (inPoly) {
                insideNonzero++
                parts.push(`${xc.toFixed(3)},${yc.toFixed(3)}=${v}`)
            } else outsideNonzero++
        }
    }
    return { inside: H(parts.join(";")), insideNonzero, outsideNonzero }
}

/** TileData 하나의 기록: 정확한 필드 해시, 순서 무관 해시, 표 행, 산림 폴리곤 안 해시, 사람이 읽을 요약 */
function digestTile(data, job) {
    const fields = {}
    walk(data, "", fields)
    const [ox, oy] = job.origin
    const poly = job.tile.corners.map(([x, y]) => [x - ox, y - oy])
    const rows = {
        buildingTable: buildingRows(data.buildingTable, data.buildings),
        roadTable: roadRows(data.roadTable, data.roads),
        waterTable: waterRows(data.waterTable, data.water),
        forestTable: forestRows(data.forestTable),
    }
    const unordered = {
        tin: meshUnordered([data.tin]),
        terrain: meshUnordered(data.terrain),
        buildings: meshUnordered([data.buildings]),
        roads: meshUnordered([data.roads]),
        roadChunks: meshUnordered(data.roadChunks),
        water: meshUnordered([data.water]),
        waterChunks: meshUnordered(data.waterChunks),
        buildingTable: rowsDigest(rows.buildingTable, namesConst(data.buildingTable, ["useNames", "structNames", "useGroupNames"])),
        roadTable: rowsDigest(rows.roadTable, namesConst(data.roadTable, ["roadSeNames", "facilityNames", "pavementNames", "statusNames"])),
        waterTable: rowsDigest(rows.waterTable, namesConst(data.waterTable, ["kindNames", "riverSeNames"])),
        forestTable: rowsDigest(rows.forestTable, namesConst(data.forestTable, ["frtpNames", "koftrNames", "storunstNames", "frorNames", "dmclsNames", "agclsNames", "dnstNames", "heightNames"])),
    }
    const tri = (m) => (m ? m.indices.length / 3 : 0)
    const summary = {
        terrainTris: data.terrain.reduce((s, c) => s + tri(c), 0),
        tinTris: tri(data.tin),
        built: data.built,
        buildingTris: tri(data.buildings),
        roadRows: data.roadTable?.count ?? 0,
        roadStats: data.roadStats,
        waterRows: data.waterTable?.count ?? 0,
        waterStats: data.waterStats,
        forestRows: data.forestTable?.count ?? 0,
        forestSkipped: data.forestSkipped,
    }
    return { fields, unordered, rows, forest: forestInside(data.forestMask, poly), summary }
}

// ---- 재검증용 출력 흔들기 ----

/** 산림 마스크 픽셀 하나를 바꾼다. inside 면 도엽 폴리곤 안(가운데 근처), 아니면 폴리곤 밖(bbox 귀퉁이) */
const flipMaskPixel = (data, job, inside) => {
    const mask = data.forestMask
    if (!mask) return false
    const [ox, oy] = job.origin
    const poly = job.tile.corners.map(([x, y]) => [x - ox, y - oy])
    const pip = (x, y) => {
        let r = false
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const [xi, yi] = poly[i], [xj, yj] = poly[j]
            if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) r = !r
        }
        return r
    }
    const cand = inside ? [[Math.floor(mask.width / 2), Math.floor(mask.height / 2)]] : [[0, 0], [mask.width - 1, 0], [0, mask.height - 1], [mask.width - 1, mask.height - 1]]
    for (const [i, j] of cand) {
        if (pip(mask.x0 + (i + 0.5) * mask.res, mask.y0 + (j + 0.5) * mask.res) !== inside) continue
        const k = j * mask.width + i
        mask.data[k] = mask.data[k] === 0 ? 2 : 0
        return `${i},${j}`
    }
    return false
}

// ---- golden ----

const STYLE_DEFAULT = { mode: "tin", step: 1, smoothNormals: true }

/**
 * 설정 × 장면 × 도엽을 정한 순서로 만들어 golden.json 을 쓴다.
 * - baseline: 워커 하나. 설정마다 장면마다 reset(앱의 select) 뒤 조정자 순서로
 * - reverse·shuffle:<seed>: 장면·도엽 순서만 바꿈
 * - fresh: 도엽마다 새 워커(캐시 모두 빔)
 * - switch: 장면마다 reset 뒤 첫 설정으로 만들고, 나머지 설정은 reset 없이(앱의 표현 방식 전환처럼 캐시를 타고) 다시 만든다
 */
async function runGolden(lib, bundles, args) {
    const { spec, scenes } = await loadPlan(lib)
    const configNames = args.configs ?? Object.keys(spec.configs)
    const outDir = path.resolve(ROOT, args.out ?? `docs/render-checks/${today()}-golden-${args.label}`)
    await mkdir(outDir, { recursive: true })
    const records = {}
    const timing = []
    const tileLogs = []
    const warnings = []
    const fetchTotals = {}
    let network = 0
    let perturbNote = null
    const perturbVertex = args.perturb === "vertex" ? await lib.perturbTarget(scenes[0].jobs.get(scenes[0].tiles[0]).tile) : null
    if (perturbVertex) perturbNote = { kind: "vertex", tile: scenes[0].tiles[0], ...perturbVertex }
    const helperData = { bundle: bundles.worker, perturbVertex }
    const started = performance.now()

    const record = async (r, config, scene) => {
        if (r.msg.type !== "built") throw new Error(`도엽 ${r.job.tile.map_id} 실패: ${r.msg.message}`)
        for (const w of r.warnings) warnings.push(`${config}|${scene.name}|${r.job.tile.map_id}: ${w}`)
        for (const [u, c] of Object.entries(r.fetches.urls)) fetchTotals[u] = (fetchTotals[u] ?? 0) + c
        network += r.fetches.network
        if ((args.perturb === "tri-order" || args.perturb === "tri-flip") && !perturbNote && r.msg.data.tin.indices.length >= 6) {
            // 순서 분류 재검증: 삼각형 둘의 자리를 바꾸면 order, 삼각형 하나의 감김을 뒤집으면 real 이어야 한다
            const ix = r.msg.data.tin.indices
            if (args.perturb === "tri-order") for (let k = 0; k < 3; k++) [ix[k], ix[k + 3]] = [ix[k + 3], ix[k]]
            else [ix[1], ix[2]] = [ix[2], ix[1]]
            perturbNote = { kind: args.perturb, key: `${config}|${scene.name}|${r.job.tile.map_id}`, field: "tin.indices(tin 모드면 terrain[0] 과 같은 배열)" }
        }
        if ((args.perturb === "mask" || args.perturb === "mask-outside") && !perturbNote) {
            const at = flipMaskPixel(r.msg.data, r.job, args.perturb === "mask")
            if (at) perturbNote = { kind: args.perturb, key: `${config}|${scene.name}|${r.job.tile.map_id}`, pixel: at }
        }
        const key = `${config}|${scene.name}|${r.job.tile.map_id}`
        records[key] = digestTile(r.msg.data, r.job)
        timing.push({ key, wall: Math.round(r.wall * 10) / 10, cpu: Math.round(r.cpu * 10) / 10, layers: r.layers })
        // --logs(C3 2026-10-23): 도엽 로그 줄을 남겨 층별 "(캐시)" 적중을 전후로 견준다(perf-check cacheFlags 와 같은 표시)
        if (args.logs) tileLogs.push({ key, line: r.logs.find((l) => l.startsWith("도엽 ")) ?? "" })
        process.stdout.write(`\r${Object.keys(records).length} 도엽 ${key}                    `)
    }
    const styleOf = (c) => ({ ...STYLE_DEFAULT, ...spec.configs[c] })

    if (args.order === "fresh") {
        for (const c of configNames) {
            for (const scene of scenes) {
                for (const id of scene.tiles) {
                    const h = new Helper(helperData)
                    await h.ready
                    await record(await buildOne(h, scene, id, styleOf(c)), c, scene)
                    await h.terminate()
                }
            }
        }
    } else if (args.order === "switch") {
        const h = new Helper(helperData)
        await h.ready
        for (const scene of scenes) {
            await h.request({ type: "reset" })
            for (const c of configNames) for (const id of scene.tiles) await record(await buildOne(h, scene, id, styleOf(c)), c, scene)
        }
        await h.terminate()
    } else {
        const ordered = orderScenes(scenes, args.order)
        const h = new Helper(helperData)
        await h.ready
        for (const c of configNames) {
            for (const scene of ordered) {
                await h.request({ type: "reset" })
                for (const id of scene.tiles) await record(await buildOne(h, scene, id, styleOf(c)), c, scene)
            }
        }
        await h.terminate()
    }
    process.stdout.write("\n")

    // 기준값(자료 대조): bbox 에만 닿는 항목·산림 폴리곤별 픽셀 수. 코드와 무관한 자료 사실이라 비교의 허용 판정에 쓴다
    const oracle = {}
    for (const scene of scenes) {
        for (const id of scene.tiles) {
            const a = await lib.analyzeTile(scene.jobs.get(id).tile, scene.origin, { wide: true })
            oracle[`${scene.name}|${id}`] = {
                sheets: a.sheetsCur,
                bboxOnly: Object.fromEntries(Object.entries(a.layers).map(([k, d]) => [k, [...new Set(d.bboxOnly.map((x) => x.replace(/@.*/, "")))]])),
                forestPixels: a.forestPixels,
            }
        }
    }

    const meta = {
        made: new Date().toISOString(),
        commit: await gitHead(),
        node: process.version,
        order: args.order,
        configs: Object.fromEntries(configNames.map((c) => [c, styleOf(c)])),
        scenes: scenes.map((s) => ({ name: s.name, bbox: s.bbox, origin: s.origin, tiles: s.tiles })),
        perturb: perturbNote,
        workerInputs: workerInputs.length,
        workerDirty,
        warnings,
        fetch: { urls: Object.keys(fetchTotals).length, requests: Object.values(fetchTotals).reduce((s, v) => s + v, 0), network, byUrl: fetchTotals },
        seconds: Math.round((performance.now() - started) / 100) / 10,
    }
    await writeFile(path.join(outDir, "golden.json"), JSON.stringify({ meta, records, oracle }))
    await writeFile(path.join(outDir, "timing.json"), JSON.stringify({ meta: { made: meta.made, commit: meta.commit, order: args.order, note: "한 번 잰 값(참고). 기준 시간은 --timing" }, tiles: timing }, null, 1))
    if (args.logs) await writeFile(path.join(outDir, "logs.json"), JSON.stringify(tileLogs, null, 1))
    console.log(`기록 ${Object.keys(records).length}개 → ${path.relative(ROOT, outDir)}/golden.json (${meta.seconds}s, 요청 ${meta.fetch.requests}, 네트워크 ${network}, 경고 ${warnings.length})`)
    if (warnings.length) console.log(warnings.slice(0, 10).join("\n"))
    if (perturbNote) console.log(`흔들기: ${JSON.stringify(perturbNote)}`)
}

/** HEAD 커밋과, 보조 워커 묶음에 들어간 src 파일 중 커밋과 다른 것(있으면 "+변경 n" 을 붙이고 목록은 meta.workerDirty) */
async function gitHead() {
    try {
        const { execFileSync } = await import("node:child_process")
        const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT }).toString().trim()
        const dirty = workerInputs.length ? execFileSync("git", ["status", "--porcelain", "--", ...workerInputs], { cwd: ROOT }).toString().trim() : ""
        workerDirty = dirty ? dirty.split("\n") : []
        return dirty ? `${head}+변경 ${workerDirty.length}` : head
    } catch {
        return null
    }
}
let workerDirty = []

// ---- 비교 ----

const loadGolden = async (p) => {
    const file = (await stat(p)).isDirectory() ? path.join(p, "golden.json") : p
    return JSON.parse(await readFile(file, "utf8"))
}
/** 필드 경로 → 묶음(순서 무관 해시·분류 단위) */
const groupOf = (p) => {
    const head = p.split(/[.[]/)[0]
    if (["id", "name", "extra", "mode"].includes(head)) return "meta"
    return head
}
/** 묶음 → 레이어 */
const LAYER_OF = {
    meta: "meta", bounds: "terrain", terrain: "terrain", tin: "terrain",
    buildings: "buildings", buildingTable: "buildings", built: "buildings",
    roads: "roads", roadChunks: "roads", roadTable: "roads", roadStats: "roads",
    water: "water", waterChunks: "water", waterTable: "water", waterStats: "water",
    forestMask: "forest", forestTable: "forest", forestSkipped: "forest",
}
const MESH_OF_TABLE = { roadTable: ["roads", "roadChunks"], waterTable: ["water", "waterChunks"], buildingTable: ["buildings"] }
const RANK = { same: 0, order: 1, "outside-1": 2, "corner-2": 2, derived: 2, "fresh-6": 2, "bbox-rows": 3, real: 4 }
const multisetDiff = (a, b) => {
    const count = new Map()
    for (const x of a) count.set(x, (count.get(x) ?? 0) + 1)
    for (const x of b) count.set(x, (count.get(x) ?? 0) - 1)
    const onlyA = [], onlyB = []
    for (const [x, c] of count) {
        for (let i = 0; i < c; i++) onlyA.push(x)
        for (let i = 0; i < -c; i++) onlyB.push(x)
    }
    return { onlyA, onlyB }
}

/**
 * 기록 하나(설정|장면|도엽)를 묶음별로 분류한다:
 * - same: 바이트 같음
 * - order: 정확한 해시는 다르나 순서 무관 해시(삼각형·표 행 정렬)가 같음(허용 3)
 * - outside-1: 산림 마스크가 도엽 폴리곤 밖 픽셀만 다름(허용 1)
 * - corner-2: 산림 표가 귀퉁이에만 걸친 폴리곤 행(기준값: 폴리곤 안 픽셀 0)이나 3.6 픽셀 수 정정(같은 id·속성 행 한 쌍의 픽셀 수가 기준값
 *   {전체, 폴리곤 안} 짝)만 다름(허용 2). **방향이 있다**: a(첫 인자) = 3.6 전 기준(전체·귀퉁이 행), b = 새 코드. 반대면 real(V6 검토 L3)
 * - bbox-rows: 도로·물 표가 도엽 폴리곤과 겹치지 않는 항목(기준값 bboxOnly)의 "못 얹은" 행만 다르고 메쉬는 같음(계획서에 없는 차이. 판단 필요)
 * - derived: 통계(숨김 수·건너뜀 수)가 위 허용 차이에서 따라 바뀜
 * - fresh-6: (`--fresh` 를 줄 때만) a 와는 real 이지만 b 가 fresh 기준과 같은 묶음(허용 6: 순서 의존을 없애 생긴 차이. compareGoldens)
 * - real: 그 밖. 실패
 */
function classifyRecord(a, b, oracle) {
    const groups = new Set([...Object.keys(a.fields), ...Object.keys(b.fields)].map(groupOf))
    const out = {}
    const diffFields = (g) => [...new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])].filter((p) => groupOf(p) === g && a.fields[p] !== b.fields[p])
    for (const g of groups) {
        const fields = diffFields(g)
        if (fields.length === 0) {
            out[g] = { cls: "same" }
            continue
        }
        if (a.unordered[g] !== undefined && a.unordered[g] === b.unordered[g]) {
            out[g] = { cls: "order", fields: fields.length }
            continue
        }
        if (g === "forestMask") {
            out[g] = a.forest.inside === b.forest.inside ? { cls: "outside-1", fields: fields.length } : { cls: "real", fields: fields.slice(0, 5), inside: [a.forest.insideNonzero, b.forest.insideNonzero] }
            continue
        }
        if (g === "forestTable" && oracle) {
            const { onlyA, onlyB } = multisetDiff(a.rows.forestTable, b.rows.forestTable)
            // 허용 2(C5 에서 엄격하게, V6 검토 L3 으로 방향까지): a = 기준(3.6 전 코드: 전체 픽셀·귀퉁이 행), b = 새 코드(폴리곤 안 픽셀·귀퉁이 행 없음).
            // 다른 행은 (가) a 에만 있는 귀퉁이 행(기준값 폴리곤 안 0)이거나, (나) 같은 id·같은 속성 행이 양쪽에 하나씩이고 a 가 기준값 전체·b 가 기준값
            // 폴리곤 안인 3.6 정정뿐이어야 한다. 반대 방향(b 에 귀퉁이 행·전체 픽셀)은 새 코드끼리 견줄 때의 퇴행이라 real
            const parse = (r) => {
                const [, id, px, attr] = /^s(\d+):(\d+):(.*)$/.exec(r)
                return { id, px: Number(px), attr }
            }
            const pa = onlyA.map(parse), pb = onlyB.map(parse)
            const corner = (x) => oracle.forestPixels[x.id]?.[1] === 0
            /** a 쪽 행 x 가 3.6 정정 짝인지(a 전체 → b 폴리곤 안) */
            const pairOk = (x) => {
                const o = oracle.forestPixels[x.id]
                const ys = pb.filter((z) => z.id === x.id)
                return !!o && pa.filter((z) => z.id === x.id).length === 1 && ys.length === 1 && ys[0].attr === x.attr && x.px === o[0] && ys[0].px === o[1]
            }
            const ok =
                pa.every((x) => (corner(x) && !pb.some((y) => y.id === x.id)) || pairOk(x)) &&
                pb.every((y) => {
                    const x = pa.find((z) => z.id === y.id)
                    return !!x && pairOk(x)
                })
            out[g] = ok ? { cls: "corner-2", rows: [onlyA.length, onlyB.length] } : { cls: "real", onlyA: onlyA.slice(0, 5), onlyB: onlyB.slice(0, 5) }
            continue
        }
        if ((g === "roadTable" || g === "waterTable") && oracle) {
            const layer = g === "roadTable" ? "roads" : "water"
            const { onlyA, onlyB } = multisetDiff(a.rows[g], b.rows[g])
            const bbox = new Set(oracle.bboxOnly[layer])
            const meshSame = MESH_OF_TABLE[g].every((m) => a.unordered[m] === b.unordered[m])
            const ok = meshSame && [...onlyA, ...onlyB].every((r) => {
                const [key, built] = r.split(":")
                return built === "nb" && bbox.has(key)
            })
            out[g] = ok ? { cls: "bbox-rows", rows: [onlyA.length, onlyB.length], ids: [...onlyA, ...onlyB].slice(0, 8) } : { cls: "real", onlyA: onlyA.slice(0, 5), onlyB: onlyB.slice(0, 5), meshSame }
            continue
        }
        out[g] = { cls: "real", fields: fields.slice(0, 5) }
    }
    // 통계는 같은 레이어 표의 허용 차이에서 따라온 것이면 derived
    for (const [g, tbl] of [["roadStats", "roadTable"], ["waterStats", "waterTable"], ["forestSkipped", "forestTable"], ["built", "buildingTable"]]) {
        if (out[g]?.cls === "real" && ["bbox-rows", "corner-2"].includes(out[tbl]?.cls)) out[g] = { ...out[g], cls: "derived" }
    }
    return out
}

/**
 * 두 golden 을 비교한다. 실패(종료 코드 1): real·빠진 기록, 그리고 allow 에 없는 bbox-rows(계획서 허용 목록에 없는 차이라 결정 by @nanangqq 전에는 실패로 둔다).
 * same·order·outside-1·corner-2·derived(허용 차이에서 따라온 통계)는 통과
 */
async function compareGoldens(pa, pb, allow = [], common = false, freshPath = null) {
    const A = await loadGolden(pa), B = await loadGolden(pb)
    // --fresh(허용 6, 2026-10-23 수락 by @nanangqq): 순서 의존을 없애 a(순서대로 만든 기준)와 달라졌지만 b(새 코드)가 fresh 기준(같은 기준 코드를 도엽마다
    // 새 워커로)과 같은 묶음은 fresh-6. 방향이 있다: b 가 fresh 와 같아야 하고, a 쪽이 fresh 와 같고 b 가 다르면 real 그대로
    // b 가 fresh 기준과 같은 코드(meta.commit 같음, 둘 다 없음 포함)면 쓰지 않는다: 반대 방향(b 가 기준 코드)에서 무엇이든 fresh 와 같아 보이는 것을 막는다
    let F = freshPath ? await loadGolden(freshPath) : null
    if (F && B.meta.commit === F.meta.commit) {
        console.log(`--fresh 무시: b(${B.meta.commit})가 fresh 기준과 같은 코드`)
        F = null
    }
    // common: 양쪽에 다 있는 기록만(설정 일부만 돌린 golden 과 비교할 때). 기본은 한쪽에만 있는 기록도 실패
    const keys = [...new Set([...Object.keys(A.records), ...Object.keys(B.records)])].filter((k) => !common || (A.records[k] && B.records[k])).sort()
    const result = { a: pa, b: pb, aMeta: { commit: A.meta.commit, order: A.meta.order, perturb: A.meta.perturb }, bMeta: { commit: B.meta.commit, order: B.meta.order, perturb: B.meta.perturb }, records: {}, counts: {}, byGroup: {} }
    let realCount = 0
    for (const k of keys) {
        const a = A.records[k], b = B.records[k]
        if (!a || !b) {
            result.records[k] = { missing: !a ? "a" : "b" }
            realCount++
            continue
        }
        const [, scene, tile] = k.split("|")
        const oracle = A.oracle?.[`${scene}|${tile}`] ?? B.oracle?.[`${scene}|${tile}`]
        const groups = classifyRecord(a, b, oracle)
        if (F?.records[k] && Object.values(groups).some((g) => g.cls === "real")) {
            const vsFresh = classifyRecord(F.records[k], b, oracle)
            for (const [g, v] of Object.entries(groups)) if (v.cls === "real" && vsFresh[g]?.cls === "same") groups[g] = { cls: "fresh-6", was: v }
        }
        const worst = Object.values(groups).reduce((w, g) => (RANK[g.cls] > RANK[w] ? g.cls : w), "same")
        result.counts[worst] = (result.counts[worst] ?? 0) + 1
        for (const [g, v] of Object.entries(groups)) {
            if (v.cls === "same") continue
            const slot = (result.byGroup[g] ??= {})
            slot[v.cls] = (slot[v.cls] ?? 0) + 1
        }
        if (worst !== "same") result.records[k] = { worst, groups: Object.fromEntries(Object.entries(groups).filter(([, v]) => v.cls !== "same")) }
        if (worst === "real" || (worst === "bbox-rows" && !allow.includes("bbox-rows"))) realCount++
    }
    const outDir = (await stat(pb)).isDirectory() ? pb : path.dirname(pb)
    const name = `compare-${path.basename(path.resolve(pa)).replace(/\.json$/, "")}.json`
    await writeFile(path.join(outDir, name), JSON.stringify(result, null, 1))
    console.log(`비교 ${keys.length}개 기록: ${Object.entries(result.counts).map(([c, n]) => `${c} ${n}`).join(", ")}`)
    for (const [g, v] of Object.entries(result.byGroup)) console.log(`  ${g.padEnd(14)} ${Object.entries(v).map(([c, n]) => `${c} ${n}`).join(", ")}`)
    const shown = Object.entries(result.records).filter(([, r]) => r.worst === "real" || r.missing || (r.worst === "bbox-rows" && !allow.includes("bbox-rows"))).slice(0, 8)
    for (const [k, r] of shown) console.log(`  다름 ${k}: ${JSON.stringify(r.groups ?? r).slice(0, 300)}`)
    result.allow = allow
    result.failed = realCount
    await writeFile(path.join(outDir, name), JSON.stringify(result, null, 1))
    console.log(`→ ${path.relative(ROOT, path.join(outDir, name))}. ${realCount ? `실패 ${realCount}개(real${allow.includes("bbox-rows") ? "" : "·bbox-rows"})` : "실패 없음"}`)
    return realCount ? 1 : 0
}

// ---- 시간 ----

const median = (xs) => {
    const s = xs.filter((x) => x !== null).sort((a, b) => a - b)
    if (s.length === 0) return null
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
/** 가장 가까운 순위 p95(표본 5개면 최댓값) */
const p95 = (xs) => {
    const s = xs.filter((x) => x !== null).sort((a, b) => a - b)
    return s.length ? s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] : null
}
const r1 = (v) => (v === null ? null : Math.round(v * 10) / 10)

/**
 * V4(a): 같은 도엽 세트를 runs 번. 한 번 = 차가운 통과(새 워커, 장면마다 reset, 조정자 순서) + 데운 통과(같은 워커에 reset 뒤 같은 순서:
 * 데이터 파일·인덱스 캐시는 데워진 채, 워커 캐시는 빔 = 앱에서 겹치는 범위를 다시 고를 때). 로컬 디스크 자료만(네트워크가 생기면 경고)
 */
async function runTiming(lib, bundles, args) {
    const { spec, scenes } = await loadPlan(lib)
    const configNames = args.configs ?? ["tin", "stepped"]
    const outDir = path.resolve(ROOT, args.out ?? `docs/render-checks/${today()}-golden-${args.label === "golden" ? "timing" : args.label}`)
    await mkdir(outDir, { recursive: true })
    const samples = {} // `${phase}|${config}|${scene}|${tile}` → [{wall,cpu,layers}]
    const totals = {} // `${phase}|${config}` → [run totals]
    let network = 0
    for (let run = 0; run < args.runs; run++) {
        for (const c of configNames) {
            const style = { ...STYLE_DEFAULT, ...spec.configs[c] }
            const h = new Helper({ bundle: bundles.worker })
            await h.ready
            for (const phase of ["cold", "warm"]) {
                let total = 0
                for (const scene of scenes) {
                    await h.request({ type: "reset" })
                    for (const id of scene.tiles) {
                        const r = await buildOne(h, scene, id, style)
                        if (r.msg.type !== "built") throw new Error(`도엽 ${id} 실패: ${r.msg.message}`)
                        network += r.fetches.network
                        const key = `${phase}|${c}|${scene.name}|${id}`
                        ;(samples[key] ??= []).push({ wall: r.wall, cpu: r.cpu, layers: r.layers })
                        total += r.wall
                    }
                }
                ;(totals[`${phase}|${c}`] ??= []).push(total)
                process.stdout.write(`\r회 ${run + 1}/${args.runs} ${c} ${phase} 합 ${Math.round(total)} ms        `)
            }
            await h.terminate()
        }
    }
    process.stdout.write("\n")
    if (network) console.log(`경고: 시간 재는 중 네트워크 받기 ${network}회(로컬 캐시가 비어 있었다). 다시 재세요`)
    const LAYERS = ["merge", "mode", "buildings", "roads", "water", "forest"]
    const perTile = {}
    for (const [key, xs] of Object.entries(samples)) {
        perTile[key] = {
            wall: { median: r1(median(xs.map((x) => x.wall))), p95: r1(p95(xs.map((x) => x.wall))) },
            cpu: { median: r1(median(xs.map((x) => x.cpu))), p95: r1(p95(xs.map((x) => x.cpu))) },
            layers: Object.fromEntries(LAYERS.map((l) => [l, { median: median(xs.map((x) => x.layers[l])), p95: p95(xs.map((x) => x.layers[l])) }])),
        }
    }
    const summary = {}
    for (const [pc, xs] of Object.entries(totals)) {
        const keys = Object.keys(perTile).filter((k) => k.startsWith(`${pc}|`))
        const layerSums = Object.fromEntries(LAYERS.map((l) => [l, keys.reduce((s, k) => s + (perTile[k].layers[l].median ?? 0), 0)]))
        summary[pc] = { tiles: keys.length, totalWall: { median: r1(median(xs)), p95: r1(p95(xs)), runs: xs.map(r1) }, sumOfTileMedians: { wall: r1(keys.reduce((s, k) => s + perTile[k].wall.median, 0)), cpu: r1(keys.reduce((s, k) => s + perTile[k].cpu.median, 0)) }, layerMedianSums: layerSums }
    }
    const meta = { made: new Date().toISOString(), commit: await gitHead(), workerDirty, node: process.version, runs: args.runs, configs: configNames, network, note: "cold = 새 워커(데이터 캐시 빔), warm = 같은 워커에 reset 뒤 다시(데이터 파일·인덱스 캐시 데워짐, 워커 캐시 빔). 레이어 ms 는 보조 워커 로그(정수 ms, 받기 포함). p95 는 가장 가까운 순위(5회면 최댓값)" }
    await writeFile(path.join(outDir, "timing.json"), JSON.stringify({ meta, summary, perTile }, null, 1))
    console.log(`시간 → ${path.relative(ROOT, outDir)}/timing.json`)
    for (const [pc, s] of Object.entries(summary)) console.log(`  ${pc.padEnd(14)} 도엽 ${s.tiles}, 합 중앙값 ${s.totalWall.median} ms(p95 ${s.totalWall.p95}), 레이어 중앙값 합 ${LAYERS.map((l) => `${l} ${s.layerMedianSums[l]}`).join(" · ")}`)
}

// ---- C0 ----

/**
 * C0(계획서 3.2 근거 확인): 5K 마다 가장자리·모서리 1K 16장을 (1) 자료 수준에서 "자기 5K 만" 과 "지금 방식" 으로 쓰이는 항목을 비교하고
 * (2) 실제 워커로 두 방식의 TileData 를 만들어 classifyRecord 로 비교한다. 지금 방식은 도엽마다 새 워커(그 도엽이 5K 의 첫 요청일 때 = 이웃 5K 를
 * 가장 많이 섞는 경우), 자기 5K 만은 레이어 인덱스에서 이웃 5K 를 비운 워커(5K 하나에 하나)
 */
async function runC0(lib, bundles, args) {
    const spec = JSON.parse(await readFile(TILES_FILE, "utf8"))
    const sheets = args.sheets ?? Object.keys(spec.c0.sheets)
    const outDir = path.resolve(ROOT, args.out ?? `docs/render-checks/${today()}-c0`)
    await mkdir(outDir, { recursive: true })
    const style = { ...STYLE_DEFAULT, ...spec.configs.tin }
    const tiles = []
    for (const id5k of sheets) {
        const { origin, tiles: ts, bbox } = await lib.sheetTiles(id5k)
        const plan = await lib.sceneJobs(bbox)
        const scene = { name: `c0-${id5k}`, origin: plan.origin, jobs: plan.jobs }
        if (plan.origin[0] !== origin[0] || plan.origin[1] !== origin[1]) throw new Error("원점 불일치")
        const edge = ts.filter((t) => t.place !== "inner")
        let ownHelper = null
        if (args.result) {
            ownHelper = new Helper({ bundle: bundles.worker, own5k: id5k })
            await ownHelper.ready
        }
        for (const t of edge) {
            const a = await lib.analyzeTile(t.tile, origin)
            const entry = { id5k, tile: t.tile.map_id, place: t.place, row: t.row, col: t.col, sheetsCur: a.sheetsCur, data: {}, result: null }
            for (const [layer, d] of Object.entries(a.layers)) {
                entry.data[layer] = { cur: d.cur, own: d.own, onlyCurIn: d.onlyCurIn, onlyCurBbox: d.onlyCurBbox.length, onlyOwnIn: d.onlyOwnIn, onlyOwnBbox: d.onlyOwnBbox.length, changed: d.changed, maxBboxArea: Math.round(d.maxBboxArea * 1e6) / 1e6, slivers: d.slivers, maxSliverDepth: d.maxSliverDepth, detail: Object.fromEntries(Object.entries(d.detail).filter(([k]) => !d.onlyCurBbox.includes(k) || d.slivers)) }
            }
            if (args.result) {
                const fresh = new Helper({ bundle: bundles.worker })
                await fresh.ready
                const cur = await buildOne(fresh, scene, t.tile.map_id, style)
                await fresh.terminate()
                const own = await buildOne(ownHelper, scene, t.tile.map_id, style)
                if (cur.msg.type !== "built" || own.msg.type !== "built") throw new Error(`도엽 ${t.tile.map_id} 실패`)
                const aw = await lib.analyzeTile(t.tile, origin, { wide: true })
                const oracle = { bboxOnly: Object.fromEntries(Object.entries(aw.layers).map(([k, d]) => [k, [...new Set(d.bboxOnly.map((x) => x.replace(/@.*/, "")))]])), forestPixels: aw.forestPixels }
                const groups = classifyRecord(digestTile(cur.msg.data, cur.job), digestTile(own.msg.data, own.job), oracle)
                entry.result = Object.fromEntries(Object.entries(groups).filter(([, v]) => v.cls !== "same"))
                // 메쉬가 실제로 다르면 그 삼각형의 넓이·깊이(경계 실금인지 실제 면인지)
                const md = meshDiff(cur.msg.data, own.msg.data, cur.job)
                entry.meshDiff = Object.fromEntries(Object.entries(md).filter(([, d]) => d.onlyA.n + d.onlyB.n > 0).map(([f, d]) => [f, { onlyCur: d.onlyA, onlyOwn: d.onlyB }]))
                entry.warnings = [...cur.warnings, ...own.warnings]
            }
            tiles.push(entry)
            process.stdout.write(`\rC0 ${tiles.length} ${id5k} ${t.tile.map_id}      `)
        }
        await ownHelper?.terminate()
        lib.clearDataCache()
    }
    process.stdout.write("\n")
    // 요약: 레이어마다 차이가 난 도엽 수와 항목 수
    const layers = ["buildings", "roads", "water", "forest"]
    const summary = {}
    for (const l of layers) {
        const s = { tiles: tiles.length, tilesWithCurExtra: 0, onlyCurIn: 0, onlyCurBbox: 0, onlyOwnIn: 0, onlyOwnBbox: 0, changed: 0, tilesInPoly: 0, maxBboxArea: 0, slivers: 0, maxSliverDepth: 0, meshTilesSliver: 0, meshTilesReal: 0, meshMaxDepth: 0, meshArea: 0 }
        for (const t of tiles) {
            const d = t.data[l]
            if (d.onlyCurIn.length + d.onlyCurBbox > 0) s.tilesWithCurExtra++
            if (d.onlyCurIn.length + d.onlyOwnIn.length + d.changed.length > 0) s.tilesInPoly++
            s.onlyCurIn += d.onlyCurIn.length
            s.onlyCurBbox += d.onlyCurBbox
            s.onlyOwnIn += d.onlyOwnIn.length
            s.onlyOwnBbox += d.onlyOwnBbox
            s.changed += d.changed.length
            s.maxBboxArea = Math.max(s.maxBboxArea, d.maxBboxArea)
            s.slivers += d.slivers
            s.maxSliverDepth = Math.max(s.maxSliverDepth, d.maxSliverDepth)
            const m = t.meshDiff?.[l]
            if (m) {
                const depth = Math.max(m.onlyCur.depth, m.onlyOwn.depth)
                // xy 가 같고 z 만 다른 삼각형도 깊이가 크게 나오므로 "실금" 은 깊이 1 cm 이하인 경우만
                if (depth <= 0.01) s.meshTilesSliver++
                else s.meshTilesReal++
                s.meshMaxDepth = Math.max(s.meshMaxDepth, depth)
                s.meshArea += m.onlyCur.area + m.onlyOwn.area
            }
        }
        s.meshArea = Math.round(s.meshArea * 1e4) / 1e4
        summary[l] = s
    }
    const resultSummary = {}
    for (const t of tiles) {
        for (const [g, v] of Object.entries(t.result ?? {})) {
            const slot = (resultSummary[g] ??= {})
            slot[v.cls] = (slot[v.cls] ?? 0) + 1
        }
    }
    const meta = { made: new Date().toISOString(), commit: await gitHead(), workerDirty, sheets: Object.fromEntries(sheets.map((s) => [s, spec.c0.sheets[s] ?? ""])), style }
    await writeFile(path.join(outDir, "c0.json"), JSON.stringify({ meta, summary, resultSummary, tiles }, null, 1))
    console.log(`C0 도엽 ${tiles.length}장(5K ${sheets.length}개) → ${path.relative(ROOT, outDir)}/c0.json`)
    for (const l of layers) {
        const s = summary[l]
        console.log(`  ${l.padEnd(9)} 지금 방식에만(폴리곤 안 ${s.onlyCurIn}, bbox 귀퉁이 ${s.onlyCurBbox} 중 실금 ${s.slivers}·최대 깊이 ${s.maxSliverDepth.toFixed(5)} m) · 자기 5K 에만(안 ${s.onlyOwnIn}, 귀퉁이 ${s.onlyOwnBbox}) · 같은 항목 값 다름 ${s.changed} · 폴리곤 안 차이 도엽 ${s.tilesInPoly}/${s.tiles} | 메쉬 다른 도엽: 실금만 ${s.meshTilesSliver}, 실제 ${s.meshTilesReal}(최대 깊이 ${s.meshMaxDepth.toFixed(3)} m, 넓이 합 ${s.meshArea} m²)`)
    }
    for (const [g, v] of Object.entries(resultSummary)) console.log(`  결과 ${g.padEnd(14)} ${Object.entries(v).map(([c, n]) => `${c} ${n}`).join(", ")}`)
}

// 진입: 워커 스레드면 보조 워커 흉내, 아니면 명령(모든 정의 뒤에 둔다)
if (!isMainThread) {
    await workerMain(workerData)
} else {
    await main().catch((err) => {
        console.error(err)
        process.exit(2)
    })
}
