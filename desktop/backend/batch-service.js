'use strict';

const fs = require('node:fs/promises');
const { constants: fsConstants, createReadStream } = require('node:fs');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { AUDIO_EXTENSIONS, DEFAULT_TRANSITION_FADE_SECONDS, VIDEO_EXTENSIONS, inspectMusicCatalog, runBatch, scanMusic, scanVideos } = require('../../src/mvp');
const { filterLibrary, readLibrary, writeLibrary, reviewTrack } = require('../../src/music-library');

const DEFAULTS = {
  videos: '',
  music: '',
  output: path.join(os.homedir(), 'Documents', '自动配 BGM Studio', 'output'),
  modelPath: process.env.FASTER_WHISPER_MODEL || 'small',
  language: process.env.FASTER_WHISPER_LANGUAGE || 'auto',
  freezeTail: '0:00',
  transitionFadeEnabled: true,
  transitionFadeDuration: DEFAULT_TRANSITION_FADE_SECONDS,
  skipCompleted: true,
  minTracksPerEpisode: 1,
  scenePriority: true,
  strictInstrumental: true,
  autoDuck: true,
  maxTracksPerEpisode: 3,
  outputAudio: true,
  outputVideo: true,
  outputTimeline: true,
  outputTranscript: true,
  ffmpeg: process.env.FFMPEG || 'ffmpeg',
  ffprobe: process.env.FFPROBE || 'ffprobe',
};

let activeRun = null;
let libraryRun = null;
let lastRun = null;
const runLogs = [];
const toolChecks = new Map();
const execFileAsync = promisify(execFile);

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function inspectPath(value, kind) {
  const target = cleanPath(value);
  if (!target) return { status: 'unset', label: '\u672a\u8bbe\u7f6e' };

  let stat;
  try { stat = await fs.stat(target); } catch (error) {
    if (kind !== 'output' || error.code !== 'ENOENT') return { status: 'unavailable', label: '\u4e0d\u53ef\u8bbf\u95ee' };
    let parent = path.dirname(path.resolve(target));
    while (true) {
      try {
        const parentStat = await fs.stat(parent);
        if (!parentStat.isDirectory()) return { status: 'unavailable', label: '\u4e0d\u53ef\u8bbf\u95ee' };
        await fs.access(parent, fsConstants.W_OK);
        return { status: 'available', label: '\u53ef\u521b\u5efa' };
      } catch (parentError) {
        if (parentError.code !== 'ENOENT') return { status: 'unavailable', label: '\u4e0d\u53ef\u8bbf\u95ee' };
        const next = path.dirname(parent);
        if (next === parent) return { status: 'unavailable', label: '\u4e0d\u53ef\u8bbf\u95ee' };
        parent = next;
      }
    }
  }

  if (kind === 'videos' ? !(stat.isDirectory() || (stat.isFile() && VIDEO_EXTENSIONS.has(path.extname(target).toLowerCase()))) : !stat.isDirectory()) {
    return { status: 'unavailable', label: '\u4e0d\u53ef\u8bbf\u95ee' };
  }
  try {
    await fs.access(target, kind === 'output' ? fsConstants.W_OK : fsConstants.R_OK);
    return { status: 'available', label: '\u53ef\u7528' };
  } catch {
    return { status: 'unavailable', label: '\u4e0d\u53ef\u8bbf\u95ee' };
  }
}

async function readJson(filePath, fallback = null) {
  if (!(await exists(filePath))) return fallback;
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')); } catch { return fallback; }
}

function cleanPath(value) { return String(value || '').trim(); }
function asNumber(value, fallback) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }

