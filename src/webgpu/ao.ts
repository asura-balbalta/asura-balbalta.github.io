import { Mat4, Vec3 } from "./camera"

/**
 * 화면 공간 주변광 차폐(SSAO)와 합성. 걸어 보기에서 단 밑동·건물 모서리에 하늘빛이 가려지는 그늘을 넣어 입체감을 낸다.
 *
 * 흐름(렌더러의 render 가 호출): 장면을 오프스크린 색 텍스처 + 깊이에 그린 뒤
 * 1. aoPass: 깊이만 읽어 픽셀의 위치(invViewProj. 카메라 기준 상대 위치 — 월드 좌표를 f32 로 복원하면 가까운 면에서
 *    0.1 ~ 0.5 mm 오차가 띠로 보였다, 2026-10-13)와 법선(이웃 깊이의 위치 차, 작은 쪽 선택)을 복원하고, 법선 반구 안의
 *    표본 12개를 viewProj 로 화면에 투영해 그 자리의 깊이가 더 가까우면 "가려짐" 으로 센다(거리 차가 반지름보다 크면 무시).
 *    표본 방향은 4×4 타일 안에서 16개 각도가 한 번씩 나오는 고정 패턴으로 돌린다(어느 4×4 창이든 모든 각도를 포함하므로
 *    2 의 흐림이 정확히 평균한다. 무작위 해시였을 때는 흐림 뒤에도 점이 남았다, 2026-10-13).
 *    평평한 면에서의 거짓 가림을 막으려고 깊이 비교 여유는 거리에 비례해 키우고 표본 시작점은 법선 쪽으로 띄운다
 *    (비스듬히 본 바닥은 한 픽셀이 수십 cm 라 고정 여유 5 cm 로는 복원 오차가 넘쳤다). 결과는 r8unorm(1 = 밝음), 화면의 AO_SCALE 배 해상도
 * 2. blurPass: 4×4 상자 흐림으로 회전 패턴을 평균한다
 * 3. compositePass: 장면 색 × AO × 외곽선을 캔버스에 쓴다. 외곽선(2026-10-13): 깊이에서 복원한 위치·법선으로 좌우·상하 이웃이
 *    이 픽셀의 접평면에서 벗어난 정도(꺾임: 계단 턱·건물 모서리)와 2차 차분(끊김: 멀리서 겹쳐 보이는 단·실루엣)을 재어
 *    1 px 선을 어둡게 섞는다. 더 먼 쪽 이웃이 이 픽셀보다 멀 때만 세어 선이 가까운 쪽 한 픽셀에만 생긴다. 안개와 함께 사라진다.
 *    SketchUp 의 edge 를 연하게 켠 것과 같은 효과로, 높이가 다른 윗면이 같은 색으로 이어져 보이는 문제를 줄인다
 * 멀리(maxDist)에서는 효과를 뺀다(안개 구간을 더 어둡게 하지 않으려고). 비용은 삼각형 수와 무관하게 픽셀 수에 비례한다
 */
const AO_FORMAT: GPUTextureFormat = "r8unorm"
/** AO 를 계산하는 해상도 배율. 0.5 면 가로·세로 절반(픽셀 1/4). 흐림을 거치므로 보기엔 큰 차이가 없다 */
export const AO_SCALE = 0.5
export const AO_PARAMS = {
    /** 표본 반구 반지름(m). 단 높이(1 m)보다 조금 크게 */
    radius: 1.2,
    /** 깊이 비교 여유(m). 여기에 거리 × biasPerMeter 를 더한다 */
    bias: 0.03,
    /** 거리 1 m 당 더하는 여유(m). 비스듬한 바닥의 복원 오차 때문 */
    biasPerMeter: 0.004,
    /** 표본 시작점을 법선 쪽으로 띄우는 비율(거리 × 이 값, m) */
    normalOffsetPerMeter: 0.002,
    /** 어둡게 하는 세기(0 ~ 1) */
    strength: 1.0,
    /** 이 거리(m)부터 효과가 사라진다(60% 지점부터 서서히) */
    maxDist: 400,
}
/** AO uniform: viewProj(0) + invViewProj(64) + eye(128) + radius(140) + params(144: bias, strength, maxDist, biasPerMeter) + size(160) + depthSize(168) + offset(176: normalOffsetPerMeter, 외곽선 세기, 안개 밀도, AO 켬) + debug(192: 출력 모드) */
const AO_UNIFORM_SIZE = 208
/**
 * 합성 pass 의 디버그 출력 모드(디버그 페이지 `aodebug=`. 운영 경로는 0). 흰색 = 0 으로 두어 판독이 쉽다.
 * 1 흐린 AO(대비 8배) · 2 흐림 전 AO(대비 8배) · 3 복원 법선(n·0.5+0.5) · 4 거리 등고선(fract(d/0.25)) ·
 * 5 이웃 행(아래)과의 거리 차 ×10 · 6 같은 차폐 계산을 전해상도로(대비 8배. 반해상도 pass 의 읽기 문제를 가르는 비교용)
 */
