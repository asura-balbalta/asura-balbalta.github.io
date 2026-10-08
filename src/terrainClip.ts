import { TinMesh } from "./terrainData"

type P = [number, number, number]

/**
 * 메쉬를 볼록 다각형(선택 사각형)으로 잘라 안쪽만 남긴다.
 *
 * 왜 자르는가: 재삼각분할은 도엽 외곽을 제약하지 않는 Delaunay 라 바깥 경계가 점들의 볼록 껍질이다. 도엽 변 위에는
 * 꼭짓점과 등고선이 그 변을 가로지르는 점만 있어, 등고선이 안 지나는 변은 꼭짓점 둘을 잇는 450m 변 하나가 되고 바로
 * 안쪽 등고선 점과 폭 수십 cm 의 바늘 삼각형을 이룬다(경사 80° 이상). 선택 사각형은 그 띠 안쪽에 있으므로 거기서 자르면
 * 바늘 삼각형이 사라지고, 잘린 경계는 정상 삼각형을 자른 것이라 경사가 실제 지형과 같다.
 *
 * 방법: 삼각형마다 다각형의 변(반평면)으로 차례로 자른다(Sutherland–Hodgman). 세 꼭짓점이 모두 안이면 그대로 두고,
 * 모두 한 변 밖이면 버리고, 걸친 것만 자른다. 잘린 볼록 조각은 부채꼴로 삼각분할한다. 꼭짓점 순서를 유지하므로
 * 반시계 삼각형은 반시계로 남는다. 잘린 점은 mm 키로 공유해 이웃 삼각형 사이에 틈이 없게 하고, 안 쓰는 정점은 지운다
 * (meshBounds·카메라가 바깥 정점을 세지 않도록). 삼각형 순서(나선 정렬)는 유지된다. segments 는 재삼각분할 뒤라 버린다.
 *
 * @param mesh 원점 기준 좌표의 메쉬(재삼각분할 뒤)
 * @param polygon 볼록 다각형(원점 기준 m, 둘레 순서. 방향 무관)
 * @returns 잘린 메쉬(새 positions·indices)
 */
export const clipMeshToConvexPolygon = (mesh: TinMesh, polygon: [number, number][]): TinMesh => {
    // 반시계로 맞춰 "변의 왼쪽 = 안쪽" 으로 통일
    let area2 = 0
    for (let i = 0; i < polygon.length; i++) {
        const [ax, ay] = polygon[i], [bx, by] = polygon[(i + 1) % polygon.length]
        area2 += ax * by - bx * ay
    }
    const ring = area2 < 0 ? [...polygon].reverse() : polygon
    const edges = ring.map(([ax, ay], i) => {
        const [bx, by] = ring[(i + 1) % ring.length]
        return { ax, ay, dx: bx - ax, dy: by - ay }
    })
    /** 변 e 기준 부호 거리(양수 = 안쪽) */
    const side = (e: (typeof edges)[number], x: number, y: number) => e.dx * (y - e.ay) - e.dy * (x - e.ax)

    const P0 = mesh.positions, I0 = mesh.indices
    const n0 = P0.length / 3
    // 결과 정점: 원본 정점은 번호 그대로(나중에 압축), 잘린 점은 n0 부터 추가
    const extra: number[] = []
    const extraIndex = new Map<string, number>()
    const cutVertex = (p: P) => {
        const key = `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}`
        let idx = extraIndex.get(key)
        if (idx === undefined) {
            idx = n0 + extra.length / 3
            extraIndex.set(key, idx)
            extra.push(p[0], p[1], p[2])
        }
        return idx
    }
    let out = new Uint32Array(I0.length)
    let m = 0
    const push3 = (a: number, b: number, c: number) => {
        if (m + 3 > out.length) {
            const grown = new Uint32Array(out.length * 2)
            grown.set(out)
            out = grown
        }
        out[m++] = a
        out[m++] = b
        out[m++] = c
    }

    let kept = 0, cut = 0
    for (let t = 0; t < I0.length; t += 3) {
        const ia = I0[t], ib = I0[t + 1], ic = I0[t + 2]
        // 빠른 판정: 모두 안 / 모두 한 변 밖
        let allInside = true
        let dropped = false
        for (const e of edges) {
            const sa = side(e, P0[3 * ia], P0[3 * ia + 1])
            const sb = side(e, P0[3 * ib], P0[3 * ib + 1])
            const sc = side(e, P0[3 * ic], P0[3 * ic + 1])
            if (sa < 0 && sb < 0 && sc < 0) {
                dropped = true
                break
            }
            if (sa < 0 || sb < 0 || sc < 0) allInside = false
        }
        if (dropped) continue
        if (allInside) {
            push3(ia, ib, ic)
            kept++
            continue
        }
        // 걸친 삼각형: 변마다 자른다
        let poly: P[] = [ia, ib, ic].map((i) => [P0[3 * i], P0[3 * i + 1], P0[3 * i + 2]] as P)
        for (const e of edges) {
            const next: P[] = []
            for (let i = 0; i < poly.length; i++) {
                const a = poly[i], b = poly[(i + 1) % poly.length]
                const sa = side(e, a[0], a[1]), sb = side(e, b[0], b[1])
                if (sa >= 0) next.push(a)
                if ((sa >= 0) !== (sb >= 0)) {
                    const r = sa / (sa - sb)
                    next.push([a[0] + (b[0] - a[0]) * r, a[1] + (b[1] - a[1]) * r, a[2] + (b[2] - a[2]) * r])
                }
            }
            poly = next
            if (poly.length < 3) break
        }
        if (poly.length < 3) continue
        // 원본 꼭짓점은 원래 번호를 쓰고(좌표가 같으면), 잘린 점은 공유 정점으로
        const idxOf = (p: P) => {
            for (const i of [ia, ib, ic]) if (P0[3 * i] === p[0] && P0[3 * i + 1] === p[1]) return i
            return cutVertex(p)
        }
        const ids = poly.map(idxOf)
        for (let i = 1; i + 1 < ids.length; i++) {
            const a = poly[0], b = poly[i], c = poly[i + 1]
            const tri2 = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
            if (Math.abs(tri2) < 1e-8) continue
            push3(ids[0], ids[i], ids[i + 1])
        }
        cut++
    }

    // 쓰는 정점만 남기고 번호를 다시 매긴다
    const used = new Int32Array(n0 + extra.length / 3).fill(-1)
    let nUsed = 0
    for (let i = 0; i < m; i++) if (used[out[i]] < 0) used[out[i]] = nUsed++
    const positions = new Float32Array(3 * nUsed)
    for (let v = 0; v < used.length; v++) {
        const to = used[v]
        if (to < 0) continue
        if (v < n0) positions.set(P0.subarray(3 * v, 3 * v + 3), 3 * to)
        else positions.set(extra.slice(3 * (v - n0), 3 * (v - n0) + 3), 3 * to)
    }
    const indices = new Uint32Array(m)
    for (let i = 0; i < m; i++) indices[i] = used[out[i]]
    console.log(
        `선택 범위로 자르기: 삼각형 ${I0.length / 3} → ${m / 3}(그대로 ${kept}, 자름 ${cut}), 정점 ${n0} → ${nUsed}(잘린 점 ${extra.length / 3})`,
    )
    return { origin: mesh.origin, positions, indices }
}
