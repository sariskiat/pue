const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');

const RUNTIME_FILES = [
  'main.js',
  'preload.js',
  'electron-builder.cjs',
  'renderer/index.html',
  'renderer/renderer.js',
  'renderer/styles.css'
];

test('runtime and build files contain zero publik, applink, or auto-updater references', () => {
  const forbidden = /publik|applink|app-link|ensureSignedIn|startUpdates|updatesCheck|updates:message/i;
  for (const rel of RUNTIME_FILES) {
    const content = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const match = forbidden.exec(content);
    assert.equal(match, null, `unexpected "${match && match[0]}" in ${rel}`);
  }
});

test('preload exposes clean BYOK bridge without publik, applink, or updates channels', () => {
  let exposedApi = null;
  const listeners = [];
  const origLoad = Module._load;
  Module._load = function stubElectron(req, parent, isMain) {
    if (req === 'electron') {
      return {
        contextBridge: {
          exposeInMainWorld(_name, api) {
            exposedApi = api;
          }
        },
        ipcRenderer: {
          invoke: () => Promise.resolve(null),
          send: () => {},
          on: (ch) => listeners.push(ch)
        }
      };
    }
    return origLoad.call(this, req, parent, isMain);
  };

  try {
    delete require.cache[require.resolve('../preload')];
    require('../preload');
    assert.ok(exposedApi, 'preload should expose window.pue');
    for (const key of Object.keys(exposedApi)) {
      assert.equal(/^(publik|appLink|updates)/i.test(key), false, `unexpected method ${key}`);
    }
    exposedApi.on('publik:state', () => {});
    exposedApi.on('updates:message', () => {});
    exposedApi.on('applink:consent-request', () => {});
    exposedApi.on('llm:token', () => {});
    assert.deepEqual(listeners, ['llm:token']);
  } finally {
    Module._load = origLoad;
  }
});
