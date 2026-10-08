import React, { CSSProperties, useState } from "react"

import { LAYER_DEFS, LayerId, LayerStates } from "../layers"
import type { TerrainMode } from "../webgpu/terrainRenderer"
import { export3dmInWorker } from "./3dmClient"
import { downloadBlob, exportFileName, ExportKind } from "./download"
import { exportSkpInWorker } from "./skpClient"
import { STL_HEADER_BYTES, STL_TRIANGLE_BYTES } from "./stl"
import { ExportOptions, exportStlInWorker, LayerMeshes } from "./stlClient"

/** 형식별 Worker 호출. 새 형식은 여기와 EXPORT_KINDS 에만 더한다 */
const EXPORTERS: Record<ExportKind, (layers: LayerMeshes, options: ExportOptions) => { promise: Promise<Blob> }> = {
    stl: exportStlInWorker,
    skp: exportSkpInWorker,
    "3dm": export3dmInWorker,
}

/** 화면에 보일 형식 목록과 버튼 문구 */
const EXPORT_KINDS: { kind: ExportKind; label: string }[] = [
    { kind: "stl", label: "STL 내려받기" },
    { kind: "skp", label: "SKP 내려받기" },
    { kind: "3dm", label: "3DM 내려받기" },
]

/**
 * 내보내기 버튼 줄. "내보내기" 에 체크된 레이어를 STL 또는 SKP 파일 하나로 만들어 내려받는다.
 *
 * 생성 중에는 버튼 대신 진행률 배지를 보인다. Worker 가 메쉬 사본으로 일하므로, 생성 중에 다른 지역을 골라도
 * 먼저 시작한 내보내기는 그대로 끝난다. app 은 이 컴포넌트를 버튼 줄 안에 두기만 하고, 형식 추가는 export 폴더 안에서 끝낸다.
 *
 * @param props.meshes 레이어별 메쉬(원점 기준). 아직 없는 레이어는 null
 * @param props.layers 레이어별 보기·내보내기 상태
 * @param props.mode 지형 표현 방식. 지형은 이대로 적는다
 * @param props.step stepped 일 때 층 간격(m)
 * @param props.active 버튼을 보일지(지형이 준비됐고 다른 작업 중이 아닐 때). 생성 중 배지는 이와 무관하게 보인다
 * @param props.buttonStyle 버튼 모양(app 의 다른 버튼과 맞춤)
 * @param props.badgeStyle 배지 모양
 */
export const ExportButtons = ({
    meshes,
    layers,
    mode,
    step,
    active,
    buttonStyle,
    badgeStyle,
}: {
    meshes: LayerMeshes
    layers: LayerStates
    mode: TerrainMode
    step: number
    active: boolean
    buttonStyle: CSSProperties
    badgeStyle: CSSProperties
}) => {
    /** 생성 중이면 배지에 보일 문구, 아니면 null */
    const [exporting, setExporting] = useState<string | null>(null)

    const runExport = (kind: ExportKind) => {
        if (exporting) return
        const label = kind.toUpperCase()
        const selected = {} as LayerMeshes
        for (const id of Object.keys(meshes) as LayerId[]) selected[id] = layers[id]?.export ? meshes[id] : null
        const included = LAYER_DEFS.map((d) => d.id).filter((id) => selected[id])
        if (included.length === 0) {
            window.alert(`${label} 에 넣을 레이어를 하나 이상 체크하세요`)
            return
        }
        setExporting(`${label} 생성 중…`)
        const started = performance.now()
        const options = {
            mode,
            step,
            onProgress: (ratio: number) => setExporting(`${label} 생성 중… ${Math.floor(ratio * 100)}%`),
        }
        const { promise } = EXPORTERS[kind](selected, options)
        promise
            .then((blob) => {
                // STL 은 크기에서 삼각형 수를 역산할 수 있고, 다른 형식은 그럴 수 없다
                const triangles =
                    kind === "stl" ? `삼각형 ${((blob.size - STL_HEADER_BYTES) / STL_TRIANGLE_BYTES).toLocaleString()}개, ` : ""
                console.log(
                    `${label} 생성 (${included.join("+")}, 지형 ${mode}) ${(performance.now() - started).toFixed(0)}ms: ` +
                        `${triangles}${(blob.size / 1048576).toFixed(1)}MB`,
                )
                downloadBlob(blob, exportFileName(mode, included, kind))
            })
            .catch((err) => {
                console.error(err)
                window.alert(`${label} 생성에 실패했습니다: ${err.message}`)
            })
            .finally(() => setExporting(null))
    }

    if (exporting) return <div style={badgeStyle}>{exporting}</div>
    if (!active) return null
    return (
        <>
            {EXPORT_KINDS.map(({ kind, label }) => (
                <button key={kind} style={buttonStyle} onClick={() => runExport(kind)}>
                    {label}
                </button>
            ))}
        </>
    )
}

