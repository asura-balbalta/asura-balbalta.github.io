import { HeightSampler } from "./terrainHeight"
import { FpsCamera } from "./webgpu/camera"

/**
 * 걸어 보기(게임 모드)의 플레이어. React 밖의 순수 모듈로, 캔버스에 붙여(attach) 포인터 잠금·키 입력을 받고
 * 렌더 루프가 프레임마다 step(dt) 로 물리를 진행해 1인칭 카메라를 받아 간다.
 *
 * 동작 규칙은 예전 three.js 게임(../app/game, playerController)에서 가져왔다: 포인터 잠금 마우스 시점, WASD(화살표) 이동,
 * Space 점프(공중 점프 2번까지), W 두 번(0.32초 안) 대시. 충돌은 지형 높이(HeightSampler)만: 발이 지표 아래로 못 가고
 * 메쉬 범위 밖으로 못 나간다. 건물은 통과한다(최소 버전).
 *
 * 움직임은 예전 코드와 같은 관성 모델(2026-10-13, 처음의 "누른 키 × 속도" 는 대시가 뚝 끊겨서 바꿈): 수평 속도를 상태로 두고
 * 키는 가속도(최고 속도 × 감쇠)로 더하며 매 프레임 e^(−k·dt) 로 감쇠한다(지상 k = damping, 공중은 0.15배라 거의 미끄러짐,
 * 공중 조작 가속은 0.36배). 걷기 최고 속도 = 가속 ÷ 감쇠 = walkSpeed. 대시는 앞 방향 속도를 dashSpeed 로 즉시 올리고 0.05초 더
 * 민 뒤 감쇠로 줄어든다(지상 65 m/s 는 약 0.6초, 16 m 뒤 걷기 속도로)
 *
 * 좌표는 메쉬 로컬(z-up, m). yaw 0 = 동쪽, 반시계. pitch 는 수평선 위로(라디안)
 *
 * 포커스(Unreal 식, 2026-10-12 결정 by @nanangqq): 들어가면 포인터 잠금(커서 숨김, 무한 회전)으로 "포커스" 상태. Esc 는 잠금만 풀어
 * 커서가 보이고 입력이 멈추지만 걸어 보기는 유지된다. 화면을 클릭하면 다시 잠금. 궤도 보기로 나가는 것은 "나가기" 버튼.
 * 처음엔 잠금 없는 방식을 골랐으나 화면을 많이 돌릴 때 가장자리에서 멈춰 불편해 바꿨다.
 * URL ?lock=0 은 잠금 API 없이 같은 흐름을 흉내 내는 테스트용(앱 내장 브라우저는 잠금을 지원하지 않는다): Esc 키가 포커스를
 * 끄고, 마우스는 어디서 움직이든 시점이 돈다
 */
export type PlayerMove = {
    /** 발 위치(메쉬 로컬, m) */
    x: number
    y: number
    z: number
    /** 발 아래 지표 높이(m) */
    ground: number
    yaw: number
}

export type Player = {
    /** 캔버스에 입력을 붙이고 포인터 잠금을 요청한다 */
    attach: (canvas: HTMLCanvasElement) => void
    /** 입력을 떼고 포인터 잠금을 푼다 */
    detach: () => void
    /** dt(초)만큼 진행하고 지금 카메라를 돌려준다 */
    step: (dt: number) => FpsCamera
    /** 물리 값을 바꾼다(테스트용 조절 패널). 바로 반영된다 */
    setPhysics: (next: Partial<WalkPhysics>) => void
    /** 계단형 모드의 층 간격(m). 주면 발 높이를 층 바닥(floor(z / step) · step)으로 맞춰 계단 위를 걷는다. null 이면 매끈한 면 */
    setGroundStep: (step: number | null) => void
    /** 다시 포커스(포인터 잠금 요청). Esc 로 풀린 뒤 화면을 클릭했을 때 */
    focus: () => void
}

