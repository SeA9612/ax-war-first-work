'use strict';
// 3차 검수 수정 목록 v3 — F23(실패 요청 롤백이 다른 성공 요청 기록을 지우지 않음, 상태 변경 직렬화), F24(안전망 시 상태 재적재)
process.env.NODE_ENV = 'test';
process.env.PERSIST = 'off';
delete process.env.AI_REAL_ENABLED;
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function call(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let d = ''; res.setEncoding('utf8'); res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
    });
    r.on('error', reject); if (body) r.write(JSON.stringify(body)); r.end();
  });
}
// 본문을 나눠 천천히 보내는 요청
function slowCall(port, p, part1, part2, delayMs) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let d = ''; res.setEncoding('utf8'); res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
    });
    r.on('error', reject);
    r.write(part1);
    setTimeout(() => { r.write(part2); r.end(); }, delayMs);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('F23: 느린 본문의 실패 요청이 롤백돼도, 그 사이 성공한 다른 요청(언론 보도·사건 접수) 기록은 보존', async () => {
  const { createServer } = require('../server');
  const store = require('../src/store');
  store.reset(false);
  const srv = createServer().listen(0);
  const port = srv.address().port;
  try {
    const before = (await call(port, 'GET', '/api/events')).body.length;
    const pA = slowCall(port, '/api/events', '{"type":"holding_reply","customer_id":"C-101",', '"qty":"abc"}', 400);
    await wait(100);
    const b1 = await call(port, 'POST', '/api/events', { type: 'news', title: '경합 시험' });
    const b2 = await call(port, 'POST', '/api/cases', { batch_ids: ['B-02-2602-01'], title: '경합 사건' });
    assert.equal(b1.status, 201); assert.equal(b2.status, 201);
    const a = await pA;
    assert.equal(a.status, 400);
    assert.equal(a.body.rolled_back, true);
    const events = (await call(port, 'GET', '/api/events')).body;
    const cases = (await call(port, 'GET', '/api/cases')).body;
    assert.equal(events.length, before + 1, '언론 보도 이벤트 보존');
    assert.equal(cases.length, 1, '사건 보존');
    assert.ok(store.get().audit.some((x) => x.action === '언론 보도 기록'));
    assert.ok(store.get().audit.some((x) => x.action === '사건 접수'));
  } finally {
    srv.close();
  }
});

test('F23: 상태 변경 요청은 한 번에 하나씩 — 동시에 보낸 실패·성공 요청이 서로 기록을 지우지 않음', async () => {
  const { createServer } = require('../server');
  const store = require('../src/store');
  store.reset(false);
  const srv = createServer().listen(0);
  const port = srv.address().port;
  try {
    const reqs = [];
    for (let i = 0; i < 10; i += 1) {
      reqs.push(call(port, 'POST', '/api/events', { type: 'news', title: '동시 ' + i }));
      reqs.push(call(port, 'POST', '/api/events', { type: 'procurement_reply', available_date: 'abc' }));
    }
    const out = await Promise.all(reqs);
    assert.equal(out.filter((r) => r.status === 201).length, 10);
    assert.equal(out.filter((r) => r.status === 400).length, 10);
    assert.equal(store.get().events.length, 10);
    assert.equal(store.get().procurementReply, null);
  } finally {
    srv.close();
  }
});

test('F24: 안전망 작동 시 마지막 저장 state.json 재적재', () => {
  const store = require('../src/store');
  const { onFatal } = require('../server');
  const E = require('../src/engine');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axwar-f24-'));
  const file = path.join(dir, 'state.json');
  const saved = E.newState();
  saved.events.push({ id: 'EV-900', type: 'news', input: {}, tag: '', occurred_on: '2026-07-01', applied_at: 'x', effect: '저장본' });
  fs.writeFileSync(file, JSON.stringify(saved));
  store.reset(false);
  store.get().events.push({ id: 'EV-BAD', type: 'news' }); // 반쯤 바뀐 메모리 상태 가정
  assert.equal(store.reloadFromDisk(file), true);
  assert.deepEqual(store.get().events.map((e) => e.id), ['EV-900']);
  assert.equal(store.reloadFromDisk(path.join(dir, '없음.json')), false);
  fs.writeFileSync(file, '{깨진 파일');
  assert.equal(store.reloadFromDisk(file), false, '깨진 파일이면 메모리 유지');
  assert.deepEqual(store.get().events.map((e) => e.id), ['EV-900']);
  // 테스트 환경(저장 끔)에서 안전망은 재적재하지 않고 메모리 유지
  const origErr = console.error; console.error = () => {};
  try { assert.equal(onFatal('테스트', new Error('x')), false); } finally { console.error = origErr; }
  fs.rmSync(dir, { recursive: true, force: true });
});
