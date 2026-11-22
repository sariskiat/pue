const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EXPECTED_DELETE_COUNT = 38;

const PROTECTED_TOP_ENTRIES = new Set([
  '.git',
  '.idea',
  '.gitignore',
  'SPEC.md',
  'SPEC-core-byok-fork.md',
  'SPEC-profile-repo-index.md',
  'SPEC-job-workspaces.md',
  'SPEC-two-speed-context.md',
  'SPEC-copilot-ui.md',
  'tasks'
]);

const DELETE_RULES = [
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

// Copy upstream files without clobbering local specs, intent, or git metadata.
function copyTreePreservingProtected(srcRoot, dstRoot, relDir = '') {
  const srcDir = relDir ? path.join(srcRoot, relDir) : srcRoot;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const relPath = relDir ? path.posix.join(relDir, entry.name) : entry.name;
    if (!relDir && PROTECTED_TOP_ENTRIES.has(entry.name)) continue;
    if (relPath === 'docs/intent' || relPath === 'test/core-fork-layout.test.js') continue;
    if (relPath === 'scripts/bootstrap-clean-fork.js') continue;
    const srcTarget = path.join(srcRoot, relPath);
    const dstTarget = path.join(dstRoot, relPath);
    if (entry.isDirectory()) {
      fs.mkdirSync(dstTarget, { recursive: true });
      copyTreePreservingProtected(srcRoot, dstRoot, relPath);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(dstTarget), { recursive: true });
      fs.copyFileSync(srcTarget, dstTarget);
      fs.chmodSync(dstTarget, fs.statSync(srcTarget).mode);
    }
  }
}

function main() {
  const srcRoot = process.argv[2];
  const dstRoot = path.resolve(__dirname, '..');
  if (!srcRoot || !fs.existsSync(srcRoot)) {
    throw new Error('Pass path to cloned Blueturboguy07/pue repository as argv[2].');
  }

  copyTreePreservingProtected(srcRoot, dstRoot);

  // Build delete list by rule and halt on any count mismatch before removing files.
  const matched = DELETE_RULES.filter((rel) => fs.existsSync(path.join(dstRoot, rel)));
  assert.equal(
    matched.length,
    EXPECTED_DELETE_COUNT,
    `Delete list count ${matched.length} !== expected ${EXPECTED_DELETE_COUNT}`
  );
  for (const rel of matched) {
    fs.rmSync(path.join(dstRoot, rel), { recursive: true, force: false });
  }

  const pkgPath = path.join(dstRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.name = 'pue';
  pkg.description = 'Local candidate interview copilot with global repo index and per-job workspaces.';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

  console.log(`Seeded pue and removed ${matched.length} standalone files/folders.`);
}

main();
