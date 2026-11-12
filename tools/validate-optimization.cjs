'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { buildMultiTrackFilter, PLANNING_VERSION } = require('../src/mvp');
const execute = promisify(execFile);
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const ffprobe = process.env.FFPROBE || 'ffprobe';
const run = (args, binary = false) => execute(ffmpeg, args, { windowsHide: true, maxBuffer: 150 * 1024 * 1024, ...(binary ? { encoding: 'buffer' } : {}) });
const rms = (bytes) => {
  let squares = 0;
  for (let offset = 0; offset + 4 <= bytes.length; offset += 4) squares += bytes.readFloatLE(offset) ** 2;
  return Math.sqrt(squares / (bytes.length / 4));
};

(async () => {
  const manifest = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
  const summary = JSON.parse(await fs.readFile(path.join(manifest.options.output, 'run-summary.json'), 'utf8'));
  assert.equal(summary.completed, manifest.episodes.length);
  const report = [];
  for (const result of summary.results) {
    assert.equal(result.analysisVersion, PLANNING_VERSION);
    const source = path.join(manifest.options.videos, result.episode + '.mp4');
    const probe = async (file) => JSON.parse((await execute(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,start_time,duration', '-of', 'json', file], { windowsHide: true })).stdout);
    const inputInfo = await probe(source);
    const outputInfo = await probe(result.finalVideoPath);
    const durationDifference = Number(outputInfo.format.duration) - Number(inputInfo.format.duration);
    assert.ok(Math.abs(durationDifference) < 0.05);
    const hashes = [];
    for (const file of [source, result.finalVideoPath]) hashes.push((await run(['-v', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-'])).stdout.trim());
    assert.equal(hashes[0], hashes[1], 'video packets must be identical');
    await run(['-v', 'error', '-i', result.finalVideoPath, '-f', 'null', '-']);
    const musicEnd = result.analysis.segments.at(-1).end;
    const bgmInfo = await probe(result.outputPath);
    assert.ok(Math.abs(Number(bgmInfo.format.duration) - musicEnd) < 0.005);
    assert.ok(result.analysis.segments.every((segment) => !segment.track || ['confirmed', 'instrumental'].includes(segment.instrumentalStatus)));
    const requiredScenes = result.analysis.sceneCandidates.filter((cut) => cut.required);
    for (const cut of requiredScenes) {
      assert.ok(cut.used, 'every required scene must change music');
      const index = result.analysis.segments.findIndex((segment) => segment.start > 0 && Math.abs(segment.start - cut.time) < 0.25);
      assert.ok(index > 0 && result.analysis.segments[index].track !== result.analysis.segments[index - 1].track);
    }
    const tailStart = musicEnd + 0.3;
    const tails = [];
    for (const file of [source, result.finalVideoPath]) tails.push((await run(['-v', 'error', '-ss', String(tailStart), '-i', file, '-t', '1', '-vn', '-ar', '48000', '-ac', '2', '-f', 'f32le', '-'], true)).stdout);
    // AAC and limiter latency can shift samples slightly; measure alignment instead of assuming byte alignment.
    let bestTail = { meanSquare: Infinity, shift: 0 };
    const frames = Math.floor(Math.min(tails[0].length, tails[1].length) / 8);
    for (let shift = -480; shift <= 480; shift += 1) {
      let squares = 0;
      let count = 0;
      for (let frame = 480; frame < frames - 480; frame += 8) { squares += (tails[1].readFloatLE((frame + shift) * 8) - tails[0].readFloatLE(frame * 8)) ** 2; count += 1; }
      if (squares / count < bestTail.meanSquare) bestTail = { meanSquare: squares / count, shift };
    }
    const tailDifferenceDb = 10 * Math.log10(Math.max(bestTail.meanSquare, 1e-24));
    assert.ok(tailDifferenceDb < -30, 'freeze tail should contain only re-encoded original audio');
    const audioStarts = outputInfo.streams.filter((stream) => stream.codec_type === 'audio').map((stream) => Number(stream.start_time));
    const videoStart = Number(outputInfo.streams.find((stream) => stream.codec_type === 'video').start_time);
    assert.ok(audioStarts.every((start) => Math.abs(start - videoStart) < 0.05));
    const baseline = path.resolve('build', result.episode + '-unducked.wav');
    const args = ['-v', 'error', '-y'];
    for (const segment of result.analysis.segments) args.push('-stream_loop', '-1', '-i', segment.track);
    args.push('-filter_complex', buildMultiTrackFilter(result.analysis.segments, musicEnd, { ...manifest.options, autoDuck: false }, [], true), '-map', '[aout]', '-t', String(musicEnd), '-c:a', 'pcm_s16le', baseline);
    await run(args);
    const interval = result.analysis.ducking.intervals.find((item) => item.end - item.start > 0.8 && item.start > 1 && item.end < result.analysis.segments[0].end - 1);
    assert.ok(interval);
    const samples = [];
    for (const file of [result.outputPath, baseline]) samples.push(rms((await run(['-v', 'error', '-ss', String(interval.start + 0.2), '-i', file, '-t', '0.35', '-ac', '2', '-ar', '48000', '-f', 'f32le', '-'], true)).stdout));
    const duckDb = 20 * Math.log10(samples[0] / samples[1]);
    assert.ok(Math.abs(duckDb - manifest.options.duckDb) < 0.6, 'real music must use the requested duck level after normalization');
    await fs.unlink(baseline);
    report.push({ episode: result.episode, durationDifference, videoPacketHashEqual: true, fullDecodePassed: true, musicEnd, tailDifferenceDb, measuredOriginalAudioOffsetMs: bestTail.shift / 48, audioVideoStartDifference: audioStarts[0] - videoStart, measuredDuckDb: duckDb, needsReview: result.analysis.needsReview, sceneCandidates: result.analysis.sceneCandidates.length, requiredSceneTimes: requiredScenes.map((cut) => cut.time), allRequiredScenesChanged: true, segments: result.analysis.segments.map(({ start, end, mood, track, review }) => ({ start, end, mood, track, review })) });
  }
  const protectedFiles = JSON.parse(await fs.readFile(manifest.protectedFiles || 'build/optimization-protected-files.json', 'utf8'));
  for (const original of protectedFiles) { const current = await fs.stat(original.file); assert.equal(current.size, original.size); assert.equal(current.mtimeMs, original.mtimeMs); }
  const output = { checkedAt: new Date().toISOString(), protectedFilesUnchanged: protectedFiles.length, results: report };
  await fs.writeFile(manifest.validationReport || 'build/optimization-validation.json', JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output));
})().catch((error) => { console.error(error); process.exitCode = 1; });
