'use strict';
// 운영 엔진: Case · 상신 · 회신 · 작업 · 확인요청 · 재공급 계획 · 이벤트 · 감사기록
// 상태 전이는 설계안 v1.1 §2, 규칙은 §3(J1~J8)을 따른다. 모든 함수는 입력을 먼저 검증한 뒤 state 객체를 갱신한다.
const { getModel, BASE_DATE } = require('./data');
const R = require('./rules');
const { computePlan, validateAssumptions, isIsoDate } = require('./supply');
const ai = require('./ai');

const S = R.STATUS;
const CASE = {
  INTAKE: '접수', JUDGED: '판정 완료', SUBMITTED: '위원회 상신', APPROVED: '회수 의결', HOLD: '보류(추가자료)',
  REJECTED: '거절(조사 계속)', PLAN_SUBMITTED: '재공급 계획 상신', PLAN_APPROVED: '재공급 승인', RECOVERY: '복구 진행',
  DONE: '정상화 완료', REVALIDATE: '재검증 필요',
};
const TASK = { WAIT: '대기', DOING: '진행', DONE: '완료', REVALIDATE: '재검증 필요', CANCEL: '취소' };
const POST_SUBMIT = new Set([CASE.SUBMITTED, CASE.APPROVED, CASE.HOLD, CASE.PLAN_SUBMITTED, CASE.PLAN_APPROVED, CASE.RECOVERY, CASE.REVALIDATE, CASE.REJECTED]);
const APPROVAL_STATES = new Set([CASE.APPROVED, CASE.PLAN_SUBMITTED, CASE.PLAN_APPROVED, CASE.RECOVERY]);
const PLAN_STATES = new Set([CASE.PLAN_SUBMITTED, CASE.PLAN_APPROVED, CASE.RECOVERY]);
const PLAN_TASK_KINDS = new Set(['납기 변경 통지', '생산 순서 변경', '품질 재승인', '재공급 납품', 'Masil 정보 통지', 'C-201 정보 통지', '대체 공급 안내']);
const NOTICE_KINDS = new Set(['고객 통지', '납기 변경 통지', '대체 공급 안내']);
const C105 = { CONFIRM: '귀속 확인(해당 배치 맞음)', WRONG: '귀속 오류(다른 배치)', UNKNOWN: '미확인(확인 불가·회신 없음)' };
const REPLY_CLASSES = ['승인', '추가자료 요구', '거절'];

const HYPOTHESES = [
  { id: 'H1', title: 'LOT-B-2602-P 원료 자체 규격 문제(로트 전체)', check: '로트 보관 샘플 재검사, V-205 COA 대조, 보류 사유 기록 확보' },
  { id: 'H2', title: '로트 내 불균질(일부 드럼·포장 단위)', check: '배치별 투입 서브로트·드럼 번호 기록 요청' },
  { id: 'H3', title: '배치 고유 공정 요인', check: '배치 제조기록서(BMR)·배치 보류 사유 확인' },
  { id: 'H4', title: '라인·시기 요인(F1 전체)', check: '우선순위 낮음 — 같은 기간 F1 다른 제품 불량 수준 재확인' },
  { id: 'H5', title: '데이터 귀속 오류(클레임 배치 기재)', check: 'C-105 클레임 실제 배치 번호(제품 라벨) 확인' },
];

// ---------------- 상태 ----------------
function newState() {
  return {
    version: 2,
    base_date: BASE_DATE,
    settings: { extensionOn: true },
    claimOverrides: {},
    events: [], cases: [], tasks: [], infoRequests: [], audit: [],
    holdingReplies: {}, procurementReply: null, c105Confirmed: {},
    seq: { case: 0, task: 0, ir: 0, ev: 0, sub: 0, audit: 0, ai: 0 },
    scenario: null,
    warningAcks: {},
  };
}

function nextId(state, key, prefix, pad) {
  state.seq[key] = (state.seq[key] || 0) + 1;
  return prefix + String(state.seq[key]).padStart(pad || 3, '0');
}
function now() { return new Date().toISOString(); }
function pct(x) { return x == null ? '-' : (x * 100).toFixed(2) + '%'; }

function audit(state, actor, action, detail, caseId, refs) {
  state.audit.push({ id: nextId(state, 'audit', 'AU-', 4), at: now(), actor, action, detail, caseId: caseId || null, refs: refs || null });
}

function judge(state) {
  return R.judgeAll(getModel(), state.claimOverrides, { extensionOn: state.settings.extensionOn });
}

function httpError(status, message, extra) {
  const e = new Error(message); e.status = status; if (extra) e.extra = extra; return e;
}
function findCase(state, id) {
  const c = state.cases.find((x) => x.id === id);
  if (!c) throw httpError(404, '사건 없음: ' + id);
  return c;
}
function setCaseStatus(state, c, status, why) {
  if (c.status === status) return;
  const from = c.status;
  c.prevStatus = from;
  c.status = status;
  c.history.push({ at: now(), from, to: status, why });
  audit(state, '시스템', '사건 상태 변경', `${from} → ${status}${why ? ' (' + why + ')' : ''}`, c.id);
}
function snapshotOf(J, batchIds) {
  const s = {};
  batchIds.forEach((b) => { const j = J.judgments[b]; s[b] = { status: j.base_status, rateP: j.rateP, rateS: j.rateS, confirmed_qty: j.confirmed_qty }; });
  return s;
}
function lastSubmission(c) { return c.submissions[c.submissions.length - 1] || null; }

// J3: 회수 실행(통지·계획)은 "가장 최근 상신이 승인"이고 사건이 의결 이후 단계일 때만 유효.
// 재상신~회신 사이, 재검증 필요, 보류, 거절 상태에서는 이전 의결 효력이 정지된다(F1).
function approvalActive(c) {
  const last = lastSubmission(c);
  return c.approvedBatchIds.length > 0 && !!last && last.status === '승인' && APPROVAL_STATES.has(c.status);
}
function requireApproval(c, what) {
  if (approvalActive(c)) return;
  const last = lastSubmission(c);
  let why = '품질위원회 회수 의결이 없습니다';
  if (c.status === CASE.REVALIDATE) why = '판정이 바뀌어 재상신·재의결이 필요합니다';
  else if (c.status === CASE.SUBMITTED) why = '재상신 후 위원회 회신 대기 중 — 이전 의결 효력 정지';
  else if (c.status === CASE.HOLD) why = '위원회 추가자료 요구로 보류 중';
  else if (c.status === CASE.REJECTED) why = '위원회 거절(조사 계속)';
  else if (last && last.status !== '승인') why = '가장 최근 상신이 승인 상태가 아님(' + last.status + ')';
  throw httpError(409, `${what} 불가: ${why}`);
}

// ---------------- 사건 ----------------
function openCaseOf(state, batchId) {
  return state.cases.find((c) => c.batchIds.includes(batchId) && c.status !== CASE.DONE && !c.downgraded);
}

function createCase(state, { title, batch_ids, source } = {}) {
  const model = getModel();
  const ids = Array.isArray(batch_ids) ? [...new Set(batch_ids.map((b) => String(b).trim()).filter(Boolean))] : [];
  if (ids.length === 0) throw httpError(400, '배치 ID가 필요합니다');
  const unknown = ids.filter((b) => !model.batchById[b]);
  if (unknown.length) throw httpError(400, '없는 배치 ID: ' + unknown.join(', '));
  // F9: 열린 사건에 포함된 배치는 새 사건으로 접수하지 않음(중복 통지 방지)
  const dup = ids.map((b) => ({ b, c: openCaseOf(state, b) })).filter((x) => x.c);
  if (dup.length) throw httpError(409, '이미 열린 사건에 포함된 배치입니다: ' + dup.map((x) => `${x.b} → ${x.c.id}(${x.c.status})`).join(', ') + ' — 기존 사건에서 처리하세요', { existing: dup.map((x) => x.c.id) });
  const c = {
    id: nextId(state, 'case', 'CASE-'),
    title: title || ids.join(', ') + ' 클레임 누적',
    batchIds: ids,
    status: CASE.INTAKE,
    prevStatus: null,
    createdAt: now(),
    history: [{ at: now(), from: null, to: CASE.INTAKE, why: source || '사건 접수' }],
    judgmentSnapshot: null,
    submissions: [], replies: [], aiDrafts: [], approvedBatchIds: [], plan: null, planHistory: [], notes: [],
    extensionAtApproval: null, downgraded: false,
  };
  state.cases.push(c);
  audit(state, '사람(품질팀)', '사건 접수', `${c.title} — 배치 ${ids.join(', ')}`, c.id);
  return c;
}

function judgeCase(state, caseId) {
  const c = findCase(state, caseId);
  const J = judge(state);
  c.judgmentSnapshot = snapshotOf(J, c.batchIds);
  if (c.status === CASE.INTAKE || c.status === CASE.JUDGED) setCaseStatus(state, c, CASE.JUDGED, '규칙 엔진 판정');
  audit(state, '시스템(규칙 엔진)', '판정', c.batchIds.map((b) => `${b} ${J.judgments[b].base_status} (생산 ${pct(J.judgments[b].rateP)} / 출하 ${pct(J.judgments[b].rateS)})`).join('; '), c.id);
  return caseView(state, c, J);
}

function caseContext(state, c, J) {
  const model = getModel();
  J = J || judge(state);
  const items = c.batchIds.map((b) => J.judgments[b]);
  const submittable = items.filter((i) => R.isSubmittable(i.base_status)).map((i) => i.batch_id);
  const sensitivity = c.batchIds.map((b) => R.customerSensitivity(model, b, J.claims));
  const scope = R.recallScope(model, submittable.length ? submittable : c.batchIds, J.claims);
  const preventive = J.preventive.filter((p) => p.triggers.some((t) => c.batchIds.includes(t)));
  return { base_date: BASE_DATE, items, submittable, sensitivity, scope, preventive };
}

async function prepareSubmissionDraft(state, caseId) {
  const c = findCase(state, caseId);
  const J = judge(state);
  const ctx = caseContext(state, c, J);
  const before = JSON.stringify(J.judgments);
  const r = await ai.prepareSubmission(ctx);
  const draft = { id: nextId(state, 'ai', 'AI-'), kind: '상신 준비', at: now(), mode: r.mode, model: r.model, reason: r.reason, output: r.output, violations: r.violations, label: 'AI 초안' };
  c.aiDrafts.push(draft);
  const after = JSON.stringify(judge(state).judgments);
  audit(state, r.mode, 'AI 상신 초안 생성', `${r.mode}${r.reason ? ' (' + r.reason + ')' : ''} · 금지 표현 ${r.violations.length}건 · 판정 변경 ${before === after ? '없음' : '있음(오류)'}`, c.id, { draftId: draft.id });
  return draft;
}

