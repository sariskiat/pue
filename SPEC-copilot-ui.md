# Module Spec: `copilot-ui`

Parent spec: [SPEC.md](SPEC.md)
Depends on: `job-workspaces`, `two-speed-context`

## 1. Objective

Extend `pue`'s glass overlay and Settings modal so you can switch job workspaces and rounds, attach global experience/repos and workspace JD/test files, generate the pre-call **Prep Brief**, inspect post-call **Round Dissections**, and approve or dismiss **Failure Journal** lessons without cluttering the live call view.

## 2. Overlay Additions (`renderer/index.html`, `renderer/renderer.js`, `renderer/styles.css`)

- **Compact Workspace & Round Pill:**
  - Shows `<Company / Role> · <Round Name>` in the panel header strip.
  - Clicking opens a lightweight popover to switch workspaces, start or end a round (`End Round & Dissect`), switch rounds, open the **Prep Brief** drawer, or open the **Round Dissection** drawer.
- **Prep Brief Drawer:**
  - Displays the active workspace's `prepBrief` (`Summary`, `Repo Matches`, `Test Plan`, `Likely Questions`, and `Prior Round Focus` carried over from earlier rounds' `nextRoundCheckpoint`), with a `Generate / Refresh Brief` button.
- **Round History & Dissection Drawer (New from Session Dissection synthesis):**
  - Lists rounds inside the active workspace (`open`, `ended`, `dissected`) plus a workspace-scoped round search input.
  - For a dissected round, renders four compact sections:
    1. **Q&A Review:** Side-by-side cards showing *Interviewer Question*, *What You Said*, *Copilot Suggestion*, verdict badge (`strong`, `partial`, `missed`, `unverified_claim`), and cited repo/doc sources.
    2. **Missed Opportunities & Signals:** Bullet list of unused repo/resume proof points (including flagged `PerceptionTrace` budget drops) and interviewer pushbacks.
    3. **Next-Round Checkpoint:** Topics settled vs weaknesses to repair in the next round.
    4. **Candidate Failure Journal (Human Admission Gate):** Lists `proposed` L1 lessons from that round with three explicit buttons: **Accept for This Job** (`accept_workspace`), **Promote to Global Profile** (`promote_global`), and **Dismiss** (`dismiss`). Also offers `Copy Markdown Report` to clipboard.
- **Live Tool Status & Cancel:**
  - Displays `"Checking <rootName>/<relPath>..."` on `llm:tool` events during Deep Path (`Smart` / `Ask`), clears as soon as `llm:token` streams, and lets Escape or Stop cancel an in-flight Deep-Path lookup.

## 3. Settings Modal Updates

- Remove all `publik` sign-in/wallet cards, `applink` consent controls, and update-check buttons.
- Keep **Keys**, **Audio** (Local Whisper and cloud STT), and **Style** (`aiRules`, opacity) tabs.
- Replace legacy plain textareas with two structured tabs:
  1. **Profile & Repos (Global):** Attached experience files (`.pdf`, `.docx`, `.md`, `.txt`) and attached local repo folders showing status badge (`ok`, `warning`, `error`), file/chunk counts, `Add File`, `Add Repo Folder`, `Re-index`, `Remove`, plus a list of active Global Promoted Lessons with `Deprecate`.
  2. **Job Workspaces:** Create/edit/delete workspace (`Company`, `Role`), attach JD files and Test files or folders (`Add JD File`, `Add Test File`, `Add Test Folder`), edit human P0 role notes (`Why Company`, `Salary Target`, `Questions to Ask`), and manage workspace-admitted lessons.

## 4. Preload Bridge (`preload.js`)

Exposes typed `window.pue` methods:
- **Profile:** `profileGet()`, `profileAddDoc(kind)`, `profileAddRepo()`, `profileRemoveItem(id)`, `profileReindex()`, `profileDeprecateLesson(id)`
- **Workspaces & Rounds:** `workspaceList()`, `workspaceCreate(payload)`, `workspaceUpdate(id, patch)`, `workspaceSelect(id)`, `workspaceDelete(id)`, `workspaceAttachFile(wsId, role, pickFolder)`, `workspaceRemoveFile(wsId, fileId)`, `workspaceCreateRound(wsId, name)`, `workspaceSelectRound(wsId, roundId)`, `workspaceEndRound(wsId, roundId)`, `workspaceGenerateBrief(wsId)`, `workspaceGetDissection(wsId, roundId)`, `workspaceListJournal(wsId)`, `workspaceDecideLesson(wsId, lessonId, decision)`, `workspaceSearchRounds(wsId, query)`
- **Cancel:** `llmCancel()`
- **Allowed event channels:** Adds `llm:tool`, `workspace:changed`, `profile:changed`, `round:dissected` to `preload.js` `allowed` list; removes all `publik:*`, `updates:*`, and `applink:*` channels.

## 5. Boundaries

- **Always:** Preserve all five `verify.js` ordering invariants (`updateTranscriptInterim`, `clearTranscriptInterim`, `showToast`, `llm:start` without `clearMessages()`, tab `saveSettings`); preserve click-through `setIgnoreMouse` toggling around popovers and drawers; escape all rendered file names, transcripts, and LLM text against XSS (`textContent` or HTML-escaped helpers).
- **Ask first:** Changing global keyboard shortcuts (`Cmd+Enter`, `Cmd+Shift+Enter`, `Cmd+H`, `Cmd+Shift+X`) or default overlay dimensions.
- **Never:** Render raw HTML from LLM outputs or JD/repo chunks; expose direct `fs` in renderer; auto-approve Failure Journal lessons without user click.

## 6. Success Criteria

1. `node verify.js` exits with code `0` after all renderer changes.
2. `preload.js` exposes every required `profile*`, `workspace*`, and `llmCancel` bridge method and zero `publik*`, `updates*`, or `applink*` methods.
3. UI tests verify workspace/round switching, Prep Brief rendering, Round Dissection Q&A review rendering, Failure Journal `Accept` / `Promote` / `Dismiss` IPC calls, and `llm:tool` status clearing on first token.
4. All user/file/LLM strings rendered in drawers use DOM text nodes or explicit escaping (verified by XSS unit test).
