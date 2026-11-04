'use strict';

const api = window.bgmStudio;
const screen = document.getElementById('screen');
const toastNode = document.getElementById('toast');
const topTitle = document.getElementById('top-title');
const topStart = document.getElementById('top-start');
const sidebarRuntime = document.getElementById('sidebar-runtime');

const state = {
  view: 'desk',
  version: '',
  config: {},
  defaults: {},
  bundledRuntime: false,
  data: { rows: [], summary: null, warning: null },
  detail: null,
  selectedEpisode: '',
  selectedTranscript: 0,
  running: false,
  logs: [],
  stopTimer: null,
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function formatSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return '—';
  const mins = Math.floor(seconds / 60);
  const rest = seconds - mins * 60;
  return `${String(mins).padStart(2, '0')}:${rest.toFixed(1).padStart(4, '0')}`;
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!bytes) return '未知大小';
  return `${(bytes / 1024 / 1024).toFixed(2)} 兆字节`;
}

function statusLabel(status) {
  return ({ completed: '已完成', skipped: '已跳过', processing: '处理中', failed: '失败', interrupted: '已中断', pending: '待处理' })[status] || status || '待处理';
}

function statusClass(status) {
  return ['completed', 'skipped', 'processing', 'failed', 'interrupted', 'pending'].includes(status) ? status : 'pending';
}

function artifactSummary(row) {
  return [
    row.outputVideo === false ? '成片未选' : row.finalVideoPath && row.status === 'completed' ? '成片' : '待成片',
    row.outputAudio === false ? '音频未选' : row.outputPath && row.status === 'completed' ? '背景音乐音频' : '待音频',
    row.outputTimeline === false ? '时间轴未选' : row.timelinePath && row.status === 'completed' ? '时间轴' : '待时间轴',
    row.outputTranscript === false ? '转录未选' : row.transcribe === false ? '转录未开启' : row.status === 'completed' ? '转录文本' : '待转录',
  ].join(' · ');
}

function shortPath(value, max = 52) {
  const text = String(value || '');
  return text.length > max ? `…${text.slice(-max + 1)}` : text;
}

function showToast(message, error = false) {
  toastNode.textContent = message;
  toastNode.style.borderColor = error ? 'rgba(255,127,112,.6)' : '';
  toastNode.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toastNode.classList.remove('show'), 2600);
}

function saveConfig() {
  try { localStorage.setItem('bgm-studio-config', JSON.stringify(state.config)); } catch { /* local-only convenience */ }
}

function loadConfig(defaults) {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem('bgm-studio-config') || '{}'); } catch { stored = {}; }
  return {
    ...defaults,
    ...stored,
    transcribe: stored.transcribe !== undefined ? Boolean(stored.transcribe) : true,
    overwrite: Boolean(stored.overwrite),
    autoDuck: Boolean(stored.autoDuck),
    freezeTail: typeof stored.freezeTail === 'string' ? stored.freezeTail : '0:00',
    duckDb: Number.isFinite(Number(stored.duckDb)) ? Number(stored.duckDb) : -10,
    fadeIn: Number.isFinite(Number(stored.fadeIn)) ? Number(stored.fadeIn) : 2,
    fadeOut: Number.isFinite(Number(stored.fadeOut)) ? Number(stored.fadeOut) : 2,
    maxTracksPerEpisode: Number.isSafeInteger(Number(stored.maxTracksPerEpisode)) && Number(stored.maxTracksPerEpisode) >= 0 ? Number(stored.maxTracksPerEpisode) : Number(defaults.maxTracksPerEpisode) || 0,
    outputAudio: stored.outputAudio !== undefined ? Boolean(stored.outputAudio) : defaults.outputAudio !== false,
    outputVideo: stored.outputVideo !== undefined ? Boolean(stored.outputVideo) : defaults.outputVideo !== false,
    outputTimeline: stored.outputTimeline !== undefined ? Boolean(stored.outputTimeline) : defaults.outputTimeline !== false,
    outputTranscript: stored.outputTranscript !== undefined ? Boolean(stored.outputTranscript) : defaults.outputTranscript !== false,
  };
}

function selectedRow() {
  return state.data.rows.find((row) => row.episode === state.selectedEpisode) || state.data.rows[0] || null;
}

