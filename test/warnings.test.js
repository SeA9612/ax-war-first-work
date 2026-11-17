'use strict';
// 대시보드 경고: 상세용 구조, 해결하면 사라짐(사건 접수·확인 처리), 확인 처리 입력 검증과 감사기록
process.env.NODE_ENV = 'test';
process.env.PERSIST = 'off';
delete process.env.AI_REAL_ENABLED;
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine');

const allOf = (s) => E.warningList(s, Object.values(E.judge(s).judgments));
const listOf = (s) => allOf(s).filter((w) => w.status === '열림');

test('초기 상태 경고: QC 보류 출하 2건 + 사건 미접수 2건, 각 경고에 id·종류·해결 방법', () => {
  const w = listOf(E.newState());
  assert.deepEqual(w.map((x) => x.id).sort(), ['HOLD_SHIP:B-02-2602-01', 'HOLD_SHIP:B-02-2603-01', 'NOCASE:B-02-2602-01', 'NOCASE:B-02-2603-01']);
  w.forEach((x) => { assert.ok(x.kind && x.batch_id && x.text && x.resolve); });
});

test('사건을 접수하면 사건 미접수 경고가 사라진다', () => {
  const s = E.newState();
  E.createCase(s, { batch_ids: ['B-02-2602-01', 'B-02-2603-01'] });
  const ids = listOf(s).map((x) => x.id);
  assert.ok(!ids.some((id) => id.startsWith('NOCASE:')));
  assert.equal(ids.filter((id) => id.startsWith('HOLD_SHIP:')).length, 2);
});

test('QC 보류 출하 경고: 사유를 적어 확인 처리하면 사라지고 감사기록이 남는다', () => {
  const s = E.newState();
  const before = s.audit.length;
  E.ackWarning(s, 'HOLD_SHIP:B-02-2602-01', '출하 통제 기록 확인을 원인조사 담당에게 요청');
  const ids = listOf(s).map((x) => x.id);
  assert.ok(!ids.includes('HOLD_SHIP:B-02-2602-01'));
  assert.ok(ids.includes('HOLD_SHIP:B-02-2603-01'));
  assert.equal(s.audit.length, before + 1);
  assert.equal(s.audit[s.audit.length - 1].action, '경고 확인 처리');
});

test('확인 처리 검증: 짧은 사유·다른 종류·없는 배치·중복은 거절, 판정은 바뀌지 않음', () => {
  const s = E.newState();
  const status = () => E.judge(s).judgments['B-02-2602-01'].status;
  const st = status();
  assert.throws(() => E.ackWarning(s, 'HOLD_SHIP:B-02-2602-01', '짧음'), (e) => e.status === 400);
  assert.throws(() => E.ackWarning(s, 'NOCASE:B-02-2602-01', '사건 없이 확인만 하려는 시도'), (e) => e.status === 400);
  assert.throws(() => E.ackWarning(s, 'HOLD_SHIP:B-02-2508-03', '보류가 아닌 배치에 대한 확인'), (e) => e.status === 404);
  E.ackWarning(s, 'HOLD_SHIP:B-02-2602-01', '확인 완료 — 원인조사로 이관');
  assert.throws(() => E.ackWarning(s, 'HOLD_SHIP:B-02-2602-01', '두 번째 확인 시도입니다'), (e) => e.status === 409);
  assert.equal(status(), st);
});

test('초기화(새 상태)하면 확인 처리 기록도 없어져 경고가 다시 보인다', () => {
  const s = E.newState();
  E.ackWarning(s, 'HOLD_SHIP:B-02-2602-01', '확인 완료 — 원인조사로 이관');
  const fresh = E.newState();
  assert.ok(listOf(fresh).some((x) => x.id === 'HOLD_SHIP:B-02-2602-01'));
});