export type AoDebugMode = 0 | 1 | 2 | 3 | 4 | 5 | 6
/** 합성 pass 옵션. ao 가 꺼지면(그리고 debug 가 0 이면) 차폐·흐림 pass 를 건너뛰고 외곽선만 */
export type CompositeOptions = { ao: boolean; edge: number; fogDensity: number; debug: AoDebugMode }

const fullscreenVertex = /* wgsl */ `
    // 정점 3개로 화면을 덮는 삼각형
    @vertex
    fn vertexMain(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
        let x = f32(i32(i & 1u) * 4 - 1);
        let y = f32(i32(i >> 1u) * 4 - 1);
        return vec4f(x, y, 0.0, 1.0);
    }
`

/** AO·합성 셰이더 공통부: uniform, 깊이 텍스처, 깊이 → 위치(카메라 기준 상대 좌표), 이웃 깊이로 법선 복원 */
const aoCommon = /* wgsl */ `
    struct AoUniforms {
        viewProj: mat4x4f, // 카메라를 원점에 둔 viewProj(상대 위치를 투영한다)
        invViewProj: mat4x4f, // 그 역행렬: ndc → 카메라 기준 상대 위치
        eye: vec3f, // 카메라 월드 위치(상대 좌표계에서는 안 쓴다)
        radius: f32,
        params: vec4f, // bias, strength, maxDist, biasPerMeter
        size: vec2f, // AO 텍스처 크기(px)
        depthSize: vec2f, // 깊이 텍스처 크기(px)
        offset: vec4f, // x normalOffsetPerMeter, y 외곽선 세기(0 이면 없음), z 안개 밀도(1/m), w AO 켬(0/1)
        debug: vec4f, // x 디버그 출력 모드(AoDebugMode. 0 이면 없음)
    };
    @group(0) @binding(0) var<uniform> a: AoUniforms;
    @group(0) @binding(1) var depthTex: texture_depth_2d;

    // uv → 깊이 픽셀 번호(내림, 범위 안으로). 픽셀 중심 uv 를 넣으면 0.5 의 여유가 있어 f32 오차에 안전하다.
    // (크기 − 1)을 곱하던 때는 오른쪽·아래 절반이 한 픽셀 어긋나 가운데 열·행에 십자선이 생겼다(2026-10-13)
    fn depthPixel(uv: vec2f) -> vec2i {
        return vec2i(clamp(floor(uv * a.depthSize), vec2f(0.0), a.depthSize - 1.0));
    }
    /** 깊이 픽셀 번호 → 그 픽셀 중심의 uv */
    fn pixelUv(c: vec2i) -> vec2f {
        return (vec2f(c) + 0.5) / a.depthSize;
    }
    fn depthAtPixel(c: vec2i) -> f32 {
        let cc = clamp(c, vec2i(0), vec2i(a.depthSize) - 1);
        return textureLoad(depthTex, cc, 0);
    }
    fn depthAt(uv: vec2f) -> f32 {
        return textureLoad(depthTex, depthPixel(uv), 0);
    }
    // 픽셀 번호로 위치 복원: 그 픽셀의 중심 uv 와 깊이를 같이 쓴다(uv 와 깊이가 다른 픽셀의 것이면 비스듬한 면에서 어긋난다)
    fn worldAtPixel(c: vec2i) -> vec3f {
        return worldAt(pixelUv(c), depthAtPixel(c));
    }
    fn worldAt(uv: vec2f, d: f32) -> vec3f {
        let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, d, 1.0);
        let p = a.invViewProj * ndc;
        return p.xyz / p.w;
    }
    // 법선: 좌우·상하 이웃 중 깊이 차가 작은 쪽으로 위치 차를 잡아 모서리에서 번지지 않게. 카메라를 향하게 뒤집는다
    fn normalAt(P: vec3f, Pr: vec3f, Pl: vec3f, Pd: vec3f, Pu: vec3f) -> vec3f {
        let dx = select(Pr - P, P - Pl, length(Pl - P) < length(Pr - P));
        let dy = select(Pd - P, P - Pu, length(Pu - P) < length(Pd - P));
        var n = normalize(cross(dx, dy));
        if (dot(n, -P) < 0.0) { n = -n; }
        return n;
    }

    const SAMPLE_COUNT = 12u;
    // 4×4 타일의 회전 순서(0 ~ 15 를 섞은 것). 이웃끼리 각도가 멀어 흐림 전에도 띠가 덜 보인다
    const ROTATION = array<u32, 16>(0u, 8u, 2u, 10u, 12u, 4u, 14u, 6u, 3u, 11u, 1u, 9u, 15u, 7u, 13u, 5u);
    // 법선 반구(z > 0) 안의 표본. 길이를 달리해 가까운 곳을 더 촘촘히 본다
    const KERNEL = array<vec3f, 12>(
        vec3f(0.19, 0.07, 0.14), vec3f(-0.16, 0.20, 0.10), vec3f(0.05, -0.27, 0.18), vec3f(-0.30, -0.12, 0.22),
        vec3f(0.36, -0.20, 0.30), vec3f(0.10, 0.42, 0.26), vec3f(-0.45, 0.18, 0.38), vec3f(0.28, 0.30, 0.52),
        vec3f(-0.20, -0.55, 0.40), vec3f(0.62, 0.08, 0.46), vec3f(-0.52, -0.38, 0.60), vec3f(0.22, -0.60, 0.72),
    );

    // 깊이 픽셀 c0 의 차폐(1 = 밝음). cell 은 4×4 타일 안의 자리(회전 패턴). AO pass(반해상도)와 디버그 6(전해상도 비교)이 같은 함수를 쓴다
    fn aoAtPixel(c0: vec2i, cell: vec2u) -> f32 {
        let uv = pixelUv(c0);
        let d = depthAtPixel(c0);
        if (d <= 0.0) { return 1.0; } // 배경(역순 깊이: 0 이 가장 멀다)
        let P = worldAt(uv, d);
        let dist = length(P);
        let maxDist = a.params.z;
        if (dist > maxDist) { return 1.0; }

        // 법선: 좌우·상하 이웃 중 깊이 차가 작은 쪽으로 위치 차를 잡아 모서리에서 번지지 않게
        let Pr = worldAtPixel(c0 + vec2i(1, 0));
        let Pl = worldAtPixel(c0 - vec2i(1, 0));
        let Pd = worldAtPixel(c0 + vec2i(0, 1));
        let Pu = worldAtPixel(c0 - vec2i(0, 1));
        let n = normalAt(P, Pr, Pl, Pd, Pu);

        // 4×4 타일 안의 자리로 정해지는 회전(16개 각도가 한 번씩)으로 돌린 접선 틀
        let ang = f32(ROTATION[cell.x + cell.y * 4u]) * (6.2831853 / 16.0);
        let rnd = vec3f(cos(ang), sin(ang), 0.37);
        let t = normalize(rnd - n * dot(rnd, n));
        let b = cross(n, t);

        let bias = a.params.x + dist * a.params.w;
        let P0 = P + n * (dist * a.offset.x);
        var occlusion = 0.0;
        for (var i = 0u; i < SAMPLE_COUNT; i = i + 1u) {
            let k = KERNEL[i];
            let s = P0 + (t * k.x + b * k.y + n * k.z) * a.radius;
            let clip = a.viewProj * vec4f(s, 1.0);
            if (clip.w <= 0.0) { continue; }
            let suv = vec2f(clip.x / clip.w * 0.5 + 0.5, 0.5 - clip.y / clip.w * 0.5);
            if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) { continue; }
            let S = worldAtPixel(depthPixel(suv));
            let sceneDist = length(S);
            let sampleDist = length(s);
            // 표본보다 앞에 뭔가 있으면 가려진 것. 너무 멀리 떨어진 것(다른 물체)은 반지름 비율로 약하게
            let range = smoothstep(0.0, 1.0, a.radius / max(abs(dist - sceneDist), 1e-3));
            occlusion = occlusion + select(0.0, 1.0, sceneDist < sampleDist - bias) * range;
        }
        var ao = 1.0 - (occlusion / f32(SAMPLE_COUNT)) * a.params.y;
        ao = mix(ao, 1.0, smoothstep(maxDist * 0.6, maxDist, dist));
        return ao;
    }
`

