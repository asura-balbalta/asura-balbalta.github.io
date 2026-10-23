#!/usr/bin/env node
/**
 * 브라우저 시간 기준값(docs/cache-refactor-plan.md 6절 V4(b), src/webgpu/VERIFY.md 3.5·4절 디버그 훅).
 *
 * render-check 와 같은 기준 환경: Playwright 는 설치된 Chrome(channel "chrome", 없거나 실패하면 받아 둔 Chromium)을 **보이는 창**·임시
 * 프로필로 띄우는 데만 쓰고, 재기·기록은 이 스크립트가 한다. 실행마다 **브라우저를 새로** 띄운다(HTTP·셰이더 캐시가 매번 빈 상태로 같게).
 * 시나리오를 실행 번호마다 돌아가며(select25 1회 → select300 1회 → walk 1회 → … ) 돌려 시간에 따른 흔들림이 한 시나리오에 몰리지 않게 한다.
 *
 * 시나리오(디버그 페이지 `#/debug/walk?…`, lock=0·look=0 을 붙인다):
 *   select25   한강 여의도 25도엽, walk=0(매끈한 면 궤도 보기): 페이지 열기 → 범위 확정(data-busy 1) → 첫 도엽(궤도 HUD) → 끝(data-busy 0)
 *   select300  도심 340도엽(여의도·용산·마포·중구), walk=0: 같은 시각들
 *   walk300    (e, --scenarios 로 고를 때만) 도심 340도엽 둘러보기 자동 진입: walk 의 (c) 와 같이 재고 순간 이동은 하지 않는다.
 *              진입 단계 도엽 로그의 층별 "(캐시)" 수(cacheHits)로 표현 방식 전환 때 정말 다시 만든 층을 센다
 *   walk       한강 여의도 25도엽, 둘러보기 자동 진입: (c) 진입(data-debug-state walking, 계단형 전환) → 주변 도엽 스트리밍이 멈출 때까지,
 *              이어서 (d) 디버그 훅 teleport 로 동북동 1 km 씩 5번 → 걸음마다 멈출 때까지
 * 기다림은 sleep 이 아니라 준비 신호로(VERIFY.md 7절): 페이지 안 MutationObserver 가 data-busy·data-debug-state·data-walk-tiles 가 바뀐
 * 시각과 HUD(.ui-orbit-hud·.ui-walk-hud) 등장 시각을 적고, 보조 워커의 "도엽 <이름>: …" 로그(도엽 하나 완성)가 온 시각을 함께 본다.
 * 마지막 활동(속성 변화·도엽 로그) 뒤 --stable ms 동안 조용하고 busy 0 이면 window.__asrbbtDebug.memory() 로 조정자의 running false·
 * pending 0 을 확인해 "멈춤" 으로 본다. 걸린 시간은 **마지막 활동 시각** 까지(조용히 기다린 --stable 은 빼고)다.
 * 시나리오 끝마다 memory() 전체와 요약(MB), 콘솔 오류·경고, 네트워크 요청(호스트·종류별 수·받은 바이트)을 남긴다. 요청은 Playwright 의 page
 * "request" 가 중첩 보조 워커 것까지 받고, 출처(main·worker)는 페이지 대상 CDP Network(메인 스레드만 봄)에 있었는지로 가른다.
 * 도엽 수는 보조 워커 로그 줄 수라 같은 도엽을 두 번 만들면 두 번 센다("만든 횟수").
 * 통과/실패 판정은 하지 않는다(--compare 는 중앙값 변화율만 보인다. 기준은 계획서 6절 V4: 10 % 넘게 느려지지 않음).
 *
 * 서버는 사용자가 띄운다(npm run build 뒤 npx serve dist, 3000 포트. R2 CORS 가 이 출처만 허용).
 *
 * 사용:
 *   node scripts/perf-check.mjs [--runs 3] [--scenarios select25,select300,walk] [--out docs/render-checks/<오늘>-perf]
 *     [--size 878x946] [--dpr 2] [--stable 2000] [--timeout 600000] [--browser chrome|chromium] [--base http://localhost:3000]
 *     [--bbox25 …] [--bbox300 …] [--steps 5] [--step-m 1000] [--bearing 22.5] [--http cold|warm]
 *   node scripts/perf-check.mjs --compare <beforeDir> <afterDir>
 *   node scripts/perf-check.mjs --merge <dir1,dir2,…> --out <dir>   # --runs 1 로 전·후를 번갈아 잰 폴더들을 빌드별로 합쳐 통계를 다시 냄
 *   --bearing  순간 이동 방향(°, 0 = 동쪽·반시계. 22.5 = 동북동, 계획서 19절 측정과 같은 쪽)
 *   --http     cold(기본): 새 컨텍스트라 HTTP 캐시가 비어 R2 에서 받는 시간까지 잰다(데이터 서버는 CDN 캐시 DYNAMIC 이라 받기 지연이 크게 흔들린다).
 *              warm: 같은 컨텍스트에서 시나리오를 한 번 돌려 HTTP 캐시만 데운 뒤(R2 응답 cache-control max-age=3600) 새 페이지에서 잰다.
 *              워커·앱 캐시는 새 페이지라 비어 있으므로 캐시 구조 변경의 효과는 남고 네트워크 흔들림만 빠진다
 * 결과: <out>/results.json(환경·실행별 원자료·통계), <out>/summary.md(표), <out>/<시나리오>-<n>.log(페이지·워커 콘솔 전체)
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { execSync } from "node:child_process"
import { createHash } from "node:crypto"
import path from "node:path"
import { chromium } from "playwright"

/** 한강 여의도(물 장면, 도엽 25, 5K 4. 계획서 19절 A 도심의 시작 범위) */
const BBOX_25 = "14127729,4511702,14130234,4514248"
/** 도심 340도엽(한 변 10.6 km 3857 = 8.4 km. 여의도·용산·마포·중구. 경고 상한 2000 아래, V3 의 "300 도엽 이상" 에도 씀) */
const BBOX_300 = "14128200,4509700,14138800,4520300"