async function assertRunConfig(input, runtime = {}) {
  const minTracksInput = input?.minTracksPerEpisode;
  const maxTracksInput = input?.maxTracksPerEpisode;
  const rawTransitionFadeDuration = input?.transitionFadeDuration;
  const transitionFadeDuration = rawTransitionFadeDuration === undefined
    ? DEFAULTS.transitionFadeDuration
    : typeof rawTransitionFadeDuration === 'number' ? rawTransitionFadeDuration
      : typeof rawTransitionFadeDuration === 'string' && rawTransitionFadeDuration.trim() !== '' ? Number(rawTransitionFadeDuration) : NaN;
  const config = {
    videos: cleanPath(input?.videos), music: cleanPath(input?.music), output: cleanPath(input?.output),
    transcripts: cleanPath(input?.transcripts) || null, modelPath: cleanPath(runtime.modelPath) || cleanPath(input?.modelPath) || DEFAULTS.modelPath,
    language: cleanPath(input?.language) || 'auto', transcribe: Boolean(input?.transcribe), mood: cleanPath(input?.mood) || null, autoDuck: input?.autoDuck === undefined ? DEFAULTS.autoDuck : input.autoDuck,
    strictInstrumental: input?.strictInstrumental === undefined ? DEFAULTS.strictInstrumental : input.strictInstrumental,
    scenePriority: input?.scenePriority === undefined ? DEFAULTS.scenePriority : input.scenePriority,
    duckDb: asNumber(input?.duckDb, -10), fadeIn: Math.max(0, asNumber(input?.fadeIn, 2)), fadeOut: Math.max(0, asNumber(input?.fadeOut, 2)), freezeTail: cleanPath(input?.freezeTail) || '0:00',
    transitionFadeEnabled: input?.transitionFadeEnabled === undefined ? DEFAULTS.transitionFadeEnabled : input.transitionFadeEnabled,
    transitionFadeDuration,
    skipCompleted: input?.skipCompleted === undefined ? DEFAULTS.skipCompleted : input.skipCompleted,
    minTracksPerEpisode: minTracksInput === undefined ? DEFAULTS.minTracksPerEpisode : String(minTracksInput).trim() ? Number(minTracksInput) : NaN,
    maxTracksPerEpisode: maxTracksInput === undefined ? DEFAULTS.maxTracksPerEpisode : String(maxTracksInput).trim() ? Number(maxTracksInput) : NaN,
    outputAudio: input?.outputAudio !== false, outputVideo: input?.outputVideo !== false,
    outputTimeline: input?.outputTimeline !== false, outputTranscript: input?.outputTranscript !== false,
    overwrite: Boolean(input?.overwrite), ffmpeg: cleanPath(runtime.ffmpeg) || cleanPath(input?.ffmpeg) || DEFAULTS.ffmpeg, ffprobe: cleanPath(runtime.ffprobe) || cleanPath(input?.ffprobe) || DEFAULTS.ffprobe,
    runMode: input?.runMode || 'all', episodeVideoPath: cleanPath(input?.episodeVideoPath),
  };
  for (const key of ['videos', 'music', 'output']) if (!config[key]) throw new Error(`请先选择${key === 'videos' ? '视频目录' : key === 'music' ? 'BGM 目录' : '输出目录'}`);
  if (!['all', 'unfinished', 'failed', 'episode'].includes(config.runMode)) throw new Error('不支持的批次恢复方式');
  if (config.runMode === 'episode' && !config.episodeVideoPath) throw new Error('请先选择需要重新生成的视频');
  if (config.duckDb > 0) throw new Error('对白 ducking 增益必须是 0 或负数');
  if (typeof config.transitionFadeEnabled !== 'boolean') throw new Error('曲目衔接淡入淡出必须使用开关值');
  if (typeof config.scenePriority !== 'boolean') throw new Error('转场必换曲必须使用开关值');
  if (typeof config.skipCompleted !== 'boolean') throw new Error('跳过已完成必须使用开关值');
  if (typeof config.strictInstrumental !== 'boolean' || typeof config.autoDuck !== 'boolean') throw new Error('纯音乐筛选和对白压低必须使用开关值');
  if (!Number.isFinite(config.transitionFadeDuration) || config.transitionFadeDuration < 0) throw new Error('曲目衔接时长必须是非负数字');
  if (!Number.isSafeInteger(config.minTracksPerEpisode) || config.minTracksPerEpisode < 1) throw new Error('每集 BGM 下限必须是正整数');
  if (!Number.isSafeInteger(config.maxTracksPerEpisode) || config.maxTracksPerEpisode < 0) throw new Error('每集 BGM 上限必须是非负整数（0 表示不限制）');
  if (!config.scenePriority && config.maxTracksPerEpisode > 0 && config.minTracksPerEpisode > config.maxTracksPerEpisode) throw new Error('每集 BGM 下限不能高于上限');
  for (const key of ['outputAudio', 'outputVideo', 'outputTimeline', 'outputTranscript']) {
    if (input?.[key] !== undefined && typeof input[key] !== 'boolean') throw new Error('输出内容设置必须使用开关值');
  }
  if (![config.outputAudio, config.outputVideo, config.outputTimeline].some(Boolean) && !(config.outputTranscript && config.transcribe)) throw new Error('请至少选择一种输出内容；单独输出转录文本时需开启本地转录');
  if (!/^\d+:\d+$/.test(config.freezeTail)) throw new Error('片尾定格时长格式应为 秒:帧，例如 2:15');
  if (config.transcribe && !(await exists(config.modelPath))) throw new Error(`模型目录不存在：${config.modelPath}`);
  return config;
}

