import { Mat4, Vec3 } from "./camera"

/**
 * 화면 공간 주변광 차폐(SSAO)와 합성. 걸어 보기에서 단 밑동·건물 모서리에 하늘빛이 가려지는 그늘을 넣어 입체감을 낸다.
 *
 * 흐름(렌더러의 render 가 호출): 장면을 오프스크린 색 텍스처 + 깊이에 그린 뒤
 * 1. aoPass: 깊이만 읽어 픽셀의 월드 위치(invViewProj)와 법선(이웃 깊이의 위치 차, 작은 쪽 선택)을 복원하고, 법선 반구 안의
 *    표본 12개를 viewProj 로 화면에 투영해 그 자리의 깊이가 더 가까우면 "가려짐" 으로 센다(거리 차가 반지름보다 크면 무시).
 *    표본 방향은 4×4 타일 안에서 16개 각도가 한 번씩 나오는 고정 패턴으로 돌린다(어느 4×4 창이든 모든 각도를 포함하므로
 *    2 의 흐림이 정확히 평균한다. 무작위 해시였을 때는 흐림 뒤에도 점이 남았다, 2026-10-13).
 *    평평한 면에서의 거짓 가림을 막으려고 깊이 비교 여유는 거리에 비례해 키우고 표본 시작점은 법선 쪽으로 띄운다
 *    (비스듬히 본 바닥은 한 픽셀이 수십 cm 라 고정 여유 5 cm 로는 복원 오차가 넘쳤다). 결과는 r8unorm(1 = 밝음), 화면의 AO_SCALE 배 해상도
 * 2. blurPass: 4×4 상자 흐림으로 회전 패턴을 평균한다
 * 3. compositePass: 장면 색 × AO 를 캔버스에 쓴다
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
/** AO uniform: viewProj(0) + invViewProj(64) + eye(128) + radius(140) + params(144: bias, strength, maxDist, biasPerMeter) + size(160) + depthSize(168) + offset(176: normalOffsetPerMeter) */
const AO_UNIFORM_SIZE = 192

const fullscreenVertex = /* wgsl */ `
    // 정점 3개로 화면을 덮는 삼각형
    @vertex
    fn vertexMain(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
        let x = f32(i32(i & 1u) * 4 - 1);
        let y = f32(i32(i >> 1u) * 4 - 1);
        return vec4f(x, y, 0.0, 1.0);
    }
`