/** 조절할 수 있는 물리 값 */
export type WalkPhysics = {
    /** 중력 가속도(m/s²) */
    gravity: number
    /** 걷기 최고 속도(m/s). 가속도는 이 값 × damping */
    walkSpeed: number
    /** 점프 초속(m/s) */
    jumpSpeed: number
    /** 대시 시작 속도(m/s) */
    dashSpeed: number
    /** 지상 감쇠(1/s). 클수록 빨리 서고 대시 꼬리가 짧다 */
    damping: number
}
/** 기본 물리 값(예전 game 코드와 같은 걷기·대시·감쇠). 조절 패널로 써 보고 정하면 여기를 바꾼다 by @nanangqq */
export const DEFAULT_WALK_PHYSICS: WalkPhysics = { gravity: 20, walkSpeed: 6, jumpSpeed: 8, dashSpeed: 65, damping: 4 }

const MAX_AIR_JUMPS = 2
/** 대시 시작 뒤 더 밀어 주는 시간(초)과 그 가속(dashSpeed 의 배수/s), 상한(dashSpeed 의 배수) */
const DASH_PUSH_DURATION = 0.05
const DASH_PUSH_ACCEL = 11.5
const DASH_SPEED_CAP = 2
/** 공중의 감쇠·조작 가속 비율(예전 코드: 감쇠 0.15배, 가속 9/25) */
const AIR_DAMPING_RATIO = 0.15
const AIR_CONTROL_RATIO = 0.36
const DASH_TAP_WINDOW = 0.32
const EYE_HEIGHT = 1.7
const LOOK_RATE = 0.002
/** 위아래 시점 한계(약 86°). 90° 면 lookAt 의 up 과 겹쳐 행렬이 무너진다 */
const PITCH_LIMIT = 1.5
const FOV_Y = (70 * Math.PI) / 180
/** 범위 가장자리에서 안쪽으로 둘 여유(m) */
const EDGE_MARGIN = 0.5
/** onMove 알림 간격(초) */
const MOVE_NOTIFY_INTERVAL = 0.1
const MAX_DT = 0.05
/** 포인터 잠금 API 를 쓸지. ?lock=0 이면 안 쓰고 흉내 낸다(테스트용) */
export const USE_POINTER_LOCK = new URLSearchParams(window.location.search).get("lock") !== "0"

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * @param options.sampler 지형 높이 조회기(범위 포함)
 * @param options.spawn 시작 xy(메쉬 로컬). 발은 그 자리 지표 위에 둔다
 * @param options.yaw 시작 방향(기본 북쪽)
 * @param options.onFocusChange 포커스(포인터 잠금)가 잡히거나 풀렸을 때(Esc, 창 전환, 요청 실패). 부모가 커서·안내를 바꾼다
 * @param options.onMove 위치가 바뀔 때 약 10 Hz 로(미니맵·상태 표시줄용)
 * @param options.physics 처음 물리 값(없는 항목은 기본값)
 * @param options.groundStep 계단형 층 간격(m). setGroundStep 참고
 */
