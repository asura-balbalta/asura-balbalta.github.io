import React, { useEffect } from "react"

import { firebaseApp } from "./fb"
import { initOlMap } from "./olmap"

export default function App() {
    useEffect(() => {
        initOlMap()
    }, [])

    return <div id="map" style={{ width: "100%", height: "100vh" }}></div>
}
