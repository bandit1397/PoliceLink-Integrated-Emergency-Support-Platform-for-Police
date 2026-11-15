# PoliceLink — 작업 안내 (Claude Code용)

> 다음 세션은 이 파일 → `README.md` 의 **개발 진행 기록** → `docs/설계검토.md` 순서로 읽고 시작할 것.
> 이 저장소는 **공개**. PIN · 개인 링크 토큰 · ntfy 토픽 이름 · 시트 ID 는 여기 · 커밋 · 문서에 쓰지 말 것 (→ `accounts.local.txt`).

## 위치

| 항목 | 위치 |
|---|---|
| GitHub (공개) | https://github.com/bandit1397/PoliceLink-Integrated-Emergency-Support-Platform-for-Police |
| 로컬 폴더 | `C:\Users\owner\Desktop\PoliceLink — Integrated Emergency Support Platform for Police` (이름에 em dash · 공백 → 경로는 항상 따옴표) |
| 기반 프로젝트 | `Desktop/emergency-ntfy` (환자 수용 요청). **수정하지 말 것** — 참고 · 복사만. 휴대폰/ntfy 지식은 그 폴더 CLAUDE.md 에 많음 |
| Apps Script 프로젝트 "PoliceLink" | https://script.google.com/home/projects/1OhwTR9Aja90AILQ3bISaVO-mgcL43OoWEa50YnFzCeA8fsjsLi-_5rg9/edit |
| 웹앱 (/exec, 배포 ID 고정) | https://script.google.com/macros/s/AKfycbx7UhxhjwnyxErO3oBARbPh4dgB-CpDJA8Hz4k2uaULFHXmWIHvQ-GNZA8O6kiwEwUcIg/exec |
| 비밀값 (git 제외) | `accounts.local.txt` — 직원 3명 PIN(admin 은 사용자가 정한 값) · 데이터 시트 주소 · 수신자 13곳 개인 링크 (통역원 5 포함) |
| 시험 휴대폰 | 갤럭시 A90 (SM-A908N · 안드로이드 12 · ntfy 1.25.2), USB 로 연결해서 adb 사용 |

## 핵심 구조

- 데이터: Google 스프레드시트 7시트 (`SHEETS`). 모든 칸 텍스트, 시간 `yyyy-MM-dd HH:mm:ss` KST. 읽기는 CacheService 30초 캐시, 쓰기 때 무효화, 쓰기는 `withLock_` 안에서 `rows_(name, true)`
- 스크립트 속성: `SHEET_ID` · `WEBAPP_URL` (자동)
- 직원: `login(아이디, PIN)` → CacheService `sess_<token>` 6시간. 역할 admin · dispatcher · officer. PIN 은 salt+SHA256. 5회 실패 10분 잠금. `changePin`(본인) · `saveUser(resetPin)`(관리자) · `resetAdminPin`(편집기)
- 수신자: 개인 링크 `?r=<token>` (RECIPIENTS.token). 토픽 `pl-` + 20자, 수신자마다 하나. ID = 유형접두어-순번 (`PT/IN/FN/AG-001`), 순번 재사용 안 함.
  삭제 = `active='D'` + 토큰 교체 (행 유지). `active==='Y'` 만 후보 · 로그인 가능
- 통역 요청 대상 = `detail`(가능 언어, 쉼표 구분)에 요청 언어가 있는 통역원 (`candidates`)
- ntfy: 서버는 메시지 내용만 만들고 **브라우저가 ntfy.sh 로 POST** (Apps Script → ntfy.sh 차단). `sequence_id` = 요청번호. **click 넣지 말 것** (계속 울리기가 안 멈춤). 긴급=우선순위 5, 보통=4
- 재알림: 상황판(admin/dispatcher) 브라우저가 1분마다 `pendingRealerts` (3분 간격 · 최대 3회)
- 외부 기관에는 `detail`(내부 메모) · `requesterId` · 경찰관 이름을 보내지 않음 (`publicRequest_`, `orgsByUser_`, `CONFIG.TYPES.*.internal`)

## 코드를 바꿀 때 (배포까지 Claude 가 함 — 사용자가 요청함)

1. 수정 → 문법: `.gs` 는 node 가 확장자를 거부 → `cp Code.gs "$TEMP/cg.js" && node --check "$TEMP/cg.js"`. Index.html 은 `<script>` 부분만 뽑아 `node --check`
2. 서버 시험: `node tests/test_server.js` → `ISOLATION OK` · `ALL TESTS PASSED`. 기능을 넣으면 시험도 추가
3. 화면 확인(필요하면): 가짜 `google.script.run` 을 붙인 Index.html 을 `python -m http.server --bind 127.0.0.1` 로 띄워 Chrome 으로 확인. 실제 웹앱 로그인은 PIN 입력이라 Claude 는 못 함 → 사용자에게
4. 커밋: git user 설정 없음 → `git -c user.name=bandit1397 -c user.email=<기존 커밋과 같은 이메일> commit …` → `git push`
5. **편집기 반영** (clasp 없음, Chrome 확장으로):
   - 편집기 탭에서 `javascript_tool`: raw.githubusercontent.com 의 **이전 커밋** 내용과 `monaco.editor.getModels()` 내용이 같은지 확인 → 같을 때만 **새 커밋** 내용으로 `pushEditOperations` (Code.gs 모델 uri 는 `.js`, Index 는 `.html`)
   - 저장: **'Drive에 프로젝트 저장' 버튼**을 누르고 비활성(=저장 완료)인지 확인. Ctrl+S 는 열린 파일만 저장될 수 있음.
     파일 목록의 '저장되지 않음' 라벨은 저장 후에도 남는 경우가 있음 (버전 4 때) → 배포 후 확인으로 판단
