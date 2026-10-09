import { LAYER_DEFS, LayerId, LayerStates } from "../layers"
import type { TerrainMode } from "../webgpu/terrainRenderer"
import { export3dmInWorker } from "./3dmClient"
import { downloadBlob, exportFileName, ExportKind } from "./download"
import { exportGlbInWorker } from "./glbClient"
import { exportSkpInWorker } from "./skpClient"
import { STL_HEADER_BYTES, STL_TRIANGLE_BYTES } from "./stl"
import { ExportOptions, exportStlInWorker, LayerMeshes } from "./stlClient"

/** 형식별 Worker 호출. 새 형식은 여기와 EXPORT_KINDS 에만 더한다 */
const EXPORTERS: Record<ExportKind, (layers: LayerMeshes, options: ExportOptions) => { promise: Promise<Blob> }> = {
    stl: exportStlInWorker,
    skp: exportSkpInWorker,
    "3dm": export3dmInWorker,
    glb: exportGlbInWorker,
}

/** 화면에 보일 형식 목록. label 은 파일 형식 이름, description 은 패널의 보조 설명 */
export const EXPORT_KINDS: { kind: ExportKind; label: string; description: string }[] = [
    { kind: "stl", label: "STL", description: "3D 프린트 · 메쉬" },
    { kind: "skp", label: "SKP", description: "SketchUp" },
    { kind: "3dm", label: "3DM", description: "Rhino" },
    { kind: "glb", label: "GLB", description: "glTF · Blender" },
]

/** "내보내기" 에 체크된 레이어 중 메쉬가 있는 것 */
export const exportableLayers = (meshes: LayerMeshes, layers: LayerStates): LayerId[] =>
    LAYER_DEFS.map((d) => d.id).filter((id) => layers[id]?.export && meshes[id])

/**
 * "내보내기" 에 체크된 레이어를 한 파일로 만들어 내려받는다. Worker 가 메쉬 사본으로 일하므로, 생성 중에 다른 지역을
 * 골라도 먼저 시작한 내보내기는 그대로 끝난다. 화면(패널·상태 표시줄·토스트)은 app 이 맡고 여기는 파일만 만든다.
 *
 * @param kind 형식
 * @param meshes 레이어별 메쉬(원점 기준). 아직 없는 레이어는 null
 * @param layers 레이어별 보기·내보내기 상태
 * @param options.mode 지형 표현 방식. 지형은 이대로 적는다
 * @param options.step stepped 일 때 층 간격(m)
 * @param options.onProgress 진행률(0 ~ 1)
 * @returns 파일에 담긴 레이어 목록. 담을 레이어가 없으면 reject(Error)
 */
export const runExport = async (
    kind: ExportKind,
    meshes: LayerMeshes,
    layers: LayerStates,
    options: { mode: TerrainMode; step: number; onProgress?: (ratio: number) => void },
): Promise<{ included: LayerId[] }> => {
    const included = exportableLayers(meshes, layers)
    if (included.length === 0) throw new Error("내보낼 레이어가 없습니다")
    const selected = {} as LayerMeshes
    for (const id of Object.keys(meshes) as LayerId[]) selected[id] = included.includes(id) ? meshes[id] : null
    const label = kind.toUpperCase()
    const started = performance.now()
    const blob = await EXPORTERS[kind](selected, options).promise
    // STL 은 크기에서 삼각형 수를 역산할 수 있고, 다른 형식은 그럴 수 없다
    const triangles =
        kind === "stl" ? `삼각형 ${((blob.size - STL_HEADER_BYTES) / STL_TRIANGLE_BYTES).toLocaleString()}개, ` : ""
    console.log(
        `${label} 생성 (${included.join("+")}, 지형 ${options.mode}) ${(performance.now() - started).toFixed(0)}ms: ` +
            `${triangles}${(blob.size / 1048576).toFixed(1)}MB`,
    )
    downloadBlob(blob, exportFileName(options.mode, included, kind))
    return { included }
}
