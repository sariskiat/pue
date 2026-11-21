# Module Spec: `job-workspaces`

Parent spec: [SPEC.md](SPEC.md)
Depends on: `core-byok-fork`, `profile-repo-index`

## 1. Objective

Replace `cue`'s flat `meetings.json` and single `jobDescription` field with sharded **Per-Job Workspaces**, append-only per-round JSONL event ledgers (*Pi* `session-manager.ts`), automated post-round **Session Dissection** (*Designing AI Agents* Ch. 4.4 and Ch. 7.2), and a human-gated 3-tier **Candidate Failure Journal** (*Designing AI Agents* Ch. 4.5 and Ch. 7.5).

## 2. Sharded Storage Layout & Schemas

To prevent multi-megabyte JSON rewrites on live turns, storage is sharded under `<userData>/workspaces/`:

1. `workspaces/index.json` (atomic via `settings-store-core.js`): `{ version: 1, activeWorkspaceId: 'ws_...', items: [{ id, company, role, updatedAt }] }`.
2. `workspaces/<wsId>.json` (atomic, debounced `1500ms` on live metadata updates, flushed on workspace switch and `will-quit`):

```javascript
{
  id: 'ws_...',
  company: 'Acme AI',
  role: 'Senior AI Engineer',
  createdAt: 1730000000000,
  updatedAt: 1730000000000,
  activeRoundId: 'rnd_...',
  files: [
    {
      id: 'wf_...',
      path: '/abs/path/to/jd.pdf',
      label: 'jd.pdf',
      role: 'jd' | 'test' | 'notes',
      isDirectory: false, // true when attaching a take-home test folder
      status: 'ok' | 'warning' | 'error',
      error: '',
      mtimeMs: 1730000000000,
      chunks: [ /* Unified Chunk[] */ ]
    }
  ],
  notes: '', // Human-owned P0 role notes (whyCompany, salaryTarget, questionsToAsk)
  admittedLessons: [
    {
      id: 'wles_...',
      factId: 'fact_...',
      guidance: 'Tie distributed queue answers to the take-home retry worker.',
      admittedAt: 1730000000000,
      status: 'accepted' | 'deprecated' | 'superseded',
      supersedesId: null
    }
  ],
  prepBrief: {
    generatedAt: null,
    summary: '',
    repoMatches: [],     // [{ repoName, whyRelevant, talkingPoints }]
    testPlan: [],        // Key requirements and talking points for attached test file/folder
    likelyQuestions: [],
    priorRoundFocus: []  // Merged from latest completed round's nextRoundCheckpoint
  },
  rounds: [
    {
      id: 'rnd_...',
      name: 'Round 1 - Technical Screen',
      startedAt: 1730000000000,
      endedAt: null,
      status: 'open' | 'ended' | 'dissected',
      turnCount: 0,
      dissection: null // Populated by src/round-dissector.js when round ends
    }
  ]
}
```

3. `workspaces/<wsId>/rounds/<rndId>.jsonl` (append-only JSONL ledger, created lazily on first real turn; rolls back in-memory pointers if `appendFileSync` fails, matching *Pi* `session-manager.ts:1182`):
   - Line 1 header: `{ type: 'round_header', version: 1, workspaceId, roundId, startedAt }`
   - Entry types (`{ id, parentId, ts, type, ... }`):
     - `transcript_turn`: `{ channel: 'you' | 'them', text }`
     - `qa_turn`: `{ mode, userText, category, answer, citedSources }` (active round projection caps at newest `20` persisted in RAM, newest `6` sent to LLM)
     - `perception_trace`: `{ mode, chunksConsidered, chunksSelected, droppedChunks, selectivity }`
     - `tool_call` / `tool_result`: `{ toolName, args, summary, durationMs, isError }`
     - `compaction`: `{ firstKeptEntryId, summary }` (non-destructive rolling transcript summary)
     - `dissection`: `{ dissection }`

4. `workspaces/<wsId>/failure-journal.jsonl` (append-only 3-tier Failure Journal):
   - `failure_fact` (L0, immutable): `{ id, roundId, ts, question, spokenExcerpt, copilotExcerpt, interviewerPushback, failureType: 'technical_gap' | 'missing_metric' | 'weak_star_framing' | 'unverified_claim' | 'context_miss' }`
   - `candidate_lesson` (L1, LLM-proposed): `{ id, factId, roundId, ts, proposedFix, suggestedScope: 'workspace' | 'global', status: 'proposed' }`
   - `lesson_decision` (L2, human-only admission event): `{ targetLessonId, ts, decision: 'accept_workspace' | 'promote_global' | 'dismiss' | 'supersede', supersedesId }`

## 3. Post-Round Session Dissection (`src/round-dissector.js`)

