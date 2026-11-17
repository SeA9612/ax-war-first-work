'use strict';
// 규칙 엔진(결정적). 설계안 v1.1 §3 J1~J8 그대로 구현한다. AI 출력은 이 모듈에 들어오지 않는다.

const THRESHOLD = 0.10; // 회수 기준 10% [원본: quality_policy_cv]
const OPEN_STATUSES = new Set(['접수', '조사중', '정정(재조사)']);

const STATUS = {
  NORMAL: '정상',
  BELOW: '정상(기준 미달)',
  INVESTIGATE: '조사·소명',
  SENSITIVE: '분모 민감',
  RECALL: '회수 대상',
  PREVENTIVE: '예방 점검',
};

// 판정 정정 오버레이를 적용한 클레임 목록 (원본 복사본은 바꾸지 않음)
function effectiveClaims(model, overrides) {
  return model.claims.map((c) => {
    const o = overrides && overrides[c.claim_id];
    if (!o) return c;
    return { ...c, ...o.fields, _override: o };
  });
}

function round4(x) { return x == null ? null : Math.round(x * 1e6) / 1e6; }

// 배치 하나 판정 (J1, J2)
function judgeBatch(model, batchId, claims) {
  const b = model.batchById[batchId];
  if (!b) throw new Error('배치 없음: ' + batchId);
  const mine = claims.filter((c) => c.batch_id === batchId);
  const confirmed = mine.filter((c) => c.defect_confirmed);
  const confirmedQty = confirmed.reduce((s, c) => s + c.qty_affected, 0);
  const open = mine.filter((c) => !c.defect_confirmed && OPEN_STATUSES.has(c.status));
  const shippedQty = (model.sblByBatch[batchId] || []).reduce((s, x) => s + x.shipped_qty, 0);
  const rateP = confirmedQty / b.produced_qty; // J1 생산 기준(정책 기본 분모)
  const rateS = shippedQty > 0 ? confirmedQty / shippedQty : null; // J1 출하 기준(보조)

  let status;
  let reason;
  if (rateP >= THRESHOLD) {
    status = STATUS.RECALL; reason = '생산 기준 율 ≥ 10%';
  } else if (rateS != null && rateS >= THRESHOLD) {
    status = STATUS.SENSITIVE; reason = '생산 기준 < 10% ≤ 출하 기준 — 두 값 모두 상신';
  } else if (open.length > 0) {
    status = STATUS.INVESTIGATE; reason = '미확정 클레임 ' + open.length + '건 — 조사·소명 대상';
  } else if (confirmedQty > 0) {
    status = STATUS.BELOW; reason = '확정 건 있으나 두 기준 모두 < 10%';
  } else {
    status = STATUS.NORMAL; reason = '확정 불량 없음';
  }

  // 기준 도달까지 필요한 확정 수량 (재판정 조건) [도출] = ceil(생산량 × 10%)
  const triggerQtyP = Math.ceil(b.produced_qty * THRESHOLD);
  return {
    batch_id: batchId,
    product_id: b.product_id,
    production_date: b.production_date,
    qc_result: b.qc_result,
    input_lot_ids: b.input_lot_ids,
    produced_qty: b.produced_qty,
    shipped_qty: shippedQty,
    unshipped_qty: b.produced_qty - shippedQty, // 미출하 잔여분 [도출]
    confirmed_qty: confirmedQty,
    confirmed_count: confirmed.length,
    open_count: open.length,
    open_qty: open.reduce((s, c) => s + c.qty_affected, 0),
    claim_count: mine.length,
    rateP: round4(rateP),
    rateS: round4(rateS),
    base_status: status,
    status,
    reason,
    trigger_qty: triggerQtyP,
    // 경고: 배치 판정 보류인데 SBL 출하 기록 존재 [원본 사실의 조합]
    warn_hold_shipped: b.qc_result === '보류' && shippedQty > 0,
  };
}

// C-105 민감도: SBL 출하 기록이 없는 클레임 고객 분을 뺀 율 (J7)
function customerSensitivity(model, batchId, claims) {
  const b = model.batchById[batchId];
  const sblCustomers = new Set((model.sblByBatch[batchId] || []).map((s) => s.customer_id));
  const confirmed = claims.filter((c) => c.batch_id === batchId && c.defect_confirmed);
  const unlinked = {};
  confirmed.forEach((c) => {
    if (!sblCustomers.has(c.customer_id)) {
      const u = unlinked[c.customer_id] || (unlinked[c.customer_id] = { customer_id: c.customer_id, count: 0, qty: 0 });
      u.count += 1; u.qty += c.qty_affected;
    }
  });
  const total = confirmed.reduce((s, c) => s + c.qty_affected, 0);
  const unlinkedQty = Object.values(unlinked).reduce((s, u) => s + u.qty, 0);
  return {
    batch_id: batchId,
    unlinked: Object.values(unlinked),
    rateP_with: round4(total / b.produced_qty),
    rateP_without: round4((total - unlinkedQty) / b.produced_qty),
  };
}

