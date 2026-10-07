import React, { Provider } from "react"
import { createRoot } from "react-dom/client"
import { createGlobalStyle } from "styled-components"
import reset from "styled-reset"

import App from "./app.tsx"

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
