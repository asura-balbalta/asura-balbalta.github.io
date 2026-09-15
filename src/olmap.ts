import Map from "ol/Map"
import View from "ol/View"
import TileLayer from "ol/layer/Tile"
import { StadiaMaps, XYZ } from "ol/source"
import { Projection, transform } from "ol/proj"
import Feature, { FeatureLike } from "ol/Feature"
import Point from "ol/geom/Point"
import VectorLayer from "ol/layer/Vector"
import VectorSource from "ol/source/Vector"
import { Coordinate } from "ol/coordinate"
import GeoJSON from "ol/format/GeoJSON.js"
import { MapEvent } from "ol"

export const initOlMap = async () => {
    let center = [14136104.293764262, 4514380.225694263] // 위치정보 허용 안할 경우 기본 좌표 (녹사평역 인근)
    const map = new Map({
        target: "map",
        layers: [
            new TileLayer({
                source: new StadiaMaps({
                    // See our gallery for more styles: https://docs.stadiamaps.com/themes/
                    layer: "alidade_smooth_dark",
                    retina: true, // Set to false for stamen_watercolor
                }),
            }),

            // osm
            // new TileLayer({
            //     source: new XYZ({
            //         url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
            //     }),
            // }),
        ],
        view: new View({
            center: center,
            zoom: 15,
            minZoom: 10,
            maxZoom: 18,
            projection: "EPSG:3857",
            // rotation: Math.PI / 2 // 시계방향 90
        }),
        controls: [],
    })

    if ("geolocation" in navigator) {
        /* geolocation is available */
        navigator.geolocation.getCurrentPosition((position) => {
            console.log(position.coords.longitude, position.coords.latitude)
            const metricCoords = transform(
                [position.coords.longitude, position.coords.latitude],
                "EPSG:4326",
                "EPSG:3857",
            )
            map.getView().setCenter(metricCoords)
        })
    } else {
        /* geolocation IS NOT available */
        // console.log('geolocation IS NOT available')
        // map.getView().setCenter([14136104.293764262, 4514380.225694263])
    }
}
