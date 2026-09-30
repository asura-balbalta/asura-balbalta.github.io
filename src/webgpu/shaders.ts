/**
 * 두 지형 셰이더가 같이 쓰는 WGSL 조각.
 * - Uniforms: viewProj 행렬(offset 0) + 표고 최소·최대(offset 64) + 카메라 위치(offset 80), 총 96바이트
 * - shade(): 북서쪽 위의 빛으로 Blinn-Phong(주변광 35% + 난반사 65% + 약한 정반사)
 */
const commonWgsl = /* wgsl */ `
    struct Uniforms {
        viewProj: mat4x4f,
        zRange: vec2f, // 색 그라데이션용 표고 최소, 최대
        eye: vec3f, // 카메라 위치 (정반사 계산용)
    };
    @group(0) @binding(0) var<uniform> u: Uniforms;

    fn shade(base: vec3f, n: vec3f, v: vec3f) -> vec3f {
        let l = normalize(vec3f(-0.5, 0.5, 1.0)); // 북서쪽 위에서 비추는 빛
        let h = normalize(l + v);
        let diffuse = max(dot(n, l), 0.0);
        let specular = pow(max(dot(n, h), 0.0), 32.0) * 0.15;
        return base * (0.35 + 0.65 * diffuse) + vec3f(specular);
    }
`

/**
 * 부드러운 지형(TIN) 셰이더 descriptor. `device.createShaderModule()` 에 그대로 넘긴다.
 *
 * - 정점 입력: 위치(@location(0)) + 정점 법선(@location(1))
 * - vertexMain: 위치를 viewProj 로 변환하고 월드 좌표와 법선을 fragment 로 넘긴다.
 * - fragmentMain: 보간된 법선으로 픽셀마다 조명. 바탕색은 표고에 따라 녹색(낮음) → 베이지(높음)
 *
 * @returns `{ label, code }` 형태의 GPUShaderModuleDescriptor
 */
export const createSmoothTerrainShader = () => ({
    label: "smooth terrain shader",
    code: /* wgsl */ `
    ${commonWgsl}

    struct VertexOutput {
        @builtin(position) p: vec4f,
        @location(0) world: vec3f,
        @location(1) normal: vec3f,
    };

    @vertex
    fn vertexMain(@location(0) pos: vec3f, @location(1) normal: vec3f) -> VertexOutput {
        var output: VertexOutput;
        output.p = u.viewProj * vec4f(pos, 1);
        output.world = pos;
        output.normal = normal;
        return output;
    }

    @fragment
    fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
        // 보간된 법선은 길이가 1이 아니므로 다시 정규화한다
        let n = normalize(input.normal);
        let v = normalize(u.eye - input.world);
        let t = clamp((input.world.z - u.zRange.x) / (u.zRange.y - u.zRange.x), 0.0, 1.0);
        let base = mix(vec3f(0.36, 0.52, 0.36), vec3f(0.86, 0.80, 0.66), t);
        return vec4f(shade(base, n, v), 1);
    }
    `,
})

/**
 * 계단형 지형(등고선 모형) 셰이더 descriptor. `device.createShaderModule()` 에 그대로 넘긴다.
 *
 * - 정점 입력: 위치(@location(0))만. 법선 버퍼가 없으므로 좌표가 같은 정점을 마음껏 공유할 수 있다.
 * - fragmentMain: 화면 미분(dpdx·dpdy)으로 그 픽셀이 속한 면의 법선을 구한다. 판·벽이 모두 평면이라 정확하다.
 *   미분으로 구한 법선은 앞뒤 부호가 정해지지 않으므로 카메라를 향하게 뒤집는다(양면 조명).
 *   바탕색은 모형 보드 같은 회백색 단색이고, 수직면(단)은 25% 어둡게 해서 어느 방향에서든 판과 구분되게 한다.
 *
 * @returns `{ label, code }` 형태의 GPUShaderModuleDescriptor
 */
export const createSteppedTerrainShader = () => ({
    label: "stepped terrain shader",
    code: /* wgsl */ `
    ${commonWgsl}

    struct VertexOutput {
        @builtin(position) p: vec4f,
        @location(0) world: vec3f,
    };

    @vertex
    fn vertexMain(@location(0) pos: vec3f) -> VertexOutput {
        var output: VertexOutput;
        output.p = u.viewProj * vec4f(pos, 1);
        output.world = pos;
        return output;
    }

    @fragment
    fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
        let v = normalize(u.eye - input.world);
        let faceNormal = normalize(cross(dpdx(input.world), dpdy(input.world)));
        let n = select(-faceNormal, faceNormal, dot(faceNormal, v) >= 0.0);
        let riserShade = 1.0 - 0.25 * (1.0 - abs(n.z));
        let base = vec3f(0.88, 0.86, 0.80) * riserShade;
        return vec4f(shade(base, n, v), 1);
    }
    `,
})
