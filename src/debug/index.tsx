import React from "react"

import { AppDebugPage } from "./app.tsx"
import { WalkDebugPage } from "./walk.tsx"

/** 디버그 페이지 해시 접두. `index.html#/debug/<페이지>?<쿼리>` */
const DEBUG_PREFIX = "#/debug/"

export const isDebugHash = (hash: string) => hash.startsWith(DEBUG_PREFIX)

/**
 * 해시를 페이지 이름과 쿼리로 나눈다. `#/debug/walk?bbox=1,2,3,4` → { page: "walk", params: bbox=1,2,3,4 }
 *
 * @param hash window.location.hash
 */
export const parseDebugHash = (hash: string) => {
    const body = hash.slice(DEBUG_PREFIX.length)
    const q = body.indexOf("?")
    return {
        page: q < 0 ? body : body.slice(0, q),
        params: new URLSearchParams(q < 0 ? "" : body.slice(q + 1)),
    }
}

/** 디버그 페이지 이름 → 컴포넌트. 새 페이지는 src/debug/<이름>.tsx 로 만들고 여기에 더한다 */
const PAGES: Record<string, (props: { params: URLSearchParams }) => React.ReactElement> = {
    walk: WalkDebugPage,
    app: AppDebugPage,
}

/**
 * 디버그 페이지 선택(src/index.tsx 가 해시가 `#/debug/` 일 때 그린다). 파라미터 해석은 각 페이지 모듈 안에서만 한다.
 * 운영 빌드에도 들어 있다(운영 주소에서는 해시가 없어 그려지지 않는다)
 *
 * @param props.hash window.location.hash
 */
export const DebugPage = ({ hash }: { hash: string }) => {
    const { page, params } = parseDebugHash(hash)
    const Page = PAGES[page]
    if (!Page) {
        return (
            <div style={{ padding: 16, fontFamily: "monospace", fontSize: 13 }}>
                알 수 없는 디버그 페이지 "{page}". 있는 페이지: {Object.keys(PAGES).join(", ")} (예: #/debug/walk?bbox=…)
            </div>
        )
    }
    return <Page params={params} />
}
