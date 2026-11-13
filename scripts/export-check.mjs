#!/usr/bin/env node
/**
 * 내보내기 파일 확인(2026-10-15, 1K 도엽 통일 뒤 내보내기가 옛 방식과 같은 구조인지).
 *
 * --export: Playwright 로 설치된 Chrome 을 띄워 디버그 페이지(bbox, walk=0)로 범위를 올린 뒤 내려받기 패널의 네 형식(STL·SKP·3DM·GLB)을
 *   차례로 내려받아 <out>/ 에 저장한다. 서버는 사용자가 띄운다(3000 포트. 옛 빌드와 비교할 때는 옛 dist 를 같은 포트로).
 * --inspect: 저장된 파일을 읽어 지형/건물 분리와 건물별 이름·속성을 요약한다(<dir>/summary.json 과 콘솔 표).
 *   STL 은 삼각형 수만(형식에 그룹·속성이 없다). GLB 는 JSON 청크의 노드 트리(terrain 노드, buildings 노드의 자식 = 건물, extras = 속성).
 *   3DM 은 rhino3dm 으로 레이어·그룹·객체 이름·user string. SKP 는 openskp 의 parseSkp 로 정의·인스턴스 이름과 attribute dictionary.
 * --compare: 두 폴더의 summary.json 을 나란히 표로.
 *
 * 녹지(OSM, docs/osm-green-layer-plan.md G5): --export 에 --uncheck "녹지 (OSM)" 을 주면 레이어 패널에서 그 레이어의 "내보내기" 를 끈 뒤 내려받는다
 *   (녹지 끔 비교. 지형은 녹지로 나눈 그대로이고 재질만 하나). 형식마다 완료 토스트 글과 캡처(toast-<형식>.png)를 남긴다. --inspect 는 GLB 재질·
 *   asset.copyright·지형 primitive 의 재질별 삼각형, 3DM 레이어·재질·문서 문자열 attribution·녹지 user text, SKP 재질·"녹지-" 정의별 면 수·
 *   파일 안 "OpenStreetMap" 횟수(UTF-16)를 더 적는다.
 *
 * 사용:
 *   node scripts/export-check.mjs --export docs/render-checks/<폴더> --bbox 14135700,4513980,14136500,4514780 [--base http://localhost:3000]
 *   node scripts/export-check.mjs --inspect docs/render-checks/<폴더>
 *   node scripts/export-check.mjs --compare <옛 폴더> <새 폴더>
 *   (녹지) node scripts/export-check.mjs --export <폴더>/green-off --bbox 14127729,4511702,14130234,4514248 --uncheck "녹지 (OSM)"
 *   (계단형, G12) 위 명령에 --stepped 를 더하면 설정 패널에서 보기 모드를 계단형으로 바꾼 뒤 내려받는다
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"

const require = createRequire(import.meta.url)

const KINDS = ["stl", "skp", "3dm", "glb"]

const parseArgs = (argv) => {
    const args = { mode: null, dirs: [], bbox: null, base: "http://localhost:3000", timeout: 240000, uncheck: [], stepped: false }
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i]
        const take = () => argv[++i]
        switch (key) {
            case "--export": args.mode = "export"; args.dirs.push(take()); break
            case "--inspect": args.mode = "inspect"; args.dirs.push(take()); break
            case "--compare": args.mode = "compare"; args.dirs.push(take(), take()); break
            case "--bbox": args.bbox = take(); break
            case "--base": args.base = take().replace(/\/$/, ""); break
            case "--timeout": args.timeout = Number(take()); break
            case "--uncheck": args.uncheck.push(take()); break
            case "--stepped": args.stepped = true; break
            default: throw new Error(`모르는 옵션 ${key}`)
        }
    }
    if (!args.mode) throw new Error("--export <dir> --bbox … | --inspect <dir> | --compare <a> <b>")
    return args
}

// ---- 내려받기 ----
const runExport = async ({ dirs: [out], bbox, base, timeout, uncheck, stepped }) => {
    if (!bbox) throw new Error("--bbox 가 필요합니다")
    const { chromium } = await import("playwright")
    await mkdir(out, { recursive: true })
    const launch = { headless: false, args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"] }
    let browser
    try {
        browser = await chromium.launch({ ...launch, channel: "chrome" })
    } catch {
        browser = await chromium.launch(launch)
    }
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, acceptDownloads: true })
    const page = await context.newPage()
    const logs = []
    page.on("console", (msg) => logs.push(`[${msg.type()}] ${msg.text()}`))
    const url = `${base}/#/debug/walk?bbox=${bbox}&walk=0&lock=0&look=0`
    const started = Date.now()
    await page.goto(url)
    // 궤도 보기 준비: 선택 도엽 로딩 끝(옛 빌드는 data-busy 가 없어 "1 이 아니면")
    await page.waitForSelector('[data-debug-page][data-debug-state="ready"]:not([data-busy="1"])', { timeout })
    console.log(`준비 ${Date.now() - started} ms: ${url}`)
    // 선택 도엽이 다 올라올 때까지: busy 가 한 번 켜졌다 꺼지고, 꺼진 채 2초 그대로인지(시간이 아니라 준비 신호의 안정으로 판단).
    // 처음 ready 는 busy 가 켜지기 전일 수 있어 형식마다 담긴 도엽 수가 달라졌다(2026-11-08 G5 확인에서 발견)
    const idle = '[data-debug-page]:not([data-busy="1"])'
    await page.waitForSelector('[data-debug-page][data-busy="1"]', { timeout: 10000 }).catch(() => {})
    for (;;) {
        await page.waitForSelector(idle, { timeout })
        const stable = await page
            .waitForSelector('[data-debug-page][data-busy="1"]', { timeout: 2000 })
            .then(() => false)
            .catch(() => true)
        if (stable) break
    }
    console.log(`도엽 다 올라옴 ${Date.now() - started} ms`)
    if (stepped) {
        // 설정 패널의 보기 모드를 계단형으로 바꾸고 다시 만든 도엽이 다 올라올 때까지 같은 안정 판정으로 기다린다(G12)
        await page.getByRole("button", { name: "설정" }).first().click()
        await page.getByRole("group", { name: "보기 모드" }).getByRole("button", { name: "계단형" }).click()
        await page.waitForSelector('[data-debug-page][data-busy="1"]', { timeout: 10000 }).catch(() => {})
        for (;;) {
            await page.waitForSelector(idle, { timeout })
            const stable = await page
                .waitForSelector('[data-debug-page][data-busy="1"]', { timeout: 2000 })
                .then(() => false)
                .catch(() => true)
            if (stable) break
        }
        console.log(`계단형 다 올라옴 ${Date.now() - started} ms`)
    }
    if (uncheck.length > 0) {
        // 레이어 패널에서 "내보내기" 체크를 끈다(녹지 끔 비교 등)
        await page.getByRole("button", { name: "레이어" }).first().click()
        for (const label of uncheck) {
            const box = page.getByRole("checkbox", { name: `${label} 내보내기` })
            await box.waitFor({ timeout: 10000 })
            if (await box.isChecked()) await box.click()
            console.log(`내보내기 끔: ${label}`)
        }
    }
    await page.getByRole("button", { name: "내려받기" }).first().click()
    await page.waitForSelector(".ui-export-row", { timeout: 10000 })
    // 건물까지 담기게: 패널 꼬리말 "담는 레이어: 지형 · 건물" 을 기다린다(옛 빌드는 건물을 따로 받아 ready 뒤에 올라온다)
    await page.waitForFunction(() => document.querySelector(".ui-panel-footer")?.textContent?.includes("건물") ?? false, null, { timeout })
    console.log(`건물 준비 ${Date.now() - started} ms`)
    const saved = {}
    for (const [i, kind] of KINDS.entries()) {
        const t0 = Date.now()
        const [download] = await Promise.all([
            page.waitForEvent("download", { timeout }),
            page.locator(".ui-export-row").nth(i).locator("button").click(),
        ])
        const file = path.join(out, `export.${kind}`)
        await download.saveAs(file)
        // 진행 막대가 사라질 때까지(다음 형식 버튼이 활성화된다)
        await page.waitForSelector(".ui-export-progress", { state: "detached", timeout })
        // 완료 안내(토스트) 글과 캡처. 출처 줄(녹지면 OSM)이 형식과 무관하게 보이는지 본다
        const title = `${kind.toUpperCase()} 파일을 내려받았습니다`
        const toast = page.locator(".fui-Toast", { hasText: title }).last()
        let toastText = null
        try {
            await toast.waitFor({ timeout: 10000 })
            toastText = (await toast.innerText()).replace(/\s+/g, " ").trim()
            await page.screenshot({ path: path.join(out, `toast-${kind}.png`) })
        } catch {}
        saved[kind] = { file, suggested: download.suggestedFilename(), ms: Date.now() - t0, toast: toastText }
        console.log(`${kind}: ${download.suggestedFilename()} (${saved[kind].ms} ms)`)
    }
    await writeFile(path.join(out, "export.log"), logs.join("\n"))
    const errors = logs.filter((l) => l.startsWith("[error]"))
    console.log(`콘솔 오류 ${errors.length}개${errors.length ? `: ${errors.slice(0, 3).join(" | ")}` : ""}`)
    await writeFile(path.join(out, "export.json"), JSON.stringify({ createdAt: new Date().toISOString(), base, bbox, uncheck, stepped, saved, consoleErrors: errors }, null, 2))
    await browser.close()
}

// ---- 읽기 ----
const inspectStl = async (file) => {
    const buf = await readFile(file)
    const triangles = buf.readUInt32LE(80)
    return { bytes: buf.length, triangles, sizeMatches: buf.length === 84 + triangles * 50 }
}

const inspectGlb = async (file) => {
    const buf = await readFile(file)
    if (buf.toString("ascii", 0, 4) !== "glTF") throw new Error("GLB 가 아님")
    const jsonLen = buf.readUInt32LE(12)
    const json = JSON.parse(buf.toString("utf8", 20, 20 + jsonLen))
    const nodes = json.nodes ?? []
    const accessors = json.accessors ?? []
    const meshes = json.meshes ?? []
    const meshStats = (node) => {
        if (node.mesh === undefined) return null
        const prims = meshes[node.mesh].primitives
        let vertices = 0, triangles = 0
        for (const p of prims) {
            vertices += accessors[p.attributes.POSITION].count
            triangles += accessors[p.indices].count / 3
        }
        return { primitives: prims.length, vertices, triangles }
    }
    const byName = (name) => nodes.find((n) => n.name === name)
    const terrain = byName("terrain")
    const buildingsNode = byName("buildings")
    const children = (buildingsNode?.children ?? []).map((i) => nodes[i])
    const withExtras = children.filter((n) => n.extras && Object.keys(n.extras).length > 0)
    const keys = withExtras.length ? Object.keys(withExtras[0].extras) : []
    const missingName = children.filter((n) => !n.name).length
    const ids = children.map((n) => n.extras?.id).filter((v) => v !== undefined)
    // 녹지: 재질 이름·색, 지형 primitive 의 재질별 삼각형, asset.copyright
    const materials = (json.materials ?? []).map((m) => ({ name: m.name, color: m.pbrMetallicRoughness?.baseColorFactor?.slice(0, 3).map((v) => Math.round(v * 255)) }))
    const terrainByMaterial = {}
    if (terrain?.mesh !== undefined)
        for (const p of meshes[terrain.mesh].primitives) {
            const name = json.materials?.[p.material]?.name ?? `#${p.material}`
            terrainByMaterial[name] = (terrainByMaterial[name] ?? 0) + accessors[p.indices].count / 3
        }
    return {
        bytes: buf.length,
        root: nodes[0]?.name,
        materials,
        terrainByMaterial,
        copyright: json.asset?.copyright ?? null,
        terrain: terrain ? meshStats(terrain) : null,
        buildings: { count: children.length, withExtras: withExtras.length, missingName, extrasKeys: keys, uniqueIds: new Set(ids).size, sample: children.slice(0, 3).map((n) => ({ name: n.name, extras: n.extras })) },
        assetExtras: json.asset?.extras ?? null,
        /** 비교용: 건물마다 이름·extras, 지형 정점·인덱스(원래 좌표 x, y, z 로 되돌린 것) */
        all: { buildings: children.map((n) => ({ name: n.name, extras: n.extras })), terrain: terrain ? terrainXyz(json, buf, terrain) : null },
    }
}

