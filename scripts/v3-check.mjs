#!/usr/bin/env node
/**
 * 캐시 리팩토링 V3 동작 시나리오(docs/cache-refactor-plan.md 6절 V3, src/webgpu/VERIFY.md 4·6·7절). 2026-10-23 C6.
 *
 * 같은 서버(dist-static 3000)가 내주는 두 빌드 — 전(--before-base, 기본 http://localhost:3000/before: 리팩토링 전 커밋을 빌드해 dist/before 에 둔 것)과
 * 후(--after-base, 기본 http://localhost:3000) — 에서 같은 단계를 밟아, 정해 둔 자리(체크포인트)마다 캡처(PNG, dpr 2)·memory()·콘솔 오류/경고를 남기고
 * 전 ↔ 후와 빌드 안의 짝(돌아온 자리 ↔ 처음 등)을 비교한다. R2 CORS 가 http://localhost:3000 출처만 허용하므로 두 빌드를 같은 서버의 다른 경로로 낸다.
 * Playwright 는 render-check·perf-check 와 같이 설치된 Chrome 을 보이는 창·임시 프로필로 띄우는 데만 쓴다(시나리오·빌드마다 새 브라우저,
 * 페이지마다 새 컨텍스트라 HTTP·워커·앱 캐시는 매번 빈 상태). 단계·판정·기록은 이 스크립트가 한다.
 * 기다림은 perf-check 와 같다: 디버그 페이지 속성(data-busy·data-debug-state·data-walk-tiles)과 보조 워커 도엽 로그가 --stable ms 조용하고 busy 0 →
 * window.__asrbbtDebug.memory() 로 조정자 쉼(running false·pending 0)을 두 번(사이 --stable 동안 새 활동 없음) → --settle 뒤 캡처.
 *
 * 시나리오(--scenarios 로 고름)
 *   s1 multi-select   강남 도심 → 북한산 → 남해안 → 소양호 → 광릉숲 → 강남 다시, select() 로 차례로(궤도 보기, orbitz 는 지역마다 해시로)
 *   s2 walk-far-back  한강 여의도 둘러보기 → teleport 동쪽 1 km × 10 → 처음 자리로. 처음·5 km·10 km·돌아온 뒤
 *   s3 large-walk     도심 340도엽(perf-check BBOX_300) 궤도 보기 → 둘러보기 진입(보조 워커 몫 > 64 → 결과 층 재생성). 진입 도엽 로그의 층별 "(캐시)" 수
 *   s4 layer-toggle   둘러보기(여의도: 건물·도로·물, 남산: 산림·건물)에서 Esc 로 포커스를 풀고 레이어 패널 "보기" 를 끄고 켬
 *   s6 fetch-fail     route abort — a 도로 5K 37608087.rds, b 물 50K 인덱스 37608.json, c 건물 codes.json, d 물 50K 인덱스 + 물 codes.json.
 *                     여의도 궤도 보기 → 둘러보기. 콘솔 오류·경고 문구·수를 전 ↔ 후로
 *   s7 rapid-reselect 녹사평에서 select(여의도) 직접 / select(소양호) 곧바로 select(여의도) / 소양호 도엽 3장 뒤 select(여의도). 끝 캡처·지문을 직접과 비교
 *   (s5 디버그 파라미터는 render-check 로 찍는다: docs/render-checks/2026-10-23-cache-v3/run.sh)
 *   V5 메모리(--builds after 로): m1 도심 여의도 → 동북동 1 km × 11, m2 산림 소양호 → 7 km, m3 선택 다섯(1.2절과 같은 경로·bbox), 걸음·선택마다 memory().
 *   m4 일부 겹치는 범위 다시 선택 때 상태 표시줄 "지형 받는 중 k / N" 이 N 에 닿는지 + 산림 레이어 패널 문구.
 *   표는 --memory-summary <out>(memory-summary.md·json)
 *
 * 비교(--compare <out>): 체크포인트 이름이 같은 PNG 를 전 ↔ 후로 짝지어 render-check 와 같은 마스크(+ 파라미터 표 0,0,400,200)를 칠하고 pixelmatch
 * (안티앨리어싱 제외)로 다른 픽셀 비율을 임계값 0.1·0.01 두 번 잰다. 판정(계획서 6절 V2 규칙): 둘러보기 = 둘 다 ≤ 0.1 %, 궤도 보기 = 0.1 에서 ≤ 0.1 %
 * (산림 장면은 0.01 도). 빌드 안 짝은 시나리오에 적은 기대(같음/다름)와 견주고, 지문(원점·메인 도엽 수와 바이트·조정자 loaded·live5k·GPU)도 같은지 본다.
 * 콘솔 문제는 숫자를 # 로, "TypeError: Failed to fetch" 를 "Error: Failed to fetch" 로(받아들인 문구 변화) 바꿔 묶어 센다.
 *
 * 사용(fb_web 에서. 서버는 dist-static 이 떠 있고 dist/ = 후, dist/before/ = 전 빌드):
 *   node scripts/v3-check.mjs --out docs/render-checks/2026-10-23-cache-v3 [--scenarios s1,s2] [--builds before,after]
 *     [--before-base http://localhost:3000/before] [--after-base http://localhost:3000] [--size 878x946] [--dpr 2] [--stable 2000] [--settle 1000]
 *     [--timeout 600000] [--browser chrome|chromium]
 *   node scripts/v3-check.mjs --compare docs/render-checks/2026-10-23-cache-v3 [--scenarios …]
 * 결과: <out>/<build>/<시나리오>/{<체크포인트>.png, index.json(render-check 형식이라 render-check --compare 로도 견줄 수 있음), run.json(memory·지문·콘솔·요청),
 *       <페이지>console.log}. 비교는 <out>/compare.json·summary.md·diff/<시나리오>/*.png
 */
import { mkdir, readFile, writeFile, access } from "node:fs/promises"
import path from "node:path"
import { chromium } from "playwright"
import pixelmatch from "pixelmatch"
import { PNG } from "pngjs"

/** 장면 bbox(EPSG:3857) */
const BBOX = {
    /** 녹사평(VERIFY 기준 세트, 5K 하나 37608090, 도엽 6) */
    base: [14135700, 4513980, 14136500, 4514780],
    /** 한강 여의도(물, 도엽 25, 5K 37608087·088·097·098) */
    hangang: [14127729, 4511702, 14130234, 4514248],
    /** 소양호(물 호소, 도엽 30, 5K 37704025·026·035·036) */
    soyang: [14232497, 4567899, 14235040, 4570432],
    /** 남산 북사면(산림, 도엽 12, 5K 37608080) */
    namsan: [14135255, 4516175, 14136775, 4517702],
    /** 도심 340도엽(perf-check BBOX_300, 여의도·용산·마포·중구) */
    big: [14128200, 4509700, 14138800, 4520300],
    /** 강남 테헤란로(127.049, 37.5045) 둘레 2.8 km 사각형 */
    gangnam: [14141630, 4508263, 14144430, 4511063],
    /** 북한산 백운대(126.9779, 37.6588) 둘레 2.8 km */
    bukhansan: [14133715, 4529937, 14136515, 4532737],
    /** 남해안 34616026 둘레(VERIFY 산림 장면을 2.8 km 로 넓힘) */
    namhae: [14123824, 4051879, 14126624, 4054679],
    /** 광릉숲(127.1636, 37.7486) 둘레 2.8 km */
    gwangneung: [14154387, 4542572, 14157187, 4545372],
}
const bboxParam = (b) => `bbox=${b.join(",")}`
const LAYERS = "https://layers.asrbbt.world"

/**
 * 빌드 안에서 견줄 짝(시나리오별). expect "same" 이면 같아야 하고, "different" 는 비교가 무뎌지지 않았는지 보는 재검증 쌍.
 * fingerprint true 면 지문(원점·메인 도엽 수와 바이트·loaded·live5k·GPU)도 같아야 한다
 */
