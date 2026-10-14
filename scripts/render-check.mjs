#!/usr/bin/env node
/**
 * 렌더 확인 자동 캡처(docs/design-code-plan.md 7절 K, src/webgpu/VERIFY.md 3절).
 *
 * Playwright 로 Chromium 을 **보이는 창**으로 띄워(헤드리스는 WebGPU 가 꺼지거나 소프트웨어로 떨어질 수 있다) 디버그 페이지
 * `#/debug/walk?…` 를 창 크기 × 파라미터 조합마다 열고, 둘러보기에 들어간 뒤(HUD 가 보이면) 잠시 기다려 **원본 해상도 PNG** 를
 * 저장한다. 같이 저장하는 지표(JSON)는 선택 영역의 이웃 행·열 밝기 차(평균·최대·최대 위치·주기)로, SSAO 가로 줄무늬처럼
 * 캡처를 눈으로 보기 어려운 띠를 숫자로 비교하기 위한 것이다. 통과/실패 판정은 하지 않는다(판단은 사람).
 *
 * 서버는 사용자가 띄운다(npm run build 뒤 npx serve dist, 3000 포트). 이 스크립트는 접속만 한다. 포인터 잠금은 자동화에서
 * 못 쓰므로 lock=0 이 없으면 붙인다.
 *
 * 브라우저는 기본으로 설치된 Chrome(Playwright channel "chrome", 별도 임시 프로필이라 사용자의 창·로그인에 손대지 않는다)을 띄운다.
 * 사용자가 보는 것과 같은 브라우저로 찍기 위해서다. Chrome 이 없거나 실행에 실패하면 Playwright 가 받아 둔 Chromium(Chrome for Testing,
 * 한 메이저 앞선 빌드)으로 넘어가며 로그에 알린다. 어느 것으로 찍었는지는 index.json 의 browser 에 남는다
 *
 * 사용:
 *   node scripts/render-check.mjs --params "bbox=14135700,4513980,14136500,4514780&yaw=90&pitch=-15" \
 *     [--params "…&aodebug=1"] [--sizes 878x946,1024x768] [--heights 940-950] [--base http://localhost:3000] \
 *     [--out docs/render-checks/<오늘>] [--settle 4500] [--region 0,0.45,1,0.5] [--dpr 2] [--timeout 120000] [--browser chrome|chromium]
 *   --params   해시 쿼리(여러 번 줄 수 있다. 조합마다 한 장). bbox 가 없으면 둘러보기에 못 들어간다
 *   --browser  chrome(기본. 설치된 Chrome, 실패하면 chromium 으로) 또는 chromium(받아 둔 Chromium 만)
 *   --sizes    창 크기 목록(CSS px). 기본 878x946
 *   --heights  너비는 sizes 의 첫 값, 높이를 a-b 로 훑는다(크기 의존 증상용). sizes 에 더해진다
 *   --region   지표를 잴 영역(비율 x,y,w,h). 기본 아래쪽 절반 가까이(HUD·파라미터 표를 피함)
 *   --dpr      deviceScaleFactor(기본 2 = 레티나. 캔버스는 dpr 배 해상도)
 *   --settle   HUD 가 보인 뒤 기다리는 ms(도엽 스트리밍·Esc 안내 사라짐). 기본 4500
 * 결과: <out>/<WxH>_<파라미터 요약>.png 와 <out>/index.json(모든 조합의 지표). PNG 는 git 에 넣지 않는다(.gitignore)
 */
import { mkdir, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { chromium } from "playwright"

/** argv → { base, params[], sizes[], out, settle, region, dpr, timeout } */
const parseArgs = (argv) => {
    const args = { base: "http://localhost:3000", params: [], sizes: [], heights: null, out: null, settle: 4500, region: [0, 0.45, 1, 0.5], dpr: 2, timeout: 120000, browser: "chrome" }
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i]
        const value = argv[i + 1]
        const take = () => {
            i++
            if (value === undefined) throw new Error(`${key} 에 값이 없습니다`)
            return value
        }
        switch (key) {
            case "--base": args.base = take().replace(/\/$/, ""); break
            case "--params": args.params.push(take()); break
            case "--sizes": args.sizes.push(...take().split(",").map(parseSize)); break
            case "--heights": args.heights = take().split("-").map(Number); break
            case "--out": args.out = take(); break
            case "--settle": args.settle = Number(take()); break
            case "--region": args.region = take().split(",").map(Number); break
            case "--dpr": args.dpr = Number(take()); break
            case "--timeout": args.timeout = Number(take()); break
            case "--browser": args.browser = take(); break
            case "--help": case "-h": printHelp(); process.exit(0)
            default: throw new Error(`모르는 옵션 ${key}`)
        }
    }
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

/** 브라우저 실행 옵션(보이는 창. 헤드리스는 WebGPU 가 꺼지거나 소프트웨어로 떨어질 수 있다) */
const LAUNCH = { headless: false, args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"] }

/**
 * 브라우저를 띄운다. chrome 이면 설치된 Chrome 을 먼저 시도하고, 없거나 실패하면 받아 둔 Chromium 으로 넘어간다.
 *
 * @param preferred "chrome" | "chromium"
 * @returns { browser, name } name 은 실제로 뜬 것("chrome" | "chromium")
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
const parseSize = (text) => {
    const m = /^(\d+)x(\d+)$/.exec(text.trim())
    if (!m) throw new Error(`크기 형식 오류 ${text}(예: 878x946)`)
    return { width: Number(m[1]), height: Number(m[2]) }
}
const printHelp = () => console.log("사용법은 파일 상단 주석 참고: node scripts/render-check.mjs --params \"bbox=…\" [--sizes 878x946]")

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
 * 브라우저 안에서 PNG 를 2D 캔버스에 그려 선택 영역의 이웃 행·열 밝기 차를 잰다(Node 에 PNG 디코더를 두지 않으려고).
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

const main = async () => {
    const args = parseArgs(process.argv.slice(2))
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
                const entry = { name, file, size, dpr: args.dpr, params: query, url }
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
                    // 둘러보기에 들어가면 HUD(.ui-walk-hud)가 뜬다. 지형·건물 로딩이 포함되므로 넉넉히 기다린다
                    await page.waitForSelector(".ui-walk-hud", { timeout: args.timeout })
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
                    Object.assign(entry, { status: status.trim(), ...metrics })
                    console.log(
                        `${name}: ${metrics.image.w}×${metrics.image.h}, 행 차 평균 ${metrics.rows.mean} 최대 ${metrics.rows.max}@${metrics.rows.maxAt} 주기 ${metrics.rows.period}(${metrics.rows.periodCorr}), 열 차 평균 ${metrics.cols.mean} 최대 ${metrics.cols.max}@${metrics.cols.maxAt}`,
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
    const index = { createdAt: new Date().toISOString(), browser: browserInfo, base: args.base, region: args.region, settle: args.settle, results }
    await writeFile(path.join(args.out, "index.json"), JSON.stringify(index, null, 2))
    console.log(`끝. ${results.length}장, ${path.join(args.out, "index.json")}`)
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
