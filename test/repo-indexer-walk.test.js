const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { indexRepository } = require('../src/repo-indexer');

test('indexRepository skips excluded dirs, binaries, minified files, symlink cycles, and out-of-root symlinks', async () => {
  const outerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pue-outer-'));
  const repoDir = path.join(outerDir, 'sample-repo');
  const secretFile = path.join(outerDir, 'outside-secret.txt');

  try {
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'node_modules', 'dep'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, '.git', 'refs', 'heads'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'ignored_out'), { recursive: true });

    fs.writeFileSync(secretFile, 'TOP_SECRET_OUTSIDE_REPO_TOKEN', 'utf8');
    fs.writeFileSync(path.join(repoDir, '.gitignore'), 'ignored_out/\n*.secret\n', 'utf8');
    fs.writeFileSync(path.join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    fs.writeFileSync(path.join(repoDir, '.git', 'refs', 'heads', 'main'), 'abcdef1234567890abcdef1234567890abcdef12\n', 'utf8');

    fs.writeFileSync(
      path.join(repoDir, 'README.md'),
      '# Sample Agent Repo\nReduced p95 queue latency from 420ms to 85ms using bounded worker pools.\n',
      'utf8'
    );
    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'sample-agent', dependencies: { ws: '^8.0.0' } }), 'utf8');
    fs.writeFileSync(path.join(repoDir, 'src', 'worker.py'), 'def run_worker_pool(batch):\n    return len(batch)\n', 'utf8');
    fs.writeFileSync(path.join(repoDir, 'src', 'index.js'), 'function startQueue() { return true; }\nmodule.exports = { startQueue };\n', 'utf8');

    // Excluded artifacts
    fs.writeFileSync(path.join(repoDir, 'node_modules', 'dep', 'index.js'), 'NODE_MODULES_NOISE', 'utf8');
    fs.writeFileSync(path.join(repoDir, 'ignored_out', 'gen.js'), 'GITIGNORED_NOISE', 'utf8');
    fs.writeFileSync(path.join(repoDir, 'key.secret'), 'GITIGNORED_EXT_NOISE', 'utf8');
    fs.writeFileSync(path.join(repoDir, 'app.min.js'), 'var a=1;MINUTE_BUNDLE_NOISE', 'utf8');
    fs.writeFileSync(path.join(repoDir, 'icon.svg'), '<svg>SVG_NOISE</svg>', 'utf8');
    fs.writeFileSync(path.join(repoDir, 'dump.csv'), 'a,b,c\n1,2,3\n', 'utf8');
    fs.writeFileSync(path.join(repoDir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    fs.writeFileSync(path.join(repoDir, 'huge.txt'), 'x'.repeat(270 * 1024), 'utf8');

    // Symlink escape + symlink cycle
    fs.symlinkSync(secretFile, path.join(repoDir, 'src', 'escaped-link.txt'));
    fs.symlinkSync(repoDir, path.join(repoDir, 'src', 'cycle-dir'));

    const record = await indexRepository(repoDir, null, { id: 'repo_sample' });
    assert.equal(record.id, 'repo_sample');
    assert.equal(record.status, 'ok');
    assert.equal(record.headSha, 'abcdef1');
    assert.ok(record.card.summary.length > 0 && record.card.summary.length <= 1200);
    assert.ok(record.card.languages.includes('Python'));
    assert.ok(record.card.languages.includes('JavaScript'));
    assert.ok(record.card.keyFiles.includes('README.md'));

    const allChunkText = record.chunks.map((c) => c.text).join('\n');
    assert.match(allChunkText, /85ms/);
    assert.match(allChunkText, /run_worker_pool/);
    assert.doesNotMatch(allChunkText, /TOP_SECRET_OUTSIDE_REPO_TOKEN/);
    assert.doesNotMatch(allChunkText, /NODE_MODULES_NOISE|GITIGNORED_NOISE|GITIGNORED_EXT_NOISE|MINUTE_BUNDLE_NOISE|SVG_NOISE/);
  } finally {
    fs.rmSync(outerDir, { recursive: true, force: true });
  }
});

test('indexRepository reuses fileMtimes in under 100ms on unchanged 200-file repo and updates changed/deleted files', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pue-200-'));
  try {
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Fast Repo\n', 'utf8');
    for (let i = 0; i < 199; i++) {
      fs.writeFileSync(
        path.join(repoDir, 'src', `mod_${i}.js`),
        `function handler_${i}() {\n  return "value_${i}";\n}\nmodule.exports = { handler_${i} };\n`,
        'utf8'
      );
    }

    const first = await indexRepository(repoDir, null, { id: 'repo_fast' });
    assert.equal(first.fileCount, 200);

    const t0 = performance.now();
    const second = await indexRepository(repoDir, first, { id: 'repo_fast' });
    const elapsedMs = performance.now() - t0;

    assert.ok(elapsedMs < 100, `incremental refresh took ${elapsedMs.toFixed(1)}ms (expected < 100ms)`);
    assert.equal(second.fileCount, 200);
    assert.equal(second.chunks.length, first.chunks.length);

    // Modify one file and delete one file
    const mod0 = path.join(repoDir, 'src', 'mod_0.js');
    const mod1 = path.join(repoDir, 'src', 'mod_1.js');
    fs.unlinkSync(mod1);
    const futureTime = new Date(Date.now() + 5000);
    fs.writeFileSync(mod0, 'function handler_0() { return "UPDATED_SENTINEL_TOKEN"; }\n', 'utf8');
    fs.utimesSync(mod0, futureTime, futureTime);

    const third = await indexRepository(repoDir, second, { id: 'repo_fast' });
    assert.equal(third.fileCount, 199);
    const joined = third.chunks.map((c) => c.text).join('\n');
    assert.match(joined, /UPDATED_SENTINEL_TOKEN/);
    assert.doesNotMatch(joined, /"value_1"/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
