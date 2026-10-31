#!/usr/bin/env node
/**
 * 두 겹 검증 선택(2026-10-31 결정 by @nanangqq, src/webgpu/VERIFY.md 6절, docs/design-code-plan.md 21절).
 *
 * 바꿀 때마다 모든 캡처를 다시 찍지 않도록, git diff 로 바뀐 파일을 분류(scripts/verify-map.json)해 필요한 검증만 고른다.
 * - 1겹(도엽 골든): 워커·데이터·메쉬 코드가 바뀌면 scripts/tile-golden.mjs 로 기준 골든과 바이트 비교(빠름, 모든 레이어)
 * - 2겹(캡처): smoke = 기본 4조합(언제나), 레이어 = 고친 레이어의 장면과 끈 조합, full = 공유 모듈이 바뀌었거나 --full(커밋 전)
 *   장면은 scripts/verify-scenes.json. 캡처·비교는 scripts/render-check.mjs 가 하고(Playwright 는 거기서만), 판정·요약은 이 스크립트가 한다.
 * 테스트 프레임워크는 쓰지 않는다(fb_web/CLAUDE.md 검증 시스템의 원칙).
 *
 * 흐름(함수):
 * - parseArgs: 옵션
 * - changedFiles: 바뀐 파일(작업 트리 ↔ HEAD 와 추적 안 된 파일, 또는 <ref>..HEAD, 또는 --files)
 * - classify: 파일마다 분류표의 처음 맞는 규칙 → 분류(없으면 unknown)
 * - makePlan: 분류 → 골든 여부·캡처 범위(smoke/레이어/full)·장면 목록
 * - printPlan: 계획 출력(예상 시간 포함)
 * - checkEnv: 서버·dist 빌드 시각·기준 폴더·Chrome/Node 버전
 * - runGolden: 골든 만들기 + 기준과 비교(tile-golden --compare, 실패면 종료 코드 1)
 * - runCaptures: render-check 캡처 → 기준과 비교(임계값마다 compare-t<값>.json)
 * - judge: 장면별 judge 임계값으로 같음/다름, 재검증 쌍 확인 → 요약 표, verify.json
 * - refreshBaseline: 전체 캡처 + 골든을 기준 폴더로, manifest.json 에 커밋·Chrome·Node
 *
 * 사용:
 *   npm run verify                         # 작업 트리 ↔ HEAD(추적 안 된 파일 포함)
 *   npm run verify -- --base <ref>         # <ref>..HEAD 의 커밋들
 *   npm run verify -- --full               # 분류와 무관하게 골든 + 전체 캡처(커밋 전)
 *   npm run verify -- --dry-run            # 계획만
 *   npm run verify -- --files src/roadsMesh.ts,src/ui/Dock.tsx --dry-run   # 가정한 diff 로 계획 보기
 *   npm run verify -- --refresh-baseline   # HEAD 에서 기준 다시 찍기(커밋 뒤, Chrome 업그레이드 뒤)
 *   옵션: --golden <dir>(기본 docs/render-checks/golden-baseline) --baseline <dir>(기본 docs/render-checks/capture-baseline)
 *         --out <dir>(기본 docs/render-checks/<오늘>-verify[-n]) --server http://localhost:3000 --allow-dirty(기준 갱신 때 src 변경 허용)
 * 서버는 사용자가 띄운다(npm run build 뒤 dist-static 3000). 종료 코드: 0 통과, 1 예상 밖 차이·실패, 2 실행 못 함(환경)
 */
