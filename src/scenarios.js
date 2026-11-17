'use strict';
// 시연 시나리오 ①②③ — 각 단계는 API와 같은 엔진 함수를 실제로 호출한다(미리 만든 결과를 보여주지 않음).
// 사람·외부 회신 입력은 [모의] 값이며, 기대값(설계안 §7·02_원인조사 §5)과 실제 처리 결과를 비교해 표시한다.
const E = require('./engine');

const pct = (x) => (x == null ? '-' : (x * 100).toFixed(2) + '%');

function j(state, b) { return E.judge(state).judgments[b]; }
function caseOf(state) { return state.cases[state.cases.length - 1]; }
function check(label, expected, actual) { return { label, expected: String(expected), actual: String(actual), ok: String(expected) === String(actual) }; }
function openTasks(state, c) { return state.tasks.filter((t) => t.caseId === c.id); }
function countBy(list, f) { const o = {}; list.forEach((x) => { const k = f(x); o[k] = (o[k] || 0) + 1; }); return o; }
const REPLY1 = '두 배치 회수 승인. 회수 범위는 SBL 출하처와 클레임 고객으로 한다.';
function kindsText(ts) { return Object.entries(countBy(ts, (t) => t.kind)).map(([k, v]) => `${k} ${v}건`).join(', '); }
const LOT_CASE = { title: 'LOT-B-2602-P 사용 PL-02 배치 클레임 누적', batch_ids: ['B-02-2602-01', 'B-02-2603-01'] };

async function sendAllNotices(state, c, kind) {
  const sent = [];
  for (const t of state.tasks.filter((x) => x.caseId === c.id && x.kind === kind && x.status === E.TASK.WAIT)) {
    E.sendNotice(state, t.id, '영업[모의]'); sent.push(t.id);
  }
  return sent;
}

