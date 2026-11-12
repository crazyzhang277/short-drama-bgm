'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { DEFAULT_TRANSITION_FADE_SECONDS, buildAudioFilter, buildMusicPlan, buildMultiTrackFilter, freezeTailDuration, inferMood, mergeIntervals, runBatch, scanMusic } = require('../src/mvp');

const execFileAsync = promisify(execFile);
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const ffprobe = process.env.FFPROBE || 'ffprobe';

test('all four switch combinations render and only screening controls vocal candidates and progress', async (t) => {
  const { ANALYSIS_VERSION, ANALYSIS_SETTINGS, MODEL_SHA256, fingerprint, readLibrary, writeLibrary } = require('../src/music-library');
  const { startBatch } = require('../desktop/backend/batch-service');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-switch-matrix-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const music = path.join(root, 'music');
  const video = path.join(root, 'episode.mp4');
  await fs.mkdir(path.join(music, '默认'), { recursive: true });
  await fs.mkdir(path.join(music, '浪漫'));
  const pure = path.join(music, '默认', 'pure.wav');
  const vocal = path.join(music, '浪漫', 'cached-vocal.wav');
  await makeAudio(pure, 440);
  await makeAudio(vocal, 660);
  await makeVideo(video);
  const cache = { music, libraryCacheDir: path.join(root, 'cache') };
  const library = { version: 1, files: {} };
  for (const [file, status] of [[pure, 'instrumental'], [vocal, 'vocal']]) library.files[file] = { fingerprint: fingerprint(await fs.stat(file)), analysis: { version: ANALYSIS_VERSION, modelSha256: MODEL_SHA256, settings: ANALYSIS_SETTINGS, complete: true, status } };
  await writeLibrary(music, library, cache);
  const transcripts = path.join(root, 'transcripts');
  await fs.mkdir(transcripts);
  await fs.writeFile(path.join(transcripts, 'episode.json'), JSON.stringify({ segments: [{ start: 0, end: 3, text: 'I love you.' }] }));
  let classifierCalls = 0;
  const missingModel = path.join(root, 'missing.tflite');
  const modelReads = [];
  const readFile = fs.readFile;
  t.mock.method(fs, 'readFile', async (file, ...args) => { if (file === missingModel) modelReads.push(file); return readFile(file, ...args); });
  for (const strictInstrumental of [true, false]) for (const preflightEnabled of [true, false]) {
    const output = path.join(root, `${strictInstrumental}-${preflightEnabled}`);
    const events = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('switch matrix run timed out')), 30000);
      startBatch({ ...cache, videos: video, output, transcripts, ffmpeg, ffprobe, strictInstrumental, preflightEnabled, transcribe: false, scenePriority: false, outputVideo: false }, (event) => {
        events.push(event);
        if (['finished', 'error'].includes(event.type)) { clearTimeout(timer); event.type === 'error' ? reject(new Error(event.message)) : resolve(); }
      }, { libraryCacheDir: cache.libraryCacheDir, vocalModelPath: missingModel, createAudioClassifier() { classifierCalls += 1; throw new Error('must not classify'); } }).catch((error) => { clearTimeout(timer); reject(error); });
    });
    const summary = events.at(-1).summary;
    assert.equal(summary.completed, 1, JSON.stringify(summary));
    assert.deepEqual(summary.results[0].tracks, [strictInstrumental ? pure : vocal]);
    assert.equal(events.some((event) => event.stage === 'analyzing-vocals'), strictInstrumental);
    assert.equal(events[0].config.preflightEnabled, preflightEnabled);
    assert.match(await fs.readFile(path.join(output, 'episode_timeline.csv'), 'utf8'), strictInstrumental ? /pure.wav/ : /cached-vocal.wav/);
    assert.ok(await wavRms(path.join(output, 'episode_bgm.wav'), .5, 2) > .001);
  }
  assert.equal(classifierCalls, 0);
  assert.deepEqual(modelReads, []);
  assert.deepEqual((await readLibrary(music, cache)).files, library.files);
  delete library.files[vocal].analysis;
  library.files[pure].disabled = true;
  await writeLibrary(music, library, cache);
  const options = { ...cache, videos: video, output: path.join(root, 'uncached'), transcripts, ffmpeg, ffprobe, strictInstrumental: false, preflightEnabled: false, vocalModelPath: missingModel, createAudioClassifier() { classifierCalls += 1; throw new Error('must not classify'); }, transcribe: false, scenePriority: false, outputVideo: false };
  const uncached = await runBatch(options, { log() {}, error() {} });
  assert.equal(uncached.completed, 1, JSON.stringify(uncached));
  assert.deepEqual(uncached.results[0].tracks, [vocal]);
  assert.equal(classifierCalls, 0);
  assert.deepEqual(modelReads, []);
  assert.deepEqual((await readLibrary(music, cache)).files, library.files);
  library.files[vocal].disabled = true;
  await writeLibrary(music, library, cache);
  const disabled = await runBatch({ ...options, output: path.join(root, 'disabled') }, { log() {}, error() {} });
  assert.equal(disabled.failed, 1);
  assert.match(disabled.results[0].error, /人工禁用/);
  assert.doesNotMatch(disabled.results[0].error, /纯音乐筛选条件/);
});

test('neutral silence renders safely and legacy completion can resume with an empty strict pool', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-silence-legacy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const music = path.join(root, 'music');
  await fs.mkdir(path.join(music, '紧张'), { recursive: true });
  const track = path.join(music, '紧张', 'tone.wav');
  const videos = path.join(root, 'source.mp4');
  await makeAudio(track, 440);
  await makeVideo(videos);
  const options = { music, videos, output: path.join(root, 'output'), ffmpeg, ffprobe, strictInstrumental: false, autoDuck: true, duckDb: -10, fadeIn: 0, fadeOut: 0, transcribe: false };
  const logger = { log() {}, error() {} };
  const first = await runBatch(options, logger);
  assert.equal(first.completed, 1);
  assert.deepEqual(first.results[0].tracks, [null]);
  assert.equal(first.results[0].analysis.ducking.enabled, false);
  assert.equal((await runBatch(options, logger)).skipped, 1);
  const stateFile = path.join(options.output, '.mvp-state.json');
  const saved = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  delete saved.episodes[videos].analysisVersion;
  await fs.writeFile(stateFile, JSON.stringify(saved));
  const resumed = await runBatch({ ...options, strictInstrumental: true, vocalModelPath: path.join(root, 'missing.tflite') }, logger);
  assert.equal(resumed.skipped, 1);
  assert.equal(resumed.results[0].analysisVersion, 'legacy');
  assert.equal(resumed.results[0].needsRegeneration, true);
  const rejected = await runBatch({ ...options, strictInstrumental: true, skipCompleted: false, vocalModelPath: path.join(root, 'missing.tflite') }, logger);
  assert.equal(rejected.failed, 1);
  assert.match(rejected.results[0].error, /纯音乐筛选条件/);
});

test('library health exposes silent, broken, short, duplicate and empty mood entries', async (t) => {
  const { checkMusicLibrary } = require('../desktop/backend/batch-service');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-health-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await Promise.all(['默认', '空情绪', '坏曲目'].map((name) => fs.mkdir(path.join(root, name))));
  const good = path.join(root, '默认', 'good.wav');
  await makeAudio(good, 440);
  await fs.copyFile(good, path.join(root, '默认', 'duplicate.wav'));
  await makeAudio(path.join(root, '坏曲目', 'quiet.wav'), 440, 0.000001);
  await fs.writeFile(path.join(root, '坏曲目', 'broken.mp3'), 'invalid');
  const report = await checkMusicLibrary({ music: root, ffmpeg, ffprobe, strictInstrumental: false });
  assert.equal(report.total, 4);
  assert.equal(report.usable, 2);
  assert.equal(report.duplicates.length, 1);
  assert.deepEqual(report.emptyDirectories, ['空情绪']);
  assert.deepEqual(report.unavailableMoods, ['坏曲目']);
  assert.equal(report.files.find((item) => item.file === good).tooShort, true);
  assert.match(report.files.find((item) => item.file.endsWith('quiet.wav')).reason, /静音/);
  assert.match(report.files.find((item) => item.file.endsWith('broken.mp3')).reason, /解码/);
  assert.equal((await fs.readFile(path.join(root, '坏曲目', 'broken.mp3'), 'utf8')), 'invalid');
});

