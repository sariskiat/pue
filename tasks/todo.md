# Task Breakdown: pue Candidate Interview Copilot

Plan reference: [tasks/plan.md](plan.md)
Master spec: [SPEC.md](../SPEC.md)

Every task follows TDD: write `Given / When / Then` QA scenarios first, write failing `node:test` cases, implement minimal code, and run focused + repo checks.

---

## Phase 1: Foundation (`core-byok-fork`)

## Task 1: Seed `pue` from `cue` and remove standalone `publik`, `updater`, and `applink` files

**Description:** Copy the cloned `Blueturboguy07/cue` tree into `/Users/saris.kia.adm/Desktop/pue` without overwriting `SPEC*.md`, `docs/intent/`, or `tasks/`. Remove the starter `main.py`, build a rule-based delete manifest with asserted count to remove standalone `publik`, `updater`, and `applink` files/scripts/tests, update `package.json` metadata (`name: "pue"`), and install dependencies.

**Acceptance criteria:**
- [x] `main.py`, `vendor/app-link`, `publik-updater.cjs`, `publik-update-verify.cjs`, `renderer/publik-card.js`, `src/publik*.js`, `src/publik-build.json`, `src/publik-gate-preload.cjs`, `src/applink*.js`, and `publik`/`updater`/`applink` test files are absent, verified by a rule-built count check before deletion.
- [x] `npm install` completes cleanly and `SPEC*.md`, `docs/intent/`, and `tasks/` remain intact.

**Verification:**
- [x] Tests pass: `node --test test/core-fork-layout.test.js`
- [x] Build succeeds: `npm ls --depth=0`
- [x] Manual check: Confirm `ls` shows `cue` codebase with `pue` `package.json` and zero standalone `publik*` or `applink*` files.

**Dependencies:** None

**Files likely touched:**
- `package.json`
- `test/core-fork-layout.test.js`
- `scripts/bootstrap-clean-fork.js` (scripted manifest + count assertion for file removal)

**Estimated scope:** Medium (3 files authored/edited + scripted removal of standalone upstream files)

---

## Task 2: Strip `publik` from `store.js`, `llm.js`, and `stt.js` and add legacy migration seed

**Description:** Remove `publik` state, `apiKeys.publik`, `applinkSlidesConsent`, and `applyPublikDefault` from `src/store.js` while adding one-time `consumeLegacyProfileSeed()`. Remove `publik` routing, headers, and refusal-retry branches from `src/llm.js` and `src/stt.js`, keeping all BYOK providers and local/cloud STT intact.

**Acceptance criteria:**
- [x] `src/store.js`, `src/llm.js`, and `src/stt.js` contain zero references to `publik` or `applink`.
- [x] `consumeLegacyProfileSeed()` extracts non-empty legacy `resumeText`, `starStories`, `jobDescription`, `whyCompany`, `salaryTarget`, and `questionsToAsk` once, sets `legacyMigrated: true`, and preserves saved API keys.
- [x] Existing BYOK provider and STT unit tests pass without regression.

**Verification:**
- [x] Tests pass: `node --test test/store-legacy-migration.test.js test/llm.test.js test/stt.test.js`
- [x] Build succeeds: `node --check src/store.js && node --check src/llm.js && node --check src/stt.js`
- [x] Manual check: Run `rg -n "publik|applink" src/store.js src/llm.js src/stt.js` and confirm 0 matches.

**Dependencies:** Task 1

**Files likely touched:**
- `src/store.js`
- `src/llm.js`
- `src/stt.js`
- `src/stt-streaming.js`
- `test/store-legacy-migration.test.js`

**Estimated scope:** Medium (5 files)

---

## Task 3: Strip `publik`, `updates`, and `applink` from `main.js`, `preload.js`, and `renderer/`

**Description:** Remove `ensureSignedIn`, `publik*` state/wallet/batcher wiring, `startUpdates`, and `applink` server setup from `main.js` and `preload.js`. Remove `publik` UI cards, wallet status, `applink` consent prompts, and update buttons from `renderer/index.html`, `renderer/renderer.js`, and `renderer/styles.css` while preserving all `verify.js` ordering invariants.

