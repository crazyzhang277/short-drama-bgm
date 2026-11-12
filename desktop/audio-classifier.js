'use strict';

const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

async function createAudioClassifier({ modelPath } = {}) {
  const { BrowserWindow, session } = require('electron');
  modelPath ||= path.resolve(__dirname, '../runtime/audio/yamnet.tflite');
  await fs.access(modelPath).catch(() => { throw new Error('YAMNet 模型缺失，请修复人声分析组件或人工确认纯音乐'); });
  const bundle = path.dirname(require.resolve('@mediapipe/tasks-audio'));
  const token = randomBytes(24).toString('hex');
  let pendingBytes;
  const assets = new Map([
    ['bundle.js', [path.join(bundle, 'audio_bundle.js'), 'text/javascript']],
    ['model', [modelPath, 'application/octet-stream']],
    ...['audio_wasm_internal.js', 'audio_wasm_module_internal.js', 'audio_wasm_internal.wasm', 'audio_wasm_module_internal.wasm']
      .map((name) => ['wasm/' + name, [path.join(bundle, 'wasm', name), name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript']]),
  ]);
  const server = http.createServer(async (request, response) => {
    const prefix = '/' + token + '/';
    if (request.method !== 'GET' || !request.url.startsWith(prefix)) { response.writeHead(404).end(); return; }
    const name = request.url.slice(prefix.length);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'self'");
    if (!name) { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><script src="bundle.js"></script>'); return; }
    if (name === 'data' && pendingBytes) { response.setHeader('Content-Type', 'application/octet-stream'); response.end(pendingBytes); return; }
    const asset = assets.get(name);
    if (!asset) { response.writeHead(404).end(); return; }
    try { response.setHeader('Content-Type', asset[1]); response.end(await fs.readFile(asset[0])); }
    catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}/${token}/`;
  const isolated = session.fromPartition('audio-' + token);
  // Processing and telemetry are confined to the local asset server, including during initialization.
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(origin) }));
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const window = new BrowserWindow({ show: false, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  const close = () => { if (!window.isDestroyed()) window.destroy(); server.close(); };
  try {
    await window.loadURL(origin);
    await window.webContents.executeJavaScript(`(async () => {
      const files = await Audio.FilesetResolver.forAudioTasks(${JSON.stringify(origin + 'wasm')});
      window.classifier = await Audio.AudioClassifier.createFromOptions(files, {
        baseOptions: { modelAssetPath: ${JSON.stringify(origin + 'model')} }, maxResults: -1, scoreThreshold: 0
      });
      window.classifyNext = async () => {
        const response = await fetch(${JSON.stringify(origin + 'data')});
        if (!response.ok) throw new Error('音频传输失败');
        const data = await response.arrayBuffer();
        return window.classifier.classify(new Float32Array(data), 16000).map(result => ({
          time: (result.timestampMs || 0) / 1000,
          categories: result.classifications.flatMap(head => head.categories)
            .filter(category => /speech|singing|choir|rap|humming|vocal|chant|mantra|a capella|yodel|whisper|babbl|narration|conversation|child|laughter|giggl|chuckl|snicker|belly laugh|yell|screaming|shout|crying|sobbing|wail|music$/i.test(category.categoryName))
            .map(category => ({ label: category.categoryName, score: category.score }))
        }));
      };
    })()`);
    return {
      async classify(bytes) {
        if (window.isDestroyed()) throw new Error('人声分析组件已关闭');
        if (pendingBytes) throw new Error('音频分析调用须顺序执行');
        pendingBytes = bytes;
        try { return await window.webContents.executeJavaScript('window.classifyNext()'); }
        finally { pendingBytes = null; }
      }, close,
    };
  } catch (error) { close(); throw new Error('人声分析组件初始化失败：' + error.message); }
}

module.exports = { createAudioClassifier };
