'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { checkMusicLibrary, diagnostics, episodeDetail, getInfo, inspectBatch, resolveImport, startBatch, stopBatch } = require('../desktop/backend/batch-service');

test('desktop batch service reads queue and links timeline/transcript artifacts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-desktop-service-'));
  const videos = path.join(root, 'videos');
  const output = path.join(root, 'output');
  await Promise.all([fs.mkdir(videos), fs.mkdir(output)]);
  await fs.writeFile(path.join(videos, '第1集.mp4'), 'placeholder');
  await fs.writeFile(path.join(output, '第1集_timeline.csv'), '\uFEFFepisode,segment,start_sec,end_sec,bgm_file,mood,selection_reason,fade_in_sec,fade_out_sec,duck_db,duck_segments,freeze_tail,freeze_tail_sec\n第1集,1,0,12.5,"默认\\平稳,夜.mp3",默认,"片段对白关键词: 谢谢",2,2,-10,"[{""start"":1,""end"":2}]",2:15,2.6\n', 'utf8');
  await fs.writeFile(path.join(output, '第1集_transcript.json'), JSON.stringify({ segments: [{ start: 1, end: 2, text: '谢谢你' }] }), 'utf8');
  await fs.writeFile(path.join(output, '.mvp-state.json'), JSON.stringify({ episodes: {
    [path.resolve(path.join(videos, '第1集.mp4'))]: {
      status: 'completed', duration: 12.5, outputPath: path.join(output, '第1集_bgm.wav'), timelinePath: path.join(output, '第1集_timeline.csv'), transcriptPath: path.join(output, '第1集_transcript.json'), mood: '默认',
    },
  } }), 'utf8');

  const batch = await inspectBatch({ videos, output, music: '', createAudioClassifier() {} });
  assert.doesNotThrow(() => structuredClone(batch));
  assert.equal(batch.rows.length, 1);
  assert.equal(batch.rows[0].status, 'completed');
  const detail = await episodeDetail({ output, episode: '第1集' });
  assert.equal(detail.timeline.length, 1);
  assert.equal(detail.timeline[0].duckSegments[0].start, 1);
  assert.equal(detail.freezeTail, '2:15');
  assert.equal(detail.freezeTailSeconds, 2.6);
  assert.equal(detail.transcript[0].text, '谢谢你');
});


test('desktop preflight distinguishes unset, available, creatable, and invalid paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-desktop-preflight-'));
  const videos = path.join(root, 'single.mp4');
  const music = path.join(root, 'music');
  const output = path.join(root, 'new-output');
  const wrongType = path.join(root, 'not-a-directory.txt');
  await Promise.all([fs.mkdir(music), fs.writeFile(videos, 'placeholder'), fs.writeFile(wrongType, 'placeholder')]);

  const available = await inspectBatch({ videos, music, output });
  assert.deepEqual(available.paths.videos, { status: 'available', label: '\u53ef\u7528' });
  assert.deepEqual(available.paths.music, { status: 'available', label: '\u53ef\u7528' });
  assert.deepEqual(available.paths.output, { status: 'available', label: '\u53ef\u521b\u5efa' });
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });

  const invalid = await inspectBatch({ videos: wrongType, music: wrongType, output: wrongType, modelPath: wrongType });
  assert.equal(invalid.paths.videos.status, 'unavailable');
  assert.equal(invalid.paths.music.status, 'unavailable');
  assert.equal(invalid.paths.output.status, 'unavailable');
  assert.equal(invalid.model.exists, false);

  const unset = await inspectBatch({ videos: '', music: '', output: '' });
  assert.equal(unset.paths.videos.status, 'unset');
  assert.equal(unset.paths.music.status, 'unset');
  assert.equal(unset.paths.output.status, 'unset');
});

test('desktop batch service can stop a queued run before rendering', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-desktop-stop-'));
  const videos = path.join(root, 'videos');
  const music = path.join(root, 'music');
  const output = path.join(root, 'output');
  await Promise.all([fs.mkdir(videos), fs.mkdir(music), fs.mkdir(output)]);

  const events = [];
  await startBatch({ videos, music, output, transcribe: false, overwrite: false }, (event) => events.push(event));
  assert.deepEqual(stopBatch(), { stopped: true });
  for (let attempt = 0; attempt < 50 && !events.some((event) => event.type === 'stopped' || event.type === 'error'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(events.at(-1).type, 'stopped');
  assert.deepEqual(stopBatch(), { stopped: false });
});


test('desktop defaults use packaged model and media-tool paths', () => {
  const developmentInfo = getInfo();
  assert.equal(developmentInfo.defaults.videos, '');
  assert.equal(developmentInfo.defaults.music, '');
  assert.equal(developmentInfo.defaults.modelPath, process.env.FASTER_WHISPER_MODEL || 'small');
  assert.match(developmentInfo.defaults.output, /Documents[\\/]自动配 BGM Studio[\\/]output$/);
  const info = getInfo({ modelPath: 'C:\\app\\resources\\model\\small', ffmpeg: 'C:\\app\\resources\\ffmpeg\\ffmpeg.exe', ffprobe: 'C:\\app\\resources\\ffmpeg\\ffprobe.exe', transcriberExecutable: 'C:\\app\\resources\\transcriber\\bgm-transcriber.exe' });
  assert.equal(info.bundledRuntime, true);
  assert.equal(info.defaults.modelPath, 'C:\\app\\resources\\model\\small');
  assert.equal(info.defaults.ffmpeg, 'C:\\app\\resources\\ffmpeg\\ffmpeg.exe');
  assert.equal(info.defaults.ffprobe, 'C:\\app\\resources\\ffmpeg\\ffprobe.exe');
  assert.equal(info.defaults.videos, '');
  assert.equal(info.defaults.music, '');
  assert.match(info.defaults.output, /Documents[\\/]自动配 BGM Studio[\\/]output$/);
  assert.equal(info.defaults.maxTracksPerEpisode, 3);
  assert.equal(info.defaults.minTracksPerEpisode, 1);
  assert.equal(info.defaults.scenePriority, true);
  assert.equal(info.defaults.outputAudio, true);
  assert.equal(info.defaults.outputVideo, true);
  assert.equal(info.defaults.outputTimeline, true);
  assert.equal(info.defaults.outputTranscript, true);
  assert.equal(info.defaults.transitionFadeEnabled, true);
  assert.equal(info.defaults.transitionFadeDuration, 1);
  assert.equal(info.defaults.skipCompleted, true);
  assert.equal('transcriberExecutable' in info.defaults, false);
});

test('preflight counts current inputs and identifies interrupted state after restart', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-preflight-counts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const video = path.join(root, 'episode.mp4');
  const music = path.join(root, 'music');
  await fs.mkdir(music);
  await fs.writeFile(video, 'placeholder');
  await fs.writeFile(path.join(root, '.mvp-state.json'), JSON.stringify({ episodes: { [video]: { episode: 'episode', status: 'processing', videoPath: video } } }));
  const info = await inspectBatch({ videos: video, music, output: root, transcribe: false });
  assert.equal(info.inputVideoCount, 1);
  assert.equal(info.rows[0].status, 'interrupted');
  assert.match(info.rows[0].error, /继续未完成/);
  assert.equal(typeof info.tools.ffmpeg.available, 'boolean');
  const health = await checkMusicLibrary({ music });
  assert.equal(health.total, 0);
  assert.equal(health.usable, 0);
});

