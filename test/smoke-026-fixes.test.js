const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

let clients = [];
const originalModuleLoad = Module._load;
Module._load = function loadWithOpenAIStub(request, parent, isMain) {
  if (request === 'openai') {
    class FakeOpenAI {
      constructor(options) {
        const rec = { options, chatRequests: [], audioRequests: [] };
        clients.push(rec);
        this.chat = {
          completions: {
            create: (req) => {
              rec.chatRequests.push(req);
              return Promise.resolve([{ choices: [{ delta: { content: 'ok' } }, { delta: {}, finish_reason: 'stop' }] }]);
            }
          }
        };
      }
    }
    return FakeOpenAI;
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};

const { createLLM } = require('../src/llm');

test.after(() => { Module._load = originalModuleLoad; });
test.beforeEach(() => { clients = []; });

const IMAGE = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg').toString('base64');

test('BYOK providers: a screenshot never switches away from the configured fast model', async () => {
  const llm = createLLM({ provider: 'openai', smart: false, apiKeys: { openai: 'sk-test' }, models: { openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' } } });
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'q' }], imageDataUrl: IMAGE, onToken: () => {} });
  assert.equal(clients[0].chatRequests[0].model, 'gpt-4o-mini');
});

const root = path.resolve(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
function fnSource(name) {
  const start = rendererSrc.indexOf(`async function ${name}()`);
  assert.ok(start > -1, `${name} not found in renderer.js`);
  const end = rendererSrc.indexOf('\n  }\n', start);
  return rendererSrc.slice(start, end + 4);
}

async function closeSettingsWith({ settings, typed = {}, atOpen }) {
  const ids = ['cerebras', 'openai', 'anthropic', 'groq', 'custom', 'gemini', 'deepgram', 'ollama', 'minimax', 'deepseek', 'azure'];
  const values = { '#base-url': '', '#azure-endpoint': '', '#model-fast': '', '#model-smart': '', '#whisper-model': 'base.en', '#whisper-language': 'auto', '#whisper-threads': '0', '#ai-rules': '' };
  for (const id of ids) values[`#key-${id}`] = typed[id] !== undefined ? typed[id] : (settings.apiKeys[id] || '');
  const el = (id) => ({ value: values[id] !== undefined ? values[id] : '', textContent: '', focus() {}, checked: false });
  let saved = null;
  const ctx = vm.createContext({
    $: el, settings, keysAtOpen: atOpen || { ...settings.apiKeys },
    cue: { settingsSet: async (s) => { saved = JSON.parse(JSON.stringify(s)); return s; } },
    clampOpacity: (x) => x, statusText: () => '', updateSmartTooltip: () => {}, Number
  });
  vm.runInContext(`${fnSource('saveSettings')}\nthis.run = saveSettings;`, ctx);
  assert.equal(await ctx.run(), true);
  return saved;
}

test('no key for the selected provider + a key typed in this visit switches to it', async () => {
  const s = { provider: 'openai', apiKeys: { openai: '' }, models: {}, localWhisper: {}, slides: {} };
  const saved = await closeSettingsWith({ settings: s, typed: { anthropic: 'sk-ant-new' }, atOpen: { openai: '' } });
  assert.equal(saved.provider, 'anthropic');
});

test('renderer: Settings remembers the keys it opened with', () => {
  assert.match(rendererSrc, /function fillSettings\(\) \{\n    keysAtOpen = \{ \.\.\.\(settings\.apiKeys \|\| \{\}\) \};/);
});
