# Spec: pue Candidate Interview Copilot

Master specification for `pue` (`/Users/saris.kia.adm/Desktop/pue`), forked from `Blueturboguy07/cue` and upgraded with context-perception and session-dissection patterns from *Designing AI Agents* (MEAP v4) and `earendil-works/pi`.
Confirmed intent: [docs/intent/pue-interview-copilot.md](docs/intent/pue-interview-copilot.md).

## 1. Objective

Turn `cue` from a single-paste-box screen overlay into a local candidate interview copilot with two isolated context layers and automated post-round session dissection:

1. **Global Candidate Profile:** Stores your experience documents (PDF, DOCX, Markdown, plain text), local code repositories, and human-approved cross-interview lessons (`promotedLessons`). Compiles compact repo summary cards and unified text chunks with provenance (`sourceId`, `relPath`, `startLine`, `endLine`, `mtimeMs`).
2. **Per-Job Workspaces:** Isolates each job application with its own JD files, test files or folders, pre-call **Prep Brief**, append-only per-round JSONL event ledgers, post-round **Session Dissection** (comparing interviewer questions, copilot suggestions, your spoken answers, and repo/JD evidence), and a gated **Failure Journal**. Memory never crosses workspace boundaries.

### Key User Outcomes

- Launch straight into `pue` using your own API keys and local or cloud speech-to-text, with zero `publik` or `applink` gating and zero telemetry.
- Attach all of your experience files and local repositories once at the global profile level, with safe incremental refresh via file `mtimeMs` and git `HEAD` SHA.
- Create one workspace per job application, attach JD and test files or folders, and generate a pre-call Prep Brief linking your projects to role requirements (automatically incorporating focus points from earlier rounds in that same workspace).
- Stream live answers on `What should I say?` and `Smart assist` in under 2 seconds of local overhead with zero live tool round-trips, using U-shaped attention ordering, Reciprocal Rank Fusion (`k = 60`), and rolling `transformContext` compaction.
- Run deep code and document inspection on `Smart` and typed `Ask` via bounded read-only tools (`list_files`, `grep_files`, `read_file`) capped at 4 tool rounds and a 35-second wall deadline.
- Dissect every completed interview round automatically into side-by-side Q&A reviews, missed evidence points, next-round checkpoints, and candidate Failure Journal lessons that require your approval before entering future prompts.

## 2. Phase 0 Capability Map

| Module id | Responsibility | Depends on | Spec |
|---|---|---|---|
| `core-byok-fork` | Fork `cue` into `/Users/saris.kia.adm/Desktop/pue`, remove `publik`, `applink`, telemetry, and self-updater, migrate legacy `cue-data.json` text fields | none | [SPEC-core-byok-fork.md](SPEC-core-byok-fork.md) |
| `profile-repo-index` | Global candidate profile for experience docs, local repos, and human-promoted lessons; hardened async repo walker, repo cards, unified chunk schema | `core-byok-fork` | [SPEC-profile-repo-index.md](SPEC-profile-repo-index.md) |
| `job-workspaces` | Sharded per-job workspaces, append-only round JSONL ledgers, isolated round memory, Prep Briefs, post-round Session Dissector, and 3-tier Failure Journal | `core-byok-fork`, `profile-repo-index` | [SPEC-job-workspaces.md](SPEC-job-workspaces.md) |
| `two-speed-context` | U-shaped 4-tier context triage, RRF (`k = 60`) chunk assembly, `PerceptionTrace` logging, `transformContext` compaction, grounding rules, and provider tool loops | `profile-repo-index`, `job-workspaces` | [SPEC-two-speed-context.md](SPEC-two-speed-context.md) |
| `copilot-ui` | Overlay workspace/round pill, Prep Brief drawer, Round History and Dissection drawer with Failure Journal approval controls, Settings file/repo managers | `job-workspaces`, `two-speed-context` | [SPEC-copilot-ui.md](SPEC-copilot-ui.md) |

**Build order:** `core-byok-fork` -> `profile-repo-index` -> `job-workspaces` -> `two-speed-context` -> `copilot-ui`

## 3. Tech Stack