function submitCase(state, caseId, { draft_id, actor } = {}) {
  const c = findCase(state, caseId);
  // F11: 순서 검증
  if (c.status === CASE.INTAKE) throw httpError(409, '먼저 규칙 판정을 실행하세요(접수 상태에서는 상신 불가)');
  if (c.status === CASE.SUBMITTED) throw httpError(409, '이미 상신되어 위원회 회신 대기 중입니다');
  if (APPROVAL_STATES.has(c.status) || c.status === CASE.DONE) throw httpError(409, '이미 회수 의결된 사건입니다. 판정 변경(재검증 필요) 없이 재상신할 수 없습니다');
  if (c.status === CASE.REJECTED) {
    const review = state.tasks.find((t) => t.caseId === c.id && t.key === 'RESUBMIT_REVIEW' && t.status !== TASK.CANCEL);
    if (!review || review.status !== TASK.DONE) throw httpError(409, '거절 후 재상신은 "거절 사유 검토" 작업을 완료한 뒤에만 가능합니다');
  }
  if (c.status === CASE.HOLD) {
    const open = state.infoRequests.filter((r) => r.caseId === c.id && r.status !== '회신 완료');
    if (open.length) throw httpError(409, '확인요청 회신 대기 중: ' + open.map((r) => r.id).join(', '));
  }
  const J = judge(state);
  const ctx = caseContext(state, c, J);
  if (ctx.submittable.length === 0) throw httpError(409, '상신할 배치가 없습니다(회수 대상·분모 민감 아님)');
  const sub = {
    id: nextId(state, 'sub', 'SUB-'),
    version: c.submissions.length + 1,
    at: now(),
    status: '회신 대기',
    items: ctx.items.filter((i) => ctx.submittable.includes(i.batch_id)).map((i) => ({
      batch_id: i.batch_id, status: i.base_status, rateP: i.rateP, rateS: i.rateS, confirmed_qty: i.confirmed_qty,
    })),
    sensitivity: ctx.sensitivity,
    unknowns: ctx.scope.filter((s) => s.unverified && state.c105Confirmed[s.customer_id] == null).map((s) => `${s.customer_id} SBL 출하 기록 없음(클레임 ${s.claim_qty} EA) [미확인]`),
    draftId: draft_id || (c.aiDrafts.filter((d) => d.kind === '상신 준비').slice(-1)[0] || {}).id || null,
    resubmission: c.submissions.length > 0,
  };
  c.submissions.push(sub);
  c.judgmentSnapshot = snapshotOf(J, c.batchIds);
  setCaseStatus(state, c, CASE.SUBMITTED, sub.resubmission ? '재상신 — 회신 확정까지 이전 의결 효력 정지' : '품질위원회 상신');
  audit(state, actor || '사람(품질팀)', sub.resubmission ? '위원회 재상신' : '위원회 상신', sub.items.map((i) => `${i.batch_id} ${i.status} 생산 ${pct(i.rateP)} / 출하 ${pct(i.rateS)}`).join('; '), c.id, { submissionId: sub.id });
  return sub;
}

async function interpretReply(state, caseId, text) {
  const c = findCase(state, caseId);
  const r = await ai.interpretReply(text, { case_id: c.id, status: c.status, batches: c.batchIds });
  const draft = { id: nextId(state, 'ai', 'AI-'), kind: '회신 해석', at: now(), mode: r.mode, model: r.model, reason: r.reason, input: text, output: r.output, violations: [], label: 'AI 분류 제안(담당자 확정 필요)' };
  c.aiDrafts.push(draft);
  audit(state, r.mode, 'AI 회신 해석', `제안 분류: ${r.output.classification}${r.reason ? ' · ' + r.reason : ''}`, c.id, { draftId: draft.id });
  return draft;
}

// 의결 효력 정지(F1): 의결 배치 비움, 의결 기반 작업 재검증 필요/취소, 발송된 통지는 정정 통지 작업으로
function suspendApproval(state, c, mode, reason) {
  c.approvedBatchIds = [];
  if (c.plan && c.plan.status !== '취소') {
    c.plan.status = mode === 'cancel' ? '취소' : '재검증 필요';
    audit(state, '시스템', '재공급 계획 상태 변경', `${c.plan.status} — ${reason}`, c.id);
  }
  const sent = [];
  state.tasks.filter((t) => t.caseId === c.id && t.dependsOnJudgment).forEach((t) => {
    if (t.status === TASK.DONE) { if (t.sent || PLAN_TASK_KINDS.has(t.kind)) sent.push(t); return; }
    if (t.status === TASK.CANCEL) return;
    if (mode === 'cancel') { t.prevStatus = t.status; t.status = TASK.CANCEL; } else { if (t.status !== TASK.REVALIDATE) t.prevStatus = t.status; t.status = TASK.REVALIDATE; }
    t.note = reason;
    audit(state, '시스템', '작업 상태 변경(의결 효력 정지)', `${t.id} ${t.title} → ${t.status}`, c.id, { taskId: t.id });
  });
  if (mode === 'cancel' && sent.length) createCorrectionTask(state, c, c.batchIds, sent, reason);
}

function createCorrectionTask(state, c, batchIds, sentTasks, why) {
  const customers = [...new Set(sentTasks.map((t) => t.customer_id).filter(Boolean))];
  return upsertTask(state, c, {
    key: 'CORRECTION:' + batchIds.join(',') + ':' + (state.seq.ev || 0) + ':' + (state.seq.sub || 0), kind: '정정 통지·영업 확인', dependsOnJudgment: false,
    title: `[정정 통지·영업 확인] ${batchIds.join(', ')} ${why} — 발송·실행된 통지·작업 ${sentTasks.length}건 재확인 (고객 ${customers.join(', ') || '-'}) · 다시 확인할 부서: 영업 통지 / 생산 순서 / 재무 채권`,
    dept: '영업·생산·재무', batchIds,
    payload: { recheck: ['영업: 고객 회수 통지·납기 변경 정정 안내', '생산: 재공급 생산 순서 원복 여부', '재무: 채권 상계·보류 영향 재확인'], sent_tasks: sentTasks.map((t) => t.id) },
    tag: '',
  });
}

// 위원회 회신 확정 (사람이 분류 확정). J3: 회수 실행은 이 의결 후에만.
function recordReply(state, caseId, { classification, text, requested_items, actor } = {}) {
  const c = findCase(state, caseId);
  if (!REPLY_CLASSES.includes(classification)) throw httpError(400, '분류는 승인 / 추가자료 요구 / 거절 중 하나를 담당자가 선택해야 합니다');
  const sub = c.submissions.filter((s) => s.status === '회신 대기').slice(-1)[0];
  if (!sub || c.status !== CASE.SUBMITTED) throw httpError(409, '회신 대기 중인 상신이 없습니다');
  const items = Array.isArray(requested_items) ? requested_items.map((x) => String(x).trim()).filter(Boolean) : [];
  const reply = { at: now(), submissionId: sub.id, classification, text: text || '', requested_items: items, actor: actor || '품질위원회[모의]' };
  c.replies.push(reply);
  sub.status = classification;
  const ev = addEvent(state, 'committee_reply', { case_id: c.id, classification, text }, '[모의] 품질위원회 회신');
  audit(state, reply.actor, '위원회 회신', `${classification}: ${text || ''}`, c.id, { eventId: ev.id });

  if (classification === '승인') {
    c.approvedBatchIds = sub.items.map((i) => i.batch_id);
    c.extensionAtApproval = state.settings.extensionOn;
    setCaseStatus(state, c, CASE.APPROVED, '품질위원회 회수 의결');
    generateRecallTasks(state, c);
  } else if (classification === '추가자료 요구') {
    suspendApproval(state, c, 'revalidate', '위원회 추가자료 요구 — 의결 효력 정지');
    setCaseStatus(state, c, CASE.HOLD, '추가자료 요구');
    (items.length ? items : [text || '추가 자료']).forEach((item) => createInfoRequestsFor(state, c, item));
  } else {
    suspendApproval(state, c, 'cancel', '위원회 거절 — 회수 작업 취소');
    setCaseStatus(state, c, CASE.REJECTED, '거절 — 조사 계속');
    ensureInvestigationTrack(state, c);
    upsertTask(state, c, { key: 'RESUBMIT_REVIEW', kind: '재상신 검토', title: '거절 사유 검토 및 재상신/보류 결정(완료해야 재상신 가능)', dept: '품질팀', dependsOnJudgment: false, batchIds: c.batchIds, tag: '[사람 판단]' });
  }
  ev.effect = `사건 ${c.id} → ${c.status}`;
  return reply;
}

// ---------------- 작업 생성 ----------------
function upsertTask(state, c, spec) {
  let t = state.tasks.find((x) => x.caseId === c.id && x.key === spec.key && x.status !== TASK.CANCEL);
  if (t) {
    if (t.status === TASK.REVALIDATE) {
      t.status = t.prevStatus && t.prevStatus !== TASK.REVALIDATE ? t.prevStatus : TASK.WAIT;
      t.note = '재검증 완료';
      audit(state, '시스템', '작업 재검증 완료', `${t.id} ${t.title} → ${t.status}`, c.id);
    }
    const keepDraft = t.sent || (t.payload && t.payload.source && t.payload.source.startsWith('AI'));
    Object.assign(t, { batchIds: spec.batchIds, title: spec.title });
    if (!keepDraft && spec.payload) t.payload = spec.payload;
    return t;
  }
  t = {
    id: nextId(state, 'task', 'T-'), caseId: c.id, key: spec.key, kind: spec.kind, title: spec.title, dept: spec.dept,
    status: TASK.WAIT, prevStatus: null, batchIds: spec.batchIds || [], dependsOnJudgment: spec.dependsOnJudgment !== false,
    customer_id: spec.customer_id || null, payload: spec.payload || null, sent: false, tag: spec.tag || '', createdAt: now(), note: '',
    track: spec.track || '회수',
  };
  state.tasks.push(t);
  audit(state, '시스템', '작업 생성', `${t.id} [${t.dept}] ${t.title}`, c.id, { taskId: t.id });
  return t;
}

function ensureInfoRequest(state, c, spec) {
  let r = state.infoRequests.find((x) => x.caseId === c.id && x.key === spec.key);
  if (r) return r;
  r = { id: nextId(state, 'ir', 'IR-'), caseId: c.id, key: spec.key, kind: spec.kind, to: spec.to, question: spec.question, status: '대기', answer: null, answeredAt: null, history: [], customer_id: spec.customer_id || null, batchIds: spec.batchIds || c.batchIds, options: spec.options || null, createdAt: now() };
  state.infoRequests.push(r);
  audit(state, '시스템', '확인요청 생성', `${r.id} → ${r.to}: ${r.question}`, c.id, { irId: r.id });
  return r;
}

