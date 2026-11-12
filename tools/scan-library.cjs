'use strict';

const { app } = require('electron');
const fs = require('node:fs/promises');
const { createAudioClassifier } = require('../desktop/audio-classifier');
const { checkMusicLibrary, stopLibraryAnalysis } = require('../desktop/backend/batch-service');

process.on('SIGINT', stopLibraryAnalysis);
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const started = Date.now();
  let peakMemoryBytes = 0;
  const sampler = setInterval(() => { peakMemoryBytes = Math.max(peakMemoryBytes, app.getAppMetrics().reduce((sum, entry) => sum + entry.memory.workingSetSize * 1024, 0)); }, 500);
  try {
    const report = await checkMusicLibrary({ music: process.argv[2], libraryCacheDir: process.argv[4], analyzeVocals: true, createAudioClassifier, ffmpeg: process.env.FFMPEG || 'ffmpeg', ffprobe: process.env.FFPROBE || 'ffprobe' }, (progress) => {
      if (progress.checked % 10 === 0 || progress.checked === progress.total) console.log(JSON.stringify(progress));
    });
    Object.assign(report, { elapsedMs: Date.now() - started, peakMemoryBytes });
    await fs.writeFile(process.argv[3], JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ elapsedMs: report.elapsedMs, peakMemoryBytes, counts: report.counts, usable: report.usable }));
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { clearInterval(sampler); app.exit(process.exitCode || 0); }
});
