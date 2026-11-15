/**
 * PoliceLink — 경찰 통합 긴급지원 플랫폼 (1차 시험판 · Google Apps Script 서버)
 *
 * 순찰차 배치 · 통역원 호출 · 금융기관 협조 · 유관기관 지원 요청을 한 화면에서 보내고,
 * 수신자의 수락/거절 → 상황관리자 배정 → 처리 완료까지 Google 스프레드시트에 기록한다.
 *
 * 기반: emergency-ntfy (환자 수용 요청) — ntfy 알림 · 알람 끄기 · 4~5초 폴링 구조를 그대로 쓴다.
 *  - Apps Script 서버(UrlFetchApp)는 ntfy.sh 에 접속할 수 없다 (Google 차단, 이전 프로젝트에서 확인).
 *    → 서버는 ntfy 메시지 내용만 만들어 돌려주고, **요청을 보낸 직원의 브라우저가** ntfy.sh 로 POST 한다.
 *    → 미응답 재알림도 상황판(관제 PC) 브라우저가 1분마다 서버에 물어보고 보낸다.
 *  - 알림에는 요청번호 · 유형 · 긴급도만 담는다 (사건 내용 · 위치 · 개인정보 없음).
 *  - 알림에 click 을 넣지 않는다 (넣으면 눌러도 ntfy 계속 울림이 멈추지 않음, 2026-10-25 확인).
 *
 * ⚠ 시험판: 가상 데이터만 넣을 것. 실제 사건 정보 · 개인정보 입력 금지.
 */

const CONFIG = {
  NTFY_SERVER: 'https://ntfy.sh',
  TYPES: {
    patrol:      { label: '순찰차 배치',   icon: '🚓', tag: 'police_car',         accept: '출동 가능', reject: '출동 불가', internal: true },
    interpreter: { label: '통역원 호출',   icon: '🗣️', tag: 'speaking_head',      accept: '통역 가능', reject: '통역 불가' },
    finance:     { label: '금융기관 협조', icon: '🏦', tag: 'bank',               accept: '접수 확인', reject: '처리 불가' },
    agency:      { label: '유관기관 지원', icon: '🏛️', tag: 'classical_building', accept: '지원 가능', reject: '지원 불가' },
  },
  URGENCY: ['긴급', '보통'],
  PATROL_STATUS: ['가용', '출동중', '휴식'],
  LANGUAGES: ['영어', '중국어', '베트남어', '러시아어', '일본어', '태국어', '몽골어', '아랍어', '기타'],
  ROLES: { admin: '관리자', dispatcher: '상황관리자', officer: '현장 경찰관' },
  REALERT_MIN: 3,       // 응답이 없으면 3분마다
  REALERT_MAX: 3,       // 최대 3번 다시 알림
  SESSION_SEC: 21600,   // 직원 로그인 유지 6시간 (CacheService 최대)
  LIST_HOURS: 24,       // 상황판에 보이는 종료 요청: 최근 24시간
  LOGIN_MAX_FAIL: 5,    // PIN 5번 틀리면
  LOGIN_LOCK_SEC: 600,  // 10분 잠금
};

// 시트 이름 → 열 이름 (모든 칸은 텍스트로 저장. 시간은 'yyyy-MM-dd HH:mm:ss' KST)
const SHEETS = {
  USERS:       ['userId', 'name', 'org', 'role', 'pinHash', 'salt', 'active', 'createdAt'],
  RECIPIENTS:  ['recipientId', 'type', 'name', 'org', 'detail', 'zone', 'contact', 'status', 'topic', 'token', 'active', 'createdAt'],
  REQUESTS:    ['requestId', 'createdAt', 'type', 'urgency', 'location', 'zone', 'language', 'summary', 'detail', 'callback',
                'requesterId', 'requesterName', 'status', 'targets', 'assignedTo', 'assignedAt', 'doneAt',
                'realertCount', 'lastAlertAt', 'updatedAt'],
  RESPONSES:   ['requestId', 'recipientId', 'status', 'note', 'at'],
  ASSIGNMENTS: ['requestId', 'recipientId', 'assignedBy', 'at', 'note'],
  AUDIT_LOG:   ['at', 'actor', 'role', 'action', 'target', 'result', 'detail'],
};
const TIME_FIELDS = ['createdAt', 'assignedAt', 'doneAt', 'lastAlertAt', 'updatedAt', 'at'];

const SHEET_ID_KEY = 'SHEET_ID';
const APP_URL_KEY = 'WEBAPP_URL';
const TZ = 'Asia/Seoul';

/* ======================================================================
 * 웹앱 진입
 * ==================================================================== */