const INTRA_PAIRS = {
    s1: [{ a: "sel1-gangnam", b: "sel6-gangnam-again", expect: "same", fingerprint: true }],
    s2: [{ a: "start", b: "return", expect: "same", fingerprint: true }],
    s4: [
        ...["buildings", "roads", "water"].flatMap((l) => [
            { a: "hangang-initial", b: `hangang-${l}-on`, expect: "same", fingerprint: true },
            { a: "hangang-initial", b: `hangang-${l}-off`, expect: "different" },
        ]),
        ...["forest", "buildings"].flatMap((l) => [
            { a: "namsan-initial", b: `namsan-${l}-on`, expect: "same", fingerprint: true },
            { a: "namsan-initial", b: `namsan-${l}-off`, expect: "different" },
        ]),
    ],
    s7: [
        { a: "direct-B", b: "rapid0-B", expect: "same", fingerprint: true },
        { a: "direct-B", b: "rapidmid-B", expect: "same", fingerprint: true },
    ],
}

const parseArgs = (argv) => {
    const args = {
        mode: "run",
        out: null,
        compareDir: null,
        scenarios: ["s1", "s2", "s3", "s4", "s6", "s7"],
        builds: ["before", "after"],
        bases: { before: "http://localhost:3000/before", after: "http://localhost:3000" },
        size: { width: 878, height: 946 },
        dpr: 2,
        stable: 2000,
        settle: 1000,
        timeout: 600000,
        browser: "chrome",
    }
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i]
        const take = () => {
            const value = argv[++i]
            if (value === undefined) throw new Error(`${key} 에 값이 없습니다`)
            return value
        }
        switch (key) {
            case "--out": args.out = take(); break
            case "--compare": args.mode = "compare"; args.compareDir = take(); break
            case "--memory-summary": args.mode = "memory"; args.memDir = take(); break
            case "--scenarios": args.scenarios = take().split(",").map((s) => s.trim()); break
            case "--builds": args.builds = take().split(",").map((s) => s.trim()); break
            case "--before-base": args.bases.before = take().replace(/\/$/, ""); break
            case "--after-base": args.bases.after = take().replace(/\/$/, ""); break
            case "--size": {
                const m = /^(\d+)x(\d+)$/.exec(take())
                if (!m) throw new Error("--size 형식 오류(예: 878x946)")
                args.size = { width: Number(m[1]), height: Number(m[2]) }
                break
            }
            case "--dpr": args.dpr = Number(take()); break
            case "--stable": args.stable = Number(take()); break
            case "--settle": args.settle = Number(take()); break
            case "--timeout": args.timeout = Number(take()); break
            case "--browser": args.browser = take(); break
            case "--help": case "-h": console.log("사용법은 파일 상단 주석 참고"); process.exit(0)
            default: throw new Error(`모르는 옵션 ${key}`)
        }
    }
    for (const s of args.scenarios) if (!SCENARIOS[s]) throw new Error(`모르는 시나리오 ${s}`)
    for (const b of args.builds) if (!args.bases[b]) throw new Error(`모르는 빌드 ${b}(before·after)`)
    if (args.mode === "run" && !args.out) args.out = path.join("docs", "render-checks", `${new Date().toISOString().slice(0, 10)}-cache-v3`)
    return args
}

// ---- 브라우저·페이지 (render-check·perf-check 와 같은 실행 옵션·기록기) ----

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

/** 페이지 안 기록기(perf-check 와 같음): 디버그 페이지 속성이 바뀐 시각과 궤도·둘러보기 HUD 가 처음 보인 시각을 window.__perf 에 */
const recorder = () => {
    const perf = { ev: [], hud: {}, status: [], navStart: performance.timeOrigin }
    window.__perf = perf
    const now = () => performance.timeOrigin + performance.now()
    let last = null
    let lastStatus = null
    const check = () => {
        // 상태 표시줄 진행 문구("지형 받는 중 k / N" 등). m4 가 k 가 N 까지 가는지 본다
        const st = document.querySelector('.ui-statusbar [role="status"]')?.textContent ?? null
        if (st !== lastStatus && !/프레임/.test(st ?? "") && perf.status.length < 5000) {
            lastStatus = st
            perf.status.push({ t: now(), text: st })
        }
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
        characterData: true,
        attributes: true,
        attributeFilter: ["data-busy", "data-debug-state", "data-walk-tiles"],
    })
}

/** 보조 워커의 도엽 완성 로그(perf-check 와 같은 모양). 1 = 도엽 id, 2 = "(밖)" */
const TILE_LOG = /^도엽 ([^\s:(]+)(\(밖\))?: /
/** 도엽 로그의 층별 "캐시에서 꺼냄"(perf-check cacheFlags 와 같음) */
const cacheFlags = (text) => ({
    terrain: /^도엽 [^\s:]+: 캐시 /.test(text),
    buildings: /건물 \d+\(캐시\)/.test(text),
    roads: /도로 \d+\([^)]*\)\(캐시\)/.test(text),
    water: /물 \d+\([^)]*\)\(캐시\)/.test(text),
    forest: /산림 \d+(\(건너뜀 \d+\))? \(캐시\)/.test(text),
    // 녹지(osm_green G7 2026-11-08)는 도엽 나누기를 캐시하지 않는다(계획서 2.3절: tinCache 는 나누기 전 TIN, 나누기는 매번). 5K 전처리 캐시는
    // 로그에 표시가 없어 memory() 캐시 표 result.osm_green 의 hits 로 본다. 그래서 여기서는 "녹지로 나눈 도엽" 만 센다(캐시 적중이 아님)
    osmGreen: /, 녹지 5K \d+\(전처리 합 [\d.]+ms\) 받기 \d+ms 분할 \d+→\d+/.test(text),
})

/** lock=0·look=0 을 붙인다(render-check 와 같은 이유: 자동화에서는 포인터 잠금을 못 쓰고, 보이는 창 위의 실제 마우스가 시점을 돌리면 안 된다) */
const withLockOff = (query) => {
    const q = new URLSearchParams(query)
    if (!q.has("lock")) q.set("lock", "0")
    if (!q.has("look")) q.set("look", "0")
    return q.toString()
}

/**
 * 페이지 하나(새 컨텍스트)를 연다. routes 의 URL 은 abort 한다(받기 실패 시나리오). 콘솔·오류·실패한 요청·도엽 로그를 시각과 함께 모은다
 *
 * @returns 세션(s). 단계 함수들이 받는다
 */
const openSession = async (browser, args, { base, dir, prefix, routes = [] }) => {
    const context = await browser.newContext({ viewport: args.size, deviceScaleFactor: args.dpr })
    await context.addInitScript(recorder)
    const s = { args, base, dir, prefix, context, page: null, query: null, url: null, consoleLines: [], problems: [], tileLogs: [], aborted: [], failed: [], checkpoints: [], marks: {}, error: null, routes }
    for (const url of routes) {
        await context.route(url, (route) => {
            s.aborted.push({ t: Date.now(), url: route.request().url() })
            return route.abort()
        })
    }
    const page = await context.newPage()
    s.page = page
    page.on("console", (msg) => {
        const t = Date.now()
        const text = msg.text()
        const type = msg.type()
        const source = msg.location()?.url?.split("/").pop() ?? ""
        s.consoleLines.push(`${new Date(t).toISOString()} [${type}] (${source}) ${text}`)
        if (type === "error" || type === "warning") s.problems.push({ t, type, source, text })
        const m = TILE_LOG.exec(text)
        if (m) s.tileLogs.push({ t, id: m[1], extra: !!m[2], cached: cacheFlags(text) })
    })
    page.on("pageerror", (err) => {
        const t = Date.now()
        s.consoleLines.push(`${new Date(t).toISOString()} [pageerror] ${String(err)}`)
        s.problems.push({ t, type: "pageerror", source: "", text: String(err) })
    })
    page.on("requestfailed", (req) => s.failed.push({ t: Date.now(), url: req.url(), error: req.failure()?.errorText ?? "failed" }))
    return s
}

/** 세션을 닫고 기록(페이지 객체 뺀 것)을 돌려준다. 콘솔 전체는 <prefix>console.log 로 */
const closeSession = async (s) => {
    await writeFile(path.join(s.dir, `${s.prefix}console.log`), s.consoleLines.join("\n"))
    await s.context.close().catch(() => {})
    const { args, context, page, consoleLines, ...rest } = s
    return { ...rest, consoleCount: consoleLines.length }
}