const aoShader = (): GPUShaderModuleDescriptor => ({
    label: "ssao shader",
    code: /* wgsl */ `
    struct AoUniforms {
        viewProj: mat4x4f,
        invViewProj: mat4x4f,
        eye: vec3f,
        radius: f32,
        params: vec4f, // bias, strength, maxDist, biasPerMeter
        size: vec2f, // AO 텍스처 크기(px)
        depthSize: vec2f, // 깊이 텍스처 크기(px)
        offset: vec4f, // x normalOffsetPerMeter
    };
    @group(0) @binding(0) var<uniform> a: AoUniforms;
    @group(0) @binding(1) var depthTex: texture_depth_2d;

    const SAMPLE_COUNT = 12u;
    // 4×4 타일의 회전 순서(0 ~ 15 를 섞은 것). 이웃끼리 각도가 멀어 흐림 전에도 띠가 덜 보인다
    const ROTATION = array<u32, 16>(0u, 8u, 2u, 10u, 12u, 4u, 14u, 6u, 3u, 11u, 1u, 9u, 15u, 7u, 13u, 5u);
    // 법선 반구(z > 0) 안의 표본. 길이를 달리해 가까운 곳을 더 촘촘히 본다
    const KERNEL = array<vec3f, 12>(
        vec3f(0.19, 0.07, 0.14), vec3f(-0.16, 0.20, 0.10), vec3f(0.05, -0.27, 0.18), vec3f(-0.30, -0.12, 0.22),
        vec3f(0.36, -0.20, 0.30), vec3f(0.10, 0.42, 0.26), vec3f(-0.45, 0.18, 0.38), vec3f(0.28, 0.30, 0.52),
        vec3f(-0.20, -0.55, 0.40), vec3f(0.62, 0.08, 0.46), vec3f(-0.52, -0.38, 0.60), vec3f(0.22, -0.60, 0.72),
    );

    ${fullscreenVertex}

    fn depthAt(uv: vec2f) -> f32 {
        let c = vec2i(clamp(uv, vec2f(0.0), vec2f(1.0)) * (a.depthSize - 1.0));
        return textureLoad(depthTex, c, 0);
    }
    fn worldAt(uv: vec2f, d: f32) -> vec3f {
        let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, d, 1.0);
        let p = a.invViewProj * ndc;
        return p.xyz / p.w;
    }

    @fragment
    fn fragmentMain(@builtin(position) fragPos: vec4f) -> @location(0) vec4f {
        let uv = fragPos.xy / a.size;
        let d = depthAt(uv);
        if (d >= 1.0) { return vec4f(1.0); } // 배경
        let P = worldAt(uv, d);
        let dist = distance(P, a.eye);
        let maxDist = a.params.z;
        if (dist > maxDist) { return vec4f(1.0); }

        // 법선: 좌우·상하 이웃 중 깊이 차가 작은 쪽으로 위치 차를 잡아 모서리에서 번지지 않게
        let px = 1.0 / a.depthSize;
        let Pr = worldAt(uv + vec2f(px.x, 0.0), depthAt(uv + vec2f(px.x, 0.0)));
        let Pl = worldAt(uv - vec2f(px.x, 0.0), depthAt(uv - vec2f(px.x, 0.0)));
        let Pd = worldAt(uv + vec2f(0.0, px.y), depthAt(uv + vec2f(0.0, px.y)));
        let Pu = worldAt(uv - vec2f(0.0, px.y), depthAt(uv - vec2f(0.0, px.y)));
        let dx = select(Pr - P, P - Pl, length(Pl - P) < length(Pr - P));
        let dy = select(Pd - P, P - Pu, length(Pu - P) < length(Pd - P));
        var n = normalize(cross(dx, dy));
        if (dot(n, a.eye - P) < 0.0) { n = -n; }

        // 4×4 타일 안의 자리로 정해지는 회전(16개 각도가 한 번씩)으로 돌린 접선 틀
        let cell = vec2u(fragPos.xy) % 4u;
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
            let S = worldAt(suv, depthAt(suv));
            let sceneDist = distance(S, a.eye);
            let sampleDist = distance(s, a.eye);
            // 표본보다 앞에 뭔가 있으면 가려진 것. 너무 멀리 떨어진 것(다른 물체)은 반지름 비율로 약하게
            let range = smoothstep(0.0, 1.0, a.radius / max(abs(dist - sceneDist), 1e-3));
            occlusion = occlusion + select(0.0, 1.0, sceneDist < sampleDist - bias) * range;
        }
        var ao = 1.0 - (occlusion / f32(SAMPLE_COUNT)) * a.params.y;
        ao = mix(ao, 1.0, smoothstep(maxDist * 0.6, maxDist, dist));
        return vec4f(ao, 0.0, 0.0, 1.0);
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
    @group(0) @binding(0) var sceneTex: texture_2d<f32>;
    @group(0) @binding(1) var aoTex: texture_2d<f32>;
    @group(0) @binding(2) var aoSampler: sampler;

    ${fullscreenVertex}

    @fragment
    fn fragmentMain(@builtin(position) fragPos: vec4f) -> @location(0) vec4f {
        let c = textureLoad(sceneTex, vec2i(fragPos.xy), 0);
        let uv = fragPos.xy / vec2f(textureDimensions(sceneTex));
        let ao = textureSample(aoTex, aoSampler, uv).r;
        return vec4f(c.rgb * ao, 1.0);
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
                    { binding: 0, resource: sceneView },
                    { binding: 1, resource: blurView },
                    { binding: 2, resource: linearSampler },
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
     * 카메라 행렬을 쓴다(장면 카메라와 같은 값). cameraUpdater 가 부른다
     *
     * @param viewProj 장면 viewProj
     * @param invViewProj 그 역행렬
     * @param eye 카메라 위치
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

    /** 차폐 계산 → 흐림 → 캔버스에 합성. 오프스크린 장면이 그려진 뒤 부른다 */
    const run = (encoder: GPUCommandEncoder, canvasView: GPUTextureView) => {
        if (!targets) return
        fullscreen(encoder, "ssao", targets.aoView, aoPipeline, targets.aoBindGroup)
        fullscreen(encoder, "ao blur", targets.blurView, blurPipeline, targets.blurBindGroup)
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
