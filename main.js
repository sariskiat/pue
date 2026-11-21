const { app, BrowserWindow, ipcMain, globalShortcut, screen, session, desktopCapturer, shell, dialog, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const store = require('./src/store');
const { captureScreenshot } = require('./src/screen');
const { createSTT } = require('./src/stt');
const { parseDocumentFile } = require('./src/resume');
const { createLLM, normalizeProviderName } = require('./src/llm');
const { giveUpTimer } = require('./src/give-up');
const { checkOwnKey } = require('./src/own-key-check');
const { MODES } = require('./src/prompts');
const { rms16 } = require('./src/wav');
const { createStreamingSTT } = require('./src/stt-streaming');
const { AdaptiveVAD, AudioRingBuffer } = require('./src/vad');
const { buildInterviewContext, detectCategory } = require('./src/interview-context');
const { createProfileStore } = require('./src/profile-store');
const { createWorkspaceStore } = require('./src/workspace-store');
const { buildPrepBriefPrompt, parsePrepBrief } = require('./src/prep-brief');
const { formatDissectionMarkdown } = require('./src/round-dissector');
const { triageContext } = require('./src/context-triage');
const { TOOL_DEFINITIONS, createScopedToolbox } = require('./src/repo-tools');

let profileStore = null;
function getProfileStore() {
  if (!profileStore) {
    profileStore = createProfileStore(() => app.getPath('userData'));
  }
  return profileStore;
}

let workspaceStore = null;
function getWorkspaceStore() {
  if (!workspaceStore) {
    workspaceStore = createWorkspaceStore(() => app.getPath('userData'), { debounceMs: 1500 });
  }
  return workspaceStore;
}

let activeFeatureAbort = null;

function recordEvent(ev) {
  if (ev && (ev.level === 'error' || ev.level === 'fatal')) {
    console.error('[pue]', ev.event, ev.msg || '');
  }
}
const { createMeetingStore } = require('./src/meetings');
const { createMeetingMemory } = require('./src/meeting-memory');
const {
  hashRGBA,
  shouldEmitSlide,
  createSlideStore,
  clampSlidesConfig,
  buildSlideSystem,
  buildSlideUser,
  DEFAULT_STABLE_REQUIRED
} = require('./src/slides');

// macOS system-audio loopback (the "them" channel via getDisplayMedia) does not
// start on Electron 31–38 unless these Chromium features are enabled; without
// them getDisplayMedia rejects with "Error starting capture" and meeting audio
// silently never works. Electron 39+ wires this up itself, where this is a
// harmless no-op. Must run before app is ready.
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');
}

// Linux Wayland / Ozone native rendering configuration. Without this, Electron
// falls back to XWayland even on a native Wayland session; 'auto' picks Wayland
// when available and X11 otherwise. Harmless no-op on X11-only sessions.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'UseOzonePlatform,WaylandWindowDecorations');
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
}
const { WhisperModelManager } = require('./src/whisper-model-manager');
const { requireWhisperModel } = require('./src/whisper-model-catalog');
const { locateWhisperRuntime } = require('./src/whisper-runtime');
const { LocalWhisperTranscriber } = require('./src/local-whisper-transcriber');

let win = null;
// Which global shortcuts cue actually holds. `globalShortcut.register` returns
// false when another application already owns the combination, and nothing used
// to look at that — so the only symptom was a key that did nothing. Iris reads
// this and can say which key is taken instead of guessing from a screenshot.
const shortcutState = { assist: false, say: false, leetcode: false, quit: false };
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';

// -------- Windows version helpers --------
// WDA_EXCLUDEFROMCAPTURE (setContentProtection) requires Windows 10 build 19041+.
// os.release() returns the NT kernel version e.g. "10.0.19041" or "10.0.22000" (Win11).
function getWindowsBuild() {
  if (!isWindows) return 0;
  const parts = os.release().split('.').map(Number);
  return parts[2] || 0; // third segment is the build number
}
const WIN_BUILD = getWindowsBuild();
const WIN_SUPPORTS_CONTENT_PROTECTION = !isWindows || WIN_BUILD >= 19041;

// WDA_EXCLUDEFROMCAPTURE (win.setContentProtection(true)) is documented to
// exclude a window's content from third-party capture surfaces (BitBlt,
// PrintWindow, DXGI Desktop Duplication, screen recording / screen share)
// WITHOUT touching the live composited image on an ordinary, physically
// scanned-out desktop session — the user still sees the window fine. But on
// a Windows session whose own visible surface is ITSELF a remoted or
// composited pipeline — a Remote Desktop (RDP) connection, a Windows 365 /
// Cloud PC session, most VM consoles, a CI runner's virtual desktop — the
// same flag has been observed to make the window render nothing at all, to
// the user as much as to any capture tool (see
// cue-windows-overlay-not-visible-for-mic-grant: PrintWindow(PW_RENDERFULLCONTENT)
// sampled zero color variance, and a full-desktop screenshot showed the
// always-on-top window occluding nothing, only ever reproduced with
// protection on and never with it off). Windows sets the SESSIONNAME
// environment variable to exactly "Console" for a locally-attached
// interactive session; every remoted session gets a different value
// (e.g. "RDP-Tcp#3"), and a non-interactive/service context has none at
// all. Anything other than a confirmed local console session is treated as
// unsafe to protect: a window the user can see (even if a screen-share
// viewer also could) is strictly better than a window that is invisible to
// everyone, including the user trying to grant it microphone access.
const WIN_IS_LOCAL_CONSOLE_SESSION = !isWindows || process.env.SESSIONNAME === 'Console';

let permWin = null;
// Windows never blocks startup on an unresolved permission (see app.whenReady()
// below), so launchApp() can already have run once by the time the user grants
// access and clicks Continue in the gate window (permissions:continue also
// calls launchApp()). Without this guard the second call re-creates the main
// BrowserWindow (createWindow() has no existing-window check) and re-registers
// global shortcuts -- a real, reachable
// regression, not a hypothetical.
let appLaunched = false;

// -------- capture / transcript state --------
const state = { capturing: false, busy: false, transcribing: { you: false, them: false } };
let sttDisabled = false; // set when the key can't reach any speech model (stops retry spam)
const buffers = { you: [], them: [] };
const sttInFlight = { you: Promise.resolve(null), them: Promise.resolve(null) }; // the channel's transcription request, if any
let sttSession = 0; // one per listening session; a piece only ever joins the session it was heard in
const lastSttText = { you: '', them: '' }; // the channel's latest text, whisper context for a piece after a cut
let sttSessionShown = false; // the current session has shown text (an old session's late text then waits no more)
const NEW_SESSION_FIRST = { message: 'a new session started first' };
const transcript = []; // { channel, text, ts } — capped at MAX_TRANSCRIPT_TURNS
const MAX_TRANSCRIPT_TURNS = 200; // ~30–40 minutes of conversation at normal pace
let meetingMemory = null; // persists the transcript per meeting + notes; see src/meeting-memory.js
let restoredTurns = []; // turns of an interrupted meeting resumed at launch, replayed to the renderer once
// -------- slides state (memory-only, never written to disk) --------
let slideStore = createSlideStore({ maxSlides: 50 });
let slideTimer = null;
let slideLastHash = null;
let slideStableCount = 0;
let slideBusy = false;
let slideDisabled = false; // set when the chat key rejects slide captions (stops cost spam)
let slideTxCursor = 0; // transcript.length at last emitted slide
const FLUSH_MS = 900;
const STREAM_INACTIVITY_MS = 25000; // abort a stalled LLM stream so state.busy can't wedge forever
const THINKING_PING_MS = 5000; // at most one "Thinking…" signal to the renderer per 5 s
const MIN_BYTES = Math.floor(16000 * 2 * 0.12); // ~0.12s
const RMS_GATE = 180;
let flushTimer = null;
let whisperModelManager = null;
let localWhisperTranscriber = null;
let activeWhisperModelId = null;
let desiredCaptureState = false;
let captureTransition = Promise.resolve(false);

// -------- streaming STT state --------
let streamingSTT = { you: null, them: null }; // streaming STT instances per channel
let streamingMode = false; // true when using WebSocket streaming STT
const vad = {
  you: new AdaptiveVAD({
    onsetThreshold: 220,
    offsetThreshold: 130,
    silenceFrames: 18,       // ~540ms silence before end
    onSpeechStart: () => send('vad:state', { channel: 'you', speaking: true }),
    onSpeechEnd: (dur) => send('vad:state', { channel: 'you', speaking: false, durationMs: dur })
  }),
  them: new AdaptiveVAD({
    onsetThreshold: 200,
    offsetThreshold: 120,
    silenceFrames: 20,       // ~600ms for remote audio (more forgiving)
    onSpeechStart: () => send('vad:state', { channel: 'them', speaking: true }),
    onSpeechEnd: (dur) => send('vad:state', { channel: 'them', speaking: false, durationMs: dur })
  })
};
// Pre-speech ring buffers (300ms) so we never clip the start of a word
const ringBuffers = {
  you: new AudioRingBuffer(300, 16000),
  them: new AudioRingBuffer(300, 16000)
};

