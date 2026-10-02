import Constrainautor from "@kninnug/constrainautor"
import Delaunator from "delaunator"

import type { TinMesh } from "./terrainData"

/**
 * 위에서 볼 때 시계 방향인 삼각형의 수. 부호 있는 면적(외적의 z)이 음수인 것을 센다. 넓이 0 은 세지 않는다.
 * 외부 라이브러리의 부호 규약에 기대지 않고 프로젝트 좌표계(x 동, y 북)에서 직접 계산한다.
 *
 * @param positions (x, y, z) 연속 배열
 * @param indices 삼각형 정점 인덱스(3개씩)
 */
export const countClockwise = (positions: Float32Array, indices: Uint32Array) => {
    let clockwise = 0
    for (let t = 0; t < indices.length; t += 3) {
        const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3
        const area2 =
            (positions[b] - positions[a]) * (positions[c + 1] - positions[a + 1]) -
            (positions[b + 1] - positions[a + 1]) * (positions[c] - positions[a])
        if (area2 < 0) clockwise++
    }
    return clockwise
}

/**
 * 합친 메쉬를 도엽 경계 없이 다시 삼각분할한다.
 *
 * 서버 TIN 은 1K 도엽마다 따로 만들어져 도엽 경계가 제약 선분이고, 그 위에는 삽입점이 없어 경계를 따라
 * 골·능선이 생긴다(서버 탐색 19). 여기서는 정점(삽입점 포함, 높이는 서버 추정값 그대로)은 두고
 * 등고선 선분(mesh.segments, 외곽 체인은 이미 제외됨)만 제약해 제약 Delaunay 를 다시 만든다.
 * 도엽 안쪽은 서버 결과와 같고(제약 Delaunay 는 네 점이 한 원 위에 있는 경우를 빼면 유일), 경계 근처만 바뀐다.
 *
 * 정점은 바뀌지 않으므로 positions 는 그대로 돌려주고 indices 만 새로 만든다.
 *
 * 삼각형 방향: Delaunator 의 삼각형은 "반시계"지만 그 기준이 y 가 아래로 커지는 화면 좌표라, 우리 좌표(x 동, y 북)에서는
 * 시계 방향이다. 서버 TIN 과 정점 법선 계산은 위에서 볼 때 반시계를 전제하므로 2·3번째 정점을 바꿔 뒤집고,
 * countClockwise 로 전수 검사해 하나라도 시계 방향이면 오류를 던진다. (처음에는 뒤집지 않아 tin 모드의 법선이 전부
 * 아래를 향해 지형이 어둡게 보였다. 계단형은 면 법선을 카메라 쪽으로 뒤집어 그리므로 드러나지 않았다)
 * (x, y)가 같고 z 만 다른 정점(서버의 수직 균열 사례)은 Delaunator 가 하나만 쓰므로 그 정점을 끝점으로 하는 선분은
 * 제약에 실패해 건너뛴다(개수를 로그에 남김).
 *
 * 결과 삼각형은 두 가지 후처리를 거친다.
 * - 도엽 합집합 밖 제거: Delaunay 는 점 전체의 볼록 껍질을 채우므로, 선택 범위가 오목한 곳(도엽이 빠진 모서리)과 범위
 *   경계선 위에 서버 TIN 에 없던 삼각형이 생긴다. 무게중심이 어느 도엽 폴리곤에도 들지 않는 삼각형을 버린다(removeOutside).
 * - 공간 순서 정렬: Delaunator 의 삼각형 순서는 중심에서 바깥으로 퍼지는 원판 모양이라, 계단형 변환이 순서대로 끊는 조각이
 *   원판 + 가장자리 fan 으로 보여 깨진 것처럼 보인다. 무게중심의 Morton 순서로 재배열해 조각이 네모난 블록 묶음이 되게 한다
 *   (sortByMorton). 조각 안 정점이 모여 있어 조각 경계의 중복 정점도 줄어든다.
 *
 * @param mesh segments 가 있는 원본 메쉬
 * @param tilePolygons 도엽 폴리곤들(원점 기준 m, 둘레 순서). 주면 합집합 밖 삼각형을 버린다
 * @returns 같은 정점에 새 삼각형. segments 가 없으면 입력을 그대로 돌려준다
 */
export const retriangulate = (mesh: TinMesh, tilePolygons?: [number, number][][]): TinMesh => {
    if (!mesh.segments) return mesh
    const started = performance.now()
    const n = mesh.positions.length / 3
    const coords = new Float64Array(2 * n)
    for (let i = 0; i < n; i++) {
        coords[2 * i] = mesh.positions[3 * i]
        coords[2 * i + 1] = mesh.positions[3 * i + 1]
    }
    const del = new Delaunator(coords)
    const tDelaunay = performance.now()
    const con = new Constrainautor(del)
    let failed = 0
    const seg = mesh.segments
    for (let s = 0; s < seg.length; s += 2) {
        try {
            con.constrainOne(seg[s], seg[s + 1])
        } catch {
            failed++
        }
    }
    const tConstrain = performance.now()
    // 꼭 맞는 크기의 새 배열에 담으면서(del.triangles 는 큰 버퍼의 subarray) 2·3번째 정점을 바꿔 위에서 볼 때 반시계로 만든다
    const T = del.triangles
    const flipped = new Uint32Array(T.length)
    for (let t = 0; t < T.length; t += 3) {
        flipped[t] = T[t]
        flipped[t + 1] = T[t + 2]
        flipped[t + 2] = T[t + 1]
    }
    const clockwise = countClockwise(mesh.positions, flipped)
    if (clockwise > 0) {
        throw new Error(`재삼각분할 결과에 시계 방향 삼각형 ${clockwise}개 (규약: 위에서 볼 때 반시계)`)
    }
    const kept = tilePolygons ? removeOutside(mesh.positions, flipped, tilePolygons) : flipped
    const indices = sortByMorton(mesh.positions, kept)
    const tPost = performance.now()
    console.log(
        `재삼각분할: 정점 ${n}, 삼각형 ${mesh.indices.length / 3} → ${indices.length / 3}(도엽 밖 ${(flipped.length - kept.length) / 3} 제거), 제약 선분 ${seg.length / 2}(실패 ${failed}), Delaunay ${Math.round(tDelaunay - started)}ms + 제약 ${Math.round(tConstrain - tDelaunay)}ms + 후처리 ${Math.round(tPost - tConstrain)}ms`,
    )
    return { origin: mesh.origin, positions: mesh.positions, indices, segments: mesh.segments }
}

