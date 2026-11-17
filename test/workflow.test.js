'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine');
const SC = require('../src/scenarios');
const { compareExtension } = require('../src/compare');
const { getModel } = require('../src/data');
const { computePlan } = require('../src/supply');
const R = require('../src/rules');

async function runScenario(id) {
  const s = E.newState();
  s.scenario = { id, next: 0, results: [] };
  for (let i = 0; i < SC.SCENARIOS[id].steps.length; i += 1) {
    const r = await SC.runStep(s, id);
    const bad = r.checks.filter((c) => !c.ok);
    assert.deepEqual(bad, [], `시나리오 ${id} 단계 ${i + 1} 실패: ${JSON.stringify(bad)}`);
  }
  return s;
}

test('시나리오 ① 정상 — 끝까지 기대값 일치', async () => {
  const s = await runScenario(1);
  const c = s.cases[0];
  assert.equal(c.status, '복구 진행');
  assert.equal(c.plan.status, '승인');
  assert.ok(s.tasks.some((t) => t.kind === 'C-201 정보 통지'));
});

test('시나리오 ② 조건 변경 — 재검증·재상신·하향·정정 통지', async () => {
  const s = await runScenario(2);
  const c = s.cases[0];
  assert.equal(c.status, '판정 완료');
  assert.ok(c.submissions.some((x) => x.status === '철회(판정 하향)'));
  const corr = s.tasks.find((t) => t.kind === '정정 통지·영업 확인');
  assert.ok(corr.payload.recheck.some((x) => x.startsWith('생산')));
  assert.ok(corr.payload.recheck.some((x) => x.startsWith('재무')));
  // 원인조사 트랙은 판정 변경 영향을 받지 않음(J5)
  assert.ok(s.tasks.filter((t) => t.track === '원인조사').every((t) => t.status === '대기'));
});

test('시나리오 ③ 정보 부족 — 보류 → 확인요청 → 재상신 → 승인', async () => {
  const s = await runScenario(3);
  assert.equal(s.cases[0].status, '회수 의결');
  assert.equal(s.infoRequests.filter((r) => r.status === '회신 완료').length, 2);
});

test('③ 분기: C-105 귀속 오류 회신 → 7.58% → 회수 대상 아님, 상신 대상 없음', async () => {
  const s = E.newState();
  const c = E.createCase(s, { batch_ids: ['B-02-2603-01'] });
  E.judgeCase(s, c.id);
  E.submitCase(s, c.id, {});
  E.recordReply(s, c.id, { classification: '추가자료 요구', text: '추가자료 요구: C-105 귀속 확인', requested_items: ['C-105 귀속 확인'] });
  const ir = s.infoRequests.find((r) => r.kind === 'C105_LABEL');
  E.answerInfoRequest(s, ir.id, { answer: '귀속 오류(다른 배치)' });
  const j = E.judge(s).judgments['B-02-2603-01'];
  assert.equal((j.rateP * 100).toFixed(2), '7.58');
  assert.notEqual(j.base_status, '회수 대상');
  assert.equal(c.status, '판정 완료');
  assert.throws(() => E.submitCase(s, c.id, {}), /상신할 배치가 없습니다/);
  // 원본 복사본은 그대로
  const ovId = Object.keys(s.claimOverrides)[0];
  assert.equal(getModel().claims.find((x) => x.claim_id === ovId).batch_id, 'B-02-2603-01');
});

test('J3: 위원회 의결 전에는 회수 작업·통지 없음', () => {
  const s = E.newState();
  const c = E.createCase(s, { batch_ids: ['B-02-2602-01', 'B-02-2603-01'] });
  E.judgeCase(s, c.id);
  E.submitCase(s, c.id, {});
  assert.equal(s.tasks.length, 0);
  assert.throws(() => E.computeCasePlan(s, c.id), (e) => e.status === 409 && /계산 불가: .*의결 효력 정지/.test(e.message));
});

test('J6 재검증: 판정 변경 시 작업 재검증 필요, 재의결 시 복원', () => {
  const s = E.newState();
  const c = E.createCase(s, { batch_ids: ['B-02-2602-01'] });
  E.judgeCase(s, c.id); E.submitCase(s, c.id, {});
  E.recordReply(s, c.id, { classification: '승인', text: '승인' });
  const scopeTask = s.tasks.find((t) => t.kind === '회수 범위 확정');
  E.applyEvent(s, { type: 'claim_correction', claim_ids: ['QC-00006', 'QC-00011', 'QC-00015'] });
  assert.equal(scopeTask.status, '재검증 필요');
  assert.equal(c.status, '재검증 필요');
  assert.ok(c.submissions.some((x) => x.status === '재상신 필요'));
  E.submitCase(s, c.id, {});
  E.recordReply(s, c.id, { classification: '승인', text: '분모 민감 두 값 검토 후 승인' });
  assert.equal(scopeTask.status, '대기');
  assert.equal(c.status, '회수 의결');
});

