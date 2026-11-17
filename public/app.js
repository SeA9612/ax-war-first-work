'use strict';
// 화면(한국어). 모든 처리는 서버 API가 수행하고, 화면은 결과·상태를 보여준다.
// 디자인 명세: docs/design/디자인_명세.md — 판정 칩(j-*) / 처리 상태 칩(p-*) / 근거 태그(ev-*) / 실행 구분(run-*)
const $ = (s, el) => (el || document).querySelector(s);
const main = $('#main');
const ui = { tab: 'overview', caseId: null, summary: null, showAll: false, openWarn: null, warnTab: '열림', dirty: false, jFilter: null, scenario: null, plan: { monthly_spare_ea: 14800, requal_days: 14, limit_weeks: 12 } };

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (x) => (x == null ? '-' : Number(x).toLocaleString('ko-KR'));
const pct = (x) => (x == null ? '-' : (x * 100).toFixed(2) + '%');
// 시각은 보는 사람의 현지 시각(한국이면 KST)으로 표시. 서버에는 표준시(UTC)로 저장돼 있다.
const pad2 = (x) => String(x).padStart(2, '0');
const dt = (s) => { if (!s) return ''; const d = new Date(s); if (isNaN(d)) return String(s); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || res.statusText); e.data = data; throw e; }
  return data;
}

// ---------------- 알림(토스트) · 처리 중 표시 ----------------
function toast(msg, err) {
  const t = $('#toast');
  $('#toastMsg').innerHTML = `<span class="t-ico" aria-hidden="true">${err ? '✕' : '✓'}</span>${esc(msg)}`;
  t.className = 'toast' + (err ? ' err' : '');
  t.setAttribute('role', err ? 'alert' : 'status');
  t.setAttribute('aria-live', err ? 'assertive' : 'polite');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), err ? 7000 : 3500);
}
let busy = 0;
function setBusy(on) { busy = Math.max(0, busy + (on ? 1 : -1)); main.setAttribute('aria-busy', busy ? 'true' : 'false'); }
async function act(fn, okMsg) {
  if (busy) return null; // 처리 중 중복 클릭 방지
  setBusy(true);
  try {
    try { const r = await fn(); if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg); await refresh(); return r; } catch (e) {
      let m = e.message; if (e.data && e.data.violations) m += '\n' + e.data.violations.map((v) => '· ' + v.label + ': 「' + v.match + '」').join('\n');
      toast(m, true); await refresh(); return null;
    }
  } finally { setBusy(false); }
}