const aoShader = (): GPUShaderModuleDescriptor => ({
    label: "ssao shader",
    code: /* wgsl */ `
    ${aoCommon}

    ${fullscreenVertex}

    @fragment
    fn fragmentMain(@builtin(position) fragPos: vec4f) -> @location(0) vec4f {
        // 이 AO 픽셀이 덮는 깊이 픽셀을 정수로 고르고(절반 해상도면 2i+1) 그 픽셀 중심으로 복원한다(aoAtPixel).
        // uv = fragPos / size 로 하면 절반 해상도 픽셀 중심이 깊이 픽셀의 경계에 정확히 걸려, floor(uv × 크기)가 f32 오차로
        // 행마다 2j 와 2j+1 로 갈리고 복원 위치가 반 픽셀씩 지그재그했다. 수평선 가까운 바닥은 한 행이 5 ~ 10 cm 라 bias 를
        // 넘어 거짓 차폐가 가로 줄무늬로 보였고, 어느 행이 갈리는지가 캔버스 높이에 따라 달랐다(946 은 줄무늬, 945 는 없음. 2026-10-14)
        let c0 = vec2i(floor(fragPos.xy * (a.depthSize / a.size)));
        let cell = vec2u(fragPos.xy) % 4u;
        return vec4f(aoAtPixel(c0, cell), 0.0, 0.0, 1.0);
    }
    `,
})

