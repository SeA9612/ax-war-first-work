'use strict';
// 검수 수정 목록 F1~F13 재현 테스트 (순서 위반·잘못된 입력·우회 경로). 기대값은 정확한 상태·수치·상태코드로 고정.
process.env.NODE_ENV = 'test';
delete process.env.AI_REAL_ENABLED;
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine');
const { getModel } = require('../src/data');
const R = require('../src/rules');
const { computePlan } = require('../src/supply');

const LOT = ['B-02-2602-01', 'B-02-2603-01'];
const st = (e, code) => (err) => err.status === code && (!e || e.test(err.message));
function approved(batches = LOT) {
  const s = E.newState();
  const c = E.createCase(s, { batch_ids: batches });
  E.judgeCase(s, c.id); E.submitCase(s, c.id, {});
  E.recordReply(s, c.id, { classification: '승인', text: '승인' });
  return [s, c];
}
function planApproved(alt = 'A') {
  const [s, c] = approved();
  E.applyEvent(s, { type: 'procurement_reply', available_date: '2026-07-20' });
  E.computeCasePlan(s, c.id);
  E.submitPlan(s, c.id, { alternative: alt });
  c.plan.required.forEach((a) => E.approvePlan(s, c.id, { approver: a, decision: '승인' }));
  return [s, c];
}

// ---------- F1 ----------
test('F1: 의결 상태에서 재상신 불가(409), 거절 시 의결 배치 비움·회수 작업 취소·통지/계획 409', () => {
  const [s, c] = approved();
  assert.throws(() => E.submitCase(s, c.id, {}), st(/이미 회수 의결/, 409));
  // 판정 변경 → 재상신 → 회신 대기 중에는 이전 의결 효력 정지
  E.applyEvent(s, { type: 'claim_correction', claim_ids: ['QC-00006', 'QC-00011', 'QC-00015'] });
  E.submitCase(s, c.id, {});
  assert.equal(E.approvalActive(c), false);
  const notice = s.tasks.find((t) => t.kind === '고객 통지');
  assert.throws(() => E.sendNotice(s, notice.id), st(/발송 불가: .*의결 효력 정지/, 409));
  assert.throws(() => E.computeCasePlan(s, c.id), st(/회신 대기/, 409));
  E.recordReply(s, c.id, { classification: '거절', text: '부결' });
  assert.equal(c.status, '거절(조사 계속)');
  assert.deepEqual(c.approvedBatchIds, []);
  assert.equal(s.tasks.filter((t) => t.track === '회수' && t.dependsOnJudgment && ['대기', '진행', '재검증 필요'].includes(t.status)).length, 0);
  assert.equal(s.tasks.filter((t) => t.track === '원인조사' && t.status === '대기').length, 6, '원인조사 트랙 유지(J5)');
  assert.throws(() => E.sendNotice(s, notice.id), (e) => e.status === 409);
  assert.throws(() => E.computeCasePlan(s, c.id), st(/거절/, 409));
});

test('F1: 발송된 통지가 있는 상태에서 거절 → 정정 통지·영업 확인 작업', () => {
  const [s, c] = approved();
  const n = s.tasks.find((t) => t.kind === '고객 통지'); E.sendNotice(s, n.id);
  E.applyEvent(s, { type: 'claim_correction', claim_ids: ['QC-00006', 'QC-00011', 'QC-00015'] });
  E.submitCase(s, c.id, {});
  E.recordReply(s, c.id, { classification: '거절', text: '거절' });
  assert.equal(s.tasks.filter((t) => t.kind === '정정 통지·영업 확인').length, 1);
});

test('F1: 추가자료 요구 시 의결 배치 비움·작업 재검증 필요', () => {
  const [s, c] = approved();
  E.applyEvent(s, { type: 'claim_correction', claim_ids: ['QC-00006', 'QC-00011', 'QC-00015'] });
  E.submitCase(s, c.id, {});
  E.recordReply(s, c.id, { classification: '추가자료 요구', text: '추가자료 요구: 배치 제조기록서', requested_items: ['배치 제조기록서'] });
  assert.equal(c.status, '보류(추가자료)');
  assert.deepEqual(c.approvedBatchIds, []);
  assert.ok(s.tasks.filter((t) => t.kind === '고객 통지').every((t) => t.status === '재검증 필요'));
});

