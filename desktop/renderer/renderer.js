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
  preset: '',
  defaults: {},
  bundledRuntime: false,
  data: { rows: [], summary: null, warning: null },
  detail: null,
  selectedEpisode: '',
  selectedTranscript: 0,
  running: false,
  starting: false,
  run: null,
  queueQuery: '',
  queueFilter: 'all',
  preflightPending: true,
  recentPaths: {},
  library: null,
  checkingLibrary: false,
  libraryProgress: null,
  libraryQuery: '',
  mediaMode: 'video',
  playbackTime: 0,
  selectedMusic: -1,
  previewEnd: null,
  logs: [],
  update: { status: 'idle', currentVersion: '', version: '', releaseDate: '', releaseNotes: '', percent: 0, transferred: 0, total: 0, speed: 0, lastCheckedAt: '', errorMessage: '' },
  updateSeenVersion: '',
};

const UPDATE_SEEN_KEY = 'bgm-studio-update-seen';
let refreshSequence = 0;
let refreshTimer;
let liveTimer;

const PRESETS = {
  preview: { label: '快速预览', description: '只输出 BGM 音频（WAV）和选曲时间轴（CSV）；关闭本地转录，便于先检查配乐。', transcribe: false, outputAudio: true, outputVideo: false, outputTimeline: true, outputTranscript: false },
  standard: { label: '标准交付', description: '开启本地转录，输出最终成片、BGM 音频（WAV）、时间轴（CSV）和转录文本（JSON）。', transcribe: true, outputAudio: true, outputVideo: true, outputTimeline: true, outputTranscript: true },
  dialogue: { label: '对白优先', description: '开启转录和对白压低（-16 dB），输出成片、BGM 音频、时间轴和转录文本，优先保证对白清晰。', transcribe: true, autoDuck: true, duckDb: -16, outputAudio: true, outputVideo: true, outputTimeline: true, outputTranscript: true },
  music: { label: '纯配乐', description: '只输出 BGM 音频（WAV）和选曲时间轴（CSV），不生成成片或本地转录；可使用已有字幕。', transcribe: false, outputAudio: true, outputVideo: false, outputTimeline: true, outputTranscript: false },
};

function selectedPreset() {
  const preset = PRESETS[state.preset];
  return preset && Object.entries(preset).every(([key, value]) => ['label', 'description'].includes(key) || state.config[key] === value) ? state.preset : '';
}

function renderPreset() {
  const selected = selectedPreset();
  return `<label for="config-preset">配置预设</label><select id="config-preset" class="select-input"><button type="button"><selectedcontent></selectedcontent></button><option value="" ${selected ? '' : 'selected'}>${state.preset ? '自定义配置' : '选择预设'}</option>${Object.entries(PRESETS).map(([key, preset]) => `<option value="${key}" ${selected === key ? 'selected' : ''} title="${escapeHtml(preset.description)}"><span>${preset.label}</span><small class="preset-description">${escapeHtml(preset.description)}</small></option>`).join('')}</select>`;
}

function rememberPaths() {
  for (const key of ['videos', 'music', 'output', 'transcripts', 'modelPath']) {
    const value = String(state.config[key] || '').trim();
    if (value) state.recentPaths[key] = [value, ...(state.recentPaths[key] || []).filter((item) => item !== value)].slice(0, 5);
  }
  try { localStorage.setItem('bgm-studio-recent-paths', JSON.stringify(state.recentPaths)); } catch { /* local-only convenience */ }
}

function recentOptions(key) {
  return `<datalist id="recent-${key}">${(state.recentPaths[key] || []).map((value) => `<option value="${escapeHtml(value)}"></option>`).join('')}</datalist>`;
}

function preflightChecks() {
  if (state.config.preflightEnabled === false) return [];
  const paths = state.data.paths || {};
  const musicCount = (state.data.musicGroups || []).reduce((sum, group) => sum + group.count, 0);
  const strict = state.config.strictInstrumental !== false;
  const library = state.library?.strictInstrumental === strict ? state.library : null;
  const usableCount = library?.usable ?? musicCount;
  const outputsReady = [state.config.outputAudio, state.config.outputVideo, state.config.outputTimeline].some(Boolean) || (state.config.outputTranscript && state.config.transcribe);
  const checks = [
    { name: '视频', ok: paths.videos?.status === 'available' && state.data.inputVideoCount > 0, label: state.data.inputVideoCount ? `找到 ${state.data.inputVideoCount} 个视频` : paths.videos?.status === 'available' ? '目录中没有支持的视频' : paths.videos?.label || '未选择', action: 'choose-videos', fix: '选择视频目录' },
    { name: 'BGM', ok: paths.music?.status === 'available' && usableCount > 0, label: library ? `当前可选 ${usableCount} / ${musicCount} 首` : musicCount ? `${musicCount} 首 · ${strict ? '开始时筛选人声' : '允许含人声曲目'}` : '未选择或没有可用曲目', action: musicCount ? strict ? 'analyze-library' : 'check-library' : 'choose-music', fix: musicCount ? strict ? '筛选或人工确认曲目' : '检查音乐库健康' : '选择音乐目录' },
    { name: '输出', ok: paths.output?.status === 'available', label: paths.output?.status === 'available' ? '可写入' : paths.output?.label || '未选择', action: 'choose-output', fix: '选择输出目录' },
    { name: '转录模型', ok: !state.config.transcribe || Boolean(state.data.model?.exists), label: !state.config.transcribe ? '本地转录已关闭' : state.data.model?.exists ? `已就绪 · ${formatBytes(state.data.model.sizeBytes)}` : '模型不可用', action: state.bundledRuntime ? 'disable-transcribe' : 'choose-model', fix: state.bundledRuntime ? '关闭本地转录' : '选择模型' },
    { name: '输出内容', ok: outputsReady, label: outputsReady ? '已选择有效输出' : '至少选择一种输出；仅转录时需开启本地转录', action: 'set-view', view: 'settings', fix: '选择输出内容' },
    { name: '媒体组件', ok: Boolean(state.data.tools?.ffmpeg?.available && state.data.tools?.ffprobe?.available), label: state.data.tools ? ['ffmpeg', 'ffprobe'].filter((key) => !state.data.tools[key]?.available).map((key) => `${key} 不可用`).join('；') || 'FFmpeg / ffprobe 已就绪' : '正在检查', action: 'refresh', fix: '安装或修复组件后重检' },
  ];
  if (state.data.validationError && !checks.some((check) => !check.ok)) {
    const tail = /片尾/.test(state.data.validationError);
    const duck = /ducking/.test(state.data.validationError);
    checks.push({ name: '参数', ok: false, label: state.data.validationError, action: tail ? 'fix-freeze-tail' : duck ? 'reset-duck' : 'set-view', view: 'settings', fix: tail ? '修正片尾时长' : duck ? '恢复默认压低幅度' : '检查设置' });
  }
  return checks;
}

function renderPreflight() {
  return `<div id="preflight-checks">${renderPreflightChecks()}</div><div id="library-result">${renderLibraryHealth()}</div>`;
}

function renderPreflightChecks() {
  const checks = preflightChecks();
  const automatic = state.config.preflightEnabled === false ? '<p class="config-note" role="status">开始前检测已关闭，启动时直接进入批次处理。</p>' : `${state.preflightPending ? '<p class="config-note" role="status">正在检查当前配置…</p>' : ''}${checks.map((check) => `<div class="preflight-row"><span>${check.name}</span><strong class="preflight-state ${check.ok ? 'available' : 'unavailable'}">${check.ok ? '✓' : '!'} ${escapeHtml(check.label)}</strong>${check.ok ? '' : `<button class="button compact ghost" data-action="${check.action}" ${check.view ? `data-view="${check.view}"` : ''}>${check.fix}</button>`}</div>`).join('')}${state.data.warning ? `<p class="config-note">${escapeHtml(state.data.warning)}</p>` : ''}`;
  return `${automatic}<div class="config-note">原始视频和音乐保持不变；已有手工文件受覆盖保护。</div><button class="button ghost" data-action="check-library" ${state.checkingLibrary || state.running ? 'disabled' : ''}>检查音乐库健康</button> <button class="button" data-action="analyze-library" ${state.checkingLibrary || state.running || state.config.strictInstrumental === false ? 'disabled' : ''} ${state.config.strictInstrumental === false ? 'title="人声筛选已关闭，开启后可分析"' : ''}>整库人声筛选</button>${state.config.strictInstrumental === false ? '<p class="config-note">人声筛选已关闭，开启后可分析</p>' : ''}${state.checkingLibrary ? `<p role="status">${state.libraryProgress ? `分析 ${state.libraryProgress.checked} / ${state.libraryProgress.total} 首` : '正在检查音乐库…'} <button class="button compact ghost" data-action="stop-library">停止，保留已分析结果</button></p>` : ''}`;
}