**Acceptance criteria:**
- [x] `rg -n "publikhq\.com|ensureSignedIn|applink|publik" main.js preload.js src/ renderer/` returns 0 hits.
- [x] `preload.js` exposes zero `publik*`, `updates*`, or `appLink*` methods or listener channels.
- [x] Full `npm test` suite and `node verify.js` pass with exit code `0`.

**Verification:**
- [x] Tests pass: `npm test`
- [x] Build succeeds: `node verify.js`
- [x] Manual check: Verify `node --check main.js && node --check preload.js && node --check renderer/renderer.js`.

**Dependencies:** Task 2

**Files likely touched:**
- `main.js`
- `preload.js`
- `renderer/index.html`
- `renderer/renderer.js`
- `test/byok-boot-wiring.test.js`

**Estimated scope:** Medium (5 files)

---

## Checkpoint 1: After Tasks 1-3 (`core-byok-fork` complete)
- [x] All unit tests pass (`npm test`)
- [x] Static UI wiring check passes (`node verify.js`)
- [x] Zero `publik` or `applink` references remain in runtime files
- [x] Ready to build `profile-repo-index`

---

## Phase 2: Global Profile & Repo Index (`profile-repo-index`)

## Task 4: Build document extractor, unified chunker, and hybrid RRF scorer in `src/repo-indexer.js`

**Description:** Create `src/repo-indexer.js` with `extractDocumentText` (supporting `.pdf`, `.docx`, `.md`, `.txt`, `.json`, `.yaml`, UTF-16 BOM, and zero-char scanned PDF warnings), `chunkText` outputting the unified `Chunk` schema (`~900` chars max, `~150` chars overlap, normalized `terms`), and `scoreChunks` combining BM25 lexical rank and exact code-symbol match rank via Reciprocal Rank Fusion (`1 / (60 + rank)`) with `maxPerSource = 2`.

**Acceptance criteria:**
- [ ] `.pdf`, `.docx`, `.md`, `.txt`, and UTF-16 BOM files extract into unified `Chunk[]` records; a zero-text PDF returns `warning` metadata instead of throwing.
- [ ] `scoreChunks` ranks both prose keyword matches and exact camelCase/snake_case symbol matches via RRF (`k = 60`) and caps results at `2` chunks per `(sourceId, relPath)`.

**Verification:**
- [ ] Tests pass: `node --test test/repo-indexer-chunks.test.js`
- [ ] Build succeeds: `node --check src/repo-indexer.js`
- [ ] Manual check: Inspect chunk provenance fields (`sourceId`, `sourceLabel`, `startLine`, `endLine`) in test output.

**Dependencies:** Task 3

**Files likely touched:**
- `src/repo-indexer.js`
- `test/repo-indexer-chunks.test.js`

**Estimated scope:** Small (2 files)

---

## Task 5: Add hardened async repo walker and incremental `fileMtimes` / `headSha` refresh

**Description:** Extend `src/repo-indexer.js` with `indexRepository(rootPath, prevRepoRecord, opts)`. Enforce event-loop yielding every `50` files, a `5,000`-entry discovery cap, a `500`-file index cap prioritizing manifests and `README*` for a `<= 1,200`-char `RepoCard`, canonical `realpath` cycle/escape blocking, exclusions for binaries/minified bundles/lockfiles/`.git`/`node_modules`, and fast incremental refresh using `headSha` and `fileMtimes`.

**Acceptance criteria:**
- [ ] Indexing skips `.git`, `node_modules`, binaries, `*.min.js`, `.svg`, `.csv`, files `> 256 KB`, symlink cycles, and symlinks pointing outside `rootPath`.
- [ ] Re-indexing an unchanged 200-file temp repo reuses `fileMtimes` and finishes in `< 100ms` without re-chunking unchanged files.

**Verification:**
- [ ] Tests pass: `node --test test/repo-indexer-walk.test.js test/repo-indexer-chunks.test.js`
- [ ] Build succeeds: `node --check src/repo-indexer.js`
- [ ] Manual check: Verify `RepoCard` summary length is `<= 1,200` chars on a sample repo.

