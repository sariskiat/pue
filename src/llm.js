// LLM factory — OpenAI, Anthropic, Gemini, and OpenAI-compatible APIs behind one streaming interface.
// stream({ system, turns:[{role,text}], imageDataUrl, maxTokens, onToken }) -> Promise<fullText>

const { createCompatibleClientOptions } = require('./openai-compatible');

const CUSTOM_PROVIDER = 'custom';
// gemini-2.0-flash was Google's default here until it was deprecated (Feb 2026)
// and fully retired (Mar 3 2026) — every request against it now 404s with a
// generic "exception parsing response" body. gemini-3.8-flash is the current
// Flash release (Aug 2026), so it is the single default used everywhere in
// this file and for Gemini transcription in stt.js / stt-streaming.js.
const CURRENT_GEMINI_DEFAULT = 'gemini-3.8-flash';
// Purpose-built speech-to-text model: no thinking tokens, returns nothing on
// silence, and answers with an `audioTranscription` part instead of `text`
// (see extractGeminiTranscript in stt.js). Falls back to
// CURRENT_GEMINI_DEFAULT if Google ever retires it.
const GEMINI_TRANSCRIBE_MODEL = 'gemini-3.5-transcribe';
// Streaming counterpart over the Live API (bidiGenerateContent): word-by-word
// interim hypotheses plus a final on each pause. Used by GeminiLiveSTT in
// stt-streaming.js; the batch model above is the fallback when it fails.
const GEMINI_TRANSCRIBE_LIVE_MODEL = 'gemini-3.5-transcribe-live';
// claude-3-5-haiku-latest / claude-3-5-sonnet-latest were retired by Anthropic
// (confirmed absent from GET https://api.anthropic.com/v1/models as of Sep 19
// 2026 — every claude-2.x and claude-3.x id 404s with not_found_error).
// claude-haiku-4-5-20251001 / claude-sonnet-4-5-20250929 are current and were
// live-verified with a real request before shipping this default.
const CURRENT_ANTHROPIC_DEFAULT_FAST = 'claude-haiku-4-5-20251001';
const CURRENT_ANTHROPIC_DEFAULT_SMART = 'claude-sonnet-4-5-20250929';
const DEFAULT_MODELS = {
  cerebras: 'qwen-3.8-27b',
  openai: 'gpt-4o-mini',
  anthropic: CURRENT_ANTHROPIC_DEFAULT_FAST,
  gemini: CURRENT_GEMINI_DEFAULT,
  ollama: 'llama3.2',
  groq: 'llama-3.1-8b-instant',
  minimax: 'MiniMax-M2.7',
  // deepseek-chat/deepseek-reasoner were retired 2026-07-24 and now 404; the
  // replacement aliases are deepseek-flash (non-thinking) and deepseek-v4-pro
  // (thinking), so those are the defaults used everywhere in this file.
  deepseek: 'deepseek-flash',
  azure: 'gpt-4o-mini'
};
const CEREBRAS_BASE_URL = 'https://api.cerebras.ai/v1';

// Gemini model ids that Google has since deprecated/retired (the 2.5 family
// went "no longer available to new users" in Sep 2026). A settings file saved
// before this fix can still have one of these persisted on disk, so
// resolveGeminiModel migrates them at read time rather than only fixing the
// default — otherwise an existing user would keep re-hitting the same 404
// forever.
const DEAD_GEMINI_MODEL_RE = /^gemini-(1\.0|1\.5|2\.0|2\.5)(?:-|$)/i;

// Single place that answers "which Gemini model should this request use?".
// Both the chat path (createLLM) and the transcription paths (src/stt.js,
// src/stt-streaming.js) go through here. STT used to skip this and hardcode
// the default instead, so a user who picked a working model in Settings still
// got 404s from a model they had never selected — the app reported a failure
// against a model id that appeared nowhere in their config.
function resolveGeminiModel(settings) {
  const s = settings || {};
  const tier = s.smart ? 'smart' : 'fast';
  const configured = ((s.models || {}).gemini || {})[tier];
  if (!configured || DEAD_GEMINI_MODEL_RE.test(configured)) return CURRENT_GEMINI_DEFAULT;
  return configured;
}

// Same self-heal, for Anthropic: matches every retired claude-2.x/claude-3.x
// id (including the "-latest" aliases), so a settings file saved back when
// claude-3-5-haiku-latest/claude-3-5-sonnet-latest were the shipped defaults
// (store.js's DEFAULTS.models.anthropic, before this fix) gets migrated to a
// live model on next read instead of permanently re-hitting the same 404.
const DEAD_ANTHROPIC_MODEL_RE = /^claude-(2(?:\.\d+)?(?:-|$)|3-)/i;

// Same story for DeepSeek's retired chat/reasoner aliases — map each to its
// closest current replacement rather than collapsing both to one default.
const DEAD_DEEPSEEK_MODEL_RE = /^deepseek-(chat|reasoner)$/i;
const CURRENT_DEEPSEEK_FAST_DEFAULT = 'deepseek-flash';
const CURRENT_DEEPSEEK_SMART_DEFAULT = 'deepseek-v4-pro';

const PROVIDER_LABELS = { azure: 'Azure AI Foundry', cerebras: 'Cerebras', openai: 'OpenAI', minimax: 'MiniMax', deepseek: 'DeepSeek' };

// DeepSeek is OpenAI-compatible and reuses the OpenAI screenshot/streaming path via baseURL.
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

