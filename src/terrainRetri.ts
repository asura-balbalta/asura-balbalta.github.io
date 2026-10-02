import Constrainautor from "@kninnug/constrainautor"
import Delaunator from "delaunator"

import type { TinMesh } from "./terrainData"

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
 * @param mesh segments 가 있는 원본 메쉬
 * @returns 같은 정점에 새 삼각형. segments 가 없으면 입력을 그대로 돌려준다
 */
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

export const retriangulate = (mesh: TinMesh): TinMesh => {
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
    const indices = new Uint32Array(T.length)
    for (let t = 0; t < T.length; t += 3) {
        indices[t] = T[t]
        indices[t + 1] = T[t + 2]
        indices[t + 2] = T[t + 1]
    }
    const clockwise = countClockwise(mesh.positions, indices)
    if (clockwise > 0) {
        throw new Error(`재삼각분할 결과에 시계 방향 삼각형 ${clockwise}개 (규약: 위에서 볼 때 반시계)`)
    }
    console.log(
        `재삼각분할: 정점 ${n}, 삼각형 ${mesh.indices.length / 3} → ${indices.length / 3}, 제약 선분 ${seg.length / 2}(실패 ${failed}), Delaunay ${Math.round(tDelaunay - started)}ms + 제약 ${Math.round(tConstrain - tDelaunay)}ms`,
    )
    return { origin: mesh.origin, positions: mesh.positions, indices, segments: mesh.segments }
}