const blurShader = (): GPUShaderModuleDescriptor => ({
    label: "ao blur shader",
    code: /* wgsl */ `
    @group(0) @binding(0) var src: texture_2d<f32>;

    ${fullscreenVertex}

    @fragment
    fn fragmentMain(@builtin(position) fragPos: vec4f) -> @location(0) vec4f {
        let size = vec2i(textureDimensions(src));
        let base = vec2i(fragPos.xy);
        var sum = 0.0;
        for (var y = -2; y <= 1; y = y + 1) {
            for (var x = -2; x <= 1; x = x + 1) {
                let c = clamp(base + vec2i(x, y), vec2i(0), size - 1);
                sum = sum + textureLoad(src, c, 0).r;
            }
        }
        return vec4f(sum / 16.0, 0.0, 0.0, 1.0);
    }
    `,
})

const compositeShader = (): GPUShaderModuleDescriptor => ({
    label: "ao composite shader",
    code: /* wgsl */ `
    ${aoCommon}
    @group(0) @binding(2) var sceneTex: texture_2d<f32>;
    @group(0) @binding(3) var aoTex: texture_2d<f32>;
    @group(0) @binding(4) var aoSampler: sampler;
    @group(0) @binding(5) var rawAoTex: texture_2d<f32>; // 흐림 전 AO(디버그 2)

    ${fullscreenVertex}

    // 한 축(좌우 또는 상하)의 외곽선 세기(0 ~ 1)
    fn edgeAlong(P: vec3f, n: vec3f, Pa: vec3f, Pb: vec3f) -> f32 {
        let va = Pa - P;
        let vb = Pb - P;
        let la = length(va);
        let lb = length(vb);
        let m = min(la, lb) + 1e-4;
        // 꺾임: 이웃이 이 픽셀의 접평면에서 벗어난 거리 / 픽셀 간격(평면 0, 직각 모서리 1).
        // 이웃이 이 픽셀보다 가까운 쪽은 빼서 선이 모서리의 가까운 쪽 한 픽셀에만 생긴다(거리가 같으면 양쪽. 1/4 픽셀 간격 여유)
        let d0 = length(P);
        let ga = step(-0.25 * m, length(Pa) - d0);
        let gb = step(-0.25 * m, length(Pb) - d0);
        let crease = max(abs(dot(va, n)) * ga, abs(dot(vb, n)) * gb) / m;
        // 끊김: 2차 차분 / 픽셀 간격. 평면이면 거의 0. 더 멀리 떨어진 이웃이 이 픽셀보다 멀 때만(실루엣 선이 가까운 쪽 한 픽셀에만)
        let gate = select(gb, ga, la > lb);
        let jump = length(va + vb) / m * gate;
        return max(smoothstep(0.35, 0.8, crease), smoothstep(0.6, 1.5, jump));
    }

    // 대비 8배 회색(1 = 흰색 = 차폐 없음)
    fn contrast8(v: f32) -> vec4f {
        return vec4f(vec3f(1.0 - (1.0 - v) * 8.0), 1.0);
    }
    // 디버그 출력(AoDebugMode). 배경은 흰색
    fn debugOut(mode: i32, fragXY: vec2f, d: f32, aoBlurred: f32) -> vec4f {
        if (d <= 0.0) { return vec4f(1.0); }
        let c = vec2i(fragXY);
        if (mode == 1) { return contrast8(aoBlurred); }
        if (mode == 2) {
            let ac = clamp(vec2i(floor(fragXY * (a.size / a.depthSize))), vec2i(0), vec2i(a.size) - 1);
            return contrast8(textureLoad(rawAoTex, ac, 0).r);
        }
        if (mode == 6) { return contrast8(aoAtPixel(c, vec2u(fragXY) % 4u)); }
        let P = worldAtPixel(c);
        if (mode == 4) { return vec4f(vec3f(fract(length(P) / 0.25)), 1.0); }
        let Pd = worldAtPixel(c + vec2i(0, 1));
        if (mode == 5) { return vec4f(vec3f(1.0 - abs(length(Pd) - length(P)) * 10.0), 1.0); }
        // 3: 복원 법선
        let Pr = worldAtPixel(c + vec2i(1, 0));
        let Pl = worldAtPixel(c - vec2i(1, 0));
        let Pu = worldAtPixel(c - vec2i(0, 1));
        return vec4f(normalAt(P, Pr, Pl, Pd, Pu) * 0.5 + 0.5, 1.0);
    }

    @fragment
    fn fragmentMain(@builtin(position) fragPos: vec4f) -> @location(0) vec4f {
        let c = textureLoad(sceneTex, vec2i(fragPos.xy), 0);
        let uv = fragPos.xy / a.depthSize;
        let aoSample = textureSample(aoTex, aoSampler, uv).r;
        let mode = i32(a.debug.x);
        if (mode != 0) { return debugOut(mode, fragPos.xy, depthAt(uv), aoSample); }
        let ao = select(1.0, aoSample, a.offset.w > 0.5);
        var edge = 0.0;
        let d = depthAt(uv);
        if (a.offset.y > 0.0 && d > 0.0) {
            let P = worldAt(uv, d);
            let px = 1.0 / a.depthSize;
            let Pr = worldAt(uv + vec2f(px.x, 0.0), depthAt(uv + vec2f(px.x, 0.0)));
            let Pl = worldAt(uv - vec2f(px.x, 0.0), depthAt(uv - vec2f(px.x, 0.0)));
            let Pd = worldAt(uv + vec2f(0.0, px.y), depthAt(uv + vec2f(0.0, px.y)));
            let Pu = worldAt(uv - vec2f(0.0, px.y), depthAt(uv - vec2f(0.0, px.y)));
            let n = normalAt(P, Pr, Pl, Pd, Pu);
            edge = max(edgeAlong(P, n, Pr, Pl), edgeAlong(P, n, Pd, Pu));
            // 안개와 같은 비율로 사라진다(멀리서 선만 남지 않게)
            let fog = 1.0 - exp(-length(P) * a.offset.z);
            edge = edge * (1.0 - fog) * a.offset.y;
        }
        return vec4f(c.rgb * ao * (1.0 - edge), 1.0);
    }
    `,
})

