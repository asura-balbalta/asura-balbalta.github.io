import { LayerId } from "../layers"
import { MeshChunk, TinMesh } from "../terrainData"
import { hexToRgb, STOP_COUNT, stopsToUniform, TerrainTheme } from "../terrainTheme"
import { createAoPasses } from "./ao"
import { createSkyPass, sunDirection } from "./sky"
import type { AoDebugMode } from "./ao"
import {
    Camera,
    cameraEye,
    cameraViewProj,
    cameraViewProjRelative,
    fpsForward,
    invert,
    isFpsCamera,
    lookAt,
    multiply,
    ortho,
    Vec3,
} from "./camera"
import { initWebGPU } from "./device"
import {
    createBuildingHighlightShader,
    createBuildingShader,
    createShadowShader,
    createSmoothTerrainShader,
    createSteppedTerrainShader,
    SHADOW_MAP_SIZE,
} from "./shaders"

/** 장면 깊이. 32비트 부동소수 + 역순 깊이(camera.ts perspective 참고): 비교 greater, 지움 0 */
const DEPTH_FORMAT: GPUTextureFormat = "depth32float"

/** 깊이 텍스처 홀더. pass 들이 공유하며, 캔버스 크기가 바뀌면 resizeUpdater 가 안의 텍스처·view 를 바꿔 끼운다 */
type DepthHolder = { texture: GPUTexture; view: GPUTextureView; width: number; height: number }
const STOPS_OFFSET = 96 // 표고 색표 array<vec4f, STOP_COUNT> 의 시작 (shaders.ts 의 Uniforms 와 같아야 한다)
const BUILDING_COLOR_OFFSET = STOPS_OFFSET + 16 * STOP_COUNT // 건물색 vec4f
const LIGHT_VP_OFFSET = BUILDING_COLOR_OFFSET + 16 // 빛 기준 viewProj mat4x4f
const LIGHTING_OFFSET = LIGHT_VP_OFFSET + 64 // vec4f: 주변광, 난반사, 그림자 켬, 안개 밀도
const FOG_COLOR_OFFSET = LIGHTING_OFFSET + 16 // vec4f: 안개색
const HEMI_OFFSET = FOG_COLOR_OFFSET + 16 // vec4f: 반구 조명 세기
const LIGHT_VP_NEAR_OFFSET = HEMI_OFFSET + 16 // 가까운 캐스케이드의 빛 기준 viewProj mat4x4f
const SKY_OFFSET = LIGHT_VP_NEAR_OFFSET + 64 // vec4f: 태양 방향 xyz + 하늘 켬
const HIGHLIGHT_COLOR_OFFSET = SKY_OFFSET + 16 // vec4f: 조준점 건물 강조색(테마 accent) + 투명도
const UNIFORM_SIZE = HIGHLIGHT_COLOR_OFFSET + 16 // viewProj(0~64) + zRange(64~72) + eye(80~92) + stops + buildingColor + lightViewProj + lighting + fogColor + hemi + lightViewProjNear + sky + highlightColor
const SHADOW_FORMAT: GPUTextureFormat = "depth32float"
/** 빛 방향(표면에서 빛으로, 남동 위 고도각 60°). shaders.ts 의 LIGHT_DIR 과 같아야 한다. 하늘의 태양은 이 방위각에 테마의 고도를 쓴다 */
const LIGHT_DIR: Vec3 = [0.40825, -0.40825, 1]
/** 가까운 섀도 캐스케이드의 반지름(m). 2048 텍셀이면 텍셀 약 4 cm */
const SHADOW_NEAR_RADIUS = 40
const normalize3 = (v: Vec3): Vec3 => {
    const len = Math.hypot(v[0], v[1], v[2])
    return [v[0] / len, v[1] / len, v[2] / len]
}
const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
/** 빛 기준 축(lookAt 과 같은 규칙: z = 빛 쪽, x = up × z, y = z × x). 상자 중심을 텍셀 단위로 스냅할 때 쓴다 */
const LIGHT_Z = normalize3(LIGHT_DIR)
const LIGHT_X = normalize3(cross3([0, 0, 1], LIGHT_Z))
const LIGHT_Y = cross3(LIGHT_Z, LIGHT_X)

/**
 * 조명 설정. 걸어 보기는 그림자·안개를 켜고 대비를 올려 입체감을 내고, 궤도 보기는 지도 톤(주변광 60%)을 유지한다.
 * 그림자는 카메라 주변 shadowRadius(m) 상자만 섀도 맵(SHADOW_MAP_SIZE²)에 뜬다. 안개는 1 − e^(−거리·fogDensity)
 */
export type Lighting = {
    ambient: number
    diffuse: number
    shadows: boolean
    shadowRadius: number
    fogDensity: number
    /** 반구 조명 세기(0 ~ 1). 수직면의 주변광이 이만큼 줄어든다 */
    hemisphere: number
    /** 화면 공간 주변광 차폐(ao.ts). 켜면 장면을 오프스크린에 그리고 AO 를 곱해 합성한다 */
    ao: boolean
    /** 절차적 하늘(sky.ts). 켜면 장면이 안 그린 픽셀을 하늘색으로 채우고 안개도 하늘색으로 */
    sky: boolean
    /** 외곽선 세기(0 ~ 1, 0 이면 없음. ao.ts 합성 pass). 계단 턱·건물 모서리·겹쳐 보이는 단에 1 px 선 */
    edge: number
}
export const DEFAULT_LIGHTING: Lighting = {
    ambient: 0.6,
    diffuse: 0.4,
    shadows: false,
    shadowRadius: 250,
    fogDensity: 0,
    hemisphere: 0,
    ao: false,
    sky: false,
    edge: 0,
}
/**
 * 렌더 디버그 설정. 운영 App 은 비운 채({}) 쓰고, 디버그 페이지(src/debug/walk.tsx)가 주소 해시의 파라미터를 해석해 채운다.
 * 2026-10-14 까지는 운영 주소의 ?ao=0·?shadow=0·?sky=0·?edge=·?sun=·?lock=0 을 여기(모듈 상단)와 player.ts 가 직접 읽었다.
 * 모든 항목은 선택이고, 없으면 기본 동작
 */