const parseArgs = (argv) => {
    const args = {
        mode: "run",
        base: "http://localhost:3000",
        runs: 3,
        scenarios: ["select25", "select300", "walk"],
        out: null,
        size: { width: 878, height: 946 },
        dpr: 2,
        stable: 2000,
        timeout: 600000,
        browser: "chrome",
        bbox25: BBOX_25,
        bbox300: BBOX_300,
        steps: 5,
        stepM: 1000,
        bearing: 22.5,
        http: "cold",
        compare: null,
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
            case "--runs": args.runs = Number(take()); break
            case "--scenarios": args.scenarios = take().split(",").map((s) => s.trim()); break
            case "--out": args.out = take(); break
            case "--size": {
                const m = /^(\d+)x(\d+)$/.exec(take())
                if (!m) throw new Error("--size 형식 오류(예: 878x946)")
                args.size = { width: Number(m[1]), height: Number(m[2]) }
                break
            }
            case "--dpr": args.dpr = Number(take()); break
            case "--stable": args.stable = Number(take()); break
            case "--timeout": args.timeout = Number(take()); break
            case "--browser": args.browser = take(); break
            case "--bbox25": args.bbox25 = take(); break
            case "--bbox300": args.bbox300 = take(); break
            case "--steps": args.steps = Number(take()); break
            case "--step-m": args.stepM = Number(take()); break
            case "--bearing": args.bearing = Number(take()); break
            case "--http": args.http = take(); break
            case "--compare": args.mode = "compare"; args.compare = [take(), take()]; break
            case "--merge": args.mode = "merge"; args.merge = take().split(",").map((s) => s.trim()); break
            case "--help": case "-h": console.log("사용법은 파일 상단 주석 참고"); process.exit(0)
            default: throw new Error(`모르는 옵션 ${key}`)
        }
    }
    for (const s of args.scenarios) if (!["select25", "select300", "walk", "walk300"].includes(s)) throw new Error(`모르는 시나리오 ${s}`)
    if (args.http !== "cold" && args.http !== "warm") throw new Error(`--http 는 cold 또는 warm(${args.http})`)
    if (!args.out) args.out = path.join("docs", "render-checks", `${new Date().toISOString().slice(0, 10)}-perf`)
    return args
}

/** 시나리오 → 디버그 페이지 해시 쿼리 */
const scenarioQuery = (name, args) => {
    if (name === "select25") return `bbox=${args.bbox25}&walk=0&lock=0&look=0`
    if (name === "select300") return `bbox=${args.bbox300}&walk=0&lock=0&look=0`
    if (name === "walk300") return `bbox=${args.bbox300}&yaw=90&pitch=-15&lock=0&look=0`
    return `bbox=${args.bbox25}&yaw=90&pitch=-15&lock=0&look=0`
}

/** render-check 와 같은 실행 옵션(보이는 창) */
const LAUNCH = { headless: false, args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"] }
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
 * 페이지 안 기록기(addInitScript). 디버그 페이지 요소의 data-busy·data-debug-state·data-walk-tiles 가 바뀐 시각(epoch ms)과
 * 궤도·둘러보기 HUD 가 처음 보인 시각을 window.__perf 에 적는다. 시각은 performance.timeOrigin + now(Node 의 Date.now 와 같은 시계)
 */
const recorder = () => {
    const perf = { ev: [], hud: {}, navStart: performance.timeOrigin }
    window.__perf = perf
    const now = () => performance.timeOrigin + performance.now()
    let last = null
    const check = () => {
        const el = document.querySelector("[data-debug-page]")
        if (el) {
            const busy = el.getAttribute("data-busy")
            const state = el.getAttribute("data-debug-state")
            const tiles = el.getAttribute("data-walk-tiles")
            const key = `${busy}/${state}/${tiles}`
            if (key !== last) {
                last = key
                perf.ev.push({ t: now(), busy, state, tiles: Number(tiles) })
            }
        }
        if (!perf.hud.orbit && document.querySelector(".ui-orbit-hud")) perf.hud.orbit = now()
        if (!perf.hud.walk && document.querySelector(".ui-walk-hud")) perf.hud.walk = now()
    }
    new MutationObserver(check).observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["data-busy", "data-debug-state", "data-walk-tiles"],
    })
}

/** 보조 워커의 도엽 완성 로그("도엽 <이름>: …", 밖 도엽은 "도엽 <이름>(밖): …"). 실패 경고("도엽 X 건물 실패:")는 빼려고 이름 뒤 공백을 막는다 */
const TILE_LOG = /^도엽 [^\s:]+: /
/** 도엽 로그에서 층별 "캐시에서 꺼냄" 표시(지형은 ": 캐시 Nms", 레이어는 "(캐시)"). 표현 방식 전환 때 몇 도엽을 정말 다시 만들었는지 센다 */
const cacheFlags = (text) => ({
    terrain: /^도엽 [^\s:]+: 캐시 /.test(text),
    buildings: /건물 \d+\(캐시\)/.test(text),
    roads: /도로 \d+\([^)]*\)\(캐시\)/.test(text),
    water: /물 \d+\([^)]*\)\(캐시\)/.test(text),
    forest: /산림 \d+(\(건너뜀 \d+\))? \(캐시\)/.test(text),
})

