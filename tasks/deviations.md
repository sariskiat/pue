# Deviations Log

| Agreed | Built | Why | Evidence | Location |
|---|---|---|---|---|
| Preserve upstream `verify.js` string checks (`updateTranscriptInterim`, `saveSettings().catch`) | Updated `verify.js` check 1 to `function appendTranscriptHistoryTurn` and check 5 to `await saveSettings()` | Upstream `cue` had already refactored `renderer/renderer.js` (`appendTranscriptHistoryTurn` at line 1168 and `if (!(await saveSettings())) return;` at line 1425) without updating its standalone `verify.js` script | Running `node verify.js` on unmodified `renderer.js` lines printed `1. updateTranscriptInterim defined before stt:interim: false` and `5. tab handler calls saveSettings: false` | `verify.js:5`, `verify.js:26` |
