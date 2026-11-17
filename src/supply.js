'use strict';
// 재공급 계획 계산 (다른 부서 영향: 생산 L-02 캐파 + 영업 납품 약속). 설계안 v1.1 §5.
// 모든 일정은 [가정] 입력에 기대는 모의 계산이며, 원본 캐파·독점 공급 제약을 지우지 않는다.
const { addDays, BASE_DATE } = require('./data');

const DEFAULT_ASSUMPTIONS = {
  monthly_spare_ea: 14800, // [가정] 실생산 역산 여유 3% (01_영향분석 §4.1)
  requal_days: 14, // [가정] 대체분 품질 재승인 소요일(달력일)
  limit_weeks: 12, // [가정] 대안 C 실행 가능 한도(주)
  provisional_material_days: 28, // [가정] 조달 회신 전 잠정 원료 확보 소요일
  mb_kg_per_ea: 0.042, // [추정] M-B 평균 원단위 (01_영향분석 §4.2)
};

function isWeekday(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z').getUTCDay();
  return d !== 0 && d !== 6; // A05: 월~금 영업일, 공휴일 없음
}
function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}

// 대체 필요 수량 = 고객별 SBL 출하량 [가정·상한]. 고객 보유 수량 회신이 있으면 그 값. C-105는 확인 회신 후에만.
function replacementDemand(scope, holdingReplies, c105Confirmed) {
  return scope.map((r) => {
    const reply = holdingReplies && holdingReplies[r.customer_id];
    let qty; let basis; let included = true;
    if (r.unverified) {
      if (c105Confirmed && c105Confirmed[r.customer_id] != null) {
        qty = c105Confirmed[r.customer_id]; basis = '[모의] 확인요청 회신 수량';
      } else {
        qty = 0; included = false; basis = '[미확인] 출하 근거 없음 — 확인 회신 전 제외';
      }
    } else if (reply != null) {
      qty = reply; basis = '[모의] 고객 보유 수량 회신';
    } else {
      qty = r.shipped_qty; basis = '[가정·상한] SBL 출하량 (고객 실제 보유량 아님)';
    }
    return {
      customer_id: r.customer_id, customer_name: r.customer_name, qty, basis, included,
      claim_customer: r.claim_qty > 0,
    };
  });
}

// 하루 단위 생산 배분 모의 (영업일만 생산)
function simulate(jobs, mode, r, s, startDate) {
  const rem = {}; const done = {};
  jobs.forEach((j) => { rem[j.id] = j.qty; });
  const edf = (list) => list.slice().sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.id < b.id ? -1 : 1));
  const existing = edf(jobs.filter((j) => j.kind !== 'rep'));
  const reps = jobs.filter((j) => j.kind === 'rep');
  const claimReps = reps.filter((j) => j.claim);
  const otherReps = reps.filter((j) => !j.claim);
  let day = startDate;
  for (let i = 0; i < 4000; i += 1) {
    const left = jobs.filter((j) => rem[j.id] > 0);
    if (left.length === 0) break;
    if (isWeekday(day)) {
      const released = (list) => list.filter((j) => rem[j.id] > 0 && j.release <= day);
      let pools;
      if (mode === 'baseline') {
        pools = [{ cap: r, list: released(existing) }];
      } else if (mode === 'A') {
        pools = [{ cap: r + s, list: [...released(reps), ...released(existing)] }];
      } else if (mode === 'B') {
        const cr = released(claimReps);
        if (cr.length > 0 || claimReps.some((j) => rem[j.id] > 0)) {
          pools = [{ cap: r + s, list: [...cr, ...released(existing)] }, { cap: 0, list: released(otherReps) }];
        } else {
          pools = [{ cap: r, list: released(existing) }, { cap: s, list: released(otherReps) }];
        }
      } else { // C: 기존 주문은 기존 능력, 대체분은 여유 능력만
        pools = [{ cap: r, list: released(existing) }, { cap: s, list: released(reps) }];
      }
      let carry = 0;
      pools.forEach((p) => {
        let cap = p.cap;
        for (const j of p.list) {
          if (cap <= 0) break;
          const take = Math.min(cap, rem[j.id]);
          rem[j.id] -= take; cap -= take;
          if (rem[j.id] <= 0 && !done[j.id]) done[j.id] = day;
        }
        carry += cap;
      });
      // 남는 능력은 기존 주문 잔고로만 넘긴다. 기존 능력(r)은 이후 신규 주문으로 계속 채워진다고 본다
      // [가정: 가동률 97% 유지, 기준일 이후 신규 주문 미반영] → 대체분은 정해진 몫 외 추가 능력을 쓰지 않음
      if (carry > 0 && mode !== 'baseline') {
        const order = [...released(existing)];
        for (const j of order) {
          if (carry <= 0) break;
          const take = Math.min(carry, rem[j.id]);
          rem[j.id] -= take; carry -= take;
          if (rem[j.id] <= 0 && !done[j.id]) done[j.id] = day;
        }
      }
    }
    day = addDays(day, 1);
  }
  return done;
}

