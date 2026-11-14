#!/usr/bin/env node
/**
 * 헤드리스 WebGPU 검사(2겹, docs/headless-check-plan.md H1, src/webgpu/VERIFY.md 6절). 브라우저 없이 Dawn(npm `webgpu`, Chrome 과 같은 구현)으로
 * 실제 렌더러를 돌려 장면 정의(scripts/verify-scenes.json, 브라우저 캡처와 같은 파일)의 장면을 그리고 기준과 두 겹 허용 오차로 비교한다.
 * Chrome 버전이 올라가도 기준이 무효가 되지 않고, 준비 신호·창 크기·포인터 잠금 흉내가 없다. 브라우저 1 px 확인은 3겹(render-check)이 따로 한다.
 * 테스트 프레임워크는 쓰지 않는다(fb_web/CLAUDE.md 검증 시스템의 원칙). 비교는 pixelmatch, PNG 는 pngjs(루트 node_modules).
 *
 * 흐름(함수):
 * - bundle: esbuild 로 조정자·보조 워커·장면 준비(scripts/headless/sceneRun.ts)·렌더러를 node_modules/.cache/fb_web/headless/ 에 묶는다.
 *   데이터 해시 = 조정자·보조 워커·장면 준비 묶음의 내용(장면 준비 묶음은 트리 셰이킹으로 렌더러의 셰이더·파이프라인을 담지 않는다)
 * - WebWorker·webWorkerMain: 브라우저 Worker 흉내(worker_threads). 조정자가 보조 워커를 만드는 것까지 앱과 같은 메시지 규약으로 돈다
 * - installFetch: R2 자료를 tile-golden 과 같은 디스크 캐시(docs/render-checks/tile-golden-cache/)에서 내준다(없으면 받아 저장)
 * - prepareScene: 장면 하나의 렌더러 호출 기록(덤프)을 만들거나(runScene) 데이터 해시가 같으면 docs/render-checks/headless-dumps/<해시>/ 에서 읽는다
 * - renderShot: 크기마다 새 device → 렌더러(target 옵션, 오프스크린 텍스처) → 기록 되풀이 → 두 프레임 → 읽어 PNG
 * - compareShot: 기준 PNG 와 장면의 judge 임계값마다 pixelmatch(마스크 = verify-scenes.json mask, CSS px × dpr) → 같음/다름
 * - sanity: 재검증 쌍(base-walk ↔ base-walk-ao0)은 달라야 한다
 * - main: 요약 한 줄 + index.json, --refresh-baseline 이면 기준 폴더(docs/render-checks/headless-baseline/)와 manifest(커밋·webgpu·GPU·macOS·날짜).
 *   비교할 때 기준의 macOS(os, 옛 기준은 어댑터 설명에서)·어댑터 설명이 지금과 다르면 비교하지 않고 종료 코드 2(verify-select 의 headlessEnvStop)
 *
 * 설치(선택, D1): npm --prefix scripts/headless install  (webgpu 0.6.2 고정, Mac 바이너리. 루트 package.json 에는 없다)
 * 사용:
 *   node scripts/render-headless.mjs [--scenes base-walk,base-walk-ao0 | --smoke | --layers roads,water | --full(기본)]
 *        [--refresh-baseline] [--baseline <dir>] [--out <dir>] [--sizes 878x946,1024x768] [--no-cache] [--keep-dumps 2] [--quiet]
 *   --scenes   장면 id 목록. --smoke 는 smoke 장면, --layers 는 smoke + 그 레이어 장면(verify-select 와 같은 규칙)
 *   --no-cache 덤프를 쓰지 않고 장면 준비를 다시(결정론 확인용)
 *   --keep-dumps 덤프 폴더(데이터 해시당 약 1 GB, 27장면)를 지금 것 포함 몇 개 남길지. 기본 2
 * 결과: <out>/<WxH>_<파라미터 요약>.png(브라우저 캡처와 같은 이름)·index.json. 종료 코드 0 통과, 1 예상 밖 차이·실패, 2 실행 못 함(webgpu 없음 등)
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { deserialize, serialize } from "node:v8"
import { isMainThread, parentPort, Worker as NodeWorker, workerData } from "node:worker_threads"
import { headlessEnvStop, osVersion } from "./verify-select.mjs"

const SELF_FILE = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(SELF_FILE), "..")
const HEADLESS_DIR = path.join(ROOT, "scripts/headless")
const WEBGPU_ENTRY = path.join(HEADLESS_DIR, "node_modules/webgpu/index.js")
const BUNDLE_DIR = path.join(ROOT, "node_modules/.cache/fb_web/headless")
const CACHE_DIR = path.join(ROOT, "docs/render-checks/tile-golden-cache")
const DUMPS_DIR = path.join(ROOT, "docs/render-checks/headless-dumps")
const R2 = "https://layers.asrbbt.world/"
/** render-check 의 기본 deviceScaleFactor(캔버스 픽셀 = 창 CSS px × 2). 브라우저 캡처와 같은 픽셀 크기로 그린다 */
const DPR = 2
/** esbuild 출력 이름 ↔ 앱이 new Worker 에 주는 주소(dist 의 파일 이름) */
const WORKER_URLS = { "terrainTiles.worker.js": "coordinator.mjs", "terrainTileBuild.worker.js": "helper.mjs" }

