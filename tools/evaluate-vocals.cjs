'use strict';

const { app } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createAudioClassifier } = require('../desktop/audio-classifier');
const { analyzeTrack, ANALYSIS_SETTINGS, ANALYSIS_VERSION } = require('../src/music-library');
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  let classifier;
  try {
    const manifest = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
    const started = Date.now();
    classifier = await createAudioClassifier();
    const initializationMs = Date.now() - started;
    const results = [];
    for (const sample of manifest.files) {
      const result = await analyzeTrack(sample.file, manifest.ffmpeg || 'ffmpeg', classifier);
      results.push({ ...sample, ...result });
      console.log(JSON.stringify({ file: path.basename(sample.file), expected: sample.expected, status: result.status, maxVocal: result.maxVocal, musicRatio: result.musicRatio, elapsedMs: result.elapsedMs }));
    }
    await fs.writeFile(manifest.output, JSON.stringify({ version: ANALYSIS_VERSION, settings: ANALYSIS_SETTINGS, initializationMs, results }, null, 2));
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { classifier?.close(); app.exit(process.exitCode || 0); }
});
