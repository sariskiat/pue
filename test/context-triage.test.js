const test = require('node:test');
const assert = require('node:assert/strict');
const { MODES } = require('../src/prompts');
const { triageContext, transformContext } = require('../src/context-triage');

test('triageContext orders P0 -> P2 -> P1, expands anaphora, logs PerceptionTrace, and finishes <20ms on 500 chunks', () => {
  const fillerChunks = Array.from({ length: 498 }, (_, i) => ({
    id: `chk_fill_${i}`,
    sourceId: `repo_fill`,
    sourceLabel: `other/file_${i % 20}.js`,
    sourceKind: 'repo',
    relPath: `file_${i % 20}.js`,
    heading: `fn_${i}`,
    startLine: 1,
    endLine: 20,
    text: `Generic helper function ${i} for string formatting and date parsing.`,
    terms: ['generic', 'helper', 'function', 'string', 'formatting', 'date', 'parsing']
  }));

  const targetChunks = [
    {
      id: 'chk_rust_bench',
      sourceId: 'repo_rust',
      sourceLabel: 'rust-queue/benches/load.rs',
      sourceKind: 'repo',
      relPath: 'benches/load.rs',
      heading: 'bench_throughput',
      startLine: 10,
      endLine: 45,
      text: 'Criterion benchmark harness achieving 50,000 messages/sec on 4 cores with p99 4.2ms.',
      terms: ['criterion', 'benchmark', 'harness', 'achieving', 'messages', 'sec', 'cores', 'rust', 'queue']
    },
    {
      id: 'chk_oversize_drop',
      sourceId: 'repo_rust2',
      sourceLabel: 'rust-queue/docs/bench_notes.md',
      sourceKind: 'repo',
      relPath: 'docs/bench_notes.md',
      heading: 'notes',
      startLine: 1,
      endLine: 90,
      text: 'Benchmark rust-queue load test details. ' + 'x'.repeat(4400),
      terms: ['benchmark', 'rust', 'queue', 'load', 'test', 'details']
    }
  ];

  const allChunks = [...fillerChunks, ...targetChunks];

  const workspace = {
    id: 'ws_1',
    company: 'Acme',
    role: 'Systems Engineer',
    notes: 'P0_HUMAN_NOTE_ANCHOR: highlight Rust latency',
    admittedLessons: [{ id: 'wles_1', status: 'accepted', guidance: 'P0_LESSON_ANCHOR: state core count' }],
    prepBrief: {
      summary: 'P0_BRIEF_ANCHOR: fault-tolerant queue role',
      repoMatches: [{ repoName: 'rust-queue', whyRelevant: 'Queue fit', talkingPoints: '50k/s' }],
      testPlan: [],
      likelyQuestions: [],
      priorRoundFocus: ['Idempotency keys']
    }
  };

  const profile = {
    repos: [{ id: 'repo_rust', name: 'rust-queue', card: { summary: 'P2_REPOCARD_ANCHOR: rust-queue overview' } }],
    promotedLessons: [{ id: 'les_1', status: 'accepted', guidance: 'State p99 latency' }]
  };

  // Warm V8 JIT once, then measure 500-chunk triage latency
  const runOnce = () =>
    triageContext({
      mode: 'assist',
      transcript: [{ channel: 'them', text: 'How did you benchmark that?', ts: 2000 }],
      userText: '',
      workspace,
      workspaceMemory: 'P2_MEMORY_ANCHOR: Round 1 covered background.',
      profile,
      allChunks,
      qaTurns: [
        {
          mode: 'say',
          userText: 'Tell me about your queue project',
          answer: 'I built rust-queue in Rust to process async jobs.',
          ts: 1000
        }
      ],
      slides: [{ index: 1, caption: 'P2_SLIDE_ANCHOR: Architecture diagram' }]
    });

  runOnce();
  const t0 = performance.now();
  const out = runOnce();
  const elapsedMs = performance.now() - t0;

  assert.ok(elapsedMs < 20, `expected <20ms, took ${elapsedMs.toFixed(2)}ms`);

  const sys = out.systemContext;
  const p0Pos = sys.indexOf('P0_HUMAN_NOTE_ANCHOR');
  const p2MemPos = sys.indexOf('P2_MEMORY_ANCHOR');
  const p2CardPos = sys.indexOf('P2_REPOCARD_ANCHOR');
  const p2SlidePos = sys.indexOf('P2_SLIDE_ANCHOR');
  const p1ChunkPos = sys.indexOf('<untrusted_context source="rust-queue/benches/load.rs:10-45">');

  assert.ok(p0Pos >= 0 && p2MemPos > p0Pos, 'P0 must precede P2 memory');
  assert.ok(p2CardPos > p0Pos && p2SlidePos > p0Pos, 'P2 cards and slides must sit after P0');
  assert.ok(p1ChunkPos > p2MemPos && p1ChunkPos > p2SlidePos, 'P1 retrieved chunks must sit at high-attention end');

  // Prior qaTurn interleaved as user + assistant before final user turn
  assert.equal(out.conversationTurns.length, 3);
  assert.equal(out.conversationTurns[0].role, 'user');
  assert.equal(out.conversationTurns[1].role, 'assistant');
  assert.match(out.conversationTurns[1].text, /rust-queue/);
  assert.equal(out.conversationTurns[2].role, 'user');

  // PerceptionTrace recorded
  assert.equal(out.perceptionTrace.chunksConsidered, 500);
  assert.ok(out.perceptionTrace.chunksSelected >= 1);
  assert.ok(out.perceptionTrace.droppedChunks.some((d) => d.id === 'chk_oversize_drop' && d.reason === 'budget_exceeded'));
});