import { spawnSync, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync, readdirSync, renameSync, copyFileSync, writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const MAP = JSON.parse(readFileSync(path.join(ROOT, "scripts/verify-map.json"), "utf8"))
const SCENES = JSON.parse(readFileSync(path.join(ROOT, "scripts/verify-scenes.json"), "utf8"))
const CHROME_MAC = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
/** 한 장 평균(준비 신호 포함, VERIFY.md 3.5 의 8 ~ 12초)과 골든(148기록, 약 40초) — 예상 시간 표시용 */
const SEC_PER_SHOT = 11
const SEC_GOLDEN = 50

class EnvError extends Error {}

// ---- 옵션 ----

const parseArgs = (argv) => {
    const a = { base: "working", full: false, dryRun: false, files: null, refresh: false, allowDirty: false, server: "http://localhost:3000", golden: "docs/render-checks/golden-baseline", baseline: "docs/render-checks/capture-baseline", out: null }
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i]
        const take = () => {
            const v = argv[++i]
            if (v === undefined) throw new EnvError(`${k} 에 값이 없습니다`)
            return v
        }
        switch (k) {
            case "--base": a.base = take(); break
            case "--full": a.full = true; break
            case "--dry-run": a.dryRun = true; break
            case "--files": a.files = take().split(",").map((s) => s.trim()).filter(Boolean); break
            case "--refresh-baseline": a.refresh = true; break
            case "--allow-dirty": a.allowDirty = true; break
            case "--server": a.server = take().replace(/\/$/, ""); break
            case "--golden": a.golden = take(); break
            case "--baseline": a.baseline = take(); break
            case "--out": a.out = take(); break
            case "--help": case "-h": console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]); process.exit(0)
            default: throw new EnvError(`모르는 옵션 ${k}`)
        }
    }
    return a
}

// ---- 바뀐 파일과 분류 ----

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim()
const lines = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean)

/**
 * 바뀐 파일(fb_web 기준 경로). working: 작업 트리 ↔ HEAD + 추적 안 된 파일(.gitignore 제외), <ref>: <ref>..HEAD
 * @returns { files, source } source 는 출력용 설명
 */
const changedFiles = (args) => {
    if (args.files) return { files: args.files, source: "--files(가정한 diff)" }
    if (args.base === "working") {
        const tracked = lines(git("diff", "--name-only", "--relative", "HEAD"))
        const untracked = lines(git("ls-files", "--others", "--exclude-standard"))
        return { files: [...new Set([...tracked, ...untracked])].sort(), source: "작업 트리 ↔ HEAD(추적 안 된 파일 포함)" }
    }
    return { files: lines(git("diff", "--name-only", "--relative", `${args.base}..HEAD`)).sort(), source: `${args.base}..HEAD` }
}

/** glob → RegExp. ** 는 / 포함 아무 글자(앞의 "**\/" 는 0개 디렉터리도), * 는 / 밖 아무 글자 */
const globRe = (pattern) => {
    let re = ""
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i]
        if (c === "*" && pattern[i + 1] === "*") {
            if (pattern[i + 2] === "/") { re += "(?:.*/)?"; i += 2 } else { re += ".*"; i += 1 }
        } else if (c === "*") re += "[^/]*"
        else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    }
    return new RegExp(`^${re}$`)
}
const RULES = MAP.rules.map((r) => ({ ...r, re: globRe(r.pattern) }))

/** 파일 하나 → { file, cls, rule } */
const classify = (file) => {
    const rule = RULES.find((r) => r.re.test(file))
    return { file, cls: rule ? rule.class : "unknown", rule: rule?.pattern ?? null }
}

/** 장면 params 의 $BBOX 를 펼친다 */
const expand = (params) => params.replace(/\$([A-Z]+)/g, (_, k) => {
    if (!SCENES.bboxes[k]) throw new Error(`verify-scenes.json: 모르는 bbox ${k}`)
    return SCENES.bboxes[k]
})

/**
 * 분류 목록 → 계획.
 * @returns { golden, mode: none|smoke|layers|full, layers[], scenes[], reasons[] }
 */
const makePlan = (classified, forceFull) => {
    const classes = classified.map((c) => ({ ...c, def: MAP.classes[c.cls] }))
    const golden = forceFull || classes.some((c) => c.def.golden)
    let mode = "none"
    const layers = new Set()
    for (const c of classes) {
        if (c.def.captures === "full") mode = "full"
        else if (c.def.captures === "layer") { layers.add(c.def.layer); if (mode !== "full") mode = "layers" }
        else if (c.def.captures === "smoke" && mode === "none") mode = "smoke"
    }
    if (forceFull) mode = "full"
    const scenes = mode === "none" ? [] : SCENES.scenes.filter((s) => mode === "full" || s.smoke || (mode === "layers" && s.layers.some((l) => layers.has(l))))
    return { golden, mode, layers: [...layers], scenes }
}

