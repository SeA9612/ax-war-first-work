'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getModel } = require('../src/data');
const R = require('../src/rules');
const E = require('../src/engine');

const pct = (x) => (x * 100).toFixed(2) + '%';
const model = getModel();

test('원본 데이터 로드: 미출하 PL-02 주문 228건 864,769 EA, Masil 더마 발주 88,000 EA', () => {
  assert.equal(model.unshippedPl02.length, 228);
  assert.equal(model.unshippedPl02.reduce((s, o) => s + o.order_qty, 0), 864769);
  assert.equal(model.masilPos.reduce((s, p) => s + p.order_qty, 0), 88000);
});

test('두 배치 회수 대상 판정 (11.87%/12.27%, 11.59%/12.11%)', () => {
  const J = R.judgeAll(model, {});
  const a = J.judgments['B-02-2602-01']; const b = J.judgments['B-02-2603-01'];
  assert.equal(a.status, '회수 대상'); assert.equal(pct(a.rateP), '11.87%'); assert.equal(pct(a.rateS), '12.27%');
  assert.equal(b.status, '회수 대상'); assert.equal(pct(b.rateP), '11.59%'); assert.equal(pct(b.rateS), '12.11%');
  const recall = Object.values(J.judgments).filter((j) => j.base_status === '회수 대상').map((j) => j.batch_id);
  assert.deepEqual(recall.sort(), ['B-02-2602-01', 'B-02-2603-01']);
  assert.ok(a.warn_hold_shipped, '보류 배치 출하 경고');
});

test('분모 민감: QC-00006·00011·00015 정정 → 9.72% / 10.04%', () => {
  const ov = {};
  ['QC-00006', 'QC-00011', 'QC-00015'].forEach((id) => { ov[id] = { fields: { defect_confirmed: false, status: '정정(재조사)' } }; });
  const j = R.judgeAll(model, ov).judgments['B-02-2602-01'];
  assert.equal(j.confirmed_qty, 14648);
  assert.equal(pct(j.rateP), '9.72%'); assert.equal(pct(j.rateS), '10.04%');
  assert.equal(j.base_status, '분모 민감');
});

test('추가 정정 QC-00004 → 두 기준 미달 → 조사·소명 (9.01% / 9.32%)', () => {
  const ov = {};
  ['QC-00006', 'QC-00011', 'QC-00015', 'QC-00004'].forEach((id) => { ov[id] = { fields: { defect_confirmed: false, status: '정정(재조사)' } }; });
  const j = R.judgeAll(model, ov).judgments['B-02-2602-01'];
  assert.equal(pct(j.rateP), '9.01%'); assert.equal(pct(j.rateS), '9.32%');
  assert.equal(j.base_status, '조사·소명');
});

test('정상(기준 미달): 확정 건 있으나 두 기준 모두 < 10% (B-02-2508-03 0.01%)', () => {
  const j = R.judgeAll(model, {}).judgments['B-02-2508-03'];
  assert.equal(j.status, '정상(기준 미달)');
  assert.equal(j.confirmed_qty, 16);
});

test('QC-00142 확정해도 회수 판정 불변 (0.003%)', () => {
  const j = R.judgeAll(model, { 'QC-00142': { fields: { defect_confirmed: true, status: '확정' } } }).judgments['B-02-2606-02'];
  assert.notEqual(j.base_status, '회수 대상');
  assert.ok(j.rateP < 0.0001);
});

test('언론 보도는 판정을 바꾸지 않음(J4)', () => {
  const s = E.newState();
  const before = JSON.stringify(E.judge(s).judgments);
  const ev = E.applyEvent(s, { type: 'news', title: '일부 소비자 트러블 보도' });
  assert.equal(JSON.stringify(E.judge(s).judgments), before);
  assert.match(ev.effect, /판정 변경 0건/);
});

test('확장(a): 같은 로트 합격 배치 예방 점검 — 미출하 잔여 3,213 / 10,483 EA, 재판정 기준 15,469 / 16,160 EA', () => {
  const J = R.judgeAll(model, {});
  const p2 = J.preventive.find((p) => p.batch_id === 'B-02-2602-02');
  const p3 = J.preventive.find((p) => p.batch_id === 'B-02-2602-03');
  assert.equal(J.judgments['B-02-2602-02'].status, '예방 점검');
  assert.equal(p2.unshipped_qty, 3213); assert.equal(p3.unshipped_qty, 10483);
  assert.equal(p2.trigger_qty, 15469); assert.equal(p3.trigger_qty, 16160);
  assert.deepEqual(Object.keys(p2.customers).sort(), ['C-101', 'C-102', 'C-103']);
  const off = R.judgeAll(model, {}, { extensionOn: false });
  assert.equal(off.preventive.length, 0);
  assert.equal(off.judgments['B-02-2602-02'].status, '정상');
});

test('C-105 민감도: 제외 시 8.35% / 7.58%, 회수 범위 = SBL ∪ 클레임', () => {
  const J = R.judgeAll(model, {});
  assert.equal(pct(R.customerSensitivity(model, 'B-02-2602-01', J.claims).rateP_without), '8.35%');
  assert.equal(pct(R.customerSensitivity(model, 'B-02-2603-01', J.claims).rateP_without), '7.58%');
  const scope = R.recallScope(model, ['B-02-2602-01', 'B-02-2603-01'], J.claims);
  assert.deepEqual(scope.map((s) => s.customer_id).sort(), ['C-101', 'C-102', 'C-103', 'C-104', 'C-105', 'C-108']);
  assert.equal(scope.reduce((s, r) => s + r.shipped_qty, 0), 299653);
  assert.ok(scope.find((s) => s.customer_id === 'C-105').unverified);
});
