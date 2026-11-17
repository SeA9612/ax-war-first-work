'use strict';
// 보고서 내보내기: 회수 판정 결과를 CSV(엑셀용)와 인쇄용 화면으로 만든다.
// 화면과 같은 규칙 엔진 결과를 그대로 쓰며, 상태를 바꾸지 않는다(읽기 전용).
const E = require('./engine');
const { getModel, BASE_DATE } = require('./data');

const PRIORITY = { '회수 대상': 0, '분모 민감': 1, '예방 점검': 2, '조사·소명': 3, '정상(기준 미달)': 4, '정상': 5 };
const pct = (x) => (x == null ? '' : (x * 100).toFixed(2) + '%');
const num = (x) => (x == null ? '' : Number(x).toLocaleString('ko-KR'));
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad2 = (x) => String(x).padStart(2, '0');
// 서버 시각을 한국 시간으로 표기(서버가 UTC로 돌아도 같은 값)
function kst(d) {
  const k = new Date(d.getTime() + 9 * 3600e3);
  return `${k.getUTCFullYear()}-${pad2(k.getUTCMonth() + 1)}-${pad2(k.getUTCDate())} ${pad2(k.getUTCHours())}:${pad2(k.getUTCMinutes())}`;
}

function sortedJudgments(state) {
  const J = E.judge(state);
  const list = Object.values(J.judgments).sort((a, b) => (PRIORITY[a.status] ?? 9) - (PRIORITY[b.status] ?? 9) || (b.rateP || 0) - (a.rateP || 0) || a.batch_id.localeCompare(b.batch_id));
  return { J, list };
}

