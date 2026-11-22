const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createInterviewerHoldController } = require('../src/stt-streaming');

const ROOT = path.join(__dirname, '..');
const mainJs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const preloadJs = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const rendererJs = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');

test('Scenario 1 & 2: During an active session, hold commits prior "you" speech, routes mic to "them", and on release commits "them" without stopping session or calling LLM', async () => {
  const calls = [];
  let capturing = true;
  const ctrl = createInterviewerHoldController({
    isCapturing: () => capturing,
    ensureCapturing: async () => { calls.push('ensureCapturing'); capturing = true; return true; },
    stopCapturing: async () => { calls.push('stopCapturing'); capturing = false; },
    commitChannel: (ch) => calls.push(`commit:${ch}`),
    flushChannel: (ch) => calls.push(`flush:${ch}`),
    onHoldStateChange: (active) => calls.push(`state:${active}`),
    drainMs: 50
  });

  assert.equal(ctrl.resolveMicChannel(), 'you');
  await ctrl.setHold(true);
  assert.equal(ctrl.isActive(), true);
  assert.equal(ctrl.resolveMicChannel(), 'them');
  assert.deepEqual(calls, ['commit:you', 'flush:you', 'state:true']);

  await ctrl.setHold(false);
  assert.equal(ctrl.isActive(), false);
  assert.equal(ctrl.resolveMicChannel(), 'you');
  assert.deepEqual(calls, ['commit:you', 'flush:you', 'state:true', 'state:false', 'commit:them', 'flush:them']);

  await new Promise((r) => setTimeout(r, 70));
  assert.equal(capturing, true, 'existing session must keep running after hold release');
  assert.equal(calls.includes('stopCapturing'), false);
});

test('Scenario 3: When session is off, hold starts on-demand capture, commits "them" on release, drains final turn, then stops capture', async () => {
  const calls = [];
  let capturing = false;
  const ctrl = createInterviewerHoldController({
    isCapturing: () => capturing,
    ensureCapturing: async () => { calls.push('ensureCapturing'); capturing = true; return true; },
    stopCapturing: async () => { calls.push('stopCapturing'); capturing = false; },
    commitChannel: (ch) => calls.push(`commit:${ch}`),
    flushChannel: (ch) => calls.push(`flush:${ch}`),
    onHoldStateChange: (active) => calls.push(`state:${active}`),
    drainMs: 120
  });

  await ctrl.setHold(true);
  assert.equal(capturing, true);
  assert.equal(ctrl.resolveMicChannel(), 'them');

  await ctrl.setHold(false);
  assert.equal(ctrl.isActive(), false);
  assert.equal(ctrl.resolveMicChannel(), 'you');
  assert.equal(capturing, true, 'must stay open briefly so committed OpenAI turn can arrive');

  // When the final "them" transcript turn arrives, drain completes immediately
  ctrl.onThemTurnSettled();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(capturing, false);
  assert.equal(calls.includes('stopCapturing'), true);
});

test('Scenario 4: toggle() flips hold state and main/preload/renderer wire #hold-them-btn, Alt+Space, and CommandOrControl+Shift+L without auto-asking', async () => {
  let capturing = true;
  const ctrl = createInterviewerHoldController({
    isCapturing: () => capturing,
    ensureCapturing: async () => true,
    stopCapturing: async () => {},
    commitChannel: () => {},
    flushChannel: () => {},
    onHoldStateChange: () => {}
  });
  assert.equal(await ctrl.toggle(), true);
  assert.equal(await ctrl.toggle(), false);

  assert.match(mainJs, /CommandOrControl\+Shift\+L/);
  assert.match(mainJs, /capture:interviewer-hold/);
  assert.match(preloadJs, /interviewerHoldSet/);
  assert.match(preloadJs, /interviewerHoldToggle/);
  assert.match(indexHtml, /id="hold-them-btn"/);
  assert.match(rendererJs, /hold-them-btn/);
  assert.match(rendererJs, /e\.altKey && e\.code === 'Space'/);
});