// ---- 자료: R2 디스크 캐시(tile-golden 과 같은 폴더) ----

const installFetch = () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = async (input) => {
        const url = typeof input === "string" ? input : input.url
        if (!url.startsWith(R2)) throw new Error(`render-headless: R2 밖 주소는 받지 않음 ${url}`)
        const rel = url.slice(R2.length)
        if (rel.includes("..") || rel.includes("?") || rel.includes("#")) throw new Error(`render-headless: 허용하지 않는 경로 ${url}`)
        const file = path.join(CACHE_DIR, "layers.asrbbt.world", rel)
        if (existsSync(file)) return new Response(readFileSync(file), { status: 200 })
        if (existsSync(`${file}.status`)) return new Response(null, { status: Number(readFileSync(`${file}.status`, "utf8")) })
        const res = await realFetch(url)
        mkdirSync(path.dirname(file), { recursive: true })
        if (!res.ok) {
            writeFileSync(`${file}.status`, String(res.status))
            return new Response(null, { status: res.status })
        }
        const bytes = Buffer.from(await res.arrayBuffer())
        writeFileSync(file, bytes)
        return new Response(bytes, { status: 200 })
    }
}

// ---- 브라우저 Worker 흉내 ----

const transferOf = (t) => (Array.isArray(t) ? t : (t?.transfer ?? []))
/** 앱 코드의 new Worker(url) → worker_threads. onmessage({data}) · onerror · postMessage(msg, transfer) · terminate */
const makeWorkerClass = (bundleDir) =>
    class WebWorker {
        constructor(url) {
            const out = WORKER_URLS[String(url).split("/").pop()]
            if (!out) throw new Error(`render-headless: 모르는 Worker 주소 ${url}`)
            this.onmessage = null
            this.onerror = null
            this.worker = new NodeWorker(SELF_FILE, { workerData: { role: "web-worker", file: path.join(bundleDir, out), bundleDir, verbose: !!process.env.HEADLESS_VERBOSE } })
            this.worker.on("message", (data) => this.onmessage?.({ data }))
            this.worker.on("error", (e) => (this.onerror ? this.onerror({ message: e.message, error: e }) : console.error(e)))
        }
        postMessage(msg, transfer) {
            this.worker.postMessage(msg, transferOf(transfer))
        }
        terminate() {
            this.worker.terminate()
        }
    }

/** 워커 스레드: fetch·self·Worker 흉내를 깔고 묶음을 import 한 뒤 메시지를 그 onmessage 로 넘긴다(import 전 메시지는 포트에 쌓여 있다) */
const webWorkerMain = async ({ file, bundleDir, verbose }) => {
    installFetch()
    if (!verbose) for (const k of ["log", "info", "debug"]) console[k] = () => {}
    globalThis.Worker = makeWorkerClass(bundleDir)
    globalThis.self = { onmessage: null, postMessage: (msg, transfer) => parentPort.postMessage(msg, transferOf(transfer)) }
    await import(pathToFileURL(file).href)
    parentPort.on("message", (data) => globalThis.self.onmessage?.({ data }))
}

// ---- 묶기 ----

const sha = (s) => createHash("sha1").update(s).digest("hex")

