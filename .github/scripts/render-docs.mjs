#!/usr/bin/env node
/**
 * 공개 문서(README.md·README.en.md·THIRD_PARTY.md)를 HTML 로 바꿔 배포 폴더의 루트에 넣는다. .github/workflows/pages.yml 이 build-site.mjs 뒤에 부른다.
 * README.md 는 readme.html 과 index.html 두 이름으로 낸다(사이트 루트가 곧 소개 페이지다. 앱은 /<태그>/ 와 /latest/ 에 있다).
 *
 * 변환은 GitHub Markdown API(POST /markdown)에 맡긴다. github.com 에서 보는 것과 같은 표·코드 블록이 나오고 npm 의존성이 늘지 않는다.
 * 문서끼리의 링크는 변환된 .html 로, 그 밖의 저장소 안 경로(LICENSE, src/…)는 GitHub 의 그 커밋 주소로 바꾼다.
 * 출력 폴더에 versions.json(build-site.mjs 가 씀)이 있으면 페이지 위에 버전 목록 줄을 넣는다. 없으면(문서만 미리 볼 때) 그 줄 없이 만든다.
 *
 * 사용: node .github/scripts/render-docs.mjs <출력 폴더>
 * 환경: GITHUB_TOKEN(있으면 인증. 없으면 비인증 한도 시간당 60회), GITHUB_REPOSITORY, GITHUB_SHA(없으면 main)
 */
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const outDir = process.argv[2]
if (!outDir) {
    console.error("usage: node .github/scripts/render-docs.mjs <out dir>")
    process.exit(1)
}
const repo = process.env.GITHUB_REPOSITORY || "asura-balbalta/asura-balbalta.github.io"
const ref = process.env.GITHUB_SHA || "main"
/** 서비스의 본 주소. 문서 위의 "앱 열기" 가 가는 곳이다(이 사이트의 /<태그>/ 는 이전 버전 기록이고 버전 줄에서 간다) */
const SERVICE_URL = "https://asrbbt.world"

/** 변환할 문서. src 는 저장소 루트 기준, out 은 출력 폴더 기준 */
const DOCS = [
    { src: "README.md", out: "readme.html", lang: "ko", title: "아수라발발타 — README" },
    { src: "README.en.md", out: "readme.en.html", lang: "en", title: "Asura Balbalta — README" },
    { src: "THIRD_PARTY.md", out: "third-party.html", lang: "ko", title: "아수라발발타 — 서드파티 고지" },
]
const DOC_LINKS = new Map(DOCS.map((d) => [d.src, d.out]))
/** 사이트 루트(index.html)로도 내는 문서 */
const ROOT_DOC = "README.md"

/** 마크다운 본문을 GitHub Markdown API 로 HTML 조각으로 바꾼다. 일시 오류는 세 번까지 다시 부른다 */
async function renderMarkdown(text) {
    const headers = { Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" }
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
    let last = ""
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch("https://api.github.com/markdown", { method: "POST", headers, body: JSON.stringify({ text, mode: "markdown" }) })
            if (res.ok) return await res.text()
            last = `HTTP ${res.status} ${(await res.text()).slice(0, 200)}`
            if (res.status < 500 && res.status !== 429 && res.status !== 403) break
        } catch (e) {
            last = String(e)
        }
        await new Promise((r) => setTimeout(r, 2000 * attempt))
    }
    throw new Error(`markdown API failed: ${last}`)
}

/** 상대 링크를 고친다: 변환한 문서는 그 .html 로, 그 밖의 저장소 경로는 GitHub 의 이 커밋 주소로. 절대 주소·#·mailto 는 그대로 */
function rewriteLinks(html) {
    return html.replace(/href="([^"]+)"/g, (whole, href) => {
        if (/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(href)) return whole
        const [file, hash] = href.split("#")
        const target = DOC_LINKS.get(file)
        const next = target ? target : `https://github.com/${repo}/blob/${ref}/${file}`
        return `href="${next}${hash ? `#${hash}` : ""}"`
    })
}

/** build-site.mjs 가 남긴 버전 목록({ latest, versions: [{ tag, date, sha }] }). 없으면 null */
async function readVersions() {
    const file = path.join(outDir, "versions.json")
    return existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : null
}