async function refresh(quiet = false) {
  try {
    state.data = await api.inspectBatch(state.config);
    if (!state.selectedEpisode || !state.data.rows.some((row) => row.episode === state.selectedEpisode)) {
      state.selectedEpisode = state.data.rows[0]?.episode || '';
    }
    if (['timeline', 'transcript'].includes(state.view) && state.selectedEpisode) await loadDetail(false);
    render();
    if (!quiet && state.data.warning) showToast(state.data.warning, true);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function loadDetail(showError = true) {
  const row = selectedRow();
  if (!row || !state.config.output) { state.detail = null; return; }
  try {
    state.detail = await api.episodeDetail({ output: state.config.output, episode: row.episode });
  } catch (error) {
    state.detail = null;
    if (showError) showToast(error.message, true);
  }
}

function configInput(key, label, pickAction) {
  return `<div class="path-row"><label for="config-${key}">${label}</label><input id="config-${key}" class="text-input" data-config-key="${key}" value="${escapeHtml(state.config[key] || '')}" placeholder="选择目录或输入路径"><button class="pick-button" data-action="${pickAction}" title="选择目录">⌕</button></div>`;
}

function videoConfigInput() {
  return `<div class="path-row video-path-row"><label for="config-videos">视频</label><input id="config-videos" class="text-input" data-config-key="videos" value="${escapeHtml(state.config.videos || '')}" placeholder="选择单个视频或视频目录"><button class="pick-button" data-action="choose-videos" title="选择视频目录">⌕</button><button class="pick-button video-file-button" data-action="choose-video-file" title="选择单个视频">文件</button></div>`;
}

function renderDesk() {
  const rows = state.data.rows || [];
  const summary = state.data.summary || {};
  const actualCompleted = Math.max(0, Number(summary.completed) || 0);
  const actualSkipped = Math.max(0, Number(summary.skipped) || 0);
  const completed = rows.length ? rows.filter((row) => row.status === 'completed' || row.status === 'skipped').length : actualCompleted + actualSkipped;
  const failed = rows.length ? rows.filter((row) => row.status === 'failed' || row.status === 'interrupted').length : Math.max(0, Number(summary.failed) || 0) + Math.max(0, Number(summary.interrupted) || 0);
  const total = rows.length || Number(summary.videos) || 0;
  const pending = Math.max(0, total - completed - failed - rows.filter((row) => row.status === 'processing').length);
  const processing = rows.filter((row) => row.status === 'processing').length;
  const model = state.data.model || {};
  const chainReady = Boolean(state.config.videos && state.config.music && state.config.output);
  const health = chainReady ? 5 : 2;
  const current = selectedRow();
  const logs = state.logs.slice(-18).reverse();

  return `<section class="view">
    <div class="view-header"><div><span class="eyebrow">批次控制台</span><h1>批次概览</h1><p>把扫描、转录、选曲、对白压低和导出当成一条可检查、可恢复的本地链路。</p></div><div class="header-actions"><button class="button ghost" data-action="new-batch">新建批次</button><button class="button ${state.running ? 'warn' : 'primary'}" data-action="${state.running ? 'stop' : 'start'}">${state.running ? '停止当前批次' : '开始批次'}</button></div></div>
    <div class="metrics"><div class="metric accent"><b>${completed}/${total || '—'}</b><span>已完成 / 已跳过</span></div><div class="metric good"><b>${state.running ? `${processing || 1}` : '空闲'}</b><span>${state.running ? '当前处理中' : '批次状态'}</span></div><div class="metric"><b>${failed}</b><span>失败 / 中断</span></div><div class="metric"><b>${pending}</b><span>待处理</span></div></div>
    <div class="layout-2">
      <div>
        <div class="panel"><div class="panel-head"><strong>最近一次运行 · ${total || 0} 集</strong><small>${summary.generatedAt ? escapeHtml(new Date(summary.generatedAt).toLocaleString('zh-CN')) : '尚未运行'}</small></div><div class="panel-body"><div class="healthline"><span>链路健康</span><b>${chainReady ? '可运行 · 本地' : '等待目录配置'}</b></div><div class="health-track">${Array.from({ length: 5 }, (_, index) => `<i class="${index < health ? '' : 'pending'}"></i>`).join('')}</div><div class="health-caption">扫描 → 语音转录 → 情绪规则 → 选曲 → 按设置导出所选内容</div></div></div>
        <div class="panel"><div class="panel-head"><strong>批次队列</strong><small>${state.data.warning ? escapeHtml(state.data.warning) : '点击一集进入时间轴 / 转录审阅'}</small></div>${rows.length ? `<table class="queue-table"><thead><tr><th>集数</th><th>状态</th><th>时长</th><th>情绪 / 音乐</th><th>产物</th><th></th></tr></thead><tbody>${rows.map((row) => `<tr class="queue-row ${row.episode === state.selectedEpisode ? 'selected' : ''}" data-action="select-episode" data-episode="${escapeHtml(row.episode)}"><td><span class="episode-name">${escapeHtml(row.episode)}</span><span class="episode-sub">${row.error ? escapeHtml(row.error) : escapeHtml(shortPath(row.videoPath, 48))}</span></td><td><span class="status-chip ${statusClass(row.status)}">${statusLabel(row.status)}</span></td><td>${formatSeconds(row.duration)}</td><td>${escapeHtml(row.mood || '未判定')}<span class="episode-sub">${escapeHtml((row.tracks || []).map((track) => String(track).split(/[\\/]/).pop()).join(' · ') || '—')}</span></td><td><span class="episode-sub">${escapeHtml(artifactSummary(row))}</span></td><td><button class="button compact ghost" data-action="open-detail" data-episode="${escapeHtml(row.episode)}">查看</button></td></tr>`).join('')}</tbody></table>` : `<div class="empty-state"><strong>还没有批次队列</strong>选择视频目录与 背景音乐 目录后，开始一次可恢复的本地运行。</div>`}</div>
        <div class="panel"><div class="panel-head"><strong>运行日志</strong><small>${state.running ? '实时更新' : '保留最近一次会话'}</small></div><div class="log-box">${logs.length ? logs.map((item) => `<div class="log-line ${item.level === 'error' ? 'error' : item.level === 'success' ? 'success' : ''}">${escapeHtml(item.message)}</div>`).join('') : '<div class="log-line">等待批次开始…</div>'}</div></div>
      </div>
      <aside>
        <div class="panel"><div class="panel-head"><strong>运行配置</strong><small>受控本地路径</small></div><div class="panel-body"><div class="path-stack">${videoConfigInput()}${configInput('music', '背景音乐', 'choose-music')}<div class="config-note"><strong>自动选曲</strong>按目录情绪、对白关键词和画面转场分段选曲；同类曲目优先选择较少使用者，不是随机。快速检查音轨可解码且不是静音，再按响度归一化。选曲依据对白情绪和场景转场。</div>${configInput('output', '输出', 'choose-output')}${configInput('transcripts', '字幕', 'choose-transcripts')}${state.bundledRuntime ? '' : configInput('modelPath', '模型', 'choose-model')}</div><div class="config-note"><strong>${model.exists ? '模型已就绪' : '模型未找到'}</strong> · ${escapeHtml(state.bundledRuntime ? '随应用内置' : shortPath(model.path || state.config.modelPath, 42))}<br>${model.exists ? `${formatBytes(model.sizeBytes)} · ${escapeHtml(state.config.language === 'auto' ? '自动识别' : state.config.language)} · 本机低精度处理` : '勾选本地转录后需要可用的模型目录'}</div><div class="switch-row"><div class="switch-label"><b>本地语音转录</b><small>生成转录文本与时间点，辅助情绪判断</small></div><label class="switch"><input type="checkbox" data-config-key="transcribe" ${state.config.transcribe ? 'checked' : ''}><span></span></label></div><div class="switch-row"><div class="switch-label"><b>对白时自动压低背景音乐</b><small>默认关闭；开启后仅在对白区间压低背景音乐。</small></div><label class="switch"><input type="checkbox" data-config-key="autoDuck" ${state.config.autoDuck ? 'checked' : ''}><span></span></label></div><div class="switch-row"><div class="switch-label"><b>允许覆盖已有结果</b><small>默认保护手工文件，恢复运行无需覆盖</small></div><label class="switch"><input type="checkbox" data-config-key="overwrite" ${state.config.overwrite ? 'checked' : ''}><span></span></label></div><div class="advanced-grid"><div class="field"><label>淡入时长</label><input class="number-input" data-config-key="fadeIn" type="number" min="0" step=".1" value="${escapeHtml(state.config.fadeIn)}"></div><div class="field"><label>淡出时长</label><input class="number-input" data-config-key="fadeOut" type="number" min="0" step=".1" value="${escapeHtml(state.config.fadeOut)}"></div><div class="field"><label>片尾定格（秒:帧）</label><input class="text-input" data-config-key="freezeTail" type="text" inputmode="numeric" placeholder="0:00" value="${escapeHtml(state.config.freezeTail)}"><small class="field-note">例：2:15 表示 2 秒 15 帧，按输入视频帧率换算</small></div></div></div></div>
        <div class="panel"><div class="panel-head"><strong>当前选集</strong><small>${current ? escapeHtml(current.episode) : '未选择'}</small></div><div class="panel-body">${current ? `<div class="inspector"><div class="inspector-card"><div class="inspector-row"><span>状态</span><b>${statusLabel(current.status)}</b></div><div class="inspector-row"><span>情绪</span><b>${escapeHtml(current.mood || '—')}</b></div><div class="inspector-row"><span>时长</span><b>${formatSeconds(current.duration)}</b></div></div><button class="button" data-action="open-timeline" data-episode="${escapeHtml(current.episode)}">打开 时间轴</button><button class="button ghost" data-action="open-transcript" data-episode="${escapeHtml(current.episode)}">打开 对白审阅</button></div>` : '<div class="empty-state">运行后可在这里检查单集产物。</div>'}</div></div>
      </aside>
    </div>
  </section>`;
}

function renderSettings() {
  const outputs = [
    ['outputAudio', '背景音乐音频（WAV）', '单独导出配乐音频文件。'],
    ['outputVideo', '最终成片视频', '保留原画面与原声，并混入背景音乐。'],
    ['outputTimeline', '选曲时间轴（CSV）', '记录每段音乐、时间范围与选曲原因。'],
    ['outputTranscript', '转录文本（JSON）', '仅在开启本地转录时输出识别结果。'],
  ];
  return `<section class="view"><div class="view-header"><div><span class="eyebrow">工作台设置</span><h1>设置</h1><p>选择批次产物，并设置每集的 BGM 片段上限。</p></div></div><div class="layout-2"><div class="panel"><div class="panel-head"><strong>输出内容</strong><small>设置会保存在本机</small></div><div class="panel-body">${outputs.map(([key, label, note]) => `<div class="switch-row"><div class="switch-label"><b>${label}</b><small>${note}</small></div><label class="switch"><input type="checkbox" data-config-key="${key}" ${state.config[key] ? 'checked' : ''}><span></span></label></div>`).join('')}<div class="config-note">取消勾选的类型不会生成；输出目录中已有的旧文件会保留，不会自动删除。</div></div></div><aside><div class="panel"><div class="panel-head"><strong>每集 BGM 片段上限</strong><small>默认 3 段，可自定义</small></div><div class="panel-body"><div class="field"><label for="config-maxTracksPerEpisode">每集最多配乐片段</label><input id="config-maxTracksPerEpisode" class="number-input" data-config-key="maxTracksPerEpisode" type="number" min="0" step="1" required value="${escapeHtml(state.config.maxTracksPerEpisode)}"><small class="field-note">只在台词情绪明显转变时切换；每段使用不同曲目，不会为用满上限强行加段。0 表示不限制段数。</small></div></div></div><div class="panel"><div class="panel-head"><strong>常用操作</strong></div><div class="panel-body"><button class="button" data-action="new-batch">新建批次</button><button class="button ghost" data-action="open-path" data-path="${escapeHtml(state.config.output || '')}" ${state.config.output ? '' : 'disabled'}>打开输出目录</button><div class="config-note">最大化时按窗口尺寸等比例放大界面，还原后恢复默认缩放。</div></div></div></aside></div></section>`;
}

function renderAbout() {
  return `<section class="view"><div class="view-header"><div><span class="eyebrow">工作台信息</span><h1>关于</h1><p>自动配背景音乐工作台</p></div></div><div class="layout-2"><div class="panel"><div class="panel-head"><strong>软件信息</strong></div><div class="panel-body"><div class="inspector-row"><span>名称</span><b>自动配背景音乐工作台</b></div><div class="inspector-row"><span>版本</span><b>${escapeHtml(state.version || '—')}</b></div><div class="inspector-row"><span>处理方式</span><b>本地运行</b></div><div class="config-note">视频、音频和批次产物按所选目录在本机处理与保存。</div></div></div><aside><div class="panel"><div class="panel-head"><strong>开源说明</strong></div><div class="panel-body"><p class="about-copy">源码随项目目录提供。目前仓库未附 LICENSE 文件，尚未声明具体开源许可；公开分发前，请由维护者选择并添加许可证。Electron、FFmpeg 和语音识别运行组件还需遵守各自上游许可证。</p></div></div></aside></div></section>`;
}

function timelineBlock(item, duration, kind, selected = false, label = '') {
  const start = Math.max(0, Number(item.start) || 0);
  const end = Math.max(start, Number(item.end) || start);
  const left = Math.max(0, Math.min(100, (start / duration) * 100));
  const width = Math.max(.5, Math.min(100 - left, ((end - start) / duration) * 100));
  return `<div class="track-block ${kind} ${selected ? 'selected' : ''}" style="left:${left}%;width:${width}%" title="${escapeHtml(label || `${formatSeconds(start)} – ${formatSeconds(end)}`)}"><small>${escapeHtml(label)}</small></div>`;
}

function renderTimeline() {
  const detail = state.detail;
  const row = selectedRow();
  if (!detail || !row) return `<section class="view"><button class="back-link" data-action="set-view" data-view="desk">← 返回批次控制台</button><div class="empty-state"><strong>还没有可查看的单集</strong>先运行批次，或在控制台选择一集。</div></section>`;
  const duration = Math.max(Number(detail.duration) || 0, 1);
  const currentIndex = Math.min(state.selectedTranscript, Math.max(0, detail.transcript.length - 1));
  const current = detail.transcript[currentIndex];
  const timeline = detail.timeline || [];
  const duckSegments = timeline.flatMap((segment) => segment.duckSegments || []);
  const selectedTimelineIndex = current ? timeline.findIndex((segment) => current.start >= segment.start && current.start < segment.end) : -1;
  const ruler = [0, .25, .5, .75, 1].map((ratio) => `<span>${formatSeconds(duration * ratio)}</span>`).join('');
  const dialogue = detail.transcript.map((item, index) => timelineBlock(item, duration, 'dialogue', index === currentIndex, item.text)).join('');
  const music = timeline.map((item, index) => timelineBlock(item, duration, 'music', index === selectedTimelineIndex, `${item.mood || '背景音乐'} · ${String(item.bgm_file || '').split(/[\\/]/).pop()}`)).join('');
  const duck = duckSegments.map((item) => timelineBlock(item, duration, 'duck', false, '对白区间')).join('');
  const freezeTailSeconds = Math.min(duration, Math.max(0, Number(detail.freezeTailSeconds) || 0));
  const freezeTail = freezeTailSeconds ? timelineBlock({ start: duration - freezeTailSeconds, end: duration }, duration, 'freeze', false, `片尾定格 ${detail.freezeTail}（无背景音乐）`) : '';
  const playhead = current ? Math.max(0, Math.min(100, (current.start / duration) * 100)) : null;
  const first = timeline[0] || {};
  return `<section class="view"><div class="detail-heading"><div><button class="back-link" data-action="set-view" data-view="desk">← 批次控制台</button><h1>时间轴 <span class="muted">/ ${escapeHtml(detail.episode)}</span></h1><p>对白轨、背景音乐片段和 对白压低区间在同一条时间轴上可检查。</p></div><div class="detail-actions"><button class="button ghost" data-action="open-transcript" data-episode="${escapeHtml(detail.episode)}">转录审阅</button>${detail.finalVideoExists ? `<button class="button primary" data-action="open-path" data-path="${escapeHtml(detail.finalVideoPath)}">打开成片</button>` : ''}<button class="button ghost" data-action="open-path" data-path="${escapeHtml(detail.outputPath)}">打开背景音乐音频</button></div></div><div class="layout-2"><div><div class="timeline-shell"><div class="ruler"><span></span>${ruler}</div><div class="timeline-track"><div class="track-label"><b>对白 / 转录</b>${detail.transcript.length} 个句段</div><div class="track-canvas">${dialogue || '<span class="health-caption">没有转录句段</span>'}${playhead === null ? '' : `<i class="playhead" style="left:${playhead}%"></i>`}</div></div><div class="timeline-track"><div class="track-label"><b>背景音乐轨</b>${timeline.length} 个片段</div><div class="track-canvas">${music || '<span class="health-caption">等待渲染产物</span>'}</div></div><div class="timeline-track"><div class="track-label"><b>对白压低</b>${duckSegments.length} 个区间</div><div class="track-canvas">${duck || '<span class="health-caption">没有对白压低区间</span>'}</div></div><div class="timeline-track"><div class="track-label"><b>片尾定格</b>${freezeTailSeconds ? detail.freezeTail : "未设置"}</div><div class="track-canvas">${freezeTail || "未设置定格时长"}</div></div></div><div class="timeline-meta"><div class="meta-card"><span>时长</span><b>${formatSeconds(duration)}</b></div><div class="meta-card"><span>格式</span><b>PCM 16 位音频</b></div><div class="meta-card"><span>输出</span><b>48 千赫 · 双声道</b></div><div class="meta-card"><span>淡入 / 对白压低</span><b>${first.fade_in_sec || '0'} 秒 / ${Number(first.duck_db) < 0 ? '已开启' : '已关闭'}</b></div></div></div><aside class="inspector"><div class="inspector-card"><h3>输出检查</h3><div class="inspector-row"><span>状态</span><b>${statusLabel(detail.status)}</b></div><div class="inspector-row"><span>情绪段</span><b>${escapeHtml(detail.mood || '—')}</b></div><div class="inspector-row"><span>峰值目标</span><b>≤ -1.0 dBFS</b></div><div class="inspector-row"><span>时间表</span><b>时间表已生成</b></div><div class="inspector-row"><span>转录</span><b>${detail.transcript.length ? '转录文本已生成' : '未生成'}</b></div></div><div class="inspector-card"><h3>当前切点</h3><div class="inspector-row"><span>时间</span><b>${current ? formatSeconds(current.start) : '—'}</b></div><div class="inspector-row"><span>说明</span><b>${escapeHtml(selectedTimelineIndex >= 0 ? timeline[selectedTimelineIndex].selection_reason : '点击转录句段查看')}</b></div></div><div class="notice"><b>需要人工确认</b><br>时间轴展示的是自动计划证据；真正交付前请试听对白清晰度、切点和 对白压低。</div></aside></div></section>`;
}

function renderTranscript() {
  const detail = state.detail;
  const row = selectedRow();
  if (!detail || !row) return `<section class="view"><button class="back-link" data-action="set-view" data-view="desk">← 返回批次控制台</button><div class="empty-state"><strong>还没有可审阅的转录</strong>先运行本地语音转录，或导入同名字幕 转录文本文件。</div></section>`;
  const lines = detail.transcript || [];
  const index = Math.min(state.selectedTranscript, Math.max(0, lines.length - 1));
  const current = lines[index];
  const mid = current ? (current.start + current.end) / 2 : 0;
  const segmentIndex = detail.timeline.findIndex((segment) => mid >= segment.start && mid < segment.end);
  const segment = detail.timeline[segmentIndex] || {};
  const linesHtml = lines.length ? lines.map((line, lineIndex) => {
    const at = (line.start + line.end) / 2;
    const lineSegment = detail.timeline.find((item) => at >= item.start && at < item.end) || {};
    return `<button class="transcript-line ${lineIndex === index ? 'selected' : ''}" data-action="select-transcript" data-index="${lineIndex}"><span class="transcript-time">${formatSeconds(line.start)}<br>${formatSeconds(line.end)}</span><span class="transcript-text">${escapeHtml(line.text)}</span><span class="transcript-tag">${escapeHtml(lineSegment.mood || '未标注')}</span></button>`;
  }).join('') : '<div class="empty-state"><strong>没有转录句段</strong>本集可能没有音轨，或尚未开启 语音转录。</div>';
  return `<section class="view"><div class="detail-heading"><div><button class="back-link" data-action="set-view" data-view="desk">← 批次控制台</button><h1>对白审阅 <span class="muted">/ ${escapeHtml(detail.episode)}</span></h1><p>先读对白，再理解切点；选中一句会联动时间轴的时间位置。</p></div><div class="detail-actions"><button class="button ghost" data-action="open-timeline" data-episode="${escapeHtml(detail.episode)}">时间轴</button>${detail.finalVideoExists ? `<button class="button primary" data-action="open-path" data-path="${escapeHtml(detail.finalVideoPath)}">打开成片</button>` : ''}<button class="button ghost" data-action="open-path" data-path="${escapeHtml(detail.transcriptPath || detail.outputPath)}">打开转录文本 / 背景音乐音频</button></div></div><div class="transcript-layout"><div class="panel"><div class="panel-head"><strong>转录句段 · ${lines.length}</strong><small>${escapeHtml(detail.mood || '情绪待判定')}</small></div><div class="panel-body"><div class="transcript-list">${linesHtml}</div></div></div><aside class="transcript-side"><div class="reason-card"><h3>音乐书签</h3><div class="big" id="bookmark-time">${current ? formatSeconds(current.start) : '—'}</div><p id="bookmark-reason">${escapeHtml(segment.selection_reason || '选择一个句段，查看它所在的背景音乐片段原因。')}</p><div class="inspector-row"><span>当前背景音乐</span><b id="bookmark-track">${escapeHtml(String(segment.bgm_file || '').split(/[\\/]/).pop() || '—')}</b></div><div class="inspector-row"><span>当前情绪</span><b id="bookmark-mood">${escapeHtml(segment.mood || '—')}</b></div><button class="button primary" style="width:100%;margin-top:13px" data-action="jump-to-line">跳到时间轴</button></div><div class="audio-box"><strong style="font-size:14px">最终成片 · 原声 + 背景音乐</strong>${detail.finalVideoUrl ? `<video id="final-video" controls preload="metadata" style="width:100%;margin-top:8px;border-radius:5px" src="${escapeHtml(detail.finalVideoUrl)}"></video>` : '<p class="config-note">本集最终成片尚未生成。</p>'}${detail.finalVideoExists ? `<button class="button ghost" style="width:100%;margin-top:8px" data-action="open-path" data-path="${escapeHtml(detail.finalVideoPath)}">打开成片</button>` : ''}</div><div class="audio-box"><strong style="font-size:14px">背景音乐试听</strong>${detail.audioUrl ? `<audio id="preview-audio" controls preload="metadata" src="${escapeHtml(detail.audioUrl)}"></audio><button class="button ghost" style="width:100%;margin-top:8px" data-action="play-line">试听当前句</button>` : '<p class="config-note">本集还没有背景音乐试听文件。</p>'}<button class="button ghost" style="width:100%;margin-top:8px" data-action="show-item" data-path="${escapeHtml(detail.outputPath)}">在文件夹中打开产物</button><span class="file-link">${escapeHtml(shortPath(detail.outputPath, 54))}</span></div><div class="notice"><b>审阅提示</b><br>关键词规则只提供可解释线索，不代表完整剧情理解；请把主观听感作为最终验收。</div></aside></div></section>`;
}

function render(preserveScroll = false) {
  const scrollTop = screen.scrollTop;
  const viewTitle = ({ desk: '批次控制台', timeline: '时间轴', transcript: '对白审阅', settings: '设置', about: '关于' })[state.view];
  topTitle.textContent = viewTitle;
  topStart.textContent = state.running ? '停止批次' : '开始批次';
  topStart.dataset.action = state.running ? 'stop' : 'start';
  topStart.classList.toggle('primary', !state.running);
  topStart.classList.toggle('warn', state.running);
  topStart.disabled = state.view !== 'desk' && !state.running && !state.config.videos;
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === state.view));
  sidebarRuntime.textContent = state.running ? '批次运行中 · 可中断' : state.data.rows.length ? '已读取上次批次状态' : '离线链路待启动';
  screen.innerHTML = ({ desk: renderDesk, timeline: renderTimeline, transcript: renderTranscript, settings: renderSettings, about: renderAbout })[state.view]?.() || renderDesk();
  if (preserveScroll) screen.scrollTop = scrollTop;
}

