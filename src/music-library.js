'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');

const ANALYSIS_VERSION = 'yamnet-1-mediapipe-1.2.2-full-v3';
// shortcut: thresholds calibrated on this library's initial samples; expand the labeled set before relaxing strict screening.
const ANALYSIS_SETTINGS = { vocalThreshold: 0.04, uncertainThreshold: 0.015, musicThreshold: 0.15, chunkSeconds: 28.8, aggregateSeconds: 3 };
const MODEL_SHA256 = '4d8b4a53282dc83ef04e3e7dbc4fbc98082e34e44ed798e16c3a0cdd4c584faf';
const VOCAL_LABEL = /^(speech|child speech.*|conversation|narration.*|babbling|speech synthesizer|shout.*|yell|screaming|whisper.*|laughter|giggle|chuckle.*|snicker|belly laugh|crying.*|sobbing|wail.*|singing|choir|yodeling|chant|mantra|rapping|humming|vocal music|a capella)$/i;

function cachePath(music, options = {}) {
  const key = createHash('sha256').update(path.resolve(music).toLowerCase()).digest('hex');
  return path.join(options.libraryCacheDir || path.join(os.homedir(), '.bgm-studio', 'music-library'), key + '.json');
}

async function readLibrary(music, options = {}) {
  try {
    const data = JSON.parse(await fs.readFile(cachePath(music, options), 'utf8'));
    if (!data.files || typeof data.files !== 'object' || Array.isArray(data.files)) throw new Error('invalid files');
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, files: {} };
    throw new Error('曲库分析缓存损坏，请备份后修复：' + cachePath(music, options));
  }
}

async function writeLibrary(music, library, options = {}) {
  const target = cachePath(music, options);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target + '.part', JSON.stringify(library, null, 2) + '\n');
  await fs.rename(target + '.part', target);
}

function fingerprint(stat) { return stat.size + ':' + stat.mtimeMs; }

function trackStatus(entry, currentFingerprint) {
  if (entry?.disabled) return 'disabled';
  if (!entry || entry.fingerprint !== currentFingerprint) return 'unknown';
  if (entry.manual === 'instrumental') return 'confirmed';
  const analysis = entry.analysis;
  if (analysis?.version !== ANALYSIS_VERSION || analysis?.modelSha256 !== MODEL_SHA256 || JSON.stringify(analysis?.settings) !== JSON.stringify(ANALYSIS_SETTINGS) || !analysis.complete) return 'unknown';
  return ['instrumental', 'vocal'].includes(analysis.status) ? analysis.status : 'unknown';
}

function summarizeFrames(frames, duration) {
  if (!frames.length || !Number.isFinite(duration) || duration <= 0) throw new Error('模型没有返回有效分析帧');
  const intervals = [];
  let maxVocal = 0;
  let musicFrames = 0;
  const windows = new Map();
  for (const frame of frames) {
    const vocals = frame.categories.filter((category) => VOCAL_LABEL.test(category.label));
    const top = vocals.sort((a, b) => b.score - a.score)[0] || { score: 0, label: '' };
    maxVocal = Math.max(maxVocal, top.score);
    if (frame.categories.some((category) => category.label === 'Music' && category.score >= ANALYSIS_SETTINGS.musicThreshold)) musicFrames += 1;
    if (top.score < ANALYSIS_SETTINGS.uncertainThreshold) continue;
    const start = Math.max(0, Math.min(duration, frame.time));
    const end = Math.min(duration, start + 0.975);
    if (end <= start) continue;
    const key = Math.floor(start / ANALYSIS_SETTINGS.aggregateSeconds);
    const window = windows.get(key);
    if (window) { window.end = Math.max(window.end, end); if (top.score > window.score) { window.score = top.score; window.label = top.label; } }
    else windows.set(key, { start, end, label: top.label, score: top.score });
  }
  for (const window of windows.values()) {
    const { start, end, label, score } = window;
    const previous = intervals.at(-1);
    if (previous && start <= previous.end + 0.1 && previous.label === label) { previous.end = end; previous.score = Math.max(previous.score, score); }
    else intervals.push({ start, end, label, score });
  }
  const status = maxVocal >= ANALYSIS_SETTINGS.vocalThreshold ? 'vocal'
    : maxVocal < ANALYSIS_SETTINGS.uncertainThreshold && musicFrames / frames.length >= 0.5 ? 'instrumental' : 'unknown';
  return { status, maxVocal, musicRatio: musicFrames / frames.length, intervals, frames: frames.length };
}

async function analyzeTrack(file, ffmpeg, classifier, signal) {
  signal?.throwIfAborted();
  const started = Date.now();
  const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  const completion = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code) => code === 0 ? resolve() : reject(new Error('整曲解码失败：' + stderr))); });
  completion.catch(() => {});
  const chunkBytes = Math.round(ANALYSIS_SETTINGS.chunkSeconds * 16000) * 4;
  let pending = Buffer.alloc(0);
  let decoded = 0;
  const frames = [];
  const consume = async (bytes) => {
    signal?.throwIfAborted();
    const result = await classifier.classify(bytes);
    if (!result.length || result.some((frame, index) => !Number.isFinite(frame.time) || frame.time < 0 || (index > 0 && (frame.time < result[index - 1].time || frame.time - result[index - 1].time > 1.01)) || !Array.isArray(frame.categories) || !frame.categories.length || frame.categories.some((category) => !Number.isFinite(category.score) || category.score < 0 || category.score > 1 || typeof category.label !== 'string')) || result[0].time > 0.05 || result.at(-1).time + 0.975 < bytes.length / 64000 - 0.05) throw new Error('模型输出无效或没有覆盖整段音频');
    frames.push(...result.map((frame) => ({ ...frame, time: frame.time + decoded / 64000 })));
    decoded += bytes.length;
  };
  try {
    for await (const bytes of child.stdout) {
      pending = Buffer.concat([pending, bytes]);
      while (pending.length >= chunkBytes) { await consume(pending.subarray(0, chunkBytes)); pending = pending.subarray(chunkBytes); }
    }
    await completion;
    if (pending.length) { if (pending.length % 4) throw new Error('解码数据不完整'); await consume(pending); }
    signal?.throwIfAborted();
    const duration = decoded / 64000;
    return { ...summarizeFrames(frames, duration), complete: true, duration, version: ANALYSIS_VERSION, modelSha256: MODEL_SHA256, settings: ANALYSIS_SETTINGS, elapsedMs: Date.now() - started, analyzedAt: new Date().toISOString() };
  } finally { if (child.exitCode === null) child.kill(); await completion.catch(() => {}); }
}