const goto = async (s, query) => {
    s.query = withLockOff(query)
    s.url = `${s.base}/#/debug/walk?${s.query}`
    await s.page.goto(s.url)
}
/** 해시만 바꾼다(새로고침 없음). 렌더 디버그 설정(orbitz 등)이 바뀌고 프리셋(bbox·yaw…)은 처음 것 그대로다 */
const setQuery = async (s, query) => {
    s.query = withLockOff(query)
    s.url = `${s.base}/#/debug/walk?${s.query}`
    await s.page.evaluate((q) => {
        location.hash = `#/debug/walk?${q}`
    }, s.query)
    await s.page.waitForTimeout(300)
}
const events = (s) => s.page.evaluate(() => window.__perf.ev)
const memory = (s) => s.page.evaluate(() => window.__asrbbtDebug.memory())
/** from 이후 마지막 활동(속성 변화·도엽 로그) 시각 */
const lastActivity = (s, ev, from) => {
    let at = from
    for (const e of ev) if (e.t >= from && e.t > at) at = e.t
    for (const l of s.tileLogs) if (l.t >= from && l.t > at) at = l.t
    return at
}

/**
 * 멈출 때까지 기다린다(perf-check waitQuiet 와 같음): 마지막 활동 뒤 stable ms 조용 + busy 0 → memory() 로 조정자 쉼을 두 번
 *
 * @returns { at, mem, timedOut }
 */
const waitQuiet = async (s, from) => {
    const { stable, timeout } = s.args
    const deadline = Date.now() + timeout
    let firstIdle = null
    while (Date.now() < deadline) {
        const ev = await events(s)
        const lastEv = ev.at(-1)
        const at = lastActivity(s, ev, from)
        if (lastEv?.busy === "0" && Date.now() - at >= stable && !(firstIdle?.at === at && Date.now() - firstIdle.time < stable)) {
            const mem = await memory(s)
            const c = mem.workers.coordinator
            const idle = !c.running && c.pending === 0
            const atAfter = lastActivity(s, await events(s), from)
            if (idle && atAfter === at && firstIdle?.at === at) return { at, mem, timedOut: false }
            firstIdle = idle && atAfter === at ? { at, time: Date.now() } : null
        }
        await s.page.waitForTimeout(200)
    }
    console.warn(`  (시간 초과: ${s.prefix})`)
    return { at: Date.now(), mem: await memory(s).catch(() => null), timedOut: true }
}

/** 주소의 bbox 로 범위 확정 → 첫 도엽(궤도 HUD) → busy 0 → 멈춤(궤도 보기) */
const waitOrbitReady = async (s) => {
    await s.page.waitForFunction(
        () => {
            const ev = window.__perf.ev
            const i = ev.findIndex((e) => e.busy === "1")
            return i >= 0 && ev.slice(i).some((e) => e.busy === "0") && !!window.__perf.hud.orbit
        },
        null,
        { timeout: s.args.timeout, polling: 100 },
    )
    const ev = await events(s)
    const i = ev.findIndex((e) => e.busy === "1")
    const tDone = ev.slice(i).find((e) => e.busy === "0").t
    return waitQuiet(s, tDone)
}
/** after 이후 둘러보기(walking)가 된 순간 → 멈춤(계단형 재생성·주변 도엽 스트리밍 끝) */
const waitWalkReady = async (s, after = 0) => {
    await s.page.waitForFunction((a) => window.__perf.ev.some((e) => e.t >= a && e.state === "walking"), after, { timeout: s.args.timeout, polling: 100 })
    const tWalk = (await events(s)).find((e) => e.t >= after && e.state === "walking").t
    const q = await waitQuiet(s, tWalk)
    return { tWalk, ...q }
}
/** 디버그 훅 select(bbox) 를 부르고 그 선택이 끝날 때까지(busy 1 → 0 → 멈춤). 반환 { tSel, tBusy, ...waitQuiet } */
const selectAndWait = async (s, bbox) => {
    const tSel = Date.now()
    await s.page.evaluate((b) => window.__asrbbtDebug.select(b), bbox)
    return waitSelected(s, tSel)
}
/**
 * tSel 에 부른 선택이 끝난 시각(busy 1 → 0). 부를 때 이미 busy 1 이면(앞 선택이 도는 중, s7 도중 재선택) 그 상태에서 시작해 처음 0 이 되는 때.
 * 반환 [busy 가 된 시각(이미 busy 면 tSel), 0 이 된 시각] 또는 null
 */
const selectionDone = (ev, t) => {
    let busy = false
    let tBusy = null
    for (const e of ev) {
        if (e.t < t) {
            busy = e.busy === "1"
            if (busy) tBusy = t
            continue
        }
        if (e.busy === "1") {
            if (!busy) tBusy = e.t
            busy = true
        } else if (busy && e.busy === "0") return [tBusy, e.t]
    }
    return null
}
const waitSelected = async (s, tSel) => {
    await s.page.waitForFunction(
        ([t, src]) => !!new Function(`return ${src}`)()(window.__perf.ev, t),
        [tSel - 50, selectionDone.toString()],
        { timeout: s.args.timeout, polling: 100 },
    )
    const [tBusy, tDone] = selectionDone(await events(s), tSel - 50)
    return { tSel, tBusy, ...(await waitQuiet(s, tDone)) }
}
/** 궤도 보기 가운데 "둘러보기" 알약을 눌러 들어간다 → 멈춤 */
const enterWalk = async (s) => {
    const t = Date.now()
    await s.page.getByRole("button", { name: "둘러보기", exact: true }).click()
    return waitWalkReady(s, t - 50)
}
/** 마우스를 캡처에 영향 없는 자리(왼쪽 가장자리 가운데)로. 독 버튼 hover 모양이 짝 비교에 끼지 않게 */
const parkMouse = (s) => s.page.mouse.move(4, Math.round(s.args.size.height / 2))

/** memory() → 지문(빌드 안 짝 비교용). 보고 형식이 빌드마다 달라 메인·조정자·GPU 의 공통 필드만 */
const fingerprint = (m) =>
    m && {
        origin: m.main?.origin ?? null,
        mainTiles: m.main?.tiles ?? null,
        loaded: m.workers?.coordinator?.loaded ?? null,
        extra: m.workers?.coordinator?.extra ?? null,
        live5k: [...(m.workers?.coordinator?.live5k ?? [])].map(String).sort(),
        gpu: m.gpu ?? null,
    }

/**
 * 체크포인트: settle 뒤 PNG 캡처·상태 표시줄·memory() 를 남긴다
 *
 * @param meta.mode "walk" | "orbit"(판정 규칙), meta.forest 산림 장면(0.01 도 봄)
 */
const checkpoint = async (s, name, meta) => {
    await s.page.waitForTimeout(s.args.settle)
    const fullName = `${s.prefix}${name}`
    const file = `${fullName}.png`
    await s.page.screenshot({ path: path.join(s.dir, file), type: "png" })
    const status = await s.page.evaluate(() => document.querySelector(".ui-statusbar")?.textContent?.trim() ?? "")
    const mem = await memory(s).catch((err) => ({ error: String(err) }))
    s.checkpoints.push({
        name: fullName,
        file,
        size: s.args.size,
        dpr: s.args.dpr,
        params: s.query,
        url: s.url,
        mode: meta.mode,
        forest: !!meta.forest,
        status,
        t: Date.now(),
        fingerprint: fingerprint(mem),
        memory: mem,
        ...(meta.extra ?? {}),
    })
    const fp = fingerprint(mem)
    console.log(`  ${fullName}: 도엽 ${fp?.loaded}(밖 ${fp?.extra}), 5K ${fp?.live5k?.length}, 메인 ${fp?.mainTiles?.tiles}`)
}