function pushTranscript(turn) {
  transcript.push(turn);
  if (transcript.length > MAX_TRANSCRIPT_TURNS) transcript.splice(0, transcript.length - MAX_TRANSCRIPT_TURNS);
  if (meetingMemory) meetingMemory.onTurn(turn);
  try {
    const ws = getWorkspaceStore().getActiveWorkspace();
    if (ws && ws.activeRoundId) {
      getWorkspaceStore().appendRoundEvent(ws.id, ws.activeRoundId, {
        type: 'transcript_turn',
        channel: turn.channel,
        text: turn.text,
        ts: turn.ts
      });
    }
  } catch (_) {
    // Never interrupt live capture if workspace write fails.
  }
}

function send(channel, data) { if (win && !win.isDestroyed()) win.webContents.send(channel, data); }

function getWhisperRuntime() {
  return locateWhisperRuntime({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    platform: process.platform,
    architecture: process.arch,
    environment: process.env
  });
}

function publishTranscript(channel, text) {
  if (!text || !text.trim()) return;
  const turn = { channel, text: text.trim(), ts: Date.now() };
  pushTranscript(turn);
  send('transcript', turn);
  send('stt:final', { channel, text: turn.text });
}

async function startLocalWhisper(settings) {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  const localSettings = settings.localWhisper || {};
  const model = requireWhisperModel(localSettings.modelId || 'base.en');
  const runtime = getWhisperRuntime();
  if (!runtime.available) throw new Error(runtime.message);
  activeWhisperModelId = model.id;
  let transcriber = null;
  try {
    const modelPath = await whisperModelManager.verifyInstalledModel(model.id).catch((error) => {
      if (error.code === 'ENOENT') {
        throw new Error(`Download the ${model.id} model in Settings → Audio before listening.`);
      }
      throw error;
    });

    transcriber = new LocalWhisperTranscriber({
      sessionOptions: {
        executablePath: runtime.executablePath,
        runtimeDirectory: runtime.runtimeDirectory,
        modelPath,
        language: model.englishOnly ? 'en' : (localSettings.language || 'auto'),
        threads: Number(localSettings.threads) || 0,
        tinydiarize: model.tinydiarize
      },
      onTranscript: publishTranscript,
      onSpeechState: (channel, speaking, durationMs) => {
        send('vad:state', { channel, speaking, durationMs });
      },
      onStatus: (status) => send('stt:status', { provider: 'local', ...status }),
      onError: (error) => {
        sttDisabled = true;
        console.log('[local-whisper] error', error && error.message);
        send('stt:status', { provider: 'local', status: 'error' });
        send('status', { message: `Local transcription error: ${error.message}. Audio was not sent to a cloud fallback.` });
      }
    });

    localWhisperTranscriber = transcriber;
    await transcriber.start();
  } catch (error) {
    if (localWhisperTranscriber === transcriber) localWhisperTranscriber = null;
    activeWhisperModelId = null;
    if (transcriber) await transcriber.forceStop().catch(() => {});
    throw error;
  }
}

async function getWhisperOverview() {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  const runtime = getWhisperRuntime();
  const models = await whisperModelManager.listModels();
  return {
    runtime: {
      available: runtime.available,
      version: runtime.version,
      target: runtime.target,
      message: runtime.message || null
    },
    models
  };
}

// -------- window --------
// The window has a transparent, click-through strip on each side of the main column so
// the history sidebar can slide out left or right. Must match --main-w/--side-w in
// styles.css. Saved windowX is the main column's x, not the window's.
const MAIN_W = 700, SIDE_W = 300;

function saveWindowPosition() {
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  store.setSettings({ windowX: x + SIDE_W, windowY: y });
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = SIDE_W + MAIN_W + SIDE_W, H = Math.min(680, Math.max(580, workArea.height - 24));

  const savedSettings = store.getSettings();
  let startX = Math.round(workArea.x + (workArea.width - MAIN_W) / 2);
  let startY = workArea.y + 6;

  if (savedSettings.windowX !== null && savedSettings.windowY !== null) {
    const clampedX = Math.max(workArea.x - MAIN_W + 100, Math.min(savedSettings.windowX, workArea.x + workArea.width - 100));
    // Keep the whole window on screen, not just a 40px sliver of it. The old
    // `- 40` let a 600px-tall window sit at y=607 on a 960px display, pushing
    // the composer and action row off the bottom edge with no way to reach them.
    const clampedY = Math.max(workArea.y, Math.min(savedSettings.windowY, workArea.y + workArea.height - H));
    startX = clampedX;
    startY = clampedY;
  }

  const winOptions = {
    width: W,
    height: H,
    x: startX - SIDE_W,
    y: startY,
    enableLargerThanScreen: true,
    // The window is shown inactive and never takes focus, so without this macOS spends the
    // first click only activating it and a press on the drag handle does nothing.
    acceptFirstMouse: true,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  };

  // Fix 1: On Windows, set type:'toolbar' which sets WS_EX_TOOLWINDOW.
  // This removes the window from Alt+Tab AND the taskbar entirely.
  // On macOS, this is not needed (dock hiding + Mission Control handle it).
  if (isWindows) {
    winOptions.type = 'toolbar';
  }

  win = new BrowserWindow(winOptions);

  // Fix 2: Only call setContentProtection if the OS supports it, and only on
  // a session where it will not blank the window out for the user themself
  // (see WIN_IS_LOCAL_CONSOLE_SESSION above — RDP/VM/Cloud-PC-style sessions
  // render a WDA_EXCLUDEFROMCAPTURE window fully invisible, not just hidden
  // from capture). On older builds, or a non-local-console Windows session,
  // we skip it silently and send a warning to the renderer instead.
  const shouldProtect = !process.env.CUE_NO_PROTECT && WIN_IS_LOCAL_CONSOLE_SESSION;
  if (shouldProtect) {
    if (isLinux) {
      // setContentProtection has no effect on Linux (no windowing-system-level
      // capture-exclusion primitive it can map to) — skip the no-op call and
      // say so, rather than pretending the window is hidden from screen shares.
      console.log('[cue] Running on Linux: native screen protection (setContentProtection) is not supported and has been skipped.');
    } else if (WIN_SUPPORTS_CONTENT_PROTECTION) {
      win.setContentProtection(true);
    } else {
      // Will notify the renderer after it loads
      console.log(`[cue] Windows build ${WIN_BUILD} < 19041 — setContentProtection not supported. Window may appear in screen shares.`);
    }
  } else if (isWindows && !WIN_IS_LOCAL_CONSOLE_SESSION && !process.env.CUE_NO_PROTECT) {
    console.log(`[cue] Windows session is not a local console session (SESSIONNAME=${process.env.SESSIONNAME}) — skipping setContentProtection so the window stays visible to you. Window may appear in screen shares.`);
  }

  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (isMac && typeof win.setHiddenInMissionControl === 'function') win.setHiddenInMissionControl(true);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  let moveSaveTimer = null;
  win.on('moved', () => {
    clearTimeout(moveSaveTimer);
    moveSaveTimer = setTimeout(saveWindowPosition, 500);
  });

  win.setTitle('Microsoft Edge Update'); // set before load

  win.webContents.on('did-finish-load', () => {
    win.showInactive();
    win.setTitle('Microsoft Edge Update');
    if (restoredTurns.length) {
      // A meeting was in progress when cue last exited: put its transcript back
      // in the sidebar so Recap / Follow-up pick up where the conversation was.
      const turns = restoredTurns;
      restoredTurns = [];
      send('transcript:restore', { turns });
      const ageMin = Math.max(1, Math.round((Date.now() - turns[turns.length - 1].ts) / 60000));
      send('status', { message: `Resumed your meeting from ${ageMin} min ago (${turns.length} turns restored).` });
    }
    // Warn about missing content protection on old Windows builds
    if (isWindows && shouldProtect && !WIN_SUPPORTS_CONTENT_PROTECTION) {
      send('status', {
        message: `Heads up: your Windows version (build ${WIN_BUILD}) does not support screen-share hiding. Upgrade to Windows 10 build 19041+ or Windows 11 to enable invisibility in screen shares.`
      });
    }
    // Warn when protection was skipped because this is not a local console
    // session (RDP / Cloud PC / VM console) — see WIN_IS_LOCAL_CONSOLE_SESSION.
    if (isWindows && !process.env.CUE_NO_PROTECT && !WIN_IS_LOCAL_CONSOLE_SESSION) {
      send('status', {
        message: 'Heads up: screen-share hiding is off for this session (remote desktop / cloud PC / VM sessions can render the window invisible to you as well when it is on). The window will be visible in screen shares here.'
      });
    }
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    console.log('[cue] renderer gone', JSON.stringify(d));
    recordEvent({ level: 'fatal', event: 'renderer_gone', code: d && d.reason, msg: 'renderer process ended: ' + JSON.stringify(d), frame: 'BrowserWindow' });
  });
}