function normalizeProviderName(provider) {
  if (!provider) return 'provider';
  if (PROVIDER_LABELS[provider]) return PROVIDER_LABELS[provider];
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

// A 429 on its own says only "slow down" — it never says the account is out of
// credit. So quota exhaustion is recognised ONLY from an upstream body that
// actually claims it (OpenAI `insufficient_quota`, Gemini `RESOURCE_EXHAUSTED`,
// or plain "exceeded your current quota"/quota/billing wording); every other
// 429 is reported as the rate limit it is. Anthropic's API has no quota concept
// at all — every Anthropic 429 is a per-minute rate_limit_error whose envelope
// is {type:'error', error:{type:'rate_limit_error', message}} (SDKs expose the
// whole envelope as error.error, so the real type sits at error.error.error.type)
// — so under the old `status === 429` rule an Anthropic user could never avoid
// the false "free-tier quota exhausted" message.
function errorSignals(error) {
  const status = error && (error.status || error.statusCode || error.response?.status);
  const code = error && (error.code || error.error?.code);
  const upstreamType = error && (error.error?.error?.type || error.error?.type);
  const rawMessage = (error && (error.message || String(error))) || '';
  return { status, code, upstreamType, text: `${rawMessage} ${code || ''} ${upstreamType || ''}`.toLowerCase() };
}

// The two upstream codes that mean "this is a burst/per-minute limit", never
// "your account is empty".
function hasRateLimitSignal({ code, upstreamType }) {
  return code === 'rate_limit_exceeded' || upstreamType === 'rate_limit_error';
}

// Pulled out so both the LLM and STT error paths (llm.js and stt.js) agree on
// what counts as a quota failure instead of drifting independently.
function isQuotaError(error) {
  const signals = errorSignals(error);
  const { code, upstreamType, text } = signals;
  if (code === 'insufficient_quota' || code === 'RESOURCE_EXHAUSTED' ||
      upstreamType === 'insufficient_quota' || upstreamType === 'RESOURCE_EXHAUSTED') return true;
  if (hasRateLimitSignal(signals)) return false;
  return /insufficient_quota|resource_exhausted|exceeded your current quota|\bquota\b|\bbilling\b/i.test(text);
}

// Everything else that 429s (including a bare 429 with no body at all, which is
// what most providers send under load) is a rate limit, not exhaustion.
function isRateLimitError(error) {
  if (isQuotaError(error)) return false;
  const signals = errorSignals(error);
  const { status, code, text } = signals;
  return status === 429 || code === 429 || hasRateLimitSignal(signals) ||
    /\b429\b|too many requests|rate limit/i.test(text);
}

// An own provider refused the key itself: OpenAI/Groq/DeepSeek/Anthropic
// answer 401 ("Incorrect API key provided", invalid_api_key,
// authentication_error); Gemini answers 400 "API key not valid". A 403
// alone is not enough (it also means "no access to this model").
function isAuthError(error) {
  const status = error && (error.status || error.statusCode || error.response?.status);
  const code = error && (error.code || error.error?.code || error.error?.type);
  const rawMessage = (error && (error.message || String(error))) || '';
  const text = `${rawMessage} ${code || ''}`.toLowerCase();
  if (status === 401) return true;
  return /incorrect api key|invalid[ _-]?api[ _-]?key|invalid x-api-key|api key not valid|api_key_invalid|authentication_error/.test(text);
}

function isNotFoundError(error) {
  const status = error && (error.status || error.statusCode || error.response?.status);
  const code = error && (error.code || error.error?.code);
  const rawMessage = (error && (error.message || String(error))) || '';
  const text = `${rawMessage} ${status || ''} ${code || ''}`.toLowerCase();
  return status === 404 || code === 404 || /\b404\b|is not found for api version|model not found/i.test(text);
}

// Gemini 429 bodies often carry a google.rpc.RetryInfo detail like
// {"retryDelay":"38s"} inside the JSON error text. Not every quota error has
// one (OpenAI/Anthropic don't), so this is best-effort and returns null when
// absent instead of guessing a wait time.
function extractRetryDelaySeconds(rawMessage) {
  const match = /retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)\s*s/i.exec(String(rawMessage || ''));
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function formatRetryWait(seconds) {
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function formatProviderErrorMessage(error, provider, model) {
  // An empty or cut answer already carries its plain sentence (settleAnswer).
  if (error && error.emptyAnswer) return error;
  const label = normalizeProviderName(provider);
  const rawMessage = (error && (error.message || String(error))) || '';

  // Never echo the provider's raw 401 body because some APIs include partial key text.
  if (isAuthError(error)) {
    const failed = new Error(`Your ${label} key did not work.`);
    failed.ownKeyFailed = { provider, providerName: label };
    return failed;
  }

  if (isQuotaError(error)) {
    const retrySeconds = extractRetryDelaySeconds(rawMessage);
    const waitHint = retrySeconds ? ` Wait about ${formatRetryWait(retrySeconds)}` : ' Wait a moment';
    return `${label} free-tier quota exhausted (429 Too Many Requests).${waitHint} and try again, or add billing to your ${label} account. You can also switch providers or models in Settings.`;
  }

  if (isRateLimitError(error)) {
    const retrySeconds = extractRetryDelaySeconds(rawMessage);
    const waitHint = retrySeconds ? ` Wait about ${formatRetryWait(retrySeconds)}` : ' Wait a moment';
    return `${label} is rate-limiting requests right now (429 Too Many Requests).${waitHint} and try again — this is a temporary per-minute/request limit, not your account running out of credit.`;
  }

  if (isNotFoundError(error)) {
    const modelHint = model ? ` "${model}"` : '';
    return `${label} model${modelHint} is unavailable (404) — it may have been renamed, retired by the provider, or misspelled. Open Settings and pick a current model for ${label} (or clear the field to use pue's default), then try again.`;
  }

  return rawMessage || 'Unknown LLM error.';
}

function sanitizeTurns(turns) {
  const valid = new Set(['user', 'assistant']);
  return (turns || []).filter(t => valid.has(t.role)).map(t => ({ role: t.role, text: String(t.text || '') }));
}

// MiniMax is OpenAI-compatible and exposes two regional gateways. MiniMax-M3
// accepts image input, so it reuses the OpenAI screenshot path via baseURL.
const MINIMAX_BASE_URLS = {
  global_en: 'https://api.minimax.io/v1',
  cn_zh: 'https://api.minimaxi.com/v1'
};

function stripDataUrl(dataUrl) {
  const m = /^data:(.+?);base64,(.*)$/s.exec(dataUrl || '');
  return m ? { mime: m[1], b64: m[2] } : null;
}

// What a stream that ends with no usable answer says, instead of a blank
// bubble. Reasoning models think inside the output cap: when the thinking
// uses it all, the stream ends with finish_reason "length" and no text
// (Pue audit 2026-11-04: 118 of 2,675 fast-tier answers came back empty).
const LENGTH_EMPTY_MESSAGE = 'No answer this time: the model used its whole length limit on thinking and wrote nothing. Ask again, or ask a shorter question.';
const EMPTY_ANSWER_MESSAGE = 'The model sent back an empty answer. Ask again.';
const LENGTH_CUT_NOTE = '\n\n(Cut off: the answer reached its length limit.)';
// A provider's safety filter (finish_reason "content_filter", Anthropic
// "refusal", Gemini SAFETY and its kin, or a known refusal sentence in the
// text) and Gemini's RECITATION filter. Only a clean stop is a whole answer;
// a stream that ends on an error or with no finish reason at all is
// incomplete too, and says so.
const FILTER_EMPTY_MESSAGE = "The AI provider's safety filter stopped this answer. Ask again with different words.";
const FILTER_CUT_NOTE = "\n\n(Incomplete: the AI provider's safety filter stopped this answer. Ask again with different words to get the rest.)";
const RECITATION_EMPTY_MESSAGE = 'The AI provider stopped this answer because it repeated published text. Ask again with different words.';
const RECITATION_CUT_NOTE = '\n\n(Incomplete: the AI provider stopped this answer because it repeated published text.)';
const INCOMPLETE_CUT_NOTE = '\n\n(Incomplete: the answer stopped before the model finished. Ask again to get the rest.)';

// Every stop reason pue knows, lower-cased: OpenAI-style finish_reason,
// Anthropic stop_reason, Gemini finishReason, and the end-of-turn words that
// own-key OpenAI-compatible servers send instead of "stop" (TGI "eos_token",
// llama.cpp/vLLM-style "eos", Anthropic-style "end_turn" and
// "stop_sequence" through a proxy, ...). Any other reason (error, OTHER,
// abort, ...) is 'incomplete'.
const CLEAN_STOPS = new Set([
  'stop', 'stopped', 'end_turn', 'end_of_turn', 'end', 'eos', 'eos_token', 'eot', 'eot_id', 'eog',
  'stop_sequence', 'stop_token', 'stop_word', 'tool_calls', 'tool_use', 'function_call',
  'complete', 'completed', 'finished', 'done'
]);
const LENGTH_STOPS = new Set(['length', 'max_tokens', 'max_output_tokens', 'max_length', 'max_new_tokens', 'limit', 'model_context_window_exceeded']);
const FILTER_STOPS = new Set(['content_filter', 'refusal', 'safety', 'prohibited_content', 'blocklist', 'spii', 'image_safety', 'image_prohibited_content']);
const RECITATION_STOPS = new Set(['recitation', 'image_recitation']);
// Gemini's "not set" value means the same as no reason at all.
const NO_REASON = new Set(['', 'finish_reason_unspecified']);

// evidence.cutShort: the stream itself shows that it did not reach its end
// (cancelled by watchdog, closed before "data: [DONE]", or no message_stop).
// Anthropic, no message_stop). A stream with no stop reason is incomplete
// only with such evidence: own-key servers that send no reason at all
// otherwise got "(Incomplete: ...)" on every answer.
function stopKind(reason, refused, evidence) {
  if (refused) return 'filter';
  const r = String(reason || '').toLowerCase();
  if (NO_REASON.has(r)) return evidence && evidence.cutShort ? 'incomplete' : 'clean';
  if (CLEAN_STOPS.has(r)) return 'clean';
  if (LENGTH_STOPS.has(r)) return 'length';
  if (FILTER_STOPS.has(r)) return 'filter';
  if (RECITATION_STOPS.has(r)) return 'recitation';
  return 'incomplete';
}

const EMPTY_MESSAGES = { length: LENGTH_EMPTY_MESSAGE, filter: FILTER_EMPTY_MESSAGE, recitation: RECITATION_EMPTY_MESSAGE };
const CUT_NOTES = { length: LENGTH_CUT_NOTE, filter: FILTER_CUT_NOTE, recitation: RECITATION_CUT_NOTE, incomplete: INCOMPLETE_CUT_NOTE };

function emptyAnswerError(kind, finishReason) {
  const error = new Error(EMPTY_MESSAGES[kind] || EMPTY_ANSWER_MESSAGE);
  error.emptyAnswer = true;
  error.filtered = kind === 'filter';
  error.stopKind = kind;
  error.finishReason = finishReason || null;
  return error;
}

// Refusal messages that an upstream host streams as if they were the answer.
// OpenRouter-hosted models sometimes send the first one as normal content,
// alone or glued to a partial answer mid-word ("...streaming of the ascendingThe request was rejected
// because..."), and then finish_reason "content_filter". Only provider messages are listed, never "I can't help with that" phrases, which
// can be real content.
//   exact: the message word for word, case and spacing as the provider sends it.
//   start: the first words of it; every wording of that message starts so.
// Three rules (blind verifies of 3282584 and 992973d):
// - A clean stop is a whole answer. It counts as refused only when the WHOLE
//   answer is one of the exact messages (case-sensitive), with nothing but
//   closing punctuation around it. An answer that merely ends with similar
//   words ("...warn users that the output data may contain inappropriate
//   content.") is never cut, never labelled, never asked again.
// - A filter stop (content_filter, refusal, SAFETY, ...): the provider's
//   message is cut off from its start to the end of the text, whatever the
//   wording after it ("high-risk", "(request id: ...)", a double space, more
//   words, the same message twice), if that start is within the last
//   REFUSAL_WINDOW characters.
// - Any other stop (length, error, cut short, ...) keeps all of its text,
//   with its own note: "The request was rejected because the token
//   expired, ..." at the end of a length cut is content, not a refusal.
const REFUSALS = [
  // Xiaomi MiMo and Moonshot gateway filter wording.
  { start: 'The request was rejected because', exact: ['The request was rejected because it was considered high risk'] },
  // Alibaba Qwen (DashScope "data_inspection_failed").
  { start: 'Input data may contain inappropriate content', exact: ['Input data may contain inappropriate content'] },
  { start: 'Output data may contain inappropriate content', exact: ['Output data may contain inappropriate content'] },
  // DeepSeek content filter wording.
  { start: 'Content Exists Risk', exact: ['Content Exists Risk'] },
  // Zhipu GLM code 1301: whole notice or first sentence alone.
  { start: '系统检测到输入或生成内容可能包含不安全或敏感内容', exact: ['系统检测到输入或生成内容可能包含不安全或敏感内容，请您避免输入易产生敏感内容的提示语，感谢您的配合。', '系统检测到输入或生成内容可能包含不安全或敏感内容'] }
];
const REFUSAL_SENTENCES = REFUSALS.flatMap((r) => r.exact);
// A provider's message (with its request id, a second copy, ...) is short;
// text that goes on longer than this after a "start" is content.
const REFUSAL_WINDOW = 240;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The whole answer is one or more exact messages, with only whitespace and
// closing punctuation around them.
const WHOLE_REFUSAL = new RegExp('^\\s*(?:(?:' +
  REFUSAL_SENTENCES.slice().sort((a, b) => b.length - a.length).map(escapeRe).join('|') +
  ')[\\s.。!！,，;；:："\'”’)\\]}]*)+$', 'u');

// Does text[i..] start with `start`? Case-sensitive; any run of whitespace
// counts as one space. 'full' (all of it), 'partial' (the text ends inside
// it: it could still grow into it), or null.
function startsAt(text, i, start) {
  let t = i;
  for (let k = 0; k < start.length; k++) {
    if (t >= text.length) return 'partial';
    if (start[k] === ' ') {
      if (!/\s/u.test(text[t])) return null;
      while (t < text.length && /\s/u.test(text[t])) t++;
    } else if (text[t] === start[k]) {
      t++;
    } else {
      return null;
    }
  }
  return 'full';
}

// Takes the streamed text piece by piece and gives back the text that is safe
// to show. From a refusal start in the last REFUSAL_WINDOW characters (a
// whole one, or one the text could still grow into, even glued mid-word to
// the last word), text is held until the stream ends; anything earlier
// streams at once. end(kind) gets the stop kind and applies the three rules
// above: it gives back the rest of the text, or the text before the refusal.
function refusalFilter(refusals = REFUSALS) {
  let text = '';
  let shown = 0;
  let refused = false;
  const from = () => Math.max(shown, text.length - REFUSAL_WINDOW);
  function startAt(i) {
    let found = null;
    for (const r of refusals) {
      const m = startsAt(text, i, r.start);
      if (m === 'full') return 'full';
      if (m) found = m;
    }
    return found;
  }
  // The first place text is held from (a full or a growing start), or the end.
  function holdFrom() {
    for (let i = from(); i < text.length; i++) if (startAt(i)) return i;
    return text.length;
  }
  // The first full refusal start that can still be cut off, or -1.
  function refusalFrom() {
    for (let i = from(); i < text.length; i++) if (startAt(i) === 'full') return i;
    return -1;
  }
  function release(to) {
    const out = text.slice(shown, to);
    shown = to;
    return out;
  }
  function drop(at) {
    refused = true;
    const out = release(at);
    shown = text.length;
    return out;
  }
  return {
    push(piece) {
      text += piece;
      return release(holdFrom());
    },
    end(kind = 'clean') {
      if (kind === 'clean') {
        // Only whitespace can have been shown before a whole-answer message.
        return WHOLE_REFUSAL.test(text) && !text.slice(0, shown).trim() ? drop(shown) : release(text.length);
      }
      if (kind !== 'filter') return release(text.length);
      const at = refusalFrom();
      return at < 0 ? release(text.length) : drop(at);
    },
    get refused() { return refused; }
  };
}

// The visible answer of one stream: every piece goes through the refusal
// filter, and only what passes reaches onToken. finish() takes the stream's
// stop reason (and evidence that it was cut short) and returns the shown
// text with its stop kind.
function answerText(onToken) {
  const filter = refusalFilter();
  let text = '';
  const emit = (piece) => { if (piece) { text += piece; onToken(piece); } };
  return {
    add(piece) { emit(filter.push(piece)); },
    finish(finishReason, evidence) {
      const kind = stopKind(finishReason, false, evidence);
      emit(filter.end(kind));
      return { text, kind: filter.refused ? 'filter' : kind, finishReason: finishReason || null };
    }
  };
}

// The end of a stream: never a blank answer, never a refusal sentence shown
// as the answer, and an answer that did not stop cleanly says why. lengthCut
// 'ellipsis' (slide captions, meeting notes) trims the cut text and ends it
// with "…" instead of a note.
function settleAnswer(answer, onToken, lengthCut) {
  const { text, kind, finishReason } = answer;
  if (!String(text || '').trim()) throw emptyAnswerError(kind, finishReason);
  if (kind === 'clean') return text;
  if (lengthCut === 'ellipsis') return trimCut(text) + '…';
  const note = CUT_NOTES[kind];
  onToken(note);
  return text + note;
}

// A cut caption ends without a dangling space, comma, colon or dash.
function trimCut(text) {
  return String(text).replace(/[\s,;:\-\u2013\u2014]+$/u, '');
}

// One streamed chunk: its text (if any) and its finish reason (if any).
// Every chunk counts as activity, reasoning-only ones included, so a model
// that thinks for a while is not taken for a stalled stream. onActivity gets
// the chunk's kind: 'text', 'thinking' (reasoning only) or 'other'. The
// reasoning text itself never leaves this function.
function readChunk(part, onActivity) {
  const choice = part && part.choices && part.choices[0];
  const delta = (choice && choice.delta) || {};
  const text = delta.content || '';
  const thinking = !text && !!(delta.reasoning || delta.reasoning_content ||
    (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length));
  if (typeof onActivity === 'function') {
    try { onActivity(text ? 'text' : thinking ? 'thinking' : 'other'); } catch { /* a watchdog hook must never break the answer */ }
  }
  return { text, finish: (choice && choice.finish_reason) || '' };
}

// SDK request options that carry pue's cancel signal (none: SDK defaults).
function requestOptions(signal) {
  return signal ? { signal } : undefined;
}

// OpenAI-compatible gateways end SSE streams with "data: [DONE]". The SDK hides
// [DONE], so this fetch passes bytes through unchanged and records arrival.
function doneWatcher() {
  const seen = { done: false };
  const watchedFetch = async (input, init) => {
    const res = await fetch(input, init);
    if (!res.ok || !res.body || !/event-stream/i.test(res.headers.get('content-type') || '')) return res;
    const decoder = new TextDecoder();
    let tail = '\n'; // the stream starts at a line start
    const watch = new TransformStream({
      transform(chunk, controller) {
        const s = tail + decoder.decode(chunk, { stream: true });
        if (/\ndata: ?\[DONE\]/.test(s)) seen.done = true;
        tail = s.slice(-16);
        controller.enqueue(chunk);
      }
    });
    return new Response(res.body.pipeThrough(watch), { status: res.status, statusText: res.statusText, headers: res.headers });
  };
  return { seen, fetch: watchedFetch };
}

async function streamOpenAI({ apiKey, baseURL, model, system, turns, imageDataUrl, maxTokens, onToken, onActivity, onResponse, lengthCut, signal, watchDone }) {
  const OpenAI = require('openai');
  const watcher = watchDone ? doneWatcher() : null;
  const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}), ...(watcher ? { fetch: watcher.fetch } : {}) });
  const messages = [{ role: 'system', content: system }];
  turns.forEach((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      messages.push({
        role: 'user', content: [
          { type: 'text', text: t.text },
          { type: 'image_url', image_url: { url: imageDataUrl } }
        ]
      });
    } else {
      messages.push({ role: t.role, content: t.text });
    }
  });
  // signal: when pue stops waiting (watchdog, caption timer), the request is
  // cancelled too, so the provider stops generating and billing it.
  const pending = client.chat.completions.create({ model, messages, stream: true, max_tokens: maxTokens }, requestOptions(signal));
  let stream;
  if (typeof onResponse === 'function' && pending && typeof pending.withResponse === 'function') {
    const { data, response } = await pending.withResponse();
    try { onResponse(response); } catch { /* a display hook must never break the answer */ }
    stream = data;
  } else {
    stream = await pending;
  }
  const answer = answerText(onToken);
  let finish = '';
  for await (const part of stream) {
    const chunk = readChunk(part, onActivity);
    if (chunk.text) answer.add(chunk.text);
    if (chunk.finish) finish = chunk.finish;
  }
  const cutShort = !!(signal && signal.aborted) || !!(watcher && !watcher.seen.done);
  return settleAnswer(answer.finish(finish, { cutShort }), onToken, lengthCut);
}

