'use strict';

const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { runBatch, writeBatchReport, PLANNING_VERSION } = require('../src/mvp');
const { createAudioClassifier } = require('../desktop/audio-classifier');
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  try {
    const manifest = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
    assert.ok(Array.isArray(manifest.episodes) && manifest.episodes.length && new Set(manifest.episodes).size === manifest.episodes.length);
    assert.notEqual(path.resolve(manifest.options.output), path.resolve(manifest.options.videos));
    const started = Date.now();
    const results = [];
    let library;
    for (const episode of manifest.episodes) {
      const summary = await runBatch({ ...manifest.options, createAudioClassifier, runMode: 'episode', episodeVideoPath: path.join(manifest.options.videos, episode + '.mp4'), skipCompleted: false }, {
        log: console.log, error: console.error,
        progress(event) { if (event.episode && event.stage) console.log(JSON.stringify({ episode: event.episode, stage: event.stage })); },
      });
      results.push(...summary.results);
      library = summary.library;
    }
    const summary = { generatedAt: new Date().toISOString(), analysisVersion: PLANNING_VERSION, library, videos: results.length,
      completed: results.filter((item) => item.status === 'completed').length, skipped: 0, failed: results.filter((item) => item.status === 'failed').length,
      interrupted: 0, pending: 0, elapsedMs: Date.now() - started, results };
    assert.equal(summary.completed, manifest.episodes.length, JSON.stringify(results.filter((item) => item.status !== 'completed')));
    const state = JSON.parse(await fs.readFile(path.join(manifest.options.output, '.mvp-state.json'), 'utf8'));
    await fs.writeFile(path.join(manifest.options.output, 'run-summary.json'), JSON.stringify(summary, null, 2));
    await writeBatchReport(manifest.options.output, summary, manifest.episodes.map((episode) => path.join(manifest.options.videos, episode + '.mp4')), state);
    console.log(JSON.stringify({ completed: summary.completed, elapsedMs: summary.elapsedMs }));
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { app.exit(process.exitCode || 0); }
});
