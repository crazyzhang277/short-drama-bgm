'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

(async () => {
  const preview = path.resolve(process.argv[2]);
  assert.ok(process.argv[4] && process.argv[5], 'Usage: node tools/check-packaged-preview.cjs <exe> <report> <video> <instrumental-music> [--vocal-sample=<audio>] [--release]');
  const sampleVideo = path.resolve(process.argv[4]);
  const sampleMusic = path.resolve(process.argv[5]);
  const releaseBuild = process.argv.includes('--release');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-packaged-check-'));
  const music = path.join(root, 'music');
  await fs.mkdir(music);
  await fs.copyFile(sampleMusic, path.join(music, path.basename(sampleMusic)));
  const vocalSample = process.argv.find((arg) => arg.startsWith('--vocal-sample='))?.slice('--vocal-sample='.length);
  const vocalMusic = path.join(root, 'vocal-music');
  const vocalFile = path.join(vocalMusic, 'speech.wav');
  if (vocalSample) { await fs.mkdir(vocalMusic); await fs.copyFile(path.resolve(vocalSample), vocalFile); }
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
      const waitFor = async (expression) => {
        const deadline = Date.now() + 15000;
        while (!(await evaluate(expression))) {
          assert.ok(Date.now() < deadline, 'Timed out: ' + expression);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
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
      assert.equal(await evaluate('document.getElementById("config-maxTracksPerEpisode").disabled'), false);
      if (!launch) await evaluate('document.getElementById("config-maxTracksPerEpisode").value="7"; document.getElementById("config-maxTracksPerEpisode").dispatchEvent(new Event("change", {bubbles:true}));');
      assert.equal(await evaluate('Number(document.getElementById("config-maxTracksPerEpisode").value)'), 7);
      assert.equal(await evaluate('Number(JSON.parse(localStorage.getItem("bgm-studio-config")).maxTracksPerEpisode)'), 7);
      assert.match(await evaluate('document.getElementById("screen").textContent'), /转场必换可超限并明确提示/);
      if (!launch) await evaluate('document.getElementById("config-scenePriority").click()');
      assert.equal(await evaluate('document.getElementById("config-maxTracksPerEpisode").disabled'), false);
      assert.equal(await evaluate('JSON.parse(localStorage.getItem("bgm-studio-config")).scenePriority'), false);
      await evaluate('document.querySelector(".nav-item[data-view=desk]").click()');
      for (const key of ['strictInstrumental', 'preflightEnabled']) assert.equal(await evaluate(`document.querySelector('[data-config-key=${key}]').checked`), launch === 0);
      const skipped = await evaluate('bgmStudio.inspectBatch(' + JSON.stringify({ videos: sampleVideo, music, output: path.join(root, 'output'), transcribe: true, preflightEnabled: false }) + ')');
      assert.equal(skipped.rows.length, 1);
      assert.deepEqual(skipped.paths, {});
      assert.equal(skipped.model, null);
      assert.equal(skipped.tools, null);
      if (!launch) for (const key of ['strictInstrumental', 'preflightEnabled']) await evaluate(`document.querySelector('[data-config-key=${key}]').click()`);
      for (const preset of ['standard', 'preview']) {
        await evaluate(`document.getElementById('config-preset').value='${preset}'; document.getElementById('config-preset').dispatchEvent(new Event('change',{bubbles:true}))`);
        assert.equal(await evaluate('state.config.strictInstrumental || state.config.preflightEnabled'), false);
      }
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
        assert.equal(summary.results[0].analysisVersion, 'local-context-music-v6');
        assert.ok(summary.results[0].analysis.segments.every(segment => segment.detectedMood && segment.moodSource && segment.moodConfidence));
        assert.doesNotMatch(summary.results[0].mood, /未确定/);
        assert.equal(summary.results[0].analysis.trackCount.met, true);
        results[0].scenePrioritySwitchPersists = true;
        results[0].offlineTranscriptionMs = Date.now() - batchStarted;
        const combinations = [];
        if (vocalSample) {
          const vocal = await evaluate('bgmStudio.checkMusicLibrary(' + JSON.stringify({ music: vocalMusic, analyzeVocals: true, strictInstrumental: true, libraryCacheDir: path.join(root, 'cache') }) + ')');
          assert.equal(vocal.files[0].status, 'vocal');
          assert.equal(vocal.usable, 0);
          results[0].vocalClassification = vocal.files[0].status;
          for (const strictInstrumental of [true, false]) for (const preflightEnabled of [true, false]) {
            const output = path.join(root, `switch-${strictInstrumental}-${preflightEnabled}`);
            const config = { videos: sampleVideo, music: strictInstrumental ? music : vocalMusic, output, transcribe: false, scenePriority: false, outputAudio: true, outputVideo: false, outputTimeline: true, outputTranscript: false, autoDuck: false, fadeIn: 0, fadeOut: 0, freezeTail: '0:00', libraryCacheDir: path.join(root, 'cache') };
            await evaluate(`for (const [key, value] of Object.entries(${JSON.stringify({ strictInstrumental, preflightEnabled })})) { const input=document.querySelector('[data-config-key='+key+']'); if(input.checked!==value) input.click(); }`);
            await evaluate(`Object.assign(state.config,${JSON.stringify(config)}); state.library=null; saveConfig(); refresh(true)`);
            await waitFor('!state.preflightPending && !state.starting && !state.running');
            assert.equal(await evaluate('document.getElementById("top-start").disabled'), false);
            const startedAt = Date.now();
            await evaluate('document.getElementById("top-start").click()');
            do {
              await new Promise((resolve) => setTimeout(resolve, 100));
              infoAfter = await evaluate('bgmStudio.appInfo()');
              assert.ok(Date.now() - startedAt < 60000, JSON.stringify(infoAfter.run));
            } while (infoAfter.running || infoAfter.run?.config.output !== output);
            const rendered = JSON.parse(await fs.readFile(path.join(output, 'run-summary.json'), 'utf8'));
            assert.equal(rendered.completed, 1, JSON.stringify(rendered));
            assert.equal(rendered.library.strictInstrumental, strictInstrumental);
            if (!strictInstrumental) assert.deepEqual(rendered.results[0].tracks, [vocalFile]);
            const csv = await fs.readFile(rendered.results[0].timelinePath, 'utf8');
            assert.ok(csv.includes(strictInstrumental ? path.basename(sampleMusic) : 'speech.wav'));
            combinations.push({ strictInstrumental, preflightEnabled, completed: rendered.completed });
            if (!strictInstrumental && !preflightEnabled) {
              const decode = async (file) => (await promisify(execFile)(info.defaults.ffmpeg, ['-v', 'error', '-i', file, '-t', '4', '-ar', '48000', '-ac', '1', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, windowsHide: true })).stdout;
              const original = await decode(vocalFile);
              const mixed = await decode(rendered.results[0].outputPath);
              let cross = 0, originalEnergy = 0, mixedEnergy = 0;
              for (let offset = 48000 * 4; offset + 4 <= Math.min(original.length, mixed.length); offset += 4) {
                const a = original.readFloatLE(offset), b = mixed.readFloatLE(offset);
                cross += a * b; originalEnergy += a * a; mixedEnergy += b * b;
              }
              const correlation = cross / Math.sqrt(originalEnergy * mixedEnergy);
              assert.ok(correlation > .98, 'vocal source/output correlation: ' + correlation);
              results[0].vocalSourceOutputCorrelation = correlation;
              results[0].vocalOutput = rendered.results[0].outputPath;
            }
          }
        }
        results[0].switchCombinations = combinations;
        results[0].switchesPersistAfterRestart = true;
        for (const key of ['strictInstrumental', 'preflightEnabled']) {
          if (await evaluate(`state.config.${key}`)) await evaluate(`document.querySelector('[data-config-key=${key}]').click()`);
          assert.equal(await evaluate(`JSON.parse(localStorage.getItem('bgm-studio-config')).${key}`), false);
        }
      }
    } finally { socket?.close(); child.kill(); await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); }); }
  }
  await fs.writeFile(process.argv[3] || 'build/packaged-preview-check.json', JSON.stringify({ root, results }, null, 2));
  console.log(JSON.stringify(results));
})().catch((error) => { console.error(error); process.exitCode = 1; });