test('targeted retry and resume preserve completed outputs and manual files and write reports', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const videos = path.join(root, 'videos');
  const music = path.join(root, 'music');
  const output = path.join(root, 'output');
  await Promise.all([fs.mkdir(videos), fs.mkdir(music), fs.mkdir(output)]);
  await makeAudio(path.join(music, 'good.wav'), 440);
  await makeVideo(path.join(videos, '01.mp4'));
  await fs.writeFile(path.join(videos, '02.mp4'), 'broken video');
  await makeVideo(path.join(videos, '03.mp4'));
  const manual = path.join(output, '03_bgm.wav');
  await fs.writeFile(manual, 'manual output');
  const options = { videos, music, output, ffmpeg, ffprobe, transcribe: false, outputVideo: false, minTracksPerEpisode: 1, fadeIn: 0, fadeOut: 0 };
  const logger = { log() {}, error() {} };
  const first = await runBatch({ strictInstrumental: false, ...options }, logger);
  assert.equal(first.completed, 1);
  assert.equal(first.failed, 2);
  const originalTime = (await fs.stat(path.join(output, '01_bgm.wav'))).mtimeMs;
  await makeVideo(path.join(videos, '02.mp4'));
  const retry = await runBatch({ strictInstrumental: false, ...options, runMode: 'failed' }, logger);
  assert.equal(retry.videos, 2);
  assert.equal(retry.completed, 1);
  assert.equal(retry.failed, 1);
  assert.equal((await fs.stat(path.join(output, '01_bgm.wav'))).mtimeMs, originalTime);
  assert.equal(await fs.readFile(manual, 'utf8'), 'manual output');
  const report = await fs.readFile(path.join(output, 'run-report.md'), 'utf8');
  assert.match(report, /使用音乐/);
  assert.match(report, /good.wav/);
  assert.match(report, /03.*失败/);
  assert.match(await fs.readFile(path.join(output, 'run-errors.log'), 'utf8'), /03/);
  const resumed = await runBatch({ strictInstrumental: false, ...options, runMode: 'unfinished', skipCompleted: false }, logger);
  assert.equal(resumed.skipped, 2);
  assert.equal(resumed.failed, 1);
  const regenerated = await runBatch({ strictInstrumental: false, ...options, runMode: 'episode', episodeVideoPath: path.join(videos, '01.mp4') }, logger);
  assert.equal(regenerated.videos, 1);
  assert.equal(regenerated.completed, 1);
  assert.equal(await fs.readFile(manual, 'utf8'), 'manual output');
  await assert.rejects(runBatch({ strictInstrumental: false, ...options, runMode: 'episode', episodeVideoPath: path.join(root, 'outside.mp4') }, logger), /没有符合条件/);
  const controller = new AbortController();
  const stopped = await runBatch({ strictInstrumental: false, ...options, signal: controller.signal }, { ...logger, progress(event) { if (event.status === 'skipped') controller.abort(); } });
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.pending, 2);
  assert.match(await fs.readFile(path.join(output, 'run-report.md'), 'utf8'), /未处理 2/);
});

test('desktop progress snapshots retain stages, accurate counters and measured estimates', async (t) => {
  const { getInfo, startBatch } = require('../desktop/backend/batch-service');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-progress-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const video = path.join(root, 'episode.mp4');
  const music = path.join(root, 'music');
  const output = path.join(root, 'output');
  await fs.mkdir(music);
  await makeAudio(path.join(music, 'good.wav'), 440);
  await makeVideo(video);
  const events = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('batch did not finish')), 30000);
    startBatch({ strictInstrumental: false, videos: video, music, output, transcribe: false, ffmpeg, ffprobe, outputVideo: false, minTracksPerEpisode: 1 }, (event) => {
      events.push(event);
      if (['finished', 'error'].includes(event.type)) { clearTimeout(timer); event.type === 'error' ? reject(new Error(event.message)) : resolve(); }
    }).catch((error) => { clearTimeout(timer); reject(error); });
  });
  assert.equal(events[0].run.estimatedRemainingMs, null);
  assert.equal(events.at(-1).summary.failed, 0, events.filter((event) => event.level === 'error').map((event) => event.message).join('\n'));
  assert.ok(events.some((event) => event.stage === 'rendering-audio'));
  const snapshot = getInfo();
  assert.equal(snapshot.running, false);
  assert.equal(snapshot.run.total, 1);
  assert.equal(snapshot.run.settled, 1);
  assert.equal(snapshot.run.counts.completed, 1);
  assert.equal(snapshot.run.estimatedRemainingMs, 0);
});

test('even explicit overwrite cannot replace source videos or music', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-source-protection-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const video = path.join(root, 'episode.mp4');
  const track = path.join(root, 'episode_bgm.wav');
  await makeVideo(video);
  await makeAudio(track, 440);
  const before = await fs.readFile(track);
  const options = { videos: root, music: root, output: root, ffmpeg, ffprobe, overwrite: true, preflightEnabled: false };
  await assert.rejects(runBatch({ strictInstrumental: false, ...options }, { log() {}, error() {} }), /输出路径与输入素材重合/);
  assert.deepEqual(await fs.readFile(track), before);
  const otherVideo = path.join(root, 'episode_final.mp4');
  await fs.copyFile(video, otherVideo);
  const beforeVideo = await fs.readFile(otherVideo);
  await assert.rejects(runBatch({ strictInstrumental: false, ...options, outputAudio: false }, { log() {}, error() {} }), /输出路径与输入素材重合/);
  assert.deepEqual(await fs.readFile(otherVideo), beforeVideo);
});

async function makeAudio(filePath, frequency, volume = 1, channels = 1) {
  const audioFilter = channels === 2 ? `volume=${volume},pan=stereo|c0=c0|c1=c0` : `volume=${volume}`;
  await execFileAsync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=0.7`,
    '-af', audioFilter, '-ar', '22050', '-ac', String(channels), filePath,
  ], { windowsHide: true });
}

async function makeVideo(filePath, duration = 2.5) {
  await execFileAsync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=blue:s=320x240:r=25:d=${duration}`,
    '-f', 'lavfi', '-i', `sine=frequency=880:sample_rate=16000:duration=${duration}`,
    '-t', String(duration), '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'aac', '-shortest', filePath,
  ], { windowsHide: true });
}

async function makeSceneVideo(filePath, sceneDuration = 15) {
  await execFileAsync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=red:s=160x120:r=25:d=${sceneDuration}`,
    '-f', 'lavfi', '-i', `color=c=white:s=160x120:r=25:d=${sceneDuration}`,
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]',
    '-map', '[v]', '-c:v', 'mpeg4', '-q:v', '5', filePath,
  ], { windowsHide: true });
}

async function makeSilentVideo(filePath, duration = 1) {
  await execFileAsync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=blue:s=320x240:r=25:d=${duration}`,
    '-t', String(duration), '-c:v', 'mpeg4', '-q:v', '5', filePath,
  ], { windowsHide: true });
}

async function makeSilentWav(filePath, duration) {
  await execFileAsync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-t', String(duration), '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', filePath,
  ], { windowsHide: true });
}

async function probe(filePath) {
  const { stdout } = await execFileAsync(ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,sample_rate,channels', '-of', 'json', filePath,
  ], { windowsHide: true });
  return JSON.parse(stdout);
}

async function wavRms(filePath, startSec, endSec) {
  const wav = await fs.readFile(filePath);
  const sampleRate = wav.readUInt32LE(24);
  const channels = wav.readUInt16LE(22);
  const dataOffset = wav.indexOf('data', 12) + 8;
  const start = dataOffset + Math.floor(startSec * sampleRate) * channels * 2;
  const end = dataOffset + Math.floor(endSec * sampleRate) * channels * 2;
  let sum = 0;
  let count = 0;
  for (let offset = start; offset + 1 < end; offset += 2) {
    const sample = wav.readInt16LE(offset) / 32768;
    sum += sample * sample;
    count += 1;
  }
  return Math.sqrt(sum / count);
}

async function wavMaxDb(filePath) {
  const { stderr } = await execFileAsync(ffmpeg, [
    '-hide_banner', '-nostats', '-i', filePath, '-af', 'volumedetect', '-f', 'null', '-',
  ], { windowsHide: true });
  const match = stderr.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
  assert.ok(match, 'ffmpeg should report the WAV peak');
  return Number(match[1]);
}

test('rejects an empty BGM library before processing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-mvp-empty-library-'));
  const musicDir = path.join(root, 'empty');
  await fs.mkdir(musicDir);
  await assert.rejects(scanMusic(musicDir), /BGM 目录没有找到音频文件/);
});

