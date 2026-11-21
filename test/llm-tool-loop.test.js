const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

let openAiRequests = [];
let openAiReplies = [];
let anthropicRequests = [];
let anthropicReplies = [];
let geminiRequests = [];
let geminiReplies = [];

const origLoad = Module._load;
Module._load = function stubProviders(req, parent, isMain) {
  if (req === 'openai') {
    return class FakeOpenAI {
      constructor() {
        this.chat = {
          completions: {
            create: async (body, opts) => {
              openAiRequests.push({ body: JSON.parse(JSON.stringify(body)), opts });
              const next = openAiReplies.shift();
              if (typeof next === 'function') return next(body, opts);
              if (next instanceof Error) throw next;
              return next || [];
            }
          }
        };
      }
    };
  }
  if (req === '@anthropic-ai/sdk') {
    return class FakeAnthropic {
      constructor() {
        this.messages = {
          create: async (body, opts) => {
            anthropicRequests.push({ body: JSON.parse(JSON.stringify(body)), opts });
            const next = anthropicReplies.shift();
            if (next instanceof Error) throw next;
            return next || [];
          }
        };
      }
    };
  }
  if (req === '@google/genai') {
    return {
      GoogleGenAI: class FakeGenAI {
        constructor() {
          this.models = {
            generateContentStream: async (payload) => {
              geminiRequests.push(JSON.parse(JSON.stringify(payload)));
              const next = geminiReplies.shift();
              if (next instanceof Error) throw next;
              return next || [];
            }
          };
        }
      }
    };
  }
  return origLoad.call(this, req, parent, isMain);
};

test.after(() => {
  Module._load = origLoad;
});

const { createLLM } = require('../src/llm');
const { TOOL_DEFINITIONS } = require('../src/repo-tools');

test.beforeEach(() => {
  openAiRequests = [];
  openAiReplies = [];
  anthropicRequests = [];
  anthropicReplies = [];
  geminiRequests = [];
  geminiReplies = [];
});