test('경고 상태: 사건 접수 → 해결됨(자동·사건 번호), 확인 처리 → 확인됨(사람·사유), 처리 이력 보존', () => {
  const s = E.newState();
  const c = E.createCase(s, { batch_ids: ['B-02-2602-01', 'B-02-2603-01'] });
  E.ackWarning(s, 'HOLD_SHIP:B-02-2602-01', '출하 통제 기록 확인을 원인조사 담당에게 요청');
  const by = Object.fromEntries(allOf(s).map((w) => [w.id, w]));
  assert.equal(by['NOCASE:B-02-2602-01'].status, '해결됨');
  assert.equal(by['NOCASE:B-02-2602-01'].handled.how, `${c.id} 사건 접수`);
  assert.equal(by['NOCASE:B-02-2602-01'].handled.by, '자동');
  assert.equal(by['HOLD_SHIP:B-02-2602-01'].status, '확인됨');
  assert.equal(by['HOLD_SHIP:B-02-2602-01'].handled.note, '출하 통제 기록 확인을 원인조사 담당에게 요청');
  assert.equal(by['HOLD_SHIP:B-02-2603-01'].status, '열림');
  assert.equal(by['HOLD_SHIP:B-02-2603-01'].handled, null);
});

test('분모 민감 경고: 시나리오 ②에서 정정 후 열림 → 상신하면 해결됨', async () => {
  const SC = require('../src/scenarios');
  const s = E.newState();
  s.scenario = { id: 2, next: 0, results: [] };
  let sawOpen = false; let sawResolved = false;
  for (let i = 0; i < SC.SCENARIOS[2].steps.length; i += 1) {
    await SC.runStep(s, 2);
    allOf(s).filter((w) => w.kind === 'sens').forEach((w) => {
      if (w.status === '열림') sawOpen = true;
      if (w.status === '해결됨') { sawResolved = true; assert.match(w.handled.how, /상신 v\d+/); }
    });
  }
  assert.ok(sawOpen, '분모 민감 경고가 열린 적이 있어야 함');
  assert.ok(sawResolved, '상신 후 해결됨이 되어야 함');
});

test('변경 번호(rev): 저장·초기화마다 달라진다', () => {
  const store = require('../src/store');
  store.reset();
  const a = store.rev();
  store.save();
  const b = store.rev();
  store.reset();
  const c = store.rev();
  assert.notEqual(a, b);
  assert.notEqual(b, c);
});

test('이벤트 흐름: 최신순, 같은 순간 반복 기록은 한 줄로 묶고 건수 표시, 개수 제한', async () => {
  const SC = require('../src/scenarios');
  const s = E.newState();
  s.scenario = { id: 1, next: 0, results: [] };
  for (let i = 0; i < SC.SCENARIOS[1].steps.length; i += 1) await SC.runStep(s, 1);
  const all = E.feedList(s, 200);
  assert.equal(all.reduce((n, g) => n + g.count, 0), s.audit.length, '묶음 건수 합 = 감사기록 수');
  assert.ok(all.length < s.audit.length, '묶여서 줄 수가 줄어야 함');
  for (let i = 1; i < all.length; i += 1) assert.ok(all[i - 1].at >= all[i].at, '최신순');
  assert.ok(all.some((g) => g.action === '작업 생성' && g.count > 1));
  assert.equal(E.feedList(s, 5).length, 5);
  assert.ok(all.every((g) => ['입력', '판정', '처리', '모의 AI', '자동'].includes(g.kind)));
});

test('이벤트 흐름: 시나리오 ②의 판정 변경 감지(J6)는 문제 신호(alert)로 표시', async () => {
  const SC = require('../src/scenarios');
  const s = E.newState();
  s.scenario = { id: 2, next: 0, results: [] };
  for (let i = 0; i < SC.SCENARIOS[2].steps.length; i += 1) await SC.runStep(s, 2);
  const all = E.feedList(s, 200);
  assert.ok(all.some((g) => g.alert && /판정 변경 감지/.test(g.action)));
  assert.ok(all.filter((g) => g.alert).length < all.length / 2, '문제 신호는 일부만');
});

