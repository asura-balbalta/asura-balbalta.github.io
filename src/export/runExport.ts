import { exportLayerCredit } from "../attribution"
import { LAYER_DEFS, LayerId, LayerStates } from "../layers"
import type { TerrainMode } from "../webgpu/terrainRenderer"
import { export3dmInWorker } from "./3dmClient"
import { downloadBlob, exportFileName, ExportKind } from "./download"
import { exportGlbInWorker } from "./glbClient"
import { GreenExport, GreenFaceRange, hasGreenFaces, hexToRgb } from "./greenExport"
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

/** 녹지 분류 이름(분류 코드 1 ~ 6 순. 색상표 greenColors 와 같은 순서, 서버 codes.json green_class 와 같은 이름) */
const GREEN_CLASS_LABELS = ["숲", "관목", "황야", "초지", "공원", "과수원"]

/**
 * "내보내기" 에 체크된 레이어 중 메쉬가 있는 것. 녹지(osmGreen)는 자기 메쉬가 없고 지형의 분류 범위로 존재하므로(b-2), 지형도 내보내고
 * 지형에 녹지 분류 삼각형이 있을 때만 든다(meshes.osmGreen 이 truthy 여도 든다: 패널 꼬리말이 도엽 통계로 부를 때)
 */
export const exportableLayers = (meshes: Partial<Record<LayerId, unknown>>, layers: LayerStates): LayerId[] => {
    const present = (id: LayerId) => {
        if (id !== "osmGreen") return !!meshes[id]
        if (!layers.terrain?.export || !meshes.terrain) return false
        return !!meshes.osmGreen || hasGreenFaces((meshes.terrain as { greenRanges?: GreenFaceRange[] }).greenRanges)
    }
    return LAYER_DEFS.map((d) => d.id).filter((id) => layers[id]?.export && present(id))
}

/** 분류별 삼각형 수 요약("숲 1,234 · 공원 567") */
const greenSummary = (ranges: GreenFaceRange[]) => {
    const counts = new Array<number>(GREEN_CLASS_LABELS.length + 1).fill(0)
    for (const r of ranges) if (r.cls > 0 && r.cls < counts.length) counts[r.cls] += r.count
    return counts
        .map((n, c) => (c > 0 && n > 0 ? `${GREEN_CLASS_LABELS[c - 1]} ${n.toLocaleString()}` : ""))
        .filter(Boolean)
        .join(" · ")
}

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
 * @param options.greenColors 녹지를 담을 때 분류 재질 색(지금 색상표의 greenColors, 분류 1 ~ 6 순)
 * @returns 파일에 담긴 레이어 목록과 완료 안내에 덧붙일 출처 줄(녹지를 담으면 "© OpenStreetMap contributors (ODbL)". STL 처럼 메타가 없는
 *   형식에서는 이 안내가 유일한 출처 표시라 형식과 무관하게 돌려준다). 담을 레이어가 없으면 reject(Error)
 */
export const runExport = async (
    kind: ExportKind,
    meshes: LayerMeshes,
    layers: LayerStates,
    options: { mode: TerrainMode; step: number; onProgress?: (ratio: number) => void; greenColors?: string[] },
): Promise<{ included: LayerId[]; credits: string[] }> => {
    const included = exportableLayers(meshes, layers)
    if (included.length === 0) throw new Error("내보낼 레이어가 없습니다")
    const selected = {} as LayerMeshes
    for (const id of Object.keys(meshes) as LayerId[]) selected[id] = included.includes(id) ? meshes[id] : null
    // 녹지: 담으면 지형의 분류 범위를 남기고 이름·색·출처를 싣는다. 안 담으면 범위를 떼어 지형을 전처럼 한 재질로
    const terrain = selected.terrain
    let green: GreenExport | undefined
    const credits: string[] = []
    if (terrain?.greenRanges) {
        if (included.includes("osmGreen")) {
            const credit = await exportLayerCredit("osmGreen", "녹지")
            green = {
                classes: GREEN_CLASS_LABELS.map((name, i) => ({ cls: i + 1, name: `녹지-${name}`, rgb: hexToRgb(options.greenColors?.[i] ?? "") })),
                source: { source: credit.provider, source_url: credit.url, license: credit.license },
                fileLine: credit.fileLine,
            }
            credits.push(credit.short)
        } else {
            const { greenRanges: _drop, ...plain } = terrain
            selected.terrain = plain
        }
    }
    const label = kind.toUpperCase()
    const started = performance.now()
    const blob = await EXPORTERS[kind](selected, { ...options, green }).promise
    // STL 은 크기에서 삼각형 수를 역산할 수 있고, 다른 형식은 그럴 수 없다
    const triangles =
        kind === "stl" ? `삼각형 ${((blob.size - STL_HEADER_BYTES) / STL_TRIANGLE_BYTES).toLocaleString()}개, ` : ""
    console.log(
        `${label} 생성 (${included.join("+")}, 지형 ${options.mode}) ${(performance.now() - started).toFixed(0)}ms: ` +
            `${triangles}${(blob.size / 1048576).toFixed(1)}MB` +
            (green && terrain?.greenRanges ? `, 녹지 삼각형 ${greenSummary(terrain.greenRanges)}` : ""),
    )
    downloadBlob(blob, exportFileName(options.mode, included, kind))
    return { included, credits }
}