test('OpenAI tool loop executes grep -> read -> final text, clears >1500-char old tool results, and sends image only on round 0', async () => {
  openAiReplies = [
    [
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'call_1', function: { name: 'grep_files', arguments: '{"query":"dlq"}' } }]
            }
          }
        ]
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ],
    [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_2', function: { name: 'read_file', arguments: '{"rootName":"repo","relPath":"w.rs"}' } }
              ]
            }
          }
        ]
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ],
    [
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'call_3', function: { name: 'list_files', arguments: '{}' } }]
            }
          }
        ]
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ],
    [
      { choices: [{ delta: { content: 'We capped DLQ retries at 5.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] }
    ]
  ];

  const executed = [];
  const toolEvents = [];
  const llm = createLLM({
    provider: 'openai',
    smart: true,
    apiKeys: { openai: 'sk-test' },
    models: { openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' } }
  });

  const out = await llm.stream({
    system: 'sys',
    turns: [{ role: 'user', text: 'How does DLQ work?' }],
    imageDataUrl: 'data:image/jpeg;base64,AAAA',
    tools: TOOL_DEFINITIONS,
    onToken: () => {},
    onToolCall: (ev) => toolEvents.push(ev),
    executeTool: async (name, args) => {
      executed.push({ name, args });
      if (name === 'grep_files') {
        return { content: 'BIG_GREP_RESULT_' + 'x'.repeat(1800), summary: 'repo/w.rs:1-40', isError: false };
      }
      return { content: 'small result', summary: name, isError: false };
    }
  });

  assert.equal(out, 'We capped DLQ retries at 5.');
  assert.equal(executed.length, 3);
  assert.equal(toolEvents.length, 3);

  // Image attached on round 0 user message, not duplicated on later tool messages
  const r0Content = JSON.stringify(openAiRequests[0].body.messages);
  assert.match(r0Content, /image_url/);

  // By round 2 (3rd request), round-0's >1500-char tool result is Level-1 cleared
  const r2ToolMsg = openAiRequests[2].body.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'call_1');
  assert.match(r2ToolMsg.content, /\[Cleared after read: repo\/w\.rs:1-40/);
});

test('Anthropic and Gemini streaming tool loops complete without EMPTY_ANSWER_MESSAGE', async () => {
  anthropicReplies = [
    [
      { type: 'message_start' },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'list_files', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"rootName":"alpha"}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' }
    ],
    [
      { type: 'message_start' },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Anthropic grounded answer.' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' }
    ]
  ];

  const antLlm = createLLM({
    provider: 'anthropic',
    smart: true,
    apiKeys: { anthropic: 'sk-ant' },
    models: { anthropic: { fast: 'claude-haiku-4-5-20251001', smart: 'claude-sonnet-4-5-20250929' } }
  });
  const antOut = await antLlm.stream({
    system: 'sys',
    turns: [{ role: 'user', text: 'Check alpha' }],
    tools: TOOL_DEFINITIONS,
    onToken: () => {},
    executeTool: async () => ({ content: 'src/main.rs', summary: 'alpha', isError: false })
  });
  assert.equal(antOut, 'Anthropic grounded answer.');

  geminiReplies = [
    [
      {
        candidates: [
          {
            content: { parts: [{ functionCall: { name: 'grep_files', args: { query: 'raft' } } }] },
            finishReason: 'STOP'
          }
        ]
      }
    ],
    [
      {
        text: 'Gemini grounded answer.',
        candidates: [{ content: { parts: [{ text: 'Gemini grounded answer.' }] }, finishReason: 'STOP' }]
      }
    ]
  ];

  const gemLlm = createLLM({
    provider: 'gemini',
    smart: true,
    apiKeys: { gemini: 'AIza-test' },
    models: { gemini: { fast: 'gemini-3.8-flash', smart: 'gemini-3.1-pro-preview' } }
  });
  const gemOut = await gemLlm.stream({
    system: 'sys',
    turns: [{ role: 'user', text: 'Check raft' }],
    tools: TOOL_DEFINITIONS,
    onToken: () => {},
    executeTool: async () => ({ content: 'raft.go:10', summary: 'grep raft', isError: false })
  });
  assert.equal(gemOut, 'Gemini grounded answer.');
});

