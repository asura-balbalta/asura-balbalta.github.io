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