const fmtTime = (sec) => (sec >= 90 ? `약 ${Math.round(sec / 60)}분` : `약 ${Math.round(sec)}초`)

const printPlan = (source, classified, plan, sizes, forceFull) => {
    console.log(`\n== 검증 계획 (${source}) ==`)
    if (classified.length === 0) console.log("바뀐 파일 없음")
    for (const c of classified) console.log(`  ${c.cls.padEnd(16)} ${c.file}${c.rule ? "" : "   ← 분류표에 없음(전체)"}`)
    if (forceFull) console.log("  --full: 분류와 무관하게 전체")
    const shots = plan.scenes.length * sizes.length
    console.log(`1겹 도엽 골든: ${plan.golden ? "예(기준과 바이트 비교)" : "아니오"}`)
    const modeText = { none: "없음", smoke: "smoke(기본 4조합)", layers: `smoke + 레이어(${plan.layers.join(", ")})`, full: "전체" }[plan.mode]
    console.log(`2겹 캡처: ${modeText} — ${plan.scenes.length}조합 × ${sizes.length}크기 = ${shots}장`)
    for (const s of plan.scenes) console.log(`  ${s.id.padEnd(22)} 판정 ${s.judge.join("·")}${s.off ? `  (끈 조합 ${s.off}=0)` : ""}`)
    const sec = (plan.golden ? SEC_GOLDEN : 0) + shots * SEC_PER_SHOT + (shots ? 15 : 0)
    console.log(`예상 시간: ${sec ? fmtTime(sec) : "0"}`)
}

// ---- 환경 확인 ----

/** 설치된 Chrome 버전(macOS). 못 읽으면 null(render-check 비교가 거부로 대신 잡는다) */
const chromeVersion = () => {
    try {
        return /([\d.]+)/.exec(execFileSync(CHROME_MAC, ["--version"], { encoding: "utf8" }))?.[1] ?? null
    } catch {
        return null
    }
}

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null)

/** dir 아래 가장 늦게 바뀐 파일 시각(ms) */
const newestMtime = (dir) => {
    let t = 0
    for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
        const parent = e.parentPath ?? e.path
        if (!e.isFile() || !/\.(tsx?|css|js)$/.test(e.name) || parent.includes(`${path.sep}llm${path.sep}eval`)) continue
        t = Math.max(t, statSync(path.join(parent, e.name)).mtimeMs)
    }
    return t
}

/**
 * 실행 전 환경 확인. 문제면 EnvError(종료 코드 2).
 * @param needs { captures, golden, compare } compare = 기준과 비교할지(기준 갱신이면 false)
 */
