/* cue renderer — UI state, mic capture, IPC, streaming render. */
(function () {
  const { icon } = window.ICONS;
  const cue = window.cue; // exposed by preload
  const $ = (s) => document.querySelector(s);
  const isWindows = cue.platform === 'win32';
  const isMac = cue.platform === 'darwin';

  // Exiting must work before settings or provider setup has completed.
  const quitButton = $('#quit-btn');
  quitButton.addEventListener('click', () => cue.quit());
  quitButton.title = isMac ? 'Quit cue (⌘⇧X)' : 'Quit cue (Ctrl+Shift+X)';

  // ---- paint icons -------------------------------------------------------
  $('#logo-btn').innerHTML = icon('badge-question-mark', { size: 16 });
  $('#tb-settings-btn').innerHTML = icon('settings', { size: 16 });
  $('.tb-hide .chev').innerHTML = icon('chevron-down', { size: 14 });
  $('#opacity-btn .ic').innerHTML = icon('eclipse', { size: 14 });
  $('#quit-btn').innerHTML = icon('x', { size: 14 });
  document.querySelector('.act[data-mode="assist"] .ic').innerHTML = icon('monitor', { size: 16 });
  document.querySelector('.act[data-mode="say"] .ic').innerHTML = icon('wand-sparkles', { size: 16 });
  document.querySelector('.act[data-mode="recap"] .ic').innerHTML = icon('refresh-cw', { size: 16 });
  $('#smart-toggle .ic').innerHTML = icon('zap', { size: 14 });
  $('#more-btn').innerHTML = icon('more-horizontal', { size: 18 });
  $('#send-btn').innerHTML = icon('play', { size: 15 });
  const clearIC = document.querySelector('#clear-transcript-btn .ic');
  if (clearIC) clearIC.innerHTML = icon('trash-2', { size: 15 });

  function setSessionButton(active) {
    const btn = $('#stop-btn');
    const ic = btn.querySelector('.ic');
    const label = btn.querySelector('.tb-stop-label');
    btn.classList.toggle('active', active);
    if (ic) ic.innerHTML = active
      ? icon('square', { size: 14 })
      : icon('play', { size: 14, filled: false });
    if (label) label.textContent = active ? 'End session' : 'Start session';
    const title = active ? 'End session' : 'Start session';
    btn.title = title;
    btn.setAttribute('aria-label', title);
  }
  setSessionButton(false);

  // ---- state -------------------------------------------------------------
  let settings = null;
  let whisperOverview = null;
  let profileState = { documents: [], repos: [], promotedLessons: [] };
  let workspaceState = { activeWorkspaceId: null, items: [], activeWorkspace: null };
  let busy = false;
  let aiEl = null;       // current streaming <div class="ai-text">
  let caretEl = null;
  let responseCount = 0;
  const MAX_RESPONSES = 20;

  const messages = $('#messages');

  function esc(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // minimal, safe markdown: fenced code, bullets, inline code, bold, paragraphs
  function renderMarkdown(text) {
    const lines = text.split('\n');
    let html = '', inCode = false, inList = false, buf = [];
    const flushP = () => { if (buf.length) { html += '<p>' + inline(buf.join(' ')) + '</p>'; buf = []; } };
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    for (const raw of lines) {
      const line = raw;
      if (/^```/.test(line.trim())) {
        if (!inCode) { flushP(); if (inList) { html += '</ul>'; inList = false; } html += '<pre><code>'; inCode = true; }
        else { html += '</code></pre>'; inCode = false; }
        continue;
      }
      if (inCode) { html += esc(line) + '\n'; continue; }
      if (/^\s*[-*]\s+/.test(line)) { flushP(); if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(line.replace(/^\s*[-*]\s+/, '')) + '</li>'; continue; }
      if (line.trim() === '') { flushP(); if (inList) { html += '</ul>'; inList = false; } continue; }
      buf.push(line.trim());
    }
    flushP(); if (inList) html += '</ul>'; if (inCode) html += '</code></pre>';
    return html;
  }

  function clearMessages() { messages.innerHTML = ''; aiEl = null; caretEl = null; }

  function addUserBubble(text) {
    const b = document.createElement('div');
    b.className = 'user-bubble';
    b.textContent = text;
    messages.appendChild(b);
  }

  function startAi(small) {
    aiEl = document.createElement('div');
    aiEl.className = 'ai-text' + (small ? ' small' : '');
    aiEl.dataset.raw = '';
    caretEl = document.createElement('span');
    caretEl.className = 'ai-caret';
    aiEl.appendChild(caretEl);
    messages.appendChild(aiEl);
  }

  // "Thinking…" while a reasoning model thinks and no answer text has come
  // yet. Only this placeholder shows, never the reasoning itself. The first
  // answer token replaces it (appendToken), and so does the final message
  // (finalizeAi re-renders the bubble from its text).
  function showThinking() {
    if (!aiEl || aiEl.dataset.raw) return;
    if (aiEl.querySelector('.ai-thinking')) return;
    const el = document.createElement('span');
    el.className = 'ai-thinking';
    el.textContent = 'Thinking…';
    if (caretEl && caretEl.parentNode === aiEl) aiEl.insertBefore(el, caretEl);
    else aiEl.appendChild(el);
    scrollAnswerToEnd();
  }

  function clearThinking() {
    const el = aiEl && aiEl.querySelector('.ai-thinking');
    if (el) el.remove();
  }

  function appendToken(t) {
    if (!aiEl) startAi(false);
    clearThinking();
    aiEl.dataset.raw += t;
    const span = document.createElement('span');
    span.className = 'w';
    span.textContent = t;
    // Guard: caretEl must be a child of aiEl
    if (caretEl && caretEl.parentNode === aiEl) {
      aiEl.insertBefore(span, caretEl);
    } else {
      aiEl.appendChild(span);
    }
    scrollAnswerToEnd();
  }

  function finalizeAi() {
    if (!aiEl) return;
    const raw = aiEl.dataset.raw || '';
    aiEl.innerHTML = renderMarkdown(raw);
    aiEl = null; caretEl = null;
    scrollAnswerToEnd(); // the final text (or the honest message) can be taller
  }

  // ---- follow the answer ---------------------------------------------------
  // #messages is at most 50vh tall. A long answer, or the honest message that
  // takes the place of an empty one, grows past its bottom edge (0.2.11 smoke
  // test: the end stayed hidden). While an answer comes in, keep its end in
  // view, but only while the view is at the end: a scroll that leaves the
  // last FOLLOW_SLACK_PX by any means (wheel, scrollbar drag, PageUp, a
  // trackpad) stops following, and a scroll back to the end starts it again.
  // cue's own scrolls are told apart by the position they set. llm:start
  // turns following on.
  let followAnswer = false;
  let followFrame = 0;
  let ownScrollTop = -1;
  const FOLLOW_SLACK_PX = 40;
  function atAnswerEnd() {
    return messages.scrollHeight - messages.scrollTop - messages.clientHeight <= FOLLOW_SLACK_PX;
  }
  function scrollMessagesToEnd() {
    const end = Math.max(0, messages.scrollHeight - messages.clientHeight);
    ownScrollTop = end;
    messages.scrollTop = end;
    ownScrollTop = messages.scrollTop; // what the browser kept (it can round)
  }
  function scrollAnswerToEnd() {
    if (!followAnswer || followFrame) return;
    // One scroll per frame, after the DOM has the new text.
    followFrame = requestAnimationFrame(() => {
      followFrame = 0;
      if (followAnswer) scrollMessagesToEnd();
    });
  }
  messages.addEventListener('scroll', () => {
    if (Math.abs(messages.scrollTop - ownScrollTop) <= 2) return; // cue's own scroll
    ownScrollTop = -1;
    followAnswer = atAnswerEnd();
  }, { passive: true });

  let busyFailsafe = null;
  function setBusy(v) {
    busy = v;
    $('#send-btn').classList.toggle('busy', v);
    clearTimeout(busyFailsafe);
    if (v) armBusyFailsafe();
  }

  // Failsafe: main has a 25s stream watchdog that always sends llm:done/llm:error, but if a
  // terminal event is ever lost the whole UI stays frozen — self-clear after a generous window.
  // The window counts from the last sign of life (thinking or answer text), so a long answer
  // that is still streaming is never cleared under it.
  function armBusyFailsafe() {
    clearTimeout(busyFailsafe);
    busyFailsafe = setTimeout(() => { busy = false; $('#send-btn').classList.toggle('busy', false); }, 40000);
  }

  function onAnswerActivity() {
    if (busy) armBusyFailsafe();
  }

  // ---- transcript helpers ------------------------------------------------
  // NOTE: The old transcript-list element was renamed to ts-list.
  // These helpers are now deprecated but kept for compatibility.
  // The main sidebar uses appendTranscriptHistoryTurn() instead.
  let transcriptInterimEl = null;

  // FIX #1: Updated to use ts-list instead of non-existent transcript-list

  function clearTranscriptInterim() {
    if (transcriptInterimEl) {
      transcriptInterimEl.remove();
      transcriptInterimEl = null;
    }
  }

  // ---- toast helper ------------------------------------------------------
  // FIX #7: Toast queue system — ensures latest toast wins cleanly without stacking
  let toastTimer = null;
  let toastFadeTimer = null;
  function showToast(message, ms) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.getElementById('panel-wrap').appendChild(el);
    }
    // Clear any pending timers to prevent overlap
    clearTimeout(toastTimer);
    clearTimeout(toastFadeTimer);
    // Immediately update content (no stacking)
    el.textContent = message;
    el.classList.add('show');
    toastTimer = setTimeout(() => {
      el.classList.remove('show');
    }, ms);
  }

  // ---- actions -----------------------------------------------------------
  function runMode(mode, text) {
    if (busy) return;
    setBusy(true);
    cue.ask({ mode, text: text || '' });
  }

  document.querySelectorAll('.act').forEach((btn) => {
    btn.addEventListener('click', () => runMode(btn.dataset.mode, ''));
  });

  const input = $('#input');
  const placeholder = $('#placeholder');
  const composer = $('#composer');

  // ========== SMART AUTO-FILL SYSTEM ==========
  // Track whether the current input text came from STT auto-fill (Them channel)
  let inputFromSTT = false;
  let sttFillTimer = null;
  let questionFinalizeTimer = null;
  let softClearTimer = null;
  let userSpeechStart = null;

  // Question history for undo (Ctrl+Z)
  const questionHistory = [];
  const MAX_QUESTION_HISTORY = 10;

  // ---- Question completeness detection ----
  function isLikelyCompleteQuestion(text) {
    const trimmed = (text || '').trim();
    
    // Must be substantial (not just filler words)
    if (trimmed.length < 12) return false;
    
    // High confidence: ends with question mark
    if (/\?$/.test(trimmed)) return true;
    
    // High confidence: behavioral interview patterns (these are complete even without ?)
    const behavioralPatterns = [
      /tell me about a time/i,
      /give me an example/i,
      /describe a (situation|time|project|challenge)/i,
      /walk me through/i,
      /can you (tell|describe|explain|share)/i,
      /what (was|were|is|are) your/i,
      /how (did|do|would) you/i,
      /why (did|do|are|should)/i,
      /what (did|do|would) you/i,
      /tell me about yourself/i,
      /tell me about your/i,
      /what.{1,30}(biggest|greatest|most|hardest|proudest)/i,
      /have you ever/i
    ];
    if (behavioralPatterns.some(p => p.test(trimmed))) return true;
    
    // Medium confidence: question starters with substantial content
    const questionStarters = /^(what|how|why|when|where|who|which|tell|describe|explain|can|could|would|should|have|did|do|is|are|was|were)/i;
    if (questionStarters.test(trimmed) && trimmed.length > 25) return true;
    
    // Medium confidence: ends with common question endings
    if (/(about that|for us|to us|with you|for you|about it|to share|you handle|you approach|your experience|your background)\s*$/i.test(trimmed)) return true;
    
    return false;
  }

  // ---- Get question confidence level ----
  function getQuestionConfidence(text) {
    const trimmed = (text || '').trim();
    if (trimmed.length < 8) return 'low';
    if (/\?$/.test(trimmed)) return 'high';
    if (isLikelyCompleteQuestion(trimmed)) return 'medium';
    if (trimmed.length > 20) return 'accumulating';
    return 'low';
  }

  // ---- Update visual state based on question readiness ----
  // FIX #8: Batch class updates to avoid flicker
  function updateQuestionReadyState() {
    const text = input.value;
    const confidence = getQuestionConfidence(text);
    
    // Batch the class changes to minimize repaints
    const shouldBeReady = confidence === 'high' || confidence === 'medium';
    const shouldBeAccumulating = confidence === 'accumulating';
    
    // Only update if state actually changed
    const isReady = composer.classList.contains('stt-ready');
    const isAccumulating = composer.classList.contains('stt-accumulating');
    
    if (shouldBeReady !== isReady || shouldBeAccumulating !== isAccumulating) {
      composer.classList.remove('stt-ready', 'stt-accumulating');
      if (shouldBeReady) {
        composer.classList.add('stt-ready');
      } else if (shouldBeAccumulating) {
        composer.classList.add('stt-accumulating');
      }
    }
    
    updateSendButtonState(); // FIX #9: Keep send button in sync
  }
  
  // FIX #9: Send button visual "ready" state
  function updateSendButtonState() {
    const sendBtn = document.getElementById('send-btn');
    if (!sendBtn) return;
    
    const hasText = input.value.trim().length > 0;
    const isReady = composer.classList.contains('stt-ready');
    
    sendBtn.classList.toggle('ready', hasText && isReady);
    sendBtn.classList.toggle('has-text', hasText);
  }

  // ---- Save question to history for undo ----
  function saveToQuestionHistory(text) {
    if (!text || text.trim().length < 5) return;
    
    // Don't save duplicates
    const last = questionHistory[questionHistory.length - 1];
    if (last && last.text === text.trim()) return;
    
    questionHistory.push({
      text: text.trim(),
      timestamp: Date.now()
    });
    
    // Keep only recent history
    while (questionHistory.length > MAX_QUESTION_HISTORY) {
      questionHistory.shift();
    }
  }

  // ---- Restore last question from history (Ctrl+Z) ----
  function restoreLastQuestion() {
    const last = questionHistory.pop();
    if (last) {
      input.value = last.text;
      inputFromSTT = true;
      lastSTTValue = last.text; // FIX #8: Track restored value for edit detection
      composer.classList.add('stt-filling');
      updateQuestionReadyState();
      syncPlaceholder();
      showToast('Question restored', 1500);
      return true;
    }
    showToast('No question to restore', 1500);
    return false;
  }

  // ---- Auto-fill the input box with transcribed speech from interviewer ----
  function autoFillInputFromSTT(text) {
    // If user has manually typed something different, don't overwrite
    if (!inputFromSTT && input.value.trim().length > 0) return;

    // Cancel any pending soft-clear (interviewer is still talking)
    clearTimeout(softClearTimer);
    composer.classList.remove('stt-dimmed');

    const current = input.value.trim();
    const newText = current ? current + ' ' + text : text;
    input.value = newText;
    inputFromSTT = true;
    lastSTTValue = newText; // FIX #6: Track the STT value for edit detection
    syncPlaceholder();

    // Show filling state
    composer.classList.add('stt-filling');
    updateQuestionReadyState();
    updateSendButtonState(); // FIX #9: Update send button state

    // Reset the idle timer — after 2s of silence, check if question is complete
    clearTimeout(questionFinalizeTimer);
    questionFinalizeTimer = setTimeout(() => {
      if (isLikelyCompleteQuestion(input.value)) {
        composer.classList.add('stt-ready');
        updateSendButtonState(); // FIX #9: Update send button when ready
        // Subtle notification that question is ready
        showToast('Press Enter to answer', 2500);
      }
    }, 1800);

    // After 8s of no new words, save to history and keep stable
    clearTimeout(sttFillTimer);
    sttFillTimer = setTimeout(() => {
      saveToQuestionHistory(input.value);
      composer.classList.remove('stt-filling');
      // Keep stt-ready if applicable
      updateQuestionReadyState();
      updateSendButtonState(); // FIX #9
    }, 8000);
  }

  // ---- Soft clear: don't immediately wipe question when user speaks ----
  function softClearSTTFill() {
    // When the user speaks (You channel), don't immediately clear
    // Instead, dim the input and wait — they might just be acknowledging
    if (!inputFromSTT) return;
    
    // FIX #3: Reset userSpeechStart at the beginning before setting new timestamp
    // This ensures we always track from fresh when a new soft-clear cycle begins
    const now = Date.now();
    if (!userSpeechStart) {
      userSpeechStart = now;
    }

    // Dim the input to show it's in "pending clear" state
    composer.classList.add('stt-dimmed');
    
    // Clear the finalization timer (user is responding)
    clearTimeout(questionFinalizeTimer);

    // Re-armed on every 'you' final, so this fires ~800ms after the user stops.
    // The 2s test below is measured from the FIRST final of this cycle, so a brief
    // acknowledgement ("mm-hm") leaves the question on screen while a sustained
    // answer clears it. Firing at 2.5s instead would make that test always true.
    clearTimeout(softClearTimer);
    softClearTimer = setTimeout(() => {
      const speechDuration = userSpeechStart ? Date.now() - userSpeechStart : 0;
      if (speechDuration > 2000) {
        // User has been speaking for a while — they're answering, clear the box
        saveToQuestionHistory(input.value);
        input.value = '';
        inputFromSTT = false;
        composer.classList.remove('stt-filling', 'stt-dimmed', 'stt-ready', 'stt-accumulating');
        syncPlaceholder();
        updateSendButtonState(); // FIX #9: Update send button state
        userSpeechStart = null;
      }
    }, 800);
  }

  // ---- Hard clear (called when user explicitly clears or types) ----
  // FIX #10: Add option to show toast when clearing
  function hardClearSTTFill(showUndoHint = false) {
    const hadContent = input.value.trim().length > 0;
    saveToQuestionHistory(input.value);
    input.value = '';
    inputFromSTT = false;
    lastSTTValue = ''; // FIX #6: Clear the tracked STT value
    userSpeechStart = null;
    composer.classList.remove('stt-filling', 'stt-dimmed', 'stt-ready', 'stt-accumulating');
    clearTimeout(softClearTimer);
    clearTimeout(questionFinalizeTimer);
    clearTimeout(sttFillTimer);
    clearInputInterim(); // FIX #5: Clear interim when clearing input
    syncPlaceholder();
    updateSendButtonState(); // FIX #9
    
    // FIX #10: Show undo hint when explicitly cleared
    if (showUndoHint && hadContent) {
      const undoHint = isWindows ? 'Ctrl+Z to undo' : '⌘Z to undo';
      showToast(`Cleared · ${undoHint}`, 2000);
    }
  }

  // ---- Reset soft-clear state (interviewer spoke again) ----
  // FIX #16: Reset userSpeechStart properly when cancelSoftClear is called
  function cancelSoftClear() {
    userSpeechStart = null; // Reset timestamp so next soft-clear starts fresh
    clearTimeout(softClearTimer);
    composer.classList.remove('stt-dimmed');
  }

  function syncPlaceholder() {
    placeholder.classList.toggle('hidden', input.value.length > 0 || document.activeElement === input);
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  }
  
  // FIX #6: Track last STT value to detect substantial edits vs minor corrections
  let lastSTTValue = '';
  
  input.addEventListener('input', () => {
    const currentValue = input.value;
    
    // FIX #5: Clear interim text when user starts typing
    clearInputInterim();
    
    // FIX #6: Only detach from STT mode if edit is substantial
    // Minor corrections (typo fixes, small additions) should keep STT mode
    if (inputFromSTT && lastSTTValue) {
      const lengthDiff = Math.abs(currentValue.length - lastSTTValue.length);
      const isCleared = currentValue.trim().length === 0;
      const isSubstantialChange = lengthDiff > lastSTTValue.length * 0.3 || isCleared;
      
      if (isSubstantialChange) {
        // User made a major change — detach from STT mode
        saveToQuestionHistory(lastSTTValue);
        inputFromSTT = false;
        lastSTTValue = '';
        composer.classList.remove('stt-filling', 'stt-dimmed', 'stt-ready', 'stt-accumulating');
        clearTimeout(softClearTimer);
        clearTimeout(questionFinalizeTimer);
      }
      // Minor edits: keep inputFromSTT = true, just update visual state
    } else if (!inputFromSTT) {
      // User typing from scratch — standard behavior
      composer.classList.remove('stt-filling', 'stt-dimmed', 'stt-ready', 'stt-accumulating');
    }
    
    syncPlaceholder();
    updateSendButtonState(); // FIX #9: Update send button on input change
  });
  input.addEventListener('focus', () => { composer.classList.add('focused'); placeholder.classList.add('hidden'); });
  input.addEventListener('blur', () => { composer.classList.remove('focused'); syncPlaceholder(); });
  $('#input-area').addEventListener('click', () => input.focus());

  function send() {
    const text = input.value.trim();
    if (!text) { runMode('assist', ''); return; }
    const wasFromSTT = inputFromSTT;
    
    // Save to history before clearing (in case user wants to redo)
    saveToQuestionHistory(text);
    
    input.value = '';
    inputFromSTT = false;
    lastSTTValue = ''; // FIX #6: Clear tracked STT value
    userSpeechStart = null;
    composer.classList.remove('stt-filling', 'stt-dimmed', 'stt-ready', 'stt-accumulating');
    clearTimeout(softClearTimer);
    clearTimeout(questionFinalizeTimer);
    clearTimeout(sttFillTimer);
    syncPlaceholder();
    updateSendButtonState(); // FIX #9
    
    // If text came from STT (interviewer question), use answerThis mode
    // Otherwise use ask mode (user typed their own question)
    runMode(wasFromSTT ? 'answerThis' : 'ask', text);
  }
  $('#send-btn').addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    // Ctrl+Z / Cmd+Z: restore last question if input is empty
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !input.value.trim()) {
      e.preventDefault();
      restoreLastQuestion();
      return;
    }
    // Escape: clear the input (with undo hint)
    if (e.key === 'Escape' && input.value.trim()) {
      e.preventDefault();
      hardClearSTTFill(true); // FIX #10: Show undo hint
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); send(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      runMode(e.shiftKey ? 'assist' : 'say', '');
    }
  });
  
  // FIX #13: Global keyboard shortcut for force-answer (Ctrl+Shift+A / Cmd+Shift+A)
  document.addEventListener('keydown', (e) => {
    // Ctrl+Shift+A / Cmd+Shift+A: Force answer current question immediately
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      if (input.value.trim()) {
        send();
      } else if (inputFromSTT || composer.classList.contains('stt-filling')) {
        // Even if question seems incomplete, force send
        send();
      } else {
        showToast('No question to answer', 1500);
      }
    }
  });
  
  // FIX #4: Add tooltip with keyboard shortcuts to send button
  const sendBtn = document.getElementById('send-btn');
  if (sendBtn) {
    const forceKey = isWindows ? 'Ctrl+Shift+A' : '⌘⇧A';
    sendBtn.title = `Send · ${forceKey} to force answer`;
  }

  // Smart toggle
  const smartBtn = $('#smart-toggle');
  smartBtn.addEventListener('click', async () => {
    settings.smart = !settings.smart;
    smartBtn.classList.toggle('on', settings.smart);
    await cue.settingsSet({ smart: settings.smart });
  });

  // Hide / collapse
  let reopenSidebarOnExpand = false;
  function toggleHide() {
    const collapsed = $('#panel-wrap').classList.toggle('collapsed');
    const btn = $('#hide-btn');
    btn.classList.toggle('collapsed', collapsed);
    const label = btn.querySelector('.tb-hide-label');
    const text = collapsed ? 'Show' : 'Hide';
    if (label) label.textContent = text;
    btn.title = text;
    btn.setAttribute('aria-label', text);
    if (collapsed) {
      reopenSidebarOnExpand = sidebarOpen;
      if (sidebarOpen) hideSidebar();
    } else if (reopenSidebarOnExpand) {
      showSidebar();
    }
  }
  $('#hide-btn').addEventListener('click', toggleHide);
  cue.on('hide:toggle', toggleHide);

  const OPACITY_MIN = 0.2;
  function clampOpacity(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 1;
    return Math.min(1, Math.max(OPACITY_MIN, Math.round(n * 100) / 100));
  }
  function opacityToPercent(value) { return Math.round(clampOpacity(value) * 100); }
  function persistOpacitySoon() {
    clearTimeout(persistOpacitySoon.timer);
    persistOpacitySoon.timer = setTimeout(() => {
      if (!settings) return;
      cue.settingsSet({ opacity: settings.opacity }).then((next) => { if (next) settings = next; }).catch(() => {});
    }, 400);
  }
  function applyOpacity(value, persist) {
    const opacity = clampOpacity(value);
    const percent = opacityToPercent(opacity);
    if (settings) settings.opacity = opacity;
    document.documentElement.style.setProperty('--cue-opacity', String(opacity));
    const tb = $('#tb-opacity-slider');
    const tbVal = $('#tb-opacity-value');
    const s = $('#s-opacity-slider');
    const sVal = $('#s-opacity-value');
    if (tb) tb.value = String(percent);
    if (tbVal) tbVal.textContent = percent + '%';
    if (s) s.value = String(percent);
    if (sVal) sVal.textContent = percent + '%';
    if (persist) persistOpacitySoon();
  }
  function toggleOpacityPopover(force) {
    const pop = $('#opacity-popover');
    const btn = $('#opacity-btn');
    if (!pop || !btn) return;
    const open = force != null ? force : pop.classList.contains('hidden');
    pop.classList.toggle('hidden', !open);
    btn.classList.toggle('on', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.getElementById('app').classList.toggle('opacity-open', open);
  }
  $('#opacity-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleOpacityPopover();
  });
  document.addEventListener('click', (e) => {
    const wrap = document.querySelector('.tb-opacity-wrap');
    if (wrap && !wrap.contains(e.target)) toggleOpacityPopover(false);
  });
  ['tb-opacity-slider', 's-opacity-slider'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => applyOpacity(Number(el.value) / 100, true));
    el.addEventListener('change', () => applyOpacity(Number(el.value) / 100, true));
  });

  // Stop = start/stop listening. Kick off system-audio capture straight from the click so
  // the user-gesture is fresh for getDisplayMedia (loopback capture needs it).
  $('#stop-btn').addEventListener('click', async () => {
    const turningOn = !$('#stop-btn').classList.contains('active');
    if (turningOn) {
      // startSystemAudio may fail (user cancels, no permission) — that's OK,
      // mic will still work and capture will toggle regardless
      try { await startSystemAudio(); } catch (_) { /* handled inside startSystemAudio */ }
    }
    const active = await cue.captureToggle();
    if (turningOn && !active) stopSystemAudio();
  });

  // Transcript toggle removed — sidebar now auto-opens with listening

  // Clear transcript
  const clearTranscriptBtn = document.getElementById('clear-transcript-btn');
  if (clearTranscriptBtn) {
    clearTranscriptBtn.addEventListener('click', async () => {
      await cue.clearTranscript();
      // Also clear the floating interim bar
      if (interimEl) { interimEl.textContent = ''; interimEl.classList.remove('show'); }
      transcriptInterimEl = null;
      clearTranscriptSidebar();
      // Only a question auto-filled from the transcript goes; anything the user typed stays.
      if (inputFromSTT) hardClearSTTFill();
      showToast('Transcript cleared.', 2500);
    });
  }

  // ---- capture: mic (renderer side) — uses AudioWorklet (modern, off-main-thread) ----
  let audioCtx = null, micStream = null, micWorklet = null;
  // Generation counter: startMic() awaits getUserMedia, so a second call (or a
  // stopMic()) can land mid-flight. Each start bumps the generation and bails
  // if it is no longer current, otherwise two capture pipelines end up feeding
  // the "you" channel at once — every slice of speech arrives twice, which the
  // transcriber can't make sense of — and the orphaned one keeps the mic hot.
  let micGen = 0;
  async function startMic() {
    if (micStream) return;
    const gen = ++micGen;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 16000
        }
      });
      if (gen !== micGen || micStream) {
        // Superseded while we were waiting: another start won, or a stop came in.
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      micStream = stream;
      // getUserMedia can resolve with a stream that has no usable audio track
      // (e.g. a virtual/placeholder device, or a device that was unplugged
      // between permission grant and capture start). Fail loudly here instead
      // of silently wiring up an AudioWorklet to nothing — that produces the
      // "cue never hears me, no error shown" symptom with no diagnostic at all.
      const [track] = micStream.getAudioTracks();
      if (!track) {
        micStream.getTracks().forEach((t) => t.stop());
        micStream = null;
        showStatus('No microphone audio track was available. Check Windows Sound settings for a working default input device, then try again.');
        return;
      }
      cue.log('mic stream started: track=' + (track.label || '(no label — permission may be stale)') + ' muted=' + track.muted);
      audioCtx = new AudioContext({ sampleRate: 16000 });

      // Use AudioWorklet for low-latency, off-main-thread processing
      try {
        await audioCtx.audioWorklet.addModule('audio-worklet-processor.js');
        const source = audioCtx.createMediaStreamSource(micStream);
        micWorklet = new AudioWorkletNode(audioCtx, 'cue-audio-processor');
        micWorklet.port.onmessage = (e) => {
          cue.micPcm(e.data);
        };
        source.connect(micWorklet);
        // Don't connect to destination — we just capture, don't play
        cue.log('mic AudioWorklet processor attached');
      } catch (workletErr) {
        // Fallback to ScriptProcessor if AudioWorklet fails (shouldn't happen in Electron 33+)
        cue.log('AudioWorklet failed, falling back to ScriptProcessor: ' + workletErr.message);
        const micNode = audioCtx.createMediaStreamSource(micStream);
        const micProc = audioCtx.createScriptProcessor(4096, 1, 1);
        const sink = audioCtx.createGain(); sink.gain.value = 0;
        micNode.connect(micProc); micProc.connect(sink); sink.connect(audioCtx.destination);
        micProc.onaudioprocess = (e) => {
          const f = e.inputBuffer.getChannelData(0);
          const out = new Int16Array(f.length);
          for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
          cue.micPcm(out.buffer);
        };
        micWorklet = { _legacy: true, proc: micProc, node: micNode, sink };
      }
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      const name = err && err.name;
      cue.log('mic error: ' + name + ' — ' + message);
      // getUserMedia's DOMException.name is the reliable signal here — the
      // .message text varies by Chromium version and isn't meant for users.
      // Distinguishing "no device" from "denied" from "in use elsewhere"
      // turns one generic dead end into three different next actions.
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        showStatus('No microphone was found. Plug one in, or pick a default input device in your OS sound settings, then try again.');
      } else if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
        showStatus(isWindows
          ? 'Microphone permission was denied. Settings → Privacy & security → Microphone → allow cue, then try again.'
          : 'Microphone permission was denied. System Settings → Privacy & Security → Microphone → allow cue, then try again.');
      } else if (name === 'NotReadableError' || name === 'TrackStartError') {
        showStatus('The microphone could not be started — another application may be using it exclusively. Close other apps using the mic and try again.');
      } else {
        showStatus('Microphone capture could not be started. Check your mic permissions and try again.');
      }
    }
  }
  function stopMic() {
    micGen++; // invalidate any startMic() still waiting on getUserMedia
    if (micWorklet) {
      if (micWorklet._legacy) {
        micWorklet.proc.disconnect(); micWorklet.proc.onaudioprocess = null;
        micWorklet.node.disconnect(); micWorklet.sink.disconnect();
      } else {
        micWorklet.disconnect();
      }
      micWorklet = null;
    }
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  }

  // ---- capture: system/meeting audio (getDisplayMedia loopback, in cue's process) ----
  let sysStream = null, sysCtx = null, sysWorklet = null, sysStarting = false;
  async function startSystemAudio() {
    // Called both from the stop-btn click (fresh user gesture for getDisplayMedia) and from the
    // capture:state handler. getDisplayMedia is async, so `if (sysStream) return` alone loses the
    // race and can open a second loopback stream that is then orphaned.
    if (sysStream || sysStarting) return;
    // macOS: asking for meeting audio means asking for a display-capture session, and
    // that session puts the OS screen-recording indicator on the menu bar for the whole
    // call. Default to staying invisible; the user opts in in Settings > Audio.
    if (isMac && !(settings && settings.meetingAudio)) {
      cue.log('system audio: meeting audio is off on macOS -- no display-capture session opened');
      showStatus('Meeting audio is off, so cue stays invisible. macOS shows a screen-recording indicator whenever an app captures system audio; turn Meeting audio on in Settings \u203a Audio if you want the other side transcribed.');
      return;
    }
    sysStarting = true;
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      cue.log('system audio unavailable: getDisplayMedia not supported');
      showStatus('Meeting audio capture is not available on this device build.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });

      stream.getVideoTracks().forEach((t) => t.stop()); // we only want the audio
      const tracks = stream.getAudioTracks();
      if (!tracks.length) {
        cue.log('system audio: no loopback track on this platform');
        stream.getTracks().forEach((t) => t.stop());
        showStatus(cue.platform === 'win32'
          ? 'No system-audio loopback track detected. Make sure "Share audio" is checked in the screen share dialog, and that your audio device is not in exclusive mode.'
          : 'No system-audio loopback track detected. Meeting audio needs macOS 14.4+ — your screen and microphone still work.');
        return;
      }
      sysStream = stream;
      sysCtx = new AudioContext({ sampleRate: 16000 });

      // Use AudioWorklet for system audio too
      try {
        await sysCtx.audioWorklet.addModule('audio-worklet-processor.js');
        const source = sysCtx.createMediaStreamSource(new MediaStream(tracks));
        sysWorklet = new AudioWorkletNode(sysCtx, 'cue-audio-processor');
        sysWorklet.port.onmessage = (e) => {
          cue.systemPcm(e.data);
        };
        source.connect(sysWorklet);
        cue.log('system audio: AudioWorklet capturing loopback');
      } catch (workletErr) {
        // Fallback to ScriptProcessor
        cue.log('system audio AudioWorklet failed, using ScriptProcessor: ' + workletErr.message);
        const sysNode = sysCtx.createMediaStreamSource(new MediaStream(tracks));
        const sysProc = sysCtx.createScriptProcessor(4096, 1, 1);
        const sink = sysCtx.createGain(); sink.gain.value = 0;
        sysNode.connect(sysProc); sysProc.connect(sink); sink.connect(sysCtx.destination);
        sysProc.onaudioprocess = (e) => {
          const f = e.inputBuffer.getChannelData(0);
          const out = new Int16Array(f.length);
          for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
          cue.systemPcm(out.buffer);
        };
        sysWorklet = { _legacy: true, proc: sysProc, node: sysNode, sink };
      }
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      cue.log('system audio error: ' + message);
      showStatus('Meeting audio could not be started. Grant screen/audio access to cue and try again.');
    } finally {
      sysStarting = false;
    }
  }
  function stopSystemAudio() {
    if (sysWorklet) {
      if (sysWorklet._legacy) {
        sysWorklet.proc.disconnect(); sysWorklet.proc.onaudioprocess = null;
        sysWorklet.node.disconnect(); sysWorklet.sink.disconnect();
      } else {
        sysWorklet.disconnect();
      }
      sysWorklet = null;
    }
    if (sysCtx) { sysCtx.close(); sysCtx = null; }
    if (sysStream) { sysStream.getTracks().forEach((t) => t.stop()); sysStream = null; }
  }

  // ---- STT / VAD status helpers ------------------------------------------
  // Live dot states: 'off' | 'idle' | 'speaking' | 'transcribing'
  function setLiveDotState(dotState) {
    const dot = document.getElementById('live-dot');
    if (!dot) return;
    dot.classList.remove('off', 'idle', 'speaking', 'transcribing');
    dot.classList.add(dotState);
    const labels = {
      off:          'Not listening',
      idle:         'Listening — silence detected',
      speaking:     'Speech detected',
      transcribing: 'Transcribing…'
    };
    dot.title = labels[dotState] || '';
  }

  let sttState = 'disconnected';

  const STT_LABELS = {
    disconnected: 'Transcription off',
    connecting: 'Starting transcription…',
    loading: 'Starting transcription…',
    streaming: 'Transcription running',
    batch: 'Transcription running',
    local: 'Transcription running',
    stopping: 'Stopping transcription…',
    error: 'Transcription error'
  };

  function setSttState(state) {
    sttState = state;
    const label = document.getElementById('stt-status');
    if (!label) return;
    label.textContent = STT_LABELS[state];
    label.className = 'stt-status stt-' + state;
  }

  function updateSttStatus({ active, streaming } = {}) {
    if (active === false) setSttState('disconnected');
    else if (active === true) setSttState(streaming ? 'connecting' : 'batch');
  }

  // ---- transcript history sidebar (hidden by default, manual toggle) ----
  let tsSidebarInterimEl = null;
  let sidebarOpen = false;
  // Track last committed row per channel — all chunks from same speaker go in one row
  const tsLastRow = { you: null, them: null };
  const tsRowTimer = { you: null, them: null };
  const TS_SENTENCE_GAP_MS = 10000; // 10s silence = new row

  const SIDEBAR_GAP = 12; // matches the 12px offset in .transcript-sidebar

  function placeSidebar(sidebar) {
    const panel = $('#panel').getBoundingClientRect();
    const needed = sidebar.offsetWidth + SIDEBAR_GAP;
    const areaLeft = screen.availLeft;
    const areaRight = screen.availLeft + screen.availWidth;
    const fitsRight = window.screenX + panel.right + needed <= areaRight;
    const fitsLeft = window.screenX + panel.left - needed >= areaLeft;
    const onLeft = !fitsRight && fitsLeft;
    if (sidebar.classList.contains('left') === onLeft) return;
    // Switch sides without animating, so the open transition starts from the new side's tucked position.
    sidebar.classList.add('ts-instant');
    sidebar.classList.toggle('left', onLeft);
    void sidebar.offsetWidth;
    sidebar.classList.remove('ts-instant');
  }

  function showSidebar() {
    const sidebar = document.getElementById('transcript-sidebar');
    const historyBtn = document.getElementById('history-btn');
    if (sidebar) {
      placeSidebar(sidebar);
      sidebar.classList.add('open');
    }
    if (historyBtn) historyBtn.classList.add('active');
    sidebarOpen = true;
  }

  function hideSidebar() {
    const sidebar = document.getElementById('transcript-sidebar');
    const historyBtn = document.getElementById('history-btn');
    if (sidebar) sidebar.classList.remove('open');
    if (historyBtn) historyBtn.classList.remove('active');
    sidebarOpen = false;
  }

  function toggleSidebar() {
    if (sidebarOpen) {
      hideSidebar();
    } else {
      showSidebar();
      // FIX #7: Scroll to bottom when opening sidebar
      const list = document.getElementById('ts-list');
      if (list) {
        requestAnimationFrame(() => {
          list.scrollTop = list.scrollHeight;
        });
      }
    }
  }

  // History button toggle
  const historyBtn = document.getElementById('history-btn');
  if (historyBtn) {
    historyBtn.querySelector('.ic').innerHTML = icon('message-square-text', { size: 14 });
    historyBtn.addEventListener('click', toggleSidebar);
  }

  // Close sidebar button
  const closeSidebarBtn = document.getElementById('close-sidebar-btn');
  if (closeSidebarBtn) {
    closeSidebarBtn.addEventListener('click', hideSidebar);
  }

  function appendTranscriptHistoryTurn(channel, text, isInterim) {
    const list = document.getElementById('ts-list');
    if (!list) return;

    // Remove placeholder on first real turn
    const ph = list.querySelector('.ts-placeholder');
    if (ph) ph.remove();

    if (isInterim) {
      // Update the single floating interim row
      if (!tsSidebarInterimEl) {
        tsSidebarInterimEl = document.createElement('div');
        tsSidebarInterimEl.className = 'ts-turn ts-' + channel + ' ts-interim-row';
        const chLabel = document.createElement('span');
        chLabel.className = 'ts-channel';
        chLabel.textContent = channel === 'them' ? 'Them' : 'You';
        const txt = document.createElement('span');
        txt.className = 'ts-text ts-interim';
        tsSidebarInterimEl.appendChild(chLabel);
        tsSidebarInterimEl.appendChild(txt);
        list.appendChild(tsSidebarInterimEl);
      }
      tsSidebarInterimEl.querySelector('.ts-text').textContent = text;
    } else {
      // Remove interim row
      if (tsSidebarInterimEl) { tsSidebarInterimEl.remove(); tsSidebarInterimEl = null; }

      const existingRow = tsLastRow[channel];
      const useExisting = existingRow && existingRow.isConnected;

      if (useExisting) {
        // Append to existing row — accumulates sentence fragments
        const txt = existingRow.querySelector('.ts-text');
        if (txt) {
          txt.textContent = txt.textContent ? txt.textContent + ' ' + text : text;
        }
      } else {
        // Start a new row (no buttons — just clean history view)
        const row = document.createElement('div');
        row.className = 'ts-turn ts-' + channel;

        const chLabel = document.createElement('span');
        chLabel.className = 'ts-channel';
        chLabel.textContent = channel === 'them' ? 'Them' : 'You';

        const txt = document.createElement('span');
        txt.className = 'ts-text';
        txt.textContent = text;

        row.appendChild(chLabel);
        row.appendChild(txt);
        list.appendChild(row);
        tsLastRow[channel] = row;
      }

      // Reset silence timer
      clearTimeout(tsRowTimer[channel]);
      tsRowTimer[channel] = setTimeout(() => { tsLastRow[channel] = null; }, TS_SENTENCE_GAP_MS);

      // When THIS channel speaks, reset the OTHER channel's row
      const other = channel === 'you' ? 'them' : 'you';
      clearTimeout(tsRowTimer[other]);
      tsLastRow[other] = null;

      list.scrollTop = list.scrollHeight;
    }
  }

  function clearTranscriptSidebar() {
    const list = document.getElementById('ts-list');
    if (list) list.innerHTML = '<div class="ts-placeholder">Conversation history will appear here when listening.</div>';
    tsSidebarInterimEl = null;
    tsLastRow.you = null; tsLastRow.them = null;
    clearTimeout(tsRowTimer.you); clearTimeout(tsRowTimer.them);
  }

  // ---- events from main --------------------------------------------------
  cue.on('capture:state', ({ active, streaming, mode }) => {
    setLiveDotState(active ? 'idle' : 'off');
    setSessionButton(active);
    // FIX #4: Add .listening class to composer when capture is active
    composer.classList.toggle('listening', active);
    // startSystemAudio() is called directly from the stop-button click handler
    // so that the getDisplayMedia request has a fresh user gesture.
    // Here we only start the mic (no gesture required) and stop everything on deactivate.
    if (active) {
      startMic();
      // Don't auto-open sidebar — user can toggle it manually
    } else {
      stopMic();
      stopSystemAudio();
      // FIX #2: Clear interim element when capture stops
      if (interimEl) {
        interimEl.textContent = '';
        interimEl.classList.remove('show');
      }
      // Don't auto-close sidebar — let user keep it open if they want
    }
    if (active && mode === 'local') setSttState('local');
    else updateSttStatus({ active, streaming });
  });

  // ---- real-time transcript display (interim + final) ----
  let interimEl = null;
  function getOrCreateInterimEl() {
    if (!interimEl) {
      interimEl = document.createElement('div');
      interimEl.className = 'interim-transcript';
      // Insert into panel-main (the left column), before the action row
      const panelMain = document.getElementById('panel-main');
      const actionRow = document.getElementById('action-row');
      if (panelMain && actionRow && actionRow.parentNode === panelMain) {
        panelMain.insertBefore(interimEl, actionRow);
      } else if (panelMain) {
        panelMain.appendChild(interimEl);
      } else {
        document.getElementById('panel').appendChild(interimEl);
      }
    }
    return interimEl;
  }
  // FIX #12: Show interim text in input box (grayed/italic) before final arrives
  let inputInterimEl = null;
  function showInterimInInput(text) {
    if (!inputInterimEl) {
      inputInterimEl = document.createElement('span');
      inputInterimEl.className = 'input-interim';
      // FIX #2: Insert into composer (not input-area) for correct positioning
      composer.appendChild(inputInterimEl);
    }
    inputInterimEl.textContent = text;
    inputInterimEl.style.display = text ? 'block' : 'none';
  }
  function clearInputInterim() {
    if (inputInterimEl) {
      inputInterimEl.textContent = '';
      inputInterimEl.style.display = 'none';
    }
  }
  
  cue.on('stt:interim', ({ channel, text }) => {
    setLiveDotState('transcribing');
    const el = getOrCreateInterimEl();
    const label = channel === 'them' ? 'Them' : 'You';
    el.textContent = `${label}: ${text}`;
    el.classList.add('show');
    appendTranscriptHistoryTurn(channel, text, true); // update sidebar interim
    
    // FIX #12: Show interviewer's interim speech in input area
    if (channel === 'them' && !input.value.trim()) {
      showInterimInInput(text);
    }
  });
  cue.on('stt:final', ({ channel, text }) => {
    setLiveDotState('idle');
    // Clear interim when we get a final
    if (interimEl) { interimEl.textContent = ''; interimEl.classList.remove('show'); }
    clearTranscriptInterim();
    clearInputInterim(); // FIX #12: Clear interim text from input area
    // sidebar: the final turn is added via the 'transcript' event below
  });
  cue.on('stt:status', ({ channel, status, provider }) => {
    cue.log(`[stt] ${provider || channel || 'unknown'} ${status}`);
    if (provider === 'local') {
      const localStates = {
        loading: 'loading',
        ready: 'local',
        transcribing: 'local',
        stopping: 'stopping',
        off: 'disconnected',
        error: 'error'
      };
      if (localStates[status]) setSttState(localStates[status]);
      if (status === 'loading') setSessionButton(true);
      if (status === 'off' || status === 'error') setSessionButton(false);
      if (status === 'loading' || status === 'transcribing' || status === 'stopping') setLiveDotState('transcribing');
      if (status === 'ready') setLiveDotState('idle');
      if (status === 'off') setLiveDotState('off');
      return;
    }
    if (status === 'connected') setSttState('streaming');
  });
  cue.on('vad:state', ({ channel, speaking }) => {
    setLiveDotState(speaking ? 'speaking' : 'idle');
  });
  cue.on('slides:update', ({ count, last }) => {
    if (!count) return;
    const title = last && last.caption ? last.caption.split('\n')[0].slice(0, 80) : 'Slide ' + count;
    showToast(`Slide ${count} captured · ${title}`, 3000);
  });
  cue.on('llm:start', ({ userBubble, small, category }) => {
    responseCount++;
    if (responseCount > MAX_RESPONSES) {
      const oldest = messages.querySelector('.response-group');
      if (oldest) oldest.remove();
      responseCount = MAX_RESPONSES;
    }
    const group = document.createElement('div');
    group.className = 'response-group';
    const sep = document.createElement('div');
    sep.className = 'response-sep';
    sep.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    group.appendChild(sep);
    if (userBubble) {
      const b = document.createElement('div');
      b.className = 'user-bubble';
      b.textContent = userBubble;
      group.appendChild(b);
    }
    if (category) {
      const pill = document.createElement('div');
      pill.className = 'category-pill';
      pill.textContent = category.charAt(0).toUpperCase() + category.slice(1);
      group.appendChild(pill);
    }
    aiEl = document.createElement('div');
    aiEl.className = 'ai-text' + (small ? ' small' : '');
    aiEl.dataset.raw = '';
    caretEl = document.createElement('span');
    caretEl.className = 'ai-caret';
    aiEl.appendChild(caretEl);
    group.appendChild(aiEl);
    messages.appendChild(group);
    followAnswer = true; // the tokens keep the end of this answer in view
    // Scroll #messages directly rather than calling sep.scrollIntoView(): that
    // scrolls *every* scrollable ancestor, and once the panel is tall enough it
    // scrolls the document too, aligning the separator to the top of the window
    // and pushing #toolbar out of view. html/body are overflow:hidden, so there
    // is no scrollbar or wheel gesture to undo it — the Stop/Hide/Quit controls
    // just never come back. The new answer starts at the end of the area (its
    // separator is at the top whenever the area has room), in one step: the
    // steps of a smooth scroll would read as the person scrolling away.
    scrollMessagesToEnd();
    setBusy(true);
  });
  function showToolStatus(detail) {
    const pick = typeof $ === 'function' ? $ : (s) => (document.getElementById ? document.getElementById(s.slice(1)) : null);
    const bar = pick('#tool-status-bar');
    const txt = pick('#tool-status-text');
    if (!bar || !txt) return;
    txt.textContent = `Checking ${detail || 'repository'}...`;
    bar.classList.remove('hidden');
  }
  function clearToolStatus() {
    const pick = typeof $ === 'function' ? $ : (s) => (document.getElementById ? document.getElementById(s.slice(1)) : null);
    const bar = pick('#tool-status-bar');
    if (bar) bar.classList.add('hidden');
  }

  cue.on('llm:thinking', () => {
    showThinking();
    onAnswerActivity(); // a long think is not a lost answer: keep the failsafe away
  });
  cue.on('llm:token', ({ text }) => {
    clearToolStatus();
    appendToken(text);
    onAnswerActivity(); // nor is a long answer that is still streaming
  });
  cue.on('llm:done', () => { clearToolStatus(); finalizeAi(); setBusy(false); });
  cue.on('llm:error', ({ message }) => {
    clearToolStatus();
    if (!aiEl) startAi(true);
    aiEl.dataset.raw = message; finalizeAi(); setBusy(false);
  });
  cue.on('llm:tool', ({ detail }) => {
    showToolStatus(detail);
    onAnswerActivity();
  });
  cue.on('transcript', ({ channel, text }) => {
    if (!text || text.trim().length < 2 || /^[?!.,;:\-…]+$/.test(text.trim())) return;
    appendTranscriptHistoryTurn(channel, text, false);
    // Auto-fill the input box with Them (interviewer) speech
    if (channel === 'them') {
      cancelSoftClear(); // Interviewer is speaking, cancel any pending clear
      autoFillInputFromSTT(text);
    } else {
      // User spoke — soft clear (don't immediately wipe, wait to see if they're really answering)
      softClearSTTFill();
    }
  });
  // Transcript of a meeting resumed at launch: sidebar rows only — no
  // auto-fill of the input box, which is for live speech.
  cue.on('transcript:restore', ({ turns }) => {
    const tsListEl = document.getElementById('ts-list');
    if (tsListEl) {
      tsListEl.innerHTML = '<div class="ts-placeholder">Conversation history will appear here when listening.</div>';
    }
    for (const t of turns || []) {
      if (!t || !t.text || t.text.trim().length < 2) continue;
      appendTranscriptHistoryTurn(t.channel, t.text, false);
    }
  });
  let statusTimer = null;
  function showStatus(message, button) {
    let el = document.getElementById('cue-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cue-status';
      // Insert into panel-main before the action row
      const panelMain = document.getElementById('panel-main');
      const actionRow = document.getElementById('action-row');
      if (panelMain && actionRow && actionRow.parentNode === panelMain) {
        panelMain.insertBefore(el, actionRow);
      } else if (panelMain) {
        panelMain.appendChild(el);
      } else {
        document.getElementById('panel').appendChild(el);
      }
    }
    el.textContent = message;
    const buttons = (Array.isArray(button) ? button : [button]).filter(Boolean);
    buttons.forEach((b) => el.appendChild(b));
    el.dataset.actions = buttons.map((b) => b.dataset.kind || '').join(' ');
    el.classList.add('show');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => el.classList.remove('show'), buttons.length ? 30000 : 11000);
  }
  cue.on('status', ({ message }) => {
    cue.log('[status] ' + message);
    showStatus(message);
    if (sttState !== 'disconnected') {
      const lower = message.toLowerCase();
      if (lower.includes('error') || lower.includes(' off')) setSttState('error');
    }
  });

  // ---- prep status & smart tooltip helpers -------------------------------


  // ---- AI rules: live char counter + soft cap ---------------------------
  function updateAiRulesCounter() {
    const el = document.getElementById('ai-rules');
    const counter = document.getElementById('ai-rules-count');
    if (!el || !counter) return;
    const n = el.value.length;
    const cap = 2000;
    counter.textContent = String(n);
    counter.classList.toggle('over', n >= cap);
    counter.parentElement.classList.toggle('s-counter-warn', n >= cap - 100);
  }
  const aiRulesEl = document.getElementById('ai-rules');
  if (aiRulesEl) aiRulesEl.addEventListener('input', updateAiRulesCounter);
  function updateSmartTooltip() {
    if (!settings) return;
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    const fast = (m.fast || '').trim();
    const smart = (m.smart || '').trim();
    const btn = document.getElementById('smart-toggle');
    if (!btn) return;
    const same = fast.toLowerCase() === smart.toLowerCase();
    btn.classList.toggle('hidden', same);
    if (same) return;
    btn.title = 'Fast: ' + (fast || 'fast model') + ' · Smart: ' + (smart || 'smart model') + ' (higher quality, ~2× slower)';
  }

  // ---- microphone permission banner --------------------------------------
  function showMicPermissionBanner() {
    let banner = document.getElementById('mic-perm-banner');
    if (banner) { banner.classList.add('show'); return; }
    banner = document.createElement('div');
    banner.id = 'mic-perm-banner';
    banner.className = 'show';
    banner.innerHTML =
      '<div class="mic-perm-text">' +
        '<strong>🎙️ Microphone access required</strong><br>' +
        'cue needs microphone permission to hear you during calls. Grant access in System Settings, then restart cue.' +
      '</div>' +
      '<div class="mic-perm-actions"></div>';
    const actions = banner.querySelector('.mic-perm-actions');
    if (cue.platform === 'darwin') {
      const openBtn = document.createElement('button');
      openBtn.textContent = 'Open Microphone Settings';
      openBtn.addEventListener('click', () => cue.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'));
      actions.appendChild(openBtn);
    }
    const dismissBtn = document.createElement('button');
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.className = 'dismiss';
    dismissBtn.addEventListener('click', () => banner.classList.remove('show'));
    actions.appendChild(dismissBtn);
    const panel = document.getElementById('panel');
    panel.insertBefore(banner, document.getElementById('action-row'));
  }

  // ---- settings ----------------------------------------------------------
  const scrim = $('#settings-scrim');
  function showSettingsTab(name) {
    document.querySelectorAll('.s-tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === name));
    document.querySelectorAll('.s-tab-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== name));
  }
  function openSettings() {
    fillSettings();
    showSettingsTab('keys');
    const byo = $('#byo-section');
    if (byo) byo.open = true;
    scrim.classList.remove('hidden');
    refreshWhisperModels();
    void refreshProfileAndWorkspaceState();
  }
  // Only hide after a successful save. A second closeSettings used to shadow
  // this one and always dismiss the modal, so validation errors (and any
  // settings:set throw) vanished with the panel — keys, models, and résumé
  // looked saved and then came back empty on the next launch.
  let closingSettings = false;
  async function closeSettings() {
    if (closingSettings) return;
    closingSettings = true;
    try {
      if (await saveSettings()) scrim.classList.add('hidden');
    } finally {
      closingSettings = false;
    }
  }
  $('#more-btn').addEventListener('click', openSettings);
  $('#tb-settings-btn').addEventListener('click', openSettings);
  $('#s-close').addEventListener('click', () => { void closeSettings(); });
  scrim.addEventListener('click', (e) => { if (e.target === scrim) void closeSettings(); });

  // Tab switching
  document.querySelectorAll('.s-tab').forEach((tab) => {
    tab.addEventListener('click', async () => {
      if (tab.classList.contains('on')) return;
      if (!(await saveSettings())) return;
      document.querySelectorAll('.s-tab').forEach(t => t.classList.remove('on'));
      document.querySelectorAll('.s-tab-pane').forEach(p => p.classList.add('hidden'));
      tab.classList.add('on');
      const pane = document.querySelector(`.s-tab-pane[data-pane="${tab.dataset.tab}"]`);
      if (pane) pane.classList.remove('hidden');
    });
  });

  const PROVIDER_NAMES = {
    cerebras: 'Cerebras',
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    gemini: 'Gemini',
    deepgram: 'Deepgram',
    custom: 'Custom',
    ollama: 'Ollama',
    groq: 'Groq',
    minimax: 'MiniMax',
    deepseek: 'DeepSeek',
    azure: 'Azure AI Foundry'
  };

  function updateCustomProviderFields() {
    const provider = settings.provider;
    document.querySelectorAll('[data-key-for]').forEach((el) => {
      el.classList.toggle('hidden', el.dataset.keyFor !== provider);
    });
    $('#custom-endpoint-settings').classList.toggle('hidden', provider !== 'custom');
    const minimaxRegionSettings = $('#minimax-region-settings');
    if (minimaxRegionSettings) minimaxRegionSettings.classList.toggle('hidden', provider !== 'minimax');
    const azureEndpointSettings = $('#azure-endpoint-settings');
    if (azureEndpointSettings) azureEndpointSettings.classList.toggle('hidden', provider !== 'azure');
    const current = $('#byo-current');
    if (current) {
      current.textContent = provider ? `· using ${PROVIDER_NAMES[provider] || provider} now` : '';
    }
  }

  // Keys as they were when Settings opened: saveSettings only follows a key
  // the person typed in this visit (see there).
  let keysAtOpen = {};
  function fillSettings() {
    keysAtOpen = { ...(settings.apiKeys || {}) };
    // Keys tab
    document.querySelectorAll('#provider-seg button').forEach((b) => b.classList.toggle('on', b.dataset.provider === settings.provider));
    $('#key-cerebras').value = settings.apiKeys.cerebras || '';
    $('#key-openai').value = settings.apiKeys.openai || '';
    $('#key-anthropic').value = settings.apiKeys.anthropic || '';
    $('#key-groq').value = settings.apiKeys.groq || '';
    $('#key-custom').value = settings.apiKeys.custom || '';
    $('#base-url').value = settings.baseUrl || '';
    updateCustomProviderFields();
    $('#key-gemini').value = settings.apiKeys.gemini || '';
    $('#key-deepgram').value = settings.apiKeys.deepgram || '';
    $('#key-ollama').value = settings.apiKeys.ollama || '';
    $('#key-minimax').value = settings.apiKeys.minimax || '';
    $('#key-deepseek').value = settings.apiKeys.deepseek || '';
    document.querySelectorAll('#minimax-region-seg button').forEach((b) => b.classList.toggle('on', b.dataset.region === (settings.minimaxRegion || 'global_en')));
    $('#key-azure').value = settings.apiKeys.azure || '';
    $('#azure-endpoint').value = settings.azureEndpoint || '';
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    $('#model-fast').value = m.fast; $('#model-smart').value = m.smart;
    $('#s-status').textContent = statusText();
    // Transcription tab
    document.querySelectorAll('#meeting-audio-seg button').forEach((button) => {
      button.classList.toggle('on', (button.dataset.meetingAudio === 'on') === !!settings.meetingAudio);
    });
    const meetingAudioNote = $('#meeting-audio-note');
    if (meetingAudioNote) {
      meetingAudioNote.textContent = isMac
        ? 'macOS can only capture system audio through a screen-capture session. While this is on, the menu bar shows the screen-recording indicator and Control Center lists cue under \u201cCurrently Sharing\u201d \u2014 visible to everyone you screen-share with. Off by default; your microphone, screen capture and answers are unaffected.'
        : 'Transcribes the other participants alongside your microphone. This platform\u2019s loopback capture shows no recording indicator.';
    }
    document.querySelectorAll('#stt-provider-seg button').forEach((button) => {
      button.classList.toggle('on', button.dataset.sttProvider === (settings.sttProvider || 'auto'));
    });
    const localWhisper = settings.localWhisper || { modelId: 'base.en', language: 'auto', threads: 0 };
    $('#whisper-language').value = localWhisper.language || 'auto';
    $('#whisper-threads').value = Number(localWhisper.threads) || 0;
    // Slides tab (inside Transcription pane)
    const slidesCfg = settings.slides || { enabled: false, intervalMs: 3000 };
    const slidesEnabled = $('#slides-enabled');
    if (slidesEnabled) slidesEnabled.checked = !!slidesCfg.enabled;
    const slidesInterval = $('#slides-interval');
    if (slidesInterval) slidesInterval.value = slidesCfg.intervalMs || 3000;
    // Style tab
    $('#ai-rules').value = settings.aiRules || '';
    updateAiRulesCounter();
    // Appearance tab
    applyOpacity(settings.opacity, false);
  }

  function statusText() {
    const k = settings.apiKeys;
    const selectedSttProvider = settings.sttProvider || 'auto';
    const automaticStt = k.openai ? 'OpenAI Realtime' : (k.groq ? 'Groq Whisper' : (k.gemini ? 'Gemini' : 'none'));
    const stt = selectedSttProvider === 'auto' ? automaticStt : selectedSttProvider;
    return `${PROVIDER_NAMES[settings.provider] || settings.provider} · STT: ${stt}`;
  }

  document.querySelectorAll('#provider-seg button').forEach((b) => b.addEventListener('click', () => {
    settings.provider = b.dataset.provider;
    document.querySelectorAll('#provider-seg button').forEach((x) => x.classList.toggle('on', x === b));
    updateCustomProviderFields();
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    $('#model-fast').value = m.fast; $('#model-smart').value = m.smart;
    $('#s-status').textContent = statusText();
    updateSmartTooltip();
  }));
  document.querySelectorAll('#minimax-region-seg button').forEach((b) => b.addEventListener('click', () => {
    settings.minimaxRegion = b.dataset.region;
    document.querySelectorAll('#minimax-region-seg button').forEach((x) => x.classList.toggle('on', x === b));
  }));
  document.querySelectorAll('#meeting-audio-seg button').forEach((button) => button.addEventListener('click', () => {
    settings.meetingAudio = button.dataset.meetingAudio === 'on';
    document.querySelectorAll('#meeting-audio-seg button').forEach((candidate) => {
      candidate.classList.toggle('on', candidate === button);
    });
  }));

  document.querySelectorAll('#stt-provider-seg button').forEach((button) => button.addEventListener('click', () => {
    settings.sttProvider = button.dataset.sttProvider;
    document.querySelectorAll('#stt-provider-seg button').forEach((candidate) => {
      candidate.classList.toggle('on', candidate === button);
    });
    $('#s-status').textContent = statusText();
  }));

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
    const units = ['B', 'KB', 'MB', 'GB'];
    const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / (1024 ** unitIndex);
    return `${value >= 10 || unitIndex < 2 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
  }

  function getSelectedWhisperModel() {
    if (!whisperOverview) return null;
    return whisperOverview.models.find((model) => model.id === $('#whisper-model').value) || null;
  }

  function renderWhisperModelState() {
    const model = getSelectedWhisperModel();
    if (!model) return;
    const language = model.englishOnly ? 'English only' : 'Multilingual';
    const recommendation = model.recommended ? ' · recommended default' : '';
    const partial = model.partialBytes > 0 && !model.installed
      ? ` · ${formatBytes(model.partialBytes)} ready to resume`
      : '';
    $('#whisper-model-detail').textContent = `${formatBytes(model.bytes)} · ${language} · ${model.quantization} · ${model.hardwareTier}${recommendation}${partial}`;

    const progressWrap = $('#whisper-progress-wrap');
    const progressPercent = model.bytes > 0 ? Math.floor((model.partialBytes / model.bytes) * 100) : 0;
    progressWrap.classList.toggle('hidden', !model.downloading);
    $('#whisper-progress').value = progressPercent;
    $('#whisper-progress-label').textContent = `${progressPercent}%`;
    $('#whisper-download').disabled = model.installed || model.downloading;
    $('#whisper-download').textContent = model.installed ? 'Installed' : (model.partialBytes ? 'Resume' : 'Download');
    $('#whisper-cancel').classList.toggle('hidden', !model.downloading);
    $('#whisper-import').disabled = model.downloading;
    $('#whisper-delete').disabled = (model.installedBytes === 0 && model.partialBytes === 0) || model.downloading;
  }

  async function refreshWhisperModels() {
    const status = $('#whisper-status');
    try {
      const previousSelection = $('#whisper-model').value || settings.localWhisper?.modelId || 'base.en';
      whisperOverview = await cue.whisperModels();
      const runtimeBadge = $('#whisper-runtime-status');
      runtimeBadge.classList.toggle('ready', whisperOverview.runtime.available);
      runtimeBadge.classList.toggle('error', !whisperOverview.runtime.available);
      runtimeBadge.textContent = whisperOverview.runtime.available
        ? `Ready · v${whisperOverview.runtime.version} · ${whisperOverview.runtime.target}`
        : 'Not prepared';
      runtimeBadge.title = whisperOverview.runtime.message || '';

      const select = $('#whisper-model');
      select.innerHTML = '';
      for (const model of whisperOverview.models) {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = `${model.label} — ${formatBytes(model.bytes)}${model.recommended ? ' (recommended)' : ''}${model.installed ? ' ✓' : ''}`;
        select.appendChild(option);
      }
      const selectionExists = whisperOverview.models.some((model) => model.id === previousSelection);
      select.value = selectionExists ? previousSelection : 'base.en';
      if (!settings.localWhisper) settings.localWhisper = {};
      settings.localWhisper.modelId = select.value;
      status.textContent = whisperOverview.runtime.available
        ? 'Model files are verified before they can be loaded.'
        : whisperOverview.runtime.message;
      renderWhisperModelState();
    } catch (error) {
      status.textContent = `Could not load local model information: ${error.message}`;
    }
  }

  $('#whisper-model').addEventListener('change', () => {
    if (!settings.localWhisper) settings.localWhisper = {};
    settings.localWhisper.modelId = $('#whisper-model').value;
    renderWhisperModelState();
  });

  $('#whisper-download').addEventListener('click', async () => {
    const model = getSelectedWhisperModel();
    if (!model) return;
    model.downloading = true;
    renderWhisperModelState();
    $('#whisper-status').textContent = `Downloading ${model.id}. You can cancel and resume later.`;
    try {
      await cue.whisperModelDownload(model.id);
      $('#whisper-status').textContent = `${model.id} downloaded and verified.`;
    } catch (error) {
      $('#whisper-status').textContent = error.message.includes('cancelled')
        ? `${model.id} download paused. Progress was kept.`
        : `Download failed: ${error.message}`;
    } finally {
      await refreshWhisperModels();
    }
  });

  $('#whisper-cancel').addEventListener('click', async () => {
    const model = getSelectedWhisperModel();
    if (model) await cue.whisperModelCancel(model.id);
  });

  $('#whisper-import').addEventListener('click', async () => {
    const model = getSelectedWhisperModel();
    if (!model) return;
    $('#whisper-status').textContent = `Verifying imported ${model.id}…`;
    try {
      const result = await cue.whisperModelImport(model.id);
      $('#whisper-status').textContent = result.cancelled ? 'Import cancelled.' : `${model.id} imported and verified.`;
    } catch (error) {
      $('#whisper-status').textContent = `Import failed: ${error.message}`;
    } finally {
      await refreshWhisperModels();
    }
  });

  $('#whisper-delete').addEventListener('click', async () => {
    const model = getSelectedWhisperModel();
    if (!model || !window.confirm(`Delete the ${model.id} model (${formatBytes(model.bytes)}) from this computer?`)) return;
    try {
      await cue.whisperModelDelete(model.id);
      $('#whisper-status').textContent = `${model.id} deleted.`;
    } catch (error) {
      $('#whisper-status').textContent = `Delete failed: ${error.message}`;
    } finally {
      await refreshWhisperModels();
    }
  });

  cue.on('whisper:download-progress', (progress) => {
    if (!whisperOverview) return;
    const model = whisperOverview.models.find((candidate) => candidate.id === progress.modelId);
    if (!model) return;
    model.partialBytes = progress.receivedBytes;
    model.downloading = true;
    if ($('#whisper-model').value === progress.modelId) {
      $('#whisper-progress-wrap').classList.remove('hidden');
      $('#whisper-progress').value = progress.percent;
      $('#whisper-progress-label').textContent = `${progress.percent}%`;
      $('#whisper-model-detail').textContent = `${formatBytes(progress.receivedBytes)} of ${formatBytes(progress.totalBytes)}`;
    }
  });
  cue.on('whisper:models-changed', () => refreshWhisperModels());

  async function saveSettings() {
    // Keys
    settings.apiKeys.cerebras = $('#key-cerebras').value.trim();
    settings.apiKeys.openai = $('#key-openai').value.trim();
    settings.apiKeys.anthropic = $('#key-anthropic').value.trim();
    settings.apiKeys.groq = $('#key-groq').value.trim();
    settings.apiKeys.custom = $('#key-custom').value.trim();
    settings.baseUrl = $('#base-url').value.trim();
    settings.apiKeys.gemini = $('#key-gemini').value.trim();
    settings.apiKeys.deepgram = $('#key-deepgram').value.trim();
    settings.apiKeys.ollama = $('#key-ollama').value.trim();
    settings.apiKeys.minimax = $('#key-minimax').value.trim();
    settings.apiKeys.deepseek = $('#key-deepseek').value.trim();
    settings.apiKeys.azure = $('#key-azure').value.trim();
    settings.azureEndpoint = $('#azure-endpoint').value.trim();
    if (!settings.models[settings.provider]) settings.models[settings.provider] = {};
    settings.models[settings.provider].fast = $('#model-fast').value.trim();
    settings.models[settings.provider].smart = $('#model-smart').value.trim();
    // If the active provider still has no key, but the user just filled in a
    // key for a different provider (without touching the Provider selector —
    // the flow both bug reports describe), switch to that provider. Without
    // this, `settings.provider` stays on its default ('openai') forever and
    // cue keeps reporting itself unconfigured even though a valid key was
    // saved for the provider the user actually meant to use.
    if (!settings.apiKeys[settings.provider]) {
      const keyedProviders = ['cerebras', 'openai', 'anthropic', 'gemini', 'groq', 'minimax', 'deepseek', 'azure'];
      const justFilled = keyedProviders.find((p) => settings.apiKeys[p] && settings.apiKeys[p] !== (keysAtOpen[p] || ''));
      if (justFilled) settings.provider = justFilled;
    }
    // Transcription
    if (!settings.localWhisper) settings.localWhisper = {};
    settings.localWhisper.modelId = $('#whisper-model').value || settings.localWhisper.modelId || 'base.en';
    settings.localWhisper.language = $('#whisper-language').value || 'auto';
    settings.localWhisper.threads = Math.max(0, Math.min(64, Number.parseInt($('#whisper-threads').value, 10) || 0));
    // Slides (opt-in, memory-only)
    if (!settings.slides) settings.slides = {};
    const slidesEnabledEl = $('#slides-enabled');
    const slidesIntervalEl = $('#slides-interval');
    if (slidesEnabledEl) settings.slides.enabled = !!slidesEnabledEl.checked;
    if (slidesIntervalEl) {
      const v = Number.parseInt(slidesIntervalEl.value, 10) || 3000;
      settings.slides.intervalMs = Math.max(1500, Math.min(15000, v));
    }
    // Style tab
    settings.aiRules = $('#ai-rules').value.trim();
    // Appearance tab
    const opacitySlider = $('#s-opacity-slider');
    if (opacitySlider) settings.opacity = clampOpacity(Number(opacitySlider.value) / 100);
    try {
      settings = await cue.settingsSet(settings);
      keysAtOpen = { ...(settings.apiKeys || {}) };
      $('#s-status').textContent = statusText();
      updateSmartTooltip();
      return true;
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      $('#s-status').textContent = message;
      $('#base-url').focus();
      return false;
    }
  }

  // ---- example conversation (matches the reference screenshot) ------------
  function showExample() {
    clearMessages();
    addUserBubble('What should I say?');
    const ai = document.createElement('div');
    ai.className = 'ai-text';
    ai.textContent = '“A discounted cash flow model values a company by projecting future free cash flows and discounting them to present value using the weighted average cost of capital.”';
    messages.appendChild(ai);
    // Marked so the sign-in prompt can take its place (renderSetupCta).
    messages.querySelectorAll('.user-bubble, .ai-text').forEach((el) => el.classList.add('is-example'));
  }

  // ---- global keys -------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !scrim.classList.contains('hidden')) void closeSettings();
    if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); openSettings(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !scrim.classList.contains('hidden')) return;
    const briefScrim = $('#prep-brief-scrim');
    if (briefScrim && !briefScrim.classList.contains('hidden')) { briefScrim.classList.add('hidden'); return; }
    const dissScrim = $('#dissection-scrim');
    if (dissScrim && !dissScrim.classList.contains('hidden')) { dissScrim.classList.add('hidden'); return; }
    if (busy && cue.llmCancel) { cue.llmCancel(); clearToolStatus(); setBusy(false); }
  });

  // Safety net for the same class of bug: html/body are overflow:hidden, so any
  // stray programmatic scroll of the document is invisible to the user and
  // unrecoverable by mouse. Snap it back so the toolbar cannot be stranded.
  window.addEventListener('scroll', () => {
    if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
  }, { passive: true });

  // ---- click-through: only the UI blocks the mouse; empty gaps pass to your screen ----
  let ignoring = null;
  let draggingWindow = false;
  function setIgnore(v) { if (v !== ignoring) { ignoring = v; cue.setIgnoreMouse(v); } }
  document.addEventListener('mousemove', (e) => {
    // The window trails the cursor while dragging; going click-through then would drop the release.
    if (draggingWindow) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const overUI = !!(el && el.closest && el.closest('#toolbar, #panel-wrap, #transcript-sidebar, #settings-scrim, #onboard-scrim, #prep-brief-scrim, #dissection-scrim'));
    setIgnore(!overUI);
  });
  setIgnore(true); // start fully click-through; hovering the panel re-enables it

  // ---- window drag: press anywhere on the toolbar that isn't a control ----
  const toolbar = $('#toolbar');
  toolbar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button, input, .tb-opacity-wrap')) return;
    e.preventDefault();
    toolbar.setPointerCapture(e.pointerId);
    draggingWindow = true;
    setIgnore(false);
    toolbar.classList.add('dragging');
    cue.windowDragStart();
  });
  // Fires on release, cancel, or anything else that ends the press.
  toolbar.addEventListener('lostpointercapture', () => {
    if (!draggingWindow) return;
    draggingWindow = false;
    toolbar.classList.remove('dragging');
    cue.windowDragEnd();
  });

  // ---- onboarding / first-run tutorial -----------------------------------
  const obScrim = $('#onboard-scrim');
  const permissionHelp = isWindows
    ? 'cue needs permission to see and hear. Open Windows Privacy & security settings, allow <strong>Microphone</strong> and <strong>Screen recording</strong> for cue, then come back here.'
    : 'cue needs two macOS permissions. Click each button, turn <strong>cue</strong> ON in the window that opens, then come back here.';
  const permissionButtons = isWindows
    ? [
        { label: 'Open Microphone settings', action: () => cue.openPane('ms-settings:privacy-microphone') },
        { label: 'Open Screen recording settings', action: () => cue.openPane('ms-settings:privacy-screenrecorder') }
      ]
    : [
        { label: 'Open Microphone settings', action: () => cue.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone') },
        { label: 'Open Screen Recording settings', action: () => cue.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture') }
      ];
  const assistShortcut = isWindows ? '<span class="kbd">Ctrl</span><span class="kbd">⇧</span><span class="kbd">↵</span>' : '<span class="kbd">⌘</span><span class="kbd">⇧</span><span class="kbd">↵</span>';
  const sayShortcut = isWindows ? '<span class="kbd">Ctrl</span> <span class="kbd">↵</span>' : '<span class="kbd">⌘</span> <span class="kbd">↵</span>';
  const quitShortcut = isWindows ? '<span class="kbd">Ctrl</span><span class="kbd">⇧</span><span class="kbd">X</span>' : '<span class="kbd">⌘</span><span class="kbd">⇧</span><span class="kbd">X</span>';
  const OB_STEPS = [
    {
      icon: '👋',
      title: 'Welcome to cue',
      body: 'cue is a private AI copilot that floats over your screen. It can see your screen, hear your meetings, and help you answer questions – while staying hidden from screen shares.',
      welcome: true
    },
    {
      icon: '🔐',
      title: 'Allow cue to see & hear',
      body: permissionHelp + '<ul><li><strong>Microphone</strong> – to hear you</li><li><strong>Screen recording</strong> – to see your screen and hear your meeting</li></ul>' +
        `<span class="ob-fine">You can also do this later in ${isWindows ? 'Windows Settings' : 'System Settings'}.</span>`,
      buttons: permissionButtons,
      permissions: true
    },
    {
      icon: '⚙️',
      connectModel: true,
      title: 'Connect an AI model',
      body: 'cue needs an AI model to answer. Add an API key for any provider in Settings.',
      buttons: [{ label: 'Open Settings', action: () => { finishOnboard(); openSettings(); } }]
    },
    {
      icon: '✨',
      title: 'You’re all set',
      body: 'How to use cue:<ul><li>' + sayShortcut + ' — <strong>What should I say?</strong> from the conversation</li><li>' + assistShortcut + ' — <strong>Smart assist</strong> with whatever\'s on screen or being said</li><li>Click <strong>Start session</strong> in the top bar to start listening to a meeting</li><li>Type a question and press <span class="kbd">↵</span></li></ul>Reopen this guide anytime by clicking the <strong>help</strong> icon in the top bar. Quit with ' + quitShortcut + '.'
    }
  ];
  let obIndex = 0;
  function renderOnboard() {
    const step = OB_STEPS[obIndex];
    const val = (x) => (typeof x === 'function' ? x() : x);
    $('#ob-icon').textContent = val(step.icon);
    $('#ob-title').textContent = val(step.title);
    $('#ob-body').innerHTML = val(step.body);
    $('#ob-error').innerHTML = '';
    $('#ob-error').classList.add('hidden');
    $('#ob-after').innerHTML = '';
    $('#ob-after').classList.add('hidden');
    const btns = $('#ob-buttons'); btns.innerHTML = '';
    (step.buttons || []).forEach((b) => { const el = document.createElement('button'); el.textContent = b.label; if (b.primary) el.classList.add('ob-cta'); if (b.link) el.classList.add('ob-link'); el.addEventListener('click', b.action); btns.appendChild(el); });
    const dots = $('#ob-dots'); dots.innerHTML = '';
    OB_STEPS.forEach((_, i) => { const d = document.createElement('span'); if (i === obIndex) d.className = 'on'; dots.appendChild(d); });
    $('#ob-back').style.visibility = obIndex === 0 ? 'hidden' : 'visible';
    $('#ob-next').textContent = obIndex === OB_STEPS.length - 1 ? 'Done' : 'Next';
    $('#ob-skip').style.visibility = obIndex === OB_STEPS.length - 1 ? 'hidden' : 'visible';
  }
  function showOnboard() { obIndex = 0; renderOnboard(); obScrim.classList.remove('hidden'); setIgnore(false); }
  async function finishOnboard() {
    obScrim.classList.add('hidden');
    if (settings && !settings.onboarded) { settings.onboarded = true; await cue.settingsSet({ onboarded: true }); }
  }
  $('#ob-next').addEventListener('click', () => { if (obIndex === OB_STEPS.length - 1) finishOnboard(); else { obIndex++; renderOnboard(); } });
  $('#ob-back').addEventListener('click', () => { if (obIndex > 0) { obIndex--; renderOnboard(); } });
  $('#ob-skip').addEventListener('click', finishOnboard);
  $('#logo-btn').addEventListener('click', showOnboard);

  // ---- profile & workspace settings UI -----------------------------------
  function clearChildren(host) {
    if (!host) return;
    host.textContent = '';
    if (Array.isArray(host.children)) host.children.length = 0;
  }

  function renderProfileSettings() {
    const docsHost = $('#profile-docs-list');
    const reposHost = $('#profile-repos-list');
    const lessonsHost = $('#profile-lessons-list');
    clearChildren(docsHost);
    clearChildren(reposHost);
    clearChildren(lessonsHost);

    const docs = (profileState && profileState.documents) || [];
    if (!docs.length) {
      const empty = document.createElement('div');
      empty.className = 'pue-empty';
      empty.textContent = 'No experience files attached yet.';
      docsHost.appendChild(empty);
    } else {
      for (const d of docs) {
        const row = document.createElement('div');
        row.className = 'pue-item-row';
        const title = document.createElement('span');
        title.className = 'pue-item-title';
        title.textContent = `${d.label} (${d.chunkCount || 0} chunks)`;
        const badge = document.createElement('span');
        badge.className = `pue-badge status-${d.status || 'ok'}`;
        badge.textContent = d.status || 'ok';
        if (d.error) badge.title = d.error;
        const rmBtn = document.createElement('button');
        rmBtn.type = 'button';
        rmBtn.className = 's-action danger compact';
        rmBtn.textContent = 'Remove';
        rmBtn.addEventListener('click', async () => {
          profileState = await cue.profileRemoveItem(d.id);
          renderProfileSettings();
        });
        row.append(title, badge, rmBtn);
        docsHost.appendChild(row);
      }
    }

    const repos = (profileState && profileState.repos) || [];
    if (!repos.length) {
      const empty = document.createElement('div');
      empty.className = 'pue-empty';
      empty.textContent = 'No local code repositories attached yet.';
      reposHost.appendChild(empty);
    } else {
      for (const r of repos) {
        const row = document.createElement('div');
        row.className = 'pue-item-row';
        const title = document.createElement('span');
        title.className = 'pue-item-title';
        title.textContent = `${r.name} (${r.fileCount || 0} files · ${r.chunkCount || 0} chunks)`;
        const badge = document.createElement('span');
        badge.className = `pue-badge status-${r.status || 'ok'}`;
        badge.textContent = r.status || 'ok';
        if (r.error) badge.title = r.error;
        const rmBtn = document.createElement('button');
        rmBtn.type = 'button';
        rmBtn.className = 's-action danger compact';
        rmBtn.textContent = 'Remove';
        rmBtn.addEventListener('click', async () => {
          profileState = await cue.profileRemoveItem(r.id);
          renderProfileSettings();
        });
        row.append(title, badge, rmBtn);
        reposHost.appendChild(row);
      }
    }

    const activeLessons = ((profileState && profileState.promotedLessons) || []).filter((l) => l.status === 'accepted');
    if (!activeLessons.length) {
      const empty = document.createElement('div');
      empty.className = 'pue-empty';
      empty.textContent = 'No promoted global lessons yet.';
      lessonsHost.appendChild(empty);
    } else {
      for (const les of activeLessons) {
        const row = document.createElement('div');
        row.className = 'pue-item-row';
        const title = document.createElement('span');
        title.className = 'pue-item-title';
        title.textContent = les.guidance;
        const depBtn = document.createElement('button');
        depBtn.type = 'button';
        depBtn.className = 's-action compact';
        depBtn.textContent = 'Deprecate';
        depBtn.addEventListener('click', async () => {
          profileState = await cue.profileDeprecateLesson(les.id);
          renderProfileSettings();
        });
        row.append(title, depBtn);
        lessonsHost.appendChild(row);
      }
    }
  }

  function renderWorkspaceSettings() {
    const sel = $('#ws-select');
    const filesHost = $('#ws-files-list');
    if (!sel || !filesHost) return;
    clearChildren(sel);
    clearChildren(filesHost);

    const items = (workspaceState && workspaceState.items) || [];
    for (const item of items) {
      const opt = document.createElement('option');
      opt.value = item.id;
      opt.textContent = `${item.company} · ${item.role}`;
      if (item.id === workspaceState.activeWorkspaceId) opt.selected = true;
      sel.appendChild(opt);
    }

    const active = workspaceState && workspaceState.activeWorkspace;
    if (!active) return;

    const companyEl = $('#ws-company');
    const roleEl = $('#ws-role');
    const notesEl = $('#ws-notes');
    if (companyEl) companyEl.value = active.company || '';
    if (roleEl) roleEl.value = active.role || '';
    if (notesEl) notesEl.value = active.notes || '';

    const files = active.files || [];
    if (!files.length) {
      const empty = document.createElement('div');
      empty.className = 'pue-empty';
      empty.textContent = 'No JD or test files attached to this workspace.';
      filesHost.appendChild(empty);
    } else {
      for (const f of files) {
        const row = document.createElement('div');
        row.className = 'pue-item-row';
        const title = document.createElement('span');
        title.className = 'pue-item-title';
        title.textContent = `[${(f.role || 'jd').toUpperCase()}] ${f.label} (${f.chunkCount || 0} chunks)`;
        const badge = document.createElement('span');
        badge.className = `pue-badge status-${f.status || 'ok'}`;
        badge.textContent = f.isDirectory ? 'folder' : f.status || 'ok';
        const rmBtn = document.createElement('button');
        rmBtn.type = 'button';
        rmBtn.className = 's-action danger compact';
        rmBtn.textContent = 'Remove';
        rmBtn.addEventListener('click', async () => {
          const snap = await cue.workspaceRemoveFile(active.id, f.id);
          applyWorkspaceSnapshot(snap);
        });
        row.append(title, badge, rmBtn);
        filesHost.appendChild(row);
      }
    }
  }

  function renderWorkspaceOverlayBar() {
    const pill = $('#workspace-pill');
    const active = workspaceState && workspaceState.activeWorkspace;
    if (!pill) return;
    if (!active) {
      pill.textContent = 'Default · Round 1';
      return;
    }
    const round = (active.rounds || []).find((r) => r.id === active.activeRoundId) || (active.rounds || [])[0];
    const roundName = round ? round.name : 'Round 1';
    pill.textContent = `${active.company} / ${active.role} · ${roundName}`;

    const wsQuick = $('#ws-quick-select');
    if (wsQuick) {
      clearChildren(wsQuick);
      for (const it of workspaceState.items || []) {
        const opt = document.createElement('option');
        opt.value = it.id;
        opt.textContent = `${it.company} · ${it.role}`;
        if (it.id === workspaceState.activeWorkspaceId) opt.selected = true;
        wsQuick.appendChild(opt);
      }
    }
    const rndQuick = $('#round-quick-select');
    if (rndQuick) {
      clearChildren(rndQuick);
      for (const r of active.rounds || []) {
        const opt = document.createElement('option');
        opt.value = r.id;
        opt.textContent = `${r.name} (${r.status || 'open'})`;
        if (r.id === active.activeRoundId) opt.selected = true;
        rndQuick.appendChild(opt);
      }
    }
  }

  function appendBulletSection(host, heading, items) {
    if (!Array.isArray(items) || !items.length) return;
    const card = document.createElement('div');
    card.className = 'pue-section-card';
    const h = document.createElement('div');
    h.className = 'pue-section-title';
    h.textContent = heading;
    card.appendChild(h);
    for (const item of items) {
      const line = document.createElement('div');
      line.className = 'pue-section-text';
      line.textContent = `• ${item}`;
      card.appendChild(line);
    }
    host.appendChild(card);
  }

  function renderPrepBriefBody(prepBrief) {
    const host = $('#brief-content');
    if (!host) return;
    clearChildren(host);
    if (!prepBrief || (!prepBrief.summary && !(prepBrief.repoMatches && prepBrief.repoMatches.length))) {
      const empty = document.createElement('div');
      empty.className = 'pue-empty';
      empty.textContent = 'No Prep Brief generated yet. Attach JD/test files and click Generate / Refresh Brief.';
      host.appendChild(empty);
      return;
    }

    if (prepBrief.summary) {
      const card = document.createElement('div');
      card.className = 'pue-section-card';
      const h = document.createElement('div');
      h.className = 'pue-section-title';
      h.textContent = 'Role Summary';
      const p = document.createElement('div');
      p.className = 'pue-section-text';
      p.textContent = prepBrief.summary;
      card.append(h, p);
      host.appendChild(card);
    }

    if (Array.isArray(prepBrief.repoMatches) && prepBrief.repoMatches.length) {
      appendBulletSection(
        host,
        'Repository Matches',
        prepBrief.repoMatches.map((m) => `${m.repoName}: ${m.whyRelevant}${m.talkingPoints ? ' (' + m.talkingPoints + ')' : ''}`)
      );
    }
    appendBulletSection(host, 'Test Plan', prepBrief.testPlan || []);
    appendBulletSection(host, 'Likely Questions', prepBrief.likelyQuestions || []);
    appendBulletSection(host, 'Focus From Earlier Rounds', prepBrief.priorRoundFocus || []);
  }

  function renderDissectionBody(dissection, journal) {
    const host = $('#dissection-content');
    const journalHost = $('#journal-lessons-list');
    clearChildren(host);
    clearChildren(journalHost);

    if (!dissection) {
      const empty = document.createElement('div');
      empty.className = 'pue-empty';
      empty.textContent = 'No dissection recorded for this round yet. Click End Round after at least 4 transcript turns.';
      host.appendChild(empty);
    } else {
      if (dissection.roundSummary) {
        const sumCard = document.createElement('div');
        sumCard.className = 'pue-section-card';
        const h = document.createElement('div');
        h.className = 'pue-section-title';
        h.textContent = 'Round Summary';
        const p = document.createElement('div');
        p.className = 'pue-section-text';
        p.textContent = dissection.roundSummary;
        sumCard.append(h, p);
        host.appendChild(sumCard);
      }

      if (Array.isArray(dissection.qaReview) && dissection.qaReview.length) {
        const wrap = document.createElement('div');
        wrap.className = 'pue-section-card';
        const h = document.createElement('div');
        h.className = 'pue-section-title';
        h.textContent = 'Side-by-Side Q&A Review';
        wrap.appendChild(h);

        for (const q of dissection.qaReview) {
          const qc = document.createElement('div');
          qc.className = 'qa-review-card';
          const qLine = document.createElement('div');
          qLine.className = 'pue-section-title';
          qLine.textContent = `Q: ${q.question}`;
          const badge = document.createElement('span');
          badge.className = `qa-verdict v-${q.verdict || 'partial'}`;
          badge.textContent = q.verdict || 'partial';
          qLine.appendChild(badge);
          qc.appendChild(qLine);

          if (q.spokenAnswer) {
            const sp = document.createElement('div');
            sp.className = 'pue-section-text';
            sp.textContent = `You spoke: ${q.spokenAnswer}`;
            qc.appendChild(sp);
          }
          if (q.copilotSuggestion) {
            const cp = document.createElement('div');
            cp.className = 'pue-section-text';
            cp.textContent = `Copilot: ${q.copilotSuggestion}`;
            qc.appendChild(cp);
          }
          if (q.gapWhy) {
            const gw = document.createElement('div');
            gw.className = 'pue-section-text';
            gw.textContent = `Gap: ${q.gapWhy}`;
            qc.appendChild(gw);
          }
          if (Array.isArray(q.citedSources) && q.citedSources.length) {
            const cs = document.createElement('div');
            cs.className = 'pue-empty';
            cs.textContent = `Sources: ${q.citedSources.join(', ')}`;
            qc.appendChild(cs);
          }
          wrap.appendChild(qc);
        }
        host.appendChild(wrap);
      }

      const missedAndSignals = [
        ...(dissection.missedOpportunities || []).map((m) => `Missed: ${m}`),
        ...(dissection.interviewerSignals || []).map((s) => `Signal: ${s}`)
      ];
      appendBulletSection(host, 'Missed Opportunities & Interviewer Signals', missedAndSignals);

      const cp = dissection.nextRoundCheckpoint || {};
      const cpItems = [
        ...(cp.settledTopics || []).map((t) => `Settled: ${t}`),
        ...(cp.openWeaknessesToRepair || []).map((w) => `Repair next: ${w}`),
        ...(cp.promisedFollowUps || []).map((f) => `Follow-up: ${f}`)
      ];
      appendBulletSection(host, 'Next-Round Checkpoint', cpItems);
    }

    const activeWsId = workspaceState && workspaceState.activeWorkspaceId;
    const proposed = ((journal && journal.lessons) || []).filter((l) => l.status === 'proposed');
    if (!proposed.length) {
      const empty = document.createElement('div');
      empty.className = 'pue-empty';
      empty.textContent = 'No pending Failure Journal lessons awaiting approval.';
      journalHost.appendChild(empty);
    } else {
      for (const lesson of proposed) {
        const card = document.createElement('div');
        card.className = 'qa-review-card';
        const txt = document.createElement('div');
        txt.className = 'pue-section-text';
        txt.textContent = `[${lesson.failureType || 'lesson'}] ${lesson.proposedFix}`;

        const acceptBtn = document.createElement('button');
        acceptBtn.type = 'button';
        acceptBtn.className = 's-action compact';
        acceptBtn.textContent = 'Accept for This Job';
        acceptBtn.addEventListener('click', async () => {
          const res = await cue.workspaceDecideLesson(activeWsId, lesson.id, 'accept_workspace');
          renderDissectionBody(dissection, res && res.journal);
          showToast('Lesson added to this workspace');
        });

        const promoteBtn = document.createElement('button');
        promoteBtn.type = 'button';
        promoteBtn.className = 's-action compact';
        promoteBtn.textContent = 'Promote to Global Profile';
        promoteBtn.addEventListener('click', async () => {
          const res = await cue.workspaceDecideLesson(activeWsId, lesson.id, 'promote_global');
          renderDissectionBody(dissection, res && res.journal);
          showToast('Lesson promoted to Global Profile');
        });

        const dismissBtn = document.createElement('button');
        dismissBtn.type = 'button';
        dismissBtn.className = 's-action danger compact';
        dismissBtn.textContent = 'Dismiss';
        dismissBtn.addEventListener('click', async () => {
          const res = await cue.workspaceDecideLesson(activeWsId, lesson.id, 'dismiss');
          renderDissectionBody(dissection, res && res.journal);
        });

        card.append(txt, acceptBtn, promoteBtn, dismissBtn);
        journalHost.appendChild(card);
      }
    }
  }

  let currentDissectionMarkdown = '';
  async function loadAndRenderDissection(roundId) {
    const active = workspaceState && workspaceState.activeWorkspace;
    if (!active) return;
    const sel = $('#dissection-round-select');
    if (sel) {
      clearChildren(sel);
      for (const r of active.rounds || []) {
        const opt = document.createElement('option');
        opt.value = r.id;
        opt.textContent = `${r.name} (${r.status || 'open'})`;
        if (r.id === (roundId || active.activeRoundId)) opt.selected = true;
        sel.appendChild(opt);
      }
    }
    const targetRoundId = roundId || active.activeRoundId;
    const [dissPayload, journal] = await Promise.all([
      cue.workspaceGetDissection(active.id, targetRoundId),
      cue.workspaceListJournal(active.id)
    ]);
    currentDissectionMarkdown = (dissPayload && dissPayload.markdown) || '';
    renderDissectionBody(dissPayload && dissPayload.round ? dissPayload.round.dissection : null, journal);
  }

  const toolCancelBtn = $('#tool-cancel-btn');
  if (toolCancelBtn) {
    toolCancelBtn.addEventListener('click', () => {
      if (cue.llmCancel) cue.llmCancel();
      clearToolStatus();
      setBusy(false);
    });
  }
  const wsPillBtn = $('#workspace-pill');
  const wsPopover = $('#workspace-popover');
  if (wsPillBtn && wsPopover) {
    wsPillBtn.addEventListener('click', () => {
      renderWorkspaceOverlayBar();
      wsPopover.classList.toggle('hidden');
    });
  }
  const wsQuickSel = $('#ws-quick-select');
  if (wsQuickSel) {
    wsQuickSel.addEventListener('change', async () => {
      if (!wsQuickSel.value) return;
      clearMessages();
      const snap = await cue.workspaceSelect(wsQuickSel.value);
      applyWorkspaceSnapshot(snap);
      if (wsPopover) wsPopover.classList.add('hidden');
    });
  }
  const rndQuickSel = $('#round-quick-select');
  if (rndQuickSel) {
    rndQuickSel.addEventListener('change', async () => {
      const active = workspaceState && workspaceState.activeWorkspace;
      if (!active || !rndQuickSel.value) return;
      clearMessages();
      const snap = await cue.workspaceSelectRound(active.id, rndQuickSel.value);
      applyWorkspaceSnapshot(snap);
      if (wsPopover) wsPopover.classList.add('hidden');
    });
  }
  const newRoundBtn = $('#new-round-btn');
  if (newRoundBtn) {
    newRoundBtn.addEventListener('click', async () => {
      const active = workspaceState && workspaceState.activeWorkspace;
      if (!active) return;
      clearMessages();
      const snap = await cue.workspaceCreateRound(active.id);
      applyWorkspaceSnapshot(snap);
      if (wsPopover) wsPopover.classList.add('hidden');
      showToast('Started new round');
    });
  }
  const openBriefBtn = $('#open-brief-btn');
  const prepBriefScrim = $('#prep-brief-scrim');
  if (openBriefBtn && prepBriefScrim) {
    openBriefBtn.addEventListener('click', () => {
      const active = workspaceState && workspaceState.activeWorkspace;
      renderPrepBriefBody(active && active.prepBrief);
      prepBriefScrim.classList.remove('hidden');
      setIgnore(false);
    });
  }
  const briefCloseBtn = $('#brief-close-btn');
  if (briefCloseBtn && prepBriefScrim) {
    briefCloseBtn.addEventListener('click', () => prepBriefScrim.classList.add('hidden'));
    prepBriefScrim.addEventListener('click', (e) => {
      if (e.target === prepBriefScrim) prepBriefScrim.classList.add('hidden');
    });
  }
  const briefGenBtn = $('#brief-generate-btn');
  if (briefGenBtn) {
    briefGenBtn.addEventListener('click', async () => {
      const active = workspaceState && workspaceState.activeWorkspace;
      if (!active) return;
      briefGenBtn.disabled = true;
      briefGenBtn.textContent = 'Generating...';
      try {
        const res = await cue.workspaceGenerateBrief(active.id);
        if (res && res.snapshot) applyWorkspaceSnapshot(res.snapshot);
        renderPrepBriefBody(res && res.brief);
        showToast('Prep Brief updated');
      } catch (err) {
        showStatus((err && err.message) || String(err));
      } finally {
        briefGenBtn.disabled = false;
        briefGenBtn.textContent = 'Generate / Refresh Brief';
      }
    });
  }
  const openDissBtn = $('#open-dissection-btn');
  const dissScrim = $('#dissection-scrim');
  if (openDissBtn && dissScrim) {
    openDissBtn.addEventListener('click', async () => {
      dissScrim.classList.remove('hidden');
      setIgnore(false);
      await loadAndRenderDissection();
    });
  }
  const dissCloseBtn = $('#dissection-close-btn');
  if (dissCloseBtn && dissScrim) {
    dissCloseBtn.addEventListener('click', () => dissScrim.classList.add('hidden'));
    dissScrim.addEventListener('click', (e) => {
      if (e.target === dissScrim) dissScrim.classList.add('hidden');
    });
  }
  const dissRoundSel = $('#dissection-round-select');
  if (dissRoundSel) {
    dissRoundSel.addEventListener('change', () => {
      void loadAndRenderDissection(dissRoundSel.value);
    });
  }
  const dissCopyBtn = $('#dissection-copy-md-btn');
  if (dissCopyBtn) {
    dissCopyBtn.addEventListener('click', async () => {
      if (!currentDissectionMarkdown) {
        showToast('No Markdown report available for this round yet');
        return;
      }
      try {
        await navigator.clipboard.writeText(currentDissectionMarkdown);
        showToast('Copied Markdown report');
      } catch (_) {
        showToast('Could not copy report');
      }
    });
  }
  const dissSearchInput = $('#dissection-search-input');
  if (dissSearchInput) {
    dissSearchInput.addEventListener('input', async () => {
      const active = workspaceState && workspaceState.activeWorkspace;
      const resHost = $('#dissection-search-results');
      if (!active || !resHost) return;
      const q = dissSearchInput.value.trim();
      clearChildren(resHost);
      if (!q) {
        resHost.classList.add('hidden');
        return;
      }
      const hits = (await cue.workspaceSearchRounds(active.id, q)) || [];
      resHost.classList.remove('hidden');
      if (!hits.length) {
        const empty = document.createElement('div');
        empty.className = 'pue-empty';
        empty.textContent = 'No matching rounds in this workspace.';
        resHost.appendChild(empty);
        return;
      }
      for (const h of hits) {
        const row = document.createElement('div');
        row.className = 'pue-item-row';
        const title = document.createElement('span');
        title.className = 'pue-item-title';
        title.textContent = `${h.name}: ${h.sample || ''}`;
        const viewBtn = document.createElement('button');
        viewBtn.type = 'button';
        viewBtn.className = 's-action compact';
        viewBtn.textContent = 'Open';
        viewBtn.addEventListener('click', () => {
          void loadAndRenderDissection(h.roundId);
        });
        row.append(title, viewBtn);
        resHost.appendChild(row);
      }
    });
  }
  const endRoundBtn = $('#end-round-btn');
  if (endRoundBtn) {
    endRoundBtn.addEventListener('click', async () => {
      const active = workspaceState && workspaceState.activeWorkspace;
      if (!active) return;
      endRoundBtn.disabled = true;
      endRoundBtn.textContent = 'Dissecting...';
      try {
        const res = await cue.workspaceEndRound(active.id, active.activeRoundId);
        if (res && res.snapshot) applyWorkspaceSnapshot(res.snapshot);
        if (dissScrim) {
          dissScrim.classList.remove('hidden');
          setIgnore(false);
          await loadAndRenderDissection(res && res.round && res.round.id);
        }
      } catch (err) {
        showStatus((err && err.message) || String(err));
      } finally {
        endRoundBtn.disabled = false;
        endRoundBtn.textContent = 'End Round';
      }
    });
  }
  cue.on('round:dissected', ({ round }) => {
    if (dissScrim && !dissScrim.classList.contains('hidden') && round) {
      void loadAndRenderDissection(round.id);
    }
  });

  function applyWorkspaceSnapshot(snap) {
    if (!snap) return;
    workspaceState = snap;
    renderWorkspaceSettings();
    if (typeof renderWorkspaceOverlayBar === 'function') renderWorkspaceOverlayBar();
  }

  async function deleteSelectedWorkspace(confirmFn) {
    const active = workspaceState && workspaceState.activeWorkspace;
    if (!active) return false;
    const hasRecordedTurns = Array.isArray(active.rounds) && active.rounds.some((r) => (r.turnCount || 0) > 0);
    if (hasRecordedTurns) {
      const ask = typeof confirmFn === 'function' ? confirmFn : (msg) => window.confirm(msg);
      if (!ask(`Delete workspace "${active.company} - ${active.role}" and all its recorded rounds?`)) {
        return false;
      }
    }
    const snap = await cue.workspaceDelete(active.id);
    applyWorkspaceSnapshot(snap);
    return true;
  }

  async function refreshProfileAndWorkspaceState() {
    try {
      if (cue.profileGet) {
        profileState = (await cue.profileGet()) || profileState;
        renderProfileSettings();
      }
      if (cue.workspaceList) {
        const snap = await cue.workspaceList();
        applyWorkspaceSnapshot(snap);
      }
    } catch (_) {}
  }

  const profAddDocBtn = $('#profile-add-doc');
  if (profAddDocBtn) {
    profAddDocBtn.addEventListener('click', async () => {
      const res = await cue.profileAddDoc('experience');
      if (res && res.profile) {
        profileState = res.profile;
        renderProfileSettings();
      }
    });
  }
  const profAddRepoBtn = $('#profile-add-repo');
  if (profAddRepoBtn) {
    profAddRepoBtn.addEventListener('click', async () => {
      const res = await cue.profileAddRepo();
      if (res && res.profile) {
        profileState = res.profile;
        renderProfileSettings();
      }
    });
  }
  const profReindexBtn = $('#profile-reindex');
  if (profReindexBtn) {
    profReindexBtn.addEventListener('click', async () => {
      profReindexBtn.disabled = true;
      try {
        profileState = await cue.profileReindex();
        renderProfileSettings();
      } finally {
        profReindexBtn.disabled = false;
      }
    });
  }
  const wsSelectEl = $('#ws-select');
  if (wsSelectEl) {
    wsSelectEl.addEventListener('change', async () => {
      if (!wsSelectEl.value) return;
      const snap = await cue.workspaceSelect(wsSelectEl.value);
      applyWorkspaceSnapshot(snap);
    });
  }
  const wsNewBtn = $('#ws-new-btn');
  if (wsNewBtn) {
    wsNewBtn.addEventListener('click', async () => {
      const snap = await cue.workspaceCreate({ company: 'New Company', role: 'Candidate Role' });
      applyWorkspaceSnapshot(snap);
    });
  }
  const wsDelBtn = $('#ws-delete-btn');
  if (wsDelBtn) {
    wsDelBtn.addEventListener('click', () => {
      void deleteSelectedWorkspace();
    });
  }
  const wsSaveMetaBtn = $('#ws-save-meta');
  if (wsSaveMetaBtn) {
    wsSaveMetaBtn.addEventListener('click', async () => {
      const active = workspaceState && workspaceState.activeWorkspace;
      if (!active) return;
      const snap = await cue.workspaceUpdate(active.id, {
        company: ($('#ws-company') && $('#ws-company').value) || active.company,
        role: ($('#ws-role') && $('#ws-role').value) || active.role,
        notes: ($('#ws-notes') && $('#ws-notes').value) || ''
      });
      applyWorkspaceSnapshot(snap);
      showToast('Workspace saved');
    });
  }
  const wsAddJdBtn = $('#ws-add-jd');
  if (wsAddJdBtn) {
    wsAddJdBtn.addEventListener('click', async () => {
      const active = workspaceState && workspaceState.activeWorkspace;
      if (!active) return;
      const res = await cue.workspaceAttachFile(active.id, 'jd', false);
      if (res && res.snapshot) applyWorkspaceSnapshot(res.snapshot);
    });
  }
  const wsAddTestFileBtn = $('#ws-add-test-file');
  if (wsAddTestFileBtn) {
    wsAddTestFileBtn.addEventListener('click', async () => {
      const active = workspaceState && workspaceState.activeWorkspace;
      if (!active) return;
      const res = await cue.workspaceAttachFile(active.id, 'test', false);
      if (res && res.snapshot) applyWorkspaceSnapshot(res.snapshot);
    });
  }
  const wsAddTestFolderBtn = $('#ws-add-test-folder');
  if (wsAddTestFolderBtn) {
    wsAddTestFolderBtn.addEventListener('click', async () => {
      const active = workspaceState && workspaceState.activeWorkspace;
      if (!active) return;
      const res = await cue.workspaceAttachFile(active.id, 'test', true);
      if (res && res.snapshot) applyWorkspaceSnapshot(res.snapshot);
    });
  }
  cue.on('profile:changed', (prof) => {
    if (prof) {
      profileState = prof;
      renderProfileSettings();
    }
  });
  cue.on('workspace:changed', (snap) => {
    applyWorkspaceSnapshot(snap);
  });

  // ---- boot --------------------------------------------------------------
  (async function boot() {
    settings = await cue.settingsGet();
    const platformInfo = await cue.platformInfo();
    await refreshProfileAndWorkspaceState();

    // R4: shortcut hints
    const sayHintEl = document.getElementById('say-shortcut-hint');
    const assistHintEl = document.getElementById('assist-shortcut-hint');
    if (sayHintEl) sayHintEl.textContent = isWindows ? 'Ctrl+↵' : '⌘↵';
    if (assistHintEl) assistHintEl.textContent = isWindows ? 'Ctrl+Shift+↵' : '⌘⇧↵';
    const sayBtn = document.querySelector('.act[data-mode="say"]');
    const assistBtn = document.querySelector('.act[data-mode="assist"]');
    if (sayBtn) sayBtn.title = isWindows
      ? 'Suggests what to say next based on the conversation (Ctrl+Enter)'
      : 'Suggests what to say next based on the conversation (⌘↵)';
    if (assistBtn) assistBtn.title = isWindows
      ? 'Scans your screen and conversation to decide what you need (Ctrl+Shift+Enter)'
      : 'Scans your screen and conversation to decide what you need (⌘⇧↵)';

    // R6: smart tooltip
    updateSmartTooltip();
    // Fix 3: Adjust permission buttons based on actual Windows version.
    // ms-settings:privacy-screenrecorder only exists on Windows 11.
    // On Windows 10, screen capture needs no permission — so replace the button
    // with a more helpful note instead of an invalid settings link.
    if (isWindows && platformInfo.winBuild > 0 && platformInfo.winBuild < 22000) {
      // Windows 10: update the onboarding screen recording button to be more helpful
      const ob = OB_STEPS.find((st) => st.permissions);
      ob.buttons = ob.buttons.filter((b) => !b.label.toLowerCase().includes('screen'));
      ob.body = 'cue needs microphone permission to hear you. Click the button below to open Windows microphone settings and allow cue.<br><br><strong>Screen capture works automatically on Windows 10</strong> — no additional permission needed.<ul><li><strong>Microphone</strong> — to hear you</li><li><strong>Screen recording</strong> — works automatically on Windows 10</li></ul><span class="ob-fine">You can also do this later in Windows Settings.</span>';
    }

    smartBtn.classList.toggle('on', !!settings.smart);
    if (!messages.children.length) showExample();
    syncPlaceholder();
    updateSendButtonState(); // Initialize send button state

    // Fix placeholder shortcut hint to match platform
    if (isWindows) {
      placeholder.innerHTML = 'Ask about your screen or conversation, or <span class="keycap">Ctrl</span><span class="keycap">⇧</span><span class="keycap">⏎</span> for Smart assist';
    }

    applyOpacity(settings.opacity, false);

    const st = await cue.captureState();
    $('#live-dot').classList.toggle('off', !st.active);
    setSessionButton(st.active);
    if (!settings.onboarded) showOnboard();
  })();
})();
