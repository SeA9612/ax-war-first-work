'use strict';
// 첫 화면(한눈에 보기) 요약 값. 누구나 배우지 않고 읽을 수 있는 숫자만 고르고,
// 문제가 있는 칸만 alert=true(화면에서 빨간 칸)로 표시한다. 상태를 바꾸지 않는다(읽기 전용).
const E = require('./engine');
const { getModel, BASE_DATE } = require('./data');

const MONTHS = 12;
const ym = (d) => d.slice(0, 7);
function prevMonth(m) { const [y, mo] = m.split('-').map(Number); return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`; }
const monthLabel = (m) => `${Number(m.slice(5))}월`;
// 늘었는지·줄었는지를 기호 없이 짧은 문장으로
function delta(cur, prev, unit) {
  const d = cur - prev;
  if (d === 0) return { dir: 'same', text: `지난달과 같아요` };
  return { dir: d > 0 ? 'up' : 'down', text: `지난달보다 ${Math.abs(d).toLocaleString('ko-KR')}${unit} ${d > 0 ? '늘었어요' : '줄었어요'}` };
}

function overview(state) {
  const m = getModel();
  const J = E.judge(state);
  const all = Object.values(J.judgments);
  const recall = all.filter((j) => j.status === '회수 대상').map((j) => j.batch_id).sort();
  const sens = all.filter((j) => j.status === '분모 민감').map((j) => j.batch_id).sort();
  const warnings = E.warningList(state, all);
  const wc = (s) => warnings.filter((w) => w.status === s).length;

  // 사건: 회수가 필요한 배치 중 사건이 없는 배치가 있으면 문제
  const active = state.cases.filter((c) => c.status !== '정상화 완료');
  const covered = new Set(state.cases.flatMap((c) => c.batchIds));
  const uncovered = [...recall, ...sens].filter((b) => !covered.has(b));
  // 회수 대상인데 아직 위원회 회수 결정(의결)이 없는 배치가 있으면 빨간 칸. 결정 뒤에는 처리 중이라 흰 칸.
  const decided = new Set(state.cases.filter((c) => c.status !== '정상화 완료').flatMap((c) => c.approvedBatchIds || []));
  const notDecided = recall.filter((b) => !decided.has(b));

  // 클레임: 기준일 직전 달까지 최근 12개월
  const thisMonth = prevMonth(ym(BASE_DATE));
  const months = []; for (let k = 0, x = thisMonth; k < MONTHS; k += 1, x = prevMonth(x)) months.unshift(x);
  const monthly = months.map((mo) => {
    const cl = J.claims.filter((c) => ym(c.claim_date) === mo);
    const conf = cl.filter((c) => c.defect_confirmed);
    return { month: mo, label: monthLabel(mo), claims: cl.length, confirmed: conf.length, open: cl.length - conf.length, confirmed_qty: conf.reduce((s, c) => s + c.qty_affected, 0) };
  });
  const cur = monthly[monthly.length - 1]; const prev = monthly[monthly.length - 2];

  // 제품별 클레임(최근 12개월)
  const inWindow = J.claims.filter((c) => ym(c.claim_date) >= months[0] && ym(c.claim_date) <= thisMonth);
  const products = Object.values(m.products).map((p) => {
    const cl = inWindow.filter((c) => c.product_id === p.product_id);
    const issue = all.some((j) => j.product_id === p.product_id && (j.status === '회수 대상' || j.status === '분모 민감'));
    return { product_id: p.product_id, name: p.product_name, claims: cl.length, confirmed_qty: cl.filter((c) => c.defect_confirmed).reduce((s, c) => s + c.qty_affected, 0), issue };
  }).sort((a, b) => b.claims - a.claims || a.product_id.localeCompare(b.product_id));

  // 후속 작업: 취소 제외, 완료 비율. 재검증 필요가 있으면 문제
  const tasks = state.tasks.filter((t) => t.status !== '취소');
  const done = tasks.filter((t) => t.status === '완료').length;
  const reval = tasks.filter((t) => t.status === '재검증 필요').length;

  const tiles = [
    { key: 'recall', label: '회수 대상 배치', value: recall.length, unit: '개', alert: notDecided.length > 0,
      note: !recall.length ? '회수 기준(확정 불량률 10%)을 넘은 배치가 없어요' : notDecided.length ? `${notDecided.join(', ')} 회수 결정 전` : `${recall.join(', ')} 회수 결정됨, 처리 중`,
      go: { tab: 'dashboard', filter: '회수 대상' } },
    { key: 'warn', label: '처리 안 된 경고', value: wc('열림'), unit: '건', alert: wc('열림') > 0,
      note: wc('열림') ? `확인됨 ${wc('확인됨')}건, 해결됨 ${wc('해결됨')}건` : '지금 처리할 경고가 없어요', go: { tab: 'dashboard', anchor: 'warn' } },
    { key: 'case', label: '진행 중 사건', value: active.length, unit: '건', alert: uncovered.length > 0,
      note: uncovered.length ? `${uncovered.join(', ')} 사건 접수 필요` : active.length ? active.map((c) => `${c.id} ${c.status}`).join(', ') : '진행 중인 사건이 없어요', go: { tab: 'cases' } },
    { key: 'claims', label: `${monthLabel(thisMonth)} 클레임`, value: cur.claims, unit: '건', alert: cur.claims > prev.claims,
      note: delta(cur.claims, prev.claims, '건').text, dir: delta(cur.claims, prev.claims, '건').dir, go: { anchor: 'monthly' } },
    { key: 'confirmed', label: `${monthLabel(thisMonth)} 확정 불량`, value: cur.confirmed_qty, unit: 'EA', alert: cur.confirmed_qty > prev.confirmed_qty,
      note: delta(cur.confirmed_qty, prev.confirmed_qty, ' EA').text, dir: delta(cur.confirmed_qty, prev.confirmed_qty, ' EA').dir, go: { anchor: 'monthly' } },
    { key: 'tasks', label: '후속 작업 완료', value: tasks.length ? Math.round((done / tasks.length) * 100) : null, unit: '%', alert: reval > 0,
      note: !tasks.length ? '아직 후속 작업이 없어요' : reval ? `${done}/${tasks.length}건 완료, 재검증 필요 ${reval}건` : `${done}/${tasks.length}건 완료`, go: { tab: 'cases' } },
  ];

  return {
    base_date: BASE_DATE, this_month: thisMonth,
    status: tiles.some((t) => t.alert) ? 'issue' : 'ok',
    issues: tiles.filter((t) => t.alert).length,
    tiles, monthly, products,
    totals: { batches: all.length, recall: recall.length, sens: sens.length },
  };
}

module.exports = { overview };
