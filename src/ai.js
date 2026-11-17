'use strict';
// AI 지점 3개 (상신 준비 · 회신 해석 · 재공급 대안 설명/고객 통지 초안).
// - Claude API(@anthropic-ai/sdk, claude-opus-5-5) 구조화 출력 사용
// - API 키 없음·호출 실패·거절(refusal) → 규칙·템플릿 기반 "모의 AI"로 대체
// - AI 출력은 "AI 초안"으로만 저장되며 판정·상태 필드를 바꾸지 않는다(엔진이 AI 출력을 판정에 쓰지 않음).
const { z } = require('zod');

const MODEL = 'claude-opus-5-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// ---------- 구조화 출력 스키마 ----------
const SubmissionSchema = z.object({
  summary: z.string().describe('근거 요약(수치 포함, 원인 단정 금지)'),
  risks: z.array(z.string()).describe('위험·주의 사항'),
  unknowns: z.array(z.string()).describe('미확인 항목과 필요한 확인'),
  draft: z.string().describe('품질위원회 상신문 초안'),
});
const ReplySchema = z.object({
  classification: z.enum(['승인', '추가자료 요구', '거절', '분류 불가']),
  requested_items: z.array(z.string()).describe('위원회가 요구한 추가 자료 목록(없으면 빈 배열)'),
  rationale: z.string(),
});
const PlanSchema = z.object({
  alternatives: z.array(z.object({
    id: z.enum(['A', 'B', 'C']),
    pros: z.array(z.string()),
    cons: z.array(z.string()),
  })),
  decision_points: z.array(z.string()).describe('승인자(영업 임원·생산 책임자)가 판단할 지점'),
  customer_notice_draft: z.string().describe('회수 고객용 대체 공급 안내 초안. 고객명 자리는 {고객사명}. 날짜·금액 약속 금지'),
});

// ---------- 금지 표현 서버 점검 (F6) ----------
// 문장 단위로 점검한다. 예외는 "출하일 YYYY-MM-DD"(당사 출하 기록 표기) 패턴 하나뿐이며 줄 전체를 빼지 않는다.
// F19: 면제는 '원인은 (현재) 조사 중/확인 중'처럼 원인 단어에 바로 붙은 비단정 표현만. 같은 문장의 다른 '확인 중'은 면제하지 않음
const CAUSE_GUARD = /원인\s*(은|이|:|：)?\s*(현재\s*|아직\s*)?(조사\s*중|조사중|확인\s*중|파악\s*중|미확정|규명되지\s*않|확정되지\s*않)/;
const CAUSE_RES = [
  /원인(은|이)\s*\S[^\n]{0,30}?(입니다|이다|임\b|였|이었|(으로|로)\s*(확정|확인|판명|밝혀|추정|보입))/,
  /원인(이|은)?\s*(확정|규명|판명)(되었|됐|되어|된|됨)/,
  /(원료|로트|공정|설비|LOT-[A-Z0-9-]+|V-\d+|배치)[^\n]{0,20}?(때문|탓|기인)/,
  /(원료|로트|공정|설비|LOT-[A-Z0-9-]+|V-\d+)\s*(자체의\s*)?(문제|불량|결함|이상)(으로|로)\s*(인한|인해|발생|판명|확인|보입|추정|판단)/,
  /원인으로\s*(확정|판명|밝혀)/,
  /원인\s*[:：]\s*[^\n]{0,30}?(불량|문제|결함|이상|오염|때문)/,
  /(이|가)\s*원인(입니다|이다|임\b|이었|였|으로\s*(확인|판명|밝혀|확정))/,
];
const COMP_WORDS = /(보상|배상|크레딧|환불|위로금|할인|지급|적립)/;
const AMOUNT_RES = [
  /\d[\d,.]*\s*(만\s*원|천\s*원|백\s*원|억\s*원?|원(?![인료본칙화])|KRW|달러|USD)/,
  /[일이삼사오육칠팔구십백천만억]{2,}\s*원(?![인료본칙화])/,
];
const PERCENT_RE = /\d+(\.\d+)?\s*(%|퍼센트|프로)/;
const SUPPLY_WORDS = /(대체|재공급|납품|공급|납기|출고|발송|보내|배송|입고)/;
const DATE_RES = [
  /\d{4}\s*[-./년]\s*\d{1,2}\s*[-./월]\s*\d{1,2}\s*일?/,
  /(^|[^\d-])\d{1,2}\s*\/\s*\d{1,2}(?!\d)/,
  /\d{1,2}\s*월\s*(\d{1,2}\s*일|말|초|중순|하순|상순|중)/,
  /(다음|이번|금|차|내)\s*주/,
  /(내일|모레|금주|차주|월말|연말|이달|다음\s*달|익월)/,
  /\d+\s*(일|주|개월)\s*(이내|안에|후|내)/,
  /[월화수목금토]요일/,
  /\d{1,2}\s*월\s*(첫|둘|셋|넷|다섯|마지막)\s*째?\s*주/, // F21: 주 단위 납기
  /(첫|둘|셋|넷|다섯)\s*째\s*주|마지막\s*주/,
  /\d+\s*주\s*차/,
  /\d{1,2}\s*월\s*(초순|중순|하순|상순)/,
];
const PRESS_RE = /(언론|보도|기사|뉴스|매체|방송|SNS|에스엔에스|유튜브|커뮤니티)/i;
const PRESS_COMPACT_RE = /(언론|보도|뉴스|방송|기사)/;