function renderLibraryHealth() {
  const library = state.library;
  if (!library) return `<p class="config-note">${state.config.strictInstrumental !== false ? '严格模式仅使用人工确认或整曲分析通过的纯音乐。首次筛选覆盖整首音频，后续复用缓存；不确定或失败曲目会被排除。' : '不检测、不按人声状态排除；含歌唱、哼唱或口播的音乐也可参与选曲。人工禁用仍有效，保留已有分析、入点与强度。'}</p>`;
  const problems = library.files.filter((file) => !file.playable || file.tooShort);
  const labels = { confirmed: '人工确认纯音乐', instrumental: '纯音乐候选', vocal: '疑似人声', unknown: '未确定', disabled: '已禁用' };
  return `<div class="library-health"><p role="status">共 ${library.total} 首，当前可选 ${library.usable} 首。${Object.entries(labels).map(([key, label]) => `${label} ${library.files.filter((file) => (file.status || 'unknown') === key).length}`).join(' · ')}</p>${library.emptyDirectories.length ? `<p>空目录：${library.emptyDirectories.map(escapeHtml).join('、')}</p>` : ''}<ul>${problems.map((file) => `<li>${escapeHtml(shortPath(file.file, 80))}：${escapeHtml(file.reason || '不足 2 秒，循环使用可能明显')}</li>`).join('')}${library.duplicates.map((file) => `<li>内容重复：${escapeHtml(shortPath(file.file, 60))}</li>`).join('')}</ul><details><summary>曲目筛选、试听和人工确认</summary><label for="library-search">搜索曲名或筛选状态</label><input id="library-search" class="text-input" type="search" value="${escapeHtml(state.libraryQuery)}" placeholder="例如：疑似人声 / City lights"><div class="library-track-list">${library.files.map((file, index) => {
    const label = labels[file.status] || labels.unknown;
    const hidden = !`${file.file} ${label}`.toLowerCase().includes(state.libraryQuery.toLowerCase());
    return `<details class="library-track" data-library-text="${escapeHtml(`${file.file} ${label}`.toLowerCase())}" ${hidden ? 'hidden' : ''}><summary>${escapeHtml(String(file.file).split(/[\\/]/).pop())} · ${label}</summary><p>${escapeHtml(file.reason || '')}</p><audio id="library-audio-${index}" controls preload="none" src="${escapeHtml(file.fileUrl || '')}"></audio><p>${[...(file.analysis?.intervals || [])].sort((a, b) => b.score - a.score).slice(0, 3).map((interval) => `<button class="button compact ghost" data-action="audition-vocal" data-index="${index}" data-start="${Math.max(0, interval.start - 1)}" data-end="${Math.min(interval.end + 1, interval.start + 20)}">${formatSeconds(interval.start)}–${formatSeconds(interval.end)} ${escapeHtml(interval.label)}</button>`).join('') || '优先试听分数最高的三个区间。没有自动标记不代表人工确认。'}</p><button class="button compact" data-action="review-track" data-index="${index}" data-review="confirm" ${state.running || state.checkingLibrary ? 'disabled' : ''}>已试听，确认纯音乐</button> <button class="button compact ghost" data-action="review-track" data-index="${index}" data-review="disable" ${state.running || state.checkingLibrary ? 'disabled' : ''}>禁用</button> <button class="button compact ghost" data-action="review-track" data-index="${index}" data-review="reset" ${state.running || state.checkingLibrary ? 'disabled' : ''}>取消确认 / 禁用</button><div class="advanced-grid"><div class="field"><label for="cue-${index}">人工入点（秒）</label><input id="cue-${index}" class="number-input" type="number" min="0" step=".1" value="${Number(file.cueIn) || 0}"></div><div class="field"><label for="intensity-${index}">音乐强度</label><select id="intensity-${index}" class="select-input">${[[1,'低'],[2,'中'],[3,'高']].map(([value, text]) => `<option value="${value}" ${Number(file.intensity || 2) === value ? 'selected' : ''}>${text}</option>`).join('')}</select></div></div><button class="button compact ghost" data-action="review-track" data-index="${index}" data-review="metadata" ${state.running || state.checkingLibrary ? 'disabled' : ''}>保存入点与强度</button></details>`;
  }).join('')}</div></details><p class="config-note">机器筛选可能漏检或误剔除。人工确认与禁用按文件指纹保存；文件变动后重新分析。没有人工入点时从 0 秒播放。检查不会删除曲目。</p></div>`;
}

function renderMetrics() {
  const rows = state.data.rows || [];
  const counts = state.run?.counts;
  const completed = counts?.completed ?? rows.filter((row) => row.status === 'completed').length;
  const skipped = counts?.skipped ?? rows.filter((row) => row.status === 'skipped').length;
  const failed = counts ? counts.failed + counts.interrupted : rows.filter((row) => ['failed', 'interrupted'].includes(row.status)).length;
  const total = state.run?.total || rows.length;
  const pending = Math.max(0, total - completed - skipped - failed - (state.running && state.run?.currentEpisode && !state.run.currentSettled ? 1 : 0));
  return `<div class="metric accent"><b>${completed}</b><span>已完成</span></div><div class="metric"><b>${skipped}</b><span>已跳过</span></div><div class="metric good"><b>${state.running ? '运行中' : '空闲'}</b><span>批次状态</span></div><div class="metric"><b>${failed}</b><span>失败 / 中断</span></div><div class="metric"><b>${pending}</b><span>待处理 / 共 ${total} 集</span></div>`;
}

function renderProgress() {
  const run = state.run;
  if (!run) return '<strong>准备开始</strong><p>完成下方检查后，即可开始本地批次。</p>';
  const percent = run.total ? Math.min(100, Math.floor(run.settled / run.total * 100)) : 0;
  const stages = { scanning: '扫描视频', 'checking-library': '检查音乐库', 'analyzing-vocals': '整库人声筛选', 'detecting-scenes': '检测镜头候选', scanned: '准备处理', probing: '读取视频信息', transcribing: '本地语音转录', planning: '选择配乐', 'rendering-audio': '生成背景音乐音频', 'rendering-video': '生成并核验最终视频', saving: '保存产物', checking: '核验已完成产物', processing: '处理中', completed: '本集完成', skipped: '本集已跳过', failed: '本集失败，继续下一集', interrupted: '本集已中断', stopping: '正在停止', stopped: '批次已停止', finished: '批次已结束', error: '批次需要处理' };
  const eta = run.estimatedRemainingMs === null || run.estimatedRemainingMs === undefined ? '正在估算' : `预计还需约 ${Math.max(1, Math.ceil(Math.max(0, run.estimatedRemainingMs - (Date.now() - run.estimatedAt)) / 60000))} 分钟`;
  return `<div class="progress-heading"><strong>${state.running ? '正在处理' : stages[run.status] || '上次批次'} · 第 ${run.currentIndex || 0} / ${run.total || 0} 集</strong><span>${percent}% · 已处理 ${run.settled || 0} 集</span></div><div class="batch-progress" role="progressbar" aria-label="批次整体进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${percent}%"></span></div><p>${run.currentEpisode ? `当前：${escapeHtml(run.currentEpisode)} · ` : ''}${escapeHtml(stages[run.currentStage] || run.currentStage || '准备中')} · ${state.running ? eta : `耗时约 ${Math.max(0, Math.round(((run.finishedAt || Date.now()) - run.startedAt) / 60000))} 分钟`}</p>${run.error ? `<p class="error-text">${escapeHtml(run.error)}</p>` : ''}`;
}

function renderQueueRow(row) {
  const count = row.analysis?.trackCount || row.trackCount;
  return `<td><span class="episode-name">${escapeHtml(row.episode)}</span><span class="episode-sub">${escapeHtml(row.error || count?.warning || shortPath(row.videoPath, 48))}</span></td><td><span class="status-chip ${statusClass(row.status)}">${statusLabel(row.status)}</span></td><td>${formatSeconds(row.duration)}</td><td>${count ? `${count.actual} 首 · ${count.segments} 段<br>` : ''}${escapeHtml(row.mood || '未判定')}<span class="episode-sub">${escapeHtml((row.tracks || []).map((track) => String(track).split(/[\\/]/).pop()).join(' · ') || '—')}</span></td><td><span class="episode-sub">${escapeHtml(artifactSummary(row))}</span></td><td><button class="button compact ghost" data-action="open-detail" data-episode="${escapeHtml(row.episode)}">查看</button></td>`;
}

function patchQueue() {
  const body = document.getElementById('queue-body');
  if (!body) return;
  const existing = new Map([...body.children].map((row) => [row.dataset.episode, row]));
  let visible = 0;
  for (const row of state.data.rows) {
    let node = existing.get(row.episode);
    if (!node) {
      node = document.createElement('tr');
      node.className = 'queue-row';
      node.dataset.action = 'select-episode';
      node.dataset.episode = row.episode;
      body.append(node);
    }
    const html = renderQueueRow(row);
    if (node._content !== html) { node.innerHTML = html; node._content = html; }
    node.classList.toggle('selected', row.episode === state.selectedEpisode);
    node.hidden = !row.episode.toLocaleLowerCase().includes(state.queueQuery.toLocaleLowerCase()) || (state.queueFilter !== 'all' && row.status !== state.queueFilter);
    if (!node.hidden) visible += 1;
    existing.delete(row.episode);
  }
  for (const node of existing.values()) node.remove();
  document.getElementById('queue-empty').hidden = visible > 0;
  document.getElementById('queue-count').textContent = `显示 ${visible} / ${state.data.rows.length} 集`;
}

function updateHTML(id, html) {
  const node = document.getElementById(id);
  if (node && node._content !== html) { node.innerHTML = html; node._content = html; }
}

function updateLive() {
  renderChrome();
  if (state.view !== 'desk') return;
  const preset = document.getElementById('config-preset');
  if (preset) { preset.value = selectedPreset(); preset.options[0].textContent = state.preset ? '自定义配置' : '选择预设'; }
  updateHTML('metrics', renderMetrics());
  updateHTML('batch-progress', renderProgress());
  updateHTML('preflight-checks', renderPreflightChecks());
  const libraryResult = document.getElementById('library-result');
  if (libraryResult && libraryResult._library !== state.library) {
    updateHTML('library-result', renderLibraryHealth());
    libraryResult._library = state.library;
  }
  document.querySelectorAll('[data-action="review-track"]').forEach((button) => { button.disabled = state.running || state.checkingLibrary; });
  patchQueue();
  updateHTML('selected-episode-panel', renderSelectedEpisode());
  for (const [action, ready] of [['open-report', state.data.reportPath], ['open-error-log', state.data.errorLogPath]]) {
    const button = document.querySelector(`[data-action="${action}"]`);
    if (button) button.disabled = !ready;
  }
  const box = document.getElementById('run-logs');
  if (box) {
    for (const entry of state.logs) {
      if (entry._shown === box) continue;
      const line = document.createElement('div');
      line.className = `log-line ${entry.level === 'error' ? 'error' : entry.level === 'success' ? 'success' : ''}`;
      line.textContent = entry.message;
      box.append(line);
      entry._shown = box;
    }
    while (box.children.length > 100) box.firstElementChild.remove();
    box.scrollTop = box.scrollHeight;
  }
  for (const action of ['retry-failed', 'continue-unfinished', 'regenerate', 'new-batch']) document.querySelectorAll(`[data-action="${action}"]`).forEach((button) => { button.disabled = state.running || state.starting; });
}

function scheduleLiveUpdate() {
  if (!liveTimer) liveTimer = setTimeout(() => { liveTimer = null; updateLive(); }, 250);
}

