import type { Extent } from "ol/extent"

import type { AppPreset } from "../app.tsx"
import type { AoDebugMode } from "../webgpu/ao"
import type { RenderDebug } from "../webgpu/terrainRenderer"

/**
 * 둘러보기 디버그 페이지(src/debug/walk.tsx)의 주소 파라미터 해석(2026-11-08 walk.tsx 에서 뽑음). 파라미터 표는 walk.tsx 머리 주석과
 * src/webgpu/VERIFY.md 4절. React·DOM 을 쓰지 않아 헤드리스 검사(scripts/render-headless.mjs)도 같은 함수로 장면 정의의 주소를 해석한다
 */

const numberList = (raw: string | null, count: number): number[] | null => {
    if (raw === null) return null
    const values = raw.split(",").map((v) => Number(v.trim()))
    return values.length === count && values.every(Number.isFinite) ? values : null
}
/** 있으면 "0" 이 아닌지(끄기 스위치). 없으면 undefined(기본 동작) */
const flag = (params: URLSearchParams, key: string) => (params.has(key) ? params.get(key) !== "0" : undefined)
const number = (params: URLSearchParams, key: string) => {
    const v = Number(params.get(key))
    return params.has(key) && Number.isFinite(v) ? v : undefined
}
/**
 * "시작,끝"(px, 시작 > 끝 ≥ 0) 또는 "0"(끔 → [0, 0]) 형식의 구간. stepfade·stepnormal(한 층의 화면 px 로 효과를 줄이는 구간)
 * 형식이 틀리면 notes 에 적고 undefined(기본값)
 */
const pairOrOff = (params: URLSearchParams, key: string, notes: string[]): [number, number] | undefined => {
    if (!params.has(key)) return undefined
    const v = params.get(key)!.split(",").map(Number)
    if (v.length === 1 && v[0] === 0) return [0, 0]
    if (v.length === 2 && v.every(Number.isFinite) && v[0] > v[1] && v[1] >= 0) return [v[0], v[1]]
    notes.push(`${key} 는 0 또는 시작,끝(px, 시작 > 끝 ≥ 0)`)
    return undefined
}
const toRadians = (deg: number | undefined) => (deg === undefined ? undefined : (deg * Math.PI) / 180)

/**
 * 해시 쿼리를 App 프리셋과 렌더 디버그 설정으로 해석한다. 형식이 틀린 값은 무시하고 notes 에 적는다
 *
 * @param params 해시의 쿼리
 */
export const parseWalkParams = (params: URLSearchParams): { preset: AppPreset; renderDebug: RenderDebug; notes: string[] } => {
    const notes: string[] = []
    const bboxValues = numberList(params.get("bbox"), 4)
    if (params.has("bbox") && !bboxValues) notes.push("bbox 형식 오류(minx,miny,maxx,maxy)")
    const spawnValues = numberList(params.get("spawn"), 2)
    if (params.has("spawn") && !spawnValues) notes.push("spawn 형식 오류(x,y)")
    const aodebugRaw = number(params, "aodebug")
    const aodebug = aodebugRaw !== undefined && Number.isInteger(aodebugRaw) && aodebugRaw >= 0 && aodebugRaw <= 9 ? (aodebugRaw as AoDebugMode) : undefined
    if (params.has("aodebug") && aodebug === undefined) notes.push("aodebug 는 0 ~ 9")
    const preset: AppPreset = {
        bbox: (bboxValues as Extent | null) ?? undefined,
        walk: !!bboxValues && params.get("walk") !== "0",
        spawn: (spawnValues as [number, number] | null) ?? undefined,
        yaw: toRadians(number(params, "yaw")),
        pitch: toRadians(number(params, "pitch")),
        hover: number(params, "hover"),
    }
    // greenclass=5 · greenclass=1,5: 녹지 색으로 그릴 분류(1 ~ 6). 틀린 값이 하나라도 있으면 무시
    const greenClassRaw = params.has("greenclass") ? params.get("greenclass")!.split(",").map((v) => Number(v.trim())) : undefined
    const greenClass = greenClassRaw && greenClassRaw.length > 0 && greenClassRaw.every((v) => Number.isInteger(v) && v >= 1 && v <= 6) ? greenClassRaw : undefined
    if (params.has("greenclass") && !greenClass) notes.push("greenclass 는 1 ~ 6 의 쉼표 목록(1 숲 · 2 관목 · 3 황야 · 4 초지 · 5 공원 · 6 과수원)")
    const greenAlphaRaw = number(params, "greenalpha")
    if (params.has("greenalpha") && (greenAlphaRaw === undefined || greenAlphaRaw < 0 || greenAlphaRaw > 1)) notes.push("greenalpha 는 0 ~ 1")
    const walkRadiusRaw = number(params, "walkradius")
    const residentRaw = number(params, "resident")
    const renderDebug: RenderDebug = {
        walkRadius: walkRadiusRaw === undefined ? undefined : walkRadiusRaw <= 0 ? Infinity : walkRadiusRaw,
        residentRadius: residentRaw === undefined ? undefined : residentRaw <= 0 ? Infinity : residentRaw,
        ao: flag(params, "ao"),
        shadow: flag(params, "shadow"),
        sky: flag(params, "sky"),
        edge: number(params, "edge"),
        sun: number(params, "sun"),
        aodebug,
        aoRadius: number(params, "aoradius"),
        aoBias: number(params, "aobias"),
        pointerLock: flag(params, "lock"),
        mouseLook: flag(params, "look"),
        pick: flag(params, "pick"),
        band: number(params, "band"),
        roads: flag(params, "roads"),
        roadsClip: flag(params, "roadsclip"),
        roadsBridge: flag(params, "roadsbridge"),
        roadsLift: number(params, "roadslift"),
        roadsMerge: flag(params, "stepmerge"),
        roadsLiftFix: flag(params, "liftfix"),
        roadsBias: number(params, "roadsbias"),
        roadsColor: params.has("roadscolor") ? `#${params.get("roadscolor")}` : undefined,
        water: flag(params, "water"),
        waterClip: flag(params, "waterclip"),
        waterZ: params.get("waterz") === "drape" ? "drape" : params.has("waterz") ? "flat" : undefined,
        waterLines: flag(params, "waterlines"),
        waterLift: number(params, "waterlift"),
        waterWidth: number(params, "waterwidth"),
        waterQ: number(params, "waterq"),
        waterColor: params.has("watercolor") ? `#${params.get("watercolor")}` : undefined,
        stepFade: pairOrOff(params, "stepfade", notes),
        stepNormal: pairOrOff(params, "stepnormal", notes),
        stepDim: number(params, "stepdim"),
        smoothFar: flag(params, "smoothfar"),
        forest: flag(params, "forest"),
        forestRes: number(params, "forestres"),
        forestWalls: flag(params, "forestwalls"),
        forestColor: params.has("forestcolor") ? params.get("forestcolor")!.split(",").map((h) => `#${h.trim()}`) : undefined,
        green: flag(params, "green"),
        greenColor: params.has("greencolor") ? params.get("greencolor")!.split(",").map((h) => `#${h.trim()}`) : undefined,
        greenAlpha: greenAlphaRaw !== undefined && greenAlphaRaw >= 0 && greenAlphaRaw <= 1 ? greenAlphaRaw : undefined,
        greenClass,
        orbitZ: number(params, "orbitz"),
    }
    return { preset, renderDebug, notes }
}