function sentencesOf(text) {
  return String(text).replace(/출하일\s*\d{4}-\d{2}-\d{2}/g, '출하일 (출하 기록)').split(/[\n.。!?]+|\.\s/).map((s) => s.trim()).filter(Boolean);
}

// kind: 'notice'(고객 통지 — 발송 차단 대상) | 'internal'(내부 상신문 — 원인 단정·보상 금액만 경고)
function checkForbidden(text, kind) {
  if (!text) return [];
  const out = [];
  const add = (code, label, match) => { if (!out.some((o) => o.code === code)) out.push({ code, label, match: String(match).slice(0, 60) }); };
  sentencesOf(text).forEach((s) => {
    if (!CAUSE_GUARD.test(s)) { const m = CAUSE_RES.map((re) => s.match(re)).find(Boolean); if (m) add('CAUSE', '원인 확정 표현', s); }
    const amount = AMOUNT_RES.map((re) => s.match(re)).find(Boolean);
    if (amount && (kind === 'notice' || COMP_WORDS.test(s))) add('MONEY', '보상·크레딧 금액', s);
    if (kind === 'notice' && PERCENT_RE.test(s)) add('MONEY', '보상·크레딧 금액', s);
    if (kind !== 'notice') return;
    if (SUPPLY_WORDS.test(s) && DATE_RES.some((re) => re.test(s))) add('DATE', '확정 안 된 대체 납기', s);
    if (PRESS_RE.test(s) || PRESS_COMPACT_RE.test(s.replace(/\s+/g, ''))) add('PRESS', '언론 보도 언급', s);
    if (/B-02-2602-0[23]/.test(s)) add('PREVENTIVE', '예방 점검 배치(회수 아님) 언급', s);
  });
  return out;
}

// ---------- 클라이언트 (F17: 비용 0원 안전장치) ----------
// 운영은 모의 AI 고정. Claude API 경로는 ANTHROPIC_API_KEY와 AI_REAL_ENABLED=true가 "둘 다" 있을 때만 열린다.
// 둘 중 하나라도 없으면 SDK 클라이언트를 만들지 않는다(주입 클라이언트도 호출하지 않음). 이 경로는 운영에서 미사용·미검증.
const REAL_MODE = 'Claude API(미검증 경로)';
let clientFactory = null; // 테스트에서 모의 클라이언트 주입
function setClientFactory(fn) { clientFactory = fn; }
function realEnabled() {
  return !!process.env.ANTHROPIC_API_KEY && process.env.AI_REAL_ENABLED === 'true';
}
function getClient() {
  if (!realEnabled()) return null;
  if (clientFactory) return clientFactory();
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic();
}
function aiStatus() {
  if (realEnabled()) return { mode: 'Claude API 경로(운영 미사용·미검증)', model: MODEL, reason: 'ANTHROPIC_API_KEY와 AI_REAL_ENABLED=true가 모두 설정됨 — 실제 호출 시 비용 발생' };
  return { mode: '모의 AI', model: null, reason: '운영 결정: 모의 AI(규칙·템플릿) 고정. Claude API 경로는 구현돼 있으나 운영에서 미사용·미검증' };
}

