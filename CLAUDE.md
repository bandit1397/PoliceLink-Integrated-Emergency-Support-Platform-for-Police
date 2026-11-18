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
- 수신자: 개인 링크 `?r=<token>` (RECIPIENTS.token). 토픽 `pl-` + 20자, 수신자마다 하나. ID = 유형접두어-순번 (`PT/IN/FN/AG/HP-001`), 순번 재사용 안 함.
  삭제 = `active='D'` + 토큰 교체 (행 유지). `active==='Y'` 만 후보 · 로그인 가능
- 통역 요청 대상 = `detail`(가능 언어, 쉼표 구분)에 요청 언어가 있는 통역원 (`candidates`)
- 권역(응급실 · 통역원): RECIPIENTS.zone = `CONFIG.REGIONS` 중 하나 이상(비면 전체 구역). 요청에서 권역 안 고르면 전체
- ntfy: 서버는 메시지 내용만 만들고 **브라우저가 ntfy.sh 로 POST** (Apps Script → ntfy.sh 차단). `sequence_id` = 요청번호. click = 웹앱 `?to=` (버전 14~). click 으로는 계속 울리기가 안 멈춤 → 웹앱 응답 버튼(수락 · 거절)이 터치 순간 `ntfy://` 를 열어 멈춤 (ntfy 는 토픽 화면 열림 · 알림 지우기 때만 멈춤). 알림 버튼 = '알람 끄기'(ntfy://). 새 요청 · 재알림은 긴급 · 보통 모두 우선순위 5 (버전 19~, 알림창이 중요도 → 시간 순이라 같아야 새 요청이 맨 위. 긴급은 제목 [긴급] · 🚨 로 구분). 배정 안내 4 · 재배정 3 · 취소 2
- 재알림: 상황판(admin/dispatcher) 브라우저가 15초마다 `pendingRealerts` (1분 간격 · 최대 3회, 버전 18~. 창이 뒤에 있어도 확인 — 브라우저가 1분에 1번 정도로 늦춤)
- 외부 기관에는 `detail`(내부 메모) · `requesterId` · 경찰관 이름을 보내지 않음 (`publicRequest_`, `orgsByUser_`, `CONFIG.TYPES.*.internal`)

## 코드를 바꿀 때 (배포까지 Claude 가 함 — 사용자가 요청함)

0. ⚠ **Index.html `<script>` 안에서는 문자열에도 `//` 를 쓰지 말 것** — Apps Script 가 `//` 뒤를 주석으로 잘라 낸다 (URL 은 `'https:\/\/…'`). HTML 주석 `<!-- -->` 도 지워짐. `node --check` 로는 못 잡음 → `tests/test_server.js` 의 검사가 잡음
1. 수정 → 문법: `.gs` 는 node 가 확장자를 거부 → `cp Code.gs "$TEMP/cg.js" && node --check "$TEMP/cg.js"`. Index.html 은 `<script>` 부분만 뽑아 `node --check`
2. 서버 시험: `node tests/test_server.js` → `ISOLATION OK` · `ALL TESTS PASSED`. 기능을 넣으면 시험도 추가
3. 화면 확인(필요하면): 가짜 `google.script.run` 을 붙인 Index.html 을 `python -m http.server --bind 127.0.0.1` 로 띄워 Chrome 으로 확인. 실제 웹앱 로그인은 PIN 입력이라 Claude 는 못 함 → 사용자에게
4. 커밋: git user 설정 없음 → `git -c user.name=bandit1397 -c user.email=<기존 커밋과 같은 이메일> commit …` → `git push`
5. **편집기 반영** (clasp 없음, Chrome 확장으로):
   - 편집기 탭에서 `javascript_tool`: raw.githubusercontent.com 의 **이전 커밋** 내용과 `monaco.editor.getModels()` 내용이 같은지 확인 → 같을 때만 **새 커밋** 내용으로 `pushEditOperations` (Code.gs 모델 uri 는 `.js`, Index 는 `.html`)
   - ⚠ **저장은 '지금 열려 있는 파일' 만 됨.** 열려 있지 않은 파일 모델에 `pushEditOperations` 하면 편집기가 변경으로 인식하지 않아
     저장 버튼이 꺼진 채로 남고, 그 파일은 **저장 · 배포되지 않음** (버전 5 에서 Index.html 이 빠져 버전 6 으로 다시 배포함).
     → 파일마다: 파일 목록에서 **그 파일을 먼저 열고** → 내용 교체 → 'Drive에 프로젝트 저장' 버튼 → 비활성 확인.
       그래도 저장 버튼이 꺼져 있으면 `editor.focus()` 후 실제 키 입력(공백) → 저장 → 공백 지우기 → 저장 (최종 내용이 커밋과 같은지 비교)
   - 파일 목록의 'Index.html 저장되지 않음' 라벨은 믿을 수 없음 (저장돼도 남음). **배포 후 /exec fetch 확인이 최종 판단**
6. **배포**: 배포 버튼 → `find` 로 '배포 관리' 메뉴를 찾아 누름 (**좌표로 누르지 말 것** — 창 크기에 따라 '새 배포' 가 눌림. 새 배포는 주소가 바뀜) → 수정(연필) → 버전 '새 버전' → 설명 → 배포 → "버전 N" · 같은 배포 ID 확인
7. **배포 확인**: /exec 탭에서 `fetch(location.href)` 결과에 새 코드 문자열이 있는지 확인 + 실제로 `/exec` 를 열어 **로그인 화면이 나오는지** (서버가 바꾼 스크립트의 문법 오류는 '불러오는 중…' 으로만 보임. `goog.script.init("…")` 의 `userHtml` 을 꺼내 `new Function` 으로 검사 가능) (배포 직후에는 이전 버전이 올 수 있음 — 1분 넘게 걸린 적도 있음 → `?v=<시각>` 붙여 다시) (웹앱 화면은 다른 출처 iframe 이라 find/read_page 로 안 보임)
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

| 버전 | 시각 (13 까지 2026-11-15) | 커밋 | 내용 |
|---|---|---|---|
| 1 | 12:11 | `7e5a07c` 무렵 (코드는 첫 커밋) | 1차 시험판. `setupDemo` 실행(권한 승인은 사용자 요청으로 Claude 가 진행) |
| 2 | 12:36 | `9ebf291` | 외부 기관 화면에 경찰관 이름 대신 소속 |
| 3 | 14:13 | `405be0e` | 관리자 수신자 화면: 유형별 순번 목록 · ＋ 추가 · 삭제 · 복사 |
| 4 | 14:27 | `bbcaaab` | 직원 본인 PIN 변경 · `resetAdminPin`. admin PIN 은 편집기 임시 함수 `tmpSetAdminPin` 으로 지정 후 함수 삭제 · 저장 (저장소 · 배포 버전에 PIN 없음) |
| 5 | 15:08 | `4d1107c` | 알림 버튼 주소에 `?to=<수신자번호>` (Code.gs 만 반영됨 — Index.html 저장 누락) |
| 6 | 15:10 | `4d1107c` | 같은 커밋의 Index.html 반영: `?to=` 면 수신자 화면 우선 · 등록 없으면 '개인 링크를 여세요' 안내 · 직원 로그아웃은 수신자 등록 유지 · 수신자 화면 버튼 '등록 해제' |
| 7 | 17:42 | `f23705b` | 수신자 휴대폰 알림 최근 3건만: 새 요청 때 4번째 오래된 알림을 ntfy `GET /<topic>/<seq>/delete` 로 삭제(`ntfyDel` → `deleteNtfy`). 밀려난 요청은 재알림 · 취소 안내 안 보냄 (`isRecentFor_`). ntfy.sh 한도: IP 당 메시지 250/일 (delete 도 1건) |
| 8 | 19:28 | `38a13a1` | 요청 유형 `hospital` (🏥 병원 응급실, `HP-`): 동시 문의 · 수용 가능/불가 + 사유(`TYPES.hospital.reasons` → RESPONSES.note, 상황판 표시) · 배정 = 이송 결정 · 환자 도착 · 인계 완료. 수신자 화면은 4초마다 다시 그리므로 사유 버튼 펼침 상태를 `reasonOpen` 에 기억. 실제 시트에 응급실 수신자 없음 (관리자 화면에서 추가) |
| 9 | 19:40 | `b32643a` | `CONFIG.REGIONS` 9개 (서울 4 · 경기 4 · 인천), `TYPES.*.regional` (hospital · interpreter). `candidates`: 요청 권역 있으면 `!x.zone` 또는 권역 일치만. 요청 권역은 목록 밖이면 '' (전체). 수신자 권역은 목록만 · 쉼표 여러 개 가능. 화면: 신규 요청 `nRegion` · 관리자 `rcRegion` |
| 10 | 20:22 | `dd7572c` | 관리자 수신자 표에 ntfy 토픽 · '토픽 복사' (`data-rctopic`, `copyText`). Index.html 만 변경. 배포 후 /exec 반영까지 1분 넘게 걸림 (편집기 다시 열어 내용 확인 후 기다리니 반영) |
| 11 | 20:32 | `da06677` | ntfy 복원 파일 버튼: `ntfyRestoreJson` · `downloadNtfyRestore` (관리자 `data-rcfile`, 수신자 `btnRestoreFile`). Apps Script iframe 은 `allow-downloads` 있음 → blob 다운로드 가능. Index.html 만 변경 |
| 12 | 21:04 | `d26046f` | **고침**: 버전 11 부터 웹앱이 '불러오는 중…' 에서 멈춤. HtmlService 가 `<script>` 안 `//` 뒤를 주석으로 지워 `'https://ntfy.sh'` → `'https:` (문법 오류). `'https:\/\/ntfy.sh'` 로 고치고 시험 추가 |
| 13 | 21:16 | `e0d598d` | 한 휴대폰에 수신자 여러 개: localStorage `pl_rtokens` {수신자번호: {t, name, type}}. `?to=` 면 그 등록으로 열기, 2개 이상이면 `rSwitch` 전환 버튼 + 다른 등록 대기 건수(30초). 등록 해제 · 만료는 그 등록만 (`forgetRecipient`) |
| 14 | 11-17 12:01 | `6cabdcc` | **알람 순서**: 알림 누름 → 바로 응답 화면(알람 계속) → 응답 버튼 = 응답 + 알람 멈춤(ntfy 화면 잠깐 → 뒤로). 응답 전송을 먼저 시작하고 같은 터치에서 `stopNtfyAlarm` (터치 직후에만 ntfy:// 열림). 수락 · 거절만. 사유 펼치기는 안 멈춤 |
| 15 | 11-17 12:04 | `b8b6c25` | 수신자 화면 안내문 · 설정 PDF 를 새 알람 순서로 |
| 16 | 11-17 12:35 | `b034f30` | **고침**: 응답 후에도 휴대폰에서 '뚜뚜뚜'(웹 화면 `beep`) 계속 — ntfy 화면이 열려 웹 화면이 뒤로 가면 새로 고침이 멈춰 대기 상태로 남았음. 응답 누르는 순간 `silenced` 에 넣고, `document.hidden` 이면 안 울림 (visibilitychange 때 `updateRinging`) |
| 17 | 11-17 13:42 | `a903829` | 수신자 화면 '📱 화면이 꺼져도 알림 받기' 안내를 **처음엔 항상 닫힘** (`showPush`). 아래 링크 '설정 보기/닫기' 로 토글, 상자 버튼 '닫기'. `pl_ntfy_done_*` 는 더 안 씀 |
| 18 | 11-17 14:15 | `cdfd2a0` | 재알림 **1분** 간격 (`REALERT_MIN` 1, `realertGapMs_` 5초 여유) · 상황판 확인 15초 · 상황판 창이 뒤에 있어도 확인 (`checkRealert` 의 `document.hidden` 제거). 배포 때 상황판 '응답 대기' 58건 (대부분 시험 요청) — ntfy.sh IP 당 250/일 주의 |
| 19 | 11-18 20:42 | `11a94d2` | **알림창 순서**: 새 요청 · 재알림을 **보통도 우선순위 5** (이전 4). 안드로이드 알림창은 중요도가 먼저라 예전 긴급이 새 보통보다 위에 남았음 → 이제 새 요청이 맨 위. 대가: 보통도 응답할 때까지 계속 울림. 수신자 화면 안내 · 설정 PDF 수정 |
| 20 | 11-18 20:54 | `76e854d` | 빨간 **응답 대기 배너는 ntfy 화면을 열지 않음** (사용자 요청): 이 화면 소리만 끄고 첫 응답 대기 카드로 스크롤. 휴대폰 알람은 **응답 버튼(수락 · 거절)으로만** 멈춤 (여전히 ntfy 화면 잠깐 → 뒤로). Index.html 만 변경. /exec 반영 10초 |
| 21 | 11-18 21:12 | `bf9439e` | **뒤로 가기 안내**: 응답 버튼 아래 경고 줄(안드로이드, `.back-hint`) · 설정 안내 · `rInfo` · PDF. ntfy 화면이 열려 있으면 그 토픽 알림이 알림창에 안 뜸(`detailViewSubscriptionId`). 자동 복귀 불가 — ntfy-android 소스: 계속 울리기는 `DetailActivity` 생성 · 알림 밀어 지우기(`DeleteBroadcastReceiver`)에서만 멈춤, `cancel`(서버 delete) 로는 안 멈춤. Index.html 만 변경. /exec 반영 30초 |
| 22 | 11-18 21:40 | `dbbbba2` | ntfy 알림 버튼 2개: **알람 끄기** + **↩ PoliceLink로 돌아가기** (view, 주소 = click). ntfy 토픽 화면의 요청 카드에도 버튼이 보임 (`DetailAdapter.maybeRenderActions`) → 응답 후 열린 ntfy 화면에서 누르면 응답 화면으로 복귀 (A90 확인: 크롬 새 탭으로 열림, 탭이 쌓임 — 뒤로 가기가 더 빠름). 안내문 · PDF |
| 23 | 11-18 21:48 | `588e4e8` | 돌아가기 버튼 문구 `RETURN_LABEL` = **🔴 PoliceLink로 돌아가기 (필수)** (버튼 색은 ntfy 가 정함 → 빨간 이모지) + 새 요청 · 재알림 본문 끝 줄 "⚠ 응답한 뒤 아래 ...를 반드시 누르세요". A90 ntfy 화면에서 본문 경고 · 버튼 모두 보임 확인 (알림창 접힌 상태에선 본문 첫 줄만) |
| 24 | 11-18 23:41 | `874ef73` | 돌아가기 버튼 `RETURN_LABEL` = **🔴 PoliceLink로 돌아가기 (필수 클릭) 🔴** (사용자: 글자 전체 빨강 요청 → ntfy 는 버튼 글자색을 정할 수 없어 앞뒤 빨간 동그라미로). 본문 경고 · 안내문 · PDF 같은 문구 |

- 휴대폰 알림 팝업(헤즈업)이 몇 초 뒤 사라짐: 안드로이드가 정함, ntfy 로는 못 바꿈. 사용자 휴대폰 설정 '접근성 → 작업 수행 시간'(최대 2분)으로 늘릴 수 있음 — 안내만 함

## 현재 데이터 · 휴대폰 상태 (2026-11-15 15시 무렵)

- **2026-11-17 갱신**: A90 ntfy 구독은 **HP-002 (홍익병원 응급실) 하나뿐** (통역원 5 · emergency-ntfy 구독 없음).
  화면 켤 때 알람이 안 보이던 원인 = PIN + 자동 잠금 10분 → 10분 안에는 잠금화면 없이 홈으로 감.
  사용자가 잠금 방식을 **'드래그'**(삼성 표기, = 밀기 · 보안 없음)로 바꿈 → 화면 끈 상태 시험 알람이 **잠금화면에 크게 보임** 확인.
  이 기종(One UI)은 잠금화면 '알림 표시할 앱'(앱별 선택) 메뉴 없음. '액션 취하기 전 대기 시간' 2분 (헤즈업 팝업 유지 시간).
  병원 배부 공기계도 같은 설정 권장 (화면 잠금 '드래그', '설정 안 함'은 잠금화면이 없어 안 됨)
  14:17~14:19 알람 안 울림 원인 = HP-002 구독이 **즉시 전달 꺼짐**(구독 버튼으로 만듦 → FCM 만, 지연 · 누락). 14:48 사용자가 켬 →
  화면 꺼짐 긴급 시험 1.4초 만에 울림 확인. 확인법: `dumpsys activity services io.heckel.ntfy` 에 SubscriberService · 알림 '알림 수신중'
  · logcat `NtfySubscriberService: - Active connections`. 설정 PDF 6-3 에 절차 (A90 화면 그림)

- 15시 무렵 사용자 보고: 몽골어 요청 알람이 휴대폰에 옴 → **PoliceLink 열기** 를 누르니 관리자 화면이 열림.
  원인: 알림 버튼은 기본 /exec 를 열고, 그 브라우저에 수신자 등록(localStorage `pl_rtoken`)이 없고 직원 로그인만 있었음
  (직원 로그아웃이 수신자 등록까지 지우던 문제 · 또는 알림이 다른 기본 브라우저로 열림). → 버전 5 · 6 으로 수정.
  **휴대폰에서는 개인 링크를 그 브라우저로 한 번 다시 열어야 함** (지워진 등록은 복구 불가)

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
4. ~~휴대폰 빠른 설정 (복원 파일)~~ → 버전 11 에서 버튼으로 됨. 안내서 `docs/phone-setup/수신자휴대폰-설정-절차.pdf` 만듦 (원본 pdf-source.html → Chrome headless, PowerShell 로 실행 — 경로에 em dash). 남은 것: 실제 A90 에서 복원 시험
5. 시험 끝나면 A90 USB 디버깅 끄기 안내
6. (보류, 2026-11-18 사용자 결정: 그대로 둠) 응답 후 ntfy 화면 → PoliceLink **자동 복귀**. 웹앱만으로는 불가. 후보: A) 휴대폰 자동화 앱(MacroDroid: ntfy 실행 → 0.5초 → 뒤로 가기, 접근성 권한 · 의도적 ntfy 열기도 튕김) B) ntfy-android 포크 앱(알람 끄고 바로 닫기, 직접 설치 APK)
   - 2026-11-18 A90 확인: 우선순위 5 시험 2건 → 알림창에서 나중 것([보통])이 맨 위, 둘 다 계속 울리기 (logcat `Playing insistent alarm`)