function c105LabelSpec(row) {
  return {
    key: 'C105_LABEL:' + row.customer_id, kind: 'C105_LABEL', to: '영업 → ' + row.customer_id, customer_id: row.customer_id,
    question: `${row.customer_id} 클레임 ${row.claim_count}건(${row.claim_qty.toLocaleString()} EA)의 제품 라벨상 배치 번호·출하 경로 확인 (${row.batches.join(', ')})`,
    options: [C105.CONFIRM, C105.WRONG, C105.UNKNOWN],
  };
}

function createInfoRequestsFor(state, c, item) {
  const J = judge(state);
  const scope = R.recallScope(getModel(), c.batchIds, J.claims);
  const unverified = scope.filter((s) => s.unverified);
  const mentions = unverified.filter((u) => item.includes(u.customer_id));
  const targets = mentions.length ? mentions : (/귀속|출하 경로|SBL/.test(item) ? unverified : []);
  if (targets.length) {
    targets.forEach((u) => {
      ensureInfoRequest(state, c, c105LabelSpec(u));
      ensureInfoRequest(state, c, {
        key: 'C105_SBL:' + u.customer_id, kind: 'C105_SBL', to: '품질팀(물류)', customer_id: u.customer_id,
        question: `${u.batches.join(', ')} → ${u.customer_id} SBL 출하 기록 누락 여부 확인`,
        options: ['SBL 누락 확인', 'SBL 누락 아님', '미확인(기록 없음)'],
      });
    });
  } else {
    ensureInfoRequest(state, c, { key: 'GEN:' + item, kind: 'GENERIC', to: '품질팀', question: item, options: null });
  }
}

function ensureInvestigationTrack(state, c) {
  // J5: 원인조사는 별도 트랙 — 회수 상태와 분리, 판정 변경의 영향을 받지 않음
  HYPOTHESES.forEach((h) => upsertTask(state, c, {
    key: 'INV:' + h.id, kind: '원인조사', title: `[원인조사 ${h.id}] ${h.title} — ${h.check}`, dept: '품질팀(조사)',
    dependsOnJudgment: false, batchIds: c.batchIds, track: '원인조사', tag: '[가설·미확정]',
  }));
  upsertTask(state, c, {
    key: 'INV:CTRL', kind: '원인조사', title: '[원인조사] 보류 로트 투입·보류 배치 출하 승인 기록 확인(과정상 원인)', dept: '품질팀(조사)',
    dependsOnJudgment: false, batchIds: c.batchIds, track: '원인조사', tag: '[미확인]',
  });
}

function noticeDraft(row, batchIds) {
  const lines = [
    '[초안 — 발송 전 품질위원회 의결 및 영업 승인 필요]',
    '제목: [Corevia Cosmetics] 더마(PL-02) 제품 일부 생산분 회수 안내',
    '',
    `${row.customer_name}(${row.customer_id}) 담당자님께,`,
    '',
    '귀사에 납품된 당사 더마(PL-02) 제품 중 아래 생산분에서 규격이탈이 확인되어, 당사 품질정책에 따라 해당 생산분의 회수를 진행하고자 안내드립니다.',
    '',
    `1. 대상 생산분(배치 번호): ${batchIds.join(', ')}`,
  ];
  if (row.unverified) {
    lines.push(`2. 귀사 클레임 접수 내역 기준: ${row.claim_count}건 / ${row.claim_qty.toLocaleString()} EA (당사 출하 기록은 확인 중입니다)`);
  } else {
    lines.push('2. 당사 출하 기록 기준 귀사 납품 내역 (귀사 입고 기록과 다를 수 있습니다)');
    row.shipments.forEach((s) => lines.push(`   - 출하일 ${s.ship_date} / ${s.batch_id} / ${s.qty.toLocaleString()} EA`));
  }
  lines.push('3. 요청 사항', '   - 위 생산분의 판매·사용을 중지하고 별도 보관해 주십시오.', '   - 귀사 보유 수량(창고·매장별)을 회신 기한까지 회신해 주십시오.',
    '4. 향후 절차', '   - 회수 방법과 일정, 대체 제품 공급 일정은 보유 수량 회신을 받은 뒤 별도로 협의드리겠습니다.', '   - 원인은 현재 조사 중이며, 확인되는 대로 안내드리겠습니다.',
    '5. 문의: 영업팀 담당자', '', '이번 일로 불편을 드려 죄송합니다. 신속히 처리하겠습니다.', 'Corevia Cosmetics 영업팀 드림');
  return lines.join('\n');
}

function generateExtensionTasks(state, c, J) {
  const model = getModel();
  const approved = c.approvedBatchIds;
  const lots = [...new Set(approved.flatMap((b) => model.batchById[b].input_lot_ids))];
  lots.forEach((lot) => {
    upsertTask(state, c, {
      key: 'LOT:' + lot, kind: '로트 격리', title: `${lot} 사용 금지·격리(잔량 수치는 원본 불일치로 표시하지 않음)`, dept: '품질·조달',
      batchIds: approved, tag: '[원본] 입고검사 보류 로트',
    });
    ensureInfoRequest(state, c, { key: 'LOT_REMAIN:' + lot, kind: 'LOT_REMAIN', to: '조달·창고', question: `${lot} 실물 잔량 확인(원본 투입량 > 입고량 불일치로 계산 불가)`, batchIds: approved });
  });
  J.preventive.filter((p) => p.triggers.some((t) => approved.includes(t))).forEach((p) => {
    const trig = p.triggers.filter((t) => approved.includes(t));
    upsertTask(state, c, {
      key: 'PREV_HOLD:' + p.batch_id, kind: '예방 점검', title: `[예방 점검] ${p.batch_id} 미출하 잔여분 약 ${p.unshipped_qty.toLocaleString()} EA 출하 보류 검토 (재판정 기준 확정 불량 ${p.trigger_qty.toLocaleString()} EA)`,
      dept: '품질팀', batchIds: trig, payload: { preventive_batch: p.batch_id }, track: '예방 점검', tag: '[도출] 생산량−SBL 출하량',
    });
    upsertTask(state, c, {
      key: 'PREV_TEST:' + p.batch_id, kind: '예방 점검', title: `[예방 점검] ${p.batch_id} 보관 샘플 재검사`, dept: '품질팀',
      batchIds: trig, payload: { preventive_batch: p.batch_id }, track: '예방 점검',
    });
    Object.keys(p.customers).forEach((cid) => upsertTask(state, c, {
      key: 'PREV_CUST:' + cid, kind: '보유분 확인 요청', title: `[예방 점검] ${cid} 보유분 확인 요청(회수 통지 아님)`, dept: '영업',
      customer_id: cid, batchIds: trig, payload: { preventive_batches: J.preventive.filter((x) => x.customers[cid]).map((x) => x.batch_id) }, track: '예방 점검', tag: '[확장 a]',
    }));
  });
}

function generateRecallTasks(state, c) {
  const model = getModel();
  const J = judge(state);
  const approved = c.approvedBatchIds;
  const scope = R.recallScope(model, approved, J.claims);
  upsertTask(state, c, {
    key: 'SCOPE', kind: '회수 범위 확정', title: `회수 범위 확정: ${approved.join(', ')} — 고객 ${scope.map((s) => s.customer_id + (s.unverified && state.c105Confirmed[s.customer_id] == null ? '[미확인]' : '')).join(', ')}`,
    dept: '품질팀', batchIds: approved, payload: { scope: scope.map((s) => ({ customer_id: s.customer_id, shipped_qty: s.shipped_qty, claim_qty: s.claim_qty, unverified: s.unverified })) }, tag: '[원본] SBL ∪ 클레임',
  });
  // F7: 회수 대상 배치 미출하 잔여분 출하 정지·격리 (N4 조건)
  approved.forEach((b) => {
    const j = J.judgments[b];
    upsertTask(state, c, {
      key: 'HOLD_SHIP:' + b, kind: '출하 정지', title: `[회수] ${b} 미출하 잔여분 약 ${j.unshipped_qty.toLocaleString()} EA 출하 정지·격리 ([도출] 생산량−SBL 출하량, 창고 실물 확인 필요)`,
      dept: '품질·물류', batchIds: [b], tag: '[도출]',
    });
  });
  // 고객 통지 초안 — 회수 대상 고객만. 출하 근거가 없는 고객은 확인요청 회신 후(J7)
  scope.forEach((row) => {
    if (row.unverified && state.c105Confirmed[row.customer_id] == null) { ensureInfoRequest(state, c, c105LabelSpec(row)); return; }
    upsertTask(state, c, {
      key: 'NOTICE:' + row.customer_id, kind: '고객 통지', title: `${row.customer_id} ${row.customer_name} 회수 통지 초안 발송(모의)`,
      dept: '영업', customer_id: row.customer_id, batchIds: row.batches, payload: { draft: noticeDraft(row, row.batches), source: '템플릿 초안' }, tag: '[템플릿 초안]',
    });
  });
  ensureInvestigationTrack(state, c);
  if (c.extensionAtApproval) generateExtensionTasks(state, c, J);
  upsertTask(state, c, { key: 'SUPPLY_REQ', kind: '재공급 계획 요청', title: '재공급 계획 수립 요청(생산 L-02·영업)', dept: '생산·영업', batchIds: approved });
  upsertTask(state, c, { key: 'FIN_AR', kind: '재무 채권 확인', title: `회수 고객 채권 영향 확인(상계·지급 보류 가능성) — ${scope.filter((s) => !s.unverified).map((s) => s.customer_id).join(', ')} [금액은 가정, 손실 확정 금지]`, dept: '재무', batchIds: approved });
}