**Dependencies:** Task 4

**Files likely touched:**
- `src/repo-indexer.js`
- `test/repo-indexer-walk.test.js`

**Estimated scope:** Small (2 files)

---

## Task 6: Build persistent `src/profile-store.js` and wire `profile:*` IPC

**Description:** Implement `src/profile-store.js` backed by `settings-store-core.js` (`<userData>/profile-index.json`, `0600` mode) managing global documents, repos, `seedFromLegacy()`, `listAllowedRoots()`, and human-only `promoteGlobalLesson` / `deprecateGlobalLesson`. Wire `profile:get`, `profile:pick-doc`, `profile:pick-repo`, `profile:remove-item`, `profile:reindex`, and `profile:deprecate-lesson` in `main.js` and `preload.js`.

**Acceptance criteria:**
- [ ] Adding, re-indexing, and removing documents and repos persists across store reloads and updates `listAllowedRoots()` immediately.
- [ ] `promoteGlobalLesson` and `deprecateGlobalLesson` manage lesson status (`accepted`, `deprecated`, `superseded`) without deleting history.
- [ ] `preload.js` and `main.js` expose all six `profile:*` channels cleanly.

**Verification:**
- [ ] Tests pass: `node --test test/profile-store.test.js && npm test`
- [ ] Build succeeds: `node verify.js`
- [ ] Manual check: Confirm `profile-index.json` writes with `0600` permissions in temp test dir.

**Dependencies:** Task 5

**Files likely touched:**
- `src/profile-store.js`
- `main.js`
- `preload.js`
- `test/profile-store.test.js`

**Estimated scope:** Medium (4 files)

---

## Checkpoint 2: After Tasks 4-6 (`profile-repo-index` complete)
- [ ] All unit tests pass (`npm test`)
- [ ] Repo walker handles symlinks, binaries, and incremental refresh within bounds
- [ ] `profile-index.json` persistence and legacy seeding verified

---

## Phase 3: Job Workspaces & Session Dissection (`job-workspaces`)

## Task 7: Build sharded `src/workspace-store.js` and append-only round JSONL ledger

**Description:** Implement `src/workspace-store.js` storing `workspaces/index.json`, debounced `workspaces/<wsId>.json` (`1500ms` + `flushAll`), and lazy append-only `workspaces/<wsId>/rounds/<rndId>.jsonl` with write-failure pointer rollback. Support attaching JD/test files and test folders, creating/switching/clearing rounds non-destructively, `buildRoundProjection()`, strict per-workspace `workspaceMemoryBlock()`, `searchWorkspaceRounds()`, and `allowedRootsForWorkspace()`.

**Acceptance criteria:**
- [ ] Workspace A and Workspace B maintain strictly isolated `workspaceMemoryBlock()`, `searchWorkspaceRounds()`, `allowedRootsForWorkspace()`, and `rounds/*.jsonl` files.
- [ ] Simulated disk error during `appendRoundEvent` rolls back in-memory `leafId` without corrupting subsequent parent links.
- [ ] `clearRoundTranscript` archives a non-empty round and opens a fresh round without erasing prior JSONL lines.

**Verification:**
- [ ] Tests pass: `node --test test/workspace-store.test.js`
- [ ] Build succeeds: `node --check src/workspace-store.js`
- [ ] Manual check: Inspect generated `index.json`, `<wsId>.json`, and `<rndId>.jsonl` files in temp test directory.

**Dependencies:** Task 6

**Files likely touched:**
- `src/workspace-store.js`
- `test/workspace-store.test.js`

**Estimated scope:** Small (2 files)

---

## Task 8: Build pre-call Prep Brief prompt builder and parser in `src/prep-brief.js`

**Description:** Implement `src/prep-brief.js` with `buildPrepBriefPrompt({ workspace, profile })` (combining workspace JD/test chunks, human role notes, global `RepoCard`s, experience highlights, and prior round `openWeaknessesToRepair`) and forgiving deterministic `parsePrepBrief(text)` returning `{ summary, repoMatches, testPlan, likelyQuestions, priorRoundFocus }`.

