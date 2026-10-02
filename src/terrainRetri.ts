import Constrainautor from "@kninnug/constrainautor"
import Delaunator from "delaunator"

import { TinMesh } from "./terrainData"

/**
 * 합친 메쉬를 도엽 경계 없이 다시 삼각분할한다.
 *
 * 서버 TIN 은 1K 도엽마다 따로 만들어져 도엽 경계가 제약 선분이고, 그 위에는 삽입점이 없어 경계를 따라
 * 골·능선이 생긴다(서버 탐색 19). 여기서는 정점(삽입점 포함, 높이는 서버 추정값 그대로)은 두고
 * 등고선 선분(mesh.segments, 외곽 체인은 이미 제외됨)만 제약해 제약 Delaunay 를 다시 만든다.
 * 도엽 안쪽은 서버 결과와 같고(제약 Delaunay 는 네 점이 한 원 위에 있는 경우를 빼면 유일), 경계 근처만 바뀐다.
 *
 * 정점은 바뀌지 않으므로 positions 는 그대로 돌려주고 indices 만 새로 만든다.
 * (x, y)가 같고 z 만 다른 정점(서버의 수직 균열 사례)은 Delaunator 가 하나만 쓰므로 그 정점을 끝점으로 하는 선분은
 * 제약에 실패해 건너뛴다(개수를 로그에 남김).
 *
 * @param mesh segments 가 있는 원본 메쉬
 * @returns 같은 정점에 새 삼각형. segments 가 없으면 입력을 그대로 돌려준다
 */
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
    // del.triangles 는 큰 버퍼의 일부(subarray)라 꼭 맞는 크기로 복사한다(transfer 때 버퍼 전체가 딸려 가지 않게)
    const indices = new Uint32Array(del.triangles)
    console.log(
        `재삼각분할: 정점 ${n}, 삼각형 ${mesh.indices.length / 3} → ${indices.length / 3}, 제약 선분 ${seg.length / 2}(실패 ${failed}), Delaunay ${Math.round(tDelaunay - started)}ms + 제약 ${Math.round(tConstrain - tDelaunay)}ms`,
    )
    return { origin: mesh.origin, positions: mesh.positions, indices, segments: mesh.segments }
}