// ---------------- 확인요청 회신 ----------------
function answerInfoRequest(state, irId, { answer, qty, note, actor } = {}) {
  const r = state.infoRequests.find((x) => x.id === irId);
  if (!r) throw httpError(404, '확인요청 없음: ' + irId);
  if (r.status === '회신 완료') throw httpError(409, '이미 회신된 확인요청');
  const ans = answer == null ? '' : String(answer).trim();
  // F8: 선택지가 있는 확인요청은 선택지 값만 받음
  if (r.options && !r.options.includes(ans)) throw httpError(400, '회신은 다음 중 하나를 선택해야 합니다: ' + r.options.join(' / '));
  if (!r.options && !ans) throw httpError(400, '회신 내용이 필요합니다');
  let qtyNum = null;
  if (qty != null && qty !== '') {
    qtyNum = Number(qty);
    if (!Number.isInteger(qtyNum) || qtyNum < 0) throw httpError(400, '수량은 0 이상의 정수여야 합니다: ' + qty);
  }
  const c = state.cases.find((x) => x.id === r.caseId);
  const ev = addEvent(state, 'info_reply', { ir_id: irId, answer: ans, qty: qtyNum, note }, '[모의] 확인요청 회신');
  r.history = r.history || [];
  r.history.push({ at: now(), answer: ans, note: note || '' });
  if (ans.startsWith('미확인')) {
    // 미확인 → 보류 유지(확인요청은 열린 상태로 남아 재상신을 계속 막음)
    r.answer = ans; r.note = note || '';
    ev.effect = `${r.id} 미확인 — 보류 유지, 재요청 필요`;
    audit(state, actor || '회신자[모의]', '확인요청 회신(미확인)', `${r.id}: ${ans} — 보류 유지`, r.caseId, { irId, eventId: ev.id });
    return r;
  }
  r.status = '회신 완료'; r.answer = ans; r.note = note || ''; r.answeredAt = now();
  audit(state, actor || '회신자[모의]', '확인요청 회신', `${r.id}: ${ans}${note ? ' — ' + note : ''}`, r.caseId, { irId, eventId: ev.id });
  if (r.kind === 'C105_LABEL') {
    const J = judge(state);
    const theirs = J.claims.filter((cl) => cl.customer_id === r.customer_id && c.batchIds.includes(cl.batch_id) && cl.defect_confirmed);
    if (ans === C105.WRONG) {
      // 귀속 오류 → 해당 클레임을 배치에서 분리(오버레이). 원본 복사본은 그대로.
      const before = J;
      theirs.forEach((cl) => {
        state.claimOverrides[cl.claim_id] = { fields: { batch_id: '귀속 미상', status: '귀속 정정' }, reason: '확인요청 회신: 귀속 오류', eventId: ev.id, original_batch: cl.batch_id };
      });
      ev.effect = `${theirs.length}건 클레임 배치 귀속 정정(오버레이)`;
      propagate(state, before, ev);
    } else if (ans === C105.CONFIRM) {
      state.c105Confirmed[r.customer_id] = qtyNum != null ? qtyNum : theirs.reduce((s, x) => s + x.qty_affected, 0);
      ev.effect = `${r.customer_id} 귀속 확인 → 회수 범위 포함, 대체 수량 ${state.c105Confirmed[r.customer_id]} EA [모의]`;
      if (c && approvalActive(c)) generateRecallTasks(state, c);
      if (c && c.plan) refreshPlan(state, c, '확인요청 회신');
    }
  } else {
    ev.effect = '기록';
  }
  return r;
}

// ---------------- 이벤트 ----------------
function addEvent(state, type, input, tag) {
  const ev = { id: nextId(state, 'ev', 'EV-'), type, input, tag: tag || '', occurred_on: (input && input.occurred_on) || BASE_DATE, applied_at: now(), effect: '' };
  state.events.push(ev);
  return ev;
}

const EVENT_LABEL = {
  claim_correction: '클레임 판정 정정', claim_confirm: '클레임 확정', news: '언론 보도', holding_reply: '고객 보유 수량 회신',
  procurement_reply: '조달 회신', committee_reply: '위원회 회신', info_reply: '확인요청 회신', claim_intake: '사건 접수',
};

// 회수 범위(의결·상신 대상) 안의 고객인지
// 회수 범위 고객별 보유 수량 상한 = 해당 고객·회수 배치 SBL 출하량(출하 기록 없는 고객은 확인 회신 수량) (F22)
function scopeCustomers(state) {
  const J = judge(state);
  const caps = new Map();
  state.cases.forEach((c) => {
    const batches = c.approvedBatchIds.length ? c.approvedBatchIds : caseContext(state, c, J).submittable;
    R.recallScope(getModel(), batches, J.claims).forEach((r) => {
      const cap = r.shipped_qty > 0 ? r.shipped_qty : (state.c105Confirmed[r.customer_id] != null ? state.c105Confirmed[r.customer_id] : 0);
      caps.set(r.customer_id, Math.max(caps.get(r.customer_id) || 0, cap));
    });
  });
  return caps;
}

function applyEvent(state, input) {
  if (!input || typeof input !== 'object') throw httpError(400, '이벤트 입력이 필요합니다');
  const type = input.type;
  const model = getModel();
  if (input.occurred_on != null && !isIsoDate(input.occurred_on)) throw httpError(400, '발생일은 YYYY-MM-DD 형식이어야 합니다: ' + input.occurred_on);
  if (type === 'claim_correction' || type === 'claim_confirm') {
    const ids = type === 'claim_confirm' ? [input.claim_id].concat(input.claim_ids || []).filter(Boolean) : (Array.isArray(input.claim_ids) ? input.claim_ids : []);
    if (ids.length === 0) throw httpError(400, '클레임 ID가 필요합니다');
    ids.forEach((id) => { if (!model.claims.find((c) => c.claim_id === id)) throw httpError(404, '클레임 없음: ' + id); });
    const before = judge(state);
    const ev = addEvent(state, type, input, '[모의] 품질팀 판정 입력');
    ids.forEach((id) => {
      state.claimOverrides[id] = type === 'claim_correction'
        ? { fields: { defect_confirmed: false, status: '정정(재조사)' }, reason: input.reason || '규격이탈 아님으로 정정[모의]', eventId: ev.id }
        : { fields: { defect_confirmed: true, status: '확정' }, reason: input.reason || '규격이탈 확정[모의]', eventId: ev.id };
    });
    audit(state, '사람(품질팀)[모의]', EVENT_LABEL[type], `${ids.join(', ')} — ${input.reason || ''}`, null, { eventId: ev.id });
    propagate(state, before, ev);
    return ev;
  }
  if (type === 'news') {
    const before = judge(state);
    const ev = addEvent(state, 'news', input, '[원본] ext_news_quality_incident / 입력');
    const changed = diffJudgments(before, judge(state));
    ev.effect = `기록만 — 판정 변경 ${changed.length}건 (언론 보도는 회수 근거 아님)`;
    audit(state, '시스템', '언론 보도 기록', ev.effect, null, { eventId: ev.id });
    return ev;
  }
  if (type === 'holding_reply') {
    const cid = input.customer_id;
    if (!cid || !model.customers[cid]) throw httpError(400, '고객 ID가 고객 마스터에 없습니다: ' + (cid || '(없음)'));
    const caps = scopeCustomers(state);
    if (!caps.has(cid)) throw httpError(400, `${cid}는 상신·의결된 회수 범위 고객이 아닙니다`);
    const q = typeof input.qty === 'number' ? input.qty : (typeof input.qty === 'string' && input.qty.trim() !== '' ? Number(input.qty) : NaN);
    if (!Number.isInteger(q) || q < 0) throw httpError(400, '보유 수량은 0 이상의 정수여야 합니다: ' + input.qty);
    const cap = caps.get(cid);
    if (q > cap) throw httpError(400, `${cid} 보유 수량 ${q.toLocaleString()} EA가 회수 배치 출하량 ${cap.toLocaleString()} EA(${cap > 0 ? '당사 SBL 출하 기록' : '출하 기록 없음·귀속 미확인'})를 넘습니다 — 회신 수량을 다시 확인하세요`);
    state.holdingReplies[cid] = q;
    const ev = addEvent(state, type, { ...input, qty: q }, '[모의] 고객 회신');
    ev.effect = `${cid} 보유 ${q.toLocaleString()} EA → 대체 필요 수량 갱신`;
    audit(state, '고객[모의]', '고객 보유 수량 회신', ev.effect, null, { eventId: ev.id });
    state.cases.filter((c) => c.plan).forEach((c) => refreshPlan(state, c, '고객 보유 수량 회신'));
    return ev;
  }
  if (type === 'procurement_reply') {
    if (!isIsoDate(input.available_date)) throw httpError(400, '원료 확보일은 YYYY-MM-DD 형식이어야 합니다: ' + (input.available_date || '(없음)'));
    let kg = null;
    if (input.available_kg != null && input.available_kg !== '') {
      kg = Number(input.available_kg);
      if (!Number.isFinite(kg) || kg < 0) throw httpError(400, '가용량(kg)은 0 이상의 숫자여야 합니다: ' + input.available_kg);
    }
    state.procurementReply = { available_date: input.available_date, available_kg: kg, lot_id: input.lot_id || '', note: input.note || '' };
    const ev = addEvent(state, type, input, '[모의] 조달 회신');
    ev.effect = `원료 확보일 ${input.available_date} — 재공급 계획 일정 계산 가능`;
    audit(state, '조달[모의]', '조달 회신', ev.effect, null, { eventId: ev.id });
    state.cases.filter((c) => c.plan).forEach((c) => refreshPlan(state, c, '조달 회신'));
    return ev;
  }
  if (type === 'claim_intake') {
    const c = createCase(state, { title: input.title, batch_ids: input.batch_ids, source: '이벤트: 클레임 누적 접수' });
    const ev = addEvent(state, type, input, '사건 입력');
    ev.effect = `${c.id} 생성`;
    return ev;
  }
  throw httpError(400, '알 수 없는 이벤트 유형: ' + type);
}

function diffJudgments(before, after) {
  return Object.keys(after.judgments).filter((b) => before.judgments[b].status !== after.judgments[b].status).map((b) => ({
    batch_id: b, from: before.judgments[b].status, to: after.judgments[b].status, rateP: after.judgments[b].rateP, rateS: after.judgments[b].rateS,
  }));
}

