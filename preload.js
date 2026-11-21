const { contextBridge, ipcRenderer } = require('electron');
const platform = process.platform;

contextBridge.exposeInMainWorld('cue', {
  platform,
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  whisperModels: () => ipcRenderer.invoke('whisper:models'),
  whisperModelDownload: (modelId) => ipcRenderer.invoke('whisper:model-download', modelId),
  whisperModelCancel: (modelId) => ipcRenderer.invoke('whisper:model-cancel', modelId),
  whisperModelDelete: (modelId) => ipcRenderer.invoke('whisper:model-delete', modelId),
  whisperModelImport: (modelId) => ipcRenderer.invoke('whisper:model-import', modelId),
  platformInfo: () => ipcRenderer.invoke('platform:info'),
  ask: (payload) => ipcRenderer.send('ask', payload),
  captureToggle: () => ipcRenderer.invoke('capture:toggle').catch((err) => {
    console.error('[pue] captureToggle error', err);
    return false;
  }),
  captureState: () => ipcRenderer.invoke('capture:state'),
  micPcm: (arrayBuffer) => ipcRenderer.send('mic:pcm', arrayBuffer),
  systemPcm: (arrayBuffer) => ipcRenderer.send('system:pcm', arrayBuffer),
  setIgnoreMouse: (v) => ipcRenderer.send('mouse:ignore', v),
  windowDragStart: () => ipcRenderer.send('window:drag-start'),
  windowDragEnd: () => ipcRenderer.send('window:drag-end'),
  clearTranscript: () => ipcRenderer.invoke('transcript:clear'),
  slidesList: () => ipcRenderer.invoke('slides:list'),
  slidesState: () => ipcRenderer.invoke('slides:state'),
  slidesClear: () => ipcRenderer.invoke('slides:clear'),
  openPane: (url) => ipcRenderer.send('open-pane', url),
  pickProfileDocument: () => ipcRenderer.invoke('profile:pickDocument'),
  profileGet: () => ipcRenderer.invoke('profile:get'),
  profileAddDoc: (kind) => ipcRenderer.invoke('profile:pick-doc', kind),
  profileAddRepo: () => ipcRenderer.invoke('profile:pick-repo'),
  profileRemoveItem: (id) => ipcRenderer.invoke('profile:remove-item', id),
  profileReindex: () => ipcRenderer.invoke('profile:reindex'),
  profileDeprecateLesson: (id) => ipcRenderer.invoke('profile:deprecate-lesson', id),
  quit: () => ipcRenderer.send('app:quit'),
  permissionsCheck: () => ipcRenderer.invoke('permissions:check'),
  permissionsRequest: () => ipcRenderer.invoke('permissions:request'),
  permissionsContinue: () => ipcRenderer.send('permissions:continue'),
  log: (msg) => ipcRenderer.send('log', msg),
  on: (channel, cb) => {
    const allowed = [
      'capture:state',
      'llm:start',
      'llm:thinking',
      'llm:token',
      'llm:done',
      'llm:error',
      'status',
      'transcript',
      'transcript:restore',
      'stt:interim',
      'stt:final',
      'stt:status',
      'vad:state',
      'hide:toggle',
      'whisper:download-progress',
      'whisper:models-changed',
      'slides:update',
      'profile:changed'
    ];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, data) => cb(data));
  }
});