const MB = (bytes) => (bytes == null ? null : Math.round((bytes / 1048576) * 10) / 10)
/** {key: {count, bytes}} 묶음의 바이트 합(조건 함수로 키를 거른다) */
const groupBytes = (group, keep = () => true) => Object.entries(group ?? {}).reduce((s, [k, v]) => s + (keep(k) ? v?.bytes ?? 0 : 0), 0)
/**
 * memory() 보고를 MB 요약으로. 보조 워커 합. 계획서 1.2절 표의 열: 데이터 파일·인덱스 JSON·5K 목록·도엽 결과·ttp·TIN·메인 사본·GPU.
 * C5(2026-10-23)부터 스레드마다 캐시 표 `caches`(`층.레이어` → LruCache.stats(). 층 fixed·index·file·result, 레이어 terrain·buildings·…)를 읽는다.
 * 그 전 형식(data·lists·results·terrain)의 원자료도 읽는다. cacheEvictions 는 키별 밀려난 수(보조 워커 합, 0 이 아닌 것만)
 */
const summarizeMemory = (m) => {
    if (!m) return null
    const helpers = m.workers?.helpers ?? []
    const sum = (f) => helpers.reduce((s, h) => s + f(h), 0)
    const c = m.workers?.coordinator ?? {}
    /** 캐시 표에서 층(과 레이어 조건)의 바이트 합 */
    const tier = (caches, t, keep = () => true) => groupBytes(caches, (k) => k.startsWith(`${t}.`) && keep(k))
    const json = (caches) => tier(caches, "index") + tier(caches, "fixed")
    const isNew = helpers.some((h) => h.caches) || !!c.caches
    const cacheEvictions = {}
    for (const h of helpers) for (const [k, s] of Object.entries(h.caches ?? {})) if (s?.evictions) cacheEvictions[k] = (cacheEvictions[k] ?? 0) + s.evictions
    const sizes = isNew
        ? {
              dataFilesMB: MB(sum((h) => tier(h.caches, "file", (k) => k !== "file.terrain"))),
              jsonMB: MB(sum((h) => json(h.caches)) + json(c.caches) + json(m.main?.caches)),
              listsMB: 0,
              resultsMB: MB(sum((h) => tier(h.caches, "result", (k) => k !== "result.terrain"))),
              ttpMB: MB(sum((h) => h.caches?.["file.terrain"]?.bytes ?? 0)),
              tinMB: MB(sum((h) => h.caches?.["result.terrain"]?.bytes ?? 0)),
          }
        : {
              dataFilesMB: MB(sum((h) => groupBytes(h.data, (k) => !k.endsWith(".json")))),
              jsonMB: MB(sum((h) => groupBytes(h.data, (k) => k.endsWith(".json"))) + groupBytes(c.data) + groupBytes(m.main?.data)),
              listsMB: MB(sum((h) => groupBytes(h.lists))),
              resultsMB: MB(sum((h) => groupBytes(h.results))),
              ttpMB: MB(sum((h) => h.terrain?.ttp?.bytes ?? 0)),
              tinMB: MB(sum((h) => h.terrain?.tin?.bytes ?? 0)),
          }
    return {
        helpers: helpers.length,
        ...sizes,
        cacheEvictions,
        mainTilesMB: MB(m.main?.tiles?.total),
        mainHeapMB: MB(m.main?.heap),
        gpuMB: MB(m.gpu?.bytes),
        gpuTiles: m.gpu?.tiles ?? null,
        loaded: c.loaded,
        extra: c.extra,
        live5k: c.live5k?.length,
        fetched5k: c.fetched5k,
    }
}

/** 요청 URL → 종류(통계용). 데이터 서버는 첫 경로 + json/파일, 나머지는 호스트 */
const requestKind = (url) => {
    if (url.startsWith("data:")) return "data:"
    const u = new URL(url)
    if (u.host === "layers.asrbbt.world") {
        const seg = u.pathname.split("/").filter(Boolean)
        return `layers/${seg[0] ?? ""}${u.pathname.endsWith(".json") ? " json" : " file"}`
    }
    return u.host
}

/**
 * 한 실행: 새 브라우저 → 새 컨텍스트 → (--http warm 이면 같은 시나리오를 한 번 돌려 HTTP 캐시만 데우고 그 페이지를 닫음) → 새 페이지에서 재기
 *
 * @returns 실행 기록(시각·시간·메모리·콘솔·요청)
 */
const runOnce = async (scenario, runIndex, args, browserInfoRef) => {
    const { browser, name } = await launchBrowser(args.browser)
    browserInfoRef.value ??= { name, version: browser.version() }
    const url = `${args.base}/#/debug/walk?${scenarioQuery(scenario, args)}`
    const rec = { scenario, run: runIndex, url, http: args.http, startedAt: new Date().toISOString() }
    try {
        const context = await browser.newContext({ viewport: args.size, deviceScaleFactor: args.dpr })
        await context.addInitScript(recorder)
        if (args.http === "warm") {
            const warm = { scenario, run: runIndex, warmup: true }
            await measureInPage(context, warm, args, url, `${scenario}-${runIndex}-warmup.log`)
            rec.warmup = { ms: warm.ms ?? null, error: warm.error ?? null, layerRequests: warm.phases?.select?.layerRequests ?? null }
        }
        await measureInPage(context, rec, args, url, `${scenario}-${runIndex}.log`)
    } catch (err) {
        rec.error = String(err)
        console.error(`${scenario} #${runIndex}: 실패 — ${rec.error}`)
    } finally {
        await browser.close()
    }
    return rec
}