/** 페이지 위의 버전 목록 줄. 태그마다 그 버전의 앱(/<태그>/)으로 간다 */
function versionLine(doc, versions) {
    if (!versions) return ""
    const en = doc.lang === "en"
    const items = versions.versions.map((v) => `<a href="${v.tag}/" title="${v.date}">${v.tag}</a>${v.tag === versions.latest ? (en ? " (latest)" : " (최신)") : ""}`)
    return `\n<div class="versions">${en ? "Versions" : "버전"}: ${items.join(" · ")}</div>`
}

/**
 * 루트 페이지에만 넣는 넘김. 태그별 경로로 나누기 전(v0.1.1 까지)에는 루트가 앱이었다. 그때 나간 주소
 * (#/attribution 은 내보낸 파일의 메타데이터에도 적혀 있다)를 최신 버전의 같은 화면으로 넘긴다. 문서 안의 #제목 링크는 건드리지 않는다.
 * 열려 있는 페이지에서 주소의 해시만 바꾸면 문서를 다시 읽지 않으므로 hashchange 도 듣는다
 */
const ROOT_REDIRECT = `<script>const toApp = () => location.hash.startsWith("#/") && location.replace("latest/" + location.hash); toApp(); addEventListener("hashchange", toApp)</script>\n`

const CSS = `
:root { color-scheme: light dark; --fg: #1f2328; --bg: #ffffff; --muted: #59636e; --line: #d1d9e0; --code: #f6f8fa; --link: #0969da; }
@media (prefers-color-scheme: dark) { :root { --fg: #f0f6fc; --bg: #0d1117; --muted: #9198a1; --line: #3d444d; --code: #151b23; --link: #4493f8; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; }
nav, main { max-width: 900px; margin: 0 auto; padding: 0 20px; }
nav { padding-top: 16px; font-size: 14px; color: var(--muted); }
.versions { margin-top: 4px; }
main { padding-bottom: 80px; overflow-wrap: break-word; }
a { color: var(--link); text-decoration: none; } a:hover { text-decoration: underline; }
h1, h2 { border-bottom: 1px solid var(--line); padding-bottom: 0.3em; } h1 { font-size: 1.9em; } h2 { font-size: 1.4em; margin-top: 1.8em; }
.anchor { display: none; }
table { display: block; width: max-content; max-width: 100%; overflow-x: auto; border-collapse: collapse; margin: 12px 0 18px; font-size: 14.5px; }
th, td { border: 1px solid var(--line); padding: 6px 12px; vertical-align: top; text-align: left; } th { background: var(--code); }
@media (min-width: 720px) { th:first-child, td:first-child { white-space: nowrap; } }
code { background: var(--code); padding: 0.15em 0.4em; border-radius: 6px; font: 85%/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { background: var(--code); padding: 14px 16px; border-radius: 6px; overflow-x: auto; } pre code { background: none; padding: 0; font-size: 13.5px; }
blockquote { margin: 12px 0; padding: 0 1em; color: var(--muted); border-left: 4px solid var(--line); }
`

/** 변환한 조각을 한 페이지로 감싼다. 위에 서비스 본 주소·저장소로 가는 줄과 버전 목록을 둔다. root 면 옛 앱 주소 넘김을 넣는다 */
function page(doc, body, versions, root) {
    return `<!doctype html>
<html lang="${doc.lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${doc.title}</title>
${root ? ROOT_REDIRECT : ""}<style>${CSS}</style>
</head>
<body>
<nav><a href="${SERVICE_URL}">${doc.lang === "en" ? "Open the app" : "앱 열기"}</a> · <a href="https://github.com/${repo}">GitHub</a>${versionLine(doc, versions)}</nav>
<main>
${body}
</main>
</body>
</html>
`
}

await mkdir(outDir, { recursive: true })
const versions = await readVersions()
for (const doc of DOCS) {
    const html = rewriteLinks(await renderMarkdown(await readFile(doc.src, "utf8")))
    await writeFile(path.join(outDir, doc.out), page(doc, html, versions, false))
    console.log(`${doc.src} → ${path.join(outDir, doc.out)} (${html.length} chars)`)
    if (doc.src === ROOT_DOC) {
        await writeFile(path.join(outDir, "index.html"), page(doc, html, versions, true))
        console.log(`${doc.src} → ${path.join(outDir, "index.html")} (사이트 루트)`)
    }
}