async function startBatch() {
  try {
    await api.startBatch(state.config);
    state.running = true;
    state.logs = [];
    showToast('批次已启动，可随时停止并恢复');
    render();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function chooseDirectory(key, title) {
  const value = await api.chooseDirectory(title);
  if (!value) return;
  state.config[key] = value;
  saveConfig();
  await refresh(true);
}

async function openDetail(episode, view) {
  state.selectedEpisode = episode || state.selectedEpisode || state.data.rows[0]?.episode || '';
  state.selectedTranscript = 0;
  await loadDetail();
  state.view = view;
  render();
}

function findCurrentAudio() {
  return document.getElementById('preview-audio');
}

async function playCurrentLine() {
  const audio = findCurrentAudio();
  const line = state.detail?.transcript?.[state.selectedTranscript];
  if (!audio || !line) return showToast('当前没有可试听句段', true);
  try {
    audio.currentTime = line.start;
    await audio.play();
    clearTimeout(state.stopTimer);
    state.stopTimer = setTimeout(() => audio.pause(), Math.max(400, (line.end - line.start) * 1000));
  } catch { showToast('系统未能启动音频预览，请直接打开音频文件', true); }
}

function selectTranscript(index) {
  const line = state.detail?.transcript?.[index];
  if (!line) return;
  state.selectedTranscript = index;
  document.querySelectorAll('.transcript-line').forEach((row) => row.classList.toggle('selected', Number(row.dataset.index) === index));
  const mid = (line.start + line.end) / 2;
  const segment = state.detail.timeline.find((item) => mid >= item.start && mid < item.end) || {};
  document.getElementById('bookmark-time').textContent = formatSeconds(line.start);
  document.getElementById('bookmark-reason').textContent = segment.selection_reason || '选择一个句段，查看它所在背景音乐片段的原因。';
  document.getElementById('bookmark-track').textContent = String(segment.bgm_file || '').split(/[\\/]/).pop() || '—';
  document.getElementById('bookmark-mood').textContent = segment.mood || '—';
  const video = document.getElementById('final-video');
  if (!video) return;
  const seek = () => {
    try {
      video.currentTime = Math.min(line.start, Number.isFinite(video.duration) ? video.duration : line.start);
      if (!video.paused) video.play().catch(() => {});
    } catch { showToast('成片暂时无法跳到该时间点', true); }
  };
  if (video.readyState >= 1) seek();
  else video.addEventListener('loadedmetadata', seek, { once: true });
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  try {
    if (action === 'set-view') {
      state.view = target.dataset.view;
      if (['timeline', 'transcript'].includes(state.view)) await loadDetail();
      render();
    } else if (action === 'refresh') {
      await refresh();
    } else if (action === 'toggle-maximize') {
      await api.toggleMaximize();
    } else if (action === 'start') {
      await startBatch();
    } else if (action === 'stop') {
      await api.stopBatch();
      showToast('正在停止当前子进程…');
    } else if (action === 'new-batch') {
      state.config = { ...state.config, videos: '', music: '', output: '', transcripts: '', overwrite: false };
      state.data = { rows: [], summary: null, warning: null };
      state.selectedEpisode = '';
      state.detail = null;
      state.view = 'desk';
      saveConfig();
      render();
    } else if (action === 'choose-videos') {
      await chooseDirectory('videos', '选择视频目录');
    } else if (action === 'choose-video-file') {
      const value = await api.chooseVideoFile();
      if (value) { state.config.videos = value; saveConfig(); await refresh(true); }
    } else if (action === 'choose-music') {
      await chooseDirectory('music', '选择 背景音乐 目录');
    } else if (action === 'choose-output') {
      await chooseDirectory('output', '选择输出目录');
    } else if (action === 'choose-transcripts') {
      await chooseDirectory('transcripts', '选择字幕目录');
    } else if (action === 'choose-model') {
      await chooseDirectory('modelPath', '选择 语音转录 模型目录');
    } else if (action === 'select-episode') {
      state.selectedEpisode = target.dataset.episode;
      render();
    } else if (action === 'open-detail') {
      await openDetail(target.dataset.episode, 'timeline');
    } else if (action === 'open-timeline') {
      await openDetail(target.dataset.episode, 'timeline');
    } else if (action === 'open-transcript') {
      await openDetail(target.dataset.episode, 'transcript');
    } else if (action === 'select-transcript') {
      selectTranscript(Number(target.dataset.index) || 0);
    } else if (action === 'jump-to-line') {
      state.view = 'timeline';
      await loadDetail();
      render();
    } else if (action === 'play-line') {
      await playCurrentLine();
    } else if (action === 'open-path') {
      await api.openPath(target.dataset.path);
    } else if (action === 'show-item') {
      await api.showItem(target.dataset.path);
    }
  } catch (error) {
    showToast(error.message, true);
  }
});

document.addEventListener('change', (event) => {
  const input = event.target.closest('[data-config-key]');
  if (!input) return;
  const key = input.dataset.configKey;
  state.config[key] = input.type === 'checkbox' ? input.checked : (['duckDb', 'fadeIn', 'fadeOut', 'maxTracksPerEpisode'].includes(key) ? (input.value === '' ? '' : Number(input.value)) : input.value);
  saveConfig();
});
document.addEventListener('input', (event) => {
  const input = event.target.closest('[data-config-key]');
  if (!input || input.type === 'checkbox') return;
  state.config[input.dataset.configKey] = ['duckDb', 'fadeIn', 'fadeOut', 'maxTracksPerEpisode'].includes(input.dataset.configKey) ? (input.value === '' ? '' : Number(input.value)) : input.value;
  saveConfig();
});

api.onBatchEvent((event) => {
  if (event.type === 'started') {
    state.running = true;
    state.logs.push({ level: 'success', message: '批次已启动 · 可恢复运行' });
  } else if (event.type === 'log') {
    state.logs.push({ level: event.level, message: event.message });
  } else if (event.type === 'progress') {
    if (event.episode && state.data.rows) {
      const row = state.data.rows.find((item) => item.episode === event.episode);
      if (row) Object.assign(row, event);
      else state.data.rows.push({ episode: event.episode, status: event.status, duration: null, mood: '', tracks: [] });
    }
  } else if (event.type === 'finished') {
    state.running = false;
    state.logs.push({ level: 'success', message: `批次结束 · 完成 ${event.summary?.completed || 0} · 跳过 ${event.summary?.skipped || 0} · 失败 ${event.summary?.failed || 0}` });
    showToast('批次已结束，正在刷新产物');
    refresh(true);
  } else if (event.type === 'stopped') {
    state.running = false;
    state.logs.push({ level: 'error', message: event.message || '批次已停止' });
    showToast(event.message || '批次已停止');
    refresh(true);
  } else if (event.type === 'error') {
    state.running = false;
    state.logs.push({ level: 'error', message: event.message });
    showToast(event.message, true);
    refresh(true);
  }
  render();
});

(async () => {
  try {
    const info = await api.appInfo();
    state.version = info.version || '';
    state.defaults = info.defaults || {};
    state.bundledRuntime = Boolean(info.bundledRuntime);
    state.config = loadConfig(state.defaults);
    if (state.bundledRuntime) Object.assign(state.config, { modelPath: state.defaults.modelPath, ffmpeg: state.defaults.ffmpeg, ffprobe: state.defaults.ffprobe });
    await refresh(true);
  } catch (error) {
    showToast(error.message, true);
    render();
  }
})();