async function bundle() {
    const { build } = await import("esbuild")
    mkdirSync(BUNDLE_DIR, { recursive: true })
    const r = await build({
        entryPoints: {
            coordinator: path.join(ROOT, "src/terrainTiles.worker.ts"),
            helper: path.join(ROOT, "src/terrainTileBuild.worker.ts"),
            scene: path.join(HEADLESS_DIR, "sceneRun.ts"),
            render: path.join(ROOT, "src/webgpu/terrainRenderer.ts"),
        },
        bundle: true,
        platform: "node",
        format: "esm",
        outdir: BUNDLE_DIR,
        outExtension: { ".js": ".mjs" },
        logLevel: "warning",
        metafile: true,
    })
    const file = (n) => path.join(BUNDLE_DIR, `${n}.mjs`)
    const dataHash = sha(["coordinator", "helper", "scene"].map((n) => readFileSync(file(n), "utf8")).join("\n")).slice(0, 12)
    const inputsOf = (n) => Object.keys(Object.entries(r.metafile.outputs).find(([f]) => f.endsWith(`${n}.mjs`))[1].inputs).filter((f) => !f.includes("node_modules"))
    return { dir: BUNDLE_DIR, file, dataHash, sceneInputs: inputsOf("scene").length, renderInputs: inputsOf("render").length }
}

// ---- 장면 ----

const SCENES = JSON.parse(readFileSync(path.join(ROOT, "scripts/verify-scenes.json"), "utf8"))
const expand = (params) => params.replace(/\$([A-Z]+)/g, (_, k) => SCENES.bboxes[k] ?? (() => { throw new Error(`verify-scenes.json: 모르는 bbox ${k}`) })())
/** render-check paramsSlug · verify-select shotName 과 같은 규칙(브라우저 캡처와 같은 PNG 이름) */
const shotName = (size, params) => {
    const parts = []
    for (const [key, value] of new URLSearchParams(params)) {
        if (key === "bbox") parts.push(`bbox-${createHash("sha1").update(value).digest("hex").slice(0, 6)}`)
        else parts.push(`${key}-${value.replace(/[^0-9a-zA-Z.-]+/g, "_")}`)
    }
    return `${size}_${parts.join("_") || "default"}`
}
const parseSize = (s) => {
    const m = /^(\d+)x(\d+)$/.exec(s)
    if (!m) throw new Error(`크기 형식 오류 ${s}`)
    return { label: s, css: [Number(m[1]), Number(m[2])], px: [Number(m[1]) * DPR, Number(m[2]) * DPR] }
}

const parseArgs = (argv) => {
    const a = { scenes: null, smoke: false, layers: null, refresh: false, baseline: "docs/render-checks/headless-baseline", out: null, sizes: SCENES.sizes, cache: true, keepDumps: 2, quiet: false }
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i]
        const take = () => {
            const v = argv[++i]
            if (v === undefined) throw new Error(`${k} 에 값이 없습니다`)
            return v
        }
        switch (k) {
            case "--scenes": a.scenes = take().split(",").map((s) => s.trim()).filter(Boolean); break
            case "--smoke": a.smoke = true; break
            case "--layers": a.layers = take().split(",").map((s) => s.trim()).filter(Boolean); break
            case "--full": break
            case "--refresh-baseline": a.refresh = true; break
            case "--baseline": a.baseline = take(); break
            case "--out": a.out = take(); break
            case "--sizes": a.sizes = take().split(","); break
            case "--no-cache": a.cache = false; break
            case "--keep-dumps": a.keepDumps = Number(take()); break
            case "--quiet": a.quiet = true; break
            case "--help": case "-h": console.log(readFileSync(SELF_FILE, "utf8").split("*/")[0]); process.exit(0)
            default: throw new Error(`모르는 옵션 ${k}`)
        }
    }
    return a
}

const selectScenes = (a) => {
    if (a.refresh && !a.scenes) return SCENES.scenes
    if (a.scenes) {
        const unknown = a.scenes.filter((id) => !SCENES.scenes.some((s) => s.id === id))
        if (unknown.length) throw new Error(`모르는 장면 ${unknown.join(", ")}`)
        return SCENES.scenes.filter((s) => a.scenes.includes(s.id))
    }
    if (a.smoke || a.layers) return SCENES.scenes.filter((s) => s.smoke || (a.layers && s.layers.some((l) => a.layers.includes(l))))
    return SCENES.scenes
}