function doGet() {
  rememberAppUrl_();
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('PoliceLink')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function getConfig() {
  return {
    types: CONFIG.TYPES,
    urgency: CONFIG.URGENCY,
    patrolStatus: CONFIG.PATROL_STATUS,
    languages: CONFIG.LANGUAGES,
    roles: CONFIG.ROLES,
    realertMin: CONFIG.REALERT_MIN,
    ready: !!PropertiesService.getScriptProperties().getProperty(SHEET_ID_KEY),
  };
}

/* ======================================================================
 * 직원 로그인 (USERS: 아이디 + PIN → 6시간 세션)
 * ==================================================================== */

function login(userId, pin) {
  userId = clean_(userId, 30).toLowerCase();
  pin = String(pin || '');
  const cache = CacheService.getScriptCache();
  const failKey = 'fail_' + userId;
  const fails = Number(cache.get(failKey)) || 0;
  if (fails >= CONFIG.LOGIN_MAX_FAIL) throw new Error('로그인 실패가 많아 10분간 잠겼습니다.');

  const user = rows_('USERS').find((u) => String(u.userId).toLowerCase() === userId);
  if (!user || user.active !== 'Y' || sha256_(user.salt + pin) !== user.pinHash) {
    cache.put(failKey, String(fails + 1), CONFIG.LOGIN_LOCK_SEC);
    audit_({ userId: userId || '-', role: '-' }, 'login', userId, 'fail', '');
    throw new Error('아이디 또는 PIN 이 올바르지 않습니다.');
  }
  cache.remove(failKey);
  const token = randomToken_();
  const sess = { userId: user.userId, name: user.name, org: user.org, role: user.role };
  cache.put('sess_' + token, JSON.stringify(sess), CONFIG.SESSION_SEC);
  audit_(sess, 'login', user.userId, 'ok', '');
  return { token: token, user: sess };
}

function logout(token) {
  CacheService.getScriptCache().remove('sess_' + token);
  return true;
}

function whoami(token) {
  return auth_(token);
}

/** 본인 PIN 변경: 현재 PIN 확인 후 새 PIN (숫자 6~12자리). 현재 PIN 을 틀리면 로그인 실패와 같이 셈 */
function changePin(token, oldPin, newPin) {
  const sess = auth_(token);
  newPin = String(newPin || '');
  checkPinRule_(newPin);
  const cache = CacheService.getScriptCache();
  const failKey = 'fail_' + String(sess.userId).toLowerCase();
  const fails = Number(cache.get(failKey)) || 0;
  if (fails >= CONFIG.LOGIN_MAX_FAIL) throw new Error('PIN 실패가 많아 10분간 잠겼습니다.');
  withLock_(() => {
    const u = find_('USERS', 'userId', sess.userId);
    if (!u || sha256_(u.salt + String(oldPin || '')) !== u.pinHash) {
      cache.put(failKey, String(fails + 1), CONFIG.LOGIN_LOCK_SEC);
      throw new Error('현재 PIN 이 올바르지 않습니다.');
    }
    if (sha256_(u.salt + newPin) === u.pinHash) throw new Error('현재 PIN 과 다른 PIN 을 입력하세요.');
    update_('USERS', u, pinFields_(newPin));
  });
  cache.remove(failKey);
  audit_(sess, 'pin_change', sess.userId, 'ok', '');
  return true;
}

function checkPinRule_(pin) {
  if (!/^\d{6,12}$/.test(pin)) throw new Error('PIN 은 숫자 6~12자리입니다.');
  if (/^(\d)\1+$/.test(pin) || '01234567890123'.indexOf(pin) >= 0 || '98765432109876'.indexOf(pin) >= 0) {
    throw new Error('같은 숫자 반복이나 연속 숫자(123456 등)는 쓸 수 없습니다.');
  }
}

function pinFields_(pin) {
  const salt = randomChars_('abcdefghijklmnopqrstuvwxyz0123456789', 16);
  return { salt: salt, pinHash: sha256_(salt + pin) };
}

/** roles 를 주면 그 역할만 허용 */
function auth_(token, roles) {
  const json = token ? CacheService.getScriptCache().get('sess_' + token) : null;
  if (!json) throw new Error('SESSION_EXPIRED');
  const sess = JSON.parse(json);
  if (roles && roles.indexOf(sess.role) < 0) throw new Error('권한이 없습니다.');
  return sess;
}

/* ======================================================================
 * 직원: 상황판 · 신규 요청 · 배정 · 종료
 * ==================================================================== */

/** 상황판: 진행 중 요청 + 최근 24시간 종료 요청. 현장 경찰관은 본인이 보낸 요청만 */
function dashboard(token) {
  const sess = auth_(token);
  const now = Date.now();
  const recips = indexBy_(rows_('RECIPIENTS'), 'recipientId');
  const latest = latestResponses_();
  const items = rows_('REQUESTS')
    .filter((r) => isActive_(r) || now - r.updatedAt < CONFIG.LIST_HOURS * 3600000)
    .filter((r) => sess.role !== 'officer' || r.requesterId === sess.userId)
    .map((r) => {
      const targets = splitIds_(r.targets).map((id) => {
        const rc = recips[id] || {};
        const resp = latest[r.requestId + '|' + id] || null;
        return {
          recipientId: id, name: rc.name || id, org: rc.org || '', zone: rc.zone || '', status: rc.status || '',
          response: resp ? { status: resp.status, note: resp.note, at: resp.at } : null,
        };
      });
      return Object.assign(publicRequest_(r, true), { targets: targets });
    })
    .sort((a, b) => (isActive_(b) - isActive_(a)) || (b.urgency === '긴급') - (a.urgency === '긴급') || b.createdAt - a.createdAt);
  const patrols = rows_('RECIPIENTS').filter((x) => x.type === 'patrol' && x.active === 'Y')
    .map((x) => ({ recipientId: x.recipientId, name: x.name, zone: x.zone, status: x.status }));
  return { now: now, me: sess, items: items, patrols: patrols };
}

/** 신규 요청 화면의 대상 목록 (순찰차는 추천 순서) */
function candidates(token, type, opts) {
  auth_(token);
  opts = opts || {};
  if (!CONFIG.TYPES[type]) throw new Error('잘못된 요청 유형입니다.');
  let list = rows_('RECIPIENTS').filter((x) => x.type === type && x.active === 'Y');
  if (type === 'patrol') return recommendPatrol_(list, clean_(opts.zone, 30), opts.urgency);
  if (type === 'interpreter' && opts.language) {
    list = list.filter((x) => splitList_(x.detail).indexOf(opts.language) >= 0);
  }
  return list.map((x) => ({
    recipientId: x.recipientId, name: x.name, org: x.org, detail: x.detail, zone: x.zone,
    status: x.status, recommended: type === 'interpreter', reason: '',
  }));
}

/**
 * 순찰차 추천: 가장 가까운 차가 아니라 가용 여부 · 담당 구역 · 현재 임무 수 · 긴급도를 함께 본다.
 * (GPS 는 3차 개발. 최종 배정은 상황관리자가 결정)
 */
function recommendPatrol_(list, zone, urgency) {
  const busy = {};
  rows_('REQUESTS').filter((r) => r.status === 'assigned' && r.type === 'patrol')
    .forEach((r) => (busy[r.assignedTo] = (busy[r.assignedTo] || 0) + 1));
  const scored = list.map((x) => {
    let score = 0;
    const why = [];
    if (x.status === '가용') { score += 100; why.push('가용'); }
    else if (x.status === '휴식') { score -= 50; why.push('휴식 중'); }
    else why.push('출동 중');
    if (zone && x.zone === zone) { score += 30; why.push('담당 구역'); }
    const n = busy[x.recipientId] || 0;
    if (n) { score -= 40 * n; why.push('진행 임무 ' + n + '건'); }
    return {
      recipientId: x.recipientId, name: x.name, org: x.org, detail: x.detail, zone: x.zone,
      status: x.status, score: score, reason: why.join(' · '),
    };
  }).sort((a, b) => b.score - a.score);
  // 긴급이면 상위 2대, 보통이면 1대를 미리 선택 (가용 차량만)
  const pickN = urgency === '긴급' ? 2 : 1;
  scored.forEach((x, i) => (x.recommended = i < pickN && x.status === '가용'));
  return scored;
}

function createRequest(token, data) {
  const sess = auth_(token);
  data = data || {};
  const type = CONFIG.TYPES[data.type] ? data.type : null;
  if (!type) throw new Error('요청 유형을 선택하세요.');
  const summary = clean_(data.summary, 200);
  if (!summary) throw new Error('요청 내용(외부 전달용)을 입력하세요.');
  const recips = indexBy_(rows_('RECIPIENTS'), 'recipientId');
  const targets = (data.targets || []).filter((id, i, a) => a.indexOf(id) === i)
    .filter((id) => recips[id] && recips[id].type === type && recips[id].active === 'Y');
  if (!targets.length) throw new Error('알림을 보낼 대상을 1곳 이상 선택하세요.');

  const now = Date.now();
  const req = {
    requestId: newId_(),
    createdAt: now,
    type: type,
    urgency: CONFIG.URGENCY.indexOf(data.urgency) >= 0 ? data.urgency : '보통',
    location: clean_(data.location, 100),
    zone: clean_(data.zone, 30),
    language: type === 'interpreter' ? clean_(data.language, 20) : '',
    summary: summary,
    detail: clean_(data.detail, 500),
    callback: clean_(data.callback, 30),
    requesterId: sess.userId,
    requesterName: sess.name,
    status: 'open',
    targets: targets.join(','),
    assignedTo: '', assignedAt: '', doneAt: '',
    realertCount: 0,
    lastAlertAt: now,
    updatedAt: now,
  };
  withLock_(() => append_('REQUESTS', req));
  audit_(sess, 'create', req.requestId, 'ok', CONFIG.TYPES[type].label + ' · ' + req.urgency + ' · 대상 ' + targets.length);
  return {
    requestId: req.requestId,
    ntfy: targets.map((id) => ntfyAlarm_(req, recips[id], '')).filter(Boolean),
  };
}

/** 상황관리자: 수락한 대상 중 하나를 배정 (재배정 가능) */
function assign(token, requestId, recipientId) {
  const sess = auth_(token, ['admin', 'dispatcher']);
  const out = withLock_(() => {
    const req = find_('REQUESTS', 'requestId', requestId);
    if (!req) throw new Error('요청을 찾을 수 없습니다.');
    if (!isActive_(req)) throw new Error('이미 종료된 요청입니다.');
    if (splitIds_(req.targets).indexOf(recipientId) < 0) throw new Error('이 요청의 대상이 아닙니다.');
    const resp = latestResponses_(true)[requestId + '|' + recipientId];
    if (!resp || resp.status !== 'accept') throw new Error('수락한 대상만 배정할 수 있습니다.');
    const prev = req.assignedTo;
    if (prev === recipientId) return null;
    const now = Date.now();
    update_('REQUESTS', req, { status: 'assigned', assignedTo: recipientId, assignedAt: now, updatedAt: now });
    append_('ASSIGNMENTS', { requestId: requestId, recipientId: recipientId, assignedBy: sess.userId, at: now, note: prev ? '재배정 (이전 ' + prev + ')' : '' });
    if (req.type === 'patrol') {
      setPatrol_(recipientId, '출동중');
      if (prev) releasePatrol_(prev, requestId);
    }
    return { req: req, prev: prev };
  });
  if (!out) return { ntfy: [] };
  audit_(sess, 'assign', requestId, 'ok', recipientId);
  const recips = indexBy_(rows_('RECIPIENTS'), 'recipientId');
  const msgs = [ntfyInfo_(out.req, recips[recipientId], '배정 확정 — 앱에서 확인하세요.', 4)];
  if (out.prev) msgs.push(ntfyInfo_(out.req, recips[out.prev], '다른 대상으로 재배정되었습니다.', 3));
  return { ntfy: msgs.filter(Boolean) };
}

/** 종료: outcome = 'done'(처리 완료) | 'cancelled'(취소). 현장 경찰관은 자기 요청 취소만 */
function closeRequest(token, requestId, outcome) {
  const sess = auth_(token);
  outcome = outcome === 'done' ? 'done' : 'cancelled';
  const req = withLock_(() => {
    const r = find_('REQUESTS', 'requestId', requestId);
    if (!r) throw new Error('요청을 찾을 수 없습니다.');
    if (!isActive_(r)) throw new Error('이미 종료된 요청입니다.');
    const own = r.requesterId === sess.userId;
    if (sess.role === 'officer' && !(own && outcome === 'cancelled')) throw new Error('권한이 없습니다.');
    const now = Date.now();
    update_('REQUESTS', r, { status: outcome, doneAt: now, updatedAt: now });
    if (r.type === 'patrol' && r.assignedTo) releasePatrol_(r.assignedTo, requestId);
    return r;
  });
  audit_(sess, outcome === 'done' ? 'complete' : 'cancel', requestId, 'ok', '');
  // 취소 시: 아직 울리고 있을 수 있는 알림을 같은 sequence_id 의 조용한 알림으로 바꿔 준다.
  if (outcome !== 'cancelled') return { ntfy: [] };
  const recips = indexBy_(rows_('RECIPIENTS'), 'recipientId');
  return { ntfy: splitIds_(req.targets).map((id) => ntfyInfo_(req, recips[id], '요청이 취소되었습니다.', 2)).filter(Boolean) };
}

/**
 * 상황판 브라우저가 1분마다 호출: 응답이 없는 대상에게 다시 보낼 ntfy 메시지.
 * 여러 PC 가 동시에 상황판을 열어도 잠금 + lastAlertAt 으로 한 번만 나간다.
 */
function pendingRealerts(token) {
  const sess = auth_(token, ['admin', 'dispatcher']);
  const now = Date.now();
  const due = rows_('REQUESTS').filter((r) => r.status === 'open' &&
    Number(r.realertCount) < CONFIG.REALERT_MAX && now - r.lastAlertAt >= CONFIG.REALERT_MIN * 60000);
  if (!due.length) return [];
  const msgs = [];
  const logs = [];
  withLock_(() => {
    const latest = latestResponses_(true);
    const recips = indexBy_(rows_('RECIPIENTS', true), 'recipientId');
    due.forEach((d) => {
      const r = find_('REQUESTS', 'requestId', d.requestId);
      if (!r || r.status !== 'open' || now - r.lastAlertAt < CONFIG.REALERT_MIN * 60000) return;
      const n = Number(r.realertCount) + 1;
      const silent = splitIds_(r.targets).filter((id) => !latest[r.requestId + '|' + id]);
      update_('REQUESTS', r, { realertCount: n, lastAlertAt: now });
      silent.forEach((id) => {
        const m = ntfyAlarm_(r, recips[id], '[재알림 ' + n + '/' + CONFIG.REALERT_MAX + '] ');
        if (m) msgs.push(m);
      });
      if (silent.length) logs.push([r.requestId, n + '회 · ' + silent.join(',')]);
    });
  });
  logs.forEach((l) => audit_(sess, 'realert', l[0], 'ok', l[1]));
  return msgs;
}

/** 상황관리자: 순찰차 상태 변경 */
function setPatrolStatus(token, recipientId, status) {
  const sess = auth_(token, ['admin', 'dispatcher']);
  if (CONFIG.PATROL_STATUS.indexOf(status) < 0) throw new Error('잘못된 상태입니다.');
  withLock_(() => setPatrol_(recipientId, status));
  audit_(sess, 'patrol_status', recipientId, 'ok', status);
  return true;
}

/** 수신자 목록 (직원 공통 · 토큰/토픽 제외 · 삭제된 수신자 제외). seq = 유형별 순번 (IN-004 → 4) */
function listRecipients(token) {
  const sess = auth_(token);
  return rows_('RECIPIENTS').filter((x) => x.active !== 'D').map((x) => {
    const o = stripRow_(x);
    o.seq = recipientSeq_(x.recipientId);
    if (sess.role !== 'admin') { delete o.token; delete o.topic; delete o.contact; }
    else o.link = recipientLink_(x.token);
    return o;
  }).sort((a, b) => Object.keys(CONFIG.TYPES).indexOf(a.type) - Object.keys(CONFIG.TYPES).indexOf(b.type) || a.seq - b.seq);
}

/** 유형별 다음 순번 (삭제된 번호도 다시 쓰지 않음) — 관리자 화면의 '＋ 추가' 이름 제안용 */
function nextRecipientSeq(token, type) {
  auth_(token, ['admin']);
  if (!CONFIG.TYPES[type]) throw new Error('잘못된 유형입니다.');
  return recipientSeq_(nextRecipientId_(type));
}

/**
 * 수신자 삭제: 링크를 즉시 무효로 하고 목록 · 알림 대상에서 뺀다.
 * 시트 행은 지우지 않는다 (지난 요청 · 응답 · 감사기록에 이름이 남도록, 순번도 다시 쓰지 않도록).
 */
function deleteRecipient(token, recipientId) {
  const sess = auth_(token, ['admin']);
  let name = '';
  withLock_(() => {
    const r = find_('RECIPIENTS', 'recipientId', recipientId);
    if (!r || r.active === 'D') throw new Error('이미 삭제되었거나 없는 수신자입니다.');
    const busy = rows_('REQUESTS', true).some((q) => q.status === 'assigned' && q.assignedTo === recipientId);
    if (busy) throw new Error('처리 중인 배정 요청이 있어 삭제할 수 없습니다. 완료 · 취소 후 삭제하세요.');
    name = r.name;
    update_('RECIPIENTS', r, { active: 'D', token: randomToken_(), status: '' });
  });
  audit_(sess, 'recipient_delete', recipientId, 'ok', name);
  return true;
}

function recipientSeq_(id) {
  return Number(String(id).split('-')[1]) || 0;
}

/* ======================================================================
 * 관리자: 사용자 · 수신자 · 감사기록
 * ==================================================================== */

function listUsers(token) {
  auth_(token, ['admin']);
  return rows_('USERS').map((u) => ({ userId: u.userId, name: u.name, org: u.org, role: u.role, active: u.active, createdAt: u.createdAt }));
}

/** 사용자 추가 · 수정. 새 사용자이거나 resetPin 이면 새 PIN 을 한 번만 돌려준다 */
function saveUser(token, data) {
  const sess = auth_(token, ['admin']);
  const userId = clean_(data.userId, 30).toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(userId)) throw new Error('아이디는 영문 소문자·숫자 3~30자입니다.');
  const role = CONFIG.ROLES[data.role] ? data.role : 'officer';
  const patch = { name: clean_(data.name, 30), org: clean_(data.org, 40), role: role, active: data.active === 'N' ? 'N' : 'Y' };
  if (!patch.name) throw new Error('이름을 입력하세요.');
  let pin = '';
  withLock_(() => {
    const u = find_('USERS', 'userId', userId);
    if (u) {
      if (u.userId === sess.userId && (patch.role !== 'admin' || patch.active !== 'Y')) throw new Error('본인 관리자 권한은 해제할 수 없습니다.');
      if (data.resetPin) {
        const p = newPin_();
        pin = p.pin;
        patch.pinHash = p.pinHash;
        patch.salt = p.salt;
      }
      update_('USERS', u, patch);
    } else {
      const p = newPin_();
      pin = p.pin;
      append_('USERS', Object.assign({ userId: userId, createdAt: Date.now(), pinHash: p.pinHash, salt: p.salt }, patch));
    }
  });
  audit_(sess, 'user_save', userId, 'ok', role + (pin ? ' · PIN 발급' : ''));
  return { userId: userId, pin: pin };
}

