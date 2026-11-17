'use strict';
// 품질 회수·공급 복구 운영 시스템 (W03) — 내장 http 서버
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const store = require('./src/store');
const E = require('./src/engine');
const ai = require('./src/ai');
const { getModel, BASE_DATE, SOURCE_DIR } = require('./src/data');
const { compareExtension } = require('./src/compare');
const SC = require('./src/scenarios');
const REPORT = require('./src/report');
const { overview } = require('./src/overview');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

// 구현 구분(심사·시연 설명용)
const IMPLEMENTATION = [
  { area: '데이터 로드·회수 판정', kind: '실제 작동', note: '원본 복사본 CSV를 읽어 규칙 엔진이 계산' },
  { area: '확장(a) 로트 추적 → 예방 점검', kind: '실제 작동', note: 'ON/OFF에 따라 판정 상태·작업 생성이 실제로 달라짐' },
  { area: 'Case·상신·작업·확인요청·감사기록 상태 전이', kind: '실제 작동', note: '서버 상태(data/state.json)에 기록' },
  { area: '재공급 대안 계산(A/B/C)', kind: '실제 작동(입력은 가정)', note: '계산은 실제, 캐파 여유·재승인 소요일 등은 [가정] 입력' },
  { area: '품질위원회 회신·영업 임원/생산 승인', kind: '모의 처리', note: '사람 결정을 화면·API로 입력[모의]' },
  { area: '고객 통지·납기 변경 통지 발송', kind: '모의 처리', note: '실제 발송 없음. 금지 표현 점검·차단은 실제 작동' },
  { area: '조달 회신·고객 보유 수량 회신·확인요청 회신', kind: '모의 처리', note: '가상 회신 입력 후 시스템이 판정·계획·상태를 실제 갱신' },
  { area: 'AI(상신 준비·회신 해석·대안 설명)', kind: '모의 AI(운영)', note: '규칙·템플릿 모의 AI 고정. 입력(판정·회신 문장·대안 계산)에 따라 출력이 달라지며 사람이 확정·선택 적용. Claude API 경로 코드는 있으나 운영 미사용·미검증(ANTHROPIC_API_KEY + AI_REAL_ENABLED=true일 때만 열림)' },
  { area: '공유 시연 상태', kind: '한계', note: '서버 상태가 하나라 시나리오 시작·초기화·확장 토글은 모든 사용자 화면에 반영됨' },
  { area: 'SBL↔SH 금액 연결', kind: '설계 단계(가정 표시)', note: '정확 일치 0건 → 금액은 [가정], 손실 확정 안 함' },
];

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 2e6) { reject(E.httpError(413, '요청이 너무 큽니다')); req.destroy(); } });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(E.httpError(400, 'JSON 형식 오류')); }
    });
    req.on('error', reject);
  });
}

function judgmentList(state, all) {
  const J = E.judge(state);
  const list = Object.values(J.judgments).filter((j) => all || j.claim_count > 0 || j.status === '예방 점검' || j.product_id === 'PL-02');
  list.sort((a, b) => (b.rateS || b.rateP) - (a.rateS || a.rateP) || (b.status === '예방 점검') - (a.status === '예방 점검') || a.batch_id.localeCompare(b.batch_id));
  const counts = {};
  Object.values(J.judgments).forEach((j) => { counts[j.status] = (counts[j.status] || 0) + 1; });
  return { list, counts, total: Object.keys(J.judgments).length, preventive: J.preventive, extensionOn: J.extensionOn };
}

// 화면에서 번호 옆에 붙일 한글 이름 [원본 마스터: 고객·제품·원료·원료 로트]
let NAMES = null;
function namesTable() {
  if (NAMES) return NAMES;
  const m = getModel();
  const customers = {}; Object.values(m.customers).forEach((c) => { customers[c.customer_id] = c.customer_name; });
  const products = {}; Object.values(m.products).forEach((p) => { products[p.product_id] = p.product_name; });
  const lots = {};
  Object.values(m.lots).forEach((l) => {
    const mat = m.materials[l.material_id];
    lots[l.lot_id] = { material: mat ? mat.material_name : l.material_id, received: String(l.receipt_date || '').slice(0, 7), inspection: l.inspection_result };
  });
  NAMES = { customers, products, lots };
  return NAMES;
}

