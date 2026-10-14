#!/usr/bin/env node
/**
 * 렌더 확인 자동 캡처와 비교(docs/design-code-plan.md 7절 K·K2, src/webgpu/VERIFY.md 3.5·6·7절).
 *
 * 캡처: Playwright 로 설치된 Chrome(없으면 받아 둔 Chromium)을 **보이는 창**으로 띄워(헤드리스는 WebGPU 가 꺼지거나 소프트웨어로
 * 떨어질 수 있다) 디버그 페이지 `#/debug/walk?…` 를 창 크기 × 파라미터 조합마다 열고, 둘러보기에 들어가 **주변 도엽 스트리밍이
 * 멈춘 뒤**(준비 신호: 디버그 페이지의 data-walk-tiles 가 stable ms 동안 변하지 않음) 원본 해상도 PNG(dpr 2)와 지표를 저장한다.
 * 지표(JSON)는 선택 영역의 이웃 행·열 밝기 차(평균·최대·위치·주기)로, SSAO 줄무늬처럼 눈으로 보기 어려운 띠를 숫자로 비교하기 위한 것.
 *
 * 비교(--compare): 두 캡처 폴더의 같은 이름 PNG 를 짝지어 pixelmatch 로 다른 픽셀 비율과 diff PNG 를 낸다. 변하는 UI(HUD·표·미니맵·
 * 상태 표시줄·조준점)는 마스크로 칠해 비교에서 뺀다. 두 폴더의 브라우저·dpr·크기가 다르면 비교하지 않는다(기준 환경 하나).
 * 같은 폴더 안에서 "달라야 하는 쌍"(ao=0 ↔ 같은 파라미터의 기본)도 재어 비교가 무뎌지지 않았는지 보인다(재검증).
 * 통과/실패 판정은 하지 않는다(판단은 사람). 허용치는 출력에 같이 적는다.
 *
 * 서버는 사용자가 띄운다(npm run build 뒤 npx serve dist, 3000 포트). 포인터 잠금은 자동화에서 못 쓰므로 lock=0 이 없으면 붙인다.
 *
 * 사용:
 *   node scripts/render-check.mjs --params "bbox=14135700,4513980,14136500,4514780&yaw=90&pitch=-15" \
 *     [--params "…&aodebug=1"] [--sizes 878x946,1024x768] [--heights 940-950] [--base http://localhost:3000] \
 *     [--out docs/render-checks/<오늘>] [--stable 2000] [--settle 1000] [--region 0,0.45,1,0.5] [--dpr 2] [--timeout 120000] [--browser chrome|chromium]
 *   node scripts/render-check.mjs --compare <beforeDir> <afterDir> [--threshold 0.1] [--max-diff-ratio 0.001] [--mask x,y,w,h …] [--no-default-masks]
 *   --params   해시 쿼리(여러 번 줄 수 있다. 조합마다 한 장). bbox 가 없으면 둘러보기에 못 들어간다
 *   --sizes    창 크기 목록(CSS px). 기본 878x946
 *   --heights  너비는 sizes 의 첫 값, 높이를 a-b 로 훑는다(크기 의존 증상용). sizes 에 더해진다
 *   --stable   도엽 수가 이만큼(ms) 변하지 않으면 준비된 것으로 본다. 기본 2000
 *   --settle   준비 뒤 더 기다리는 ms(그림자·AO 가 마지막 도엽을 그릴 시간). 기본 1000
 *   --region   지표를 잴 영역(비율 x,y,w,h). 기본 아래쪽 절반 가까이(HUD·파라미터 표를 피함)
 *   --dpr      deviceScaleFactor(기본 2 = 레티나. 캔버스는 dpr 배 해상도)
 *   --browser  chrome(기본. 설치된 Chrome, 실패하면 chromium 으로) 또는 chromium(받아 둔 Chromium 만)
 *   --threshold        pixelmatch 픽셀당 색 차 임계값(0 ~ 1). 기본 0.1. 안티앨리어싱 픽셀은 세지 않는다
 *   --max-diff-ratio   "같다" 고 볼 다른 픽셀 비율 상한. 기본 0.001(0.1 %)
 *   --mask             비교에서 뺄 영역(CSS px "x,y,w,h". x·y 는 숫자·음수(오른쪽·아래에서)·c(가운데), w·h 는 숫자·full. 여러 번).
 *                      기본 마스크(HUD·표·미니맵·조절 패널·상태 표시줄·가운데 안내)에 더한다
 * 결과: <out>/<WxH>_<파라미터 요약>.png 와 <out>/index.json. 비교는 <afterDir>/compare.json 과 <afterDir>/diff/*.png.
 * PNG 는 git 에 넣지 않는다(.gitignore)
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { chromium } from "playwright"
import pixelmatch from "pixelmatch"
import { PNG } from "pngjs"

/**
 * 비교에서 빼는 기본 영역. 둘러보기 화면의 변하는 UI: HUD(위 가운데), 파라미터 표(왼쪽 위), 미니맵·조절 패널(오른쪽),
 * 상태 표시줄(아래), 조준점·안내 알약(가운데). 레이아웃이 바뀌면 여기를 고친다.
 * 단위는 **CSS px**(UI 가 창 비율이 아니라 고정 px 로 놓이므로. 캡처 픽셀은 × dpr): [x, y, w, h] 에서 x·y 는 숫자(왼쪽·위에서),
 * 음수(오른쪽·아래에서 안쪽으로), "c"(가운데 맞춤) 중 하나. w 가 Infinity 면 끝까지
 */