/**
 * SSAO pass 들과 오프스크린 타깃을 만든다. 크기가 바뀌면 resize 로 텍스처를 다시 만든다.
 *
 * @param device GPU device
 * @param format 캔버스(= 오프스크린 장면 색) 텍스처 포맷
 * @returns sceneView(장면을 그릴 오프스크린 색 텍스처 view), setCamera, resize, aoPass, blurPass, compositePass, destroy
 */
export const createAoPasses = (device: GPUDevice, format: GPUTextureFormat) => {
    const uniformBuffer = device.createBuffer({
        label: "ao uniforms",
        size: AO_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(
        uniformBuffer,
        140,
        new Float32Array([AO_PARAMS.radius, AO_PARAMS.bias, AO_PARAMS.strength, AO_PARAMS.maxDist, AO_PARAMS.biasPerMeter]),
    )
    device.queue.writeBuffer(uniformBuffer, 176, new Float32Array([AO_PARAMS.normalOffsetPerMeter, 0, 0, 0]))
    const linearSampler = device.createSampler({ magFilter: "linear", minFilter: "linear" })

    const createPipeline = (name: string, shader: GPUShaderModuleDescriptor, target: GPUTextureFormat) => {
        const module = device.createShaderModule(shader)
        return device.createRenderPipeline({
            label: `pipeline (${name})`,
            layout: "auto",
            vertex: { module, entryPoint: "vertexMain" },
            fragment: { module, entryPoint: "fragmentMain", targets: [{ format: target }] },
            primitive: { topology: "triangle-list" },
        })
    }
    const aoPipeline = createPipeline("ssao", aoShader(), AO_FORMAT)
    const blurPipeline = createPipeline("ao blur", blurShader(), AO_FORMAT)
    const compositePipeline = createPipeline("ao composite", compositeShader(), format)

    type Targets = {
        scene: GPUTexture
        sceneView: GPUTextureView
        ao: GPUTexture
        aoView: GPUTextureView
        blur: GPUTexture
        blurView: GPUTextureView
        aoBindGroup: GPUBindGroup
        blurBindGroup: GPUBindGroup
        compositeBindGroup: GPUBindGroup
    }
    let targets: Targets | null = null

    /**
     * 캔버스 크기에 맞춰 오프스크린 텍스처와 바인드그룹을 (다시) 만든다.
     *
     * @param w 캔버스 픽셀 너비
     * @param h 캔버스 픽셀 높이
     * @param depthView 장면 깊이 텍스처 view(TEXTURE_BINDING 용도 포함)
     */
    const resize = (w: number, h: number, depthView: GPUTextureView) => {
        destroyTargets()
        const aw = Math.max(1, Math.round(w * AO_SCALE))
        const ah = Math.max(1, Math.round(h * AO_SCALE))
        const make = (label: string, size: [number, number], fmt: GPUTextureFormat) =>
            device.createTexture({
                label,
                size,
                format: fmt,
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            })
        const scene = make("scene color", [w, h], format)
        const ao = make("ao", [aw, ah], AO_FORMAT)
        const blur = make("ao blur", [aw, ah], AO_FORMAT)
        const sceneView = scene.createView()
        const aoView = ao.createView()
        const blurView = blur.createView()
        device.queue.writeBuffer(uniformBuffer, 160, new Float32Array([aw, ah, w, h]))
        targets = {
            scene,
            sceneView,
            ao,
            aoView,
            blur,
            blurView,
            aoBindGroup: device.createBindGroup({
                layout: aoPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: uniformBuffer } },
                    { binding: 1, resource: depthView },
                ],
            }),
            blurBindGroup: device.createBindGroup({
                layout: blurPipeline.getBindGroupLayout(0),
                entries: [{ binding: 0, resource: aoView }],
            }),
            compositeBindGroup: device.createBindGroup({
                layout: compositePipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: uniformBuffer } },
                    { binding: 1, resource: depthView },
                    { binding: 2, resource: sceneView },
                    { binding: 3, resource: blurView },
                    { binding: 4, resource: linearSampler },
                    { binding: 5, resource: aoView },
                ],
            }),
        }
    }
    const destroyTargets = () => {
        if (!targets) return
        targets.scene.destroy()
        targets.ao.destroy()
        targets.blur.destroy()
        targets = null
    }

    /**
     * 카메라 행렬을 쓴다. cameraUpdater 가 부른다
     *
     * @param viewProj 카메라를 원점에 둔 viewProj(cameraViewProjRelative)
     * @param invViewProj 그 역행렬
     * @param eye 카메라 월드 위치(참고용)
     */
    const setCamera = (viewProj: Mat4, invViewProj: Mat4, eye: Vec3) => {
        device.queue.writeBuffer(uniformBuffer, 0, viewProj)
        device.queue.writeBuffer(uniformBuffer, 64, invViewProj)
        device.queue.writeBuffer(uniformBuffer, 128, new Float32Array(eye))
    }

    const fullscreen = (
        encoder: GPUCommandEncoder,
        label: string,
        view: GPUTextureView,
        pipeline: GPURenderPipeline,
        bindGroup: GPUBindGroup,
    ) => {
        const pass = encoder.beginRenderPass({
            label,
            colorAttachments: [{ view, loadOp: "clear", clearValue: { r: 1, g: 1, b: 1, a: 1 }, storeOp: "store" }],
        })
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, bindGroup)
        pass.draw(3)
        pass.end()
    }

    let lastOptions: CompositeOptions | null = null
    /**
     * (AO 가 켜져 있으면) 차폐 계산 → 흐림 → 캔버스에 합성(AO × 외곽선). 오프스크린 장면이 그려진 뒤 부른다
     *
     * @param options ao 켬, 외곽선 세기(0 ~ 1, 0 이면 없음), 안개 밀도(외곽선이 안개와 같이 사라지도록), 디버그 출력 모드(0 이면 없음)
     */
    const run = (encoder: GPUCommandEncoder, canvasView: GPUTextureView, options: CompositeOptions) => {
        if (!targets) return
        if (
            !lastOptions ||
            lastOptions.ao !== options.ao ||
            lastOptions.edge !== options.edge ||
            lastOptions.fogDensity !== options.fogDensity ||
            lastOptions.debug !== options.debug
        ) {
            lastOptions = { ...options }
            device.queue.writeBuffer(
                uniformBuffer,
                176,
                new Float32Array([AO_PARAMS.normalOffsetPerMeter, options.edge, options.fogDensity, options.ao ? 1 : 0, options.debug, 0, 0, 0]),
            )
        }
        // 디버그 출력(1·2·6)은 AO 가 꺼져 있어도 차폐 텍스처가 있어야 한다
        if (options.ao || options.debug !== 0) {
            fullscreen(encoder, "ssao", targets.aoView, aoPipeline, targets.aoBindGroup)
            fullscreen(encoder, "ao blur", targets.blurView, blurPipeline, targets.blurBindGroup)
        }
        fullscreen(encoder, "ao composite", canvasView, compositePipeline, targets.compositeBindGroup)
    }

    return {
        /** 장면을 그릴 오프스크린 색 텍스처 view(resize 뒤에 있다) */
        sceneView: () => targets?.sceneView ?? null,
        setCamera,
        resize,
        run,
        destroy: () => {
            destroyTargets()
            uniformBuffer.destroy()
        },
    }
}