Triggered on `endRound(wsId, roundId)` (when `turnCount >= minTurnsForNotes` where `minTurnsForNotes = 4`), after `resumeWindowMs = 30 * 60 * 1000` of silence, or on app startup via `catchUpPendingRounds()`.

A separate-frame Critic prompt inspects the round JSONL ledger (bounded tail scan `<= 2,000` entries), workspace JD/test chunks, and `PerceptionTrace` entries to produce:

```javascript
dissection = {
  generatedAt: 1730000005000,
  roundSummary: '2-3 factual sentences of what was covered.',
  qaReview: [
    {
      question: 'How did your queue handle poison messages?',
      copilotSuggestion: 'Summary of pue suggestion if triggered, else ""',
      spokenAnswer: 'Summary of candidate "you" turns following the question',
      verdict: 'strong' | 'partial' | 'missed' | 'unverified_claim',
      gapWhy: 'Omitted dead-letter retry cap from worker.js:42',
      citedSources: ['order-service/src/worker.js:42']
    }
  ],
  missedOpportunities: [
    'Did not mention 99.95% delivery rate documented in resume.pdf',
    'Context miss: worker.js chunk was dropped by budget (see PerceptionTrace)'
  ],
  interviewerSignals: [
    'Interviewer pushed twice on failure recovery and idempotency keys'
  ],
  nextRoundCheckpoint: {
    settledTopics: ['Past role overview', 'Queue basics'],
    openWeaknessesToRepair: ['Idempotency key storage trade-offs'],
    promisedFollowUps: ['Share benchmark setup in Round 2']
  }
}
```

- Any `partial`, `missed`, or `unverified_claim` item appends an L0 `failure_fact` and L1 `candidate_lesson` (`status: 'proposed'`) to `failure-journal.jsonl`.
- **Hard governance rule:** L1 `candidate_lesson` entries NEVER enter live prompts automatically. Only human-approved `admittedLessons` (workspace) or `promotedLessons` (global profile) enter prompts, and human `workspace.notes` always outrank model-derived lessons.

## 4. Lifecycle & Interfaces

- `src/workspace-store.js`:
  - `listWorkspaces()`, `getActiveWorkspace()`, `createWorkspace({ company, role })`, `updateWorkspace(id, patch)`, `setActiveWorkspace(id)`, `deleteWorkspace(id)`
  - `attachWorkspaceFile(wsId, targetPath, role)` (supports files and test folders), `removeWorkspaceFile(wsId, fileId)`
  - `createRound(wsId, name)`, `setActiveRound(wsId, roundId)`, `endRound(wsId, roundId)`, `clearRoundTranscript(wsId, roundId)` (archives non-empty round cleanly and opens a fresh round so raw JSONL history is never destructively erased)
  - `appendRoundEvent(wsId, roundId, event)`, `buildRoundProjection(wsId, roundId) -> { transcript, rollingSummary, qaTurns, perceptionTraces }`
  - `workspaceMemoryBlock(wsId, currentRoundId)` (returns up to `3` prior completed rounds' `roundSummary` + `nextRoundCheckpoint` strictly inside `wsId`)
  - `listFailureJournal(wsId)`, `decideCandidateLesson(wsId, lessonId, decision)`
  - `searchWorkspaceRounds(wsId, query)`
  - `allowedRootsForWorkspace(wsId)`, `flushAll()`
- `src/prep-brief.js` & `src/round-dissector.js`:
  - `buildPrepBriefPrompt({ workspace, profile })`, `parsePrepBrief(text)`
  - `buildDissectionPrompt({ roundProjection, workspace, profileCards })`, `parseDissection(text)`

## 5. Boundaries

- **Always:** Flush pending workspace writes on workspace switch and `will-quit`; keep a `"Default Workspace"` ready on first boot; preserve raw JSONL entries non-destructively.
- **Ask first:** Deleting a workspace that has recorded rounds.
- **Never:** Read or search rounds across different `workspaceId`s, or auto-admit L1 Failure Journal lessons without user action.

## 6. Success Criteria

1. Workspace A and Workspace B maintain completely separate `rounds/*.jsonl`, `failure-journal.jsonl`, `workspaceMemoryBlock()`, and `searchWorkspaceRounds()` results.
2. Simulated write failure in `appendRoundEvent` rolls back in-memory `leafId` without corrupting parent pointers.
3. `endRound` on a 6-turn mock interview generates a parsed `dissection` with `qaReview`, `nextRoundCheckpoint`, L0 `failure_fact`s, and `proposed` L1 `candidate_lesson`s.
4. L1 lessons remain excluded from `workspaceMemoryBlock` until `decideCandidateLesson(..., 'accept_workspace')` is called, and `decideCandidateLesson(..., 'promote_global')` delegates to `profile-store.js`.