export const createPlayer = ({
    sampler,
    spawn,
    yaw: initialYaw = Math.PI / 2,
    onFocusChange,
    onMove,
    physics: initialPhysics,
    groundStep: initialGroundStep = null,
}: {
    sampler: HeightSampler
    spawn: [number, number]
    yaw?: number
    onFocusChange?: (focused: boolean) => void
    onMove?: (move: PlayerMove) => void
    physics?: Partial<WalkPhysics>
    groundStep?: number | null
}): Player => {
    let physics: WalkPhysics = { ...DEFAULT_WALK_PHYSICS, ...initialPhysics }
    let groundStep = initialGroundStep
    /** 발 아래 지표 높이. 계단형이면 층 바닥으로 내림 */
    const groundAt = (gx: number, gy: number) => {
        const h = sampler.heightAt(gx, gy)
        if (h === null) return null
        return groundStep ? Math.floor(h / groundStep) * groundStep : h
    }
    let x = clamp(spawn[0], sampler.min[0] + EDGE_MARGIN, sampler.max[0] - EDGE_MARGIN)
    let y = clamp(spawn[1], sampler.min[1] + EDGE_MARGIN, sampler.max[1] - EDGE_MARGIN)
    let ground = groundAt(x, y) ?? sampler.min[2]
    let z = ground
    let vx = 0
    let vy = 0
    let vz = 0
    let yaw = initialYaw
    let pitch = 0
    let grounded = true
    let airJumps = 0
    let dashUntil = 0
    let lastForwardTap = -Infinity
    let clock = 0
    let sinceNotify = 0
    const keys = new Set<string>()
    let canvas: HTMLCanvasElement | null = null
    let locked = false

    const isTyping = (e: KeyboardEvent) => {
        const t = e.target as HTMLElement | null
        return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
    }
    const onKeyDown = (e: KeyboardEvent) => {
        if (isTyping(e)) return
        const code = e.code
        if (code === "Escape" && !USE_POINTER_LOCK) {
            // 잠금 흉내: Esc 로 포커스를 끈다(실제 잠금에서는 브라우저가 풀고 pointerlockchange 로 안다)
            setLocked(false)
            return
        }
        if (!locked) return
        if (code === "Space" || code.startsWith("Arrow")) e.preventDefault()
        if (e.repeat) {
            keys.add(code)
            return
        }
        if (code === "Space") {
            if (grounded) {
                vz = physics.jumpSpeed
                grounded = false
                airJumps = 0
            } else if (airJumps < MAX_AIR_JUMPS) {
                vz = physics.jumpSpeed
                airJumps++
            }
        }
        if (code === "KeyW" || code === "ArrowUp") {
            if (clock - lastForwardTap < DASH_TAP_WINDOW) {
                // 대시: 앞 방향 수평 속도를 즉시 올리고 잠깐 더 민다. 그 뒤는 감쇠가 줄인다
                vx = Math.cos(yaw) * physics.dashSpeed
                vy = Math.sin(yaw) * physics.dashSpeed
                dashUntil = clock + DASH_PUSH_DURATION
                lastForwardTap = -Infinity
            } else {
                lastForwardTap = clock
            }
        }
        keys.add(code)
    }
    const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code)
    const onMouseMove = (e: MouseEvent) => {
        if (!locked) return
        yaw -= e.movementX * LOOK_RATE
        pitch = clamp(pitch - e.movementY * LOOK_RATE, -PITCH_LIMIT, PITCH_LIMIT)
    }
    /** 포커스 상태를 바꾸고 알린다. 풀리면 눌린 키를 모두 뗀다 */
    const setLocked = (next: boolean) => {
        if (next === locked) return
        locked = next
        if (!next) keys.clear()
        onFocusChange?.(next)
    }
    const onLockChange = () => {
        if (!USE_POINTER_LOCK) return
        setLocked(document.pointerLockElement === canvas)
    }
    const onLockError = () => setLocked(false)
    const onBlur = () => keys.clear()
    /** 포인터 잠금을 요청한다(흉내 모드면 바로 포커스). 결과는 pointerlockchange/error 로 온다 */
    const requestLock = () => {
        if (!canvas) return
        if (!USE_POINTER_LOCK) {
            setLocked(true)
            return
        }
        // 최신 Chrome 은 Promise 를 돌려준다(거부되면 pointerlockerror 도 함께 난다)
        try {
            const r = canvas.requestPointerLock() as unknown
            if (r instanceof Promise) r.catch(() => onLockError())
        } catch {
            onLockError()
        }
    }

    const camera = (): FpsCamera => ({ eye: [x, y, z + EYE_HEIGHT], yaw, pitch, fovY: FOV_Y })

    const notify = () => onMove?.({ x, y, z, ground, yaw })

    return {
        attach: (el) => {
            canvas = el
            document.addEventListener("keydown", onKeyDown)
            document.addEventListener("keyup", onKeyUp)
            document.addEventListener("mousemove", onMouseMove)
            document.addEventListener("pointerlockchange", onLockChange)
            document.addEventListener("pointerlockerror", onLockError)
            window.addEventListener("blur", onBlur)
            requestLock()
            notify()
        },
        detach: () => {
            document.removeEventListener("keydown", onKeyDown)
            document.removeEventListener("keyup", onKeyUp)
            document.removeEventListener("mousemove", onMouseMove)
            document.removeEventListener("pointerlockchange", onLockChange)
            document.removeEventListener("pointerlockerror", onLockError)
            window.removeEventListener("blur", onBlur)
            if (document.pointerLockElement === canvas) document.exitPointerLock()
            locked = false
            canvas = null
            keys.clear()
        },
        step: (rawDt) => {
            const dt = clamp(rawDt, 0, MAX_DT)
            clock += dt
            // 이동 방향: 앞 = yaw, 오른쪽 = yaw − 90°
            let f = 0
            let s = 0
            if (keys.has("KeyW") || keys.has("ArrowUp")) f += 1
            if (keys.has("KeyS") || keys.has("ArrowDown")) f -= 1
            if (keys.has("KeyD") || keys.has("ArrowRight")) s += 1
            if (keys.has("KeyA") || keys.has("ArrowLeft")) s -= 1
            // 키 → 가속. 지상 가속 = 최고 속도 × 감쇠(그래야 최고 속도에서 가속과 감쇠가 비긴다), 공중은 그 0.36배
            if (locked && (f !== 0 || s !== 0)) {
                const len = Math.hypot(f, s)
                const accel = physics.walkSpeed * physics.damping * (grounded ? 1 : AIR_CONTROL_RATIO) * dt
                vx += ((f * Math.cos(yaw) + s * Math.sin(yaw)) / len) * accel
                vy += ((f * Math.sin(yaw) - s * Math.cos(yaw)) / len) * accel
            }
            // 대시 직후 잠깐 더 밀기(상한 있음)
            if (clock < dashUntil) {
                vx += Math.cos(yaw) * physics.dashSpeed * DASH_PUSH_ACCEL * dt
                vy += Math.sin(yaw) * physics.dashSpeed * DASH_PUSH_ACCEL * dt
                const h = Math.hypot(vx, vy)
                const cap = physics.dashSpeed * DASH_SPEED_CAP
                if (h > cap) {
                    vx *= cap / h
                    vy *= cap / h
                }
            }
            // 감쇠: 지상은 damping, 공중은 그 0.15배(거의 미끄러진다)
            const decay = Math.exp(-physics.damping * (grounded ? 1 : AIR_DAMPING_RATIO) * dt)
            vx *= decay
            vy *= decay
            if (Math.abs(vx) + Math.abs(vy) > 1e-4) {
                const nx = clamp(x + vx * dt, sampler.min[0] + EDGE_MARGIN, sampler.max[0] - EDGE_MARGIN)
                const ny = clamp(y + vy * dt, sampler.min[1] + EDGE_MARGIN, sampler.max[1] - EDGE_MARGIN)
                const g = groundAt(nx, ny)
                // 메쉬 밖(가장자리의 빈 삼각형)이나 범위 끝에서는 멈춘다
                if (g !== null) {
                    x = nx
                    y = ny
                    ground = g
                } else {
                    vx = 0
                    vy = 0
                }
            }
            vz -= physics.gravity * dt
            z += vz * dt
            if (z <= ground) {
                z = ground
                vz = 0
                grounded = true
                airJumps = 0
            } else {
                grounded = false
            }
            sinceNotify += dt
            if (sinceNotify >= MOVE_NOTIFY_INTERVAL) {
                sinceNotify = 0
                notify()
            }
            return camera()
        },
        setPhysics: (next) => {
            physics = { ...physics, ...next }
        },
        setGroundStep: (step) => {
            groundStep = step
            const g = groundAt(x, y)
            if (g !== null) ground = g
        },
        focus: requestLock,
    }
}