async function modelInfo(modelPath) {
  const info = { path: modelPath, exists: false, sizeBytes: 0 };
  try {
    if (!(await fs.stat(modelPath)).isDirectory()) return info;
    await fs.access(modelPath, fsConstants.R_OK);
    const files = await fs.readdir(modelPath, { withFileTypes: true, recursive: true });
    const sizes = await Promise.all(files.filter((entry) => entry.isFile()).map(async (entry) => {
      const filePath = path.join(entry.parentPath || modelPath, entry.name);
      return (await fs.stat(filePath)).size;
    }));
    info.sizeBytes = sizes.reduce((total, size) => total + size, 0);
    info.exists = sizes.length > 0 && info.sizeBytes > 0;
  } catch { info.sizeBytes = 0; }
  return info;
}
function summaryByEpisode(summary) {
  const map = new Map();
  for (const item of summary?.results || []) map.set(item.episode, item);
  return map;
}

function stateEpisodes(state) { return state?.episodes && typeof state.episodes === 'object' ? state.episodes : {}; }

async function inspectBatch(input = {}) {
  const config = { ...DEFAULTS, ...input };
  const output = cleanPath(config.output);
  const paths = {
    videos: await inspectPath(config.videos, 'videos'),
    music: await inspectPath(config.music, 'music'),
    output: await inspectPath(output, 'output'),
  };
  const state = output ? await readJson(path.join(output, '.mvp-state.json'), { episodes: {} }) : { episodes: {} };
  const summary = output ? await readJson(path.join(output, 'run-summary.json'), null) : null;
  let videos = [];
  let warning = null;
  if (cleanPath(config.videos)) try { videos = await scanVideos(cleanPath(config.videos)); } catch (error) { warning = error.message; }
  const resultMap = summaryByEpisode(summary);
  const episodes = stateEpisodes(state);
  const known = new Map();
  for (const video of videos) known.set(path.resolve(video).toLowerCase(), { videoPath: video, episode: path.parse(video).name });
  for (const [videoPath] of Object.entries(episodes)) {
    const key = path.resolve(videoPath).toLowerCase();
    if (!known.has(key)) known.set(key, { videoPath, episode: path.parse(videoPath).name });
  }
  for (const item of summary?.results || []) {
    const key = String(item.episode || '');
    if (!key || [...known.values()].some((entry) => entry.episode.toLowerCase() === key.toLowerCase())) continue;
    known.set(key.toLowerCase(), { videoPath: '', episode: key });
  }
  const rows = [...known.values()].sort((a, b) => a.episode.localeCompare(b.episode, 'zh-CN', { numeric: true })).map(({ videoPath, episode }) => {
    const key = videoPath ? path.resolve(videoPath) : Object.keys(episodes).find((candidate) => path.parse(candidate).name === episode);
    const item = { ...((key && episodes[key]) || resultMap.get(episode) || {}) };
    if (['processing', 'checking'].includes(item.status) && (!activeRun || path.resolve(activeRun.config?.output || '.') !== path.resolve(output || '.'))) {
      item.status = 'interrupted';
      item.error = '上次运行未完成，可点击“继续未完成”恢复；原始素材未修改。';
    }
    const sourceVideoPath = videoPath || key || '';
    const extension = path.extname(sourceVideoPath) || '.mp4';
    return { episode, videoPath: sourceVideoPath, status: item.status || 'pending', duration: Number.isFinite(Number(item.duration)) ? Number(item.duration) : null, mood: item.mood || '', moods: item.moods || [], trackCount: item.analysis?.trackCount, tracks: item.tracks || (item.track ? [item.track] : []), outputAudio: item.outputAudio !== false, outputVideo: item.outputVideo !== false, outputTimeline: item.outputTimeline !== false, outputTranscript: item.outputTranscript !== false, transcribe: item.transcribe === undefined ? Boolean(config.transcribe) : Boolean(item.transcribe), outputPath: item.outputAudio === false ? '' : item.outputPath || (output ? path.join(output, `${episode}_bgm.wav`) : ''), finalVideoPath: item.outputVideo === false ? '' : item.finalVideoPath || (output ? path.join(output, `${episode}_final${extension.toLowerCase()}`) : ''), timelinePath: item.outputTimeline === false ? '' : item.timelinePath || (output ? path.join(output, `${episode}_timeline.csv`) : ''), transcriptPath: item.outputTranscript === false ? '' : typeof item.transcriptPath === 'string' ? item.transcriptPath : output ? path.join(output, `${episode}_transcript.json`) : '', error: item.error || '', updatedAt: item.updatedAt || '' };
  });
  let musicGroups = [];
  if (cleanPath(config.music)) try { const groups = await scanMusic(cleanPath(config.music)); musicGroups = [...groups.entries()].map(([mood, tracks]) => ({ mood, count: tracks.length })); } catch (error) { warning ||= error.message; }
  const model = await modelInfo(cleanPath(config.modelPath) || DEFAULTS.modelPath);
  const tools = await inspectTools(config);
  let validationError = '';
  try { await assertRunConfig(config); } catch (error) { validationError = error.message; }
  const { createAudioClassifier, ...publicConfig } = config;
  return { config: { ...publicConfig, output }, state, summary, rows, warning, validationError, active: Boolean(activeRun), run: runSnapshot(), model, musicGroups, paths, tools, inputVideoCount: videos.length, inputVideos: videos, reportPath: output && await exists(path.join(output, 'run-report.md')) ? path.join(output, 'run-report.md') : '', errorLogPath: output && await exists(path.join(output, 'run-errors.log')) ? path.join(output, 'run-errors.log') : '' };
}