6. **배포**: 배포 버튼 → `find` 로 '배포 관리' 메뉴를 찾아 누름 (**좌표로 누르지 말 것** — 창 크기에 따라 '새 배포' 가 눌림. 새 배포는 주소가 바뀜) → 수정(연필) → 버전 '새 버전' → 설명 → 배포 → "버전 N" · 같은 배포 ID 확인
7. **배포 확인**: /exec 탭에서 `fetch(location.href)` 결과에 새 코드 문자열이 있는지 확인 (웹앱 화면은 다른 출처 iframe 이라 find/read_page 로 안 보임)
8. 이 파일 '배포 기록' 과 README '개발 진행 기록' 갱신

### 브라우저 · 휴대폰 점검 요령

- 데이터 시트 읽기: docs.google.com 시트 탭에서 `fetch('/spreadsheets/d/<SHEET_ID>/gviz/tq?tqx=out:csv&sheet=RECIPIENTS', {credentials:'include'})` (SHEET_ID 는 accounts.local.txt)
- ntfy 실제 발송 확인: `https://ntfy.sh/<topic>/json?poll=1&since=24h` (topic 은 RECIPIENTS.topic) — 결과를 사용자에게 보여줄 때 토픽 이름은 가릴 것
- adb: `"$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe"` (PATH 에 없음). Git Bash 는 `/sdcard/...` 를 Windows 경로로 바꿔 버림 → **`export MSYS_NO_PATHCONV=1`** 먼저
  - 구독 목록: `am start -n io.heckel.ntfy/.ui.MainActivity -f 0x04008000` → `uiautomator dump /sdcard/ui.xml` → `cat` 으로 text 추출
  - 구독 추가: `am start -a android.intent.action.VIEW -d "ntfy://ntfy.sh/<topic>" io.heckel.ntfy`
  - 수신 로그: `logcat -d | grep -i ntfy` (`NtfyFirebase: Received message` · `NtfySubscriberService: Active connections`)
  - 끝나면 **홈 버튼** (ntfy 토픽 화면을 열어 두면 그 토픽 알림이 알림창에 안 뜸)
- 편집기 · 웹앱 창이 가려지면 스크린샷 시간 초과 → `javascript_tool` 로 DOM 확인

## 배포 기록 (모두 같은 /exec 주소)

| 버전 | 시각 (2026-11-15) | 커밋 | 내용 |
|---|---|---|---|
| 1 | 12:11 | `7e5a07c` 무렵 (코드는 첫 커밋) | 1차 시험판. `setupDemo` 실행(권한 승인은 사용자 요청으로 Claude 가 진행) |
| 2 | 12:36 | `9ebf291` | 외부 기관 화면에 경찰관 이름 대신 소속 |
| 3 | 14:13 | `405be0e` | 관리자 수신자 화면: 유형별 순번 목록 · ＋ 추가 · 삭제 · 복사 |
| 4 | 14:27 | `bbcaaab` | 직원 본인 PIN 변경 · `resetAdminPin`. admin PIN 은 편집기 임시 함수 `tmpSetAdminPin` 으로 지정 후 함수 삭제 · 저장 (저장소 · 배포 버전에 PIN 없음) |

## 현재 데이터 · 휴대폰 상태 (2026-11-15 15시 무렵)

- 수신자: setupDemo 12곳 + 사용자가 추가한 **IN-005 `통역원 5` (가능 언어: 인도네시아어)**
- 요청: `1115-1317-665`(영어, IN-001 수락), `1115-1440-E9W`(몽골어 긴급 → IN-003 대상, 응답 대기 · 재알림 2회 이상) — 둘 다 열린 상태
- 갤럭시 A90 ntfy 구독: 병원 시스템 서울 · 인천 토픽(emergency-ntfy) + **통역원 5 토픽 (즉시 전달 켬)**. 시험 알림 수신 확인 (FCM 약 0.5초)
  - 마지막에 USB 가 offline 돼서 홈 버튼을 못 누름 → 사용자에게 홈 버튼 안내함
- 사용자가 말한 증상 "몽골어 요청이 안 온다": 원인 = ① 휴대폰 링크(통역원 5)는 몽골어 대상 아님 ② ntfy 구독을 안 했음. ②는 고침, ①은 사용자 선택 대기
  (통역원 5 에 몽골어 추가 또는 인도네시아어로 시험) — README '알림이 안 올 때 점검 순서'

## 다음 할 일 후보

1. (사용자 응답 대기) 통역원 5 가능 언어에 몽골어 추가 여부
2. 휴대폰에서 실제 요청 → 수락 → 배정 → 현장 도착 → 완료 전체 흐름, 화면 꺼짐 긴급 알람(계속 울리기) · 재알림 확인
3. 수신자 화면에 'ntfy 구독 안 됨' 경고 (구독 버튼을 안 눌러 생긴 문제 재발 방지) — 웹앱에서 구독 여부를 직접 알 수는 없으므로 '구독 완료' 확인 버튼 + 시험 알림 보내기 버튼 같은 방식 검토
4. 휴대폰 빠른 설정: emergency-ntfy `phone-setup/make-ntfy-restore.html` 방식(복원 파일, instant · insistent 포함)을 PoliceLink 토픽용으로
5. 시험 끝나면 A90 USB 디버깅 끄기 안내