/**
 * 컨텍스트에 새 페이지를 열어 시나리오 하나를 재고 rec 에 채운다(워커·앱 메모리 캐시는 페이지마다 새로. HTTP 캐시는 컨텍스트가 같으면 이어진다).
 * 콘솔 전체는 logName 으로 저장하고 페이지를 닫는다. 실패는 rec.error
 */
const measureInPage = async (context, rec, args, url, logName) => {
    const { scenario, run: runIndex } = rec
    const label = rec.warmup === true ? `${scenario} #${runIndex}(데우기)` : `${scenario} #${runIndex}`
    const consoleLines = []
    const problems = []
    const tileLogs = []
    const requests = []
    const page = await context.newPage()
    try {
        page.on("pageerror", (err) => problems.push({ t: Date.now(), type: "pageerror", text: String(err) }))
        page.on("console", (msg) => {
            const t = Date.now()
            const text = msg.text()
            const type = msg.type()
            const source = msg.location()?.url?.split("/").pop() ?? ""
            consoleLines.push(`${new Date(t).toISOString()} [${type}] (${source}) ${text}`)
            if (type === "error" || type === "warning") problems.push({ t, type, source, text })
            if (TILE_LOG.test(text)) tileLogs.push({ t, extra: text.includes("(밖):"), cached: cacheFlags(text) })
        })
        // 요청 출처: Playwright 의 page "request" 는 중첩 보조 워커 요청까지 받지만 출처를 주지 않는다(req.frame() 도 워커에서 예외 없음).
        // 페이지 대상 CDP Network 는 메인 스레드 요청만 받으므로(2026-10-23 확인: 데이터 파일 0건) 거기 없는 요청을 워커로 본다
        const mainUrls = new Map()
        const cdp = await context.newCDPSession(page)
        await cdp.send("Network.enable")
        cdp.on("Network.requestWillBeSent", (e) => mainUrls.set(e.request.url, (mainUrls.get(e.request.url) ?? 0) + 1))
        page.on("request", (req) => {
            requests.push({ req, t: Date.now(), url: req.url(), kind: requestKind(req.url()), from: null, bytes: null, failed: null })
        })
        /** 아직 출처가 없는 요청을 시간 순으로 메인(CDP 가 본 URL 을 하나씩 씀)·워커로 나눈다. 구간 끝(조용해진 뒤)에 부른다 */
        const classify = () => {
            for (const r of requests) {
                if (r.from) continue
                const n = mainUrls.get(r.url) ?? 0
                if (n > 0) {
                    r.from = "main"
                    mainUrls.set(r.url, n - 1)
                } else r.from = "worker"
            }
        }
        page.on("requestfinished", async (req) => {
            const r = requests.find((x) => x.req === req)
            if (!r) return
            try {
                // -1 은 크기 모름(같은 페이지에서 다시 받은 것 등) → null
                const sizes = await req.sizes()
                r.bytes = sizes.responseBodySize >= 0 ? sizes.responseBodySize : null
                // 받기 시간(요청 시작 → 응답 끝, ms). HTTP 캐시에서 오면 작다
                const timing = req.timing()
                r.ms = timing.responseEnd >= 0 ? Math.round(timing.responseEnd) : null
            } catch {
                /* 크기·시간을 못 읽으면 null */
            }
        })
        page.on("requestfailed", (req) => {
            const r = requests.find((x) => x.req === req)
            if (r) r.failed = req.failure()?.errorText ?? "failed"
        })

        const perfState = () => page.evaluate(() => ({ ev: window.__perf.ev, hud: window.__perf.hud, navStart: window.__perf.navStart }))
        const memory = () => page.evaluate(() => window.__asrbbtDebug.memory())
        /**
         * 멈출 때까지 기다린다: 마지막 활동(속성 변화·도엽 로그, from 이후) 뒤 stable ms 조용 + busy 0 → memory() 로 조정자 쉼 확인.
         * 반환 { at(마지막 활동 epoch ms), mem, timedOut }
         */
        const waitQuiet = async (from) => {
            const deadline = Date.now() + args.timeout
            const lastActivity = (ev) => Math.max(from, ...ev.filter((e) => e.t >= from).map((e) => e.t), ...tileLogs.filter((l) => l.t >= from).map((l) => l.t))
            // 조정자 "쉼" 을 두 번 본다(render-check waitReady 와 같은 이유: memory() 는 보조 워커 답을 기다린 뒤 running 을 읽어, 밖 도엽을
            // 막 끝낸 순간에 "쉼" 인데 그 도엽의 로그·메인 갱신이 아직 안 온 때가 있다). 첫 확인 뒤 stable 동안 새 활동이 없고 다시 쉼이면 멈춤
            let firstIdle = null
            while (Date.now() < deadline) {
                const st = await perfState()
                const lastEv = st.ev.at(-1)
                const at = lastActivity(st.ev)
                if (lastEv?.busy === "0" && Date.now() - at >= args.stable && !(firstIdle?.at === at && Date.now() - firstIdle.time < args.stable)) {
                    const mem = await memory()
                    const c = mem.workers.coordinator
                    const idle = !c.running && c.pending === 0
                    const atAfter = lastActivity((await perfState()).ev)
                    if (idle && atAfter === at && firstIdle?.at === at) return { at, mem, timedOut: false }
                    firstIdle = idle && atAfter === at ? { at, time: Date.now() } : null
                }
                await page.waitForTimeout(200)
            }
            return { at: Date.now(), mem: await memory().catch(() => null), timedOut: true }
        }
        /** 첫 이벤트(조건) 시각 */
        const firstEv = (ev, pred, after = 0) => ev.find((e) => e.t >= after && pred(e))?.t ?? null
        /** 구간 [a, b) 의 요청·도엽 로그 통계 */
        const phaseStats = (a, b) => {
            classify()
            const reqs = requests.filter((r) => r.t >= a && r.t < b)
            const byKind = {}
            for (const r of reqs) {
                const k = `${r.kind} (${r.from})`
                byKind[k] ??= { count: 0, bytes: 0 }
                byKind[k].count++
                byKind[k].bytes += r.bytes ?? 0
            }
            const logs = tileLogs.filter((l) => l.t >= a && l.t < b)
            return {
                requests: reqs.length,
                workerRequests: reqs.filter((r) => r.from === "worker").length,
                layerRequests: reqs.filter((r) => r.kind.startsWith("layers/")).length,
                layerBytes: reqs.filter((r) => r.kind.startsWith("layers/")).reduce((s, r) => s + (r.bytes ?? 0), 0),
                // 데이터 받기 시간: 가장 오래 걸린 것과 합(겹쳐 받으므로 합은 벽시계 시간이 아니다). 흔들림이 받기 탓인지 가를 때
                layerFetchMaxMs: Math.max(0, ...reqs.filter((r) => r.kind.startsWith("layers/")).map((r) => r.ms ?? 0)),
                layerFetchSumMs: reqs.filter((r) => r.kind.startsWith("layers/")).reduce((s, r) => s + (r.ms ?? 0), 0),
                failed: reqs.filter((r) => r.failed).length,
                byKind,
                tilesBuilt: logs.length,
                extraBuilt: logs.filter((l) => l.extra).length,
                // 층별로 캐시에서 꺼낸 도엽 수(나머지는 그 층을 새로 만듦)
                cacheHits: Object.fromEntries(["terrain", "buildings", "roads", "water", "forest"].map((k) => [k, logs.filter((l) => l.cached?.[k]).length])),
            }
        }
        const problemsIn = (a, b) => problems.filter((p) => p.t >= a && p.t < b).map(({ type, source, text }) => ({ type, source, text }))

        const t0 = Date.now()
        await page.goto(url)
        if (scenario === "select25" || scenario === "select300") {
            // 범위 확정(busy 1) → 첫 도엽(궤도 HUD) → 끝(busy 0)
            await page.waitForFunction(
                () => {
                    const ev = window.__perf.ev
                    const i = ev.findIndex((e) => e.busy === "1")
                    return i >= 0 && ev.slice(i).some((e) => e.busy === "0") && !!window.__perf.hud.orbit
                },
                null,
                { timeout: args.timeout, polling: 100 },
            )
            const st = await perfState()
            const tSelect = firstEv(st.ev, (e) => e.busy === "1")
            const tDone = firstEv(st.ev, (e) => e.busy === "0", tSelect)
            const quiet = await waitQuiet(tDone)
            const tEnd = Date.now()
            Object.assign(rec, {
                times: {
                    pageToSelectMs: Math.round(tSelect - st.navStart),
                    firstTileMs: Math.round(st.hud.orbit - tSelect),
                    buildMs: Math.round(tDone - tSelect),
                    settledMs: Math.round(quiet.at - tSelect),
                    totalMs: Math.round(tDone - st.navStart),
                },
                timedOut: quiet.timedOut,
                tiles: quiet.mem?.workers.coordinator.loaded ?? null,
                memory: summarizeMemory(quiet.mem),
                memoryRaw: quiet.mem,
                phases: { select: { ...phaseStats(t0, tEnd), problems: problemsIn(t0, tEnd) } },
            })
            console.log(
                `${label}: 도엽 ${rec.tiles}, 범위 확정→끝 ${rec.times.buildMs} ms(첫 도엽 ${rec.times.firstTileMs}, 조용 ${rec.times.settledMs}), 페이지부터 ${rec.times.totalMs} ms${quiet.timedOut ? ", 시간 초과" : ""}`,
            )
        } else {
            // (c) 둘러보기 진입: walking 이 된 순간 → 계단형 재생성(busy 1 → 0)·주변 도엽 스트리밍이 멈출 때까지
            await page.waitForFunction(() => window.__perf.ev.some((e) => e.state === "walking"), null, { timeout: args.timeout, polling: 100 })
            const st = await perfState()
            const tSelect = firstEv(st.ev, (e) => e.busy === "1")
            const tSelectDone = firstEv(st.ev, (e) => e.busy === "0", tSelect)
            const tWalk = firstEv(st.ev, (e) => e.state === "walking")
            const entry = await waitQuiet(tWalk)
            const st2 = await perfState()
            const tStepped = firstEv(st2.ev, (e) => e.state === "walking" && e.busy === "0", tWalk)
            const tEntryEnd = Date.now()
            rec.times = {
                pageToSelectMs: Math.round(tSelect - st.navStart),
                selectBuildMs: Math.round(tSelectDone - tSelect),
                walkSteppedMs: tStepped ? Math.round(tStepped - tWalk) : null,
                walkEntryMs: Math.round(entry.at - tWalk),
            }
            rec.walkTiles = st2.ev.at(-1)?.tiles ?? null
            rec.timedOut = entry.timedOut
            rec.memory = { entry: summarizeMemory(entry.mem) }
            rec.memoryRaw = { entry: entry.mem }
            rec.phases = {
                select: { ...phaseStats(t0, tWalk), problems: problemsIn(t0, tWalk) },
                entry: { ...phaseStats(tWalk, tEntryEnd), problems: problemsIn(tWalk, tEntryEnd) },
            }
            console.log(
                `${label}: 선택 ${rec.times.selectBuildMs} ms, 진입→계단형 ${rec.times.walkSteppedMs} ms, 진입→멈춤 ${rec.times.walkEntryMs} ms(밖 도엽 ${rec.walkTiles}, 만든 도엽 ${rec.phases.entry.tilesBuilt})${entry.timedOut ? ", 시간 초과" : ""}`,
            )
            // (d) 순간 이동(walk 만. walk300 은 진입까지): 플레이어 자리(조정자의 걷기 중심 5179 − 원점 = 메쉬 로컬 m)에서 bearing 쪽으로 step-m 씩
            const c = entry.mem.workers.coordinator
            const origin = entry.mem.main.origin
            const spawn = [c.walk[0] - origin[0], c.walk[1] - origin[1]]
            const rad = (args.bearing * Math.PI) / 180
            rec.teleport = { spawn, bearing: args.bearing, stepM: args.stepM, steps: [] }
            let prevEnd = tEntryEnd
            const steps = scenario === "walk" ? args.steps : 0
            for (let k = 1; k <= steps; k++) {
                const target = [spawn[0] + k * args.stepM * Math.cos(rad), spawn[1] + k * args.stepM * Math.sin(rad)]
                const tStart = Date.now()
                await page.evaluate(([x, y]) => window.__asrbbtDebug.teleport(x, y), target)
                const q = await waitQuiet(tStart)
                const tStepEnd = Date.now()
                const stq = await perfState()
                const step = {
                    k,
                    target: target.map((v) => Math.round(v)),
                    ms: Math.round(q.at - tStart),
                    walkTiles: stq.ev.at(-1)?.tiles ?? null,
                    timedOut: q.timedOut,
                    ...phaseStats(prevEnd, tStepEnd),
                    problems: problemsIn(prevEnd, tStepEnd),
                }
                prevEnd = tStepEnd
                rec.teleport.steps.push(step)
                if (k === steps) {
                    rec.memory.teleportEnd = summarizeMemory(q.mem)
                    rec.memoryRaw.teleportEnd = q.mem
                }
                console.log(`  teleport ${k} km: ${step.ms} ms(밖 도엽 ${step.walkTiles}, 만든 도엽 ${step.tilesBuilt}, 데이터 요청 ${step.layerRequests})${q.timedOut ? ", 시간 초과" : ""}`)
            }
        }
        rec.consoleCount = consoleLines.length
        rec.problems = problems.map(({ type, source, text }) => ({ type, source, text }))
        classify()
        rec.requestsTotal = { count: requests.length, failed: requests.filter((r) => r.failed).length, fromWorker: requests.filter((r) => r.from === "worker").length }
        rec.ms = Date.now() - t0
    } catch (err) {
        rec.error = String(err)
        console.error(`${label}: 실패 — ${rec.error}`)
    } finally {
        await writeFile(path.join(args.out, logName), consoleLines.join("\n"))
        await page.close().catch(() => {})
    }
}

