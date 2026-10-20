# 아수라발발타 (asrbbt_web)

[English](README.en.md)

> 이 문서는 Claude(Anthropic 의 AI)가 저장소 내용을 읽고 작성했고 @nanangqq 가 검토했다. 이 저장소의 공개용 문서는 사람이 직접 쓴 것이 아니면 이렇게 표기한다.

브라우저에서 한국의 지형·건물·도로를 3D 로 보고 내보내는 WebGPU 뷰어다. 지도에서 범위를 고르면 그 안의 1K 도엽을 받아 지형 TIN 을 만들고,
건물과 도로를 얹어 그린다. 1인칭으로 둘러볼 수 있고, STL·SKP·3DM·GLB 로 내보낼 수 있다. 서버 없이 정적 파일만으로 동작한다.

## 기능

| 영역 | 내용 |
| --- | --- |
| 지도 | OpenLayers. Stadia / CARTO 바탕 지도 전환, 라이트·다크, 주소·장소 검색(VWorld), 현재 위치 |
| 범위 선택 | 클릭·이동·클릭(터치는 끌기), 1K 도엽 격자, 도엽 수에 따른 한도 사전 검사 |
| 지형 | R2 정적 파일(TTP)에서 받은 점·선을 브라우저에서 제약 Delaunay 로 삼각분할(mm 정수). 매끈한 TIN 과 계단형(등고선 모형) 두 모드, 절대 표고 색표 |
| 건물 | 건물 도형·용도·구조·높이·층수·이름. 건물 표(속성 13개), 조준점 건물 HUD |
| 도로 | 차도 면을 지형 삼각형으로 잘라 얹기, 교량 선 보간, 터널 숨김 |
| 3D | 자체 WebGPU 렌더러. pan·orbit·zoom, 그림자 캐스케이드, SSAO, 절차적 하늘, 외곽선. WebGPU 미지원 브라우저 안내 |
| 둘러보기 | 1인칭 이동, 도엽 스트리밍, 반경 거르기, 메모리 관리 |
| 내보내기 | STL, SKP(openskp + 패치), 3DM(rhino3dm), GLB. 판 쌓기 지형, 건물마다 그룹/솔리드/노드, 출처 메타데이터 |
| UI | Fluent UI 컨트롤, 모바일 레이아웃, 리퀴드 글래스(Chromium) |

## 요구 사항

- WebGPU 를 지원하는 브라우저. Chrome 최신 버전에서 확인했다. 미지원이면 앱이 안내 화면을 보인다.
- Node.js 22 (`v22.21` 에서 확인), npm.

## 실행

```bash
git clone https://github.com/asura-balbalta/asura-balbalta.github.io.git
cd asura-balbalta.github.io
npm install            # postinstall 이 patches/ 의 openskp 패치를 적용한다
npm run build          # esbuild → dist/ (prebuild 가 rhino3dm wasm 을 dist/export/ 로 복사)
npx serve dist -l 3000 # http://localhost:3000
```

개발 중에는 `npm run dev`(esbuild watch) 를 따로 띄워 두고 같은 `serve` 로 본다. 타입 검사는 `npm run typecheck`(TypeScript 6.0.3 고정).

지형·건물·도로 데이터는 공개 버킷 `https://layers.asrbbt.world` 에서 받으며 `localhost` 에서도 CORS 가 허용돼 있다. 따라서 클론만 하면 운영본과 같은 데이터로 동작한다.

## 데이터와 출처

| 레이어 | 원자료 | 이용 조건 |
| --- | --- | --- |
| 지형 | 국토지리정보원 국가기본도(등고선·표고점·하천경계·도엽인덱스) | 공공누리 제1유형(출처 표시) |
| 건물 | 브이월드 GIS건물통합정보 + 건축물대장 표제부·총괄표제부(높이·층수·이름 보충) | CC BY 4.0 · 이용허락범위 제한 없음 |
| 도로 | 국가기본도 차도경계면·도로중심선 | 공공누리 제1유형(출처 표시) |

