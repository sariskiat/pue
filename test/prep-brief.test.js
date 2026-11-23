const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPrepBriefPrompt, parsePrepBrief } = require('../src/prep-brief');

test('buildPrepBriefPrompt wraps untrusted JD/test chunks and carries prior round focus', () => {
  const workspace = {
    company: 'Acme AI',
    role: 'Staff Systems Engineer',
    notes: 'Salary target: $210k. Emphasize Rust and distributed queues.',
    files: [
      {
        id: 'wf_jd',
        label: 'jd.md',
        role: 'jd',
        chunks: [{ sourceLabel: 'jd.md', startLine: 1, endLine: 12, text: 'Build fault-tolerant job queues in Rust.' }]
      },
      {
        id: 'wf_test',
        label: 'takehome.md',
        role: 'test',
        chunks: [{ sourceLabel: 'takehome.md', startLine: 1, endLine: 20, text: 'Implement retry worker with dead-letter queue.' }]
      }
    ],
    rounds: [
      {
        id: 'rnd_1',
        name: 'Round 1',
        dissection: {
          roundSummary: 'Passed screening.',
          nextRoundCheckpoint: {
            settledTopics: ['Background'],
            openWeaknessesToRepair: ['State exact dead-letter max retry threshold'],
            promisedFollowUps: ['Mention benchmark throughput']
          }
        }
      }
    ]
  };

  const profile = {
    documents: [
      {
        id: 'doc_1',
        label: 'resume.pdf',
        kind: 'resume',
        chunks: [{ sourceLabel: 'resume.pdf', startLine: 1, endLine: 15, text: 'Led queue migration to 50k msgs/sec.' }]
      }
    ],
    repos: [
      {
        id: 'repo_1',
        name: 'rust-queue',
        card: {
          summary: 'Repository: rust-queue\nLanguages: Rust\nOverview: Bounded retry queue with DLQ.',
          languages: ['Rust'],
          keyFiles: ['README.md', 'src/lib.rs']
        }
      }
    ]
  };

  const { system, user, priorRoundFocus } = buildPrepBriefPrompt({ workspace, profile });
  assert.match(system, /never invent|only use/i);
  assert.match(user, /<untrusted_context source="jd\.md:1-12">/);
  assert.match(user, /<untrusted_context source="takehome\.md:1-20">/);
  assert.match(user, /rust-queue/);
  assert.match(user, /State exact dead-letter max retry threshold/);
  assert.equal(priorRoundFocus.length, 2);
});

test('parsePrepBrief parses structured sections and falls back gracefully on plain prose', () => {
  const raw = [
    'Role Summary:',
    'Acme AI wants a Staff Systems Engineer focused on fault-tolerant Rust queues and DLQ handling.',
    '',
    'Repo Matches:',
    '- rust-queue | Matches Rust queue requirement | Highlight bounded retry and 50k msgs/sec benchmark',
    '- inference-gw | Shows backpressure control | Mention token bucket limiter',
    '',
    'Test Plan:',
    '- Walk through retry backoff and dead-letter threshold in takehome.md',
    '- Explain idempotency key storage',
    '',
    'Likely Questions:',
    '- How do you prevent poison messages from blocking workers?',
    '- How did you benchmark 50k msgs/sec?'
  ].join('\n');

  const parsed = parsePrepBrief(raw, ['State exact dead-letter max retry threshold']);
  assert.match(parsed.summary, /fault-tolerant Rust queues/);
  assert.equal(parsed.repoMatches.length, 2);
  assert.equal(parsed.repoMatches[0].repoName, 'rust-queue');
  assert.match(parsed.repoMatches[0].whyRelevant, /Rust queue/);
  assert.match(parsed.repoMatches[0].talkingPoints, /50k msgs\/sec/);
  assert.equal(parsed.testPlan.length, 2);
  assert.equal(parsed.likelyQuestions.length, 2);
  assert.deepEqual(parsed.priorRoundFocus, ['State exact dead-letter max retry threshold']);

  const fallback = parsePrepBrief('Focus on queue retries and Rust ownership.', []);
  assert.equal(fallback.summary, 'Focus on queue retries and Rust ownership.');
  assert.deepEqual(fallback.repoMatches, []);
});

test('Prep Brief & Dissection request maxTokens >= 4096 so multi-repo profiles do not cut off at 1200 tokens', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const wsSrc = fs.readFileSync(path.join(root, 'src', 'workspace-store.js'), 'utf8');
  const cssSrc = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');

  const briefIdx = mainSrc.indexOf("ipcMain.handle('workspace:generate-brief'");
  assert.ok(briefIdx > -1);
  const briefSlice = mainSrc.slice(briefIdx, briefIdx + 900);
  assert.match(briefSlice, /maxTokens:\s*4096/);

  const dissIdx = wsSrc.indexOf('async function generateRoundDissection');
  assert.ok(dissIdx > -1);
  const dissSlice = wsSrc.slice(dissIdx, dissIdx + 900);
  assert.match(dissSlice, /maxTokens:\s*4096/);

  assert.match(cssSrc, /\.pue-section-text\s*\{[^}]*white-space:\s*pre-line/);
});

test('parsePrepBrief preserves bullet newlines in Role Summary and strips trailing (Cut off: ...) + dangling repo stubs', () => {
  const realBugInput = [
    'Role Summary:',
    'Senior AI CoE Engineer at Ascend Money. Your strongest fit is your CJ More pattern:',
    '- 20 Thai Text-to-SQL agents that cut ~1,200 BI hours a year',
    '- A solo 61-tool MCP server worth ~3.2M THB a year',
    'Your CEO Office background supports the strategy-team setting.',
    '',
    'Repo Matches:',
    '- kissflow-forge 2 | Solo 61-tool MCP server | Cut build time 10x+',
    '- search-gt-revision | Measurement rigor | 97.7% Hit@10 on 27,010 queries',
    '- commercial-:',
    '',
    '(Cut off: the answer reached its length limit.)'
  ].join('\n');

  const parsed = parsePrepBrief(realBugInput, []);
  assert.equal(parsed.truncated, true);
  assert.match(parsed.summary, /\n• 20 Thai Text-to-SQL agents/);
  assert.match(parsed.summary, /\n• A solo 61-tool MCP server/);
  assert.equal(parsed.repoMatches.length, 2);
  assert.deepEqual(
    parsed.repoMatches.map((r) => r.repoName),
    ['kissflow-forge 2', 'search-gt-revision']
  );
});

