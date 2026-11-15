#!/usr/bin/env node
/**
 * 배포 폴더를 조립한다: v* 태그마다 그 커밋을 따로 풀어 빌드해 <출력>/<태그>/ 에 넣고, <출력>/latest/ 는 가장 높은 버전으로 넘긴다.
 * .github/workflows/pages.yml 이 부른다. 루트의 문서 페이지(index.html·readme.html …)는 이어서 render-docs.mjs 가 만든다.
 *
 * GitHub Pages 는 배포할 때마다 사이트 전체를 바꾸므로, 옛 버전을 남기려면 매번 모든 태그를 다시 빌드해 함께 올려야 한다.
 * 태그 하나라도 빌드에 실패하면 멈춘다(배포하지 않으므로 이전 사이트가 그대로 남는다). 일부러 뺄 태그는 EXCLUDE_TAGS 에 적는다.
 *
 * 사용: node .github/scripts/build-site.mjs <출력 폴더>
 * 환경: EXCLUDE_TAGS(쉼표로 구분한 태그. 빌드와 목록에서 뺀다)
 * 결과: <출력>/<태그>/(앱), <출력>/latest/index.html(넘김), <출력>/versions.json({ latest, versions: [{ tag, date, sha }] }, 높은 버전부터)
 */
import { execFileSync } from "node:child_process"
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const outDir = process.argv[2]
if (!outDir) {
    console.error("usage: node .github/scripts/build-site.mjs <out dir>")
    process.exit(1)
}

/** 경로 이름으로 쓰는 태그 모양. v1.2.3, v1.2.3-rc.1 만 받는다(주소가 되므로 다른 모양의 v* 태그는 건너뛴다) */
const TAG_SHAPE = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/
const exclude = new Set((process.env.EXCLUDE_TAGS || "").split(",").map((s) => s.trim()).filter(Boolean))
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim()

/** 배포할 태그를 높은 버전부터. 시험판(v1.2.3-rc.1)은 같은 번호의 정식판보다 낮게 친다 */
function listTags() {
    const all = git("-c", "versionsort.suffix=-", "tag", "-l", "v*", "--sort=-v:refname").split("\n").filter(Boolean)
    const tags = []
    for (const tag of all) {
        if (!TAG_SHAPE.test(tag)) console.log(`건너뜀(태그 모양): ${tag}`)
        else if (exclude.has(tag)) console.log(`건너뜀(EXCLUDE_TAGS): ${tag}`)
        else tags.push(tag)
    }
    return tags
}

/** 태그 하나를 임시 폴더에 풀어 빌드하고 dist/ 를 <출력>/<태그>/ 로 옮긴다. 작업 트리는 건드리지 않는다 */
async function buildTag(tag) {
    const work = await mkdtemp(path.join(os.tmpdir(), `site-${tag}-`))
    const tar = `${work}.tar`
    const run = (cmd, args) => execFileSync(cmd, args, { cwd: work, stdio: "inherit" })
    try {
        git("archive", "--format=tar", "-o", tar, tag)
        execFileSync("tar", ["-xf", tar, "-C", work], { stdio: "inherit" })
        run("npm", ["ci", "--no-audit", "--no-fund"]) // postinstall 이 patches/ 를 적용한다
        run("npm", ["run", "build"]) // prebuild 가 rhino3dm 을 dist/export/ 로 복사한다
        await cp(path.join(work, "dist"), path.join(outDir, tag), { recursive: true, filter: (src) => path.basename(src) !== ".gitignore" })
    } finally {
        await rm(work, { recursive: true, force: true })
        await rm(tar, { force: true })
    }
}

/** /latest/ 페이지. 가장 높은 버전으로 넘기고 해시(#/attribution 등)와 쿼리는 그대로 붙인다 */
const latestPage = (tag) => `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<title>아수라발발타 ${tag}</title>
<script>location.replace("../${tag}/" + location.search + location.hash)</script>
<noscript><meta http-equiv="refresh" content="0; url=../${tag}/" /></noscript>
</head>
<body><a href="../${tag}/">${tag}</a></body>
</html>
`

const tags = listTags()
if (tags.length === 0) {
    console.error("배포할 v* 태그가 없다")
    process.exit(1)
}
await mkdir(outDir, { recursive: true })
const versions = []
for (const tag of tags) {
    console.log(`\n=== ${tag} 빌드 ===`)
    await buildTag(tag)
    versions.push({ tag, date: git("log", "-1", "--format=%cs", tag), sha: git("rev-parse", "--short", `${tag}^{commit}`) })
}
// 최신 = 가장 높은 정식판. 시험판뿐이면 그중 가장 높은 것
const latest = (versions.find((v) => !v.tag.includes("-")) || versions[0]).tag
await mkdir(path.join(outDir, "latest"), { recursive: true })
await writeFile(path.join(outDir, "latest", "index.html"), latestPage(latest))
await writeFile(path.join(outDir, "versions.json"), `${JSON.stringify({ latest, versions }, null, 2)}\n`)
console.log(`\n버전 ${versions.length}개: ${versions.map((v) => v.tag).join(", ")} (latest → ${latest})`)
