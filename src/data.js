'use strict';
// 원본 복사본(data/source)을 읽어 업무모델 객체로 만든다.
// 원본 파일은 읽기만 하며, 계산 결과에는 근거 태그([원본]/[도출]/[가정]/[모의]/[미확인])를 붙인다.
const fs = require('fs');
const path = require('path');

const SOURCE_DIR = path.join(__dirname, '..', 'data', 'source');
const BASE_DATE = '2026-07-01'; // 가상기업 기준일 [원본: A05]

// 파이프(|) 구분 CSV 읽기 (A05: UTF-8, 첫 행 헤더, 파이프 구분)
function readCsv(rel) {
  const text = fs.readFileSync(path.join(SOURCE_DIR, rel), 'utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const header = lines[0].split('|');
  return lines.slice(1).map((line) => {
    const cells = line.split('|');
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i]; });
    return row;
  });
}

function readText(rel) {
  return fs.readFileSync(path.join(SOURCE_DIR, rel), 'utf8');
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function load() {
  const claims = readCsv('01_corevia/quality/qc_claims_cv.csv').map((r) => ({
    claim_id: r.claim_id,
    claim_date: r.claim_date,
    customer_id: r.customer_id,
    product_id: r.product_id,
    batch_id: r.batch_id,
    lot_id: r.lot_id,
    claim_type: r.claim_type,
    defect_confirmed: r.defect_confirmed === 'True',
    qty_affected: Number(r.qty_affected),
    status: r.status,
  }));

  const batches = readCsv('01_corevia/production/prod_batch_log_cv.csv').map((r) => ({
    batch_id: r.batch_id,
    product_id: r.product_id,
    production_line: r.production_line,
    production_date: r.production_date,
    produced_qty: Number(r.produced_qty),
    input_lot_ids: r.input_lot_ids.split(/[;,]/).map((s) => s.trim()).filter(Boolean),
    qc_result: r.qc_result,
  }));

  const sbl = readCsv('01_corevia/quality/shipment_batch_link_cv.csv').map((r) => ({
    shipment_id: r.shipment_id,
    batch_id: r.batch_id,
    customer_id: r.customer_id,
    product_id: r.product_id,
    order_date: r.order_date,
    ship_date: r.ship_date,
    shipped_qty: Number(r.shipped_qty),
  }));

  const customers = {};
  readCsv('01_corevia/master/m_customer_cv.csv').forEach((r) => {
    customers[r.customer_id] = {
      customer_id: r.customer_id,
      customer_name: r.customer_name,
      channel_type: r.channel_type,
      cost_linked_clause: r.cost_linked_clause === 'True',
      payment_terms_days: Number(r.payment_terms_days),
      revenue_share_pct: Number(r.revenue_share_pct),
    };
  });

  const products = {};
  readCsv('01_corevia/master/m_product_cv.csv').forEach((r) => { products[r.product_id] = r; });
  const materials = {};
  readCsv('01_corevia/master/m_material_cv.csv').forEach((r) => { materials[r.material_id] = r; });

  const lots = {};
  readCsv('01_corevia/procurement/material_lot_master_cv.csv').forEach((r) => {
    lots[r.lot_id] = { ...r, received_qty: Number(r.received_qty) };
  });

  const capacity = readCsv('01_corevia/production/strat_capacity_cv.csv').map((r) => ({
    ...r, capacity_qty: Number(r.capacity_qty), utilization_pct: Number(r.utilization_pct),
  }));

  // PL-02 미출하 주문 = SO 중 SH(order_id)가 없는 주문, 2024-01 이전 주문 제외 [도출, 01_영향분석 §3.1]
  const orders = readCsv('01_corevia/sales/sales_orders_cv.csv');
  const shipments = readCsv('01_corevia/sales/sales_shipments_cv.csv');
  const shippedOrderIds = new Set(shipments.map((s) => s.order_id));
  const unshippedPl02 = orders
    .filter((o) => o.product_id === 'PL-02' && !shippedOrderIds.has(o.order_id) && o.order_date >= '2024-01-01')
    .map((o) => ({
      order_id: o.order_id,
      order_date: o.order_date,
      customer_id: o.customer_id,
      order_qty: Number(o.order_qty),
      order_amount_krw: Number(o.order_amount_krw),
      // 예상 납기 = 주문일 + 리드타임 중앙값 61일 [추정] (SO에 납기 필드 없음)
      expected_due: addDays(o.order_date, 61),
    }))
    .sort((a, b) => (a.expected_due < b.expected_due ? -1 : a.expected_due > b.expected_due ? 1 : a.order_id < b.order_id ? -1 : 1));

  // PL-02 2026 H1 월평균 생산량 [도출]
  const pl02H1 = batches.filter((b) => b.product_id === 'PL-02' && b.production_date >= '2026-01-01' && b.production_date <= '2026-06-30');
  const pl02MonthlyAvg = Math.round(pl02H1.reduce((s, b) => s + b.produced_qty, 0) / 6);

  // Masil 더마 발주 (Corevia 앞, PL-02 SKU) [원본: sc_purchase_orders_ms, m_sku_ms]
  const skus = {};
  readCsv('02_masil/master/m_sku_ms.csv').forEach((r) => { skus[r.sku_id] = r; });
  const inv = {};
  readCsv('02_masil/inventory/sku_inventory_ms.csv').forEach((r) => { inv[r.sku_id] = r; });
  const masilPos = readCsv('02_masil/inventory/sc_purchase_orders_ms.csv')
    .filter((p) => skus[p.sku_id] && skus[p.sku_id].product_id === 'PL-02')
    .map((p) => ({
      po_id: p.po_id,
      sku_id: p.sku_id,
      sku_name: skus[p.sku_id].sku_name,
      order_date: p.order_date,
      order_qty: Number(p.order_qty),
      lead_time_weeks: Number(p.lead_time_weeks),
      due: addDays(p.order_date, Number(p.lead_time_weeks) * 7),
      stock_cover_weeks: inv[p.sku_id] ? Number(inv[p.sku_id].stock_cover_weeks) : null,
      safety_stock_weeks_min: Number(skus[p.sku_id].safety_stock_weeks_min),
    }));

  // 재무 채권 [원본: fin_ar_aging_cv] 고객별 미회수 잔액
  const ar = {};
  readCsv('01_corevia/financials/fin_ar_aging_cv.csv').forEach((r) => {
    if (r.customer_id === 'NONE') return;
    const a = ar[r.customer_id] || (ar[r.customer_id] = { outstanding_krw: 0, overdue_krw: 0 });
    a.outstanding_krw += Number(r.outstanding_krw);
    if (Number(r.aging_days) > 0) a.overdue_krw += Number(r.outstanding_krw);
  });

  const docs = {
    quality_policy: readText('01_corevia/quality/quality_policy_cv.md'),
    news: readText('05_external/news/ext_news_quality_incident.md'),
    rfp: readText('01_corevia/docs/rfp_c201.md'),
  };

  // C-201 RFP 요약 [원본: rfp_c201.md]
  const rfp = {
    customer: 'C-201',
    derma_annual_qty: 1500000,
    line_constraint: '더마 물량은 F1 더마 전용 라인(L-02)에서만 생산 가능',
    penalty: '납기 지연 페널티 월 3%',
    recall_cost: '품질 리콜 비용 공급자 전가',
    deadline: '마감 3주',
    authority: '입찰 참여 결정 = CEO/이사회',
  };

  const batchById = {};
  batches.forEach((b) => { batchById[b.batch_id] = b; });
  const sblByBatch = {};
  sbl.forEach((s) => { (sblByBatch[s.batch_id] = sblByBatch[s.batch_id] || []).push(s); });

  return {
    BASE_DATE, claims, batches, batchById, sbl, sblByBatch, customers, products, materials, lots,
    capacity, unshippedPl02, pl02MonthlyAvg, masilPos, ar, docs, rfp,
  };
}

let cached = null;
function getModel() {
  if (!cached) cached = load();
  return cached;
}

module.exports = { getModel, readCsv, addDays, BASE_DATE, SOURCE_DIR };
