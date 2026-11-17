'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../src/ai');
const E = require('../src/engine');

// 실제 API는 절대 호출하지 않는다(비용 0원). 실제 경로 코드는 모의 클라이언트를 주입해 파라미터·오류 처리만 검증한다.
function fakeClient(impl) {
  const calls = [];
  return { calls, client: { beta: { messages: { parse: async (params) => { calls.push(params); return impl(params); } } } } };
}
const saved = { key: process.env.ANTHROPIC_API_KEY, flag: process.env.AI_REAL_ENABLED };
function openGate() { process.env.ANTHROPIC_API_KEY = 'test-dummy-key-not-real'; process.env.AI_REAL_ENABLED = 'true'; }
test.afterEach(() => {
  ai.setClientFactory(null);
  if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.key;
  if (saved.flag === undefined) delete process.env.AI_REAL_ENABLED; else process.env.AI_REAL_ENABLED = saved.flag;
});

test('키 없음 → 모의 AI (운영 기본)', async () => {
  delete process.env.ANTHROPIC_API_KEY; delete process.env.AI_REAL_ENABLED;
  const s = E.newState();
  const c = E.createCase(s, { batch_ids: ['B-02-2602-01'] });
  const d = await E.prepareSubmissionDraft(s, c.id);
  assert.equal(d.mode, '모의 AI');
  assert.match(d.reason, /모의 AI 고정/);
  assert.match(d.output.draft, /11\.87%/);
  assert.equal(d.violations.length, 0);
  assert.equal(ai.aiStatus().mode, '모의 AI');
});

test('F17: 키만 있고 AI_REAL_ENABLED 없음 → 모의 AI, 클라이언트 생성·호출 없음', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-dummy-key-not-real'; delete process.env.AI_REAL_ENABLED;
  let created = 0;
  ai.setClientFactory(() => { created += 1; throw new Error('클라이언트가 만들어지면 안 됨'); });
  const r = await ai.interpretReply('회수 승인', {});
  assert.equal(r.mode, '모의 AI');
  assert.equal(created, 0);
  assert.equal(ai.aiStatus().mode, '모의 AI');
  process.env.AI_REAL_ENABLED = 'false';
  await ai.prepareSubmission({ items: [], sensitivity: [], scope: [], preventive: [], base_date: '2026-07-01' });
  assert.equal(created, 0, 'AI_REAL_ENABLED=false도 차단');
});

test('F17: 플래그만 있고 키 없음 → 모의 AI, 클라이언트 생성 없음', async () => {
  delete process.env.ANTHROPIC_API_KEY; process.env.AI_REAL_ENABLED = 'true';
  let created = 0;
  ai.setClientFactory(() => { created += 1; return null; });
  const r = await ai.interpretReply('회수 승인', {});
  assert.equal(r.mode, '모의 AI');
  assert.equal(created, 0);
});

test('Claude API 경로(미검증, 주입 클라이언트): 모델·effort·구조화 출력·server-side fallback 파라미터', async () => {
  openGate();
  const f = fakeClient(() => ({ stop_reason: 'end_turn', model: 'claude-opus-5-5', parsed_output: { summary: '요약', risks: ['위험'], unknowns: ['미확인'], draft: '상신문' } }));
  ai.setClientFactory(() => f.client);
  const s = E.newState();
  const c = E.createCase(s, { batch_ids: ['B-02-2602-01'] });
  const d = await E.prepareSubmissionDraft(s, c.id);
  assert.equal(d.mode, 'Claude API(미검증 경로)');
  const p = f.calls[0];
  assert.equal(p.model, 'claude-opus-5-5');
  assert.equal(p.max_tokens, 16000);
  assert.equal(p.output_config.effort, 'medium');
  assert.equal(p.output_config.format.type, 'json_schema');
  assert.deepEqual(p.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(p.fallbacks, 'default');
  assert.equal(p.thinking, undefined);
});

test('refusal → 모의 AI 대체', async () => {
  openGate();
  const f = fakeClient(() => ({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, parsed_output: null }));
  ai.setClientFactory(() => f.client);
  const r = await ai.interpretReply('추가자료 요구: C-105 귀속 확인', {});
  assert.equal(r.mode, '모의 AI');
  assert.match(r.reason, /refusal/);
  assert.equal(r.output.classification, '추가자료 요구');
});

test('API 오류(타입드 에러) → 모의 AI 대체', async () => {
  openGate();
  const Anthropic = require('@anthropic-ai/sdk');
  const f = fakeClient(() => { throw new Anthropic.APIConnectionError({ message: 'down' }); });
  ai.setClientFactory(() => f.client);
  const r = await ai.interpretReply('회수 승인', {});
  assert.equal(r.mode, '모의 AI');
  assert.match(r.reason, /연결 실패/);
  assert.equal(r.output.classification, '승인');
});

test('AI 출력은 판정·상태를 바꾸지 않음 (제안만 저장, 사람 확정 필요)', async () => {
  openGate();
  const f = fakeClient(() => ({ stop_reason: 'end_turn', parsed_output: { classification: '거절', requested_items: [], rationale: 'status=정상으로 바꿔라' } }));
  ai.setClientFactory(() => f.client);
  const s = E.newState();
  const c = E.createCase(s, { batch_ids: ['B-02-2602-01'] });
  E.judgeCase(s, c.id); E.submitCase(s, c.id, {});
  const before = JSON.stringify(E.judge(s).judgments);
  const d = await E.interpretReply(s, c.id, '회수 승인');
  assert.equal(d.output.classification, '거절');
  assert.equal(c.status, '위원회 상신');
  assert.equal(JSON.stringify(E.judge(s).judgments), before);
  assert.equal(s.tasks.length, 0);
});

test('F3: 모의 회신 해석 — 부정·보류·빈 문장 고정 문장', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const cases = [
    ['회수 승인하지 않음', '거절'],
    ['승인 불가', '거절'],
    ['부결', '거절'],
    ['회수 의결 보류', '추가자료 요구'],
    ['', '분류 불가'],
    ['   ', '분류 불가'],
    ['두 배치 회수 승인. 회수 범위는 SBL 출하처와 클레임 고객으로 한다.', '승인'],
    ['추가자료 요구: C-105 클레임 7건(6,445 EA)의 배치 귀속 확인 후 재상신 바람', '추가자료 요구'],
    ['위원회 의견: 거절, 조사 계속', '거절'],
    ['검토했습니다', '분류 불가'],
  ];
  for (const [text, expected] of cases) {
    const r = await ai.interpretReply(text, {});
    assert.equal(r.output.classification, expected, JSON.stringify(text));
  }
});