async function inspectTools(config) {
  return Object.fromEntries(await Promise.all(['ffmpeg', 'ffprobe'].map(async (key) => {
    const command = cleanPath(config[key]) || DEFAULTS[key];
    if (!toolChecks.has(command)) toolChecks.set(command, execFileAsync(command, ['-version'], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 }).then(({ stdout }) => ({ available: true, version: stdout.match(/version\s+(\S+)/)?.[1] || '可用' }), () => ({ available: false, version: '' })));
    const result = await toolChecks.get(command);
    if (!result.available) toolChecks.delete(command);
    return [key, result];
  })));
}

async function checkMusicLibrary(input = {}, progress) {
  if (activeRun || libraryRun) throw new Error('已有批次或曲库分析正在运行');
  const controller = new AbortController();
  libraryRun = controller;
  try { return await inspectLibrary(input, progress, controller.signal); }
  finally { libraryRun = null; }
}

async function inspectLibrary(input, progress, signal) {
  const config = { ...DEFAULTS, ...input };
  const music = cleanPath(config.music);
  if (!music || (await inspectPath(music, 'music')).status !== 'available') throw new Error('音乐目录不可读取，请重新选择；原始素材未修改。');
  let groups = new Map();
  try { groups = await scanMusic(music); } catch (error) { if (!error.message.startsWith('BGM 目录没有找到音频文件')) throw error; }
  const directories = (await fs.readdir(music, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const cached = await readLibrary(music, config);
  const healthState = { musicCatalog: cached.health || {} };
  const inspected = await inspectMusicCatalog(groups, config.ffprobe, config.ffmpeg, signal, healthState, true);
  const vocal = await filterLibrary(inspected.groups, { ...config, music }, { analyze: Boolean(input.analyzeVocals), signal, progress });
  const library = await readLibrary(music, config);
  library.health = healthState.musicCatalog;
  await writeLibrary(music, library, config);
  const hashes = new Map();
  const duplicates = [];
  for (const entry of inspected.files) {
    signal?.throwIfAborted();
    try {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(entry.file)) hash.update(chunk);
      const digest = hash.digest('hex');
      if (hashes.has(digest)) duplicates.push({ file: entry.file, original: hashes.get(digest) });
      else hashes.set(digest, entry.file);
    } catch { entry.playable = false; entry.reason = '文件无法读取'; }
  }
  const musicGroups = [...groups].map(([mood, tracks]) => ({ mood, count: tracks.length, usable: tracks.filter((file) => inspected.files.find((entry) => entry.file === file)?.playable && vocal.metadata.get(file)?.eligible).length }));
  const files = inspected.files.map((entry) => ({ ...vocal.metadata.get(entry.file), ...entry, reason: entry.reason || vocal.metadata.get(entry.file)?.reason || '', eligible: Boolean(entry.playable && vocal.metadata.get(entry.file)?.eligible), fileUrl: pathToFileURL(entry.file).href, tooShort: Number.isFinite(entry.duration) && entry.duration < 2 }));
  return { total: inspected.checked, usable: files.filter((entry) => entry.eligible).length, playable: files.filter((entry) => entry.playable).length, counts: vocal.counts, strictInstrumental: config.strictInstrumental !== false, musicGroups, emptyDirectories: directories.filter((name) => !groups.has(name)), unavailableMoods: musicGroups.filter((group) => !group.usable).map((group) => group.mood), duplicates, files, checkedAt: new Date().toISOString() };
}

async function reviewMusicTrack(input = {}) {
  if (activeRun || libraryRun) throw new Error('请等待批次或曲库分析结束后再修改曲目');
  libraryRun = new AbortController();
  try {
  const music = cleanPath(input.music);
  const groups = await scanMusic(music);
  if (input.action === 'metadata') {
    if (![...groups.values()].flat().includes(path.resolve(String(input.file || '')))) throw new Error('曲目不属于当前曲库');
    const { stdout } = await execFileAsync(cleanPath(input.ffprobe) || DEFAULTS.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', input.file], { windowsHide: true });
    if (Number(input.cueIn) >= Number(JSON.parse(stdout).format?.duration)) throw new Error('音乐入点须小于曲目时长');
  }
  await reviewTrack(music, groups, input, input);
  const result = await filterLibrary(new Map([['reviewed', [path.resolve(input.file)]]]), { ...input, music });
  return result.files[0];
  } finally { libraryRun = null; }
}

function stopLibraryAnalysis() { libraryRun?.abort(); return { stopped: Boolean(libraryRun) }; }

async function resolveImport(input = {}) {
  const target = cleanPath(input.path);
  const key = input.key || '';
  if (!target || (key && !['videos', 'music', 'output', 'transcripts', 'modelPath'].includes(key))) throw new Error('拖入路径或用途无效');
  const stat = await fs.stat(target);
  const extension = path.extname(target).toLowerCase();
  if (key) {
    if (!stat.isDirectory() && !(key === 'videos' && stat.isFile() && VIDEO_EXTENSIONS.has(extension)) && !(key === 'music' && stat.isFile() && AUDIO_EXTENSIONS.has(extension))) throw new Error('请拖入对应目录；视频栏也接受单个视频，音乐栏也接受音频文件。');
    return { key, path: key === 'music' && stat.isFile() ? path.dirname(target) : target };
  }
  if (stat.isFile() && VIDEO_EXTENSIONS.has(extension)) return { key: 'videos', path: target };
  if (stat.isFile() && AUDIO_EXTENSIONS.has(extension)) return { key: 'music', path: path.dirname(target) };
  if (!stat.isDirectory()) throw new Error('请拖入视频、音频或目录，字幕和模型目录可拖到对应路径栏。');
  const entries = await fs.readdir(target, { withFileTypes: true });
  if (entries.some((entry) => entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))) return { key: 'videos', path: target };
  if (entries.some((entry) => entry.isFile() && entry.name === 'model.bin')) return { key: 'modelPath', path: target };
  try { await scanMusic(target); return { key: 'music', path: target }; } catch { /* An empty directory is a useful output target. */ }
  if (entries.some((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.json')) return { key: 'transcripts', path: target };
  return { key: 'output', path: target };
}

function errorCategory(message) {
  const text = String(message || '');
  return !text ? '无' : /覆盖|已存在/.test(text) ? '输出文件冲突' : /模型|转录/.test(text) ? '转录组件或模型不可用' : /ENOENT|ffmpeg|ffprobe/.test(text) ? '媒体文件或处理组件不可用' : /EACCES|EPERM|权限/.test(text) ? '文件访问权限不足' : /中断|停止/.test(text) ? '用户停止' : '处理失败，请在本机查看错误日志';
}

async function diagnostics(input = {}, runtime = {}, versions = {}) {
  const config = { ...DEFAULTS, ...input, ...runtime };
  const [tools, model] = await Promise.all([inspectTools(config), modelInfo(cleanPath(config.modelPath) || DEFAULTS.modelPath)]);
  const settings = Object.fromEntries(['transcribe', 'autoDuck', 'scenePriority', 'overwrite', 'skipCompleted', 'outputAudio', 'outputVideo', 'outputTimeline', 'outputTranscript'].map((key) => [key, Boolean(config[key])]));
  for (const key of ['duckDb', 'fadeIn', 'fadeOut', 'transitionFadeDuration', 'minTracksPerEpisode', 'maxTracksPerEpisode']) settings[key] = Number.isFinite(Number(config[key])) ? Number(config[key]) : '未设置';
  settings.transitionFadeEnabled = config.transitionFadeEnabled !== false;
  settings.freezeTail = /^\d+:\d+$/.test(config.freezeTail) ? config.freezeTail : '无效或未设置';
  return JSON.stringify({ 软件版本: versions.version || require('../../package.json').version, Node: process.version, Electron: versions.electron || process.versions.electron || '未启动桌面运行时', 系统: process.platform, FFmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, 转录模型: { ready: model.exists, sizeBytes: model.sizeBytes }, 路径配置: Object.fromEntries(['videos', 'music', 'output', 'transcripts'].map((key) => [key, Boolean(cleanPath(config[key]))])), 配置摘要: settings, 最近错误: errorCategory([...runLogs].reverse().find((entry) => entry.level === 'error')?.message), 隐私: '已省略用户目录、素材文件名、转录内容和原始错误文本' }, null, 2);
}

function parseCsvLine(line) {
  const values = []; let value = ''; let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') { if (quoted && line[i + 1] === '"') { value += '"'; i += 1; } else quoted = !quoted; }
    else if (char === ',' && !quoted) { values.push(value); value = ''; } else value += char;
  }
  values.push(value); return values;
}
function parseCsv(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.length);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => Object.fromEntries(parseCsvLine(line).map((value, index) => [headers[index], value])));
}

async function episodeDetail(input = {}) {
  const output = cleanPath(input.output);
  const episode = cleanPath(input.episode);
  if (!output || !episode) throw new Error('缺少输出目录或集数');
  const state = await readJson(path.join(output, '.mvp-state.json'), { episodes: {} });
  const stateEntry = Object.values(stateEpisodes(state)).find((item) => item.episode === episode)
    || Object.values(stateEpisodes(state)).find((item) => path.parse(item.outputPath || '').name === `${episode}_bgm`)
    || Object.values(stateEpisodes(state)).find((item) => path.parse(item.timelinePath || '').name === `${episode}_timeline`)
    || {};
  const outputPath = stateEntry.outputAudio === false ? '' : stateEntry.outputPath || path.join(output, `${episode}_bgm.wav`);
  const timelinePath = stateEntry.outputTimeline === false ? '' : stateEntry.timelinePath || path.join(output, `${episode}_timeline.csv`);
  const transcriptPath = stateEntry.outputTranscript === false ? '' : typeof stateEntry.transcriptPath === 'string' ? stateEntry.transcriptPath : path.join(output, `${episode}_transcript.json`);
  const finalVideoPath = stateEntry.outputVideo === false ? '' : stateEntry.finalVideoPath || path.join(output, `${episode}_final.mp4`);
  const finalVideoExists = await exists(finalVideoPath);
  const timeline = await exists(timelinePath) ? parseCsv(await fs.readFile(timelinePath, 'utf8')) : [];
  const transcriptRaw = await readJson(transcriptPath, null);
  const transcript = Array.isArray(transcriptRaw) ? transcriptRaw : transcriptRaw?.segments || [];
  return {
    episode,
    status: stateEntry.status || 'pending',
    duration: Number(stateEntry.duration) || (timeline.length ? Number(timeline[timeline.length - 1].end_sec) + (Number(timeline[0].freeze_tail_sec) || 0) : 0),
    freezeTail: timeline[0]?.freeze_tail || '0:00',
    freezeTailSeconds: Number(timeline[0]?.freeze_tail_sec) || 0,
    mood: stateEntry.mood || timeline.map((item) => item.mood).filter(Boolean).join(' → '),
    analysis: stateEntry.analysis || null,
    analysisVersion: stateEntry.analysisVersion || 'legacy',
    outputPath,
    finalVideoPath,
    finalVideoExists,
    finalVideoUrl: finalVideoExists ? pathToFileURL(finalVideoPath).href : '',
    timelinePath: await exists(timelinePath) ? timelinePath : '',
    transcriptPath: await exists(transcriptPath) ? transcriptPath : '',
    audioUrl: await exists(outputPath) ? pathToFileURL(outputPath).href : '',
    timeline: timeline.map((item) => ({
      ...item,
      segment: Number(item.segment),
      start: Number(item.start_sec),
      end: Number(item.end_sec),
      duckSegments: (() => {
        try { return JSON.parse(item.duck_segments || '[]'); } catch { return []; }
      })(),
    })),
    transcript: transcript.map((item) => ({ start: Number(item.start), end: Number(item.end), text: String(item.text || '').trim() }))
      .filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start && item.text),
  };
}
async function startBatch(input, emit, runtime = {}) {
  if (activeRun || libraryRun) throw new Error('已有批次或曲库分析正在运行');
  const controller = new AbortController();
  const run = { controller, config: null };
  activeRun = run;
  let config;
  try { config = await assertRunConfig(input, runtime); } catch (error) { activeRun = null; throw error; }
  run.config = config;
  runLogs.length = 0;
  lastRun = { config, startedAt: Date.now(), currentIndex: 0, total: 0, currentEpisode: '', currentStage: 'scanning', settled: 0, counts: { completed: 0, skipped: 0, failed: 0, interrupted: 0 }, status: 'running', samples: 0, sampleMs: 0 };
  let episodeStartedAt = 0;
  const settled = new Set();
  const send = (event) => {
    const at = new Date().toISOString();
    if (event.type === 'progress') {
      if (event.total !== undefined) lastRun.total = event.total;
      if (event.index !== undefined) {
        if (lastRun.currentIndex !== event.index) episodeStartedAt = Date.now();
        Object.assign(lastRun, { currentIndex: event.index, currentEpisode: event.episode, videoPath: event.videoPath });
      }
      lastRun.currentStage = event.stage || event.status || lastRun.currentStage;
      if (Object.hasOwn(lastRun.counts, event.status) && !settled.has(event.videoPath)) {
        settled.add(event.videoPath);
        lastRun.counts[event.status] += 1;
        lastRun.settled += 1;
        if (event.status === 'completed') { lastRun.samples += 1; lastRun.sampleMs += Math.max(1, Date.now() - episodeStartedAt); }
      }
      lastRun.currentStartedAt = episodeStartedAt;
      lastRun.currentSettled = settled.has(event.videoPath);
    }
    if (['finished', 'stopped', 'error'].includes(event.type)) {
      if (activeRun === run) activeRun = null;
      lastRun.status = event.type;
      lastRun.currentStage = event.type;
      lastRun.finishedAt = Date.now();
      lastRun.summary = event.summary || null;
      lastRun.error = event.message || '';
    }
    if (event.type === 'log' || event.message || event.type === 'started') {
      runLogs.push({ at, level: event.level || (event.type === 'error' ? 'error' : 'info'), message: event.message || '批次已启动 · 可恢复运行' });
      if (runLogs.length > 100) runLogs.shift();
    }
    emit?.({ ...event, at, run: runSnapshot() });
  };
  send({ type: 'started', config });
  Promise.resolve().then(async () => {
    try {
      await runBatch({ ...config, ...runtime, signal: controller.signal }, {
        log(message) { send({ type: 'log', level: 'info', message: String(message) }); },
        error(message) { send({ type: 'log', level: 'error', message: String(message) }); },
        progress(payload) {
          if (payload.stage === 'finished') send({ type: controller.signal.aborted || payload.summary?.interrupted ? 'stopped' : 'finished', summary: payload.summary });
          else send({ type: 'progress', ...payload });
        },
      });
    } catch (error) {
      const message = controller.signal.aborted ? '用户已停止批次；原始素材未修改，可继续未完成。' : `${error.message}；原始素材未修改，请检查目录、组件或错误日志后重试。`;
      try { await fs.appendFile(path.join(config.output, 'run-errors.log'), `${new Date().toISOString()} ${message}\n`, 'utf8'); } catch { /* The output directory may itself be unavailable. */ }
      send({ type: controller.signal.aborted ? 'stopped' : 'error', message });
    } finally { if (activeRun === run) activeRun = null; }
  });
  return { started: true, run: runSnapshot() };
}
function runSnapshot() {
  if (!lastRun) return null;
  const remaining = Math.max(0, lastRun.total - lastRun.settled);
  const elapsed = !lastRun.currentSettled && lastRun.currentStartedAt ? Date.now() - lastRun.currentStartedAt : 0;
  return { ...lastRun, counts: { ...lastRun.counts }, estimatedRemainingMs: lastRun.samples ? Math.max(0, remaining * lastRun.sampleMs / lastRun.samples - elapsed) : null, estimatedAt: Date.now() };
}
function stopBatch() {
  if (!activeRun) return { stopped: false };
  activeRun.controller.abort();
  if (lastRun) lastRun.currentStage = 'stopping';
  return { stopped: true };
}
function getInfo(runtime = {}) {
  const defaults = { ...DEFAULTS };
  if (runtime.modelPath) {
    defaults.videos = '';
    defaults.music = '';
    defaults.output = path.join(os.homedir(), 'Documents', '自动配 BGM Studio', 'output');
  }
  for (const key of ['modelPath', 'ffmpeg', 'ffprobe']) if (runtime[key]) defaults[key] = runtime[key];
  return { defaults, bundledRuntime: Boolean(runtime.modelPath), running: Boolean(activeRun), run: runSnapshot(), logs: [...runLogs], node: process.version, electron: process.versions.electron || '' };
}
module.exports = { checkMusicLibrary, reviewMusicTrack, stopLibraryAnalysis, diagnostics, episodeDetail, getInfo, inspectBatch, resolveImport, startBatch, stopBatch };

