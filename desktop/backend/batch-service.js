'use strict';

const fs = require('node:fs/promises');
const { constants: fsConstants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { DEFAULT_TRANSITION_FADE_SECONDS, VIDEO_EXTENSIONS, runBatch, scanMusic, scanVideos } = require('../../src/mvp');

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
  minTracksPerEpisode: 2,
  maxTracksPerEpisode: 3,
  outputAudio: true,
  outputVideo: true,
  outputTimeline: true,
  outputTranscript: true,
  ffmpeg: process.env.FFMPEG || 'ffmpeg',
  ffprobe: process.env.FFPROBE || 'ffprobe',
};

let activeRun = null;

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
    language: cleanPath(input?.language) || 'auto', transcribe: Boolean(input?.transcribe), mood: cleanPath(input?.mood) || null, autoDuck: Boolean(input?.autoDuck),
    duckDb: asNumber(input?.duckDb, -10), fadeIn: Math.max(0, asNumber(input?.fadeIn, 2)), fadeOut: Math.max(0, asNumber(input?.fadeOut, 2)), freezeTail: cleanPath(input?.freezeTail) || '0:00',
    transitionFadeEnabled: input?.transitionFadeEnabled === undefined ? DEFAULTS.transitionFadeEnabled : input.transitionFadeEnabled,
    transitionFadeDuration,
    skipCompleted: input?.skipCompleted === undefined ? DEFAULTS.skipCompleted : input.skipCompleted,
    minTracksPerEpisode: minTracksInput === undefined ? DEFAULTS.minTracksPerEpisode : String(minTracksInput).trim() ? Number(minTracksInput) : NaN,
    maxTracksPerEpisode: maxTracksInput === undefined ? DEFAULTS.maxTracksPerEpisode : String(maxTracksInput).trim() ? Number(maxTracksInput) : NaN,
    outputAudio: input?.outputAudio !== false, outputVideo: input?.outputVideo !== false,
    outputTimeline: input?.outputTimeline !== false, outputTranscript: input?.outputTranscript !== false,
    overwrite: Boolean(input?.overwrite), ffmpeg: cleanPath(runtime.ffmpeg) || cleanPath(input?.ffmpeg) || DEFAULTS.ffmpeg, ffprobe: cleanPath(runtime.ffprobe) || cleanPath(input?.ffprobe) || DEFAULTS.ffprobe,
  };
  for (const key of ['videos', 'music', 'output']) if (!config[key]) throw new Error(`请先选择${key === 'videos' ? '视频目录' : key === 'music' ? 'BGM 目录' : '输出目录'}`);
  if (config.duckDb > 0) throw new Error('对白 ducking 增益必须是 0 或负数');
  if (typeof config.transitionFadeEnabled !== 'boolean') throw new Error('曲目衔接淡入淡出必须使用开关值');
  if (typeof config.skipCompleted !== 'boolean') throw new Error('跳过已完成必须使用开关值');
  if (!Number.isFinite(config.transitionFadeDuration) || config.transitionFadeDuration < 0) throw new Error('曲目衔接时长必须是非负数字');
  if (!Number.isSafeInteger(config.minTracksPerEpisode) || config.minTracksPerEpisode < 1) throw new Error('每集 BGM 下限必须是正整数');
  if (!Number.isSafeInteger(config.maxTracksPerEpisode) || config.maxTracksPerEpisode < 0) throw new Error('每集 BGM 上限必须是非负整数（0 表示不限制）');
  if (config.maxTracksPerEpisode > 0 && config.minTracksPerEpisode > config.maxTracksPerEpisode) throw new Error('每集 BGM 下限不能高于上限');
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
    const item = (key && episodes[key]) || resultMap.get(episode) || {};
    const sourceVideoPath = videoPath || key || '';
    const extension = path.extname(sourceVideoPath) || '.mp4';
    return { episode, videoPath: sourceVideoPath, status: item.status || 'pending', duration: Number.isFinite(Number(item.duration)) ? Number(item.duration) : null, mood: item.mood || '', moods: item.moods || [], tracks: item.tracks || (item.track ? [item.track] : []), outputAudio: item.outputAudio !== false, outputVideo: item.outputVideo !== false, outputTimeline: item.outputTimeline !== false, outputTranscript: item.outputTranscript !== false, transcribe: item.transcribe === undefined ? Boolean(config.transcribe) : Boolean(item.transcribe), outputPath: item.outputAudio === false ? '' : item.outputPath || (output ? path.join(output, `${episode}_bgm.wav`) : ''), finalVideoPath: item.outputVideo === false ? '' : item.finalVideoPath || (output ? path.join(output, `${episode}_final${extension.toLowerCase()}`) : ''), timelinePath: item.outputTimeline === false ? '' : item.timelinePath || (output ? path.join(output, `${episode}_timeline.csv`) : ''), transcriptPath: item.outputTranscript === false ? '' : typeof item.transcriptPath === 'string' ? item.transcriptPath : output ? path.join(output, `${episode}_transcript.json`) : '', error: item.error || '', updatedAt: item.updatedAt || '' };
  });
  let musicGroups = [];
  if (cleanPath(config.music)) try { const groups = await scanMusic(cleanPath(config.music)); musicGroups = [...groups.entries()].map(([mood, tracks]) => ({ mood, count: tracks.length })); } catch (error) { warning ||= error.message; }
  return { config: { ...config, output }, state, summary, rows, warning, active: Boolean(activeRun), model: await modelInfo(cleanPath(config.modelPath) || DEFAULTS.modelPath), musicGroups, paths };
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
    outputPath,
    finalVideoPath,
    finalVideoExists,
    finalVideoUrl: finalVideoExists ? pathToFileURL(finalVideoPath).href : '',
    timelinePath,
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
  if (activeRun) throw new Error('已有批次正在运行');
  const config = await assertRunConfig(input, runtime); const controller = new AbortController(); activeRun = { controller, config };
  const send = (event) => emit?.({ ...event, at: new Date().toISOString() }); send({ type: 'started', config });
  Promise.resolve().then(async () => { try { const summary = await runBatch({ ...config, ...runtime, signal: controller.signal }, { log(message) { send({ type: 'log', level: 'info', message: String(message) }); }, error(message) { send({ type: 'log', level: 'error', message: String(message) }); }, progress(payload) { if (payload.stage === 'finished') send({ type: controller.signal.aborted || payload.summary?.interrupted ? 'stopped' : 'finished', summary: payload.summary }); else send({ type: 'progress', ...payload }); } }); if (!summary) send({ type: 'finished', summary }); } catch (error) { send({ type: controller.signal.aborted ? 'stopped' : 'error', message: controller.signal.aborted ? '用户已停止批次' : error.message }); } finally { activeRun = null; } });
  return { started: true };
}
function stopBatch() { if (!activeRun) return { stopped: false }; activeRun.controller.abort(); return { stopped: true }; }
function getInfo(runtime = {}) {
  const defaults = { ...DEFAULTS };
  if (runtime.modelPath) {
    defaults.videos = '';
    defaults.music = '';
    defaults.output = path.join(os.homedir(), 'Documents', '自动配 BGM Studio', 'output');
  }
  for (const key of ['modelPath', 'ffmpeg', 'ffprobe']) if (runtime[key]) defaults[key] = runtime[key];
  return { defaults, bundledRuntime: Boolean(runtime.modelPath), running: Boolean(activeRun), node: process.version };
}
module.exports = { episodeDetail, getInfo, inspectBatch, startBatch, stopBatch };

