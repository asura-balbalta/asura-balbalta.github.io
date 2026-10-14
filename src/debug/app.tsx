import React, { useMemo } from "react"

import AppRoot, { AppEnv } from "../app.tsx"

/**
 * 운영 화면 디버그 페이지: 같은 App 을 브라우저 환경만 흉내 내어 띄운다(docs/design-code-plan.md 8절). 지형·둘러보기 프리셋은
 * walk 페이지가 맡고, 이 페이지는 "이 브라우저가 어떤 환경인지" 를 바꾼다. 운영 주소에는 이런 스위치를 두지 않는다(7절 J 결정).
 *
 * 주소: `index.html#/debug/app?gpu=0&glass=0`
 * - gpu=0: WebGPU 미지원 브라우저처럼(진입 토스트·알약, 범위 그리기 막힘). gpu=1 은 실제 판별과 무관하게 지원으로 봄
 * - glass=0 | glass=1: 리퀴드 글래스를 엔진 판별과 무관하게 끄거나 켬(iOS·Safari 재현, Chromium 에서 끄고 비교)
 * 없는 항목은 실제 브라우저 판별을 따른다. 받은 파라미터는 왼쪽 위에 작게 보인다(클릭은 통과)
 */

/** 있으면 "0" 이 아닌지(끄기 스위치). 없으면 undefined(실제 판별) */
const flag = (params: URLSearchParams, key: string) => (params.has(key) ? params.get(key) !== "0" : undefined)

/**
 * 해시 쿼리를 App 의 환경 흉내로 해석한다
 *
 * @param params 해시의 쿼리
 */
export const parseAppParams = (params: URLSearchParams): AppEnv => ({
    webgpu: flag(params, "gpu"),
    glass: flag(params, "glass"),
})

/**
 * @param props.params 해시의 쿼리(src/debug/index.tsx 가 나눠 준다)
 */
export const AppDebugPage = ({ params }: { params: URLSearchParams }) => {
    // 같은 쿼리면 같은 객체를 넘겨 App 이 헛돌지 않게 한다
    const query = params.toString()
    const env = useMemo(() => parseAppParams(new URLSearchParams(query)), [query])
    const rows: [string, string][] = []
    for (const [key, value] of new URLSearchParams(query)) rows.push([key, value])
    return (
        <>
            <AppRoot env={env} />
            <div
                data-debug-page="app"
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
                {"debug/app" + (rows.length === 0 ? " (파라미터 없음)" : "")}
                {rows.map(([key, value]) => `\n${key} = ${value}`).join("")}
            </div>
        </>
    )
}
