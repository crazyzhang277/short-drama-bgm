'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

(async () => {
  const preview = path.resolve(process.argv[2]);
  assert.ok(process.argv[4] && process.argv[5], 'Usage: node tools/check-packaged-preview.cjs <exe> <report> <video> <instrumental-music> [--release]');
  const sampleVideo = path.resolve(process.argv[4]);
  const sampleMusic = path.resolve(process.argv[5]);
  const releaseBuild = process.argv.includes('--release');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-packaged-check-'));
  const music = path.join(root, 'music');
  await fs.mkdir(music);
  await fs.copyFile(sampleMusic, path.join(music, path.basename(sampleMusic)));
  const results = [];
  for (let launch = 0; launch < 2; launch += 1) {
    const started = Date.now();
    const child = spawn(preview, ['--remote-debugging-port=0', '--user-data-dir=' + path.join(root, 'profile')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let socket;
    child.stderr.on('data', (bytes) => { stderr = (stderr + bytes).slice(-16000); });
    try {
      let target;
      const until = Date.now() + 15000;
      while (Date.now() < until) {
        const port = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(stderr)?.[1];
        if (port) target = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find((item) => item.type === 'page' && item.url.startsWith('file:'));
        if (target) break;
        if (child.exitCode !== null) throw new Error('preview exited: ' + stderr);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(target, stderr);
      socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
      const pending = new Map();
      let id = 0;
      socket.onmessage = (message) => { const data = JSON.parse(message.data); if (pending.has(data.id)) { pending.get(data.id)(data); pending.delete(data.id); } };
      const evaluate = async (expression) => {
        const requestId = ++id;
        const response = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error('preview evaluate timeout: ' + expression)); }, 60000);
          pending.set(requestId, (value) => { clearTimeout(timeout); resolve(value); });
          socket.send(JSON.stringify({ id: requestId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
        });
        assert.ok(!response.error && !response.result.exceptionDetails, JSON.stringify(response));
        return response.result.result.value;
      };
      while (!(await evaluate('Boolean(window.bgmStudio && document.getElementById("config-videos"))'))) {
        if (Date.now() >= until) throw new Error(await evaluate('document.body?.innerText || "page loading"') + '\n' + stderr);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const startupMs = Date.now() - started;
      const info = await evaluate('bgmStudio.appInfo()');
      assert.ok(info.bundledRuntime);
      assert.equal(info.update.enabled, releaseBuild);
      assert.equal(info.version, require('../package.json').version);
      assert.equal(info.defaults.scenePriority, true);
      await evaluate('document.querySelector(".nav-item[data-view=settings]").click()');
      assert.equal(await evaluate('document.getElementById("config-scenePriority").checked'), launch === 0);
      assert.match(await evaluate('document.getElementById("screen").textContent'), /转场必须换，情绪变化也换/);
      assert.equal(await evaluate('document.getElementById("config-maxTracksPerEpisode").disabled'), launch === 0);
      if (!launch) await evaluate('document.getElementById("config-scenePriority").click()');
      assert.equal(await evaluate('document.getElementById("config-maxTracksPerEpisode").disabled'), false);
      assert.equal(await evaluate('JSON.parse(localStorage.getItem("bgm-studio-config")).scenePriority'), false);
      await evaluate('document.querySelector(".nav-item[data-view=desk]").click()');
      const inspect = await evaluate('bgmStudio.inspectBatch(' + JSON.stringify({ videos: sampleVideo, music, output: path.join(root, 'output'), transcribe: true }) + ')');
      assert.equal(inspect.tools.ffmpeg.available, true);
      assert.equal(inspect.tools.ffprobe.available, true);
      assert.ok(inspect.model.exists);
      const libraryStarted = Date.now();
      const library = await evaluate('bgmStudio.checkMusicLibrary(' + JSON.stringify({ music, analyzeVocals: true, strictInstrumental: true, libraryCacheDir: path.join(root, 'cache') }) + ')');
      assert.equal(library.total, 1);
      assert.equal(library.usable, 1);
      assert.equal(library.files[0].status, 'instrumental');
      results.push({ launch: launch + 1, startupMs, libraryMs: Date.now() - libraryStarted, version: info.version, bundledRuntime: true, updatesDisabled: !releaseBuild, localModelWorks: true });
      if (!launch) {
        const config = { videos: sampleVideo, music, output: path.join(root, 'output'), transcribe: true, strictInstrumental: true, scenePriority: false, libraryCacheDir: path.join(root, 'cache'), outputVideo: false, outputAudio: false, outputTimeline: true, outputTranscript: true, freezeTail: '2:16' };
        const batchStarted = Date.now();
        await evaluate('bgmStudio.startBatch(' + JSON.stringify(config) + ')');
        let infoAfter;
        do { await new Promise((resolve) => setTimeout(resolve, 200)); infoAfter = await evaluate('bgmStudio.appInfo()'); assert.ok(Date.now() - batchStarted < 60000); } while (infoAfter.running);
        const summary = JSON.parse(await fs.readFile(path.join(root, 'output', 'run-summary.json'), 'utf8'));
        assert.equal(summary.completed, 1, JSON.stringify(summary));
        assert.equal(summary.results[0].analysis.wordTimestamps, true);
        assert.equal(summary.results[0].analysis.scenePriority, false);
        assert.equal(summary.results[0].analysisVersion, 'scene-required-with-mood-v4');
        assert.equal(summary.results[0].analysis.trackCount.met, true);
        results[0].scenePrioritySwitchPersists = true;
        results[0].offlineTranscriptionMs = Date.now() - batchStarted;
      }
    } finally { socket?.close(); child.kill(); await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); }); }
  }
  await fs.writeFile(process.argv[3] || 'build/packaged-preview-check.json', JSON.stringify({ root, results }, null, 2));
  console.log(JSON.stringify(results));
})().catch((error) => { console.error(error); process.exitCode = 1; });