/** 수 목록 → { median, min, max, n }(null 은 뺀다) */
const stats = (values) => {
    const v = values.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b)
    if (v.length === 0) return null
    const mid = Math.floor(v.length / 2)
    const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
    return { median, min: v[0], max: v.at(-1), n: v.length }
}

/** 실행 기록 → 지표 이름별 통계(--compare 가 같은 이름으로 짝짓는다) */
const metricStats = (records) => {
    const ok = records.filter((r) => !r.error)
    const out = {}
    const add = (name, f) => {
        const s = stats(ok.map(f))
        if (s) out[name] = s
    }
    for (const sc of ["select25", "select300"]) {
        const rs = ok.filter((r) => r.scenario === sc)
        if (rs.length === 0) continue
        const sub = (name, f) => {
            const s = stats(rs.map(f))
            if (s) out[`${sc}.${name}`] = s
        }
        sub("buildMs", (r) => r.times.buildMs)
        sub("firstTileMs", (r) => r.times.firstTileMs)
        sub("settledMs", (r) => r.times.settledMs)
        sub("totalMs", (r) => r.times.totalMs)
        sub("pageToSelectMs", (r) => r.times.pageToSelectMs)
        sub("layerRequests", (r) => r.phases.select.layerRequests)
        sub("workerRequests", (r) => r.phases.select.workerRequests)
        sub("layerMB", (r) => MB(r.phases.select.layerBytes))
        sub("layerFetchMaxMs", (r) => r.phases.select.layerFetchMaxMs)
        sub("tilesBuilt", (r) => r.phases.select.tilesBuilt)
    }
    const ws = ok.filter((r) => r.scenario === "walk")
    if (ws.length > 0) {
        const sub = (name, f) => {
            const s = stats(ws.map(f))
            if (s) out[`walk.${name}`] = s
        }
        sub("selectBuildMs", (r) => r.times.selectBuildMs)
        sub("walkSteppedMs", (r) => r.times.walkSteppedMs)
        sub("walkEntryMs", (r) => r.times.walkEntryMs)
        sub("entryTilesBuilt", (r) => r.phases.entry.tilesBuilt)
        sub("selectLayerRequests", (r) => r.phases.select.layerRequests)
        sub("selectWorkerRequests", (r) => r.phases.select.workerRequests)
        sub("entryLayerRequests", (r) => r.phases.entry.layerRequests)
        const steps = Math.max(0, ...ws.map((r) => r.teleport?.steps.length ?? 0))
        for (let k = 1; k <= steps; k++) {
            sub(`teleport${k}Ms`, (r) => r.teleport?.steps[k - 1]?.ms)
            sub(`teleport${k}LayerRequests`, (r) => r.teleport?.steps[k - 1]?.layerRequests)
            sub(`teleport${k}FetchMaxMs`, (r) => r.teleport?.steps[k - 1]?.layerFetchMaxMs)
        }
        if (steps > 0) {
            add("walk.teleportTotalMs", (r) => (r.scenario === "walk" ? (r.teleport?.steps ?? []).reduce((s, x) => s + x.ms, 0) : null))
            add("walk.teleportLayerRequests", (r) => (r.scenario === "walk" ? (r.teleport?.steps ?? []).reduce((s, x) => s + x.layerRequests, 0) : null))
            const all = stats(ws.flatMap((r) => (r.teleport?.steps ?? []).map((s) => s.ms)))
            if (all) out["walk.teleportAllStepsMs"] = all
        }
    }
    // (e) 큰 선택(340도엽) 뒤 둘러보기 진입: 계단형으로 전부 다시 만든다. 결과 캐시 상한(64)이 생기면 밀려난 레이어를 새로 만들게 되는 경로
    const w3 = ok.filter((r) => r.scenario === "walk300")
    if (w3.length > 0) {
        const sub = (name, f) => {
            const s = stats(w3.map(f))
            if (s) out[`walk300.${name}`] = s
        }
        sub("selectBuildMs", (r) => r.times.selectBuildMs)
        sub("walkSteppedMs", (r) => r.times.walkSteppedMs)
        sub("walkEntryMs", (r) => r.times.walkEntryMs)
        sub("entryTilesBuilt", (r) => r.phases.entry.tilesBuilt)
        sub("entryLayerRequests", (r) => r.phases.entry.layerRequests)
        for (const k of ["terrain", "buildings", "roads", "water", "forest"]) sub(`entryCacheHits.${k}`, (r) => r.phases.entry.cacheHits?.[k])
    }
    return out
}