// J6: 판정이 바뀌면 그 판정에 기댄 작업은 재검증 필요, 상신은 재상신 필요
function propagate(state, before, ev) {
  const after = judge(state);
  const changed = diffJudgments(before, after);
  const effects = [];
  state.cases.forEach((c) => {
    if (!c.judgmentSnapshot) return;
    const caseChanged = c.batchIds.filter((b) => c.judgmentSnapshot[b].status !== after.judgments[b].base_status);
    const prevSnapshot = c.judgmentSnapshot;
    if (caseChanged.length === 0) { c.judgmentSnapshot = snapshotOf(after, c.batchIds); return; }
    const msg = caseChanged.map((b) => `${b} ${prevSnapshot[b].status} → ${after.judgments[b].base_status} (생산 ${pct(after.judgments[b].rateP)} / 출하 ${pct(after.judgments[b].rateS)})`).join('; ');
    audit(state, '시스템(규칙 엔진)', '판정 변경 감지', msg, c.id, { eventId: ev && ev.id });
    effects.push(`${c.id}: ${msg}`);
    c.judgmentSnapshot = snapshotOf(after, c.batchIds);
    const stillTarget = c.batchIds.filter((b) => R.isSubmittable(after.judgments[b].base_status));
    if (!POST_SUBMIT.has(c.status)) {
      if (c.status === CASE.JUDGED) audit(state, '시스템', '판정 갱신', '상신 전이므로 판정만 갱신', c.id);
      c.downgraded = stillTarget.length === 0;
      return;
    }
    const downgraded = caseChanged.filter((b) => R.isSubmittable(prevSnapshot[b].status) && !R.isSubmittable(after.judgments[b].base_status));
    const caseTasks = state.tasks.filter((t) => t.caseId === c.id && t.dependsOnJudgment);
    const sentAffected = [];
    caseTasks.forEach((t) => {
      if (!t.batchIds.some((b) => caseChanged.includes(b))) return;
      if (t.status === TASK.DONE) { if (t.sent || PLAN_TASK_KINDS.has(t.kind)) sentAffected.push(t); return; }
      if (t.status === TASK.CANCEL) return;
      const onlyDowngraded = t.batchIds.every((b) => !stillTarget.includes(b));
      if (onlyDowngraded && downgraded.length) {
        // 예방 점검은 다른 회수 대상 배치 기준으로 유지될 수 있음 → 취소 대신 재검증
        const pb = t.payload && t.payload.preventive_batch;
        if (pb && after.judgments[pb] && after.judgments[pb].status === S.PREVENTIVE) {
          if (t.status !== TASK.REVALIDATE) t.prevStatus = t.status;
          t.status = TASK.REVALIDATE; t.note = `트리거 배치 하향 — 다른 회수 대상 배치(${after.judgments[pb].preventive.triggers.join(', ')}) 기준 예방 점검 유지 여부 확인`;
        } else {
          t.prevStatus = t.status; t.status = TASK.CANCEL; t.note = '판정 하향으로 취소';
        }
      } else {
        if (t.status !== TASK.REVALIDATE) t.prevStatus = t.status;
        t.status = TASK.REVALIDATE; t.note = '판정 변경으로 재검증 필요';
      }
      audit(state, '시스템', '작업 상태 변경', `${t.id} ${t.title} → ${t.status}`, c.id, { taskId: t.id });
    });
    const sentForDown = sentAffected.filter((t) => t.batchIds.some((b) => downgraded.includes(b)));
    if (downgraded.length && sentForDown.length) createCorrectionTask(state, c, downgraded, sentForDown, '판정 하향');
    c.submissions.forEach((s) => {
      if (s.status === '회신 대기' || s.status === '승인') s.status = stillTarget.length ? '재상신 필요' : '철회(판정 하향)';
    });
    if (c.plan && c.plan.status !== '취소') {
      c.plan.status = stillTarget.length ? '재검증 필요' : '취소';
      audit(state, '시스템', '재공급 계획 상태 변경', `${c.plan.status}`, c.id);
    }
    if (stillTarget.length) {
      c.approvedBatchIds = c.approvedBatchIds.filter((b) => stillTarget.includes(b));
      setCaseStatus(state, c, CASE.REVALIDATE, '판정 변경 — 재상신 필요');
    } else {
      c.approvedBatchIds = [];
      c.downgraded = true;
      setCaseStatus(state, c, CASE.JUDGED, '판정 하향 — 상신 대상 없음(조사·소명/기준 미달)');
    }
  });
  if (ev) ev.effect = `판정 변경 ${changed.length}건${changed.length ? ': ' + changed.map((d) => `${d.batch_id} ${d.from}→${d.to}`).join(', ') : ''}${effects.length ? ' · 영향 사건 ' + effects.length + '건' : ''}`;
  return changed;
}

// ---------------- 재공급 계획 ----------------
function planInput(state, c, assumptions) {
  const J = judge(state);
  return {
    scope: R.recallScope(getModel(), c.approvedBatchIds, J.claims),
    holdingReplies: state.holdingReplies,
    c105Confirmed: state.c105Confirmed,
    procurementReply: state.procurementReply,
    assumptions: assumptions || (c.plan && c.plan.assumptions) || {},
  };
}

// 계획 기반 작업을 재검증 필요로 (F2)
function revalidatePlanTasks(state, c, why) {
  state.tasks.filter((t) => t.caseId === c.id && PLAN_TASK_KINDS.has(t.kind) && [TASK.WAIT, TASK.DOING].includes(t.status)).forEach((t) => {
    t.prevStatus = t.status; t.status = TASK.REVALIDATE; t.note = why;
    audit(state, '시스템', '작업 상태 변경(계획 재검증)', `${t.id} ${t.title} → 재검증 필요`, c.id, { taskId: t.id });
  });
}

function computeCasePlan(state, caseId, assumptions) {
  const c = findCase(state, caseId);
  requireApproval(c, '재공급 계획 계산');
  const input = planInput(state, c, assumptions);
  input.assumptions = validateAssumptions(input.assumptions); // 검증 실패 시 상태 변경 전에 400
  const result = computePlan(getModel(), input);
  const prev = c.plan;
  // F2: 상신·승인 이력이 있는 계획을 다시 계산하면 이전 버전을 보존하고 새 버전은 재승인 필요
  if (prev && (['상신', '승인'].includes(prev.status) || (prev.approvals && Object.keys(prev.approvals).length))) {
    c.planHistory.push({ version: prev.version, status: prev.status, selected: prev.selected, approvals: prev.approvals, exception_reason: prev.exception_reason || null, computedAt: prev.computedAt, supersededAt: now() });
    revalidatePlanTasks(state, c, '재공급 계획 재계산 — 새 버전 재승인 필요');
    if (PLAN_STATES.has(c.status)) setCaseStatus(state, c, CASE.APPROVED, '재공급 계획 재계산 — 재승인 필요');
    audit(state, '시스템', '재공급 계획 버전 보존', `v${prev.version} (${prev.status}, 대안 ${prev.selected || '-'}, 승인 ${Object.keys(prev.approvals || {}).join('+') || '-'}) 보존`, c.id);
  }
  c.plan = {
    id: 'PLAN-' + c.id.slice(5),
    version: prev ? (prev.version || 1) + 1 : 1,
    status: result.status,
    assumptions: input.assumptions,
    result,
    selected: null,
    approvals: {},
    computedAt: now(),
    explain: prev ? prev.explain : null,
  };
  audit(state, '시스템', '재공급 대안 계산', `v${c.plan.version} ${result.status} · 대체 ${result.replacement_total.toLocaleString()} EA · ` + result.alternatives.map((a) => `${a.id}: 완료 ${a.replacement_done || '미완료'} / 영향 주문 ${a.delayed_orders.length}건 최대 ${a.max_delay_days}일 / ${a.feasibility_note.split(':')[0]}`).join(' · '), c.id);
  const t = state.tasks.find((x) => x.caseId === c.id && x.key === 'SUPPLY_REQ');
  if (t && t.status === TASK.WAIT) t.status = TASK.DOING;
  return c.plan;
}

function refreshPlan(state, c, why) {
  if (!c.plan || c.plan.status === '취소') return;
  if (c.plan.status === '재검증 필요') {
    // F2: 재검증 필요 계획은 회신 이벤트로 자동 재계산하지 않음(재상신·재의결 또는 사람의 재계산 필요)
    audit(state, '시스템', '재공급 계획 입력 변경 기록', `${why} — 재검증 필요 계획은 자동 재계산하지 않음`, c.id);
    return;
  }
  if (['상신', '승인'].includes(c.plan.status)) {
    c.plan.status = '재검증 필요';
    revalidatePlanTasks(state, c, `${why} — 상신·승인된 계획의 입력 변경`);
    if (PLAN_STATES.has(c.status)) setCaseStatus(state, c, CASE.APPROVED, '재공급 계획 입력 변경 — 재계산·재승인 필요');
    audit(state, '시스템', '재공급 계획 재검증 필요', `${why} — 상신/승인된 계획의 입력 변경`, c.id);
    return;
  }
  if (!approvalActive(c)) {
    c.plan.status = '재검증 필요';
    audit(state, '시스템', '재공급 계획 재검증 필요', `${why} — 의결 효력이 없어 재계산하지 않음`, c.id);
    return;
  }
  computeCasePlan(state, c.id, c.plan.assumptions);
  audit(state, '시스템', '재공급 계획 재계산', why, c.id);
}

async function explainCasePlan(state, caseId) {
  const c = findCase(state, caseId);
  requireApproval(c, 'AI 대안 설명');
  if (!c.plan) throw httpError(409, '먼저 재공급 대안을 계산하세요');
  const r = await ai.explainPlan(c.plan.result);
  const draft = { id: nextId(state, 'ai', 'AI-'), kind: '재공급 대안 설명', at: now(), mode: r.mode, model: r.model, reason: r.reason, output: r.output, violations: r.violations, label: 'AI 초안' };
  c.aiDrafts.push(draft);
  c.plan.explain = draft.id;
  audit(state, r.mode, 'AI 재공급 대안 설명·대체 공급 안내 초안', `금지 표현 ${r.violations.length}건${r.reason ? ' · ' + r.reason : ''}`, c.id, { draftId: draft.id });
  return draft;
}

function submitPlan(state, caseId, { alternative, exception_reason, actor } = {}) {
  const c = findCase(state, caseId);
  requireApproval(c, '재공급 계획 상신');
  if (!c.plan) throw httpError(409, '재공급 계획 없음');
  if (c.plan.status === '확인 대기') throw httpError(409, '조달 회신 전 — 일정 확정 불가(확인 대기)');
  if (c.plan.status !== '계산 완료') throw httpError(409, '계획 상태가 계산 완료가 아님: ' + c.plan.status + ' (재계산 필요)');
  const alt = c.plan.result.alternatives.find((a) => a.id === alternative);
  if (!alt) throw httpError(400, '대안은 A / B / C 중 하나를 선택하세요');
  if (!alt.feasible) throw httpError(409, '선택한 대안은 실행할 수 없습니다: ' + alt.feasibility_note);
  const reason = exception_reason == null ? '' : String(exception_reason).trim();
  if (alt.over_limit && !reason) throw httpError(409, `대안 ${alt.id}는 한도 초과(${alt.weeks_to_complete}주 > ${c.plan.assumptions.limit_weeks}주) — 예외 사유를 입력해야 상신할 수 있습니다`);
  const required = alt.over_limit && !alt.approvals_required.includes('영업 임원') ? ['영업 임원', ...alt.approvals_required] : alt.approvals_required;
  c.plan.selected = alternative;
  c.plan.status = '상신';
  c.plan.required = required;
  c.plan.approvals = {};
  c.plan.exception_reason = alt.over_limit ? reason : null;
  setCaseStatus(state, c, CASE.PLAN_SUBMITTED, `대안 ${alternative} 상신 — 필요 승인: ${required.join(' + ')}`);
  audit(state, actor || '사람(품질팀·생산)', '재공급 계획 상신', `대안 ${alternative} ${alt.name} · 영향 주문 ${alt.delayed_orders.length}건(최대 ${alt.max_delay_days}일)${alt.over_limit ? ' · 한도 초과 예외 사유: ' + reason : ''}`, c.id);
  return c.plan;
}