// ---------- F2 ----------
test('F2: 재검증 필요 중 조달·고객 회신이 와도 계획 자동 재계산 금지, 상신·승인 409', () => {
  const [s, c] = approved();
  E.computeCasePlan(s, c.id);
  E.applyEvent(s, { type: 'claim_correction', claim_ids: ['QC-00006', 'QC-00011', 'QC-00015'] });
  assert.equal(c.status, '재검증 필요');
  assert.equal(c.plan.status, '재검증 필요');
  E.applyEvent(s, { type: 'procurement_reply', available_date: '2026-07-20' });
  E.applyEvent(s, { type: 'holding_reply', customer_id: 'C-101', qty: 100 });
  assert.equal(c.plan.status, '재검증 필요');
  assert.throws(() => E.computeCasePlan(s, c.id), st(/계산 불가: 판정이 바뀌어 재상신·재의결이 필요/, 409));
  assert.throws(() => E.submitPlan(s, c.id, { alternative: 'A' }), (e) => e.status === 409);
  assert.equal(c.status, '재검증 필요');
});

test('F2: 승인된 계획 재계산 → 이전 승인 기록 보존(v1), 새 버전 재승인 필요, 계획 기반 작업 재검증 필요', () => {
  const [s, c] = planApproved('A');
  assert.equal(c.status, '복구 진행');
  const due = s.tasks.filter((t) => t.kind === '납기 변경 통지');
  assert.equal(due.length, 11);
  E.computeCasePlan(s, c.id, { monthly_spare_ea: 58484 });
  assert.equal(c.plan.version, 2);
  assert.equal(c.plan.status, '계산 완료');
  assert.equal(c.planHistory.length, 1);
  assert.deepEqual(Object.keys(c.planHistory[0].approvals).sort(), ['생산 책임자', '영업 임원']);
  assert.equal(c.planHistory[0].selected, 'A');
  assert.equal(c.status, '회수 의결');
  assert.ok(due.every((t) => t.status === '재검증 필요'));
  assert.throws(() => E.updateTaskStatus(s, due[0].id, { status: '대기' }), st(/재검증 필요/, 409));
  // 고객 회신으로 승인 계획이 조용히 계산 완료로 돌아가지 않음
  E.submitPlan(s, c.id, { alternative: 'A' });
  c.plan.required.forEach((a) => E.approvePlan(s, c.id, { approver: a, decision: '승인' }));
  E.applyEvent(s, { type: 'holding_reply', customer_id: 'C-101', qty: 100 });
  assert.equal(c.plan.status, '재검증 필요');
  E.applyEvent(s, { type: 'holding_reply', customer_id: 'C-102', qty: 200 });
  assert.equal(c.plan.status, '재검증 필요', '두 번째 회신에도 자동 재계산 없음');
});

// ---------- F4 ----------
test('F4: 기본 가정 정확값 — A 8주·최대 19일, B 41주 한도 초과·최대 12일, C 93주 실행 불가, C-103·C-108 완료일', () => {
  const model = getModel();
  const J = R.judgeAll(model, {});
  const scope = R.recallScope(model, LOT, J.claims);
  const [A, B, C] = computePlan(model, { scope, procurementReply: { available_date: '2026-07-20' } }).alternatives;
  assert.equal(A.replacement_done, '2026-08-20'); assert.equal(A.weeks_to_complete, 8); assert.equal(A.over_limit, false);
  assert.equal(A.delayed_orders.length, 159); assert.equal(A.affected_qty, 658427); assert.equal(A.max_delay_days, 19); assert.equal(A.avg_delay_days, 17.3);
  assert.equal(B.replacement_done, '2027-04-13'); assert.equal(B.weeks_to_complete, 41); assert.equal(B.over_limit, true); assert.equal(B.max_delay_days, 12); assert.equal(B.avg_delay_days, 10.6);
  assert.equal(B.claim_customers_done, '2026-08-12');
  assert.equal(B.per_customer.find((p) => p.customer_id === 'C-103').replacement_done, '2027-02-01');
  assert.equal(B.per_customer.find((p) => p.customer_id === 'C-108').replacement_done, '2027-04-13');
  assert.equal(C.weeks_to_complete, 93); assert.equal(C.feasible, false); assert.equal(C.delayed_orders.length, 0);
  assert.match(B.feasibility_note, /^한도 초과/);
  assert.match(C.feasibility_note, /^실행 불가/);
});

