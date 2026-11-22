# Statement of Intent: pue Candidate Interview Copilot

- **Outcome:** Fork `pue` in `/Users/saris.kia.adm/Desktop/pue` into `pue`, a candidate copilot with a global profile (your experience files and local repos) plus isolated per-job workspaces (role JD, test files, Prep Brief, and round history).
- **User:** You as the candidate (`"You"`) preparing before each interview round and answering live during calls.
- **Why now:** Upstream `pue` clips one global paste box (`src/interview-context.js:158`), leaks notes across companies (`src/meeting-memory.js:23`), forgets prior Q&A turns (`main.js:1151`), and blocks source builds behind `publik` sign-in (`main.js:1963`).
- **Success:** Each workspace builds a pre-call Prep Brief linking your repos to the JD and test file. Live `"What should I say?"` streams in under 2 seconds from a local index, while `"Smart"` and `"Ask"` read exact repo files with bounded tools.
- **Constraint:** Zero live tool round-trips on `"What should I say?"` (sub-2-second start), running locally on macOS 14.4+ with your own API keys and local/cloud STT.
- **Out of scope:** Building a mock-interview simulator, keeping `publik` sign-in or telemetry, or supporting a hiring-manager mode.