function approvePlan(state, caseId, { approver, decision, note } = {}) {
  const c = findCase(state, caseId);
  if (!['승인', '반려'].includes(decision)) throw httpError(400, "결정은 '승인' 또는 '반려'만 입력할 수 있습니다");
  if (!c.plan || c.plan.status !== '상신' || c.status !== CASE.PLAN_SUBMITTED) throw httpError(409, '상신된 재공급 계획이 없습니다');
  requireApproval(c, '재공급 계획 승인');
  if (!c.plan.required.includes(approver)) throw httpError(400, '승인자는 ' + c.plan.required.join(' / ') + ' 중 하나여야 합니다');
  if (c.plan.approvals[approver]) throw httpError(409, approver + '는 이미 승인했습니다');
  if (decision === '반려') {
    c.plan.status = '계산 완료'; c.plan.approvals = {}; c.plan.selected = null;
    setCaseStatus(state, c, CASE.APPROVED, `${approver} 반려 — 대안 재검토`);
    audit(state, approver + '[모의]', '재공급 계획 반려', note || '', c.id);
    return c.plan;
  }
  c.plan.approvals[approver] = { at: now(), note: note || '' };
  audit(state, approver + '[모의]', '재공급 계획 승인', `대안 ${c.plan.selected}${c.plan.exception_reason ? ' (한도 초과 예외 승인: ' + c.plan.exception_reason + ')' : ''}${note ? ' — ' + note : ''}`, c.id);
  if (c.plan.required.every((r) => c.plan.approvals[r])) {
    c.plan.status = '승인';
    setCaseStatus(state, c, CASE.PLAN_APPROVED, '필요 승인 모두 완료');
    generatePlanTasks(state, c);
    setCaseStatus(state, c, CASE.RECOVERY, '후속 작업 생성');
  }
  return c.plan;
}

function supplyNoticeDraft(row) {
  return [
    '[초안 — 영업 승인 전 발송 금지]',
    `${row.customer_name}(${row.customer_id}) 담당자님께,`,
    '회수 대상 생산분의 대체 제품 공급 계획을 수립했습니다.',
    '귀사 보유 수량 회신을 반영하여 대체 수량을 확정하고, 공급 일정은 생산·품질 확인 후 영업 담당자가 개별 협의드리겠습니다.',
    '원인은 현재 조사 중이며, 확인되는 대로 안내드리겠습니다.',
    'Corevia Cosmetics 영업팀 드림',
  ].join('\n');
}

function generatePlanTasks(state, c) {
  const alt = c.plan.result.alternatives.find((a) => a.id === c.plan.selected);
  const approved = c.approvedBatchIds;
  const keys = new Set();
  const up = (spec) => { keys.add(spec.key); return upsertTask(state, c, spec); };
  alt.delayed_by_customer.filter((d) => d.customer_id !== 'Masil').forEach((d) => {
    up({
      key: 'DUE:' + d.customer_id, kind: '납기 변경 통지', title: `${d.customer_id} 기존 주문 ${d.orders}건(${d.qty.toLocaleString()} EA) 납기 변경 통지(모의) — 최대 ${d.max_delay_days}일 [가정 기반]`,
      dept: '영업', customer_id: d.customer_id, batchIds: approved,
      payload: { draft: `[초안 — 영업 임원 승인 범위 내]\n${d.customer_id} 담당자님께,\n당사 생산 일정 조정으로 귀사 PL-02 주문 ${d.orders}건(${d.qty.toLocaleString()} EA)의 출하 일정 변경이 예상되어 사전 안내드립니다.\n변경 일정은 생산 확정 후 영업 담당자가 개별 협의드리겠습니다.\nCorevia Cosmetics 영업팀 드림`, source: '템플릿 초안' },
    });
  });
  // F12: 회수 고객용 '대체 공급 안내' — 템플릿 초안으로 생성, AI 초안은 사람이 선택해 적용(적용·발송 시 재점검)
  const J = judge(state);
  R.recallScope(getModel(), approved, J.claims).filter((row) => !row.unverified || state.c105Confirmed[row.customer_id] != null).forEach((row) => {
    up({
      key: 'SUPPLY_NOTICE:' + row.customer_id, kind: '대체 공급 안내', title: `${row.customer_id} ${row.customer_name} 대체 공급 안내 발송(모의) — 대안 ${alt.id}`,
      dept: '영업', customer_id: row.customer_id, batchIds: row.batches, payload: { draft: supplyNoticeDraft(row), source: '템플릿 초안' },
    });
  });
  up({ key: 'PROD_SEQ', kind: '생산 순서 변경', title: `L-02 생산 순서 변경 요청 — 대안 ${alt.id}(${alt.name}), 대체 ${c.plan.result.replacement_total.toLocaleString()} EA`, dept: '생산', batchIds: approved });
  up({ key: 'REQUAL', kind: '품질 재승인', title: '대체 생산 배치 qc 합격 + 사용 원료 로트 규격내 확인(N5)', dept: '품질', batchIds: approved });
  up({ key: 'DELIVERY', kind: '재공급 납품', title: '대체분 납품 완료 확인(N7)', dept: '생산·물류', batchIds: approved });
  up({ key: 'MASIL', kind: 'Masil 정보 통지', title: `Masil 공급 영향 정보 통지 — ${alt.masil_impact}`, dept: '그룹·Masil', batchIds: approved });
  up({ key: 'C201', kind: 'C-201 정보 통지', title: `C-201 입찰 검토팀(전략) 정보 통지 — ${alt.c201_memo}`, dept: '전략', batchIds: approved });
  upsertTask(state, c, { key: 'FIN_AR', kind: '재무 채권 확인', title: '회수 고객 채권 영향 확인(상계·지급 보류 가능성) [금액은 가정, 손실 확정 금지]', dept: '재무', batchIds: approved });
  // 새 대안에 없는 이전 계획 작업은 취소
  state.tasks.filter((t) => t.caseId === c.id && PLAN_TASK_KINDS.has(t.kind) && t.status === TASK.REVALIDATE && !keys.has(t.key)).forEach((t) => {
    t.prevStatus = t.status; t.status = TASK.CANCEL; t.note = '새 계획 버전에 없음 — 취소';
    audit(state, '시스템', '작업 취소(계획 변경)', `${t.id} ${t.title}`, c.id, { taskId: t.id });
  });
  const t = state.tasks.find((x) => x.caseId === c.id && x.key === 'SUPPLY_REQ');
  if (t && t.status !== TASK.CANCEL && t.status !== TASK.REVALIDATE) t.status = TASK.DONE;
}

// ---------------- 작업 조작 ----------------
function findTask(state, id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) throw httpError(404, '작업 없음: ' + id);
  return t;
}
function updateTaskStatus(state, id, { status, note, actor } = {}) {
  const t = findTask(state, id);
  if (![TASK.WAIT, TASK.DOING, TASK.DONE, TASK.CANCEL].includes(status)) throw httpError(400, '상태는 대기 / 진행 / 완료 / 취소 중 하나여야 합니다');
  // F11: 재검증 필요는 재상신·재의결 또는 계획 재승인으로만 해제
  if (t.status === TASK.REVALIDATE) throw httpError(409, '재검증 필요 작업은 재상신·재의결 또는 재공급 계획 재승인으로만 해제됩니다');
  if (t.status === TASK.CANCEL) throw httpError(409, '취소된 작업은 변경할 수 없습니다');
  if (t.sent) throw httpError(409, '발송 완료된 통지는 변경할 수 없습니다(정정은 정정 통지 작업으로)');
  if (NOTICE_KINDS.has(t.kind) && status === TASK.DONE) throw httpError(409, '통지 작업은 발송(모의)으로 완료합니다');
  const c = findCase(state, t.caseId);
  if (t.dependsOnJudgment && status === TASK.DONE && t.track !== '원인조사') requireApproval(c, '회수 작업 완료 처리');
  t.prevStatus = t.status; t.status = status; if (note) t.note = note;
  audit(state, actor || '담당자', '작업 상태 변경', `${t.id} ${t.title} → ${status}${note ? ' (' + note + ')' : ''}`, t.caseId, { taskId: id });
  return t;
}
function editDraft(state, id, text, actor) {
  const t = findTask(state, id);
  if (t.sent) throw httpError(409, '발송 완료된 통지는 수정할 수 없습니다(정정은 정정 통지 작업으로)');
  if (typeof text !== 'string' || !text.trim()) throw httpError(400, '초안 내용이 필요합니다');
  t.payload = { ...(t.payload || {}), draft: text, source: '사람 수정' };
  audit(state, actor || '담당자', '통지 초안 수정', t.id, t.caseId, { taskId: id });
  return t;
}
// F12: AI 대체 공급 안내 초안을 사람이 선택해 회수 고객 작업에 적용(금지 표현 재점검)
function applyAiDraft(state, id, { draft_id, actor } = {}) {
  const t = findTask(state, id);
  if (t.kind !== '대체 공급 안내') throw httpError(409, 'AI 대체 공급 안내 초안은 회수 고객의 "대체 공급 안내" 작업에만 적용할 수 있습니다');
  if (t.sent) throw httpError(409, '발송 완료된 통지는 수정할 수 없습니다');
  const c = findCase(state, t.caseId);
  const d = c.aiDrafts.find((x) => x.id === draft_id) || c.aiDrafts.filter((x) => x.kind === '재공급 대안 설명').slice(-1)[0];
  if (!d || d.kind !== '재공급 대안 설명') throw httpError(409, '적용할 AI 대체 공급 안내 초안이 없습니다');
  const model = getModel();
  const name = model.customers[t.customer_id] ? model.customers[t.customer_id].customer_name : t.customer_id;
  const text = String(d.output.customer_notice_draft || '').replace(/\{고객사명\}/g, `${name}(${t.customer_id})`);
  const v = ai.checkForbidden(text, 'notice');
  if (v.length) {
    audit(state, '시스템', 'AI 초안 적용 차단(금지 표현)', `${t.id}: ${v.map((x) => x.label).join(', ')}`, t.caseId, { taskId: id });
    throw httpError(422, '금지 표현이 있어 AI 초안을 적용할 수 없습니다: ' + v.map((x) => x.label).join(', '), { violations: v });
  }
  t.payload = { ...(t.payload || {}), draft: text, source: `AI 초안(${d.mode}) ${d.id} — 담당자 선택 적용` };
  audit(state, actor || '영업(담당자)', 'AI 초안 적용', `${t.id} ← ${d.id} (${d.mode})`, t.caseId, { taskId: id, draftId: d.id });
  return t;
}
function sendNotice(state, id, actor) {
  const t = findTask(state, id);
  if (!NOTICE_KINDS.has(t.kind)) throw httpError(400, '통지 작업이 아닙니다');
  if (t.sent) throw httpError(409, '이미 발송된 통지입니다(재발송 불가 — 정정은 정정 통지 작업으로)');
  if (!t.payload || !t.payload.draft) throw httpError(400, '초안 없음');
  const c = findCase(state, t.caseId);
  requireApproval(c, '고객 통지 발송');
  if (t.status === TASK.REVALIDATE || t.status === TASK.CANCEL) throw httpError(409, '재검증 필요·취소 작업은 발송할 수 없습니다');
  if (t.kind !== '고객 통지' && !(c.plan && c.plan.status === '승인')) throw httpError(409, '재공급 계획 승인 전에는 납기 변경·대체 공급 안내를 발송할 수 없습니다');
  const v = ai.checkForbidden(t.payload.draft, 'notice');
  if (v.length) {
    audit(state, '시스템', '발송 차단(금지 표현)', `${t.id}: ${v.map((x) => x.label + '「' + x.match + '」').join(', ')}`, t.caseId, { taskId: id });
    throw httpError(422, '금지 표현으로 발송 차단: ' + v.map((x) => x.label).join(', '), { violations: v });
  }
  t.prevStatus = t.status; t.status = TASK.DONE; t.sent = true; t.sentAt = now();
  audit(state, actor || '영업[모의]', '통지 발송(모의)', `${t.id} ${t.title}`, t.caseId, { taskId: id });
  return t;
}