test('규칙 적중 현황: 판정 규칙 수가 판정 현황과 같고, J7 회수 범위에 C-105 미확인 포함', () => {
  const s = E.newState();
  const hits = Object.fromEntries(E.ruleHits(s).map((r) => [r.rule + ':' + (r.filter || r.name), r]));
  const counts = {};
  Object.values(E.judge(s).judgments).forEach((j) => { counts[j.status] = (counts[j.status] || 0) + 1; });
  ['회수 대상', '분모 민감', '조사·소명', '예방 점검'].forEach((st) => {
    const r = E.ruleHits(s).find((x) => x.filter === st);
    assert.equal(r.count, counts[st] || 0, st);
  });
  assert.deepEqual(hits['J2:회수 대상'].batches, ['B-02-2602-01', 'B-02-2603-01']);
  const j7 = E.ruleHits(s).find((r) => r.rule === 'J7');
  assert.ok(j7.count > 0 && j7.unverified.includes('C-105'));
  assert.equal(E.ruleHits(s).find((r) => r.rule === 'J3').count, 0);
});

test('규칙 적중 현황: 시나리오 ① 후 J3 의결 2배치·J4 보도 1건, 확장 끄면 예방 점검 0·꺼짐 표시', async () => {
  const SC = require('../src/scenarios');
  const s = E.newState();
  s.scenario = { id: 1, next: 0, results: [] };
  for (let i = 0; i < SC.SCENARIOS[1].steps.length; i += 1) await SC.runStep(s, 1);
  const by = (rule) => E.ruleHits(s).find((r) => r.rule === rule);
  assert.equal(by('J3').count, 2);
  assert.equal(by('J4').count, 1);
  const off = E.newState(); off.settings.extensionOn = false;
  const prev = E.ruleHits(off).find((r) => r.filter === '예방 점검');
  assert.equal(prev.count, 0);
  assert.equal(prev.off, true);
});

test('클레임 추이: 마지막 값 = 판정 생산 기준 불량률, 10% 도달일 앞뒤가 기준과 맞고, 주는 7일 간격', () => {
  const s = E.newState();
  const t = E.claimTrend(s);
  assert.deepEqual(t.series.map((x) => x.batch_id), ['B-02-2602-01', 'B-02-2603-01']);
  const J = E.judge(s).judgments;
  for (let i = 1; i < t.weeks.length; i += 1) assert.equal((Date.parse(t.weeks[i]) - Date.parse(t.weeks[i - 1])) / 86400000, 7);
  t.series.forEach((x) => {
    const last = x.points[x.points.length - 1];
    assert.ok(Math.abs(last.rate - J[x.batch_id].rateP) < 1e-6, x.batch_id);
    assert.ok(x.crossed_on, '회수 대상은 10% 도달일이 있어야 함');
    const before = x.points.filter((p) => p.week < x.crossed_on);
    before.forEach((p) => assert.ok(p.rate < 0.1 || p.week >= x.crossed_on));
    for (let i = 1; i < x.points.length; i += 1) assert.ok(x.points[i].rate >= x.points[i - 1].rate, '누적은 줄지 않음');
  });
});

test('클레임 추이: 시나리오 ② 정정 후에도 사건 배치는 남고, 마지막 값이 정정된 판정(9.01%)과 같음', async () => {
  const SC = require('../src/scenarios');
  const s = E.newState();
  s.scenario = { id: 2, next: 0, results: [] };
  for (let i = 0; i < SC.SCENARIOS[2].steps.length; i += 1) await SC.runStep(s, 2);
  const t = E.claimTrend(s);
  const x = t.series.find((y) => y.batch_id === 'B-02-2602-01');
  assert.ok(x, '사건 배치는 추이에 남아야 함');
  const J = E.judge(s).judgments['B-02-2602-01'];
  assert.ok(Math.abs(x.points[x.points.length - 1].rate - J.rateP) < 1e-6);
  assert.equal((J.rateP * 100).toFixed(2), '9.01');
});

test('번호 이름표(/api/names): 원본 마스터에서 로트·고객·제품 한글 이름', async () => {
  const http = require('http');
  const { createServer } = require('../server');
  const srv = createServer().listen(0);
  try {
    const port = srv.address().port;
    const body = await new Promise((resolve, reject) => http.get({ port, path: '/api/names' }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject));
    assert.deepEqual(body.lots['LOT-B-2602-P'], { material: '특허 활성성분', received: '2026-02', inspection: '보류' });
    assert.equal(body.lots['LOT-A-2412-1'].material, '히알루론산');
    assert.equal(body.customers['C-101'], '뷰티메가리테일');
    assert.equal(body.products['PL-02'], '더마');
  } finally { srv.close(); }
});
