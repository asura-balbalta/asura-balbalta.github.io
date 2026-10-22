import type { ForestPolygon } from "./forestData"
import { createForestTable, ForestCodeNames, ForestTable } from "./forestTable"

/**
 * 산림 마스크(docs/forest-layer-plan.md 3.2절 "안 라", 2026-10-22 결정 by @nanangqq). 1K 도엽마다 임상도 폴리곤을 격자(R8)로 칠하고, 지형 셰이더가
 * 픽셀의 월드 xy 로 그 값을 읽어 지형 바탕색을 임상 색으로 바꾼다. 산림은 지형 위의 별도 메쉬가 아니라 **지형 표면의 속성**이 된다.
 *
 * 왜 마스크인가: 드레이프(지형 삼각형으로 자르기, S2 1차)는 임상도 고리가 지형 TIN 보다 촘촘해 1K 하나가 지형의 최대 61배 삼각형·1초가 됐다
 * (34616026). 마스크는 지형 메쉬를 그대로 두고 색만 바꾸므로 삼각형이 늘지 않고, 계단형의 판·벽도 같은 xy 로 읽어 같이 칠해진다.
 *
 * 칠하는 법: OffscreenCanvas 의 path fill 대신 **주사선 짝홀(even-odd) 채우기를 직접** 한다. 픽셀 중심 (x0 + (i + ½)·res, y0 + (j + ½)·res)
 * 이 폴리곤 안(외곽과 구멍의 교차 수가 홀수)이면 그 픽셀을 frtp + 1 로. 이유: canvas 는 안티에일리어싱으로 경계 픽셀이 섞인 색이 되어 임상
 * 코드를 다시 골라야 하고(가장 가까운 색 찾기), 브라우저마다 결과가 미세하게 다를 수 있다. 직접 채우면 값이 정확한 코드이고 결정적이며
 * Node 에서도 같은 코드로 잰다. 고리 변마다 지나는 행에만 교차점을 넣으므로 시간은 (정점 수 + 교차 수) 에 비례한다.
 * 무효 도형(자기교차)도 짝홀 규칙으로 칠할 뿐 예외가 나지 않는다. 혹시 모를 예외는 폴리곤마다 try/catch 로 건너뛰고 센다.
 *
 * 행 j = 0 이 y0(아래)쪽이다(셰이더도 floor((y − y0) / res) 로 같은 행을 읽는다). 원본 도형은 바꾸지 않는다(간략화 없음).
 */

/** 마스크 픽셀 크기(m). 디버그 forestres= (1 또는 2) */
export const FOREST_RES_M = 1

/** 도엽 하나의 마스크. data[j·width + i] = frtp + 1(0 = 산림 아님). 범위는 공통 원점 기준 m */
export type ForestMask = {
    data: Uint8Array
    width: number
    height: number
    /** 격자 왼쪽 아래(m, 공통 원점 기준) */
    x0: number
    y0: number
    /** 픽셀 크기(m) */
    res: number
}

export type ForestMaskResult = {
    /** 칠한 픽셀이 하나도 없으면 null(지형은 산림 없는 셰이더로 그린다) */
    mask: ForestMask | null
    /** 칠한 폴리곤의 표(임상 순 → id 순, 행마다 픽셀 수) */
    table: ForestTable
    /** 고리가 3점 미만이거나 예외로 건너뛴 폴리곤 수 */
    skipped: number
    /** 칠하기 시간(ms) */
    ms: number
}

/**
 * 도엽 폴리곤 범위의 마스크를 만든다.
 *
 * @param polys 공통 원점 mm 좌표의 임상도 폴리곤(이 도엽이 든 5K 의 것. flags & 1 중복 제거한 것)
 * @param tilePoly 도엽 폴리곤(원점 기준 m). 마스크는 그 축 정렬 bbox 를 덮는다
 * @param res 픽셀 크기(m)
 * @param codes codes.json 이름 표(표에 싣는다)
 */