**Acceptance criteria:**
- [ ] `buildPrepBriefPrompt` includes JD/test evidence, global repo cards, and any `openWeaknessesToRepair` from the latest dissected round in that same workspace.
- [ ] `parsePrepBrief` parses structured Markdown headings into typed fields and degrades gracefully on malformed model output without throwing.

**Verification:**
- [ ] Tests pass: `node --test test/prep-brief.test.js`
- [ ] Build succeeds: `node --check src/prep-brief.js`
- [ ] Manual check: Verify prompt wraps JD/test excerpts inside `<untrusted_context>` tags.

**Dependencies:** Task 7

**Files likely touched:**
- `src/prep-brief.js`
- `test/prep-brief.test.js`

**Estimated scope:** Small (2 files)

---

## Task 9: Build post-round Session Dissector (`src/round-dissector.js`) and 3-tier Failure Journal

**Description:** Implement `src/round-dissector.js` (`buildDissectionPrompt`, `parseDissection`) and wire `endRound`, `resumeWindowMs = 30m`, `catchUpPendingRounds`, `listFailureJournal`, and `decideCandidateLesson` into `src/workspace-store.js`. Dissection compares interviewer questions, copilot suggestions, spoken `"you"` turns, and `PerceptionTrace` drops to write `qaReview`, `missedOpportunities`, `interviewerSignals`, `nextRoundCheckpoint`, L0 `failure_fact`s, and `proposed` L1 `candidate_lesson`s in `failure-journal.jsonl`.

**Acceptance criteria:**
- [ ] Ending a round with `>= 4` turns writes a parsed `dissection` plus L0 `failure_fact` and L1 `candidate_lesson` (`status: 'proposed'`) entries to `failure-journal.jsonl`.
- [ ] `proposed` L1 lessons never appear in `workspaceMemoryBlock()` or `admittedLessons` until `decideCandidateLesson(wsId, lessonId, 'accept_workspace')` is invoked; `'promote_global'` delegates cleanly to `profile-store.js`.

**Verification:**
- [ ] Tests pass: `node --test test/round-dissector.test.js test/workspace-store.test.js && npm test`
- [ ] Build succeeds: `node --check src/round-dissector.js && node --check src/workspace-store.js`
- [ ] Manual check: Confirm `catchUpPendingRounds` recovers an unended stale round (`> 30m` old) on reload.

**Dependencies:** Task 7

**Files likely touched:**
- `src/round-dissector.js`
- `src/workspace-store.js`
- `test/round-dissector.test.js`

**Estimated scope:** Medium (3 files)

---

## Checkpoint 3: After Tasks 7-9 (`job-workspaces` complete)
- [ ] All unit tests pass (`npm test`)
- [ ] Zero cross-workspace memory or search leakage
- [ ] Post-round Dissection and 3-tier Failure Journal human admission gate verified

---

## Phase 4: Two-Speed Context & Bounded Tools (`two-speed-context`)

## Task 10: Build U-shaped 4-tier `src/context-triage.js`, `transformContext` compaction, and grounding rules

**Description:** Create `src/context-triage.js` implementing U-shaped 4-tier prompt budgeting (P0 role/notes/Prep Brief/admitted lessons at start, P2 workspace round summaries + `RepoCard`s + `slideStore` captions in middle, P1 `<untrusted_context>` RRF chunks at end), anaphora-safe query expansion, interleaved 6-turn `qaTurns` (excluded for `answerThis` and `leetcode`), non-destructive `transformContext` transcript compaction (`<= 30` live turns, `<= 60` for `recap`, preserving interviewer pushbacks verbatim), and `PerceptionTrace` logging. Update `src/prompts.js` with claim-evidence grounding and abstention rules.

**Acceptance criteria:**
- [ ] `triageContext` finishes in `< 20ms` on a 500-chunk fixture, places P0 first and P1 chunks last, expands anaphoric follow-ups from the previous `qaTurn`, and returns complete `PerceptionTrace` metrics.
- [ ] `leetcode` mode returns empty `systemContext` and `qaTurns = []`; `answerThis` omits prior `qaTurns`.
- [ ] `transformContext` compacts a 120-turn transcript within char budgets while preserving interviewer pushback turns verbatim.