const DEFAULT_MASKS = [
    ["c", 0, 560, 60],
    [0, 0, 400, 140],
    [-300, 0, 300, 470],
    [0, -44, Infinity, 44],
    ["c", "c", 560, 160],
]
/** --mask 의 문자열 "x,y,w,h" 를 마스크로. x·y 는 숫자·음수·c, w·h 는 숫자 또는 full */
const parseMask = (text) => {
    const parts = text.split(",").map((v) => v.trim())
    if (parts.length !== 4) throw new Error(`마스크 형식 오류 ${text}(예: -340,0,340,480 또는 c,0,700,64)`)
    const pos = (v) => (v === "c" ? "c" : Number(v))
    const len = (v) => (v === "full" ? Infinity : Number(v))
    return [pos(parts[0]), pos(parts[1]), len(parts[2]), len(parts[3])]
}
/**
 * 마스크 하나를 이미지 픽셀 사각형으로. 반환 [x0, y0, x1, y1](범위 안으로 자름)
 *
 * @param mask [x, y, w, h] CSS px
 * @param width 이미지 픽셀 너비
 * @param height 이미지 픽셀 높이
 * @param dpr 캡처의 deviceScaleFactor
 */
const maskRect = ([x, y, w, h], width, height, dpr) => {
    const pw = Math.min(width, Math.round(w * dpr))
    const ph = Math.min(height, Math.round(h * dpr))
    const x0 = x === "c" ? Math.round((width - pw) / 2) : x < 0 ? width + Math.round(x * dpr) : Math.round(x * dpr)
    const y0 = y === "c" ? Math.round((height - ph) / 2) : y < 0 ? height + Math.round(y * dpr) : Math.round(y * dpr)
    return [Math.max(0, x0), Math.max(0, y0), Math.min(width, x0 + pw), Math.min(height, y0 + ph)]
}
/** 마스크를 칠하는 색(두 이미지 모두 같은 색이라 차이 0) */
const MASK_COLOR = [255, 0, 255, 255]