원자료는 모두 "출처만 표시하면 상업 이용·가공 가능" 조건이다. 전체 표시문과 링크는 앱의 출처 페이지(`#/attribution`)와 `src/attribution.ts` 에 있고, 내보낸 파일의 메타데이터에도 들어간다.
원자료를 1K 도엽 단위 정적 파일(TTP·BFP·RDS1)로 가공하는 서버 코드는 이 저장소에 없다. `src/terrainData.ts` 의 `TERRAIN_API`(`localhost:8000`)는 그 서버를 로컬에서 돌릴 때만 쓰는 개발 경로다.

## 키와 외부 서비스

정적 SPA 라 키가 번들에 그대로 들어가며, 각 서비스에서 허용 도메인으로 묶어 관리한다. 포크해서 다른 도메인에 올리려면 자기 키로 바꾸고 그 도메인을 등록해야 한다.

| 파일 | 상수 | 서비스 |
| --- | --- | --- |
| `src/config.ts` | `VWORLD_KEY` | VWorld 검색 API(주소·장소). 비어 있으면 검색 패널이 안내만 보인다 |
| `src/basemap.ts` | `CARTO_API_KEY` | CARTO 바탕 지도 타일. 없으면 타일에 워터마크 |
| `src/basemap.ts` | — | Stadia Maps 는 코드에 키가 없다. 무료 플랜은 비상업·월 크레딧 한도(Stadia 약관) |
| `src/fb.ts` | Firebase 웹 설정 | 초기 스캐폴딩. 앱이 호출하지 않으며 `firebase.json`·`.firebaserc` 는 비공개 작업 저장소의 Firebase Hosting 배포용이다 |

## 디버그 페이지와 검증 스크립트

- `#/debug/walk?bbox=…&spawn=…&yaw=…&pitch=…`: 범위·자리·각도와 효과 스위치(`ao=0`, `shadow=0`, `sky=0`, `roads=0` …)를 주소로 고정해 같은 장면을 다시 띄운다. 파라미터 표는 [`src/webgpu/VERIFY.md`](src/webgpu/VERIFY.md) 4절.
- `#/debug/app?gpu=0&glass=0`: WebGPU 미지원·리퀴드 글래스 꺼짐 같은 브라우저 환경을 흉내낸다.
- `npm run render-check`: 설치된 Chrome 으로 기준 장면을 캡처해 지표(`index.json`)와 PNG 를 남기고 전후를 비교한다. `npm run band-check`(도엽 경계 띠 측정), `scripts/export-check.mjs`(내보내기 파일 생성·되읽기 비교).
- 렌더링을 고칠 때의 절차(재현 → 좁히기 → 수치 → 수정, 전후 비교)는 `src/webgpu/VERIFY.md`.

## 이 저장소에 대해

- 개발은 비공개 작업 저장소에서 하고, 커밋을 한 개씩 이 저장소에 재현해 올린다. author 날짜는 원래 작업한 시점이고 committer 날짜는 옮긴 시점이다.
- 커밋 메시지와 주석에 보이는 `docs/…`, "계획서 N절", "보고서" 는 비공개 저장소의 작업 기록(계획·측정·캡처)을 가리킨다. 이 저장소에는 없다. 코드 주석의 `by @nanangqq` 는 그 결정·확인을 한 사람이다.
- 커밋 메시지는 한국어, `type(scope): 한 문장` 꼴이다.
- 배포는 `v*` 태그를 push 하면 GitHub Actions 가 빌드해 GitHub Pages 에 올린다(`.github/workflows/pages.yml`). main push 로는 배포되지 않는다.
- 이슈는 환영한다. PR 은 비공개 저장소에 손으로 옮겨 반영한 뒤 재현 커밋으로 올라오므로 머지 커밋이 아니라 같은 내용의 커밋으로 반영된다.

## 라이선스

코드는 [MIT](LICENSE). 서드파티 코드와 라이선스는 [`THIRD_PARTY.md`](THIRD_PARTY.md). 데이터는 위 "데이터와 출처" 의 각 조건을 따른다.