// -------- STT flushing (batch mode fallback) --------
function noTranscriptionMessage() {
  return 'Transcription is off. Pick Local in Settings > Audio to transcribe on this computer with no key, or add an OpenAI or Groq key. Screen and coding features work without it.';
}

async function flushChannel(channel) {
  if (state.transcribing[channel]) return;
  const settings = store.getSettings();
  const stt = createSTT(settings);
  const chunks = buffers[channel];
  buffers[channel] = [];
  const windowPcm = chunks.length ? Buffer.concat(chunks) : null;
  const pcm = windowPcm && windowPcm.length >= MIN_BYTES && rms16(windowPcm) >= RMS_GATE ? windowPcm : null;
  if (!pcm) return;
  await transcribePiece(channel, pcm, settings, stt, { session: sttSession });
}

function transcribePiece(channel, pcm, settings, stt, { context = '', session = sttSession } = {}) {
  const run = (async () => {
    state.transcribing[channel] = true;
    try {
      if (!stt.available) {
        if (!sttDisabled) { sttDisabled = true; send('status', { message: noTranscriptionMessage() }); }
        return null;
      }
      const res = await stt.transcribe(pcm, { context });
      if (session !== sttSession) {
        const text = !res.error && res.text ? res.text.trim() : '';
        if (text.length > 1 && !sttSessionShown && !/^[?!.,;:\-…]+$/.test(text)) {
          const turn = { channel, text, ts: Date.now() };
          pushTranscript(turn);
          send('transcript', turn);
          return null;
        }
        return { stale: true, pcm, session, error: res.error || (text ? NEW_SESSION_FIRST : null) };
      }
      if (res.error) {
        handleSttError(res.error);
        return null;
      }
      if (res.text && res.text.trim() && res.text.trim().length > 1 && !/^[?!.,;:\-…]+$/.test(res.text.trim())) {
        const turn = { channel, text: res.text.trim(), ts: Date.now() };
        pushTranscript(turn);
        send('transcript', turn);
        lastSttText[channel] = turn.text;
        sttSessionShown = true;
      }
      return null;
    } catch (e) {
      console.log('[stt] error', e && e.message);
      recordEvent({ level: 'error', event: 'stt_failed', msg: e && e.message ? e.message : String(e), frame: 'transcribePiece', context: { channel } });
      return null;
    } finally {
      state.transcribing[channel] = false;
    }
  })();
  sttInFlight[channel] = run.catch(() => null);
  return run;
}

let notesStatusFor = 0;
function notesAfterStop(memory, lastWords) {
  const stop = ++notesStatusFor;
  return lastWords.then(() => memory.refreshNotes()).then((notes) => {
    if (notes && stop === notesStatusFor) send('status', { message: `Meeting notes saved (${notes.turns} turns).` });
  }).catch(() => {});
}

function startSttSession() {
  sttSession++;
  buffers.you = []; buffers.them = [];
  lastSttText.you = ''; lastSttText.them = '';
  sttSessionShown = false;
}

function handleSttError(err) {
  console.log('[stt] error', err.provider, err.status, err.code, err.message);
  recordEvent({
    level: 'error',
    event: 'stt_rejected',
    code: err.code || (err.status ? 'http_' + err.status : null),
    msg: err.message,
    frame: 'handleSttError',
    context: { provider: err.provider, status: err.status || null, alreadyDisabled: sttDisabled }
  });
  if (sttDisabled) return;
  const isQuota = err.status === 429 || err.code === 'RESOURCE_EXHAUSTED' || (err.message && err.message.includes('Quota exceeded'));
  const noAccess = err.status === 403 || err.status === 401 || err.code === 'model_not_found' || isQuota;
  sttDisabled = true;
  if (noAccess) {
    send('status', { message: `Transcription off: your ${err.provider} key was rejected or hit a quota limit. Update your key in Settings to resume.` });
  } else {
    send('status', { message: 'Transcription error (' + err.provider + '): ' + err.message });
  }
}

function startFlushLoop() {
  if (flushTimer) return;
  flushTimer = setInterval(() => { flushChannel('you'); flushChannel('them'); }, FLUSH_MS);
}
function stopFlushLoop() { if (flushTimer) { clearInterval(flushTimer); flushTimer = null; } }

// -------- streaming STT setup --------
function initStreamingSTT() {
  const settings = store.getSettings();
  streamingMode = false;

  ['you', 'them'].forEach((channel) => {
    let instance = null; // set below; lets the callbacks tell a stale instance from the live one
    const sttInstance = createStreamingSTT(settings, channel, {
      onTranscript: (ch, text) => {
        if (instance && streamingSTT[ch] !== instance) return; // stale instance after a stop/start

        const turn = { channel: ch, text, ts: Date.now() };
        pushTranscript(turn);
        send('transcript', turn);
        send('stt:final', { channel: ch, text });
      },
      onInterim: (ch, text) => {
        if (instance && streamingSTT[ch] !== instance) return;
        send('stt:interim', { channel: ch, text });
      },
      onError: (err) => {
        // A socket torn down by a quick stop/start can still report an error a
        // moment later; acting on it would kill the sessions that replaced it
        // and start the batch loop alongside them (double transcription).
        if (instance && streamingSTT[channel] !== instance) return;
        console.log('[streaming-stt] error', err.provider, err.message);
        const batchFallbackAvailable = createSTT(settings).available;
        stopStreamingSTT(); // close WebSockets and clear keep-alive intervals
        if (batchFallbackAvailable) {
          send('status', { message: `Streaming transcription (${err.provider}) error: ${err.message}. Falling back to batch mode.` });
          startFlushLoop();
        } else if (!sttDisabled) {
          sttDisabled = true;
          send('status', { message: `Transcription stopped (${err.provider}): ${err.message}. The selected provider has no batch fallback.` });
        }
        streamingMode = false;
      },
      onStatusChange: (ch, status) => {
        send('stt:status', { channel: ch, status });
        if (status === 'connected') {
          console.log(`[streaming-stt] ${ch} channel connected`);
        }
      }
    });

    if (sttInstance.type === 'streaming' && sttInstance.instance) {
      instance = sttInstance.instance;
      streamingMode = true;
      streamingSTT[channel] = instance;
      instance.connect();
    }
  });

  return streamingMode;
}

function stopStreamingSTT() {
  ['you', 'them'].forEach((channel) => {
    if (streamingSTT[channel]) {
      streamingSTT[channel].disconnect();
      streamingSTT[channel] = null;
    }
  });
  streamingMode = false;
}

// -------- slides: auto tracking (opt-in, memory-only) --------
// Cheap hash poll (32px thumbnail) every intervalMs; full-res VLM caption only
// on stable change. Never blocks runFeature (own slideBusy flag). Images are
// never stored — only hash + caption + transcript window.
function getSlidesConfig() {
  return clampSlidesConfig(store.getSettings().slides || {});
}

async function captureHashFrame() {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 32, height: 32 }
  });
  if (!sources.length) return null;
  const img = sources[0].thumbnail;
  if (!img || img.isEmpty()) return null;
  const size = img.getSize();
  const bmp = img.toBitmap();
  if (!bmp || !size.width || !size.height) return null;
  return { width: size.width, height: size.height, data: bmp };
}

async function captionSlide(imageDataUrl, transcriptSlice) {
  const settings = store.getSettings();
  const llm = createLLM(settings);
  if (!llm.ready) throw new Error(llm.configurationError || 'Complete the provider settings.');
  // A fixed 25 s total limit (never re-armed). When it gives up, the request
  // is cancelled too, so a long think is not billed for a caption nobody sees.
  const guard = giveUpTimer(STREAM_INACTIVITY_MS, 'slide caption timed out');
  try {
    return await Promise.race([
      llm.stream({
        system: buildSlideSystem(),
        turns: [{ role: 'user', text: buildSlideUser(transcriptSlice) }],
        imageDataUrl,
        maxTokens: 300,
        // A caption cut at the cap is trimmed and ends with "…", never with
        // the chat answer's "(Cut off: …)" note.
        lengthCut: 'ellipsis',
        signal: guard.signal,
        onToken: () => {},
        onRetry: (r) => recordEvent({ level: 'info', event: 'llm_filter_retry', msg: `${r.from} -> ${r.to}`, frame: 'captionSlide', context: { mode: 'caption', from: r.from, to: r.to, finishReason: r.finishReason } })
      }),
      guard.expired
    ]);
  } finally {
    guard.clear();
  }
}