/** 장면 하나의 렌더러 호출 기록. 데이터 해시가 같은 덤프가 있으면 읽고, 없으면 장면 준비를 돌려 저장한다 */
const prepareScene = async (lib, b, scene, a) => {
    const query = expand(scene.params)
    const file = path.join(DUMPS_DIR, b.dataHash, `${scene.id}.v8`)
    if (a.cache && existsSync(file)) {
        const d = deserialize(readFileSync(file))
        if (d.query === query) return { ...d, cached: true, ms: 0 }
    }
    const t = performance.now()
    const realLog = console.log
    console.log = () => {}
    let run
    try {
        run = await lib.runScene(query, { log: a.quiet ? undefined : (s) => process.stdout.write(`  ${s}\n`) })
    } finally {
        console.log = realLog
    }
    const ms = Math.round(performance.now() - t)
    const dump = { query, dataHash: b.dataHash, createdAt: new Date().toISOString(), ...run }
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, serialize(dump))
    return { ...dump, cached: false, ms }
}

/** 오래된 데이터 해시 폴더를 지운다(최근 keep 개만, 지금 것은 남김) */
const pruneDumps = (current, keep) => {
    if (!existsSync(DUMPS_DIR)) return
    const dirs = readdirSync(DUMPS_DIR).filter((d) => d !== current).map((d) => ({ d, t: statSync(path.join(DUMPS_DIR, d)).mtimeMs })).sort((x, y) => y.t - x.t)
    for (const { d } of dirs.slice(Math.max(0, keep - 1))) rmSync(path.join(DUMPS_DIR, d), { recursive: true, force: true })
}

// ---- 그리기 ----

/** 텍스처 → RGBA(bgra 면 바꿔 담는다) */
const readTexture = async (device, tex, w, h, format) => {
    const bpr = Math.ceil((w * 4) / 256) * 256
    const buf = device.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    const enc = device.createCommandEncoder()
    enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [w, h])
    device.queue.submit([enc.finish()])
    await buf.mapAsync(GPUMapMode.READ)
    const src = new Uint8Array(buf.getMappedRange())
    const out = Buffer.alloc(w * h * 4)
    const bgra = format.startsWith("bgra")
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const s = y * bpr + x * 4
            const d = (y * w + x) * 4
            out[d] = src[s + (bgra ? 2 : 0)]
            out[d + 1] = src[s + 1]
            out[d + 2] = src[s + (bgra ? 0 : 2)]
            out[d + 3] = src[s + 3]
        }
    }
    buf.unmap()
    buf.destroy()
    return out
}

/**
 * 크기 하나를 그린다: 새 device(앱의 initWebGPU 처럼 기본 한도·features 없음) → 오프스크린 텍스처(COPY_SRC) → 렌더러(target) → 기록 되풀이 →
 * 두 프레임(앱은 계속 그린다. 두 번째를 읽는다) → PNG 바이트
 */
