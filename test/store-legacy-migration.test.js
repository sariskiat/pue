const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

test('store.js, llm.js, stt.js, and stt-streaming.js contain zero publik or applink references', () => {
  for (const rel of ['src/store.js', 'src/llm.js', 'src/stt.js', 'src/stt-streaming.js']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.equal(/publik|applink/i.test(src), false, `unexpected match in ${rel}`);
  }
});

test('consumeLegacyProfileSeed extracts legacy text once, preserves API keys, and heals publik provider', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pue-store-'));
  try {
    fs.writeFileSync(
      path.join(tmpDir, 'cue-data.json'),
      JSON.stringify({
        provider: 'publik',
        apiKeys: { openai: 'sk-keep-me', anthropic: 'sk-ant-keep', publik: 'pk_old' },
        resumeText: 'Senior Engineer with 6 years Python',
        starStories: 'Cut latency 40%',
        jobDescription: 'Staff AI Engineer',
        whyCompany: 'Strong infra team',
        whyLeaving: 'Seeking ownership',
        workStyle: 'Evidence first',
        salaryTarget: '$190k',
        questionsToAsk: 'How is on-call structured?'
      }),
      'utf8'
    );

    const { createSettingsStore } = require('../src/store');
    const s1 = createSettingsStore(() => tmpDir);
    const loaded = s1.getSettings();
    assert.equal(loaded.provider, 'openai');
    assert.equal(loaded.apiKeys.openai, 'sk-keep-me');
    assert.equal('publik' in loaded.apiKeys, false);
    assert.equal('publik' in loaded, false);

    const seed = s1.consumeLegacyProfileSeed();
    assert.deepEqual(seed, {
      resumeText: 'Senior Engineer with 6 years Python',
      starStories: 'Cut latency 40%',
      jobDescription: 'Staff AI Engineer',
      whyCompany: 'Strong infra team',
      whyLeaving: 'Seeking ownership',
      workStyle: 'Evidence first',
      salaryTarget: '$190k',
      questionsToAsk: 'How is on-call structured?'
    });

    assert.equal(s1.consumeLegacyProfileSeed(), null);

    const s2 = createSettingsStore(() => tmpDir);
    assert.equal(s2.getSettings().legacyMigrated, true);
    assert.equal(s2.consumeLegacyProfileSeed(), null);
    assert.equal(s2.getSettings().apiKeys.openai, 'sk-keep-me');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('consumeLegacyProfileSeed returns null on empty defaults', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pue-store-empty-'));
  try {
    const { createSettingsStore } = require('../src/store');
    const s = createSettingsStore(() => tmpDir);
    assert.equal(s.consumeLegacyProfileSeed(), null);
    assert.equal(s.getSettings().legacyMigrated, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