test('length-truncated tool calls are rejected without executing executeTool', async () => {
  openAiReplies = [
    [
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'call_trunc', function: { name: 'read_file', arguments: '{"rootName":"r",' } }]
            }
          }
        ]
      },
      { choices: [{ delta: {}, finish_reason: 'length' }] }
    ],
    [
      { choices: [{ delta: { content: 'Answered safely after truncation.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] }
    ]
  ];

  let executedCount = 0;
  const llm = createLLM({
    provider: 'openai',
    smart: true,
    apiKeys: { openai: 'sk-test' },
    models: { openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' } }
  });

  const res = await llm.stream({
    system: 'sys',
    turns: [{ role: 'user', text: 'Read file' }],
    tools: TOOL_DEFINITIONS,
    onToken: () => {},
    executeTool: async () => {
      executedCount++;
      return { content: 'nope', summary: 'nope', isError: false };
    }
  });

  assert.equal(executedCount, 0, 'truncated tool call must never execute');
  assert.equal(res, 'Answered safely after truncation.');
  const secondReqMsgs = JSON.stringify(openAiRequests[1].body.messages);
  assert.match(secondReqMsgs, /truncated/i);
});

test('round-0 HTTP 400 tool-schema error falls back once to topK=10 context, while 401 and 429 never fall back', async () => {
  const err400 = Object.assign(new Error('400 Unrecognized request argument supplied: tools'), { status: 400 });
  openAiReplies = [
    err400,
    [
      { choices: [{ delta: { content: 'Fallback top-10 answer.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] }
    ]
  ];

  const llm = createLLM({
    provider: 'custom',
    smart: true,
    baseUrl: 'http://127.0.0.1:9999/v1',
    apiKeys: { custom: 'sk-c' },
    models: { custom: { fast: 'm1', smart: 'm2' } }
  });

  const out = await llm.stream({
    system: 'normal-sys',
    turns: [{ role: 'user', text: 'q' }],
    tools: TOOL_DEFINITIONS,
    fallbackSystem: 'EXPANDED_TOP10_SYS',
    fallbackTurns: [{ role: 'user', text: 'q-fallback' }],
    onToken: () => {},
    executeTool: async () => ({ content: '', summary: '', isError: false })
  });

  assert.equal(out, 'Fallback top-10 answer.');
  assert.equal(openAiRequests.length, 2);
  assert.equal('tools' in openAiRequests[1].body, false);
  assert.equal(openAiRequests[1].body.messages[0].content, 'EXPANDED_TOP10_SYS');

  // 401 and 429 must fail immediately without fallback
  for (const status of [401, 429]) {
    openAiRequests = [];
    openAiReplies = [Object.assign(new Error(`${status} rejected`), { status })];
    await assert.rejects(
      llm.stream({
        system: 'sys',
        turns: [{ role: 'user', text: 'q' }],
        tools: TOOL_DEFINITIONS,
        fallbackSystem: 'EXPANDED_TOP10_SYS',
        onToken: () => {},
        executeTool: async () => ({ content: '', summary: '', isError: false })
      })
    );
    assert.equal(openAiRequests.length, 1, `status ${status} must not trigger fallback`);
  }
});

test('Deep-Path wall timeout aborts stalled tool loops cleanly', { timeout: 1500 }, async () => {
  openAiReplies = [
    (_body, opts) =>
      new Promise((_resolve, reject) => {
        const fallback = setTimeout(() => reject(new Error('missing abort signal on request')), 400);
        fallback.unref();
        if (opts && opts.signal) {
          opts.signal.addEventListener('abort', () => {
            clearTimeout(fallback);
            reject(opts.signal.reason || new Error('aborted'));
          });
        }
      })
  ];

  const llm = createLLM({
    provider: 'openai',
    smart: true,
    apiKeys: { openai: 'sk-test' },
    models: { openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' } }
  });

  await assert.rejects(
    llm.stream({
      system: 'sys',
      turns: [{ role: 'user', text: 'stall' }],
      tools: TOOL_DEFINITIONS,
      deepTimeoutMs: 80,
      onToken: () => {},
      executeTool: async () => ({ content: '', summary: '', isError: false })
    }),
    /timed out|aborted/i
  );
});

test('preload exposes workspace:*, llmCancel, llm:tool, workspace:changed, and round:dissected', () => {
  let exposed = null;
  const channels = [];
  const prevLoad = Module._load;
  Module._load = function stubElectron(req, parent, isMain) {
    if (req === 'electron') {
      return {
        contextBridge: { exposeInMainWorld: (_k, api) => { exposed = api; } },
        ipcRenderer: { invoke: () => Promise.resolve(null), send: () => {}, on: (ch) => channels.push(ch) }
      };
    }
    return prevLoad.call(this, req, parent, isMain);
  };
  try {
    delete require.cache[require.resolve('../preload')];
    require('../preload');
    for (const fn of [
      'workspaceList',
      'workspaceCreate',
      'workspaceUpdate',
      'workspaceSelect',
      'workspaceDelete',
      'workspaceAttachFile',
      'workspaceRemoveFile',
      'workspaceCreateRound',
      'workspaceSelectRound',
      'workspaceEndRound',
      'workspaceGenerateBrief',
      'workspaceGetDissection',
      'workspaceListJournal',
      'workspaceDecideLesson',
      'workspaceSearchRounds',
      'llmCancel'
    ]) {
      assert.equal(typeof exposed[fn], 'function', `missing preload method ${fn}`);
    }
    exposed.on('llm:tool', () => {});
    exposed.on('workspace:changed', () => {});
    exposed.on('round:dissected', () => {});
    assert.deepEqual(channels, ['llm:tool', 'workspace:changed', 'round:dissected']);
  } finally {
    Module._load = prevLoad;
  }
});
