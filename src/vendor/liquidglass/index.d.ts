/**
 * @ybouane/liquidglass 1.0.3 의 최소 타입 선언(원본 dist/*.d.ts 에서 쓰는 부분만 옮김).
 * index.js 는 npm 패키지의 dist/index.js 를 그대로 복사한 번들(html-to-image 포함, 의존성 없음). LICENSE.md 참고
 */

/** 유리 요소 하나의 설정. 요소의 dataset.config(JSON) 또는 init 의 defaults 로 준다 */
export interface GlassConfig {
    /** 배경 흐림 0 ~ 1 */
    blurAmount: number
    /** 굴절 세기 */
    refraction: number
    /** 가장자리 색수차 */
    chromAberration: number
    /** 가장자리 빛 */
    edgeHighlight: number
    /** 정반사 하이라이트 */
    specular: number
    /** 비스듬히 볼 때의 프레넬 반사 */
    fresnel: number
    /** 잔물결 왜곡 */
    distortion: number
    /** 모서리 반지름(CSS px) */
    cornerRadius: number
    /** 단면 곡률(베벨 깊이) */
    zRadius: number
    /** 전체 불투명도 */
    opacity: number
    /** 채도 -1 ~ 1 */
    saturation: number
    /** 푸른 유리 틴트 */
    tintStrength: number
    /** 밝기 -0.5 ~ 0.5 */
    brightness: number
    /** 그림자 불투명도 */
    shadowOpacity: number
    /** 그림자 퍼짐(CSS px) */
    shadowSpread: number
    /** 그림자 세로 오프셋(CSS px) */
    shadowOffsetY: number
    /** 끌어서 옮길 수 있게 */
    floating: boolean
    /** 버튼처럼 호버·누름 반응 */
    button: boolean
    /** 0: 양면 볼록, 1: 돔 */
    bevelMode: number
}

export interface LiquidGlassOptions {
    /** 루트. 유리 요소와 배경(캔버스 등)이 이 요소의 직계 자식이어야 한다 */
    root: HTMLElement
    /** 유리 효과를 줄 요소들 */
    glassElements?: NodeListOf<HTMLElement> | HTMLElement[]
    /** 기본 설정 덮어쓰기 */
    defaults?: Partial<GlassConfig>
}

export declare class LiquidGlass {
    static init(options: LiquidGlassOptions): Promise<LiquidGlass>
    readonly root: HTMLElement
    readonly defaults: GlassConfig
    /** 매 프레임 갱신되는 fps */
    fps: number
    /** 렌더 루프를 멈추고 주입한 캔버스·WebGL 자원을 정리한다 */
    destroy(): void
    /** 라이브러리가 못 보는 변화(캔버스 픽셀 갱신 등)를 알린다. 인자가 없으면 모든 유리를 다시 그린다 */
    markChanged(element?: HTMLElement): void
}

export declare const DEFAULTS: GlassConfig
/** 글꼴을 나중에 불러왔을 때, 다음 init 이 글꼴 캐시를 다시 만들게 한다 */
export declare function invalidateFontEmbedCache(): void
