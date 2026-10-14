import { LiquidGlass } from "../vendor/liquidglass/index.js"
import { RefObject, useEffect } from "react"

/**
 * 리퀴드 글래스(3D 화면의 유리 그릇). Chromium 엔진에서만 켠다: WebKit(iOS 전체·데스크톱 Safari)은 WebGPU 캔버스를
 * drawImage 로 읽으면 그 프레임의 화면 표시가 건너뛰어져 3D 가 멈춘 것처럼 보였다(2026-10-10 iPhone 확인, 끄면 정상).
 * Firefox 는 확인 전이라 같이 뺀다. 판별과 무관하게 끄거나 켜는 것은 디버그 페이지 `#/debug/app?glass=0|1`(src/debug/app.tsx →
 * App 의 env.glass). 운영 주소에는 스위치가 없다.
 *
 * 라이브러리는 루트의 직계 자식을 캔버스로 떠서(일반 DOM 은 html-to-image, canvas 는 drawImage) 유리 요소 위치에 WebGL 로
 * 굴절·흐림을 그린다. 3D 화면에서만 켠다: WebGPU 캔버스는 루트 직계 자식이라 data-dynamic 을 주면 매 프레임 drawImage 로
 * 복사되지만, 지도 화면의 OpenLayers 는 div 안의 캔버스라 html-to-image 경로를 타서 끌 때마다 다시 떠야 해 쓸 수 없다.
 * 켜는 동안 루트에 ui-lg 클래스를 달아 CSS 유리(배경·흐림·그림자)를 끄고, 유리 요소의 첫 자식으로 주입되는 캔버스가 그린다.
 * 요소마다 모서리 반지름을 dataset.config 로 준다(라이브러리 기본 65px 은 알약 전용).
 * 라이브러리는 init 때 받은 요소만 그리므로, 루트의 자식이 바뀌어 유리 대상 집합이 달라지면(모바일 ↔ 데스크톱 전환으로
 * 탭 막대 ↔ 독이 갈아 끼워지거나, 상태 알약·빠른 메뉴가 생기고 없어질 때) 인스턴스를 부수고 다시 만든다.
 * 상태 표시줄은 작은 글자가 많아 대상에서 빼고 CSS 유리(glass-strong)를 유지한다.
 * 측정용으로 window.__lg 에 인스턴스를 둔다(fps 속성).
 */