test('configures track transition fades and caps them for short segments', () => {
  const segments = [{ start: 0, end: 10 }, { start: 10, end: 20 }];
  assert.equal(DEFAULT_TRANSITION_FADE_SECONDS, 1);
  const defaultGraph = buildMultiTrackFilter(segments, 20, { fadeIn: 0, fadeOut: 0 }, []);
  assert.match(defaultGraph, /afade=t=out:st=9\.5:d=1/);
  assert.match(defaultGraph, /afade=t=in:st=0:d=1/);

  const customGraph = buildMultiTrackFilter(segments, 20, { transitionFadeDuration: 0.4, fadeIn: 0, fadeOut: 0 }, []);
  assert.match(customGraph, /afade=t=out:st=9\.8:d=0\.4/);
  assert.match(customGraph, /afade=t=in:st=0:d=0\.4/);

  const disabledGraph = buildMultiTrackFilter(segments, 20, { transitionFadeEnabled: false, fadeIn: 0, fadeOut: 0 }, []);
  assert.match(disabledGraph, /adelay=10000:all=1/);
  assert.doesNotMatch(disabledGraph, /afade=t=(?:in|out):st=[^;]*d=/);

  const shortGraph = buildMultiTrackFilter(
    [{ start: 0, end: 0.8 }, { start: 0.8, end: 1.6 }],
    1.6,
    { transitionFadeDuration: 5, fadeIn: 0, fadeOut: 0 },
    [],
  );
  assert.match(shortGraph, /afade=t=out:st=0\.6:d=0\.4/);
  assert.match(shortGraph, /afade=t=in:st=0:d=0\.4/);
  assert.match(shortGraph, /adelay=600:all=1/);
});