/** argv → 옵션. --compare 가 있으면 mode "compare" */
const parseArgs = (argv) => {
    const args = {
        mode: "capture",
        base: "http://localhost:3000",
        params: [],
        sizes: [],
        heights: null,
        out: null,
        stable: 2000,
        settle: 1000,
        region: [0, 0.45, 1, 0.5],
        dpr: 2,
        timeout: 120000,
        browser: "chrome",
        compare: null,
        threshold: 0.1,
        maxDiffRatio: 0.001,
        masks: [],
        defaultMasks: true,
    }
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i]
        const take = () => {
            const value = argv[++i]
            if (value === undefined) throw new Error(`${key} 에 값이 없습니다`)
            return value
        }
        switch (key) {
            case "--base": args.base = take().replace(/\/$/, ""); break
            case "--params": args.params.push(take()); break
            case "--sizes": args.sizes.push(...take().split(",").map(parseSize)); break
            case "--heights": args.heights = take().split("-").map(Number); break
            case "--out": args.out = take(); break
            case "--stable": args.stable = Number(take()); break
            case "--settle": args.settle = Number(take()); break
            case "--region": args.region = take().split(",").map(Number); break
            case "--dpr": args.dpr = Number(take()); break
            case "--timeout": args.timeout = Number(take()); break
            case "--browser": args.browser = take(); break
            case "--compare": args.mode = "compare"; args.compare = [take(), take()]; break
            case "--threshold": args.threshold = Number(take()); break
            case "--max-diff-ratio": args.maxDiffRatio = Number(take()); break
            case "--mask": args.masks.push(parseMask(take())); break
            case "--no-default-masks": args.defaultMasks = false; break
            case "--help": case "-h": printHelp(); process.exit(0)
            default: throw new Error(`모르는 옵션 ${key}`)
        }
    }
    if (args.mode === "compare") return args
    if (args.params.length === 0) throw new Error("--params 가 필요합니다(예: --params \"bbox=minx,miny,maxx,maxy&yaw=90\")")
    if (args.sizes.length === 0) args.sizes.push({ width: 878, height: 946 })
    if (args.heights) {
        const [a, b] = args.heights
        const width = args.sizes[0].width
        for (let h = a; h <= b; h++) if (!args.sizes.some((s) => s.width === width && s.height === h)) args.sizes.push({ width, height: h })
    }
    if (!args.out) args.out = path.join("docs", "render-checks", new Date().toISOString().slice(0, 10))
    if (args.browser !== "chrome" && args.browser !== "chromium") throw new Error(`--browser 는 chrome 또는 chromium(${args.browser})`)
    return args
}
const parseSize = (text) => {
    const m = /^(\d+)x(\d+)$/.exec(text.trim())
    if (!m) throw new Error(`크기 형식 오류 ${text}(예: 878x946)`)
    return { width: Number(m[1]), height: Number(m[2]) }
}
const printHelp = () => console.log("사용법은 파일 상단 주석 참고: node scripts/render-check.mjs --params \"bbox=…\" | --compare <before> <after>")

/** 파일 이름에 쓸 파라미터 요약: bbox 는 해시 6자리로 줄이고 나머지는 key-value 를 잇는다 */
const paramsSlug = (params) => {
    const q = new URLSearchParams(params)
    const parts = []
    for (const [key, value] of q) {
        if (key === "bbox") parts.push(`bbox-${createHash("sha1").update(value).digest("hex").slice(0, 6)}`)
        else parts.push(`${key}-${value.replace(/[^0-9a-zA-Z.-]+/g, "_")}`)
    }
    return parts.join("_") || "default"
}

/** lock=0 이 없으면 붙인다(자동화에서는 포인터 잠금을 못 쓴다) */
const withLockOff = (params) => {
    const q = new URLSearchParams(params)
    if (!q.has("lock")) q.set("lock", "0")
    return q.toString()
}