const checkEnv = async (args, needs) => {
    const notes = []
    if (needs.captures) {
        try {
            const res = await fetch(`${args.server}/`)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
        } catch (err) {
            throw new EnvError(`미리보기 서버(${args.server})에 닿지 않습니다: ${err.message}. dist-static(npx serve dist, 3000)을 띄운 뒤 다시`)
        }
        const distJs = path.join(ROOT, "dist/index.js")
        if (!existsSync(distJs)) throw new EnvError("dist/index.js 가 없습니다. npm run build 먼저")
        // 경고만: watch(esbuild)는 출력이 같으면 다시 쓰지 않아 주석만 고친 경우 오탐할 수 있다
        const srcT = newestMtime(path.join(ROOT, "src"))
        const distT = Math.max(statSync(distJs).mtimeMs, statSync(path.join(ROOT, "dist/terrainTileBuild.worker.js")).mtimeMs)
        if (srcT > distT) notes.push(`경고: src 코드가 dist 보다 ${Math.round((srcT - distT) / 1000)}초 새롭습니다. npm run build 를 안 했으면 캡처는 옛 빌드입니다(Ctrl+C 뒤 빌드)`)
    }
    const chrome = chromeVersion()
    if (needs.captures && needs.compare) {
        const m = readJson(path.resolve(ROOT, args.baseline, "manifest.json"))
        if (!m) throw new EnvError(`캡처 기준이 없습니다(${args.baseline}/manifest.json). npm run verify -- --refresh-baseline 으로 HEAD 에서 먼저 찍으세요`)
        if (chrome && m.browser?.version !== chrome)
            throw new EnvError(`Chrome 버전이 기준과 다릅니다(기준 ${m.browser?.name} ${m.browser?.version}, 지금 ${chrome}). 버전이 다른 캡처는 비교하지 않습니다(VERIFY.md 7절 4). 변경 전 커밋에서 npm run verify -- --refresh-baseline 으로 기준을 새로 찍으세요`)
        if (m.complete === false) throw new EnvError(`캡처 기준이 불완전합니다(${args.baseline}/manifest.json errors). --refresh-baseline 다시`)
        notes.push(`캡처 기준: ${m.commit} ${m.browser?.name} ${m.browser?.version}, ${m.shots}장 (${m.createdAt})`)
    }
    if (needs.golden && needs.compare) {
        const m = readJson(path.resolve(ROOT, args.golden, "manifest.json"))
        if (!m || !existsSync(path.resolve(ROOT, args.golden, "golden.json"))) throw new EnvError(`골든 기준이 없습니다(${args.golden}). npm run verify -- --refresh-baseline 먼저`)
        if (m.node !== process.version) notes.push(`주의: 골든 기준의 Node ${m.node} ≠ 지금 ${process.version}. 수학 함수 차이로 다를 수 있으니 차이가 나면 기준 커밋에서 --refresh-baseline`)
        notes.push(`골든 기준: ${m.commit} Node ${m.node} (${m.createdAt})`)
    }
    return { chrome, notes }
}

// ---- 실행 ----

/** node 스크립트를 자식 프로세스로(출력은 그대로 흘림) → 종료 코드 */
const runNode = (script, scriptArgs) => {
    console.log(`\n$ node ${script} ${scriptArgs.map((a) => (/[\s&]/.test(a) ? `"${a}"` : a)).join(" ")}`)
    const r = spawnSync(process.execPath, [path.join(ROOT, script), ...scriptArgs], { cwd: ROOT, stdio: "inherit" })
    return r.status ?? 1
}

/** 골든 만들기 → 기준과 비교. @returns { ok, built, code } */
const runGolden = (args, outDir) => {
    const goldenOut = path.join(outDir, "golden")
    const built = runNode("scripts/tile-golden.mjs", ["--label", "verify", "--out", goldenOut])
    if (built !== 0) return { ok: false, built: false, code: built }
    // 기준이 같은 코드·같은 순서(baseline)로 만든 HEAD 골든이라 허용 차이(--allow·--fresh)는 쓰지 않는다. 그 관례는 옛 92a8954 기준용(cache-refactor-plan 6절)
    const code = runNode("scripts/tile-golden.mjs", ["--compare", args.golden, goldenOut])
    return { ok: code === 0, built: true, code }
}

/** 장면 하나 × 크기 → render-check 의 PNG 이름(render-check.mjs paramsSlug 와 같은 규칙) */
const shotName = (size, params) => {
    const parts = []
    for (const [key, value] of new URLSearchParams(params)) {
        if (key === "bbox") parts.push(`bbox-${createHash("sha1").update(value).digest("hex").slice(0, 6)}`)
        else parts.push(`${key}-${value.replace(/[^0-9a-zA-Z.-]+/g, "_")}`)
    }
    return `${size}_${parts.join("_") || "default"}`
}

/** 캡처만. @returns 종료 코드 */
const capture = (scenes, outDir) =>
    runNode("scripts/render-check.mjs", ["--sizes", SCENES.sizes.join(","), "--out", outDir, ...scenes.flatMap((s) => ["--params", expand(s.params)])])