// Azure AI Foundry Models API (cognitiveservices.azure.com hosts) lives under
// {endpoint}/openai/v1 and authenticates with the `api-key` header.
function normalizeAzureBaseURL(raw) {
  let u = String(raw || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  if (!u) return '';
  if (/cognitiveservices\.azure\.com/i.test(u) && !/\/openai\/v1$/i.test(u)) {
    u += '/openai/v1';
  }
  return u;
}

async function streamAzure({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken, onActivity, endpoint, lengthCut, signal }) {
  const url = normalizeAzureBaseURL(endpoint);
  if (!url) throw new Error('Missing Azure endpoint. Add your Azure AI Foundry or Azure OpenAI endpoint in Settings.');
  const messages = [{ role: 'system', content: system }];
  turns.forEach((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      messages.push({ role: 'user', content: [
        { type: 'text', text: t.text },
        { type: 'image_url', image_url: { url: imageDataUrl } }
      ] });
    } else {
      messages.push({ role: t.role, content: t.text });
    }
  });
  const OpenAI = require('openai');
  let client;
  if (/openai\.azure\.com/i.test(url)) {
    client = new OpenAI.AzureOpenAI({ endpoint: url.replace(/\/openai$/i, ''), apiKey, apiVersion: '2024-10-21' });
  } else {
    // Foundry / OpenAI-compatible base: force the `api-key` header and drop the
    // Authorization header the SDK adds by default (those hosts don't take a Bearer key).
    const azureFetch = async (input, init) => {
      const headers = new Headers(init && init.headers);
      headers.set('api-key', apiKey);
      headers.delete('authorization');
      return fetch(input, { ...init, headers });
    };
    client = new OpenAI({ baseURL: url, apiKey, fetch: azureFetch });
  }
  const stream = await client.chat.completions.create({ model, messages, stream: true, max_completion_tokens: maxTokens }, requestOptions(signal));
  const answer = answerText(onToken);
  let finish = '';
  for await (const part of stream) {
    const chunk = readChunk(part, onActivity);
    if (chunk.text) answer.add(chunk.text);
    if (chunk.finish) finish = chunk.finish;
  }
  return settleAnswer(answer.finish(finish, { cutShort: !!(signal && signal.aborted) }), onToken, lengthCut);
}