/** 레이어 패널을 열어 "<이름> 보기" 를 on 으로 맞추고 닫는다(UI 경로) */
const setLayerVisible = async (s, label, on) => {
    const page = s.page
    await page.getByRole("button", { name: "레이어", exact: true }).click()
    const cb = page.getByRole("checkbox", { name: `${label} 보기`, exact: true })
    await cb.waitFor({ timeout: 10000 })
    if ((await cb.isChecked()) !== on) await cb.click()
    if ((await cb.isChecked()) !== on) throw new Error(`${label} 보기를 ${on ? "켜지" : "끄지"} 못했습니다`)
    await page.getByRole("button", { name: "레이어 패널 닫기", exact: true }).click()
    await parkMouse(s)
}

// ---- 시나리오 ----

/** 시나리오: run(ctx) 는 페이지를 열고(ctx.page(prefix, routes)) 단계를 밟는다 */
const SCENARIOS = {
    s1: {
        title: "범위 여러 번 선택(지역 다섯 + 처음 지역 다시)",
        run: async (ctx) => {
            const s = await ctx.page("")
            await goto(s, `${bboxParam(BBOX.gangnam)}&walk=0&orbitz=40`)
            await waitOrbitReady(s)
            await checkpoint(s, "sel1-gangnam", { mode: "orbit" })
            const steps = [
                ["sel2-bukhansan", BBOX.bukhansan, 450, true],
                ["sel3-namhae", BBOX.namhae, 50, true],
                ["sel4-soyang", BBOX.soyang, 250, true],
                ["sel5-gwangneung", BBOX.gwangneung, 150, true],
                ["sel6-gangnam-again", BBOX.gangnam, 40, false],
            ]
            for (const [name, bbox, z, forest] of steps) {
                await setQuery(s, `${bboxParam(BBOX.gangnam)}&walk=0&orbitz=${z}`)
                const r = await selectAndWait(s, bbox)
                s.marks[name] = { tSel: r.tSel, tBusy: r.tBusy, at: r.at, timedOut: r.timedOut }
                await checkpoint(s, name, { mode: "orbit", forest })
            }
        },
    },
    s2: {
        title: "멀리 걸었다가 처음 자리로(여의도 → 동쪽 1 km × 10 → 처음)",
        run: async (ctx) => {
            const s = await ctx.page("")
            await goto(s, `${bboxParam(BBOX.hangang)}&yaw=90&pitch=-15`)
            const entry = await waitWalkReady(s)
            const c = entry.mem.workers.coordinator
            const origin = entry.mem.main.origin
            const spawn = [c.walk[0] - origin[0], c.walk[1] - origin[1]]
            s.marks.spawn = spawn
            await checkpoint(s, "start", { mode: "walk" })
            const steps = []
            for (let k = 1; k <= 10; k++) {
                const target = [spawn[0] + k * 1000, spawn[1]]
                const t = Date.now()
                await s.page.evaluate(([x, y]) => window.__asrbbtDebug.teleport(x, y), target)
                const q = await waitQuiet(s, t)
                steps.push({ k, ms: Math.round(q.at - t), timedOut: q.timedOut, tiles: s.tileLogs.filter((l) => l.t >= t).length })
                if (k === 5 || k === 10) await checkpoint(s, `east${k}km`, { mode: "walk" })
            }
            const t = Date.now()
            await s.page.evaluate(([x, y]) => window.__asrbbtDebug.teleport(x, y), spawn)
            const q = await waitQuiet(s, t)
            steps.push({ k: "return", ms: Math.round(q.at - t), timedOut: q.timedOut, tiles: s.tileLogs.filter((l) => l.t >= t).length })
            s.marks.steps = steps
            await checkpoint(s, "return", { mode: "walk" })
        },
    },
    s3: {
        title: "큰 선택(340도엽) 뒤 둘러보기 진입",
        run: async (ctx) => {
            const s = await ctx.page("")
            await goto(s, `${bboxParam(BBOX.big)}&walk=0&orbitz=30&yaw=90&pitch=-15`)
            const sel = await waitOrbitReady(s)
            s.marks.select = { at: sel.at, timedOut: sel.timedOut, tilesBuilt: s.tileLogs.length }
            await checkpoint(s, "orbit", { mode: "orbit", forest: true })
            const w = await enterWalk(s)
            const logs = s.tileLogs.filter((l) => l.t >= w.tWalk)
            s.marks.entry = {
                ms: Math.round(w.at - w.tWalk),
                timedOut: w.timedOut,
                tilesBuilt: logs.length,
                extraBuilt: logs.filter((l) => l.extra).length,
                cacheHits: Object.fromEntries(["terrain", "buildings", "roads", "water", "forest", "osmGreen"].map((k) => [k, logs.filter((l) => l.cached[k]).length])),
            }
            await checkpoint(s, "walk", { mode: "walk", forest: true })
        },
    },
    s4: {
        title: "레이어 보기 끄고 켜기(레이어 패널)",
        run: async (ctx) => {
            // 여의도는 지표에 서면 강바닥(수면 아래)이라 물·도로가 안 보인다(2026-10-23 첫 실행: 끈 것과 0 %) → 80 m 공중 정지에서 내려다본다
            const scenes = [
                ["hangang", BBOX.hangang, "yaw=90&pitch=-35&hover=80", [["buildings", "건물"], ["roads", "도로"], ["water", "물"]], false],
                ["namsan", BBOX.namsan, "yaw=90&pitch=-15", [["forest", "산림"], ["buildings", "건물"]], true],
            ]
            for (const [scene, bbox, view, layers, forest] of scenes) {
                const s = await ctx.page(`${scene}-`)
                await goto(s, `${bboxParam(bbox)}&${view}`)
                await waitWalkReady(s)
                // lock=0 은 들어가자마자 포커스(흉내)라 독이 숨는다 → Esc 로 풀어 독을 보인다
                await s.page.keyboard.press("Escape")
                await s.page.waitForSelector("nav.ui-dock", { timeout: 10000 })
                await parkMouse(s)
                await checkpoint(s, "initial", { mode: "walk", forest })
                for (const [id, label] of layers) {
                    await setLayerVisible(s, label, false)
                    await checkpoint(s, `${id}-off`, { mode: "walk", forest })
                    await setLayerVisible(s, label, true)
                    await checkpoint(s, `${id}-on`, { mode: "walk", forest })
                }
            }
        },
    },
    s6: {
        title: "받기 실패(route abort)에서 경고·화면",
        run: async (ctx) => {
            const variants = [
                ["a-roads5k", [`${LAYERS}/roads/v1/37608/37608087.rds`]],
                ["b-water50k", [`${LAYERS}/water/index/v1/37608.json`]],
                ["c-buildings-codes", [`${LAYERS}/buildings/index/v1/codes.json`]],
                ["d-water50k-codes", [`${LAYERS}/water/index/v1/37608.json`, `${LAYERS}/water/index/v1/codes.json`]],
            ]
            for (const [name, routes] of variants) {
                const s = await ctx.page(`${name}-`, routes)
                await goto(s, `${bboxParam(BBOX.hangang)}&walk=0&orbitz=15&yaw=90&pitch=-15`)
                await waitOrbitReady(s)
                await checkpoint(s, "orbit", { mode: "orbit" })
                await enterWalk(s)
                await checkpoint(s, "walk", { mode: "walk" })
            }
        },
    },
    s7: {
        title: "빠른 재선택(앞 선택이 끝나기 전에 다음 선택)",
        run: async (ctx) => {
            const start = `${bboxParam(BBOX.base)}&walk=0&orbitz=15`
            // 직접: 녹사평 → 여의도
            {
                const s = await ctx.page("")
                await goto(s, start)
                await waitOrbitReady(s)
                const r = await selectAndWait(s, BBOX.hangang)
                s.marks.direct = { tSel: r.tSel, timedOut: r.timedOut, logsAfterB: tileIdsAfter(s, r.tSel) }
                await checkpoint(s, "direct-B", { mode: "orbit" })
            }
            // 곧바로: select(소양호); select(여의도) 를 같은 틱에
            {
                const s = await ctx.page("")
                await goto(s, start)
                await waitOrbitReady(s)
                const tSel = Date.now()
                await s.page.evaluate(([a, b]) => {
                    window.__asrbbtDebug.select(a)
                    window.__asrbbtDebug.select(b)
                }, [BBOX.soyang, BBOX.hangang])
                const r = await waitSelected(s, tSel)
                s.marks.rapid0 = { tSel, timedOut: r.timedOut, logsAfterB: tileIdsAfter(s, tSel) }
                await checkpoint(s, "rapid0-B", { mode: "orbit" })
            }
            // 도중: select(소양호) → 소양호 도엽 로그 3줄 → select(여의도)
            {
                const s = await ctx.page("")
                await goto(s, start)
                await waitOrbitReady(s)
                const tA = Date.now()
                await s.page.evaluate((a) => window.__asrbbtDebug.select(a), BBOX.soyang)
                const deadline = Date.now() + s.args.timeout
                while (s.tileLogs.filter((l) => l.t >= tA).length < 3 && Date.now() < deadline) await s.page.waitForTimeout(50)
                const aBefore = s.tileLogs.filter((l) => l.t >= tA).map((l) => l.id)
                const tB = Date.now()
                await s.page.evaluate((b) => window.__asrbbtDebug.select(b), BBOX.hangang)
                const r = await waitSelected(s, tB)
                s.marks.rapidmid = { tA, tB, aTilesBeforeB: aBefore, timedOut: r.timedOut, logsAfterB: tileIdsAfter(s, tB) }
                await checkpoint(s, "rapidmid-B", { mode: "orbit" })
            }
        },
    },
}
// ---- V5 메모리(계획서 6절 V5: 1.2절과 같은 경로·같은 훅) ----

