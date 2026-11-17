'use strict';
// 보고서 내보내기: CSV(엑셀 한글·수식 방지)와 인쇄용 화면, 판정과 같은 값, 상태 불변
process.env.NODE_ENV = 'test';
process.env.PERSIST = 'off';
delete process.env.AI_REAL_ENABLED;
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine');
const R = require('../src/report');

const parse = (csv) => csv.replace(/^﻿/, '').trim().split('\r\n');

test('CSV: BOM으로 시작, 머리·전체 배치 행, 회수 대상이 맨 위', () => {
  const s = E.newState();
  const csv = R.reportCsv(s);
  assert.ok(csv.startsWith('﻿'));
  const lines = parse(csv);
  assert.match(lines[0], /기준일 2026-07-01/);
  assert.match(lines[1], /^배치,제품,제품명,생산일/);
  const total = Object.keys(E.judge(s).judgments).length;
  assert.equal(lines.length, 2 + total);
  assert.match(lines[2], /^B-02-26\d\d-01,PL-02,/);
  assert.match(lines[2], /,회수 대상,/);
});

test('CSV 불량률은 판정 엔진 값과 같다', () => {
  const s = E.newState();
  const j = E.judge(s).judgments['B-02-2602-01'];
  const row = parse(R.reportCsv(s)).find((l) => l.startsWith('B-02-2602-01,'));
  assert.ok(row.includes((j.rateP * 100).toFixed(2) + '%'));
  assert.ok(row.includes((j.rateS * 100).toFixed(2) + '%'));
});

test('보고서는 상태를 바꾸지 않는다(감사기록·판정 그대로)', () => {
  const s = E.newState();
  E.createCase(s, { batch_ids: ['B-02-2602-01', 'B-02-2603-01'] });
  const before = JSON.stringify(s);
  R.reportCsv(s); R.reportHtml(s);
  assert.equal(JSON.stringify(s), before);
});

test('인쇄용 화면: 요약·조치 배치·경고·사건·회수 범위 고객, 사건 열이 CSV에 기록', () => {
  const s = E.newState();
  let html = R.reportHtml(s);
  assert.match(html, /품질 회수 판정 보고서/);
  assert.match(html, /접수된 사건이 없습니다/);
  assert.match(html, /사건 미접수/);
  const c = E.createCase(s, { batch_ids: ['B-02-2602-01', 'B-02-2603-01'] });
  html = R.reportHtml(s);
  assert.ok(html.includes(c.id));
  assert.match(html, /C-101 뷰티메가리테일/);
  assert.match(html, /아직 위원회 의결 전/);
  assert.match(html, /@page/);
  assert.ok(parse(R.reportCsv(s)).find((l) => l.startsWith('B-02-2602-01,')).includes(c.id));
});

test('CSV 칸: 쉼표·따옴표는 감싸고, 수식으로 읽힐 값은 글자로 둔다', () => {
  const s = E.newState();
  s.cases.push({ id: '=HYPERLINK("x")', status: '접수', batchIds: ['B-02-2602-01'] });
  const row = parse(R.reportCsv(s)).find((l) => l.startsWith('B-02-2602-01,'));
  assert.ok(row.includes(`"'=HYPERLINK(""x"")(접수)"`));
});