test('triageContext isolates leetcode completely and omits prior qaTurns on answerThis', () => {
  const workspace = { company: 'Acme', role: 'SWE', notes: 'SECRET_WS_NOTE', admittedLessons: [], prepBrief: { summary: 'BRIEF' } };
  const qaTurns = [{ mode: 'say', userText: 'Prior Q', answer: 'Prior A', ts: 100 }];

  const leet = triageContext({
    mode: 'leetcode',
    transcript: [{ channel: 'them', text: 'Two sum', ts: 200 }],
    userText: '',
    workspace,
    profile: { repos: [], promotedLessons: [] },
    allChunks: [],
    qaTurns
  });
  assert.equal(leet.systemContext, '');
  assert.equal(leet.conversationTurns.length, 1);
  assert.doesNotMatch(leet.systemPrompt, /SECRET_WS_NOTE/);

  const ansThis = triageContext({
    mode: 'answerThis',
    transcript: [],
    userText: 'Why do you want to join Acme?',
    workspace,
    profile: { repos: [], promotedLessons: [] },
    allChunks: [],
    qaTurns
  });
  assert.match(ansThis.systemContext, /SECRET_WS_NOTE/);
  assert.equal(ansThis.conversationTurns.length, 1, 'answerThis omits prior qaTurns');
});

test('transformContext compacts 120-turn transcript within bounds while preserving interviewer pushbacks verbatim', () => {
  const turns = [];
  for (let i = 0; i < 120; i++) {
    if (i === 12) {
      turns.push({
        id: `t_${i}`,
        channel: 'them',
        text: "Wait, are you sure that lock doesn't deadlock under contention?",
        ts: i * 1000
      });
    } else {
      turns.push({
        id: `t_${i}`,
        channel: i % 2 === 0 ? 'them' : 'you',
        text: `Routine conversation exchange number ${i} discussing general project timeline and setup details.`,
        ts: i * 1000
      });
    }
  }

  const sayView = transformContext({ mode: 'say', transcript: turns, rollingSummary: 'Initial intro completed.' });
  assert.ok(sayView.formattedTranscript.length <= 6500, `exceeded say cap: ${sayView.formattedTranscript.length}`);
  assert.match(sayView.formattedTranscript, /Wait, are you sure that lock doesn't deadlock/);
  assert.match(sayView.formattedTranscript, /exchange number 119/);
  assert.ok(sayView.compactionCandidate && sayView.compactionCandidate.firstKeptEntryId);

  const recapView = transformContext({ mode: 'recap', transcript: turns, rollingSummary: 'Initial intro completed.' });
  assert.ok(recapView.formattedTranscript.length <= 10500);
  assert.match(recapView.formattedTranscript, /Initial intro completed/);
  assert.match(recapView.formattedTranscript, /Wait, are you sure that lock doesn't deadlock/);
});

test('candidate prompts include claim-evidence grounding and passive untrusted_context rules', () => {
  for (const modeName of ['assist', 'say', 'ask', 'answerThis']) {
    const sys = MODES[modeName].buildSystem('CTX_END_MARKER');
    assert.match(sys, /untrusted_context/);
    assert.match(sys, /never invent|never fabricate/i);
    assert.ok(sys.endsWith('CTX_END_MARKER'), `${modeName} must place contextBlock at high-attention end`);
  }
});