const SYSTEM = [
  '당신은 Corevia Cosmetics 품질 회수 운영 시스템의 보조 AI다. 가상기업 기준일은 2026-07-01이다.',
  '판정(회수 대상 여부)은 규칙 엔진이 이미 계산했다. 판정을 바꾸거나 새로 내리지 말고 주어진 수치만 인용하라.',
  '원인을 확정하는 표현을 쓰지 마라(원인은 조사 중). 보상·크레딧·환불 금액을 쓰지 마라. 확정되지 않은 대체 납기 날짜를 쓰지 마라.',
  '고객 통지문에는 언론 보도를 언급하지 말고, 회수 대상이 아닌 예방 점검 배치(B-02-2602-02, B-02-2602-03)를 언급하지 마라.',
  '근거 태그([원본]/[도출]/[가정]/[모의]/[미확인])를 유지하라. 모든 출력은 한국어로 작성하라.',
].join('\n');

async function callStructured(schema, userText) {
  const client = getClient();
  if (!client) return { ok: false, reason: '운영 모의 AI 고정 — ANTHROPIC_API_KEY와 AI_REAL_ENABLED=true가 모두 있어야 Claude API 경로 사용' };
  let betaZodOutputFormat;
  let Anthropic;
  try {
    ({ betaZodOutputFormat } = require('@anthropic-ai/sdk/helpers/beta/zod'));
    Anthropic = require('@anthropic-ai/sdk');
  } catch (e) {
    return { ok: false, reason: 'SDK 로드 실패: ' + e.message };
  }
  try {
    // server-side fallback은 beta 엔드포인트에서만 받으므로 beta.messages.parse + betaZodOutputFormat 사용
    const response = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: betaZodOutputFormat(schema) },
      system: SYSTEM,
      messages: [{ role: 'user', content: userText }],
    });
    if (response.stop_reason === 'refusal') {
      const cat = response.stop_details && response.stop_details.category;
      return { ok: false, reason: 'AI 거절(refusal' + (cat ? ': ' + cat : '') + ')' };
    }
    if (!response.parsed_output) return { ok: false, reason: '구조화 출력 파싱 실패' };
    return { ok: true, output: response.parsed_output, model: response.model || MODEL };
  } catch (err) {
    const A = Anthropic;
    let reason;
    if (A && err instanceof A.AuthenticationError) reason = 'API 인증 실패';
    else if (A && err instanceof A.RateLimitError) reason = 'API 요청 한도 초과';
    else if (A && err instanceof A.BadRequestError) reason = 'API 요청 오류(400)';
    else if (A && err instanceof A.APIConnectionError) reason = 'API 연결 실패';
    else if (A && err instanceof A.APIError) reason = 'API 오류 ' + (err.status || '');
    else reason = 'AI 호출 실패: ' + (err && err.message ? err.message : String(err));
    return { ok: false, reason };
  }
}

function pct(x) { return x == null ? '-' : (x * 100).toFixed(2) + '%'; }
function n(x) { return Number(x).toLocaleString('ko-KR'); }

