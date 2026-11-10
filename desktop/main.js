'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
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
const { RELEASE_URL, createUpdateService } = require('./update-service');

let mainWindow;
let updateService;
let batchStarting = false;

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

function sendUpdate(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('update:event', event);
}

app.whenReady().then(() => {
  if (app.isPackaged) {
    const { CancellationToken, autoUpdater } = require('electron-updater');
    const updateCheckPath = path.join(app.getPath('userData'), 'update-check.json');
    let lastCheckAt = 0;
    try { lastCheckAt = JSON.parse(fs.readFileSync(updateCheckPath, 'utf8')).lastCheckedAt || 0; } catch { /* first launch or invalid local cache */ }
    updateService = createUpdateService({
      updater: autoUpdater,
      currentVersion: app.getVersion(),
      lastCheckAt,
      onCheckAt: (lastCheckedAt) => {
        try { fs.writeFileSync(updateCheckPath, JSON.stringify({ lastCheckedAt })); } catch { /* cache is only for throttling */ }
      },
      createCancellationToken: () => new CancellationToken(),
      isBatchRunning: () => batchStarting || getInfo(runtime).running,
      emit: sendUpdate,
    });
  }
  ipcMain.handle('app:info', async () => ({
    ...await getInfo(runtime),
    version: app.getVersion(),
    update: updateService?.getState() || { status: 'idle', enabled: false, currentVersion: app.getVersion(), version: '', releaseDate: '', releaseNotes: '', sizeBytes: 0, percent: 0, transferred: 0, total: 0, speed: 0, lastCheckedAt: '', errorMessage: '' },
  }));
  ipcMain.handle('update:state', () => updateService?.getState());
  ipcMain.handle('update:check', () => updateService?.check({ manual: true }));
  ipcMain.handle('update:download', () => updateService?.download());
  ipcMain.handle('update:cancel', () => updateService?.cancelDownload());
  ipcMain.handle('update:install', () => updateService?.install());
  ipcMain.handle('update:open-page', async () => {
    await shell.openExternal(RELEASE_URL);
    return { opened: true };
  });
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
  ipcMain.handle('batch:start', async (_event, config) => {
    batchStarting = true;
    try { return await startBatch(config, send, runtime); }
    finally { batchStarting = false; }
  });
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
  if (updateService) {
    const timer = setTimeout(() => updateService.check(), 7000);
    timer.unref?.();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => updateService?.dispose());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

