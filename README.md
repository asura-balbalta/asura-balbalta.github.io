# 아수라발발타 (asrbbt_web)

[English](README.en.md)

> 이 문서는 Claude(Anthropic 의 AI)가 저장소 내용을 읽고 작성했고 @nanangqq 가 검토했습니다. 이 저장소의 공개용 문서는 사람이 직접 쓴 것이 아니면 이렇게 표기합니다.

한국의 지형·건물·도로·물·산림·녹지를 브라우저에서 3D 로 보고 내보낼 수 있는 WebGPU 뷰어입니다. 지도에서 범위를 고르면 그 안의 1K 도엽을 받아 지형 TIN 을 만들고,
그 위에 건물·도로·물을 얹고 산림·녹지를 지형 면에 칠해 보여 줍니다. 1인칭으로 둘러볼 수 있고, STL·SKP·3DM·GLB 파일로 내보낼 수 있습니다. 별도 서버 없이 정적 파일만으로 동작합니다.

서비스의 본 주소는 **<https://asrbbt.world>** 입니다. 이 저장소는 두 가지 용도로 공개합니다.

- **로컬 실행**: 코드를 받아 그대로 실행하거나, 원하는 대로 고쳐서 쓸 수 있습니다(아래 "실행").
- **이전 버전의 기록**: 서비스가 바뀌어 온 과정을 커밋 이력으로 남깁니다. 태그를 붙인 버전은 그 시점의 앱을 `https://asura-balbalta.github.io/<태그>/`(예: `/v0.0.1/`)에서 열어 볼 수 있습니다.

## 기능

| 영역 | 내용 |
| --- | --- |
| 지도 | OpenLayers. Stadia / CARTO 바탕 지도 전환, 라이트·다크, 주소·장소 검색(VWorld), 현재 위치 |
| 범위 선택 | 클릭·이동·클릭으로 범위 지정(터치는 끌기), 1K 도엽 격자, 도엽 수 한도 사전 검사 |
| 지형 | R2 정적 파일(TTP)에서 받은 점·선을 브라우저에서 제약 Delaunay 로 삼각분할(mm 정수 좌표). 매끈한 TIN 과 계단형(등고선 모형) 두 가지 모드, 절대 표고 색표 |
| 건물 | 건물 도형과 용도·구조·높이·층수·이름. 건물 표(속성 13개), 조준점 건물 HUD |
| 도로 | 차도 면을 지형 삼각형에 맞춰 잘라 얹기, 교량·고가는 중심선 양끝 높이를 보간, 터널은 숨김 |
| 물 | 실폭하천·호소의 수면을 별도 평면으로 투명하게 표시(높이는 둘레 지형 높이의 중앙값, 도엽 경계에서 맞춤), 하천선은 띠로 표시 |
| 산림 | 임상도 폴리곤을 1K 도엽마다 1 m 격자 마스크로 만들어 지형 바탕색을 임상별 색으로 칠합니다. 내보내기에는 넣지 않습니다 |
| 녹지 | OpenStreetMap 녹지 태그를 6개 분류로 묶어 지형 면을 분류별로 나눠 칠합니다 |
| 3D | 자체 WebGPU 렌더러. pan·orbit·zoom, 그림자 캐스케이드, SSAO, 절차적 하늘, 외곽선. WebGPU 미지원 브라우저에는 안내 화면 |
| 둘러보기 | 1인칭 이동, 도엽 스트리밍, 보이는 거리 설정(2·3·5 km), 메모리 관리(개수 상한 LRU 캐시) |
| 내보내기 | STL, SKP(openskp + 패치), 3DM(rhino3dm), GLB. 판 쌓기 지형, 건물마다 그룹/솔리드/노드, 도로·물·녹지 포함(산림 제외), 출처 메타데이터 |
| UI | Fluent UI 컨트롤, 모바일 레이아웃, 리퀴드 글래스(Chromium) |

## 요구 사항

- WebGPU 를 지원하는 브라우저가 필요합니다. Chrome 최신 버전에서 확인했습니다. 지원하지 않는 브라우저에서는 앱이 안내 화면을 보여 줍니다.
- Node.js 22(`v22.21` 에서 확인)와 npm 이 필요합니다.