/** GLB 의 지형 노드에서 정점(x, y, z. 파일의 (x, z, -y) 를 되돌림)과 인덱스를 꺼낸다 */
const terrainXyz = (json, buf, node) => {
    const binStart = 20 + json_len(buf) + 8
    const read = (accessorIndex) => {
        const acc = json.accessors[accessorIndex]
        const view = json.bufferViews[acc.bufferView]
        const offset = binStart + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0)
        const Ctor = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array }[acc.componentType]
        const n = { SCALAR: 1, VEC3: 3 }[acc.type]
        return new Ctor(buf.buffer.slice(buf.byteOffset + offset, buf.byteOffset + offset + acc.count * n * Ctor.BYTES_PER_ELEMENT))
    }
    const positions = [], indices = []
    let base = 0
    for (const p of json.meshes[node.mesh].primitives) {
        const pos = read(p.attributes.POSITION), idx = read(p.indices)
        for (let i = 0; i < pos.length; i += 3) positions.push(pos[i], -pos[i + 2], pos[i + 1])
        for (let i = 0; i < idx.length; i++) indices.push(idx[i] + base)
        base += pos.length / 3
    }
    return { positions: Array.from(positions), indices: Array.from(indices) }
}
const json_len = (buf) => buf.readUInt32LE(12)