test('예방 점검은 회수 통지를 만들지 않음 — 보유분 확인 요청만', () => {
  const s = E.newState();
  const c = E.createCase(s, { batch_ids: ['B-02-2602-01', 'B-02-2603-01'] });
  E.judgeCase(s, c.id); E.submitCase(s, c.id, {});
  E.recordReply(s, c.id, { classification: '승인', text: '승인' });
  const notices = s.tasks.filter((t) => t.kind === '고객 통지');
  notices.forEach((t) => {
    assert.ok(!/B-02-2602-0[23]/.test(t.payload.draft));
    assert.ok(t.batchIds.every((b) => ['B-02-2602-01', 'B-02-2603-01'].includes(b)));
  });
  const prev = s.tasks.filter((t) => t.track === '예방 점검');
  assert.ok(prev.length > 0);
  assert.ok(prev.every((t) => t.kind !== '고객 통지'));
  assert.deepEqual(prev.filter((t) => t.kind === '보유분 확인 요청').map((t) => t.customer_id).sort(), ['C-101', 'C-102', 'C-103']);
  assert.ok(prev.some((t) => t.title.includes('3,213')));
  assert.ok(prev.some((t) => t.title.includes('10,483')));
  // 로트 격리: 잔량 수치 없음, 확인요청으로 연결
  const lot = s.tasks.find((t) => t.kind === '로트 격리');
  assert.ok(!/807\.9|27,901/.test(lot.title));
  assert.ok(s.infoRequests.some((r) => r.kind === 'LOT_REMAIN'));
});

test('C-105 제외: 통지 초안·대체 수량에서 제외, 확인요청 생성', () => {
  const s = E.newState();
  const c = E.createCase(s, { batch_ids: ['B-02-2602-01', 'B-02-2603-01'] });
  E.judgeCase(s, c.id); E.submitCase(s, c.id, {});
  E.recordReply(s, c.id, { classification: '승인', text: '승인' });
  assert.ok(!s.tasks.some((t) => t.kind === '고객 통지' && t.customer_id === 'C-105'));
  assert.ok(s.infoRequests.some((r) => r.kind === 'C105_LABEL' && r.customer_id === 'C-105'));
  const p = E.computeCasePlan(s, c.id);
  const d = p.result.demand.find((x) => x.customer_id === 'C-105');
  assert.equal(d.included, false);
  assert.equal(p.result.replacement_total, 299653);
  // 고객 보유 수량 회신 → 대체 수량 재계산
  E.applyEvent(s, { type: 'holding_reply', customer_id: 'C-103', qty: 40000 });
  assert.equal(c.plan.result.replacement_total, 299653 - 83402 + 40000);
});

test('확장 ON/OFF 실제 실행 비교: OFF면 예방 점검 대상·작업 없음, 회수 통지 수 동일', () => {
  const d = compareExtension(E.newState());
  assert.deepEqual(d.on.preventive_batches.map((p) => p.batch_id).sort(), ['B-02-2602-02', 'B-02-2602-03']);
  assert.equal(d.off.preventive_batches.length, 0);
  assert.equal(d.off.tasks.filter((t) => t.track === '예방 점검').length, 0);
  assert.ok(d.on.tasks.filter((t) => t.track === '예방 점검').length >= 7);
  assert.equal(d.on.recall_notice_count, d.off.recall_notice_count);
  assert.ok(d.diff.tasks_only_on.length > 0);
});

test('재공급: 조달 회신 전 확인 대기(상신 불가), 대안 C 실행 불가, 기존 주문 지연 대안은 영업 임원 승인 필요', () => {
  const s = E.newState();
  const c = E.createCase(s, { batch_ids: ['B-02-2602-01', 'B-02-2603-01'] });
  E.judgeCase(s, c.id); E.submitCase(s, c.id, {});
  E.recordReply(s, c.id, { classification: '승인', text: '승인' });
  E.computeCasePlan(s, c.id);
  assert.equal(c.plan.status, '확인 대기');
  assert.throws(() => E.submitPlan(s, c.id, { alternative: 'A' }), /확인 대기/);
  E.applyEvent(s, { type: 'procurement_reply', available_date: '2026-07-20' });
  assert.equal(c.plan.status, '계산 완료');
  const [A, , C] = c.plan.result.alternatives;
  assert.equal(C.feasible, false);
  assert.match(C.feasibility_note, /실행 불가/);
  assert.equal(C.delayed_orders.length, 0);
  assert.ok(A.delayed_orders.length > 0);
  assert.deepEqual(A.approvals_required, ['영업 임원', '생산 책임자']);
  assert.throws(() => E.submitPlan(s, c.id, { alternative: 'C' }), /실행 불가/);
  E.submitPlan(s, c.id, { alternative: 'A' });
  E.approvePlan(s, c.id, { approver: '생산 책임자', decision: '승인' });
  assert.equal(c.plan.status, '상신', '영업 임원 승인 전에는 미승인');
  E.approvePlan(s, c.id, { approver: '영업 임원', decision: '승인' });
  assert.equal(c.plan.status, '승인');
  assert.ok(s.tasks.some((t) => t.kind === 'Masil 정보 통지'));
  assert.ok(s.tasks.some((t) => t.kind === '납기 변경 통지'));
});

test('재공급 민감도: 월 여유 58,484 / 4,874 EA 입력 시 결과가 바뀌고 C는 여전히 실행 불가', () => {
  const model = getModel();
  const J = R.judgeAll(model, {});
  const scope = R.recallScope(model, ['B-02-2602-01', 'B-02-2603-01'], J.claims);
  const w = [14800, 58484, 4874].map((v) => computePlan(model, { scope, procurementReply: { available_date: '2026-07-20' }, assumptions: { monthly_spare_ea: v } }).alternatives[2]);
  assert.ok(w[1].weeks_to_complete < w[0].weeks_to_complete);
  assert.ok(w[2].weeks_to_complete > w[0].weeks_to_complete);
  w.forEach((c) => assert.equal(c.feasible, false));
  const loose = computePlan(model, { scope, procurementReply: { available_date: '2026-07-20' }, assumptions: { monthly_spare_ea: 58484, limit_weeks: 52 } }).alternatives[2];
  assert.equal(loose.feasible, true, '한도 가정을 바꾸면 결론이 바뀜(민감도)');
});