- **Runtime:** Electron `^33.2.1`, Node.js `>=22.12.0` (CommonJS, no bundler).
- **Document parsing:** Existing `pdf-parse` (`^1.1.1`) and `mammoth` (`^1.8.0`), plus Node `fs` for UTF-8 and UTF-16 BOM text and source files.
- **LLM providers:** Existing `openai` (`^4.73.0`), `@anthropic-ai/sdk` (`^0.32.1`), `@google/genai` (`^2.12.0`), plus OpenAI-compatible endpoints (Groq, DeepSeek, Cerebras, Ollama, Azure, MiniMax, Custom).
- **Speech-to-text:** Existing local `whisper.cpp` sidecar plus Deepgram, OpenAI, Groq, and Gemini STT.
- **Target OS:** macOS 14.4+ primary (`setContentProtection(true)` preserved unless `CUE_NO_PROTECT=1`).

## 4. Commands

```bash
# Install dependencies
npm install

# Run full automated test suite
npm test

# Run a single test file
node --test test/two-speed-context.test.js

# Run UI static wiring check
node verify.js

# Prepare local whisper.cpp runtime (macOS requires CMake and Xcode CLI tools)
npm run prepare:whisper

# Launch app from source
npm start

# Package macOS Apple Silicon build
npm run dist:mac:arm64
```

## 5. Project Structure

```text
/Users/saris.kia.adm/Desktop/pue/
  main.js                      Electron entry, IPC handlers, capture, feature orchestration
  preload.js                   Context-isolated window.cue IPC bridge
  verify.js                    Static renderer wiring assertions
  package.json                 Scripts and dependencies (no publik or applink scripts)
  SPEC.md                      Master spec and capability map index
  SPEC-<module-id>.md          Module specifications (5 files)
  docs/
    intent/                    Confirmed Statement of Intent
  tasks/                       Implementation plan and task list (Phase 2+)
  renderer/
    index.html                 Overlay window, workspace/round bar, drawers, composer
    renderer.js                Renderer state, audio capture, streaming UI, Settings modal
    styles.css                 Glass overlay styles
    permissions.html           macOS permission guide
  src/
    store.js                   Global settings store (no publik fields) + one-time legacy migration
    settings-store-core.js     Atomic JSON persistence (0600, .tmp + .bak)
    profile-store.js           Global experience docs, repo index, and promotedLessons store
    repo-indexer.js            Hardened async walker, repo card compiler, unified chunker, RRF scorer
    workspace-store.js         Sharded workspaces, append-only round JSONL ledgers, Failure Journal
    prep-brief.js              Pre-call Prep Brief prompt and structured parser
    round-dissector.js         Post-round Session Dissector, Q&A pairing critic, checkpoint builder
    context-triage.js          U-shaped 4-tier budgeter, transformContext compaction, PerceptionTrace
    repo-tools.js              Read-only path-jailed tools (list_files, grep_files, read_file)
    llm.js                     Streaming LLM client + per-provider bounded tool-calling loop
    prompts.js                 Candidate prompts with claim-evidence grounding and abstention rules
    interview-context.js       Question category detection and untrusted-context formatting
    stt.js / stt-streaming.js  Audio transcription (local Whisper and cloud STT)
    slides.js / screen.js      Screenshot and slide-caption helpers
  test/
    *.test.js                  Node built-in test runner unit and integration suites
```

## 6. Code Style

Match upstream `cue`: plain CommonJS JavaScript, explicit error handling, zero external bundler, and pure testable logic in `src/` separated from Electron `app` and `ipcMain` wiring in `main.js`. Comments state why, not what.

Representative path-jail helper (hardened against deleted roots, non-existent leaf targets, symlink escapes, and case-insensitive volumes):

```javascript
// Canonicalize the nearest existing ancestor so non-existent targets cannot bypass realpathSync.
function resolveExistingCanonical(targetPath) {
  const abs = path.resolve(targetPath);
  let probe = abs;
  const missingTail = [];
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    missingTail.unshift(path.basename(probe));
    probe = parent;
  }
  const realBase = fs.realpathSync(probe);
  return missingTail.length ? path.join(realBase, ...missingTail) : realBase;
}

// Restrict every tool read to canonicalized roots that still exist on disk.
function resolveScopedPath(requestedPath, allowedRoots) {
  const realTarget = resolveExistingCanonical(requestedPath);
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const targetCmp = norm(realTarget);
  for (const root of allowedRoots) {
    if (!fs.existsSync(root)) continue;
    const rootCmp = norm(fs.realpathSync(root));
    if (targetCmp === rootCmp || targetCmp.startsWith(rootCmp + path.sep)) {
      return realTarget;
    }
  }
  throw new Error(`Access denied outside attached roots: ${requestedPath}`);
}

module.exports = { resolveScopedPath };
```