function renderSelectedEpisode() {
  const row = selectedRow();
  if (!row) return '<div class="panel-head"><strong>当前选集</strong></div><div class="empty-state">选择一集查看产物与错误详情。</div>';
  return `<div class="panel-head"><strong>当前选集</strong><small>${escapeHtml(row.episode)}</small></div><div class="panel-body inspector"><div class="inspector-row"><span>状态</span><b>${statusLabel(row.status)}</b></div><div class="inspector-row"><span>情绪</span><b>${escapeHtml(row.mood || '—')}</b></div><div class="inspector-row"><span>时长</span><b>${formatSeconds(row.duration)}</b></div><button class="button" data-action="open-timeline" data-episode="${escapeHtml(row.episode)}">打开时间轴</button><button class="button ghost" data-action="open-transcript" data-episode="${escapeHtml(row.episode)}">打开对白审阅</button><button class="button ghost" data-action="regenerate" ${state.running || state.starting ? 'disabled' : ''}>重新生成当前集</button>${row.error ? `<div class="notice error-text">${escapeHtml(row.error)}<br>原始素材未修改。请检查文件权限、媒体组件和同名产物，再重试失败项。</div>` : ''}</div>`;
}

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

function musicMoodLabel(segment) {
  const mood = segment.detected_mood || (segment.mood_fallback === 'true' ? '未确定（回退）' : segment.mood || '未标注');
  const source = { 'neutral-bed': '（叙事铺底）', 'scene-context': '（场景建议）' }[segment.mood_source] || '';
  return mood + source;
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!bytes) return '未知大小';
  return `${(bytes / 1024 / 1024).toFixed(2)} 兆字节`;
}

function statusLabel(status) {
  return ({ completed: '已完成', skipped: '已跳过', checking: '核验产物中', processing: '处理中', failed: '失败', interrupted: '已中断', pending: '待处理' })[status] || status || '待处理';
}

function statusClass(status) {
  return status === 'checking' ? 'processing' : ['completed', 'skipped', 'processing', 'failed', 'interrupted', 'pending'].includes(status) ? status : 'pending';
}

function artifactSummary(row) {
  const ready = ['completed', 'skipped'].includes(row.status);
  return [
    row.outputVideo === false ? '成片未选' : row.finalVideoPath && ready ? '成片' : '待成片',
    row.outputAudio === false ? '音频未选' : row.outputPath && ready ? '背景音乐音频' : '待音频',
    row.outputTimeline === false ? '时间轴未选' : row.timelinePath && ready ? '时间轴' : '待时间轴',
    row.outputTranscript === false ? '转录未选' : row.transcribe === false ? '转录未开启' : ready && row.transcriptPath ? '转录文本' : '待转录',
  ].join(' · ');
}

function shortPath(value, max = 52) {
  const text = String(value || '');
  return text.length > max ? `…${text.slice(-max + 1)}` : text;
}

function loadSeenUpdate() {
  try { return localStorage.getItem(UPDATE_SEEN_KEY) || ''; } catch { return ''; }
}

function markUpdateSeen() {
  if (!state.update.version) return;
  state.updateSeenVersion = state.update.version;
  try { localStorage.setItem(UPDATE_SEEN_KEY, state.updateSeenVersion); } catch { /* local-only convenience */ }
}

function hasUnreadUpdate() {
  return state.update.status === 'available' && Boolean(state.update.version) && state.updateSeenVersion !== state.update.version;
}

function applyUpdateState(update) {
  if (update && typeof update === 'object') {
    if (update.version !== undefined && update.version !== state.update.version) Object.assign(state.update, { releaseNotes: '', releaseDate: '', sizeBytes: 0 });
    state.update = { ...state.update, ...update };
  }
}

function formatUpdateDate(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
}

function renderReleaseNotes() {
  if (!state.update.version || ['idle', 'checking', 'not-available'].includes(state.update.status)) return '';
  let notes = state.update.releaseNotes || '';
  if (/<(?:p|ul|ol|li|div|h[1-6]|br|pre|blockquote)\b/i.test(notes)) {
    const template = document.createElement('template');
    template.innerHTML = notes;
    template.content.querySelectorAll('script, style, iframe, object').forEach((node) => node.remove());
    template.content.querySelectorAll('li').forEach((node) => node.prepend('• '));
    template.content.querySelectorAll('p, li, div, h1, h2, h3, h4, h5, h6, br, pre, blockquote').forEach((node) => node.append('\n'));
    notes = template.content.textContent.trim();
  }
  return `<section class="release-notes"><h3>v${escapeHtml(state.update.version)} 更新内容</h3><div class="update-notes" role="region" aria-label="新版改动说明" tabindex="0">${escapeHtml(notes || '暂未获取到此版本的改动说明，可打开下载页面查看。')}</div></section>`;
}

function renderUpdateCard() {
  const update = state.update;
  const version = escapeHtml(update.version || '—');
  const sizeNotice = update.sizeBytes ? `预计安装包 ${formatBytes(update.sizeBytes)}；实际下载量可能因差分更新而变化。` : '下载量以实际下载进度为准。';
  const statusLabel = !update.enabled && update.status === 'idle' ? '未启用' : ({ idle: '待检查', checking: '检查中', available: '有更新', downloading: '下载中', downloaded: '待安装', installing: '安装中', 'not-available': '已是最新版', error: '需要处理' })[update.status] || '待检查';
  const percent = Math.min(100, Math.max(0, Number(update.percent) || 0));
  const transfer = `${formatBytes(update.transferred)} / ${formatBytes(update.total)}`;
  const speed = update.speed ? ` · ${formatBytes(update.speed)}/秒` : '';
  const checkedAt = formatUpdateDate(update.lastCheckedAt);
  const releaseDate = formatUpdateDate(update.releaseDate);
  let content;
  if (update.status === 'checking') {
    content = '<strong>正在检查更新…</strong><p>不会影响当前批次和本地文件。</p><div class="update-actions"><button class="button ghost" disabled>检查中</button></div>';
  } else if (update.status === 'available') {
    content = `<strong>发现新版本</strong><div class="update-version">v${version}</div><p class="config-note">GitHub Releases${releaseDate === '—' ? '' : ` · 版本日期 ${releaseDate}`}</p><p class="config-note">${escapeHtml(sizeNotice)}</p><div class="update-actions"><button class="button primary" data-action="download-update">下载更新</button><button class="button ghost" data-action="open-update-page">查看下载页面</button></div>`;
  } else if (update.status === 'downloading') {
    content = `<strong>正在下载 v${version}</strong><div class="update-progress" role="progressbar" aria-label="更新下载进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent.toFixed(0)}"><span style="width:${percent}%"></span></div><p class="config-note">${percent.toFixed(0)}% · 已下载 ${transfer}${speed}</p><div class="update-actions"><button class="button ghost" data-action="cancel-update">取消下载</button></div>`;
  } else if (update.status === 'downloaded') {
    content = `<strong>更新已准备好</strong><p>v${version} 已下载完成，重启后安装。</p><div class="update-actions"><button class="button ghost" data-action="defer-update">稍后安装</button><button class="button primary" data-action="install-update" ${state.running ? 'disabled' : ''}>${state.running ? '批次运行中' : '立即重启安装'}</button></div>${state.running ? '<p class="config-note">批次运行中，完成后可安装更新。</p>' : ''}`;
  } else if (update.status === 'not-available') {
    content = `<strong>当前已是最新版</strong><p>当前版本 v${escapeHtml(update.currentVersion || state.version || '—')} · 上次检查 ${checkedAt}</p><div class="update-actions"><button class="button ghost" data-action="check-update">再次检查</button></div>`;
  } else if (update.status === 'error') {
    content = `<strong>更新操作失败</strong><p>${escapeHtml(update.errorMessage || 'GitHub 暂时无法访问')}，当前版本仍可正常使用。</p><div class="update-actions"><button class="button ghost" data-action="check-update">重试</button><button class="button ghost" data-action="open-update-page">打开下载页面</button></div>`;
  } else if (update.status === 'installing') {
    content = '<strong>正在准备重启安装</strong><p>请稍候，当前应用将关闭并安装更新。</p>';
  } else if (!update.enabled) {
    content = '<strong>应用内更新未启用</strong><p>开发模式不会联网检查更新。正式安装版可在此检查、下载和安装 GitHub Releases 中的新版本。</p>';
  } else {
    content = `<strong>检查更新</strong><p>更新不会影响本地批次和文件。${update.lastCheckedAt ? `上次检查 ${checkedAt}。` : ''}</p><div class="update-actions"><button class="button ghost" data-action="check-update">检查更新</button></div>`;
  }
  return `<div class="panel update-panel"><div class="panel-head"><strong>更新</strong><span class="update-state-label">${escapeHtml(statusLabel)}</span></div><div class="panel-body update-body" role="status" aria-live="polite">${content}${renderReleaseNotes()}</div></div>`;
}

function showToast(message, error = false) {
  toastNode.textContent = message;
  toastNode.style.borderColor = error ? 'rgba(255,127,112,.6)' : '';
  toastNode.classList.add('show');
  toastNode.setAttribute('role', error ? 'alert' : 'status');
  if (error) { toastNode.tabIndex = -1; toastNode.focus({ preventScroll: true }); }
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toastNode.classList.remove('show'), 2600);
}

function saveConfig() {
  try {
    localStorage.setItem('bgm-studio-config', JSON.stringify(state.config));
    localStorage.setItem('bgm-studio-preset', state.preset);
  } catch { /* local-only convenience */ }
}