// ---------------- CSV ----------------
const csvCell = (v) => {
  const s = String(v == null ? '' : v);
  // 엑셀 수식으로 해석되는 값(=, +, -, @ 로 시작)은 앞에 ' 를 붙여 글자로 둔다
  const safe = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? "'" + s : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const stripTags = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function reportCsv(state) {
  const m = getModel();
  const { list } = sortedJudgments(state);
  const caseOf = (b) => state.cases.filter((c) => c.batchIds.includes(b)).map((c) => `${c.id}(${c.status})`).join(' ');
  const head = ['배치', '제품', '제품명', '생산일', '원료 로트', 'QC 결과', '생산량(EA)', 'SBL 출하(EA)', '확정 불량(EA)', '생산 기준 불량률', '출하 기준 불량률', '미확정 클레임(건)', '판정', '기본 판정', 'QC 보류인데 출하', '사건', '근거'];
  const rows = list.map((j) => [
    j.batch_id, j.product_id, (m.products[j.product_id] || {}).product_name || '', j.production_date, j.input_lot_ids.join(' '), j.qc_result,
    j.produced_qty, j.shipped_qty, j.confirmed_qty, pct(j.rateP), pct(j.rateS), j.open_count,
    j.status, j.base_status, j.warn_hold_shipped ? '예' : '', caseOf(j.batch_id), stripTags(j.reason),
  ]);
  const meta = [[`회수 판정 결과 — 기준일 ${BASE_DATE}, 작성 ${kst(new Date())} (한국 시간), 회수 기준: 확정 불량률 10%`]];
  // 맨 앞 BOM: 엑셀에서 한글이 깨지지 않게
  return '﻿' + [...meta, head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// ---------------- 인쇄용 화면 ----------------
const tagText = (s) => esc(s).replace(/\[(원본|도출|가정|모의|미확인|추정)([^\]]*)\]/g, '<span class="tg">[$1$2]</span>');

function reportHtml(state) {
  const m = getModel();
  const { J, list } = sortedJudgments(state);
  const counts = {};
  list.forEach((j) => { counts[j.status] = (counts[j.status] || 0) + 1; });
  const focus = list.filter((j) => ['회수 대상', '분모 민감', '예방 점검'].includes(j.status));
  const prodName = (id) => (m.products[id] || {}).product_name || '';
  const custName = (id) => (m.customers[id] || {}).customer_name || '';
  const warnings = E.warningList(state, list);
  const views = state.cases.map((c) => E.caseView(state, c, J));
  const now = kst(new Date());

  const countRow = Object.keys(PRIORITY).map((k) => `<td class="${k === '회수 대상' && counts[k] ? 'hot' : ''}"><div class="k">${esc(k)}</div><div class="v">${num(counts[k] || 0)}</div></td>`).join('');

  const focusTbl = focus.length ? `<table><thead><tr><th>배치</th><th>제품</th><th>생산일</th><th class="r">생산량</th><th class="r">SBL 출하</th><th class="r">확정 불량</th><th class="r">생산 기준</th><th class="r">출하 기준</th><th class="r">미확정</th><th>판정</th><th>근거</th></tr></thead><tbody>
    ${focus.map((j) => `<tr class="${j.status === '회수 대상' ? 'hot' : ''}"><td class="nw">${esc(j.batch_id)}</td><td>${esc(j.product_id)} ${esc(prodName(j.product_id))}</td><td class="nw">${esc(j.production_date)}</td><td class="r">${num(j.produced_qty)}</td><td class="r">${num(j.shipped_qty)}</td><td class="r">${num(j.confirmed_qty)}</td><td class="r"><b>${pct(j.rateP)}</b></td><td class="r">${pct(j.rateS)}</td><td class="r">${num(j.open_count)}</td><td class="nw"><b>${esc(j.status)}</b>${j.status !== j.base_status ? `<div class="s">기본 판정 ${esc(j.base_status)}</div>` : ''}</td><td class="s">${tagText(j.reason)}${j.warn_hold_shipped ? '<div>QC 결과 보류인데 출하됨</div>' : ''}</td></tr>`).join('')}
    </tbody></table>` : '<p class="muted">회수 대상·분모 민감·예방 점검 배치가 없습니다.</p>';

  const scopeHtml = views.length ? views.map((v) => {
    const sc = (v.scope || []);
    const total = sc.reduce((s, x) => s + (x.shipped_qty || 0), 0);
    return `<h3>${esc(v.id)} ${esc(v.title)} <span class="st">${esc(v.status)}</span></h3>
    <div class="s">대상 배치 ${esc(v.batchIds.join(', '))}${v.approvedBatchIds && v.approvedBatchIds.length ? ` · 의결된 배치 ${esc(v.approvedBatchIds.join(', '))}` : ' · 아직 위원회 의결 전(회수 범위 확정 아님)'}</div>
    ${sc.length ? `<table><thead><tr><th>고객</th><th class="r">SBL 출하(EA)</th><th class="r">클레임(건)</th><th class="r">클레임 수량(EA)</th><th>배치</th><th>근거</th></tr></thead><tbody>
      ${sc.map((x) => `<tr><td class="nw">${esc(x.customer_id)} ${esc(x.customer_name || custName(x.customer_id))}</td><td class="r">${num(x.shipped_qty)}</td><td class="r">${num(x.claim_count)}</td><td class="r">${num(x.claim_qty)}</td><td class="s">${esc((x.batches || []).join(', '))}</td><td class="s">${tagText(x.source)}${x.unverified ? ' <b>[미확인]</b>' : ''}</td></tr>`).join('')}
      <tr class="sum"><td>합계 ${sc.length}곳</td><td class="r">${num(total)}</td><td colspan="4"></td></tr></tbody></table>` : '<p class="muted">회수 범위 고객 없음</p>'}`;
  }).join('') : '<p class="muted">접수된 사건이 없습니다. 회수 범위 고객은 사건을 접수하면 정해집니다.</p>';

  const warnHtml = warnings.length ? `<table><thead><tr><th>상태</th><th>내용</th><th>처리</th></tr></thead><tbody>
    ${warnings.map((w) => `<tr class="${w.status === '열림' ? 'hot' : ''}"><td class="nw"><b>${esc(w.status)}</b></td><td>${tagText(w.text)}</td><td class="s">${w.handled ? `${esc(w.handled.how)} · ${esc(w.handled.by)}${w.handled.note ? ` · ${esc(w.handled.note)}` : ''}` : '처리 전'}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">경고 없음</p>';

  const caseHtml = views.length ? `<table><thead><tr><th>사건</th><th>제목</th><th>상태</th><th class="r">작업</th><th class="r">완료</th><th class="r">상신</th></tr></thead><tbody>
    ${views.map((v) => `<tr><td class="nw">${esc(v.id)}</td><td>${esc(v.title)}</td><td class="nw"><b>${esc(v.status)}</b></td><td class="r">${num(v.tasks.length)}</td><td class="r">${num(v.tasks.filter((t) => /완료|발송/.test(t.status)).length)}</td><td class="r">${num((v.submissions || []).length)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">접수된 사건이 없습니다.</p>';

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>회수 판정 보고서 ${esc(BASE_DATE)}</title>
<style>
:root { --ink:#1d2329; --muted:#5d6670; --line:#d5dae0; --hot:#fdecec; }
* { box-sizing: border-box; }
body { margin: 0; background: #fff; color: var(--ink); font: 13px/1.5 "Malgun Gothic", "Apple SD Gothic Neo", system-ui, sans-serif; }
.page { max-width: 1040px; margin: 0 auto; padding: 24px 16px 40px; }
.bar { display: flex; gap: 8px; justify-content: flex-end; margin-bottom: 12px; }
.bar a, .bar button { font: inherit; padding: 6px 14px; border: 1px solid var(--line); background: #fff; color: var(--ink); border-radius: 4px; cursor: pointer; text-decoration: none; }
.bar button { background: var(--ink); color: #fff; border-color: var(--ink); }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 24px 0 8px; padding-bottom: 4px; border-bottom: 2px solid var(--ink); }
h3 { font-size: 13px; margin: 14px 0 4px; }
.meta { color: var(--muted); font-size: 12px; }
table { width: 100%; border-collapse: collapse; margin-top: 6px; }
th, td { border: 1px solid var(--line); padding: 4px 6px; text-align: left; vertical-align: top; }
th { background: #f3f5f7; font-weight: 700; font-size: 12px; }
.r { text-align: right; font-variant-numeric: tabular-nums; }
.nw { white-space: nowrap; }
.s { font-size: 11.5px; color: var(--muted); }
.muted { color: var(--muted); }
tr.hot td, td.hot { background: var(--hot); }
tr.sum td { font-weight: 700; }
.counts td { text-align: center; }
.counts .k { font-size: 12px; color: var(--muted); }
.counts .v { font-size: 18px; font-weight: 700; }
.st { font-weight: 400; color: var(--muted); }
.tg { color: var(--muted); }
.foot { margin-top: 28px; font-size: 11px; color: var(--muted); border-top: 1px solid var(--line); padding-top: 8px; }
.wrap { overflow-x: auto; }
@media print {
  .bar { display: none; }
  .page { max-width: none; padding: 0; }
  body { font-size: 10.5px; }
  h2 { break-after: avoid; }
  tr { break-inside: avoid; }
  tr.hot td, td.hot, th { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .wrap { overflow: visible; }
}
@page { size: A4 landscape; margin: 12mm; }
</style></head>
<body><div class="page">
<div class="bar"><a href="/">운영 화면으로</a><a href="/api/report.csv" download>CSV 받기</a><button type="button" id="printBtn">인쇄 / PDF 저장</button></div>
<h1>품질 회수 판정 보고서</h1>
<div class="meta">기준일 ${esc(BASE_DATE)} · 작성 ${esc(now)} (한국 시간) · 회수 기준: 확정 불량률 10%(생산량 기준, 출하량 기준 함께 표기) · 확장(a) 로트 추적 ${state.settings.extensionOn ? 'ON' : 'OFF'}</div>

<h2>1. 판정 요약 (전체 ${num(list.length)}개 배치)</h2>
<table class="counts"><tr>${countRow}</tr></table>

<h2>2. 조치가 필요한 배치</h2>
<div class="wrap">${focusTbl}</div>
<p class="s">조사·소명 ${num(counts['조사·소명'] || 0)}개 배치와 정상 배치는 CSV에 모두 담겨 있습니다.</p>

<h2>3. 경고</h2>
<div class="wrap">${warnHtml}</div>

<h2>4. 사건 진행</h2>
<div class="wrap">${caseHtml}</div>

<h2>5. 회수 범위 고객</h2>
<div class="wrap">${scopeHtml}</div>

<div class="foot">근거 표기: [원본] 원본 파일 값, [도출] 원본으로 계산한 값, [가정] 팀 가정, [모의] 가상 입력과 회신, [미확인] 확인 요청 대상. 언론 보도와 미확정 클레임은 판정에 넣지 않습니다. 이 보고서는 작성 시각의 시스템 상태를 그대로 옮긴 것이며, 판정을 바꾸지 않습니다.</div>
</div>
<script>document.getElementById('printBtn').addEventListener('click', function () { window.print(); });</script>
</body></html>`;
}

module.exports = { reportCsv, reportHtml };