const inspect3dm = async (file) => {
    const rhino = await require("rhino3dm")()
    const buf = await readFile(file)
    const doc = rhino.File3dm.fromByteArray(new Uint8Array(buf))
    const layers = []
    for (let i = 0; i < doc.layers().count; i++) layers.push(doc.layers().get(i).name)
    const groups = []
    for (let i = 0; i < doc.groups().count; i++) groups.push(doc.groups().get(i).name)
    const perLayer = {}
    const sample = []
    let withUserStrings = 0
    const ids = new Set()
    const objects = doc.objects()
    for (let i = 0; i < objects.count; i++) {
        const obj = objects.get(i)
        const attr = obj.attributes()
        const layer = layers[attr.layerIndex] ?? `#${attr.layerIndex}`
        const geo = obj.geometry()
        const type = geo?.constructor?.name ?? "?"
        const stat = (perLayer[layer] ??= { objects: 0, types: {}, named: 0 })
        stat.objects++
        stat.types[type] = (stat.types[type] ?? 0) + 1
        if (attr.name) stat.named++
        const us = attr.getUserStrings?.() ?? []
        if (layer === "buildings" && us.length > 0) {
            withUserStrings++
            const id = us.find(([k]) => k === "id")?.[1]
            if (id !== undefined) ids.add(id)
            if (sample.length < 3) sample.push({ name: attr.name, userStrings: Object.fromEntries(us) })
        }
    }
    const materials = []
    for (let i = 0; i < doc.materials().count; i++) {
        const m = doc.materials().get(i)
        materials.push({ name: m.name, color: [m.diffuseColor.r, m.diffuseColor.g, m.diffuseColor.b] })
    }
    // 녹지 레이어 객체의 user text(출처)와 면 수
    const green = {}
    for (let i = 0; i < objects.count; i++) {
        const obj = objects.get(i)
        const attr = obj.attributes()
        const layer = layers[attr.layerIndex] ?? ""
        if (!layer.startsWith("녹지-") && layer !== "terrain") continue
        const geo = obj.geometry()
        const faces = geo?.faces ? geo.faces().count : 0
        const g = (green[layer] ??= { objects: 0, faces: 0, material: null, userStrings: null })
        g.objects++
        g.faces += faces
        if (layer !== "terrain") {
            g.material = attr.materialIndex
            g.userStrings = Object.fromEntries(attr.getUserStrings?.() ?? [])
        }
    }
    // 문서 문자열 표(키 → 값). get(i) 는 [키, 값] 쌍
    let attribution = null
    const strings = doc.strings()
    for (let i = 0; i < strings.count; i++) {
        const entry = strings.get(i)
        if (Array.isArray(entry) && entry[0] === "attribution") attribution = entry[1]
    }
    return { bytes: buf.length, layers, groups, perLayer, materials, green, attribution, buildings: { withUserStrings, uniqueIds: ids.size, sample } }
}