test('mood rules and interval merging stay deterministic', () => {
  const groups = new Map([
    ['默认', ['default.wav']],
    ['紧张', ['tense.wav']],
  ]);
  const mood = inferMood({ segments: [{ start: 0, end: 1, text: '危险，快跑' }] }, groups);
  assert.equal(mood.mood, '紧张');
  assert.deepEqual(mergeIntervals([
    { start: 1, end: 2 },
    { start: 1.9, end: 3 },
  ], 5, 0), [{ start: 1, end: 3 }]);
  assert.match(buildAudioFilter(10, { fadeIn: 1, fadeOut: 1, autoDuck: true, duckDb: -10 }, [{ start: 2, end: 3 }]), /between\(t,2,3\)/);
  assert.doesNotMatch(buildAudioFilter(10, { fadeIn: 1, fadeOut: 1, duckDb: -10 }, [{ start: 2, end: 3 }]), /between\(t,2,3\)/);
  assert.doesNotMatch(buildMultiTrackFilter([{ start: 0, end: 10 }], 10, { fadeIn: 0, fadeOut: 0, duckDb: -10 }, [{ start: 2, end: 3 }]), /volume=volume='/);
  assert.match(buildMultiTrackFilter([{ start: 0, end: 10 }], 10, { fadeIn: 0, fadeOut: 0, autoDuck: true, duckDb: -10 }, [{ start: 2, end: 3 }]), /volume=volume='/);
  assert.equal(freezeTailDuration('2:15', 25), 2.6);
  assert.throws(() => freezeTailDuration('0:25', 25), /帧数必须小于视频帧率/);

  const prefixedGroups = new Map([
    ['07_平静_治愈氛围', ['calm-a.mp3', 'calm-b.mp3']],
    ['01_紧张_激烈冲突', ['tense.mp3']],
    ['08_悲伤_失落离别', ['sad.mp3']],
    ['09_忧郁_阴暗神秘', ['mystery.mp3']],
  ]);
  const plan = buildMusicPlan({ duration: 60, transcript: null, groups: prefixedGroups, options: { mood: null }, trackUses: new Map() });
  assert.equal(plan.segments.length, 1);
  assert.equal(plan.segments[0].mood, '07_平静_治愈氛围');
  assert.equal(inferMood({ segments: [{ start: 1, end: 2, text: '发现秘密线索' }] }, prefixedGroups).mood, '09_忧郁_阴暗神秘');
  const scenePlan = buildMusicPlan({
    duration: 60,
    transcript: null,
    groups: prefixedGroups,
    options: { mood: null },
    trackUses: new Map(),
    sceneCuts: [{ time: 20, score: 20 }, { time: 30, score: 14 }, { time: 45, score: 16 }],
  });
  assert.equal(scenePlan.segments.length, 1);
  const override = buildMusicPlan({
    duration: 60,
    transcript: { segments: [{ start: 1, end: 15, text: '危险快跑' }, { start: 30, end: 50, text: '难过哭泣' }] },
    groups: prefixedGroups,
    options: { mood: '07_平静_治愈氛围' },
    trackUses: new Map(),
  });
  assert.deepEqual(override.segments.map((segment) => segment.mood), ['07_平静_治愈氛围']);
});

test('classifies English dialogue and mood turns', () => {
  const groups = new Map([
    ['默认', ['default.wav']],
    ['01_紧张_激烈冲突', ['tense.wav']],
    ['02_愤怒_压迫反派', ['angry.wav']],
    ['05_浪漫_温柔爱情', ['romance.wav']],
    ['08_悲伤_失落离别', ['sad.wav']],
  ]);
  assert.equal(inferMood({ segments: [{ start: 0, end: 1, text: 'How dare you? She slapped and humiliated her.' }] }, groups).mood, '02_愤怒_压迫反派');
  assert.equal(inferMood({ segments: [{ start: 0, end: 1, text: 'Just a moment, please.' }] }, groups).mood, '默认');
  const plan = buildMusicPlan({
    duration: 60,
    transcript: { segments: [
      { start: 0, end: 20, text: 'This is our wedding. I love my husband.' },
      { start: 35, end: 55, text: 'How dare you? She slapped and humiliated her.' },
    ] },
    groups,
    options: { mood: null },
    trackUses: new Map(),
  });
  assert.deepEqual(plan.segments.map((segment) => segment.mood), ['05_浪漫_温柔爱情', '02_愤怒_压迫反派']);
});

test('caps music segments at the configured limit and uses different tracks', () => {
  const groups = new Map([
    ['紧张', ['tense.wav']],
    ['浪漫', ['romance.wav']],
    ['悲伤', ['sad.wav']],
  ]);
  const plan = buildMusicPlan({
    duration: 60,
    transcript: { segments: [
      { start: 1, end: 10, text: '危险，快跑' },
      { start: 22, end: 30, text: '我爱你' },
      { start: 42, end: 50, text: '难过，哭泣' },
    ] },
    groups,
    options: { scenePriority: false, maxTracksPerEpisode: 2 },
    trackUses: new Map(),
  });
  assert.equal(plan.segments.length, 2);
  assert.equal(new Set(plan.segments.map((segment) => segment.track)).size, 2);
});

test('uses only persistent script mood turns and never fills the segment limit by default', () => {
  const groups = new Map([
    ['紧张', ['tense.wav']],
    ['浪漫', ['romance.wav']],
    ['悲伤', ['sad.wav']],
  ]);
  const plan = buildMusicPlan({
    duration: 90,
    transcript: { segments: [
      { start: 2, end: 25, text: '危险，快跑，有人追杀' },
      { start: 30, end: 50, text: '我爱你，我们结婚吧' },
      { start: 60, end: 85, text: '我很难过，眼泪止不住' },
    ] },
    groups,
    options: { maxTracksPerEpisode: 3 },
    trackUses: new Map(),
  });
  assert.deepEqual(plan.segments.map((segment) => segment.mood), ['紧张', '浪漫', '悲伤']);
  assert.equal(plan.segments.length, 3);
  assert.equal(new Set(plan.segments.map((segment) => segment.track)).size, 3);

  const oneMood = buildMusicPlan({
    duration: 90,
    transcript: { segments: [
      { start: 2, end: 25, text: '我爱你，我们结婚吧' },
      { start: 30, end: 50, text: '我们一起回家，感谢家人' },
      { start: 60, end: 85, text: '我会一直陪着你' },
    ] },
    groups,
    options: { maxTracksPerEpisode: 3 },
    trackUses: new Map(),
  });
  assert.deepEqual(oneMood.segments.map(segment => segment.detectedMood), ['浪漫', '温情']);
  assert.equal(oneMood.segments[1].track, null, 'missing warm and neutral tracks must not hide the detected emotion');
});

test('ignores a brief isolated emotion mention between longer story sections', () => {
  const groups = new Map([
    ['浪漫', ['romance.wav']],
    ['愤怒', ['anger.wav']],
  ]);
  const plan = buildMusicPlan({
    duration: 60,
    transcript: { segments: [
      { start: 1, end: 18, text: '我爱你，我们一直相爱' },
      { start: 22, end: 23, text: '我很愤怒' },
      { start: 28, end: 55, text: '我爱你，想和你一起生活' },
    ] },
    groups,
    options: { maxTracksPerEpisode: 3 },
    trackUses: new Map(),
  });
  assert.equal(plan.segments.length, 1);
  assert.equal(plan.segments[0].mood, '浪漫');
});

test('recognizes conflict and reconciliation turns in English drama dialogue', () => {
  const groups = new Map([
    ['02_愤怒_压迫反派', ['anger-a.mp3', 'anger-b.mp3']],
    ['07_平静_治愈氛围', ['warm-a.mp3', 'warm-b.mp3']],
    ['08_悲伤_失落离别', ['sad-a.mp3', 'sad-b.mp3']],
  ]);
  const plan = (duration, segments) => buildMusicPlan({
    duration, transcript: { segments }, groups,
    options: { maxTracksPerEpisode: 3 }, trackUses: new Map(),
  });

  const conflict = plan(85.378, [
    { start: 14.8, end: 16.8, text: 'Are you two really this cruel?' },
    { start: 17, end: 19.3, text: "Mom, this isn't about being cruel." },
    { start: 50.3, end: 51.8, text: 'You even hit me.' },
    { start: 51.8, end: 53.8, text: 'And you told us to get out twice.' },
    { start: 78, end: 83.7, text: 'If I get sick in the future, will you still come?' },
    { start: 83.7, end: 85.2, text: 'We will.' },
  ]);
  assert.deepEqual(conflict.segments.map((segment) => segment.mood), ['02_愤怒_压迫反派', '07_平静_治愈氛围']);
  assert.equal(new Set(conflict.segments.map((segment) => segment.track)).size, 2);

  const reunion = plan(88.373, [
    { start: 11.6, end: 13.6, text: "Mom, I'm hungry." },
    { start: 13.7, end: 19.3, text: "No, Mom, we're back." },
    { start: 25.8, end: 31.4, text: 'Can we stay for a couple of days?' },
    { start: 32, end: 37.1, text: "I'm older now. I can find a place." },
    { start: 40, end: 45.6, text: 'Neither of you is going anywhere.' },
    { start: 51.2, end: 56.2, text: 'Mom, thank you for not making us leave back then.' },
    { start: 56.2, end: 59.9, text: "You're stuck with me." },
    { start: 73.2, end: 76.5, text: 'Mom.' },
    { start: 77.2, end: 81.8, text: 'Real home is a place where you are safe.' },
    { start: 82.3, end: 85, text: "Eat up. Nobody's holding back tonight." },
  ]);
  assert.deepEqual(reunion.segments.map((segment) => segment.mood), ['08_悲伤_失落离别', '07_平静_治愈氛围']);
  assert.equal(new Set(reunion.segments.map((segment) => segment.track)).size, 2);
});

test('uses mood changes first and enforces the minimum even without mood evidence', () => {
  const groups = new Map([
    ['浪漫', ['romance.wav']],
    ['愤怒', ['anger.wav']],
    ['默认', ['default.wav']],
  ]);
  const plan = buildMusicPlan({
    duration: 120, transcript: { segments: [
      { start: 10, end: 16, text: '我爱你，我们一直相爱' },
      { start: 62, end: 65, text: '我真的很愤怒，也无法原谅' },
    ] }, groups,
    options: { minTracksPerEpisode: 2, maxTracksPerEpisode: 3 }, trackUses: new Map(),
  });

  assert.equal(plan.segments.length, 2);
  assert.notDeepEqual(plan.segments.map(({ start, end }) => [start, end]), [[0, 60], [60, 120]]);
  assert.equal(new Set(plan.segments.map((segment) => segment.track)).size, 2);
  assert.match(plan.segments[1].reason, /情绪转折/);

  const oneMood = buildMusicPlan({
    duration: 120, transcript: null, groups,
    options: { minTracksPerEpisode: 2, maxTracksPerEpisode: 3 }, trackUses: new Map(),
  });
  assert.equal(oneMood.segments.length, 1);
  assert.equal(oneMood.trackCount.actual, 1);
  assert.equal(oneMood.trackCount.met, false);
  assert.match(oneMood.trackCount.warning, /曲目不足/);
});

test('scene-priority switch changes music at the episode 15 transition even with one mood', () => {
  const groups = new Map([['默认', ['calm-a.wav', 'calm-b.wav', 'calm-c.wav']]]);
  const sceneCuts = [{ time: 13.566667, score: 17.279, kind: 'cut' }, { time: 18.133333, score: 48.756, kind: 'cut' }, { time: 19.766667, score: 26.315, kind: 'cut' }];
  const plan = (options) => buildMusicPlan({ duration: 53.310657, transcript: null, groups, sceneCuts, options, trackUses: new Map() });
  const enabled = plan({ scenePriority: true, minTracksPerEpisode: 1, maxTracksPerEpisode: 3 });
  assert.deepEqual(enabled.segments.map((segment) => segment.start), [0, 18.133333]);
  assert.equal(enabled.trackCount.actual, 2);
  assert.equal(enabled.sceneCandidates.filter((cut) => cut.used).length, 1);
  assert.match(enabled.segments[1].reason, /转场必换曲/);
  assert.equal(plan({ scenePriority: false, minTracksPerEpisode: 1 }).segments.length, 1);
  assert.equal(plan({ scenePriority: true, maxTracksPerEpisode: 1 }).segments.length, 2);
  const required = plan({ scenePriority: false, minTracksPerEpisode: 2, maxTracksPerEpisode: 3 });
  assert.equal(required.trackCount.met, true);
  assert.equal(required.segments[1].start, 18.133333);
});

test('minimum picks different compatible songs, uses pauses and reports impossible requests', () => {
  const groups = new Map([['默认', ['calm-a.wav', 'calm-b.wav', 'calm-c.wav']], ['紧张', ['tense.wav']]]);
  const plan = (options = {}, transcript = null, duration = 60, choices = groups) => buildMusicPlan({ duration, transcript, groups: choices,
    options: { scenePriority: false, minTracksPerEpisode: 2, maxTracksPerEpisode: 3, ...options }, trackUses: new Map() });
  const paused = plan({}, { segments: [{ start: 1, end: 15, text: 'Hello.' }, { start: 20, end: 55, text: 'We should talk.' }] });
  assert.equal(paused.segments[1].start, 17.5);
  assert.match(paused.segments[1].reason, /停顿/);
  assert.deepEqual(paused.trackCount, { minimum: 2, maximum: 3, actual: 2, segments: 2, met: true, exceededBy: 0, warning: '' });
  const noEvidence = plan({ minTracksPerEpisode: 3 });
  assert.equal(noEvidence.trackCount.actual, 3);
  assert.ok(noEvidence.segments.every((segment) => segment.end - segment.start >= 6 && segment.track !== 'tense.wav'));
  const nearEnd = buildMusicPlan({ duration: 55, transcript: null, groups, sceneCuts: [{ time: 48, score: 28 }, { time: 24, score: 15 }],
    options: { scenePriority: false, minTracksPerEpisode: 2 }, trackUses: new Map() });
  assert.equal(nearEnd.segments[1].start, 24);
  const short = plan({}, null, 10);
  assert.equal(short.segments.length, 1);
  assert.match(short.trackCount.warning, /时长不足/);
  const insufficient = plan({}, null, 60, new Map([['默认', ['only.wav']], ['紧张', ['unrelated.wav']]]));
  assert.equal(insufficient.segments.length, 1);
  assert.equal(insufficient.trackCount.actual, 1);
  assert.match(insufficient.trackCount.warning, /曲目不足/);
  const compatible = plan({ mood: '紧张' });
  assert.equal(compatible.trackCount.actual, 2);
  assert.equal(compatible.segments[0].track, 'tense.wav');
  assert.ok(compatible.segments[1].track.startsWith('calm-'));
});

test('required scene switches keep close transitions and override the cap without adjacent track reuse', () => {
  const groups = new Map([['默认', Array.from({ length: 5 }, (_, index) => `calm-${index}.wav`)]]);
  const sceneCuts = [12, 13, 24, 36, 48].map((time) => ({ time, score: 50, kind: 'cut' }));
  const plan = (options) => buildMusicPlan({ duration: 60, transcript: null, groups, sceneCuts, options, trackUses: new Map() });
  const capped = plan({ maxTracksPerEpisode: 3 });
  assert.equal(capped.segments.length, 6);
  assert.equal(capped.trackCount.maximum, 3);
  assert.equal(capped.trackCount.exceededBy, 3);
  assert.match(capped.trackCount.warning, /转场必换.*上限 3 段.*实际 6 段.*超出 3 段/);
  assert.ok(capped.sceneCandidates.every((cut) => cut.required && cut.used));
  assert.ok(capped.segments.every((segment, index) => !index || segment.track !== capped.segments[index - 1].track));
  assert.equal(plan({ scenePriority: false, maxTracksPerEpisode: 3 }).segments.length, 1);
  const unlimited = plan({ maxTracksPerEpisode: 0 });
  assert.deepEqual(unlimited.segments.map((segment) => segment.start), [0, 12, 13, 24, 36, 48]);
  const dense = plan({ minTracksPerEpisode: 5, maxTracksPerEpisode: 5 });
  assert.equal(dense.trackCount.met, true);
  const compact = buildMusicPlan({ duration: 30, transcript: null, groups, sceneCuts: [{ time: 15, score: 50, kind: 'cut' }],
    options: { minTracksPerEpisode: 5, maxTracksPerEpisode: 5 }, trackUses: new Map() });
  assert.equal(compact.trackCount.actual, 4);
  assert.equal(compact.trackCount.met, false);
  assert.match(compact.trackCount.warning, /必换点分段限制/);
  assert.ok(compact.sceneCandidates[0].used);
  assert.ok(compact.segments.every((segment) => segment.end - segment.start >= 6));
  const compactOff = buildMusicPlan({ duration: 30, transcript: null, groups, sceneCuts: [{ time: 15, score: 50, kind: 'cut' }],
    options: { scenePriority: false, minTracksPerEpisode: 5, maxTracksPerEpisode: 5 }, trackUses: new Map() });
  assert.equal(compactOff.trackCount.actual, 5);
});

test('scene-required mode preserves emotion changes separately instead of moving them to an earlier scene', () => {
  const groups = new Map([['浪漫', ['love.wav']], ['愤怒', ['anger.wav']], ['默认', ['calm-a.wav', 'calm-b.wav']]]);
  const options = { scenePriority: true, maxTracksPerEpisode: 3 };
  const transcript = { segments: [{ start: 1, end: 10, text: '我爱你，我们相爱。' }, { start: 32, end: 40, text: '我很愤怒，无法原谅！' }] };
  const plan = buildMusicPlan({ duration: 60, transcript, groups, options, trackUses: new Map(), sceneCuts: [{ time: 18, score: 50, kind: 'cut' }] });
  assert.deepEqual(plan.segments.map((segment) => segment.start), [0, 18, 31.8]);
  assert.deepEqual(plan.segments.map((segment) => segment.mood), ['浪漫', '默认', '愤怒']);
  assert.equal(plan.sceneCandidates[0].used, true);
  assert.match(plan.segments[2].reason, /情绪转折/);
  const coincident = buildMusicPlan({ duration: 60, transcript, groups, options, trackUses: new Map(), sceneCuts: [{ time: 32, score: 50, kind: 'cut' }] });
  assert.equal(coincident.segments.length, 2);
  assert.equal(coincident.segments[1].start, 32);
  assert.equal(coincident.segments[1].mood, '愤怒');
  assert.ok(coincident.segments[1].transition.sceneChange);
});

test('ordinary emotion changes respect the editable cap while required scenes can exceed it', () => {
  const groups = new Map([['浪漫', ['love.wav']], ['愤怒', ['anger.wav']], ['默认', ['calm-a.wav', 'calm-b.wav']]]);
  const transcript = { segments: [{ start: 1, end: 10, text: '我爱你，我们相爱。' }, { start: 32, end: 40, text: '我很愤怒，无法原谅！' }] };
  const plan = (maximum, sceneCuts = []) => buildMusicPlan({ duration: 60, transcript, groups,
    options: { scenePriority: true, maxTracksPerEpisode: maximum }, trackUses: new Map(), sceneCuts });
  assert.equal(plan(1).segments.length, 1);
  assert.ok(plan(2).segments.length <= 2);
  assert.ok(plan(0).segments.length > 1);
  const required = plan(1, [{ time: 18, score: 50, kind: 'cut' }]);
  assert.equal(required.segments.length, 2);
  assert.ok(required.sceneCandidates[0].used);
  assert.equal(required.trackCount.exceededBy, 1);
  assert.throws(() => buildMusicPlan({ duration: 60, groups, transcript, trackUses: new Map(),
    options: { scenePriority: true, minTracksPerEpisode: 3, maxTracksPerEpisode: 2 } }), /下限.*上限/);
});

test('required scenes report missing alternative music instead of silently continuing the same track', () => {
  const groups = new Map([['默认', ['only.wav']], ['紧张', ['unrelated.wav']]]);
  assert.throws(() => buildMusicPlan({ duration: 60, transcript: null, groups, options: { scenePriority: true },
    trackUses: new Map(), sceneCuts: [{ time: 20, score: 50, kind: 'cut' }] }), /20 秒处必须换曲.*没有另一首/);
  const allowed = buildMusicPlan({ duration: 60, transcript: null, groups, options: { scenePriority: false },
    trackUses: new Map(), sceneCuts: [{ time: 20, score: 50, kind: 'cut' }] });
  assert.equal(allowed.segments.length, 1);
});

test('understands English clause turns and ignores negated mood words', () => {
  const groups = new Map([
    ['浪漫', ['romance.wav']],
    ['愤怒', ['anger.wav']],
    ['默认', ['default.wav']],
  ]);
  const plan = buildMusicPlan({
    duration: 60,
    transcript: { segments: [{ start: 0, end: 60, text: "I love you, but how dare you treat me like this?", words: [
        {start:0,end:10,word:"I love you,"}, {start:32,end:34,word:" but"}, {start:35,end:58,word:" how dare you treat me like this?"}
      ] }] },
    groups,
    options: { maxTracksPerEpisode: 3 },
    trackUses: new Map(),
  });
  assert.deepEqual(plan.segments.map((segment) => segment.mood), ['浪漫', '愤怒']);
  assert.equal(inferMood({ segments: [{ start: 0, end: 2, text: "I don't love you and I'm not happy." }] }, groups).mood, '默认');
});

test('batch MVP renders Chinese paths, ducking, validation, and resume', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-mvp-'));
  const videoDir = path.join(root, '素材', '视频');
  const musicDir = path.join(root, '素材', 'BGM');
  const transcriptDir = path.join(root, '素材', '字幕');
  const outputDir = path.join(root, '输出');
  await Promise.all([
    fs.mkdir(videoDir, { recursive: true }),
    fs.mkdir(path.join(musicDir, '默认'), { recursive: true }),
    fs.mkdir(path.join(musicDir, '紧张'), { recursive: true }),
    fs.mkdir(transcriptDir, { recursive: true }),
  ]);
  await makeAudio(path.join(musicDir, '默认', '平稳.wav'), 330);
  await makeAudio(path.join(musicDir, '紧张', '追逐.wav'), 660);
  await makeVideo(path.join(videoDir, '第10集.mp4'));
  await makeVideo(path.join(videoDir, '第2集.mp4'));
  await fs.writeFile(path.join(transcriptDir, '第2集.json'), JSON.stringify({ segments: [{ start: 0.6, end: 1.1, text: '危险，快跑' }] }), 'utf8');

  const options = {
    videos: videoDir,
    music: musicDir,
    output: outputDir,
    transcripts: transcriptDir,
    transcribe: false,
    mood: null,
    autoDuck: true,
    duckDb: -10,
    fadeIn: 0.2,
    fadeOut: 0.2,
    overwrite: false,
    ffmpeg,
    ffprobe,
  };
  const first = await runBatch({ strictInstrumental: false, ...options }, { log() {}, error() {} });
  assert.equal(first.failed, 0);
  assert.equal(first.completed, 2);
  assert.deepEqual(first.results.map((item) => item.episode), ['第2集', '第10集']);
  const finalVideo = path.join(outputDir, '第2集_final.mp4');
  const finalMedia = await probe(finalVideo);
  assert.ok(finalMedia.streams.some((stream) => stream.codec_type === 'video'));
  assert.ok(finalMedia.streams.some((stream) => stream.codec_type === 'audio' && stream.codec_name === 'aac'));
  assert.ok(Math.abs(Number(finalMedia.format.duration) - 2.5) <= 0.2);

  const wav = path.join(outputDir, '第2集_bgm.wav');
  const csv = path.join(outputDir, '第2集_timeline.csv');
  const media = await probe(wav);
  const audio = media.streams.find((stream) => stream.codec_name === 'pcm_s16le');
  assert.equal(Number(audio.sample_rate), 48000);
  assert.equal(Number(audio.channels), 2);
  assert.ok(Math.abs(Number(media.format.duration) - 2.5) <= 0.05);
  const csvBytes = await fs.readFile(csv);
  assert.deepEqual([...csvBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const csvText = csvBytes.toString('utf8');
  assert.match(csvText, /紧张/);
  assert.match(csvText, /追逐/);
  assert.match(csvText, /detected_mood/);
  assert.match(csvText, /duck_segments/);
  const duckedRms = await wavRms(wav, 0.7, 1.0);
  const normalRms = await wavRms(wav, 1.5, 1.8);
  assert.ok(20 * Math.log10(duckedRms / normalRms) <= -8, '对白区间 BGM should be audibly reduced');
  const leadingRms = await wavRms(wav, 0, 0.1);
  const steadyRms = await wavRms(wav, 1.4, 1.5);
  const trailingRms = await wavRms(wav, 2.4, 2.5);
  assert.ok(leadingRms < steadyRms * 0.4, 'BGM should fade in');
  assert.ok(trailingRms < steadyRms * 0.4, 'BGM should fade out');
  const mixedWav = path.join(root, 'mixed.wav');
  await execFileAsync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', finalVideo, '-vn', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', mixedWav], { windowsHide: true });
  assert.ok(await wavRms(mixedWav, 1.3, 1.6) > await wavRms(wav, 1.3, 1.6) * 1.15, 'final video should retain original audio in addition to BGM');

  const secondProgress = [];
  const second = await runBatch({ strictInstrumental: false, ...options }, { log() {}, error() {}, progress(event) { secondProgress.push(event); } });
  assert.equal(second.failed, 0);
  assert.equal(second.skipped, 2);
  assert.equal(secondProgress.filter((event) => event.status === 'checking').length, 2);
  assert.equal(secondProgress.some((event) => event.status === 'processing'), false);
  assert.deepEqual(secondProgress.filter((event) => event.status).map(({ episode, status }) => [episode, status]), [
    ['第2集', 'checking'], ['第2集', 'skipped'], ['第10集', 'checking'], ['第10集', 'skipped'],
  ]);

  const overwriteButSkip = await runBatch({ strictInstrumental: false, ...options, overwrite: true, skipCompleted: true }, { log() {}, error() {} });
  assert.equal(overwriteButSkip.failed, 0);
  assert.equal(overwriteButSkip.skipped, 2);

  const changedButSkipped = await runBatch({ strictInstrumental: false, ...options, fadeIn: 0.8, skipCompleted: true }, { log() {}, error() {} });
  assert.equal(changedButSkipped.failed, 0);
  assert.equal(changedButSkipped.skipped, 2);

  const rerunProgress = [];
  const rerun = await runBatch({ strictInstrumental: false, ...options, fadeIn: 0.8, skipCompleted: false }, { log() {}, error() {}, progress(event) { rerunProgress.push(event); } });
  assert.equal(rerun.failed, 0);
  assert.equal(rerun.completed, 2);
  assert.equal(rerunProgress.filter((event) => event.status === 'processing').length, 2);

  const selectionOnly = await runBatch({ strictInstrumental: false, ...options, outputAudio: false, outputVideo: false, outputTimeline: true, outputTranscript: false }, { log() {}, error() {} });
  assert.equal(selectionOnly.skipped, 2);
  let selectionState = JSON.parse(await fs.readFile(path.join(outputDir, '.mvp-state.json'), 'utf8'));
  const selectedEpisode = selectionState.episodes[path.join(videoDir, '第2集.mp4')];
  assert.equal(selectedEpisode.outputAudio, false);
  assert.equal(selectedEpisode.outputVideo, false);
  assert.equal(selectedEpisode.outputTimeline, true);
  assert.equal(selectedEpisode.outputTranscript, false);
  assert.equal((await runBatch({ strictInstrumental: false, ...options }, { log() {}, error() {} })).skipped, 2);

  await makeSilentWav(path.join(outputDir, '第10集_bgm.wav'), 2.5);
  const recoveredProgress = [];
  const recoveredOutput = await runBatch({ strictInstrumental: false, ...options }, { log() {}, error() {}, progress(event) { recoveredProgress.push(event); } });
  assert.equal(recoveredOutput.failed, 0);
  assert.equal(recoveredOutput.completed, 1);
  assert.equal(recoveredOutput.skipped, 1);
  assert.deepEqual(recoveredProgress.filter((event) => event.status).map(({ episode, status }) => [episode, status]), [
    ['第2集', 'checking'], ['第2集', 'skipped'], ['第10集', 'checking'], ['第10集', 'processing'], ['第10集', 'completed'],
  ]);

  await fs.writeFile(path.join(transcriptDir, '第2集.json'), JSON.stringify({ segments: [] }), 'utf8');
  const changedTranscript = await runBatch({ strictInstrumental: false, ...options, skipCompleted: false }, { log() {}, error() {} });
  assert.equal(changedTranscript.completed, 2);
  assert.equal(changedTranscript.skipped, 0);
  assert.equal(changedTranscript.results.find((item) => item.episode === '第2集').mood, '平静（叙事铺底）');
  assert.match(await fs.readFile(csv, 'utf8'), /,0,\[\],0:00,0,local-context-music-v6,/);
  await fs.writeFile(finalVideo, 'broken final output', 'utf8');
  const recoveredFinal = await runBatch({ strictInstrumental: false, ...options }, { log() {}, error() {} });
  assert.equal(recoveredFinal.completed, 1);
  assert.ok((await probe(finalVideo)).streams.some((stream) => stream.codec_type === 'video')); 

  await fs.writeFile(path.join(videoDir, '第2集.mp4'), 'not a video', 'utf8');
  const damagedInput = await runBatch({ strictInstrumental: false, ...options }, { log() {}, error() {} });
  assert.equal(damagedInput.failed, 1);
  const state = JSON.parse(await fs.readFile(path.join(outputDir, '.mvp-state.json'), 'utf8'));
  assert.equal(state.episodes[path.join(videoDir, '第2集.mp4')].status, 'failed');
  assert.equal(await fs.stat(wav).then(() => true), true);

  await makeVideo(path.join(videoDir, '第2集.mp4'));
  await fs.writeFile(path.join(videoDir, '坏集.mp4'), 'not a video', 'utf8');
  const thirdOutput = path.join(root, '输出-失败继续');
  const third = await runBatch({ strictInstrumental: false, ...options, output: thirdOutput }, { log() {}, error() {} });
  assert.equal(third.failed, 1);
  assert.equal(third.completed, 2);
});

test('selected outputs render only required artifacts and preserve deselected older files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-mvp-output-selection-'));
  const videoDir = path.join(root, 'videos');
  const musicDir = path.join(root, 'BGM', '默认');
  const outputDir = path.join(root, 'output');
  await Promise.all([
    fs.mkdir(videoDir, { recursive: true }),
    fs.mkdir(musicDir, { recursive: true }),
    fs.mkdir(outputDir, { recursive: true }),
  ]);
  await makeAudio(path.join(musicDir, '平稳.wav'), 440);
  await makeVideo(path.join(videoDir, '样片.mp4'));

  const oldFiles = new Map([
    ['样片_bgm.wav', 'keep old audio'],
    ['样片_final.mp4', 'keep old video'],
    ['样片_transcript.json', 'keep old transcript'],
  ]);
  for (const [name, contents] of oldFiles) await fs.writeFile(path.join(outputDir, name), contents, 'utf8');

  const summary = await runBatch({ strictInstrumental: false,
    videos: videoDir, music: path.dirname(musicDir), output: outputDir,
    transcribe: false, overwrite: false, outputAudio: false, outputVideo: false,
    outputTimeline: true, outputTranscript: false, duckDb: -10, fadeIn: 0.1, fadeOut: 0.1, ffmpeg, ffprobe,
  }, { log() {}, error() {} });

  assert.equal(summary.completed, 1);
  assert.ok((await fs.stat(path.join(outputDir, '样片_timeline.csv'))).isFile());
  for (const [name, contents] of oldFiles) assert.equal(await fs.readFile(path.join(outputDir, name), 'utf8'), contents);
  await assert.rejects(fs.access(path.join(outputDir, '样片_bgm.wav.part.wav')));
  const state = JSON.parse(await fs.readFile(path.join(outputDir, '.mvp-state.json'), 'utf8'));
  const episode = state.episodes[path.join(videoDir, '样片.mp4')];
  assert.equal(episode.outputAudio, false);
  assert.equal(episode.outputVideo, false);
  assert.equal(episode.outputTimeline, true);
  assert.equal(episode.outputTranscript, false);
  const oldTimeline = await fs.readFile(path.join(outputDir, '样片_timeline.csv'), 'utf8');

  const videoOnly = await runBatch({ strictInstrumental: false,
    videos: videoDir, music: path.dirname(musicDir), output: outputDir,
    transcribe: false, overwrite: true, outputAudio: false, outputVideo: true,
    outputTimeline: false, outputTranscript: false, duckDb: -10, fadeIn: 0.1, fadeOut: 0.1, ffmpeg, ffprobe,
  }, { log() {}, error() {} });
  assert.equal(videoOnly.completed, 1);
  const finalVideo = await probe(path.join(outputDir, '样片_final.mp4'));
  assert.ok(finalVideo.streams.some((stream) => stream.codec_type === 'video'));
  assert.ok(finalVideo.streams.some((stream) => stream.codec_type === 'audio'));
  assert.equal(await fs.readFile(path.join(outputDir, '样片_bgm.wav'), 'utf8'), oldFiles.get('样片_bgm.wav'));
  assert.equal(await fs.readFile(path.join(outputDir, '样片_timeline.csv'), 'utf8'), oldTimeline);
  assert.equal(await fs.readFile(path.join(outputDir, '样片_transcript.json'), 'utf8'), oldFiles.get('样片_transcript.json'));
  await assert.rejects(fs.access(path.join(outputDir, '样片_bgm.wav.part.wav')));
  const finalState = JSON.parse(await fs.readFile(path.join(outputDir, '.mvp-state.json'), 'utf8'));
  const finalEpisode = finalState.episodes[path.join(videoDir, '样片.mp4')];
  assert.equal(finalEpisode.outputAudio, false);
  assert.equal(finalEpisode.outputVideo, true);
  assert.equal(finalEpisode.outputTimeline, false);
});