/** Chromium 엔진인지. userAgentData 가 있으면 brands 에 Chromium 이 있는지, 없으면 UA 의 "Chrome/"(iOS 의 CriOS 는 WebKit 이라 제외) */
const isChromium = () => {
    const brands = (navigator as { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands
    if (brands) return brands.some((b) => /chromium/i.test(b.brand))
    const ua = navigator.userAgent
    return /Chrome\/\d+/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua)
}

/** 이 브라우저의 기본값(Chromium 이면 켬). App 은 env.glass 가 있으면 그것을 우선한다 */
export const LIQUID_GLASS_DEFAULT = isChromium()

const searchParams = new URLSearchParams(window.location.search)

/**
 * 유리 틴트. 셰이더가 색에 GLASS_TINT_COLOR 를 strength 만큼 섞어 곱한다(1 을 넘으면 선형으로 더 강하게).
 * 무색이면 라이트 3D 화면에서 회색 건물 위에 올라간 독이 잘 안 보여 넣었다(2026-10-10 요청 by @nanangqq). 1 은 거의 티가 안 나고
 * 2.5 는 뚜렷한 파랑. accent 색상으로 바꾼 뒤에는 1 도 세서 0.5 로 골랐다 by @nanangqq. 런타임 비교는 콘솔에서 __lg.defaults.tintStrength·tintColor 를 바꾸면 바로 반영.
 * URL ?tint=숫자 로 세기 덮어쓰기. CSS 유리(terrainTheme.ts 의 glass)도 같은 톤으로 맞춘다
 *
 * 틴트 색: 라이브러리 원본 (0.92, 0.95, 1.05) 는 R 과 G 를 비슷하게 깎아 보라·군청 쪽(색상 약 225°)으로 보였다.
 * 라이트 accent #0f6cbd(색상 약 208°)에 맞추려고 R 을 더 깎고 G 는 거의 둔다: 0.5 배로 섞으면 (0.935, 0.985, 1.025),
 * 색상 약 207°. 밝기는 원본과 같다
 */
const GLASS_TINT_STRENGTH = 0.5
const GLASS_TINT_COLOR: [number, number, number] = [0.87, 0.97, 1.05]
const tintParam = Number(searchParams.get("tint"))
const glassTint = searchParams.has("tint") && Number.isFinite(tintParam) ? tintParam : GLASS_TINT_STRENGTH

/**
 * 유리 요소 선택자 → 모서리 반지름(ui.css 의 border-radius 와 같게)과 베벨 깊이 zRadius(px).
 * 셰이더는 가장자리에서 zRadius 만큼 들어올 때까지 높이를 올리고 그 뒤 평평하다. zRadius 가 요소 높이의 절반보다 크면
 * 평평한 구간이 없어 가운데 선에서 기울기가 뒤집혀 굴절 경계가 가로선으로 보인다. 그래서 높이 절반보다 작게 둔다
 * 베벨 폭만큼 테두리 안쪽에 굴절 띠가 생기므로 좁게(5px) 둔다. 처음 10~12 로 두니 테두리 안쪽에 흐린 띠가 보였다
 */
const GLASS_TARGETS: [selector: string, config: { cornerRadius: number; zRadius: number }][] = [
    [".ui-dock", { cornerRadius: 16, zRadius: 5 }],
    [".ui-search", { cornerRadius: 16, zRadius: 5 }],
    [".ui-pill", { cornerRadius: 16, zRadius: 5 }],
    [".ui-tabbar", { cornerRadius: 16, zRadius: 5 }],
    [".ui-status-pill", { cornerRadius: 14, zRadius: 5 }],
    [".ui-quick-menu", { cornerRadius: 16, zRadius: 5 }],
    [".ui-walk-pill", { cornerRadius: 22, zRadius: 5 }],
    [".ui-walk-hud", { cornerRadius: 18, zRadius: 5 }],
]

/**
 * @param active 3D 화면에서 true. 바뀔 때마다 만들고 부순다
 * @param root 루트 요소(FluentProvider 의 div). 유리 요소와 WebGPU 캔버스가 그 직계 자식이어야 한다
 */
export const useLiquidGlass = (active: boolean, root: RefObject<HTMLElement | null>) => {
    useEffect(() => {
        const rootEl = root.current
        if (!active || !rootEl) return
        const w = window as unknown as { __lg?: LiquidGlass }
        let instance: LiquidGlass | null = null
        let disposed = false
        /** 초기화 세대. 늦게 끝난 이전 초기화는 버린다 */
        let generation = 0
        let registered: HTMLElement[] = []
        let timer = 0

        /** 지금 루트에 있는 유리 대상 요소(모서리 반지름 config 를 달아서) */
        const collect = () => {
            const glass: HTMLElement[] = []
            for (const [selector, config] of GLASS_TARGETS) {
                for (const el of rootEl.querySelectorAll<HTMLElement>(selector)) {
                    el.dataset.config = JSON.stringify(config)
                    glass.push(el)
                }
            }
            return glass
        }
        const start = () => {
            const gen = ++generation
            const canvas = rootEl.querySelector<HTMLCanvasElement>('canvas[id^="terrain-canvas"]')
            if (canvas) canvas.dataset.dynamic = ""
            registered = collect()
            rootEl.classList.add("ui-lg")
            LiquidGlass.init({
                root: rootEl,
                glassElements: registered,
                // 가장자리 빛·프레넬·색수차를 낮춰 테두리 안쪽 띠가 보이지 않게. 흐림과 약한 굴절만 남긴다
                defaults: {
                    blurAmount: 0.25,
                    refraction: 0.35,
                    chromAberration: 0.01,
                    edgeHighlight: 0.02,
                    fresnel: 0.3,
                    specular: 0.08,
                    tintStrength: glassTint,
                    tintColor: GLASS_TINT_COLOR,
                    shadowOpacity: 0.2,
                    shadowSpread: 8,
                },
            })
                .then((created) => {
                    if (disposed || gen !== generation) return created.destroy()
                    instance = created
                    w.__lg = created
                })
                .catch((err) => console.error("리퀴드 글래스 초기화 실패:", err))
        }
        const restart = () => {
            if (disposed) return
            instance?.destroy()
            instance = null
            start()
        }
        start()
        // 루트의 자식이 바뀌어 유리 대상 집합이 달라지면 다시 만든다(같으면 그대로)
        const observer = new MutationObserver(() => {
            const now = collect()
            if (now.length === registered.length && now.every((el, i) => el === registered[i])) return
            window.clearTimeout(timer)
            timer = window.setTimeout(restart, 50)
        })
        observer.observe(rootEl, { childList: true })
        return () => {
            disposed = true
            window.clearTimeout(timer)
            observer.disconnect()
            instance?.destroy()
            rootEl.classList.remove("ui-lg")
            delete w.__lg
        }
    }, [active, root])
}
