/**
 * 4×4 행렬. WGSL mat4x4f 와 같은 열 우선(column-major) 배치로, m[col * 4 + row] 이다.
 * uniform 버퍼에 그대로 writeBuffer 할 수 있다.
 */
export type Mat4 = Float32Array
export type Vec3 = [number, number, number]

/** 벡터 뺄셈 a - b */
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

/** 벡터 내적 a · b */
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** 벡터 외적 a × b */
const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
]

/** 길이가 1인 벡터로 정규화 */
const normalize = (a: Vec3): Vec3 => {
    const len = Math.hypot(a[0], a[1], a[2])
    return [a[0] / len, a[1] / len, a[2] / len]
}

/**
 * 원근 투영 행렬을 만든다. 카메라 좌표(카메라가 -z 방향을 봄)를 clip 공간으로 옮긴다.
 *
 * WebGPU clip 공간의 깊이는 0 ~ 1 인데, 여기서는 역순(reversed-Z: near → 1, far → 0)으로 쓴다(2026-10-13).
 * 깊이 버퍼가 32비트 부동소수(depth32float)일 때 역순이면 부동소수의 정밀도가 먼 곳까지 고르게 쓰여, 걸어 보기(near 0.3 m ·
 * far 20 km)에서 수십 m 거리의 깊이 오차가 cm 에서 mm 아래로 내려간다. SSAO 가 깊이에서 법선을 복원할 때의 노이즈가 이 때문이었다.
 * 렌더러의 깊이 비교는 "greater", 지움 값은 0 이다. 직교 투영(ortho, 섀도 맵)은 정순 그대로다.
 *
 * @param fovY 세로 시야각(라디안)
 * @param aspect 화면 가로/세로 비율
 * @param near 가까운 절단면까지의 거리(양수)
 * @param far 먼 절단면까지의 거리(near 보다 큼)
 * @returns 투영 행렬
 */
export const perspective = (
    fovY: number,
    aspect: number,
    near: number,
    far: number,
): Mat4 => {
    const f = 1 / Math.tan(fovY / 2)
    const d = far - near
    return new Float32Array([
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, near / d, -1,
        0, 0, (far * near) / d, 0,
    ])
}

/**
 * 직교 투영 행렬(섀도 맵의 빛 기준 투영). 카메라 좌표 상자 [l, r] × [b, t] × [-far, -near] 를 clip 공간(깊이 0 ~ 1)으로 옮긴다.
 *
 * @returns 투영 행렬
 */
export const ortho = (l: number, r: number, b: number, t: number, near: number, far: number): Mat4 =>
    new Float32Array([
        2 / (r - l), 0, 0, 0,
        0, 2 / (t - b), 0, 0,
        0, 0, -1 / (far - near), 0,
        -(r + l) / (r - l), -(t + b) / (t - b), -near / (far - near), 1,
    ])

/**
 * 뷰 행렬을 만든다. 월드 좌표를 "eye 에서 target 을 바라보는 카메라" 기준 좌표로 옮긴다.
 *
 * 카메라 축: x = 화면 오른쪽, y = 화면 위, z = 카메라 뒤쪽(카메라는 자기 -z 방향을 본다).
 *
 * @param eye 카메라 위치
 * @param target 바라보는 점
 * @param up 월드의 위쪽 방향(지형은 [0, 0, 1])
 * @returns 뷰 행렬
 */
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

/**
 * 행렬 곱 a × b. 정점에 적용하면 b 가 먼저, a 가 나중에 적용된다.
 *
 * @param a 나중에 적용할 행렬(예: projection)
 * @param b 먼저 적용할 행렬(예: view)
 * @returns 곱한 결과(새 배열)
 */
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

/**
 * target 을 중심으로 구면 좌표로 도는 궤도 카메라. 지형 좌표계는 z-up(x=동, y=북, z=표고).
 */
export type OrbitCamera = {
    /** 바라보는 중심점 */
    target: Vec3
    /** target 에서 카메라까지 거리(m) */
    distance: number
    /** target 에서 본 카메라 방향(라디안). 0 = 동쪽, π/2 = 북쪽 */
    azimuth: number
    /** 수평선 위로 올려다본 각도(라디안) */
    elevation: number
    /** 세로 시야각(라디안) */
    fovY: number
}

/**
 * 궤도 카메라의 위치(eye)를 구한다. target 에서 azimuth·elevation 방향으로 distance 만큼 떨어진 점.
 *
 * @param cam 궤도 카메라 상태
 * @returns 카메라 위치(지형 로컬 좌표, m)
 */
export const orbitEye = (cam: OrbitCamera): Vec3 => {
    const { target, distance, azimuth, elevation } = cam
    const ce = Math.cos(elevation)
    return [
        target[0] + distance * ce * Math.cos(azimuth),
        target[1] + distance * ce * Math.sin(azimuth),
        target[2] + distance * Math.sin(elevation),
    ]
}

/**
 * 궤도 카메라 파라미터로 셰이더에 넘길 viewProj 행렬을 만든다.
 *
 * 1. orbitEye 로 카메라 위치를 구한다.
 * 2. near/far 를 distance 에 비례시켜(0.01배 ~ 10배) 깊이 정밀도를 확보한다.
 * 3. projection × view 를 반환한다.
 *
 * @param cam 궤도 카메라 상태
 * @param aspect 화면 가로/세로 비율
 * @returns viewProj 행렬
 */
export const orbitViewProj = (cam: OrbitCamera, aspect: number): Mat4 => {
    const { distance } = cam
    const proj = perspective(cam.fovY, aspect, distance * 0.01, distance * 10)
    return multiply(proj, lookAt(orbitEye(cam), cam.target, [0, 0, 1]))
}

