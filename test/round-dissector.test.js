const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createWorkspaceStore } = require('../src/workspace-store');
const { createProfileStore } = require('../src/profile-store');
const { buildDissectionPrompt, parseDissection } = require('../src/round-dissector');

const MOCK_DISSECTION_TEXT = [
  'Round Summary:',
  'Technical screen covered poison-message handling and throughput numbers on rust-queue.',
  '',
  'Q&A Review:',
  '- How did you handle poison messages? | Mention dead-letter cap of 5 retries in worker.rs:42 | Said we retried messages a few times | partial | Omitted exact 5-retry cap and DLQ alert metric | rust-queue/src/worker.rs:42',
  '- Walk through throughput benchmarks | Cite 50k msgs/sec load test | Stated 50k msgs/sec on 4 cores | strong | Clear metric grounded in README | rust-queue/README.md:8',
  '',
  'Missed Opportunities:',
  '- Context miss: worker.rs chunk chk_99 was dropped by budget in PerceptionTrace',
  '- Did not mention zero-message-loss chaos test',
  '',
  'Interviewer Signals:',
  '- Interviewer pushed twice on exact retry bounds and idempotency keys',
  '',
  'Settled Topics:',
  '- Throughput benchmark setup',
  '',
  'Weaknesses to Repair:',
  '- Dead-letter retry cap and idempotency storage trade-offs',
  '',
  'Promised Follow-Ups:',
  '- Share schema details in Round 2',
  '',
  'Candidate Lessons:',
  '- missing_metric | Always state the exact 5-retry DLQ threshold from worker.rs:42 | workspace',
  '- technical_gap | Lead queue answers with idempotency key guarantees plus retry bounds | global'
].join('\n');

test('buildDissectionPrompt includes transcript, copilot suggestions, and PerceptionTrace drops', () => {
  const prompt = buildDissectionPrompt({
    roundProjection: {
      rawTranscript: [
        { channel: 'them', text: 'How did you handle poison messages?', ts: 1000 },
        { channel: 'you', text: 'We retried messages a few times.', ts: 2000 }
      ],
      qaTurns: [{ mode: 'say', userText: '', answer: 'Mention 5-retry DLQ in worker.rs:42', citedSources: ['rust-queue/src/worker.rs:42'] }],
      perceptionTraces: [
        {
          mode: 'say',
          chunksConsidered: 12,
          chunksSelected: 5,
          droppedChunks: [{ id: 'chk_99', sourceLabel: 'rust-queue/src/worker.rs', reason: 'budget_exceeded' }]
        }
      ]
    },
    workspace: { company: 'Acme', role: 'Staff SWE', files: [] },
    profile: { repos: [{ name: 'rust-queue', card: { summary: 'Rust queue with DLQ' } }], documents: [] }
  });

  assert.match(prompt.system, /separate-frame|factual|never invent/i);
  assert.match(prompt.user, /How did you handle poison messages\?/);
  assert.match(prompt.user, /Mention 5-retry DLQ/);
  assert.match(prompt.user, /chk_99/);

  const parsed = parseDissection(MOCK_DISSECTION_TEXT);
  assert.equal(parsed.qaReview.length, 2);
  assert.equal(parsed.qaReview[0].verdict, 'partial');
  assert.deepEqual(parsed.qaReview[0].citedSources, ['rust-queue/src/worker.rs:42']);
  assert.equal(parsed.proposedLessons.length, 2);
});