async function pollSlides() {
  if (!state.capturing || slideBusy || slideDisabled) return;
  const cfg = getSlidesConfig();
  if (!cfg.enabled) return;
  if (slideStore.count() >= cfg.maxSlides) return;
  let frame = null;
  try {
    frame = await captureHashFrame();
  } catch {
    return;
  }
  if (!frame) return;
  const newHash = hashRGBA(frame.width, frame.height, frame.data);
  if (!newHash) return;
  const decision = shouldEmitSlide(slideLastHash, newHash, {
    threshold: cfg.threshold,
    stableCount: slideStableCount,
    requiredStable: DEFAULT_STABLE_REQUIRED
  });
  slideStableCount = decision.stableCount;
  if (!decision.emit) {
    if (slideLastHash && decision.distance != null && decision.distance <= cfg.threshold) slideLastHash = slideLastHash;
    return;
  }
  slideLastHash = newHash;
  slideStableCount = decision.stableCount;
  // Stable change: take one full-res frame and caption it.
  slideBusy = true;
  try {
    const imageDataUrl = await captureScreenshot();
    if (!imageDataUrl) return;
    const txStart = slideTxCursor;
    const txEnd = transcript.length;
    const slice = transcript.slice(txStart, txEnd).slice(-8);
    const caption = (await captionSlide(imageDataUrl, slice) || '').trim();
    if (!caption) return;
    const slide = slideStore.add({ hash: newHash, caption, txStart, txEnd });
    slideTxCursor = txEnd;
    send('slides:update', { count: slideStore.count(), last: slide });
    recordEvent({ level: 'info', event: 'slide_captured', msg: 'slide ' + slideStore.count() + ' captioned' });
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (/429|quota|401|403|model_not_found/i.test(msg)) {
      slideDisabled = true;
      send('status', { message: 'Slide captions paused: ' + msg });
    } else {
      console.log('[slides] caption failed', msg);
    }
  } finally {
    slideBusy = false;
  }
}

function startSlideLoop() {
  stopSlideLoop();
  const cfg = getSlidesConfig();
  slideTimer = setInterval(() => { pollSlides().catch(() => {}); }, cfg.intervalMs);
  if (slideTimer.unref) slideTimer.unref();
}

function stopSlideLoop() {
  if (slideTimer) { clearInterval(slideTimer); slideTimer = null; }
}

function resetSlidesSession() {
  slideStore.clear();
  slideLastHash = null;
  slideStableCount = 0;
  slideBusy = false;
  slideDisabled = false;
  slideTxCursor = transcript.length;
}

// -------- audio routing (streaming or batch) --------
// Per-channel level report every few seconds while capturing, so "cue never
// hears me" reports can be told apart: no chunks (capture never reached the
// main process), chunks but rms≈0 (a silent/muted device), or healthy audio
// that the transcriber is dropping.
const AUDIO_LEVEL_LOG_MS = 5000;
const audioLevels = { you: { chunks: 0, peakRms: 0 }, them: { chunks: 0, peakRms: 0 }, lastLog: 0 };
function noteAudioLevel(channel, buf) {
  const lv = audioLevels[channel];
  lv.chunks++;
  if (buf.length >= 2) lv.peakRms = Math.max(lv.peakRms, rms16(buf));
  const now = Date.now();
  if (now - audioLevels.lastLog < AUDIO_LEVEL_LOG_MS) return;
  audioLevels.lastLog = now;
  const fmt = (c) => `${c}: chunks=${audioLevels[c].chunks} peakRms=${Math.round(audioLevels[c].peakRms)}`;
  console.log(`[audio] ${fmt('you')} | ${fmt('them')} (gate=${RMS_GATE}, mode=${localWhisperTranscriber ? 'local' : streamingMode ? 'streaming' : 'batch'})`);
  audioLevels.you = { chunks: 0, peakRms: 0 };
  audioLevels.them = { chunks: 0, peakRms: 0 };
}

function routeAudio(channel, pcmBuffer) {
  const buf = Buffer.from(pcmBuffer);
  noteAudioLevel(channel, buf);

  if (localWhisperTranscriber) {
    localWhisperTranscriber.push(channel, buf);
    return;
  }

  // Always run through VAD for speech state detection
  vad[channel].processChunk(buf);

  // Keep pre-speech buffer
  ringBuffers[channel].write(buf);

  if (streamingMode && streamingSTT[channel]) {
    // Streaming mode: send raw PCM directly to the WebSocket
    streamingSTT[channel].sendAudio(pcmBuffer);
  } else {
    // Batch mode: accumulate in buffers for periodic flush
    buffers[channel].push(buf);
  }
}

// -------- capture toggle --------
// Mic + system audio are both captured in the RENDERER (getUserMedia for the mic,
// getDisplayMedia loopback for system audio) so they run inside cue's own process
// and use cue's own Screen-Recording grant — no separate helper binary to authorize.
async function setCapturing(active) {
  if (active === state.capturing) return state.capturing;

  if (active) {
    sttDisabled = false; // reset on re-enable
    startSttSession();
    const settings = store.getSettings();
    if ((settings.sttProvider || 'auto') === 'local') {
      try {
        await startLocalWhisper(settings);
        state.capturing = true;
        console.log('[cue] capture started, mode: local');
        slideDisabled = false;
        slideTxCursor = transcript.length;
        slideStore = createSlideStore({ maxSlides: getSlidesConfig().maxSlides });
        slideLastHash = null;
        slideStableCount = 0;
        startSlideLoop();
        send('capture:state', { active: true, streaming: false, mode: 'local' });
        send('slides:update', { count: 0, last: null });
        return true;
      } catch (error) {
        state.capturing = false;
        desiredCaptureState = false;
        if (error.code === 'STARTUP_CANCELLED') {
          send('stt:status', { provider: 'local', status: 'off' });
          send('capture:state', { active: false, streaming: false, mode: 'local' });
          return false;
        }
        send('stt:status', { provider: 'local', status: 'error' });
        send('status', { message: `Local transcription could not start: ${error.message} No audio was sent to a cloud provider.` });
        send('capture:state', { active: false, streaming: false, mode: 'local' });
        return false;
      }
    }

    state.capturing = true;
    // Try streaming first, fall back to batch
    const streaming = initStreamingSTT();
    if (!streaming) {
      startFlushLoop();
    }
    slideDisabled = false;
    slideTxCursor = transcript.length;
    const slideCfg = getSlidesConfig();
    slideStore = createSlideStore({ maxSlides: slideCfg.maxSlides });
    slideLastHash = null;
    slideStableCount = 0;
    startSlideLoop();
    console.log('[cue] capture started, mode:', streaming ? 'streaming' : 'batch');
    send('capture:state', { active: true, streaming: streamingMode, mode: streaming ? 'streaming' : 'batch' });
    send('slides:update', { count: 0, last: null });
    return true;
  }

  state.capturing = false;
  stopFlushLoop();
  stopStreamingSTT();
  const lastWords = Promise.all([sttInFlight.you, sttInFlight.them]).catch(() => {});
  if (meetingMemory) {
    notesAfterStop(meetingMemory, lastWords);
  }
  stopSlideLoop();
  buffers.you = []; buffers.them = [];
  vad.you.reset(); vad.them.reset();
  ringBuffers.you.clear(); ringBuffers.them.clear();
  const stoppingLocalTranscriber = localWhisperTranscriber;
  localWhisperTranscriber = null;
  send('capture:state', { active: false, streaming: false, mode: stoppingLocalTranscriber ? 'local' : 'off' });
  if (stoppingLocalTranscriber) {
    send('stt:status', { provider: 'local', status: 'stopping' });
    try {
      await stoppingLocalTranscriber.stop();
    } catch (error) {
      console.log('[local-whisper] stop error', error && error.message);
    } finally {
      activeWhisperModelId = null;
    }
  }
  return false;
}

