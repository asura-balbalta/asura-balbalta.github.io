import { Feature } from "ol"
import { Coordinate } from "ol/coordinate"
import GeoJSON from "ol/format/GeoJSON"
import { Point, Polygon } from "ol/geom"
import { Projection } from "ol/proj"

export const createFeatureCollectionData = (
    feature: Feature,
    bbox: number[],
) => {
    const geojson = new GeoJSON()
    const featureCollection = JSON.parse(geojson.writeFeatures([feature]))
    featureCollection.bbox = bbox

    return featureCollection
}

export const createPointFeature = (coords: Coordinate, crs: Projection) => {
    const point = new Point(coords)
    const pointFeature = new Feature(point)
    pointFeature.setProperties({ crs: crs.getCode() })
    return pointFeature
}

export const createPointFeatureCollectionData = (
    coords: Coordinate,
    crs: Projection,
) => {
    const pointFeature = createPointFeature(coords, crs)
    const bbox = [coords[0], coords[1], coords[0], coords[1]]

    return createFeatureCollectionData(pointFeature, bbox)
}

export const createBoxFeature = (
    pt1: Coordinate,
    pt2: Coordinate,
    crs: Projection,
) => {
    // 두 점을 받아 사각형 좌표 계산
    const [x1, y1] = pt1
    const [x2, y2] = pt2

    // 사각형 꼭짓점 좌표 계산 (시계방향)
    const minX = Math.min(x1, x2)
    const maxX = Math.max(x1, x2)
    const minY = Math.min(y1, y2)
    const maxY = Math.max(y1, y2)

    const boxCoords = [
        [minX, minY],
        [minX, maxY],
        [maxX, maxY],
        [maxX, minY],
        [minX, minY], // 폴리곤 닫기
    ]

    const boxFeature = new Feature({
        geometry: new Polygon([boxCoords]),
    })

    boxFeature.setProperties({ crs: crs.getCode() })

    return boxFeature
}

export const loadFeatureCollection = async (url: string) => {
    const res = await fetch(url)
    const featureCollectionData = await res.json()
    const features = new GeoJSON().readFeatures(featureCollectionData)
    return features
}