test('endRound dissects >=4-turn round and gates Failure Journal lessons behind human approval', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pue-dissect-'));
  try {
    const profileStore = createProfileStore(() => userData);
    const wsStore = createWorkspaceStore(() => userData, { debounceMs: 0 });
    const ws = wsStore.createWorkspace({ company: 'Acme', role: 'Staff SWE' });
    const r1 = ws.activeRoundId;

    const turns = [
      { channel: 'them', text: 'How did you handle poison messages?' },
      { channel: 'you', text: 'We retried messages a few times.' },
      { channel: 'them', text: 'What were your throughput numbers?' },
      { channel: 'you', text: '50k messages per second on 4 cores.' }
    ];
    for (const t of turns) {
      wsStore.appendRoundEvent(ws.id, r1, { type: 'transcript_turn', ...t });
    }
    wsStore.appendRoundEvent(ws.id, r1, {
      type: 'qa_turn',
      mode: 'say',
      answer: 'Mention 5-retry DLQ in worker.rs:42',
      citedSources: ['rust-queue/src/worker.rs:42']
    });

    const fakeLlmFactory = () => ({
      ready: true,
      stream: async () => MOCK_DISSECTION_TEXT
    });

    const dissectedRound = await wsStore.endRound(ws.id, r1, {
      llmFactory: fakeLlmFactory,
      profile: profileStore.getProfile()
    });

    assert.equal(dissectedRound.status, 'dissected');
    assert.ok(dissectedRound.dissection);
    assert.equal(dissectedRound.dissection.qaReview.length, 2);

    // Governance invariant: proposed L1 lessons NEVER auto-enter admittedLessons or global profile
    assert.equal(wsStore.getWorkspace(ws.id).admittedLessons.length, 0);
    assert.equal(profileStore.getActiveLessons().length, 0);

    const journal = wsStore.listFailureJournal(ws.id);
    assert.equal(journal.facts.length >= 1, true);
    assert.equal(journal.lessons.length, 2);
    assert.ok(journal.lessons.every((l) => l.status === 'proposed'));

    // Human approves lesson 0 for workspace and promotes lesson 1 to global profile
    wsStore.decideCandidateLesson(ws.id, journal.lessons[0].id, 'accept_workspace', { profileStore });
    wsStore.decideCandidateLesson(ws.id, journal.lessons[1].id, 'promote_global', { profileStore });

    assert.equal(wsStore.getWorkspace(ws.id).admittedLessons.length, 1);
    assert.match(wsStore.getWorkspace(ws.id).admittedLessons[0].guidance, /5-retry DLQ/);
    assert.equal(profileStore.getActiveLessons().length, 1);
    assert.match(profileStore.getActiveLessons()[0].guidance, /idempotency key/);

    const updatedJournal = wsStore.listFailureJournal(ws.id);
    assert.equal(updatedJournal.lessons[0].status, 'accepted');
    assert.equal(updatedJournal.lessons[1].status, 'promoted');
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('catchUpPendingRounds closes and dissects stale open rounds older than 30 minutes', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pue-catchup-'));
  let clock = 1_000_000;
  try {
    const wsStore1 = createWorkspaceStore(() => userData, { debounceMs: 0, now: () => clock });
    const ws = wsStore1.createWorkspace({ company: 'StaleCo', role: 'SWE' });
    const rId = ws.activeRoundId;
    for (let i = 0; i < 5; i++) {
      clock += 1000;
      wsStore1.appendRoundEvent(ws.id, rId, {
        type: 'transcript_turn',
        channel: i % 2 === 0 ? 'them' : 'you',
        text: `Turn number ${i + 1}`
      });
    }
    wsStore1.flushAll();

    // Advance clock past 30-minute resume window
    clock += 35 * 60 * 1000;
    const wsStore2 = createWorkspaceStore(() => userData, { debounceMs: 0, now: () => clock });
    const caughtUp = await wsStore2.catchUpPendingRounds({
      llmFactory: () => ({ ready: true, stream: async () => MOCK_DISSECTION_TEXT }),
      profile: { repos: [], documents: [] }
    });
    assert.equal(caughtUp, 1);
    const reloadedRound = wsStore2.getWorkspace(ws.id).rounds.find((r) => r.id === rId);
    assert.equal(reloadedRound.status, 'dissected');
    assert.ok(reloadedRound.endedAt > 0);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
