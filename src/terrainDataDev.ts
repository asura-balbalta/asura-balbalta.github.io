// 로컬 개발 서버 전용. /mesh.bin(서버가 여러 도엽을 합친 메쉬)은 정적 파일 서빙에는 없으므로 서비스 코드에서 쓰지 않는다.
import { Extent } from "ol/extent"
import { parseTin, TERRAIN_API, TinMesh } from "./terrainData"

export const fetchMergedMeshDev = async (bbox3857: Extent): Promise<TinMesh> => {
    const res = await fetch(
        `${TERRAIN_API}/mesh.bin?bbox=${bbox3857.join(",")}&crs=3857`,
    )
    if (!res.ok) throw new Error(`/mesh.bin ${res.status}: ${await res.text()}`)
    const mesh = parseTin(await res.arrayBuffer())
    console.log(
        `[dev] /mesh.bin: 도엽 ${res.headers.get("X-Tile-Count")}개, 정점 ${mesh.positions.length / 3}, 삼각형 ${mesh.indices.length / 3}, 누락 도엽 [${res.headers.get("X-Missing-Tiles")}]`,
    )
    return mesh
}