/**
 * 브라우저 안에서 PNG 를 2D 캔버스에 그려 선택 영역의 이웃 행·열 밝기 차를 잰다.
 * 반환: { image: {w,h}, region: {x,y,w,h}, rows: {mean,max,maxAt,period,periodCorr}, cols: {...} }
 * rows.mean 은 "위아래 이웃 행과의 평균 밝기 차(0 ~ 255)" 를 행마다 구해 다시 평균한 것. max 는 그 행 값 중 최대, maxAt 은 그 행 번호(영역 기준).
 * period 는 행별 값(평균 뺀 것)의 자기상관이 가장 큰 간격(2 ~ 64 px)과 그 상관(0 ~ 1). 줄무늬가 규칙적이면 상관이 높다
 */
const measureInBrowser = async ({ dataUrl, region }) => {
    const img = new Image()
    img.src = dataUrl
    await img.decode()
    const W = img.naturalWidth
    const H = img.naturalHeight
    const canvas = document.createElement("canvas")
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    ctx.drawImage(img, 0, 0)
    const [rx, ry, rw, rh] = region
    const x0 = Math.floor(rx * W)
    const y0 = Math.floor(ry * H)
    const w = Math.max(2, Math.floor(rw * W))
    const h = Math.max(2, Math.floor(rh * H))
    const data = ctx.getImageData(x0, y0, w, h).data
    const L = new Float32Array(w * h)
    for (let i = 0; i < w * h; i++) L[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]
    const rowDiff = new Float32Array(h - 1)
    for (let y = 0; y < h - 1; y++) {
        let sum = 0
        for (let x = 0; x < w; x++) sum += Math.abs(L[(y + 1) * w + x] - L[y * w + x])
        rowDiff[y] = sum / w
    }
    const colDiff = new Float32Array(w - 1)
    for (let x = 0; x < w - 1; x++) {
        let sum = 0
        for (let y = 0; y < h; y++) sum += Math.abs(L[y * w + x + 1] - L[y * w + x])
        colDiff[x] = sum / h
    }
    const stats = (arr) => {
        const n = arr.length
        let mean = 0
        let max = -1
        let maxAt = 0
        for (let i = 0; i < n; i++) {
            mean += arr[i]
            if (arr[i] > max) {
                max = arr[i]
                maxAt = i
            }
        }
        mean /= n
        let variance = 0
        for (let i = 0; i < n; i++) variance += (arr[i] - mean) ** 2
        let period = 0
        let periodCorr = 0
        if (variance > 1e-9) {
            for (let lag = 2; lag <= Math.min(64, Math.floor(n / 2)); lag++) {
                let c = 0
                for (let i = 0; i + lag < n; i++) c += (arr[i] - mean) * (arr[i + lag] - mean)
                c /= variance
                if (c > periodCorr) {
                    periodCorr = c
                    period = lag
                }
            }
        }
        const round = (v) => Math.round(v * 1000) / 1000
        return { mean: round(mean), max: round(max), maxAt, period, periodCorr: round(periodCorr) }
    }
    return { image: { w: W, h: H }, region: { x: x0, y: y0, w, h }, rows: stats(rowDiff), cols: stats(colDiff) }
}