function saveRecipient(token, data) {
  const sess = auth_(token, ['admin']);
  const type = CONFIG.TYPES[data.type] ? data.type : null;
  if (!type) throw new Error('유형을 선택하세요.');
  const patch = {
    type: type,
    name: clean_(data.name, 40),
    org: clean_(data.org, 40),
    detail: clean_(data.detail, 100),
    zone: clean_(data.zone, 30),
    contact: clean_(data.contact, 30),
    status: type === 'patrol' ? (CONFIG.PATROL_STATUS.indexOf(data.status) >= 0 ? data.status : '가용') : '',
    active: data.active === 'N' ? 'N' : 'Y',
  };
  if (!patch.name) throw new Error('이름을 입력하세요.');
  let id = clean_(data.recipientId, 20);
  withLock_(() => {
    const r = id && find_('RECIPIENTS', 'recipientId', id);
    if (r) {
      if (r.active === 'D') throw new Error('삭제된 수신자는 수정할 수 없습니다. 새로 추가하세요.');
      patch.type = r.type; // 유형은 바꾸지 않음 (번호 체계 유지)
      if (r.type !== 'patrol') patch.status = '';
      if (data.newToken) patch.token = randomToken_();
      update_('RECIPIENTS', r, patch);
    } else {
      id = nextRecipientId_(type);
      append_('RECIPIENTS', Object.assign({ recipientId: id, topic: newTopic_(), token: randomToken_(), createdAt: Date.now() }, patch));
    }
  });
  audit_(sess, 'recipient_save', id, 'ok', patch.name + (data.newToken ? ' · 링크 재발급' : ''));
  return { recipientId: id };
}

