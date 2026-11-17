'use strict';
// 확장(a) ON/OFF 비교: 같은 입력(현재 판정 오버레이 포함)을 별도 상태 두 개에서 실제 실행해 차이를 만든다.
const E = require('./engine');

function runOnce(baseState, extensionOn) {
  const s = E.newState();
  s.claimOverrides = JSON.parse(JSON.stringify(baseState.claimOverrides || {}));
  s.settings.extensionOn = extensionOn;
  const J = E.judge(s);
  const recall = Object.values(J.judgments).filter((j) => j.base_status === '회수 대상').map((j) => j.batch_id);
  const lotBatches = ['B-02-2602-01', 'B-02-2602-02', 'B-02-2602-03', 'B-02-2603-01'].map((b) => ({
    batch_id: b, status: J.judgments[b].status, rateP: J.judgments[b].rateP, unshipped_qty: J.judgments[b].unshipped_qty, trigger_qty: J.judgments[b].trigger_qty,
  }));
  let tasks = []; let irs = [];
  if (recall.length) {
    const c = E.createCase(s, { title: '비교용 사건', batch_ids: recall });
    E.judgeCase(s, c.id);
    E.submitCase(s, c.id, {});
    E.recordReply(s, c.id, { classification: '승인', text: '비교용 회수 승인[모의]' });
    tasks = s.tasks.map((t) => ({ kind: t.kind, title: t.title, track: t.track, dept: t.dept }));
    irs = s.infoRequests.map((r) => ({ kind: r.kind, to: r.to, question: r.question }));
  }
  return {
    extensionOn,
    recall_batches: recall,
    preventive_batches: J.preventive.map((p) => ({ batch_id: p.batch_id, unshipped_qty: p.unshipped_qty, trigger_qty: p.trigger_qty, customers: p.customers })),
    lot_batches: lotBatches,
    task_count: tasks.length,
    tasks,
    info_requests: irs,
    recall_notice_count: tasks.filter((t) => t.kind === '고객 통지').length,
  };
}

function compareExtension(state) {
  const on = runOnce(state, true);
  const off = runOnce(state, false);
  const onlyOn = on.tasks.filter((t) => !off.tasks.some((o) => o.title === t.title));
  return {
    on, off,
    diff: {
      preventive_only_on: on.preventive_batches.map((p) => p.batch_id),
      tasks_only_on: onlyOn,
      info_requests_only_on: on.info_requests.filter((r) => !off.info_requests.some((o) => o.question === r.question)),
      recall_notice_same: on.recall_notice_count === off.recall_notice_count,
      note: '확장 ON에서만 같은 로트 사용 합격 배치가 예방 점검으로 분리되고, 회수 통지는 늘지 않음(보유분 확인 요청만)',
    },
  };
}

module.exports = { compareExtension };
