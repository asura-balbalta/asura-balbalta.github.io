import { Mat4, Vec3 } from "./camera"

/**
 * 절차적 하늘(둘러보기용). 그림 파일 없이 픽셀마다 시선 방향과 태양 방향으로 하늘색을 계산한다.
 *
 * 모델: 대기 단일 산란의 해석적 근사. 시선이 지나는 공기량(Kasten–Young 상대 공기량: 천정 1, 수평선 약 38)으로 시선 투과율을,
 * 태양 고도의 공기량으로 태양빛 투과율을 구하고, Rayleigh(공기 분자, 파랑·수평선에서 희게)와 Mie(먼지·물방울, 태양 둘레 밝음)
 * 위상 함수로 산란광을 더한다. 태양을 낮추면 태양빛 투과율이 붉어져 저녁이 저절로 나온다. 마지막에 1 − e^(−c) 톤매핑 뒤
 * 1/2.2 감마로 sRGB 에 맞춘다(지형색은 sRGB 값을 그대로 쓰므로. 감마 없이는 천정이 짙은 남색으로 나왔다, 2026-10-13).
 * 같은 함수를 지형 셰이더의 안개 목표색에도 써서 멀어지는 지형이 그 방향의 하늘색으로 녹아든다(shaders.ts).
 *
 * pass: 전체 화면 삼각형을 역순 깊이의 가장 먼 값(0)으로, 깊이 비교 equal 로 그려 장면이 아무것도 안 그린 픽셀만 칠한다.
 * 장면 pass 뒤, SSAO 합성 전에 같은 색 타깃에 그린다
 */
export const skyWgsl = /* wgsl */ `
    const SKY_PI = 3.14159265;
    // 산란 계수(1/m) × 대기 두께(m) = 천정 방향 광학 깊이. Rayleigh 는 파장별(빨강 < 초록 < 파랑), Mie 는 무채색
    const SKY_BETA_R = vec3f(5.8e-6 * 8000.0, 13.5e-6 * 8000.0, 33.1e-6 * 8000.0);
    const SKY_BETA_M = vec3f(21e-6 * 1200.0);
    const SKY_SUN = 22.0; // 태양 세기(톤매핑 전)
    const SKY_G = 0.76; // Mie 비대칭. 클수록 태양 둘레 밝음이 좁다
    const SKY_NIGHT = vec3f(0.012, 0.016, 0.03); // 밤 바닥(다중 산란·별빛 대신, 낮에는 묻힌다)

    // Kasten–Young 상대 공기량. 지평선 아래(cosZ < 0)는 더 커져 태양빛이 거의 안 닿는다
    fn skyAirMass(cosZ: f32) -> f32 {
        let z = degrees(acos(clamp(cosZ, -1.0, 1.0)));
        return 1.0 / (max(cosZ, 0.0) + 0.50572 * pow(max(96.07995 - z, 0.01), -1.6364));
    }
    // dir: 시선 방향(단위), sun: 태양 방향(단위, 표면에서 태양으로). 수평선 아래 방향은 수평선 색
    fn skyColor(dir: vec3f, sun: vec3f) -> vec3f {
        let v = normalize(vec3f(dir.xy, max(dir.z, 0.0)) + vec3f(0.0, 0.0, 1e-4));
        let mu = dot(v, sun);
        let ext = SKY_BETA_R + SKY_BETA_M;
        let tView = exp(-ext * skyAirMass(v.z));
        let tSun = exp(-ext * skyAirMass(sun.z));
        let phaseR = 3.0 / (16.0 * SKY_PI) * (1.0 + mu * mu);
        let g2 = SKY_G * SKY_G;
        let phaseM = 3.0 / (8.0 * SKY_PI) * ((1.0 - g2) * (1.0 + mu * mu)) / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * SKY_G * mu, 1.5));
        let inscatter = (SKY_BETA_R * phaseR + SKY_BETA_M * phaseM) / ext * (1.0 - tView) * tSun * SKY_SUN;
        let disc = smoothstep(0.99955, 0.9999, mu) * tSun * SKY_SUN * 0.5; // 태양 원반(지름 약 1.2°)
        let c = inscatter + vec3f(disc) + SKY_NIGHT * (1.0 - v.z * 0.7);
        return pow(1.0 - exp(-c), vec3f(1.0 / 2.2));
    }
`