// -------- feature runner --------
async function runFeature(mode, userText) {
  if (state.busy) return;
  const def = MODES[mode];
  if (!def) return;
  state.busy = true;
  let streamSettled = false; // drop stray tokens from a stream we've already abandoned
  try {
    const settings = store.getSettings();
    const llm = createLLM(settings);
    const userBubble = def.userBubble !== null
      ? def.userBubble
      : (mode === 'ask' ? userText : mode === 'answerThis' ? `"${(userText || '').slice(0, 60)}${userText && userText.length > 60 ? '…' : ''}"` : null);
    const category = mode !== 'leetcode' ? detectCategory(transcript) : null;
    send('llm:start', { userBubble, small: !!def.small, category });

    if (!llm.ready) {
      const message = llm.configurationError || ('Complete the ' + settings.provider + ' provider settings. Model: ' + (llm.model || 'unset') + '.');
      send('llm:error', { message });
      return;
    }

    let imageDataUrl = null;
    if (def.needsScreen) {
      try {
        imageDataUrl = await captureScreenshot();
        if (!imageDataUrl) throw new Error('No screen source was available.');
      }
      catch (e) {
        recordEvent({ level: 'error', event: 'screen_capture_failed', msg: e && e.message ? e.message : String(e), frame: 'captureScreenshot', context: { mode } });
        const message = process.platform === 'darwin'
          ? 'Screen capture needs permission — grant Screen Recording to cue in System Settings.'
          : process.platform === 'win32'
            ? 'Screen capture failed. Make sure cue is not blocked by Windows privacy or security software, then try again.'
            : 'Screen capture failed. Check your desktop capture permissions, then try again.';
        send('status', { message });
      }
    }

    // Follow-up / Recap have nothing to work with before anything was heard —
    // sent to the model anyway, it fabricates plausible generic output that
    // looks like a canned preset. Say so instead, and log how much context
    // every feature actually ran with.
    console.log(`[llm] mode=${mode} transcriptTurns=${transcript.length} capturing=${state.capturing}`);
    if (def.transcriptRequired && transcript.length === 0) {
      send('llm:error', { message: state.capturing
        ? 'Nothing has been transcribed yet — say something (or let the other side talk) and try again.'
        : 'Nothing captured yet — press the listen button first so cue can hear the conversation.' });
      return;
    }

    const settingsForPrompt = store.getSettings();
    const activeWs = getWorkspaceStore().getActiveWorkspace();
    const activeRoundId = activeWs ? activeWs.activeRoundId : null;
    const roundProj =
      activeWs && activeRoundId
        ? getWorkspaceStore().buildRoundProjection(activeWs.id, activeRoundId)
        : { transcript, rollingSummary: '', qaTurns: [] };
    const wsMemory =
      mode !== 'leetcode' && activeWs && activeRoundId
        ? getWorkspaceStore().workspaceMemoryBlock(activeWs.id, activeRoundId)
        : '';
    const fullProfile = getProfileStore().getProfile();

    const triaged = triageContext({
      mode,
      transcript: roundProj.transcript && roundProj.transcript.length ? roundProj.transcript : transcript,
      rollingSummary: roundProj.rollingSummary || '',
      userText: userText || '',
      workspace: activeWs,
      workspaceMemory: wsMemory,
      profile: fullProfile,
      qaTurns: roundProj.qaTurns || [],
      slides: slideStore.list(),
      aiRules: settingsForPrompt.aiRules || ''
    });
    const system = triaged.systemPrompt;
    const turnsForStream = triaged.conversationTurns;
    let fallbackSystem = null;
    let fallbackTurns = null;

    if (activeWs && activeRoundId && mode !== 'leetcode') {
      try {
        getWorkspaceStore().appendRoundEvent(activeWs.id, activeRoundId, {
          type: 'perception_trace',
          ...triaged.perceptionTrace
        });
        if (triaged.compactionCandidate) {
          getWorkspaceStore().appendRoundEvent(activeWs.id, activeRoundId, {
            type: 'compaction',
            ...triaged.compactionCandidate
          });
        }
      } catch (_) {}
    }

    const allowedRootEntries = [
      ...getProfileStore().listAllowedRootEntries(),
      ...(activeWs ? getWorkspaceStore().allowedRootEntriesForWorkspace(activeWs.id) : [])
    ];
    const toolbox = createScopedToolbox(allowedRootEntries);
    const isDeepMode = mode !== 'leetcode' && (mode === 'ask' || !!settingsForPrompt.smart) && toolbox.hasRoots;

    if (isDeepMode) {
      const expanded = triageContext({
        mode,
        transcript: roundProj.transcript && roundProj.transcript.length ? roundProj.transcript : transcript,
        rollingSummary: roundProj.rollingSummary || '',
        userText: userText || '',
        workspace: activeWs,
        workspaceMemory: wsMemory,
        profile: fullProfile,
        qaTurns: roundProj.qaTurns || [],
        slides: slideStore.list(),
        aiRules: settingsForPrompt.aiRules || '',
        topK: 10,
        p1BudgetChars: 6500
      });
      fallbackSystem = expanded.systemPrompt;
      fallbackTurns = expanded.conversationTurns;
    }

    // Watchdog: a provider that stalls mid-stream would otherwise hang the await forever,
    // leaving state.busy = true and wedging every later question until an app restart.
    // When it gives up, the HTTP request is cancelled too (guard.signal), so the
    // provider stops generating and billing an answer cue no longer shows.
    const guard = giveUpTimer(STREAM_INACTIVITY_MS, 'the model stopped responding (timed out). Please try again.');
    const cancelController = new AbortController();
    activeFeatureAbort = cancelController;
    const requestSignal = AbortSignal.any([guard.signal, cancelController.signal]);
    const rearm = guard.rearm;
    const citedSources = new Set(
      triaged && Array.isArray(triaged.matchedChunks)
        ? triaged.matchedChunks.map((c) => `${c.sourceLabel || 'source'}:${c.startLine || 1}`)
        : []
    );
    let answerStarted = false;
    let thinkingSentAt = 0;
    const noteActivity = (kind) => {
      if (streamSettled) return;
      rearm();
      if (kind === 'thinking' && !answerStarted && Date.now() - thinkingSentAt >= THINKING_PING_MS) {
        thinkingSentAt = Date.now();
        send('llm:thinking', {});
      }
    };
    let finalAnswerText = '';
    try {
      finalAnswerText = await Promise.race([
        llm.stream({
          system,
          turns: turnsForStream,
          imageDataUrl,
          onToken: (t) => { if (streamSettled) return; answerStarted = true; rearm(); send('llm:token', { text: t }); },
          onActivity: noteActivity,
          signal: guard.signal,
          ...(isDeepMode
            ? {
                signal: requestSignal,
                tools: TOOL_DEFINITIONS,
                maxToolRounds: 4,
                deepTimeoutMs: 35000,
                fallbackSystem,
                fallbackTurns,
                onToolCall: (info) => {
                  rearm();
                  const detail = (info.args && (info.args.relPath || info.args.query || info.args.rootName)) || info.name;
                  send('llm:tool', { name: info.name, detail: String(detail), round: info.round });
                  if (activeWs && activeRoundId) {
                    try {
                      getWorkspaceStore().appendRoundEvent(activeWs.id, activeRoundId, {
                        type: 'tool_call',
                        toolName: info.name,
                        args: info.args || {}
                      });
                    } catch (_) {}
                  }
                },
                executeTool: async (name, toolArgs) => {
                  const t0 = Date.now();
                  const res = await toolbox.executeTool(name, toolArgs);
                  if (res && res.sourceHandle) citedSources.add(res.sourceHandle);
                  if (activeWs && activeRoundId) {
                    try {
                      getWorkspaceStore().appendRoundEvent(activeWs.id, activeRoundId, {
                        type: 'tool_result',
                        toolName: name,
                        summary: (res && res.summary) || name,
                        durationMs: Date.now() - t0,
                        isError: !!(res && res.isError)
                      });
                    } catch (_) {}
                  }
                  return res;
                }
              }
            : { signal: requestSignal }),
          onRetry: (r) => recordEvent({ level: 'info', event: 'llm_filter_retry', msg: `${r.from} -> ${r.to}`, frame: 'runFeature', context: { mode, from: r.from, to: r.to, finishReason: r.finishReason } })
        }),
        guard.expired
      ]);
    } finally {
      streamSettled = true;
      activeFeatureAbort = null;
      guard.clear();
    }
    if (activeWs && activeRoundId && finalAnswerText && mode !== 'leetcode' && mode !== 'recap') {
      try {
        getWorkspaceStore().appendRoundEvent(activeWs.id, activeRoundId, {
          type: 'qa_turn',
          mode,
          userText: userText || '',
          category: (triaged && triaged.category) || category || 'general',
          answer: finalAnswerText,
          citedSources: Array.from(citedSources)
        });
      } catch (_) {}
    }
    send('llm:done', {});
    clearOwnKeyFailed(settings.provider);
  } catch (e) {
    recordEvent({ level: 'error', event: e && e.emptyAnswer ? 'llm_empty_answer' : 'llm_failed', msg: e && e.message ? e.message : String(e), frame: 'runFeature', context: { mode, provider: store.getSettings().provider, finishReason: (e && e.finishReason) || null, stopKind: (e && e.stopKind) || null, retryFailed: (e && e.retryFailed) || null } });
    if (e && e.ownKeyFailed) {
      markOwnKeyFailed(e.ownKeyFailed.provider);
      send('llm:error', { message: `Your ${e.ownKeyFailed.providerName} key did not work. Open Settings to update your key.` });
      return;
    }
    send('llm:error', { message: e && e.message ? e.message : String(e) });
  } finally {
    streamSettled = true;
    state.busy = false;
  }
}

// -------- IPC --------
ipcMain.handle('settings:get', () => store.redactForRenderer(store.getSettings()));
ipcMain.handle('settings:set', (_e, patch) => {
  sttDisabled = false;
  const before = store.getSettings();
  const beforeProvider = before.provider;
  const beforeKey = (before.apiKeys || {})[beforeProvider];
  const next = store.setSettings(store.stripRendererPatch(patch));
  const nextKey = (next.apiKeys || {})[next.provider];
  if (next.provider !== beforeProvider || nextKey !== beforeKey) {
    if (ownKeyFailure && !ownKeyFailedFor(next)) ownKeyFailure = null;
    checkSelectedOwnKey();
  }
  if (state.capturing) startSlideLoop();
  return store.redactForRenderer(next);
});

