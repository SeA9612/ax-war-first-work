'use strict';
// 상태 저장: 서버 메모리 + data/state.json. 초기 상태는 시드(원본 복사본 + 빈 운영 기록)에서 생성.
const fs = require('fs');
const path = require('path');
const E = require('./engine');

const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, '..', 'data', 'state.json');
const PERSIST = process.env.NODE_ENV !== 'test' && process.env.PERSIST !== 'off';

let state = null;
// 변경 번호(rev): 상태가 바뀔 때마다 올라간다. 화면은 5초마다 이 값만 물어보고, 달라졌을 때만 전체 상태를 다시 받는다.
// 서버가 다시 켜지면 BOOT가 바뀌어 번호가 0부터 시작해도 화면은 '달라짐'으로 알아챈다.
const BOOT = Date.now().toString(36);
let revN = 0;
function bump() { revN += 1; }
function rev() { return BOOT + '-' + revN; }

// 이전 버전이 저장한 state.json에는 이후 추가된 필드가 없다 — 불러올 때 기본값을 채운다(기존 기록은 그대로)
const CASE_DEFAULTS = () => ({ submissions: [], replies: [], aiDrafts: [], approvedBatchIds: [], plan: null, planHistory: [], notes: [], history: [], extensionAtApproval: null, downgraded: false, prevStatus: null, judgmentSnapshot: null });
function migrate(s) {
  if (!s || typeof s !== 'object') return s;
  const seed = E.newState();
  for (const k of Object.keys(seed)) if (s[k] === undefined) s[k] = seed[k];
  if (s.settings && seed.settings) for (const k of Object.keys(seed.settings)) if (s.settings[k] === undefined) s.settings[k] = seed.settings[k];
  (s.cases || []).forEach((c) => {
    const d = CASE_DEFAULTS();
    for (const k of Object.keys(d)) if (c[k] === undefined || (Array.isArray(d[k]) && !Array.isArray(c[k]))) c[k] = d[k];
    if (c.plan) {
      if (c.plan.version == null) c.plan.version = 1;
      if (!c.plan.approvals) c.plan.approvals = {};
      if (c.plan.exception_reason === undefined) c.plan.exception_reason = null;
    }
  });
  return s;
}

function load() {
  if (PERSIST && fs.existsSync(STATE_FILE)) {
    try {
      state = migrate(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
      return state;
    } catch (e) {
      console.error('state.json 읽기 실패 — 시드로 초기화', e.message);
    }
  }
  state = E.newState();
  save();
  return state;
}
function get() { return state || load(); }
function save() {
  bump();
  if (!PERSIST || !state) return;
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
}
function reset(keepSettings) {
  const ext = state ? state.settings.extensionOn : true;
  state = E.newState();
  if (keepSettings) state.settings.extensionOn = ext;
  save();
  return state;
}

// 실패한 요청의 되돌리기(F5)
function replace(next) { state = next; save(); return state; }  // save()가 번호를 올림

// F24: 프로세스 안전망 작동 시 마지막 저장 상태를 다시 읽음. 파일이 없거나 깨졌으면 false(메모리 유지)
function reloadFromDisk(file) {
  const f = file || STATE_FILE;
  if (!file && !PERSIST) return false;
  if (!fs.existsSync(f)) return false;
  try {
    state = migrate(JSON.parse(fs.readFileSync(f, 'utf8')));
    bump();
    return true;
  } catch (e) {
    console.error('state.json 재적재 실패 — 메모리 상태 유지', e.message);
    return false;
  }
}

module.exports = { get, save, reset, load, replace, reloadFromDisk, migrate, rev, STATE_FILE };