async function streamAnthropic({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken, lengthCut, signal }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const messages = turns.map((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      const content = [];
      if (img) content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.b64 } });
      content.push({ type: 'text', text: t.text });
      return { role: 'user', content };
    }
    return { role: t.role, content: t.text };
  });
  const stream = await client.messages.create({ model, max_tokens: maxTokens, system, messages, stream: true }, requestOptions(signal));
  // stop_reason comes in the message_delta event: end_turn, max_tokens,
  // refusal, ... The stream ends with message_stop: without it (and with no
  // stop_reason) it did not finish.
  const answer = answerText(onToken);
  let stop = '';
  let ended = false;
  for await (const ev of stream) {
    if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') answer.add(ev.delta.text);
    else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason;
    else if (ev.type === 'message_stop') ended = true;
  }
  return settleAnswer(answer.finish(stop, { cutShort: !ended || !!(signal && signal.aborted) }), onToken, lengthCut);
}

// Gemini 3.x counts its internal "thinking" tokens against maxOutputTokens, so
// a 700-token cap was mostly eaten by reasoning and the visible answer came
// back truncated mid-sentence (measured: 3.8-flash spends ~390 thinking tokens
// on a short notes prompt by default). Fast tier: thinkingLevel "low", which
// on flash means no thinking at all (0 thought tokens, ~3x faster). Smart tier:
// leave the model's default reasoning alone. Either way, give the cap headroom
// for thoughts so the visible budget is what maxTokens says.
// (thinkingBudget: 0 is rejected by pro models and "minimal" by flash, so
// "low" is the one setting that works across the family.)
const GEMINI_THINKING_HEADROOM = { fast: 1024, smart: 4096 };
function geminiGenerationConfig({ system, maxTokens, thinking }) {
  const config = {
    systemInstruction: system,
    maxOutputTokens: maxTokens + (thinking ? GEMINI_THINKING_HEADROOM.smart : GEMINI_THINKING_HEADROOM.fast)
  };
  if (!thinking) config.thinkingConfig = { thinkingLevel: 'low' };
  return config;
}