export type RenderDebug = {
    /** false 면 둘러보기 SSAO 끔 */
    ao?: boolean
    /** false 면 둘러보기 그림자 끔 */
    shadow?: boolean
    /** false 면 절차적 하늘 끔(안개는 배경색으로) */
    sky?: boolean
    /** 외곽선 세기(0 ~ 1, 0 이면 끔). 없으면 EDGE_STRENGTH */
    edge?: number
    /** 하늘 태양 고도(°). 없으면 테마 값 */
    sun?: number
    /** SSAO 합성 pass 의 디버그 출력 모드(ao.ts AoDebugMode). 없으면 0 */
    aodebug?: AoDebugMode
    /** 둘러보기 중 장면에 그릴 반경(m, 카메라에서 도엽 범위까지). 없으면 WALK_CULL_RADIUS */
    walkRadius?: number
    /** false 면 포인터 잠금 API 없이 흉내(내장 브라우저·자동 캡처용. player.ts) */
    pointerLock?: boolean
    /** false 면 마우스로 시점을 돌리지 않는다(자동 캡처의 결정론: 보이는 창 위를 지나는 실제 마우스가 시점을 바꾸지 않게) */
    mouseLook?: boolean
    /** false 면 둘러보기 중 조준점의 건물 찾기(강조·조준점 옆 정보)를 끈다(TerrainViewCanvas·buildingPick.ts) */
    pick?: boolean
    /** 도엽 생성 때 이웃을 합치는 경계 띠 폭(m). 0 이면 이웃 전체(옛 동작). 없으면 보조 워커 기본값(terrainTileBuild.worker.ts) */
    band?: number
}
/**
 * 둘러보기 중 장면에 그릴 반경(m). 이보다 먼 도엽은 그리지 않는다(L4, 2026-10-14). 안개 1/1200 에서 5 km 의 가시도는 약 1.5 % 라
 * 사라지는 것이 보이지 않는다. 디버그 페이지 walkradius= 로 바꿔 비교한다
 */
export const WALK_CULL_RADIUS = 5000
/** 외곽선 기본 세기(0.18 = 18% 어둡게. 0.25 는 진했다, 2026-10-13). Chrome 에서 edge= 로 비교해 정하면 바꾼다 by @nanangqq */
const EDGE_STRENGTH = 0.18
/**
 * 둘러보기(걸어 보기) 조명. 디버그 설정으로 SSAO·그림자·하늘을 끄거나 외곽선 세기를 바꿀 수 있다
 *
 * @param debug 렌더 디버그 설정(운영은 {})
 */
export const walkLighting = (debug: RenderDebug = {}): Lighting => ({
    ambient: 0.5,
    diffuse: 0.5,
    shadows: debug.shadow !== false,
    shadowRadius: 250,
    fogDensity: 1 / 1200,
    hemisphere: 0.35,
    ao: debug.ao !== false,
    sky: debug.sky !== false,
    edge: debug.edge ?? EDGE_STRENGTH,
})

/** 지형 표현 방식. tin: 정점 법선으로 부드럽게, stepped: 계단형(면 법선, 법선 버퍼 없음) */
export type TerrainMode = "tin" | "stepped"

/** 메쉬 정점 좌표의 범위. 원점을 뺀 로컬 좌표(m) 기준 */
export type MeshBounds = {
    min: [number, number, number]
    max: [number, number, number]
}

/**
 * 배경 pass 함수를 만든다. 프레임마다 가장 먼저 실행되어 색 버퍼와 깊이 버퍼를 비운다.
 *
 * @param bg 배경색 홀더(0 ~ 1). color 를 바꾸면 다음 프레임부터 반영된다(backgroundUpdater)
 * @param depth 깊이 텍스처 홀더. 뒤이은 pass 들이 같은 view 를 load 해서 쓴다. 캔버스 크기가 바뀌면 resizeUpdater 가 바꿔 끼운다
 * @returns `(encoder, target) => void` pass 함수. target 은 캔버스 또는 오프스크린 장면 텍스처의 view
 */
const renderBackgroundPassFactory =
    (bg: { color: { r: number; g: number; b: number } }, depth: DepthHolder) =>
    (encoder: GPUCommandEncoder, target: GPUTextureView) => {
        const backgroundPass = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: target,
                    loadOp: "clear",
                    clearValue: { ...bg.color, a: 1 },
                    storeOp: "store",
                },
            ],
            depthStencilAttachment: {
                view: depth.view,
                depthLoadOp: "clear",
                depthClearValue: 0, // 역순 깊이: 0 이 가장 멀다
                depthStoreOp: "store",
            },
        })
        backgroundPass.end()
    }

/**
 * 메쉬를 "버퍼 하나가 maxBytes 를 넘지 않는" 조각들로 나눈다. 넓은 범위에서 정점·인덱스 버퍼가
 * WebGPU 기본 한도(maxBufferSize, 보통 256MB)를 넘어도 한도를 올리지 않고 그릴 수 있게 하기 위한 것.
 *
 * 삼각형을 순서대로 조각에 담다가, 조각의 정점 수나 인덱스 수가 한도에 닿으면 조각을 끊는다.
 * 조각마다 그 조각이 쓰는 정점만 모아 0부터 다시 번호를 매기므로(globalToLocal), 조각 사이에 정점이 중복될 수 있지만
 * 삼각형은 그대로라 그리는 결과는 같다. 조각은 generator 로 하나씩 만들어 메모리를 한 조각 분량만 더 쓴다.
 * 메쉬 전체가 한도 안이면 복사 없이 그대로 하나의 조각으로 돌려준다.
 *
 * @param positions 정점 좌표 (x, y, z) 연속 배열
 * @param indices 삼각형 인덱스 (3개씩)
 * @param normals 정점 법선(선택). 있으면 조각마다 같이 나눈다
 * @param maxBytes 버퍼 하나의 최대 바이트 수 (device.limits.maxBufferSize)
 */