test('saves transcript text and timestamps when transcription is enabled', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-mvp-transcript-'));
  const videoDir = path.join(root, 'videos');
  const musicDir = path.join(root, 'BGM', '默认');
  const transcriptDir = path.join(root, 'transcripts');
  const outputDir = path.join(root, 'output');
  await Promise.all([
    fs.mkdir(videoDir, { recursive: true }),
    fs.mkdir(musicDir, { recursive: true }),
    fs.mkdir(transcriptDir, { recursive: true }),
    fs.mkdir(outputDir, { recursive: true }),
  ]);
  await makeAudio(path.join(musicDir, '平稳.wav'), 440);
  await makeVideo(path.join(videoDir, '样片.mp4'));
  const segments = [{ start: 0.6, end: 1.1, text: 'This is our wedding.' }];
  await fs.writeFile(path.join(transcriptDir, '样片.json'), JSON.stringify({ segments }), 'utf8');

  const options = {
    videos: videoDir, music: path.dirname(musicDir), output: outputDir, transcripts: transcriptDir,
    transcribe: true, mood: null, duckDb: -10, fadeIn: 0.1, fadeOut: 0.1, overwrite: false, ffmpeg, ffprobe,
  };
  const transcriptPath = path.join(outputDir, '样片_transcript.json');
  await fs.writeFile(transcriptPath, 'keep user transcript', 'utf8');
  const protectedAttempt = await runBatch({ strictInstrumental: false, ...options }, { log() {}, error() {} });
  assert.equal(protectedAttempt.failed, 1);
  assert.equal(await fs.readFile(transcriptPath, 'utf8'), 'keep user transcript');
  await fs.unlink(transcriptPath);

  const first = await runBatch({ strictInstrumental: false, ...options }, { log() {}, error() {} });
  assert.equal(first.failed, 0);
  assert.equal(first.results[0].transcriptPath, transcriptPath);
  assert.deepEqual(JSON.parse(await fs.readFile(transcriptPath, 'utf8')).segments, segments);
  assert.equal((await runBatch({ strictInstrumental: false, ...options }, { log() {}, error() {} })).skipped, 1);

  const updatedSegments = [{ start: 0.6, end: 1.1, text: 'She slapped me.' }];
  await fs.writeFile(path.join(transcriptDir, '样片.json'), JSON.stringify({ segments: updatedSegments }), 'utf8');
  assert.equal((await runBatch({ strictInstrumental: false, ...options, skipCompleted: false }, { log() {}, error() {} })).completed, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(transcriptPath, 'utf8')).segments, updatedSegments);

  await fs.unlink(transcriptPath);
  const resumed = await runBatch({ strictInstrumental: false, ...options }, { log() {}, error() {} });
  assert.equal(resumed.completed, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(transcriptPath, 'utf8')).segments, updatedSegments);
});