/** 1.2절 B 의 선택 다섯(설계 계획서 19절 원자료 B-select.json 과 같은 bbox) */
const B_SELECTS = [
    ["gangnam", [14139900, 4507800, 14141500, 4509400]],
    ["bukhansan", [14134500, 4530800, 14136100, 4532400]],
    ["namhae", [14124252, 4052302, 14126196, 4054256]],
    ["haeundae", [14377400, 4185000, 14379000, 4186600]],
    ["soyang", [14232497, 4567899, 14235040, 4570432]],
]
const toMB = (b) => Math.round(((b ?? 0) / 1048576) * 10) / 10
/** memory()(후 형식, 캐시 표) → 1.2절 표의 열 + 스레드당 최대 개수(상한과 견줌)·밀려남 */
const summarizeMem = (m) => {
    const helpers = m?.workers?.helpers ?? []
    const c = m?.workers?.coordinator ?? {}
    const sumH = (pred) => helpers.reduce((s, h) => s + Object.entries(h.caches ?? {}).reduce((t, [k, v]) => t + (pred(k) ? v.bytes ?? 0 : 0), 0), 0)
    const maxCount = (k) => Math.max(0, ...helpers.map((h) => h.caches?.[k]?.count ?? 0))
    const json = (caches) => Object.entries(caches ?? {}).reduce((t, [k, v]) => t + (k.startsWith("index.") || k.startsWith("fixed.") ? v.bytes ?? 0 : 0), 0)
    const evictionsByKey = {}
    for (const h of helpers) for (const [k, v] of Object.entries(h.caches ?? {})) if (v.evictions) evictionsByKey[k] = (evictionsByKey[k] ?? 0) + v.evictions
    for (const [k, v] of Object.entries(c.caches ?? {})) if (v.evictions) evictionsByKey[`coordinator.${k}`] = v.evictions
    // 캐시 표 이름공간(서버 경로). 녹지는 file.osm_green(데이터 층)·result.osm_green(5K 전처리)·index.osm_green(50K 인덱스, 조정자)
    const layers = ["buildings", "roads", "water", "forest", "osm_green"]
    return {
        loaded: c.loaded,
        extra: c.extra,
        live5k: c.live5k?.length,
        fetched5k: c.fetched5k,
        fileMB: toMB(sumH((k) => k.startsWith("file.") && k !== "file.terrain")),
        resultMB: toMB(sumH((k) => k.startsWith("result.") && k !== "result.terrain")),
        resultByLayerMB: Object.fromEntries(layers.map((l) => [l, toMB(sumH((k) => k === `result.${l}`))])),
        fileByLayerMB: Object.fromEntries(layers.map((l) => [l, toMB(sumH((k) => k === `file.${l}`))])),
        ttpMB: toMB(sumH((k) => k === "file.terrain")),
        tinMB: toMB(sumH((k) => k === "result.terrain")),
        jsonMB: toMB(helpers.reduce((s, h) => s + json(h.caches), 0) + json(c.caches) + json(m?.main?.caches)),
        mainMB: toMB(m?.main?.tiles?.total),
        gpuMB: toMB(m?.gpu?.bytes),
        heapMB: toMB(m?.main?.heap),
        maxPerHelper: {
            fileLayer: Math.max(...layers.map((l) => maxCount(`file.${l}`))),
            ttp: maxCount("file.terrain"),
            result: Math.max(...["terrain", ...layers].map((l) => maxCount(`result.${l}`))),
        },
        indexMax: Math.max(0, ...Object.entries(c.caches ?? {}).filter(([k]) => k.startsWith("index.")).map(([, v]) => v.count)),
        evictions: Object.values(evictionsByKey).reduce((s, v) => s + v, 0),
        evictionsByKey,
    }
}
/** memory() 를 이름과 함께 남긴다(캡처 없음) */
const memMark = async (s, name, extra = {}) => {
    const mem = await memory(s)
    ;(s.marks.mem ??= []).push({ name, t: Date.now(), ...extra, mem })
    const m = summarizeMem(mem)
    console.log(`  ${s.prefix}${name}: 도엽 ${m.loaded}(밖 ${m.extra}), 5K ${m.live5k}/${m.fetched5k}, 파일 ${m.fileMB} · 결과 ${m.resultMB} · ttp ${m.ttpMB} · TIN ${m.tinMB} MB, 스레드당 최대 파일 ${m.maxPerHelper.fileLayer}·결과 ${m.maxPerHelper.result}·ttp ${m.maxPerHelper.ttp}, 밀려남 ${m.evictions}`)
}
/** 둘러보기 중 동북동(22.5°)으로 1 km 씩 steps 번(1.2절 A 경로). 걸음마다 멈춘 뒤 memory */
const walkRoute = async (s, entryMem, steps, bearing = 22.5) => {
    const c = entryMem.workers.coordinator
    const origin = entryMem.main.origin
    const spawn = [c.walk[0] - origin[0], c.walk[1] - origin[1]]
    const rad = (bearing * Math.PI) / 180
    s.marks.spawn = spawn
    for (let k = 1; k <= steps; k++) {
        const target = [spawn[0] + k * 1000 * Math.cos(rad), spawn[1] + k * 1000 * Math.sin(rad)]
        const t = Date.now()
        await s.page.evaluate(([x, y]) => window.__asrbbtDebug.teleport(x, y), target)
        const q = await waitQuiet(s, t)
        await memMark(s, `${k}km`, { ms: Math.round(q.at - t), timedOut: q.timedOut, tiles: s.tileLogs.filter((l) => l.t >= t).length })
    }
}
Object.assign(SCENARIOS, {
    m1: {
        title: "V5 도심: 여의도 25도엽 → 동북동 1 km × 11(1.2절 A 도심)",
        run: async (ctx) => {
            const s = await ctx.page("")
            await goto(s, `${bboxParam(BBOX.hangang)}&yaw=90&pitch=-15`)
            const entry = await waitWalkReady(s)
            await memMark(s, "0km")
            await walkRoute(s, entry.mem, 11)
            await checkpoint(s, "end", { mode: "walk" })
        },
    },
    m2: {
        title: "V5 산림: 소양호 30도엽 → 동북동 1 km × 7(1.2절 A 산림)",
        run: async (ctx) => {
            const s = await ctx.page("")
            await goto(s, `${bboxParam(BBOX.soyang)}&yaw=90&pitch=-15`)
            const entry = await waitWalkReady(s)
            await memMark(s, "0km")
            await walkRoute(s, entry.mem, 7)
            await checkpoint(s, "end", { mode: "walk", forest: true })
        },
    },
    m3: {
        title: "V5 선택 다섯: 강남 → 북한산 → 남해안 → 해운대 → 소양호(1.2절 B, 둘러보기 없음)",
        run: async (ctx) => {
            const s = await ctx.page("")
            await goto(s, "walk=0")
            await s.page.waitForFunction(() => !!window.__asrbbtDebug, null, { timeout: s.args.timeout })
            await s.page.waitForTimeout(2000)
            await memMark(s, "start")
            for (const [name, bbox] of B_SELECTS) {
                const r = await selectAndWait(s, bbox)
                await memMark(s, name, { ms: Math.round(r.at - r.tSel), timedOut: r.timedOut })
            }
        },
    },
    m4: {
        title: "진행 문구(일부 겹치는 범위 다시 선택)·산림 패널 문구",
        run: async (ctx) => {
            const s = await ctx.page("")
            await goto(s, `${bboxParam(BBOX.hangang)}&walk=0&orbitz=15`)
            await waitOrbitReady(s)
            // 동쪽으로 1250(3857, 약 1 km) 옮긴 범위: 5K 일부(지형 파일 ttp)는 캐시에 있고 일부는 새로 받는다
            const b = BBOX.hangang
            const shifted = [b[0] + 1250, b[1], b[2] + 1250, b[3]]
            const r = await selectAndWait(s, shifted)
            const st = (await s.page.evaluate(() => window.__perf.status)).filter((x) => x.t >= r.tSel - 50)
            const dl = st.map((x) => /지형 받는 중 (\d+) \/ (\d+)/.exec(x.text ?? "")).filter(Boolean).map((m) => [Number(m[1]), Number(m[2])])
            s.marks.progress = {
                texts: [...new Set(st.map((x) => x.text))].slice(0, 60),
                download: dl,
                total: dl.at(-1)?.[1] ?? null,
                maxDone: Math.max(0, ...dl.map((d) => d[0])),
                reachedN: dl.some(([d, n]) => d === n),
                fetched: s.tileLogs.length,
            }
            console.log(`  진행: 지형 받는 중 ${JSON.stringify(dl)} → N 도달 ${s.marks.progress.reachedN}`)
            await checkpoint(s, "reselect", { mode: "orbit" })
            // 산림 패널 문구(남산 산림)
            await setQuery(s, `${bboxParam(BBOX.hangang)}&walk=0&orbitz=150`)
            await selectAndWait(s, BBOX.namsan)
            await s.page.getByRole("button", { name: "레이어", exact: true }).click()
            const row = s.page.locator(".ui-layer-row", { hasText: "산림" })
            await row.waitFor({ timeout: 10000 })
            const note = row.locator(".ui-layer-note").first()
            s.marks.forestNote = { row: await row.innerText(), note: await note.innerText().catch(() => null), title: await note.getAttribute("title").catch(() => null) }
            console.log(`  산림 패널: ${JSON.stringify(s.marks.forestNote)}`)
            await checkpoint(s, "forest-panel", { mode: "orbit", forest: true })
            await s.page.getByRole("button", { name: "레이어 패널 닫기", exact: true }).click()
        },
    },
})