test('F4: 월 여유 0·음수·문자, 날짜 형식 오류 → 400. 미완료 대체분은 미완료로 표시', () => {
  const model = getModel();
  const J = R.judgeAll(model, {});
  const scope = R.recallScope(model, LOT, J.claims);
  [0, -100, '0', 'x'].forEach((v) => assert.throws(() => computePlan(model, { scope, assumptions: { monthly_spare_ea: v } }), (e) => e.status === 400));
  assert.throws(() => computePlan(model, { scope, assumptions: { requal_days: 'abc' } }), (e) => e.status === 400);
  assert.throws(() => computePlan(model, { scope, procurementReply: { available_date: '2026/07/20' } }), (e) => e.status === 400);
  const tiny = computePlan(model, { scope, procurementReply: { available_date: '2026-07-20' }, assumptions: { monthly_spare_ea: 1 } }).alternatives;
  assert.equal(tiny[2].replacement_done, null);
  assert.equal(tiny[2].feasible, false);
  assert.match(tiny[2].feasibility_note, /^완료 불가/);
  assert.equal(tiny[1].feasible, false, 'B도 클레임 없는 고객 대체분 미완료 → 완료 불가');
});

test('F4: 한도 초과 B는 예외 사유 필수, 예외 승인은 영업 임원 승인·감사기록 필수', () => {
  const [s, c] = approved();
  E.applyEvent(s, { type: 'procurement_reply', available_date: '2026-07-20' });
  E.computeCasePlan(s, c.id);
  assert.throws(() => E.submitPlan(s, c.id, { alternative: 'B' }), st(/예외 사유/, 409));
  E.submitPlan(s, c.id, { alternative: 'B', exception_reason: '클레임 고객 우선 — C-103·C-108과 대체 일정 별도 합의' });
  assert.deepEqual(c.plan.required, ['영업 임원', '생산 책임자']);
  E.approvePlan(s, c.id, { approver: '생산 책임자', decision: '승인' });
  assert.equal(c.plan.status, '상신');
  E.approvePlan(s, c.id, { approver: '영업 임원', decision: '승인' });
  assert.equal(c.plan.status, '승인');
  assert.ok(s.audit.some((a) => a.action === '재공급 계획 상신' && /예외 사유: 클레임 고객 우선/.test(a.detail)));
  assert.ok(s.audit.some((a) => a.actor.startsWith('영업 임원') && /한도 초과 예외 승인/.test(a.detail)));
});

// ---------- F5 ----------
test('F5: 잘못된 입력은 400이고 상태 무변경', () => {
  const [s, c] = approved();
  E.applyEvent(s, { type: 'procurement_reply', available_date: '2026-07-20' });
  E.computeCasePlan(s, c.id);
  const before = JSON.stringify(s);
  const bad = [
    { type: 'procurement_reply', available_date: 'abc' },
    { type: 'procurement_reply', available_date: '2026-02-30' },
    { type: 'procurement_reply', available_date: '2026-07-20', available_kg: -1 },
    { type: 'holding_reply', customer_id: 'C-101', qty: 'abc' },
    { type: 'holding_reply', customer_id: 'C-102', qty: -5000 },
    { type: 'holding_reply', customer_id: 'C-102', qty: 1.5 },
    { type: 'holding_reply', customer_id: 'C-999', qty: 5 },
    { type: 'holding_reply', customer_id: 'C-109', qty: 5 },
    { type: 'claim_correction', claim_ids: [] },
    { type: '없는유형' },
  ];
  bad.forEach((ev) => assert.throws(() => E.applyEvent(s, ev), (e) => e.status === 400, JSON.stringify(ev)));
  assert.throws(() => E.computeCasePlan(s, c.id, { monthly_spare_ea: 'abc' }), (e) => e.status === 400);
  assert.throws(() => E.createCase(s, { batch_ids: ['B-없음'] }), (e) => e.status === 400);
  assert.equal(JSON.stringify(s), before);
  assert.equal(c.plan.result.replacement_total, 299653);
});

