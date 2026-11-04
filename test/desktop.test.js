'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { episodeDetail, getInfo, inspectBatch, startBatch, stopBatch } = require('../desktop/backend/batch-service');

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

  const batch = await inspectBatch({ videos, output, music: '' });
  assert.equal(batch.rows.length, 1);
  assert.equal(batch.rows[0].status, 'completed');
  const detail = await episodeDetail({ output, episode: '第1集' });
  assert.equal(detail.timeline.length, 1);
  assert.equal(detail.timeline[0].duckSegments[0].start, 1);
  assert.equal(detail.freezeTail, '2:15');
  assert.equal(detail.freezeTailSeconds, 2.6);
  assert.equal(detail.transcript[0].text, '谢谢你');
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
  assert.equal(developmentInfo.defaults.modelPath, 'small');
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
  assert.equal(info.defaults.outputAudio, true);
  assert.equal(info.defaults.outputVideo, true);
  assert.equal(info.defaults.outputTimeline, true);
  assert.equal(info.defaults.outputTranscript, true);
  assert.equal('transcriberExecutable' in info.defaults, false);
});

test('desktop batch settings reject invalid BGM caps and empty output selection', async () => {
  const base = { videos: 'videos', music: 'music', output: 'output', transcribe: false };
  await assert.rejects(startBatch({ ...base, maxTracksPerEpisode: 2.5 }, () => {}), /每集 BGM 上限必须是非负整数/);
  await assert.rejects(startBatch({ ...base, maxTracksPerEpisode: 2, outputAudio: false, outputVideo: false, outputTimeline: false, outputTranscript: false }, () => {}), /请至少选择一种输出内容/);
  await assert.rejects(startBatch({ ...base, outputAudio: false, outputVideo: false, outputTimeline: false, outputTranscript: true }, () => {}), /开启本地转录/);
});
