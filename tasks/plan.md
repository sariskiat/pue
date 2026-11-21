# Implementation Plan: pue Candidate Interview Copilot

Master spec: [SPEC.md](../SPEC.md)
Task list target: [tasks/todo.md](todo.md)

## 1. Overview

`pue` forks `Blueturboguy07/cue` inside `/Users/saris.kia.adm/Desktop/pue` into a local, bring-your-own-key candidate interview copilot. It adds a persistent Global Candidate Profile (indexing experience files and local repositories into repo cards and provenance-tagged chunks), isolated Per-Job Workspaces (sharded JSON metadata plus append-only per-round JSONL event ledgers), automated post-round Session Dissection with a human-gated 3-tier Failure Journal, and a two-speed context harness (`< 20ms` U-shaped RRF retrieval for live call modes vs bounded read-only file-lookup tools for `Smart` and `Ask`).

## 2. Dependency Graph

```text
Phase 1: core-byok-fork (Tasks 1 -> 2 -> 3)
    |
    v
Phase 2: profile-repo-index (Tasks 4 -> 5 -> 6)
    |
    v
Phase 3: job-workspaces (Task 7 -> Tasks 8, 9)
    |
    v
Phase 4: two-speed-context (Tasks 10, 11 -> Task 12)
    |
    v
Phase 5: copilot-ui (Task 13 -> Task 14)
```

### Parallelization Opportunities

- **Sequential backbone:** Tasks `1 -> 2 -> 3` (`core-byok-fork`), Tasks `4 -> 5 -> 6` (`profile-repo-index`), and Tasks `13 -> 14` (`copilot-ui` touches shared `renderer/` files, keeping one active writer per directory).
- **Safe parallel pairs (isolated files, shared read-only contracts):**
  - After Task `7` (`workspace-store.js`), Task `8` (`src/prep-brief.js`) and Task `9` (`src/round-dissector.js`) can be built in parallel worktrees before merging `workspace-store.js` hooks.
  - After Tasks `6` and `7`, Task `10` (`src/context-triage.js` + `src/prompts.js`) and Task `11` (`src/repo-tools.js`) touch disjoint files and can run in parallel before Task `12` (`src/llm.js` + `main.js`).

## 3. Key Architecture & TDD Decisions

- **Strict TDD workflow per task:** Every task starts by listing `Given / When / Then` QA scenarios, writing one failing `node:test` case per scenario, implementing the minimal pure code in `src/` (or IPC/UI wiring), and passing both the focused test file and the full `npm test` + `node verify.js` suite.
- **Safe bulk file deletion (Task 1):** Before deleting `publik`, `updater`, and `applink` files from the seeded fork, build the exact file list by rule in a script, assert the expected file count, and abort on any mismatch.
- **Sharded storage + append-only JSONL ledgers (Task 7):** Workspaces write metadata to `workspaces/index.json` and `workspaces/<wsId>.json` via `settings-store-core.js` (`0600` mode, `1500ms` debounce, flushed on switch and `will-quit`). Live round turns append to `workspaces/<wsId>/rounds/<rndId>.jsonl` with in-memory pointer rollback on write error so long calls never rewrite multi-megabyte JSON blobs.
- **Two-speed latency protection (Tasks 10-12):** `say`, `assist`, `answerThis`, and `recap` (with `smart = false`) never pass tool schemas to `llm.stream()`. Deep Path (`smart = true` or `ask`) caps tool loops at `4` rounds and a `35,000ms` overall wall deadline, intercepts tool calls before `settleAnswer()`, rejects length-truncated tool calls, and falls back to `topK = 10` chunks only on round-0 HTTP `400`/`404`/`422` schema rejections.
- **Human-sovereign Failure Journal (Task 9 & Task 14):** Post-round dissection writes immutable L0 failure facts and `proposed` L1 candidate lessons to `failure-journal.jsonl`. Lessons stay inert until approved via explicit user IPC (`accept_workspace` or `promote_global`).

## 4. Ordered Task Index

Full acceptance criteria, TDD verification steps, and file lists live in [tasks/todo.md](todo.md).