test('fails clearly when a packaged transcriber executable is missing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-mvp-transcriber-runtime-'));
  const videoDir = path.join(root, 'videos');
  const musicDir = path.join(root, 'BGM', '默认');
  const outputDir = path.join(root, 'output');
  await Promise.all([
    fs.mkdir(videoDir, { recursive: true }),
    fs.mkdir(musicDir, { recursive: true }),
    fs.mkdir(outputDir, { recursive: true }),
  ]);
  await makeAudio(path.join(musicDir, '平稳.wav'), 440);
  await makeVideo(path.join(videoDir, '样片.mp4'));
  const summary = await runBatch({ strictInstrumental: false,
    videos: videoDir, music: path.dirname(musicDir), output: outputDir,
    transcribe: true, transcriberExecutable: path.join(root, 'missing-transcriber.exe'),
    duckDb: -10, fadeIn: 0.1, fadeOut: 0.1, overwrite: false, ffmpeg, ffprobe,
  }, { log() {}, error() {} });
  assert.equal(summary.failed, 1);
  assert.match(summary.results[0].error, /内置转录组件不存在/);
});

test('does not overwrite unowned files and renders videos without audio', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-mvp-safety-'));
  const videoDir = path.join(root, 'videos');
  const musicDir = path.join(root, 'BGM', '默认');
  const outputDir = path.join(root, 'output');
  await Promise.all([
    fs.mkdir(videoDir, { recursive: true }),
    fs.mkdir(musicDir, { recursive: true }),
    fs.mkdir(outputDir, { recursive: true }),
  ]);
  await makeAudio(path.join(musicDir, '平稳.wav'), 440);
  await makeSilentVideo(path.join(videoDir, '无音轨.mp4'));
  await makeSilentVideo(path.join(videoDir, '手工.mp4'));
  const protectedPath = path.join(outputDir, '手工_bgm.wav');
  await fs.writeFile(protectedPath, 'keep this user file', 'utf8');

  const summary = await runBatch({ strictInstrumental: false,
    videos: videoDir,
    music: path.dirname(musicDir),
    output: outputDir,
    transcripts: null,
    transcribe: false,
    mood: null,
    duckDb: -10,
    fadeIn: 0.1,
    fadeOut: 0.1,
    overwrite: false,
    ffmpeg,
    ffprobe,
  }, { log() {}, error() {} });

  assert.equal(summary.completed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(await fs.readFile(protectedPath, 'utf8'), 'keep this user file');
  assert.equal(await outputIsPcm(path.join(outputDir, '无音轨_bgm.wav')), true);
});

