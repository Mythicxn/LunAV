const { contextBridge, ipcRenderer } = require('electron');

// Buffer thông báo single-instance để không bị mất nếu main gửi trước khi renderer đăng ký callback.
let pendingSingleInstanceNotice = null;
let singleInstanceNoticeCallback = null;
ipcRenderer.on('single-instance-notice', (_e, text) => {
  pendingSingleInstanceNotice = text;
  if (typeof singleInstanceNoticeCallback === 'function') {
    const cb = singleInstanceNoticeCallback;
    singleInstanceNoticeCallback = null;
    const msg = pendingSingleInstanceNotice;
    pendingSingleInstanceNotice = null;
    try { cb(msg); } catch {}
  }
});

contextBridge.exposeInMainWorld('api', {
  quit: () => ipcRenderer.send('quit'),
  onCursor: (cb) => ipcRenderer.on('cursor', (_e, pos) => cb(pos)),
  onDiscordEvent: (cb) => ipcRenderer.on('discord-event', (_e, ev) => cb(ev)),
  onVoiceTurn: (cb) => ipcRenderer.on('voice-turn', (_e, data) => cb(data)),
  onSingleInstanceNotice: (cb) => {
    singleInstanceNoticeCallback = cb;
    if (pendingSingleInstanceNotice != null) {
      const msg = pendingSingleInstanceNotice;
      pendingSingleInstanceNotice = null;
      singleInstanceNoticeCallback = null;
      try { cb(msg); } catch {}
    }
  },
  getState: () => ipcRenderer.invoke('get-state'),
  setLive2DModel: (id) => ipcRenderer.invoke('set-live2d-model', id),
  saveKey: (k) => ipcRenderer.invoke('save-key', k),
  deleteKey: () => ipcRenderer.invoke('delete-key'),
  saveTavilyKey: (k) => ipcRenderer.invoke('save-tavily-key', k),
  deleteTavilyKey: () => ipcRenderer.invoke('delete-tavily-key'),
  chat: (t, opts) => ipcRenderer.invoke('chat', t, opts),
  tts: (t, o) => ipcRenderer.invoke('tts', t, o),
  setVoice: (o) => ipcRenderer.invoke('set-voice', o),
  discordJoin: () => ipcRenderer.invoke('discord-join'),
  discordLeave: () => ipcRenderer.invoke('discord-leave'),
  discordStatus: () => ipcRenderer.invoke('discord-status'),
  ping: () => ipcRenderer.invoke('ping'),
  setWindowSize: (o) => ipcRenderer.invoke('set-window-size', o),
  openDevConsole: () => ipcRenderer.invoke('dev-console-open'),
  clearDevConsole: () => ipcRenderer.invoke('dev-console-clear'),
  devLog: (level, text) => ipcRenderer.invoke('dev-log', { level, text }),
  onDevLog: (cb) => ipcRenderer.on('dev-log', (_e, item) => cb(item)),
  onDevLogBatch: (cb) => ipcRenderer.on('dev-log-batch', (_e, items) => cb(items)),
  onDevLogClear: (cb) => ipcRenderer.on('dev-log-clear', () => cb()),
  getDevConsoleSettings: () => ipcRenderer.invoke('dev-console-get-settings'),
  saveDiscordConfig: (o) => ipcRenderer.invoke('dev-console-save-discord', o),
  setCoordinateDebug: (enabled) => ipcRenderer.invoke('dev-console-set-coordinate-debug', !!enabled),
  onCoordinateDebugSetting: (cb) => ipcRenderer.on('coordinate-debug-setting', (_e, enabled) => cb(!!enabled)),
  getProgramStorage: () => ipcRenderer.invoke('dev-console-storage'),
  clearAll: () => ipcRenderer.invoke('clear-all'),
});