async function streamGemini({ apiKey, model, system, turns, imageDataUrl, maxTokens, thinking, onToken, lengthCut, signal }) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const contents = turns.map((t, i) => {
    const last = i === turns.length - 1;
    const parts = [{ text: t.text }];
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      if (img) parts.push({ inlineData: { mimeType: img.mime, data: img.b64 } });
    }
    return { role: t.role === 'assistant' ? 'model' : 'user', parts };
  });
  const config = geminiGenerationConfig({ system, maxTokens, thinking });
  if (signal) config.abortSignal = signal;
  let stream;
  try {
    stream = await ai.models.generateContentStream({ model, contents, config });
  } catch (e) {
    // A model that predates thinkingLevel (or a custom id that rejects it)
    // should still answer: retry once without the thinking setting.
    if (!config.thinkingConfig || !/thinking/i.test((e && e.message) || '')) throw e;
    delete config.thinkingConfig;
    stream = await ai.models.generateContentStream({ model, contents, config });
  }
  // finishReason comes on the last candidate: STOP, MAX_TOKENS, SAFETY,
  // RECITATION, ... A blocked prompt has no candidate, only
  // promptFeedback.blockReason: the safety filter stopped it.
  const answer = answerText(onToken);
  let stop = '';
  for await (const chunk of stream) {
    const t = chunk && chunk.text;
    if (t) answer.add(t);
    const candidate = chunk && Array.isArray(chunk.candidates) ? chunk.candidates[0] : null;
    if (candidate && candidate.finishReason) stop = candidate.finishReason;
    else if (!stop && chunk && chunk.promptFeedback && chunk.promptFeedback.blockReason) stop = 'SAFETY';
  }
  return settleAnswer(answer.finish(stop, { cutShort: !!(signal && signal.aborted) }), onToken, lengthCut);
}

async function streamOllama({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken, signal }) {
  const baseUrl = apiKey || 'http://localhost:11434';
  const url = `${baseUrl.replace(/\/$/, '')}/api/chat`;

  const messages = [{ role: 'system', content: system }];
  turns.forEach((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      if (img) {
        messages.push({ role: 'user', content: t.text, images: [img.b64] });
      } else {
        messages.push({ role: 'user', content: t.text });
      }
    } else {
      messages.push({ role: t.role, content: t.text });
    }
  });

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true }),
      ...(signal ? { signal } : {})
    });
  } catch (err) {
    throw new Error(`Ollama fetch failed: ${err.message}. Is Ollama running at ${baseUrl}?`);
  }

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
  }

  const decoder = new TextDecoder();
  let full = '';
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        if (data.message && data.message.content) {
          full += data.message.content;
          onToken(data.message.content);
        }
      } catch (e) {
        // ignore
      }
    }
  }
  if (buffer.trim()) {
    try {
      const data = JSON.parse(buffer);
      if (data.message && data.message.content) {
        full += data.message.content;
        onToken(data.message.content);
      }
    } catch (e) { }
  }
  return full;
}

function shouldFallbackFromTools(error) {
  if (!error) return false;
  if (isAuthError(error) || isQuotaError(error) || isRateLimitError(error)) return false;
  const { status, text } = errorSignals(error);
  if (status === 401 || status === 403 || status === 429) return false;
  if (status === 400 || status === 404 || status === 422 || status === 501) return true;
  return /tool|function.?call|not supported|unrecognized|unknown field/i.test(text);
}

const LEVEL1_CLEAR_THRESHOLD = 1500;
function formatToolResultForRound(record, currentRound) {
  if (currentRound - record.roundIndex >= 2 && record.rawContent.length > LEVEL1_CLEAR_THRESHOLD) {
    return `[Cleared after read: ${record.summary || record.name}; re-read if needed]`;
  }
  return record.rawContent;
}

function toOpenAiTools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }));
}

function buildOpenAiClient(provider, { apiKey, baseURL, endpoint, watchDone }, minimaxRegion) {
  const OpenAI = require('openai');
  if (provider === 'azure') {
    const url = normalizeAzureBaseURL(endpoint);
    if (!url) throw new Error('Missing Azure endpoint. Add your Azure AI Foundry or Azure OpenAI endpoint in Settings.');
    if (/openai\.azure\.com/i.test(url)) {
      return { client: new OpenAI.AzureOpenAI({ endpoint: url.replace(/\/openai$/i, ''), apiKey, apiVersion: '2024-10-21' }), isAzure: true };
    }
    const azureFetch = async (input, init) => {
      const headers = new Headers(init && init.headers);
      headers.set('api-key', apiKey);
      headers.delete('authorization');
      return fetch(input, { ...init, headers });
    };
    return { client: new OpenAI({ baseURL: url, apiKey, fetch: azureFetch }), isAzure: true };
  }

  let resolvedBase = baseURL;
  if (provider === 'groq') resolvedBase = 'https://api.groq.com/openai/v1';
  else if (provider === 'cerebras') resolvedBase = CEREBRAS_BASE_URL;
  else if (provider === 'minimax') resolvedBase = MINIMAX_BASE_URLS[minimaxRegion] || MINIMAX_BASE_URLS.global_en;
  else if (provider === 'deepseek') resolvedBase = DEEPSEEK_BASE_URL;

  const watcher = watchDone ? doneWatcher() : null;
  const client = new OpenAI({
    apiKey,
    ...(resolvedBase ? { baseURL: resolvedBase } : {}),
    ...(watcher ? { fetch: watcher.fetch } : {})
  });
  return { client, isAzure: false };
}