// 입력 검증 (F4·F5): 잘못된 값은 상태를 바꾸기 전에 400으로 거절
function badInput(msg) { const e = new Error(msg); e.status = 400; return e; }
function isIsoDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
function validateAssumptions(input) {
  const a = { ...DEFAULT_ASSUMPTIONS };
  const src = input || {};
  const num = (k, label, { min, integer, allowZero }) => {
    if (src[k] === undefined || src[k] === null || src[k] === '') return;
    const v = typeof src[k] === 'number' ? src[k] : (typeof src[k] === 'string' && src[k].trim() !== '' ? Number(src[k]) : NaN);
    if (!Number.isFinite(v)) throw badInput(label + '은(는) 숫자여야 합니다: ' + src[k]);
    if (integer && !Number.isInteger(v)) throw badInput(label + '은(는) 정수여야 합니다: ' + src[k]);
    if (allowZero ? v < min : v <= min) throw badInput(label + '은(는) ' + (allowZero ? min + ' 이상이어야' : min + '보다 커야') + ' 합니다: ' + src[k]);
    a[k] = v;
  };
  num('monthly_spare_ea', '월 가용 여유(EA)', { min: 0 });
  num('requal_days', '품질 재승인 소요일', { min: 0, integer: true, allowZero: true });
  num('limit_weeks', '대체 완료 한도(주)', { min: 0 });
  num('provisional_material_days', '잠정 원료 확보 소요일', { min: 0, integer: true, allowZero: true });
  num('mb_kg_per_ea', 'M-B 원단위', { min: 0 });
  return a;
}

