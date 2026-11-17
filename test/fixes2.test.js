'use strict';
// 2차 검수 수정 목록 v2 — F18~F22 회귀 테스트
process.env.NODE_ENV = 'test';
process.env.PERSIST = 'off';
delete process.env.AI_REAL_ENABLED;
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const ai = require('../src/ai');
const E = require('../src/engine');

// fetch는 잘못된 주소를 정규화하므로 원시 요청 경로를 그대로 보낸다
function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: rawPath }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('F18: 잘못 인코딩된 주소·한글 경로에도 서버가 죽지 않고 400/404 한국어 응답, 이후 계속 응답', async () => {
  const { createServer } = require('../server');
  const srv = createServer().listen(0);
  const port = srv.address().port;
  try {
    const bad = await rawGet(port, '/%E0%A4%A');
    assert.equal(bad.status, 400); assert.match(bad.body, /잘못된 주소/);
    const pct = await rawGet(port, '/%');
    assert.equal(pct.status, 400);
    const korean = await rawGet(port, '/' + encodeURIComponent('01_참가자_배포용') + '/A05.html');
    assert.equal(korean.status, 404); assert.match(korean.body, /없는 주소/);
    const rawKorean = await rawGet(port, '/%ED%95%9C');
    assert.equal(rawKorean.status, 404);
    const trav = await rawGet(port, '/..%2Fserver.js');
    assert.ok([400, 403, 404].includes(trav.status));
    const apiBad = await rawGet(port, '/api/batches/%E0%A4%A');
    assert.ok([400, 404].includes(apiBad.status));
    const health = await rawGet(port, '/api/health');
    assert.equal(health.status, 200, '오류 요청 뒤에도 서버가 계속 응답');
    const index = await rawGet(port, '/');
    assert.equal(index.status, 200);
  } finally {
    srv.close();
  }
});

test('F18: 처리 중 예상하지 못한 예외도 500 한국어 응답, 프로세스 유지', async () => {
  const { createServer } = require('../server');
  const store = require('../src/store');
  const srv = createServer().listen(0);
  const port = srv.address().port;
  const original = store.get;
  try {
    store.get = () => { throw new TypeError('테스트용 내부 오류'); };
    const r = await rawGet(port, '/api/state');
    assert.equal(r.status, 500);
    assert.match(r.body, /서버 내부 오류/);
    store.get = original;
    const ok = await rawGet(port, '/api/health');
    assert.equal(ok.status, 200);
  } finally {
    store.get = original;
    srv.close();
  }
});

test('F19: 원인 단정 우회 문장 차단, 비단정 "원인은 (현재) 조사 중/확인 중"만 면제', () => {
  ['원료가 원인입니다.', '원인: 원료 로트 불량', '원인은 원료로 판명되었으며 세부 사항은 확인 중입니다', '로트가 원인으로 확인되었습니다.'].forEach((t) => {
    assert.ok(ai.checkForbidden(t, 'notice').some((v) => v.code === 'CAUSE'), t);
  });
  ['원인은 현재 조사 중이며, 확인되는 대로 안내드리겠습니다.', '원인은 현재 확인 중입니다.', '원인은 미확정이다.'].forEach((t) => {
    assert.deepEqual(ai.checkForbidden(t, 'notice'), [], t);
  });
  assert.deepEqual(ai.checkForbidden('원인: 조사 중(별도 트랙). 본 상신은 원인 확정을 전제로 하지 않음.', 'internal'), []);
});

test('F20: "미의결"은 거절, "유보함"은 추가자료 요구(보류)로 제안', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal((await ai.interpretReply('반대 다수로 미의결', {})).output.classification, '거절');
  assert.equal((await ai.interpretReply('승인을 유보함', {})).output.classification, '추가자료 요구');
  assert.equal((await ai.interpretReply('미승인', {})).output.classification, '거절');
  assert.equal((await ai.interpretReply('회수 승인', {})).output.classification, '승인');
});

test('F21: 주 단위·순(초·중·말) 납기 표현 차단', () => {
  ['8월 첫째 주까지 대체품 납품', '8월 둘째주 대체 공급', '9월 초순 재공급 예정', '8월 말 대체품 발송', '3주차에 대체품 발송', '마지막 주에 대체 제품 공급'].forEach((t) => {
    assert.ok(ai.checkForbidden(t, 'notice').some((v) => v.code === 'DATE'), t);
  });
  assert.deepEqual(ai.checkForbidden('   - 출하일 2026-02-09 / B-02-2602-01 / 30,440 EA', 'notice'), []);
});

test('F22: 고객 보유 수량이 회수 배치 SBL 출하량을 넘으면 400, 상태 무변경', () => {
  const s = E.newState();
  const c = E.createCase(s, { batch_ids: ['B-02-2602-01', 'B-02-2603-01'] });
  E.judgeCase(s, c.id); E.submitCase(s, c.id, {});
  E.recordReply(s, c.id, { classification: '승인', text: '승인' });
  const before = JSON.stringify(s);
  assert.throws(() => E.applyEvent(s, { type: 'holding_reply', customer_id: 'C-101', qty: 999999 }), (e) => e.status === 400 && /56,993 EA/.test(e.message));
  assert.throws(() => E.applyEvent(s, { type: 'holding_reply', customer_id: 'C-101', qty: 56994 }), (e) => e.status === 400);
  assert.throws(() => E.applyEvent(s, { type: 'holding_reply', customer_id: 'C-105', qty: 1 }), (e) => e.status === 400 && /귀속 미확인/.test(e.message));
  assert.equal(JSON.stringify(s), before);
  E.applyEvent(s, { type: 'holding_reply', customer_id: 'C-101', qty: 56993 });
  assert.equal(s.holdingReplies['C-101'], 56993);
});