// ---------- 모의 AI (규칙·템플릿) ----------
function mockSubmission(ctx) {
  const lines = ctx.items.map((i) => `${i.batch_id}: 확정 ${n(i.confirmed_qty)} EA, 생산 기준 ${pct(i.rateP)} / 출하 기준 ${pct(i.rateS)} → ${i.status}`);
  const unknowns = ['고객별 실제 보유·판매 수량 [미확인] — 회수 수량은 SBL 출하량을 상한으로 가정',
    '보류 로트 사용 승인·보류 배치 출하 승인 기록 [미확인] — 원인조사 트랙에서 확인',
    '매출·청구 금액 영향: SBL↔SH 정확 일치 0건 → [가정], 손실 확정 금지'];
  ctx.sensitivity.forEach((s) => s.unlinked.forEach((u) => unknowns.unshift(
    `${u.customer_id} 클레임 ${u.count}건(${n(u.qty)} EA)은 ${s.batch_id}의 SBL 출하 기록 없음 [미확인] — 제외 시 ${pct(s.rateP_without)} (포함 ${pct(s.rateP_with)})`)));
  const risks = [];
  ctx.items.forEach((i) => {
    if (i.status === '분모 민감') risks.push(`${i.batch_id}: 분모 선택에 따라 판정이 갈림(생산 ${pct(i.rateP)} < 10% ≤ 출하 ${pct(i.rateS)}) — 두 값 모두 위원회 판단 필요`);
    if (i.warn_hold_shipped) risks.push(`${i.batch_id}: QC 결과 '보류'인데 출하 기록 존재 [원본 사실의 조합] — 출하 통제 확인 필요`);
  });
  if (ctx.preventive && ctx.preventive.length) risks.push(`같은 로트 사용 배치 ${ctx.preventive.map((p) => p.batch_id).join(', ')}는 확정 불량 기준 미달 → 회수가 아닌 예방 점검으로 분리(확장 a)`);
  risks.push('원인은 미확정(가설 H1~H5 조사 중). 정책상 기준 충족 시 원인 규명을 기다리지 않음');
  const draft = [
    `[상신] 품질 회수 판정 결과 의결 요청 (기준일 ${ctx.base_date})`,
    `1. 대상 배치\n${lines.map((l) => '  - ' + l).join('\n')}`,
    `2. 판정 근거: 회수 기준 = 규격이탈 확정 불량률 10% 이상 [원본: quality_policy_cv]. 분모는 생산량(정책 기본), 출하량 기준은 보조로 함께 기재.`,
    `3. 회수 범위(안): SBL 출하처 ∪ 확정 클레임 고객 — ${ctx.scope.map((s) => s.customer_id + (s.unverified ? '[미확인]' : '')).join(', ')}`,
    `4. 미확인 사항\n${unknowns.map((u) => '  - ' + u).join('\n')}`,
    '5. 원인: 조사 중(별도 트랙). 본 상신은 원인 확정을 전제로 하지 않음.',
    '6. 의결 요청: 회수 승인 / 추가자료 요구 / 거절(조사 계속) 중 결정 부탁드립니다.',
  ].join('\n');
  return { summary: lines.join(' / '), risks, unknowns, draft };
}

function mockReply(text) {
  // F3: 기본값은 '분류 불가'. 보류·추가자료 → 부정(거절) → 승인 순으로 판단하고, 아무 규칙에도 안 맞으면 사람이 직접 분류.
  const t = String(text || '').trim();
  if (!t) return { classification: '분류 불가', requested_items: [], rationale: '빈 문장 — 담당자가 직접 분류해야 함(모의 AI)' };
  let classification = '분류 불가';
  if (/보류|유보|추가\s*자료|보완|확인\s*후|재상신|자료\s*(요구|요청|제출)|추가\s*확인/.test(t)) classification = '추가자료 요구';
  else if (/(승인|의결|가결|실행)\s*(하지\s*않|하지\s*않음|안\s*함|않음|않는다|불가|못\s*함|못한다|거부)|불승인|미승인|미의결|불의결|부결|기각|거절|반려|조사\s*계속|승인할\s*수\s*없|승인\s*없음/.test(t)) classification = '거절';
  else if (/승인|의결|가결|회수\s*실행/.test(t)) classification = '승인';
  const requested = [];
  if (classification === '추가자료 요구') {
    const m = t.split(/[:：]/).slice(1).join(':').trim();
    (m ? m.split(/[,·\n;]| 및 /) : [t]).map((x) => x.trim()).filter(Boolean).forEach((x) => requested.push(x));
  }
  return { classification, requested_items: requested, rationale: '키워드 규칙 기반 분류(모의 AI) — 담당자가 확정해야 함' };
}

