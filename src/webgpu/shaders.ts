import { STOP_COUNT } from "../terrainTheme"
import { skyWgsl } from "./sky"

/** 섀도 맵 한 변(텍셀). 걸어 보기의 그림자 상자(반지름 SHADOW_RADIUS m)를 이 해상도로 덮는다 */
export const SHADOW_MAP_SIZE = 2048

/**
 * 모든 지형·건물 셰이더가 같이 쓰는 WGSL 조각.
 * - Uniforms: viewProj 행렬(offset 0) + 표고 최소·최대(offset 64, 지금은 안 씀) + 카메라 위치(offset 80)
 *   + 표고 색표 stops(offset 96, vec4f × STOP_COUNT: z, r, g, b. 높이 오름차순)
 *   + 건물색 buildingColor(offset 96 + 16·STOP_COUNT, vec4f)
 *   + 빛 기준 viewProj lightViewProj(그 뒤 64바이트, 섀도 맵을 뜰 때와 비교할 때 같이 쓴다)
 *   + lighting(vec4f: 주변광, 난반사, 그림자 켬(0/1), 안개 밀도 1/m)
 *   + fogColor(vec4f: 안개색 = 배경색)
 *   + hemi(vec4f: x = 반구 조명 세기. 주변광을 위를 향한 면 100%, 수직면 (1 − x)·100% 로 가른다. 하늘빛이 위에서 온다는 단서)
 *   + lightViewProjNear(가까운 캐스케이드) + sky(vec4f: xyz 태양 방향, w 하늘 켬. 켜지면 안개 목표색이 그 방향의 하늘색(sky.ts))
 *   오프셋은 terrainRenderer.ts 의 상수와 같아야 한다
 * - binding 1·2: 섀도 맵(depth)과 비교 샘플러. 셰이더가 쓰지 않으면(섀도 pass 의 정점 셰이더) layout "auto" 가 뺀다
 * - terrainColor(): 절대 표고 → 바탕색. 색표는 uniform 이라 테마 전환은 셰이더를 바꾸지 않고 uniform 만 다시 쓴다
 * - shadowFactor(): 빛 기준 좌표로 섀도 맵과 비교(3×3 PCF, 비교 샘플러의 선형 보간까지 합쳐 부드럽게). 상자 밖은 1(밝음).
 *   자기 그림자(acne)는 법선 방향 띄우기 + 깊이 바이어스로 줄인다
 * - shade(): 남동쪽 위의 빛으로 난반사 조명. 지도 톤의 기본은 주변광 60% + 난반사 40%(걸어 보기는 45/55 로 대비를 올린다),
 *   정반사 없음. 끝에 거리 안개(1 − e^(−d·밀도))로 배경색에 섞는다
 */
