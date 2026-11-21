const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const { createProfileStore } = require('../src/profile-store');

test('profile-store persists docs and repos with 0600 mode and updates listAllowedRoots immediately', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pue-prof-'));
  const userData = path.join(tmpRoot, 'userdata');
  const docsDir = path.join(tmpRoot, 'docs');
  const repoDir = path.join(tmpRoot, 'my-service');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });

  try {
    const resumeFile = path.join(docsDir, 'resume.md');
    fs.writeFileSync(resumeFile, '# Jane Doe\nBuilt low-latency inference router.\n', 'utf8');
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# My Service\nHandles 12k RPS.\n', 'utf8');
    fs.writeFileSync(path.join(repoDir, 'src', 'router.js'), 'function routeRequest() { return 200; }\n', 'utf8');

    const store1 = createProfileStore(() => userData);
    const docRec = await store1.addDocument(resumeFile, 'resume');
    const repoRec = await store1.addRepo(repoDir);

    assert.equal(docRec.status, 'ok');
    assert.ok(docRec.chunks.length >= 1);
    assert.equal(repoRec.status, 'ok');
    assert.equal(repoRec.fileCount, 2);

    const roots = store1.listAllowedRoots();
    assert.equal(roots.length, 1);
    assert.equal(roots[0], fs.realpathSync(repoDir));

    const indexPath = path.join(userData, 'profile-index.json');
    const mode = fs.statSync(indexPath).mode & 0o777;
    assert.equal(mode, 0o600);

    // Reload from disk in fresh instance
    const store2 = createProfileStore(() => userData);
    assert.equal(store2.getProfile().documents.length, 1);
    assert.equal(store2.getProfile().repos.length, 1);
    assert.equal(store2.getAllChunks().length >= 2, true);

    await store2.reindexAll();
    assert.equal(store2.getProfile().repos[0].fileCount, 2);

    store2.removeItem(repoRec.id);
    assert.deepEqual(store2.listAllowedRoots(), []);
    assert.equal(store2.getProfile().repos.length, 0);

    store2.removeItem(docRec.id);
    assert.equal(store2.getProfile().documents.length, 0);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('seedFromLegacy imports legacy resumeText and starStories once', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pue-prof-seed-'));
  try {
    const store = createProfileStore(() => userData);
    const seeded = await store.seedFromLegacy({
      resumeText: 'Principal Engineer at Acme',
      starStories: 'Situation: Outage. Action: Added circuit breaker. Result: Zero downtime.'
    });
    assert.equal(seeded, true);
    assert.equal(store.getProfile().documents.length, 1);
    assert.match(store.getAllChunks().map((c) => c.text).join('\n'), /circuit breaker/);

    const second = await store.seedFromLegacy({ resumeText: 'Duplicate' });
    assert.equal(second, false);
    assert.equal(store.getProfile().documents.length, 1);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('promoteGlobalLesson and deprecateGlobalLesson preserve history with supersession', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pue-prof-les-'));
  try {
    const store = createProfileStore(() => userData);
    const first = store.promoteGlobalLesson({
      topic: 'latency_metrics',
      guidance: 'Always state P95 and P99 numbers.',
      sourceWorkspaceId: 'ws_1'
    });
    assert.equal(first.status, 'accepted');

    const second = store.promoteGlobalLesson({
      topic: 'latency_metrics',
      guidance: 'State P50, P95, P99, and RPS load.',
      sourceWorkspaceId: 'ws_2',
      supersedesId: first.id
    });
    assert.equal(second.status, 'accepted');
    assert.equal(second.supersedesId, first.id);

    const all = store.getProfile().promotedLessons;
    assert.equal(all.length, 2);
    assert.equal(all.find((l) => l.id === first.id).status, 'superseded');
    assert.equal(store.getActiveLessons().length, 1);
    assert.equal(store.getActiveLessons()[0].id, second.id);

    store.deprecateGlobalLesson(second.id);
    assert.equal(store.getActiveLessons().length, 0);
    assert.equal(store.getProfile().promotedLessons.length, 2);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('preload exposes profile:* methods and profile:changed listener channel', () => {
  let exposed = null;
  const channels = [];
  const origLoad = Module._load;
  Module._load = function stub(req, parent, isMain) {
    if (req === 'electron') {
      return {
        contextBridge: { exposeInMainWorld: (_k, api) => { exposed = api; } },
        ipcRenderer: { invoke: () => Promise.resolve(null), send: () => {}, on: (ch) => channels.push(ch) }
      };
    }
    return origLoad.call(this, req, parent, isMain);
  };
  try {
    delete require.cache[require.resolve('../preload')];
    require('../preload');
    for (const fn of ['profileGet', 'profileAddDoc', 'profileAddRepo', 'profileRemoveItem', 'profileReindex', 'profileDeprecateLesson']) {
      assert.equal(typeof exposed[fn], 'function', `missing preload method ${fn}`);
    }
    exposed.on('profile:changed', () => {});
    assert.deepEqual(channels, ['profile:changed']);
  } finally {
    Module._load = origLoad;
  }
});
