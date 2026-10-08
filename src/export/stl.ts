/**
 * 바이너리 STL 인코더. 지형 메쉬(TIN 또는 계단형 조각)를 STL 파일 조각으로 적는다.
 *
 * 파일은 머리말(encodeStlHeader) 하나 뒤에 삼각형 레코드(encodeStlTriangles)가 이어지는 구조라,
 * 조각별로 따로 인코딩한 뒤 Blob 으로 이어 붙이면 된다. 좌표는 TinMesh 와 같이 원점을 뺀 미터 단위이며,
 * 원점 절대좌표는 머리말 문구에 적어 둔다.
 */

/** 바이너리 STL 머리말 크기: 80바이트 문구 + 4바이트 삼각형 수 */
export const STL_HEADER_BYTES = 84
/** 삼각형 레코드 하나의 크기: float32 × (법선 3 + 꼭짓점 9) + uint16 속성 */
export const STL_TRIANGLE_BYTES = 50

/**
 * 바이너리 STL 머리말을 만든다.
 *
 * 80바이트 문구에 원점·좌표계·단위를 적어, 파일만 받아도 절대좌표를 복원할 수 있게 한다.
 * (바이너리 STL 머리말은 "solid" 로 시작하면 ASCII STL 로 오인될 수 있어 다른 문구로 시작한다)
 *
 * @param triangleCount 뒤따르는 삼각형 레코드 수
 * @param origin 메쉬 원점(ESRI:102080 절대좌표). 꼭짓점 좌표는 이 값을 뺀 것이다
 */
export const encodeStlHeader = (triangleCount: number, origin: [number, number]): ArrayBuffer => {
    const buf = new ArrayBuffer(STL_HEADER_BYTES)
    const text = `asrbbt terrain origin=${origin[0]},${origin[1]} crs=ESRI:102080 unit=m`
    // 문구는 ASCII 만 쓰므로 80바이트에서 잘라도 글자가 깨지지 않는다
    new Uint8Array(buf).set(new TextEncoder().encode(text).subarray(0, 80))
    new DataView(buf).setUint32(80, triangleCount, true)
    return buf
}

/**
 * 인덱스 메쉬의 삼각형들을 바이너리 STL 삼각형 레코드로 적는다(머리말 없음).
 *
 * 면 법선은 꼭짓점 순서(위에서 볼 때 반시계)대로 외적해 구하므로 지형은 위를 향한다.
 * 넓이가 0인 삼각형은 법선을 (0, 0, 0) 으로 둔다(STL 뷰어들이 허용하는 관례).
 *
 * @param positions 꼭짓점 좌표 (x, y, z) 연속 배열
 * @param indices 삼각형 꼭짓점 인덱스(3개씩). 길이가 3의 배수가 아니면 나머지는 버린다
 * @returns 삼각형 수 × STL_TRIANGLE_BYTES 크기의 버퍼
 */
export const encodeStlTriangles = (positions: Float32Array, indices: Uint32Array): ArrayBuffer => {
    const count = Math.floor(indices.length / 3)
    const buf = new ArrayBuffer(count * STL_TRIANGLE_BYTES)
    const view = new DataView(buf)
    let o = 0
    for (let t = 0; t < count; t++) {
        const a = indices[t * 3] * 3
        const b = indices[t * 3 + 1] * 3
        const c = indices[t * 3 + 2] * 3
        const ax = positions[a], ay = positions[a + 1], az = positions[a + 2]
        const bx = positions[b], by = positions[b + 1], bz = positions[b + 2]
        const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2]
        const ux = bx - ax, uy = by - ay, uz = bz - az
        const vx = cx - ax, vy = cy - ay, vz = cz - az
        let nx = uy * vz - uz * vy
        let ny = uz * vx - ux * vz
        let nz = ux * vy - uy * vx
        const len = Math.hypot(nx, ny, nz)
        if (len > 0) {
            nx /= len
            ny /= len
            nz /= len
        } else {
            nx = ny = nz = 0
        }
        view.setFloat32(o, nx, true)
        view.setFloat32(o + 4, ny, true)
        view.setFloat32(o + 8, nz, true)
        view.setFloat32(o + 12, ax, true)
        view.setFloat32(o + 16, ay, true)
        view.setFloat32(o + 20, az, true)
        view.setFloat32(o + 24, bx, true)
        view.setFloat32(o + 28, by, true)
        view.setFloat32(o + 32, bz, true)
        view.setFloat32(o + 36, cx, true)
        view.setFloat32(o + 40, cy, true)
        view.setFloat32(o + 44, cz, true)
        view.setUint16(o + 48, 0, true)
        o += STL_TRIANGLE_BYTES
    }
    return buf
}
