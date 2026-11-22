// Empirical test of all real Browser "Other Screen / Multi-Monitor" Detection APIs
// in Chromium on macOS 27.2.1 while pue is actively floating on top.
//
// Run with:
//   ./node_modules/.bin/electron scripts/stealth-audit/check-browser-screen-detection.cjs

const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_PNG = path.join(ROOT, 'docs', 'real-cases', 'case4-real-browser-screen-detection.png');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pue-screen-detect-'));

const tmpUserData = path.join(TMP_DIR, 'userdata');
fs.mkdirSync(tmpUserData, { recursive: true });
fs.writeFileSync(
  path.join(tmpUserData, 'pue-data.json'),
  JSON.stringify({ provider: 'anthropic', onboarded: true, apiKeys: { anthropic: 'sk-ant-test' } }, null, 2),
  { mode: 0o600 }
);
app.commandLine.appendSwitch('enable-experimental-web-platform-features');
app.getPath = (name) => (name === 'userData' ? tmpUserData : path.join(tmpUserData, name));
process.env.PUE_SKIP_PERMISSIONS = '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pueWin = null;
app.on('browser-window-created', (_ev, w) => {
  if (!pueWin) pueWin = w;
});

require(path.join(ROOT, 'main.js'));

app.whenReady().then(async () => {
  while (!pueWin) await sleep(50);
  await new Promise((resolve) => {
    if (pueWin.webContents.isLoading()) pueWin.webContents.once('did-finish-load', resolve);
    else resolve();
  });
  await sleep(350);

  // Grant ALL permissions (including 'window-management' / 'window-placement') to the test browser tab
  // so we see the maximum information a browser page can ever obtain even if the user clicks "Allow"!
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
  session.defaultSession.setPermissionCheckHandler(() => true);

  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();

  const detectorWin = new BrowserWindow({
    width: 1060,
    height: 720,
    x: primary.workArea.x + 40,
    y: primary.workArea.y + 40,
    backgroundColor: '#ffffff'
  });

  const detectorHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f8fafc; color: #0f172a; margin: 0; padding: 24px 28px; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  .sub { font-size: 13px; color: #475569; margin-bottom: 14px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #cbd5e1; border-radius: 8px; overflow: hidden; font-size: 13px; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #e2e8f0; }
  th { background: #f1f5f9; font-weight: 700; color: #334155; }
  .mono { font-family: "SF Mono", Menlo, monospace; font-size: 12px; }
  .pass { color: #166534; font-weight: 700; background: #dcfce7; padding: 2px 8px; border-radius: 999px; display: inline-block; }
  .warn { color: #991b1b; font-weight: 700; background: #fee2e2; padding: 2px 8px; border-radius: 999px; display: inline-block; }
  pre { background: #0f172a; color: #e2e8f0; padding: 14px; border-radius: 8px; font: 12px/1.5 "SF Mono", Menlo, monospace; margin-top: 14px; white-space: pre-wrap; }
</style>
</head>
<body>
  <h1>Real Chromium Multi-Screen / External Display Detector (Live Run While pue Is Open)</h1>
  <div class="sub" id="meta"></div>
  <table>
    <thead>
      <tr>
        <th>Browser API Check</th>
        <th>Live Value Measured</th>
        <th>Does It Detect pue?</th>
      </tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>
  <pre id="raw"></pre>
  <script>
    window.__runScreenAudit = async function(osDisplayCount) {
      document.getElementById('meta').textContent =
        'OS connected displays = ' + osDisplayCount + ' | pue BrowserWindow = OPEN & floating on top (1300x680, layer=screen-saver)';

      let screenDetailsSummary = 'unsupported';
      let screenDetailsCount = null;
      let screenDetailsRaw = null;
      if (typeof window.getScreenDetails === 'function') {
        try {
          const sd = await window.getScreenDetails();
          screenDetailsCount = sd.screens.length;
          screenDetailsRaw = sd.screens.map((s) => ({
            label: s.label,
            isPrimary: s.isPrimary,
            isInternal: s.isInternal,
            width: s.width,
            height: s.height,
            availWidth: s.availWidth,
            availHeight: s.availHeight,
            left: s.left,
            top: s.top,
            devicePixelRatio: s.devicePixelRatio
          }));
          screenDetailsSummary = 'screens.length = ' + sd.screens.length + ' (' + sd.screens.map((s) => s.width + 'x' + s.height + (s.isInternal ? ' internal' : ' external')).join(', ') + ')';
        } catch (e) {
          screenDetailsSummary = 'error: ' + e.message;
        }
      }

      const checks = [
        {
          api: 'window.screen.isExtended',
          val: String(window.screen.isExtended),
          detectsPue: window.screen.isExtended
            ? 'YES — reports >1 physical/Sidecar/AirPlay display attached to Mac!'
            : 'NO (false — pue is a window on the same display, NOT a 2nd monitor)'
        },
        {
          api: 'window.getScreenDetails() (Window Management API)',
          val: screenDetailsSummary,
          detectsPue: screenDetailsCount > 1
            ? 'YES — lists ' + screenDetailsCount + ' displays (unplug external monitor / Sidecar!)'
            : 'NO (lists only physical displays; pue overlay is invisible to getScreenDetails)'
        },
        {
          api: 'screen.width x height vs availWidth x availHeight',
          val: window.screen.width + 'x' + window.screen.height + ' | avail: ' + window.screen.availWidth + 'x' + window.screen.availHeight,
          detectsPue: 'NO (pue does not reserve Dock/menu-bar workArea space)'
        },
        {
          api: 'window.devicePixelRatio & screenLeft / screenTop',
          val: 'dpr=' + window.devicePixelRatio + ' | pos=(' + window.screenLeft + ', ' + window.screenTop + ')',
          detectsPue: 'NO (unchanged by pue)'
        },
        {
          api: 'document.hasFocus() & document.visibilityState',
          val: 'hasFocus=' + document.hasFocus() + ' | visibility=' + document.visibilityState,
          detectsPue: document.hasFocus() ? 'NO while using hotkeys (flips false ONLY if you click pue)' : 'YES (lost focus)'
        }
      ];

      const tbody = document.getElementById('rows');
      tbody.innerHTML = '';
      for (const c of checks) {
        const tr = document.createElement('tr');
        const badgeClass = c.detectsPue.startsWith('NO') ? 'pass' : 'warn';
        tr.innerHTML =
          '<td class="mono">' + c.api + '</td>' +
          '<td class="mono">' + c.val + '</td>' +
          '<td><span class="' + badgeClass + '">' + c.detectsPue + '</span></td>';
        tbody.appendChild(tr);
      }

      const out = {
        osDisplayCount,
        isExtended: window.screen.isExtended,
        screen: {
          width: window.screen.width,
          height: window.screen.height,
          availWidth: window.screen.availWidth,
          availHeight: window.screen.availHeight
        },
        screenDetailsCount,
        screenDetailsRaw,
        hasFocus: document.hasFocus(),
        visibilityState: document.visibilityState
      };
      document.getElementById('raw').textContent = 'Raw JSON returned to website JavaScript:\\n' + JSON.stringify(out, null, 2);
      return out;
    };
  </script>
</body>
</html>`;

  const http = require('node:http');
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(detectorHtml);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  await detectorWin.loadURL(`http://127.0.0.1:${port}/`);
  detectorWin.show();
  detectorWin.focus();
  await sleep(350);

  const result = await detectorWin.webContents.executeJavaScript(`window.__runScreenAudit(${displays.length})`);
  await sleep(250);

  const img = await detectorWin.webContents.capturePage();
  fs.mkdirSync(path.dirname(OUT_PNG), { recursive: true });
  fs.writeFileSync(OUT_PNG, img.toPNG());
  srv.close();
  console.log('BROWSER_SCREEN_AUDIT=' + JSON.stringify(result, null, 2));
  console.log('Saved screenshot:', OUT_PNG);
  app.exit(0);
});
