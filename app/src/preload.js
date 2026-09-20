const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  start: () => ipcRenderer.invoke('queue:start'),
  stop: () => ipcRenderer.invoke('queue:stop'),
  counts: () => ipcRenderer.invoke('queue:counts'),
  reimport: () => ipcRenderer.invoke('queue:reimport'),
  failed: () => ipcRenderer.invoke('queue:failed'),
  retryFailed: () => ipcRenderer.invoke('queue:retryFailed'),
  list: () => ipcRenderer.invoke('queue:list'),
  retryOne: (videoId) => ipcRenderer.invoke('queue:retryOne', videoId),
  deleteVideos: (videoIds) => ipcRenderer.invoke('queue:delete', videoIds),
  addFiles: () => ipcRenderer.invoke('queue:addFiles'),
  openFile: (filePath) => ipcRenderer.invoke('shell:openFile', filePath),
  openUrl: (url) => ipcRenderer.invoke('shell:openUrl', url),
  onLog: (cb) => ipcRenderer.on('queue:log', (_e, line) => cb(line)),
  onState: (cb) => ipcRenderer.on('queue:state', (_e, state) => cb(state)),
  onItem: (cb) => ipcRenderer.on('queue:item', (_e, item) => cb(item)),
});