// 전체 배치 판정 + (확장 a) 로트 추적 → 예방 점검
function judgeAll(model, overrides, opts) {
  const extensionOn = !(opts && opts.extensionOn === false);
  const claims = effectiveClaims(model, overrides);
  const result = {};
  model.batches.forEach((b) => { result[b.batch_id] = judgeBatch(model, b.batch_id, claims); });
  const preventive = extensionOn ? findPreventive(model, result) : [];
  preventive.forEach((p) => {
    const j = result[p.batch_id];
    j.status = STATUS.PREVENTIVE;
    j.reason = '같은 원료 로트(' + p.lots.join(', ') + ')를 쓴 회수 대상 배치(' + p.triggers.join(', ') + ') 존재, 확정 불량 기준 미달 — 회수 아님(확장 a)';
    j.preventive = p;
  });
  return { judgments: result, claims, preventive, extensionOn };
}

// 회수 대상 배치의 input_lot_ids → 같은 로트를 쓴 다른 배치 중 기준 미달 배치
function findPreventive(model, judgments) {
  const recall = Object.values(judgments).filter((j) => j.base_status === STATUS.RECALL);
  const map = {};
  recall.forEach((r) => {
    r.input_lot_ids.forEach((lot) => {
      model.batches.forEach((b) => {
        if (b.batch_id === r.batch_id || !b.input_lot_ids.includes(lot)) return;
        const j = judgments[b.batch_id];
        if (j.base_status === STATUS.RECALL || j.base_status === STATUS.SENSITIVE) return;
        const p = map[b.batch_id] || (map[b.batch_id] = { batch_id: b.batch_id, lots: [], triggers: [] });
        if (!p.lots.includes(lot)) p.lots.push(lot);
        if (!p.triggers.includes(r.batch_id)) p.triggers.push(r.batch_id);
      });
    });
  });
  return Object.values(map).map((p) => {
    const j = judgments[p.batch_id];
    const customers = {};
    (model.sblByBatch[p.batch_id] || []).forEach((s) => { customers[s.customer_id] = (customers[s.customer_id] || 0) + s.shipped_qty; });
    return {
      ...p,
      confirmed_qty: j.confirmed_qty,
      trigger_qty: j.trigger_qty, // 재판정 기준 (15,469 / 16,160 EA)
      unshipped_qty: j.unshipped_qty, // 출하 보류 검토 대상 = 미출하 잔여분 (3,213 / 10,483 EA) [도출]
      shipped_qty: j.shipped_qty,
      customers, // 보유분 확인 요청 대상 (회수 통지 아님)
    };
  });
}

// 회수 범위 고객 = SBL 출하처 ∪ 확정 클레임 고객 (J7)
function recallScope(model, batchIds, claims) {
  const rows = {};
  const get = (cid) => rows[cid] || (rows[cid] = {
    customer_id: cid,
    customer_name: model.customers[cid] ? model.customers[cid].customer_name : cid,
    shipped_qty: 0, claim_qty: 0, claim_count: 0, batches: [], shipments: [],
  });
  batchIds.forEach((bid) => {
    (model.sblByBatch[bid] || []).forEach((s) => {
      const r = get(s.customer_id);
      r.shipped_qty += s.shipped_qty;
      r.shipments.push({ shipment_id: s.shipment_id, batch_id: bid, ship_date: s.ship_date, qty: s.shipped_qty });
      if (!r.batches.includes(bid)) r.batches.push(bid);
    });
    claims.filter((c) => c.batch_id === bid && c.defect_confirmed).forEach((c) => {
      const r = get(c.customer_id);
      r.claim_qty += c.qty_affected; r.claim_count += 1;
      if (!r.batches.includes(bid)) r.batches.push(bid);
    });
  });
  return Object.values(rows).map((r) => ({
    ...r,
    source: r.shipped_qty > 0 ? '[원본] SBL 출하' : '[미확인] SBL 출하 기록 없음 — 클레임만',
    unverified: r.shipped_qty === 0,
  })).sort((a, b) => b.shipped_qty - a.shipped_qty || a.customer_id.localeCompare(b.customer_id));
}

function isSubmittable(status) {
  return status === STATUS.RECALL || status === STATUS.SENSITIVE;
}

module.exports = {
  THRESHOLD, STATUS, effectiveClaims, judgeBatch, judgeAll, findPreventive, recallScope,
  customerSensitivity, isSubmittable,
};
