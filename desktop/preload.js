'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('bgmStudio', {
  appInfo: () => ipcRenderer.invoke('app:info'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  chooseDirectory: (title) => ipcRenderer.invoke('dialog:directory', title),
  chooseVideoFile: () => ipcRenderer.invoke('dialog:video-file'),
  inspectBatch: (config) => ipcRenderer.invoke('batch:inspect', config),
  checkMusicLibrary: (config) => ipcRenderer.invoke('music:check', config),
  reviewMusicTrack: (config) => ipcRenderer.invoke('music:review', config),
  stopLibraryAnalysis: () => ipcRenderer.invoke('music:stop'),
  resolveImport: (input) => ipcRenderer.invoke('paths:import', input),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  previewDiagnostics: (config) => ipcRenderer.invoke('diagnostics:preview', config),
  copyDiagnostics: (config) => ipcRenderer.invoke('diagnostics:copy', config),
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
