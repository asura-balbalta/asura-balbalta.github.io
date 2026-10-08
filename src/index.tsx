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

  /* OpenLayers 기본 CSS 를 넣지 않았으므로 저작권 표시(Attribution 컨트롤)만 직접 꾸민다 */
  .ol-attribution {
    position: absolute;
    right: 0;
    bottom: 0;
    padding: 2px 6px;
    background: rgba(255, 255, 255, 0.7);
    font: 11px sans-serif;
    color: #333;
  }
  .ol-attribution ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .ol-attribution a {
    color: inherit;
  }
  .ol-attribution button {
    display: none;
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
