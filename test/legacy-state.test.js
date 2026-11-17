'use strict';
// 이전 버전이 저장한 state.json(일부 필드 없음)을 불러와도 화면·재계산·승인이 동작하는지 (2026-11-12 사용자 제보: 재공급 계획 탭 오류)
process.env.NODE_ENV = 'test';
process.env.PERSIST = 'off';
delete process.env.AI_REAL_ENABLED;
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine');
const SC = require('../src/scenarios');
const store = require('../src/store');

async function runScenario(id) {
  const s = E.newState();
  s.scenario = { id, next: 0, results: [] };
  for (let i = 0; i < SC.SCENARIOS[id].steps.length; i += 1) await SC.runStep(s, id);
  return s;
}

// 시나리오 ① 끝 상태를 이전 버전 형식으로 되돌린다(이후 추가된 필드 삭제)
function toLegacy(s) {
  const old = JSON.parse(JSON.stringify(s));
  old.cases.forEach((c) => {
    delete c.planHistory;
    if (c.plan) {
      delete c.plan.version; delete c.plan.exception_reason;
      (c.plan.result.alternatives || []).forEach((a) => {
        ['per_customer', 'affected_qty', 'avg_delay_days', 'max_delay_days', 'delay_ea_days', 'over_limit'].forEach((k) => delete a[k]);
      });
    }
  });
  return old;
}

test('이전 형식 상태: 불러올 때 빠진 필드를 기본값으로 채우고 기존 기록은 유지', async () => {
  const legacy = toLegacy(await runScenario(1));
  const before = legacy.cases[0];
  const m = store.migrate(JSON.parse(JSON.stringify(legacy)));
  const c = m.cases[0];
  assert.deepEqual(c.planHistory, []);
  assert.equal(c.plan.version, 1);
  assert.equal(c.plan.exception_reason, null);
  assert.equal(c.status, before.status);
  assert.equal(c.plan.status, before.plan.status);
  assert.equal(c.plan.selected, before.plan.selected);
  assert.equal(m.tasks.length, legacy.tasks.length);
  assert.equal(m.audit.length, legacy.audit.length);
});

test('이전 형식 상태: 재계산하면 새 형식(v2)으로 다시 계산되고 이전 승인 이력 보존, 재승인 후 복구 진행', async () => {
  const s = store.migrate(toLegacy(await runScenario(1)));
  const c = s.cases[0];
  const prevSelected = c.plan.selected;
  E.computeCasePlan(s, c.id, { monthly_spare_ea: 14800, requal_days: 14, limit_weeks: 12 });
  assert.equal(c.plan.version, 2);
  assert.equal(c.planHistory.length, 1);
  assert.equal(c.planHistory[0].selected, prevSelected);
  const byId = Object.fromEntries(c.plan.result.alternatives.map((a) => [a.id, a]));
  assert.equal(byId.A.over_limit, false);
  assert.equal(byId.A.max_delay_days, 19);
  assert.equal(byId.B.over_limit, true);
  assert.ok(Array.isArray(byId.A.per_customer) && byId.A.per_customer.length > 0);
  assert.equal(byId.C.feasible, false);
});
