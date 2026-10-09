# liquidglass

- 출처: https://github.com/ybouane/liquidglass (npm `@ybouane/liquidglass` 1.0.3)
- 라이선스: MIT (Copyright (c) ybouane)
- `index.js` 는 패키지의 `dist/index.js` 를 그대로 복사한 것(html-to-image 가 묶여 있어 의존성 없음).
- npm 의존성으로 두지 않는 이유: 패키지의 `postinstall` 이 `patch-package` 를 부르는데 그 명령이 함께 설치되지 않아
  `npm install` 이 실패한다. 번들 하나라 복사해 두는 쪽이 안전하다. 새 버전으로 바꿀 때는 같은 파일을 다시 복사하고
  `index.d.ts` 의 선언이 맞는지 본다.