// ---------------- 정상화 기준 N1~N9 ----------------
function normalization(state, c) {
  const tasks = state.tasks.filter((t) => t.caseId === c.id && t.status !== TASK.CANCEL);
  const irs = state.infoRequests.filter((r) => r.caseId === c.id);
  const byKind = (k) => tasks.filter((t) => t.kind === k);
  const allDone = (list) => list.length > 0 && list.every((t) => t.status === TASK.DONE);
  const approved = approvalActive(c) || c.status === CASE.DONE;
  const J = judge(state);
  const scope = c.approvedBatchIds.length ? R.recallScope(getModel(), c.approvedBatchIds, J.claims) : [];
  const c105Open = irs.filter((r) => r.kind === 'C105_LABEL' && r.status !== '회신 완료');
  const verified = scope.filter((s) => !s.unverified || state.c105Confirmed[s.customer_id] != null);
  const plan = c.plan;
  const ext = c.extensionAtApproval;
  const n4List = [...byKind('출하 정지'), ...(ext ? byKind('로트 격리') : [])];
  const prevTasks = tasks.filter((t) => t.track === '예방 점검');
  const items = [
    { id: 'N1', label: '회수 범위 확정', ok: approved && c105Open.length === 0 && byKind('회수 범위 확정').some((t) => t.status === TASK.DONE), evidence: approved ? `의결 배치 ${c.approvedBatchIds.join(', ')} · C-105 확인 ${c105Open.length ? '대기' : '완료/해당 없음'}` : '유효한 의결 없음' },
    { id: 'N2', label: '고객 통지 완료', ok: approved && allDone(byKind('고객 통지')) && byKind('고객 통지').length >= verified.length, evidence: `${byKind('고객 통지').filter((t) => t.sent).length}/${verified.length} 발송(모의)` },
    { id: 'N3', label: '회수 수량 확정', ok: verified.length > 0 && verified.every((s) => state.holdingReplies[s.customer_id] != null), evidence: `보유 수량 회신 ${verified.filter((s) => state.holdingReplies[s.customer_id] != null).length}/${verified.length}` },
    { id: 'N4', label: '문제 로트·배치 격리', ok: approved && allDone(n4List), evidence: `출하 정지 ${byKind('출하 정지').filter((t) => t.status === TASK.DONE).length}/${byKind('출하 정지').length}` + (ext ? ` · 로트 격리 ${byKind('로트 격리').filter((t) => t.status === TASK.DONE).length}/${byKind('로트 격리').length}` : ' · 로트 격리 미생성(확장 OFF로 의결 — 위험)') },
    { id: 'N5', label: '대체 물량 품질 재승인', ok: allDone(byKind('품질 재승인')), evidence: byKind('품질 재승인').map((t) => t.status).join(',') || '계획 승인 전' },
    { id: 'N6', label: '재공급 일정 확정·고객 합의', ok: !!plan && plan.status === '승인' && [...byKind('납기 변경 통지'), ...byKind('대체 공급 안내')].every((t) => t.status === TASK.DONE), evidence: plan ? `계획 v${plan.version || 1} ${plan.status}${plan.selected ? ' · 대안 ' + plan.selected : ''} · 납기 통지 ${byKind('납기 변경 통지').filter((t) => t.sent).length}/${byKind('납기 변경 통지').length} · 대체 공급 안내 ${byKind('대체 공급 안내').filter((t) => t.sent).length}/${byKind('대체 공급 안내').length}` : '계획 없음' },
    { id: 'N7', label: '재공급 납품 완료', ok: allDone(byKind('재공급 납품')), evidence: byKind('재공급 납품').map((t) => t.status).join(',') || '계획 승인 전' },
    ext
      ? { id: 'N8', label: '예방 점검 종결', ok: prevTasks.length === 0 ? approved : allDone(prevTasks), evidence: prevTasks.length ? `${prevTasks.filter((t) => t.status === TASK.DONE).length}/${prevTasks.length} 완료` : '예방 점검 대상 없음' }
      : { id: 'N8', label: '예방 점검 종결', ok: approved, risk: true, evidence: '예방 점검 미수행(위험) — 확장 OFF로 의결. 같은 로트 합격 배치 B-02-2602-02·03 점검 없이 종료됨' },
    { id: 'N9', label: '후속 연결', ok: tasks.some((t) => t.track === '원인조사') && allDone(byKind('재무 채권 확인')) && allDone(byKind('Masil 정보 통지')) && allDone(byKind('C-201 정보 통지')), evidence: `원인조사 트랙 ${tasks.some((t) => t.track === '원인조사') ? '열림' : '없음'} · 재무/Masil/C-201 ${[byKind('재무 채권 확인'), byKind('Masil 정보 통지'), byKind('C-201 정보 통지')].map((l) => (allDone(l) ? '완료' : '미완')).join('/')}` },
  ];
  return items;
}

function closeCase(state, caseId) {
  const c = findCase(state, caseId);
  const n = normalization(state, c);
  const missing = n.filter((x) => !x.ok);
  if (missing.length) throw httpError(409, '정상화 기준 미충족: ' + missing.map((x) => x.id + ' ' + x.label).join(', '), { missing });
  const risks = n.filter((x) => x.risk);
  setCaseStatus(state, c, CASE.DONE, 'N1~N9 모두 충족' + (risks.length ? ' · 위험 표시: ' + risks.map((x) => x.evidence).join(' / ') : ''));
  c.closedWithRisk = risks.map((x) => x.evidence);
  return c;
}

// ---------------- 조회 ----------------
function caseView(state, c, J) {
  J = J || judge(state);
  const ctx = caseContext(state, c, J);
  return {
    ...c,
    approval_active: approvalActive(c),
    current: ctx.items,
    submittable: ctx.submittable,
    sensitivity: ctx.sensitivity,
    scope: ctx.scope,
    preventive: ctx.preventive,
    tasks: state.tasks.filter((t) => t.caseId === c.id),
    infoRequests: state.infoRequests.filter((r) => r.caseId === c.id),
    timeline: state.audit.filter((a) => a.caseId === c.id),
    normalization: normalization(state, c),
  };
}

// F13: 의결 후 확장을 켜면 빠진 로트 격리·예방 점검 작업을 보충 생성
function setExtension(state, on) {
  if (typeof on !== 'boolean') throw httpError(400, 'on 값은 true/false여야 합니다');
  const before = judge(state);
  state.settings.extensionOn = on;
  const after = judge(state);
  const changed = diffJudgments(before, after);
  const supplemented = [];
  if (on) {
    state.cases.filter((c) => approvalActive(c) && c.extensionAtApproval === false).forEach((c) => {
      const n0 = state.tasks.length;
      c.extensionAtApproval = true;
      generateExtensionTasks(state, c, after);
      supplemented.push({ caseId: c.id, tasks: state.tasks.length - n0 });
      audit(state, '시스템', '확장(a) 작업 보충 생성', `의결 후 확장 ON — 로트 격리·예방 점검 작업 ${state.tasks.length - n0}건 보충`, c.id);
    });
  }
  audit(state, '사람(품질팀)', '확장(a) 설정 변경', `로트 추적→예방 점검 ${on ? 'ON' : 'OFF'} · 배치 상태 변경 ${changed.length}건${supplemented.length ? ' · 보충 생성 사건 ' + supplemented.map((s) => s.caseId).join(', ') : ''}`, null);
  return { extensionOn: state.settings.extensionOn, changed, supplemented };
}