/** 브라우저 실행 옵션(보이는 창) */
const LAUNCH = { headless: false, args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"] }

/**
 * 브라우저를 띄운다. chrome 이면 설치된 Chrome(별도 임시 프로필)을 먼저 시도하고, 없거나 실패하면 받아 둔 Chromium 으로 넘어간다.
 *
 * @param preferred "chrome" | "chromium"
 * @returns { browser, name } name 은 실제로 뜬 것
 */
const launchBrowser = async (preferred) => {
    if (preferred === "chrome") {
        try {
            return { browser: await chromium.launch({ ...LAUNCH, channel: "chrome" }), name: "chrome" }
        } catch (err) {
            console.warn(`설치된 Chrome 을 띄우지 못해 Playwright Chromium 으로 넘어갑니다: ${String(err).split("\n")[0]}`)
        }
    }
    return { browser: await chromium.launch(LAUNCH), name: "chromium" }
}

/**
 * 준비 신호를 기다린다: HUD(.ui-walk-hud) → 디버그 페이지의 data-walk-tiles 가 stable ms 동안 변하지 않음(도엽 스트리밍 멈춤).
 *
 * @returns { tiles, readyMs } 마지막 도엽 수와 걸린 시간. timeout 을 넘기면 그때까지의 값으로 진행하고 timedOut 을 켠다
 */
const waitReady = async (page, { timeout, stable }) => {
    const started = Date.now()
    await page.waitForSelector(".ui-walk-hud", { timeout })
    const deadline = started + timeout
    let last = null
    let since = Date.now()
    while (Date.now() < deadline) {
        const tiles = await page.getAttribute("[data-debug-page]", "data-walk-tiles")
        if (tiles !== last) {
            last = tiles
            since = Date.now()
        } else if (Date.now() - since >= stable) {
            return { tiles: Number(last), readyMs: Date.now() - started, timedOut: false }
        }
        await page.waitForTimeout(250)
    }
    return { tiles: Number(last), readyMs: Date.now() - started, timedOut: true }
}

const capture = async (args) => {
    await mkdir(args.out, { recursive: true })
    const { browser, name: browserName } = await launchBrowser(args.browser)
    const browserInfo = { name: browserName, version: browser.version() }
    console.log(`${browserName} ${browserInfo.version}(보이는 창) 시작. 결과: ${args.out}`)
    const results = []
    try {
        for (const size of args.sizes) {
            for (const params of args.params) {
                const query = withLockOff(params)
                const url = `${args.base}/#/debug/walk?${query}`
                const name = `${size.width}x${size.height}_${paramsSlug(params)}`
                const file = path.join(args.out, `${name}.png`)
                const entry = { name, file: `${name}.png`, size, dpr: args.dpr, params: query, url }
                const started = Date.now()
                const context = await browser.newContext({ viewport: size, deviceScaleFactor: args.dpr })
                const page = await context.newPage()
                const errors = []
                page.on("pageerror", (err) => errors.push(String(err)))
                page.on("console", (msg) => {
                    if (msg.type() === "error") errors.push(msg.text())
                })
                try {
                    await page.goto(url)
                    const ready = await waitReady(page, args)
                    await page.waitForTimeout(args.settle)
                    const status = await page.evaluate(() => document.querySelector(".ui-statusbar")?.textContent ?? "")
                    const png = await page.screenshot({ path: file, type: "png" })
                    const measurePage = await context.newPage()
                    await measurePage.goto("about:blank")
                    const metrics = await measurePage.evaluate(measureInBrowser, {
                        dataUrl: `data:image/png;base64,${png.toString("base64")}`,
                        region: args.region,
                    })
                    await measurePage.close()
                    Object.assign(entry, { status: status.trim(), ready, ...metrics })
                    console.log(
                        `${name}: ${metrics.image.w}×${metrics.image.h}, 준비 ${ready.readyMs} ms(도엽 ${ready.tiles}${ready.timedOut ? ", 시간 초과" : ""}), 행 차 평균 ${metrics.rows.mean} 최대 ${metrics.rows.max}@${metrics.rows.maxAt} 주기 ${metrics.rows.period}(${metrics.rows.periodCorr}), 열 차 평균 ${metrics.cols.mean} 최대 ${metrics.cols.max}@${metrics.cols.maxAt}`,
                    )
                } catch (err) {
                    entry.error = String(err)
                    console.error(`${name}: 실패 — ${entry.error}`)
                } finally {
                    entry.errors = errors
                    entry.ms = Date.now() - started
                    await context.close()
                }
                results.push(entry)
            }
        }
    } finally {
        await browser.close()
    }
    const index = { createdAt: new Date().toISOString(), browser: browserInfo, base: args.base, region: args.region, stable: args.stable, settle: args.settle, results }
    await writeFile(path.join(args.out, "index.json"), JSON.stringify(index, null, 2))
    console.log(`끝. ${results.length}장, ${path.join(args.out, "index.json")}`)
}

/** PNG 파일을 읽어 마스크 영역을 칠한다(두 이미지에 같은 색이라 차이 0) */
const readMasked = async (file, masks, dpr) => {
    const png = PNG.sync.read(await readFile(file))
    for (const mask of masks) {
        const [x0, y0, x1, y1] = maskRect(mask, png.width, png.height, dpr)
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                const i = (y * png.width + x) * 4
                png.data[i] = MASK_COLOR[0]
                png.data[i + 1] = MASK_COLOR[1]
                png.data[i + 2] = MASK_COLOR[2]
                png.data[i + 3] = MASK_COLOR[3]
            }
        }
    }
    return png
}