async function outputIsPcm(filePath) {
  const media = await probe(filePath);
  const audio = media.streams.find((stream) => stream.codec_name === 'pcm_s16le');
  return Boolean(audio && Number(audio.sample_rate) === 48000 && Number(audio.channels) === 2);
}

test('limits rendered BGM peaks to preserve headroom', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-mvp-limiter-'));
  const videoDir = path.join(root, 'videos');
  const musicDir = path.join(root, 'BGM', '默认');
  const outputDir = path.join(root, 'output');
  await Promise.all([
    fs.mkdir(videoDir, { recursive: true }),
    fs.mkdir(musicDir, { recursive: true }),
  ]);
  await makeAudio(path.join(musicDir, '满电平.wav'), 440, 8, 2);
  await makeVideo(path.join(videoDir, '峰值.mp4'));

  const summary = await runBatch({ strictInstrumental: false,
    videos: videoDir,
    music: path.dirname(musicDir),
    output: outputDir,
    transcripts: null,
    transcribe: false,
    mood: null,
    duckDb: -10,
    fadeIn: 0,
    fadeOut: 0,
    overwrite: false,
    ffmpeg,
    ffprobe,
  }, { log() {}, error() {} });

  assert.equal(summary.failed, 0);
  const wav = path.join(outputDir, '峰值_bgm.wav');
  assert.ok(await wavMaxDb(wav) <= -0.9);
  assert.ok(Math.abs(Number((await probe(wav)).format.duration) - 2.5) <= 0.05);
});

