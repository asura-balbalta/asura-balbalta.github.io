import { Feature, Map, MapBrowserEvent, MapEvent } from "ol"
import { EventsKey } from "ol/events"
import { createBoxFeature, createFeatureCollectionData } from "./featureUtil"
import VectorSource from "ol/source/Vector"
import VectorLayer from "ol/layer/Vector"
import { unByKey } from "ol/Observable"
import { getTilesInBbox } from "./terrainData"
import { fetchMergedMeshDev } from "./terrainDataDev"
import { drawMeshPoints, drawTileOutlines } from "./tileOverlay"

const squareToolHelper: {
    clickCount: number
    ptCoords: number[]
    eventsKeys: EventsKey[]
    boxFeature?: Feature
} = {
    clickCount: 0,
    ptCoords: [],
    eventsKeys: [],
}

const SQUARE_RANGE_LAYER_NAME = "squareRangeBox"

export const resetSquareTool = (map: Map, parent?: Window) => {
    squareToolHelper.clickCount = 0
    squareToolHelper.ptCoords = []
    if (squareToolHelper.eventsKeys.length > 0) {
        for (const eventsKey of squareToolHelper.eventsKeys) {
            unByKey(eventsKey)
        }

        squareToolHelper.eventsKeys = []
    }
    squareToolHelper.boxFeature = undefined

    map.getAllLayers()
        .filter((layer) => layer.get("name") === SQUARE_RANGE_LAYER_NAME)
        .forEach((layer) => map.removeLayer(layer))

    // const toParentUnsetSquareRequestData: messageDataToParent = {
    //     requestType: toParentRequestType.UNSET_SQUARE,
    //     args: {},
    // }
    // sendRequestMessageFromMapToParent(toParentUnsetSquareRequestData, parent)
}

export const squareToolClickEventHandler = (
    ev: MapBrowserEvent,
    map: Map,
    parent?: Window,
) => {
    squareToolHelper.ptCoords = squareToolHelper.ptCoords.concat(ev.coordinate)

    if (squareToolHelper.clickCount === 0) {
        squareToolHelper.clickCount += 1

        const squareRangeTrackEventsKey = map.on("pointermove", (ev) => {
            // console.log(ev.coordinate)
            map.getAllLayers()
                .filter(
                    (layer) => layer.get("name") === SQUARE_RANGE_LAYER_NAME,
                )
                .forEach((layer) => map.removeLayer(layer))

            const pt1 = squareToolHelper.ptCoords.slice(0, 2)
            const pt2 = ev.coordinate
            const boxFeature = createBoxFeature(
                pt1,
                pt2,
                ev.map.getView().getProjection(),
            )

            const vectorSource = new VectorSource({
                features: [boxFeature],
            })

            const squareRangeLayer = new VectorLayer({
                source: vectorSource,
                style: {
                    "fill-color": "rgba(186, 230, 253, 0.1)",
                    "stroke-color": "#BAE6FD",
                    "stroke-width": 1.5,
                },
            })
            squareRangeLayer.set("name", SQUARE_RANGE_LAYER_NAME)

            map.addLayer(squareRangeLayer)
        })
        squareToolHelper.eventsKeys.push(squareRangeTrackEventsKey)
    } else if (squareToolHelper.clickCount === 1) {
        const pt1 = squareToolHelper.ptCoords.slice(0, 2)
        const pt2 = squareToolHelper.ptCoords.slice(2, 4)
        const boxFeature = createBoxFeature(
            pt1,
            pt2,
            ev.map.getView().getProjection(),
        )

        const bbox = boxFeature.getGeometry()?.getExtent()
        console.log(bbox)
        if (bbox) {
            getTilesInBbox(bbox)
                .then(({ tiles }) => drawTileOutlines(map, tiles))
                .catch((err) => console.error(err))
            // 개발용: 로컬 서버의 /mesh.bin 으로 표고 데이터 확인
            fetchMergedMeshDev(bbox)
                .then((mesh) => drawMeshPoints(map, mesh))
                .catch((err) => console.error(err))
        }

        // const toParentSetSquareRequestData: messageDataToParent = {
        //     requestType: toParentRequestType.SET_SQUARE,
        //     args: {
        //         featureCollection: createFeatureCollectionData(
        //             boxFeature,
        //             bbox!,
        //         ),
        //     },
        // }
        // sendRequestMessageFromMapToParent(toParentSetSquareRequestData, parent)

        for (const eventsKey of squareToolHelper.eventsKeys) {
            unByKey(eventsKey)
        }
        squareToolHelper.boxFeature = boxFeature

        squareToolHelper.clickCount = 0
        squareToolHelper.ptCoords = []
        squareToolHelper.eventsKeys = []
    } else {
    }
}
