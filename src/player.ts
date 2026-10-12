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
 * 좌표는 메쉬 로컬(z-up, m). yaw 0 = 동쪽, 반시계. pitch 는 수평선 위로(라디안)
 *
 * 포인터 잠금은 기본으로 쓰지 않는다(잠금 없는 쪽을 골랐다 by @nanangqq, 2026-10-12): 커서가 보인 채 마우스가 어디서 움직이든 시점이
 * 돌고, Esc 키로 나간다. 마우스가 화면 가장자리에 닿으면 그 방향으로는 더 못 돈다. URL ?lock=1 이면 포인터 잠금을 쓴다
 * (커서 숨김, 무한 회전, Esc 로 잠금이 풀리면 나감). 앱 내장 브라우저는 잠금을 지원하지 않는다
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
}

const WALK_SPEED = 6
const GRAVITY = 20
const JUMP_SPEED = 8
const MAX_AIR_JUMPS = 2
const DASH_FACTOR = 3
const DASH_DURATION = 0.25
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
/** 포인터 잠금을 쓸지. 기본은 안 씀, ?lock=1 이면 씀 */
export const USE_POINTER_LOCK = new URLSearchParams(window.location.search).get("lock") === "1"

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * @param options.sampler 지형 높이 조회기(범위 포함)
 * @param options.spawn 시작 xy(메쉬 로컬). 발은 그 자리 지표 위에 둔다
 * @param options.yaw 시작 방향(기본 북쪽)
 * @param options.onExit 포인터 잠금이 풀렸을 때(Esc, 창 전환, 요청 실패). 부모가 걸어 보기를 끝낸다
 * @param options.onMove 위치가 바뀔 때 약 10 Hz 로(미니맵·상태 표시줄용)
 */
export const createPlayer = ({
    sampler,
    spawn,
    yaw: initialYaw = Math.PI / 2,
    onExit,
    onMove,
}: {
    sampler: HeightSampler
    spawn: [number, number]
    yaw?: number
    onExit: () => void
    onMove?: (move: PlayerMove) => void
}): Player => {
    let x = clamp(spawn[0], sampler.min[0] + EDGE_MARGIN, sampler.max[0] - EDGE_MARGIN)
    let y = clamp(spawn[1], sampler.min[1] + EDGE_MARGIN, sampler.max[1] - EDGE_MARGIN)
    let ground = sampler.heightAt(x, y) ?? sampler.min[2]
    let z = ground
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
            onExit()
            return
        }
        if (code === "Space" || code.startsWith("Arrow")) e.preventDefault()
        if (e.repeat) {
            keys.add(code)
            return
        }
        if (code === "Space") {
            if (grounded) {
                vz = JUMP_SPEED
                grounded = false
                airJumps = 0
            } else if (airJumps < MAX_AIR_JUMPS) {
                vz = JUMP_SPEED
                airJumps++
            }
        }
        if (code === "KeyW" || code === "ArrowUp") {
            if (clock - lastForwardTap < DASH_TAP_WINDOW) {
                dashUntil = clock + DASH_DURATION
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
    const onLockChange = () => {
        if (!USE_POINTER_LOCK) return
        const now = document.pointerLockElement === canvas
        if (locked && !now) onExit()
        locked = now
    }
    const onLockError = () => onExit()
    const onBlur = () => keys.clear()

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
            if (USE_POINTER_LOCK) {
                // 최신 Chrome 은 Promise 를 돌려준다(거부되면 pointerlockerror 도 함께 난다)
                try {
                    const r = el.requestPointerLock() as unknown
                    if (r instanceof Promise) r.catch(() => onExit())
                } catch {
                    onExit()
                }
            } else {
                locked = true
            }
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
            if (f !== 0 || s !== 0) {
                const len = Math.hypot(f, s)
                const speed = WALK_SPEED * (clock < dashUntil ? DASH_FACTOR : 1)
                const dx = ((f * Math.cos(yaw) + s * Math.sin(yaw)) / len) * speed * dt
                const dy = ((f * Math.sin(yaw) - s * Math.cos(yaw)) / len) * speed * dt
                const nx = clamp(x + dx, sampler.min[0] + EDGE_MARGIN, sampler.max[0] - EDGE_MARGIN)
                const ny = clamp(y + dy, sampler.min[1] + EDGE_MARGIN, sampler.max[1] - EDGE_MARGIN)
                const g = sampler.heightAt(nx, ny)
                // 메쉬 밖(가장자리의 빈 삼각형)으로는 나가지 않는다
                if (g !== null) {
                    x = nx
                    y = ny
                    ground = g
                }
            }
            vz -= GRAVITY * dt
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
    }
}
