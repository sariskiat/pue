const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const REQUIRED_PATHS = [
  'package.json',
  'main.js',
  'preload.js',
  'verify.js',
  'SPEC.md',
  'SPEC-core-byok-fork.md',
  'SPEC-profile-repo-index.md',
  'SPEC-job-workspaces.md',
  'SPEC-two-speed-context.md',
  'SPEC-copilot-ui.md',
  'docs/intent/pue-interview-copilot.md',
  'tasks/plan.md',
  'tasks/todo.md'
];

const FORBIDDEN_PATHS = [
  'main.py',
  'publik-updater.cjs',
  'publik-update-verify.cjs',
  'renderer/publik-card.js',
  'src/publik.js',
  'src/publik-gate.js',
  'src/publik-gate-preload.cjs',
  'src/publik-ui.js',
  'src/publik-build.json',
  'src/publik-stt-batcher.js',
  'src/applink.js',
  'src/applink-state.js',
  'vendor/app-link',
  'scripts/publik-release.sh',
  'scripts/publik-update-feed.cjs',
  '.github/scripts/publik-self-test.cjs',
  '.github/scripts/live-update-proof.cjs',
  '.github/scripts/updater-electron-crypto.cjs',
  '.github/scripts/updater-proof.cjs',
  '.github/workflows/publik-build.yml',
  '.github/workflows/publik-patch-agent.yml',
  '.github/workflows/live-update-proof.yml',
  '.github/workflows/update-feed.yml',
  '.github/workflows/updater-proof.yml',
  'test/applink.test.js',
  'test/publik.test.js',
  'test/publik-copy.test.js',
  'test/publik-cta.test.js',
  'test/publik-first-r3.test.js',
  'test/publik-module.test.js',
  'test/publik-stt-batcher.test.js',
  'test/publik-update-feed.test.js',
  'test/publik-update-verify.test.js',
  'test/settings-publik-option.test.js',
  'test/store-publik.test.js',
  'test/updater-schedule.test.js',
  'test/updater-wiring.test.js',
  'test/fixtures/update-feed'
];

test('fork layout keeps pue specs and core Electron entrypoints', () => {
  for (const rel of REQUIRED_PATHS) {
    assert.equal(fs.existsSync(path.join(ROOT, rel)), true, `missing ${rel}`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'pue');
});

test('fork layout removes standalone publik, updater, and applink files', () => {
  for (const rel of FORBIDDEN_PATHS) {
    assert.equal(fs.existsSync(path.join(ROOT, rel)), false, `unexpected ${rel}`);
  }
});