const inspectSkp = async (file) => {
    const { parseSkp, buildScene } = require("openskp")
    const buf = await readFile(file)
    const parsed = await parseSkp(new Uint8Array(buf))
    const defs = [...parsed.definitions.values()]
    const terrain = defs.find((d) => d.name === "terrain")
    // 그룹 속성은 장면 계층(buildScene)의 인스턴스 노드에서 읽는다(정의에 붙은 사전은 openskp 가 내놓지 않는다)
    const scene = await buildScene(new Uint8Array(buf))
    const nodes = []
    const walk = (n) => {
        nodes.push(n)
        for (const c of n.children ?? []) walk(c)
    }
    walk(scene.sceneHierarchy)
    const buildingsNode = nodes.find((n) => n.name === "buildings")
    const buildings = buildingsNode?.children ?? []
    const withDict = buildings.filter((n) => n.attributeDictionaries?.asrbbt && Object.keys(n.attributeDictionaries.asrbbt).length > 0)
    const keys = withDict.length ? Object.keys(withDict[0].attributeDictionaries.asrbbt) : []
    const ids = withDict.map((n) => n.attributeDictionaries.asrbbt.id)
    // openskp 의 reader 는 인스턴스 사전을 2021+ 형식(VFF, D007/DC05)에서만 꺼내고 writer 는 2017 형식(v17)으로 쓰므로, 자기가 쓴
    // 파일의 사전은 못 읽는다(withDict 0). 약한 검사로 파일 바이트의 UTF-16 "asrbbt" 횟수(= 사전 수)를 센다. 값은 SketchUp 에서 본다
    const key = Buffer.from("asrbbt", "utf16le")
    let rawDictCount = 0
    for (let i = buf.indexOf(key); i >= 0; i = buf.indexOf(key, i + key.length)) rawDictCount++
    const countOf = (text) => {
        let n = 0
        for (const k of [Buffer.from(text, "utf16le"), Buffer.from(text, "utf8")]) for (let i = buf.indexOf(k); i >= 0; i = buf.indexOf(k, i + k.length)) n++
        return n
    }
    // 녹지: 재질(이름·색)과 "녹지-" 정의별 면 수, 지형 그룹 안 하위 그룹 이름
    const greenDefs = Object.fromEntries(defs.filter((d) => d.name?.startsWith("녹지-")).map((d) => [d.name, d.faces?.length ?? null]))
    const terrainNode = nodes.find((n) => n.name === "terrain")
    const green = {
        materials: (parsed.materials ?? []).map((m) => ({ name: m.name, color: [m.color.r, m.color.g, m.color.b] })),
        defs: greenDefs,
        terrainChildren: (terrainNode?.children ?? []).map((n) => n.name),
        osmCount: countOf("OpenStreetMap"),
        odblCount: countOf("ODbL"),
    }
    return {
        rawDictCount,
        green,
        attributesReadable: withDict.length > 0,
        bytes: buf.length,
        definitions: defs.length,
        terrain: terrain ? { faces: terrain.faces?.length ?? null } : null,
        buildings: {
            count: buildings.length,
            named: buildings.filter((n) => n.name).length,
            withDict: withDict.length,
            dictKeys: keys,
            uniqueIds: new Set(ids).size,
            ids,
            definitionNames: buildings.slice(0, 3).map((n) => n.definitionName),
            sample: withDict.slice(0, 3).map((n) => ({ name: n.name, asrbbt: n.attributeDictionaries.asrbbt })),
        },
        all: { buildings: buildings.map((n) => ({ name: n.name, asrbbt: n.attributeDictionaries?.asrbbt ?? null })) },
    }
}
const round = (v, digits) => Number(v.toFixed(digits))

