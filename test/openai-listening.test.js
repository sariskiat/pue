const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const EventEmitter = require('node:events');

const { OpenAIRealtimeSTT, createStreamingSTT } = require('../src/stt-streaming');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const rendererJs = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const mainJs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

test('Scenario 1 & 2: Audio tab exposes #stt-openai-card with #stt-key-openai synced with #key-openai without hijacking chat provider', () => {
  assert.match(html, /id="stt-openai-card"/);
  assert.match(html, /id="stt-key-openai"/);
  assert.match(rendererJs, /updateSttProviderFields/);
  assert.match(rendererJs, /#stt-key-openai/);
});

test('Scenario 3: OpenAIRealtimeSTT uses gpt-live-transcribe, accumulates interim deltas per item_id, and commits >=120ms turns', async () => {
  const sentEvents = [];
  class FakeWebSocket extends EventEmitter {
    constructor(url, opts) {
      super();
      this.url = url;
      this.opts = opts;
      this.readyState = 1;
    }
    send(payload) {
      sentEvents.push(JSON.parse(payload));
    }
    close() {
      this.readyState = 3;
    }
  }

  const interims = [];
  const finals = [];
  const instance = createStreamingSTT(
    { sttProvider: 'openai', apiKeys: { openai: 'sk-test-openai' } },
    'them',
    {
      onTranscript: (_ch, text) => finals.push(text),
      onInterim: (_ch, text) => interims.push(text),
      onError: () => {},
      onStatusChange: () => {}
    }
  );
  assert.equal(instance.type, 'streaming');
  assert.equal(instance.provider, 'openai-realtime');
  assert.equal(instance.instance.model, 'gpt-live-transcribe');

  const stt = new OpenAIRealtimeSTT('sk-test-openai', {
    WebSocketImpl: FakeWebSocket,
    onInterim: (t) => interims.push(t),
    onTranscript: (t) => finals.push(t)
  });

  await stt.connect();
  stt.ws.emit('open');

  assert.equal(sentEvents.length, 1);
  assert.equal(sentEvents[0].type, 'session.update');
  assert.equal(sentEvents[0].session.type, 'transcription');
  assert.equal(sentEvents[0].session.audio.input.transcription.model, 'gpt-live-transcribe');
  assert.equal(sentEvents[0].session.audio.input.transcription.delay, 'low');
  assert.deepEqual(sentEvents[0].session.audio.input.transcription.languages, ['th', 'en']);
  assert.match(sentEvents[0].session.audio.input.transcription.prompt, /Thai or English/i);
  assert.equal(sentEvents[0].session.audio.input.turn_detection, null);
  assert.equal('language' in sentEvents[0].session.audio.input.transcription, false);

  stt.ws.emit('message', Buffer.from(JSON.stringify({ type: 'session.updated' })));

  // Empty commit (<120ms audio) must be ignored so OpenAI does not error on empty buffer
  assert.equal(stt.commit(), false);

  // Send 200ms of 16kHz PCM16 (6400 bytes)
  stt.sendAudio(Buffer.alloc(6400, 1));
  assert.equal(sentEvents.filter((e) => e.type === 'input_audio_buffer.append').length, 1);

  // Streaming delta accumulation per item_id
  stt.ws.emit('message', Buffer.from(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.delta',
    item_id: 'item_1',
    delta: 'Walk me'
  })));
  stt.ws.emit('message', Buffer.from(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.delta',
    item_id: 'item_1',
    delta: ' through your queue.'
  })));
  assert.deepEqual(interims, ['Walk me', 'Walk me through your queue.']);

  // Commit at speech end
  assert.equal(stt.commit(), true);
  assert.equal(sentEvents.at(-1).type, 'input_audio_buffer.commit');
  // Second commit without new audio is a no-op
  assert.equal(stt.commit(), false);

  stt.ws.emit('message', Buffer.from(JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item_1',
    transcript: 'Walk me through your queue.'
  })));
  assert.deepEqual(finals, ['Walk me through your queue.']);
});

test('Scenario 4: main.js commits OpenAI streaming audio on VAD speech end and before disconnect', () => {
  assert.match(mainJs, /commitStreamingChannel\(['"]you['"]\)/);
  assert.match(mainJs, /commitStreamingChannel\(['"]them['"]\)/);
});

test('Scenario 5: Batch OpenAI transcription omits forced language=en and prompts Thai or English', async () => {
  const Module = require('node:module');
  const origLoad = Module._load;
  const captured = [];
  Module._load = function stubOpenAI(req, parent, isMain) {
    if (req === 'openai') {
      class FakeOpenAI {
        constructor() {
          this.audio = {
            transcriptions: {
              create: async (params) => {
                captured.push(params);
                return { text: 'สวัสดีครับ walk me through your architecture' };
              }
            }
          };
        }
      }
      FakeOpenAI.toFile = async (buf, name) => ({ buf, name });
      return FakeOpenAI;
    }
    return origLoad.call(this, req, parent, isMain);
  };

  try {
    const { createSTT } = require('../src/stt');
    const stt = createSTT({ sttProvider: 'openai', apiKeys: { openai: 'sk-test' } });
    const res = await stt.transcribe(Buffer.alloc(6400, 2));
    assert.equal(res.text, 'สวัสดีครับ walk me through your architecture');
    assert.equal(captured.length, 1);
    assert.equal('language' in captured[0], false);
    assert.match(captured[0].prompt, /Thai/i);
    assert.match(captured[0].prompt, /English/i);
  } finally {
    Module._load = origLoad;
  }
});
