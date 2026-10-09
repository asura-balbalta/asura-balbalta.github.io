import React from "react"
import { createRoot } from "react-dom/client"
import { createGlobalStyle } from "styled-components"
import reset from "styled-reset"

import App from "./app.tsx"
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

// iOS Safari 는 viewport 의 user-scalable=no 를 무시하고 두 손가락 벌리기로 페이지를 확대한다. 3D 캔버스는
// touch-action: none 으로 막지만, 그 밖의 영역에서 시작된 제스처까지 막아 페이지가 확대되지 않게 한다
document.addEventListener("gesturestart", (e) => e.preventDefault(), { passive: false })

root.render(
    <>
        {/* <React.StrictMode> */}
        <GlobalStyle />
        <App />
        {/* </React.StrictMode> */}
    </>,
)
