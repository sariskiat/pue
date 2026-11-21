// Atomic JSON settings store for BYOK providers and overlay preferences.
// Requires Electron lazily so pure Node unit tests never boot Electron.
const { createFileStore } = require('./settings-store-core');
const { normalizeBaseUrl } = require('./openai-compatible');

const MAX_AI_RULES_CHARS = 2000;
const MIN_OPACITY = 0.2;
const MAX_OPACITY = 1;

const LEGACY_SEED_KEYS = [
  'resumeText',
  'starStories',
  'jobDescription',
  'whyCompany',
  'whyLeaving',
  'workStyle',
  'salaryTarget',
  'questionsToAsk'
];

const VALID_PROVIDERS = new Set([
  'cerebras',
  'openai',
  'anthropic',
  'gemini',
  'custom',
  'ollama',
  'groq',
  'minimax',
  'deepseek',
  'azure'
]);

const DEFAULTS = {
  provider: 'openai',
  sttProvider: 'auto',
  localWhisper: {
    modelId: 'base.en',
    language: 'auto',
    threads: 0
  },
  smart: false,
  // macOS system-audio loopback lights up the menu-bar screen-share badge,
  // so keep it opt-in on macOS and on elsewhere.
  meetingAudio: process.platform !== 'darwin',
  baseUrl: '',
  minimaxRegion: 'global_en',
  apiKeys: {
    cerebras: '',
    openai: '',
    anthropic: '',
    gemini: '',
    deepgram: '',
    custom: '',
    ollama: '',
    groq: '',
    minimax: '',
    deepseek: '',
    azure: ''
  },
  azureEndpoint: '',
  legacyMigrated: false,
  resumeText: '',
  jobDescription: '',
  starStories: '',
  whyCompany: '',
  whyLeaving: '',
  workStyle: '',
  salaryTarget: '',
  questionsToAsk: '',
  aiRules: '',
  opacity: 1,
  slides: {
    enabled: false,
    intervalMs: 3000,
    threshold: 5,
    maxSlides: 50
  },
  windowX: null,
  windowY: null,
  models: {
    cerebras: { fast: 'qwen-3.8-27b', smart: 'qwen-3.8-27b' },
    openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' },
    anthropic: { fast: 'claude-haiku-4-5-20251001', smart: 'claude-sonnet-4-5-20250929' },
    gemini: { fast: 'gemini-3.8-flash', smart: 'gemini-3.1-pro-preview' },
    custom: { fast: '', smart: '' },
    ollama: { fast: 'llama3.2', smart: 'llama3.3' },
    groq: { fast: 'llama-3.1-8b-instant', smart: 'llama-3.3-70b-versatile' },
    minimax: { fast: 'MiniMax-M2.7', smart: 'MiniMax-M3' },
    deepseek: { fast: 'deepseek-flash', smart: 'deepseek-v4-pro' },
    azure: { fast: 'gpt-4o-mini', smart: 'gpt-4o' }
  }
};

function clampOpacity(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, Math.round(n * 100) / 100));
}

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && typeof base[k] === 'object' && base[k] !== null) {
      out[k] = deepMerge(base[k], over[k]);
    } else if (k === 'aiRules' && typeof over[k] === 'string') {
      out[k] = over[k].slice(0, MAX_AI_RULES_CHARS);
    } else {
      out[k] = over[k];
    }
  }
  return out;
}

// Strip obsolete upstream fields and heal retired provider names on load.
function sanitizeSettingsObject(raw) {
  const next = { ...raw };
  for (const key of Object.keys(next)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
      delete next[key];
    }
  }
  if (next.apiKeys && typeof next.apiKeys === 'object') {
    const cleanKeys = {};
    for (const k of Object.keys(DEFAULTS.apiKeys)) {
      cleanKeys[k] = typeof next.apiKeys[k] === 'string' ? next.apiKeys[k] : '';
    }
    next.apiKeys = cleanKeys;
  }
  if (next.models && typeof next.models === 'object') {
    const cleanModels = {};
    for (const k of Object.keys(DEFAULTS.models)) {
      cleanModels[k] = { ...DEFAULTS.models[k], ...(next.models[k] || {}) };
    }
    next.models = cleanModels;
  }
  if (!VALID_PROVIDERS.has(next.provider)) {
    next.provider = 'openai';
  }
  next.baseUrl = normalizeBaseUrl(next.baseUrl || '');
  next.opacity = clampOpacity(next.opacity);
  return next;
}

function stripRendererPatch(patch) {
  const out = {};
  for (const k of Object.keys(patch || {})) {
    if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) {
      out[k] = patch[k];
    }
  }
  return out;
}

function redactForRenderer(s) {
  return {
    ...s,
    apiKeys: { ...(s.apiKeys || {}) }
  };
}

function createSettingsStore(resolveUserDataDir) {
  const fileStore = createFileStore(resolveUserDataDir, 'cue-data.json');
  let data = null;
  let lastError = null;

  function save() {
    try {
      fileStore.persist(data);
      lastError = null;
      return true;
    } catch (e) {
      lastError = e;
      console.error('[pue] failed to save settings:', e && e.message);
      return false;
    }
  }

  function load() {
    if (data) return data;
    const loaded = fileStore.load();
    const raw = loaded ? loaded.data : {};
    const hadUnsupportedProvider = raw && raw.provider && !VALID_PROVIDERS.has(raw.provider);
    data = sanitizeSettingsObject(deepMerge(DEFAULTS, raw));
    if ((loaded && loaded.recoveredFromBackup) || hadUnsupportedProvider) {
      save();
    }
    return data;
  }

  // Extract legacy pasted text once so profile and workspace stores can seed cleanly.
  function consumeLegacyProfileSeed() {
    load();
    if (data.legacyMigrated) return null;
    const seed = {};
    let hasAny = false;
    for (const key of LEGACY_SEED_KEYS) {
      const val = typeof data[key] === 'string' ? data[key].trim() : '';
      seed[key] = val;
      if (val.length > 0) hasAny = true;
    }
    data = { ...data, legacyMigrated: true };
    save();
    return hasAny ? seed : null;
  }

  return {
    getSettings() {
      return load();
    },
    lastSaveError() {
      return lastError;
    },
    setSettings(patch) {
      load();
      data = sanitizeSettingsObject(deepMerge(data, stripRendererPatch(patch)));
      save();
      return data;
    },
    consumeLegacyProfileSeed,
    stripRendererPatch,
    redactForRenderer
  };
}

let defaultInstance = null;
function defaultStore() {
  if (!defaultInstance) {
    defaultInstance = createSettingsStore(() => {
      const { app } = require('electron');
      return app.getPath('userData');
    });
  }
  return defaultInstance;
}

module.exports = {
  MAX_AI_RULES_CHARS,
  MIN_OPACITY,
  MAX_OPACITY,
  clampOpacity,
  stripRendererPatch,
  redactForRenderer,
  createSettingsStore,
  getSettings() {
    return defaultStore().getSettings();
  },
  lastSaveError() {
    return defaultStore().lastSaveError();
  },
  setSettings(patch) {
    return defaultStore().setSettings(patch);
  },
  consumeLegacyProfileSeed() {
    return defaultStore().consumeLegacyProfileSeed();
  }
};
