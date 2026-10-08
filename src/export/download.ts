import type { LayerId } from "../layers"
import type { TerrainMode } from "../webgpu/terrainRenderer"

/** 내보내기 형식. 버튼·파일 확장자·Worker 선택에 쓴다 */
export type ExportKind = "stl" | "skp"

/** 내려받을 파일 이름. 예: asrbbt-terrain-tin+buildings-20261008-1630.stl */
export const exportFileName = (mode: TerrainMode, layerIds: LayerId[], ext: ExportKind, now = new Date()) => {
    const pad = (n: number) => String(n).padStart(2, "0")
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
    const parts = layerIds.map((id) => (id === "terrain" ? `terrain-${mode}` : id))
    return `asrbbt-${parts.join("+")}-${stamp}.${ext}`
}

/** Blob 을 브라우저 다운로드로 내려준다 */
export const downloadBlob = (blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    a.remove()
    // 클릭이 처리될 시간을 준 뒤 해제한다
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