const SCENARIOS = {
  1: {
    title: '① 정상 — 회수 기준 충족 → 상신 → 의결 → 후속 작업 → 재공급 승인',
    steps: [
      {
        title: '사건 접수(클레임 누적 이벤트)',
        input: 'claim_intake: LOT-B-2602-P 사용 배치 B-02-2602-01, B-02-2603-01',
        run: async (s) => {
          E.applyEvent(s, { type: 'claim_intake', ...LOT_CASE });
          const c = caseOf(s);
          return { summary: `${c.id} 생성(${c.status})`, checks: [check('사건 상태', '접수', c.status)] };
        },
      },
      {
        title: '규칙 판정 + 로트 추적(확장 a)',
        input: '판정 실행',
        run: async (s) => {
          const c = caseOf(s); E.judgeCase(s, c.id);
          const a = j(s, 'B-02-2602-01'); const b = j(s, 'B-02-2603-01');
          return {
            summary: `B-02-2602-01 ${a.status} ${pct(a.rateP)}/${pct(a.rateS)} · B-02-2603-01 ${b.status} ${pct(b.rateP)}/${pct(b.rateS)} · 예방 점검 ${j(s, 'B-02-2602-02').status}, ${j(s, 'B-02-2602-03').status}`,
            checks: [check('B-02-2602-01 생산 기준', '11.87%', pct(a.rateP)), check('B-02-2602-01 출하 기준', '12.27%', pct(a.rateS)),
              check('B-02-2603-01 생산 기준', '11.59%', pct(b.rateP)), check('B-02-2603-01 출하 기준', '12.11%', pct(b.rateS)),
              check('판정', '회수 대상', a.status), check('B-02-2602-02 (확장)', '예방 점검', j(s, 'B-02-2602-02').status)],
          };
        },
      },
      {
        title: '모의 AI 상신 준비(근거 요약·위험·미확인·상신문 초안)',
        input: '모의 AI(규칙·템플릿) — 판정 수치·민감도·회수 범위 입력',
        run: async (s) => {
          const d = await E.prepareSubmissionDraft(s, caseOf(s).id);
          return { summary: `${d.mode} 초안 생성 · 미확인 ${d.output.unknowns.length}건 · 금지 표현 ${d.violations.length}건`, checks: [check('판정 불변(AI)', '회수 대상', j(s, 'B-02-2602-01').status)] };
        },
      },
      {
        title: '품질위원회 상신',
        input: '품질팀 검토 후 상신',
        run: async (s) => {
          const sub = E.submitCase(s, caseOf(s).id, { actor: '사람(품질팀)' });
          return { summary: `${sub.id} 상신 — ${sub.items.length}개 배치`, checks: [check('사건 상태', '위원회 상신', caseOf(s).status)] };
        },
      },
      {
        title: '위원회 회신 문장 입력 [모의] → 모의 AI 분류 제안(확정 아님)',
        input: '회신 문장: "두 배치 회수 승인. 회수 범위는 SBL 출하처와 클레임 고객으로 한다."',
        run: async (s) => {
          const c = caseOf(s);
          const d = await E.interpretReply(s, c.id, REPLY1);
          return {
            summary: `${d.mode} 분류 제안: ${d.output.classification} — 제안만 저장, 사건 상태는 그대로`,
            checks: [check('AI 분류 제안', '승인', d.output.classification), check('사건 상태(제안만으로 불변)', '위원회 상신', c.status), check('작업 생성 없음', 0, openTasks(s, c).length)],
          };
        },
      },
      {
        title: '[모의] 담당자 확정: "승인" 선택 → 후속 작업 자동 생성',
        input: '담당자가 분류 "승인"을 직접 선택해 확정',
        run: async (s) => {
          const c = caseOf(s);
          E.recordReply(s, c.id, { classification: '승인', text: REPLY1, actor: '품질위원회 간사(담당자 확정)[모의]' });
          const ts = openTasks(s, c);
          const notices = ts.filter((t) => t.kind === '고객 통지').map((t) => t.customer_id);
          return {
            summary: `${c.status} · 작업 ${ts.length}건 (${kindsText(ts)}) · 확인요청 ${s.infoRequests.length}건`,
            checks: [check('사건 상태', '회수 의결', c.status),
              check('회수 통지 고객(C-105 제외)', 'C-101,C-102,C-103,C-104,C-108', notices.sort().join(',')),
              check('C-105 확인요청 생성', 'true', s.infoRequests.some((r) => r.kind === 'C105_LABEL')),
              check('미출하 잔여분 출하 정지 작업', 'B-02-2602-01 4,885 EA / B-02-2603-01 6,940 EA', ts.filter((t) => t.kind === '출하 정지').map((t) => t.batchIds[0] + ' ' + t.title.match(/약 ([\d,]+) EA/)[1] + ' EA').join(' / ')),
              check('예방 점검 고객 통지 없음', '0', ts.filter((t) => t.kind === '고객 통지' && ['B-02-2602-02', 'B-02-2602-03'].some((b) => (t.payload.draft || '').includes(b))).length)],
          };
        },
      },
      {
        title: '고객 회수 통지 발송(모의) — 금지 표현 서버 점검 통과',
        input: '영업 승인 후 발송[모의]',
        run: async (s) => {
          const sent = await sendAllNotices(s, caseOf(s), '고객 통지');
          return { summary: `${sent.length}건 발송(모의): ${sent.join(', ')}`, checks: [check('발송 건수', 5, sent.length)] };
        },
      },
      {
        title: '재공급 대안 계산(조달 회신 전 → 확인 대기)',
        input: '가정: 월 여유 14,800 EA, 재승인 14일, 한도 12주(모든 회수 고객 대체 완료 기준)',
        run: async (s) => {
          const p = E.computeCasePlan(s, caseOf(s).id);
          return { summary: `계획 ${p.status} · 대체 ${p.result.replacement_total.toLocaleString()} EA(SBL 상한, C-105 제외)`, checks: [check('계획 상태', '확인 대기', p.status), check('대체 필요 수량', '299,653', p.result.replacement_total.toLocaleString())] };
        },
      },
      {
        title: '조달 회신 [모의] → 재계산 → 모의 AI 대안 설명',
        input: 'procurement_reply: 원료 확보일 2026-07-20, LOT-B-2607-1(규격내), 15,000 kg',
        run: async (s) => {
          E.applyEvent(s, { type: 'procurement_reply', available_date: '2026-07-20', available_kg: 15000, lot_id: 'LOT-B-2607-1(모의)', note: 'V-205 규격내 후속 로트' });
          const c = caseOf(s);
          const d = await E.explainCasePlan(s, c.id);
          const [A, B, C] = c.plan.result.alternatives;
          const cust = (alt, id) => alt.per_customer.find((p) => p.customer_id === id).replacement_done;
          return {
            summary: c.plan.result.alternatives.map((a) => `${a.id}: 전체 대체 완료 ${a.replacement_done}(${a.weeks_to_complete}주) · 영향 주문 ${a.delayed_orders.length}건 · 평균 ${a.avg_delay_days}일/최대 ${a.max_delay_days}일 · ${a.feasibility_note}`).join(' | ') + ` · ${d.mode} 설명`,
            checks: [check('계획 상태', '계산 완료', c.plan.status),
              check('A 전체 대체 완료(한도 내)', '2026-08-20 / 8주 / 한도 내', `${A.replacement_done} / ${A.weeks_to_complete}주 / ${A.over_limit ? '한도 초과' : '한도 내'}`),
              check('A·B 최대 지연일', '19 / 12', `${A.max_delay_days} / ${B.max_delay_days}`),
              check('B C-103·C-108 대체 완료일', '2027-02-01 / 2027-04-13', `${cust(B, 'C-103')} / ${cust(B, 'C-108')}`),
              check('B 한도 판정', '한도 초과(41주)', B.over_limit ? `한도 초과(${B.weeks_to_complete}주)` : '한도 내'),
              check('대안 C', '실행 불가(93주)', C.feasible ? '가능' : `실행 불가(${C.weeks_to_complete}주)`),
              check('대안 A 필요 승인', '영업 임원+생산 책임자', A.approvals_required.join('+'))],
          };
        },
      },
      {
        title: '대안 선택: B는 한도 초과(예외 사유 없으면 상신 차단) → 한도 내 대안 A 상신 → 영업 임원·생산 책임자 승인[모의] → 후속 작업',
        input: '대안 B(예외 사유 없음) 시도 → 대안 A 상신',
        run: async (s) => {
          const c = caseOf(s);
          let blocked = '';
          try { E.submitPlan(s, c.id, { alternative: 'B' }); } catch (e) { blocked = String(e.status); }
          E.submitPlan(s, c.id, { alternative: 'A' });
          E.approvePlan(s, c.id, { approver: '영업 임원', decision: '승인' });
          E.approvePlan(s, c.id, { approver: '생산 책임자', decision: '승인' });
          const ts = openTasks(s, c).filter((t) => ['납기 변경 통지', '대체 공급 안내', '생산 순서 변경', 'Masil 정보 통지', 'C-201 정보 통지', '품질 재승인'].includes(t.kind));
          const masil = ts.filter((t) => t.kind === 'Masil 정보 통지').length;
          return { summary: `${c.status} · ${kindsText(ts)}`, checks: [check('B 예외 사유 없이 상신', '409', blocked), check('사건 상태', '복구 진행', c.status), check('Masil 정보 통지', 1, masil), check('대체 공급 안내(회수 고객)', 5, ts.filter((t) => t.kind === '대체 공급 안내').length)] };
        },
      },
      {
        title: '[모의] 담당자가 모의 AI 대체 공급 안내 초안을 회수 고객 작업에 선택 적용 → 금지 표현 재점검 후 발송(모의)',
        input: 'C-101 대체 공급 안내 작업 ← AI 초안 적용 → 발송',
        run: async (s) => {
          const c = caseOf(s);
          const t = s.tasks.find((x) => x.caseId === c.id && x.kind === '대체 공급 안내' && x.customer_id === 'C-101');
          E.applyAiDraft(s, t.id, { actor: '영업(담당자)[모의]' });
          E.sendNotice(s, t.id, '영업[모의]');
          return { summary: `${t.id} 초안 출처: ${t.payload.source} · ${t.status}`, checks: [check('초안 출처 AI 표시', 'true', t.payload.source.startsWith('AI 초안')), check('발송(모의)', '완료', t.status)] };
        },
      },
      {
        title: '언론 보도 입력 → 판정 불변',
        input: 'news: 단일 온라인 매체, 미확정 보도',
        run: async (s) => {
          const before = j(s, 'B-02-2602-01').status;
          const ev = E.applyEvent(s, { type: 'news', title: '일부 소비자 트러블 사례 보도(미확정)', source: 'ext_news_quality_incident' });
          return { summary: ev.effect, checks: [check('판정', before, j(s, 'B-02-2602-01').status), check('사건 상태 유지', '복구 진행', caseOf(s).status)] };
        },
      },
    ],
  },
  2: {
    title: '② 조건 변경 — 판정 정정 → 분모 민감 → 재검증·재상신 → 추가 정정 → 하향·정정 통지',
    steps: [
      {
        title: '사전 상태: B-02-2602-01 사건 접수·판정·상신·의결·통지 발송·재공급 승인(실제 처리)',
        input: '시나리오 ①의 처리를 B-02-2602-01 한 배치로 실행',
        run: async (s) => {
          E.applyEvent(s, { type: 'claim_intake', title: 'B-02-2602-01 클레임 누적', batch_ids: ['B-02-2602-01'] });
          const c = caseOf(s);
          E.judgeCase(s, c.id);
          await E.prepareSubmissionDraft(s, c.id);
          E.submitCase(s, c.id, {});
          E.recordReply(s, c.id, { classification: '승인', text: '회수 승인[모의]' });
          await sendAllNotices(s, c, '고객 통지');
          E.applyEvent(s, { type: 'procurement_reply', available_date: '2026-07-20', available_kg: 15000, lot_id: 'LOT-B-2607-1(모의)' });
          E.computeCasePlan(s, c.id);
          E.submitPlan(s, c.id, { alternative: 'A' });
          E.approvePlan(s, c.id, { approver: '영업 임원', decision: '승인' });
          E.approvePlan(s, c.id, { approver: '생산 책임자', decision: '승인' });
          const due = await sendAllNotices(s, c, '납기 변경 통지');
          return { summary: `${c.id} ${c.status} · 회수 통지·납기 변경 통지 ${due.length}건 발송(모의)`, checks: [check('판정', '회수 대상', j(s, 'B-02-2602-01').status), check('사건 상태', '복구 진행', c.status)] };
        },
      },
      {
        title: '판정 정정 입력 [모의]: QC-00006·00011·00015 → 규격이탈 아님',
        input: 'claim_correction: QC-00006(1,100), QC-00011(1,084), QC-00015(1,068)',
        run: async (s) => {
          const ev = E.applyEvent(s, { type: 'claim_correction', claim_ids: ['QC-00006', 'QC-00011', 'QC-00015'], reason: '재검사 결과 규격 내[모의]' });
          const a = j(s, 'B-02-2602-01'); const c = caseOf(s);
          const rv = openTasks(s, c).filter((t) => t.status === E.TASK.REVALIDATE).length;
          return {
            summary: `${ev.effect} · 재검증 필요 작업 ${rv}건 · 사건 ${c.status}`,
            checks: [check('확정 수량', '14648', a.confirmed_qty), check('생산 기준', '9.72%', pct(a.rateP)), check('출하 기준', '10.04%', pct(a.rateS)),
              check('판정', '분모 민감', a.status), check('사건 상태', '재검증 필요', c.status), check('재검증 필요 작업 있음', 'true', rv > 0)],
          };
        },
      },
      {
        title: '모의 AI 재상신 준비 → 두 값(9.72% / 10.04%) 함께 재상신',
        input: '품질팀 재상신',
        run: async (s) => {
          const c = caseOf(s);
          const d = await E.prepareSubmissionDraft(s, c.id);
          const sub = E.submitCase(s, c.id, {});
          return { summary: `${sub.id} 재상신(v${sub.version}) · ${d.mode} · 위험: ${d.output.risks[0]}`, checks: [check('재상신 항목 상태', '분모 민감', sub.items[0].status), check('사건 상태', '위원회 상신', c.status)] };
        },
      },
      {
        title: '대조 입력: QC-00142 미확정 → 확정 (결론 유지 근거)',
        input: 'claim_confirm: QC-00142 (B-02-2606-02, 5 EA)',
        run: async (s) => {
          const ev = E.applyEvent(s, { type: 'claim_confirm', claim_id: 'QC-00142', reason: '규격이탈 확정[모의]' });
          const x = j(s, 'B-02-2606-02');
          return { summary: `${ev.effect} · B-02-2606-02 ${pct(x.rateP)} → ${x.status} (회수 대상 아님 유지)`, checks: [check('B-02-2606-02 생산 기준', '0.00%', pct(x.rateP)), check('회수 판정', 'false', x.status === '회수 대상'), check('사건 상태 불변', '위원회 상신', caseOf(s).status)] };
        },
      },
      {
        title: '추가 정정 [모의]: QC-00004 → 두 기준 모두 미달 → 조사·소명, 후속 작업 취소, 정정 통지·영업 확인',
        input: 'claim_correction: QC-00004(1,059)',
        run: async (s) => {
          const ev = E.applyEvent(s, { type: 'claim_correction', claim_ids: ['QC-00004'], reason: '재검사 결과 규격 내[모의]' });
          const a = j(s, 'B-02-2602-01'); const c = caseOf(s);
          const ts = openTasks(s, c);
          const corr = ts.filter((t) => t.kind === '정정 통지·영업 확인');
          return {
            summary: `${ev.effect} (기본 판정 ${a.base_status}) · 취소 ${ts.filter((t) => t.status === '취소').length}건 · 원인조사 유지 ${ts.filter((t) => t.track === '원인조사' && t.status === '대기').length}건 · 정정 통지 작업 ${corr.length}건`,
            checks: [check('생산 기준', '9.01%', pct(a.rateP)), check('출하 기준', '9.32%', pct(a.rateS)), check('기본 판정', '조사·소명', a.base_status),
              check('표시 상태(확장 a: 같은 로트의 B-02-2603-01이 회수 대상)', '예방 점검', a.status),
              check('정정 통지·영업 확인 작업', 1, corr.length), check('사건 상태', '판정 완료', c.status), check('재공급 계획', '취소', c.plan.status)],
          };
        },
      },
    ],
  },
  3: {
    title: '③ 정보 부족 — 위원회 추가자료 요구(C-105 귀속) → 보류 → 확인요청 → 재상신',
    steps: [
      {
        title: 'B-02-2603-01 사건 접수·판정(C-105 민감도 표시)',
        input: 'claim_intake: B-02-2603-01',
        run: async (s) => {
          E.applyEvent(s, { type: 'claim_intake', title: 'B-02-2603-01 클레임 누적', batch_ids: ['B-02-2603-01'] });
          const c = caseOf(s);
          const v = E.judgeCase(s, c.id);
          const sens = v.sensitivity[0];
          return { summary: `11.59% 회수 대상 · C-105(${sens.unlinked[0].qty} EA) 제외 시 ${pct(sens.rateP_without)}`, checks: [check('생산 기준', '11.59%', pct(sens.rateP_with)), check('C-105 제외 시', '7.58%', pct(sens.rateP_without))] };
        },
      },
      {
        title: '모의 AI 상신 준비 → 상신',
        input: '품질팀 상신',
        run: async (s) => {
          const c = caseOf(s);
          const d = await E.prepareSubmissionDraft(s, c.id);
          E.submitCase(s, c.id, {});
          return { summary: `${d.mode} 초안 미확인 항목: ${d.output.unknowns[0]}`, checks: [check('사건 상태', '위원회 상신', c.status)] };
        },
      },
      {
        title: '위원회 회신 [모의] "추가자료 요구: C-105 귀속 확인" → 모의 AI 해석 → 담당자 확정 → 보류·확인요청 2건',
        input: '회신 문장: "추가자료 요구: C-105 클레임 7건(6,445 EA)의 배치 귀속 확인 후 재상신 바람"',
        run: async (s) => {
          const c = caseOf(s);
          const text = '추가자료 요구: C-105 클레임 7건(6,445 EA)의 배치 귀속 확인 후 재상신 바람';
          const d = await E.interpretReply(s, c.id, text);
          E.recordReply(s, c.id, { classification: '추가자료 요구', text, requested_items: d.output.requested_items, actor: '품질위원회 간사(담당자 확정)[모의]' });
          const irs = s.infoRequests.filter((r) => r.caseId === c.id);
          let blocked = false;
          try { E.submitCase(s, c.id, {}); } catch (e) { blocked = true; }
          return { summary: `${c.status} · 확인요청 ${irs.map((r) => r.id + '→' + r.to).join(', ')} · 회신 전 재상신 차단=${blocked}`, checks: [check('AI 분류 제안', '추가자료 요구', d.output.classification), check('사건 상태', '보류(추가자료)', c.status), check('확인요청 수', 2, irs.length), check('회신 전 재상신 차단', 'true', blocked)] };
        },
      },
      {
        title: '확인요청 회신 [모의]: 라벨상 B-02-2603-01 맞음 · SBL 누락 확인 → 판정 유지 → 재상신',
        input: 'info_reply ×2',
        run: async (s) => {
          const c = caseOf(s);
          const irs = s.infoRequests.filter((r) => r.caseId === c.id);
          E.answerInfoRequest(s, irs.find((r) => r.kind === 'C105_LABEL').id, { answer: '귀속 확인(해당 배치 맞음)', note: '제품 라벨 배치 번호 B-02-2603-01[모의]' });
          E.answerInfoRequest(s, irs.find((r) => r.kind === 'C105_SBL').id, { answer: 'SBL 누락 확인', note: '물류 출고 전표 존재, SBL 미등록[모의]' });
          const sub = E.submitCase(s, c.id, {});
          return { summary: `판정 ${j(s, 'B-02-2603-01').status} 유지 · ${sub.id} 재상신`, checks: [check('판정 유지', '회수 대상', j(s, 'B-02-2603-01').status), check('사건 상태', '위원회 상신', c.status)] };
        },
      },
      {
        title: '위원회 승인 [모의] → C-105 포함 회수 범위·통지 생성',
        input: '회신: 회수 승인',
        run: async (s) => {
          const c = caseOf(s);
          E.recordReply(s, c.id, { classification: '승인', text: '회수 승인[모의]' });
          const notices = openTasks(s, c).filter((t) => t.kind === '고객 통지').map((t) => t.customer_id).sort();
          return { summary: `${c.status} · 통지 대상 ${notices.join(', ')}`, checks: [check('C-105 통지 포함', 'true', notices.includes('C-105')), check('사건 상태', '회수 의결', c.status)] };
        },
      },
    ],
  },
};

function listScenarios(state) {
  return Object.entries(SCENARIOS).map(([id, sc]) => ({
    id: Number(id), title: sc.title,
    steps: sc.steps.map((st, i) => ({ index: i, title: st.title, input: st.input })),
    cursor: state.scenario && state.scenario.id === Number(id) ? state.scenario.next : null,
    results: state.scenario && state.scenario.id === Number(id) ? state.scenario.results : [],
  }));
}

async function runStep(state, id) {
  const sc = SCENARIOS[id];
  if (!sc) throw E.httpError(404, '시나리오 없음');
  if (!state.scenario || state.scenario.id !== Number(id)) throw E.httpError(409, '먼저 시나리오 시작(초기화)을 누르세요');
  const i = state.scenario.next;
  if (i >= sc.steps.length) throw E.httpError(409, '모든 단계를 실행했습니다');
  const r = await sc.steps[i].run(state);
  const result = { index: i, title: sc.steps[i].title, input: sc.steps[i].input, ...r, at: new Date().toISOString() };
  state.scenario.results.push(result);
  state.scenario.next = i + 1;
  return result;
}

module.exports = { SCENARIOS, listScenarios, runStep };