/** 임계값마다 기준과 비교 → compare-t<값>.json. 기본 임계값(0.1)을 마지막에 돌려 diff/ 가 그것이 되게 한다. @returns { [t]: compare } */
const compareAll = (baselineDir, outDir, thresholds) => {
    const results = {}
    for (const t of [...thresholds].sort((a, b) => a - b)) {
        const code = runNode("scripts/render-check.mjs", ["--compare", baselineDir, outDir, ...SCENES.mask.flatMap((m) => ["--mask", m]), "--threshold", String(t), "--max-diff-ratio", String(SCENES.maxDiffRatio)])
        if (code !== 0) throw new EnvError(`render-check --compare 실패(임계값 ${t}). 위 출력 확인(브라우저 버전이 다르면 --refresh-baseline)`)
        copyFileSync(path.join(outDir, "compare.json"), path.join(outDir, `compare-t${t}.json`))
        results[t] = JSON.parse(readFileSync(path.join(outDir, "compare.json"), "utf8"))
    }
    return results
}

/**
 * 장면별 판정과 재검증. @returns { rows, sanity, failures[] }
 * rows: { scene, size, ratios: {t: {px, ratio, same}}, verdict }
 */
const judge = (scenes, outDir, compares) => {
    const index = readJson(path.join(outDir, "index.json"))
    const failures = []
    const rows = []
    for (const s of scenes) {
        for (const size of SCENES.sizes) {
            const name = shotName(size, expand(s.params))
            const shot = index?.results.find((r) => r.name === name)
            const row = { scene: s.id, size, name, ratios: {}, verdict: "같음" }
            if (!shot || shot.error) {
                row.verdict = "캡처 실패"
                failures.push(`${s.id} ${size}: 캡처 실패 ${shot?.error ?? "(index.json 에 없음)"}`)
                rows.push(row)
                continue
            }
            if (shot.ready?.timedOut) failures.push(`${s.id} ${size}: 준비 신호 시간 초과(도엽 ${shot.ready.tiles})`)
            for (const [t, cmp] of Object.entries(compares)) {
                const p = cmp.pairs.find((x) => x.name === name)
                const judged = s.judge.includes(Number(t))
                if (!p || p.ratio === undefined) {
                    row.ratios[t] = { missing: true }
                    if (judged) { row.verdict = "기준 없음"; failures.push(`${s.id} ${size}: 기준에 짝이 없음(${p?.missing ? "새 조합" : "크기·dpr 다름"}). 장면을 바꿨으면 --refresh-baseline`) }
                    continue
                }
                row.ratios[t] = { px: p.diffPixels, ratio: p.ratio, same: p.same, judged }
                if (judged && !p.same) { row.verdict = "다름"; failures.push(`${s.id} ${size}: 임계값 ${t} 에서 ${(p.ratio * 100).toFixed(4)} % 다름 → ${path.join(outDir, p.diff)}`) }
            }
            rows.push(row)
        }
    }
    // 재검증: 같은 폴더 안 기본 ↔ ao=0 은 모든 임계값에서 "다름" 이어야 한다(아니면 비교가 무뎌진 것)
    const sanity = []
    for (const [t, cmp] of Object.entries(compares)) {
        for (const x of cmp.sanity ?? []) {
            sanity.push({ t: Number(t), on: x.on, ratio: x.ratio, different: x.different })
            if (!x.different) failures.push(`재검증 ${x.on} ↔ ao=0 이 임계값 ${t} 에서 같음 — 비교가 무뎌졌는지 확인(VERIFY.md 7절 6)`)
        }
    }
    if (Object.keys(compares).length && scenes.some((s) => s.id === "base-walk-ao0") && sanity.length === 0) failures.push("재검증 쌍(기본 ↔ ao=0)을 찾지 못함")
    return { rows, sanity, failures }
}

const pct = (r) => (r === undefined ? "-" : `${r.px} px ${(r.ratio * 100).toFixed(4)}%${r.judged ? "" : "(참고)"}`)

const printSummary = (golden, judged, outDir) => {
    console.log("\n== 요약 ==")
    if (golden) console.log(`1겹 도엽 골든: ${golden.ok ? "같음" : golden.built ? "다름(위 tile-golden 비교 출력)" : `만들기 실패(종료 코드 ${golden.code})`}`)
    if (judged) {
        const ts = Object.keys(judged.compares).sort((a, b) => b - a)
        console.log(`2겹 캡처 ${judged.rows.length}장 (${outDir})`)
        console.log(`  ${"장면".padEnd(22)} ${"크기".padEnd(9)} ${ts.map((t) => `t${t}`.padEnd(26)).join(" ")} 판정`)
        for (const r of judged.rows) console.log(`  ${r.scene.padEnd(22)} ${r.size.padEnd(9)} ${ts.map((t) => (r.ratios[t]?.missing ? "짝 없음" : pct(r.ratios[t])).padEnd(26)).join(" ")} ${r.verdict}`)
        for (const s of judged.sanity) console.log(`  재검증 t${s.t} ${s.on} ↔ ao=0: ${(s.ratio * 100).toFixed(3)} % ${s.different ? "다름(정상)" : "같음(무뎌짐?)"}`)
    }
}

