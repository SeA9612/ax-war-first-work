'use strict';
// 첫 화면(한눈에 보기): 문제가 있는 칸만 빨간 칸(alert), 지난달 대비 문장, 처리하면 빨간 칸이 풀림
process.env.NODE_ENV = 'test';
process.env.PERSIST = 'off';
delete process.env.AI_REAL_ENABLED;
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine');
const { overview } = require('../src/overview');

const tile = (o, k) => o.tiles.find((t) => t.key === k);

test('초기 상태: 회수 대상 2·경고 4·사건 미접수만 빨간 칸, 클레임 칸은 줄어서 흰 칸', () => {
  const o = overview(E.newState());
  assert.equal(o.status, 'issue');
  assert.deepEqual(o.tiles.filter((t) => t.alert).map((t) => t.key), ['recall', 'warn', 'case']);
  assert.equal(tile(o, 'recall').value, 2);
  assert.equal(tile(o, 'warn').value, 4);
  assert.match(tile(o, 'case').note, /사건 접수 필요/);
  assert.equal(o.this_month, '2026-06');
  assert.equal(tile(o, 'claims').value, 5);
  assert.equal(tile(o, 'claims').note, '지난달보다 7건 줄었어요');
  assert.equal(tile(o, 'tasks').value, null);
});

test('월별 클레임 12개월, 마지막 달 값이 칸과 같고 확정+미확정=전체', () => {
  const o = overview(E.newState());
  assert.equal(o.monthly.length, 12);
  assert.equal(o.monthly[11].month, '2026-06');
  o.monthly.forEach((m) => assert.equal(m.confirmed + m.open, m.claims));
  assert.equal(o.monthly[11].claims, tile(o, 'claims').value);
});

test('제품별 클레임: 6개 제품, 회수 대상이 있는 PL-02만 표시', () => {
  const o = overview(E.newState());
  assert.equal(o.products.length, 6);
  assert.deepEqual(o.products.filter((p) => p.issue).map((p) => p.product_id), ['PL-02']);
  assert.equal(o.products[0].product_id, 'PL-02');
});

test('사건을 접수하고 경고를 처리하면 해당 빨간 칸이 풀린다(회수 대상 칸은 사실이라 남음)', () => {
  const s = E.newState();
  E.createCase(s, { batch_ids: ['B-02-2602-01', 'B-02-2603-01'] });
  E.ackWarning(s, 'HOLD_SHIP:B-02-2602-01', '출하 통제 기록 확인을 원인조사 담당에게 요청');
  E.ackWarning(s, 'HOLD_SHIP:B-02-2603-01', '출하 통제 기록 확인을 원인조사 담당에게 요청');
  const o = overview(s);
  assert.equal(tile(o, 'warn').alert, false);
  assert.equal(tile(o, 'case').alert, false);
  assert.equal(tile(o, 'case').value, 1);
  assert.equal(tile(o, 'recall').alert, true);
});

test('첫 화면 계산은 상태를 바꾸지 않는다', () => {
  const s = E.newState();
  const before = JSON.stringify(s);
  overview(s);
  assert.equal(JSON.stringify(s), before);
});

test('회수 대상 칸: 위원회 회수 결정 전에는 빨간 칸, 결정 뒤에는 처리 중이라 흰 칸', async () => {
  const SC = require('../src/scenarios');
  const s = E.newState();
  s.scenario = { id: 1, next: 0, results: [] };
  for (let i = 0; i < 6; i += 1) await SC.runStep(s, 1); // 접수 → 판정 → 상신 → 회신 → 승인 확정
  const t = tile(overview(s), 'recall');
  assert.equal(t.value, 2);
  assert.equal(t.alert, false);
  assert.match(t.note, /회수 결정됨/);
});
