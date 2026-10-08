import { STOP_COUNT } from "../terrainTheme"

/**
 * 두 지형 셰이더가 같이 쓰는 WGSL 조각.
 * - Uniforms: viewProj 행렬(offset 0) + 표고 최소·최대(offset 64, 지금은 안 씀) + 카메라 위치(offset 80)
 *   + 표고 색표 stops(offset 96, vec4f × STOP_COUNT: z, r, g, b. 높이 오름차순)
 *   + 건물색 buildingColor(offset 96 + 16·STOP_COUNT, vec4f), 총 112 + 16·STOP_COUNT 바이트
 * - terrainColor(): 절대 표고 → 바탕색. 색표는 uniform 이라 테마 전환은 셰이더를 바꾸지 않고 uniform 만 다시 쓴다
 * - shade(): 남동쪽 위의 빛으로 난반사 조명. 지도 톤을 살리려고 주변광 60% + 난반사 40%, 정반사 없음
 */
const commonWgsl = /* wgsl */ `
    const STOP_COUNT = ${STOP_COUNT}u;

    struct Uniforms {
        viewProj: mat4x4f,
        zRange: vec2f, // 표고 최소, 최대 (절대 표고 색표로 바꾼 뒤로는 안 쓴다)
        eye: vec3f, // 카메라 위치 (계단형의 양면 판정용)
        stops: array<vec4f, STOP_COUNT>, // 표고 색표: (z, r, g, b), 높이 오름차순
        buildingColor: vec4f, // 건물 레이어 색 (r, g, b, 1)
    };
    @group(0) @binding(0) var<uniform> u: Uniforms;

    // 단계 사이는 선형 보간, 양 끝 밖은 끝 색
    fn terrainColor(z: f32) -> vec3f {
        if (z <= u.stops[0].x) { return u.stops[0].yzw; }
        for (var i = 1u; i < STOP_COUNT; i = i + 1u) {
            if (z <= u.stops[i].x) {
                let a = u.stops[i - 1u];
                let b = u.stops[i];
                return mix(a.yzw, b.yzw, (z - a.x) / (b.x - a.x));
            }
        }
        return u.stops[STOP_COUNT - 1u].yzw;
    }

    fn shade(base: vec3f, n: vec3f, v: vec3f) -> vec3f {
        let l = normalize(vec3f(0.5, -0.5, 1.0)); // 남동쪽 위에서 비추는 빛(고도각 약 55°). 지도 음영 관례는 북서(315°)이나 비교를 위해 바꿔 봄
        let diffuse = max(dot(n, l), 0.0);
        return base * (0.6 + 0.4 * diffuse);
    }
`

/**
 * 부드러운 지형(TIN) 셰이더 descriptor. `device.createShaderModule()` 에 그대로 넘긴다.
 *
 * - 정점 입력: 위치(@location(0)) + 정점 법선(@location(1))
 * - vertexMain: 위치를 viewProj 로 변환하고 월드 좌표와 법선을 fragment 로 넘긴다.
 * - fragmentMain: 보간된 법선으로 픽셀마다 조명. 바탕색은 절대 표고 색표(terrainColor)
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
        let base = terrainColor(input.world.z);
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
 *   바탕색은 절대 표고 색표(terrainColor. 판은 층 높이라 판마다 한 색)이고, 수직면(단)은 25% 어둡게 해서 어느 방향에서든
 *   판과 구분되게 한다.
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
        let base = terrainColor(input.world.z) * riserShade;
        return vec4f(shade(base, n, v), 1);
    }
    `,
})

/**
 * 건물 레이어 셰이더 descriptor. 건물은 바닥 폴리곤을 세운 상자라 면이 모두 평면이므로, 계단형 지형과 같이
 * 정점 입력은 위치뿐이고 법선은 화면 미분으로 구한다(양면 조명). 색은 uniform 의 buildingColor 하나이고
 * 벽(수직면)은 25% 어둡게 해 지붕과 구분한다.
 *
 * @returns `{ label, code }` 형태의 GPUShaderModuleDescriptor
 */
export const createBuildingShader = () => ({
    label: "building shader",
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
        let wallShade = 1.0 - 0.25 * (1.0 - abs(n.z));
        let base = u.buildingColor.rgb * wallShade;
        return vec4f(shade(base, n, v), 1);
    }
    `,
})