// ---- 기준 갱신 ----

/** 기존 기준 폴더가 있으면 지우지 않고 <dir>-<그 커밋> 으로 옮긴다(이미 있으면 -n). @returns 옮긴 경로 또는 null */
const moveAside = (dir) => {
    const abs = path.resolve(ROOT, dir)
    if (!existsSync(abs)) return null
    const old = readJson(path.join(abs, "manifest.json"))
    let dest = `${abs}-${old?.commit ?? "old"}`
    for (let n = 2; existsSync(dest); n++) dest = `${abs}-${old?.commit ?? "old"}-${n}`
    renameSync(abs, dest)
    return path.relative(ROOT, dest)
}

const refreshBaseline = async (args) => {
    // 문서(none)·검증 스크립트(script) 말고 커밋 안 된 변경이 있으면 막는다(그 둘은 화면·도엽 출력을 바꾸지 않는다)
    const dirty = changedFiles({ base: "working" }).files.map(classify).filter((c) => !["none", "script"].includes(c.cls)).map((c) => `${c.cls} ${c.file}`)
    if (dirty.length && !args.allowDirty)
        throw new EnvError(`기준은 커밋된 코드에서 찍습니다. 출력에 닿는 커밋 안 된 변경이 있습니다:\n  ${dirty.join("\n  ")}\n커밋하거나 되돌린 뒤 다시(일부러면 --allow-dirty)`)
    const { chrome } = await checkEnv(args, { captures: true, golden: true, compare: false })
    const commit = git("rev-parse", "--short", "HEAD") + (dirty.length ? "+dirty" : "")
    const subject = git("log", "-1", "--format=%s")
    const shots = SCENES.scenes.length * SCENES.sizes.length
    console.log(`\n== 기준 갱신 (HEAD ${commit} ${subject.slice(0, 60)}) ==\n골든 + 전체 캡처 ${shots}장, 예상 ${fmtTime(SEC_GOLDEN + shots * SEC_PER_SHOT + 15)}. Chrome ${chrome ?? "(버전 못 읽음)"}`)
    const moved = [moveAside(args.golden), moveAside(args.baseline)].filter(Boolean)
    for (const m of moved) console.log(`이전 기준을 ${m} 로 옮겼습니다(필요 없으면 지워도 됨)`)

    // 1) 골든
    const gCode = runNode("scripts/tile-golden.mjs", ["--label", "baseline", "--out", args.golden])
    if (gCode !== 0) throw new EnvError(`골든을 만들지 못했습니다(종료 코드 ${gCode})`)
    const g = readJson(path.resolve(ROOT, args.golden, "golden.json"))
    const gMeta = g.meta
    writeFileSync(path.resolve(ROOT, args.golden, "manifest.json"), JSON.stringify({ kind: "golden-baseline", commit, subject, createdAt: new Date().toISOString(), node: process.version, records: Object.keys(g.records).length, goldenCommit: gMeta.commit, workerDirty: gMeta.workerDirty, policy: "커밋 뒤 HEAD 에서 다시 찍는다(VERIFY.md 6절). 기계마다 따로(git 제외)" }, null, 2))

    // 2) 전체 캡처
    const cCode = capture(SCENES.scenes, path.resolve(ROOT, args.baseline))
    const index = readJson(path.resolve(ROOT, args.baseline, "index.json"))
    const errors = (index?.results ?? []).filter((r) => r.error || r.ready?.timedOut).map((r) => `${r.name}: ${r.error ?? "준비 시간 초과"}`)
    const manifest = {
        kind: "capture-baseline",
        commit,
        subject,
        createdAt: new Date().toISOString(),
        browser: index?.browser ?? null,
        chromeInstalled: chrome,
        node: process.version,
        sizes: SCENES.sizes,
        scenes: SCENES.scenes.map((s) => s.id),
        scenesHash: createHash("sha1").update(readFileSync(path.join(ROOT, "scripts/verify-scenes.json"))).digest("hex").slice(0, 12),
        shots: index?.results.length ?? 0,
        complete: cCode === 0 && errors.length === 0,
        errors,
        policy: "커밋 뒤 HEAD 에서, 그리고 Chrome 이 올라가면 다시 찍는다(VERIFY.md 6절). 기계마다 따로(git 제외)",
    }
    writeFileSync(path.resolve(ROOT, args.baseline, "manifest.json"), JSON.stringify(manifest, null, 2))
    console.log(`\n기준 갱신 ${manifest.complete ? "완료" : "불완전"}: 골든 ${args.golden}, 캡처 ${args.baseline} (${manifest.shots}장, ${manifest.browser?.name} ${manifest.browser?.version})`)
    if (errors.length) { console.log(errors.join("\n")); return 1 }
    return 0
}

