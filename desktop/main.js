'use strict';

const { app, BrowserWindow, clipboard, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { fileURLToPath } = require('node:url');
const { createAudioClassifier } = require('./audio-classifier');
const runtime = app.isPackaged ? {
  transcriberExecutable: path.join(process.resourcesPath, 'transcriber', 'bgm-transcriber.exe'),
  modelPath: path.join(process.resourcesPath, 'model', 'small'),
  ffmpeg: path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe'),
  ffprobe: path.join(process.resourcesPath, 'ffmpeg', 'ffprobe.exe'),
} : {
  ffmpeg: process.env.FFMPEG || 'ffmpeg',
  ffprobe: process.env.FFPROBE || 'ffprobe',
};
runtime.createAudioClassifier = createAudioClassifier;
runtime.vocalModelPath = app.isPackaged ? path.join(process.resourcesPath, 'audio', 'yamnet.tflite') : path.resolve(__dirname, '../runtime/audio/yamnet.tflite');
runtime.libraryCacheDir = process.env.BGM_LIBRARY_CACHE_DIR || path.join(os.homedir(), '.bgm-studio', 'music-library');
if (app.isPackaged) {
  process.env.HF_HUB_OFFLINE = '1';
  process.env.TRANSFORMERS_OFFLINE = '1';
}
const { checkMusicLibrary, diagnostics, episodeDetail, getInfo, inspectBatch, resolveImport, startBatch, stopBatch } = require('./backend/batch-service');
const { RELEASE_URL, createUpdateService } = require('./update-service');
const { schedulePendingUpdateCleanup } = require('./update-cache');

const RENDERER_HTML_PATH = path.resolve(__dirname, 'renderer', 'index.html');
const SAFE_OPEN_EXTENSIONS = new Set([
  '.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v',
  '.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus',
  '.csv', '.json', '.md', '.log',
]);

function isTrustedRendererUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ''));
    return parsed.protocol === 'file:' && path.resolve(fileURLToPath(parsed)).toLowerCase() === RENDERER_HTML_PATH.toLowerCase();
  } catch {
    return false;
  }
}

async function resolveSafeShellTarget(target, { allowDirectory = true, allowAnyExtension = false } = {}) {
  const raw = String(target || '').trim();
  if (!raw || /^(\\\\|\/\/)/.test(raw)) throw new Error('不支持打开空路径或网络共享路径');
  const resolved = path.resolve(raw);
  const stat = await fs.promises.stat(resolved);
  if (stat.isDirectory()) {
    if (!allowDirectory) throw new Error('目标不是允许打开的文件');
    return resolved;
  }
  if (!stat.isFile()) throw new Error('不支持打开该路径类型');
  if (!allowAnyExtension && !SAFE_OPEN_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
    throw new Error('不允许直接打开该类型文件');
  }
  return resolved;
}

function handleTrusted(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    const frameUrl = event.senderFrame?.url || event.sender?.getURL?.() || '';
    if (!isTrustedRendererUrl(frameUrl)) throw new Error('拒绝来自未受信任页面的 IPC 调用');
    return handler(event, ...args);
  });
}

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
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault();
  });
  mainWindow.on('maximize', () => {
    const { width, height } = mainWindow.getContentBounds();
    mainWindow.webContents.setZoomFactor(Math.min(1.35, Math.max(1, Math.min(width / 1440, height / 900))));
  });
  mainWindow.on('unmaximize', () => mainWindow.webContents.setZoomFactor(1));
  mainWindow.loadFile(RENDERER_HTML_PATH);
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
  if (app.isPackaged && !require('../package.json').bgmPreview) {
    schedulePendingUpdateCleanup();
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
  handleTrusted('app:info', async () => ({
    ...await getInfo(runtime),
    version: app.getVersion(),
    update: updateService?.getState() || { status: 'idle', enabled: false, currentVersion: app.getVersion(), version: '', releaseDate: '', releaseNotes: '', sizeBytes: 0, percent: 0, transferred: 0, total: 0, speed: 0, lastCheckedAt: '', errorMessage: '' },
  }));
  handleTrusted('update:state', () => updateService?.getState());
  handleTrusted('update:check', () => updateService?.check({ manual: true }));
  handleTrusted('update:download', () => updateService?.download());
  handleTrusted('update:cancel', () => updateService?.cancelDownload());
  handleTrusted('update:install', () => updateService?.install());
  handleTrusted('update:open-page', async () => {
    await shell.openExternal(RELEASE_URL);
    return { opened: true };
  });
  handleTrusted('window:toggle-maximize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  handleTrusted('dialog:directory', async (_event, title) => {
    const result = await dialog.showOpenDialog(mainWindow, { title: String(title || '选择目录'), properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  handleTrusted('dialog:video-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择一个待配乐视频',
      properties: ['openFile'],
      filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  handleTrusted('batch:inspect', (_event, config) => inspectBatch({ ...config, ...runtime }));
  handleTrusted('music:check', (_event, config) => checkMusicLibrary({ ...config, ...runtime }, (library) => send({ type: 'library-progress', library })));
  handleTrusted('music:review', (_event, config) => require('./backend/batch-service').reviewMusicTrack({ ...config, ...runtime }));
  handleTrusted('music:stop', () => require('./backend/batch-service').stopLibraryAnalysis());
  handleTrusted('paths:import', (_event, input) => resolveImport(input));
  handleTrusted('diagnostics:preview', (_event, config) => diagnostics(config, runtime, { version: app.getVersion(), electron: process.versions.electron }));
  handleTrusted('diagnostics:copy', async (_event, config) => {
    clipboard.writeText(await diagnostics(config, runtime, { version: app.getVersion(), electron: process.versions.electron }));
    return { copied: true };
  });
  handleTrusted('batch:start', async (_event, config) => {
    batchStarting = true;
    try { return await startBatch(config, send, runtime); }
    finally { batchStarting = false; }
  });
  handleTrusted('batch:stop', () => stopBatch());
  handleTrusted('episode:detail', (_event, input) => episodeDetail(input));
  handleTrusted('shell:openPath', async (_event, target) => {
    const safeTarget = await resolveSafeShellTarget(target);
    const error = await shell.openPath(safeTarget);
    if (error) throw new Error(error);
    return { opened: true };
  });
  handleTrusted('shell:showItem', async (_event, target) => {
    const safeTarget = await resolveSafeShellTarget(target, { allowAnyExtension: true });
    shell.showItemInFolder(safeTarget);
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

