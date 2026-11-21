const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('http');

const { createLLM } = require('../src/llm');

const INCOMPLETE_NOTE = '\n\n(Incomplete: the answer stopped before the model finished. Ask again to get the rest.)';
const FILTER_EMPTY = "The AI provider's safety filter stopped this answer. Ask again with different words.";
const MIMO = 'The request was rejected because it was considered high risk';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sse = (o) => 'data: ' + JSON.stringify(o) + '\n\n';
const chunk = (delta, finish) => ({ id: 'gen-x', provider: 'Xiaomi', model: 'xiaomi/mimo-v2.6-pro', object: 'chat.completion.chunk', created: 0, choices: [{ index: 0, delta, finish_reason: finish || null, native_finish_reason: finish || null }] });
const usage = { id: 'gen-x', object: 'chat.completion.chunk', created: 0, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };

async function withServer(frames, fn) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      try { bodies.push(JSON.parse(raw || '{}')); } catch { bodies.push(null); }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-test-header': 'seen' });
      for (const f of frames) { res.write(f); await sleep(5); }
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    return await fn(base, bodies);
  } finally {
    server.closeAllConnections && server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

const customAt = (base, extra = {}) => ({
  provider: 'custom',
  smart: false,
  apiKeys: { custom: 'sk-local' },
  baseUrl: base,
  models: { custom: { fast: 'my-local', smart: 'my-local' } },
  ...extra
});

async function ask(settings, params = {}) {
  const tokens = [];
  let result;
  let error = null;
  try {
    result = await createLLM(settings).stream({ system: 's', turns: [{ role: 'user', text: 'q' }], onToken: (t) => tokens.push(t), ...params });
  } catch (e) {
    error = e;
  }
  return { result, error, shown: tokens.join(''), tokens };
}

test('OpenAI-compatible SSE: content, no finish reason, then [DONE]: whole answer', async () => {
  await withServer([sse(chunk({ content: 'A whole ' })), sse(chunk({ content: 'answer.' })), sse(usage), 'data: [DONE]\n\n'], async (base) => {
    const { result, shown } = await ask(customAt(base), { watchDone: true });
    assert.equal(result, 'A whole answer.');
    assert.equal(shown, result);
  });
});

test('OpenAI-compatible SSE: [DONE] split across two network writes still counts', async () => {
  await withServer([sse(chunk({ content: 'Split done.' })), 'data: [DO', 'NE]\n\n'], async (base) => {
    assert.equal((await ask(customAt(base), { watchDone: true })).result, 'Split done.');
  });
});

test('guard: watched stream that closes before [DONE] with no finish reason is marked incomplete', async () => {
  await withServer([sse(chunk({ content: 'The wick draws the melted wax' }))], async (base) => {
    const { result, shown } = await ask(customAt(base), { watchDone: true });
    assert.equal(result, 'The wick draws the melted wax' + INCOMPLETE_NOTE);
    assert.equal(shown, result);
  });
});

test('OpenAI-compatible SSE: "stop" + [DONE] streams in pieces with clean request body and headers hook', async () => {
  await withServer([sse(chunk({ reasoning: 'plan' })), sse(chunk({ content: 'One ' })), sse(chunk({ content: 'two.' })), sse(chunk({}, 'stop')), sse(usage), 'data: [DONE]\n\n'], async (base, bodies) => {
    let header = null;
    const { result, tokens } = await ask(customAt(base), { onResponse: (res) => { header = res.headers.get('x-test-header'); } });
    assert.equal(result, 'One two.');
    assert.ok(tokens.length >= 2, 'text streams in pieces');
    assert.equal(bodies[0].model, 'my-local');
    assert.deepEqual(Object.keys(bodies[0]).sort(), ['max_tokens', 'messages', 'model', 'stream']);
    assert.equal(header, 'seen');
  });
});

test('own OpenAI-compatible server: no finish reason and no [DONE] is a whole answer', async () => {
  await withServer([sse({ choices: [{ index: 0, delta: { content: 'Local model answer.' } }] })], async (base, bodies) => {
    const { result } = await ask(customAt(base));
    assert.equal(result, 'Local model answer.');
    assert.equal('reasoning_effort' in bodies[0], false);
  });
});

test('own OpenAI-compatible server: "eos_token" (TGI) is a whole answer', async () => {
  await withServer([sse({ choices: [{ index: 0, delta: { content: 'TGI answer.' }, finish_reason: null }] }), sse({ choices: [{ index: 0, delta: {}, finish_reason: 'eos_token' }] }), 'data: [DONE]\n\n'], async (base) => {
    assert.equal((await ask(customAt(base))).result, 'TGI answer.');
  });
});

test('guard: OpenRouter content_filter shape over the wire drops refusal and returns safety message', async () => {
  const frames = [sse(chunk({ role: 'assistant', content: '' })), sse(chunk({ reasoning: 'weighing' })), sse(chunk({ content: MIMO })), sse(chunk({ content: '' }, 'content_filter')), sse(usage), 'data: [DONE]\n\n'];
  await withServer(frames, async (base, bodies) => {
    const { error, shown } = await ask(customAt(base), { imageDataUrl: 'data:image/jpeg;base64,AAAA' });
    assert.equal(error.message, FILTER_EMPTY);
    assert.equal(shown, '');
    assert.equal(bodies.length, 1);
  });
});

test('over the wire: a "length" stop with legit "The request was rejected because ..." keeps the text and length note', async () => {
  const legit = 'The request was rejected because the token expired, so refresh it and';
  const frames = [sse(chunk({ reasoning: 'plan' })), sse(chunk({ content: 'It says: ' })), sse(chunk({ content: legit })), sse(chunk({}, 'length')), sse(usage), 'data: [DONE]\n\n'];
  await withServer(frames, async (base, bodies) => {
    const { result, shown, error } = await ask(customAt(base), { imageDataUrl: 'data:image/jpeg;base64,AAAA' });
    assert.equal(error, null);
    assert.equal(result, 'It says: ' + legit + '\n\n(Cut off: the answer reached its length limit.)');
    assert.equal(shown, result);
    assert.equal(bodies.length, 1);
  });
});