/** 점이 다각형 안에 있는지(짝홀 규칙). 경계 위는 어느 쪽이든 될 수 있다 */
const pointInPolygon = (x: number, y: number, poly: [number, number][]) => {
    let inside = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i]
        const [xj, yj] = poly[j]
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
}

/**
 * 무게중심이 어느 도엽 폴리곤에도 들지 않는 삼각형을 뺀다. 도엽 폴리곤은 bbox 격자(셀 500m)로 찾아 삼각형마다 몇 개만 검사한다.
 *
 * @param positions (x, y, z) 연속 배열
 * @param indices 삼각형 정점 인덱스(3개씩)
 * @param polygons 도엽 폴리곤들(원점 기준 m)
 * @returns 남은 삼각형만 담은 새 배열
 */
const removeOutside = (positions: Float32Array, indices: Uint32Array, polygons: [number, number][][]) => {
    const CELL = 500
    const cellKey = (x: number, y: number) => Math.floor(x / CELL) * 1048576 + Math.floor(y / CELL)
    const grid = new Map<number, number[]>()
    polygons.forEach((poly, i) => {
        const xs = poly.map((p) => p[0])
        const ys = poly.map((p) => p[1])
        for (let cx = Math.floor(Math.min(...xs) / CELL); cx <= Math.floor(Math.max(...xs) / CELL); cx++) {
            for (let cy = Math.floor(Math.min(...ys) / CELL); cy <= Math.floor(Math.max(...ys) / CELL); cy++) {
                const k = cx * 1048576 + cy
                let list = grid.get(k)
                if (!list) grid.set(k, (list = []))
                list.push(i)
            }
        }
    })
    const out = new Uint32Array(indices.length)
    let n = 0
    for (let t = 0; t < indices.length; t += 3) {
        const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3
        const cx = (positions[a] + positions[b] + positions[c]) / 3
        const cy = (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3
        const candidates = grid.get(cellKey(cx, cy))
        if (!candidates || !candidates.some((i) => pointInPolygon(cx, cy, polygons[i]))) continue
        out[n++] = indices[t]
        out[n++] = indices[t + 1]
        out[n++] = indices[t + 2]
    }
    return out.subarray(0, n)
}

/** 16비트 정수의 비트를 한 칸씩 벌린다(Morton 키용) */
const spreadBits = (v: number) => {
    v = (v | (v << 8)) & 0x00ff00ff
    v = (v | (v << 4)) & 0x0f0f0f0f
    v = (v | (v << 2)) & 0x33333333
    v = (v | (v << 1)) & 0x55555555
    return v
}

/** Morton 정렬의 셀 크기(m). 조각이 이 셀들의 블록 묶음이 된다 */
const MORTON_CELL_M = 256

/**
 * 삼각형을 무게중심의 Morton(Z-order) 순서로 재배열한다. 축당 최대 2^16 셀. 키별 counting sort 라 O(n) 이다.
 *
 * @param positions (x, y, z) 연속 배열
 * @param indices 삼각형 정점 인덱스(3개씩)
 * @returns 재배열한 새 배열
 */
const sortByMorton = (positions: Float32Array, indices: Uint32Array) => {
    const nTri = indices.length / 3
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (let i = 0; i < positions.length; i += 3) {
        minX = Math.min(minX, positions[i])
        maxX = Math.max(maxX, positions[i])
        minY = Math.min(minY, positions[i + 1])
        maxY = Math.max(maxY, positions[i + 1])
    }
    const cells = Math.max(Math.ceil((maxX - minX) / MORTON_CELL_M), Math.ceil((maxY - minY) / MORTON_CELL_M)) + 1
    const bits = Math.min(16, Math.ceil(Math.log2(cells)))
    const keys = new Uint32Array(nTri)
    for (let t = 0; t < nTri; t++) {
        const a = indices[3 * t] * 3, b = indices[3 * t + 1] * 3, c = indices[3 * t + 2] * 3
        const cx = ((positions[a] + positions[b] + positions[c]) / 3 - minX) / MORTON_CELL_M
        const cy = ((positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3 - minY) / MORTON_CELL_M
        keys[t] = (spreadBits(Math.floor(cx)) | (spreadBits(Math.floor(cy)) << 1)) >>> 0
    }
    // counting sort: counts[k] = 키가 k 보다 작은 삼각형 수 → 각 키의 시작 위치
    const counts = new Uint32Array((1 << (2 * bits)) + 1)
    for (let t = 0; t < nTri; t++) counts[keys[t] + 1]++
    for (let k = 1; k < counts.length; k++) counts[k] += counts[k - 1]
    const out = new Uint32Array(indices.length)
    for (let t = 0; t < nTri; t++) {
        const dst = counts[keys[t]]++ * 3
        out[dst] = indices[3 * t]
        out[dst + 1] = indices[3 * t + 1]
        out[dst + 2] = indices[3 * t + 2]
    }
    return out
}