async function streamOpenAiToolLoop(provider, args, minimaxRegion) {
  const {
    model,
    system,
    turns,
    imageDataUrl,
    maxTokens,
    tools,
    executeTool,
    onToken,
    onActivity,
    onToolCall,
    lengthCut,
    signal,
    maxToolRounds = 4
  } = args;

  const { client, isAzure } = buildOpenAiClient(provider, args, minimaxRegion);
  const openAiTools = toOpenAiTools(tools);

  const buildInitialOpenAiMessages = (withImage) => {
    const msgs = [{ role: 'system', content: system }];
    turns.forEach((t, i) => {
      const last = i === turns.length - 1;
      if (last && withImage && imageDataUrl && t.role === 'user') {
        msgs.push({
          role: 'user',
          content: [
            { type: 'text', text: t.text },
            { type: 'image_url', image_url: { url: imageDataUrl } }
          ]
        });
      } else {
        msgs.push({ role: t.role, content: t.text });
      }
    });
    return msgs;
  };

  // Track assistant + tool turns dynamically so Level-1 clearing can compact older tool outputs.
  const roundRecords = [];

  for (let roundIdx = 0; roundIdx <= maxToolRounds; roundIdx++) {
    const allowTools = roundIdx < maxToolRounds;
    const messages = buildInitialOpenAiMessages(roundIdx === 0);
    for (const rec of roundRecords) {
      messages.push(rec.assistantMessage);
      for (const tr of rec.toolRecords) {
        messages.push({
          role: 'tool',
          tool_call_id: tr.callId,
          content: formatToolResultForRound(tr, roundIdx)
        });
      }
    }
    if (!allowTools) {
      messages.push({
        role: 'user',
        content: 'Tool budget reached. Provide your best grounded answer now from the gathered evidence.'
      });
    }

    const reqBody = {
      model,
      messages,
      stream: true,
      ...(isAzure ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
      ...(allowTools ? { tools: openAiTools } : {})
    };

    let stream;
    try {
      stream = await client.chat.completions.create(reqBody, requestOptions(signal));
    } catch (err) {
      if (err && typeof err === 'object') err.toolRound = roundIdx;
      throw err;
    }
    const answer = answerText(onToken);
    const toolCallMap = new Map();
    let finish = '';

    for await (const part of stream) {
      const choice = part && Array.isArray(part.choices) ? part.choices[0] : null;
      const delta = choice && choice.delta;
      if (delta && Array.isArray(delta.tool_calls)) {
        if (typeof onActivity === 'function') onActivity('other');
        for (const tc of delta.tool_calls) {
          const idx = tc.index || 0;
          const prev = toolCallMap.get(idx) || { id: '', name: '', arguments: '' };
          if (tc.id) prev.id = tc.id;
          if (tc.function && tc.function.name) prev.name += tc.function.name;
          if (tc.function && typeof tc.function.arguments === 'string') prev.arguments += tc.function.arguments;
          toolCallMap.set(idx, prev);
        }
      }
      const chunk = readChunk(part, onActivity);
      if (chunk.text) answer.add(chunk.text);
      if (chunk.finish) finish = chunk.finish;
    }

    const toolCalls = Array.from(toolCallMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, v], idx) => ({
        id: v.id || `call_${roundIdx}_${idx}`,
        name: v.name,
        arguments: v.arguments || '{}'
      }))
      .filter((tc) => tc.name);

    if (allowTools && toolCalls.length > 0) {
      const assistantMessage = {
        role: 'assistant',
        content: null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: LENGTH_STOPS.has(String(finish || '').toLowerCase()) ? '{}' : tc.arguments
          }
        }))
      };

      const toolRecords = [];
      const isTruncated = LENGTH_STOPS.has(String(finish || '').toLowerCase());
      for (const tc of toolCalls) {
        if (isTruncated) {
          toolRecords.push({
            roundIndex: roundIdx,
            callId: tc.id,
            name: tc.name,
            summary: `${tc.name} (truncated)`,
            rawContent:
              '[Tool call truncated because output hit max_tokens; request a smaller file range or answer directly from current evidence.]'
          });
          continue;
        }
        let parsedArgs = {};
        try {
          parsedArgs = JSON.parse(tc.arguments || '{}');
        } catch (_) {
          toolRecords.push({
            roundIndex: roundIdx,
            callId: tc.id,
            name: tc.name,
            summary: `${tc.name} (invalid JSON)`,
            rawContent: '[Invalid JSON arguments in tool call; retry with valid JSON.]'
          });
          continue;
        }
        if (typeof onToolCall === 'function') {
          try {
            onToolCall({ name: tc.name, args: parsedArgs, round: roundIdx });
          } catch (_) {}
        }
        const res = await executeTool(tc.name, parsedArgs);
        toolRecords.push({
          roundIndex: roundIdx,
          callId: tc.id,
          name: tc.name,
          summary: (res && res.summary) || tc.name,
          rawContent: String((res && res.content) || '')
        });
      }
      roundRecords.push({ assistantMessage, toolRecords });
      continue;
    }

    const cutShort = !!(signal && signal.aborted);
    return settleAnswer(answer.finish(finish, { cutShort }), onToken, lengthCut);
  }

  throw new Error(EMPTY_ANSWER_MESSAGE);
}

