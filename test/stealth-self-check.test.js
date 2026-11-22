const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const mainJs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const preloadJs = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const rendererJs = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');

test('createWindow initializes hidden (show: false) before setContentProtection and uses skipTransformProcessType', () => {
  assert.match(mainJs, /show:\s*false/);
  assert.match(mainJs, /skipTransformProcessType:\s*true/);
  assert.equal(/Microsoft Edge Update/.test(mainJs), false);
});

test('Settings -> Display exposes a live ScreenCaptureKit / WebRTC protection self-check', () => {
  assert.match(mainJs, /display:verify-protection/);
  assert.match(preloadJs, /verifyProtection/);
  assert.match(indexHtml, /id="verify-protection-btn"/);
  assert.match(indexHtml, /id="verify-protection-result"/);
  assert.match(rendererJs, /verify-protection-btn/);
});