test('preserves the requested BGM duration after loudnorm resampling', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-mvp-loudnorm-duration-'));
  const track = path.join(root, '平稳.wav');
  const output = path.join(root, 'output.wav');
  const duration = 67.849;
  await makeAudio(track, 440);

  const filter = buildMultiTrackFilter(
    [{ start: 0, end: duration, track }],
    duration,
    { fadeIn: 0, fadeOut: 2, autoDuck: false, duckDb: -10 },
    [],
    false,
  );
  await execFileAsync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-stream_loop', '-1', '-i', track,
    '-filter_complex', filter, '-map', '[aout]', '-t', String(duration),
    '-vn', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', output,
  ], { windowsHide: true });

  const media = await probe(output);
  assert.ok(Math.abs(Number(media.format.duration) - duration) <= 0.05);
});

test('splits a long episode at a transcript mood turn and renders two BGM segments', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-mvp-scenes-'));
  const videoDir = path.join(root, 'videos');
  const musicDir = path.join(root, 'BGM');
  const transcriptDir = path.join(root, 'transcripts');
  const outputDir = path.join(root, 'output');
  await Promise.all([
    fs.mkdir(videoDir, { recursive: true }),
    fs.mkdir(path.join(musicDir, '01_紧张_激烈冲突'), { recursive: true }),
    fs.mkdir(path.join(musicDir, '08_悲伤_失落离别'), { recursive: true }),
    fs.mkdir(transcriptDir, { recursive: true }),
  ]);
  await makeAudio(path.join(musicDir, '01_紧张_激烈冲突', '冲突.wav'), 330);
  await makeAudio(path.join(musicDir, '08_悲伤_失落离别', '离别.wav'), 660);
  await makeVideo(path.join(videoDir, '转折.mp4'), 50);
  await fs.writeFile(path.join(transcriptDir, '转折.json'), JSON.stringify({ segments: [
    { start: 2, end: 18, text: '危险，快跑，前面有人追杀' },
    { start: 28, end: 46, text: '我很难过，眼泪止不住，对不起' },
  ] }), 'utf8');

  const summary = await runBatch({ strictInstrumental: false,
    videos: videoDir,
    music: musicDir,
    output: outputDir,
    transcripts: transcriptDir,
    transcribe: false,
    mood: null,
    duckDb: -10,
    fadeIn: 0.2,
    fadeOut: 0.2,
    overwrite: false,
    ffmpeg,
    ffprobe,
  }, { log() {}, error() {} });

  assert.equal(summary.failed, 0);
  const wav = path.join(outputDir, '转折_bgm.wav');
  const csv = (await fs.readFile(path.join(outputDir, '转折_timeline.csv'), 'utf8')).trim().split(/\r?\n/);
  assert.equal(csv.length, 3);
  assert.match(csv[1], /01_紧张_激烈冲突/);
  assert.match(csv[2], /08_悲伤_失落离别/);
  assert.match(csv[1], /对白线索/);
  assert.notEqual(csv[1].split(',')[4], csv[2].split(',')[4]);
  const media = await probe(wav);
  const audio = media.streams.find((stream) => stream.codec_name === 'pcm_s16le');
  assert.ok(audio);
  assert.ok(Math.abs(Number(media.format.duration) - 50) <= 0.05);
});

test('required scene renders a short switch despite the cap while the disabled mode keeps one track', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-required-short-scene-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const videoDir = path.join(root, 'videos');
  const musicDir = path.join(root, 'music');
  await Promise.all([fs.mkdir(videoDir), fs.mkdir(musicDir)]);
  await makeSceneVideo(path.join(videoDir, 'short.mp4'), 2);
  await makeAudio(path.join(musicDir, 'a.wav'), 330);
  await makeAudio(path.join(musicDir, 'b.wav'), 440);
  for (const scenePriority of [true, false]) {
    const summary = await runBatch({ videos: videoDir, music: musicDir, output: path.join(root, String(scenePriority)),
      strictInstrumental: false, transcribe: false, scenePriority, minTracksPerEpisode: 1, maxTracksPerEpisode: 1,
      freezeTail: 0, fadeIn: 0, fadeOut: 0, ffmpeg, ffprobe }, { log() {}, error() {} });
    assert.equal(summary.completed, 1, JSON.stringify(summary));
    const result = summary.results[0];
    assert.equal(result.analysis.trackCount.actual, scenePriority ? 2 : 1);
    assert.equal(result.analysis.trackCount.exceededBy, scenePriority ? 1 : 0);
    assert.ok(result.analysis.sceneCandidates.length);
    if (scenePriority) {
      assert.ok(result.analysis.sceneCandidates.every((cut) => cut.required && cut.used));
      assert.ok(Math.abs(result.analysis.segments[1].start - 2) < 0.05);
      assert.notEqual(result.tracks[0], result.tracks[1]);
      assert.match(result.analysis.trackCount.warning, /转场必换.*上限 1 段.*实际 2 段.*超出 1 段/);
      assert.match(await fs.readFile(result.timelinePath, 'utf8'), /超出 1 段/);
      assert.match(await fs.readFile(path.join(root, String(scenePriority), 'run-report.md'), 'utf8'), /超出 1 段/);
    }
    await execFileAsync(ffmpeg, ['-v', 'error', '-i', result.finalVideoPath, '-f', 'null', '-'], { windowsHide: true });
    assert.ok(Math.abs(Number((await probe(result.finalVideoPath)).format.duration) - 4) < 0.05);
  }
});

test('minimum produces two rendered songs at a visual cut and preserves the configured freeze tail', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-mvp-visual-cuts-'));
  const videoDir = path.join(root, 'videos');
  const musicDir = path.join(root, 'BGM', '默认');
  const outputDir = path.join(root, 'output');
  await Promise.all([
    fs.mkdir(videoDir, { recursive: true }),
    fs.mkdir(musicDir, { recursive: true }),
  ]);
  await makeAudio(path.join(musicDir, '平稳1.wav'), 330);
  await makeAudio(path.join(musicDir, '平稳2.wav'), 440);
  await makeSilentWav(path.join(musicDir, '静音.wav'), 4);
  await fs.writeFile(path.join(musicDir, '损坏.mp3'), '不是有效音频');
  await makeSceneVideo(path.join(videoDir, '转场.mp4'));

  const summary = await runBatch({ strictInstrumental: false,
    videos: videoDir,
    music: path.dirname(musicDir),
    output: outputDir,
    transcribe: false,
    minTracksPerEpisode: 2,
    maxTracksPerEpisode: 3,
    scenePriority: true,
    mood: null,
    autoDuck: false,
    duckDb: -10,
    fadeIn: 0,
    fadeOut: 0.2,
    freezeTail: '2:15',
    overwrite: false,
    ffmpeg,
    ffprobe,
  }, { log() {}, error() {} });

  assert.equal(summary.failed, 0);
  const rows = (await fs.readFile(path.join(outputDir, '转场_timeline.csv'), 'utf8')).trim().split(/\r?\n/);
  assert.equal(rows.length, 3);
  assert.equal(Number(rows[1].split(',')[2]), 0);
  assert.ok(Math.abs(Number(rows[1].split(',')[3]) - 15) < 0.05);
  assert.ok(Math.abs(Number(rows[2].split(',')[3]) - 27.4) < 0.05);
  assert.equal(summary.results[0].analysis.trackCount.actual, 2);
  assert.equal(summary.results[0].analysis.trackCount.met, true);
  assert.notEqual(summary.results[0].tracks[0], summary.results[0].tracks[1]);
  assert.ok(summary.results[0].analysis.sceneCandidates.some((cut) => cut.used));
  assert.equal(rows[1].split(',')[11], '2:15');
  assert.equal(Number(rows[1].split(',')[12]), 2.6);
  const bgm = await probe(path.join(outputDir, '转场_bgm.wav'));
  const finalVideo = await probe(path.join(outputDir, '转场_final.mp4'));
  assert.ok(Math.abs(Number(bgm.format.duration) - 27.4) < 0.05);
  assert.ok(Math.abs(Number(finalVideo.format.duration) - 30) < 0.2);
  const state = JSON.parse(await fs.readFile(path.join(outputDir, '.mvp-state.json'), 'utf8'));
  assert.equal(state.version, 14);
  assert.equal(state.musicCatalog[path.resolve(musicDir, '损坏.mp3')].playable, false);
  assert.equal(state.musicCatalog[path.resolve(musicDir, '静音.wav')].playable, false);
});