function summary(state) {
  const jl = judgmentList(state, false);
  const warnings = E.warningList(state, jl.list);
  return {
    rev: store.rev(),
    base_date: BASE_DATE,
    ai: ai.aiStatus(),
    settings: state.settings,
    judgments: jl,
    warnings,
    feed: E.feedList(state, 30),
    rules: E.ruleHits(state),
    trend: E.claimTrend(state),
    overview: overview(state),
    cases: state.cases.map((c) => ({ id: c.id, title: c.title, status: c.status, batchIds: c.batchIds, approvedBatchIds: c.approvedBatchIds, plan: c.plan ? { status: c.plan.status, selected: c.plan.selected } : null })),
    tasks: state.tasks,
    infoRequests: state.infoRequests,
    events: state.events,
    claimOverrides: state.claimOverrides,
    holdingReplies: state.holdingReplies,
    procurementReply: state.procurementReply,
    c105Confirmed: state.c105Confirmed,
    implementation: IMPLEMENTATION,
  };
}

function sourcesInfo() {
  const out = [];
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p);
    else if (d.name !== 'README.md') {
      const buf = fs.readFileSync(p);
      const rel = path.relative(SOURCE_DIR, p).split(path.sep).join('/');
      out.push({ path: rel, bytes: buf.length, rows: rel.endsWith('.csv') ? buf.toString('utf8').split(/\r?\n/).filter(Boolean).length - 1 : null, sha256: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16), tag: '[원본] 내용 무수정 복사' });
    }
  });
  walk(SOURCE_DIR);
  const m = getModel();
  return {
    files: out,
    derived: [
      { name: 'PL-02 미출하 주문', value: `${m.unshippedPl02.length}건 / ${m.unshippedPl02.reduce((s, o) => s + o.order_qty, 0).toLocaleString()} EA`, tag: '[도출] SO − SH(order_id), 2024-01 이전 주문 제외' },
      { name: '예상 납기', value: '주문일 + 61일', tag: '[추정] PL-02 리드타임 중앙값(SO에 납기 필드 없음)' },
      { name: 'PL-02 월평균 생산(2026 H1)', value: m.pl02MonthlyAvg.toLocaleString() + ' EA', tag: '[도출] prod_batch_log_cv' },
      { name: 'Masil 더마 발주', value: m.masilPos.reduce((s, p) => s + p.order_qty, 0).toLocaleString() + ' EA (' + m.masilPos.length + '건)', tag: '[원본] sc_purchase_orders_ms (Corevia SO에 없음)' },
      { name: 'L-02 캐파', value: '1,949,480 / 가동률 97%', tag: '[원본] 기간 단위 불일치 → 월 여유 14,800 EA [가정] (대안 58,484 / 4,874)' },
      { name: 'SBL↔SH 연결', value: '정확 일치 0건', tag: '[도출] 금액 영향은 [가정], 손실 확정 금지' },
      { name: '클레임 미확정 매핑', value: 'status ∈ {접수, 조사중, 정정(재조사)} 이고 defect_confirmed=False', tag: '[가정] 원본에 "보류" 값 없음' },
    ],
    implementation: IMPLEMENTATION,
  };
}