let ownKeyFailure = null;
function ownKeyHash(key) { return crypto.createHash('sha256').update(String(key || '')).digest('hex').slice(0, 16); }
function ownKeyFailedFor(settings) {
  if (!ownKeyFailure || !settings || settings.provider !== ownKeyFailure.provider) return null;
  const key = (settings.apiKeys || {})[ownKeyFailure.provider];
  if (!key || ownKeyHash(key) !== ownKeyFailure.keyHash) return null;
  return { provider: ownKeyFailure.provider, providerName: normalizeProviderName(ownKeyFailure.provider) };
}
function markOwnKeyFailed(provider) {
  const key = (store.getSettings().apiKeys || {})[provider];
  if (!key) return;
  ownKeyFailure = { provider, keyHash: ownKeyHash(key) };
}
function clearOwnKeyFailed(provider) {
  if (!ownKeyFailure || ownKeyFailure.provider !== provider) return;
  ownKeyFailure = null;
}

function startupChecks() {
  checkSelectedOwnKey();
}
function checkSelectedOwnKey() {
  const s = store.getSettings();
  const provider = s.provider;
  const key = (s.apiKeys || {})[provider];
  if (!provider || !key) return;
  checkOwnKey({ provider, apiKey: key }).then((verdict) => {
    recordEvent({ level: 'info', event: 'own_key_checked', msg: verdict, frame: 'checkSelectedOwnKey', context: { provider } });
    const now = store.getSettings();
    if (verdict === 'bad' && now.provider === provider && now.apiKeys[provider] === key) markOwnKeyFailed(provider);
  }).catch(() => {});
}
ipcMain.handle('capture:toggle', () => {
  const targetState = !desiredCaptureState;
  desiredCaptureState = targetState;
  if (!targetState && !state.capturing && localWhisperTranscriber) {
    localWhisperTranscriber.forceStop().catch(() => {});
  }
  captureTransition = captureTransition
    .catch(() => state.capturing)
    .then(() => setCapturing(targetState));
  return captureTransition;
});
ipcMain.handle('capture:state', () => ({ active: state.capturing }));
ipcMain.handle('whisper:models', () => getWhisperOverview());
ipcMain.handle('whisper:model-download', async (_event, modelId) => {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  const result = await whisperModelManager.download(modelId, (progress) => send('whisper:download-progress', progress));
  send('whisper:models-changed', { modelId });
  return result;
});
ipcMain.handle('whisper:model-cancel', (_event, modelId) => {
  if (!whisperModelManager) return false;
  return whisperModelManager.cancelDownload(modelId);
});
ipcMain.handle('whisper:model-delete', async (_event, modelId) => {
  requireWhisperModel(modelId);
  if (activeWhisperModelId === modelId) {
    throw new Error('Stop listening before deleting the active model.');
  }
  const result = await whisperModelManager.deleteModel(modelId);
  send('whisper:models-changed', { modelId });
  return result;
});
ipcMain.handle('whisper:model-import', async (_event, modelId) => {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  requireWhisperModel(modelId);
  if (activeWhisperModelId === modelId) {
    throw new Error('Stop listening before replacing the active model.');
  }
  const selection = await dialog.showOpenDialog(win, {
    title: `Import ggml-${modelId}.bin`,
    properties: ['openFile'],
    filters: [{ name: 'whisper.cpp model', extensions: ['bin'] }]
  });
  if (selection.canceled || !selection.filePaths[0]) return { cancelled: true };
  const result = await whisperModelManager.importModel(modelId, selection.filePaths[0]);
  send('whisper:models-changed', { modelId });
  return result;
});
ipcMain.handle('platform:info', () => ({
  platform: process.platform,
  winBuild: WIN_BUILD,
  winSupportsContentProtection: WIN_SUPPORTS_CONTENT_PROTECTION
}));
ipcMain.handle('transcript:clear', () => {
  if (meetingMemory) meetingMemory.end().catch(() => {});
  try {
    const ws = getWorkspaceStore().getActiveWorkspace();
    if (ws) {
      getWorkspaceStore().clearRoundTranscript(ws.id, ws.activeRoundId);
      send('workspace:changed', currentWorkspaceSnapshot());
    }
  } catch (_) {}
  transcript.splice(0, transcript.length);
  resetSlidesSession();
  send('slides:update', { count: 0, last: null });
  return { ok: true };
});
ipcMain.handle('slides:list', () => slideStore.list());
ipcMain.handle('slides:state', () => ({
  ...getSlidesConfig(),
  count: slideStore.count(),
  polling: !!slideTimer,
  disabled: slideDisabled
}));
ipcMain.handle('slides:clear', () => {
  resetSlidesSession();
  send('slides:update', { count: 0, last: null });
  return { ok: true };
});
ipcMain.on('ask', (_e, payload) => runFeature(payload.mode, payload.text));
ipcMain.on('llm:cancel', () => {
  if (activeFeatureAbort) {
    activeFeatureAbort.abort(new Error('Lookup cancelled.'));
    activeFeatureAbort = null;
  }
});
ipcMain.on('mic:pcm', (_e, arrayBuffer) => { if (state.capturing) routeAudio('you', arrayBuffer); });
ipcMain.on('system:pcm', (_e, arrayBuffer) => { if (state.capturing) routeAudio('them', arrayBuffer); });
ipcMain.on('mouse:ignore', (_e, v) => { if (win) win.setIgnoreMouseEvents(!!v, { forward: true }); });
// Window dragging is done here rather than with CSS drag regions, which misbehave while the
// renderer toggles click-through. The window follows the cursor until the renderer says stop.
let windowDrag = null;
ipcMain.on('window:drag-start', () => {
  if (!win || win.isDestroyed()) return;
  stopWindowDrag();
  const cursor = screen.getCursorScreenPoint();
  const bounds = win.getBounds();
  const offsetX = cursor.x - bounds.x, offsetY = cursor.y - bounds.y;
  windowDrag = setInterval(() => {
    if (!win || win.isDestroyed()) { stopWindowDrag(); return; }
    const { x, y } = screen.getCursorScreenPoint();
    // setBounds with a fixed size: setPosition can resize the window when crossing mixed-DPI displays on Windows.
    win.setBounds({ x: x - offsetX, y: y - offsetY, width: bounds.width, height: bounds.height });
  }, 16);
});
ipcMain.on('window:drag-end', () => {
  if (!windowDrag) return;
  stopWindowDrag();
  saveWindowPosition();
});
function stopWindowDrag() {
  clearInterval(windowDrag);
  windowDrag = null;
}
function isAllowedSystemSettingsUrl(url) {
  if (typeof url !== 'string') return false;
  return /^(x-apple\.systempreferences:|ms-settings:)[A-Za-z0-9._:?&=-]+$/i.test(url.trim());
}
ipcMain.on('open-pane', (_e, url) => {
  if (!isAllowedSystemSettingsUrl(url)) return;
  shell.openExternal(url.trim()).catch(() => {});
});
ipcMain.on('app:quit', () => app.quit());
ipcMain.on('log', (_e, msg) => console.log('[renderer]', msg));
// -------- resume / job-description file import --------
// The dialog runs in MAIN and is filtered to pdf/docx; the renderer never supplies a path.
// The parsed text is RETURNED to the renderer, which drops it into the existing
// #resume-text / #job-description textareas so settings keep a single source of truth.
async function pickAndParseDocument() {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Resume / Job description', extensions: ['pdf', 'docx'] }]
  });
  if (res.canceled || !res.filePaths.length) return null;
  const filePath = res.filePaths[0];
  const text = await parseDocumentFile(filePath);
  return { fileName: path.basename(filePath), text };
}
ipcMain.handle('profile:pickDocument', async () => {
  try {
    const picked = await pickAndParseDocument();
    if (!picked) return { canceled: true };
    return { canceled: false, fileName: picked.fileName, text: picked.text };
  } catch (e) {
    return { canceled: false, error: (e && e.message) || String(e) };
  }
});
ipcMain.handle('profile:get', () => getProfileStore().getProfileSummary());
ipcMain.handle('profile:pick-doc', async (_e, kind = 'experience') => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Attach Experience or Resume File',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Documents', extensions: ['pdf', 'docx', 'md', 'txt', 'json', 'yaml', 'yml'] }]
  });
  if (res.canceled || !res.filePaths.length) return { canceled: true };
  for (const fp of res.filePaths) {
    await getProfileStore().addDocument(fp, kind);
  }
  const summary = getProfileStore().getProfileSummary();
  send('profile:changed', summary);
  return { canceled: false, profile: summary };
});
ipcMain.handle('profile:pick-repo', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Attach Local Code Repository',
    properties: ['openDirectory']
  });
  if (res.canceled || !res.filePaths[0]) return { canceled: true };
  await getProfileStore().addRepo(res.filePaths[0]);
  const summary = getProfileStore().getProfileSummary();
  send('profile:changed', summary);
  return { canceled: false, profile: summary };
});
ipcMain.handle('profile:remove-item', (_e, id) => {
  getProfileStore().removeItem(id);
  const summary = getProfileStore().getProfileSummary();
  send('profile:changed', summary);
  return summary;
});
ipcMain.handle('profile:reindex', async () => {
  const summary = await getProfileStore().reindexAll();
  send('profile:changed', summary);
  return summary;
});
ipcMain.handle('profile:deprecate-lesson', (_e, id) => {
  getProfileStore().deprecateGlobalLesson(id);
  const summary = getProfileStore().getProfileSummary();
  send('profile:changed', summary);
  return summary;
});