test('F5: HTTP 요청 실패 시 서버가 요청 전 상태로 되돌리고 한국어 오류 반환', async () => {
  process.env.PERSIST = 'off';
  const { createServer } = require('../server');
  const store = require('../src/store');
  store.reset(false);
  const srv = createServer().listen(0);
  const port = srv.address().port;
  const call = async (method, path, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  try {
    const c = (await call('POST', '/api/cases', { batch_ids: LOT })).body;
    await call('POST', `/api/cases/${c.id}/judge`);
    await call('POST', `/api/cases/${c.id}/submit`, {});
    await call('POST', `/api/cases/${c.id}/reply`, { classification: '승인', text: '승인' });
    await call('POST', '/api/events', { type: 'procurement_reply', available_date: '2026-07-20' });
    await call('POST', `/api/cases/${c.id}/plan/compute`, {});
    const before = JSON.stringify(store.get());
    const r1 = await call('POST', '/api/events', { type: 'procurement_reply', available_date: 'abc' });
    assert.equal(r1.status, 400); assert.match(r1.body.error, /YYYY-MM-DD/);
    const r2 = await call('POST', `/api/cases/${c.id}/plan/compute`, { assumptions: { monthly_spare_ea: 0 } });
    assert.equal(r2.status, 400); assert.match(r2.body.error, /월 가용 여유/);
    assert.equal(JSON.stringify(store.get()), before);
    // F10: 없는 시나리오 번호 → 404, 상태 무변경
    const r3 = await call('POST', '/api/scenarios/9/start');
    assert.equal(r3.status, 404);
    assert.equal(JSON.stringify(store.get()), before);
    const r4 = await call('POST', '/api/scenarios/9/step');
    assert.equal(r4.status, 404);
    // F11: 계획 승인 결정 값 검증
    await call('POST', `/api/cases/${c.id}/plan/submit`, { alternative: 'A' });
    const r5 = await call('POST', `/api/cases/${c.id}/plan/approve`, { approver: '영업 임원', decision: '보류' });
    assert.equal(r5.status, 400);
    const r6 = await call('POST', `/api/cases/${c.id}/plan/approve`, { approver: '영업 임원' });
    assert.equal(r6.status, 400);
    assert.equal(store.get().cases[0].plan.status, '상신');
    const r7 = await call('POST', '/api/settings/extension', { on: '켜기' });
    assert.equal(r7.status, 400);
  } finally {
    srv.close();
  }
});

// ---------- F7 ----------
test('F7: 회수 의결 시 미출하 잔여분 출하 정지 작업(4,885 / 6,940 EA), N4 충족 조건', () => {
  const [s, c] = approved();
  const holds = s.tasks.filter((t) => t.kind === '출하 정지');
  assert.deepEqual(holds.map((t) => t.batchIds[0]), LOT);
  assert.match(holds[0].title, /약 4,885 EA/); assert.match(holds[1].title, /약 6,940 EA/);
  assert.match(holds[0].title, /\[도출\].*창고 실물 확인 필요/);
  const lot = s.tasks.find((t) => t.kind === '로트 격리');
  E.updateTaskStatus(s, lot.id, { status: '완료' });
  assert.equal(E.normalization(s, c).find((x) => x.id === 'N4').ok, false, '출하 정지 미완료면 N4 미충족');
  holds.forEach((t) => E.updateTaskStatus(s, t.id, { status: '완료' }));
  assert.equal(E.normalization(s, c).find((x) => x.id === 'N4').ok, true);
});

// ---------- F8 ----------
test('F8: C-105 확인 회신은 선택지(귀속 확인/귀속 오류/미확인)만, 미확인은 보류 유지', () => {
  const s = E.newState();
  const c = E.createCase(s, { batch_ids: ['B-02-2603-01'] });
  E.judgeCase(s, c.id); E.submitCase(s, c.id, {});
  E.recordReply(s, c.id, { classification: '추가자료 요구', text: 'C-105 귀속 확인', requested_items: ['C-105 귀속 확인'] });
  const ir = s.infoRequests.find((r) => r.kind === 'C105_LABEL');
  assert.deepEqual(ir.options, [E.C105.CONFIRM, E.C105.WRONG, E.C105.UNKNOWN]);
  assert.throws(() => E.answerInfoRequest(s, ir.id, { answer: '확인 불가(고객 무응답)' }), (e) => e.status === 400);
  assert.deepEqual(s.c105Confirmed, {});
  E.answerInfoRequest(s, ir.id, { answer: E.C105.UNKNOWN });
  assert.equal(ir.status, '대기');
  assert.deepEqual(s.c105Confirmed, {});
  assert.throws(() => E.submitCase(s, c.id, {}), st(/회신 대기/, 409));
  E.answerInfoRequest(s, ir.id, { answer: E.C105.CONFIRM, qty: 6445 });
  assert.equal(s.c105Confirmed['C-105'], 6445);
});

// ---------- F9 ----------
test('F9: 열린 사건에 포함된 배치는 새 사건 접수 차단(409)', () => {
  const s = E.newState();
  E.createCase(s, { batch_ids: LOT });
  assert.throws(() => E.createCase(s, { batch_ids: ['B-02-2603-01'] }), st(/CASE-001/, 409));
  assert.equal(s.cases.length, 1);
});

// ---------- F11 ----------
test('F11: 판정 전 상신 409, 거절 후 검토 작업 완료 전 재상신 409, 재검증 필요 작업 임의 해제 409', () => {
  const s = E.newState();
  const c = E.createCase(s, { batch_ids: ['B-02-2602-01'] });
  assert.throws(() => E.submitCase(s, c.id, {}), st(/규칙 판정/, 409));
  E.judgeCase(s, c.id); E.submitCase(s, c.id, {});
  assert.throws(() => E.submitCase(s, c.id, {}), st(/회신 대기/, 409));
  E.recordReply(s, c.id, { classification: '거절', text: '거절' });
  assert.throws(() => E.submitCase(s, c.id, {}), st(/거절 사유 검토/, 409));
  const review = s.tasks.find((t) => t.key === 'RESUBMIT_REVIEW');
  E.updateTaskStatus(s, review.id, { status: '완료' });
  E.submitCase(s, c.id, {});
  assert.equal(c.status, '위원회 상신');
  E.recordReply(s, c.id, { classification: '승인', text: '승인' });
  E.applyEvent(s, { type: 'claim_correction', claim_ids: ['QC-00006', 'QC-00011', 'QC-00015'] });
  const rv = s.tasks.find((t) => t.status === '재검증 필요');
  ['대기', '진행', '완료'].forEach((x) => assert.throws(() => E.updateTaskStatus(s, rv.id, { status: x }), (e) => e.status === 409));
});

// ---------- F12 ----------
test('F12: AI 대체 공급 안내 초안은 회수 고객 작업에만 사람이 선택 적용, 금지 표현이면 적용 차단', async () => {
  const [s, c] = approved();
  E.applyEvent(s, { type: 'procurement_reply', available_date: '2026-07-20' });
  E.computeCasePlan(s, c.id);
  const d = await E.explainCasePlan(s, c.id);
  E.submitPlan(s, c.id, { alternative: 'A' });
  c.plan.required.forEach((a) => E.approvePlan(s, c.id, { approver: a, decision: '승인' }));
  const supply = s.tasks.filter((t) => t.kind === '대체 공급 안내');
  assert.deepEqual(supply.map((t) => t.customer_id).sort(), ['C-101', 'C-102', 'C-103', 'C-104', 'C-108']);
  assert.ok(supply.every((t) => t.payload.source === '템플릿 초안'), '자동 적용하지 않음');
  const due = s.tasks.find((t) => t.kind === '납기 변경 통지' && t.customer_id === 'C-109');
  assert.throws(() => E.applyAiDraft(s, due.id, { draft_id: d.id }), st(/대체 공급 안내/, 409));
  const t = supply[0];
  E.applyAiDraft(s, t.id, { draft_id: d.id });
  assert.match(t.payload.source, /^AI 초안\(모의 AI\)/);
  assert.ok(!t.payload.draft.includes('{고객사명}'));
  d.output.customer_notice_draft += '\n대체품은 7월 말까지 보내드립니다.';
  assert.throws(() => E.applyAiDraft(s, supply[1].id, { draft_id: d.id }), (e) => e.status === 422);
  assert.equal(supply[1].payload.source, '템플릿 초안');
});

// ---------- F13 ----------
test('F13: 확장 OFF로 의결 → N8 "예방 점검 미수행(위험)" 표시, 의결 후 ON → 빠진 작업 보충 생성', () => {
  const s = E.newState();
  E.setExtension(s, false);
  const c = E.createCase(s, { batch_ids: LOT });
  E.judgeCase(s, c.id); E.submitCase(s, c.id, {});
  E.recordReply(s, c.id, { classification: '승인', text: '승인' });
  assert.equal(s.tasks.filter((t) => t.track === '예방 점검' || t.kind === '로트 격리').length, 0);
  const n8 = E.normalization(s, c).find((x) => x.id === 'N8');
  assert.equal(n8.risk, true);
  assert.match(n8.evidence, /예방 점검 미수행\(위험\)/);
  const r = E.setExtension(s, true);
  assert.deepEqual(r.supplemented, [{ caseId: c.id, tasks: 8 }]);
  assert.equal(s.tasks.filter((t) => t.track === '예방 점검').length, 7);
  assert.equal(s.tasks.filter((t) => t.kind === '로트 격리').length, 1);
  assert.equal(E.normalization(s, c).find((x) => x.id === 'N8').risk, undefined);
});
