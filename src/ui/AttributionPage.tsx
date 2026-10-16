import { FluentProvider } from "@fluentui/react-components"
import React from "react"

import { AttributionContent } from "./AttributionContent"
import { fluentTheme, uiCssVars } from "./theme"

/**
 * 출처 페이지 `#/attribution`(src/index.tsx 가 해시로 고른다). 내려받기 파일 메타데이터·README 가 링크하는 주소라 앱 밖에서
 * 열린다. 앱 안에서는 같은 내용을 AttributionDialog 로 본다(페이지로 가면 App 이 내려가 받아 둔 지형을 잃는다).
 * 운영체제의 라이트·다크 설정을 따른다. 모양은 ui.css(.ui-attribution-page)
 */
export const AttributionPage = () => {
    const theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
    return (
        <FluentProvider theme={fluentTheme(theme)} style={uiCssVars(theme)}>
            <main className="ui-attribution-page">
                <div className="ui-attribution-page-body">
                    <h1>원본 데이터 출처</h1>
                    <AttributionContent />
                    <p className="ui-attribution-back">
                        <a href="/">지도로 가기</a>
                    </p>
                </div>
            </main>
        </FluentProvider>
    )
}

/** `#/attribution`(뒤에 쿼리가 붙어도) */
export const isAttributionHash = (hash: string) => hash === "#/attribution" || hash.startsWith("#/attribution?")