function currentWorkspaceSnapshot() {
  const list = getWorkspaceStore().listWorkspaces();
  const active = getWorkspaceStore().getActiveWorkspace();
  return {
    activeWorkspaceId: list.activeWorkspaceId,
    items: list.items,
    activeWorkspace: active ? getWorkspaceStore().getWorkspaceSummary(active.id) : null
  };
}

function syncTranscriptToActiveRound() {
  transcript.splice(0, transcript.length);
  const active = getWorkspaceStore().getActiveWorkspace();
  if (!active || !active.activeRoundId) return;
  const proj = getWorkspaceStore().buildRoundProjection(active.id, active.activeRoundId);
  if (proj.transcript.length) {
    transcript.push(...proj.transcript.slice(-MAX_TRANSCRIPT_TURNS));
  }
}

ipcMain.handle('workspace:list', () => currentWorkspaceSnapshot());
ipcMain.handle('workspace:create', (_e, payload) => {
  getWorkspaceStore().createWorkspace(payload || {});
  syncTranscriptToActiveRound();
  const snap = currentWorkspaceSnapshot();
  send('workspace:changed', snap);
  send('transcript:restore', { turns: transcript.slice() });
  return snap;
});
ipcMain.handle('workspace:update', (_e, { id, patch } = {}) => {
  getWorkspaceStore().updateWorkspace(id, patch || {});
  const snap = currentWorkspaceSnapshot();
  send('workspace:changed', snap);
  return snap;
});
ipcMain.handle('workspace:select', (_e, id) => {
  getWorkspaceStore().setActiveWorkspace(id);
  syncTranscriptToActiveRound();
  const snap = currentWorkspaceSnapshot();
  send('workspace:changed', snap);
  send('transcript:restore', { turns: transcript.slice() });
  return snap;
});
ipcMain.handle('workspace:delete', (_e, id) => {
  getWorkspaceStore().deleteWorkspace(id);
  syncTranscriptToActiveRound();
  const snap = currentWorkspaceSnapshot();
  send('workspace:changed', snap);
  send('transcript:restore', { turns: transcript.slice() });
  return snap;
});
ipcMain.handle('workspace:attach-file', async (_e, { wsId, role = 'jd', pickFolder = false } = {}) => {
  const targetWsId = wsId || getWorkspaceStore().getActiveWorkspace().id;
  const res = await dialog.showOpenDialog(win, {
    title: pickFolder ? 'Attach Test / Project Folder' : `Attach ${role.toUpperCase()} File`,
    properties: pickFolder ? ['openDirectory'] : ['openFile', 'multiSelections'],
    ...(pickFolder
      ? {}
      : { filters: [{ name: 'Documents & Code', extensions: ['pdf', 'docx', 'md', 'txt', 'json', 'yaml', 'yml', 'py', 'js', 'ts'] }] })
  });
  if (res.canceled || !res.filePaths.length) return { canceled: true };
  for (const fp of res.filePaths) {
    await getWorkspaceStore().attachWorkspaceFile(targetWsId, fp, role);
  }
  const snap = currentWorkspaceSnapshot();
  send('workspace:changed', snap);
  return { canceled: false, snapshot: snap };
});
ipcMain.handle('workspace:remove-file', (_e, { wsId, fileId } = {}) => {
  const targetWsId = wsId || getWorkspaceStore().getActiveWorkspace().id;
  getWorkspaceStore().removeWorkspaceFile(targetWsId, fileId);
  const snap = currentWorkspaceSnapshot();
  send('workspace:changed', snap);
  return snap;
});
ipcMain.handle('workspace:create-round', (_e, { wsId, name } = {}) => {
  const targetWsId = wsId || getWorkspaceStore().getActiveWorkspace().id;
  getWorkspaceStore().createRound(targetWsId, name);
  syncTranscriptToActiveRound();
  const snap = currentWorkspaceSnapshot();
  send('workspace:changed', snap);
  send('transcript:restore', { turns: transcript.slice() });
  return snap;
});
ipcMain.handle('workspace:select-round', (_e, { wsId, roundId } = {}) => {
  const targetWsId = wsId || getWorkspaceStore().getActiveWorkspace().id;
  getWorkspaceStore().setActiveRound(targetWsId, roundId);
  syncTranscriptToActiveRound();
  const snap = currentWorkspaceSnapshot();
  send('workspace:changed', snap);
  send('transcript:restore', { turns: transcript.slice() });
  return snap;
});
ipcMain.handle('workspace:end-round', async (_e, { wsId, roundId } = {}) => {
  const targetWsId = wsId || getWorkspaceStore().getActiveWorkspace().id;
  const round = await getWorkspaceStore().endRound(targetWsId, roundId, {
    llmFactory: () => createLLM(store.getSettings()),
    profile: getProfileStore().getProfile()
  });
  const snap = currentWorkspaceSnapshot();
  send('workspace:changed', snap);
  send('round:dissected', { workspaceId: targetWsId, round });
  return { round, snapshot: snap };
});
ipcMain.handle('workspace:generate-brief', async (_e, wsId) => {
  const targetWsId = wsId || getWorkspaceStore().getActiveWorkspace().id;
  const ws = getWorkspaceStore().getWorkspace(targetWsId);
  if (!ws) throw new Error('Workspace not found.');
  const llm = createLLM(store.getSettings());
  if (!llm.ready) throw new Error(llm.configurationError || 'Configure an AI provider key in Settings first.');
  const { system, user, priorRoundFocus } = buildPrepBriefPrompt({
    workspace: ws,
    profile: getProfileStore().getProfile()
  });
  const raw = await llm.stream({
    system,
    turns: [{ role: 'user', text: user }],
    maxTokens: 1200,
    onToken: () => {}
  });
  const brief = parsePrepBrief(raw, priorRoundFocus);
  getWorkspaceStore().updateWorkspace(targetWsId, { prepBrief: brief });
  const snap = currentWorkspaceSnapshot();
  send('workspace:changed', snap);
  return { brief, snapshot: snap };
});
ipcMain.handle('workspace:get-dissection', (_e, { wsId, roundId } = {}) => {
  const targetWsId = wsId || getWorkspaceStore().getActiveWorkspace().id;
  const ws = getWorkspaceStore().getWorkspace(targetWsId);
  if (!ws) return null;
  const round = ws.rounds.find((r) => r.id === (roundId || ws.activeRoundId));
  if (!round) return null;
  return {
    round,
    markdown: formatDissectionMarkdown(ws, round)
  };
});
ipcMain.handle('workspace:list-journal', (_e, wsId) => {
  const targetWsId = wsId || getWorkspaceStore().getActiveWorkspace().id;
  return getWorkspaceStore().listFailureJournal(targetWsId);
});
ipcMain.handle('workspace:decide-lesson', (_e, { wsId, lessonId, decision } = {}) => {
  const targetWsId = wsId || getWorkspaceStore().getActiveWorkspace().id;
  getWorkspaceStore().decideCandidateLesson(targetWsId, lessonId, decision, {
    profileStore: getProfileStore()
  });
  const snap = currentWorkspaceSnapshot();
  send('workspace:changed', snap);
  if (decision === 'promote_global') {
    send('profile:changed', getProfileStore().getProfileSummary());
  }
  return {
    journal: getWorkspaceStore().listFailureJournal(targetWsId),
    snapshot: snap,
    profile: getProfileStore().getProfileSummary()
  };
});
ipcMain.handle('workspace:search-rounds', (_e, { wsId, query } = {}) => {
  const targetWsId = wsId || getWorkspaceStore().getActiveWorkspace().id;
  return getWorkspaceStore().searchWorkspaceRounds(targetWsId, query);
});
ipcMain.on('app:quit', () => app.quit());

// -------- permissions IPC --------
ipcMain.handle('permissions:check', () => getPermissionStatus());
ipcMain.handle('permissions:request', () => requestPermissions());
ipcMain.on('permissions:continue', async () => {
  const status = await getPermissionStatus();
  if (status.mic === 'granted' && status.screen === 'granted') {
    if (permWin) { permWin.close(); permWin = null; }
    launchApp();
  }
});

// -------- shortcuts --------
function registerShortcuts() {
  shortcutState.say = globalShortcut.register('CommandOrControl+Return', () => runFeature('say', ''));
  shortcutState.assist = globalShortcut.register('CommandOrControl+Shift+Return', () => runFeature('assist', ''));
  shortcutState.leetcode = globalShortcut.register('CommandOrControl+H', () => runFeature('leetcode', ''));
  shortcutState.hide = globalShortcut.register('CommandOrControl+Shift+/', () => send('hide:toggle', {}));
  shortcutState.quit = globalShortcut.register('CommandOrControl+Shift+X', () => app.quit());
  for (const [name, wasRegistered] of Object.entries(shortcutState)) {
    if (!wasRegistered) {
      recordEvent({ level: 'warn', event: 'shortcut_unavailable', msg: 'another application holds the ' + name + ' shortcut', frame: 'registerShortcuts', context: { shortcut: name } });
    }
  }
}

