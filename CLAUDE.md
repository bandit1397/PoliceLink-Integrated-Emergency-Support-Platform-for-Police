# PoliceLink — 작업 안내 (Claude Code용)

| 항목 | 위치 |
|---|---|
| GitHub (공개) | https://github.com/bandit1397/PoliceLink-Integrated-Emergency-Support-Platform-for-Police |
| 기반 프로젝트 | `Desktop/emergency-ntfy` (환자 수용 요청). **그 폴더는 수정하지 말 것** — 참고 · 복사만 |
| 파일 | `Code.gs`(서버) · `Index.html`(화면) · `appsscript.json` · `README.md`(사용자 안내) · `docs/설계검토.md` |
| Apps Script 프로젝트 "PoliceLink" | https://script.google.com/home/projects/1OhwTR9Aja90AILQ3bISaVO-mgcL43OoWEa50YnFzCeA8fsjsLi-_5rg9/edit |
| 웹앱 (/exec, 같은 주소 유지) | https://script.google.com/macros/s/AKfycbx7UhxhjwnyxErO3oBARbPh4dgB-CpDJA8Hz4k2uaULFHXmWIHvQ-GNZA8O6kiwEwUcIg/exec |
| 시험 계정 PIN · 시트 주소 | `accounts.local.txt` (git 제외, 저장소에 쓰지 말 것) |

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

- 1차 시험판 작성, 서버 로직은 모의 환경 시험 통과
- Apps Script 배포 완료: 편집기에 GitHub `main` 의 Code.gs · Index.html 붙여넣기 → `setupDemo` 실행(권한 승인, 시트 · 계정 3개 · 가상 수신자 12곳) → 웹앱 버전 1 (실행: 나, 액세스: 모든 사용자) → /exec 열어 로그인 화면 확인 (WEBAPP_URL 저장됨)
- 편집기 반영 방법: 편집기 페이지에서 `monaco.editor.getModels()` 에 raw.githubusercontent.com 내용을 넣고 Ctrl+S (clasp 없음)
- 버전 2 (2026-11-15 12:36, 커밋 `9ebf291`): 외부 기관 화면에 요청 경찰관 이름 대신 소속 (`orgsByUser_`). 편집기가 이전 커밋과 같은지 확인 후 교체 → 배포 관리 → 새 버전
- 버전 3 (2026-11-15 14:13, 커밋 `405be0e`): 관리자 수신자 화면 = 유형별 순번 목록 · ＋ 추가(`nextRecipientSeq`) · 삭제(`deleteRecipient`, active=D 소프트 삭제 · 토큰 교체 · 번호 재사용 안 함). Code.gs · Index.html 둘 다 교체
  - 배포 메뉴는 창 크기에 따라 위치가 바뀜 → 좌표 대신 find 로 '배포 관리' 를 찾아 누를 것 (한 번 '새 배포' 가 열려 취소함)
  - UI 확인: 가짜 google.script.run 을 붙인 Index.html 을 127.0.0.1 로 띄워 확인 (실제 로그인은 PIN 이 필요해 사용자만 가능)
- **아직 안 함**: 로그인 후 화면 흐름 · 휴대폰 ntfy 시험
