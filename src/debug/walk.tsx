import React, { useMemo, useState } from "react"

import AppRoot, { AppDebugState } from "../app.tsx"
import { installDebugHooks } from "./hooks"
import { parseWalkParams } from "./walkParams"

export { parseWalkParams }

/**
 * 둘러보기 디버그 페이지(docs/design-code-plan.md 7절 J3). 같은 App 을 초기 상태 프리셋과 렌더 디버그 설정으로 띄워, 범위 선택 →
 * 둘러보기 진입을 손으로 하지 않고 같은 자리·각도를 주소 하나로 다시 연다. 파라미터 해석은 이 모듈 안에서만 한다.
 *
 * 주소: `index.html#/debug/walk?bbox=minx,miny,maxx,maxy&spawn=x,y&yaw=90&pitch=-10&ao=0&shadow=0&sky=0&edge=0.25&sun=60&aodebug=1&lock=0`
 * - bbox: 선택 범위(EPSG:3857 extent. 앱의 selection 과 같은 형식). 있으면 지도가 뜨는 대로 확정해 지형을 받고 3D 로 넘어간다
 * - walk=0 이면 3D 까지만(기본은 bbox 가 있으면 둘러보기 자동 진입)
 * - orbitz: 궤도 보기 초기 카메라가 바라보는 높이(m). 없으면 첫 도엽 z 범위 가운데(5K 가 여럿이면 첫 도엽이 실행마다 달라진다. 매끈한 면 회귀 캡처용)
 * - spawn: 시작 xy(메쉬 로컬, m. 메쉬 origin 을 뺀 EPSG:5179). 없으면 범위 가운데
 * - yaw·pitch: 시작 방향(°, yaw 0 = 동쪽·반시계, 90 = 북쪽)·위아래(°, 위로 +). 없으면 북쪽·수평
 * - hover: 지표 위 이 높이(m)에서 공중 정지한 채 시작(Space 한 번이면 풀린다). 높은 곳에서 본 장면을 같은 자리에서 다시 찍을 때
 * - ao·shadow·sky: 0 이면 끔. edge: 외곽선 세기(0 ~ 1). sun: 태양 고도(°). aodebug: SSAO 디버그 출력 모드(ao.ts AoDebugMode 0 ~ 6)
 * - aoradius·aobias: SSAO 표본 반지름·깊이 여유(m, 기본 1.2·0.03). 띠·후광이 어느 항에 반응하는지 가를 때
 * - stepnormal: 계단형 조명 법선을 매끈한 지형 법선으로 옮기는 구간(한 층의 화면 px, 기본 8,3). 0 이면 끔(면 법선만)
 * - smoothfar=0: 먼 거리 계단 부드럽게 끔(표시: stepfade·stepnormal 0, 생성: 계단형 매끈한 법선 안 만듦. 생성은 범위 확정·다시 만들기 때 적용)
 * - stepdim: 매끈한 법선으로 다 옮겼을 때 바탕색 배수(기본 0.8, 1 이면 보정 없음)
 * - stepfade: 계단형 벽 음영·외곽선을 줄이는 구간(한 층의 화면 px, 기본 4,2). 0 이면 감쇠 끔(먼 산 무아레 비교)
 * - walkradius: 둘러보기 중 장면에 그릴 반경(m). 품질 설정 "보이는 거리"(기본 3000)보다 우선. 0 이면 모두 그림
 * - resident: 둘러보기 중 GPU 에 올려 둘 반경(m, 기본 walkradius 와 같음). 0 이면 내리지 않음(옛 동작)
 * - band: 도엽 생성 때 이웃을 합치는 경계 띠 폭(m). 0 이면 이웃 3×3 전체(옛 동작). 없으면 기본값. 범위 확정 때만 적용된다
 * - roads=0: 도로 레이어를 그리지 않음(회귀 비교). roadsclip=0: 도로 얹기의 B(지형 삼각형으로 자르기) 끔. roadsbridge=0: 교량·고가도 지형을 따라감.
 *   roadslift: 띄움(m, 기본 0.1). roadsbias: 깊이 바이어스(0 이면 끔, 기본 1). roadscolor: 도로색 RRGGBB(# 없이). clip·bridge 는 범위 확정 때만 적용.
 *   stepmerge=0: 계단형 도로의 같은 층 판 합치기 끔. liftfix=0: 계단형 도로 띄우기의 접힘 수정 끔(둘 다 끄면 R1 전 화면 조각과 같아야 한다)
 * - water=0: 물 레이어를 그리지 않음. waterz=flat|drape: 높이 경로(기본 flat = 자체 면, drape = 지형에 얹음. 비교용). waterclip=0: drape 의 B 끔. waterlines=0: 하천선 띠 끔.
 *   waterlift: 띄움(m, 기본 0.05). waterwidth: 띠 폭(m, 전부 같은 값). waterq: 수면 높이 분위수(0 ~ 1, 기본 0.5 중앙값). watercolor: 물색 RRGGBB 또는
 *   RRGGBBAA(# 없이). clip·z·lines·width·q 는 범위 확정 때만
 * - forest=0: 산림을 받지도 칠하지도 않음(지형이 산림 없는 원래 셰이더로 그려져 전과 비트까지 같다). forestres=1|2: 마스크 픽셀 크기(m, 기본 2. 범위 확정 때만).
 *   forestwalls=0: 계단형 벽은 칠하지 않음. forestcolor: 산림 색 RRGGBB(# 없이) 하나(임상 전부) 또는 쉼표로 다섯(임상 0 무립목지 · 1 침엽 · 2 활엽 · 3 혼효 · 4 죽림 순)
 * - green=0: 녹지(OSM)를 받지도 지형을 나누지도 않음(지형 조각·TIN 이 녹지 전과 바이트까지 같다. 범위 확정 때만)
 *   greencolor: 녹지 색 RRGGBB(# 없이) 하나(분류 전부) 또는 쉼표로 여섯(1 숲 · 2 관목 · 3 황야 · 4 초지 · 5 공원 · 6 과수원 순). greenalpha=0 ~ 1: 섞는 비율.
 *   greenclass=5 · greenclass=1,5: 그 분류만 녹지 색, 나머지는 지형 색(비교용)
 * - lock=0: 포인터 잠금 없이 흉내(내장 브라우저·Playwright. 마우스는 어디서 움직여도 시점, Esc 가 포커스 끔)
 * - look=0: 마우스로 시점을 돌리지 않음(자동 캡처. 보이는 창 위를 실제 마우스가 지나가도 시점이 그대로)
 * 해시를 고치면(새로고침 없이) 렌더 디버그 설정은 바로 반영되고, 프리셋(bbox·spawn·yaw·pitch·hover)은 처음 한 번만 적용된다.
 * 받은 파라미터를 왼쪽 위(둘러보기 중 비어 있는 자리. 오른쪽 위는 미니맵)에 작게 보여 무엇이 적용됐는지 확인할 수 있다(클릭은 통과).
 * 그 요소의 data-debug-state(loading | ready | walking)·data-busy(로딩·재생성 중 1)·data-walk-tiles(선택 범위 밖 도엽 수)는
 * 자동 캡처(scripts/render-check.mjs)의 준비 신호다: 둘러보기 중 busy 가 0 이고 도엽 수가 한동안 변하지 않으면 찍는다.
 * 해석(parseWalkParams)은 walkParams.ts(헤드리스 검사 scripts/render-headless.mjs 와 같은 함수)
 */

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
            <AppRoot preset={preset} renderDebug={renderDebug} onDebugState={setState} onDebugApi={installDebugHooks} />
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