/**
 * 태양 방향(표면에서 태양으로, 단위 벡터).
 *
 * @param altitudeDeg 고도각(°). 0 수평선, 90 천정, 음수면 지평선 아래
 * @param horizontal 수평 방향(xy). 길이는 무관(그림자 빛의 방위각과 같게 넘긴다)
 */
export const sunDirection = (altitudeDeg: number, horizontal: [number, number]): Vec3 => {
    const a = (altitudeDeg * Math.PI) / 180
    const len = Math.hypot(horizontal[0], horizontal[1]) || 1
    return [(horizontal[0] / len) * Math.cos(a), (horizontal[1] / len) * Math.cos(a), Math.sin(a)]
}

/** 하늘 uniform: invViewProj(0) + eye(64) + sun(80) + size(96) */
const SKY_UNIFORM_SIZE = 112

const skyShader = (): GPUShaderModuleDescriptor => ({
    label: "sky shader",
    code: /* wgsl */ `
    struct SkyUniforms {
        invViewProj: mat4x4f, // 카메라를 원점에 둔 viewProj 의 역행렬(ndc → 카메라 기준 방향)
        eye: vec3f, // 안 쓴다(카메라 기준 좌표계)
        _pad: f32,
        sun: vec4f, // xyz 태양 방향
        size: vec2f, // 타깃 크기(px)
    };
    @group(0) @binding(0) var<uniform> s: SkyUniforms;

    ${skyWgsl}

    // 화면을 덮는 삼각형. z = 0 은 역순 깊이의 가장 먼 값이라 깊이 비교 equal 이 "장면이 안 그린 픽셀" 만 통과시킨다
    @vertex
    fn vertexMain(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
        let x = f32(i32(i & 1u) * 4 - 1);
        let y = f32(i32(i >> 1u) * 4 - 1);
        return vec4f(x, y, 0.0, 1.0);
    }

    @fragment
    fn fragmentMain(@builtin(position) fragPos: vec4f) -> @location(0) vec4f {
        let uv = fragPos.xy / s.size;
        let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.5, 1.0);
        let p = s.invViewProj * ndc;
        let dir = normalize(p.xyz / p.w);
        return vec4f(skyColor(dir, s.sun.xyz), 1.0);
    }
    `,
})

/**
 * 하늘 pass 를 만든다.
 *
 * @param device GPU device
 * @param format 색 타깃 포맷(캔버스 = 오프스크린 장면 색)
 * @param depthFormat 장면 깊이 텍스처 포맷(역순 깊이)
 * @returns setCamera(카메라가 바뀔 때), setSun(태양 방향), setSize(타깃 크기), run(장면 pass 뒤에), destroy
 */
export const createSkyPass = (device: GPUDevice, format: GPUTextureFormat, depthFormat: GPUTextureFormat) => {
    const uniformBuffer = device.createBuffer({
        label: "sky uniforms",
        size: SKY_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    const module = device.createShaderModule(skyShader())
    const pipeline = device.createRenderPipeline({
        label: "pipeline (sky)",
        layout: "auto",
        vertex: { module, entryPoint: "vertexMain" },
        fragment: { module, entryPoint: "fragmentMain", targets: [{ format }] },
        primitive: { topology: "triangle-list" },
        depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: "equal" },
    })
    const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
    })

    const setCamera = (invViewProj: Mat4, eye: Vec3) => {
        device.queue.writeBuffer(uniformBuffer, 0, invViewProj)
        device.queue.writeBuffer(uniformBuffer, 64, new Float32Array(eye))
    }
    const setSun = (sun: Vec3) => device.queue.writeBuffer(uniformBuffer, 80, new Float32Array([...sun, 0]))
    const setSize = (w: number, h: number) => device.queue.writeBuffer(uniformBuffer, 96, new Float32Array([w, h]))

    /** 장면이 그려진 색 타깃에, 깊이가 아직 가장 먼 값인 픽셀만 하늘색으로 채운다 */
    const run = (encoder: GPUCommandEncoder, colorView: GPUTextureView, depthView: GPUTextureView) => {
        const pass = encoder.beginRenderPass({
            label: "sky",
            colorAttachments: [{ view: colorView, loadOp: "load", storeOp: "store" }],
            depthStencilAttachment: { view: depthView, depthReadOnly: true },
        })
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, bindGroup)
        pass.draw(3)
        pass.end()
    }

    return { setCamera, setSun, setSize, run, destroy: () => uniformBuffer.destroy() }
}
