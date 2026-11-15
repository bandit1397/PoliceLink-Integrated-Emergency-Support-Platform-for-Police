// Apps Script 서비스 모의 환경에서 Code.gs 흐름 시험 — 실행: node tests/test_server.js
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');
const assert = require('assert');

const src = fs.readFileSync(process.argv[2] || require('path').join(__dirname, '..', 'Code.gs'), 'utf8');
let clock = Date.parse('2026-11-15T10:00:00+09:00');
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(clock); }
  static now() { return clock; }
}

function makeSheet(name) {
  const data = [];
  return {
    name, data,
    getMaxRows: () => 1000,
    getLastRow: () => { for (let i = data.length - 1; i >= 0; i--) if (data[i] && data[i].some((v) => v !== '')) return i + 1; return 0; },
    getRange: (r, c, nr, nc) => ({
      setNumberFormat() { return this; },
      setFontWeight() { return this; }, setBackground() { return this; }, setFontColor() { return this; },
      setValues(vals) {
        vals.forEach((row, i) => {
          data[r - 1 + i] = data[r - 1 + i] || [];
          row.forEach((v, j) => {
            let x = v;
            if (typeof x === 'string' && x[0] === "'") x = x.slice(1);
            else if (typeof x === 'string' && x[0] === '=') throw new Error('formula written: ' + x);
            data[r - 1 + i][c - 1 + j] = x;
          });
        });
        return this;
      },
      getValues() {
        const out = [];
        for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push(((data[r - 1 + i] || [])[c - 1 + j]) ?? ''); out.push(row); }
        return out;
      },
      clearContent() { for (let i = 0; i < nr; i++) data[r - 1 + i] = []; return this; },
    }),
    setFrozenRows() {},
  };
}
const sheets = {};
const ss = {
  getId: () => 'SSID', getUrl: () => 'https://docs/SSID',
  getSheetByName: (n) => sheets[n] || null,
  insertSheet: (n) => (sheets[n] = makeSheet(n)),
  getSheets: () => Object.values(sheets),
  deleteSheet: (s) => delete sheets[s.name],
};
sheets['Sheet1'] = makeSheet('Sheet1');
const props = {};
const cache = {};
let logs = [];
const ctx = {
  Date: FakeDate, console: { log: (m) => logs.push(m), error: (m) => logs.push('ERR ' + m) }, JSON, Math, String, Number, Object, Array, isNaN, parseInt, Error,
  SpreadsheetApp: { create: () => ss, openById: () => ss },
  PropertiesService: { getScriptProperties: () => ({
    getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => (props[k] = String(v)),
    getProperties: () => ({ ...props }), deleteProperty: (k) => delete props[k] }) },
  CacheService: { getScriptCache: () => ({
    get: (k) => (k in cache ? cache[k] : null), put: (k, v) => { if (v.length > 100000) throw new Error('too big'); cache[k] = v; },
    remove: (k) => delete cache[k], removeAll: (ks) => ks.forEach((k) => delete cache[k]) }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/XYZ/exec' }) },
  HtmlService: { createHtmlOutputFromFile: () => ({ setTitle() { return this; }, addMetaTag() { return this; } }) },
  Utilities: {
    getUuid: () => crypto.randomUUID(),
    formatDate: (d, tz, fmt) => {
      const k = new RealDate(d.getTime() + 9 * 3600000);
      const p = (n) => ('0' + n).slice(-2);
      return fmt.replace('yyyy', k.getUTCFullYear()).replace('MM', p(k.getUTCMonth() + 1)).replace('dd', p(k.getUTCDate()))
        .replace('HH', p(k.getUTCHours())).replace('mm', p(k.getUTCMinutes())).replace('ss', p(k.getUTCSeconds()));
    },
    computeDigest: (alg, s) => [...crypto.createHash('sha256').update(s, 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
    DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 },
  },
};
vm.createContext(ctx);
vm.runInContext(src, ctx);
const G = ctx;
const throws = (fn, re) => { try { fn(); } catch (e) { assert(re.test(e.message), 'unexpected error: ' + e.message); return; } throw new Error('expected throw ' + re); };

// 설치
G.doGet();
const out = G.setupDemo();
console.log(out);
const pins = {};
out.split('\n').forEach((l) => { const m = l.match(/아이디: (\S+)\s+PIN: (\d{6})/); if (m) pins[m[1]] = m[2]; });
assert(pins.admin && pins.sit01 && pins.p4101, 'pins');
assert(!sheets['Sheet1'], 'default sheet removed');
assert.strictEqual(G.setupDemo().includes('PIN'), false, 'idempotent');

// 로그인
throws(() => G.login('admin', '000000x'), /올바르지/);
const admin = G.login('admin', pins.admin).token;
const disp = G.login('sit01', pins.sit01).token;
const off = G.login('P4101', pins.p4101).token; // 대소문자 무관
throws(() => G.dashboard('bogus'), /SESSION_EXPIRED/);

// 수신자 목록: 관리자만 토큰/링크
const rAdmin = G.listRecipients(admin);
const rOff = G.listRecipients(off);
assert(rAdmin[0].token && rAdmin[0].link.includes('?r='), 'admin sees link');
assert(!rOff[0].token && !rOff[0].topic, 'officer no token');
const tok = (name) => rAdmin.find((x) => x.name === name).token;

// 순찰차 추천: A구역 긴급 → 41호(가용·A) 1순위, 42호(가용) 2순위, 43호(출동중) 미선택
const cands = G.candidates(off, 'patrol', { zone: 'A구역', urgency: '긴급' });
assert.deepStrictEqual(cands.map((c) => c.name), ['41호', '42호', '43호']);
assert.deepStrictEqual(cands.map((c) => c.recommended), [true, true, false]);
const interp = G.candidates(off, 'interpreter', { language: '영어' });
assert.deepStrictEqual(interp.map((c) => c.name).sort(), ['통역원 A (가상)', '통역원 D (가상)']);

// 요청 생성 (현장 경찰관) + 수식 주입 방어
const created = G.createRequest(off, { type: 'patrol', urgency: '긴급', location: '=HYPERLINK("x")', zone: 'A구역',
  summary: '가상 상황: 주취자 소란 지원', detail: '내부 메모', callback: '02-000-0000', targets: cands.slice(0, 2).map((c) => c.recipientId).concat(['FN-001']) });
assert.strictEqual(created.ntfy.length, 2, 'FN-001 filtered out (type mismatch)');
const n0 = created.ntfy[0].body;
assert.strictEqual(n0.priority, 5); assert.strictEqual(n0.sequence_id, created.requestId);
assert(!('click' in n0), 'no click'); assert(/\/exec\?to=PT-00[12]$/.test(n0.actions[0].url) && !n0.actions[0].url.includes('?r='), 'url has recipient id, no token: ' + n0.actions[0].url);
assert(!JSON.stringify(n0).includes('주취자') && !JSON.stringify(n0).includes('A구역'), 'no case detail in ntfy');
const id = created.requestId;
const reqRow = G.find_('REQUESTS', 'requestId', id);
assert.strictEqual(reqRow.location, '=HYPERLINK("x")', 'stored as text');

// 경찰관은 자기 요청만, 배정 권한 없음
assert.strictEqual(G.dashboard(off).items.length, 1);
throws(() => G.assign(off, id, 'PT-001'), /권한/);

// 수신자: 41호 화면 — 내부(순찰차)라 detail 보임
const t41 = tok('41호'), t42 = tok('42호'), tBank = tok('가상은행 협조창구');
let v41 = G.recipientView(t41);
assert.strictEqual(v41.items.length, 1); assert.strictEqual(v41.items[0].detail, '내부 메모');
assert.strictEqual(G.recipientView(tBank).items.length, 0, 'bank sees nothing');
throws(() => G.recipientRespond(tBank, id, 'accept'), /찾을 수 없/);
throws(() => G.recipientView('x'.repeat(40)), /RECIPIENT_INVALID/);

// 배정은 수락한 대상만
throws(() => G.assign(disp, id, 'PT-001'), /수락한 대상만/);
G.recipientRespond(t41, id, 'accept');
G.recipientRespond(t42, id, 'reject');
throws(() => G.recipientRespond(t41, id, 'arrived'), /배정된 요청이 아닙니다/);
const as = G.assign(disp, id, 'PT-001');
assert.strictEqual(as.ntfy.length, 1); assert.strictEqual(as.ntfy[0].body.priority, 4);
let d = G.dashboard(disp);
assert.strictEqual(d.items[0].status, 'assigned');
assert.strictEqual(d.patrols.find((p) => p.name === '41호').status, '출동중');
throws(() => G.recipientRespond(t42, id, 'accept'), /이미 배정/);
// 배정 후 42호(거절) 화면에도 남아 '다른 대상' 표시
const v42 = G.recipientView(t42); assert(v42.items[0].assignedOther);

// 추천이 바뀜: 41호 출동중 → 42호가 1순위
assert.strictEqual(G.candidates(off, 'patrol', { zone: 'A구역', urgency: '보통' })[0].name, '42호');

// 수신자가 도착 → 완료 → 순찰차 가용 복귀
G.recipientRespond(t41, id, 'arrived');
G.recipientRespond(t41, id, 'done');
d = G.dashboard(disp);
assert.strictEqual(d.items[0].status, 'done');
assert.strictEqual(d.patrols.find((p) => p.name === '41호').status, '가용');
throws(() => G.closeRequest(disp, id, 'done'), /이미 종료/);

// 통역 요청: 외부 기관이라 detail 안 보임 · 재알림
const ci = G.createRequest(disp, { type: 'interpreter', urgency: '보통', language: '영어', summary: '가상: 진술 통역', detail: '비밀 내부', targets: interp.map((c) => c.recipientId) });
assert.strictEqual(ci.ntfy[0].body.priority, 4);
const tA = tok('통역원 A (가상)');
const vA = G.recipientView(tA);
assert.strictEqual(vA.items[0].detail, undefined, 'external no detail');
assert.strictEqual(vA.items[0].requesterId, undefined);
assert(vA.ntfy.link.startsWith('ntfy://ntfy.sh/pl-'));
G.recipientRespond(tA, ci.requestId, 'accept');
assert.strictEqual(G.pendingRealerts(disp).length, 0, 'not yet');
throws(() => G.pendingRealerts(off), /권한/);
clock += 3 * 60000;
let ra = G.pendingRealerts(disp);
assert.strictEqual(ra.length, 1, 'only D (no response) realerted');
assert(ra[0].body.title.startsWith('[재알림 1/3]'));
assert.strictEqual(G.pendingRealerts(disp).length, 0, 'no duplicate');
clock += 3 * 60000; G.pendingRealerts(disp); clock += 3 * 60000; G.pendingRealerts(disp); clock += 3 * 60000;
assert.strictEqual(G.pendingRealerts(disp).length, 0, 'max 3');

// 취소: 경찰관은 남의 요청 취소 불가, 취소 시 조용한 알림
throws(() => G.closeRequest(off, ci.requestId, 'cancelled'), /권한/);
const cc = G.closeRequest(disp, ci.requestId, 'cancelled');
assert.strictEqual(cc.ntfy.length, 2); assert.strictEqual(cc.ntfy[0].body.priority, 2);

// 관리자: 계정 · PIN 재발급 · 수신자 링크 재발급
throws(() => G.listUsers(disp), /권한/);
const nu = G.saveUser(admin, { userId: 'sit02', name: '상황 박OO', org: '112', role: 'dispatcher' });
assert(/^\d{6}$/.test(nu.pin));
assert(G.login('sit02', nu.pin).token);
const rp = G.saveUser(admin, { userId: 'sit02', name: '상황 박OO', org: '112', role: 'dispatcher', resetPin: true });
throws(() => G.login('sit02', nu.pin), /올바르지/);
assert(G.login('sit02', rp.pin).token);
throws(() => G.saveUser(admin, { userId: 'admin', name: 'x', role: 'officer' }), /본인 관리자/);
G.saveRecipient(admin, Object.assign({}, rAdmin.find((x) => x.name === '41호'), { newToken: true }));
throws(() => G.recipientView(t41), /RECIPIENT_INVALID/);
const nr = G.saveRecipient(admin, { type: 'agency', name: '가상 보건소', org: 'OO구' });
assert.strictEqual(nr.recipientId, 'AG-004');

// 로그인 잠금
for (let i = 0; i < 5; i++) { try { G.login('p4101', 'bad'); } catch (e) {} }
throws(() => G.login('p4101', pins.p4101), /잠겼/);

// 상황관리자 처리 완료 (금융기관: 접수 확인 → 배정 → 완료)
const cf = G.createRequest(disp, { type: 'finance', urgency: '긴급', summary: '가상: 협조 요청 접수 확인', targets: ['FN-001'] });
G.recipientRespond(tBank, cf.requestId, 'accept');
G.assign(disp, cf.requestId, 'FN-001');
assert.strictEqual(G.closeRequest(disp, cf.requestId, 'done').ntfy.length, 0);
assert.strictEqual(G.recipientView(tBank).items[0].status, 'done');
// 24시간 지나면 상황판에서 사라짐
clock += 25 * 3600000;
assert.strictEqual(G.dashboard(admin).items.length, 0);

// 감사기록
const au = G.listAudit(admin, 500);
const acts = new Set(au.map((a) => a.action));
['login', 'create', 'assign', 'respond', 'complete', 'cancel', 'realert', 'user_save', 'recipient_save'].forEach((a) => assert(acts.has(a), 'audit ' + a));
assert(!JSON.stringify(G.listUsers(admin)).includes('pinHash'));

// 시간 저장 형식
assert(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(sheets.REQUESTS.data[1][1]), 'time format ' + sheets.REQUESTS.data[1][1]);
assert.strictEqual(G.find_('REQUESTS', 'requestId', id).createdAt, Date.parse('2026-11-15T10:00:00+09:00'));

// 본인 PIN 변경 · 관리자 PIN 초기화
{
  const s = G.login('sit02', rp.pin).token;
  throws(() => G.changePin(s, '000000', '482913'), /현재 PIN/);
  throws(() => G.changePin(s, rp.pin, '12345'), /6~12/);
  throws(() => G.changePin(s, rp.pin, '111111'), /반복이나 연속/);
  throws(() => G.changePin(s, rp.pin, '234567'), /반복이나 연속/);
  throws(() => G.changePin(s, rp.pin, '987654'), /반복이나 연속/);
  throws(() => G.changePin(s, rp.pin, rp.pin), /다른 PIN/);
  G.changePin(s, rp.pin, '482913');
  throws(() => G.login('sit02', rp.pin), /올바르지/);
  assert(G.login('sit02', '482913').token);
  throws(() => G.changePin('bogus', '482913', '590174'), /SESSION_EXPIRED/);
  // 현재 PIN 5번 틀리면 잠김
  for (let i = 0; i < 5; i++) { try { G.changePin(s, '000000', '590174'); } catch (e) {} }
  throws(() => G.changePin(s, '482913', '590174'), /잠겼/);
  // resetAdminPin: 새 PIN 으로 로그인, 옛 PIN 거부
  const msg = G.resetAdminPin();
  const np = msg.match(/새 PIN: (\d{6})/)[1];
  throws(() => G.login('admin', pins.admin), /올바르지/);
  assert(G.login('admin', np).token);
  pins.admin = np;
  const acts = G.listAudit(G.login('admin', np).token, 50).map((a) => a.action);
  assert(acts.includes('pin_change') && acts.includes('pin_reset'));
}

// 순번 · 추가 · 삭제
{
  assert.strictEqual(G.nextRecipientSeq(admin, 'interpreter'), 5);
  throws(() => G.nextRecipientSeq(disp, 'interpreter'), /권한/);
  const add5 = G.saveRecipient(admin, { type: 'interpreter', name: '통역원 5', detail: '태국어' });
  assert.strictEqual(add5.recipientId, 'IN-005');
  let list = G.listRecipients(admin);
  const in5 = list.find((x) => x.recipientId === 'IN-005');
  assert.strictEqual(in5.seq, 5);
  assert.deepStrictEqual([...list.filter((x) => x.type === 'interpreter').map((x) => x.seq)], [1, 2, 3, 4, 5], 'sorted by seq');
  assert(G.recipientView(in5.token));
  // 유형 바꾸기 시도 → 유형 유지
  G.saveRecipient(admin, { recipientId: 'IN-005', type: 'finance', name: '통역원 5', detail: '태국어' });
  assert.strictEqual(G.find_('RECIPIENTS', 'recipientId', 'IN-005').type, 'interpreter');
  // 삭제 → 링크 무효, 목록 · 후보 제외, 번호 재사용 안 함
  G.deleteRecipient(admin, 'IN-005');
  throws(() => G.recipientView(in5.token), /RECIPIENT_INVALID/);
  list = G.listRecipients(admin);
  assert(!list.some((x) => x.recipientId === 'IN-005'));
  assert(!G.candidates(off, 'interpreter', { language: '태국어' }).length);
  throws(() => G.deleteRecipient(admin, 'IN-005'), /이미 삭제/);
  throws(() => G.saveRecipient(admin, { recipientId: 'IN-005', type: 'interpreter', name: 'x' }), /삭제된 수신자/);
  assert.strictEqual(G.nextRecipientSeq(admin, 'interpreter'), 6, 'no reuse');
  assert.strictEqual(G.saveRecipient(admin, { type: 'interpreter', name: '통역원 6' }).recipientId, 'IN-006');
  throws(() => G.deleteRecipient(disp, 'IN-006'), /권한/);
  // 배정 중이면 삭제 거부
  const q = G.createRequest(disp, { type: 'interpreter', urgency: '보통', summary: '가상', targets: ['IN-006'] });
  const t6 = G.listRecipients(admin).find((x) => x.recipientId === 'IN-006').token;
  G.recipientRespond(t6, q.requestId, 'accept');
  G.assign(disp, q.requestId, 'IN-006');
  throws(() => G.deleteRecipient(admin, 'IN-006'), /처리 중인 배정/);
  G.closeRequest(disp, q.requestId, 'done');
  G.deleteRecipient(admin, 'IN-006');
  // 지난 요청의 상황판에는 이름이 그대로 남음
  assert.strictEqual(G.dashboard(admin).items.find((r) => r.requestId === q.requestId).targets[0].name, '통역원 6');
  assert(G.listAudit(admin, 50).some((a) => a.action === 'recipient_delete'));
}

// 기관별 분리: 유형마다 요청 1건씩 → 각 수신자는 자기에게 온 것만, 다른 수신자 이름 · 내부 메모 없음
G.clearRequests();
const all = G.listRecipients(admin);
const byName = (n) => all.find((x) => x.name === n);
const sent = {
  interpreter: G.createRequest(disp, { type: 'interpreter', urgency: '긴급', language: '영어', summary: '가상 통역 요청', detail: 'SECRET-I', targets: [byName('통역원 A (가상)').recipientId] }).requestId,
  finance: G.createRequest(disp, { type: 'finance', urgency: '긴급', summary: '가상 금융 협조', detail: 'SECRET-F', targets: [byName('가상은행 협조창구').recipientId] }).requestId,
  agency: G.createRequest(disp, { type: 'agency', urgency: '보통', summary: '가상 기관 지원', detail: 'SECRET-A', targets: [byName('소방 상황실 (가상)').recipientId, byName('구청 당직실 (가상)').recipientId] }).requestId,
};
const view = (n) => G.recipientView(byName(n).token);
const ids = (v) => [...v.items.map((r) => r.requestId)];
assert.deepStrictEqual(ids(view('통역원 A (가상)')), [sent.interpreter]);
assert.deepStrictEqual(ids(view('통역원 B (가상)')), [], 'other interpreter not targeted');
assert.deepStrictEqual(ids(view('가상은행 협조창구')), [sent.finance]);
assert.deepStrictEqual(ids(view('샘플저축은행 협조창구')), [], 'other bank sees nothing');
assert.deepStrictEqual(ids(view('소방 상황실 (가상)')), [sent.agency]);
assert.deepStrictEqual(ids(view('정신건강복지센터 (가상)')), [], 'untargeted agency');
['통역원 A (가상)', '가상은행 협조창구', '소방 상황실 (가상)'].forEach((n) => {
  const j = JSON.stringify(view(n));
  assert(!/SECRET-/.test(j), 'no internal memo for ' + n);
  all.filter((x) => x.name !== n).forEach((o) => assert(!j.includes(o.name) && !j.includes(o.token), n + ' leaks ' + o.name));
});
// 다른 기관의 요청에 응답 시도 → 거부
throws(() => G.recipientRespond(byName('가상은행 협조창구').token, sent.interpreter, 'accept'), /찾을 수 없/);
throws(() => G.recipientRespond(byName('구청 당직실 (가상)').token, sent.finance, 'accept'), /찾을 수 없/);
// 수신자 토큰으로 직원 기능 불가
throws(() => G.dashboard(byName('통역원 A (가상)').token), /SESSION_EXPIRED/);
// 외부 기관: 요청자 이름 대신 소속 / 순찰차(내부): 이름
assert.strictEqual(view('통역원 A (가상)').items[0].requesterName, 'OO경찰서 112상황실');
assert(!JSON.stringify(view('가상은행 협조창구')).includes('상황관리 김OO'), 'no officer name to bank');
const cp = G.createRequest(off, { type: 'patrol', urgency: '보통', summary: '가상 순찰 지원', targets: [byName('42호').recipientId] });
assert.strictEqual(view('42호').items.find((r) => r.requestId === cp.requestId).requesterName, '순경 이OO');
console.log('ISOLATION OK');

G.clearRequests();
assert.strictEqual(G.rows_('REQUESTS', true).length, 0);
assert.strictEqual(G.rows_('USERS', true).length, 4);
console.log('ALL TESTS PASSED');