async function filterLibrary(groups, options = {}, { analyze = false, signal, progress } = {}) {
  const library = await readLibrary(options.music, options);
  const files = [...new Set([...groups.values()].flat())];
  let classifier;
  let initializationError;
  const modelPath = options.vocalModelPath || path.resolve(__dirname, '../runtime/audio/yamnet.tflite');
  const report = [];
  try {
    for (let index = 0; index < files.length; index += 1) {
      signal?.throwIfAborted();
      const file = files[index];
      const currentFingerprint = fingerprint(await fs.stat(file));
      const previous = library.files[file];
      const entry = previous?.fingerprint === currentFingerprint ? previous : { fingerprint: currentFingerprint, disabled: previous?.disabled || false };
      library.files[file] = entry;
      if (analyze && !entry.disabled && entry.manual !== 'instrumental' && trackStatus(entry, currentFingerprint) === 'unknown' && !(entry.analysis?.complete && entry.analysis.version === ANALYSIS_VERSION && entry.analysis.modelSha256 === MODEL_SHA256 && JSON.stringify(entry.analysis.settings) === JSON.stringify(ANALYSIS_SETTINGS))) {
        try {
          if (initializationError) throw initializationError;
          if (!classifier) {
            try {
              if (createHash('sha256').update(await fs.readFile(modelPath)).digest('hex') !== MODEL_SHA256) throw new Error('YAMNet 模型校验失败');
              if (!options.createAudioClassifier) throw new Error('自动人声分析需要桌面版的离线音频组件');
              classifier = await options.createAudioClassifier({ modelPath });
            } catch (error) { initializationError = error; throw error; }
          }
          entry.analysis = await analyzeTrack(file, options.ffmpeg, classifier, signal);
        } catch (error) {
          if (signal?.aborted) throw error;
          entry.analysis = { status: 'unknown', complete: false, reason: error.message, version: ANALYSIS_VERSION, modelSha256: MODEL_SHA256 };
        }
        await writeLibrary(options.music, library, options);
      }
      const status = trackStatus(entry, currentFingerprint);
      const eligible = status !== 'disabled' && (options.strictInstrumental === false || ['confirmed', 'instrumental'].includes(status));
      report.push({ file, ...entry, status, eligible, reason: status === 'disabled' ? '人工禁用' : status === 'confirmed' ? '人工确认纯音乐' : status === 'vocal' ? '检测到疑似人声' : status === 'instrumental' ? '整曲分析为纯音乐候选' : entry.analysis?.reason || '未扫描或证据不确定' });
      progress?.({ checked: index + 1, total: files.length, file, status });
    }
  } finally { classifier?.close(); }
  const metadata = new Map(report.map((entry) => [entry.file, entry]));
  const filtered = new Map([...groups].flatMap(([mood, tracks]) => { const allowed = tracks.filter((file) => metadata.get(file)?.eligible); return allowed.length ? [[mood, allowed]] : []; }));
  return { groups: filtered, files: report, metadata, counts: Object.fromEntries(['confirmed', 'instrumental', 'vocal', 'unknown', 'disabled'].map((status) => [status, report.filter((entry) => entry.status === status).length])) };
}

async function reviewTrack(music, groups, input, options = {}) {
  const file = path.resolve(String(input.file || ''));
  if (![...groups.values()].flat().includes(file)) throw new Error('曲目不属于当前曲库');
  if (!['confirm', 'disable', 'reset', 'metadata'].includes(input.action)) throw new Error('不支持的曲目操作');
  const currentFingerprint = fingerprint(await fs.stat(file));
  const library = await readLibrary(music, options);
  const previous = library.files[file];
  const entry = previous?.fingerprint === currentFingerprint ? previous : { fingerprint: currentFingerprint, disabled: previous?.disabled || false };
  if (input.action === 'confirm') { entry.manual = 'instrumental'; entry.disabled = false; }
  if (input.action === 'disable') entry.disabled = true;
  if (input.action === 'reset') { delete entry.manual; entry.disabled = false; }
  if (input.action === 'metadata') {
    const cueIn = Number(input.cueIn);
    const intensity = Number(input.intensity);
    if (typeof input.cueIn === 'boolean' || !Number.isFinite(cueIn) || cueIn < 0 || cueIn > 86400 || ![1, 2, 3].includes(intensity)) throw new Error('入点须为非负秒数，强度须为 1、2 或 3');
    entry.cueIn = cueIn; entry.intensity = intensity;
  }
  library.files[file] = entry;
  await writeLibrary(music, library, options);
  return entry;
}

module.exports = { ANALYSIS_VERSION, ANALYSIS_SETTINGS, MODEL_SHA256, analyzeTrack, cachePath, filterLibrary, fingerprint, readLibrary, writeLibrary, reviewTrack, summarizeFrames, trackStatus };