const commonWgsl = /* wgsl */ `
    const STOP_COUNT = ${STOP_COUNT}u;
    const SHADOW_TEXEL = ${1 / SHADOW_MAP_SIZE};

    struct Uniforms {
        viewProj: mat4x4f,
        zRange: vec2f, // 표고 최소, 최대 (절대 표고 색표로 바꾼 뒤로는 안 쓴다)
        eye: vec3f, // 카메라 위치 (계단형의 양면 판정용)
        stops: array<vec4f, STOP_COUNT>, // 표고 색표: (z, r, g, b), 높이 오름차순
        buildingColor: vec4f, // 건물 레이어 색 (r, g, b, 1)
        lightViewProj: mat4x4f, // 빛(평행광) 기준 직교 투영. 섀도 맵의 좌표계
        lighting: vec4f, // x 주변광, y 난반사, z 그림자 켬(0/1), w 안개 밀도(1/m, 0 이면 없음)
        fogColor: vec4f, // 안개색(배경색)
        hemi: vec4f, // x 반구 조명 세기(0 이면 없음)
        lightViewProjNear: mat4x4f, // 가까운 캐스케이드(카메라 주변 40 m, 텍셀 4 cm)의 빛 기준 투영
        sky: vec4f, // xyz 태양 방향(하늘·안개용), w 하늘 켬(0/1)
    };
    @group(0) @binding(0) var<uniform> u: Uniforms;
    @group(0) @binding(1) var shadowMap: texture_depth_2d;
    @group(0) @binding(2) var shadowSampler: sampler_comparison;
    @group(0) @binding(3) var shadowMapNear: texture_depth_2d;

    const LIGHT_DIR = vec3f(0.40825, -0.40825, 1.0); // 남동쪽 위에서 비추는 빛(고도각 60°, 하늘의 태양과 같은 방위). 지도 음영 관례는 북서(315°)

    ${skyWgsl}

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

    // 섀도 맵 한 장에서 5×5 PCF(비교 샘플러의 선형 보간까지 합쳐 부드럽게). Level 판이라 분기 안에서도 쓸 수 있다
    fn pcf(map: texture_depth_2d, uv: vec2f, z: f32) -> f32 {
        var lit = 0.0;
        for (var y = -2; y <= 2; y = y + 1) {
            for (var x = -2; x <= 2; x = x + 1) {
                let o = vec2f(f32(x), f32(y)) * SHADOW_TEXEL;
                lit = lit + textureSampleCompareLevel(map, shadowSampler, uv + o, z - 0.0012);
            }
        }
        return lit / 25.0;
    }
    // 빛 기준 투영 → (uv, 깊이, 상자 안이면 1)
    fn lightCoord(m: mat4x4f, p: vec3f) -> vec4f {
        let c = m * vec4f(p, 1.0);
        let ndc = c.xyz / c.w;
        let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
        let inside = uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0 && ndc.z >= 0.0 && ndc.z <= 1.0;
        return vec4f(uv, ndc.z, select(0.0, 1.0, inside));
    }
    // 이 점이 빛을 받는 비율(0 그림자 ~ 1 밝음). 가까운 캐스케이드 상자 안이면 그것을, 아니면 먼 것을 쓰되, 가까운 상자의
    // 가장자리 15% 띠에서는 둘을 서서히 섞어 경계선이 보이지 않게 한다(2026-10-13, 칼같이 나뉘던 것).
    // 그림자가 꺼져 있거나 두 상자 밖이면 1. 빛을 향한 면만 법선 방향으로 조금 띄운다(자기 그림자 줄임. 텍셀 크기에 맞춰 8 cm / 40 cm)
    fn shadowFactor(world: vec3f, n: vec3f, l: vec3f) -> f32 {
        if (u.lighting.z < 0.5) { return 1.0; }
        let facing = step(0.0, dot(n, l));
        let near = lightCoord(u.lightViewProjNear, world + n * 0.08 * facing);
        let edge = min(min(near.x, 1.0 - near.x), min(near.y, 1.0 - near.y));
        let w = select(0.0, smoothstep(0.0, 0.15, edge), near.w > 0.5);
        if (w >= 1.0) { return pcf(shadowMapNear, near.xy, near.z); }
        let far = lightCoord(u.lightViewProj, world + n * 0.4 * facing);
        var farLit = 1.0;
        if (far.w > 0.5) { farLit = pcf(shadowMap, far.xy, far.z); }
        if (w <= 0.0) { return farLit; }
        return mix(farLit, pcf(shadowMapNear, near.xy, near.z), w);
    }

    fn shade(base: vec3f, n: vec3f, world: vec3f) -> vec3f {
        let l = normalize(LIGHT_DIR);
        let diffuse = max(dot(n, l), 0.0) * shadowFactor(world, n, l);
        // 반구 조명: 위를 향할수록 하늘빛(주변광)을 다 받고, 수직면은 (1 − hemi) 만큼만
        let sky = 1.0 - u.hemi.x * (1.0 - (n.z * 0.5 + 0.5));
        let lit = base * (u.lighting.x * sky + u.lighting.y * diffuse);
        let d = distance(u.eye, world);
        let fog = clamp(1.0 - exp(-d * u.lighting.w), 0.0, 1.0);
        // 안개 목표색: 하늘이 켜져 있으면 그 방향의 하늘색(멀어지는 지형이 하늘로 녹아든다), 아니면 배경색
        var fogColor = u.fogColor.rgb;
        if (u.sky.w > 0.5) { fogColor = skyColor((world - u.eye) / max(d, 1e-3), u.sky.xyz); }
        return mix(lit, fogColor, fog);
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
        let base = terrainColor(input.world.z);
        return vec4f(shade(base, n, input.world), 1);
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
        return vec4f(shade(base, n, input.world), 1);
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
        return vec4f(shade(base, n, input.world), 1);
    }
    `,
})

/**
 * 섀도 맵을 뜨는 셰이더(정점만). 빛 기준 viewProj 로 깊이만 기록한다. 정점 입력은 위치 하나라 지형(tin·stepped)·건물의
 * 정점 버퍼를 그대로 쓴다(tin 의 법선 버퍼는 바인딩하지 않는다)
 *
 * @param cascade "far"(카메라 주변 250 m) 또는 "near"(40 m). 쓰는 행렬이 다르다
 * @returns `{ label, code }` 형태의 GPUShaderModuleDescriptor
 */
export const createShadowShader = (cascade: "far" | "near") => ({
    label: `shadow depth shader (${cascade})`,
    code: /* wgsl */ `
    ${commonWgsl}

    @vertex
    fn vertexMain(@location(0) pos: vec3f) -> @builtin(position) vec4f {
        return u.${cascade === "near" ? "lightViewProjNear" : "lightViewProj"} * vec4f(pos, 1);
    }
    `,
})
