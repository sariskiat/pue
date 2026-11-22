# pue

**Local BYOK candidate interview copilot for macOS, Windows, and Linux.**

`pue` floats an always-on-top glass panel over your desktop during interview preparation and live calls. It connects directly to your own AI keys (Anthropic, OpenAI, Google Gemini, Groq, Cerebras, DeepSeek, MiniMax, Azure AI Foundry, Ollama, or any OpenAI-compatible endpoint) with zero cloud account gates or telemetry.

> [!IMPORTANT]
> Screen-share hiding (`setContentProtection`) is best-effort and depends on OS APIs. Always follow the rules of the platform you use and local recording consent laws.

## Core Capabilities

- **Global Candidate Profile:** Index your resume, experience documents (`.md`, `.txt`, `.pdf`, `.docx`), and local Git repositories once. Incremental BM25 + exact-symbol Reciprocal Rank Fusion (`RRF`) keeps code and project facts searchable offline.
- **Isolated Per-Job Workspaces:** Keep each company and role in its own sharded workspace (`workspaces/<wsId>/`) with attached job descriptions, take-home files, pre-call Prep Briefs, and multi-round JSONL logs. Data never leaks across companies.
- **Two-Speed Context Retrieval:**
  - **Fast Path (`Smart` off):** Local `RRF` chunk retrieval (`<20ms`) with zero live tool calls for instant spoken-style replies.
  - **Deep Path (`Smart` on or typed `Ask`):** Bounded read-only file tool loop (`list_files`, `grep_files`, `read_file`, max 4 rounds, `35s` wall timeout) jailed strictly to your attached repositories and workspace folders.
- **Thai + English Live Transcription:** Stream live speech through OpenAI Realtime (`gpt-live-transcribe`, configured for Thai `th` and English `en` without translating), Deepgram, Gemini, Groq, or offline local `whisper.cpp`. You can keep Anthropic or Gemini for chat while using OpenAI for listening in **Settings -> Audio**.
- **Hold: Them (Interviewer Capture):** Hold **Hold: Them** on the overlay, hold `⌥Space` while `pue` is focused, or toggle `⌘⇧L` globally from Zoom or Chrome while the interviewer or hiring manager asks a question. `pue` tags that speech as `Them` in your active session and round log without auto-sending an answer.
- **Post-Round Dissection & Failure Journal:** Click **End Round** after a call to generate a side-by-side review (`You spoke` vs `Copilot suggested`), gap ratings, and proposed lessons. No lesson enters future prompts until you explicitly approve it for the workspace or promote it globally.

## Controls & Shortcuts

| Action | macOS | Windows / Linux | Behavior |
|---|---|---|---|
| **What should I say?** | `⌘↵` | `Ctrl+Enter` | Suggests a first-person spoken reply from the live transcript and profile |
| **Smart assist** | `⌘⇧↵` | `Ctrl+Shift+Enter` | Captures your screen plus recent conversation |
| **Hold: Them** | Hold button, `⌥Space`, or `⌘⇧L` | Hold button, `Alt+Space`, or `Ctrl+Shift+L` | Transcribes audio as `Them` (interviewer) into the session; release saves the turn |
| **Coding solve** | `⌘H` | `Ctrl+H` | Solves a coding problem from your screen |
| **Smart toggle** | Click `Smart` pill | Click `Smart` pill | Enables the stronger model and read-only repository tools |
| **Hide / Show panel** | `⌘⇧/` | `Ctrl+Shift+/` | Collapses or restores the overlay |
| **Quit `pue`** | `⌘⇧X` | `Ctrl+Shift+X` | Exits `pue` immediately |

## Quick Start

Requires Node.js `22.12+`.

```bash
git clone https://github.com/sariskiat/pue.git
cd pue
npm install
npm start
```

### First-Time Setup in `pue`

1. Open **Settings -> Keys**, choose your chat provider (for example `Anthropic` or `OpenAI`), and paste your API key.
2. Open **Settings -> Audio**, choose `OpenAI` (paste your `sk-...` key in the OpenAI Realtime card) or `Local` (`whisper.cpp`). Turn **Meeting audio -> On** if you want macOS system-audio loopback, or leave it `Off` and use **Hold: Them** (`⌘⇧L`).
3. Open **Settings -> Profile** to attach your resume and local Git repositories.
4. Open **Settings -> Jobs** to create a workspace for the target company and attach the job description.

## Build & Install on macOS (Apple Silicon)

```bash
# Build unpacked app bundle into dist/mac-arm64/pue.app
./node_modules/.bin/electron-builder --mac --arm64 --dir

# Ad-hoc sign with microphone entitlement and copy to /Applications
codesign --force --deep --sign - --entitlements build-resources/entitlements.mac.plist dist/mac-arm64/pue.app
ditto dist/mac-arm64/pue.app /Applications/pue.app
xattr -cr /Applications/pue.app
```

If you want offline local `whisper.cpp` transcription from source, run `npm run prepare:whisper` once before packaging, and build with `PUE_BUNDLE_WHISPER=1` to bundle the local binary.

## Verification

```bash
# Unit and integration tests
npm test

# Static renderer wiring checks
node verify.js

# Automated 13-screen Electron UI screenshot and geometry audit
PUE_UI_AUDIT_OUT=/tmp/pue-ui-audit PUE_SKIP_PERMISSIONS=1 PUE_NO_PROTECT=1 ./node_modules/.bin/electron scripts/ui-audit/capture-screens.cjs
```

## Data Storage

All settings, keys, indexed chunks, and round logs stay on your machine under your OS user data directory (`~/Library/Application Support/pue/` on macOS) with `0600` file permissions:

- `pue-data.json`: provider settings and local API keys
- `profile-index.json`: global candidate documents, repository cards/chunks, and promoted lessons
- `workspaces/<wsId>.json`: per-job workspace metadata and Prep Brief
- `workspaces/<wsId>/rounds/<rndId>.jsonl`: append-only round transcript, tool trace, and Q&A log
- `workspaces/<wsId>/failure-journal.jsonl`: workspace-governed Failure Journal lessons