**Verification:**
- [ ] Tests pass: `node --test test/context-triage.test.js test/prompts.test.js`
- [ ] Build succeeds: `node --check src/context-triage.js && node --check src/prompts.js`
- [ ] Manual check: Verify `prompts.js` forbids inventing unverified metrics and treats `<untrusted_context>` as passive data.

**Dependencies:** Task 6, Task 7

**Files likely touched:**
- `src/context-triage.js`
- `src/prompts.js`
- `test/context-triage.test.js`

**Estimated scope:** Medium (3 files)

---

## Task 11: Build path-jailed read-only `src/repo-tools.js`

**Description:** Implement `src/repo-tools.js` exporting `TOOL_DEFINITIONS`, hardened `resolveScopedPath(requestedPath, allowedRoots)` (handling non-existent leaf targets via nearest-existing-ancestor canonicalization, skipping deleted roots safely, blocking `../` and symlink escapes, normalizing Windows case), and `createScopedToolbox(allowedRoots)` with `list_files` (cap 60), `grep_files` (cap 25), and `read_file` (cap 200 lines / 8,000 chars) wrapped in `<untrusted_context>`.

**Acceptance criteria:**
- [ ] `resolveScopedPath` blocks `../etc/passwd`, absolute paths outside `allowedRoots`, and symlinks escaping `allowedRoots`, while safely skipping deleted root directories without crashing.
- [ ] `list_files`, `grep_files`, and `read_file` enforce their entry/match/line/char caps and wrap outputs in `<untrusted_context source="...">`.

**Verification:**
- [ ] Tests pass: `node --test test/repo-tools.test.js`
- [ ] Build succeeds: `node --check src/repo-tools.js`
- [ ] Manual check: Verify zero write/exec/spawn imports exist in `src/repo-tools.js`.

**Dependencies:** Task 6, Task 7

**Files likely touched:**
- `src/repo-tools.js`
- `test/repo-tools.test.js`

**Estimated scope:** Small (2 files)

---

## Task 12: Add per-provider streaming tool loop to `src/llm.js` and wire `main.js` + `preload.js`

**Description:** Extend `src/llm.js` with bounded tool-loop execution (`maxToolRounds = 4`, `35,000ms` overall wall timeout, Level-1 clearing for consumed `tool_result`s `> 1,500` chars) across OpenAI/Compatible, Anthropic, and Gemini streams. Intercept tool calls before `settleAnswer()`, reject `finishReason === 'length'` truncated tool calls, attach `imageDataUrl` only on round `0`, and fall back once to `topK = 10` chunks only on round-0 HTTP `400`/`404`/`422` tool-schema rejections. Wire `workspace:*`, `llmCancel`, `triageContext`, `createScopedToolbox`, Prep Brief, and Round Dissection into `main.js` and `preload.js`.

**Acceptance criteria:**
- [ ] Simulated multi-round tool calls (`grep_files -> read_file -> streamed answer`) succeed across OpenAI, Anthropic, and Gemini stream adapters without triggering `EMPTY_ANSWER_MESSAGE`, and reject `finishReason === 'length'` tool calls safely.
- [ ] Round-0 HTTP `400` tool-schema error falls back once to `topK = 10` local chunks, whereas `401` and `429` fail immediately without fallback; `say` (`smart = false`) passes zero tools.
- [ ] `main.js` and `preload.js` wire all `workspace:*`, `llm:tool`, `round:dissected`, and `llmCancel` channels and persist `qa_turn` + `perception_trace` to the active round JSONL ledger.

**Verification:**
- [ ] Tests pass: `node --test test/llm-tool-loop.test.js test/llm.test.js && npm test`
- [ ] Build succeeds: `node --check src/llm.js && node --check main.js && node verify.js`
- [ ] Manual check: Verify Deep-Path wall timer aborts a stalled mock tool loop cleanly and resets `state.busy = false`.

**Dependencies:** Task 8, Task 9, Task 10, Task 11

**Files likely touched:**
- `src/llm.js`
- `main.js`
- `preload.js`
- `test/llm-tool-loop.test.js`

