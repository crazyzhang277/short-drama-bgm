'use strict';

const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RELEASE_URL = 'https://github.com/crazyzhang277/short-drama-bgm/releases';

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function releaseNotesText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((item) => typeof item === 'string' ? item : item?.note || item?.body || '')
    .filter(Boolean)
    .join('\n\n');
}

async function fetchReleaseNotes(version) {
  const response = await fetch(`https://api.github.com/repos/crazyzhang277/short-drama-bgm/releases/tags/v${encodeURIComponent(version)}`, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error('无法获取发布说明');
  const release = await response.json();
  return release.tag_name === `v${version}` && !release.draft && !release.prerelease ? asText(release.body) : '';
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function updateInfo(info = {}, previous = {}) {
  if (info.version && info.version !== previous.version) previous = {};
  return {
    version: asText(info.version) || previous.version || '',
    releaseDate: asText(info.releaseDate) || previous.releaseDate || '',
    releaseNotes: releaseNotesText(info.releaseNotes) || previous.releaseNotes || '',
    sizeBytes: Math.max(0, finiteNumber(info.files?.[0]?.size, previous.sizeBytes || 0)),
  };
}

function createUpdateService({
  updater,
  currentVersion = '',
  enabled = true,
  emit = () => {},
  isBatchRunning = () => false,
  createCancellationToken = () => null,
  now = () => new Date(),
  intervalMs = UPDATE_INTERVAL_MS,
  lastCheckAt: previousCheckAt = 0,
  onCheckAt = () => {},
} = {}) {
  const parsedCheckAt = typeof previousCheckAt === 'string' ? Date.parse(previousCheckAt) : Number(previousCheckAt);
  const state = {
    status: 'idle',
    enabled: Boolean(enabled && updater),
    currentVersion: asText(currentVersion),
    version: '',
    releaseDate: '',
    releaseNotes: '',
    sizeBytes: 0,
    percent: 0,
    transferred: 0,
    total: 0,
    speed: 0,
    lastCheckedAt: Number.isFinite(parsedCheckAt) && parsedCheckAt > 0 ? new Date(parsedCheckAt).toISOString() : '',
    errorMessage: '',
  };
  let checkPromise = null;
  let downloadToken = null;
  let cancelRequested = false;
  let lastCheckAt = Number.isFinite(parsedCheckAt) && parsedCheckAt > 0 ? parsedCheckAt : 0;
  let bound = false;
  const listeners = [];

  const nowMs = () => new Date(now()).getTime();
  const nowIso = () => new Date(nowMs()).toISOString();
  const snapshot = () => ({ ...state });
  const publish = (patch) => {
    Object.assign(state, patch);
    emit(snapshot());
    return snapshot();
  };
  const fail = (error, message = '') => {
    const text = asText(message) || asText(error?.message) || '更新操作失败';
    return publish({ status: 'error', errorMessage: text });
  };
  const recordCheck = () => {
    const lastCheckedAt = nowIso();
    lastCheckAt = Date.parse(lastCheckedAt);
    try { onCheckAt(lastCheckedAt); } catch { /* update throttling is best-effort */ }
    publish({ lastCheckedAt });
  };

  function on(event, handler) {
    if (!updater?.on) return;
    updater.on(event, handler);
    listeners.push([event, handler]);
  }

  function bind() {
    if (!enabled || !updater || bound) return;
    bound = true;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    on('checking-for-update', () => publish({ status: 'checking', errorMessage: '' }));
    on('update-available', (info) => publish({
      status: 'available',
      ...updateInfo(info),
      percent: 0,
      transferred: 0,
      total: 0,
      speed: 0,
      errorMessage: '',
    }));
    on('update-not-available', () => publish({
      status: 'not-available',
      version: '',
      releaseDate: '',
      releaseNotes: '',
      sizeBytes: 0,
      percent: 0,
      transferred: 0,
      total: 0,
      speed: 0,
      errorMessage: '',
    }));
    on('download-progress', (info = {}) => publish({
      status: 'downloading',
      percent: Math.min(100, Math.max(0, finiteNumber(info.percent))),
      transferred: Math.max(0, finiteNumber(info.transferred)),
      total: Math.max(0, finiteNumber(info.total)),
      speed: Math.max(0, finiteNumber(info.bytesPerSecond ?? info.speed)),
      errorMessage: '',
    }));
    on('update-downloaded', (info = {}) => publish({
      status: 'downloaded',
      ...updateInfo(info, state),
      percent: 100,
      transferred: Math.max(0, finiteNumber(info.transferred || info.filesize)),
      total: Math.max(0, finiteNumber(info.total || info.filesize)),
      speed: 0,
      errorMessage: '',
    }));
    on('update-cancelled', (info = {}) => publish({
      status: 'available',
      ...updateInfo(info, state),
      percent: 0,
      transferred: 0,
      total: 0,
      speed: 0,
      errorMessage: '下载已取消',
    }));
    on('error', (error, message) => fail(error, message));
  }

  function check({ manual = false } = {}) {
    if (!enabled || !updater?.checkForUpdates) return snapshot();
    if (checkPromise) return checkPromise;
    if (['downloading', 'downloaded', 'installing'].includes(state.status)) return snapshot();
    if (!manual && lastCheckAt && nowMs() - lastCheckAt < intervalMs) return snapshot();
    checkPromise = (async () => {
      publish({ status: 'checking', errorMessage: '' });
      try {
        await updater.checkForUpdates();
        if (state.status === 'available' && state.version && !state.releaseNotes.trim()) {
          const version = state.version;
          try {
            const releaseNotes = await fetchReleaseNotes(version);
            if (state.version === version && releaseNotes) publish({ releaseNotes });
          } catch { /* Release notes must not block downloading an update. */ }
        }
      } catch (error) {
        fail(error);
      } finally {
        recordCheck();
        checkPromise = null;
      }
      return snapshot();
    })();
    return checkPromise;
  }

  async function download() {
    if (!enabled || !updater?.downloadUpdate) return snapshot();
    if (!['available', 'error'].includes(state.status) || !state.version) return snapshot();
    cancelRequested = false;
    downloadToken = createCancellationToken();
    publish({ status: 'downloading', percent: 0, transferred: 0, total: 0, speed: 0, errorMessage: '' });
    try {
      await updater.downloadUpdate(downloadToken || undefined);
    } catch (error) {
      if (!cancelRequested) fail(error);
    } finally {
      downloadToken = null;
      cancelRequested = false;
    }
    return snapshot();
  }

  function cancelDownload() {
    if (!downloadToken) return snapshot();
    cancelRequested = true;
    downloadToken.cancel?.();
    return publish({ status: 'available', percent: 0, transferred: 0, total: 0, speed: 0, errorMessage: '下载已取消' });
  }

  function install() {
    if (!enabled || !updater?.quitAndInstall) return snapshot();
    if (state.status !== 'downloaded') throw new Error('更新尚未下载完成');
    if (isBatchRunning()) throw new Error('批次运行中，完成后可安装更新');
    publish({ status: 'installing', errorMessage: '' });
    try {
      updater.quitAndInstall(false, true);
    } catch (error) {
      fail(error);
      throw error;
    }
    return snapshot();
  }

  function dispose() {
    for (const [event, handler] of listeners.splice(0)) updater?.removeListener?.(event, handler);
    downloadToken?.cancel?.();
    downloadToken = null;
    bound = false;
  }

  bind();
  return { getState: snapshot, check, download, cancelDownload, install, dispose };
}

module.exports = { RELEASE_URL, UPDATE_INTERVAL_MS, createUpdateService };