const INSPECTORS = { stl: inspectStl, glb: inspectGlb, "3dm": inspect3dm, skp: inspectSkp }

const runInspect = async ({ dirs: [dir] }) => {
    const summary = {}
    for (const kind of KINDS) {
        const file = path.join(dir, `export.${kind}`)
        try {
            summary[kind] = await INSPECTORS[kind](file)
        } catch (err) {
            summary[kind] = { error: String(err) }
        }
        const s = summary[kind]
        console.log(`== ${kind}: ${JSON.stringify(s, (k, v) => (k === "json" || k === "all" || k === "ids" ? undefined : v)).slice(0, 1400)}`)
    }
    await writeFile(path.join(dir, "summary.json"), JSON.stringify(summary, null, 2))
    console.log(`끝. ${path.join(dir, "summary.json")}`)
}

const runCompare = async ({ dirs: [a, b] }) => {
    const [sa, sb] = await Promise.all([a, b].map(async (d) => JSON.parse(await readFile(path.join(d, "summary.json"), "utf8"))))
    const rows = []
    const row = (label, va, vb) => rows.push([label, JSON.stringify(va), JSON.stringify(vb)])
    row("STL 삼각형", sa.stl?.triangles, sb.stl?.triangles)
    row("GLB 지형 정점/삼각형", sa.glb?.terrain && [sa.glb.terrain.vertices, sa.glb.terrain.triangles], sb.glb?.terrain && [sb.glb.terrain.vertices, sb.glb.terrain.triangles])
    row("GLB 건물 수 / extras 있음 / 고유 id", sa.glb?.buildings && [sa.glb.buildings.count, sa.glb.buildings.withExtras, sa.glb.buildings.uniqueIds], sb.glb?.buildings && [sb.glb.buildings.count, sb.glb.buildings.withExtras, sb.glb.buildings.uniqueIds])
    row("GLB extras 키", sa.glb?.buildings?.extrasKeys, sb.glb?.buildings?.extrasKeys)
    row("3DM 레이어", sa["3dm"]?.layers, sb["3dm"]?.layers)
    row("3DM 그룹", sa["3dm"]?.groups, sb["3dm"]?.groups)
    row("3DM 레이어별 객체", sa["3dm"]?.perLayer, sb["3dm"]?.perLayer)
    row("3DM 건물 user string / 고유 id", sa["3dm"]?.buildings && [sa["3dm"].buildings.withUserStrings, sa["3dm"].buildings.uniqueIds], sb["3dm"]?.buildings && [sb["3dm"].buildings.withUserStrings, sb["3dm"].buildings.uniqueIds])
    row("SKP 정의 수 / 건물 그룹 / 이름 있음 / 파일 안 asrbbt 사전 수 / 정의 이름 예", sa.skp && [sa.skp.definitions, sa.skp.buildings.count, sa.skp.buildings.named, sa.skp.rawDictCount, sa.skp.buildings.definitionNames[0]], sb.skp && [sb.skp.definitions, sb.skp.buildings.count, sb.skp.buildings.named, sb.skp.rawDictCount, sb.skp.buildings.definitionNames[0]])
    row("SKP 지형 면 수", sa.skp?.terrain?.faces, sb.skp?.terrain?.faces)
    // 녹지(G5)
    row("파일 크기 STL / SKP / 3DM / GLB", KINDS.map((k) => sa[k]?.bytes), KINDS.map((k) => sb[k]?.bytes))
    row("GLB 지형 재질별 삼각형", sa.glb?.terrainByMaterial, sb.glb?.terrainByMaterial)
    row("GLB 재질", sa.glb?.materials?.map((m) => m.name), sb.glb?.materials?.map((m) => m.name))
    row("GLB copyright 에 OpenStreetMap", !!sa.glb?.copyright?.includes("OpenStreetMap"), !!sb.glb?.copyright?.includes("OpenStreetMap"))
    row("3DM 녹지·지형 레이어(객체·면)", sa["3dm"]?.green, sb["3dm"]?.green)
    row("3DM 재질", sa["3dm"]?.materials?.map((m) => m.name), sb["3dm"]?.materials?.map((m) => m.name))
    row("3DM attribution 에 OpenStreetMap", !!sa["3dm"]?.attribution?.includes("OpenStreetMap"), !!sb["3dm"]?.attribution?.includes("OpenStreetMap"))
    row("SKP 재질 / 녹지 정의 면 수 / 파일 안 OpenStreetMap·ODbL 횟수", sa.skp?.green && [sa.skp.green.materials.length, sa.skp.green.defs, sa.skp.green.osmCount, sa.skp.green.odblCount], sb.skp?.green && [sb.skp.green.materials.length, sb.skp.green.defs, sb.skp.green.osmCount, sb.skp.green.odblCount])
    // 건물 id 포함 관계와 속성 일치(GLB extras 기준. 3DM user string 은 같은 함수에서 나온다)
    const ba = new Map((sa.glb?.all?.buildings ?? []).map((b) => [b.extras?.id, b]))
    const bb = new Map((sb.glb?.all?.buildings ?? []).map((b) => [b.extras?.id, b]))
    const common = [...ba.keys()].filter((id) => bb.has(id))
    let attrDiff = 0, nameDiff = 0
    const diffs = []
    for (const id of common) {
        const x = ba.get(id), y = bb.get(id)
        if (x.name !== y.name) nameDiff++
        const keys = new Set([...Object.keys(x.extras), ...Object.keys(y.extras)])
        const bad = [...keys].filter((k) => JSON.stringify(x.extras[k]) !== JSON.stringify(y.extras[k]))
        if (bad.length) {
            attrDiff++
            if (diffs.length < 5) diffs.push({ id, bad: bad.map((k) => [k, x.extras[k], y.extras[k]]) })
        }
    }
    row("건물 id: A 전체 / A∩B / A 에만 / B 에만", ba.size, [common.length, ba.size - common.length, bb.size - common.length])
    row("공통 건물 중 이름 다름 / 속성 다름", "—", [nameDiff, attrDiff, diffs])
    // SKP 그룹 속성이 GLB extras 와 같은지(형식 간 일관성. SKP 값은 문자열이라 문자열로 견준다)
    const skpSame = (summary, glbMap) => {
        const list = summary?.all?.buildings ?? []
        let same = 0, differ = 0
        for (const b of list) {
            const g = glbMap.get(Number(b.asrbbt?.id))
            if (!g || !b.asrbbt) { differ++; continue }
            const keys = Object.keys(g.extras)
            if (keys.every((k) => String(b.asrbbt[k]) === String(g.extras[k])) && b.name === g.name) same++
            else differ++
        }
        return [same, differ]
    }
    row("SKP 그룹 속성·이름 = GLB (같음 / 다름. openskp 가 v17 사전을 못 읽으면 모두 다름)", skpSame(sa.skp, ba), skpSame(sb.skp, bb))
    // 지형: A 의 정점 자리에서 B 의 높이(삼각형 보간)를 재 차이를 본다
    const ta = sa.glb?.all?.terrain, tb = sb.glb?.all?.terrain
    if (ta && tb) {
        const { createHeightSampler } = await import(path.resolve("node_modules/.cache/fb_web/terrainHeight.mjs"))
        const sampler = createHeightSampler({ origin: [0, 0], positions: new Float32Array(tb.positions), indices: new Uint32Array(tb.indices) })
        const oa = sa.glb.assetExtras?.origin ?? [0, 0], ob = sb.glb.assetExtras?.origin ?? [0, 0]
        let n = 0, miss = 0, sum = 0, max = 0, over1cm = 0, over10cm = 0
        for (let i = 0; i < ta.positions.length; i += 3) {
            const x = ta.positions[i] + oa[0] - ob[0], y = ta.positions[i + 1] + oa[1] - ob[1]
            const z = sampler.heightAt(x, y)
            if (z === null) { miss++; continue }
            const d = Math.abs(z - ta.positions[i + 2])
            n++; sum += d; if (d > max) max = d; if (d > 0.01) over1cm++; if (d > 0.1) over10cm++
        }
        row("지형: A 정점 자리의 B 높이 차(표본 / B 밖 / 평균 / 최대 / >1cm / >10cm)", "—", [n, miss, round(sum / Math.max(n, 1), 4), round(max, 3), over1cm, over10cm])
        row("지형 원점 A / B", oa, ob)
    }
    console.log(["항목", path.basename(a), path.basename(b)].join(" | "))
    for (const r of rows) console.log(r.join(" | "))
}

const args = parseArgs(process.argv.slice(2))
const run = { export: runExport, inspect: runInspect, compare: runCompare }[args.mode]
run(args).catch((err) => {
    console.error(err)
    process.exit(1)
})
