# Module Spec: `core-byok-fork`

Parent spec: [SPEC.md](SPEC.md)
Depends on: none

## 1. Objective

Create a clean, runnable fork of `Blueturboguy07/cue` inside `/Users/saris.kia.adm/Desktop/pue` that boots straight into the overlay using bring-your-own-key (BYOK) AI providers and local or cloud STT, with all `publik` gating, telemetry, self-updater, and external `applink` server plumbing removed, while migrating any existing legacy `cue-data.json` fields once on first boot.

## 2. Scope & Changes

### Remove

- PyCharm starter `main.py` in `/Users/saris.kia.adm/Desktop/pue`.
- `publik` modules, updater, and scripts:
  - `src/publik.js`, `src/publik-gate.js`, `src/publik-gate-preload.cjs`, `src/publik-ui.js`, `src/publik-build.json`, `src/publik-stt-batcher.js`
  - `publik-updater.cjs`, `publik-update-verify.cjs`, `renderer/publik-card.js`
  - `.github/scripts/publik-self-test.cjs`, `.github/scripts/live-update-proof.cjs`, `.github/scripts/updater-*.cjs`, `scripts/publik-*.js`, `scripts/publik-*.sh`
  - `publik` and updater tests (`test/publik*.test.js`, `test/store-publik.test.js`, `test/settings-publik-option.test.js`, `test/updater-*.test.js`)
- External `applink` local server plumbing (Iris diagnostic bridge):
  - `src/applink.js`, `src/applink-state.js`, `vendor/app-link`, `test/applink.test.js`, and `applink:*` IPC channels in `main.js`, `preload.js`, and `src/store.js`.
- All `publik` and `updates` references in `main.js`, `preload.js`, `src/store.js`, `src/llm.js`, `src/stt.js`, `renderer/index.html`, `renderer/renderer.js`, and `package.json`.

### Keep & Migrate

- All BYOK LLM providers (`openai`, `anthropic`, `gemini`, `cerebras`, `groq`, `deepseek`, `minimax`, `azure`, `ollama`, `custom`).
- All STT paths (`local` whisper.cpp, `deepgram`, `openai`, `groq`, `gemini`).
- Overlay protections (`setContentProtection(true)`), global shortcuts, audio worklets, slide captioning (`src/slides.js`), and all remaining unit tests.
- **One-time legacy migration (`migrateLegacySettings`):** If an existing `cue-data.json` contains non-empty `resumeText`, `starStories`, `jobDescription`, `whyCompany`, `salaryTarget`, or `questionsToAsk` and `legacyMigrated !== true`, export a structured migration payload so `profile-store.js` and `workspace-store.js` seed an initial experience note and Default Workspace without losing prior text, then mark `legacyMigrated: true`.

## 3. Interfaces & Contracts

- `src/store.js`:
  - `DEFAULTS` removes `publik`, `apiKeys.publik`, and `applinkSlidesConsent`, adding `legacyMigrated: false`.
  - Exports `consumeLegacyProfileSeed()` returning `{ resumeText, starStories, jobDescription, whyCompany, whyLeaving, workStyle, salaryTarget, questionsToAsk } | null` once.
- `preload.js`: removes all `publik*`, `updates*`, and `appLink*` methods and listener channels from `window.cue`.
- `main.js`: `app.whenReady()` launches the overlay directly (after macOS permission check if needed) with zero sign-in gate, zero update check, and zero local `applink` socket.

## 4. Boundaries

- **Always:** Preserve all BYOK provider, STT, Whisper, screen, slide, and shortcut unit tests.
- **Ask first:** Removing `electron-updater` from `package.json` dependencies.
- **Never:** Make outbound requests to `publikhq.com`, open an external `applink` IPC socket, or drop saved API keys during legacy migration.

## 5. Success Criteria

1. `main.py` is replaced by the `pue` codebase in `/Users/saris.kia.adm/Desktop/pue`.
2. Searching `main.js`, `preload.js`, `src/`, and `renderer/` for `publikhq.com`, `ensureSignedIn`, or `applink` returns zero hits.
3. Legacy `cue-data.json` with `resumeText` and `jobDescription` produces a valid seed via `consumeLegacyProfileSeed()` once and preserves all API keys.
4. `npm test` and `node verify.js` pass with exit code `0`.