## 실행

```bash
git clone https://github.com/asura-balbalta/asura-balbalta.github.io.git
cd asura-balbalta.github.io
npm install            # postinstall 이 patches/ 의 openskp 패치를 적용합니다
npm run build          # esbuild → dist/ (prebuild 가 rhino3dm wasm 을 dist/export/ 로 복사합니다)
npx serve dist -l 3000 # http://localhost:3000
```

개발할 때는 `npm run dev`(esbuild watch)를 따로 띄워 두고 같은 `serve` 로 확인합니다. 타입 검사는 `npm run typecheck` 입니다(TypeScript 6.0.3 고정).

레이어 데이터는 공개 버킷 `https://layers.asrbbt.world` 에서 받습니다. `localhost` 에서도 CORS 가 허용돼 있어서, 저장소를 클론해 빌드하면 운영본과 같은 데이터로 동작합니다.

## 데이터와 출처

| 레이어 | 원자료 | 이용 조건 |
| --- | --- | --- |
| 지형 | 국토지리정보원 국가기본도(등고선·표고점·하천경계·도엽인덱스) | 공공누리 제1유형(출처 표시) |
| 건물 | 브이월드 GIS건물통합정보 + 건축물대장 표제부·총괄표제부(높이·층수·이름 보충) | CC BY 4.0 · 이용허락범위 제한 없음 |
| 도로 | 국가기본도 차도경계면·도로중심선 | 공공누리 제1유형(출처 표시) |
| 물 | 국가기본도 실폭하천·호소·하천중심선 | 공공누리 제1유형(출처 표시) |
| 산림 | 산림청 임상도(1:5000), 브이월드 데이터마켓 | CC BY-NC-ND(저작자표시·비영리·변경금지). 원자료를 고치지 않고 그대로 쓰며 내보내기에는 넣지 않습니다 |
| 녹지 | OpenStreetMap(Geofabrik 추출본) | ODbL 1.0 |

지형·건물·도로·물의 원자료는 출처만 표시하면 상업적 이용과 가공이 가능한 조건입니다. 산림(CC BY-NC-ND)과 녹지(ODbL 1.0)는 조건이 다르므로, 포크해서 쓰거나 배포할 때는 레이어별 조건을 따로 확인해 주세요. 전체 표시문과 링크는 앱의 출처 페이지(`#/attribution`)와 `src/attribution.ts` 에 있고, 내보낸 파일의 메타데이터에도 들어갑니다.

원자료를 1K 도엽 단위 정적 파일(TTP·BFP·RDS1 등)로 가공하는 서버 코드는 이 저장소에 없습니다. `src/terrainData.ts` 의 `TERRAIN_API`(`localhost:8000`)는 그 서버를 로컬에서 돌릴 때만 쓰는 개발용 경로입니다.

## 키와 외부 서비스

정적 SPA 라서 키가 번들에 그대로 들어갑니다. 대신 각 서비스에 허용 도메인을 등록해 관리합니다. 포크해서 다른 도메인에 올리려면 키를 본인 것으로 바꾸고 그 도메인을 등록해야 합니다.

| 파일 | 상수 | 서비스 |
| --- | --- | --- |
| `src/config.ts` | `VWORLD_KEY` | VWorld 검색 API(주소·장소). 비어 있으면 검색 패널에 안내만 나옵니다 |
| `src/basemap.ts` | `CARTO_API_KEY` | CARTO 바탕 지도 타일. 키가 없으면 타일에 워터마크가 찍힙니다 |
| `src/basemap.ts` | — | Stadia Maps 는 코드에 키가 없습니다. 무료 플랜은 비상업용이고 월 크레딧 한도가 있습니다(Stadia 약관) |
| `src/fb.ts` | Firebase 웹 설정 | 초기 스캐폴딩입니다. 앱이 호출하지 않으며, `firebase.json`·`.firebaserc` 는 비공개 작업 저장소의 Firebase Hosting 배포용입니다 |

## 디버그 페이지와 검증 스크립트