/** 콘솔 오류·경고를 시나리오별로 같은 문구끼리 센다(숫자는 # 으로 바꿔 묶는다) */
const problemSummary = (records) => {
    const out = {}
    for (const r of records) {
        const all = [...(r.problems ?? [])]
        out[r.scenario] ??= {}
        for (const p of all) {
            const key = `[${p.type}] ${p.text.replace(/\d+(\.\d+)?/g, "#").slice(0, 200)}`
            out[r.scenario][key] = (out[r.scenario][key] ?? 0) + 1
        }
    }
    return out
}

const fmt = (s) => (s ? `${s.median} | ${s.min} | ${s.max}` : "– | – | –")

const summaryMarkdown = (result) => {
    const lines = []
    lines.push(`# perf-check ${result.createdAt}`, "")
    lines.push(`- 브라우저 ${result.browser.name} ${result.browser.version}, 창 ${result.size.width}×${result.size.height}, dpr ${result.dpr}, HTTP 캐시 ${result.http}, 실행 ${result.runs}회(실행마다 새 브라우저), stable ${result.stable} ms`)
    lines.push(`- 커밋 ${result.git.head}${result.git.dirtySrc ? " (작업 트리 src 변경 있음)" : ""}, dist 해시 ${result.git.dist}(index.js·두 워커), 서버 ${result.base}`)
    lines.push(`- bbox25 ${result.bbox25}, bbox300 ${result.bbox300}, 순간 이동 ${result.teleport.steps} × ${result.teleport.stepM} m, 방향 ${result.teleport.bearing}°`, "")
    lines.push("| 지표 | 중앙값 | 최소 | 최대 |", "| --- | --- | --- | --- |")
    for (const [name, s] of Object.entries(result.stats)) lines.push(`| ${name} | ${fmt(s)} |`)
    lines.push("", "## 시나리오 끝 메모리(MB, 실행별)", "")
    lines.push("| 시나리오 | 실행 | 도엽(밖) | live/받은 5K | 데이터 파일 | JSON | 5K 목록 | 도엽 결과 | ttp · TIN | 메인 사본 | GPU | 메인 힙 |")
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for (const r of result.records) {
        const rows = r.scenario === "walk" ? [["walk(c) 진입", r.memory?.entry], ["walk(d) 이동 끝", r.memory?.teleportEnd]] : r.scenario === "walk300" ? [["walk300(e) 진입", r.memory?.entry]] : [[r.scenario, r.memory]]
        for (const [label, m] of rows) {
            if (!m) continue
            lines.push(`| ${label} | ${r.run} | ${m.loaded}(${m.extra}) | ${m.live5k}/${m.fetched5k} | ${m.dataFilesMB} | ${m.jsonMB} | ${m.listsMB} | ${m.resultsMB} | ${m.ttpMB} · ${m.tinMB} | ${m.mainTilesMB} | ${m.gpuMB} | ${m.mainHeapMB} |`)
        }
    }
    lines.push("", "## 콘솔 오류·경고(시나리오별, 숫자는 #)", "")
    for (const [sc, items] of Object.entries(result.problems)) {
        const entries = Object.entries(items)
        lines.push(`- ${sc}: ${entries.length === 0 ? "없음" : ""}`)
        for (const [k, n] of entries) lines.push(`  - ${n}회 ${k}`)
    }
    const failed = result.records.filter((r) => r.error)
    if (failed.length) lines.push("", "## 실패한 실행", "", ...failed.map((r) => `- ${r.scenario} #${r.run}: ${r.error}`))
    return lines.join("\n") + "\n"
}