export const buildForestMask = (polys: ForestPolygon[], tilePoly: [number, number][], res = FOREST_RES_M, codes?: ForestCodeNames): ForestMaskResult => {
    const started = performance.now()
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity
    for (const [x, y] of tilePoly) {
        if (x < bx0) bx0 = x
        if (x > bx1) bx1 = x
        if (y < by0) by0 = y
        if (y > by1) by1 = y
    }
    const width = Math.max(1, Math.ceil((bx1 - bx0) / res))
    const height = Math.max(1, Math.ceil((by1 - by0) / res))
    const data = new Uint8Array(width * height)
    // 겹치는 폴리곤이 있으면 나중 것이 덮으므로 순서를 고정한다(임상 순 → id 순. S1 표본에서 같은 5K 안 겹침은 0)
    const order = polys
        .map((p) => {
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
            for (let i = 0; i < p.xy.length; i += 2) {
                const x = p.xy[i] / 1000, y = p.xy[i + 1] / 1000
                if (x < x0) x0 = x
                if (x > x1) x1 = x
                if (y < y0) y0 = y
                if (y > y1) y1 = y
            }
            return { p, x0, y0, x1, y1 }
        })
        .filter((b) => b.x1 >= bx0 && b.x0 <= bx1 && b.y1 >= by0 && b.y0 <= by1)
        .sort((a, b) => a.p.frtp - b.p.frtp || a.p.id - b.p.id)

    const rows: ForestPolygon[] = []
    const pixels: number[] = []
    let skipped = 0
    /** 행마다 교차 x(재사용) */
    const crossings: number[][] = Array.from({ length: height }, () => [])
    for (const { p, y0: py0, y1: py1 } of order) {
        const n = p.xy.length / 2
        const holesTotal = p.holes.reduce((s, h) => s + h, 0)
        const outerN = n - holesTotal
        if (outerN < 3) {
            skipped++
            continue
        }
        // 이 폴리곤이 덮는 행(픽셀 중심 y 가 [py0, py1] 안)
        const j0 = Math.max(0, Math.ceil((py0 - by0) / res - 0.5))
        const j1 = Math.min(height - 1, Math.floor((py1 - by0) / res - 0.5))
        if (j0 > j1) continue
        let count = 0
        try {
            for (let j = j0; j <= j1; j++) crossings[j].length = 0
            // 고리마다 닫는 변까지. 변 (a → b) 이 픽셀 중심 행 yc 를 지나면(반열린 [min, max)) 교차 x 를 넣는다
            let start = 0
            for (const len of [outerN, ...p.holes]) {
                for (let i = 0; i < len; i++) {
                    const a = start + i, b = start + ((i + 1) % len)
                    const ax = p.xy[2 * a] / 1000, ay = p.xy[2 * a + 1] / 1000
                    const qx = p.xy[2 * b] / 1000, qy = p.xy[2 * b + 1] / 1000
                    if (ay === qy) continue
                    const lo = Math.min(ay, qy), hi = Math.max(ay, qy)
                    const ja = Math.max(j0, Math.ceil((lo - by0) / res - 0.5))
                    const jb = Math.min(j1, Math.ceil((hi - by0) / res - 0.5) - 1)
                    for (let j = ja; j <= jb; j++) {
                        const yc = by0 + (j + 0.5) * res
                        crossings[j].push(ax + ((yc - ay) * (qx - ax)) / (qy - ay))
                    }
                }
                start += len
            }
            const value = p.frtp + 1
            for (let j = j0; j <= j1; j++) {
                const xs = crossings[j]
                if (xs.length < 2) continue
                xs.sort((u, v) => u - v)
                const rowOff = j * width
                // 짝홀: (0, 1), (2, 3) … 쌍 사이가 안. 홀수 개(무효 도형)면 마지막 하나는 버린다
                for (let k = 0; k + 1 < xs.length; k += 2) {
                    const i0 = Math.max(0, Math.ceil((xs[k] - bx0) / res - 0.5))
                    const i1 = Math.min(width - 1, Math.floor((xs[k + 1] - bx0) / res - 0.5))
                    if (i0 > i1) continue
                    data.fill(value, rowOff + i0, rowOff + i1 + 1)
                    count += i1 - i0 + 1
                }
            }
        } catch {
            skipped++
            continue
        }
        if (count === 0) continue
        rows.push(p)
        pixels.push(count)
    }
    const table = createForestTable(rows, codes)
    table.pixels.set(pixels)
    const mask = rows.length > 0 ? { data, width, height, x0: bx0, y0: by0, res } : null
    return { mask, table, skipped, ms: performance.now() - started }
}

/** 디버그 forestres= 값을 허용 범위로(1 또는 2 m. 그 밖은 기본값) */
export const forestResOf = (v: number | undefined) => (v === 1 || v === 2 ? v : FOREST_RES_M)
