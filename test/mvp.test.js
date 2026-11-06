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
    '-f', 'lavfi', '-i', `color=c=blue:s=160x120:r=25:d=${sceneDuration}`,
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
    options: { maxTracksPerEpisode: 2 },
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
  assert.equal(oneMood.segments.length, 1);
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

test('uses sensitive mood changes for the minimum target without uniform splitting', () => {
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
});

test('understands English clause turns and ignores negated mood words', () => {
  const groups = new Map([
    ['浪漫', ['romance.wav']],
    ['愤怒', ['anger.wav']],
    ['默认', ['default.wav']],
  ]);
  const plan = buildMusicPlan({
    duration: 60,
    transcript: { segments: [{ start: 0, end: 60, text: "I love you, but how dare you treat me like this?" }] },
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
  const first = await runBatch(options, { log() {}, error() {} });
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
  const second = await runBatch(options, { log() {}, error() {}, progress(event) { secondProgress.push(event); } });
  assert.equal(second.failed, 0);
  assert.equal(second.skipped, 2);
  assert.equal(secondProgress.filter((event) => event.status === 'checking').length, 2);
  assert.equal(secondProgress.some((event) => event.status === 'processing'), false);
  assert.deepEqual(secondProgress.filter((event) => event.episode).map(({ episode, status }) => [episode, status]), [
    ['第2集', 'checking'], ['第2集', 'skipped'], ['第10集', 'checking'], ['第10集', 'skipped'],
  ]);

  const overwriteButSkip = await runBatch({ ...options, overwrite: true, skipCompleted: true }, { log() {}, error() {} });
  assert.equal(overwriteButSkip.failed, 0);
  assert.equal(overwriteButSkip.skipped, 2);

  const changedButSkipped = await runBatch({ ...options, fadeIn: 0.8, skipCompleted: true }, { log() {}, error() {} });
  assert.equal(changedButSkipped.failed, 0);
  assert.equal(changedButSkipped.skipped, 2);

  const rerunProgress = [];
  const rerun = await runBatch({ ...options, fadeIn: 0.8, skipCompleted: false }, { log() {}, error() {}, progress(event) { rerunProgress.push(event); } });
  assert.equal(rerun.failed, 0);
  assert.equal(rerun.completed, 2);
  assert.equal(rerunProgress.filter((event) => event.status === 'processing').length, 2);

  const selectionOnly = await runBatch({ ...options, outputAudio: false, outputVideo: false, outputTimeline: true, outputTranscript: false }, { log() {}, error() {} });
  assert.equal(selectionOnly.skipped, 2);
  let selectionState = JSON.parse(await fs.readFile(path.join(outputDir, '.mvp-state.json'), 'utf8'));
  const selectedEpisode = selectionState.episodes[path.join(videoDir, '第2集.mp4')];
  assert.equal(selectedEpisode.outputAudio, false);
  assert.equal(selectedEpisode.outputVideo, false);
  assert.equal(selectedEpisode.outputTimeline, true);
  assert.equal(selectedEpisode.outputTranscript, false);
  assert.equal((await runBatch(options, { log() {}, error() {} })).skipped, 2);

  await makeSilentWav(path.join(outputDir, '第10集_bgm.wav'), 2.5);
  const recoveredProgress = [];
  const recoveredOutput = await runBatch(options, { log() {}, error() {}, progress(event) { recoveredProgress.push(event); } });
  assert.equal(recoveredOutput.failed, 0);
  assert.equal(recoveredOutput.completed, 1);
  assert.equal(recoveredOutput.skipped, 1);
  assert.deepEqual(recoveredProgress.filter((event) => event.episode).map(({ episode, status }) => [episode, status]), [
    ['第2集', 'checking'], ['第2集', 'skipped'], ['第10集', 'checking'], ['第10集', 'processing'], ['第10集', 'completed'],
  ]);

  await fs.writeFile(path.join(transcriptDir, '第2集.json'), JSON.stringify({ segments: [] }), 'utf8');
  const changedTranscript = await runBatch({ ...options, skipCompleted: false }, { log() {}, error() {} });
  assert.equal(changedTranscript.completed, 2);
  assert.equal(changedTranscript.skipped, 0);
  assert.equal(changedTranscript.results.find((item) => item.episode === '第2集').mood, '默认');
  assert.match(await fs.readFile(csv, 'utf8'), /,-10,\[\],0:00,0\n/);
  await fs.writeFile(finalVideo, 'broken final output', 'utf8');
  const recoveredFinal = await runBatch(options, { log() {}, error() {} });
  assert.equal(recoveredFinal.completed, 1);
  assert.ok((await probe(finalVideo)).streams.some((stream) => stream.codec_type === 'video')); 

  await fs.writeFile(path.join(videoDir, '第2集.mp4'), 'not a video', 'utf8');
  const damagedInput = await runBatch(options, { log() {}, error() {} });
  assert.equal(damagedInput.failed, 1);
  const state = JSON.parse(await fs.readFile(path.join(outputDir, '.mvp-state.json'), 'utf8'));
  assert.equal(state.episodes[path.join(videoDir, '第2集.mp4')].status, 'failed');
  assert.equal(await fs.stat(wav).then(() => true), true);

  await makeVideo(path.join(videoDir, '第2集.mp4'));
  await fs.writeFile(path.join(videoDir, '坏集.mp4'), 'not a video', 'utf8');
  const thirdOutput = path.join(root, '输出-失败继续');
  const third = await runBatch({ ...options, output: thirdOutput }, { log() {}, error() {} });
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

  const summary = await runBatch({
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

  const videoOnly = await runBatch({
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
  const protectedAttempt = await runBatch(options, { log() {}, error() {} });
  assert.equal(protectedAttempt.failed, 1);
  assert.equal(await fs.readFile(transcriptPath, 'utf8'), 'keep user transcript');
  await fs.unlink(transcriptPath);

  const first = await runBatch(options, { log() {}, error() {} });
  assert.equal(first.failed, 0);
  assert.equal(first.results[0].transcriptPath, transcriptPath);
  assert.deepEqual(JSON.parse(await fs.readFile(transcriptPath, 'utf8')).segments, segments);
  assert.equal((await runBatch(options, { log() {}, error() {} })).skipped, 1);

  const updatedSegments = [{ start: 0.6, end: 1.1, text: 'She slapped me.' }];
  await fs.writeFile(path.join(transcriptDir, '样片.json'), JSON.stringify({ segments: updatedSegments }), 'utf8');
  assert.equal((await runBatch({ ...options, skipCompleted: false }, { log() {}, error() {} })).completed, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(transcriptPath, 'utf8')).segments, updatedSegments);

  await fs.unlink(transcriptPath);
  const resumed = await runBatch(options, { log() {}, error() {} });
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
  const summary = await runBatch({
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

  const summary = await runBatch({
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

  const summary = await runBatch({
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

  const summary = await runBatch({
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
  assert.match(csv[1], /片段对白关键词/);
  assert.notEqual(csv[1].split(',')[4], csv[2].split(',')[4]);
  const media = await probe(wav);
  const audio = media.streams.find((stream) => stream.codec_name === 'pcm_s16le');
  assert.ok(audio);
  assert.ok(Math.abs(Number(media.format.duration) - 50) <= 0.05);
});

test('does not change BGM at visual cuts and ends music at the configured freeze tail', async () => {
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

  const summary = await runBatch({
    videos: videoDir,
    music: path.dirname(musicDir),
    output: outputDir,
    transcribe: false,
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
  assert.equal(rows.length, 2);
  assert.equal(Number(rows[1].split(',')[2]), 0);
  assert.ok(Math.abs(Number(rows[1].split(',')[3]) - 27.4) < 0.05);
  assert.equal(rows[1].split(',')[11], '2:15');
  assert.equal(Number(rows[1].split(',')[12]), 2.6);
  const bgm = await probe(path.join(outputDir, '转场_bgm.wav'));
  const finalVideo = await probe(path.join(outputDir, '转场_final.mp4'));
  assert.ok(Math.abs(Number(bgm.format.duration) - 27.4) < 0.05);
  assert.ok(Math.abs(Number(finalVideo.format.duration) - 30) < 0.2);
  const state = JSON.parse(await fs.readFile(path.join(outputDir, '.mvp-state.json'), 'utf8'));
  assert.equal(state.version, 13);
  assert.equal(state.musicCatalog[path.resolve(musicDir, '损坏.mp3')].playable, false);
  assert.equal(state.musicCatalog[path.resolve(musicDir, '静音.wav')].playable, false);
});
