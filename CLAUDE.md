# PoliceLink — 작업 안내 (Claude Code용)

| 항목 | 위치 |
|---|---|
| GitHub (공개) | https://github.com/bandit1397/PoliceLink-Integrated-Emergency-Support-Platform-for-Police |
| 기반 프로젝트 | `Desktop/emergency-ntfy` (환자 수용 요청). **그 폴더는 수정하지 말 것** — 참고 · 복사만 |
| 파일 | `Code.gs`(서버) · `Index.html`(화면) · `appsscript.json` · `README.md`(사용자 안내) · `docs/설계검토.md` |
| Apps Script 프로젝트 · 웹앱 URL | 아직 없음 (사용자가 만들면 여기에 적기) |

## 핵심 구조

- 데이터: Google 스프레드시트 7시트 (`SHEETS` 상수). 모든 칸 텍스트, 시간 `yyyy-MM-dd HH:mm:ss` KST. 읽기는 CacheService 30초 캐시, 쓰기 때 무효화, 쓰기는 `withLock_` 안에서 `rows_(name, true)`
- 스크립트 속성: `SHEET_ID` · `WEBAPP_URL` (자동). 비밀값은 저장소에 쓰지 않음
- 직원: `login(아이디, PIN)` → CacheService `sess_<token>` 6시간. 역할 admin · dispatcher · officer
- 수신자: 개인 링크 `?r=<token>` (RECIPIENTS.token). 토픽 `pl-` + 20자, 수신자마다 하나
- ntfy: 서버는 메시지 내용만 만들고 **브라우저가 ntfy.sh 로 POST** (Apps Script → ntfy.sh 차단). `sequence_id` = 요청번호. **click 넣지 말 것** (계속 울리기가 안 멈춤)
- 재알림: 상황판(admin/dispatcher) 브라우저가 1분마다 `pendingRealerts`
- 외부 기관에는 `detail`(내부 메모) · `requesterId` 를 보내지 않음 (`publicRequest_`, `CONFIG.TYPES.*.internal`)

## 코드를 바꿀 때

1. 수정 → 문법 확인: `.gs` 는 node 가 확장자를 거부하므로 `.js` 로 복사해서 `node --check`
2. 서버 흐름 시험: `node tests/test_server.js` (모의 SpreadsheetApp · CacheService 등, `ALL TESTS PASSED` 확인)
3. 커밋: 이 PC 는 git user 설정이 없음 → `git -c user.name=bandit1397 -c user.email=<기존 커밋과 같은 이메일> commit …`
4. Apps Script 편집기 반영 · **새 버전 배포는 사용자가 직접**

## 상태 (2026-11-15)

- 1차 시험판 작성, 서버 로직은 모의 환경 시험 통과. **실제 Apps Script · 휴대폰 시험은 아직 안 함**