### Phase 1: Foundation (`core-byok-fork`)
- [x] Task 1: Seed `pue` from `cue` and remove standalone `publik`, `updater`, and `applink` files (`SPEC-core-byok-fork.md`)
- [x] Task 2: Strip `publik` from `store.js`, `llm.js`, and `stt.js` and add legacy migration seed (`SPEC-core-byok-fork.md`)
- [ ] Task 3: Strip `publik`, `updates`, and `applink` from `main.js`, `preload.js`, and `renderer/` (`SPEC-core-byok-fork.md`)
- [ ] Checkpoint 1: Clean BYOK fork boots and passes `npm test` + `node verify.js`

### Phase 2: Global Profile & Repo Index (`profile-repo-index`)
- [ ] Task 4: Build document extractor, unified chunker, and hybrid RRF scorer in `src/repo-indexer.js` (`SPEC-profile-repo-index.md`)
- [ ] Task 5: Add hardened async repo walker and incremental `fileMtimes` / `headSha` refresh (`SPEC-profile-repo-index.md`)
- [ ] Task 6: Build persistent `src/profile-store.js` and wire `profile:*` IPC (`SPEC-profile-repo-index.md`)
- [ ] Checkpoint 2: Global profile indexes documents and repos locally and passes all tests

### Phase 3: Job Workspaces & Session Dissection (`job-workspaces`)
- [ ] Task 7: Build sharded `src/workspace-store.js` and append-only round JSONL ledger (`SPEC-job-workspaces.md`)
- [ ] Task 8: Build pre-call Prep Brief prompt builder and parser in `src/prep-brief.js` (`SPEC-job-workspaces.md`)
- [ ] Task 9: Build post-round Session Dissector (`src/round-dissector.js`) and 3-tier Failure Journal (`SPEC-job-workspaces.md`)
- [ ] Checkpoint 3: Isolated workspaces, JSONL round recovery, Prep Brief, and Dissection pass all tests

### Phase 4: Two-Speed Context & Bounded Tools (`two-speed-context`)
- [ ] Task 10: Build U-shaped 4-tier `src/context-triage.js`, `transformContext` compaction, and grounding rules (`SPEC-two-speed-context.md`)
- [ ] Task 11: Build path-jailed read-only `src/repo-tools.js` (`SPEC-two-speed-context.md`)
- [ ] Task 12: Add per-provider streaming tool loop to `src/llm.js` and wire `main.js` + `preload.js` (`SPEC-two-speed-context.md`)
- [ ] Checkpoint 4: Fast Path (`< 20ms` triage) and Deep Path (bounded 4-round tool loop + fallback) pass all tests

### Phase 5: Overlay & Settings UI (`copilot-ui`)
- [ ] Task 13: Add Settings UI tabs for Global Profile & Repos and Job Workspaces (`SPEC-copilot-ui.md`)
- [ ] Task 14: Add Overlay Workspace/Round pill, Prep Brief drawer, Round Dissection & Failure Journal drawer, and tool status (`SPEC-copilot-ui.md`)
- [ ] Checkpoint 5: Full end-to-end verification (`npm test`, `node verify.js`, zero `publik`/`applink` residue)

## 5. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| `cue`'s `settleAnswer()` throws empty-answer errors on text-less tool turns | High | Intercept tool-call stop reasons before `settleAnswer()` and test OpenAI, Anthropic, and Gemini streaming deltas explicitly in Task 12. |
| Large monorepo or symlink loop blocks Electron main thread during indexing | High | Enforce async yielding every 50 files, 5,000-entry walk cap, 500-file index cap, and canonical `realpath` cycle/escape guard in Task 5. |
| Long interview transcripts overflow `recap` or live modes | Medium | Cap live windows and run non-destructive `compaction` entries preserving interviewer pushbacks verbatim in Task 10. |
| Renderer edits break `verify.js` ordering or click-through mouse handling | Medium | Run `node verify.js` on every UI task (Tasks 3, 13, 14) and route new drawers through existing modal mouse-capture toggles. |
| Prompt injection inside attached JD or external test repo | High | Wrap all retrieved chunks and tool outputs in `<untrusted_context>` delimiters and instruct passive-data handling in Task 10 and Task 11. |

## 6. Deviations Log Policy

Agreed baseline is `SPEC.md` (with `SPEC-*.md`) and `tasks/plan.md`. Module boundary changes stop and ask first; any smaller implementation deviation is recorded in `tasks/deviations.md` (`agreed`, `built`, `why`, `evidence`, `file:line`).

## 7. Open Questions

None. Review `tasks/plan.md` and `tasks/todo.md`, and reply to approve starting Phase 4 implementation (beginning with Task 1).