// ---------------- 칩·태그 ----------------
const JUDG = { '회수 대상': 'j-recall', '분모 민감': 'j-sens', '예방 점검': 'j-prev', '조사·소명': 'j-inv', '정상(기준 미달)': 'j-below', '정상': 'j-ok' };
const PROC = {
  '접수': 'p-wait', '판정 완료': 'p-wait', '대기': 'p-wait', '확인 대기': 'p-wait',
  '위원회 상신': 'p-active', '상신': 'p-active', '재공급 계획 상신': 'p-active', '진행': 'p-active', '복구 진행': 'p-active', '계산 완료': 'p-active', '회신 대기': 'p-active',
  '회수 의결': 'p-done p-red', '재공급 승인': 'p-done', '승인': 'p-done', '완료': 'p-done', '회신 완료': 'p-done', '정상화 완료': 'p-done',
  '보류(추가자료)': 'p-attn', '재검증 필요': 'p-attn', '거절(조사 계속)': 'p-attn', '반려': 'p-attn', '추가자료 요구': 'p-attn', '거절': 'p-attn', '재상신 필요': 'p-attn',
  '취소': 'p-cancel', '철회(판정 하향)': 'p-cancel',
};
function statusChip(s, extra) { return `<span class="chip ${JUDG[s] || PROC[s] || 'p-wait'}${extra ? ' ' + extra : ''}">${esc(s)}</span>`; }
const pchip = (text, cls) => `<span class="chip ${cls}">${esc(text)}</span>`;
const EVC = { 원본: 'ev-src', 도출: 'ev-der', 가정: 'ev-asm', 추정: 'ev-asm', 모의: 'ev-mock', 미확인: 'ev-unk' };
const EV_RE = /\[(원본|도출|가정|모의|미확인|추정)([^\]]*)\]/g;
// 서버 문자열 속 근거 태그를 모양 있는 태그로 감싼다(글자 내용은 그대로).
// 서버 문장(작업 제목·감사기록·판정 근거 등) 속 고객 번호에 이름을 붙인다. 이미 바로 뒤에 이름이 있으면 건너뛴다.
// 고객 통지 초안(pre.draft)은 tagify를 쓰지 않으므로 실제 발송 문안은 바뀌지 않는다.
function withCustNames(html) {
  return html.replace(/\bC-\d{3}\b/g, (id, at, all) => {
    const name = NAMES.customers && NAMES.customers[id];
    if (!name) return id;
    const after = all.slice(at + id.length, at + id.length + name.length + 2);
    if (after.startsWith('(' + name) || after.startsWith(' ' + name) || all.startsWith(' <span class="idname">', at + id.length) || all.startsWith('<span class="idname">', at + id.length)) return id;
    return `${id}<span class="idname">(${esc(name)})</span>`;
  });
}
function tagify(v) {
  return withCustNames(esc(v).replace(EV_RE, (m, k) => `<span class="tag ${EVC[k]}">${m}</span>`).replace(/\(모의\)/g, '<span class="tag ev-mock">(모의)</span>'));
}
const anyTag = (t) => (/^\[(원본|도출|가정|모의|미확인|추정)/.test(t) ? tagify(t) : `<span class="tag">${esc(t)}</span>`);
const RUN = {
  real: '<span class="tag run-real">[실제 작동]</span>',
  mock: '<span class="tag run-mock">[모의 처리]</span>',
  ai: '<span class="tag run-ai">모의 AI</span>',
};
const modeTag = (m) => `<span class="tag ${m === '모의 AI' ? 'run-ai' : 'run-real'}">${esc(m)}</span>`;
// 표 래퍼: 가로 스크롤은 래퍼 안에서만(페이지 가로 스크롤 방지)
const tbl = (inner, o = {}) => `<div class="table-wrap${o.h ? ' scroll h' + o.h : ''}${o.sticky ? ' sticky1' : ''}"><table${o.min ? ` style="min-width:${o.min}px"` : ''}>${inner}</table></div>`;
const SHARED = '공유 시연 환경입니다. 이 작업은 이 화면을 보는 모든 사용자의 상태를 바꿉니다. 계속할까요?';
// 화면 안 확인 상자 — 브라우저 확인 팝업(confirm)은 앱 내 미리보기 창 등에서 막혀 버튼이 반응 없는 것처럼 보이므로 대신 사용
function askConfirm(title, detail, okLabel) {
  const dlg = $('#confirmDlg');
  $('#cfTitle').textContent = title;
  $('#cfBody').textContent = detail;
  $('#cfOk').textContent = okLabel;
  return new Promise((resolve) => {
    const done = (v) => { dlg.removeEventListener('close', onClose); if (dlg.open) dlg.close(); resolve(v); };
    const onClose = () => done(dlg.returnValue === 'ok');
    dlg.returnValue = '';
    dlg.addEventListener('close', onClose);
    $('#cfOk').onclick = () => { dlg.returnValue = 'ok'; dlg.close(); };
    $('#cfCancel').onclick = () => { dlg.returnValue = ''; dlg.close(); };
    dlg.showModal();
    $('#cfCancel').focus();
  });
}

// 번호 옆 한글 이름: 원본 번호는 그대로 두고(추적용 열쇠), 뜻을 작게 붙인다.
let NAMES = { customers: {}, products: {}, lots: {} };
const nm = (txt) => `<span class="idname">${esc(txt)}</span>`;
const custL = (id) => `${esc(id)}${NAMES.customers[id] ? ' ' + nm(NAMES.customers[id]) : ''}`;
const prodL = (id) => `${esc(id)}${NAMES.products[id] ? ' ' + nm(NAMES.products[id]) : ''}`;
const lotL = (id) => { const l = NAMES.lots[id]; return `${esc(id)}${l ? ' ' + nm(`${l.material}, ${l.received} 입고${l.inspection && l.inspection !== '규격내' ? ', 입고검사 ' + l.inspection : ''}`) : ''}`; };
const custText = (id) => `${id}${NAMES.customers[id] ? '(' + NAMES.customers[id] + ')' : ''}`;
function setLive(ok) {
  const el = $('#liveState'); if (!el) return;
  el.classList.toggle('down', !ok);
  el.textContent = ok ? `자동 갱신 중, 마지막 확인 ${dt(new Date().toISOString()).slice(11)}` : '연결 끊김, 다시 시도 중';
}
async function refresh() {
  if (!NAMES.loaded) { try { NAMES = { ...(await api('GET', '/api/names')), loaded: true }; } catch (e) { /* 이름 없이도 화면은 동작 */ } }
  ui.summary = await api('GET', '/api/state');
  $('#extToggle').checked = ui.summary.settings.extensionOn;
  $('#extState').textContent = ': ' + (ui.summary.settings.extensionOn ? 'ON' : 'OFF');
  await render();
  ui.dirty = false;
  $('#liveBar').hidden = true;
  setLive(true);
}

async function render() {
  document.querySelectorAll('#tabs button').forEach((x) => {
    const on = x.dataset.tab === ui.tab;
    x.classList.toggle('active', on); x.setAttribute('aria-selected', on ? 'true' : 'false'); x.tabIndex = on ? 0 : -1;
    if (on) x.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
  });
  const fn = { overview: renderOverview, dashboard: renderDashboard, cases: renderCases, events: renderEvents, plan: renderPlan, ext: renderExt, scenarios: renderScenarios, audit: renderAudit, sources: renderSources }[ui.tab];
  try {
    await fn();
  } catch (e) {
    // 화면을 그리다 실패하면 이전 탭 내용이 남지 않도록 오류 안내로 바꾼다
    const tabName = (document.querySelector(`#tabs button[data-tab="${ui.tab}"]`) || {}).textContent || ui.tab;
    main.innerHTML = `<h2>${esc(tabName)}</h2><div class="panel errbox"><b>화면을 표시하지 못했습니다.</b><div class="small top-gap">${esc(e && e.message ? e.message : String(e))}</div><div class="small top-gap">저장된 상태가 이전 버전 형식일 수 있습니다. 상단 '초기화' 후 다시 시도하거나, 다른 탭으로 이동했다가 돌아오세요.</div><div class="top-gap"><button class="btn" id="retryRender">다시 표시</button></div></div>`;
    const rb = $('#retryRender'); if (rb) rb.onclick = () => refresh().catch(() => {});
    console.error('화면 표시 오류', e);
  }
}

// ---------------- 한눈에 보기(첫 화면) ----------------
// 누구나 배우지 않고 읽는 요약판. 평소엔 흰 칸, 문제가 있는 칸만 빨간 칸. 칸을 누르면 자세한 화면으로 간다.
// 칸 안 작은 그림: 클레임 칸은 최근 6개월 추이선(마지막 점 강조), 작업 칸은 완료 진행 막대. 숫자를 대신하지 않고 흐름만 보탠다.
function ovSpark(vals, labels) {
  const W = 120, H = 30, pad = 3, mx = Math.max(1, ...vals);
  const x = (i) => pad + (i * (W - pad * 2)) / Math.max(1, vals.length - 1);
  const y = (v) => H - pad - (v / mx) * (H - pad * 2);
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const li = vals.length - 1;
  return `<svg class="ov-spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="최근 ${vals.length}개월: ${vals.map((v, i) => `${labels[i]} ${v.toLocaleString('ko-KR')}`).join(', ')}"><polyline points="${pts}"/><circle cx="${x(li)}" cy="${y(vals[li])}" r="3"/></svg><span class="ov-spark-l">${esc(labels[0])}~${esc(labels[li])}</span>`;
}
function ovTileExtra(t, o) {
  const last6 = o.monthly.slice(-6);
  if (t.key === 'claims') return ovSpark(last6.map((m) => m.claims), last6.map((m) => m.label));
  if (t.key === 'confirmed') return ovSpark(last6.map((m) => m.confirmed_qty), last6.map((m) => m.label));
  if (t.key === 'tasks' && t.value != null) return `<span class="ov-prog" role="img" aria-label="완료 ${t.value}%"><span style="width:${t.value}%"></span></span>`;
  return '';
}
function ovTileHtml(t, o) {
  const v = t.value == null ? '-' : n(t.value);
  const note = t.key === 'case' || t.key === 'recall' ? withCustNames(esc(t.note)) : esc(t.note);
  return `<button type="button" class="kpi ov-tile${t.alert ? ' on' : ''}" data-ov="${esc(t.key)}" aria-label="${esc(t.label)} ${esc(v)}${esc(t.unit)}${t.alert ? ', 확인 필요' : ''}. ${esc(t.note)}">
    <span class="k">${esc(t.label)}</span><span class="v">${esc(v)}${t.value == null ? '' : `<small>${esc(t.unit)}</small>`}</span><span class="ov-note">${note}</span>${o ? `<span class="ov-extra">${ovTileExtra(t, o)}</span>` : ''}</button>`;
}
function ovMonthlyHtml(o) {
  const W = 640, H = 220, P = { l: 36, r: 8, t: 16, b: 26 };
  const iw = W - P.l - P.r, ih = H - P.t - P.b, nM = o.monthly.length;
  const yMax = Math.ceil(Math.max(5, ...o.monthly.map((x) => x.claims)) / 5) * 5;
  const y = (v) => P.t + ih - (v / yMax) * ih;
  const slot = iw / nM, bw = Math.min(30, slot * 0.6);
  const cx = (i) => P.l + slot * (i + 0.5);
  const ticks = []; for (let v = 0; v <= yMax; v += yMax / 5) ticks.push(v);
  const grid = ticks.map((v) => `<line class="tg" x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}"/><text class="tt" x="${P.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('');
  const bars = o.monthly.map((m, i) => {
    const x = cx(i) - bw / 2;
    const hc = ih * (m.confirmed / yMax), ho = ih * (m.open / yMax);
    const gap = hc > 0 && ho > 0 ? 2 : 0;
    return `<g class="ov-bar" data-mi="${i}"><rect class="hit" x="${cx(i) - slot / 2}" y="${P.t}" width="${slot}" height="${ih}"/>`
      + (hc ? `<rect x="${x}" y="${y(m.confirmed)}" width="${bw}" height="${hc}" rx="2" style="fill:var(--series-1)"/>` : '')
      + (ho ? `<rect x="${x}" y="${y(m.claims)}" width="${bw}" height="${Math.max(0, ho - gap)}" rx="2" style="fill:var(--ov-open)"/>` : '')
      + `<text class="tt" x="${cx(i)}" y="${H - 8}" text-anchor="middle">${esc(m.label)}</text>`
      + (i === nM - 1 || m.claims === Math.max(...o.monthly.map((z) => z.claims)) ? `<text class="tend" x="${cx(i)}" y="${y(m.claims) - 5}" text-anchor="middle">${m.claims}</text>` : '')
      + '</g>';
  }).join('');
  const table = `<details class="top-gap"><summary class="small">표로 보기</summary>${tbl(`<thead><tr><th>월</th><th class="num">클레임</th><th class="num">확정</th><th class="num">미확정</th><th class="num">확정 불량(EA)</th></tr></thead><tbody>${o.monthly.map((m) => `<tr><td>${esc(m.month)}</td><td class="num">${m.claims}</td><td class="num">${m.confirmed}</td><td class="num">${m.open}</td><td class="num">${n(m.confirmed_qty)}</td></tr>`).join('')}</tbody>`)}</details>`;
  return `<div class="panel" id="ovMonthly"><div class="panel-head"><h3>월별 클레임</h3><span class="end small muted">최근 12개월, 접수일 기준</span></div>
    <div class="tlegend"><span class="tl-item"><span class="tl-sw sq" style="background:var(--series-1)"></span>확정 클레임</span><span class="tl-item"><span class="tl-sw sq" style="background:var(--ov-open)"></span>미확정(판정에 넣지 않음)</span></div>
    <div class="tchart" id="ovMonthChart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="최근 12개월 월별 클레임 건수">${grid}${bars}</svg><div class="ttip" hidden></div></div>${table}</div>`;
}
// 제품별 클레임: 전체 중 차지하는 몫(도넛). 회수 대상이 있는 제품만 빨강, 나머지는 회색 단계. 범례에 이름·건수·비율을 글로 적어 색에만 기대지 않음.
const OV_GRAYS = ['#5b6b7d', '#7f8c9a', '#a0aab6', '#bcc4cd', '#d3d8de'];
function ovProductsHtml(o) {
  const total = o.products.reduce((s, p) => s + p.claims, 0);
  const R = 62, SW = 22, C = 2 * Math.PI * R, GAP = 2;
  let k = 0;
  const parts = o.products.filter((p) => p.claims > 0).map((p) => ({ ...p, color: p.issue ? 'var(--j-recall-bar)' : OV_GRAYS[Math.min(k++, OV_GRAYS.length - 1)] }));
  let at = 0;
  const segs = parts.map((p) => {
    const len = total ? (p.claims / total) * C : 0; const g = parts.length > 1 ? Math.min(GAP, len / 2) : 0;
    const el = `<circle class="dn-seg" data-pid="${esc(p.product_id)}" cx="80" cy="80" r="${R}" fill="none" stroke="${p.color}" stroke-width="${SW}" stroke-dasharray="${(len - g).toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-at).toFixed(2)}"/>`;
    at += len; return el;
  }).join('');
  const issue = parts.find((p) => p.issue);
  const legend = o.products.map((p) => { const c = (parts.find((x) => x.product_id === p.product_id) || {}).color || 'var(--line)';
    return `<li class="${p.issue ? 'on' : ''}"><span class="dl-sw" style="background:${c}"></span><span class="dl-name">${esc(p.product_id)} ${nm(p.name)}</span><span class="dl-val">${n(p.claims)}건</span><span class="dl-pct">${total ? Math.round((p.claims / total) * 100) : 0}%</span>${p.issue ? '<span class="dl-note">회수 대상 배치 있음</span>' : ''}</li>`; }).join('');
  return `<div class="panel"><div class="panel-head"><h3>제품별 클레임</h3><span class="end small muted">최근 12개월</span></div>
    <div class="ov-donut"><svg viewBox="0 0 160 160" role="img" aria-label="제품별 클레임 비율, 전체 ${total}건${issue ? `, ${esc(issue.name)} ${Math.round((issue.claims / total) * 100)}%` : ''}"><circle cx="80" cy="80" r="${R}" fill="none" stroke="var(--surface-2)" stroke-width="${SW}"/><g transform="rotate(-90 80 80)">${segs}</g>
      <text x="80" y="78" text-anchor="middle" class="dn-v">${n(total)}건</text><text x="80" y="98" text-anchor="middle" class="dn-k">전체 클레임</text></svg>
    <ul class="ov-dlegend">${legend}</ul><div class="ttip" hidden></div></div></div>`;
}
// 마우스를 올리면 그 막대·조각의 숫자를 작은 상자로 보여 준다(키보드 사용자는 '표로 보기'·범례로 같은 값 확인)
function ovTip(box, targets, html) {
  if (!box) return; const tip = box.querySelector('.ttip');
  const hide = () => { tip.hidden = true; box.querySelectorAll('.hov').forEach((x) => x.classList.remove('hov')); };
  targets.forEach((el) => {
    el.addEventListener('pointerenter', () => { hide(); el.classList.add('hov'); tip.innerHTML = html(el); tip.hidden = false; });
    el.addEventListener('pointermove', (ev) => {
      const r = box.getBoundingClientRect();
      const x = Math.min(ev.clientX - r.left + 14, r.width - tip.offsetWidth - 4);
      const y = Math.max(4, ev.clientY - r.top - tip.offsetHeight - 10);
      tip.style.left = Math.max(4, x) + 'px'; tip.style.top = y + 'px';
    });
    el.addEventListener('pointerleave', hide);
  });
}
function ovBindTips(o) {
  const mc = $('#ovMonthChart');
  if (mc) ovTip(mc, [...mc.querySelectorAll('.ov-bar')], (el) => { const m = o.monthly[Number(el.dataset.mi)];
    return `<b>${esc(m.month.slice(0, 4))}년 ${esc(m.label)}</b><div>클레임 <b>${n(m.claims)}건</b></div><div><span class="tl-sw sq" style="background:var(--series-1)"></span>확정 ${n(m.confirmed)}건 · 불량 ${n(m.confirmed_qty)} EA</div><div><span class="tl-sw sq" style="background:var(--ov-open)"></span>미확정 ${n(m.open)}건</div>`; });
  const dn = main.querySelector('.ov-donut');
  const total = o.products.reduce((a, p) => a + p.claims, 0);
  if (dn) ovTip(dn, [...dn.querySelectorAll('.dn-seg')], (el) => { const p = o.products.find((x) => x.product_id === el.dataset.pid);
    return `<b>${esc(p.product_id)} ${esc(p.name)}</b><div>클레임 <b>${n(p.claims)}건</b> (${total ? Math.round((p.claims / total) * 100) : 0}%)</div><div>확정 불량 ${n(p.confirmed_qty)} EA</div>${p.issue ? '<div class="tip-hot">회수 대상 배치 있음</div>' : ''}`; });
}
async function renderOverview() {
  const s = ui.summary; const o = s.overview;
  const head = o.status === 'issue'
    ? `<div class="ov-status on" role="status"><b>확인이 필요한 곳 ${o.issues}곳</b><span>빨간 칸을 누르면 자세한 화면으로 이동해요.</span></div>`
    : `<div class="ov-status" role="status"><b>지금은 문제가 없어요</b><span>문제가 생기면 해당 칸이 빨간색으로 바뀌어요.</span></div>`;
  main.innerHTML = `<div class="h2row"><h2>한눈에 보기</h2><span class="end report-btns"><a class="btn alt sm" href="/api/report.html" target="_blank" rel="noopener">보고서(인쇄용)</a><a class="btn alt sm" href="/api/report.csv" download>CSV 내보내기</a></span></div>
  ${head}
  <div class="kpis ov-grid">${o.tiles.map((t) => ovTileHtml(t, o)).join('')}</div>
  <div class="kpi-note small muted">원본 데이터 기준(기준일 ${esc(o.base_date)}). '${Number(o.this_month.slice(5))}월'은 기준일 직전 달이에요. 전체 ${n(o.totals.batches)}개 배치.</div>
  <div class="ov-charts">${ovMonthlyHtml(o)}${ovProductsHtml(o)}</div>
  <div class="live-grid">${trendPanelHtml(s.trend)}${feedPanelHtml(s.feed, 6)}</div>`;
  bindTrend(s.trend);
  ovBindTips(o);
  const goTab = (tab, after) => { ui.tab = tab; refresh().then(after || (() => {})).catch((e) => toast(e.message, true)); };
  main.querySelectorAll('[data-ov]').forEach((b) => { b.onclick = () => {
    const t = o.tiles.find((x) => x.key === b.dataset.ov); const g = t.go || {};
    if (g.tab === 'dashboard') {
      ui.jFilter = g.filter || null; if (g.anchor === 'warn') ui.warnTab = '열림';
      goTab('dashboard', () => { const h = [...main.querySelectorAll('.panel-head h3')].find((x) => x.textContent === (g.anchor === 'warn' ? '경고' : '배치 목록')); if (h) h.scrollIntoView({ block: 'start' }); });
    } else if (g.tab) goTab(g.tab);
    else if (g.anchor === 'monthly') $('#ovMonthly').scrollIntoView({ block: 'start' });
  }; });
  main.querySelectorAll('[data-feedcase]').forEach((b) => { b.onclick = () => { ui.caseId = b.dataset.feedcase; goTab('cases'); }; });
  const fa = $('#feedAll'); if (fa) fa.onclick = () => goTab('audit');
}

// ---------------- 대시보드 ----------------
const KPI = [['회수 대상', 'k-recall', 1], ['분모 민감', 'k-sens', 1], ['예방 점검', 'k-prev', 1], ['조사·소명', 'k-inv', 0], ['정상(기준 미달)', 'k-below', 0], ['정상', 'k-ok', 0]];
const WARN_ORDER = { hold_shipped: 0, no_case: 1, sens: 2 };
const WARN_TABS = ['열림', '확인됨', '해결됨'];
// 클레임 추이(운영 감시 5단계): 문제 배치의 주별 누적 확정 불량률(생산 기준) 선 그래프, 10% 회수 기준선.
// 색은 배치 고유(순서 고정, 순위로 바꾸지 않음) — 선 끝 직접 표기 + 범례 + 표로 보기로 색에만 기대지 않음.
const TREND_W = 720, TREND_H = 260, TP = { l: 44, r: 112, t: 14, b: 30 };
function trendGeom(t) {
  const maxRate = Math.max(t.threshold * 1.3, ...t.series.flatMap((s) => s.points.map((p) => p.rate)));
  const yMax = Math.ceil(maxRate * 100 / 2) * 2 / 100; // 2% 단위로 올림
  const iw = TREND_W - TP.l - TP.r, ih = TREND_H - TP.t - TP.b, n = t.weeks.length;
  const x = (i) => TP.l + (n <= 1 ? iw / 2 : (i * iw) / (n - 1));
  const y = (r) => TP.t + ih - (r / yMax) * ih;
  return { yMax, x, y, iw, ih, n };
}
function trendPanelHtml(t) {
  if (!t || !t.series.length) return `<div class="panel"><div class="panel-head"><h3>클레임 추이</h3></div><div class="muted">추이를 볼 문제 배치(회수 대상·분모 민감·사건 배치)가 없습니다.</div></div>`;
  const g = trendGeom(t);
  const pct1 = (r) => (r * 100).toFixed(2) + '%';
  const md = (d) => d.slice(5).replace('-', '/');
  const yTicks = []; for (let v = 0; v <= g.yMax + 1e-9; v += 0.02) yTicks.push(v);
  const xEvery = Math.max(1, Math.ceil(g.n / 8));
  const grid = yTicks.map((v) => `<line class="tg" x1="${TP.l}" x2="${TP.l + g.iw}" y1="${g.y(v)}" y2="${g.y(v)}"/><text class="tt" x="${TP.l - 6}" y="${g.y(v) + 4}" text-anchor="end">${Math.round(v * 100)}%</text>`).join('');
  const xs = t.weeks.map((w, i) => (i % xEvery === 0 || i === g.n - 1) ? `<text class="tt" x="${g.x(i)}" y="${TREND_H - 10}" text-anchor="middle">${md(w)}</text>` : '').join('');
  const thr = `<line class="tthr" x1="${TP.l}" x2="${TP.l + g.iw}" y1="${g.y(t.threshold)}" y2="${g.y(t.threshold)}"/><text class="tthr-l" x="${TP.l + g.iw + 6}" y="${g.y(t.threshold) + 4}">회수 기준 10%</text>`;
  // 선 끝 직접 표기: 겹치지 않게 최소 14px 간격으로 밀어냄
  const ends = t.series.map((s, k) => ({ k, y: g.y(s.points[s.points.length - 1].rate) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i += 1) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
  const endY = Object.fromEntries(ends.map((e) => [e.k, e.y]));
  const lines = t.series.map((s, k) => {
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${g.x(i).toFixed(1)},${g.y(p.rate).toFixed(1)}`).join('');
    const ci = s.crossed_on ? t.weeks.findIndex((w) => w >= s.crossed_on) : -1;
    const cross = ci >= 0 ? `<circle class="tdot" cx="${g.x(ci)}" cy="${g.y(s.points[ci].rate)}" r="4.5" style="fill:var(--series-${k + 1})"/>` : '';
    return `<path class="tline" d="${d}" style="stroke:var(--series-${k + 1})"/>${cross}<text class="tend" x="${TP.l + g.iw + 6}" y="${endY[k] + 4}"><tspan style="fill:var(--series-${k + 1})">■</tspan> ${esc(s.batch_id.slice(-7))}</text>`;
  }).join('');
  const legend = t.series.map((s, k) => `<span class="tl-item"><span class="tl-sw" style="background:var(--series-${k + 1})"></span>${esc(s.batch_id)} ${statusChip(s.status, 'sm')} ${s.crossed_on ? `10% 도달 ${esc(s.crossed_on)}` : '10% 미도달'}, 현재 ${pct1(s.final_rate)}</span>`).join('');
  const table = `<details class="top-gap"><summary class="small">표로 보기</summary>${tbl(`<thead><tr><th>주(일요일까지)</th>${t.series.map((s) => `<th class="num">${esc(s.batch_id)} 누적 확정</th><th class="num">불량률</th>`).join('')}</tr></thead><tbody>${t.weeks.map((w, i) => `<tr><td class="nw">${esc(w)}</td>${t.series.map((s) => `<td class="num">${n(s.points[i].confirmed_qty)}</td><td class="num">${pct1(s.points[i].rate)}</td>`).join('')}</tr>`).join('')}</tbody>`, { h: 360 })}</details>`;
  return `<div class="panel trend-panel"><div class="panel-head"><h3>클레임 추이</h3><span class="end small muted">주별 누적 확정 불량률(생산 기준) ${tagify('[도출]')}</span></div>
    <div class="tlegend">${legend}</div>
    <div class="tchart" id="trendChart"><svg viewBox="0 0 ${TREND_W} ${TREND_H}" role="img" aria-label="문제 배치 주별 누적 확정 불량률과 회수 기준 10%">${grid}${thr}${xs}${lines}<line class="tcross" id="tCross" x1="0" x2="0" y1="${TP.t}" y2="${TP.t + g.ih}" visibility="hidden"/><rect class="thit" x="${TP.l}" y="${TP.t}" width="${g.iw}" height="${g.ih}"/></svg><div class="ttip" id="tTip" hidden></div></div>
    <div class="small muted">현재 '확정'인 클레임 수량을 접수일 기준으로 쌓은 값입니다(확정일은 원본에 없음). 마지막 값은 판정 현황의 생산 기준 불량률과 같습니다.${t.omitted ? ` 그 밖의 배치 ${t.omitted}개는 생략했습니다.` : ''}</div>${table}</div>`;
}
function bindTrend(t) {
  const box = $('#trendChart'); if (!box || !t || !t.series.length) return;
  const svg = box.querySelector('svg'); const hit = box.querySelector('.thit'); const cross = $('#tCross'); const tip = $('#tTip');
  const g = trendGeom(t);
  const show = (ev) => {
    const r = svg.getBoundingClientRect(); const sx = (ev.clientX - r.left) * (TREND_W / r.width);
    const i = Math.max(0, Math.min(g.n - 1, Math.round(((sx - TP.l) / g.iw) * (g.n - 1))));
    cross.setAttribute('x1', g.x(i)); cross.setAttribute('x2', g.x(i)); cross.setAttribute('visibility', 'visible');
    tip.innerHTML = `<b>${esc(t.weeks[i])}까지</b>${t.series.map((s, k) => `<div><span class="tl-sw" style="background:var(--series-${k + 1})"></span>${esc(s.batch_id)} ${(s.points[i].rate * 100).toFixed(2)}% (${n(s.points[i].confirmed_qty)} EA, 클레임 ${s.points[i].claims}건)</div>`).join('')}`;
    tip.hidden = false;
    const px = (g.x(i) / TREND_W) * r.width; tip.style.left = Math.min(px + 12, r.width - tip.offsetWidth - 4) + 'px';
  };
  hit.addEventListener('pointermove', show);
  hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; });
}
// 규칙 적중 현황(운영 감시 4단계): 규칙별 적용 수. 판정 규칙은 누르면 배치 목록을 그 판정으로 거른다.
function rulePanelHtml(rules) {
  const list = rules || [];
  return `<div class="panel"><div class="panel-head"><h3>규칙 적중 현황</h3><span class="end small muted">현재 판정·사건·이벤트 기준</span></div>
    ${tbl(`<thead><tr><th>구분</th><th class="wtext">내용</th><th class="num">적중</th><th>대상</th></tr></thead><tbody>${list.map((r) => `<tr>
      <td class="nw"><b>${esc(r.label)}</b></td>
      <td>${esc(r.name)}${r.off ? ' <span class="small muted">(확장 꺼짐)</span>' : ''}</td>
      <td class="num nw"><b>${n(r.count)}</b> ${esc(r.unit)}</td>
      <td class="small">${r.filter && r.count ? `<button type="button" class="linkbtn" data-rfilter="${esc(r.filter)}">목록에서 보기</button> ` : ''}${r.batches && r.batches.length && r.batches.length <= 6 ? esc(r.batches.join(', ')) : ''}${r.customers ? esc(r.customers.join(', ')) + (r.unverified && r.unverified.length ? ` ${tagify('[미확인]')} ${esc(r.unverified.join(', '))} SBL 기록 없음` : '') : ''}</td></tr>`).join('')}</tbody>`, { min: 560 })}</div>`;
}
// 이벤트 흐름(운영 감시 3단계): 감사기록 최신순, 같은 순간 반복은 묶음. 새로 들어온 줄은 잠깐 연하게 표시, 문제 신호 줄만 빨간 효과.
let feedSeen = null;
function feedTime(at) { const d = dt(at); const today = dt(new Date().toISOString()).slice(0, 10); return d.slice(0, 10) === today ? d.slice(11) : d.slice(5, 16); }
function feedPanelHtml(feed, limit) {
  const list = limit ? (feed || []).slice(0, limit) : (feed || []);
  const fresh = new Set(!limit && feedSeen ? list.filter((g) => !feedSeen.has(g.id)).map((g) => g.id) : []);
  if (!limit) feedSeen = new Set(list.map((g) => g.id));
  return `<div class="panel feed-panel"><div class="panel-head"><h3>이벤트 흐름</h3><span class="end small muted">최신순, 최근 ${list.length}줄</span></div>
    ${list.length ? `<ol class="feed">${list.map((g) => `<li class="${g.alert ? 'alert' : ''}${fresh.has(g.id) ? ' fresh' : ''}">
      <span class="f-time">${esc(feedTime(g.at))}</span>
      <span class="f-body"><span class="f-kind">${esc(g.kind)}</span> <b>${esc(g.action)}</b>${g.count > 1 ? ` <span class="f-count">${g.count}건</span>` : ''}${g.caseId ? ` <button type="button" class="linkbtn f-case" data-feedcase="${esc(g.caseId)}">${esc(g.caseId)}</button>` : ''}
        <span class="f-detail">${esc(g.actor)}${g.detail ? ', ' + withCustNames(esc(g.detail)) : ''}${g.count > 1 ? ' 외' : ''}</span></span></li>`).join('')}</ol>` : '<div class="muted">아직 기록이 없습니다. 사건 접수나 이벤트 입력을 하면 여기에 쌓입니다.</div>'}
    <div class="small top-gap"><button type="button" class="linkbtn" id="feedAll">감사기록 전체 보기</button></div></div>`;
}
const WARN_EMPTY = { 열림: '처리할 경고가 없습니다.', 확인됨: '확인 처리한 경고가 없습니다.', 해결됨: '해결된 경고가 없습니다.' };
// 경고를 누르면 아래에 상세(배치 사실·출하 기록)와 해결 방법을 보여 준다. 해결되면 서버 목록에서 빠져 사라진다.
async function fillWarnDetail(w) {
  const el = $('#warnDetail'); if (!el) return;
  let d;
  try { d = await api('GET', '/api/batches/' + encodeURIComponent(w.batch_id)); } catch (e) { el.innerHTML = `<div class="errbox">상세를 불러오지 못했습니다: ${esc(e.message)}</div>`; return; }
  const j = d.judgment;
  const facts = `<div class="kv">
    <div>배치</div><div>${esc(j.batch_id)} (${prodL(j.product_id)}, 생산일 ${esc(j.production_date)})</div>
    <div>원료 로트</div><div>${j.input_lot_ids.map(lotL).join(', ')}</div>
    <div>QC 결과</div><div>${tagify(esc(j.qc_result) + ' [원본]')}</div>
    <div>생산량 / SBL 출하</div><div>${n(j.produced_qty)} EA / ${n(j.shipped_qty)} EA</div>
    <div>확정 불량</div><div>${n(j.confirmed_qty)} EA (생산 기준 ${pct(j.rateP)}, 출하 기준 ${pct(j.rateS)})</div>
    <div>현재 판정</div><div>${statusChip(j.status)}</div></div>`;
  let what = ''; let fix = '';
  if (w.kind === 'hold_shipped') {
    const days = d.sbl.map((x) => x.ship_date).sort();
    const custs = [...new Set(d.sbl.map((x) => x.customer_id))];
    what = `<p>생산 기록의 QC 결과는 '보류'인데, SBL에는 ${d.sbl.length}건이 출하된 기록이 있습니다${days.length ? ` (${esc(days[0])}부터 ${esc(days[days.length - 1])}까지, 고객 ${esc(custs.map(custText).join(', '))})` : ''}. 두 원본 사실을 겹쳐 본 결과라 원본 값은 바뀌지 않습니다. 보류 배치가 어떻게 출하됐는지는 원인조사에서 확인할 일이며, 회수 판정에는 영향을 주지 않습니다.</p>`;
    fix = `<label class="f" for="ackNote">확인 내용(감사기록에 남습니다)</label><textarea id="ackNote" rows="2" placeholder="예: 출하 통제 기록 확인을 원인조사 담당에게 요청함"></textarea>
      <div class="row top-gap"><button type="button" class="btn" id="ackBtn">확인 처리</button><span class="small muted">처리하면 이 경고가 목록에서 사라집니다.</span></div>`;
  } else if (w.kind === 'no_case') {
    what = `<p>판정이 회수 대상(생산 기준 불량률 10% 이상)인데, 이 배치를 다루는 사건이 아직 없습니다. 사건을 접수해야 품질위원회 상신과 회수 절차를 시작할 수 있습니다.</p>`;
    fix = `<div class="row"><button type="button" class="btn" id="fixCaseBtn">회수 대상 배치로 사건 접수</button><span class="small muted">같은 원료 로트의 회수 대상 배치를 한 사건으로 묶어 접수합니다. 접수하면 이 경고가 사라집니다.</span></div>`;
  } else if (w.kind === 'sens') {
    what = `<p>생산량 기준으로는 10% 미만이지만 출하량 기준으로는 10% 이상입니다. 어느 쪽을 쓸지 규칙만으로 정할 수 없어, 두 값을 모두 적어 품질위원회에 상신해야 합니다.</p>`;
    fix = `<div class="row"><button type="button" class="btn" id="fixSensBtn">사건 화면으로 이동</button><span class="small muted">이 배치가 든 사건을 상신하면 이 경고가 사라집니다.</span></div>`;
  }
  if (w.status !== '열림' && w.handled) {
    fix = `<h4>처리 이력</h4><div class="kv"><div>상태</div><div>${esc(w.status)}</div><div>처리</div><div>${esc(w.handled.how)}</div><div>처리자</div><div>${esc(w.handled.by)}</div><div>시각</div><div>${esc(dt(w.handled.at))}</div>${w.handled.note ? `<div>확인 내용</div><div>${esc(w.handled.note)}</div>` : ''}</div>${w.status === '확인됨' ? '<p class="small muted">원본 사실은 그대로라 경고 자체는 남아 있고, 담당자가 확인했다는 기록만 붙어 있습니다.</p>' : ''}`;
  }
  el.innerHTML = `${what}${facts}${w.kind === 'hold_shipped' ? `<h4>SBL 출하 기록 ${tagify('[원본]')}</h4>${tbl(`<thead><tr><th>SBL</th><th>고객</th><th>출하일</th><th class="num">수량</th></tr></thead><tbody>${d.sbl.map((x) => `<tr><td class="nw">${esc(x.shipment_id)}</td><td class="nw">${custL(x.customer_id)}</td><td class="nw">${esc(x.ship_date)}</td><td class="num">${n(x.shipped_qty)}</td></tr>`).join('')}</tbody>`, { h: 360, min: 380 })}` : ''}<div class="warn-fix">${fix}</div>`;
  const ack = $('#ackBtn');
  if (ack) ack.onclick = () => act(() => api('POST', '/api/warnings/' + w.id + '/ack', { note: $('#ackNote').value }), () => { ui.openWarn = null; return '경고 확인 처리 완료'; });
  const fc = $('#fixCaseBtn');
  if (fc) fc.onclick = () => $('#newCaseBtn').click();
  const fs = $('#fixSensBtn');
  if (fs) fs.onclick = () => { const c = ui.summary.cases.find((x) => x.batchIds.includes(w.batch_id)); if (c) ui.caseId = c.id; document.querySelector('[data-tab="cases"]').click(); };
}
async function renderDashboard() {
  const s = ui.summary; const J = s.judgments;
  // 판정 칸을 누르면 그 판정으로 목록을 거른다. 기본 목록에 없는 판정(정상 등)도 보이도록 거를 때는 전체에서 고른다.
  const data = (ui.showAll || ui.jFilter) ? await api('GET', '/api/batches?all=1') : J;
  const rows = ui.jFilter ? data.list.filter((j) => j.status === ui.jFilter) : data.list;
  const c = J.counts;
  const allWarns = s.warnings.slice().sort((a, b) => (WARN_ORDER[a.kind] ?? 9) - (WARN_ORDER[b.kind] ?? 9));
  const warnCount = (t) => allWarns.filter((w) => w.status === t).length;
  const warns = allWarns.filter((w) => w.status === ui.warnTab);
  if (ui.openWarn && !warns.some((w) => w.id === ui.openWarn)) ui.openWarn = null;
  main.innerHTML = `
  <h2>배치 판정 현황 ${RUN.real}</h2><p class="lede">규칙 엔진이 회수 기준(확정 불량률 10%)으로 계산합니다. 불량률은 생산량 기준이 기본이고, 출하량 기준은 참고로 함께 보여 줍니다.</p>
  <div class="kpis">
    ${KPI.map(([k, cls, major]) => `<button type="button" class="kpi ${cls}${major ? '' : ' minor'}${major && c[k] ? ' on' : ''}${ui.jFilter === k ? ' picked' : ''}" data-kfilter="${esc(k)}" aria-pressed="${ui.jFilter === k}" title="누르면 배치 목록을 '${esc(k)}'(으)로 거릅니다"><span class="k">${esc(k)}</span><span class="v">${n(c[k] || 0)}</span></button>`).join('')}
  </div>
  <div class="kpi-note small muted">전체 ${n(J.total)}개 배치 기준</div>
  <div class="live-grid">
  <div class="panel">
    <div class="panel-head"><h3>경고</h3><div class="end seg" role="group" aria-label="경고 상태">${WARN_TABS.map((t) => `<button type="button" class="segbtn${t === '열림' && warnCount(t) ? ' hot' : ''}" data-wtab="${t}" aria-pressed="${ui.warnTab === t}">${t} ${warnCount(t)}</button>`).join('')}</div></div>
    ${warns.length ? `<ul class="warnlist">${warns.map((w) => { const open = ui.openWarn === w.id; return `<li><button type="button" class="warn-item" data-warn="${esc(w.id)}" aria-expanded="${open}"${open ? ' aria-controls="warnDetail"' : ''}><span class="wi-text">${tagify(w.text)}${w.handled ? `<span class="wi-meta">${esc(w.handled.how)}, ${esc(w.handled.by)}, ${esc(dt(w.handled.at))}</span>` : ''}</span><span class="wi-more">${open ? '닫기' : '자세히'}</span></button>${open ? '<div class="warn-detail" id="warnDetail" role="region" aria-label="경고 상세">불러오는 중…</div>' : ''}</li>`; }).join('')}</ul>` : `<div class="muted warn-empty">${WARN_EMPTY[ui.warnTab]}</div>`}
    <div class="small muted top-gap">확장(a) 로트 추적: ${pchip(s.settings.extensionOn ? 'ON' : 'OFF', s.settings.extensionOn ? 'p-done sm' : 'p-wait sm')} 끄면 예방 점검 상태와 그 작업이 생기지 않습니다.</div>
  </div>
  ${feedPanelHtml(s.feed)}
  </div>
  ${trendPanelHtml(s.trend)}
  ${rulePanelHtml(s.rules)}
  <div class="panel">
    <div class="panel-head"><h3>배치 목록</h3>
      <label class="chk" for="showAll"><input type="checkbox" id="showAll" ${ui.showAll ? 'checked' : ''}> 전체 ${n(J.total)}개 배치 보기(기본: 클레임 있는 배치 + PL-02 전체 + 예방 점검)</label>
      <span class="end"><button class="btn" id="newCaseBtn">회수 대상 배치로 사건 접수</button></span></div>
    ${ui.jFilter ? `<div class="filterbar" role="status">판정 '${esc(ui.jFilter)}' 배치 ${n(rows.length)}개만 보는 중 <button type="button" class="btn sm alt" id="clearFilter">거르기 해제</button></div>` : ''}
    ${tbl(`<thead><tr><th>배치</th><th>제품</th><th>생산일</th><th>로트</th><th>QC 결과[원본]</th><th class="num">생산량</th><th class="num">SBL 출하</th><th class="num">확정 불량</th><th class="num">생산 기준</th><th class="num">출하 기준</th><th class="num">미확정</th><th>판정</th><th class="wtext">근거</th></tr></thead>
      <tbody>${rows.map((j) => `<tr class="${j.status === '회수 대상' ? 'bar-recall' : j.status === '예방 점검' ? 'bar-prev' : ''}">
        <td class="nw"><button type="button" class="linkbtn" data-batch="${esc(j.batch_id)}">${esc(j.batch_id)}</button></td><td class="nw">${prodL(j.product_id)}</td><td class="nw">${esc(j.production_date)}</td><td class="small">${j.input_lot_ids.map(lotL).join('<br>')}</td>
        <td class="nw">${esc(j.qc_result)}${j.warn_hold_shipped ? ' <span class="chip p-attn sm">보류인데 출하됨</span>' : ''}</td>
        <td class="num">${n(j.produced_qty)}</td><td class="num">${n(j.shipped_qty)}</td><td class="num">${n(j.confirmed_qty)}</td>
        <td class="num"><b>${pct(j.rateP)}</b></td><td class="num">${pct(j.rateS)}</td><td class="num">${j.open_count}</td>
        <td class="nw">${statusChip(j.status)}${j.status !== j.base_status ? `<div class="small muted">기본 판정: ${esc(j.base_status)}</div>` : ''}</td>
        <td class="small">${tagify(j.reason)}${j.status === '예방 점검' ? `<div>미출하 잔여 ${n(j.unshipped_qty)} EA ${tagify('[도출]')} · 재판정 기준 ${n(j.trigger_qty)} EA</div>` : ''}</td></tr>`).join('')}</tbody>`, { min: 1100, sticky: true, h: 560 })}
  </div>
  <div id="batchDetail"></div>`;
  $('#showAll').onchange = (e) => { ui.showAll = e.target.checked; render(); };
  bindTrend(s.trend);
  const goList = () => { const h = [...main.querySelectorAll('.panel-head h3')].find((x) => x.textContent === '배치 목록'); if (h) h.scrollIntoView({ block: 'start' }); };
  main.querySelectorAll('[data-kfilter]').forEach((b) => { b.onclick = () => { ui.jFilter = ui.jFilter === b.dataset.kfilter ? null : b.dataset.kfilter; render().then(() => { if (ui.jFilter) goList(); }); }; });
  main.querySelectorAll('[data-rfilter]').forEach((b) => { b.onclick = () => { ui.jFilter = b.dataset.rfilter; render().then(goList); }; });
  const cf = $('#clearFilter'); if (cf) cf.onclick = () => { ui.jFilter = null; render(); };
  main.querySelectorAll('[data-feedcase]').forEach((b) => { b.onclick = () => { ui.caseId = b.dataset.feedcase; document.querySelector('[data-tab="cases"]').click(); }; });
  const fa = $('#feedAll'); if (fa) fa.onclick = () => document.querySelector('[data-tab="audit"]').click();
  main.querySelectorAll('[data-wtab]').forEach((b) => { b.onclick = () => { ui.warnTab = b.dataset.wtab; ui.openWarn = null; render(); }; });
  main.querySelectorAll('[data-warn]').forEach((b) => { b.onclick = () => { ui.openWarn = ui.openWarn === b.dataset.warn ? null : b.dataset.warn; render().then(() => { const x = main.querySelector(`[data-warn="${ui.openWarn}"]`); if (x) x.focus(); }); }; });
  if (ui.openWarn) { const w = warns.find((x) => x.id === ui.openWarn); if (w) fillWarnDetail(w); }
  $('#newCaseBtn').onclick = () => {
    const ids = J.list.filter((j) => j.base_status === '회수 대상' || j.base_status === '분모 민감').map((j) => j.batch_id);
    if (!ids.length) return toast('회수 대상·분모 민감 배치가 없습니다', true);
    act(() => api('POST', '/api/cases', { batch_ids: ids, title: ids.join(', ') + ' 클레임 누적' }), (r) => { ui.caseId = r.id; ui.tab = 'cases'; return r.id + ' 접수'; });
  };
  main.querySelectorAll('[data-batch]').forEach((a) => { a.onclick = async (e) => { e.preventDefault(); await showBatch(a.dataset.batch); }; });
}

async function showBatch(id) {
  const d = await api('GET', '/api/batches/' + id);
  $('#batchDetail').innerHTML = `<div class="panel"><div class="panel-head"><h3>${esc(id)} 상세</h3>${statusChip(d.judgment.status)}</div>
  <div class="grid g2"><div><h4>${tagify('클레임 [원본 + 정정 오버레이]')}</h4>${tbl(`<thead><tr><th>ID</th><th>일자</th><th>고객</th><th class="num">수량</th><th>불량 확정</th><th>상태</th><th>정정</th></tr></thead><tbody>
  ${d.claims.map((c) => `<tr><td class="nw">${esc(c.claim_id)}</td><td class="nw">${esc(c.claim_date)}</td><td class="nw">${custL(c.customer_id)}</td><td class="num">${n(c.qty_affected)}</td><td class="nw">${c.defect_confirmed ? '확정' : '미확정'}</td><td>${esc(c.status)}</td><td class="small">${c._override ? '<span class="tag ev-mock">[모의] ' + esc(c._override.reason) + '</span>' : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">없음</td></tr>'}
  </tbody>`, { h: 400, min: 560 })}</div>
  <div><h4>${tagify('품질 출하(SBL) [원본]')}</h4>${tbl(`<thead><tr><th>SBL</th><th>고객</th><th>출하일</th><th class="num">수량</th></tr></thead><tbody>
  ${d.sbl.map((x) => `<tr><td class="nw">${esc(x.shipment_id)}</td><td class="nw">${custL(x.customer_id)}</td><td class="nw">${esc(x.ship_date)}</td><td class="num">${n(x.shipped_qty)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">SBL 없음</td></tr>'}
  </tbody>`, { h: 400, min: 380 })}</div></div></div>`;
  $('#batchDetail').scrollIntoView({ behavior: 'auto', block: 'start' });
}

// ---------------- 사건 ----------------
async function renderCases() {
  const list = ui.summary.cases;
  // 초기화·시나리오 시작으로 사건이 사라졌으면 선택을 다시 정한다(없는 사건 조회 오류 방지)
  if (ui.caseId && !list.some((c) => c.id === ui.caseId)) ui.caseId = null;
  if (!ui.caseId && list.length) ui.caseId = list[list.length - 1].id;
  main.innerHTML = `<h2>사건(Case)</h2><div class="casegrid"><div class="caselist">
    ${list.map((c) => `<button type="button" class="casecard" data-case="${esc(c.id)}" aria-current="${c.id === ui.caseId ? 'true' : 'false'}"><span class="cid">${esc(c.id)}</span><span class="ct">${esc(c.title)}</span>${statusChip(c.status)}</button>`).join('') || '<div class="muted">사건 없음 — 대시보드 또는 이벤트 입력·시나리오에서 접수</div>'}
    <div class="panel newcase small"><b>새 사건 접수</b><label class="f" for="ncBatches">배치 ID(쉼표)</label><input id="ncBatches" value="B-02-2602-01, B-02-2603-01"><div class="row top-gap"><button class="btn sm alt" id="ncBtn">접수</button></div></div>
  </div><div id="caseBody"></div></div>`;
  main.querySelectorAll('[data-case]').forEach((b) => { b.onclick = () => { ui.caseId = b.dataset.case; render(); }; });
  $('#ncBtn').onclick = () => act(() => api('POST', '/api/cases', { batch_ids: $('#ncBatches').value.split(',').map((x) => x.trim()).filter(Boolean) }), (r) => { ui.caseId = r.id; return r.id + ' 접수'; });
  if (!ui.caseId) return;
  const c = await api('GET', '/api/cases/' + ui.caseId);
  $('#caseBody').innerHTML = caseHtml(c);
  bindCase(c);
}

// 상태 스텝퍼(설계안 상태 순서 8칸). 4번째 칸은 실제 위원회 결과(의결/보류/거절)를 이름으로 표시.
const FLOW = ['접수', '판정 완료', '위원회 상신', '회수 의결/보류/거절', '재공급 계획 상신', '재공급 승인', '복구 진행', '정상화 완료'];
function stepperHtml(c) {
  let st = c.status; const rv = st === '재검증 필요';
  if (rv) st = c.prevStatus || '판정 완료';
  let idx; let label4 = FLOW[3]; let attn = rv;
  if (st === '보류(추가자료)' || st === '거절(조사 계속)') { idx = 3; label4 = st; attn = true; } else if (st === '회수 의결') { idx = 3; } else idx = FLOW.indexOf(st);
  if (idx < 0) idx = 0;
  if (idx > 3 && label4 === FLOW[3]) label4 = '회수 의결';
  const fin = c.status === '정상화 완료';
  return `<ol class="stepper" aria-label="상태 흐름">${FLOW.map((name, i) => {
    const nm = i === 3 ? (idx >= 3 ? label4 : name) : name;
    const cur = i === idx;
    let cls = i < idx ? 'done' : cur ? 'cur' : 'wait';
    if (cur && attn) cls += ' attn'; if (cur && fin) cls += ' fin'; if (cur && i > 0) cls += ' reached';
    const dot = i < idx || (cur && fin) ? '✓' : cur && attn ? '!' : String(i + 1);
    const mark = cur ? `<span class="st-mark">현재</span>${rv ? statusChip('재검증 필요', 'sm') : ''}` : '';
    return `<li class="${cls}"${cur ? ' aria-current="step"' : ''}><span class="st-dot" aria-hidden="true">${dot}</span>${i < idx ? '<span class="sr-only">완료</span>' : ''}<span class="st-name">${esc(nm)}</span>${mark}</li>`;
  }).join('')}</ol>`;
}

// 처리 흐름 4칸(판정 → 근거 → 승인 → 작업) — 기존 사건 데이터만 사용
function flowHtml(c) {
  const judged = c.status !== '접수';
  const none = '<span class="none">아직 없음</span>';
  const cell = (no, title, tag, body, href) => `<div class="flow-cell"><div class="fh"><span class="fno" aria-hidden="true">${no}</span><b>${title}</b>${tag}</div><div class="fbody">${body}</div><a class="see" href="#${href}">보기 <span class="sr-only">${title}</span>↓</a></div>`;
  const c1 = judged ? c.current.map((j) => `<div class="line"><span class="nw">${esc(j.batch_id)}</span>${statusChip(j.base_status)}${j.status !== j.base_status ? ' → ' + statusChip(j.status) : ''}</div>`).join('') : none;
  const unl = c.sensitivity.filter((s) => s.unlinked.length);
  const custs = [...new Set(unl.flatMap((s) => s.unlinked.map((u) => u.customer_id)))];
  const irWait = c.infoRequests.filter((r) => r.status !== '회신 완료').length;
  const c2 = judged ? `${c.current.map((j) => `<div class="line"><span class="nw">${esc(j.batch_id)}</span><span class="big-num">${pct(j.rateP)}</span><span class="muted">/ ${pct(j.rateS)}</span></div>`).join('')}
    <div class="line muted">생산 기준 / 출하 기준</div>
    <div class="line">${tagify('[미확인]')} ${unl.length}개 배치${custs.length ? ' (' + esc(custs.join(', ')) + ')' : ''} · 확인요청 대기 ${irWait}건</div>` : none;
  const lastSub = c.submissions[c.submissions.length - 1];
  const appr = c.plan && c.plan.approvals ? Object.keys(c.plan.approvals) : [];
  const c3 = `<div class="line">위원회 ${lastSub ? statusChip(lastSub.status) + ` <span class="muted">${esc(lastSub.id)}</span>` : none}</div>
    <div class="line">재공급 ${c.plan ? statusChip(c.plan.status) + (appr.length ? ` <span class="muted">${esc(appr.join('·'))} 승인</span>` : '') : '-'}</div>`;
  const ts = c.tasks;
  const cnt = (k, v) => ts.filter((t) => t[k] === v).length;
  const c4 = ts.length ? `<div class="line"><span class="big-num">${ts.length}</span>건</div>
    <div class="line">${['대기', '진행', '완료', '재검증 필요', '취소'].map((s) => `${s} ${cnt('status', s)}`).join(' · ')}</div>
    <div class="line muted">회수 ${cnt('track', '회수')} · 예방 점검 ${cnt('track', '예방 점검')} · 원인조사 ${cnt('track', '원인조사')}</div>` : none;
  return `<div class="panel" id="sec-flow"><div class="panel-head"><h3>처리 흐름</h3></div><div class="flow4">
    ${cell(1, '판정', RUN.real, c1, 'sec-judge')}${cell(2, '근거', RUN.real, c2, 'sec-judge')}${cell(3, '승인', RUN.mock, c3, 'sec-reply')}${cell(4, '작업', RUN.real, c4, 'sec-tasks')}</div></div>`;
}

const AFTER_SUBMIT = ['접수', '위원회 상신', '회수 의결', '재공급 계획 상신', '재공급 승인', '복구 진행', '정상화 완료'];
function caseHtml(c) {
  const lastSub = c.submissions[c.submissions.length - 1];
  const pendingSub = c.submissions.find((s) => s.status === '회신 대기');
  const lastReplyDraft = c.aiDrafts.filter((d) => d.kind === '회신 해석').slice(-1)[0];
  const ts = c.tasks;
  const track = (name) => ts.filter((t) => t.track === name);
  // 다음 할 동작 1개만 주 버튼(화면 표시 규칙 — 서버 동작 불변)
  const hasSubDraft = c.aiDrafts.some((d) => d.kind === '상신 준비');
  const primary = c.status === '접수' ? 'judge' : c.status === '판정 완료' && !hasSubDraft ? 'aisub' : c.submittable.length && !AFTER_SUBMIT.includes(c.status) ? 'submit' : '';
  const bcls = (a) => 'btn' + (primary === a ? '' : ' alt');
  const submitOff = !c.submittable.length || c.status === '접수';
  const stCount = ['대기', '진행', '완료', '재검증 필요', '취소'].map((s) => [s, ts.filter((t) => t.status === s).length]).filter((x) => x[1]);
  const okN = c.normalization.filter((x) => x.ok).length;
  return `
  <div class="panel" id="sec-head"><div class="panel-head"><h3>${esc(c.id)} <span class="h-sub">${esc(c.title)}</span></h3> ${statusChip(c.status)}${c.prevStatus ? `<span class="small muted">이전: ${esc(c.prevStatus)}</span>` : ''}</div>
    <div class="case-meta">배치 ${esc(c.batchIds.join(', '))} · 의결 배치 ${esc(c.approvedBatchIds.join(', ') || '-')}</div>
    ${stepperHtml(c)}
    <div class="actions">
      <span class="btn-tag"><button class="${bcls('judge')}" data-a="judge">① 규칙 판정</button>${RUN.real}</span>
      <span class="btn-tag"><button class="${bcls('aisub')}" data-a="aisub">② 모의 AI 상신 준비</button>${RUN.ai}</span>
      <span class="btn-tag"><button class="${bcls('submit')}" data-a="submit" ${submitOff ? 'disabled' : ''}${c.status === '접수' ? ' title="① 규칙 판정 후 상신할 수 있습니다"' : ''}>③ 품질위원회 ${c.submissions.length ? '재' : ''}상신</button>${RUN.real}</span>
      <button class="btn alt push" data-a="close">정상화 완료 처리</button>
    </div>
  </div>
  ${flowHtml(c)}
  <div class="panel" id="sec-judge"><div class="panel-head"><h3>근거·판정</h3>${RUN.real}${tagify('[도출] 규칙 엔진')}</div>
    ${tbl(`<thead><tr><th>배치</th><th class="num">확정 불량</th><th class="num">생산량</th><th class="num">SBL 출하</th><th class="num">생산 기준</th><th class="num">출하 기준</th><th>판정</th><th>${tagify('C-105 등 SBL 없는 클레임 민감도 [미확인]')}</th></tr></thead><tbody>
    ${c.current.map((j) => { const s = c.sensitivity.find((x) => x.batch_id === j.batch_id); return `<tr><td class="nw">${esc(j.batch_id)}</td><td class="num">${n(j.confirmed_qty)}</td><td class="num">${n(j.produced_qty)}</td><td class="num">${n(j.shipped_qty)}</td><td class="num"><b class="${j.rateP >= 0.1 ? 'rate-hi' : ''}">${pct(j.rateP)}</b></td><td class="num">${pct(j.rateS)}</td><td class="nw">${statusChip(j.base_status)}${j.status !== j.base_status ? ' → ' + statusChip(j.status) : ''}</td>
      <td class="small">${s && s.unlinked.length ? esc(s.unlinked.map((u) => `${custText(u.customer_id)} ${u.count}건 ${n(u.qty)} EA`).join(', ')) + ` → 제외 시 <b>${pct(s.rateP_without)}</b> / 포함 ${pct(s.rateP_with)}` : '-'}</td></tr>`; }).join('')}
    </tbody>`, { min: 900, sticky: true })}
    <h4>회수 범위(안) = SBL 출하처 ∪ 확정 클레임 고객</h4>
    ${tbl(`<thead><tr><th>고객</th><th class="num">SBL 출하(상한)</th><th class="num">확정 클레임</th><th class="wtext">근거</th></tr></thead><tbody>
    ${c.scope.map((r) => `<tr><td>${esc(r.customer_id)} ${esc(r.customer_name)}</td><td class="num">${n(r.shipped_qty)}</td><td class="num">${n(r.claim_qty)}</td><td class="small">${tagify(r.source)}</td></tr>`).join('')}
    </tbody>`, { min: 560 })}
    ${c.preventive.length ? `<h4>예방 점검 대상(확장 a) — 회수 아님</h4>${tbl(`<thead><tr><th>배치</th><th class="num">미출하 잔여(출하 보류 검토)</th><th class="num">재판정 기준</th><th>보유분 확인 요청 고객</th></tr></thead><tbody>
      ${c.preventive.map((p) => `<tr class="bar-prev"><td class="nw">${esc(p.batch_id)}</td><td class="num">${n(p.unshipped_qty)} EA ${tagify('[도출]')}</td><td class="num">${n(p.trigger_qty)} EA</td><td class="small">${esc(Object.entries(p.customers).map(([k, v]) => k + ' ' + n(v)).join(', '))}</td></tr>`).join('')}</tbody>`, { min: 640 })}` : ''}
    <div class="small muted top-gap">${tagify('금액 영향: SBL↔SH 정확 일치 0건 → [가정], 손실 확정 금지. 원인은 별도 트랙에서 조사 중이며 판정에 쓰지 않음.')}</div>
  </div>
  <div class="panel ai-panel" id="sec-ai"><div class="panel-head"><h3>AI 초안</h3><span class="ailabel">판정·상태를 바꾸지 않음</span></div>
    ${c.aiDrafts.length ? c.aiDrafts.slice().reverse().map((d) => `<details ${d === c.aiDrafts[c.aiDrafts.length - 1] ? 'open' : ''}><summary>${esc(d.id)} ${esc(d.kind)} ${modeTag(d.mode)} ${d.violations && d.violations.length ? pchip('금지 표현 ' + d.violations.length, 'p-attn sm') : ''} <span class="small muted">${dt(d.at)}</span></summary>
      ${d.reason ? '<div class="small muted">(' + esc(d.reason) + ')</div>' : ''}
      ${d.violations && d.violations.length ? `<div class="errbox">${d.violations.map((v) => esc(v.label + ': ' + v.match)).join('<br>')}</div>` : ''}
      ${draftBody(d)}</details>`).join('') : '<div class="muted">아직 없습니다. 위의 ② 모의 AI 상신 준비 버튼을 누르세요.</div>'}
  </div>
  <div class="panel mockpanel" id="sec-reply"><div class="panel-head"><h3>상신·위원회 회신</h3><span class="tag run-mock">[모의] 회신 입력</span></div>
    ${c.submissions.length ? `<ul class="subhist">${c.submissions.map((s) => `<li>${esc(s.id)} v${s.version} <span class="muted">${dt(s.at)}</span> — ${esc(s.items.map((i) => `${i.batch_id} ${i.status} ${pct(i.rateP)}/${pct(i.rateS)}`).join('; '))} → ${statusChip(s.status)}</li>`).join('')}</ul>` : '<div class="muted small">상신 없음</div>'}
    ${pendingSub ? `<label class="f" for="replyText">위원회 회신 문장(자유 입력)</label><textarea id="replyText" class="mockin" placeholder="예: 추가자료 요구: C-105 클레임 7건(6,445 EA)의 배치 귀속 확인 후 재상신 바람">${esc(lastReplyDraft ? lastReplyDraft.input : '')}</textarea>
      <div class="row top-gap"><button class="btn alt" data-a="interpret">모의 AI 회신 해석(분류 제안)</button></div>
      ${lastReplyDraft ? `<div class="ai-suggest">AI 제안: <b>${esc(lastReplyDraft.output.classification)}</b> ${modeTag(lastReplyDraft.mode)} 요구 자료: ${esc((lastReplyDraft.output.requested_items || []).join(' / ') || '-')}</div>` : ''}
      <div class="small muted">AI 제안은 참고용이며 자동 선택되지 않습니다</div>
      <div class="grid g2 top-gap"><div><label class="f strong" for="replyClass">담당자 확정 분류</label><select id="replyClass" class="full"><option value="" selected>— 담당자가 직접 선택 —</option>${['승인', '추가자료 요구', '거절'].map((x) => `<option>${x}</option>`).join('')}</select></div>
      <div><label class="f" for="replyItems">요구 자료(쉼표)</label><input id="replyItems" class="full" placeholder="요구 자료(쉼표)" value="${esc(lastReplyDraft ? (lastReplyDraft.output.requested_items || []).join(', ') : '')}"></div></div>
      <div class="row top-gap"><button class="btn" data-a="reply">회신 확정</button></div>` : (lastSub ? '' : '')}
  </div>
  <div class="panel" id="sec-ir"><div class="panel-head"><h3>확인요청 ${c.infoRequests.length}건</h3></div>
    ${c.infoRequests.length ? tbl(`<thead><tr><th>ID</th><th>대상</th><th>질문</th><th>상태</th><th>${tagify('회신 [모의]')}</th></tr></thead><tbody>${c.infoRequests.map((r) => `<tr><td class="nw">${esc(r.id)}</td><td>${esc(r.to)}</td><td class="small">${tagify(r.question)}</td><td class="nw">${statusChip(r.status)}</td>
      <td>${r.status === '회신 완료' ? esc(r.answer) + (r.note ? '<div class="small muted">' + esc(r.note) + '</div>' : '') : `<div class="row">${r.options ? `<select id="ira-${r.id}" class="mockin" aria-label="${esc(r.id)} 회신 내용">${r.options.map((o) => `<option>${esc(o)}</option>`).join('')}</select>` : `<input id="ira-${r.id}" class="mockin" placeholder="회신 내용" aria-label="${esc(r.id)} 회신 내용">`}<input id="irn-${r.id}" class="mockin" placeholder="메모" aria-label="${esc(r.id)} 메모" style="width:120px"><button class="btn sm" data-ir="${r.id}">회신 입력</button></div>`}</td></tr>`).join('')}</tbody>`, { min: 760 }) : '<div class="muted small">없음</div>'}
  </div>
  <div class="panel" id="sec-tasks"><div class="panel-head"><h3>작업 ${ts.length}건</h3><span class="small muted">회수 ${track('회수').length} · 예방 점검 ${track('예방 점검').length} · 원인조사(별도 트랙) ${track('원인조사').length}</span>
      <span class="end">${stCount.map(([s, k]) => `<span class="chip ${PROC[s]} sm">${esc(s)} ${k}</span>`).join('')}</span></div>
    ${tbl(`<thead><tr><th>ID</th><th>트랙</th><th>부서</th><th>작업</th><th>상태</th><th>처리</th></tr></thead><tbody>
    ${ts.map((t) => `<tr class="${t.status === '재검증 필요' ? 'bar-attn' : t.status === '취소' ? 'row-cancel' : ''}"><td class="nw">${esc(t.id)}</td><td class="small">${esc(t.track)}</td><td class="small">${esc(t.dept)}</td><td>${tagify(t.title)}${t.tag ? ' ' + anyTag(t.tag) : ''}${t.note ? '<div class="small muted">' + tagify(t.note) + '</div>' : ''}
      ${t.payload && t.payload.draft ? `<details><summary class="small">초안 보기·수정</summary>${t.sent ? `<pre class="draft">${esc(t.payload.draft)}</pre><div class="small muted">발송 완료 — 수정·재발송 불가(정정은 정정 통지 작업으로)</div>` : `<textarea id="dr-${t.id}" aria-label="${esc(t.id)} 초안" style="min-height:180px">${esc(t.payload.draft)}</textarea><div class="row top-gap"><button class="btn sm alt" data-draft="${t.id}">초안 저장</button></div>`}</details>` : ''}
      ${t.payload && t.payload.recheck ? '<ul class="small">' + t.payload.recheck.map((x) => '<li>' + tagify(x) + '</li>').join('') + '</ul>' : ''}</td>
      <td class="nw">${statusChip(t.status)}${t.sent ? ' <span class="tag ev-mock">발송[모의]</span>' : ''}</td>
      <td class="small"><div class="stack">${t.payload && t.payload.source ? '<div class="muted">초안: ' + tagify(t.payload.source) + '</div>' : ''}${t.kind === '대체 공급 안내' && !t.sent && !['취소', '재검증 필요'].includes(t.status) && c.aiDrafts.some((d) => d.kind === '재공급 대안 설명') ? `<div><button class="btn sm alt" data-applyai="${t.id}">AI 초안 적용(선택)</button></div>` : ''}${t.payload && t.payload.draft && !t.sent && !['취소', '재검증 필요'].includes(t.status) ? `<div><button class="btn sm" data-send="${t.id}">발송(모의)</button></div>` : ''}
      ${!['완료', '취소', '재검증 필요'].includes(t.status) && !(t.payload && t.payload.draft) ? `<div class="row"><button class="btn sm alt" data-ts="${t.id}" data-to="진행">진행</button><button class="btn sm" data-ts="${t.id}" data-to="완료">완료</button></div>` : ''}</div></td></tr>`).join('') || '<tr><td colspan="6" class="muted">작업 없음 — 위원회 의결 후 자동 생성</td></tr>'}
    </tbody>`, { min: 960, sticky: true })}
  </div>
  <div class="panel" id="sec-norm"><div class="panel-head"><h3>정상화 체크리스트 N1~N9</h3><span class="small muted">— 기록 근거로 자동 판정</span><span class="end">${pchip(`충족 ${okN}/${c.normalization.length}`, okN === c.normalization.length ? 'p-done' : 'p-wait')}</span></div>
    <ul class="normlist">${c.normalization.map((x) => `<li><span class="nid">${esc(x.id)}</span><span class="nlab">${esc(x.label)} ${x.ok ? (x.risk ? '<span class="chip p-attn sm"><span aria-hidden="true">!&nbsp;</span>충족(위험 표시)</span>' : '<span class="chip p-done sm"><span aria-hidden="true">✓&nbsp;</span>충족</span>') : '<span class="chip p-wait sm"><span aria-hidden="true">○&nbsp;</span>미충족</span>'}</span><span class="nev">${tagify(x.evidence)}</span></li>`).join('')}</ul>
  </div>
  <div class="panel" id="sec-tl"><h3>타임라인(감사기록)</h3><ol class="timeline">
    ${c.timeline.slice().reverse().map((a) => { const k = a.actor === '모의 AI' ? 'ai' : /\[모의\]/.test(a.actor) ? 'mock' : ''; return `<li class="${k}"><span class="tl-time">${dt(a.at)}</span><span class="tl-rail" aria-hidden="true"><span class="tl-dot"></span></span><div class="tl-body"><span class="actor ${k}">${esc(a.actor)}</span> <b>${esc(a.action)}</b><div>${tagify(a.detail)}</div></div></li>`; }).join('')}</ol></div>`;
}

function draftBody(d) {
  const o = d.output || {};
  if (d.kind === '상신 준비') return `<div class="small"><b>근거 요약</b> ${tagify(o.summary)}</div><div class="small"><b>위험</b><ul>${(o.risks || []).map((x) => '<li>' + tagify(x) + '</li>').join('')}</ul></div><div class="small"><b>미확인</b><ul>${(o.unknowns || []).map((x) => '<li>' + tagify(x) + '</li>').join('')}</ul></div><pre class="draft">${esc(o.draft)}</pre>`;
  if (d.kind === '회신 해석') return `<div class="small">입력: ${esc(d.input)}<br>제안 분류: <b>${esc(o.classification)}</b> · 요구 자료: ${esc((o.requested_items || []).join(' / '))}<br>${tagify(o.rationale)}</div>`;
  return `<div class="small">${(o.alternatives || []).map((a) => `<div><b>대안 ${esc(a.id)}</b> 장점: ${esc(a.pros.join(' / '))} · 단점: ${esc(a.cons.join(' / '))}</div>`).join('')}<b>승인자 판단 지점</b><ul>${(o.decision_points || []).map((x) => '<li>' + tagify(x) + '</li>').join('')}</ul></div><pre class="draft">${esc(o.customer_notice_draft)}</pre>`;
}

function bindCase(c) {
  const id = c.id;
  const on = (a, f) => { const b = main.querySelector(`[data-a="${a}"]`); if (b) b.onclick = f; };
  on('judge', () => act(() => api('POST', `/api/cases/${id}/judge`), '판정 완료'));
  on('aisub', () => act(() => api('POST', `/api/cases/${id}/ai/submission`), (r) => `${r.result.mode} 상신 초안 생성`));
  on('submit', () => act(() => api('POST', `/api/cases/${id}/submit`), '품질위원회 상신'));
  on('close', () => act(() => api('POST', `/api/cases/${id}/close`), '정상화 완료'));
  on('interpret', () => act(() => api('POST', `/api/cases/${id}/reply/interpret`, { text: $('#replyText').value }), (r) => 'AI 제안: ' + r.result.output.classification));
  on('reply', () => { if (!$('#replyClass').value) return toast('담당자가 분류를 직접 선택해야 합니다', true); act(() => api('POST', `/api/cases/${id}/reply`, { classification: $('#replyClass').value, text: $('#replyText').value, requested_items: $('#replyItems').value.split(',').map((x) => x.trim()).filter(Boolean) }), '회신 확정 — 후속 처리 반영'); });
  main.querySelectorAll('[data-ir]').forEach((b) => { b.onclick = () => act(() => api('POST', `/api/info-requests/${b.dataset.ir}/answer`, { answer: $('#ira-' + b.dataset.ir).value, note: $('#irn-' + b.dataset.ir).value }), '확인요청 회신 반영'); });
  main.querySelectorAll('[data-applyai]').forEach((b) => { b.onclick = () => act(() => api('POST', `/api/tasks/${b.dataset.applyai}/apply-ai`, {}), 'AI 초안 적용 — 발송 전 금지 표현 재점검'); });
  main.querySelectorAll('[data-send]').forEach((b) => { b.onclick = () => act(() => api('POST', `/api/tasks/${b.dataset.send}/send`), '발송(모의) 완료'); });
  main.querySelectorAll('[data-draft]').forEach((b) => { b.onclick = () => act(() => api('POST', `/api/tasks/${b.dataset.draft}/draft`, { text: $('#dr-' + b.dataset.draft).value }), '초안 저장'); });
  main.querySelectorAll('[data-ts]').forEach((b) => { b.onclick = () => act(() => api('POST', `/api/tasks/${b.dataset.ts}/status`, { status: b.dataset.to }), '작업 ' + b.dataset.to); });
}

// ---------------- 이벤트 입력 ----------------
function renderEvents() {
  const s = ui.summary;
  const caseOpts = s.cases.map((c) => `<option value="${esc(c.id)}">${esc(c.id)} ${esc(c.status)}</option>`).join('');
  const mockTag = '<span class="tag run-mock">[모의]</span>';
  main.innerHTML = `<h2>이벤트 입력</h2><p class="lede">입력하면 규칙 엔진이 바로 다시 판정하고, 관련 사건과 작업, 재공급 계획의 상태를 고칩니다.</p>
  <div class="grid g3">
    <div class="panel mockpanel"><div class="panel-head"><h3>클레임 판정 정정</h3>${mockTag}</div><label class="f" for="corrIds">클레임 ID(쉼표) → 규격이탈 아님(False)</label><input id="corrIds" class="full" value="QC-00006, QC-00011, QC-00015"><label class="f" for="corrReason">사유</label><input id="corrReason" class="full" value="재검사 결과 규격 내"><div class="row top-gap"><button class="btn" id="corrBtn">정정 입력</button></div></div>
    <div class="panel mockpanel"><div class="panel-head"><h3>클레임 확정</h3>${mockTag}</div><label class="f" for="confId">클레임 ID</label><input id="confId" value="QC-00142"><div class="row top-gap"><button class="btn" id="confBtn">확정 입력</button></div><div class="small muted top-gap">미확정 클레임이 모두 확정돼도 새로 기준을 넘는 배치 없음(최대 0.019%)</div></div>
    <div class="panel"><div class="panel-head"><h3>언론 보도</h3><span class="tag ev-src">[원본] ext_news_quality_incident</span></div><input id="newsTitle" class="full" aria-label="보도 제목" value="일부 소비자 트러블 사례 보도(미확정, 제품·배치 미지목)"><div class="row top-gap"><button class="btn" id="newsBtn">보도 입력</button></div><div class="small muted top-gap">기록만 하고 판정은 바꾸지 않음</div></div>
    <div class="panel"><div class="panel-head"><h3>위원회 회신</h3></div><div class="row"><select id="crCase" aria-label="사건">${caseOpts}</select><select id="crClass" aria-label="회신 분류"><option>승인</option><option>추가자료 요구</option><option>거절</option></select></div><textarea id="crText" class="top-gap" aria-label="회신 문장">회수 승인</textarea><div class="row top-gap"><button class="btn" id="crBtn">회신 확정</button></div><div class="small muted top-gap">자유 문장 해석(AI)은 사건 화면에서</div></div>
    <div class="panel mockpanel"><div class="panel-head"><h3>고객 보유 수량 회신(N3)</h3>${mockTag}</div><div class="row"><select id="hrCust" aria-label="고객">${['C-101', 'C-102', 'C-103', 'C-104', 'C-105', 'C-108'].map((x) => `<option>${x}</option>`).join('')}</select><input id="hrQty" type="number" aria-label="보유 수량" value="20000"><button class="btn" id="hrBtn">회신 입력</button></div><div class="small muted top-gap">${tagify('입력 시 대체 필요 수량이 SBL 상한[가정] 대신 이 값으로 재계산')}</div></div>
    <div class="panel mockpanel"><div class="panel-head"><h3>조달 회신</h3>${mockTag}</div><label class="f" for="prDate">원료(M-B) 확보일</label><input id="prDate" type="date" value="2026-07-20"><label class="f" for="prKg">가용량 kg</label><input id="prKg" type="number" value="15000"><label class="f" for="prLot">로트</label><input id="prLot" class="full" value="LOT-B-2607-1(모의)"><div class="row top-gap"><button class="btn" id="prBtn">회신 입력</button></div><div class="small muted top-gap">회신 전 재공급 계획은 "확인 대기"(일정 확정 불가)</div></div>
  </div>
  <div class="panel"><h3>이벤트 기록 (발생일·적용 시각 분리)</h3>${tbl(`<thead><tr><th>ID</th><th>유형</th><th>발생일(기준)</th><th>적용 시각</th><th>입력</th><th>처리 결과</th></tr></thead><tbody>
  ${s.events.slice().reverse().map((e) => `<tr><td class="nw">${esc(e.id)}</td><td>${esc(EVENT_NAME[e.type] || e.type)} ${anyTag(e.tag)}</td><td class="nw">${esc(e.occurred_on)}</td><td class="small nw">${dt(e.applied_at)}</td><td class="small">${tagify(eventText(e))}</td><td class="small">${tagify(e.effect)}</td></tr>`).join('')}</tbody>`, { h: 400, min: 900 })}</div>`;
  const ev = (body, msg) => act(() => api('POST', '/api/events', body), (r) => msg + ' — ' + (r.effect || ''));
  $('#corrBtn').onclick = () => ev({ type: 'claim_correction', claim_ids: $('#corrIds').value.split(',').map((x) => x.trim()).filter(Boolean), reason: $('#corrReason').value }, '정정 반영');
  $('#confBtn').onclick = () => ev({ type: 'claim_confirm', claim_id: $('#confId').value.trim() }, '확정 반영');
  $('#newsBtn').onclick = () => ev({ type: 'news', title: $('#newsTitle').value }, '보도 기록');
  $('#hrBtn').onclick = () => ev({ type: 'holding_reply', customer_id: $('#hrCust').value, qty: Number($('#hrQty').value) }, '보유 수량 반영');
  $('#prBtn').onclick = () => ev({ type: 'procurement_reply', available_date: $('#prDate').value, available_kg: $('#prKg').value, lot_id: $('#prLot').value }, '조달 회신 반영');
  $('#crBtn').onclick = () => { const id = $('#crCase').value; if (!id) return toast('사건 없음', true); act(() => api('POST', `/api/cases/${id}/reply`, { classification: $('#crClass').value, text: $('#crText').value }), '회신 확정'); };
}

function eventText(e) {
  const i = e.input || {};
  switch (e.type) {
    case 'claim_correction': return '정정 클레임: ' + (i.claim_ids || []).join(', ') + (i.reason ? ' — 사유: ' + i.reason : '');
    case 'claim_confirm': return '확정 클레임: ' + [i.claim_id].concat(i.claim_ids || []).filter(Boolean).join(', ');
    case 'news': return '보도: ' + (i.title || '');
    case 'holding_reply': return custText(i.customer_id) + ' 보유 수량 ' + n(i.qty) + ' EA';
    case 'procurement_reply': return '원료 확보일 ' + i.available_date + (i.available_kg != null && i.available_kg !== '' ? ' · 가용 ' + n(i.available_kg) + ' kg' : '') + (i.lot_id ? ' · ' + i.lot_id : '');
    case 'committee_reply': return (i.case_id || '') + ' 회신: ' + (i.classification || '') + (i.text ? ' — ' + i.text : '');
    case 'info_reply': return (i.ir_id || '') + ' 회신: ' + (i.answer || '') + (i.note ? ' — ' + i.note : '');
    case 'claim_intake': return '사건 접수: ' + (i.batch_ids || []).join(', ');
    default: return '';
  }
}
const EVENT_NAME = { claim_correction: '클레임 판정 정정', claim_confirm: '클레임 확정', news: '언론 보도', holding_reply: '고객 보유 수량 회신', procurement_reply: '조달 회신', committee_reply: '위원회 회신', info_reply: '확인요청 회신', claim_intake: '사건 접수' };

// ---------------- 재공급 계획 ----------------
const PRESETS = [[14800, '14,800(기본)'], [58484, '58,484'], [4874, '4,874']];
async function renderPlan() {
  const cases = ui.summary.cases.filter((c) => c.approvedBatchIds.length || c.plan);
  if (!cases.length) { main.innerHTML = '<h2>재공급 계획</h2><div class="panel"><p class="muted">아직 계산할 사건이 없습니다. 재공급 계획은 품질위원회가 회수를 의결한 사건에서만 계산할 수 있습니다.</p><p>처음이라면 <b>시연 시나리오 ①</b>을 실행해 보세요 — 사건 접수부터 의결·재공급 계산까지 순서대로 진행됩니다.</p><button type="button" class="btn" id="goScenarios">시연 시나리오로 이동</button></div>'; $('#goScenarios').onclick = () => document.querySelector('[data-tab="scenarios"]').click(); return; }
  if (!ui.planCase || !cases.find((c) => c.id === ui.planCase)) ui.planCase = cases[cases.length - 1].id;
  const c = await api('GET', '/api/cases/' + ui.planCase);
  const p = c.plan; const r = p && p.result; const a = (p && p.assumptions) || ui.plan;
  const explain = p && p.explain ? c.aiDrafts.find((d) => d.id === p.explain) : null;
  const spare = a.monthly_spare_ea != null ? a.monthly_spare_ea : 14800;
  const asmTag = tagify('[가정]');
  main.innerHTML = `<h2>재공급 계획</h2><p class="lede">${tagify('회수가 다른 부서에 주는 영향(생산 L-02 캐파, 영업 납품 약속)을 계산합니다. 계산은 실제로 하고, 입력값은 [가정]과 [모의]입니다.')}</p>
  <div class="panel"><div class="row"><label for="planCase"><b>사건</b></label><select id="planCase">${cases.map((x) => `<option value="${esc(x.id)}" ${x.id === ui.planCase ? 'selected' : ''}>${esc(x.id)} ${esc(x.status)}</option>`).join('')}</select>
    ${p ? `<span>계획 v${p.version || 1}</span> ${statusChip(p.status)} ${p.selected ? '<span>선택 대안 <b>' + esc(p.selected) + '</b></span>' : ''}${p.exception_reason ? ' <span>· 한도 초과 예외 사유: ' + esc(p.exception_reason) + '</span>' : ''}` : '<span class="muted">계획 없음</span>'}${c.approval_active ? '' : ' <span class="chip p-attn">의결 효력 없음 — 계산·상신 불가</span>'}</div>${(c.planHistory || []).length ? `<details class="small top-gap"><summary>이전 버전</summary><div class="muted">이전 버전: ${esc(c.planHistory.map((h) => `v${h.version} ${h.status} 대안 ${h.selected || '-'} 승인 ${Object.keys(h.approvals || {}).join('+') || '-'}`).join(' · '))}</div></details>` : ''}
  <div class="grid g4 top-gap">
    <div><label class="f" for="aSpare">월 가용 여유 EA ${asmTag}</label><input id="aSpare" class="asm full" type="number" value="${esc(spare)}"><div class="row preset-row">${PRESETS.map(([v, t]) => `<button class="btn sm alt" data-spare="${v}" aria-pressed="${Number(spare) === v}">${t}</button>`).join('')}</div></div>
    <div><label class="f" for="aReq">품질 재승인 소요일 ${asmTag}</label><input id="aReq" class="asm full" type="number" value="${esc(a.requal_days != null ? a.requal_days : 14)}"></div>
    <div><label class="f" for="aLim">대체 완료 한도(주, A·B·C 공통) ${asmTag}</label><input id="aLim" class="asm full" type="number" value="${esc(a.limit_weeks != null ? a.limit_weeks : 12)}"></div>
    <div><span class="f" aria-hidden="true">&nbsp;</span><div class="row"><button class="btn" id="calcBtn" ${c.approval_active ? '' : 'disabled title="유효한 회수 의결이 없음"'}>대안 계산</button><button class="btn alt" id="explainBtn" ${p ? '' : 'disabled'}>모의 AI 대안 설명</button></div></div>
  </div>
  <div class="small muted top-gap">${tagify('원본 캐파: L-02 capacity_qty 1,949,480 · 가동률 97% [원본] — 기간 단위 불일치(미확인). 기본 14,800 = 실생산 역산 여유 3% [가정], 대안값 58,484(월 단위 해석) / 4,874(연 단위 해석).')}</div></div>
  ${r ? planResultHtml(c, p, r, explain) : ''}`;
  $('#planCase').onchange = (e) => { ui.planCase = e.target.value; render(); };
  const syncPreset = () => main.querySelectorAll('[data-spare]').forEach((x) => x.setAttribute('aria-pressed', String(Number($('#aSpare').value) === Number(x.dataset.spare))));
  main.querySelectorAll('[data-spare]').forEach((b) => { b.onclick = () => { $('#aSpare').value = b.dataset.spare; syncPreset(); }; });
  $('#aSpare').oninput = syncPreset;
  $('#calcBtn').onclick = () => act(() => api('POST', `/api/cases/${c.id}/plan/compute`, { assumptions: { monthly_spare_ea: Number($('#aSpare').value), requal_days: Number($('#aReq').value), limit_weeks: Number($('#aLim').value) } }), (x) => '계산: ' + x.result.status);
  $('#explainBtn').onclick = () => act(() => api('POST', `/api/cases/${c.id}/plan/explain`), (x) => x.result.mode + ' 설명 생성');
  main.querySelectorAll('[data-psub]').forEach((b) => { b.onclick = () => { const ex = $('#exc-' + b.dataset.psub); act(() => api('POST', `/api/cases/${c.id}/plan/submit`, { alternative: b.dataset.psub, exception_reason: ex ? ex.value : undefined }), '재공급 계획 상신'); }; });
  main.querySelectorAll('[data-pappr]').forEach((b) => { b.onclick = () => act(() => api('POST', `/api/cases/${c.id}/plan/approve`, { approver: b.dataset.pappr, decision: b.dataset.dec }), b.dataset.pappr + ' ' + b.dataset.dec); });
}

const feasChip = (a) => (a._legacy && a.feasible ? '<span class="chip p-attn">재계산 필요</span>' : !a.feasible ? '<span class="chip j-recall">실행 불가</span>' : a.over_limit ? '<span class="chip p-attn">한도 초과(예외 필요)</span>' : '<span class="chip p-done">한도 내</span>');
const INPUT_LABEL = { monthly_normal: 'L-02 월 정상 생산', monthly_spare: '월 가용 여유', capacity_raw: 'L-02 원본 캐파', material_date: '원료 확보일', requal_days: '품질 재승인 소요일', limit_weeks: '대체 완료 한도(주)' };
// 이전 버전 상태 파일에 저장된 계산 결과는 일부 필드가 없다 — 빈 값으로 채우고 재계산을 안내한다
const LEGACY_ALT_FIELDS = ['per_customer', 'affected_qty', 'avg_delay_days', 'max_delay_days', 'delay_ea_days', 'over_limit'];
function normalizePlanResult(r) {
  const legacy = (r.alternatives || []).some((a) => LEGACY_ALT_FIELDS.some((k) => a[k] === undefined));
  const alternatives = (r.alternatives || []).map((a) => ({
    ...a,
    per_customer: a.per_customer || [], delayed_orders: a.delayed_orders || [], delayed_by_customer: a.delayed_by_customer || [],
    approvals_required: a.approvals_required || [], affected_qty: a.affected_qty != null ? a.affected_qty : a.delayed_qty,
    avg_delay_days: a.avg_delay_days != null ? a.avg_delay_days : '-', max_delay_days: a.max_delay_days != null ? a.max_delay_days : '-',
    delay_ea_days: a.delay_ea_days != null ? a.delay_ea_days : null, over_limit: !!a.over_limit,
    _legacy: LEGACY_ALT_FIELDS.some((k) => a[k] === undefined),
  }));
  return {
    legacy,
    r: { ...r, alternatives, demand: r.demand || [], inputs_tags: r.inputs_tags || {},
      existing_orders: r.existing_orders || {}, masil: r.masil || {}, rfp: r.rfp || {} },
  };
}
function planResultHtml(c, p, rawR, explain) {
  const { legacy, r } = normalizePlanResult(rawR);
  const lim = (p.assumptions && p.assumptions.limit_weeks) != null ? p.assumptions.limit_weeks : (r.inputs_tags.limit_weeks || {}).value;
  const canSubmit = p.status === '계산 완료' && c.approval_active && !legacy;
  const card = (a) => `<div class="alt-card${p.selected === a.id ? ' sel' : ''}${a.feasible ? '' : ' nogo'}">
    <div class="ah"><b>대안 ${esc(a.id)}</b><span>${esc(a.name)}</span>${p.selected === a.id ? pchip('선택됨', 'p-active sm') : ''}</div>
    <div>${feasChip(a)}</div>
    <div class="metric"><span class="lab">모든 회수 고객 대체 완료</span><span class="big-num">${a.weeks_to_complete != null ? a.weeks_to_complete + '주' : '미완료'}</span><span class="small">${esc(a.replacement_done || '미완료')}${a.over_limit && lim != null ? ` (한도 ${lim}주)` : ''}</span></div>
    <div class="metric"><span class="lab">영향받는 기존 주문</span><span class="big-num">${n(a.delayed_orders.length)}건</span><span class="small muted">${n(a.affected_qty)} EA</span></div>
    <div class="metric"><span class="lab">지연일 평균/최대</span><span class="big-num">${a.avg_delay_days} / ${a.max_delay_days}일</span></div>
    <div class="small"><span class="muted">필요 승인 ${tagify('[가정]')}</span> ${esc(a.approvals_required.join(' + '))}</div>
    <div class="small muted">${tagify(a.feasibility_note)}</div>
    ${canSubmit && a.feasible ? `<div class="foot-act">${a.over_limit ? `<input id="exc-${a.id}" placeholder="한도 초과 예외 사유(필수)" aria-label="대안 ${esc(a.id)} 한도 초과 예외 사유(필수)">` : ''}<button class="btn${a.over_limit ? ' alt' : ''}" data-psub="${a.id}">이 대안 상신</button></div>` : ''}
  </div>`;
  return `
  ${legacy ? `<div class="warnbox big"><b>이전 버전에서 계산된 결과입니다.</b> 일부 항목(고객별 완료일·지연일 등)이 없어 상신할 수 없습니다. ${c.approval_active ? "위의 '대안 계산'을 다시 눌러 최신 기준으로 다시 계산해 주세요." : "상단 '초기화' 후 시나리오를 다시 실행해 주세요."}</div>` : ''}
  ${r.status === '확인 대기' ? '<div class="warnbox big"><b>조달 회신 전 — 일정은 잠정이며 상신할 수 없습니다(확인 대기).</b> 이벤트 입력 → 조달 회신.</div>' : ''}
  ${r.material_warning ? `<div class="warnbox">${tagify(r.material_warning)}</div>` : ''}
  <div class="alt-cards" aria-label="대안 요약">${r.alternatives.map(card).join('')}</div>
  <div class="panel"><div class="panel-head"><h3>대안 비교</h3>${RUN.real}</div>${tbl(`<thead><tr><th>대안</th><th>모든 회수 고객 대체 완료(한도 기준)</th><th>클레임 고객 완료</th><th class="num">영향받는 기존 주문(건·전체 수량)</th><th class="num">지연일 평균/최대 · EA·일</th><th>영향 고객(수량/최대 지연일)</th><th class="wtext">Masil 영향</th><th class="wtext">C-201 메모</th><th>필요 승인 ${tagify('[가정]')}</th><th>실행</th></tr></thead><tbody>
    ${r.alternatives.map((a) => `<tr><td style="min-width:150px"><b>${esc(a.id)}</b> ${esc(a.name)}</td><td><span class="nw">${esc(a.replacement_done) || '<b>미완료</b>'}${a.weeks_to_complete != null ? ' (' + a.weeks_to_complete + '주)' : ''}</span>${a.over_limit ? ' <span class="chip p-attn sm">한도 초과</span>' : ''}<div class="small muted">${esc(a.per_customer.map((x) => x.customer_id + ' ' + (x.replacement_done || '미완료')).join(' · '))}</div></td><td class="nw">${esc(a.claim_customers_done || '-')}</td><td class="num">${n(a.delayed_orders.length)}건<br>${n(a.affected_qty)} EA</td><td class="num">${a.avg_delay_days} / ${a.max_delay_days}일<br>${n(a.delay_ea_days)}</td>
      <td class="small nw">${a.delayed_by_customer.slice(0, 8).map((d) => `${custL(d.customer_id)} ${n(d.qty)}/${d.max_delay_days}일`).join('<br>') || '-'}</td><td class="small">${tagify(a.masil_impact)}</td><td class="small">${tagify(a.c201_memo)}</td>
      <td class="small">${esc(a.approvals_required.join(' + '))}</td><td>${feasChip(a)}<div class="small">${tagify(a.feasibility_note)}</div></td></tr>`).join('')}
  </tbody>`, { min: 1280, sticky: true })}
  <details class="top-gap"><summary class="small">지연되는 기존 주문 목록(선택 또는 대안 A)</summary>${(() => { const alt = r.alternatives.find((x) => x.id === (p.selected || 'A')) || r.alternatives[0] || { delayed_orders: [] }; return tbl(`<thead><tr><th>주문</th><th>고객</th><th class="num">수량</th><th class="num">지연일</th><th>기준 완료</th><th>대안 완료</th></tr></thead><tbody>${alt.delayed_orders.map((d) => `<tr><td class="nw">${esc(d.id)}</td><td class="nw">${esc(d.customer_id)}</td><td class="num">${n(d.qty)}</td><td class="num">${d.delay_days}</td><td class="nw">${esc(d.baseline_done)}</td><td class="nw">${esc(d.alt_done)}</td></tr>`).join('')}</tbody>`, { h: 400, min: 560 }); })()}</details>
  <div class="small muted top-gap">모의 계산 가정: 영업일(월~금) 생산, 기존 주문은 예상 납기 순(EDF), 기준일 이후 신규 주문은 알 수 없어 기존 능력이 계속 채워진다고 가정. 지연일 = 대안 완료일 − 현 계획(재공급 없음) 완료일.</div></div>
  <div class="grid g2">
    <div class="panel"><h3>대체 필요 수량 ${n(r.replacement_total)} EA</h3>${tbl(`<thead><tr><th>고객</th><th class="num">수량</th><th class="wtext">근거</th></tr></thead><tbody>
      ${r.demand.map((d) => `<tr class="${d.included ? '' : 'row-cancel'}"><td>${esc(d.customer_id)} ${esc(d.customer_name)}${d.claim_customer ? ' <span class="tag">클레임</span>' : ''}</td><td class="num">${d.included ? n(d.qty) : '<span class="chip p-cancel sm">제외</span>'}</td><td class="small">${tagify(d.basis)}</td></tr>`).join('')}
    </tbody>`, { min: 420 })}<div class="small muted top-gap">${tagify(`M-B 필요량 약 ${n(r.mb_required_kg)} kg [추정 0.042 kg/EA]`)}</div></div>
    <div class="panel"><h3>입력·가정</h3><div class="kv">${Object.entries(r.inputs_tags).filter(([, x]) => !Array.isArray(x)).map(([k, x]) => `<div>${esc(INPUT_LABEL[k] || k)}</div><div>${esc(typeof x.value === 'number' ? n(x.value) : x.value)} <span class="small">${tagify(x.tag)}</span></div>`).join('')}
      <div>기존 미출하 주문</div><div>${n(r.existing_orders.count)}건 / ${n(r.existing_orders.qty)} EA <span class="small">${tagify(r.existing_orders.tag)}</span></div>
      <div>Masil 더마 발주</div><div>${n(r.masil.total_qty)} EA <span class="small">${tagify(r.masil.tag)}</span></div>
      <div>C-201 RFP</div><div class="small">${n(r.rfp.derma_annual_qty)} EA/년 · ${tagify(r.rfp.line_constraint)} · ${tagify(r.rfp.recall_cost)} · ${tagify(r.rfp.authority)}</div></div></div>
  </div>
  ${p.status === '상신' ? `<div class="panel mockpanel"><div class="panel-head"><h3>승인</h3><span class="tag run-mock">[모의] 영업 임원·생산 책임자</span></div><div>대안 <b>${esc(p.selected)}</b> · 필요 승인: ${esc(p.required.join(' + '))}</div><div class="top-gap">${p.required.map((x) => `<div class="appr-row"><span class="who">${esc(x)}</span>${p.approvals[x] ? pchip(x + ' 승인', 'p-done') : `<button class="btn" data-pappr="${esc(x)}" data-dec="승인">${esc(x)} 승인</button><button class="btn warn" data-pappr="${esc(x)}" data-dec="반려">${esc(x)} 반려</button>`}</div>`).join('')}</div></div>` : ''}
  ${explain ? `<div class="panel ai-panel"><div class="panel-head"><h3>AI 대안 설명·고객 통지 초안</h3>${modeTag(explain.mode)} <span class="ailabel">AI 초안</span></div>${explain.violations.length ? `<div class="errbox">${explain.violations.map((v) => esc(v.label + ': ' + v.match)).join('<br>')}</div>` : ''}${draftBody(explain)}</div>` : ''}`;
}

// ---------------- 확장 비교 ----------------
async function renderExt() {
  main.innerHTML = '<h2>확장(a) ON/OFF 비교</h2><div class="infobox">같은 입력으로 두 상태를 실제 실행 중…</div>';
  const d = await api('GET', '/api/extension/compare');
  const offMap = Object.fromEntries(d.off.lot_batches.map((b) => [b.batch_id, b.status]));
  const onMap = Object.fromEntries(d.on.lot_batches.map((b) => [b.batch_id, b.status]));
  const differs = (id) => onMap[id] !== offMap[id];
  const prevN = (x) => x.lot_batches.filter((b) => b.status === '예방 점검').length;
  const sign = (k) => (k >= 0 ? '+' + k : String(k));
  const cells = [
    ['생성 작업', d.on.task_count, d.off.task_count],
    ['예방 점검 배치', prevN(d.on), prevN(d.off)],
    ['확인요청', d.on.info_requests.length, d.off.info_requests.length],
    ['회수 통지', d.on.recall_notice_count, d.off.recall_notice_count, true],
  ];
  const side = (x) => `<div class="panel"><div class="panel-head"><h3>확장 ${x.extensionOn ? 'ON' : 'OFF'}</h3>${x.extensionOn ? pchip('ON', 'p-done') : pchip('OFF', 'p-wait')}</div>
    ${tbl(`<thead><tr><th>LOT-B-2602-P(특허 활성성분) 사용 배치</th><th>상태</th><th class="num">미출하 잔여</th><th class="num">재판정 기준</th><th><span class="sr-only">차이</span></th></tr></thead><tbody>${x.lot_batches.map((b) => `<tr class="${differs(b.batch_id) ? 'diffrow' : ''}"><td class="nw">${esc(b.batch_id)}</td><td class="nw">${statusChip(b.status)}</td><td class="num">${n(b.unshipped_qty)}</td><td class="num">${n(b.trigger_qty)}</td><td class="nw">${differs(b.batch_id) ? pchip('차이', 'p-attn sm') : ''}</td></tr>`).join('')}</tbody>`, { min: 520 })}
    <div class="top-gap">회수 의결 후 생성 작업 <b class="big-num">${x.task_count}</b>건 · 회수 통지 ${x.recall_notice_count}건 · 확인요청 ${x.info_requests.length}건</div>
    <details class="top-gap"><summary class="small">작업 목록</summary><ul class="small">${x.tasks.map((t) => `<li>[${esc(t.track)}] ${tagify(t.title)}</li>`).join('')}</ul></details></div>`;
  main.innerHTML = `<h2>확장(a) ON/OFF 비교 ${RUN.real}</h2><p class="lede">${tagify('현재 판정을 복사해 확장 ON 상태와 OFF 상태를 따로 만들고, 사건 접수부터 회수 승인[모의]까지 두 번 실제로 실행해 비교합니다.')}</p>
  <div class="cmp-kpi" aria-label="비교 지표">${cells.map(([lab, on, off, notice]) => `<div class="cmp-cell"><div class="lab">${lab}</div><div class="nums"><span class="side">ON</span><span class="on">${on}</span><span class="sep" aria-hidden="true">|</span><span class="side">OFF</span><span class="off">${off}</span></div>${notice && d.diff.recall_notice_same ? '<div class="delta same">동일 ✓ 과잉 회수 없음</div>' : `<div class="delta">차이 ${sign(on - off)}</div>`}</div>`).join('')}</div>
  <div class="okbox top-gap">${tagify(d.diff.note)} · ON에서만 생기는 작업 ${d.diff.tasks_only_on.length}건 · 예방 점검 배치 ${esc(d.diff.preventive_only_on.join(', ') || '없음')} · 회수 통지 수 동일: ${d.diff.recall_notice_same ? '예' : '아니오'}</div>
  <div class="grid g2">${side(d.on)}${side(d.off)}</div>
  <div class="panel"><h3>ON에서만 생성된 작업·확인요청</h3><ul class="plain onlylist">${d.diff.tasks_only_on.map((t) => `<li><span aria-hidden="true"><b>+</b> </span>${tagify(t.title)} <span class="chip p-wait sm">${esc(t.dept)}</span></li>`).join('')}${d.diff.info_requests_only_on.map((r) => `<li><span aria-hidden="true"><b>+</b> </span>[확인요청] ${tagify(r.question)}</li>`).join('')}</ul>
  <div class="small muted top-gap">현재 화면 설정: 확장 ${ui.summary.settings.extensionOn ? 'ON' : 'OFF'} (상단 토글로 실제 운영 상태 변경)</div></div>`;
}

// ---------------- 시나리오 ----------------
function stepRunTags(title) {
  const ai = /모의 AI/.test(title);
  const mock = /\[모의\]|\(모의\)/.test(title);
  return (ai ? RUN.ai : '') + (mock ? RUN.mock : '') + (!ai && !mock ? RUN.real : '');
}
const checksTbl = (checks) => `<div class="checks">${tbl(`<thead><tr><th>항목</th><th>기대</th><th>실제</th><th>결과</th></tr></thead><tbody>${checks.map((c) => `<tr class="${c.ok ? '' : 'bad'}"><td>${esc(c.label)}</td><td>${esc(c.expected)}</td><td>${esc(c.actual)}</td><td class="nw"><span class="${c.ok ? 'check-ok' : 'check-no'}">${c.ok ? '✓ 일치' : '✗ 불일치'}</span></td></tr>`).join('')}</tbody>`, { min: 520 })}</div>`;
async function renderScenarios() {
  const list = await api('GET', '/api/scenarios');
  if (!ui.scenario || !list.find((x) => String(x.id) === String(ui.scenario))) {
    const pick = list.find((x) => x.cursor != null && x.cursor < x.steps.length) || list.find((x) => x.cursor != null) || list[0];
    ui.scenario = pick && pick.id;
  }
  const prog = (sc) => (sc.cursor == null ? '시작 전' : `진행 ${sc.results.length}/${sc.steps.length} 단계`);
  const sel = list.find((x) => String(x.id) === String(ui.scenario));
  const card = (sc) => { const isSel = sc === sel; const ended = sc.cursor == null || sc.cursor >= sc.steps.length; const ratio = sc.steps.length ? Math.round((sc.results.length / sc.steps.length) * 100) : 0;
    return `<div class="sc-card${isSel ? ' sel' : ''}"><button type="button" class="sc-pick" data-pick="${sc.id}" aria-current="${isSel ? 'true' : 'false'}">${esc(sc.title)}</button>
    <div class="progress"><span>${prog(sc)}</span><div class="pbar${ratio === 100 ? ' full' : ''}" aria-hidden="true"><span style="width:${ratio}%"></span></div></div>
    <div class="row"><button class="btn alt" data-start="${sc.id}">시작(초기화)</button><button class="btn" data-step="${sc.id}" ${ended ? 'disabled' : ''}>다음 단계 실행</button><button class="btn alt" data-runall="${sc.id}" ${ended ? 'disabled' : ''}>끝까지</button></div></div>`; };
  const detail = (sc) => `<div class="panel"><div class="panel-head"><h3>${esc(sc.title)}</h3><span class="end small muted"><b>${prog(sc)}</b></span></div>
    <ol class="vsteps">${sc.steps.map((st, i) => { const r = sc.results.find((x) => x.index === i); const state = r ? 'done' : sc.cursor === i ? 'next' : 'wait';
      return `<li class="${state}"${state === 'next' ? ' aria-current="step"' : ''}><span class="st-dot" aria-hidden="true">${r ? '✓' : i + 1}</span><div>${r ? '<span class="sr-only">완료</span>' : ''}
        <div class="sh"><span class="stitle">${tagify(st.title)}${state === 'next' ? ' <span class="st-mark">다음</span>' : ''}</span><span class="stags">${stepRunTags(st.title)}</span></div>
        <div class="sin">입력: ${tagify(st.input)}</div>
        ${r ? `<div class="ssum">${tagify(r.summary)}</div>${checksTbl(r.checks)}` : ''}</div></li>`; }).join('')}</ol></div>`;
  main.innerHTML = `<h2>시연 시나리오</h2><p class="lede">각 단계는 실제 API로 처리됩니다. '시작'을 누르면 상태가 처음으로 돌아갑니다.</p>
  <div class="sc-cards">${list.map(card).join('')}</div>
  ${sel ? detail(sel) : ''}`;
  main.querySelectorAll('[data-pick]').forEach((b) => { b.onclick = () => { ui.scenario = b.dataset.pick; render(); }; });
  main.querySelectorAll('[data-start]').forEach((b) => { b.onclick = async () => { if (!(await askConfirm('시나리오를 시작할까요?', '시작하면 지금까지의 운영 기록이 모두 지워지고 처음 상태로 돌아갑니다. 이 화면을 보는 모든 사람에게 적용됩니다.', '시작(초기화)'))) return; ui.scenario = b.dataset.start; act(() => api('POST', `/api/scenarios/${b.dataset.start}/start`), '시나리오 시작(초기화)'); }; });
  main.querySelectorAll('[data-step]').forEach((b) => { b.onclick = () => { ui.scenario = b.dataset.step; act(() => api('POST', `/api/scenarios/${b.dataset.step}/step`), (r) => r.title + '\n' + r.summary); }; });
  main.querySelectorAll('[data-runall]').forEach((b) => { b.onclick = async () => {
    if (busy) return;
    const sc = list.find((x) => String(x.id) === b.dataset.runall);
    ui.scenario = sc.id; setBusy(true);
    main.querySelectorAll('[data-step],[data-runall],[data-start]').forEach((x) => { x.disabled = true; });
    const total = sc.steps.length - sc.cursor; let k = 0; let failed = false;
    try {
      for (let i = sc.cursor; i < sc.steps.length; i += 1) {
        toast(`끝까지 실행 중… ${k + 1}/${total}`);
        try { await api('POST', `/api/scenarios/${sc.id}/step`); k += 1; } catch (e) { toast(e.message, true); failed = true; break; }
      }
      if (!failed) toast(`끝까지 실행했습니다(${k}단계)`);
    } finally { setBusy(false); }
    await refresh();
  }; });
}

// ---------------- 감사기록 · 출처 ----------------
async function renderAudit() {
  const a = await api('GET', '/api/audit');
  const actor = (x) => { const k = x === '모의 AI' ? 'ai' : /\[모의\]/.test(x) ? 'mock' : ''; return `<span class="actor ${k}">${esc(x)}</span>`; };
  main.innerHTML = `<h2>감사기록 ${a.length}건</h2><div class="panel">${tbl(`<thead><tr><th>시각</th><th>사건</th><th>주체</th><th>행위</th><th class="wtext">내용</th></tr></thead><tbody>
  ${a.slice().reverse().map((x) => `<tr><td class="small nw">${dt(x.at)}</td><td class="nw">${esc(x.caseId || '')}</td><td class="small">${actor(x.actor)}</td><td>${esc(x.action)}</td><td class="small">${tagify(x.detail)}</td></tr>`).join('')}</tbody>`, { h: 720, min: 960 })}</div>`;
}
async function renderSources() {
  const d = await api('GET', '/api/sources');
  const kindCls = (k) => (/모의 AI/.test(k) ? 'run-ai' : /모의/.test(k) ? 'run-mock' : /실제/.test(k) ? 'run-real' : 'ev-der');
  main.innerHTML = `<h2>데이터 출처와 구현 구분</h2>
  <div class="panel"><h3>실제 작동 / 모의 처리 / 설계 단계</h3>
    <div class="legend" aria-label="표시 범례">${['[원본]', '[도출]', '[가정]', '[모의]', '[미확인]'].map(tagify).join('')} ${RUN.real}${RUN.mock}${RUN.ai}</div>
    ${tbl(`<thead><tr><th>영역</th><th>구분</th><th class="wtext">설명</th></tr></thead><tbody>${d.implementation.map((x) => `<tr><td>${esc(x.area)}</td><td><span class="tag ${kindCls(x.kind)}">${esc(x.kind)}</span></td><td class="small">${tagify(x.note)}</td></tr>`).join('')}</tbody>`, { min: 640 })}</div>
  <div class="panel"><h3>도출·가정 값</h3>${tbl(`<tbody>${d.derived.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.value)}</td><td class="small">${tagify(x.tag)}</td></tr>`).join('')}</tbody>`, { min: 560 })}</div>
  <div class="panel"><h3>원본 복사본 (data/source, 내용 무수정)</h3>${tbl(`<thead><tr><th>경로(04_원본데이터 기준)</th><th class="num">행</th><th class="num">바이트</th><th>SHA-256(앞 16자)</th><th>태그</th></tr></thead><tbody>${d.files.map((f) => `<tr><td>${esc(f.path)}</td><td class="num">${n(f.rows)}</td><td class="num">${n(f.bytes)}</td><td class="small nw">${esc(f.sha256)}</td><td class="small">${tagify(f.tag)}</td></tr>`).join('')}</tbody>`, { min: 900 })}</div>`;
}

// ---------------- 공통 ----------------
const tabBtns = [...document.querySelectorAll('#tabs button')];
// 탭을 바꿀 때마다 서버의 최신 상태를 받아 그린다(공유 환경에서 다른 사용자가 초기화·진행해도 옛 정보로 그리지 않음)
const go = () => refresh().catch((e) => toast(e.message, true));
tabBtns.forEach((b) => { b.onclick = () => { ui.tab = b.dataset.tab; go(); }; });

// ---------------- 자동 갱신(운영 감시 1단계) ----------------
// 5초마다 서버 변경 번호만 묻고, 달라졌을 때만 전체 상태를 받아 다시 그린다. 외부 서비스·상시 연결 없음(비용 0원).
// 입력 중이거나 확인 상자가 열려 있으면 화면을 덮어쓰지 않고 '새 변경 있음' 안내만 띄운다.
const POLL_MS = 5000;
let polling = false;
main.addEventListener('input', () => { ui.dirty = true; });
function isEditing() {
  const el = document.activeElement;
  const typing = el && main.contains(el) && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.type !== 'checkbox';
  return Boolean(busy || $('#confirmDlg').open || typing || ui.dirty);
}
async function applyLive() { $('#liveBar').hidden = true; ui.dirty = false; await refresh(); }
async function poll() {
  if (polling || document.hidden || !ui.summary) return;
  polling = true;
  try {
    const r = await fetch('/api/rev', { cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    const { rev } = await r.json();
    setLive(true);
    if (rev !== ui.summary.rev) {
      if (isEditing()) $('#liveBar').hidden = false;
      else await applyLive();
    }
  } catch (e) { setLive(false); } finally { polling = false; }
}
$('#liveApply').onclick = () => applyLive().catch((e) => toast(e.message, true));
setInterval(poll, POLL_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
$('#tabs').addEventListener('keydown', (e) => {
  const i = tabBtns.indexOf(document.activeElement); if (i < 0) return;
  let j = null;
  if (e.key === 'ArrowRight') j = (i + 1) % tabBtns.length; else if (e.key === 'ArrowLeft') j = (i - 1 + tabBtns.length) % tabBtns.length; else if (e.key === 'Home') j = 0; else if (e.key === 'End') j = tabBtns.length - 1;
  if (j == null) return;
  e.preventDefault(); tabBtns[j].focus(); ui.tab = tabBtns[j].dataset.tab; go();
});
$('#toastClose').onclick = () => $('#toast').classList.add('hidden');
document.querySelectorAll('#foot > span').forEach((el) => { el.innerHTML = tagify(el.textContent); });
$('#extToggle').onchange = async (e) => { const want = e.target.checked; if (!(await askConfirm(want ? '확장(a)을 켤까요?' : '확장(a)을 끌까요?', '원료 로트 추적에 따라 예방 점검 상태와 작업이 바뀝니다. 이 화면을 보는 모든 사람에게 적용됩니다.', want ? '켜기' : '끄기'))) { e.target.checked = !want; return; } act(() => api('POST', '/api/settings/extension', { on: e.target.checked }), (r) => `확장(a) ${r.extensionOn ? 'ON' : 'OFF'} — 배치 상태 변경 ${r.changed.length}건${r.supplemented && r.supplemented.length ? ' · 의결 사건 작업 보충 생성 ' + r.supplemented.map((x) => x.caseId + ' ' + x.tasks + '건').join(', ') : ''}`); };
$('#resetBtn').onclick = async () => { if (await askConfirm('초기화할까요?', '모든 운영 기록이 지워지고 처음 상태로 돌아갑니다. 이 화면을 보는 모든 사람에게 적용됩니다.', '초기화')) act(() => api('POST', '/api/reset'), '초기화 완료'); };
refresh().catch((e) => toast(e.message, true));
