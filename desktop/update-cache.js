'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const UPDATER_CACHE_DIR_NAME = 'short-drama-bgm-mvp-updater';
const CLEANUP_DELAY_MS = 8_000;
const CLEANUP_RETRY_DELAY_MS = 2_000;
const CLEANUP_RETRIES = 5;

function getUpdaterCacheDir(localAppData = process.env.LOCALAPPDATA, homeDir = os.homedir()) {
  const base = typeof localAppData === 'string' && localAppData.trim()
    ? localAppData
    : path.join(homeDir, 'AppData', 'Local');
  return path.join(base, UPDATER_CACHE_DIR_NAME);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupPendingUpdate({
  cacheDir,
  remove = fs.rm,
  waitForRetry = wait,
  retries = CLEANUP_RETRIES,
  retryDelayMs = CLEANUP_RETRY_DELAY_MS,
  logger = console,
} = {}) {
  if (typeof cacheDir !== 'string' || !cacheDir) return false;
  const pendingDir = path.join(cacheDir, 'pending');
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await remove(pendingDir, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (attempt === retries) {
        logger.warn?.(`无法清理更新临时包：${error?.message || error}`);
        return false;
      }
      await waitForRetry(retryDelayMs);
    }
  }
  return false;
}

function schedulePendingUpdateCleanup({
  argv = process.argv,
  localAppData = process.env.LOCALAPPDATA,
  homeDir = os.homedir(),
  schedule = setTimeout,
  cleanup = cleanupPendingUpdate,
  delayMs = CLEANUP_DELAY_MS,
  logger = console,
} = {}) {
  if (!Array.isArray(argv) || !argv.includes('--updated')) return false;
  const cacheDir = getUpdaterCacheDir(localAppData, homeDir);
  const timer = schedule(() => cleanup({ cacheDir, logger }).catch((error) => {
    logger.warn?.(`清理更新临时包时发生异常：${error?.message || error}`);
  }), delayMs);
  timer?.unref?.();
  return true;
}

module.exports = {
  CLEANUP_DELAY_MS,
  CLEANUP_RETRIES,
  CLEANUP_RETRY_DELAY_MS,
  UPDATER_CACHE_DIR_NAME,
  cleanupPendingUpdate,
  getUpdaterCacheDir,
  schedulePendingUpdateCleanup,
};
