/**
 * 지형 셰이더 모듈 descriptor 를 만든다. `device.createShaderModule()` 에 그대로 넘긴다.
 *
 * - uniform(@group(0) @binding(0)): viewProj 행렬(offset 0) + 표고 최소·최대(offset 64) + 카메라 위치(offset 80), 총 96바이트
 * - vertexMain: 정점 위치(@location(0))를 viewProj 로 변환하고, 월드 좌표와 정점 법선(@location(1))을 fragment 로 넘긴다.
 * - fragmentMain: 삼각형 안에서 보간된 법선으로 픽셀마다 Blinn-Phong 조명(주변광 + 난반사 + 정반사)을 계산하고,
 *   표고에 따라 녹색(낮음) → 베이지(높음)로 색을 섞는다.
 *
 * @returns `{ label, code }` 형태의 GPUShaderModuleDescriptor
 */
export const createTerrainShader = () => ({
    label: "terrain shader",
    code: /* wgsl */ `
    struct Uniforms {
        viewProj: mat4x4f,
        zRange: vec2f, // 색 그라데이션용 표고 최소, 최대
        eye: vec3f, // 카메라 위치 (정반사 계산용)
    };
    @group(0) @binding(0) var<uniform> u: Uniforms;

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
        let l = normalize(vec3f(-0.5, 0.5, 1.0)); // 북서쪽 위에서 비추는 빛
        let v = normalize(u.eye - input.world);
        let h = normalize(l + v);

        let diffuse = max(dot(n, l), 0.0);
        let specular = pow(max(dot(n, h), 0.0), 32.0) * 0.15;

        let t = clamp((input.world.z - u.zRange.x) / (u.zRange.y - u.zRange.x), 0.0, 1.0);
        let base = mix(vec3f(0.36, 0.52, 0.36), vec3f(0.86, 0.80, 0.66), t);
        return vec4f(base * (0.35 + 0.65 * diffuse) + vec3f(specular), 1);
    }
    `,
})