function listAudit(token, limit) {
  auth_(token, ['admin']);
  const all = rows_('AUDIT_LOG', true);
  return all.slice(-Math.min(Number(limit) || 200, 1000)).reverse().map(stripRow_);
}

/* ======================================================================
 * 수신자 (순찰차 · 통역원 · 금융기관 · 유관기관): 개인 링크 ?r=<token>
 * 자기에게 온 요청만 보이고, 외부 기관은 내부용 상세 내용(detail)을 못 본다.
 * ==================================================================== */

function recipientView(rtoken) {
  const me = recipientAuth_(rtoken);
  const now = Date.now();
  const latest = latestResponses_();
  const internal = !!CONFIG.TYPES[me.type].internal;
  const orgs = internal ? {} : orgsByUser_();
  const items = rows_('REQUESTS')
    .filter((r) => splitIds_(r.targets).indexOf(me.recipientId) >= 0)
    .filter((r) => r.status === 'open' || r.assignedTo === me.recipientId || !!latest[r.requestId + '|' + me.recipientId])
    .filter((r) => isActive_(r) || now - r.updatedAt < CONFIG.LIST_HOURS * 3600000)
    .map((r) => {
      const o = publicRequest_(r, internal);
      // 외부 기관에는 요청 경찰관 이름 대신 소속만 (최소정보)
      if (!internal) o.requesterName = orgs[r.requesterId] || '경찰';
      const mine = latest[r.requestId + '|' + me.recipientId];
      o.mine = mine ? { status: mine.status, at: mine.at } : null;
      o.assignedToMe = r.assignedTo === me.recipientId;
      o.assignedOther = !!r.assignedTo && !o.assignedToMe;
      delete o.assignedTo;
      return o;
    })
    .sort((a, b) => b.createdAt - a.createdAt);
  return {
    now: now,
    me: { recipientId: me.recipientId, type: me.type, name: me.name, org: me.org, zone: me.zone, status: me.status },
    ntfy: { topic: me.topic, link: 'ntfy://' + CONFIG.NTFY_SERVER.replace(/^https?:\/\//, '') + '/' + me.topic },
    items: items,
  };
}

/** status: accept | reject (응답 대기 중) · arrived | done (나에게 배정된 뒤) */
function recipientRespond(rtoken, requestId, status, note) {
  const me = recipientAuth_(rtoken);
  if (['accept', 'reject', 'arrived', 'done'].indexOf(status) < 0) throw new Error('잘못된 응답입니다.');
  withLock_(() => {
    const r = find_('REQUESTS', 'requestId', requestId);
    if (!r || splitIds_(r.targets).indexOf(me.recipientId) < 0) throw new Error('요청을 찾을 수 없습니다.');
    const now = Date.now();
    if (status === 'accept' || status === 'reject') {
      if (r.status !== 'open') throw new Error('이미 배정되었거나 종료된 요청입니다.');
    } else {
      if (r.status !== 'assigned' || r.assignedTo !== me.recipientId) throw new Error('나에게 배정된 요청이 아닙니다.');
      if (status === 'done') {
        update_('REQUESTS', r, { status: 'done', doneAt: now, updatedAt: now });
        if (me.type === 'patrol') releasePatrol_(me.recipientId, requestId);
      }
    }
    append_('RESPONSES', { requestId: requestId, recipientId: me.recipientId, status: status, note: clean_(note, 100), at: now });
    if (status !== 'done') update_('REQUESTS', r, { updatedAt: now });
  });
  audit_({ userId: me.recipientId, role: 'recipient' }, 'respond', requestId, 'ok', status);
  return true;
}

/** 순찰차가 스스로 상태 변경 (가용 · 출동중 · 휴식) */
function recipientSetStatus(rtoken, status) {
  const me = recipientAuth_(rtoken);
  if (me.type !== 'patrol' || CONFIG.PATROL_STATUS.indexOf(status) < 0) throw new Error('잘못된 상태입니다.');
  withLock_(() => setPatrol_(me.recipientId, status));
  audit_({ userId: me.recipientId, role: 'recipient' }, 'patrol_status', me.recipientId, 'ok', status);
  return true;
}

function recipientAuth_(rtoken) {
  rtoken = String(rtoken || '');
  if (rtoken.length < 20) throw new Error('RECIPIENT_INVALID');
  const me = rows_('RECIPIENTS').find((x) => x.token === rtoken);
  if (!me || me.active !== 'Y') throw new Error('RECIPIENT_INVALID');
  return me;
}

/* ======================================================================
 * ntfy 메시지 (브라우저가 그대로 ntfy.sh 에 POST)
 * ==================================================================== */

/** 새 요청 · 재알림: 우선순위 5(긴급) 는 '계속 울리기' 대상 */
function ntfyAlarm_(req, rc, prefix) {
  if (!rc || !rc.topic) return null;
  const t = CONFIG.TYPES[req.type];
  const urgent = req.urgency === '긴급';
  return ntfyBody_(rc, req, {
    title: `${prefix}[${req.urgency}] ${t.label} 요청`,
    message: `요청 ${req.requestId}. 이 알림을 누르면 알람이 멈춥니다.`,
    priority: urgent ? 5 : 4,
    tags: urgent ? ['rotating_light', t.tag] : [t.tag],
  });
}

/** 배정 · 재배정 · 취소 안내. 같은 sequence_id 라 울리던 알림이 이 알림으로 바뀐다 */
function ntfyInfo_(req, rc, text, priority) {
  if (!rc || !rc.topic) return null;
  const t = CONFIG.TYPES[req.type];
  return ntfyBody_(rc, req, {
    title: `${t.label} 요청 ${req.requestId}`,
    message: text,
    priority: priority,
    tags: [t.tag],
  });
}

function ntfyBody_(rc, req, m) {
  const url = appUrl_();
  const body = Object.assign({ topic: rc.topic, sequence_id: req.requestId }, m);
  // click 은 넣지 않는다. 알림 본문 → ntfy 화면(알람 멈춤) → 버튼 → 웹앱.
  // 웹앱 주소에 개인 토큰은 넣지 않고(ntfy.sh 에 남으므로), 비밀이 아닌 수신자 번호만 붙인다(?to=IN-005).
  // 화면은 ?to= 가 있으면 관리자 로그인이 남아 있어도 그 브라우저에 등록된 수신자 응답 화면을 연다.
  if (url) body.actions = [{ action: 'view', label: 'PoliceLink 열기', url: url + '?to=' + encodeURIComponent(rc.recipientId), clear: true }];
  return { server: CONFIG.NTFY_SERVER, body: body };
}

/* ======================================================================
 * 설치 · 가상 데이터 (Apps Script 편집기에서 실행)
 * ==================================================================== */

/** 스프레드시트와 7개 시트를 만들고, 첫 관리자 계정을 만든다. 결과(PIN)는 실행 로그에 표시 */
function setup() {
  const props = PropertiesService.getScriptProperties();
  let ss;
  const id = props.getProperty(SHEET_ID_KEY);
  if (id) ss = SpreadsheetApp.openById(id);
  else {
    ss = SpreadsheetApp.create('PoliceLink 데이터 (시험용 · 가상 데이터만)');
    props.setProperty(SHEET_ID_KEY, ss.getId());
  }
  Object.keys(SHEETS).forEach((name) => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const head = SHEETS[name];
    sh.getRange(1, 1, sh.getMaxRows(), head.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#10213f').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  });
  const def = ss.getSheetByName('Sheet1') || ss.getSheetByName('시트1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);
  clearTableCache_();

  const lines = ['스프레드시트: ' + ss.getUrl()];
  if (!rows_('USERS', true).length) {
    const p = newPin_();
    append_('USERS', { userId: 'admin', name: '시스템 관리자', org: '관리', role: 'admin', pinHash: p.pinHash, salt: p.salt, active: 'Y', createdAt: Date.now() });
    lines.push('관리자 계정  아이디: admin   PIN: ' + p.pin + '   ← 지금 적어 두세요 (다시 볼 수 없음)');
  }
  console.log(lines.join('\n'));
  return lines.join('\n');
}

/** setup + 가상 직원 2명 · 가상 수신자 12곳 (이미 있으면 건너뜀) */
function setupDemo() {
  const lines = [setup()];
  if (!find_('USERS', 'userId', 'sit01')) {
    [['sit01', '상황관리 김OO', 'OO경찰서 112상황실', 'dispatcher'], ['p4101', '순경 이OO', 'OO지구대', 'officer']].forEach((u) => {
      const p = newPin_();
      append_('USERS', { userId: u[0], name: u[1], org: u[2], role: u[3], pinHash: p.pinHash, salt: p.salt, active: 'Y', createdAt: Date.now() });
      lines.push(`${CONFIG.ROLES[u[3]]} 계정  아이디: ${u[0]}   PIN: ${p.pin}`);
    });
  }
  if (!rows_('RECIPIENTS', true).length) {
    const demo = [
      ['patrol', '41호', 'OO지구대 1팀', '순찰차 · 2인', 'A구역', '가용'],
      ['patrol', '42호', 'OO지구대 2팀', '순찰차 · 2인', 'B구역', '가용'],
      ['patrol', '43호', 'OO지구대 3팀', '순찰차 · 2인', 'A구역', '출동중'],
      ['interpreter', '통역원 A (가상)', '외국인 통역 인력풀', '영어, 중국어', '', ''],
      ['interpreter', '통역원 B (가상)', '외국인 통역 인력풀', '베트남어', '', ''],
      ['interpreter', '통역원 C (가상)', '외국인 통역 인력풀', '러시아어, 몽골어', '', ''],
      ['interpreter', '통역원 D (가상)', '외국인 통역 인력풀', '영어, 일본어', '', ''],
      ['finance', '가상은행 협조창구', '가상은행 금융사고대응팀', '공식 협조 창구 (가상)', '', ''],
      ['finance', '샘플저축은행 협조창구', '샘플저축은행 준법지원부', '공식 협조 창구 (가상)', '', ''],
      ['agency', '소방 상황실 (가상)', 'OO소방서', '구조 · 구급', '', ''],
      ['agency', '구청 당직실 (가상)', 'OO구청', '행정 지원', '', ''],
      ['agency', '정신건강복지센터 (가상)', 'OO구 정신건강복지센터', '위기 개입', '', ''],
    ];
    demo.forEach((d) => {
      append_('RECIPIENTS', {
        recipientId: nextRecipientId_(d[0]), type: d[0], name: d[1], org: d[2], detail: d[3], zone: d[4],
        contact: '', status: d[5], topic: newTopic_(), token: randomToken_(), active: 'Y', createdAt: Date.now(),
      });
    });
    lines.push('가상 수신자 ' + demo.length + '곳 추가 → 관리자 화면 > 수신자 에서 개인 링크 확인');
  }
  const msg = lines.join('\n');
  console.log(msg);
  return msg;
}

/**
 * 관리자 PIN 을 잊었을 때 (편집기에서 실행): admin 에 새 무작위 PIN 을 만들어 실행 로그에 보여 주고 잠금을 푼다.
 * 로그인한 뒤 화면 위쪽 'PIN 변경' 으로 원하는 PIN 으로 바꾸면 된다.
 */
function resetAdminPin() {
  const p = newPin_();
  withLock_(() => {
    const u = find_('USERS', 'userId', 'admin');
    if (!u) throw new Error('admin 계정이 없습니다. setup 을 실행하세요.');
    update_('USERS', u, { pinHash: p.pinHash, salt: p.salt, active: 'Y', role: 'admin' });
  });
  CacheService.getScriptCache().remove('fail_admin');
  audit_({ userId: 'editor', role: 'admin' }, 'pin_reset', 'admin', 'ok', '편집기 resetAdminPin');
  const msg = '관리자 계정  아이디: admin   새 PIN: ' + p.pin + '   ← 로그인 후 PIN 변경 권장';
  console.log(msg);
  return msg;
}

/** 요청 · 응답 · 배정 · 감사기록을 모두 지운다 (편집기에서 수동 실행. 사용자 · 수신자는 남김) */
function clearRequests() {
  withLock_(() => {
    ['REQUESTS', 'RESPONSES', 'ASSIGNMENTS', 'AUDIT_LOG'].forEach((name) => {
      const sh = sheet_(name);
      if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, SHEETS[name].length).clearContent();
    });
    rows_('RECIPIENTS', true).filter((x) => x.type === 'patrol').forEach((x) => update_('RECIPIENTS', x, { status: '가용' }));
    clearTableCache_();
  });
}

/* ======================================================================
 * 내부: 요청 가공
 * ==================================================================== */

function isActive_(r) {
  return r.status === 'open' || r.status === 'assigned';
}

/** 화면으로 보낼 요청. withDetail=false 이면 내부용 상세 · 요청자 아이디를 뺀다 (외부 기관용 최소 정보) */
function publicRequest_(r, withDetail) {
  const o = {
    requestId: r.requestId, createdAt: r.createdAt, updatedAt: r.updatedAt, type: r.type, urgency: r.urgency,
    location: r.location, zone: r.zone, language: r.language, summary: r.summary, callback: r.callback,
    status: r.status, assignedTo: r.assignedTo, assignedAt: r.assignedAt, doneAt: r.doneAt,
    realertCount: Number(r.realertCount) || 0, requesterName: r.requesterName,
  };
  if (withDetail) { o.detail = r.detail; o.requesterId = r.requesterId; }
  return o;
}

/** 직원 아이디 → 소속 (외부 기관 화면에 이름 대신 표시) */
function orgsByUser_() {
  const m = {};
  rows_('USERS').forEach((u) => (m[u.userId] = u.org));
  return m;
}

/** '요청|수신자' → 가장 최근 응답 */
function latestResponses_(fresh) {
  const map = {};
  rows_('RESPONSES', fresh).forEach((x) => {
    const k = x.requestId + '|' + x.recipientId;
    if (!map[k] || map[k].at <= x.at) map[k] = x;
  });
  return map;
}

function setPatrol_(recipientId, status) {
  const r = find_('RECIPIENTS', 'recipientId', recipientId);
  if (r && r.type === 'patrol' && r.status !== status) update_('RECIPIENTS', r, { status: status });
}

/** 다른 진행 중 임무가 없으면 순찰차를 '가용' 으로 */
function releasePatrol_(recipientId, exceptRequestId) {
  const other = rows_('REQUESTS', true).some((x) => x.status === 'assigned' && x.assignedTo === recipientId && x.requestId !== exceptRequestId);
  if (!other) setPatrol_(recipientId, '가용');
}

function recipientLink_(token) {
  const url = appUrl_();
  return url ? url + '?r=' + token : '(웹앱을 배포하고 한 번 열면 링크가 생깁니다)';
}

function nextRecipientId_(type) {
  const pre = { patrol: 'PT', interpreter: 'IN', finance: 'FN', agency: 'AG' }[type];
  const n = rows_('RECIPIENTS', true).filter((x) => String(x.recipientId).indexOf(pre) === 0)
    .reduce((m, x) => Math.max(m, Number(String(x.recipientId).slice(3)) || 0), 0);
  return pre + '-' + ('00' + (n + 1)).slice(-3);
}

/* ======================================================================
 * 내부: 스프레드시트 표 읽기 · 쓰기 (짧은 캐시 + 쓰기 때 무효화)
 * ==================================================================== */

function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty(SHEET_ID_KEY);
  if (!id) throw new Error('관리자가 아직 setup 을 실행하지 않았습니다.');
  return SpreadsheetApp.openById(id);
}

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('시트가 없습니다: ' + name + ' (setup 을 다시 실행하세요)');
  return sh;
}

/** 표 전체를 객체 배열로. fresh=true 이면 캐시를 건너뛴다 (잠금 안에서 쓰기 전에) */
function rows_(name, fresh) {
  const cache = CacheService.getScriptCache();
  const key = 'tbl_' + name;
  if (!fresh) {
    const hit = cache.get(key);
    if (hit) return JSON.parse(hit);
  }
  const head = SHEETS[name];
  const sh = sheet_(name);
  const last = sh.getLastRow();
  const values = last > 1 ? sh.getRange(2, 1, last - 1, head.length).getValues() : [];
  const list = [];
  values.forEach((v, i) => {
    if (v[0] === '' || v[0] === null) return;
    const o = { _row: i + 2 };
    head.forEach((h, j) => (o[h] = fromCell_(h, v[j])));
    list.push(o);
  });
  try { cache.put(key, JSON.stringify(list), 30); } catch (e) { cache.remove(key); }
  return list;
}

function find_(name, field, value) {
  return rows_(name, true).find((x) => String(x[field]) === String(value)) || null;
}

function append_(name, obj) {
  const head = SHEETS[name];
  const sh = sheet_(name);
  const row = sh.getLastRow() + 1;
  sh.getRange(row, 1, 1, head.length).setNumberFormat('@').setValues([head.map((h) => toCell_(h, obj[h]))]);
  CacheService.getScriptCache().remove('tbl_' + name);
  obj._row = row;
  return obj;
}

function update_(name, obj, patch) {
  Object.assign(obj, patch);
  const head = SHEETS[name];
  sheet_(name).getRange(obj._row, 1, 1, head.length).setValues([head.map((h) => toCell_(h, obj[h]))]);
  CacheService.getScriptCache().remove('tbl_' + name);
  return obj;
}

function clearTableCache_() {
  CacheService.getScriptCache().removeAll(Object.keys(SHEETS).map((n) => 'tbl_' + n));
}

function toCell_(field, v) {
  if (v === undefined || v === null || v === '') return '';
  if (TIME_FIELDS.indexOf(field) >= 0 && typeof v === 'number') return Utilities.formatDate(new Date(v), TZ, 'yyyy-MM-dd HH:mm:ss');
  const s = String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s; // 수식으로 해석되지 않게
}

function fromCell_(field, v) {
  if (v instanceof Date) return v.getTime();
  const s = String(v == null ? '' : v);
  if (TIME_FIELDS.indexOf(field) >= 0) {
    if (!s) return 0;
    const t = new Date(s.replace(' ', 'T') + '+09:00').getTime();
    return isNaN(t) ? 0 : t;
  }
  return s;
}

function stripRow_(x) {
  const o = Object.assign({}, x);
  delete o._row; delete o.pinHash; delete o.salt;
  return o;
}

function audit_(sess, action, target, result, detail) {
  try {
    withLock_(() => append_('AUDIT_LOG', {
      at: Date.now(), actor: sess.userId, role: sess.role, action: action, target: target, result: result, detail: clean_(detail, 200),
    }));
  } catch (e) {
    console.error('audit failed: ' + e);
  }
}

/* ======================================================================
 * 내부: 공통
 * ==================================================================== */

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/** 트리거에서 getUrl()은 /dev 주소를 줄 수 있으므로, 웹앱으로 열렸을 때의 /exec 주소를 저장해 둔다 */
function rememberAppUrl_() {
  try {
    const url = ScriptApp.getService().getUrl() || '';
    if (!/\/exec$/.test(url)) return;
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty(APP_URL_KEY) !== url) props.setProperty(APP_URL_KEY, url);
  } catch (e) {
    console.error('remember url failed: ' + e);
  }
}

function appUrl_() {
  const saved = PropertiesService.getScriptProperties().getProperty(APP_URL_KEY);
  if (saved) return saved;
  const url = ScriptApp.getService().getUrl() || '';
  return /\/exec$/.test(url) ? url : '';
}

function indexBy_(list, field) {
  const m = {};
  list.forEach((x) => (m[x[field]] = x));
  return m;
}

function splitIds_(s) {
  return String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
}

function splitList_(s) {
  return String(s || '').split(/[,·/]/).map((x) => x.trim()).filter(Boolean);
}

function clean_(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

/** 요청번호: 월일-시분-무작위 3자 (예: 1115-1432-K7P). ntfy sequence_id 로도 쓴다 */
function newId_() {
  return Utilities.formatDate(new Date(), TZ, 'MMdd-HHmm') + '-' + randomChars_('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 3);
}

/** 수신자별 ntfy 토픽: 추측하기 어려운 이름 (토픽 = 비밀번호 역할. 저장소 · 문서에 쓰지 말 것) */
function newTopic_() {
  return 'pl-' + randomChars_('abcdefghijkmnpqrstuvwxyz23456789', 20);
}

function newPin_() {
  const pin = randomChars_('0123456789', 6);
  const salt = randomChars_('abcdefghijklmnopqrstuvwxyz0123456789', 16);
  return { pin: pin, salt: salt, pinHash: sha256_(salt + pin) };
}

function randomToken_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

/** Utilities.getUuid() (암호학적 난수) 기반 무작위 문자 */
function randomChars_(chars, n) {
  let s = '';
  while (s.length < n) {
    const hex = Utilities.getUuid().replace(/-/g, '');
    for (let i = 0; i + 2 <= hex.length && s.length < n; i += 2) {
      if (i === 12 || i === 16) continue; // UUID v4 의 고정 비트(버전 · 변형)가 든 바이트는 건너뜀
      const b = parseInt(hex.substr(i, 2), 16);
      if (b < 256 - (256 % chars.length)) s += chars[b % chars.length];
    }
  }
  return s;
}

function sha256_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map((b) => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}