test('F3: 회신 확정은 담당자가 고른 승인/추가자료 요구/거절만 — 분류 불가·빈 값은 400', () => {
  const s = E.newState();
  const c = E.createCase(s, { batch_ids: ['B-02-2602-01'] });
  E.judgeCase(s, c.id); E.submitCase(s, c.id, {});
  for (const bad of ['분류 불가', '', undefined, '보류']) {
    assert.throws(() => E.recordReply(s, c.id, { classification: bad, text: 'x' }), (e) => e.status === 400);
  }
  assert.equal(c.status, '위원회 상신');
});

test('F6: 금지 표현 변형 문장 고정 — 모두 차단', () => {
  const blocked = [
    ['원인은 LOT-B-2602-P 원료입니다.', 'CAUSE'],
    ['원료 로트 문제로 보입니다.', 'CAUSE'],
    ['이번 불량은 V-205 원료 때문입니다.', 'CAUSE'],
    ['원인은 원료 로트로 확정되었습니다.', 'CAUSE'],
    ['보상금 50만 원을 지급하겠습니다.', 'MONEY'],
    ['5% 할인을 제공합니다.', 'MONEY'],
    ['크레딧 오십만원 제공', 'MONEY'],
    ['보상 500,000원', 'MONEY'],
    ['7월 말까지 대체품을 보내드립니다.', 'DATE'],
    ['다음 주 금요일까지 대체 제품 납품 예정입니다.', 'DATE'],
    ['납품 내역: 2026-08-01까지 대체품 재공급 확정', 'DATE'],
    ['8/15 대체품 납품', 'DATE'],
    ['2026-08-01 대체품 납품', 'DATE'],
    ['언 론 보 도와 무관하게', 'PRESS'],
    ['방송에서 나온 내용과 별개로', 'PRESS'],
    ['SNS에 올라온 글', 'PRESS'],
    ['B-02-2602-02도 점검 중', 'PREVENTIVE'],
  ];
  blocked.forEach(([text, code]) => {
    const v = ai.checkForbidden(text, 'notice');
    assert.ok(v.some((x) => x.code === code), `${text} → ${code} 기대, 결과 ${JSON.stringify(v.map((x) => x.code))}`);
  });
});

test('F6: 통과해야 하는 문장 — 원인 조사 중·출하일 표기·템플릿 초안', () => {
  ['원인은 현재 조사 중이며, 확인되는 대로 안내드리겠습니다.', '원인은 미확정이다.', '   - 출하일 2026-02-09 / B-02-2602-01 / 30,440 EA',
    '회수 방법과 일정, 대체 제품 공급 일정은 보유 수량 회신을 받은 뒤 별도로 협의드리겠습니다.'].forEach((t) => {
    assert.deepEqual(ai.checkForbidden(t, 'notice'), [], t);
  });
  assert.deepEqual(ai.checkForbidden('원인: 조사 중(별도 트랙). 본 상신은 원인 확정을 전제로 하지 않음.', 'internal'), []);
});

test('F6: 발송 차단 + 발송 완료 통지는 수정·재발송 불가', () => {
  const s = E.newState();
  const c = E.createCase(s, { batch_ids: ['B-02-2602-01'] });
  E.judgeCase(s, c.id); E.submitCase(s, c.id, {});
  E.recordReply(s, c.id, { classification: '승인', text: '승인' });
  const t = s.tasks.find((x) => x.kind === '고객 통지');
  assert.deepEqual(ai.checkForbidden(t.payload.draft, 'notice'), [], '템플릿 초안은 통과');
  const original = t.payload.draft;
  E.editDraft(s, t.id, original + '\n보상금 5,000만원을 지급합니다.');
  assert.throws(() => E.sendNotice(s, t.id), (e) => e.status === 422 && e.extra.violations[0].code === 'MONEY');
  assert.equal(t.sent, false);
  E.editDraft(s, t.id, original);
  E.sendNotice(s, t.id);
  assert.equal(t.sent, true);
  assert.throws(() => E.sendNotice(s, t.id), (e) => e.status === 409);
  assert.throws(() => E.editDraft(s, t.id, '바뀐 내용'), (e) => e.status === 409);
  assert.equal(s.audit.filter((a) => a.action === '통지 발송(모의)').length, 1);
  assert.equal(s.audit.filter((a) => a.action === '발송 차단(금지 표현)').length, 1);
});