- `#/debug/walk?bbox=…&spawn=…&yaw=…&pitch=…`: 범위·자리·각도와 효과 스위치(`ao=0`, `shadow=0`, `sky=0`, `roads=0` …)를 주소로 고정해 같은 장면을 다시 띄울 수 있습니다. 파라미터 표는 [`src/webgpu/VERIFY.md`](src/webgpu/VERIFY.md) 4절에 있습니다.
- `#/debug/app?gpu=0&glass=0`: WebGPU 미지원, 리퀴드 글래스 꺼짐 같은 브라우저 환경을 흉내 냅니다.
- `npm run render-check`: 설치된 Chrome 으로 기준 장면을 캡처해 지표(`index.json`)와 PNG 를 남기고 전후를 비교합니다. 그 밖에 `npm run band-check`(도엽 경계 띠 측정)와 `scripts/export-check.mjs`(내보내기 파일 생성·되읽기 비교)가 있습니다.
- `npm run verify`: git diff 로 바뀐 파일을 분류해 필요한 검증만 골라 돌립니다. 1겹은 도엽 출력 골든 비교입니다(`npm run tile-golden`, 실제 워커를 Node 에서 돌려 바이트 단위로 비교). 2겹은 헤드리스 검사로, 브라우저 없이 Dawn 으로 같은 장면을 그려 기준과 비교합니다(`scripts/render-headless.mjs`). `-- --full` 을 붙이면 브라우저 캡처까지 하고, `-- --refresh-baseline` 은 기준을 다시 만듭니다. 기준과 받아 둔 자료는 `docs/render-checks/`(git 제외, 기계마다 따로)에 생깁니다.
- 헤드리스 검사는 선택 설치입니다: `npm --prefix scripts/headless install`(npm `webgpu`). 설치하지 않으면 `verify` 가 설치 명령을 알려 주고 그 단계를 건너뜁니다. `npm run perf-check` 는 디버그 훅으로 브라우저 시간을 잽니다.
- 렌더링을 고칠 때의 절차(재현 → 좁히기 → 수치 → 수정, 전후 비교)와 검증 선택 규칙은 `src/webgpu/VERIFY.md` 에 있습니다.

## 이 저장소에 대해

- 개발은 비공개 작업 저장소에서 하고, 커밋을 하나씩 이 저장소에 재현해 올립니다. author 날짜는 원래 작업한 시점이고 committer 날짜는 옮긴 시점입니다.
- 커밋 메시지와 주석에 나오는 `docs/…`, "계획서 N절", "보고서" 는 비공개 저장소의 작업 기록(계획·측정·캡처)을 가리키며, 이 저장소에는 없습니다. 코드 주석의 `by @nanangqq` 는 그 결정이나 확인을 한 사람을 뜻합니다.
- 커밋 메시지는 한국어로, `type(scope): 한 문장` 꼴로 씁니다.
- `v*` 태그를 push 하면 GitHub Actions 가 빌드해 GitHub Pages 에 배포합니다(`.github/workflows/pages.yml`). main 에 push 하는 것만으로는 배포되지 않습니다.
- 배포본은 태그마다 경로가 따로 있습니다. `/v0.0.1/` 처럼 태그 이름이 그 버전의 앱 주소이고, `/latest/` 는 가장 높은 버전으로 넘어갑니다. 배포할 때마다 모든 `v*` 태그를 다시 빌드해 함께 올립니다(`.github/scripts/build-site.mjs`).
- 사이트 루트(`/`)는 이 문서입니다(`/readme.html` 과 같고, 영어는 `/readme.en.html`). 서드파티 고지는 `/third-party.html` 에 있습니다(`.github/scripts/render-docs.mjs` 가 변환합니다).
- 이슈는 언제든 환영합니다. PR 은 비공개 저장소에 손으로 옮겨 반영한 뒤 재현 커밋으로 올라옵니다. 그래서 머지 커밋이 아니라 같은 내용의 새 커밋으로 반영됩니다.

## 라이선스

코드는 [MIT](LICENSE) 라이선스입니다. 서드파티 코드와 라이선스는 [`THIRD_PARTY.md`](THIRD_PARTY.md)에 정리했습니다. 데이터는 위 "데이터와 출처" 의 레이어별 조건을 따릅니다.