/**
 * 1인칭 카메라(걸어 보기). eye 에서 yaw(수평, 0 = 동쪽, 반시계)·pitch(수평선 위로, 라디안) 방향을 본다.
 * near·far 는 거리에 비례하는 궤도 카메라와 달리 고정이다: 발 앞 0.3 m 부터 20 km 까지
 */
export type FpsCamera = {
    eye: Vec3
    yaw: number
    pitch: number
    fovY: number
}
export const FPS_NEAR = 0.3
export const FPS_FAR = 20000

/** 1인칭 카메라가 보는 방향(단위 벡터) */
export const fpsForward = ({ yaw, pitch }: FpsCamera): Vec3 => {
    const cp = Math.cos(pitch)
    return [cp * Math.cos(yaw), cp * Math.sin(yaw), Math.sin(pitch)]
}

export const fpsViewProj = (cam: FpsCamera, aspect: number): Mat4 => {
    const f = fpsForward(cam)
    const target: Vec3 = [cam.eye[0] + f[0], cam.eye[1] + f[1], cam.eye[2] + f[2]]
    return multiply(perspective(cam.fovY, aspect, FPS_NEAR, FPS_FAR), lookAt(cam.eye, target, [0, 0, 1]))
}

/** 렌더러가 받는 카메라: 궤도 또는 1인칭 */
export type Camera = OrbitCamera | FpsCamera
export const isFpsCamera = (cam: Camera): cam is FpsCamera => "eye" in cam
export const cameraEye = (cam: Camera): Vec3 => (isFpsCamera(cam) ? cam.eye : orbitEye(cam))
export const cameraViewProj = (cam: Camera, aspect: number): Mat4 =>
    isFpsCamera(cam) ? fpsViewProj(cam, aspect) : orbitViewProj(cam, aspect)

/**
 * 4×4 행렬의 역행렬(여인수 전개). 특이 행렬이면 단위 행렬을 돌려준다. SSAO 가 깊이에서 월드 위치를 복원하는 데 쓴다
 *
 * @param m 열 우선 행렬
 * @returns 역행렬(새 배열)
 */
export const invert = (m: Mat4): Mat4 => {
    const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m
    const b00 = a00 * a11 - a01 * a10
    const b01 = a00 * a12 - a02 * a10
    const b02 = a00 * a13 - a03 * a10
    const b03 = a01 * a12 - a02 * a11
    const b04 = a01 * a13 - a03 * a11
    const b05 = a02 * a13 - a03 * a12
    const b06 = a20 * a31 - a21 * a30
    const b07 = a20 * a32 - a22 * a30
    const b08 = a20 * a33 - a23 * a30
    const b09 = a21 * a32 - a22 * a31
    const b10 = a21 * a33 - a23 * a31
    const b11 = a22 * a33 - a23 * a32
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06
    if (det === 0) return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    det = 1 / det
    return new Float32Array([
        (a11 * b11 - a12 * b10 + a13 * b09) * det,
        (a02 * b10 - a01 * b11 - a03 * b09) * det,
        (a31 * b05 - a32 * b04 + a33 * b03) * det,
        (a22 * b04 - a21 * b05 - a23 * b03) * det,
        (a12 * b08 - a10 * b11 - a13 * b07) * det,
        (a00 * b11 - a02 * b08 + a03 * b07) * det,
        (a32 * b02 - a30 * b05 - a33 * b01) * det,
        (a20 * b05 - a22 * b02 + a23 * b01) * det,
        (a10 * b10 - a11 * b08 + a13 * b06) * det,
        (a01 * b08 - a00 * b10 - a03 * b06) * det,
        (a30 * b04 - a31 * b02 + a33 * b00) * det,
        (a21 * b02 - a20 * b04 - a23 * b00) * det,
        (a11 * b07 - a10 * b09 - a12 * b06) * det,
        (a00 * b09 - a01 * b07 + a02 * b06) * det,
        (a31 * b01 - a30 * b03 - a32 * b00) * det,
        (a20 * b03 - a21 * b01 + a22 * b00) * det,
    ])
}

/**
 * 카메라를 원점에 둔 viewProj(카메라 기준 좌표계). 깊이에서 위치를 복원하는 후처리(SSAO·외곽선·하늘)가 쓴다.
 * 월드 좌표(원점에서 수백 m ~ km)를 f32 역행렬로 복원하면 0.1 ~ 0.5 mm 오차가 남아, 가까운 면(픽셀 간격 1 ~ 2 mm)에서
 * 외곽선 판정이 띠 모양으로 흔들렸다(2026-10-13). 카메라 기준이면 오차가 거리 × 1e-7 로 준다
 *
 * @param camera 궤도 또는 1인칭 카메라
 * @param aspect 화면 가로/세로 비율
 * @returns 복원한 위치가 "카메라에서 본 상대 위치(m)" 가 되는 viewProj
 */
export const cameraViewProjRelative = (camera: Camera, aspect: number): Mat4 => {
    if (isFpsCamera(camera)) {
        return multiply(perspective(camera.fovY, aspect, FPS_NEAR, FPS_FAR), lookAt([0, 0, 0], fpsForward(camera), [0, 0, 1]))
    }
    const eye = orbitEye(camera)
    const t = camera.target
    const toTarget: Vec3 = [t[0] - eye[0], t[1] - eye[1], t[2] - eye[2]]
    const proj = perspective(camera.fovY, aspect, camera.distance * 0.01, camera.distance * 10)
    return multiply(proj, lookAt([0, 0, 0], toTarget, [0, 0, 1]))
}