function mockPlan(ctx) {
  const alts = ctx.alternatives.map((a) => {
    const pros = []; const cons = [];
    if (a.id === 'A') { pros.push(`대체 완료가 가장 빠름(대체 완료 ${a.weeks_to_complete}주 [가정])`); cons.push(`기존 주문 ${a.delayed_orders.length}건·${n(a.delayed_qty)} EA 지연`); }
    if (a.id === 'B') { pros.push('클레임 접수 고객 대체를 먼저 끝냄'); cons.push(`클레임 없는 고객 대체는 여유 능력만 사용 — 전체 ${a.weeks_to_complete}주`, `기존 주문 ${a.delayed_orders.length}건 지연`); }
    if (a.id === 'C') { pros.push('기존 주문 지연 없음'); cons.push(a.feasible ? `대체 완료 ${a.weeks_to_complete}주` : a.feasibility_note); }
    cons.push(a.masil_impact);
    return { id: a.id, pros, cons };
  });
  return {
    alternatives: alts,
    decision_points: [
      '기존 주문을 늦추는 대안(A·B)은 영업 임원 + 생산 책임자 승인 필요 [교육용 가정]',
      'Masil 더마 발주 지연 시 그룹 계열사 결품 위험 — Masil 정보 통지',
      'C-201 입찰 판단(CEO/이사회)에 L-02 여유 소진 정보 통지',
      ctx.status === '확인 대기' ? '조달 회신 전이라 일정은 잠정 — 상신 불가' : '일정은 [가정] 입력 기반 모의 결과',
    ],
    customer_notice_draft: [
      '[초안 — 영업 승인 전 발송 금지]',
      '{고객사명} 담당자님께,',
      '회수 대상 생산분의 대체 제품 공급 계획을 수립 중입니다.',
      '귀사 보유 수량 회신을 반영하여 대체 수량을 확정하고, 공급 일정은 생산·품질 확인 후 별도로 안내드리겠습니다.',
      '원인은 현재 조사 중이며, 확인되는 대로 안내드리겠습니다.',
      'Corevia Cosmetics 영업팀 드림',
    ].join('\n'),
  };
}

function buildPrompt(kind, ctx) {
  return `작업: ${kind}\n아래 JSON은 규칙 엔진·계산 결과다(판정 변경 금지).\n${JSON.stringify(ctx, null, 1).slice(0, 60000)}`;
}

async function run(kind, schema, ctx, mockFn, promptCtx) {
  const res = await callStructured(schema, buildPrompt(kind, promptCtx || ctx));
  if (res.ok) return { mode: REAL_MODE, model: res.model, output: res.output, reason: null };
  return { mode: '모의 AI', model: null, output: mockFn(ctx), reason: res.reason };
}

async function prepareSubmission(ctx) {
  const r = await run('품질위원회 상신 준비(근거 요약·위험·미확인·상신문 초안)', SubmissionSchema, ctx, mockSubmission);
  r.violations = checkForbidden([r.output.summary, r.output.draft, ...(r.output.risks || [])].join('\n'), 'internal');
  return r;
}

async function interpretReply(text, ctx) {
  const r = await run('위원회 회신 해석(분류 제안 + 요구 자료 추출)', ReplySchema, text, mockReply, { reply_text: text, case: ctx });
  r.violations = [];
  return r;
}

async function explainPlan(ctx) {
  const slim = { status: ctx.status, assumptions: ctx.assumptions, replacement_total: ctx.replacement_total, alternatives: ctx.alternatives.map((a) => ({ ...a, delayed_orders: a.delayed_orders.slice(0, 15) })) };
  const r = await run('재공급 대안 설명 + 고객 통지 초안', PlanSchema, ctx, mockPlan, slim);
  r.violations = checkForbidden(r.output.customer_notice_draft, 'notice');
  return r;
}

module.exports = {
  MODEL, checkForbidden, setClientFactory, aiStatus, prepareSubmission, interpretReply, explainPlan,
  SubmissionSchema, ReplySchema, PlanSchema, callStructured,
};