function computePlan(model, input) {
  const a = validateAssumptions(input.assumptions);
  const monthlyNormal = model.pl02MonthlyAvg; // [도출] 2026 H1 PL-02 월평균 생산
  const perDay = (m) => (m * 12) / 261; // 월 → 영업일 환산 [가정]
  const r = perDay(monthlyNormal);
  const s = perDay(a.monthly_spare_ea);
  const proc = input.procurementReply || null;
  if (proc && !isIsoDate(proc.available_date)) throw badInput('원료 확보일은 YYYY-MM-DD 형식이어야 합니다: ' + proc.available_date);
  const materialDate = proc ? (proc.available_date < BASE_DATE ? BASE_DATE : proc.available_date) : addDays(BASE_DATE, a.provisional_material_days);
  const status = proc ? '계산 완료' : '확인 대기';

  const demand = replacementDemand(input.scope, input.holdingReplies, input.c105Confirmed);
  const repTotal = demand.filter((d) => d.included).reduce((x, d) => x + d.qty, 0);

  const jobs = [];
  model.unshippedPl02.forEach((o) => jobs.push({
    id: o.order_id, kind: 'order', qty: o.order_qty, due: o.expected_due, release: BASE_DATE, customer_id: o.customer_id,
  }));
  model.masilPos.forEach((p) => jobs.push({
    id: p.po_id, kind: 'masil', qty: p.order_qty, due: p.due, release: BASE_DATE, customer_id: 'Masil',
  }));
  demand.filter((d) => d.included && d.qty > 0).forEach((d) => jobs.push({
    id: 'REP-' + d.customer_id, kind: 'rep', qty: d.qty, due: materialDate, release: materialDate, customer_id: d.customer_id, claim: d.claim_customer,
  }));

  const baseline = simulate(jobs, 'baseline', r, s, BASE_DATE);
  const names = { A: '대체분 전량 우선', B: '클레임 접수 고객 우선 분할', C: '여유 캐파만 사용' };
  const alternatives = ['A', 'B', 'C'].map((mode) => {
    const done = simulate(jobs, mode, r, s, BASE_DATE);
    const delayed = [];
    jobs.filter((j) => j.kind !== 'rep').forEach((j) => {
      const d = daysBetween(baseline[j.id], done[j.id]);
      if (d > 0) delayed.push({ id: j.id, kind: j.kind, customer_id: j.customer_id, qty: j.qty, delay_days: d, baseline_done: baseline[j.id], alt_done: done[j.id] });
    });
    const repJobs = jobs.filter((j) => j.kind === 'rep');
    // 고객별 대체 완료일(재승인 포함). 모의 기간 안에 끝나지 않은 대체분은 '미완료'(null)로 남긴다(F4)
    const perCustomer = repJobs.map((j) => ({
      customer_id: j.customer_id, qty: j.qty, claim_customer: !!j.claim,
      production_done: done[j.id] || null,
      replacement_done: done[j.id] ? addDays(done[j.id], a.requal_days) : null,
    }));
    const unfinished = perCustomer.filter((p) => !p.replacement_done);
    const lastDone = (list) => (list.length === 0 || list.some((p) => !p.replacement_done) ? null
      : list.reduce((m, p) => (p.replacement_done > m ? p.replacement_done : m), '0000-00-00'));
    const repDone = lastDone(perCustomer); // 한도 기준 = 모든 회수 고객의 대체 완료일
    const claimDone = lastDone(perCustomer.filter((p) => p.claim_customer));
    const weeks = repDone ? Math.ceil(daysBetween(BASE_DATE, repDone) / 7) : null;
    const byCustomer = {};
    delayed.forEach((d) => {
      const c = byCustomer[d.customer_id] || (byCustomer[d.customer_id] = { customer_id: d.customer_id, orders: 0, qty: 0, max_delay_days: 0 });
      c.orders += 1; c.qty += d.qty; c.max_delay_days = Math.max(c.max_delay_days, d.delay_days);
    });
    const masilDelayed = delayed.filter((d) => d.kind === 'masil');
    const affectedQty = delayed.reduce((x, d) => x + d.qty, 0);
    const eaDays = delayed.reduce((x, d) => x + d.qty * d.delay_days, 0);
    const overLimit = unfinished.length > 0 || (weeks != null && weeks > a.limit_weeks);
    // 대안 C는 기존 주문을 늦추지 않고 여유 능력만 쓰므로 한도 초과 = 실행 불가(설계 §5).
    // A·B도 같은 한도(모든 회수 고객 대체 완료일)를 적용 — 초과 시 '한도 초과', 상신하려면 예외 사유 + 영업 임원 승인 필수.
    const feasible = unfinished.length === 0 && !(mode === 'C' && overLimit);
    const needsSalesExec = delayed.length > 0 || overLimit; // 기존 주문 지연·한도 예외 → 영업 임원 승인 필요 [가정]
    let note;
    if (unfinished.length) note = '완료 불가: ' + unfinished.map((p) => p.customer_id).join(', ') + ' 대체분이 모의 기간(약 11년) 안에 끝나지 않음';
    else if (mode === 'C' && overLimit) note = '실행 불가: 모든 회수 고객 대체 완료까지 ' + weeks + '주 > 한도 ' + a.limit_weeks + '주 [가정]';
    else if (overLimit) note = '한도 초과: 모든 회수 고객 대체 완료까지 ' + weeks + '주 > 한도 ' + a.limit_weeks + '주 [가정] — 상신하려면 예외 사유 필수, 영업 임원 승인 필요';
    else note = (status === '확인 대기' ? '일정 잠정(조달 회신 전)' : '한도 내(가정 기준)');
    return {
      id: mode,
      name: names[mode],
      replacement_done: repDone,
      claim_customers_done: claimDone,
      per_customer: perCustomer,
      weeks_to_complete: weeks,
      over_limit: overLimit,
      delayed_orders: delayed.sort((x, y) => y.delay_days - x.delay_days || (x.id < y.id ? -1 : 1)),
      delayed_by_customer: Object.values(byCustomer).sort((x, y) => y.qty - x.qty),
      delayed_qty: affectedQty, // 영향받는 주문의 전체 수량(밀린 물량 아님)
      affected_qty: affectedQty,
      max_delay_days: delayed.length ? Math.max(...delayed.map((d) => d.delay_days)) : 0,
      avg_delay_days: delayed.length ? Math.round((delayed.reduce((x, d) => x + d.delay_days, 0) / delayed.length) * 10) / 10 : 0,
      delay_ea_days: eaDays,
      masil_impact: masilDelayed.length
        ? 'Masil 더마 발주 ' + masilDelayed.length + '건 지연(최대 ' + Math.max(...masilDelayed.map((d) => d.delay_days)) + '일) — 재고 커버 2.2~4.3주로 안전재고(4주) 미달 SKU 결품 위험 증가'
        : 'Masil 더마 발주 88,000 EA 지연 없음(이 가정 기준)',
      c201_memo: 'L-02 여유 능력[가정]이 대체분에 ' + (mode === 'C' ? (weeks == null ? '장기간' : weeks + '주') + ' 동안 전부' : '우선') + ' 쓰임 → C-201 더마 연 1,500,000 EA 소화 판단 더 불리. 입찰 판단은 CEO/이사회 권한 — 정보 통지만',
      approvals_required: needsSalesExec ? ['영업 임원', '생산 책임자'] : ['생산 책임자'],
      feasible,
      feasibility_note: note,
    };
  });

  return {
    status,
    computed_at_basis: BASE_DATE,
    assumptions: a,
    inputs_tags: {
      monthly_normal: { value: monthlyNormal, tag: '[도출] 2026 H1 PL-02 월평균 생산' },
      monthly_spare: { value: a.monthly_spare_ea, tag: '[가정] 기본 14,800 = 실생산 역산 여유 3%' },
      capacity_raw: { value: 1949480, util: 97, tag: '[원본] strat_capacity_cv L-02 — 기간 단위 불일치(미확인)' },
      spare_alternatives: [
        { value: 58484, tag: '[가정] capacity_qty를 월 단위로 볼 때 여유 3%' },
        { value: 4874, tag: '[가정] capacity_qty를 연 단위로 볼 때 월 여유 3%' },
      ],
      material_date: { value: materialDate, tag: proc ? '[모의] 조달 회신 원료 확보일' : '[가정] 조달 회신 전 잠정(기준일+' + a.provisional_material_days + '일)' },
      requal_days: { value: a.requal_days, tag: '[가정] 품질 재승인 소요일' },
      limit_weeks: { value: a.limit_weeks, tag: '[가정] 모든 회수 고객 대체 완료 한도(주)' },
    },
    procurement_reply: proc,
    demand,
    replacement_total: repTotal,
    mb_required_kg: Math.round(repTotal * a.mb_kg_per_ea),
    material_warning: proc && proc.available_kg != null && Number(proc.available_kg) < repTotal * a.mb_kg_per_ea
      ? '조달 회신 가용량 ' + proc.available_kg + 'kg < 필요량 약 ' + Math.round(repTotal * a.mb_kg_per_ea) + 'kg [추정] — 부분 생산만 가능, 조달 추가 확인 필요'
      : null,
    existing_orders: { count: model.unshippedPl02.length, qty: model.unshippedPl02.reduce((x, o) => x + o.order_qty, 0), tag: '[도출] PL-02 미출하 주문(예상 납기 = 주문일+61일 [추정])' },
    masil: { pos: model.masilPos, total_qty: model.masilPos.reduce((x, p) => x + p.order_qty, 0), tag: '[원본] Masil 발주 — Corevia SO에 없음, 별도 수요 행' },
    rfp: model.rfp,
    alternatives,
  };
}

module.exports = { computePlan, replacementDemand, DEFAULT_ASSUMPTIONS, simulate, validateAssumptions, isIsoDate };