test('drag import identifies media and honours explicit path roles', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-import-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const video = path.join(root, 'episode.mp4');
  const track = path.join(root, 'track.wav');
  await Promise.all([fs.writeFile(video, ''), fs.writeFile(track, '')]);
  assert.deepEqual(await resolveImport({ path: video }), { key: 'videos', path: video });
  assert.deepEqual(await resolveImport({ path: track }), { key: 'music', path: root });
  assert.deepEqual(await resolveImport({ path: root, key: 'output' }), { key: 'output', path: root });
  await assert.rejects(resolveImport({ path: video, key: 'modelPath' }), /请拖入对应目录/);
  await assert.rejects(resolveImport({ path: root, key: '__proto__' }), /用途无效/);
});

test('diagnostics omit private paths, names, arbitrary config, and raw errors', async () => {
  const secret = 'PRIVATE_PERSON_video_and_music';
  const text = await diagnostics({ videos: `C:\\Users\\${secret}\\private.mp4`, music: `/home/${secret}/music`, modelPath: `/home/${secret}/model`, unexpected: secret, freezeTail: secret, language: secret });
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes('private.mp4'), false);
  const info = JSON.parse(text);
  assert.equal(info.路径配置.videos, true);
  assert.equal(info.转录模型.ready, false);
});

test('concurrent starts share a lock and reload info retains run configuration', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-run-lock-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const events = [];
  const config = { videos: root, music: root, output: root, transcribe: false, scenePriority: false };
  const first = startBatch(config, (event) => events.push(event));
  await assert.rejects(startBatch(config), /已有批次/);
  await first;
  assert.equal(getInfo().running, true);
  assert.equal(getInfo().run.config.output, root);
  assert.equal(getInfo().run.config.scenePriority, false);
  assert.equal(getInfo().logs.length, 1);
  stopBatch();
  for (let n = 0; n < 100 && getInfo().running; n += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(getInfo().running, false);
  assert.equal(getInfo().run.status, 'stopped');
  assert.equal(events.at(-1).type, 'stopped');
});

test('desktop batch settings reject invalid BGM caps and empty output selection', async () => {
  const base = { videos: 'videos', music: 'music', output: 'output', transcribe: false };
  await assert.rejects(startBatch({ ...base, minTracksPerEpisode: 0 }, () => {}), /每集 BGM 下限必须是正整数/);
  await assert.rejects(startBatch({ ...base, scenePriority: false, minTracksPerEpisode: 3, maxTracksPerEpisode: 2 }, () => {}), /每集 BGM 下限不能高于上限/);
  await assert.rejects(startBatch({ ...base, maxTracksPerEpisode: 2.5 }, () => {}), /每集 BGM 上限必须是非负整数/);
  await assert.rejects(startBatch({ ...base, transitionFadeEnabled: 'false' }, () => {}), /曲目衔接淡入淡出必须使用开关值/);
  await assert.rejects(startBatch({ ...base, scenePriority: 'false' }, () => {}), /转场必换曲必须使用开关值/);
  await assert.rejects(startBatch({ ...base, skipCompleted: 'false' }, () => {}), /跳过已完成必须使用开关值/);
  await assert.rejects(startBatch({ ...base, transitionFadeDuration: -0.1 }, () => {}), /曲目衔接时长必须是非负数字/);
  await assert.rejects(startBatch({ ...base, transitionFadeDuration: 'invalid' }, () => {}), /曲目衔接时长必须是非负数字/);
  await assert.rejects(startBatch({ ...base, transitionFadeDuration: null }, () => {}), /曲目衔接时长必须是非负数字/);
  await assert.rejects(startBatch({ ...base, maxTracksPerEpisode: 2, outputAudio: false, outputVideo: false, outputTimeline: false, outputTranscript: false }, () => {}), /请至少选择一种输出内容/);
  await assert.rejects(startBatch({ ...base, outputAudio: false, outputVideo: false, outputTimeline: false, outputTranscript: true }, () => {}), /开启本地转录/);
});
