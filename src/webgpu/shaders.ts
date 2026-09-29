/**
 * 지형 셰이더 모듈 descriptor 를 만든다. `device.createShaderModule()` 에 그대로 넘긴다.
 *
 * - uniform(@group(0) @binding(0)): viewProj 행렬(64바이트) + 표고 최소·최대(vec2f)
 * - vertexMain: 정점 위치(@location(0), vec3f)를 viewProj 로 변환하고, 월드 좌표를 fragment 로 넘긴다.
 * - fragmentMain: 화면 미분(dpdx·dpdy)으로 면 법선을 구해 북서쪽 위의 빛으로 음영을 주고,
 *   표고에 따라 녹색(낮음) → 베이지(높음)로 색을 섞는다. 법선 버퍼가 필요 없다.
 *
 * @returns `{ label, code }` 형태의 GPUShaderModuleDescriptor
 */
export const createTerrainShader = () => ({
    label: "terrain shader",
    code: /* wgsl */ `
    struct Uniforms {
        viewProj: mat4x4f,
        zRange: vec2f, // 색 그라데이션용 표고 최소, 최대
    };
    @group(0) @binding(0) var<uniform> u: Uniforms;

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
        // 법선 버퍼 없이 화면 미분으로 면 법선을 구한다. 지형은 위를 향하므로 z 가 음수면 뒤집는다
        var n = normalize(cross(dpdx(input.world), dpdy(input.world)));
        n = select(n, -n, n.z < 0);

        let light = normalize(vec3f(-0.5, 0.5, 1.0)); // 북서쪽 위에서 비추는 빛
        let diffuse = max(dot(n, light), 0.0);

        let t = clamp((input.world.z - u.zRange.x) / (u.zRange.y - u.zRange.x), 0.0, 1.0);
        let base = mix(vec3f(0.36, 0.52, 0.36), vec3f(0.86, 0.80, 0.66), t);
        return vec4f(base * (0.35 + 0.65 * diffuse), 1);
    }
    `,
})
