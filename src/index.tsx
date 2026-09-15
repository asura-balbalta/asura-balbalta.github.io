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

  body {
    line-height: normal;
  }
`

root.render(
    <>
        {/* <React.StrictMode> */}
        <GlobalStyle />
        <App />
        {/* </React.StrictMode> */}
    </>,
)
