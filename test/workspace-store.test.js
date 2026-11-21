const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createWorkspaceStore } = require('../src/workspace-store');

test('workspace-store isolates memory, search, files, and allowedRoots strictly per workspace', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pue-ws-'));
  const userData = path.join(tmpRoot, 'userdata');
  const filesDir = path.join(tmpRoot, 'files');
  const testRepoA = path.join(tmpRoot, 'takehome-a');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(filesDir, { recursive: true });
  fs.mkdirSync(path.join(testRepoA, 'src'), { recursive: true });

  try {
    const jdA = path.join(filesDir, 'acme-jd.md');
    const jdB = path.join(filesDir, 'beta-jd.md');
    fs.writeFileSync(jdA, '# Acme Staff Engineer\nMust know distributed consensus and Raft.\n', 'utf8');
    fs.writeFileSync(jdB, '# Beta ML Engineer\nFocus on PyTorch quantization.\n', 'utf8');
    fs.writeFileSync(path.join(testRepoA, 'src', 'raft.js'), 'function appendEntries() { return true; }\n', 'utf8');

    const store = createWorkspaceStore(() => userData, { debounceMs: 0 });
    const wsA = store.createWorkspace({ company: 'Acme', role: 'Staff Engineer' });
    await store.attachWorkspaceFile(wsA.id, jdA, 'jd');
    await store.attachWorkspaceFile(wsA.id, testRepoA, 'test');

    const rndA1 = wsA.activeRoundId;
    store.appendRoundEvent(wsA.id, rndA1, { type: 'transcript_turn', channel: 'them', text: 'Explain your Raft election timeout.' });
    store.appendRoundEvent(wsA.id, rndA1, { type: 'transcript_turn', channel: 'you', text: 'We used randomized 150-300ms timers.' });
    store.updateRoundMeta(wsA.id, rndA1, {
      endedAt: Date.now(),
      status: 'dissected',
      dissection: {
        roundSummary: 'Covered Acme Raft election timers and split-vote handling.',
        nextRoundCheckpoint: {
          settledTopics: ['Raft basics'],
          openWeaknessesToRepair: ['Log compaction snapshots'],
          promisedFollowUps: []
        }
      }
    });
    const rndA2 = store.createRound(wsA.id, 'Round 2 - System Design');

    const wsB = store.createWorkspace({ company: 'Beta', role: 'ML Engineer' });
    await store.attachWorkspaceFile(wsB.id, jdB, 'jd');

    const memA = store.workspaceMemoryBlock(wsA.id, rndA2.id);
    const memB = store.workspaceMemoryBlock(wsB.id, wsB.activeRoundId);
    assert.match(memA, /Acme Raft election timers/);
    assert.match(memA, /Log compaction snapshots/);
    assert.equal(memB, '');

    assert.equal(store.searchWorkspaceRounds(wsA.id, 'Raft').length, 1);
    assert.equal(store.searchWorkspaceRounds(wsB.id, 'Raft').length, 0);

    const rootsA = store.allowedRootsForWorkspace(wsA.id);
    const rootsB = store.allowedRootsForWorkspace(wsB.id);
    assert.deepEqual(rootsA, [fs.realpathSync(testRepoA)]);
    assert.deepEqual(rootsB, []);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('appendRoundEvent rolls back leafId on disk write error without breaking parent chain', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pue-ws-rollback-'));
  let failNextWrite = false;

  try {
    const store = createWorkspaceStore(() => userData, {
      debounceMs: 0,
      appendLineFn(filePath, content, isNew) {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error('ENOSPC simulated disk full');
        }
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        if (isNew) fs.writeFileSync(filePath, content, { mode: 0o600 });
        else fs.appendFileSync(filePath, content, { mode: 0o600 });
      }
    });

    const ws = store.createWorkspace({ company: 'TestCo', role: 'SWE' });
    const roundId = ws.activeRoundId;

    const e1 = store.appendRoundEvent(ws.id, roundId, { type: 'transcript_turn', channel: 'them', text: 'First turn' });
    const e2 = store.appendRoundEvent(ws.id, roundId, { type: 'transcript_turn', channel: 'you', text: 'Second turn' });
    assert.equal(e2.parentId, e1.id);

    failNextWrite = true;
    assert.throws(() => {
      store.appendRoundEvent(ws.id, roundId, { type: 'transcript_turn', channel: 'them', text: 'Failed turn' });
    }, /ENOSPC/);

    const e4 = store.appendRoundEvent(ws.id, roundId, { type: 'transcript_turn', channel: 'them', text: 'Recovered fourth turn' });
    assert.equal(e4.parentId, e2.id, 'parentId must still point to e2 after failed write');

    const storeReloaded = createWorkspaceStore(() => userData, { debounceMs: 0 });
    const proj = storeReloaded.buildRoundProjection(ws.id, roundId);
    assert.deepEqual(
      proj.transcript.map((t) => t.text),
      ['First turn', 'Second turn', 'Recovered fourth turn']
    );
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('clearRoundTranscript archives old JSONL non-destructively and buildRoundProjection honors compaction', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pue-ws-clear-'));
  try {
    const store = createWorkspaceStore(() => userData, { debounceMs: 0 });
    const ws = store.createWorkspace({ company: 'Gamma', role: 'Backend' });
    const r1 = ws.activeRoundId;

    const t1 = store.appendRoundEvent(ws.id, r1, { type: 'transcript_turn', channel: 'them', text: 'Old question 1' });
    const t2 = store.appendRoundEvent(ws.id, r1, { type: 'transcript_turn', channel: 'you', text: 'Old answer 1' });
    const t3 = store.appendRoundEvent(ws.id, r1, { type: 'transcript_turn', channel: 'them', text: 'Recent question 2' });
    store.appendRoundEvent(ws.id, r1, {
      type: 'compaction',
      firstKeptEntryId: t3.id,
      summary: 'Candidate answered Old question 1.'
    });

    const proj = store.buildRoundProjection(ws.id, r1);
    assert.equal(proj.rollingSummary, 'Candidate answered Old question 1.');
    assert.deepEqual(proj.transcript.map((t) => t.text), ['Recent question 2']);
    assert.ok(t1.id && t2.id);

    const freshRound = store.clearRoundTranscript(ws.id, r1);
    assert.notEqual(freshRound.id, r1);
    assert.equal(store.buildRoundProjection(ws.id, freshRound.id).transcript.length, 0);
    // Old JSONL ledger still exists untouched
    const oldProjection = store.buildRoundProjection(ws.id, r1);
    assert.equal(oldProjection.rollingSummary, 'Candidate answered Old question 1.');
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