const run = async (args) => {
    await mkdir(args.out, { recursive: true })
    const git = (() => {
        try {
            return { head: execSync("git rev-parse --short HEAD").toString().trim(), dirtySrc: execSync("git status --porcelain -- src").toString().trim() !== "" }
        } catch {
            return { head: null, dirtySrc: null }
        }
    })()
    // 실제로 잰 빌드: 서버가 내주는 dist 의 앱·워커 번들 해시(src 를 고치고 빌드하지 않았으면 커밋과 다를 수 있다)
    const hash = createHash("sha1")
    for (const f of ["index.js", "terrainTiles.worker.js", "terrainTileBuild.worker.js"]) hash.update(await readFile(path.join("dist", f)).catch(() => Buffer.from("")))
    git.dist = hash.digest("hex").slice(0, 12)
    const browserInfo = { value: null }
    const records = []
    for (let i = 1; i <= args.runs; i++) {
        for (const scenario of args.scenarios) records.push(await runOnce(scenario, i, args, browserInfo))
    }
    const result = {
        createdAt: new Date().toISOString(),
        browser: browserInfo.value,
        base: args.base,
        size: args.size,
        dpr: args.dpr,
        http: args.http,
        runs: args.runs,
        stable: args.stable,
        bbox25: args.bbox25,
        bbox300: args.bbox300,
        teleport: { steps: args.steps, stepM: args.stepM, bearing: args.bearing },
        git,
        stats: null,
        problems: null,
        records: records.map((r) => r),
    }
    result.stats = metricStats(records)
    result.problems = problemSummary(records)
    await writeFile(path.join(args.out, "results.json"), JSON.stringify(result, null, 2))
    await writeFile(path.join(args.out, "summary.md"), summaryMarkdown(result))
    console.log(`끝. ${records.length}회, ${path.join(args.out, "results.json")}, summary.md`)
    for (const [name, s] of Object.entries(result.stats)) console.log(`${name}: 중앙값 ${s.median} (최소 ${s.min}, 최대 ${s.max}, n ${s.n})`)
}