/**
 * m5 상한 확인용 도시 24곳(lon, lat). 1.2절 경로(m1–m3)로는 어느 층도 상한에 닿지 않아(2026-10-23: 스레드당 최대 파일 14/32·결과 42/64·ttp 18/64)
 * 서로 다른 50K·5K 를 많이 지나가게 작은 범위(약 1.6 km 3857)를 차례로 고른다
 */
const CAP_CITIES = [
    ["seoul", 126.978, 37.566], ["incheon", 126.705, 37.456], ["suwon", 127.029, 37.263], ["chuncheon", 127.73, 37.881],
    ["wonju", 127.92, 37.342], ["gangneung", 128.876, 37.752], ["cheongju", 127.489, 36.642], ["daejeon", 127.385, 36.351],
    ["cheonan", 127.152, 36.815], ["jeonju", 127.148, 35.824], ["gwangju", 126.853, 35.16], ["mokpo", 126.392, 34.812],
    ["suncheon", 127.487, 34.95], ["jinju", 128.108, 35.18], ["changwon", 128.681, 35.228], ["busan", 129.075, 35.18],
    ["ulsan", 129.311, 35.539], ["gyeongju", 129.224, 35.856], ["pohang", 129.343, 36.019], ["daegu", 128.601, 35.871],
    ["andong", 128.729, 36.568], ["gumi", 128.344, 36.12], ["chungju", 127.926, 36.991], ["sejong", 127.289, 36.48],
]
const lonLatBbox = (lon, lat, side = 1600) => {
    const R = 20037508.342789244
    const x = (lon * R) / 180
    const y = (Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) * R) / Math.PI
    return [x - side / 2, y - side / 2, x + side / 2, y + side / 2].map(Math.round)
}
SCENARIOS.m5 = {
    title: "V5 상한 확인: 도시 24곳을 차례로 선택(50K·5K 를 많이 지남)",
    run: async (ctx) => {
        const s = await ctx.page("")
        await goto(s, "walk=0")
        await s.page.waitForFunction(() => !!window.__asrbbtDebug, null, { timeout: s.args.timeout })
        await s.page.waitForTimeout(2000)
        for (const [name, lon, lat] of CAP_CITIES) {
            const r = await selectAndWait(s, lonLatBbox(lon, lat))
            await memMark(s, name, { ms: Math.round(r.at - r.tSel), timedOut: r.timedOut })
        }
    },
}

