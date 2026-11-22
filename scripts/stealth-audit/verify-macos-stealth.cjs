// Empirical macOS screen-share stealth benchmark for pue.
// Runs two passes in real Electron on this Mac:
//   Pass 1 (CONTROL, PUE_NO_PROTECT=1): proves all capture pipelines see the #FF00FF marker when unprotected.
//   Pass 2 (PROTECTED, default): proves exact pixel & window-list behavior across:
//     1. Apple ScreenCaptureKit full-display capture (Zoom / Teams / OBS / QuickTime / Meet native)
//     2. Apple ScreenCaptureKit shareable window list & forced desktopIndependentWindow capture
//     3. Chromium WebRTC desktopCapturer (Chrome / Edge / Arc / Google Meet / Teams Web / CoderPad)
//     4. macOS native /usr/sbin/screencapture compositor screenshot
//     5. NSRunningApplication activationPolicy (Cmd+Tab & Dock visibility) & frontmost focus theft
//
// Run with one command:
//   node scripts/stealth-audit/verify-macos-stealth.cjs

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const PROBE_SRC = path.join(__dirname, 'macos-probe.swift');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pue-stealth-audit-'));
const PROBE_BIN = path.join(TMP_DIR, 'macos-probe');
const ELECTRON_CHILD = path.join(TMP_DIR, 'electron-harness.cjs');

if (process.platform !== 'darwin') {
  console.error('verify-macos-stealth.cjs requires macOS.');
  process.exit(1);
}

console.log('[1/3] Compiling Swift ScreenCaptureKit + AppKit + CoreGraphics probe...');
execFileSync('swiftc', ['-parse-as-library', '-O', PROBE_SRC, '-o', PROBE_BIN], { stdio: 'inherit' });

fs.writeFileSync(
  ELECTRON_CHILD,
  `
const { app, desktopCapturer } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const tmpUserData = process.env.PUE_AUDIT_USERDATA;
app.getPath = (name) => (name === 'userData' ? tmpUserData : path.join(tmpUserData, name));

fs.mkdirSync(tmpUserData, { recursive: true });
fs.writeFileSync(
  path.join(tmpUserData, 'pue-data.json'),
  JSON.stringify({ provider: 'openai', onboarded: true, apiKeys: { openai: 'sk-test' } }, null, 2),
  { mode: 0o600 }
);

function countMagentaInNativeImage(img) {
  if (!img || img.isEmpty()) return 0;
  const bmp = img.toBitmap(); // BGRA on macOS/little-endian
  let hits = 0;
  for (let i = 0; i + 3 < bmp.length; i += 4) {
    const b = bmp[i];
    const g = bmp[i + 1];
    const r = bmp[i + 2];
    if (r >= 235 && g <= 25 && b >= 235) hits++;
  }
  return hits;
}

app.on('browser-window-created', (_ev, win) => {
  win.webContents.once('did-finish-load', async () => {
    try {
      await new Promise((r) => setTimeout(r, 350));
      // Paint a pure #FF00FF magenta surface on #panel inside pue's overlay window
      await win.webContents.executeJavaScript(\`(() => {
        const panel = document.getElementById('panel');
        if (panel) panel.style.cssText += ';background:#ff00ff !important;backdrop-filter:none !important;';
      })()\`);
      await new Promise((r) => setTimeout(r, 350));

      // Verify pue's own webContents actually rendered the magenta block to GPU
      const selfPage = await win.webContents.capturePage();
      const selfMagentaPixels = countMagentaInNativeImage(selfPage);

      // macOS /usr/sbin/screencapture -x
      const shotPath = path.join(${JSON.stringify(TMP_DIR)}, 'screencapture-' + process.pid + '.png');
      try {
        execFileSync('/usr/sbin/screencapture', ['-x', shotPath]);
      } catch (_) {}

      // Chromium WebRTC desktopCapturer (screen + window)
      let webRtcScreenMagentaPixels = null;
      let webRtcWindowMatches = null;
      let webRtcError = null;
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 1440, height: 900 }
        });
        const screenSources = sources.filter((s) => s.id.startsWith('screen:'));
        const windowSources = sources.filter((s) => s.id.startsWith('window:'));
        webRtcScreenMagentaPixels = screenSources.reduce((sum, s) => sum + countMagentaInNativeImage(s.thumbnail), 0);
        webRtcWindowMatches = windowSources.filter((s) =>
          /pue|Microsoft Edge Update/i.test(s.name || '') || countMagentaInNativeImage(s.thumbnail) > 50
        ).length;
      } catch (e) {
        webRtcError = e && e.message ? e.message : String(e);
      }

      // Swift ScreenCaptureKit + AppKit + CGWindowList probe
      const rawProbe = execFileSync(${JSON.stringify(PROBE_BIN)}, ['--pid', String(process.pid), '--png', shotPath], {
        encoding: 'utf8'
      });
      const probe = JSON.parse(rawProbe.trim());

      console.log('STEALTH_JSON=' + JSON.stringify({
        selfRenderedMagentaPixels: selfMagentaPixels,
        webRtcScreenMagentaPixels,
        webRtcWindowMatches,
        webRtcError,
        ...probe
      }));
      app.exit(0);
    } catch (err) {
      console.error('HARNESS_ERR', err);
      app.exit(1);
    }
  });
});

require(${JSON.stringify(path.join(ROOT, 'main.js'))});
`
);

function runPass(label, protect) {
  const userData = fs.mkdtempSync(path.join(TMP_DIR, `ud-${label}-`));
  const env = {
    ...process.env,
    PUE_SKIP_PERMISSIONS: '1',
    PUE_AUDIT_USERDATA: userData
  };
  if (protect) delete env.PUE_NO_PROTECT;
  else env.PUE_NO_PROTECT = '1';

  const electronBin = path.join(ROOT, 'node_modules', '.bin', 'electron');
  const res = spawnSync(electronBin, [ELECTRON_CHILD], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 30000
  });
  const line = (res.stdout || '').split('\n').find((l) => l.startsWith('STEALTH_JSON='));
  if (!line) {
    console.error(`Pass ${label} failed:`, res.stdout, res.stderr);
    process.exit(1);
  }
  return JSON.parse(line.slice('STEALTH_JSON='.length));
}

console.log('[2/3] Running Pass 1: UNPROTECTED CONTROL (PUE_NO_PROTECT=1)...');
const control = runPass('control', false);
console.log('CONTROL =', JSON.stringify(control, null, 2));

console.log('[3/3] Running Pass 2: PROTECTED (live pue settings)...');
const protectedRun = runPass('protected', true);
console.log('PROTECTED =', JSON.stringify(protectedRun, null, 2));