// ---------------- 대시보드 경고 ----------------
// 경고마다 id·종류·해결 방법을 둔다. 원인이 사라지면(사건 접수·상신) 자동으로 빠지고,
// 원본 사실이라 바뀌지 않는 'QC 보류인데 출하'는 담당자가 사유를 적어 확인 처리하면 빠진다(감사기록 남김).
function warningList(state, list) {
  // 상태 3가지: 열림(처리 필요) / 확인됨(사람이 확인했으나 원본 사실은 남음) / 해결됨(원인이 사라짐 — 사건 접수·상신)
  const acks = state.warningAcks || {};
  const caseOf = (b) => state.cases.find((c) => c.batchIds.includes(b));
  const firstSubmission = (b) => {
    let best = null;
    state.cases.filter((c) => c.batchIds.includes(b)).forEach((c) => (c.submissions || []).forEach((sub) => {
      // 분모 민감 상태로 두 값을 담아 상신한 기록만 해결로 본다(정정 전의 예전 상신은 제외)
      if ((sub.items || []).some((i) => i.batch_id === b && i.status === '분모 민감') && (!best || sub.at < best.sub.at)) best = { c, sub };
    }));
    return best;
  };
  const out = [];
  list.filter((j) => j.warn_hold_shipped).forEach((j) => {
    const id = 'HOLD_SHIP:' + j.batch_id;
    const a = acks[id];
    out.push({ id, kind: 'hold_shipped', batch_id: j.batch_id, text: `${j.batch_id}: QC 결과 '보류'인데 SBL 출하 ${j.shipped_qty.toLocaleString()} EA [원본 사실의 조합]`, resolve: 'ack',
      status: a ? '확인됨' : '열림', handled: a ? { at: a.at, by: a.by || '품질팀', how: '확인 처리', note: a.note } : null });
  });
  list.filter((j) => j.status === '분모 민감').forEach((j) => {
    const f = firstSubmission(j.batch_id);
    out.push({ id: 'SENS:' + j.batch_id, kind: 'sens', batch_id: j.batch_id, text: `${j.batch_id}: 분모 민감 — 생산 ${(j.rateP * 100).toFixed(2)}% / 출하 ${(j.rateS * 100).toFixed(2)}% 두 값 모두 상신`, rateP: j.rateP, rateS: j.rateS, resolve: 'submit',
      status: f ? '해결됨' : '열림', handled: f ? { at: f.sub.at, by: '자동', how: `${f.c.id} 상신 v${f.sub.version}`, note: null } : null });
  });
  list.filter((j) => j.status === '회수 대상').forEach((j) => {
    const c = caseOf(j.batch_id);
    out.push({ id: 'NOCASE:' + j.batch_id, kind: 'no_case', batch_id: j.batch_id, text: `${j.batch_id}: 회수 대상인데 사건 미접수`, rateP: j.rateP, rateS: j.rateS, resolve: 'case',
      status: c ? '해결됨' : '열림', handled: c ? { at: c.createdAt, by: '자동', how: `${c.id} 사건 접수`, note: null } : null });
  });
  return out;
}

// ---------------- 이벤트 흐름(운영 감시 3단계) ----------------
// 감사기록을 최신순으로 보여 준다. 같은 순간(2초 이내)에 같은 주체·행위·사건으로 연달아 생긴 기록(예: 작업 생성 45건)은 한 줄로 묶는다.
// 종류: 입력(밖에서 들어온 일) / 판정 / 처리(사람) / 모의 AI / 자동. 문제 신호(차단·재검증·판정 변경·효력 정지)는 alert.
const FEED_ALERT = /차단|재검증 필요|판정 변경 감지|효력 정지|취소/;
function feedKind(a) {
  if (/모의 AI/.test(a.actor)) return '모의 AI';
  if (/회신|보도|클레임|정정|보유 수량/.test(a.action)) return '입력';
  if (/판정/.test(a.action)) return '판정';
  if (a.actor === '시스템' || /^시스템/.test(a.actor)) return '자동';
  return '처리';
}
function feedList(state, limit) {
  const max = Math.max(1, Math.min(Number(limit) || 30, 200));
  const groups = [];
  for (const a of state.audit || []) {
    const g = groups[groups.length - 1];
    if (g && g.actor === a.actor && g.action === a.action && g.caseId === (a.caseId || null) && Date.parse(a.at) - Date.parse(g.lastAt) <= 2000) {
      g.count += 1; g.lastAt = a.at; g.id = a.id; continue;
    }
    groups.push({ id: a.id, firstId: a.id, at: a.at, lastAt: a.at, actor: a.actor, action: a.action, detail: a.detail, caseId: a.caseId || null, count: 1, kind: feedKind(a), alert: FEED_ALERT.test(a.action) });
  }
  return groups.reverse().slice(0, max).map(({ lastAt, ...g }) => g);
}

// ---------------- 규칙 적중 현황(운영 감시 4단계) ----------------
// 규칙마다 지금 몇 개 배치·고객·건에 적용됐는지. 값은 모두 현재 판정·사건·이벤트·감사기록에서 계산한다(가공 점수 없음).
function ruleHits(state) {
  const J = judge(state);
  const js = Object.values(J.judgments);
  const ids = (st) => js.filter((j) => j.status === st).map((j) => j.batch_id).sort();
  const recall = ids('회수 대상');
  const sens = ids('분모 민감');
  const scope = R.recallScope(getModel(), recall.concat(sens), J.claims);
  const approved = [...new Set(state.cases.flatMap((c) => c.approvedBatchIds || []))].sort();
  const news = (state.events || []).filter((e) => e.type === 'news').length;
  const j6 = (state.audit || []).filter((a) => /판정 변경 감지/.test(a.action)).length;
  return [
    { rule: 'J2', label: '회수 판정', name: '회수 기준: 생산 기준 불량률 10% 이상', unit: '배치', count: recall.length, batches: recall, filter: '회수 대상' },
    { rule: 'J2', label: '회수 판정', name: '분모 민감: 생산 기준 10% 미만, 출하 기준 10% 이상', unit: '배치', count: sens.length, batches: sens, filter: '분모 민감' },
    { rule: 'J2', label: '회수 판정', name: '미확정 클레임이 있어 조사·소명 대상', unit: '배치', count: ids('조사·소명').length, batches: [], filter: '조사·소명' },
    { rule: '확장(a)', label: '로트 추적', name: '회수 배치와 같은 원료 로트 → 예방 점검', unit: '배치', count: ids('예방 점검').length, batches: ids('예방 점검'), filter: '예방 점검', off: !state.settings.extensionOn },
    { rule: 'J3', label: '위원회 의결', name: '품질위원회 의결로 회수가 승인된 배치', unit: '배치', count: approved.length, batches: approved, filter: null },
    { rule: 'J4', label: '언론 보도', name: '언론 보도 입력(판정은 바뀌지 않음)', unit: '건', count: news, batches: [], filter: null },
    { rule: 'J6', label: '판정 변경', name: '판정 변경 감지 → 관련 작업 재검증', unit: '회', count: j6, batches: [], filter: null },
    { rule: 'J7', label: '회수 범위', name: '회수 범위 고객(SBL 출하처 + 확정 클레임 고객)', unit: '곳', count: scope.length, batches: [], filter: null,
      customers: scope.map((x) => x.customer_id), unverified: scope.filter((x) => x.unverified).map((x) => x.customer_id) },
  ];
}

// ---------------- 클레임 추이(운영 감시 5단계) ----------------
// 대상: 지금 회수 대상·분모 민감인 배치 + 사건에 들어 있는 배치(최대 4개). 주(일요일 끝) 단위로
// '현재 확정된 클레임'의 수량을 접수일 기준으로 누적해 생산 기준 불량률을 그린다. 확정일은 원본에 없어 접수일을 쓴다.
const TREND_MAX = 4;
function weekEnd(iso) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7)); return d.toISOString().slice(0, 10); }
function claimTrend(state) {
  const model = getModel();
  const J = judge(state);
  const pick = [];
  const add = (b) => { if (b && !pick.includes(b) && J.judgments[b]) pick.push(b); };
  Object.values(J.judgments).filter((j) => j.status === '회수 대상' || j.status === '분모 민감').map((j) => j.batch_id).sort().forEach(add);
  state.cases.forEach((c) => c.batchIds.forEach(add));
  const batches = pick.slice(0, TREND_MAX);
  const mine = (b) => J.claims.filter((c) => c.batch_id === b).sort((x, y) => x.claim_date.localeCompare(y.claim_date));
  const allDates = batches.flatMap((b) => mine(b).map((c) => c.claim_date));
  if (!allDates.length) return { threshold: R.THRESHOLD, base_date: BASE_DATE, weeks: [], series: [], omitted: pick.length - batches.length };
  const weeks = [];
  for (let w = weekEnd(allDates.sort()[0]); w <= weekEnd(BASE_DATE); ) {
    weeks.push(w);
    const d = new Date(w + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 7); w = d.toISOString().slice(0, 10);
  }
  const series = batches.map((b) => {
    const j = J.judgments[b];
    const produced = model.batchById[b].produced_qty;
    const cl = mine(b);
    const trigger = Math.ceil(produced * R.THRESHOLD);
    let cum = 0; let crossed = null;
    cl.filter((c) => c.defect_confirmed).forEach((c) => { cum += c.qty_affected; if (!crossed && cum >= trigger) crossed = c.claim_date; });
    const points = weeks.map((w) => {
      const upto = cl.filter((c) => weekEnd(c.claim_date) <= w);
      const qty = upto.filter((c) => c.defect_confirmed).reduce((s, c) => s + c.qty_affected, 0);
      return { week: w, claims: upto.length, confirmed_qty: qty, rate: qty / produced };
    });
    return { batch_id: b, status: j.status, produced_qty: produced, trigger_qty: trigger, crossed_on: crossed, final_rate: j.rateP, points };
  });
  return { threshold: R.THRESHOLD, base_date: BASE_DATE, weeks, series, omitted: pick.length - batches.length };
}

function ackWarning(state, id, note) {
  const text = String(note || '').trim();
  if (!/^HOLD_SHIP:[A-Za-z0-9-]+$/.test(String(id))) throw httpError(400, '확인 처리할 수 있는 경고가 아닙니다. 사건 접수나 상신으로 해결되는 경고입니다.');
  if (text.length < 5) throw httpError(400, '확인 내용을 5자 이상 적어 주세요(감사기록에 남습니다).');
  if (text.length > 300) throw httpError(400, '확인 내용은 300자 이내로 적어 주세요.');
  const batchId = id.split(':')[1];
  const j = judge(state).judgments[batchId];
  if (!j || !j.warn_hold_shipped) throw httpError(404, '해당 경고가 없습니다.');
  if (!state.warningAcks) state.warningAcks = {};
  if (state.warningAcks[id]) throw httpError(409, '이미 확인 처리된 경고입니다.');
  state.warningAcks[id] = { note: text, at: now(), by: '품질팀' };
  audit(state, '품질팀', '경고 확인 처리', `${batchId} QC 보류인데 출하: ${text}`, null, { warning: id });
  return { id, ...state.warningAcks[id] };
}

module.exports = {
  warningList, ackWarning, feedList, ruleHits, claimTrend,
  CASE, TASK, C105, newState, judge, createCase, judgeCase, prepareSubmissionDraft, submitCase, interpretReply, recordReply,
  answerInfoRequest, applyEvent, computeCasePlan, explainCasePlan, submitPlan, approvePlan, updateTaskStatus, editDraft, applyAiDraft,
  sendNotice, normalization, closeCase, caseView, setExtension, findCase, httpError, EVENT_LABEL, caseContext, HYPOTHESES, approvalActive,
};