const renderShot = async (gpu, R, dump, size) => {
    const adapter = await gpu.requestAdapter()
    const device = await adapter.requestDevice()
    const errors = []
    device.onuncapturederror = (e) => errors.push(String(e.error?.message ?? e.error))
    const format = gpu.getPreferredCanvasFormat()
    const [w, h] = size.px
    const tex = device.createTexture({ size: [w, h], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
    const t = performance.now()
    device.pushErrorScope("validation")
    const r = await R.createTerrainRenderFunctionAndUpdateFunctions({ target: { device, format, getTexture: () => tex }, width: w, height: h, ...dump.create })
    for (const [name, args] of dump.calls) r.updaters[name](...args)
    r.render()
    r.render()
    await device.queue.onSubmittedWorkDone()
    const err = await device.popErrorScope()
    if (err) errors.push(err.message)
    const rgba = await readTexture(device, tex, w, h, format)
    const ms = Math.round(performance.now() - t)
    tex.destroy()
    r.destroy()
    return { rgba, w, h, ms, errors }
}

// ---- 비교 ----

let PNG, pixelmatch
const loadImageLibs = async () => {
    PNG = (await import("pngjs")).PNG
    pixelmatch = (await import("pixelmatch")).default
}
const writePng = (file, rgba, w, h) => {
    const png = new PNG({ width: w, height: h })
    rgba.copy(png.data)
    writeFileSync(file, PNG.sync.write(png))
}
/** verify-scenes.json mask("x,y,w,h" CSS px, 왼쪽 위 기준) → 칠한 사본과 칠한 픽셀 수 */
const masked = (png) => {
    const data = Buffer.from(png.data)
    const cover = new Uint8Array(png.width * png.height)
    for (const m of SCENES.mask) {
        const [x, y, mw, mh] = m.split(",").map(Number)
        for (let yy = y * DPR; yy < Math.min(png.height, (y + mh) * DPR); yy++)
            for (let xx = x * DPR; xx < Math.min(png.width, (x + mw) * DPR); xx++) {
                const i = yy * png.width + xx
                cover[i] = 1
                data.writeUInt32BE(0xff00ffff, i * 4)
            }
    }
    let n = 0
    for (const c of cover) n += c
    return { data, maskedPx: n }
}
/** 두 PNG(파일 또는 객체)를 임계값마다 비교. @returns { [t]: { px, ratio, same } } */
const compareImages = (a, b, thresholds, diffFile) => {
    if (a.width !== b.width || a.height !== b.height) return { sizeMismatch: true }
    const ma = masked(a)
    const mb = masked(b)
    const compared = a.width * a.height - ma.maskedPx
    const out = {}
    for (const t of [...thresholds].sort((x, y) => y - x)) {
        const diff = diffFile ? new PNG({ width: a.width, height: a.height }) : null
        const px = pixelmatch(ma.data, mb.data, diff?.data ?? null, a.width, a.height, { threshold: t, includeAA: false })
        out[t] = { px, ratio: px / compared, same: px / compared <= SCENES.maxDiffRatio }
        if (diff && t === 0.1 && px > 0) writeFileSync(diffFile, PNG.sync.write(diff))
    }
    return out
}

// ---- 진입 ----

const git = (...args) => {
    try {
        return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim()
    } catch {
        return ""
    }
}
const defaultOut = () => {
    const base = path.join("docs/render-checks", `${new Date().toLocaleDateString("sv-SE")}-headless`)
    let out = base
    for (let n = 2; existsSync(path.join(ROOT, out)); n++) out = `${base}-${n}`
    return out
}

async function main() {
    const a = parseArgs(process.argv.slice(2))
    if (!existsSync(WEBGPU_ENTRY)) {
        console.error(`webgpu(Dawn) 가 설치되어 있지 않습니다. 설치: npm --prefix scripts/headless install  (약 130 MB, webgpu 0.6.2 고정. docs/headless-check-plan.md D1)\n브라우저 캡처는 npm run verify -- --browser`)
        return 2
    }
    const scenes = selectScenes(a)
    const sizes = a.sizes.map(parseSize)
    const baselineDir = path.resolve(ROOT, a.baseline)
    const manifestFile = path.join(baselineDir, "manifest.json")
    if (!a.refresh && !existsSync(manifestFile)) {
        console.error(`헤드리스 기준이 없습니다(${a.baseline}/manifest.json). node scripts/render-headless.mjs --refresh-baseline 으로 먼저 찍으세요`)
        return 2
    }
    // 기준 환경: macOS(Metal 드라이버)·어댑터가 기준과 다르면 비교하지 않고 멈춘다(VERIFY.md 7절, headless-check-plan 9.2). OS 는 여기서, 어댑터는 Dawn 을 띄운 뒤
    const os = osVersion()
    const baseline = a.refresh ? null : JSON.parse(readFileSync(manifestFile, "utf8"))
    const osStop = baseline && headlessEnvStop(baseline, os)
    if (osStop) {
        console.error(`실행하지 못함: ${osStop}`)
        return 2
    }
    const outRel = a.refresh ? a.baseline : (a.out ?? defaultOut())
    const outDir = path.resolve(ROOT, outRel)
    if (a.refresh && existsSync(baselineDir)) {
        const old = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, "utf8")) : null
        let dest = `${baselineDir}-${old?.commit ?? "old"}`
        for (let n = 2; existsSync(dest); n++) dest = `${baselineDir}-${old?.commit ?? "old"}-${n}`
        renameSync(baselineDir, dest)
        console.log(`이전 헤드리스 기준을 ${path.relative(ROOT, dest)} 로 옮겼습니다(필요 없으면 지워도 됨)`)
    }
    mkdirSync(outDir, { recursive: true })
    const started = performance.now()
    const b = await bundle()
    installFetch()
    globalThis.Worker = makeWorkerClass(b.dir)
    globalThis.location ??= { origin: "headless", pathname: "/" }
    const lib = await import(pathToFileURL(b.file("scene")).href)
    const { create, globals } = await import(pathToFileURL(WEBGPU_ENTRY).href)
    Object.assign(globalThis, globals)
    const gpu = create([])
    const R = await import(pathToFileURL(b.file("render")).href)
    await loadImageLibs()
    const probe = await gpu.requestAdapter()
    const info = probe.info ?? {}
    const adapter = { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description }
    const webgpuVersion = JSON.parse(readFileSync(path.join(HEADLESS_DIR, "node_modules/webgpu/package.json"), "utf8")).version
    const adapterStop = baseline && headlessEnvStop(baseline, os, adapter)
    if (adapterStop) {
        console.error(`실행하지 못함: ${adapterStop}`)
        return 2
    }
    if (baseline && baseline.webgpu !== webgpuVersion) console.log(`주의: 기준의 webgpu ${baseline.webgpu} ≠ 지금 ${webgpuVersion}. 차이가 나면 기준을 다시 찍으세요(--refresh-baseline)`)
    console.log(`헤드리스 2겹: Dawn webgpu ${webgpuVersion} · ${adapter.description ?? adapter.vendor} · 장면 ${scenes.length} × 크기 ${sizes.length} · 데이터 해시 ${b.dataHash} → ${outRel}`)

    const results = []
    const failures = []
    let dataMs = 0
    let renderMs = 0
    let cachedCount = 0
    for (const scene of scenes) {
        let dump
        try {
            dump = await prepareScene(lib, b, scene, a)
        } catch (err) {
            failures.push(`${scene.id}: 장면 준비 실패 ${err.message}`)
            for (const s of sizes) results.push({ scene: scene.id, size: s.label, error: `장면 준비 실패 ${err.message}` })
            console.log(`${scene.id}: 장면 준비 실패 — ${err.message}`)
            continue
        }
        dataMs += dump.ms
        if (dump.cached) cachedCount++
        for (const size of sizes) {
            const name = shotName(size.label, expand(scene.params))
            const entry = { scene: scene.id, size: size.label, name, file: `${name}.png`, px: size.px, dataMs: dump.ms, cached: dump.cached, info: dump.info }
            try {
                const shot = await renderShot(gpu, R, dump, size)
                renderMs += shot.ms
                entry.renderMs = shot.ms
                entry.errors = shot.errors
                writePng(path.join(outDir, entry.file), shot.rgba, shot.w, shot.h)
                if (shot.errors.length) failures.push(`${scene.id} ${size.label}: WebGPU 오류 ${shot.errors[0]}`)
                if (baseline) {
                    const baseFile = path.join(baselineDir, entry.file)
                    if (!existsSync(baseFile)) {
                        entry.verdict = "기준 없음"
                        failures.push(`${scene.id} ${size.label}: 기준에 짝이 없음(장면을 바꿨으면 --refresh-baseline)`)
                    } else {
                        mkdirSync(path.join(outDir, "diff"), { recursive: true })
                        const cmp = compareImages(PNG.sync.read(readFileSync(baseFile)), PNG.sync.read(readFileSync(path.join(outDir, entry.file))), [...new Set([...scene.judge, 0.1])], path.join(outDir, "diff", entry.file))
                        entry.compare = cmp
                        const bad = scene.judge.filter((t) => !cmp[t]?.same)
                        entry.verdict = cmp.sizeMismatch ? "크기 다름" : bad.length ? "다름" : "같음"
                        if (entry.verdict !== "같음") failures.push(`${scene.id} ${size.label}: ${bad.map((t) => `t${t} ${(cmp[t].ratio * 100).toFixed(4)} %`).join(", ") || entry.verdict} → ${path.join(outRel, "diff", entry.file)}`)
                    }
                }
                if (!a.quiet) {
                    const c = entry.compare ? scene.judge.map((t) => `t${t} ${entry.compare[t].px} px`).join(" ") : ""
                    console.log(`${scene.id.padEnd(22)} ${size.label.padEnd(9)} 데이터 ${dump.cached ? "덤프" : `${dump.ms} ms`} · 그리기 ${shot.ms} ms · 도엽 ${dump.info.tiles}(밖 ${dump.info.extra})${c ? ` · ${c} → ${entry.verdict}` : ""}`)
                }
            } catch (err) {
                entry.error = String(err?.stack ?? err)
                failures.push(`${scene.id} ${size.label}: 그리기 실패 ${err.message}`)
                console.log(`${scene.id} ${size.label}: 그리기 실패 — ${err.message}`)
            }
            results.push(entry)
        }
    }

    // 재검증: 같은 실행 안에서 기본 ↔ ao=0 은 달라야 한다(비교가 무뎌지지 않았는지)
    const sanity = []
    for (const off of scenes.filter((s) => new URLSearchParams(expand(s.params)).get("ao") === "0")) {
        const q = new URLSearchParams(expand(off.params))
        q.delete("ao")
        const on = scenes.find((s) => new URLSearchParams(expand(s.params)).toString() === q.toString())
        if (!on) continue
        for (const size of sizes) {
            const fa = path.join(outDir, `${shotName(size.label, expand(on.params))}.png`)
            const fb = path.join(outDir, `${shotName(size.label, expand(off.params))}.png`)
            if (!existsSync(fa) || !existsSync(fb)) continue
            const cmp = compareImages(PNG.sync.read(readFileSync(fa)), PNG.sync.read(readFileSync(fb)), on.judge)
            const different = on.judge.every((t) => !cmp[t].same)
            sanity.push({ on: on.id, off: off.id, size: size.label, ratios: Object.fromEntries(on.judge.map((t) => [t, cmp[t].ratio])), different })
            if (!different) failures.push(`재검증 ${on.id} ↔ ${off.id} ${size.label}: 같음 — 비교가 무뎌졌는지 확인(VERIFY.md 7절 6)`)
        }
    }

    const seconds = Math.round((performance.now() - started) / 100) / 10
    const commit = git("rev-parse", "--short", "HEAD")
    const dirty = git("status", "--porcelain", "--", "src", "scripts/headless", "scripts/render-headless.mjs") ? "+dirty" : ""
    const index = { createdAt: new Date().toISOString(), commit: commit + dirty, webgpu: webgpuVersion, adapter, os, node: process.version, dpr: DPR, sizes: a.sizes, dataHash: b.dataHash, seconds, dataMs, renderMs, results, sanity, failures }
    writeFileSync(path.join(outDir, "index.json"), JSON.stringify(index, null, 1))
    if (a.refresh) {
        const manifest = {
            kind: "headless-baseline",
            commit: commit + dirty,
            subject: git("log", "-1", "--format=%s"),
            createdAt: index.createdAt,
            webgpu: webgpuVersion,
            adapter,
            os,
            node: process.version,
            dpr: DPR,
            sizes: a.sizes,
            scenes: scenes.map((s) => s.id),
            scenesHash: sha(readFileSync(path.join(ROOT, "scripts/verify-scenes.json"))).slice(0, 12),
            shots: results.filter((r) => !r.error).length,
            complete: failures.length === 0 && scenes.length === SCENES.scenes.length,
            failures,
            policy: "화면·워커 출력이 바뀐 커밋 뒤, 또는 webgpu 버전·기계·macOS(Metal 드라이버)가 바뀌면 HEAD 에서 다시 찍는다(어댑터·OS 가 다르면 실행이 멈춘다, VERIFY.md 6절). Chrome 업데이트와 무관. 기계마다 따로(git 제외)",
        }
        writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
    }
    pruneDumps(b.dataHash, a.keepDumps)
    const judged = results.filter((r) => r.verdict)
    const same = judged.filter((r) => r.verdict === "같음").length
    const sanityText = sanity.length ? `, 재검증 ${sanity.map((s) => `${s.size} ${(Math.min(...Object.values(s.ratios)) * 100).toFixed(2)} %`).join("·")}` : ""
    const verdictText = a.refresh ? `기준 ${results.filter((r) => !r.error).length}장 저장` : `같음 ${same}/${results.length}`
    console.log(`\n헤드리스 요약: ${verdictText}${failures.length ? `, 문제 ${failures.length}` : ""}${sanityText} · 데이터 ${(dataMs / 1000).toFixed(1)} s(덤프 재사용 ${cachedCount}/${scenes.length}) + 그리기 ${(renderMs / 1000).toFixed(1)} s · 전체 ${seconds} s → ${outRel}/index.json`)
    if (failures.length) console.log(`  ${failures.join("\n  ")}`)
    return failures.length ? 1 : 0
}

if (!isMainThread && workerData?.role === "web-worker") {
    await webWorkerMain(workerData)
} else if (isMainThread) {
    const code = await main().catch((err) => {
        console.error(err)
        return 2
    })
    process.exit(code)
}
