'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const runtime = app.isPackaged ? {
  transcriberExecutable: path.join(process.resourcesPath, 'transcriber', 'bgm-transcriber.exe'),
  modelPath: path.join(process.resourcesPath, 'model', 'small'),
  ffmpeg: path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe'),
  ffprobe: path.join(process.resourcesPath, 'ffmpeg', 'ffprobe.exe'),
} : {};
if (app.isPackaged) {
  process.env.HF_HUB_OFFLINE = '1';
  process.env.TRANSFORMERS_OFFLINE = '1';
}
const { episodeDetail, getInfo, inspectBatch, startBatch, stopBatch } = require('./backend/batch-service');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#f4f7fa',
    title: '自动配背景音乐工作台',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.on('maximize', () => {
    const { width, height } = mainWindow.getContentBounds();
    mainWindow.webContents.setZoomFactor(Math.min(1.35, Math.max(1, Math.min(width / 1440, height / 900))));
  });
  mainWindow.on('unmaximize', () => mainWindow.webContents.setZoomFactor(1));
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function send(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('batch:event', event);
}

app.whenReady().then(() => {
  ipcMain.handle('app:info', async () => ({ ...await getInfo(runtime), version: app.getVersion() }));
  ipcMain.handle('window:toggle-maximize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle('dialog:directory', async (_event, title) => {
    const result = await dialog.showOpenDialog(mainWindow, { title: String(title || '选择目录'), properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('dialog:video-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择一个待配乐视频',
      properties: ['openFile'],
      filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('batch:inspect', (_event, config) => inspectBatch({ ...config, ...runtime }));
  ipcMain.handle('batch:start', (_event, config) => startBatch(config, send, runtime));
  ipcMain.handle('batch:stop', () => stopBatch());
  ipcMain.handle('episode:detail', (_event, input) => episodeDetail(input));
  ipcMain.handle('shell:openPath', async (_event, target) => {
    const error = await shell.openPath(path.resolve(String(target || '')));
    if (error) throw new Error(error);
    return { opened: true };
  });
  ipcMain.handle('shell:showItem', (_event, target) => {
    shell.showItemInFolder(path.resolve(String(target || '')));
    return { shown: true };
  });
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