async function streamAnthropicToolLoop(args) {
  const {
    apiKey,
    model,
    system,
    turns,
    imageDataUrl,
    maxTokens,
    tools,
    executeTool,
    onToken,
    onActivity,
    onToolCall,
    lengthCut,
    signal,
    maxToolRounds = 4
  } = args;

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const anthropicTools = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters
  }));

  const buildInitialAnthropicMessages = (withImage) =>
    turns.map((t, i) => {
      const last = i === turns.length - 1;
      if (last && withImage && imageDataUrl && t.role === 'user') {
        const img = stripDataUrl(imageDataUrl);
        const content = [];
        if (img) content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.b64 } });
        content.push({ type: 'text', text: t.text });
        return { role: 'user', content };
      }
      return { role: t.role, content: t.text };
    });

  const roundRecords = [];

  for (let roundIdx = 0; roundIdx <= maxToolRounds; roundIdx++) {
    const allowTools = roundIdx < maxToolRounds;
    const messages = buildInitialAnthropicMessages(roundIdx === 0);
    for (const rec of roundRecords) {
      messages.push(rec.assistantMessage);
      messages.push({
        role: 'user',
        content: rec.toolRecords.map((tr) => ({
          type: 'tool_result',
          tool_use_id: tr.callId,
          content: formatToolResultForRound(tr, roundIdx)
        }))
      });
    }
    if (!allowTools) {
      messages.push({ role: 'user', content: 'Tool budget reached. Answer directly now.' });
    }

    const reqBody = {
      model,
      max_tokens: maxTokens,
      system,
      messages,
      stream: true,
      ...(allowTools ? { tools: anthropicTools } : {})
    };

    let stream;
    try {
      stream = await client.messages.create(reqBody, requestOptions(signal));
    } catch (err) {
      if (err && typeof err === 'object') err.toolRound = roundIdx;
      throw err;
    }
    const answer = answerText(onToken);
    const toolBlocks = new Map();
    let stop = '';
    let ended = false;

    for await (const ev of stream) {
      if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use') {
        if (typeof onActivity === 'function') onActivity('other');
        toolBlocks.set(ev.index, {
          id: ev.content_block.id,
          name: ev.content_block.name,
          initialInput: ev.content_block.input,
          jsonText: ''
        });
      } else if (ev.type === 'content_block_delta' && ev.delta) {
        if (ev.delta.type === 'text_delta') {
          if (typeof onActivity === 'function') onActivity('text');
          answer.add(ev.delta.text);
        } else if (ev.delta.type === 'input_json_delta' && toolBlocks.has(ev.index)) {
          if (typeof onActivity === 'function') onActivity('other');
          toolBlocks.get(ev.index).jsonText += ev.delta.partial_json || '';
        }
      } else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason) {
        stop = ev.delta.stop_reason;
      } else if (ev.type === 'message_stop') {
        ended = true;
      }
    }

    const toolCalls = Array.from(toolBlocks.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, b]) => b);

    if (allowTools && toolCalls.length > 0) {
      const isTruncated = LENGTH_STOPS.has(String(stop || '').toLowerCase());
      const assistantContent = [];
      const toolRecords = [];

      for (const tc of toolCalls) {
        let parsedInput = tc.initialInput && Object.keys(tc.initialInput).length ? tc.initialInput : {};
        let invalidJson = false;
        if (!isTruncated && tc.jsonText.trim()) {
          try {
            parsedInput = JSON.parse(tc.jsonText);
          } catch (_) {
            parsedInput = {};
            invalidJson = true;
          }
        }
        assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: parsedInput });

        if (isTruncated) {
          toolRecords.push({
            roundIndex: roundIdx,
            callId: tc.id,
            name: tc.name,
            summary: `${tc.name} (truncated)`,
            rawContent: '[Tool call truncated because output hit max_tokens; request a smaller slice.]'
          });
          continue;
        }
        if (invalidJson) {
          toolRecords.push({
            roundIndex: roundIdx,
            callId: tc.id,
            name: tc.name,
            summary: `${tc.name} (invalid JSON)`,
            rawContent: '[Invalid JSON arguments in tool call; retry with valid JSON.]'
          });
          continue;
        }
        if (typeof onToolCall === 'function') {
          try {
            onToolCall({ name: tc.name, args: parsedInput, round: roundIdx });
          } catch (_) {}
        }
        const res = await executeTool(tc.name, parsedInput);
        toolRecords.push({
          roundIndex: roundIdx,
          callId: tc.id,
          name: tc.name,
          summary: (res && res.summary) || tc.name,
          rawContent: String((res && res.content) || '')
        });
      }

      roundRecords.push({ assistantMessage: { role: 'assistant', content: assistantContent }, toolRecords });
      continue;
    }

    return settleAnswer(answer.finish(stop, { cutShort: !ended || !!(signal && signal.aborted) }), onToken, lengthCut);
  }

  throw new Error(EMPTY_ANSWER_MESSAGE);
}

async function streamGeminiToolLoop(args) {
  const {
    apiKey,
    model,
    system,
    turns,
    imageDataUrl,
    maxTokens,
    thinking,
    tools,
    executeTool,
    onToken,
    onActivity,
    onToolCall,
    lengthCut,
    signal,
    maxToolRounds = 4
  } = args;

  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });

  const buildInitialGeminiContents = (withImage) =>
    turns.map((t, i) => {
      const last = i === turns.length - 1;
      const parts = [{ text: t.text }];
      if (last && withImage && imageDataUrl && t.role === 'user') {
        const img = stripDataUrl(imageDataUrl);
        if (img) parts.push({ inlineData: { mimeType: img.mime, data: img.b64 } });
      }
      return { role: t.role === 'assistant' ? 'model' : 'user', parts };
    });

  const roundRecords = [];

  for (let roundIdx = 0; roundIdx <= maxToolRounds; roundIdx++) {
    const allowTools = roundIdx < maxToolRounds;
    const contents = buildInitialGeminiContents(roundIdx === 0);
    for (const rec of roundRecords) {
      contents.push(rec.modelTurn);
      contents.push({
        role: 'user',
        parts: rec.toolRecords.map((tr) => ({
          functionResponse: {
            name: tr.name,
            response: { result: formatToolResultForRound(tr, roundIdx) }
          }
        }))
      });
    }
    if (!allowTools) {
      contents.push({ role: 'user', parts: [{ text: 'Tool budget reached. Answer directly now.' }] });
    }

    const config = geminiGenerationConfig({ system, maxTokens, thinking });
    if (signal) config.abortSignal = signal;
    if (allowTools) {
      config.tools = [
        {
          functionDeclarations: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters
          }))
        }
      ];
    }

    let stream;
    try {
      stream = await ai.models.generateContentStream({ model, contents, config });
    } catch (e) {
      if (!config.thinkingConfig || !/thinking/i.test((e && e.message) || '')) {
        if (e && typeof e === 'object') e.toolRound = roundIdx;
        throw e;
      }
      delete config.thinkingConfig;
      try {
        stream = await ai.models.generateContentStream({ model, contents, config });
      } catch (e2) {
        if (e2 && typeof e2 === 'object') e2.toolRound = roundIdx;
        throw e2;
      }
    }

    const answer = answerText(onToken);
    const functionCalls = [];
    let stop = '';

    for await (const chunk of stream) {
      const candidate = chunk && Array.isArray(chunk.candidates) ? chunk.candidates[0] : null;
      const parts = (candidate && candidate.content && candidate.content.parts) || [];
      for (const p of parts) {
        if (p && p.functionCall) {
          if (typeof onActivity === 'function') onActivity('other');
          functionCalls.push(p.functionCall);
        }
      }
      const t = chunk && chunk.text;
      if (t) {
        if (typeof onActivity === 'function') onActivity('text');
        answer.add(t);
      }
      if (candidate && candidate.finishReason) stop = candidate.finishReason;
      else if (!stop && chunk && chunk.promptFeedback && chunk.promptFeedback.blockReason) stop = 'SAFETY';
    }

    if (allowTools && functionCalls.length > 0) {
      const isTruncated = LENGTH_STOPS.has(String(stop || '').toLowerCase());
      const modelTurn = {
        role: 'model',
        parts: functionCalls.map((fc) => ({ functionCall: { name: fc.name, args: fc.args || {} } }))
      };
      const toolRecords = [];

      for (const fc of functionCalls) {
        if (isTruncated) {
          toolRecords.push({
            roundIndex: roundIdx,
            name: fc.name,
            summary: `${fc.name} (truncated)`,
            rawContent: '[Tool call truncated because output hit max_tokens.]'
          });
          continue;
        }
        const callArgs = fc.args || {};
        if (typeof onToolCall === 'function') {
          try {
            onToolCall({ name: fc.name, args: callArgs, round: roundIdx });
          } catch (_) {}
        }
        const res = await executeTool(fc.name, callArgs);
        toolRecords.push({
          roundIndex: roundIdx,
          name: fc.name,
          summary: (res && res.summary) || fc.name,
          rawContent: String((res && res.content) || '')
        });
      }

      roundRecords.push({ modelTurn, toolRecords });
      continue;
    }

    return settleAnswer(answer.finish(stop, { cutShort: !!(signal && signal.aborted) }), onToken, lengthCut);
  }

  throw new Error(EMPTY_ANSWER_MESSAGE);
}