/**
 * 두 PNG 를 비교한다(마스크 적용 뒤 pixelmatch, 안티앨리어싱 제외).
 *
 * @returns { diffPixels, comparedPixels, ratio, diff(PNG) } 크기가 다르면 { sizeMismatch: true }
 */
const diffImages = (a, b, { threshold, maskedPixels }) => {
    if (a.width !== b.width || a.height !== b.height) return { sizeMismatch: true, a: [a.width, a.height], b: [b.width, b.height] }
    const diff = new PNG({ width: a.width, height: a.height })
    const diffPixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold, includeAA: false })
    const comparedPixels = a.width * a.height - maskedPixels
    return { diffPixels, comparedPixels, ratio: diffPixels / comparedPixels, diff }
}

/** 마스크가 덮는 픽셀 수(겹침은 한 번만 센다) */
const maskedPixelCount = (masks, width, height, dpr) => {
    const covered = new Uint8Array(width * height)
    for (const mask of masks) {
        const [x0, y0, x1, y1] = maskRect(mask, width, height, dpr)
        for (let y = y0; y < y1; y++) covered.fill(1, y * width + x0, y * width + x1)
    }
    let n = 0
    for (let i = 0; i < covered.length; i++) n += covered[i]
    return n
}

/** 쿼리에서 ao=0 을 뺀 문자열(재검증 쌍 찾기용). ao 가 없으면 null */
const withoutAoOff = (params) => {
    const q = new URLSearchParams(params)
    if (q.get("ao") !== "0") return null
    q.delete("ao")
    return q.toString()
}