**Estimated scope:** Medium (4 files)

---

## Checkpoint 4: After Tasks 10-12 (`two-speed-context` complete)
- [ ] All unit and integration tests pass (`npm test`)
- [ ] Fast Path runs zero tool loops (`< 20ms` local triage)
- [ ] Deep Path executes jailed read-only tools across providers with timeout, truncation, and fallback guards

---

## Phase 5: Overlay & Settings UI (`copilot-ui`)

## Task 13: Add Settings UI tabs for Global Profile & Repos and Job Workspaces

**Description:** Update `renderer/index.html`, `renderer/renderer.js`, and `renderer/styles.css` to replace legacy pasted textareas with two Settings tabs: **Profile & Repos** (add/remove/reindex experience docs and repo folders with status badges and chunk counts; view/deprecate global promoted lessons) and **Job Workspaces** (create/edit/delete workspaces with confirmation, attach JD/test files and test folders, edit human P0 role notes).

**Acceptance criteria:**
- [ ] Settings modal renders **Profile & Repos** and **Job Workspaces** tabs, calls the `window.cue.profile*` and `window.cue.workspace*` bridge methods, and escapes all file paths/names safely via DOM text nodes or HTML escaping.
- [ ] Deleting a workspace with recorded rounds prompts for explicit confirmation before calling `workspaceDelete`.
- [ ] `node verify.js` passes all ordering checks.

**Verification:**
- [ ] Tests pass: `node --test test/settings-workspaces-ui.test.js && npm test`
- [ ] Build succeeds: `node verify.js`
- [ ] Manual check: Verify tab switching still triggers `saveSettings` as asserted by `verify.js`.

**Dependencies:** Task 12

**Files likely touched:**
- `renderer/index.html`
- `renderer/renderer.js`
- `renderer/styles.css`
- `test/settings-workspaces-ui.test.js`

**Estimated scope:** Medium (4 files)

---

## Task 14: Add Overlay Workspace/Round pill, Prep Brief drawer, Round Dissection & Failure Journal drawer, and tool status

**Description:** Add the compact `<Company / Role> · <Round>` header pill and popover (`Switch Workspace`, `New Round`, `End Round & Dissect`), the **Prep Brief** drawer (`Generate / Refresh Brief`), the **Round History & Dissection** drawer (side-by-side Q&A review, missed opportunities, next-round checkpoint, Failure Journal `Accept for This Job` / `Promote to Global Profile` / `Dismiss` buttons, `Copy Markdown Report`), and `llm:tool` live status + cancel handling. Extend `verify.js` with static assertions for the new handlers.

**Acceptance criteria:**
- [ ] Overlay renders the Workspace/Round pill, Prep Brief drawer, and Round Dissection drawer with Failure Journal approval actions (`accept_workspace`, `promote_global`, `dismiss`), keeping `setIgnoreMouse` click-through intact.
- [ ] `llm:tool` displays `"Checking <path>..."`, clears on first `llm:token`, and cancels cleanly on Stop/Escape; XSS payloads in mock filenames/LLM fields render inertly as plain text.
- [ ] Full `npm test` suite and extended `node verify.js` pass with exit code `0`.

**Verification:**
- [ ] Tests pass: `node --test test/overlay-dissection-ui.test.js && npm test`
- [ ] Build succeeds: `node verify.js`
- [ ] Manual check: Launch `CUE_NO_PROTECT=1 npm start` smoke check (or headless Electron smoke script) to confirm clean window boot and quit.

**Dependencies:** Task 13

**Files likely touched:**
- `renderer/index.html`
- `renderer/renderer.js`
- `renderer/styles.css`
- `verify.js`
- `test/overlay-dissection-ui.test.js`

**Estimated scope:** Medium (5 files)

---

## Checkpoint 5: After Tasks 13-14 (`copilot-ui` complete & Release Verification)
- [ ] Full test suite passes (`npm test`)
- [ ] Static renderer verification passes (`node verify.js`)
- [ ] Zero `publik` or `applink` hits across runtime files
- [ ] Every module in `SPEC.md` mapped to `file:line` with `tasks/deviations.md` reviewed ("No deviations" if none)