/** 두 결과의 같은 지표 중앙값을 견준다(시간 지표는 + 가 느려짐). 판정은 하지 않고 10 % 넘게 느려진 시간 지표에 표시만 한다 */
const compare = async (args) => {
    const [beforeDir, afterDir] = args.compare
    const before = JSON.parse(await readFile(path.join(beforeDir, "results.json"), "utf8"))
    const after = JSON.parse(await readFile(path.join(afterDir, "results.json"), "utf8"))
    const envA = `${before.browser?.name} ${before.browser?.version} ${before.size?.width}x${before.size?.height}@${before.dpr} http ${before.http ?? "cold"}`
    const envB = `${after.browser?.name} ${after.browser?.version} ${after.size?.width}x${after.size?.height}@${after.dpr} http ${after.http ?? "cold"}`
    if (envA !== envB) throw new Error(`환경이 달라 비교하지 않습니다: before ${envA}, after ${envB}`)
    const rows = []
    for (const [name, b] of Object.entries(before.stats)) {
        const a = after.stats[name]
        if (!a) continue
        const change = b.median === 0 ? null : (a.median - b.median) / b.median
        // 받기 시간(FetchMaxMs)은 흔들림 원인을 가르는 진단값(warm 에서 몇 ms)이라 표시하지 않는다
        const slower = name.endsWith("Ms") && !name.includes("Fetch") && change !== null && change > 0.1
        rows.push({ name, before: b, after: a, change, slower })
        console.log(`${name}: ${b.median} → ${a.median}${change === null ? "" : ` (${change >= 0 ? "+" : ""}${(change * 100).toFixed(1)} %)`}${slower ? "  ← 10 % 넘게 느림" : ""}  [전 ${b.min}–${b.max}, 후 ${a.min}–${a.max}]`)
    }
    await writeFile(path.join(afterDir, "perf-compare.json"), JSON.stringify({ createdAt: new Date().toISOString(), before: beforeDir, after: afterDir, env: envB, rows }, null, 2))
    console.log(`끝. ${path.join(afterDir, "perf-compare.json")}`)
}

/**
 * 여러 결과 폴더(같은 환경에서 --runs 1 로 전·후를 번갈아 잰 것)의 실행 기록을 이어 붙여 통계·요약을 다시 낸다(2026-10-23 C6).
 * --merge <폴더1,폴더2,…> --out <폴더>. 실행 번호는 이어 붙인 순서로 다시 매긴다. 환경(브라우저·창·dpr·http·서버)이 다르면 거부
 */
const merge = async (args) => {
    const parts = []
    for (const dir of args.merge) parts.push({ dir, result: JSON.parse(await readFile(path.join(dir, "results.json"), "utf8")) })
    const env = (r) => `${r.browser?.name} ${r.browser?.version} ${r.size?.width}x${r.size?.height}@${r.dpr} http ${r.http} ${r.base}`
    for (const p of parts) if (env(p.result) !== env(parts[0].result)) throw new Error(`환경이 달라 합치지 않습니다: ${p.dir} (${env(p.result)}) ↔ ${env(parts[0].result)}`)
    const records = []
    const runOf = new Map()
    for (const p of parts)
        for (const r of p.result.records) {
            const key = `${p.dir}#${r.run}`
            if (!runOf.has(key)) runOf.set(key, runOf.size + 1)
            records.push({ ...r, run: runOf.get(key), mergedFrom: p.dir })
        }
    await mkdir(args.out, { recursive: true })
    const result = { ...parts[0].result, createdAt: new Date().toISOString(), runs: runOf.size, mergedFrom: args.merge, records }
    result.stats = metricStats(records)
    result.problems = problemSummary(records)
    await writeFile(path.join(args.out, "results.json"), JSON.stringify(result, null, 2))
    await writeFile(path.join(args.out, "summary.md"), summaryMarkdown(result))
    console.log(`합침: ${parts.length}개 폴더, 실행 ${runOf.size}회, 기록 ${records.length} → ${path.join(args.out, "results.json")}`)
}

const main = async () => {
    const args = parseArgs(process.argv.slice(2))
    if (args.mode === "compare") await compare(args)
    else if (args.mode === "merge") await merge(args)
    else await run(args)
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