const compare = async (args) => {
    const [beforeDir, afterDir] = args.compare
    const before = JSON.parse(await readFile(path.join(beforeDir, "index.json"), "utf8"))
    const after = JSON.parse(await readFile(path.join(afterDir, "index.json"), "utf8"))
    // 기준 환경 하나: 브라우저·버전이 다르면 비교하지 않는다(GPU·드라이버 차이로 작은 차이가 정상적으로 난다)
    const envA = `${before.browser?.name} ${before.browser?.version}`
    const envB = `${after.browser?.name} ${after.browser?.version}`
    if (envA !== envB) throw new Error(`브라우저가 달라 비교하지 않습니다: before ${envA}, after ${envB}`)
    const masks = [...(args.defaultMasks ? DEFAULT_MASKS : []), ...args.masks]
    const diffDir = path.join(afterDir, "diff")
    await mkdir(diffDir, { recursive: true })
    const pairs = []
    const images = new Map()
    const load = async (dir, entry) => {
        const key = `${dir}/${entry.file}`
        if (!images.has(key)) images.set(key, await readMasked(path.join(dir, entry.file), masks, entry.dpr ?? 1))
        return images.get(key)
    }
    console.log(`비교: ${envA}, 임계값 ${args.threshold}, 같다고 볼 비율 ≤ ${args.maxDiffRatio}, 마스크 ${masks.length}개`)
    // 마스크가 UI 를 제대로 덮는지 눈으로 볼 수 있게 after 첫 장의 마스크 칠한 사본을 남긴다
    const first = after.results.find((r) => !r.error)
    if (first) await writeFile(path.join(diffDir, "masked.png"), PNG.sync.write(await load(afterDir, first)))
    for (const b of after.results) {
        if (b.error) continue
        const a = before.results.find((r) => r.name === b.name && !r.error)
        if (!a) {
            pairs.push({ name: b.name, missing: "before" })
            console.log(`${b.name}: before 에 없음(새 조합)`)
            continue
        }
        if (a.dpr !== b.dpr || a.size.width !== b.size.width || a.size.height !== b.size.height) {
            pairs.push({ name: b.name, mismatch: { before: [a.size, a.dpr], after: [b.size, b.dpr] } })
            console.log(`${b.name}: 크기·dpr 이 달라 건너뜀`)
            continue
        }
        const imgA = await load(beforeDir, a)
        const imgB = await load(afterDir, b)
        const result = diffImages(imgA, imgB, { threshold: args.threshold, maskedPixels: maskedPixelCount(masks, imgA.width, imgA.height, b.dpr ?? 1) })
        if (result.sizeMismatch) {
            pairs.push({ name: b.name, sizeMismatch: result })
            console.log(`${b.name}: 이미지 크기가 달라 건너뜀`)
            continue
        }
        const diffFile = path.join("diff", `${b.name}.png`)
        await writeFile(path.join(afterDir, diffFile), PNG.sync.write(result.diff))
        const same = result.ratio <= args.maxDiffRatio
        const metricsSame =
            a.rows && b.rows && ["mean", "max", "period"].every((k) => a.rows[k] === b.rows[k]) && ["mean", "max"].every((k) => a.cols[k] === b.cols[k])
        pairs.push({ name: b.name, diffPixels: result.diffPixels, comparedPixels: result.comparedPixels, ratio: result.ratio, same, metricsSame, diff: diffFile })
        console.log(
            `${b.name}: 다른 픽셀 ${result.diffPixels} / ${result.comparedPixels} (${(result.ratio * 100).toFixed(4)} %) → ${same ? "같음" : "다름"}, 지표 ${metricsSame ? "같음" : "다름"}, ${diffFile}`,
        )
    }
    // 재검증: after 안에서 ao=0 과 같은 파라미터의 기본을 짝지어 "다름" 이 나오는지
    const sanity = []
    for (const off of after.results) {
        const base = withoutAoOff(off.params)
        if (base === null || off.error) continue
        const on = after.results.find((r) => r.params === base && r.size.width === off.size.width && r.size.height === off.size.height && !r.error)
        if (!on) continue
        const imgOff = await load(afterDir, off)
        const imgOn = await load(afterDir, on)
        const result = diffImages(imgOn, imgOff, { threshold: args.threshold, maskedPixels: maskedPixelCount(masks, imgOn.width, imgOn.height, on.dpr ?? 1) })
        if (result.sizeMismatch) continue
        const different = result.ratio > args.maxDiffRatio
        sanity.push({ on: on.name, off: off.name, ratio: result.ratio, different })
        console.log(`재검증 ${on.name} ↔ ${off.name}: ${(result.ratio * 100).toFixed(4)} % → ${different ? "다름(정상)" : "같음(비교가 무뎌졌는지 확인)"}`)
    }
    const summary = {
        createdAt: new Date().toISOString(),
        before: beforeDir,
        after: afterDir,
        browser: after.browser,
        threshold: args.threshold,
        maxDiffRatio: args.maxDiffRatio,
        masks,
        pairs,
        sanity,
    }
    await writeFile(path.join(afterDir, "compare.json"), JSON.stringify(summary, null, 2))
    console.log(`끝. ${pairs.length}쌍, ${path.join(afterDir, "compare.json")}`)
}

const main = async () => {
    const args = parseArgs(process.argv.slice(2))
    if (args.mode === "compare") await compare(args)
    else await capture(args)
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