function loadConfig(defaults) {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem('bgm-studio-config') || '{}'); } catch { stored = {}; }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) stored = {};
  return {
    ...defaults,
    ...stored,
    transcribe: stored.transcribe !== undefined ? Boolean(stored.transcribe) : true,
    overwrite: Boolean(stored.overwrite),
    autoDuck: stored.autoDuck === undefined ? defaults.autoDuck !== false : Boolean(stored.autoDuck),
    strictInstrumental: stored.strictInstrumental === undefined ? true : Boolean(stored.strictInstrumental),
    preflightEnabled: stored.preflightEnabled === undefined ? true : Boolean(stored.preflightEnabled),
    scenePriority: stored.scenePriority === undefined ? defaults.scenePriority !== false : Boolean(stored.scenePriority),
    skipCompleted: stored.skipCompleted !== undefined ? Boolean(stored.skipCompleted) : defaults.skipCompleted !== false,
    freezeTail: typeof stored.freezeTail === 'string' ? stored.freezeTail : '0:00',
    duckDb: Number.isFinite(Number(stored.duckDb)) ? Number(stored.duckDb) : -10,
    fadeIn: Number.isFinite(Number(stored.fadeIn)) ? Number(stored.fadeIn) : 2,
    fadeOut: Number.isFinite(Number(stored.fadeOut)) ? Number(stored.fadeOut) : 2,
    transitionFadeEnabled: stored.transitionFadeEnabled !== undefined ? Boolean(stored.transitionFadeEnabled) : defaults.transitionFadeEnabled !== false,
    transitionFadeDuration: stored.transitionFadeDuration !== '' && Number.isFinite(Number(stored.transitionFadeDuration)) ? Number(stored.transitionFadeDuration) : Number(defaults.transitionFadeDuration) || 1,
    minTracksPerEpisode: Number.isSafeInteger(Number(stored.minTracksPerEpisode)) && Number(stored.minTracksPerEpisode) >= 1 ? Number(stored.minTracksPerEpisode) : Number(defaults.minTracksPerEpisode) || 1,
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

async function refresh(quiet = false, live = false) {
  const sequence = ++refreshSequence;
  const config = { ...state.config };
  state.preflightPending = config.preflightEnabled !== false;
  renderChrome();
  try {
    const data = await api.inspectBatch(config);
    if (sequence !== refreshSequence || JSON.stringify(config) !== JSON.stringify(state.config)) return;
    state.data = data;
    state.preflightPending = false;
    if (!state.selectedEpisode || !state.data.rows.some((row) => row.episode === state.selectedEpisode)) {
      state.selectedEpisode = state.data.rows[0]?.episode || '';
    }
    if (!live && ['timeline', 'transcript'].includes(state.view) && state.selectedEpisode) await loadDetail(false);
    if (live) updateLive();
    else render(true);
    if (!quiet && state.data.warning) showToast(state.data.warning, true);
  } catch (error) {
    if (sequence !== refreshSequence || JSON.stringify(config) !== JSON.stringify(state.config)) return;
    state.preflightPending = false;
    state.data.warning = error.message;
    showToast(error.message, true);
    updateLive();
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
  return `<div class="path-row" data-drop-key="${key}"><label for="config-${key}">${label}</label><input id="config-${key}" class="text-input" data-config-key="${key}" list="recent-${key}" value="${escapeHtml(state.config[key] || '')}" placeholder="选择、输入或拖入目录">${recentOptions(key)}<button class="pick-button" data-action="${pickAction}" aria-label="选择${label}目录">⌕</button></div>`;
}

function videoConfigInput() {
  return `<div class="path-row video-path-row" data-drop-key="videos"><label for="config-videos">视频</label><input id="config-videos" class="text-input" data-config-key="videos" list="recent-videos" value="${escapeHtml(state.config.videos || '')}" placeholder="选择或拖入视频 / 目录">${recentOptions('videos')}<button id="video-source-button" class="pick-button" popovertarget="video-source-menu" aria-haspopup="dialog" aria-label="选择视频目录或单个视频" title="选择视频目录或单个视频">⌕</button><div id="video-source-menu" class="video-source-menu" popover="auto" role="dialog" aria-label="选择视频来源"><button type="button" data-action="choose-videos" autofocus>选择视频目录</button><button type="button" data-action="choose-video-file">选择单个视频</button></div></div>`;
}

function renderDesk() {
  const model = state.data.model || {};

  return `<section class="view">
    <div class="view-header"><div><h1>批次概览</h1></div><div class="header-actions"><button class="button ghost" data-action="new-batch" ${state.running ? 'disabled' : ''}>新建批次</button><button class="button ghost" data-action="diagnostics">复制诊断信息</button></div></div>
    <div class="metrics" id="metrics">${renderMetrics()}</div>
    <div class="panel progress-panel"><div class="panel-body" id="batch-progress" role="status" aria-live="polite">${renderProgress()}</div><div class="recovery-actions"><button class="button" data-action="continue-unfinished" ${state.running ? 'disabled' : ''}>继续未完成</button><button class="button ghost" data-action="retry-failed" ${state.running ? 'disabled' : ''}>仅重试失败项</button><button class="button ghost" data-action="open-report" ${state.data.reportPath ? '' : 'disabled'}>打开批次报告</button><button class="button ghost" data-action="open-error-log" ${state.data.errorLogPath ? '' : 'disabled'}>打开错误日志</button></div></div>
    <div class="layout-2">
      <div>
        <div class="panel"><div class="panel-head"><strong>开始前检查</strong><div class="header-actions"><small>开始前检测</small><label class="switch"><input id="config-preflightEnabled" type="checkbox" aria-label="开始前检测" data-config-key="preflightEnabled" ${state.config.preflightEnabled !== false ? 'checked' : ''}><span></span></label></div></div><div class="panel-body"><div class="preflight" id="preflight-content" role="group" aria-label="开始前检查清单">${renderPreflight()}</div></div></div>
<div class="panel"><div class="panel-head"><strong>批次队列</strong><small id="queue-count"></small></div><div class="queue-toolbar"><label for="queue-search">集数搜索</label><input id="queue-search" class="text-input" type="search" placeholder="输入集数名称" value="${escapeHtml(state.queueQuery)}"><label for="queue-filter">状态</label><select id="queue-filter" class="select-input">${[["all","全部"],["pending","待处理"],["checking","核验中"],["processing","处理中"],["completed","已完成"],["skipped","已跳过"],["failed","失败"],["interrupted","已中断"]].map(([value,label]) => `<option value="${value}" ${state.queueFilter === value ? "selected" : ""}>${label}</option>`).join("")}</select></div><div class="queue-scroll"><table class="queue-table"><thead><tr><th>集数</th><th>状态</th><th>时长</th><th>情绪 / 音乐</th><th>产物</th><th></th></tr></thead><tbody id="queue-body"></tbody></table></div><div id="queue-empty" class="empty-state">没有匹配的集数；可选择视频，或调整搜索与筛选。</div></div>
<div class="panel"><div class="panel-head"><strong>运行日志</strong><small>最近 100 条 · 自动更新</small></div><div id="run-logs" class="log-box" role="log" aria-label="批次运行日志" aria-live="polite"></div></div>
      </div>
      <aside>
        <div class="panel"><div class="panel-head"><strong>运行配置</strong><small>路径栏支持拖入与最近记录</small></div><div class="panel-body">${renderPreset()}<p class="config-note">预设只修改现有参数；不会更改目录或开启覆盖。</p><div class="drop-zone" tabindex="0" role="region" aria-label="拖放导入">拖入视频、音频或目录自动识别；也可拖到对应路径栏。</div><div class="path-stack">${videoConfigInput()}${configInput('music', '背景音乐', 'choose-music')}<details class="config-details"><summary>自动选曲与音量处理</summary><p>${state.config.strictInstrumental !== false ? "先筛选纯音乐，再匹配情绪和人工强度" : "匹配情绪和人工强度，不按人声状态排除"}，最后减少重复；相近需求连续播放，曲目不足时用中性曲目或留白。</p></details>${configInput('output', '输出', 'choose-output')}${configInput('transcripts', '字幕', 'choose-transcripts')}${state.bundledRuntime ? '' : configInput('modelPath', '模型', 'choose-model')}</div><div class="config-note" id="model-note"><strong>${state.config.transcribe ? (state.config.preflightEnabled === false ? '启动时加载转录模型' : model.exists ? '转录模型可访问' : '转录模型不可访问') : '本地转录未启用'}</strong> · ${escapeHtml(state.bundledRuntime ? '随应用内置' : shortPath(model.path || state.config.modelPath, 42))}<br>${state.config.preflightEnabled === false ? '已跳过模型预检；启动时按当前配置加载' : model.exists ? `${formatBytes(model.sizeBytes)} · ${escapeHtml(state.config.language === 'auto' ? '自动识别' : state.config.language)} · 本机低精度处理` : '勾选本地转录后需要可用的模型目录'}</div><div class="switch-row"><div class="switch-label"><b>本地语音转录</b><small>生成转录文本与时间点，辅助情绪判断</small></div><label class="switch"><input type="checkbox" aria-label="本地语音转录" data-config-key="transcribe" ${state.config.transcribe ? 'checked' : ''}><span></span></label></div><div class="switch-row"><div class="switch-label"><b>BGM 人声/歌词筛选</b><small>${state.config.strictInstrumental !== false ? "检测并排除疑似人声、未确定和分析失败的音乐。" : "不检测、不按人声状态排除；含歌唱、哼唱或口播的音乐也可参与选曲。"}</small></div><label class="switch"><input type="checkbox" aria-label="BGM 人声/歌词筛选" data-config-key="strictInstrumental" ${state.config.strictInstrumental ? 'checked' : ''}><span></span></label></div><div class="switch-row"><div class="switch-label"><b>对白时自动压低背景音乐</b><small>响度处理后执行压低；只在已有对白时间区间生效。</small></div><label class="switch"><input type="checkbox" aria-label="对白时自动压低背景音乐" data-config-key="autoDuck" ${state.config.autoDuck ? 'checked' : ''}><span></span></label></div><div class="switch-row"><div class="switch-label"><b>允许覆盖已有结果</b><small>默认保护手工文件，恢复运行无需覆盖</small></div><label class="switch"><input type="checkbox" aria-label="允许覆盖已有结果" data-config-key="overwrite" ${state.config.overwrite ? 'checked' : ''}><span></span></label></div><details class="config-details"><summary>高级音频参数</summary><div class="advanced-grid"><div class="field"><label for="config-fadeIn">淡入时长</label><input id="config-fadeIn" class="number-input" data-config-key="fadeIn" type="number" min="0" step=".1" value="${escapeHtml(state.config.fadeIn)}"></div><div class="field"><label for="config-fadeOut">淡出时长</label><input id="config-fadeOut" class="number-input" data-config-key="fadeOut" type="number" min="0" step=".1" value="${escapeHtml(state.config.fadeOut)}"></div><div class="field"><label for="config-freezeTail">片尾定格（秒:帧）</label><input id="config-freezeTail" class="text-input" data-config-key="freezeTail" type="text" inputmode="numeric" placeholder="0:00" value="${escapeHtml(state.config.freezeTail)}"><small class="field-note">例：2:15 表示 2 秒 15 帧，按输入视频帧率换算</small></div></div></details></div></div>
        <div class="panel" id="selected-episode-panel">${renderSelectedEpisode()}</div>
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
  return `<section class="view"><div class="view-header"><div><h1>设置</h1></div></div><div class="layout-2"><div class="panel"><div class="panel-head"><strong>输出内容</strong><small>设置会保存在本机</small></div><div class="panel-body">${outputs.map(([key, label, note]) => `<div class="switch-row"><div class="switch-label"><b>${label}</b><small>${note}</small></div><label class="switch"><input type="checkbox" aria-label="${escapeHtml(label)}" data-config-key="${key}" ${state.config[key] ? 'checked' : ''}><span></span></label></div>`).join('')}<div class="switch-row"><div class="switch-label"><b>跳过已完成</b><small>默认开启；已有产物有效时不重复处理</small></div><label class="switch"><input type="checkbox" aria-label="跳过已完成" data-config-key="skipCompleted" ${state.config.skipCompleted ? 'checked' : ''}><span></span></label></div><div class="config-note">未勾选的类型不会生成；修改 BGM 或选曲设置后，如需重新生成已完成集数，请先关闭“跳过已完成”。</div></div></div><aside><div class="panel"><div class="panel-head"><strong>每集 BGM 数量</strong><small>至少 ${state.config.minTracksPerEpisode} 首 · 最多 ${state.config.maxTracksPerEpisode === 0 ? '不限制' : `${state.config.maxTracksPerEpisode} 段`}${state.config.scenePriority ? ' · 转场可超限' : ''}</small></div><div class="panel-body"><div class="field"><label for="config-minTracksPerEpisode">每集至少使用不同曲目（首）</label><input id="config-minTracksPerEpisode" class="number-input" data-config-key="minTracksPerEpisode" type="number" min="1" step="1" required value="${escapeHtml(state.config.minTracksPerEpisode)}"><small class="field-note">优先在转场或停顿处补足；时长或匹配曲目不足时明确提示。</small></div><div class="field"><label for="config-maxTracksPerEpisode">每集最多配乐片段</label><input id="config-maxTracksPerEpisode" class="number-input" data-config-key="maxTracksPerEpisode" type="number" min="0" step="1" required value="${escapeHtml(state.config.maxTracksPerEpisode)}"><small class="field-note">0 表示不限制；普通情绪换曲遵守上限，转场必换可超限并明确提示。下限不能高于上限。</small><details class="field-help"><summary>选曲方式</summary><p>开启“转场必换曲”后，识别出的场景转场必须更换曲目，情绪变化也继续换曲；普通情绪换曲遵守片段上限和防频繁换曲间隔；必换转场优先，超出上限时显示实际段数及超出数量。普通对白切镜不等同于场景转场。关闭后按情绪规则和数量上限规划。下限始终按不同曲目补足，补足段最短 6 秒；只使用匹配情绪或中性的合格音乐，必换点无其他合格曲目时明确报错。</p></details></div></div></div><div class="panel"><div class="panel-head"><strong>换曲与衔接</strong><small>${state.config.transitionFadeEnabled ? '已开启' : '已关闭'}</small></div><div class="panel-body"><div class="switch-row"><div class="switch-label"><b>转场必换曲</b><small>转场必须换，情绪变化也换；普通情绪遵守上限，必换转场超限会提示</small></div><label class="switch"><input id="config-scenePriority" type="checkbox" aria-label="转场必换曲" data-config-key="scenePriority" ${state.config.scenePriority ? 'checked' : ''}><span></span></label></div><div class="switch-row"><div class="switch-label"><b>切换曲目时淡入淡出</b><small>上一段淡出，同时让下一段淡入</small></div><label class="switch"><input type="checkbox" aria-label="切换曲目时淡入淡出" data-config-key="transitionFadeEnabled" ${state.config.transitionFadeEnabled ? 'checked' : ''}><span></span></label></div><div class="field"><label for="config-transitionFadeDuration">衔接时长（秒）</label><input id="config-transitionFadeDuration" class="number-input" data-config-key="transitionFadeDuration" type="number" min="0" step="0.1" required value="${escapeHtml(state.config.transitionFadeDuration)}" ${state.config.transitionFadeEnabled ? '' : 'disabled'}><small class="field-note">衔接时长不超过较短配乐片段的一半。</small></div></div></div><div class="panel"><div class="panel-head"><strong>常用操作</strong></div><div class="panel-body"><button class="button ghost" data-action="open-path" data-path="${escapeHtml(state.config.output || '')}" ${state.config.output ? '' : 'disabled'}>打开输出目录</button></div></div></aside></div></section>`;
}

function renderAbout() {
  return `<section class="view"><div class="view-header"><div><h1>关于</h1></div></div><div class="layout-2"><div><div class="panel"><div class="panel-head"><strong>软件信息</strong></div><div class="panel-body"><div class="inspector-row"><span>名称</span><b>自动配背景音乐工作台</b></div><div class="inspector-row"><span>版本</span><b>${escapeHtml(state.version || '—')}</b></div><div class="inspector-row"><span>处理方式</span><b>本地运行</b></div><div class="config-note">视频、音频和批次产物按所选目录在本机处理与保存。</div></div></div><div class="panel"><div class="panel-head"><strong>开源组件与许可证</strong></div><div class="panel-body"><p class="about-copy">本项目原创代码采用 MIT License，文本见随包和源码中的 LICENSE。随包第三方组件及其许可证如下：</p><div class="inspector-row"><span>faster-whisper / CTranslate2 / Silero VAD</span><b>MIT</b></div><div class="inspector-row"><span>Small 模型</span><b>MIT；原始 Whisper small：Apache-2.0</b></div><div class="inspector-row"><span>Electron</span><b>MIT</b></div><div class="inspector-row"><span>electron-updater</span><b>MIT</b></div><div class="inspector-row"><span>FFmpeg shared</span><b>LGPL-3.0</b></div><div class="inspector-row"><span>YAMNet / MediaPipe Tasks Audio</span><b>Apache-2.0</b></div><div class="inspector-row"><span>PyAV / PyInstaller</span><b>BSD-3-Clause / GPLv2 特别例外</b></div><div class="config-note">完整来源、版权说明与许可证文本位于 resources/licenses/THIRD_PARTY_NOTICES.md 和 resources/licenses/。</div></div></div></div><aside>${renderUpdateCard()}</aside></div></section>`;
}
function timelineBlock(item, duration, kind, selected = false, label = '', index = 0) {
  const start = Math.max(0, Number(item.start) || 0);
  const end = Math.max(start, Number(item.end) || start);
  const left = Math.max(0, Math.min(100, (start / duration) * 100));
  const width = Math.max(.5, Math.min(100 - left, ((end - start) / duration) * 100));
  return `<button type="button" class="track-block ${kind} ${selected ? 'selected' : ''}" data-action="timeline-seek" data-kind="${kind}" data-index="${index}" data-start="${start}" aria-pressed="${selected}" aria-label="${escapeHtml(`${label}，${formatSeconds(start)} 至 ${formatSeconds(end)}`)}" style="left:${left}%;width:${width}%" title="${escapeHtml(label || `${formatSeconds(start)} – ${formatSeconds(end)}`)}"><small>${escapeHtml(label)}</small></button>`;
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
  const selectedTimelineIndex = state.selectedMusic >= 0 ? state.selectedMusic : current ? timeline.findIndex((segment) => current.start >= segment.start && current.start < segment.end) : -1;
  const ruler = [0, .25, .5, .75, 1].map((ratio) => `<span>${formatSeconds(duration * ratio)}</span>`).join('');
  const dialogue = detail.transcript.map((item, index) => timelineBlock(item, duration, 'dialogue', index === currentIndex, item.text, index)).join('');
  const music = timeline.map((item, index) => timelineBlock(item, duration, 'music', index === selectedTimelineIndex, `${item.mood || '背景音乐'} · ${String(item.bgm_file || '').split(/[\\/]/).pop()}`, index)).join('');
  const duck = duckSegments.map((item) => timelineBlock(item, duration, 'duck', false, '对白区间')).join('');
  const freezeTailSeconds = Math.min(duration, Math.max(0, Number(detail.freezeTailSeconds) || 0));
  const freezeTail = freezeTailSeconds ? timelineBlock({ start: duration - freezeTailSeconds, end: duration }, duration, 'freeze', false, `片尾定格 ${detail.freezeTail}（无背景音乐）`) : '';
  const playhead = current ? Math.max(0, Math.min(100, (current.start / duration) * 100)) : null;
  const first = timeline[0] || {};
  return `<section class="view"><div class="detail-heading"><div><button class="back-link" data-action="set-view" data-view="desk">← 批次控制台</button><h1>时间轴 <span class="muted">/ ${escapeHtml(detail.episode)}</span></h1></div><div class="detail-actions"><button class="button ghost" data-action="open-transcript" data-episode="${escapeHtml(detail.episode)}">转录审阅</button>${detail.finalVideoExists ? `<button class="button primary" data-action="open-path" data-path="${escapeHtml(detail.finalVideoPath)}">打开成片</button>` : ''}${detail.audioUrl ? `<button class="button ghost" data-action="open-path" data-path="${escapeHtml(detail.outputPath)}">打开背景音乐音频</button>` : ""}</div></div><div class="layout-2"><div><div class="timeline-shell"><div class="ruler"><span></span>${ruler}</div><div class="timeline-track"><div class="track-label"><b>对白 / 转录</b>${detail.transcript.length} 个句段</div><div class="track-canvas">${dialogue || '<span class="health-caption">没有转录句段</span>'}<i class="playhead" style="left:${playhead || 0}%"></i></div></div><div class="timeline-track"><div class="track-label"><b>背景音乐轨</b>${timeline.length} 个片段</div><div class="track-canvas">${music || '<span class="health-caption">等待渲染产物</span>'}<i class="playhead" style="left:${playhead || 0}%"></i></div></div><div class="timeline-track"><div class="track-label"><b>对白压低</b>${duckSegments.length} 个区间</div><div class="track-canvas">${duck || '<span class="health-caption">没有对白压低区间</span>'}</div></div><div class="timeline-track"><div class="track-label"><b>片尾定格</b>${freezeTailSeconds ? detail.freezeTail : "未设置"}</div><div class="track-canvas">${freezeTail || "未设置定格时长"}</div></div></div><div class="timeline-meta"><div class="meta-card"><span>时长</span><b>${formatSeconds(duration)}</b></div><div class="meta-card"><span>格式</span><b>PCM 16 位音频</b></div><div class="meta-card"><span>输出</span><b>48 千赫 · 双声道</b></div><div class="meta-card"><span>淡入 / 对白压低</span><b>${first.fade_in_sec || '0'} 秒 / ${Number(first.duck_db) < 0 ? '已开启' : '已关闭'}</b></div></div></div><aside class="inspector">${renderPlayers(detail)}${renderAnalysisEvidence(detail)}<div class="inspector-card"><h3>输出检查</h3><div class="inspector-row"><span>状态</span><b>${statusLabel(detail.status)}</b></div><div class="inspector-row"><span>情绪段</span><b>${escapeHtml(detail.mood || '—')}</b></div><div class="inspector-row"><span>峰值目标</span><b>≤ -1.0 dBFS</b></div><div class="inspector-row"><span>时间表</span><b>${timeline.length ? '已生成' : '未生成'}</b></div><div class="inspector-row"><span>转录</span><b>${detail.transcript.length ? '转录文本已生成' : '未生成'}</b></div></div><div class="inspector-card"><h3>当前切点</h3><div class="inspector-row"><span>时间</span><b id="bookmark-time">${current ? formatSeconds(current.start) : '—'}</b></div><div class="inspector-row"><span>说明</span><b id="bookmark-reason">${escapeHtml(selectedTimelineIndex >= 0 ? timeline[selectedTimelineIndex].selection_reason : '点击对白块或音乐块查看')}</b></div></div><div class="notice"><b>需要人工确认</b><br>时间轴展示的是自动计划证据；真正交付前请试听对白清晰度、切点和 对白压低。</div></aside></div></section>`;
}

function renderAnalysisEvidence(detail) {
  const analysis = detail.analysis;
  if (!analysis) return '<div class="notice">旧版产物：尚未使用本轮策略重新生成。</div>';
  return `<div class="inspector-card"><h3>本次分析依据</h3><p>纯音乐：${analysis.strictInstrumental ? '严格筛选' : '允许未确认曲目'} · 时间：${analysis.wordTimestamps ? '词级时间' : '句段时间，需抽查'} · 压低：${analysis.ducking?.enabled ? `${analysis.ducking.db} dB` : '未生效'}</p>${analysis.sceneError ? `<p>${escapeHtml(analysis.sceneError)}</p>` : ''}<p>转场必换：${analysis.scenePriority ? '开启' : '关闭'}${analysis.trackCount ? ` · 实际 ${analysis.trackCount.actual} 首 / ${analysis.trackCount.segments} 段 · 下限 ${analysis.trackCount.minimum} 首${analysis.trackCount.maximum !== undefined ? ' · 上限 ' + (analysis.trackCount.maximum || '不限') + (analysis.trackCount.maximum ? ' 段' : '') : ''}` : ''}</p>${analysis.trackCount?.warning ? `<p class="notice error-text">${escapeHtml(analysis.trackCount.warning)}</p>` : ''}<details><summary>镜头候选与换歌依据（${analysis.sceneCandidates?.length || 0} 处）</summary>${(analysis.sceneCandidates || []).map((cut) => `<p>${formatSeconds(cut.time)} · ${cut.required ? '场景转场（必换）' : '镜头候选'} · ${cut.used ? '已换曲' : '保留原曲'}</p>`).join('')}${(analysis.segments || []).map((segment) => `<p>${formatSeconds(segment.start)}–${formatSeconds(segment.end)} · ${escapeHtml(segment.reason)} · 入点 ${segment.cueIn || 0} 秒${segment.review ? ' · 待检查' : ''}</p>`).join('')}</details><p class="config-note">原音轨保留；原片是否已有音乐尚需听辨。规则不理解地点或时间跳跃的含义。</p></div>`;
}

function renderPlayers(detail) {
  const mode = state.mediaMode === 'video' && detail.finalVideoUrl ? 'video' : detail.audioUrl ? 'audio' : 'video';
  state.mediaMode = mode;
  return `<div class="audio-box video-review"><div class="preview-heading"><strong>试听与验收</strong><span>空格播放 · ← → 跳转 5 秒</span></div><div class="media-tabs" role="group" aria-label="试听来源"><button class="button ghost" data-action="media-mode" data-mode="video" aria-pressed="${mode === 'video'}" ${detail.finalVideoUrl ? '' : 'disabled'}>成片 · 对白 + BGM</button><button class="button ghost" data-action="media-mode" data-mode="audio" aria-pressed="${mode === 'audio'}" ${detail.audioUrl ? '' : 'disabled'}>纯 BGM</button></div>${detail.finalVideoUrl ? `<video id="final-video" class="review-video" aria-label="试听成片，包含对白和背景音乐" controls preload="metadata" src="${escapeHtml(detail.finalVideoUrl)}" ${mode === 'video' ? '' : 'hidden'}></video>` : '<p class="config-note">本集成片尚未生成。</p>'}${detail.audioUrl ? `<audio id="preview-audio" aria-label="试听纯背景音乐" controls preload="metadata" src="${escapeHtml(detail.audioUrl)}" ${mode === 'audio' ? '' : 'hidden'}></audio>` : '<p class="config-note">本集暂无纯 BGM 文件。</p>'}<p id="final-video-status" class="preview-status" role="status" hidden>成片无法播放，请点击打开成片使用本机播放器检查。</p><p id="preview-audio-status" class="preview-status" role="status" hidden>纯 BGM 无法播放，请在输出目录检查音频文件。</p><div class="media-shortcuts" tabindex="0" role="group" aria-label="播放快捷键区域：空格播放或暂停，左右方向键跳转五秒">${detail.transcript.length ? '<button class="button ghost preview-action" data-action="play-line">试听当前句段</button>' : ''}<span class="config-note" id="playback-time">${formatSeconds(state.playbackTime)}</span></div><div class="artifact-actions">${detail.finalVideoExists ? `<button class="button ghost" data-action="open-path" data-path="${escapeHtml(detail.finalVideoPath)}">打开成片</button>` : ''}${detail.audioUrl ? `<button class="button ghost" data-action="show-item" data-path="${escapeHtml(detail.outputPath)}">打开 BGM 产物位置</button>` : ''}${detail.timelinePath ? `<button class="button ghost" data-action="open-path" data-path="${escapeHtml(detail.timelinePath)}">打开时间轴文件</button>` : ''}</div></div>`;
}

function renderTranscript() {
  const detail = state.detail;
  if (!detail || !selectedRow()) return `<section class="view"><button class="back-link" data-action="set-view" data-view="desk">← 返回批次控制台</button><div class="empty-state"><strong>还没有可审阅的转录</strong>先运行本地语音转录，或导入同名转录文本文件。</div></section>`;
  const lines = detail.transcript || [];
  const index = Math.min(state.selectedTranscript, Math.max(0, lines.length - 1));
  const current = lines[index];
  const mid = current ? (current.start + current.end) / 2 : 0;
  const segment = detail.timeline.find((item) => mid >= item.start && mid < item.end) || {};
  const linesHtml = lines.map((line, lineIndex) => {
    const at = (line.start + line.end) / 2;
    const music = detail.timeline.find((item) => at >= item.start && at < item.end) || {};
    return `<button type="button" class="transcript-line ${lineIndex === index ? 'selected' : ''}" aria-pressed="${lineIndex === index}" data-action="select-transcript" data-index="${lineIndex}"><span class="transcript-time">${formatSeconds(line.start)}<br>${formatSeconds(line.end)}</span><span class="transcript-text">${escapeHtml(line.text)}</span><span class="transcript-tag">${escapeHtml(musicMoodLabel(music))}</span></button>`;
  }).join('');
  return `<section class="view"><div class="detail-heading"><div><button class="back-link" data-action="set-view" data-view="desk">← 批次控制台</button><h1>对白审阅 <span class="muted">/ ${escapeHtml(detail.episode)}</span></h1></div><div class="detail-actions"><button class="button ghost" data-action="open-timeline" data-episode="${escapeHtml(detail.episode)}">时间轴</button>${detail.transcriptPath ? `<button class="button ghost" data-action="open-path" data-path="${escapeHtml(detail.transcriptPath)}">打开转录文本</button>` : ''}</div></div><div class="transcript-layout"><div class="panel transcript-panel"><div class="panel-head"><strong>对白句段 · ${lines.length}</strong><small>${escapeHtml(detail.mood || '情绪待判定')}</small></div><div class="panel-body transcript-scroll" role="region" aria-label="对白句段" tabindex="0"><div class="transcript-list">${linesHtml || '<div class="empty-state">没有转录句段；本集可能没有音轨或尚未开启转录。</div>'}</div></div></div><aside class="transcript-side">${renderPlayers(detail)}<div class="reason-card"><h3>音乐书签</h3><div class="big" id="bookmark-time">${current ? formatSeconds(current.start) : '—'}</div><p id="bookmark-reason">${escapeHtml(segment.selection_reason || '选择一个句段查看选曲原因。')}</p><div class="inspector-row"><span>当前背景音乐</span><b id="bookmark-track">${escapeHtml(String(segment.bgm_file || '').split(/[\\/]/).pop() || '—')}</b></div><div class="inspector-row"><span>当前情绪</span><b id="bookmark-mood">${escapeHtml(musicMoodLabel(segment))}</b></div><button class="button primary bookmark-jump" data-action="jump-to-line">跳到时间轴</button></div><div class="notice"><b>审阅提示</b><br>关键词规则只提供线索，不代表完整剧情理解；请试听对白清晰度、切点和压低效果后再交付。</div></aside></div></section>`;
}

function renderChrome() {
  const viewTitle = ({ desk: '批次控制台', timeline: '时间轴', transcript: '对白审阅', settings: '设置', about: '关于' })[state.view];
  topTitle.textContent = viewTitle;
  topStart.textContent = state.running ? '停止批次' : '开始批次';
  topStart.dataset.action = state.running ? 'stop' : 'start';
  topStart.classList.toggle('primary', !state.running);
  topStart.classList.toggle('warn', state.running);
  topStart.hidden = state.view !== 'desk' && !state.running;
  topStart.disabled = state.starting || state.checkingLibrary || (!state.running && state.config.preflightEnabled !== false && (state.preflightPending || Boolean(state.data.warning) || preflightChecks().some((check) => !check.ok)));
  topStart.title = topStart.disabled ? '请完成页面上的开始前检查' : '';
  document.querySelectorAll('.nav-item').forEach((item) => {
    const active = item.dataset.view === state.view;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
  const aboutNav = document.querySelector('.nav-item[data-view="about"]');
  if (state.view === 'about' && hasUnreadUpdate()) markUpdateSeen();
  if (aboutNav) {
    aboutNav.setAttribute('aria-label', hasUnreadUpdate() ? '关于，有新版本可用' : '关于');
    aboutNav.querySelector('.update-dot')?.classList.toggle('visible', hasUnreadUpdate());
  }
  sidebarRuntime.textContent = state.running ? '批次运行中 · 可中断' : state.data.rows.length ? '已读取上次批次状态' : '离线链路待启动';
}

function render(preserveScroll = false) {
  const scrollTop = screen.scrollTop;
  const transcriptScrollTop = screen.querySelector('.transcript-scroll')?.scrollTop;
  const focused = screen.contains(document.activeElement) ? document.activeElement : null;
  const focusId = focused?.id;
  const focusKey = focused?.dataset.configKey;
  const focusAction = focused?.dataset.action;
  const focusData = focused?.dataset || {};
  renderChrome();
  state.previewEnd = null;
  screen.innerHTML = ({ desk: renderDesk, timeline: renderTimeline, transcript: renderTranscript, settings: renderSettings, about: renderAbout })[state.view]?.() || renderDesk();
  const libraryResult = document.getElementById('library-result');
  if (libraryResult) libraryResult._library = state.library;
  document.getElementById('final-video')?.addEventListener('error', () => {
    const status = document.getElementById('final-video-status');
    if (status) status.hidden = false;
  });
  document.getElementById('preview-audio')?.addEventListener('error', () => {
    const status = document.getElementById('preview-audio-status');
    if (status) status.hidden = false;
  });
  if (preserveScroll) screen.scrollTop = scrollTop;
  if (transcriptScrollTop !== undefined) screen.querySelector('.transcript-scroll')?.scrollTo(0, transcriptScrollTop);
  const focusTarget = focusId ? document.getElementById(focusId) : focusKey ? [...screen.querySelectorAll('[data-config-key]')].find((item) => item.dataset.configKey === focusKey) : focusAction ? [...screen.querySelectorAll('[data-action]')].find((item) => item.dataset.action === focusAction && item.dataset.episode === focusData.episode && item.dataset.index === focusData.index && item.dataset.view === focusData.view) : null;
  focusTarget?.focus({ preventScroll: true });
  bindMedia();
  updateLive();
}

async function startBatch(runMode = 'all') {
  if (state.running || state.starting || state.checkingLibrary) return;
  state.starting = true;
  updateLive();
  try {
    if (state.config.preflightEnabled !== false) await refresh(true, true);
    if (state.config.preflightEnabled !== false && (state.preflightPending || state.data.warning || preflightChecks().some((check) => !check.ok))) {
      state.view = 'desk'; render();
      document.querySelector('#preflight-content button')?.focus();
      return showToast('请先修复开始前检查中的失败项', true);
    }
    const current = selectedRow();
    if (runMode === 'failed' && !state.data.rows.some((row) => row.status === 'failed')) return showToast('没有需要重试的失败项');
    if (runMode === 'episode' && !current?.videoPath) return showToast('请先选择可访问的视频', true);
    if (runMode === 'episode' && !window.confirm(`重新生成“${current.episode}”？仅替换本程序为该集创建的产物，仍保护同名手工文件；原始视频和音乐不会修改。`)) return;
    if (runMode === 'all' && state.config.overwrite && !window.confirm('已开启允许覆盖：本次队列的同名输出可能被替换。原始素材不会修改，是否继续？')) return;
    rememberPaths();
    const result = await api.startBatch({ ...state.config, runMode, ...(runMode === 'all' ? {} : { overwrite: false }), ...(runMode === 'episode' ? { episodeVideoPath: current.videoPath } : {}) });
    if (result.run && (!state.run || state.run.startedAt < result.run.startedAt)) state.run = result.run;
    if (state.run?.status === 'running') state.running = true;
    showToast('批次已启动，可随时停止并恢复');
    updateLive();
  } catch (error) {
    showToast(error.message, true);
  } finally { state.starting = false; updateLive(); }
}

async function chooseDirectory(key, title) {
  const value = await api.chooseDirectory(title);
  if (!value) return;
  state.config[key] = value;
  if (key === 'music') state.library = null;
  rememberPaths();
  saveConfig();
  await refresh(true);
}

async function openDetail(episode, view) {
  state.selectedEpisode = episode || state.selectedEpisode || state.data.rows[0]?.episode || '';
  state.selectedTranscript = 0;
  state.selectedMusic = -1;
  state.playbackTime = 0;
  await loadDetail();
  state.view = view;
  render();
}

function activeMedia() {
  return document.getElementById(state.mediaMode === 'video' ? 'final-video' : 'preview-audio');
}

async function playCurrentLine() {
  const media = activeMedia();
  const line = state.detail?.transcript?.[state.selectedTranscript];
  if (!media || !line) return showToast('当前没有可试听句段', true);
  try {
    seekMedia(line.start);
    state.previewEnd = line.end;
    await media.play();
  } catch {
    showToast('无法启动句段试听，请使用播放器控件或打开产物检查', true);
  }
}

function seekMedia(time) {
  const media = activeMedia();
  state.previewEnd = null;
  state.playbackTime = Math.max(0, Number(time) || 0);
  syncReview(state.playbackTime);
  if (!media) return;
  const seek = () => {
    try { media.currentTime = Math.min(state.playbackTime, Number.isFinite(media.duration) ? media.duration : state.playbackTime); }
    catch { showToast('暂时无法跳到该时间点，请检查产物文件', true); }
  };
  if (media.readyState >= 1) seek();
  else media.addEventListener('loadedmetadata', seek, { once: true });
}

function syncReview(time) {
  const detail = state.detail;
  if (!detail) return;
  const musicIndex = detail.timeline.findIndex((item) => time >= item.start && time < item.end);
  const segment = detail.timeline[musicIndex] || {};
  state.selectedMusic = musicIndex;
  const transcriptIndex = detail.transcript.findIndex((item) => time >= item.start && time < item.end);
  if (transcriptIndex >= 0) state.selectedTranscript = transcriptIndex;
  document.querySelectorAll('.transcript-line, .track-block.dialogue, .track-block.music').forEach((node) => {
    const selected = Number(node.dataset.index) === (node.classList.contains('music') ? musicIndex : transcriptIndex);
    node.classList.toggle('selected', selected);
    node.setAttribute('aria-pressed', String(selected));
  });
  const values = { 'bookmark-time': formatSeconds(time), 'bookmark-reason': segment.selection_reason || '当前时间没有音乐片段', 'bookmark-track': String(segment.bgm_file || '').split(/[\\/]/).pop() || '—', 'bookmark-mood': musicMoodLabel(segment), 'playback-time': formatSeconds(time) };
  for (const [id, value] of Object.entries(values)) { const node = document.getElementById(id); if (node) node.textContent = value; }
  document.querySelectorAll('.playhead').forEach((node) => { node.style.left = `${Math.min(100, Math.max(0, time / Math.max(1, detail.duration) * 100))}%`; });
}

function bindMedia() {
  for (const media of screen.querySelectorAll('audio, video')) {
    media.addEventListener('play', () => {
      for (const other of screen.querySelectorAll('audio, video')) if (other !== media) other.pause();
    });
    media.addEventListener('timeupdate', () => {
      if (media !== activeMedia()) return;
      state.playbackTime = media.currentTime;
      syncReview(media.currentTime);
      if (state.previewEnd !== null && media.currentTime >= state.previewEnd) { media.pause(); state.previewEnd = null; }
    });
    media.addEventListener('loadedmetadata', () => {
      if (media === activeMedia() && state.playbackTime) media.currentTime = Math.min(media.duration, state.playbackTime);
    });
  }
  syncReview(state.playbackTime);
}

function selectTranscript(index) {
  const line = state.detail?.transcript?.[index];
  if (!line) return;
  state.selectedTranscript = index;
  seekMedia(line.start);
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  target.closest('[popover]')?.hidePopover();
  try {
    if (action === 'set-view') {
      state.view = target.dataset.view;
      if (['timeline', 'transcript'].includes(state.view)) await loadDetail();
      render();
    } else if (action === 'refresh') {
      await refresh();
    } else if (action === 'check-update') {
      applyUpdateState(await api.checkForUpdates());
      showToast('正在检查更新…');
      render();
    } else if (action === 'download-update') {
      applyUpdateState(await api.downloadUpdate());
      showToast('正在下载更新…');
      render();
    } else if (action === 'cancel-update') {
      applyUpdateState(await api.cancelUpdate());
      showToast('已取消下载更新');
      render();
    } else if (action === 'defer-update') {
      showToast('更新已保留，稍后可在“关于”页安装');
    } else if (action === 'install-update') {
      applyUpdateState(await api.installUpdate());
      render();
    } else if (action === 'open-update-page') {
      await api.openUpdatePage();
    } else if (action === 'toggle-maximize') {
      await api.toggleMaximize();
    } else if (action === 'start') {
      await startBatch();
    } else if (action === 'continue-unfinished') {
      await startBatch('unfinished');
    } else if (action === 'retry-failed') {
      await startBatch('failed');
    } else if (action === 'regenerate') {
      await startBatch('episode');
    } else if (action === 'disable-transcribe') {
      state.config.transcribe = false;
      saveConfig();
      await refresh(true);
    } else if (action === 'fix-freeze-tail') {
      state.view = 'desk';
      render();
      const input = document.getElementById('config-freezeTail');
      input.closest('details').open = true;
      input.focus();
    } else if (action === 'reset-duck') {
      state.config.duckDb = -10;
      saveConfig();
      await refresh(true, true);
    } else if (action === 'check-library' || action === 'analyze-library') {
      if (action === 'analyze-library' && state.config.strictInstrumental === false) return showToast('人声筛选已关闭，开启后可分析');
      if (state.checkingLibrary || state.running) return;
      const config = { ...state.config };
      state.checkingLibrary = true;
      state.libraryProgress = null;
      updateLive();
      try { const library = await api.checkMusicLibrary({ ...config, analyzeVocals: action === 'analyze-library' }); if (state.config.music === config.music && state.config.strictInstrumental === config.strictInstrumental) state.library = library; }
      finally { state.checkingLibrary = false; updateLive(); }
    } else if (action === 'stop-library') {
      await api.stopLibraryAnalysis();
    } else if (action === 'review-track') {
      const index = Number(target.dataset.index);
      const file = state.library.files[index];
      const result = await api.reviewMusicTrack({ ...state.config, file: file.file, action: target.dataset.review,
        ...(target.dataset.review === 'metadata' ? { cueIn: document.getElementById(`cue-${index}`).value, intensity: document.getElementById(`intensity-${index}`).value } : {}),
      });
      Object.assign(file, result);
      state.library = { ...state.library, usable: state.library.files.filter((entry) => entry.playable && entry.eligible).length };
      updateLive();
      showToast('曲目设置已保存');
    } else if (action === 'audition-vocal') {
      const audio = document.getElementById(`library-audio-${target.dataset.index}`);
      document.querySelectorAll('.library-track audio').forEach((other) => { if (other !== audio) other.pause(); });
      audio.currentTime = Number(target.dataset.start);
      audio.ontimeupdate = () => { if (audio.currentTime >= Number(target.dataset.end)) { audio.pause(); audio.ontimeupdate = null; } };
      await audio.play();
    } else if (action === 'open-report' || action === 'open-error-log') {
      const path = action === 'open-report' ? state.data.reportPath : state.data.errorLogPath;
      if (path) await api.openPath(path);
    } else if (action === 'diagnostics') {
      const text = await api.previewDiagnostics(state.config);
      document.getElementById('diagnostic-text').value = text;
      document.getElementById('diagnostics-dialog').showModal();
      document.getElementById('copy-diagnostics').focus();
    } else if (action === 'copy-diagnostics') {
      await api.copyDiagnostics(state.config);
      document.getElementById('diagnostics-dialog').close();
      showToast('已复制脱敏诊断信息');
    } else if (action === 'close-diagnostics') {
      document.getElementById('diagnostics-dialog').close();
    } else if (action === 'stop') {
      await api.stopBatch();
      if (state.run) state.run.currentStage = 'stopping';
      updateLive();
      showToast('正在停止当前子进程…');
    } else if (action === 'new-batch') {
      if (state.running || state.starting) return;
      if (!window.confirm('新建批次将清空当前目录配置和界面记录，磁盘上的视频、音乐和已有产物都不会删除。是否继续？')) return;
      state.config = { ...state.config, videos: '', music: '', output: '', transcripts: '', overwrite: false };
      state.data = { rows: [], summary: null, warning: null };
      state.selectedEpisode = '';
      state.detail = null;
      state.run = null;
      state.logs = [];
      state.library = null;
      state.queueQuery = '';
      state.queueFilter = 'all';
      state.view = 'desk';
      saveConfig();
      await refresh(true);
    } else if (action === 'choose-videos') {
      await chooseDirectory('videos', '选择视频目录');
    } else if (action === 'choose-video-file') {
      const value = await api.chooseVideoFile();
      if (value) { state.config.videos = value; rememberPaths(); saveConfig(); await refresh(true); }
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
      updateLive();
    } else if (action === 'open-detail') {
      await openDetail(target.dataset.episode, 'timeline');
    } else if (action === 'open-timeline') {
      await openDetail(target.dataset.episode, 'timeline');
    } else if (action === 'open-transcript') {
      await openDetail(target.dataset.episode, 'transcript');
    } else if (action === 'select-transcript') {
      selectTranscript(Number(target.dataset.index) || 0);
    } else if (action === 'timeline-seek') {
      if (target.dataset.kind === 'dialogue') selectTranscript(Number(target.dataset.index));
      else seekMedia(Number(target.dataset.start));
    } else if (action === 'media-mode') {
      const time = activeMedia()?.currentTime || state.playbackTime;
      activeMedia()?.pause();
      state.mediaMode = target.dataset.mode;
      const video = document.getElementById('final-video');
      const audio = document.getElementById('preview-audio');
      if (video) video.hidden = state.mediaMode !== 'video';
      if (audio) audio.hidden = state.mediaMode !== 'audio';
      document.querySelectorAll('[data-action="media-mode"]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.mode === state.mediaMode)));
      seekMedia(time);
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
  if (event.target.id === 'queue-filter') { state.queueFilter = event.target.value; patchQueue(); return; }
  if (event.target.id === 'config-preset') {
    const preset = PRESETS[event.target.value];
    if (!preset) return;
    state.preset = event.target.value;
    const { label, description, ...config } = preset;
    Object.assign(state.config, config);
    saveConfig();
    refresh(true);
    showToast(`已应用“${label}”预设`);
    return;
  }
  const input = event.target.closest('[data-config-key]');
  if (!input) return;
  const key = input.dataset.configKey;
  state.config[key] = input.type === 'checkbox' ? input.checked : (['duckDb', 'fadeIn', 'fadeOut', 'transitionFadeDuration', 'minTracksPerEpisode', 'maxTracksPerEpisode'].includes(key) ? (input.value === '' ? '' : Number(input.value)) : input.value);
  saveConfig();
  if (key === 'music' || key === 'strictInstrumental') state.library = null;
  const redraw = key === 'strictInstrumental' || key === 'preflightEnabled';
  if (redraw) render(true);
  clearTimeout(refreshTimer);
  rememberPaths();
  refresh(true, !redraw);
  if (key === 'scenePriority' && state.view === 'settings') render(true);
  const transitionDuration = document.getElementById('config-transitionFadeDuration');
  if (transitionDuration) transitionDuration.disabled = !state.config.transitionFadeEnabled;
});
document.addEventListener('input', (event) => {
  if (event.target.id === 'library-search') {
    state.libraryQuery = event.target.value;
    document.querySelectorAll('[data-library-text]').forEach((node) => { node.hidden = !node.dataset.libraryText.includes(state.libraryQuery.toLowerCase()); });
    return;
  }
  if (event.target.id === 'queue-search') { state.queueQuery = event.target.value; patchQueue(); return; }
  const input = event.target.closest('[data-config-key]');
  if (!input || input.type === 'checkbox') return;
  state.config[input.dataset.configKey] = ['duckDb', 'fadeIn', 'fadeOut', 'transitionFadeDuration', 'minTracksPerEpisode', 'maxTracksPerEpisode'].includes(input.dataset.configKey) ? (input.value === '' ? '' : Number(input.value)) : input.value;
  saveConfig();
  if (input.dataset.configKey === 'music') state.library = null;
  refreshSequence += 1;
  state.preflightPending = state.config.preflightEnabled !== false;
  renderChrome();
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh(true, true), 400);
});

document.addEventListener('keydown', async (event) => {
  if (![' ', 'ArrowLeft', 'ArrowRight'].includes(event.key) || event.target.closest('input, textarea, select, button, a, audio, video, [contenteditable]') || !['timeline', 'transcript'].includes(state.view)) return;
  const media = activeMedia();
  if (!media) return;
  event.preventDefault();
  if (event.key !== ' ') return seekMedia(media.currentTime + (event.key === 'ArrowLeft' ? -5 : 5));
  try { if (media.paused) await media.play(); else media.pause(); } catch { showToast('无法播放，请检查产物文件', true); }
});

document.addEventListener('dragover', (event) => {
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('drop', async (event) => {
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault();
  const files = [...event.dataTransfer.files];
  if (files.length !== 1) return showToast('请一次拖入一个视频、音频或目录', true);
  try {
    const result = await api.resolveImport({ path: api.getPathForFile(files[0]), key: event.target.closest('[data-drop-key]')?.dataset.dropKey || '' });
    if (result.key === 'modelPath' && state.bundledRuntime) return showToast('安装版使用内置模型，无需导入');
    state.config[result.key] = result.path;
    if (result.key === 'music') state.library = null;
    rememberPaths(); saveConfig();
    await refresh(true);
    showToast('已识别并导入路径');
  } catch (error) { showToast(error.message, true); }
});

api.onBatchEvent((event) => {
  if (event.type === 'library-progress' || event.library) { state.libraryProgress = event.library; scheduleLiveUpdate(); if (event.type === 'library-progress') return; }
  if (event.run) state.run = event.run;
  if (event.type === 'started') {
    state.running = true;
    state.logs = [];
    state.logs.push({ level: 'success', message: '批次已启动 · 可恢复运行' });
  } else if (event.type === 'log') {
    state.logs.push({ level: event.level, message: event.message });
  } else if (event.type === 'progress') {
    if (event.episode && state.data.rows) {
      const row = state.data.rows.find((item) => item.episode === event.episode);
      if (row) Object.assign(row, event);
      else state.data.rows.push({ duration: null, mood: '', tracks: [], ...event });
    }
  } else if (event.type === 'finished') {
    state.running = false;
    state.logs.push({ level: 'success', message: `批次结束 · 完成 ${event.summary?.completed || 0} · 跳过 ${event.summary?.skipped || 0} · 失败 ${event.summary?.failed || 0}` });
    showToast('批次已结束，正在刷新产物');
    refresh(true, true);
  } else if (event.type === 'stopped') {
    state.running = false;
    state.logs.push({ level: 'error', message: event.message || '批次已停止' });
    showToast(event.message || '批次已停止');
    refresh(true, true);
  } else if (event.type === 'error') {
    state.running = false;
    state.logs.push({ level: 'error', message: event.message });
    showToast(event.message, true);
    refresh(true, true);
  }
  if (state.logs.length > 100) state.logs.splice(0, state.logs.length - 100);
  scheduleLiveUpdate();
});

api.onUpdateEvent((update) => {
  applyUpdateState(update);
  renderChrome();
  if (state.view === 'about') {
    const card = screen.querySelector('.update-panel');
    if (card) card.outerHTML = renderUpdateCard();
  }
});

(async () => {
  try {
    const info = await api.appInfo();
    state.version = info.version || '';
    state.updateSeenVersion = loadSeenUpdate();
    applyUpdateState(info.update);
    state.defaults = info.defaults || {};
    state.bundledRuntime = Boolean(info.bundledRuntime);
    state.config = loadConfig(state.defaults);
    try { state.preset = localStorage.getItem('bgm-studio-preset') || ''; } catch { /* local-only convenience */ }
    if (!PRESETS[state.preset]) state.preset = '';
    if (!state.run || !info.run || (info.run.estimatedAt || 0) >= (state.run.estimatedAt || 0)) {
      state.running = Boolean(info.running);
      state.run = info.run || null;
      state.logs = info.logs || [];
    }
    if (state.running && state.run?.config) {
      const { strictInstrumental, preflightEnabled, ...runningConfig } = state.run.config;
      Object.assign(state.config, runningConfig);
    }
    try {
      const recent = JSON.parse(localStorage.getItem('bgm-studio-recent-paths') || '{}');
      for (const key of ['videos', 'music', 'output', 'transcripts', 'modelPath']) state.recentPaths[key] = Array.isArray(recent[key]) ? recent[key].filter((value) => typeof value === 'string').slice(0, 5) : [];
    } catch { state.recentPaths = {}; }
    if (state.bundledRuntime) Object.assign(state.config, { modelPath: state.defaults.modelPath, ffmpeg: state.defaults.ffmpeg, ffprobe: state.defaults.ffprobe });
    await refresh(true);
  } catch (error) {
    showToast(error.message, true);
    render();
  }
})();

setInterval(() => { if (state.running && state.view === 'desk') updateHTML('batch-progress', renderProgress()); }, 1000);