/** --memory-summary <dir>: <dir>/after/m1·m2·m3·m5/run.json 의 memory 기록을 표로(memory-summary.md·json) */
const memorySummary = async (args) => {
    const root = args.memDir
    const out = {}
    const md = [`# V5 메모리 ${new Date().toISOString()}`, "", "MB 는 보조 워커 셋 합(인덱스 JSON 은 메인·조정자 포함). 스레드당 최대 개수는 보조 워커 중 가장 많은 것(상한: 레이어 파일 32 · ttp 64 · 결과 64), 인덱스는 조정자 50K(상한 14)", ""]
    for (const sc of ["m1", "m2", "m3", "m5"]) {
        const file = path.join(root, "after", sc, "run.json")
        if (!(await exists(file))) continue
        const run = JSON.parse(await readFile(file, "utf8"))
        const marks = run.pages?.[0]?.marks?.mem ?? []
        const rows = marks.map((x) => ({ name: x.name, ms: x.ms ?? null, ...summarizeMem(x.mem) }))
        out[sc] = { title: SCENARIOS[sc].title, error: run.error, rows }
        md.push(`## ${sc} ${SCENARIOS[sc].title}`, "", "| 지점 | 도엽(밖) | live/받은 5K | 데이터 파일 | 도엽 결과 | ttp · TIN | 인덱스 JSON | 메인 사본 | GPU | 메인 힙 | 스레드당 최대 파일·결과·ttp / 인덱스 | 밀려남 |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
        for (const r of rows)
            md.push(`| ${r.name} | ${r.loaded}(${r.extra}) | ${r.live5k}/${r.fetched5k} | ${r.fileMB} | ${r.resultMB} | ${r.ttpMB} · ${r.tinMB} | ${r.jsonMB} | ${r.mainMB} | ${r.gpuMB} | ${r.heapMB} | ${r.maxPerHelper.fileLayer}·${r.maxPerHelper.result}·${r.maxPerHelper.ttp} / ${r.indexMax} | ${r.evictions} |`)
        const last = rows.at(-1)
        if (last) md.push("", `끝 레이어별(건물·도로·물·산림): 데이터 파일 ${Object.values(last.fileByLayerMB).join("·")}, 도엽 결과 ${Object.values(last.resultByLayerMB).join("·")}. 밀려남 ${JSON.stringify(last.evictionsByKey)}`, "")
        if (run.error) md.push(`실행 오류: ${run.error}`, "")
    }
    await writeFile(path.join(root, "memory-summary.json"), JSON.stringify(out, null, 2))
    await writeFile(path.join(root, "memory-summary.md"), md.join("\n") + "\n")
    console.log(md.join("\n"))
}

/** t 이후 도엽 로그의 id(50K 번호 앞 5자리별 수와 목록) */
const tileIdsAfter = (s, t) => {
    const ids = s.tileLogs.filter((l) => l.t >= t).map((l) => l.id)
    const by50k = {}
    for (const id of ids) by50k[id.slice(0, 5)] = (by50k[id.slice(0, 5)] ?? 0) + 1
    return { count: ids.length, by50k, ids }
}

// ---- 실행 ----

const run = async (args) => {
    for (const sc of args.scenarios) {
        for (const build of args.builds) {
            const dir = path.join(args.out, build, sc)
            await mkdir(dir, { recursive: true })
            const { browser, name } = await launchBrowser(args.browser)
            const browserInfo = { name, version: browser.version() }
            const sessions = []
            const started = Date.now()
            console.log(`${sc} ${build}(${args.bases[build]}) — ${SCENARIOS[sc].title}`)
            let error = null
            try {
                const ctx = {
                    page: async (prefix, routes = []) => {
                        const s = await openSession(browser, args, { base: args.bases[build], dir, prefix, routes })
                        sessions.push(s)
                        return s
                    },
                }
                await SCENARIOS[sc].run(ctx)
            } catch (err) {
                error = String(err?.stack ?? err)
                console.error(`${sc} ${build}: 실패 — ${error}`)
            }
            const records = []
            for (const s of sessions) records.push(await closeSession(s))
            await browser.close()
            const results = records.flatMap((r) => r.checkpoints.map(({ memory: _m, ...c }) => c))
            await writeFile(
                path.join(dir, "index.json"),
                JSON.stringify({ createdAt: new Date().toISOString(), browser: browserInfo, base: args.bases[build], stable: args.stable, settle: args.settle, scenario: sc, results }, null, 2),
            )
            await writeFile(
                path.join(dir, "run.json"),
                JSON.stringify({ createdAt: new Date().toISOString(), browser: browserInfo, base: args.bases[build], build, scenario: sc, ms: Date.now() - started, error, pages: records }, null, 2),
            )
            console.log(`  끝 ${Math.round((Date.now() - started) / 1000)} 초${error ? " (실패)" : ""}`)
        }
    }
}

// ---- 비교 ----

/** render-check DEFAULT_MASKS 와 같은 목록(CSS px) + 파라미터 표를 넓힌 0,0,400,200(계획서 V2 규칙) */
const MASKS = [
    ["c", 0, 560, 60],
    [0, 0, 400, 140],
    [-300, 0, 300, 470],
    [0, -44, Infinity, 44],
    ["c", "c", 560, 160],
    ["c", -110, 220, 70],
    [0, 0, 400, 200],
]
const maskRect = ([x, y, w, h], width, height, dpr) => {
    const pw = Math.min(width, Math.round(w * dpr))
    const ph = Math.min(height, Math.round(h * dpr))
    const x0 = x === "c" ? Math.round((width - pw) / 2) : x < 0 ? width + Math.round(x * dpr) : Math.round(x * dpr)
    const y0 = y === "c" ? Math.round((height - ph) / 2) : y < 0 ? height + Math.round(y * dpr) : Math.round(y * dpr)
    return [Math.max(0, x0), Math.max(0, y0), Math.min(width, x0 + pw), Math.min(height, y0 + ph)]
}
const imageCache = new Map()
/** PNG 를 읽어 마스크를 칠한다(두 이미지에 같은 색이라 차이 0). 반환 { png, masked(픽셀 수) } */
const readMasked = async (file, dpr) => {
    if (imageCache.has(file)) return imageCache.get(file)
    const png = PNG.sync.read(await readFile(file))
    const covered = new Uint8Array(png.width * png.height)
    for (const mask of MASKS) {
        const [x0, y0, x1, y1] = maskRect(mask, png.width, png.height, dpr)
        for (let yy = y0; yy < y1; yy++) {
            covered.fill(1, yy * png.width + x0, yy * png.width + x1)
            for (let xx = x0; xx < x1; xx++) png.data.set([255, 0, 255, 255], (yy * png.width + xx) * 4)
        }
    }
    let masked = 0
    for (let i = 0; i < covered.length; i++) masked += covered[i]
    const v = { png, masked }
    imageCache.set(file, v)
    return v
}
/** 두 PNG 의 다른 픽셀 비율(임계값 0.1·0.01). diffOut 이 있으면 0.1 의 diff PNG 를 쓴다 */
const diffPair = async (fileA, fileB, dpr, diffOut) => {
    const a = await readMasked(fileA, dpr)
    const b = await readMasked(fileB, dpr)
    if (a.png.width !== b.png.width || a.png.height !== b.png.height) return { sizeMismatch: true }
    const { width, height } = a.png
    const compared = width * height - a.masked
    const out = {}
    for (const threshold of [0.1, 0.01]) {
        const diff = new PNG({ width, height })
        const n = pixelmatch(a.png.data, b.png.data, diff.data, width, height, { threshold, includeAA: false })
        out[`t${threshold}`] = { diffPixels: n, ratio: n / compared }
        if (threshold === 0.1 && diffOut) {
            await mkdir(path.dirname(diffOut), { recursive: true })
            await writeFile(diffOut, PNG.sync.write(diff))
        }
    }
    return out
}
const MAX_RATIO = 0.001
/** 판정(계획서 V2 규칙): 둘러보기는 0.1·0.01 모두, 궤도 보기는 0.1(산림 장면은 0.01 도) */
const judgeSame = (meta, d) =>
    !d.sizeMismatch && d["t0.1"].ratio <= MAX_RATIO && (meta.mode === "orbit" && !meta.forest ? true : d["t0.01"].ratio <= MAX_RATIO)
const pct = (r) => `${(r * 100).toFixed(4)} %`

/** 콘솔 문제 문구 정규화(숫자 → #, 받아들인 문구 변화 TypeError → Error) */
const normProblem = (p) =>
    `[${p.type}] ${p.text
        .replace(/TypeError: Failed to fetch/g, "Error: Failed to fetch")
        .replace(/\d+(\.\d+)?/g, "#")
        .slice(0, 240)}`
const countBy = (items, key) => {
    const out = {}
    for (const it of items) out[key(it)] = (out[key(it)] ?? 0) + 1
    return out
}
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** 보조 워커 캐시 표(후 형식)를 키별로 더한다. 전 형식이면 null */
const helperCacheTable = (m) => {
    const helpers = m?.workers?.helpers ?? []
    if (!helpers.some((h) => h.caches)) return null
    const out = {}
    for (const h of helpers)
        for (const [k, v] of Object.entries(h.caches ?? {})) {
            const o = (out[k] ??= { count: 0, bytes: 0, max: v.max, hits: 0, misses: 0, evictions: 0 })
            for (const f of ["count", "bytes", "hits", "misses", "evictions"]) o[f] += v[f] ?? 0
        }
    return out
}

const exists = async (p) => access(p).then(() => true, () => false)

const compare = async (args) => {
    const root = args.compareDir
    const summary = { createdAt: new Date().toISOString(), root, rules: { masks: MASKS, maxRatio: MAX_RATIO, thresholds: [0.1, 0.01] }, scenarios: {} }
    const md = [`# V3 비교 ${summary.createdAt}`, "", `- 마스크: render-check 기본 + 0,0,400,200. 같음 = 다른 픽셀 ≤ 0.1 %(둘러보기는 임계값 0.1·0.01 모두, 궤도 보기는 0.1, 산림 장면은 0.01 도)`, ""]
    for (const sc of args.scenarios) {
        imageCache.clear()
        const dirB = path.join(root, "before", sc)
        const dirA = path.join(root, "after", sc)
        if (!(await exists(path.join(dirB, "index.json"))) || !(await exists(path.join(dirA, "index.json")))) continue
        const idxB = JSON.parse(await readFile(path.join(dirB, "index.json"), "utf8"))
        const idxA = JSON.parse(await readFile(path.join(dirA, "index.json"), "utf8"))
        const runB = JSON.parse(await readFile(path.join(dirB, "run.json"), "utf8"))
        const runA = JSON.parse(await readFile(path.join(dirA, "run.json"), "utf8"))
        const envB = `${idxB.browser?.name} ${idxB.browser?.version}`
        const envA = `${idxA.browser?.name} ${idxA.browser?.version}`
        if (envA !== envB) throw new Error(`${sc}: 브라우저가 달라 비교하지 않습니다(${envB} ↔ ${envA})`)
        const out = { title: SCENARIOS[sc].title, errors: { before: runB.error, after: runA.error }, cross: [], intra: { before: [], after: [] }, console: [], notes: {} }
        // 전 ↔ 후(같은 체크포인트)
        for (const a of idxA.results) {
            const b = idxB.results.find((r) => r.name === a.name)
            if (!b) {
                out.cross.push({ name: a.name, missing: "before" })
                continue
            }
            const d = await diffPair(path.join(dirB, b.file), path.join(dirA, a.file), a.dpr, path.join(root, "diff", sc, `${a.name}.png`))
            const fpB = b.fingerprint
            const fpA = a.fingerprint
            out.cross.push({
                name: a.name,
                mode: a.mode,
                forest: a.forest,
                ...d,
                same: judgeSame(a, d),
                tiles: { before: [fpB?.loaded, fpB?.extra, fpB?.mainTiles?.tiles], after: [fpA?.loaded, fpA?.extra, fpA?.mainTiles?.tiles] },
                tilesSame: sameJson([fpB?.loaded, fpB?.extra, fpB?.mainTiles?.tiles, fpB?.live5k, fpB?.origin], [fpA?.loaded, fpA?.extra, fpA?.mainTiles?.tiles, fpA?.live5k, fpA?.origin]),
            })
        }
        for (const b of idxB.results) if (!idxA.results.some((r) => r.name === b.name)) out.cross.push({ name: b.name, missing: "after" })
        // 빌드 안 짝
        for (const [build, idx, dir] of [["before", idxB, dirB], ["after", idxA, dirA]]) {
            for (const p of INTRA_PAIRS[sc] ?? []) {
                const ra = idx.results.find((r) => r.name === p.a)
                const rb = idx.results.find((r) => r.name === p.b)
                if (!ra || !rb) {
                    out.intra[build].push({ ...p, missing: true })
                    continue
                }
                const d = await diffPair(path.join(dir, ra.file), path.join(dir, rb.file), ra.dpr, path.join(root, "diff", sc, `${build}-${p.a}--${p.b}.png`))
                const same = judgeSame(ra, d)
                const fpSame = p.fingerprint ? sameJson(ra.fingerprint, rb.fingerprint) : null
                const fpDiff = {}
                if (p.fingerprint && !fpSame) for (const k of Object.keys(ra.fingerprint ?? {})) if (!sameJson(ra.fingerprint[k], rb.fingerprint?.[k])) fpDiff[k] = [ra.fingerprint[k], rb.fingerprint?.[k]]
                out.intra[build].push({ ...p, ...d, same, ok: (p.expect === "same") === same && fpSame !== false, fingerprintSame: fpSame, fingerprintDiff: fpDiff })
            }
        }
        // 콘솔 문제(페이지별)
        const pagesB = runB.pages ?? []
        const pagesA = runA.pages ?? []
        for (let i = 0; i < Math.max(pagesB.length, pagesA.length); i++) {
            const pb = pagesB[i]
            const pa = pagesA[i]
            const cb = countBy(pb?.problems ?? [], normProblem)
            const ca = countBy(pa?.problems ?? [], normProblem)
            const keys = [...new Set([...Object.keys(cb), ...Object.keys(ca)])].sort()
            const rows = keys.map((k) => ({ key: k, before: cb[k] ?? 0, after: ca[k] ?? 0 }))
            const raw = (p) => (p?.problems ?? []).map((x) => x.text)
            out.console.push({
                page: pa?.prefix ?? pb?.prefix ?? "",
                same: rows.every((r) => r.before === r.after),
                rows,
                total: { before: (pb?.problems ?? []).length, after: (pa?.problems ?? []).length },
                uncaught: { before: raw(pb).filter((t) => /Uncaught/.test(t)).length, after: raw(pa).filter((t) => /Uncaught/.test(t)).length },
                typeErrorFetch: { before: raw(pb).filter((t) => /TypeError: Failed to fetch/.test(t)).length, after: raw(pa).filter((t) => /TypeError: Failed to fetch/.test(t)).length },
                aborted: { before: pb?.aborted?.length ?? 0, after: pa?.aborted?.length ?? 0 },
                failedRequests: { before: pb?.failed?.length ?? 0, after: pa?.failed?.length ?? 0 },
                marks: { before: pb?.marks, after: pa?.marks },
            })
        }
        // 후의 캐시 표(마지막 체크포인트)
        const lastMem = (run) => run.pages?.flatMap((p) => p.checkpoints).at(-1)?.memory
        out.notes.afterCacheTable = helperCacheTable(lastMem(runA))
        out.notes.afterCoordinatorCaches = lastMem(runA)?.workers?.coordinator?.caches ?? null
        summary.scenarios[sc] = out

        // summary.md
        md.push(`## ${sc} ${out.title}`, "")
        if (out.errors.before || out.errors.after) md.push(`- 실행 오류: 전 ${out.errors.before ?? "없음"} / 후 ${out.errors.after ?? "없음"}`, "")
        md.push("| 체크포인트 | 보기 | 0.1 | 0.01 | 판정 | 도엽(loaded, 밖, 메인) 전 → 후 |", "| --- | --- | --- | --- | --- | --- |")
        for (const c of out.cross) {
            if (c.missing) {
                md.push(`| ${c.name} | – | – | – | ${c.missing} 에 없음 | – |`)
                continue
            }
            md.push(`| ${c.name} | ${c.mode}${c.forest ? "·산림" : ""} | ${pct(c["t0.1"].ratio)} | ${pct(c["t0.01"].ratio)} | ${c.same ? "같음" : "**다름**"} | ${c.tiles.before.join(", ")} → ${c.tiles.after.join(", ")}${c.tilesSame ? "" : " (지문 다름)"} |`)
        }
        if ((INTRA_PAIRS[sc] ?? []).length) {
            md.push("", "| 빌드 안 짝 | 기대 | 전 0.1 / 0.01 | 전 | 후 0.1 / 0.01 | 후 |", "| --- | --- | --- | --- | --- | --- |")
            for (let i = 0; i < INTRA_PAIRS[sc].length; i++) {
                const p = INTRA_PAIRS[sc][i]
                const b = out.intra.before[i]
                const a = out.intra.after[i]
                const cell = (x) => (x?.missing ? "없음" : `${pct(x["t0.1"].ratio)} / ${pct(x["t0.01"].ratio)}`)
                const verdict = (x) => (x?.missing ? "–" : `${x.same ? "같음" : "다름"}${x.fingerprintSame === false ? "·지문 다름" : ""}${x.ok ? "" : " **(기대와 다름)**"}`)
                md.push(`| ${p.a} ↔ ${p.b} | ${p.expect === "same" ? "같음" : "다름"} | ${cell(b)} | ${verdict(b)} | ${cell(a)} | ${verdict(a)} |`)
            }
        }
        md.push("", "콘솔 오류·경고(정규화 문구별 수, 전 → 후):", "")
        for (const c of out.console) {
            md.push(`- 페이지 "${c.page || "(하나)"}": 합 ${c.total.before} → ${c.total.after}${c.same ? " (같음)" : " **(다름)**"}, Uncaught ${c.uncaught.before} → ${c.uncaught.after}, abort ${c.aborted.before} → ${c.aborted.after}, 실패 요청 ${c.failedRequests.before} → ${c.failedRequests.after}, "TypeError: Failed to fetch" ${c.typeErrorFetch.before} → ${c.typeErrorFetch.after}`)
            for (const r of c.rows) md.push(`  - ${r.before} → ${r.after}${r.before === r.after ? "" : " ←"} ${r.key.replace(/\|/g, "\\|").slice(0, 200)}`)
        }
        md.push("")
    }
    await writeFile(path.join(root, "compare.json"), JSON.stringify(summary, null, 2))
    await writeFile(path.join(root, "summary.md"), md.join("\n") + "\n")
    console.log(md.join("\n"))
}

const main = async () => {
    const args = parseArgs(process.argv.slice(2))
    if (args.mode === "compare") await compare(args)
    else if (args.mode === "memory") await memorySummary(args)
    else await run(args)
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
