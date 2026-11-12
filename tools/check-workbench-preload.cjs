'use strict';

const { contextBridge } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv.find((arg) => arg.startsWith('--bgm-test-root=')).slice('--bgm-test-root='.length);
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixture.json'), 'utf8'));
let batchListener;
let updateListener;
let finishLibrary;
let delayInspect = false;
let finishInspect;
const calls = [];

contextBridge.exposeInMainWorld('bgmStudio', {
  appInfo: async () => fixture.info,
  inspectBatch: async (config) => {
    calls.push({ action: 'inspect', config });
    const batch = structuredClone(fixture.batch);
    if (delayInspect) { delayInspect = false; await new Promise((resolve) => { finishInspect = resolve; }); }
    return { ...batch, config, rows: config.videos ? batch.rows : [], inputVideoCount: config.videos ? 60 : 0 };
  },
  episodeDetail: async () => fixture.detail,
  startBatch: async (config) => { calls.push({ action: 'start', config }); return { started: true, run: fixture.info.run }; },
  stopBatch: async () => { calls.push({ action: 'stop' }); return { stopped: true }; },
  chooseDirectory: async () => null,
  chooseVideoFile: async () => null,
  getPathForFile: () => fixture.info.defaults.videos,
  resolveImport: async (input) => ({ key: input.key || 'videos', path: input.path }),
  checkMusicLibrary: async (config) => {
    calls.push({ action: 'library-check', analyze: config.analyzeVocals });
    if (config.analyzeVocals) await new Promise((resolve) => { finishLibrary = resolve; });
    const strict = config.strictInstrumental !== false;
    return { ...fixture.library, strictInstrumental: strict, usable: fixture.library.files.filter((file) => file.playable && file.status !== 'disabled' && (!strict || ['instrumental', 'confirmed'].includes(file.status))).length };
  },
  stopLibraryAnalysis: async () => { calls.push({ action: 'library-stop' }); finishLibrary?.(); return { stopped: true }; },
  reviewMusicTrack: async (input) => {
    calls.push({ action: 'library-review', input });
    const file = fixture.library.files.find((entry) => entry.file === input.file);
    if (input.action === 'confirm') Object.assign(file, { status: 'confirmed', eligible: true });
    if (input.action === 'disable') Object.assign(file, { status: 'disabled', eligible: false });
    if (input.action === 'reset') Object.assign(file, { status: 'unknown', eligible: false });
    if (input.action === 'metadata') Object.assign(file, { cueIn: Number(input.cueIn), intensity: Number(input.intensity) });
    return file;
  },
  previewDiagnostics: async () => '{"隐私":"已脱敏"}',
  copyDiagnostics: async () => { calls.push({ action: 'copy' }); },
  openPath: async (target) => { calls.push({ action: 'open', target }); },
  showItem: async () => {},
  toggleMaximize: async () => {},
  onBatchEvent: (listener) => { batchListener = listener; },
  onUpdateEvent: (listener) => { updateListener = listener; },
});
contextBridge.exposeInMainWorld('workbenchTest', {
  emitBatch: (event) => {
    if (event.run) fixture.info.run = event.run;
    if (['finished', 'stopped', 'error'].includes(event.type)) fixture.info.running = false;
    const row = fixture.batch.rows.find((item) => item.episode === event.episode);
    if (row) Object.assign(row, event);
    batchListener(event);
  },
  emitUpdate: (update) => updateListener(update),
  failPreflight: (fail) => { fixture.batch.warning = fail ? 'delayed preflight failure' : null; fixture.batch.paths.output.status = fail ? 'unavailable' : 'available'; },
  delayInspect: () => { delayInspect = true; },
  releaseInspect: () => { finishInspect?.(); finishInspect = null; },
  unknownLibrary: () => { for (const file of fixture.library.files) Object.assign(file, { status: 'unknown', eligible: false }); },
  calls: () => calls,
});