async function streamWithTools(provider, args, minimaxRegion) {
  if (provider === 'anthropic') return streamAnthropicToolLoop(args);
  if (provider === 'gemini') return streamGeminiToolLoop(args);
  if (provider === 'ollama') {
    const err = new Error('Ollama tool loop unsupported; falling back to local chunk injection');
    err.status = 400;
    throw err;
  }
  if (
    ['openai', CUSTOM_PROVIDER, 'groq', 'cerebras', 'minimax', 'deepseek', 'azure'].includes(provider)
  ) {
    return streamOpenAiToolLoop(provider, args, minimaxRegion);
  }
  throw new Error('unknown provider: ' + provider);
}

function createLLM(settings) {
  const provider = settings.provider;
  const keys = settings.apiKeys || {};
  let apiKey = keys[provider];
  let baseURL = '';
  let configurationError = '';
  let missingKey = false;
  const tier = settings.smart ? 'smart' : 'fast';
  const models = settings.models || {};
  let model = (models[provider] || {})[tier];
  if (provider === 'gemini') {
    model = resolveGeminiModel(settings);
  }
  if (provider === 'anthropic' && DEAD_ANTHROPIC_MODEL_RE.test(model || '')) {
    model = tier === 'smart' ? CURRENT_ANTHROPIC_DEFAULT_SMART : CURRENT_ANTHROPIC_DEFAULT_FAST;
  }
  if (provider === 'deepseek' && DEAD_DEEPSEEK_MODEL_RE.test(model || '')) {
    model = /reasoner/i.test(model) ? CURRENT_DEEPSEEK_SMART_DEFAULT : CURRENT_DEEPSEEK_FAST_DEFAULT;
  }
  if (!model) model = DEFAULT_MODELS[provider] || '';
  const minimaxRegion = settings.minimaxRegion || 'global_en';
  const endpoint = settings.azureEndpoint || '';

  if (provider === CUSTOM_PROVIDER) {
    try {
      const clientOptions = createCompatibleClientOptions(apiKey, settings.baseUrl);
      apiKey = clientOptions.apiKey;
      baseURL = clientOptions.baseURL;
    } catch (error) {
      configurationError = error.message;
    }
    if (!model && !configurationError) {
      configurationError = 'Set a Fast or Smart model for the Custom provider.';
    }
  } else if (provider !== 'ollama' && !apiKey) {
    // Ollama is a local server: the field holds a URL, and no key is required.
    configurationError = `Add your ${normalizeProviderName(provider)} key in Settings.`;
    missingKey = true;
  }

  // Azure needs a second credential: the resource endpoint.
  if (!configurationError && provider === 'azure' && !endpoint) {
    configurationError = 'Add your Azure AI Foundry endpoint in Settings.';
  }

  const ready = !configurationError && !!model;
  const maxTokens = settings.smart ? 1400 : 700;
  const visionModel = model;

  return {
    provider, model, visionModel, apiKey, baseURL,
    ready,
    configurationError,
    missingKey,
    providerName: normalizeProviderName(provider),
    async stream(params) {
      if (!ready) throw new Error(configurationError || `Complete the ${provider} provider settings.`);
      const useModel = params && params.imageDataUrl ? visionModel : model;
      const args = { apiKey, baseURL, endpoint, model: useModel, maxTokens, thinking: !!settings.smart, ...params, turns: sanitizeTurns(params.turns) };
      if (!(Number.isFinite(args.maxTokens) && args.maxTokens > 0)) args.maxTokens = maxTokens;
      const wrap = (error, failedModel) => {
        const wrapped = formatProviderErrorMessage(error, provider, failedModel);
        return wrapped instanceof Error ? wrapped : new Error(wrapped);
      };

      const hasTools = Array.isArray(params && params.tools) && params.tools.length > 0 && typeof params.executeTool === 'function';
      if (!hasTools) {
        try {
          return await streamWith(provider, args, minimaxRegion);
        } catch (error) {
          throw wrap(error, useModel);
        }
      }

      const deepTimeoutMs =
        Number.isFinite(params.deepTimeoutMs) && params.deepTimeoutMs > 0 ? params.deepTimeoutMs : 35000;
      const wallController = new AbortController();
      const wallTimer = setTimeout(() => {
        wallController.abort(new Error('Deep repository lookup timed out. Please try again.'));
      }, deepTimeoutMs);
      if (typeof wallTimer.unref === 'function') wallTimer.unref();

      const combinedSignal = params.signal
        ? AbortSignal.any([params.signal, wallController.signal])
        : wallController.signal;

      let emittedTokens = false;
      const userOnToken = args.onToken || (() => {});
      const trackedArgs = {
        ...args,
        signal: combinedSignal,
        onToken: (tok) => {
          emittedTokens = true;
          userOnToken(tok);
        }
      };

      try {
        return await streamWithTools(provider, trackedArgs, minimaxRegion);
      } catch (error) {
        const failedAtRound0 = error && (error.toolRound === 0 || error.toolRound === undefined);
        if (failedAtRound0 && !emittedTokens && !combinedSignal.aborted && shouldFallbackFromTools(error)) {
          try {
            return await streamWith(
              provider,
              {
                ...trackedArgs,
                system: params.fallbackSystem || args.system,
                turns: sanitizeTurns(params.fallbackTurns || params.turns),
                tools: undefined,
                executeTool: undefined,
                onToolCall: undefined
              },
              minimaxRegion
            );
          } catch (fallbackErr) {
            throw wrap(fallbackErr, useModel);
          }
        }
        throw wrap(error, useModel);
      } finally {
        clearTimeout(wallTimer);
      }
    }
  };
}

function streamWith(provider, args, minimaxRegion) {
  if (provider === 'openai') return streamOpenAI(args);
  if (provider === CUSTOM_PROVIDER) return streamOpenAI(args);
  if (provider === 'ollama') return streamOllama(args);
  if (provider === 'groq') return streamOpenAI({ ...args, baseURL: 'https://api.groq.com/openai/v1' });
  if (provider === 'cerebras') return streamOpenAI({ ...args, baseURL: CEREBRAS_BASE_URL });
  if (provider === 'minimax') return streamOpenAI({ ...args, baseURL: MINIMAX_BASE_URLS[minimaxRegion] || MINIMAX_BASE_URLS.global_en });
  if (provider === 'deepseek') return streamOpenAI({ ...args, baseURL: DEEPSEEK_BASE_URL });
  if (provider === 'anthropic') return streamAnthropic(args);
  if (provider === 'gemini') return streamGemini(args);
  if (provider === 'azure') return streamAzure(args);
  return Promise.reject(new Error('unknown provider: ' + provider));
}

module.exports = {
  createLLM,
  formatProviderErrorMessage,
  isAuthError,
  normalizeProviderName,
  isQuotaError,
  isNotFoundError,
  geminiGenerationConfig,
  LENGTH_EMPTY_MESSAGE,
  EMPTY_ANSWER_MESSAGE,
  LENGTH_CUT_NOTE,
  FILTER_EMPTY_MESSAGE,
  FILTER_CUT_NOTE,
  RECITATION_EMPTY_MESSAGE,
  RECITATION_CUT_NOTE,
  INCOMPLETE_CUT_NOTE,
  REFUSAL_SENTENCES,
  refusalFilter,
  stopKind,
  resolveGeminiModel,
  CURRENT_GEMINI_DEFAULT,
  GEMINI_TRANSCRIBE_MODEL,
  GEMINI_TRANSCRIBE_LIVE_MODEL,
  CURRENT_ANTHROPIC_DEFAULT_FAST,
  CURRENT_ANTHROPIC_DEFAULT_SMART,
  isRateLimitError
};