## 7. Testing Strategy

- **Framework:** Node built-in test runner (`node --test test/*.test.js`), zero extra test framework packages.
- **Unit tests:** Pure modules (`repo-indexer.js`, `context-triage.js`, `repo-tools.js`, `prep-brief.js`, `round-dissector.js`) run against temp directories and deterministic fake LLM streams without launching Electron.
- **Persistence & ledger tests:** `profile-store.js` and `workspace-store.js` test sharded atomic writes, append-only JSONL round recovery, rollback on write failure, and 3-tier Failure Journal state transitions (`proposed -> accepted -> dismissed -> superseded`).
- **Tool-loop & compaction tests:** `llm.js` and `context-triage.js` test per-provider tool-call assembly, `settleAnswer` interception, truncated-tool-call rejection (`stopReason === 'length'`), round-0 HTTP `400`/`404`/`422` chunk fallback, 35-second wall timeout, and long-transcript compaction.
- **UI wiring checks:** `verify.js` plus DOM/IPC source tests assert preload allowlists, workspace/round switching, Prep Brief and Round Dissection drawers, and function-definition ordering.

## 8. Boundaries

- **Always:**
  - Run `npm test` and `node verify.js` before reporting any build step complete.
  - Canonicalize and check every tool file path through `resolveScopedPath` against active `allowedRoots`.
  - Wrap retrieved repo, JD, and document chunks plus tool outputs in `<untrusted_context source="...">` tags.
  - Keep round ledgers, round dissections, and workspace Failure Journals isolated per `workspaceId`.
  - Require explicit user action before promoting any LLM-proposed Failure Journal lesson into active prompts.
- **Ask first:**
  - Adding any npm package to `package.json`.
  - Changing persisted JSON or JSONL schemas (`cue-data.json`, `profile-index.json`, `workspaces/index.json`, `workspaces/<id>.json`, `rounds/<rndId>.jsonl`, `failure-journal.jsonl`).
  - Changing Electron global shortcuts or overlay window content-protection flags.
- **Never:**
  - Leave `publik` gating, `publik` telemetry, `publik` auto-updates, or `applink` local server endpoints active.
  - Leak transcripts, round notes, dissections, or workspace-scoped lessons across different workspaces.
  - Allow `repo-tools.js` to write files, delete files, traverse outside `allowedRoots`, or run shell commands.
  - Fabricate personal metrics, project names, or resume facts when retrieved evidence does not contain them.
  - Let an LLM self-publish Failure Journal lessons into `PrepBrief` or `profile-index.json` without user approval.

## 9. Master Success Criteria

1. `npm start` opens the `pue` overlay directly with zero `publik` window, zero `applink` listener, and zero outbound telemetry calls.
2. Attaching multiple experience documents and local repositories builds unified chunks and repo cards asynchronously, skips binaries/minified bundles/symlink loops, and refreshes incrementally via `mtimeMs` and git `HEAD` SHA.
3. Creating workspaces A and B, running interview rounds in A, and switching to B yields zero cross-workspace leakage in prompts, recaps, dissections, or search results.
4. `What should I say?` and `Smart assist` assemble U-shaped triaged context (RRF `k = 60` chunks, diversity cap max 2 per file, last 6 `qaTurns`, compacted transcript) in `< 20ms` locally with zero live tool calls, recording a `PerceptionTrace` in the round JSONL ledger.
5. `Smart` and typed `Ask` execute up to 4 read-only tool rounds within a 35-second wall deadline across OpenAI, Anthropic, Gemini, and OpenAI-compatible providers, falling back cleanly to `topK = 10` local chunks on round-0 HTTP `400`/`404`/`422` tool-schema errors.
6. Ending a round (`>= 4` transcript turns) writes a structured Session Dissection (`qaReview`, `missedOpportunities`, `interviewerSignals`, `nextRoundCheckpoint`) plus append-only L0 Failure Facts and L1 Candidate Lessons that stay inactive until approved by the user.
7. `npm test` and `node verify.js` pass with exit code `0`.

## 10. Open Questions

None. Review the updated `SPEC.md` and the five `SPEC-*.md` module specs, and reply to approve moving to Phase 2 (`tasks/plan.md`).
