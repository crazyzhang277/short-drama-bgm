'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bgmStudio', {
  appInfo: () => ipcRenderer.invoke('app:info'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  chooseDirectory: (title) => ipcRenderer.invoke('dialog:directory', title),
  chooseVideoFile: () => ipcRenderer.invoke('dialog:video-file'),
  inspectBatch: (config) => ipcRenderer.invoke('batch:inspect', config),
  startBatch: (config) => ipcRenderer.invoke('batch:start', config),
  stopBatch: () => ipcRenderer.invoke('batch:stop'),
  episodeDetail: (input) => ipcRenderer.invoke('episode:detail', input),
  openPath: (target) => ipcRenderer.invoke('shell:openPath', target),
  showItem: (target) => ipcRenderer.invoke('shell:showItem', target),
  updateState: () => ipcRenderer.invoke('update:state'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  cancelUpdate: () => ipcRenderer.invoke('update:cancel'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openUpdatePage: () => ipcRenderer.invoke('update:open-page'),
  onBatchEvent: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('batch:event', wrapped);
    return () => ipcRenderer.removeListener('batch:event', wrapped);
  },
  onUpdateEvent: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('update:event', wrapped);
    return () => ipcRenderer.removeListener('update:event', wrapped);
  },
});
