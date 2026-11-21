const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveScopedPath, TOOL_DEFINITIONS, createScopedToolbox } = require('../src/repo-tools');

test('resolveScopedPath blocks traversal and symlink escapes, skips deleted roots, and resolves missing leaf targets', () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'pue-jail-'));
  const allowedDir = path.join(outer, 'allowed-repo');
  const staleDir = path.join(outer, 'deleted-repo');
  const outsideFile = path.join(outer, 'secret.env');
  fs.mkdirSync(path.join(allowedDir, 'src'), { recursive: true });
  fs.writeFileSync(outsideFile, 'SECRET_KEY=123', 'utf8');
  fs.writeFileSync(path.join(allowedDir, 'src', 'ok.js'), 'module.exports = 1;\n', 'utf8');
  fs.symlinkSync(outsideFile, path.join(allowedDir, 'src', 'escape-link.env'));

  try {
    const roots = [staleDir, allowedDir];

    const valid = resolveScopedPath(path.join(allowedDir, 'src', 'ok.js'), roots);
    assert.equal(valid, fs.realpathSync(path.join(allowedDir, 'src', 'ok.js')));

    const missingInRoot = resolveScopedPath(path.join(allowedDir, 'src', 'does-not-exist.js'), roots);
    assert.ok(missingInRoot.startsWith(fs.realpathSync(allowedDir)));

    assert.throws(() => resolveScopedPath(path.join(allowedDir, '..', 'secret.env'), roots), /Access denied/);
    assert.throws(() => resolveScopedPath('/etc/passwd', roots), /Access denied/);
    assert.throws(() => resolveScopedPath(path.join(allowedDir, 'src', 'escape-link.env'), roots), /Access denied/);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('createScopedToolbox enforces caps, skips excluded/binary files, and wraps outputs in untrusted_context', async () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'pue-tools-'));
  const repoA = path.join(outer, 'alpha');
  const outsideSecret = path.join(outer, 'outside.txt');
  fs.mkdirSync(path.join(repoA, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repoA, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(outsideSecret, 'OUTSIDE_DATA', 'utf8');
  fs.writeFileSync(path.join(repoA, 'node_modules', 'pkg', 'index.js'), 'FINDME_TOKEN_HIDDEN', 'utf8');
  fs.writeFileSync(path.join(repoA, 'src', 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x46, 0x49]));
  fs.symlinkSync(outsideSecret, path.join(repoA, 'src', 'badlink.txt'));

  const longLines = Array.from({ length: 260 }, (_, i) => `const FINDME_TOKEN_${i + 1} = ${i + 1};`).join('\n');
  fs.writeFileSync(path.join(repoA, 'src', 'worker.js'), longLines + '\n', 'utf8');

  try {
    assert.equal(TOOL_DEFINITIONS.length, 3);
    const toolbox = createScopedToolbox([{ name: 'alpha', path: repoA }]);

    const listed = await toolbox.executeTool('list_files', { rootName: 'alpha' });
    assert.match(listed.content, /<untrusted_context source="list_files:alpha">/);
    assert.match(listed.content, /src\/worker\.js/);
    assert.doesNotMatch(listed.content, /node_modules/);
    assert.doesNotMatch(listed.content, /badlink\.txt/);

    const grepped = await toolbox.executeTool('grep_files', { query: 'FINDME_TOKEN', maxMatches: 10 });
    assert.match(grepped.content, /<untrusted_context source="grep_files">/);
    assert.match(grepped.content, /alpha\/src\/worker\.js:1:/);
    assert.doesNotMatch(grepped.content, /node_modules/);
    const matchLines = grepped.content.split('\n').filter((l) => l.startsWith('alpha/src/worker.js:'));
    assert.equal(matchLines.length, 10, 'grep_files respects maxMatches');

    const readOut = await toolbox.executeTool('read_file', { rootName: 'alpha', relPath: 'src/worker.js', startLine: 1, endLine: 250 });
    assert.match(readOut.content, /<untrusted_context source="alpha\/src\/worker\.js:1-200">/);
    assert.match(readOut.content, /\[Truncated: showing lines 1-200 of 26[01]/);
    assert.equal(readOut.content.length <= 8500, true);

    const escaped = await toolbox.executeTool('read_file', { rootName: 'alpha', relPath: '../outside.txt' });
    assert.equal(escaped.isError, true);
    assert.match(escaped.content, /Access denied/);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});