function* splitMeshIntoChunks(
    positions: Float32Array,
    indices: Uint32Array,
    normals: Float32Array | undefined,
    maxBytes: number,
): Generator<MeshChunk> {
    if (positions.byteLength <= maxBytes && indices.byteLength <= maxBytes) {
        yield { positions, normals, indices }
        return
    }

    const vertexCount = positions.length / 3
    const maxVerts = Math.floor(maxBytes / 12)
    const maxIndices = Math.floor(maxBytes / 4) - (Math.floor(maxBytes / 4) % 3)
    const globalToLocal = new Int32Array(vertexCount).fill(-1)
    const localToGlobal = new Uint32Array(Math.min(maxVerts, vertexCount))

    let start = 0
    while (start < indices.length) {
        const capacity = Math.min(maxIndices, indices.length - start)
        const chunkIndices = new Uint32Array(capacity)
        let localCount = 0
        let n = 0
        // 삼각형 하나가 새 정점을 최대 3개 만들므로, 그만큼 여유가 있을 때만 담는다
        while (n + 3 <= capacity && localCount + 3 <= maxVerts) {
            for (let k = 0; k < 3; k++) {
                const g = indices[start + n + k]
                let l = globalToLocal[g]
                if (l < 0) {
                    l = localCount++
                    globalToLocal[g] = l
                    localToGlobal[l] = g
                }
                chunkIndices[n + k] = l
            }
            n += 3
        }
        if (n === 0) throw new Error("버퍼 한도가 너무 작아 삼각형 하나도 담을 수 없음")

        const chunkPositions = new Float32Array(localCount * 3)
        const chunkNormals = normals ? new Float32Array(localCount * 3) : undefined
        for (let l = 0; l < localCount; l++) {
            const g = localToGlobal[l]
            chunkPositions.set(positions.subarray(g * 3, g * 3 + 3), l * 3)
            chunkNormals?.set(normals!.subarray(g * 3, g * 3 + 3), l * 3)
            globalToLocal[g] = -1
        }
        yield {
            positions: chunkPositions,
            normals: chunkNormals,
            indices: n === capacity ? chunkIndices : chunkIndices.subarray(0, n),
        }
        start += n
    }
}

/** 정점 버퍼 하나에 float32x3 하나가 들어가는 레이아웃 */
const float32x3Layout = (shaderLocation: number): GPUVertexBufferLayout => ({
    arrayStride: 12,
    attributes: [{ format: "float32x3", offset: 0, shaderLocation }],
})

/**
 * 지형 pass 와 그 데이터를 바꾸는 updater 들을 만든다.
 *
 * 셰이더 모듈, 파이프라인(깊이 테스트 포함), uniform 버퍼, 바인드그룹은 여기서 한 번만 만든다.
 * 파이프라인은 셋이다: 지형 tin(좌표 + 정점 법선, 부드러운 음영), 지형 stepped(좌표만, 셰이더에서 면 법선),
 * buildings(좌표만, 면 법선, 건물색). uniform 버퍼는 모두 같이 쓰고, 바인드그룹만 파이프라인마다 만든다(layout "auto" 라서).
 * GPU 조각은 도엽별로 들고 있고(streamTiles), pass 는 보이는 레이어만 그린다(layerVisibilityUpdater).
 * 도엽과 카메라는 반환하는 updater 로 버퍼만 바꾼다.
 *
 * @param device GPU device
 * @param format 캔버스 텍스처 포맷
 * @param depth 배경 pass 와 공유하는 깊이 텍스처 홀더
 * @param initialAspect 처음 화면 가로/세로 비율(카메라 투영용). 캔버스 크기가 바뀌면 aspectUpdater 로 갱신한다
 * @returns scenePass 와 updater 들
 */