// ---- 진입 ----

const defaultOut = () => {
    const base = path.join("docs/render-checks", `${new Date().toLocaleDateString("sv-SE")}-verify`)
    let out = base
    for (let n = 2; existsSync(path.join(ROOT, out)); n++) out = `${base}-${n}`
    return out
}

const main = async () => {
    const args = parseArgs(process.argv.slice(2))
    if (args.refresh) return refreshBaseline(args)
    const { files, source } = changedFiles(args)
    const classified = files.map(classify)
    const plan = makePlan(classified, args.full)
    printPlan(source, classified, plan, SCENES.sizes, args.full)
    if (args.dryRun) return 0
    if (!plan.golden && plan.scenes.length === 0) {
        console.log("검증할 것이 없습니다.")
        return 0
    }
    const { notes } = await checkEnv(args, { captures: plan.scenes.length > 0, golden: plan.golden, compare: true })
    for (const n of notes) console.log(n)
    const outRel = args.out ?? defaultOut()
    const outDir = path.resolve(ROOT, outRel)
    mkdirSync(outDir, { recursive: true })

    const golden = plan.golden ? runGolden(args, outDir) : null
    let judged = null
    if (plan.scenes.length) {
        const cCode = capture(plan.scenes, outDir)
        if (cCode !== 0) console.log(`render-check 캡처 종료 코드 ${cCode}(장별 실패는 아래 판정에 나온다)`)
        const thresholds = [...new Set(plan.scenes.flatMap((s) => s.judge))]
        if (!thresholds.includes(0.1)) thresholds.push(0.1)
        const compares = compareAll(path.resolve(ROOT, args.baseline), outDir, thresholds)
        judged = { ...judge(plan.scenes, outDir, compares), compares }
    }
    printSummary(golden, judged, outRel)
    const failures = [...(golden && !golden.ok ? ["도엽 골든이 기준과 다름"] : []), ...(judged?.failures ?? [])]
    writeFileSync(
        path.join(outDir, "verify.json"),
        JSON.stringify({ createdAt: new Date().toISOString(), head: git("rev-parse", "--short", "HEAD"), source, files: classified, plan: { golden: plan.golden, mode: plan.mode, layers: plan.layers, scenes: plan.scenes.map((s) => s.id) }, golden, rows: judged?.rows ?? [], sanity: judged?.sanity ?? [], failures }, null, 2),
    )
    if (failures.length) {
        console.log(`\n예상 밖 차이 ${failures.length}건:\n  ${failures.join("\n  ")}\n→ diff PNG 를 보고, 다르면 안 되는 곳이면 VERIFY.md 3절(재현 → 좁히기 → 수치)`)
        return 1
    }
    console.log(`\n통과. 결과 ${outRel}/verify.json`)
    return 0
}

main()
    .then((code) => process.exit(code))
    .catch((err) => {
        console.error(err instanceof EnvError ? `\n실행하지 못함: ${err.message}` : err)
        process.exit(2)
    })
