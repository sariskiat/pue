const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'renderer', 'renderer.js'), 'utf8');

const defPos = src.indexOf('function appendTranscriptHistoryTurn');
const handlerPos = src.indexOf("pue.on('stt:interim'");
const r1 = defPos !== -1 && handlerPos !== -1 && defPos < handlerPos;
console.log('1. appendTranscriptHistoryTurn defined before stt:interim:', r1);

const clearDefPos = src.indexOf('function clearTranscriptInterim');
const finalHandlerPos = src.indexOf("pue.on('stt:final'");
const r2 = clearDefPos !== -1 && finalHandlerPos !== -1 && clearDefPos < finalHandlerPos;
console.log('2. clearTranscriptInterim defined before stt:final:', r2);

const toastDefPos = src.indexOf('function showToast');
const clearBtnHandlerPos = src.indexOf('clearTranscriptBtn.addEventListener');
const r3 = toastDefPos !== -1 && clearBtnHandlerPos !== -1 && toastDefPos < clearBtnHandlerPos;
console.log('3. showToast defined before clear btn addEventListener:', r3);

const llmStartIdx = src.indexOf("pue.on('llm:start'");
const llmTokenIdx = src.indexOf("pue.on('llm:token'");
const llmStartBlock = src.substring(llmStartIdx, llmTokenIdx);
const r4 = !llmStartBlock.includes('clearMessages()');
console.log('4. llm:start does NOT call clearMessages():', r4);

const tabClickPos = src.indexOf("querySelectorAll('.s-tab').forEach");
const tabHandlerPos = src.indexOf('await saveSettings()', tabClickPos);
const r5 = tabClickPos > 0 && tabHandlerPos > tabClickPos;
console.log('5. tab handler awaits saveSettings:', r5);

const clearToolDefPos = src.indexOf('function clearToolStatus');
const r6 = clearToolDefPos !== -1 && llmTokenIdx !== -1 && clearToolDefPos < llmTokenIdx;
console.log('6. clearToolStatus defined before llm:token:', r6);

const overlayBarDefPos = src.indexOf('function renderWorkspaceOverlayBar');
const wsChangedPos = src.indexOf("pue.on('workspace:changed'");
const r7 = overlayBarDefPos !== -1 && wsChangedPos !== -1 && overlayBarDefPos < wsChangedPos;
console.log('7. renderWorkspaceOverlayBar defined before workspace:changed:', r7);

const allPass = r1 && r2 && r3 && r4 && r5 && r6 && r7;
console.log('\nAll checks passed:', allPass);
process.exit(allPass ? 0 : 1);