async function route(req, res, url, parsedBody) {
  const state = store.get();
  const p = url.pathname;
  const m = (re) => p.match(re);
  const method = req.method;
  const body = parsedBody || {};
  let r;

  if (p === '/api/health') return send(res, 200, { ok: true, base_date: BASE_DATE });
  if (p === '/api/state' && method === 'GET') return send(res, 200, summary(state));
  if (p === '/api/report.csv' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="recall-report-${BASE_DATE}.csv"; filename*=UTF-8''${encodeURIComponent('회수판정_' + BASE_DATE + '.csv')}` });
    return res.end(REPORT.reportCsv(state));
  }
  if (p === '/api/report.html' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(REPORT.reportHtml(state));
  }
  if (p === '/api/names' && method === 'GET') return send(res, 200, namesTable());
  if (p === '/api/rev' && method === 'GET') return send(res, 200, { rev: store.rev() });
  if (p === '/api/batches' && method === 'GET') return send(res, 200, judgmentList(state, url.searchParams.get('all') === '1'));
  if ((r = m(/^\/api\/batches\/([^/]+)$/)) && method === 'GET') {
    const model = getModel();
    const J = E.judge(state);
    const j = J.judgments[r[1]];
    if (!j) return send(res, 404, { error: '배치 없음' });
    return send(res, 200, { judgment: j, claims: J.claims.filter((c) => c.batch_id === r[1] || (c._override && c._override.original_batch === r[1])), sbl: model.sblByBatch[r[1]] || [] });
  }
  if ((r = m(/^\/api\/warnings\/([^/]+)\/ack$/)) && method === 'POST') { const out = E.ackWarning(state, r[1].replace(/%3A/gi, ':'), body.note); store.save(); return send(res, 200, out); }
  if (p === '/api/cases' && method === 'GET') return send(res, 200, state.cases.map((c) => E.caseView(state, c)));
  if (p === '/api/cases' && method === 'POST') { const c = E.createCase(state, body); store.save(); return send(res, 201, E.caseView(state, c)); }
  if ((r = m(/^\/api\/cases\/([^/]+)$/)) && method === 'GET') return send(res, 200, E.caseView(state, E.findCase(state, r[1])));
  if ((r = m(/^\/api\/cases\/([^/]+)\/(judge|ai\/submission|submit|reply\/interpret|reply|plan\/compute|plan\/explain|plan\/submit|plan\/approve|close)$/)) && method === 'POST') {
    const id = r[1]; const act = r[2]; let out;
    if (act === 'judge') out = E.judgeCase(state, id);
    else if (act === 'ai/submission') out = await E.prepareSubmissionDraft(state, id);
    else if (act === 'submit') out = E.submitCase(state, id, body);
    else if (act === 'reply/interpret') out = await E.interpretReply(state, id, body.text || '');
    else if (act === 'reply') out = E.recordReply(state, id, body);
    else if (act === 'plan/compute') out = E.computeCasePlan(state, id, body.assumptions);
    else if (act === 'plan/explain') out = await E.explainCasePlan(state, id);
    else if (act === 'plan/submit') out = E.submitPlan(state, id, body);
    else if (act === 'plan/approve') out = E.approvePlan(state, id, body);
    else if (act === 'close') out = E.closeCase(state, id);
    store.save();
    return send(res, 200, { result: out, case: E.caseView(state, E.findCase(state, id)) });
  }
  if (p === '/api/events' && method === 'GET') return send(res, 200, state.events);
  if (p === '/api/events' && method === 'POST') { const ev = E.applyEvent(state, body); store.save(); return send(res, 201, ev); }
  if ((r = m(/^\/api\/info-requests\/([^/]+)\/answer$/)) && method === 'POST') { const out = E.answerInfoRequest(state, r[1], body); store.save(); return send(res, 200, out); }
  if ((r = m(/^\/api\/tasks\/([^/]+)\/(status|draft|send|apply-ai)$/)) && method === 'POST') {
    let out;
    if (r[2] === 'status') out = E.updateTaskStatus(state, r[1], body);
    else if (r[2] === 'draft') out = E.editDraft(state, r[1], body.text);
    else if (r[2] === 'apply-ai') out = E.applyAiDraft(state, r[1], body);
    else out = E.sendNotice(state, r[1]);
    store.save();
    return send(res, 200, out);
  }
  if (p === '/api/settings/extension' && method === 'POST') { const out = E.setExtension(state, body.on); store.save(); return send(res, 200, out); }
  if (p === '/api/extension/compare' && method === 'GET') return send(res, 200, compareExtension(state));
  if (p === '/api/audit' && method === 'GET') return send(res, 200, state.audit);
  if (p === '/api/sources' && method === 'GET') return send(res, 200, sourcesInfo());
  if (p === '/api/scenarios' && method === 'GET') return send(res, 200, SC.listScenarios(state));
  if ((r = m(/^\/api\/scenarios\/([^/]+)\/start$/)) && method === 'POST') {
    if (!SC.SCENARIOS[r[1]]) return send(res, 404, { error: '없는 시나리오 번호입니다: ' + r[1] + ' (1·2·3만 가능) — 상태는 바뀌지 않았습니다' });
    const s = store.reset(true);
    s.scenario = { id: Number(r[1]), next: 0, results: [] };
    store.save();
    return send(res, 200, SC.listScenarios(s).find((x) => x.id === Number(r[1])));
  }
  if ((r = m(/^\/api\/scenarios\/([^/]+)\/step$/)) && method === 'POST') {
    if (!SC.SCENARIOS[r[1]]) return send(res, 404, { error: '없는 시나리오 번호입니다: ' + r[1] });
    const out = await SC.runStep(state, Number(r[1]));
    store.save();
    return send(res, 200, out);
  }
  if (p === '/api/reset' && method === 'POST') { store.reset(false); return send(res, 200, { ok: true, message: '초기화 완료(시드 상태)' }); }
  return send(res, 404, { error: '없는 API: ' + method + ' ' + p });
}

function sendText(res, status, text) {
  if (res.headersSent) { try { res.end(); } catch (e) { /* 이미 닫힘 */ } return; }
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function serveStatic(req, res, url) {
  // F18: 잘못된 퍼센트 인코딩(예: /%E0%A4%A, /%)은 예외로 프로세스를 죽이지 않고 400
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch (e) { return sendText(res, 400, '잘못된 주소입니다(주소 인코딩 오류)'); }
  if (rel.includes('\0')) return sendText(res, 400, '잘못된 주소입니다');
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return sendText(res, 403, '접근할 수 없는 주소입니다');
  fs.readFile(file, (err, data) => {
    try {
      if (err) return sendText(res, 404, '없는 주소입니다');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch (e) {
      console.error(e);
      sendText(res, 500, '서버 내부 오류가 발생했습니다');
    }
  });
}

// F23: 상태를 바꾸는 요청은 한 번에 하나씩 처리(직렬화 큐). 본문은 큐 밖에서 먼저 다 읽는다.
let mutationQueue = Promise.resolve();
function serialize(fn) {
  const run = mutationQueue.then(fn, fn);
  mutationQueue = run.then(() => undefined, () => undefined);
  return run;
}

function sendError(res, e, rolledBack) {
  try {
    const status = e && e.status ? e.status : 500;
    if (status >= 500) console.error(e);
    const message = status >= 500 ? '서버 내부 오류가 발생했습니다. 요청은 반영되지 않았습니다.' : e.message;
    if (res.headersSent) { res.end(); return; }
    send(res, status, { error: message, rolled_back: rolledBack, ...((e && e.extra) || {}) });
  } catch (e2) {
    console.error(e2);
    try { if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('서버 내부 오류가 발생했습니다'); } catch (e3) { /* 응답 불가 */ }
  }
}

function createServer() {
  return http.createServer(async (req, res) => {
    // F18: 요청 처리 전체를 요청 단위로 보호 — 어떤 예외도 프로세스를 종료시키지 않음(500 한국어 응답)
    let url;
    try {
      try { url = new URL(req.url, 'http://localhost'); } catch (e) { return sendText(res, 400, '잘못된 주소입니다'); }
      if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url);
      if (req.method !== 'POST') { await route(req, res, url, {}); return; }
    } catch (e) { sendError(res, e, false); return; }
    // POST: ① 본문을 먼저 끝까지 읽고(이 동안 상태는 건드리지 않음) ② 큐에서 차례가 오면
    // ③ 상태 변경 직전에 스냅샷 → 처리 → 실패하면 이 요청의 변경만 되돌림(F5·F23)
    let body;
    try { body = await readBody(req); } catch (e) { sendError(res, e, false); return; }
    await serialize(async () => {
      const snapshot = JSON.stringify(store.get());
      try {
        await route(req, res, url, body);
      } catch (e) {
        try { store.replace(JSON.parse(snapshot)); } catch (e2) { console.error(e2); }
        sendError(res, e, true);
      }
    });
  });
}

// F24: 프로세스 안전망이 작동하면 메모리 상태를 믿지 않고 마지막으로 저장된 state.json을 다시 읽는다
function onFatal(kind, e) {
  console.error(kind + '(서버 유지):', e);
  try {
    const reloaded = store.reloadFromDisk();
    console.error(reloaded ? '마지막 저장 상태(state.json)를 다시 읽었습니다' : '저장된 상태 파일이 없어 메모리 상태를 유지합니다');
    return reloaded;
  } catch (e2) {
    console.error('상태 재적재 실패:', e2);
    return false;
  }
}

if (require.main === module) {
  // F18·F24: 마지막 안전망 — 예상하지 못한 예외는 기록하고 마지막 저장 상태를 다시 읽은 뒤 프로세스 유지
  process.on('uncaughtException', (e) => onFatal('처리되지 않은 예외', e));
  process.on('unhandledRejection', (e) => onFatal('처리되지 않은 비동기 오류', e));
  store.load();
  getModel();
  createServer().listen(PORT, () => console.log(`품질 회수·공급 복구 운영 시스템 — http://localhost:${PORT} (기준일 ${BASE_DATE}, AI: ${ai.aiStatus().mode})`));
}

module.exports = { createServer, onFatal };
