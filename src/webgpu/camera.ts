// 행렬은 WGSL mat4x4f 와 같은 열 우선(column-major): m[col * 4 + row]
export type Mat4 = Float32Array
type Vec3 = [number, number, number]

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
]
const normalize = (a: Vec3): Vec3 => {
    const len = Math.hypot(a[0], a[1], a[2])
    return [a[0] / len, a[1] / len, a[2] / len]
}

// WebGPU clip 공간의 깊이는 0(near) ~ 1(far). OpenGL(-1 ~ 1)용 공식과 다르다
export const perspective = (
    fovY: number,
    aspect: number,
    near: number,
    far: number,
): Mat4 => {
    const f = 1 / Math.tan(fovY / 2)
    const nf = 1 / (near - far)
    return new Float32Array([
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, far * nf, -1,
        0, 0, far * near * nf, 0,
    ])
}

// 카메라는 자기 -z 방향을 본다
export const lookAt = (eye: Vec3, target: Vec3, up: Vec3): Mat4 => {
    const z = normalize(sub(eye, target))
    const x = normalize(cross(up, z))
    const y = cross(z, x)
    return new Float32Array([
        x[0], y[0], z[0], 0,
        x[1], y[1], z[1], 0,
        x[2], y[2], z[2], 0,
        -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
    ])
}

export const multiply = (a: Mat4, b: Mat4): Mat4 => {
    const out = new Float32Array(16)
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            let sum = 0
            for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k]
            out[c * 4 + r] = sum
        }
    }
    return out
}

// 지형 좌표계는 z-up (x=동, y=북, z=표고)
export type OrbitCamera = {
    target: Vec3
    distance: number
    azimuth: number // target 에서 본 카메라 방향. 0 = 동쪽, π/2 = 북쪽
    elevation: number // 수평선 위 각도
    fovY: number
}

export const orbitViewProj = (cam: OrbitCamera, aspect: number): Mat4 => {
    const { target, distance, azimuth, elevation } = cam
    const ce = Math.cos(elevation)
    const eye: Vec3 = [
        target[0] + distance * ce * Math.cos(azimuth),
        target[1] + distance * ce * Math.sin(azimuth),
        target[2] + distance * Math.sin(elevation),
    ]
    // near/far 를 거리에 비례시켜 깊이 정밀도를 확보
    const proj = perspective(cam.fovY, aspect, distance * 0.01, distance * 10)
    return multiply(proj, lookAt(eye, target, [0, 0, 1]))
}