const createTerrainDrawingPassAndUpdaters = (
    device: GPUDevice,
    format: GPUTextureFormat,
    depth: DepthHolder,
    initialAspect: number,
    /** 지금 렌더 디버그 설정(태양 고도 덮어쓰기). 바뀌면 paletteUpdater 를 다시 불러야 반영된다 */
    getDebug: () => RenderDebug,
) => {
    let aspect = initialAspect
    /** 마지막으로 올린 카메라. 비율이 바뀌면 같은 카메라로 viewProj 를 다시 쓴다 */
    let lastCamera: Camera | null = null
    const uniformBuffer = device.createBuffer({
        label: "terrain uniforms",
        size: UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    // 섀도 맵(빛 기준 깊이)과 비교 샘플러. 선형 필터를 주면 비교 결과가 보간돼(하드웨어 PCF) 가장자리가 부드럽다
    const shadowTexture = device.createTexture({
        label: "shadow map",
        size: [SHADOW_MAP_SIZE, SHADOW_MAP_SIZE],
        format: SHADOW_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    const shadowView = shadowTexture.createView()
    const shadowTextureNear = device.createTexture({
        label: "shadow map (near)",
        size: [SHADOW_MAP_SIZE, SHADOW_MAP_SIZE],
        format: SHADOW_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    const shadowViewNear = shadowTextureNear.createView()
    const shadowSampler = device.createSampler({ compare: "less", magFilter: "linear", minFilter: "linear" })

    /** 파이프라인과 그 바인드그룹을 만든다(uniform + 섀도 맵 + 비교 샘플러) */
    const createPipelineSet = (
        name: string,
        shader: GPUShaderModuleDescriptor,
        buffers: GPUVertexBufferLayout[],
        /** overlay: 반투명으로 덮어 그리는 파이프라인(건물 강조). 알파 블렌딩, 깊이는 읽기만(같은 면을 통과하도록 greater-equal) */
        options: { overlay?: boolean } = {},
    ) => {
        const shaderModule = device.createShaderModule(shader)
        const pipeline = device.createRenderPipeline({
            label: `pipeline (${name})`,
            layout: "auto",
            vertex: { module: shaderModule, entryPoint: "vertexMain", buffers },
            fragment: {
                module: shaderModule,
                entryPoint: "fragmentMain",
                targets: [
                    options.overlay
                        ? {
                              format,
                              blend: {
                                  color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
                                  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
                              },
                          }
                        : { format },
                ],
            },
            primitive: { topology: "triangle-list", cullMode: "none" },
            depthStencil: {
                format: DEPTH_FORMAT,
                depthWriteEnabled: !options.overlay,
                depthCompare: options.overlay ? "greater-equal" : "greater", // 역순 깊이
            },
        })
        // layout "auto" 는 셰이더가 실제로 쓰는 바인딩만 레이아웃에 넣는다. 강조(overlay) 셰이더는 uniform 만 써서 섀도 맵 entry 를
        // 넣으면 바인드그룹이 무효가 되고(그 프레임의 command buffer 전체가 버려져 화면이 검게 됨, 2026-10-15), 0 번만 넣는다
        const bindGroup = device.createBindGroup({
            label: `bind group (${name})`,
            layout: pipeline.getBindGroupLayout(0),
            entries: options.overlay
                ? [{ binding: 0, resource: { buffer: uniformBuffer } }]
                : [
                      { binding: 0, resource: { buffer: uniformBuffer } },
                      { binding: 1, resource: shadowView },
                      { binding: 2, resource: shadowSampler },
                      { binding: 3, resource: shadowViewNear },
                  ],
        })
        return { pipeline, bindGroup }
    }

    // 섀도 pass 파이프라인(캐스케이드마다 하나): 정점 위치만 받아 빛 기준 깊이를 기록한다. 색 출력 없음. 깊이 바이어스로 자기 그림자를 줄인다
    const createShadowCascade = (cascade: "far" | "near", view: GPUTextureView) => {
        const module = device.createShaderModule(createShadowShader(cascade))
        const pipeline = device.createRenderPipeline({
            label: `pipeline (shadow ${cascade})`,
            layout: "auto",
            vertex: { module, entryPoint: "vertexMain", buffers: [float32x3Layout(0)] },
            primitive: { topology: "triangle-list", cullMode: "none" },
            depthStencil: {
                format: SHADOW_FORMAT,
                depthWriteEnabled: true,
                depthCompare: "less",
                depthBias: 2,
                depthBiasSlopeScale: 2,
            },
        })
        const bindGroup = device.createBindGroup({
            label: `bind group (shadow ${cascade})`,
            layout: pipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
        })
        return { pipeline, bindGroup, view }
    }
    const shadowCascades = [createShadowCascade("far", shadowView), createShadowCascade("near", shadowViewNear)]

    const pipelines: Record<TerrainMode | "buildings" | "buildingHighlight", ReturnType<typeof createPipelineSet>> = {
        tin: createPipelineSet("terrain tin", createSmoothTerrainShader(), [
            float32x3Layout(0),
            float32x3Layout(1),
        ]),
        stepped: createPipelineSet("terrain stepped", createSteppedTerrainShader(), [
            float32x3Layout(0),
        ]),
        buildings: createPipelineSet("buildings", createBuildingShader(), [float32x3Layout(0)]),
        buildingHighlight: createPipelineSet("building highlight", createBuildingHighlightShader(), [float32x3Layout(0)], { overlay: true }),
    }

    type GpuChunk = {
        vertexBuffer: GPUBuffer
        normalBuffer: GPUBuffer | null
        indexBuffer: GPUBuffer
        indexCount: number
        /** 원본 메쉬 인덱스 배열에서 이 조각이 시작하는 자리(조각이 삼각형 순서대로 나뉘므로). 건물 강조가 삼각형 범위를 조각 안 자리로 옮기는 데 쓴다 */
        indexStart: number
    }
    const layerVisible: Record<LayerId, boolean> = { terrain: true, buildings: true }

    const destroyChunks = (chunks: GpuChunk[]) => {
        for (const c of chunks) {
            c.vertexBuffer.destroy()
            c.normalBuffer?.destroy()
            c.indexBuffer.destroy()
        }
    }

    /** 버퍼를 만들고 데이터를 써서 돌려준다 */
    const uploadBuffer = (label: string, usage: GPUBufferUsageFlags, data: Float32Array | Uint32Array) => {
        const buffer = device.createBuffer({ label, size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST })
        device.queue.writeBuffer(buffer, 0, data)
        return buffer
    }

    /** 조각을 GPU 버퍼로 올린 GpuChunk 를 만든다 */
    const uploadChunk = (label: string, chunk: MeshChunk, indexStart = 0): GpuChunk => ({
        vertexBuffer: uploadBuffer(`${label} vertices`, GPUBufferUsage.VERTEX, chunk.positions),
        normalBuffer: chunk.normals ? uploadBuffer(`${label} normals`, GPUBufferUsage.VERTEX, chunk.normals) : null,
        indexBuffer: uploadBuffer(`${label} indices`, GPUBufferUsage.INDEX, chunk.indices),
        indexCount: chunk.indices.length,
        indexStart,
    })

    /**
     * 레이어를 그릴지 정한다(다음 프레임부터). 메쉬·버퍼는 그대로 두므로 바로 켜고 끌 수 있다.
     *
     * @param id 레이어
     * @param visible true 면 그린다
     */
    const layerVisibilityUpdater = (id: LayerId, visible: boolean) => {
        layerVisible[id] = visible
    }

    /**
     * 카메라 상태로 viewProj 행렬(uniform offset 0)과 카메라 위치(offset 80, 정반사 계산용)를 쓴다.
     *
     * @param camera 궤도 카메라 또는 1인칭 카메라(걸어 보기)
     */
    const cameraUpdater = (camera: Camera) => {
        lastCamera = camera
        const viewProj = cameraViewProj(camera, aspect)
        const eye = cameraEye(camera)
        lastEye = eye
        device.queue.writeBuffer(uniformBuffer, 0, viewProj)
        device.queue.writeBuffer(uniformBuffer, 80, new Float32Array(eye))
        if (lighting.shadows) {
            device.queue.writeBuffer(uniformBuffer, LIGHT_VP_OFFSET, lightViewProj(camera, lighting.shadowRadius, 0.6))
            device.queue.writeBuffer(uniformBuffer, LIGHT_VP_NEAR_OFFSET, lightViewProj(camera, SHADOW_NEAR_RADIUS, 0.5))
        }
        if (lighting.ao || lighting.sky || lighting.edge > 0) {
            // 후처리는 카메라 기준 행렬을 받는다(복원 위치 = 카메라에서 본 상대 위치. f32 정밀도 때문, camera.ts 참고)
            const rel = cameraViewProjRelative(camera, aspect)
            onCamera?.(rel, invert(rel), eye)
        }
    }
    /** 마지막 카메라 위치(거리 거르기용) */
    let lastEye: Vec3 | null = null
    /** 카메라가 바뀔 때 다른 pass(SSAO·외곽선·하늘)에도 알린다. 행렬은 카메라 기준(cameraViewProjRelative) */
    let onCamera: ((viewProj: Float32Array, invViewProj: Float32Array, eye: Vec3) => void) | null = null
    const setCameraListener = (fn: typeof onCamera) => {
        onCamera = fn
    }

    let lighting: Lighting = DEFAULT_LIGHTING

    /**
     * 빛 기준 viewProj. 카메라 주변 반지름 r 상자를 빛 방향에서 직교 투영한다. 1인칭이면 보는 방향 앞쪽(r × aheadRatio)에
     * 상자를 두어 섀도 맵을 알차게 쓴다. 상자 중심은 빛 기준 x·y 축에서 텍셀 크기 단위로 반올림해, 카메라가 움직여도 텍셀 격자가
     * 땅에 고정되게 한다(그렇지 않으면 그림자 가장자리의 계단이 매 프레임 다른 자리에 생겨 흔들린다)
     *
     * @param camera 카메라
     * @param r 상자 반지름(m)
     * @param aheadRatio 1인칭에서 앞쪽으로 둘 거리(r 의 배수)
     */
    const lightViewProj = (camera: Camera, r: number, aheadRatio: number) => {
        const eye = cameraEye(camera)
        let focus: Vec3 = eye
        if (isFpsCamera(camera)) {
            const f = fpsForward(camera)
            focus = [eye[0] + f[0] * r * aheadRatio, eye[1] + f[1] * r * aheadRatio, eye[2]]
        } else {
            focus = camera.target
        }
        const texel = (2 * r) / SHADOW_MAP_SIZE
        const fx = dot3(focus, LIGHT_X)
        const fy = dot3(focus, LIGHT_Y)
        const sx = Math.round(fx / texel) * texel - fx
        const sy = Math.round(fy / texel) * texel - fy
        focus = [
            focus[0] + LIGHT_X[0] * sx + LIGHT_Y[0] * sy,
            focus[1] + LIGHT_X[1] * sx + LIGHT_Y[1] * sy,
            focus[2] + LIGHT_X[2] * sx + LIGHT_Y[2] * sy,
        ]
        const lightEye: Vec3 = [focus[0] + LIGHT_Z[0] * r * 2, focus[1] + LIGHT_Z[1] * r * 2, focus[2] + LIGHT_Z[2] * r * 2]
        return multiply(ortho(-r, r, -r, r, 0.1, r * 4), lookAt(lightEye, focus, [0, 0, 1]))
    }

    /**
     * 조명(주변광·난반사·그림자·안개)을 바꾼다. 카메라가 있으면 빛 행렬도 다시 쓴다
     *
     * @param next 조명 설정
     */
    const lightingUpdater = (next: Lighting) => {
        lighting = next
        device.queue.writeBuffer(
            uniformBuffer,
            LIGHTING_OFFSET,
            new Float32Array([next.ambient, next.diffuse, next.shadows ? 1 : 0, next.fogDensity]),
        )
        device.queue.writeBuffer(uniformBuffer, HEMI_OFFSET, new Float32Array([next.hemisphere, 0, 0, 0]))
        writeSky()
        if (lastCamera) cameraUpdater(lastCamera)
    }
    const currentLighting = () => lighting
    /** 하늘의 태양 방향(그림자 빛의 방위각 + 테마의 고도). paletteUpdater 가 바꾼다 */
    let sunDir: Vec3 = sunDirection(60, [LIGHT_DIR[0], LIGHT_DIR[1]])
    const writeSky = () =>
        device.queue.writeBuffer(uniformBuffer, SKY_OFFSET, new Float32Array([...sunDir, lighting.sky ? 1 : 0]))
    const currentSun = () => sunDir
    lightingUpdater(DEFAULT_LIGHTING)

    /** 안개색(배경색)을 쓴다. 테마 전환 때 배경색과 함께 */
    const fogColorUpdater = ({ r, g, b }: { r: number; g: number; b: number }) => {
        device.queue.writeBuffer(uniformBuffer, FOG_COLOR_OFFSET, new Float32Array([r, g, b, 1]))
    }

    /**
     * 화면 가로/세로 비율을 바꾼다(캔버스 크기 변경). 카메라가 이미 있으면 같은 카메라로 투영을 다시 쓴다.
     *
     * @param next 새 비율(너비 / 높이)
     */
    const aspectUpdater = (next: number) => {
        if (next === aspect) return
        aspect = next
        if (lastCamera) cameraUpdater(lastCamera)
    }

    /**
     * 표고 색표(uniform offset STOPS_OFFSET)와 건물색(BUILDING_COLOR_OFFSET)을 쓴다. 테마 전환 때 부른다.
     * 셰이더·파이프라인은 그대로다.
     *
     * @param theme 색표 단계 STOP_COUNT 개(높이 오름차순)와 건물색을 가진 테마. 태양 고도는 디버그 설정(sun)이 있으면 그 값
     */
    const paletteUpdater = (theme: Pick<TerrainTheme, "stops" | "buildingColor" | "sunAltitude" | "ui">) => {
        lastTheme = theme
        device.queue.writeBuffer(uniformBuffer, STOPS_OFFSET, stopsToUniform(theme.stops))
        const { r, g, b } = hexToRgb(theme.buildingColor)
        device.queue.writeBuffer(uniformBuffer, BUILDING_COLOR_OFFSET, new Float32Array([r, g, b, 1]))
        // 조준점 건물 강조색: UI 강조색(accent, 라이트 #0f6cbd · 다크 #bae6fd)을 0.45 로 덮는다
        const accent = hexToRgb(theme.ui.accent)
        device.queue.writeBuffer(uniformBuffer, HIGHLIGHT_COLOR_OFFSET, new Float32Array([accent.r, accent.g, accent.b, 0.45]))
        sunDir = sunDirection(getDebug().sun ?? theme.sunAltitude, [LIGHT_DIR[0], LIGHT_DIR[1]])
        writeSky()
    }
    /** 마지막 테마. 디버그 설정이 바뀌면 같은 테마로 태양을 다시 쓴다(refreshPalette) */
    let lastTheme: Parameters<typeof paletteUpdater>[0] | null = null
    const refreshPalette = () => {
        if (lastTheme) paletteUpdater(lastTheme)
    }

    /**
     * 걸어 보기 스트리밍 도엽(walkTiles): 도엽 id → GPU 조각. 지형 조각은 계단형 파이프라인(면 법선, 법선 버퍼 없음)으로,
     * 건물은 건물 파이프라인으로 그린다. 나가면 streamClearUpdater 로 모두 비운다. 선택 범위도 같은 도엽으로 온다(1K 도엽 통일, 계획서 7절 L)
     */
    type TileBounds = { min: [number, number]; max: [number, number] }
    const streamTiles = new Map<string, { terrain: GpuChunk[]; buildings: GpuChunk[]; mode: TerrainMode; bounds: TileBounds | null }>()
    /**
     * 거리 거르기 반경(m). 둘러보기 중에만 켜진다(cullRadiusUpdater). 카메라 xy 에서 도엽 xy 범위까지의 거리가 이보다 멀면
     * 장면 pass 에서 빼고, 그림자 pass 는 캐스케이드 반경의 2배 밖을 뺀다(빛 상자가 카메라 앞쪽으로 치우쳐 있어 여유를 둔다).
     * 도엽 범위가 없는 조각(옛 경로)은 거르지 않는다
     */
    let cullRadius: number | null = null
    const cullRadiusUpdater = (radius: number | null) => {
        cullRadius = radius
    }
    /** 점(xy)에서 도엽 xy 범위까지의 거리(안이면 0) */
    const distanceToBounds = (eye: Vec3, b: TileBounds) => {
        const dx = Math.max(b.min[0] - eye[0], 0, eye[0] - b.max[0])
        const dy = Math.max(b.min[1] - eye[1], 0, eye[1] - b.max[1])
        return Math.hypot(dx, dy)
    }

    /**
     * 도엽 하나를 올리거나(이전 것은 교체) 뺀다(null).
     *
     * @param id 도엽 id
     * @param tile 지형 조각(계단형, 또는 법선이 있는 매끈한 면)과 건물 메쉬, 지형 표현 방식, 도엽 xy 범위(거리 거르기용). null 이면 뺀다
     */
    const streamTileUpdater = (
        id: string,
        tile: { terrain: MeshChunk[]; buildings: TinMesh | null; mode: TerrainMode; bounds?: TileBounds } | null,
    ) => {
        const prev = streamTiles.get(id)
        if (prev) {
            destroyChunks(prev.terrain)
            destroyChunks(prev.buildings)
            streamTiles.delete(id)
        }
        if (!tile) return
        if (tile.mode === "tin" && tile.terrain.some((c) => !c.normals)) throw new Error(`도엽 ${id}: 매끈한 면 조각에 법선이 없음`)
        const terrain = tile.terrain.map((c) => uploadChunk(`tile ${id}`, c))
        const buildings: GpuChunk[] = []
        if (tile.buildings) {
            const b = tile.buildings
            let indexStart = 0
            for (const c of splitMeshIntoChunks(b.positions, b.indices, undefined, device.limits.maxBufferSize)) {
                buildings.push(uploadChunk(`tile ${id} buildings`, c, indexStart))
                indexStart += c.indices.length
            }
        }
        streamTiles.set(id, { terrain, buildings, mode: tile.mode, bounds: tile.bounds ?? null })
    }
    /**
     * 표고 색 범위(uniform offset 64)를 쓴다. 도엽이 하나씩 올라오며 범위가 넓어질 때마다 다시 쓴다
     *
     * @param minZ 최저 표고(m)
     * @param maxZ 최고 표고(m)
     */
    const elevationRangeUpdater = (minZ: number, maxZ: number) => {
        device.queue.writeBuffer(uniformBuffer, 64, new Float32Array([minZ, maxZ]))
    }
    const streamClearUpdater = () => {
        for (const t of streamTiles.values()) {
            destroyChunks(t.terrain)
            destroyChunks(t.buildings)
        }
        streamTiles.clear()
    }
    /**
     * 이번 프레임에 그릴 (조각, 파이프라인) 목록: 스트리밍 도엽(거리 거르기 반경 안).
     *
     * @param radius 거리 거르기 반경(m). null 이면 모두 그린다
     */
    const collectDraws = (radius: number | null) => {
        const draws: { chunks: GpuChunk[]; set: ReturnType<typeof createPipelineSet> }[] = []
        const eye = radius !== null ? lastEye : null
        for (const t of streamTiles.values()) {
            if (eye && t.bounds && distanceToBounds(eye, t.bounds) > radius!) continue
            if (layerVisible.terrain && t.terrain.length > 0) draws.push({ chunks: t.terrain, set: pipelines[t.mode] })
            if (layerVisible.buildings && t.buildings.length > 0) draws.push({ chunks: t.buildings, set: pipelines.buildings })
        }
        return draws
    }

    /**
     * 섀도 맵을 뜨는 pass(캐스케이드 둘: 먼 250 m, 가까운 40 m). 그림자가 켜져 있을 때만, 보이는 조각을 빛 기준으로 깊이만
     * 그린다(정점 버퍼 0 만 바인딩).
     * 배경 pass 보다 먼저 실행한다
     *
     * @param encoder 이번 프레임의 command encoder
     */
    const shadowPass = (encoder: GPUCommandEncoder) => {
        if (!lighting.shadows) return
        const draws = collectDraws(cullRadius === null ? null : Math.min(cullRadius, lighting.shadowRadius * 2))
        for (const cascade of shadowCascades) {
            const pass = encoder.beginRenderPass({
                colorAttachments: [],
                depthStencilAttachment: { view: cascade.view, depthLoadOp: "clear", depthClearValue: 1, depthStoreOp: "store" },
            })
            pass.setPipeline(cascade.pipeline)
            pass.setBindGroup(0, cascade.bindGroup)
            for (const { chunks } of draws) {
                for (const c of chunks) {
                    pass.setVertexBuffer(0, c.vertexBuffer)
                    pass.setIndexBuffer(c.indexBuffer, "uint32")
                    pass.drawIndexed(c.indexCount)
                }
            }
            pass.end()
        }
    }

    /**
     * 장면을 그리는 pass. 배경 pass 가 비운 색·깊이 버퍼를 load 해서 그 위에 그린다.
     * 보이는 레이어마다 파이프라인을 바꾸고(지형은 도엽이 들고 온 모드, 건물은 전용), 조각마다 버퍼를
     * 바꿔 가며 drawIndexed 한다(tin 모드에서만 법선 버퍼 바인딩). 그릴 조각이 없으면 아무것도 하지 않는다.
     *
     * @param encoder 이번 프레임의 command encoder
     * @param target 그릴 색 텍스처 view(캔버스 또는 오프스크린 장면 텍스처)
     */
    const scenePass = (encoder: GPUCommandEncoder, target: GPUTextureView) => {
        const draws = collectDraws(cullRadius)
        if (draws.length === 0) return

        const pass = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: target,
                    loadOp: "load",
                    storeOp: "store",
                },
            ],
            depthStencilAttachment: {
                view: depth.view,
                depthLoadOp: "load",
                depthStoreOp: "store",
            },
        })
        for (const { chunks, set } of draws) {
            pass.setPipeline(set.pipeline)
            pass.setBindGroup(0, set.bindGroup)
            for (const c of chunks) {
                pass.setVertexBuffer(0, c.vertexBuffer)
                if (c.normalBuffer) pass.setVertexBuffer(1, c.normalBuffer)
                pass.setIndexBuffer(c.indexBuffer, "uint32")
                pass.drawIndexed(c.indexCount)
            }
        }
        // 건물 강조: 장면을 다 그린 뒤 그 건물의 삼각형 범위만 반투명으로 한 번 더(조각이 여럿이면 범위가 걸치는 조각마다 그 부분)
        if (highlights.length > 0 && layerVisible.buildings) {
            const set = pipelines.buildingHighlight
            pass.setPipeline(set.pipeline)
            pass.setBindGroup(0, set.bindGroup)
            for (const h of highlights) {
                const tile = streamTiles.get(h.tileId)
                if (!tile) continue
                const first = h.faceStart * 3
                const end = h.faceEnd * 3
                for (const c of tile.buildings) {
                    const from = Math.max(first, c.indexStart)
                    const to = Math.min(end, c.indexStart + c.indexCount)
                    if (from >= to) continue
                    pass.setVertexBuffer(0, c.vertexBuffer)
                    pass.setIndexBuffer(c.indexBuffer, "uint32")
                    pass.drawIndexed(to - from, 1, from - c.indexStart)
                }
            }
        }
        pass.end()
    }

    /** 강조할 건물들(고정한 건물 + 조준점 건물): 도엽 id 와 그 도엽 건물 메쉬 안 삼각형 범위 [faceStart, faceEnd) */
    let highlights: { tileId: string; faceStart: number; faceEnd: number }[] = []
    /**
     * 둘러보기 중 강조할 건물 목록을 바꾼다(TerrainViewCanvas 가 buildingPick 결과·고정 상태로 부른다). 다음 프레임부터 반영
     *
     * @param next 도엽 id 와 삼각형 범위(BuildingTable 의 faceBase[k] ~ 다음 세운 건물)들. 빈 배열이면 강조 없음
     */
    const highlightUpdater = (next: { tileId: string; faceStart: number; faceEnd: number }[]) => {
        highlights = next
    }

    return {
        scenePass,
        shadowPass,
        lightingUpdater,
        currentLighting,
        currentSun,
        setCameraListener,
        fogColorUpdater,
        streamTileUpdater,
        streamClearUpdater,
        elevationRangeUpdater,
        cullRadiusUpdater,
        highlightUpdater,
        layerVisibilityUpdater,
        cameraUpdater,
        aspectUpdater,
        paletteUpdater,
        refreshPalette,
    }
}

/**
 * 3D 지형 렌더러를 조립한다. (Doe 의 createAe12RenderFunctionAndUpdateFunctions 와 같은 구조)
 *
 * 1. initWebGPU 로 device·context 준비
 * 2. 캔버스 크기의 깊이 텍스처 생성
 * 3. 배경 pass, 장면 pass·updater 생성
 *
 * 캔버스 크기가 바뀌면 resizeUpdater 로 알린다. 색 텍스처는 WebGPU 가 canvas 속성 크기를 따라 다시 잡지만, 깊이 텍스처와
 * 투영 비율은 여기서 직접 다시 만들어야 한다.
 *
 * @param options.canvasId 대상 canvas 요소의 id
 * @param options.width 캔버스 실제 픽셀 너비(canvas width 속성과 같아야 한다)
 * @param options.height 캔버스 실제 픽셀 높이
 * @param options.backgroundColor 처음 배경색(0 ~ 1). backgroundUpdater 로 바꿀 수 있다
 * @param options.debug 처음 렌더 디버그 설정(태양 고도·AO 디버그 출력). debugUpdater 로 바꿀 수 있다. 운영은 생략
 * @returns render(한 프레임 그리기), updaters(streamTileUpdater, streamClearUpdater, elevationRangeUpdater, cullRadiusUpdater,
 *   layerVisibilityUpdater, cameraUpdater, paletteUpdater, lightingUpdater, backgroundUpdater, resizeUpdater, debugUpdater), destroy(device 해제)
 */
export const createTerrainRenderFunctionAndUpdateFunctions = async ({
    canvasId,
    width,
    height,
    backgroundColor,
    debug: initialDebug = {},
}: {
    canvasId: string
    width: number
    height: number
    backgroundColor: { r: number; g: number; b: number }
    debug?: RenderDebug
}) => {
    const { context, device, format } = await initWebGPU(canvasId)
    let debug = initialDebug

    /** 캔버스 픽셀 크기의 깊이 텍스처를 만든다(SSAO 가 읽으므로 TEXTURE_BINDING 도) */
    const createDepth = (w: number, h: number): DepthHolder => {
        const texture = device.createTexture({
            size: [w, h],
            format: DEPTH_FORMAT,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        })
        return { texture, view: texture.createView(), width: w, height: h }
    }
    const first = createDepth(width, height)
    // pass 들은 이 홀더를 붙들고 그릴 때마다 view 를 읽는다. 크기가 바뀌면 안의 텍스처만 바꿔 끼운다
    const depth: DepthHolder = { ...first }

    const background = { color: backgroundColor }
    const backgroundPass = renderBackgroundPassFactory(background, depth)
    const {
        scenePass,
        shadowPass,
        aspectUpdater,
        fogColorUpdater,
        currentLighting,
        currentSun,
        setCameraListener,
        refreshPalette,
        ...sceneUpdaters
    } = createTerrainDrawingPassAndUpdaters(device, format, depth, width / height, () => debug)
    fogColorUpdater(backgroundColor)
    // SSAO·외곽선(둘러보기): 오프스크린 장면 텍스처 + 합성 pass. 하늘 pass 는 장면 뒤 빈 픽셀을 채운다. 카메라가 바뀌면 같은 행렬을 받는다
    const ao = createAoPasses(device, format)
    ao.resize(width, height, depth.view)
    const sky = createSkyPass(device, format, DEPTH_FORMAT)
    sky.setSize(width, height)
    sky.setSun(currentSun())
    setCameraListener((viewProj, invViewProj, eye) => {
        ao.setCamera(viewProj, invViewProj, eye)
        sky.setCamera(invViewProj, eye)
    })
    /** 색표·건물색·태양 고도(테마)를 바꾼다. 하늘 pass 에도 태양을 알린다 */
    const paletteUpdater = (theme: Parameters<typeof sceneUpdaters.paletteUpdater>[0]) => {
        sceneUpdaters.paletteUpdater(theme)
        sky.setSun(currentSun())
    }
    /** 배경색(= 안개색)을 바꾼다(다음 프레임부터). 테마 전환용 */
    const backgroundUpdater = (color: { r: number; g: number; b: number }) => {
        background.color = color
        fogColorUpdater(color)
    }
    /** 렌더 디버그 설정을 바꾼다(태양 고도는 즉시 다시 쓰고, AO 디버그 출력은 다음 프레임부터). 조명 항목은 호출자가 lightingUpdater 로 */
    const debugUpdater = (next: RenderDebug) => {
        debug = next
        refreshPalette()
        sky.setSun(currentSun())
    }

    /**
     * 캔버스 픽셀 크기가 바뀌었을 때. 깊이 텍스처를 새 크기로 다시 만들고(이전 것은 해제) 투영 비율을 갱신한다.
     * canvas 의 width·height 속성을 먼저 바꾼 뒤 불러야 색 텍스처와 깊이 텍스처 크기가 맞는다. 같은 크기면 아무것도 안 한다
     *
     * @param w 캔버스 실제 픽셀 너비
     * @param h 캔버스 실제 픽셀 높이
     */
    const resizeUpdater = (w: number, h: number) => {
        if (w === depth.width && h === depth.height) return
        if (w <= 0 || h <= 0) return
        const next = createDepth(w, h)
        depth.texture.destroy()
        Object.assign(depth, next)
        ao.resize(w, h, depth.view)
        sky.setSize(w, h)
        aspectUpdater(w / h)
    }

    /**
     * 한 프레임을 그린다: 섀도 pass(그림자가 켜져 있을 때) → 배경 pass → 장면 pass → (하늘이 켜져 있으면) 하늘 pass →
     * (AO 나 외곽선이 켜져 있으면) SSAO·흐림·합성. 합성이 있으면 배경·장면·하늘은 오프스크린 텍스처에 그리고 합성 pass 가 캔버스에 쓴다
     */
    const render = () => {
        const encoder = device.createCommandEncoder()
        const canvasView = context.getCurrentTexture().createView()
        const lighting = currentLighting()
        const aoDebug = debug.aodebug ?? 0
        const offscreen = lighting.ao || lighting.edge > 0 || aoDebug !== 0 ? ao.sceneView() : null
        const target = offscreen ?? canvasView
        shadowPass(encoder)
        backgroundPass(encoder, target)
        scenePass(encoder, target)
        if (lighting.sky) sky.run(encoder, target, depth.view)
        if (offscreen) {
            ao.run(encoder, canvasView, { ao: lighting.ao, edge: lighting.edge, fogDensity: lighting.fogDensity, debug: aoDebug })
        }
        device.queue.submit([encoder.finish()])
    }

    const updaters = { ...sceneUpdaters, paletteUpdater, backgroundUpdater, resizeUpdater, debugUpdater }

    /** GPU device 와 그에 속한 버퍼·텍스처를 모두 해제한다. 컴포넌트 언마운트 때 호출 */
    const destroy = () => {
        ao.destroy()
        sky.destroy()
        device.destroy()
    }

    return { render, updaters, destroy }
}
