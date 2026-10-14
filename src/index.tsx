import React, { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { createGlobalStyle } from "styled-components"
import reset from "styled-reset"

import App from "./app.tsx"
import { DebugPage, isDebugHash } from "./debug/index.tsx"
// 그릇(레일·패널·상태 표시줄 등)의 재질·배치. esbuild 가 dist/index.css 로 내고 dist/index.html 이 링크한다
import "./ui/ui.css"

const rootElement =
    document.getElementById("root") || document.createElement("div")
const root = createRoot(rootElement)

const GlobalStyle = createGlobalStyle`
  ${reset}
  /* other styles */

  html, body {
    /* 모바일에서 가장자리 당김(당겨서 새로고침·튕김)이 3D 조작을 끊지 않게 */
    overscroll-behavior: none;
  }

  body {
    line-height: normal;
    /* UI 글꼴은 운영체제 글꼴(ui/theme.ts UI_FONT_FAMILY 와 같은 스택). 숫자(퍼센트·n/N·km)는 폭을 고정해 흔들리지 않게 */
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', sans-serif;
    font-variant-numeric: tabular-nums;
  }
`

/**
 * 페이지 선택(docs/design-code-plan.md 7절): 주소 해시가 `#/debug/` 로 시작하면 디버그 페이지(src/debug/), 아니면 운영 App.
 * 번들 하나·같은 App 이고 페이지만 상태로 고른다. 해시가 바뀌면(hashchange) 새로고침 없이 따라간다.
 * 해시라 정적 서버(npx serve dist)·Firebase 설정에 손댈 것이 없다
 */
const Root = () => {
    const [hash, setHash] = useState(window.location.hash)
    useEffect(() => {
        const onHashChange = () => setHash(window.location.hash)
        window.addEventListener("hashchange", onHashChange)
        return () => window.removeEventListener("hashchange", onHashChange)
    }, [])
    return isDebugHash(hash) ? <DebugPage hash={hash} /> : <App />
}

// iOS Safari 는 viewport 의 user-scalable=no 를 무시하고 두 손가락 벌리기로 페이지를 확대한다. 3D 캔버스는
// touch-action: none 으로 막지만, 그 밖의 영역에서 시작된 제스처까지 막아 페이지가 확대되지 않게 한다
document.addEventListener("gesturestart", (e) => e.preventDefault(), { passive: false })

root.render(
    <>
        {/* <React.StrictMode> */}
        <GlobalStyle />
        <Root />
        {/* </React.StrictMode> */}
    </>,
)
