// Empty answers on the publik tiers (prod audit 2026-11-04): the tiers are
// reasoning models and the thinking counts inside the output cap. With the
// 700-token cap, 118 of 2,675 fast-tier answers came back empty (output 700,
// reasoning 700), and on 0.2.10 one screenshot answer in five was cut off.
// Reproduced live with pue's exact request (publik-balanced, max_tokens 700,
// a screenshot): finish_reason "length", 700 of 700 tokens reasoning, no text,
// and pue showed a blank bubble or "timed out" after 25 s.
const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

let created = null;     // the request pue sent
let chunks = [];        // what the stream yields
const originalModuleLoad = Module._load;
Module._load = function loadWithOpenAIStub(request, parent, isMain) {
  if (request === 'openai') {
    return class FakeOpenAI {
      constructor() {
        this.chat = { completions: { create: (req) => { created = req; return Promise.resolve(chunks); } } };
      }
    };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};
test.after(() => { Module._load = originalModuleLoad; });

const { createLLM } = require('../src/llm');
const mainSrc = require('./source-text').readSource('main.js'); // CRLF-safe (Windows checkouts)

function ownSettings(overrides = {}) {
  return {
    provider: 'openai', smart: false,
    apiKeys: { openai: 'sk-own' },
    models: { openai: { fast: 'gpt-own', smart: 'gpt-own' } },
    ...overrides
  };
}
const text = (t) => ({ choices: [{ delta: { content: t } }] });
const thinking = (t) => ({ choices: [{ delta: { reasoning: t, reasoning_details: [{ type: 'reasoning.text', text: t }] } }] });
const finish = (reason) => ({ choices: [{ delta: {}, finish_reason: reason }], usage: { completion_tokens: 700, completion_tokens_details: { reasoning_tokens: 700 } } });
const IMAGE = 'data:image/jpeg;base64,AAAA';

async function ask(settings, params = {}) {
  const got = [];
  let activity = 0;
  const llm = createLLM(settings);
  const result = await llm.stream({ system: 's', turns: [{ role: 'user', text: 'q' }], onToken: (t) => got.push(t), onActivity: () => { activity++; }, ...params });
  return { result, got, activity };
}

test.beforeEach(() => { created = null; chunks = [text('ok'), finish('stop')]; });

// ---- the cap leaves room for thinking ---------------------------------------

test('an own OpenAI key keeps its cap with no reasoning_effort override', async () => {
  await ask(ownSettings());
  assert.equal(created.model, 'gpt-own');
  assert.equal(created.max_tokens, 700);
  assert.equal(created.reasoning_effort, undefined);
});

// ---- never a blank answer -------------------------------------------------

test('all thinking, no text, finish "length" (the prod case): an honest message, not a blank answer', async () => {
  chunks = [thinking('Let me think'), thinking(' about this'), finish('length')];
  await assert.rejects(ask(ownSettings(), { imageDataUrl: IMAGE }), (err) => {
    assert.match(err.message, /^No answer this time: the model used its whole length limit on thinking and wrote nothing\./);
    assert.equal(err.finishReason, 'length');
    return true;
  });
});

test('an answer cut at the cap says so at its end', async () => {
  chunks = [thinking('plan'), text('Use a sliding window and'), finish('length')];
  const { result, got } = await ask(ownSettings());
  assert.equal(got[0], 'Use a sliding window and');
  assert.equal(got[got.length - 1], '\n\n(Cut off: the answer reached its length limit.)');
  assert.ok(result.endsWith('(Cut off: the answer reached its length limit.)'));
});

test('an empty answer that ended normally also gets a message', async () => {
  chunks = [thinking('hmm'), finish('stop')];
  await assert.rejects(ask(ownSettings()), /^Error: The model sent back an empty answer\. Ask again\.$|^The model sent back an empty answer\. Ask again\.$/);
});

test('a whole answer is unchanged', async () => {
  chunks = [thinking('short think'), text('Two pointers. '), text('O(n) time.'), finish('stop')];
  const { result, got } = await ask(ownSettings());
  assert.equal(result, 'Two pointers. O(n) time.');
  assert.deepEqual(got, ['Two pointers. ', 'O(n) time.']);
});

// ---- thinking is activity -------------------------------------------------

test('reasoning-only chunks count as activity, so the 25 s watchdog does not call a long think a stall', async () => {
  chunks = [thinking('a'), thinking('b'), thinking('c'), text('Answer.'), finish('stop')];
  const { activity } = await ask(ownSettings());
  assert.equal(activity, 5);
});

test('main.js: the answer watchdog is re-armed by thinking chunks too', () => {
  const run = mainSrc.slice(mainSrc.indexOf('async function runFeature(mode, userText) {'));
  assert.match(run, /onActivity: noteActivity,/);
  assert.match(run, /const noteActivity = \(kind\) => \{\s*if \(streamSettled\) return;\s*rearm\(\);/);
});