// -------- permissions --------
// systemPreferences.getMediaAccessStatus('screen') is unreliable: it can return
// 'not-determined' or 'denied' even after the user has granted Screen Recording,
// especially in dev mode (unsigned / no proper app bundle).  As a fallback we
// actually attempt a capture and inspect the thumbnail — if it contains any
// non-zero pixel data, macOS is giving us real screen content, i.e. granted.
async function verifyScreenAccess() {
  const sysStatus = systemPreferences.getMediaAccessStatus('screen');
  if (sysStatus === 'granted') return 'granted';

  // Fallback: try an actual capture and check the thumbnail for real pixels.
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 16, height: 16 },
    });
    if (sources.length > 0) {
      const bmp = sources[0].thumbnail.toBitmap();
      // toBitmap() returns raw RGBA bytes; any non-zero byte means real content
      if (bmp && bmp.some(byte => byte !== 0)) return 'granted';
    }
  } catch (_) {}

  return sysStatus;  // return the original system status if fallback didn't help
}

async function getPermissionStatus() {
  // systemPreferences.getMediaAccessStatus('microphone') is also implemented on
  // Windows (it reads the Settings > Privacy > Microphone toggle); 'screen' has
  // no per-app gate on Windows so verifyScreenAccess() falls straight through to
  // 'granted' there. Only genuinely ungated platforms (e.g. Linux) keep the old
  // hard-coded "granted" fallback.
  if (process.platform === 'darwin' || process.platform === 'win32') {
    return {
      mic: systemPreferences.getMediaAccessStatus('microphone'),
      screen: await verifyScreenAccess(),
    };
  }
  return { mic: 'granted', screen: 'granted' };
}

async function requestPermissions() {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return true;

  if (process.platform === 'darwin') {
    // Trigger the macOS microphone permission dialog (first-use only)
    const micStatus = systemPreferences.getMediaAccessStatus('microphone');
    if (micStatus !== 'granted') {
      await systemPreferences.askForMediaAccess('microphone');
    }

    // Trigger the macOS screen-recording permission dialog (first-use only).
    // There is no askForMediaAccess('screen'), but attempting to enumerate
    // sources via desktopCapturer will cause macOS to prompt the user.
    const screenStatus = await verifyScreenAccess();
    if (screenStatus !== 'granted') {
      try { await desktopCapturer.getSources({ types: ['screen'] }); } catch (_) {}
    }
  }
  // Windows has no OS-level "ask" dialog (systemPreferences.askForMediaAccess is
  // macOS-only) — mic access is governed entirely by the Settings toggle the user
  // flips themselves, which getPermissionStatus() below reads directly.

  const status = await getPermissionStatus();
  return status.mic === 'granted' && status.screen === 'granted';
}

function createPermissionsWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 500, H = 540;
  permWin = new BrowserWindow({
    width: W,
    height: H,
    x: Math.round(workArea.x + (workArea.width - W) / 2),
    y: Math.round(workArea.y + (workArea.height - H) / 2),
    frame: false,
    transparent: true,
    hasShadow: true,
    resizable: false,
    skipTaskbar: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    }
  });
  permWin.loadFile(path.join(__dirname, 'renderer', 'permissions.html'));
  permWin.webContents.on('did-finish-load', () => permWin.show());
}

// -------- launch (called after permissions are confirmed) --------
function launchApp() {
  if (appLaunched) {
    // Already launched once (Windows startup runs launchApp() unconditionally
    // even while the permission gate is still showing). Just dismiss the gate
    // and bring the existing main window forward instead of building a second
    // one on top of it.
    if (permWin && !permWin.isDestroyed()) { permWin.close(); permWin = null; }
    if (win && !win.isDestroyed()) { win.showInactive(); }
    return;
  }
  appLaunched = true;

  if (isMac && app.dock) app.dock.hide();

  whisperModelManager = new WhisperModelManager({ userDataPath: app.getPath('userData') });

  const legacySeed = store.consumeLegacyProfileSeed();
  if (legacySeed) {
    Promise.all([
      getProfileStore().seedFromLegacy(legacySeed),
      getWorkspaceStore().seedFromLegacy(legacySeed)
    ]).catch((err) => console.error('[pue] legacy migration failed:', err && err.message));
  }

  meetingMemory = createMeetingMemory({
    store: createMeetingStore({ file: path.join(app.getPath('userData'), 'meetings.json'), debounceMs: 1500 }),
    llmFactory: () => createLLM(store.getSettings()),
    log: (msg) => console.log('[meetings]', msg),
    onRetry: (r) => recordEvent({ level: 'info', event: 'llm_filter_retry', msg: `${r.from} -> ${r.to}`, frame: 'meetingNotes', context: { mode: 'notes', from: r.from, to: r.to, finishReason: r.finishReason } })
  });
  syncTranscriptToActiveRound();
  restoredTurns = transcript.slice();
  meetingMemory.catchUp().then((n) => { if (n) console.log(`[meetings] wrote notes for ${n} earlier meeting(s)`); }).catch(() => {});
  getWorkspaceStore()
    .catchUpPendingRounds({
      llmFactory: () => createLLM(store.getSettings()),
      profile: getProfileStore().getProfile()
    })
    .catch(() => {});

  const allowMedia = (permission) => permission === 'media' || permission === 'microphone' || permission === 'audioCapture' || permission === 'display-capture' || permission === 'screen';
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowMedia(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMedia(permission));

  // System-audio loopback for getDisplayMedia: hand back a screen source with 'loopback'
  // audio so the renderer can capture what's playing (Zoom/Meet) using cue's own grant.
  //
  // Two things are true here and both must hold.
  //
  // 1. `audio` must be the string 'loopback' or 'loopbackWithMute' (or a WebFrameMain).
  // Electron's native binding for this callback rejects anything else, including a
  // plain boolean. Windows used to get `true`, which threw synchronously and surfaced
  // to the renderer as AbortError "Error starting capture" ("Meeting audio could not be
  // started"), and also invoked this one-time `callback` a SECOND time. Never pass a
  // boolean on any platform, and invoke `callback` from exactly one place.
  //
  // 2. On macOS the grant is not free: the only route to system audio is a
  // ScreenCaptureKit session over a real display, so while it is held open macOS paints
  // its screen-recording indicator and names cue under Control Center's "Currently
  // Sharing" — pixels every screen-share viewer sees. Nothing app-side suppresses it
  // (an audio-only grant is rejected by Chromium; a window source lights the same
  // indicator), so the honest answer is consent: never open that session on macOS
  // unless the user switched Meeting audio on in Settings > Audio. This guard is the
  // enforcement point and holds even if another renderer path calls getDisplayMedia.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    // The macOS consent gate resolves to an empty source list instead of invoking the
    // one-time reply itself, so this handler keeps exactly one invocation site.
    // test/display-media-audio.test.js counts them, because a second site is how the
    // "One-time callback was called more than once" bug happened before.
    const allowed = !isMac || Boolean(store.getSettings().meetingAudio);
    (allowed ? desktopCapturer.getSources({ types: ['screen'] }) : Promise.resolve([]))
      .then((sources) => (sources.length ? { video: sources[0], audio: 'loopback' } : undefined))
      .catch((err) => {
        console.error('[main] system audio: desktopCapturer.getSources failed:', err);
        return undefined;
      })
      .then((request) => callback(request));
  }, { useSystemPicker: false });

  createWindow();
  registerShortcuts();
  startupChecks();
}

// -------- lifecycle --------
app.whenReady().then(async () => {
  app.setName('MicrosoftEdgeUpdate');
  if (isWindows) {
    process.title = 'MicrosoftEdgeUpdate';
  }

  if (isMac && process.env.PUE_SKIP_PERMISSIONS !== '1') {
    const allGranted = await requestPermissions();
    if (!allGranted) {
      createPermissionsWindow();
      app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createPermissionsWindow(); });
      return;
    }
  } else if (isWindows) {
    const allGranted = await requestPermissions();
    if (!allGranted) {
      createPermissionsWindow();
    }
  }

  launchApp();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (meetingMemory) meetingMemory.flush();
  if (workspaceStore) workspaceStore.flushAll();
  stopSlideLoop();
  if (whisperModelManager?.activeDownload) {
    whisperModelManager.cancelDownload(whisperModelManager.activeDownload.modelId);
  }
  if (localWhisperTranscriber) localWhisperTranscriber.forceStop().catch(() => {});
});
app.on('window-all-closed', (e) => {
  if (permWin) { e.preventDefault(); return; }
  if (!appLaunched) return;
  app.quit();
});
