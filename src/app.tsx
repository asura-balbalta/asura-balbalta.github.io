import React, { CSSProperties, useEffect, useRef, useState } from "react"
import { Map } from "ol"
import { Extent } from "ol/extent"

import { firebaseApp } from "./fb"
import { initOlMap } from "./olmap"
import { TinMesh } from "./terrainData"
import { fetchMergedMeshDev } from "./terrainDataDev"
import { TerrainViewCanvas } from "./components/TerrainViewCanvas"

const fullMapStyle: CSSProperties = { width: "100%", height: "100vh" }

const miniMapStyle: CSSProperties = {
    position: "fixed",
    top: 16,
    right: 16,
    width: 320,
    height: 220,
    zIndex: 10,
    borderRadius: 8,
    overflow: "hidden",
    border: "2px solid rgba(255, 255, 255, 0.35)",
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.5)",
}

export default function App() {
    const mapRef = useRef<Map | null>(null)
    const [selection, setSelection] = useState<Extent | null>(null)
    const [mesh, setMesh] = useState<TinMesh | null>(null)

    useEffect(() => {
        initOlMap((bbox) => {
            setSelection(bbox)
            // 개발용: 로컬 서버의 /mesh.bin 으로 받은 메쉬를 3D 로 표시
            fetchMergedMeshDev(bbox)
                .then(setMesh)
                .catch((err) => console.error(err))
        }).then((map) => (mapRef.current = map))
    }, [])

    const isMiniMap = mesh !== null

    useEffect(() => {
        const map = mapRef.current
        if (!map) return
        // 지도 div 크기가 바뀌면 OpenLayers 에 알려야 다시 그린다
        map.updateSize()
        if (isMiniMap && selection) {
            map.getView().fit(selection, { padding: [20, 20, 20, 20] })
        }
    }, [isMiniMap, selection])

    return (
        <>
            {mesh && <TerrainViewCanvas mesh={mesh} />}
            <div id="map" style={isMiniMap ? miniMapStyle : fullMapStyle}></div>
        </>
    )
}
