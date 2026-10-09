/**
 * 외부 서비스 키. 정적 SPA 라 배포본에 그대로 들어가므로, 키는 서비스 쪽에서 허용 도메인으로 묶는다.
 *
 * VWorld 검색 인증키(https://www.vworld.kr → 오픈API → 인증키 발급). 허용 도메인에 asrbbt-9f3a9.web.app, 미리보기 채널,
 * 개발용 localhost 를 등록해야 동작한다. 비어 있으면 주소 검색 패널이 "검색 키가 설정되지 않았습니다" 를 보인다
 */
export const VWORLD_KEY = "DA2058A7-F489-4F5B-94FC-C492296D88EA"
