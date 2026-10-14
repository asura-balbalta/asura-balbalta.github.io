import React, { useMemo, useState } from "react"
import type { Extent } from "ol/extent"

import AppRoot, { AppDebugState, AppPreset } from "../app.tsx"
import type { AoDebugMode } from "../webgpu/ao"
import type { RenderDebug } from "../webgpu/terrainRenderer"

/**
 * 둘러보기 디버그 페이지(docs/design-code-plan.md 7절 J3). 같은 App 을 초기 상태 프리셋과 렌더 디버그 설정으로 띄워, 범위 선택 →
 * 둘러보기 진입을 손으로 하지 않고 같은 자리·각도를 주소 하나로 다시 연다. 파라미터 해석은 이 모듈 안에서만 한다.
 *
 * 주소: `index.html#/debug/walk?bbox=minx,miny,maxx,maxy&spawn=x,y&yaw=90&pitch=-10&ao=0&shadow=0&sky=0&edge=0.25&sun=60&aodebug=1&lock=0`
 * - bbox: 선택 범위(EPSG:3857 extent. 앱의 selection 과 같은 형식). 있으면 지도가 뜨는 대로 확정해 지형을 받고 3D 로 넘어간다
 * - walk=0 이면 3D 까지만(기본은 bbox 가 있으면 둘러보기 자동 진입)
 * - spawn: 시작 xy(메쉬 로컬, m. 메쉬 origin 을 뺀 EPSG:5179). 없으면 범위 가운데
 * - yaw·pitch: 시작 방향(°, yaw 0 = 동쪽·반시계, 90 = 북쪽)·위아래(°, 위로 +). 없으면 북쪽·수평
 * - ao·shadow·sky: 0 이면 끔. edge: 외곽선 세기(0 ~ 1). sun: 태양 고도(°). aodebug: SSAO 디버그 출력 모드(ao.ts AoDebugMode 0 ~ 6)
 * - walkradius: 둘러보기 중 장면에 그릴 반경(m, 기본 5000). 0 이면 모두 그림
 * - lock=0: 포인터 잠금 없이 흉내(내장 브라우저·Playwright. 마우스는 어디서 움직여도 시점, Esc 가 포커스 끔)
 * - look=0: 마우스로 시점을 돌리지 않음(자동 캡처. 보이는 창 위를 실제 마우스가 지나가도 시점이 그대로)
 * 해시를 고치면(새로고침 없이) 렌더 디버그 설정은 바로 반영되고, 프리셋(bbox·spawn·yaw·pitch)은 처음 한 번만 적용된다.
 * 받은 파라미터를 왼쪽 위(둘러보기 중 비어 있는 자리. 오른쪽 위는 미니맵)에 작게 보여 무엇이 적용됐는지 확인할 수 있다(클릭은 통과).
 * 그 요소의 data-debug-state(loading | ready | walking)·data-busy(로딩·재생성 중 1)·data-walk-tiles(선택 범위 밖 도엽 수)는
 * 자동 캡처(scripts/render-check.mjs)의 준비 신호다: 둘러보기 중 busy 가 0 이고 도엽 수가 한동안 변하지 않으면 찍는다
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
    const aodebug = aodebugRaw !== undefined && Number.isInteger(aodebugRaw) && aodebugRaw >= 0 && aodebugRaw <= 6 ? (aodebugRaw as AoDebugMode) : undefined
    if (params.has("aodebug") && aodebug === undefined) notes.push("aodebug 는 0 ~ 6")
    const preset: AppPreset = {
        bbox: (bboxValues as Extent | null) ?? undefined,
        walk: !!bboxValues && params.get("walk") !== "0",
        spawn: (spawnValues as [number, number] | null) ?? undefined,
        yaw: toRadians(number(params, "yaw")),
        pitch: toRadians(number(params, "pitch")),
    }
    const walkRadiusRaw = number(params, "walkradius")
    const renderDebug: RenderDebug = {
        walkRadius: walkRadiusRaw === undefined ? undefined : walkRadiusRaw <= 0 ? Infinity : walkRadiusRaw,
        ao: flag(params, "ao"),
        shadow: flag(params, "shadow"),
        sky: flag(params, "sky"),
        edge: number(params, "edge"),
        sun: number(params, "sun"),
        aodebug,
        pointerLock: flag(params, "lock"),
        mouseLook: flag(params, "look"),
        pick: flag(params, "pick"),
    }
    return { preset, renderDebug, notes }
}

/**
 * @param props.params 해시의 쿼리(src/debug/index.tsx 가 나눠 준다)
 */
export const WalkDebugPage = ({ params }: { params: URLSearchParams }) => {
    // 같은 쿼리면 같은 객체를 넘겨 App 의 effect 가 헛돌지 않게 한다
    const query = params.toString()
    const { preset, renderDebug, notes } = useMemo(() => parseWalkParams(new URLSearchParams(query)), [query])
    const rows: [string, string][] = []
    for (const [key, value] of new URLSearchParams(query)) rows.push([key, value])
    const [state, setState] = useState<AppDebugState>({ busy: false, walking: false, tiles: 0 })
    const debugState = state.walking ? "walking" : state.busy ? "loading" : "ready"
    return (
        <>
            <AppRoot preset={preset} renderDebug={renderDebug} onDebugState={setState} />
            <div
                data-debug-page="walk"
                data-debug-state={debugState}
                data-busy={state.busy ? 1 : 0}
                data-walk-tiles={state.tiles}
                style={{
                    position: "fixed",
                    top: 8,
                    left: 8,
                    zIndex: 1000,
                    pointerEvents: "none",
                    padding: "6px 8px",
                    borderRadius: 6,
                    background: "rgba(0, 0, 0, 0.55)",
                    color: "#fff",
                    fontFamily: "monospace",
                    fontSize: 11,
                    lineHeight: 1.4,
                    whiteSpace: "pre",
                }}
            >
                {"debug/walk" + (rows.length === 0 ? " (파라미터 없음)" : "")}
                {rows.map(([key, value]) => `\n${key} = ${value}`).join("")}
                {notes.map((note) => `\n! ${note}`).join("")}
                {`\n[${debugState}${state.busy ? " busy" : ""}${state.walking ? ` tiles=${state.tiles}` : ""}]`}
            </div>
        </>
    )
}
