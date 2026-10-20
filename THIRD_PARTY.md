# 서드파티 고지 (Third-party notices)

> 이 문서는 Claude(Anthropic 의 AI)가 `package-lock.json` 과 `node_modules` 의 라이선스 필드를 읽고 작성했고 @nanangqq 가 검토했다.

이 저장소의 코드는 MIT 라이선스([`LICENSE`](LICENSE))로 배포한다. 아래는 번들에 들어가거나 빌드·검증에 쓰이는 외부 코드와 그 라이선스다.
버전은 `package-lock.json` 기준(2026-10-20). 라이선스 전문은 각 패키지의 `node_modules/<이름>/LICENSE*` 에 있다.

## 1. 번들에 들어가는 런타임 의존성 (Runtime dependencies)

| 패키지 | 버전 | 라이선스 | 용도 |
| --- | --- | --- | --- |
| react, react-dom | 19.3.0 | MIT | UI |
| @fluentui/react-components, @fluentui/react-icons | 9.74.9, 2.0.343 | MIT | UI 컨트롤·아이콘 |
| styled-components, styled-reset | 6.5.3, 5.0.0 | MIT | 스타일 |
| ol (OpenLayers) | 10.10.0 | BSD-2-Clause | 2D 지도, 범위 선택, 바탕 지도 타일 |
| proj4 | 2.22.0 | MIT | 좌표 변환(EPSG:3857 ↔ 5179 등) |
| delaunator | 5.1.0 | ISC | Delaunay 삼각분할 |
| @kninnug/constrainautor | 4.1.0 | ISC | 제약 Delaunay(지형 TIN) |
| earcut | 3.2.4 | ISC | 다각형 삼각분할(건물·도로 면) |
| openskp | 1.3.0 | MIT | SKP 내보내기. `patches/openskp+1.3.0.patch` 로 수정해 쓴다(아래 3절) |
| rhino3dm | 8.35.0 | MIT | 3DM 내보내기. 빌드가 `rhino3dm.min.js`·`rhino3dm.wasm` 을 `dist/export/` 로 복사한다 |
| firebase | 12.19.0 | Apache-2.0 | 초기 스캐폴딩(`src/fb.ts`). 앱이 호출하지 않는다 |

## 2. 복사해 둔 코드 (Vendored code)

| 출처 | 라이선스 | 위치 |
| --- | --- | --- |
| liquidglass (`@ybouane/liquidglass` 1.0.3, https://github.com/ybouane/liquidglass) | MIT, Copyright (c) ybouane | `src/vendor/liquidglass/`. 출처·복사 이유·라이선스는 그 폴더의 `LICENSE.md` |
| Phosphor Icons `mouse-left-click-fill`, `mouse-right-click-fill` (https://github.com/phosphor-icons/core) | MIT, Copyright (c) 2023 Phosphor Icons | `src/ui/OrbitHud.tsx` 의 SVG path 데이터 2개 |

## 3. 패치 (Patches)

`patches/openskp+1.3.0.patch` — `npm install` 의 `postinstall`(patch-package)이 `node_modules/openskp` 에 적용한다. MIT 코드의 파생물이며 같은 조건으로 배포한다. 수정 내용은 패치 파일 참조.

## 4. 개발·검증에만 쓰는 의존성 (Development only)

| 패키지 | 버전 | 라이선스 | 용도 |
| --- | --- | --- | --- |
| esbuild | 0.28.2 | MIT | 번들 |
| typescript | 6.0.3 | Apache-2.0 | 타입 검사(`npm run typecheck`) |
| @webgpu/types | 0.1.74 | BSD-3-Clause | WebGPU 타입 |
| @types/react, @types/react-dom, @types/delaunator | 19.3.0, 19.3.0, 5.0.3 | MIT | 타입 |
| patch-package | 8.0.1 | MIT | 3절 패치 적용 |
| playwright | 1.64.0 | Apache-2.0 | `scripts/render-check.mjs` 가 설치된 Chrome 을 띄우는 데만 쓴다 |
| pixelmatch, pngjs | 8.0.0, 7.0.0 | ISC, MIT | 캡처 비교 |
| firebase-tools | 15.30.1 | MIT | Firebase Hosting 배포(`npm run deploy`). GitHub Pages 배포에는 쓰지 않는다 |

## 5. 지도 타일·검색 API (Map tiles and search)

코드가 아니라 서비스다. 각 서비스의 약관을 따르고 화면에 저작권을 표시한다(`src/basemap.ts`, `src/vworld.ts`).

- Stadia Maps — Alidade Smooth / Smooth Dark. © Stadia Maps · © OpenMapTiles · © OpenStreetMap contributors
- CARTO — Positron / Dark Matter. © OpenStreetMap contributors · © CARTO
- VWorld(브이월드) 통합 검색 API — 주소·장소 검색

## 6. 데이터 (Data)

지형·건물·도로 데이터는 한국 공공데이터를 가공한 것이며 코드 라이선스(MIT)와 별개다. 원자료별 출처와 이용 조건(공공누리 제1유형, CC BY 등)은
앱의 출처 페이지(`#/attribution`)와 `src/attribution.ts` 에 있다.
