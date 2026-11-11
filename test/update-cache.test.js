'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  CLEANUP_DELAY_MS,
  UPDATER_CACHE_DIR_NAME,
  cleanupPendingUpdate,
  getUpdaterCacheDir,
  schedulePendingUpdateCleanup,
} = require('../desktop/update-cache');

test('schedules cleanup only after an updated launch', async () => {
  let scheduled;
  let cleanupArgs;
  const schedule = (callback, delay) => {
    scheduled = { callback, delay };
    return { unref() {} };
  };

  assert.equal(schedulePendingUpdateCleanup({
    argv: ['app.exe', '--updated'],
    localAppData: 'C:\\Users\\test\\AppData\\Local',
    schedule,
    cleanup: async (args) => { cleanupArgs = args; },
  }), true);
  assert.equal(scheduled.delay, CLEANUP_DELAY_MS);
  await scheduled.callback();
  assert.equal(cleanupArgs.cacheDir, path.join('C:\\Users\\test\\AppData\\Local', UPDATER_CACHE_DIR_NAME));

  assert.equal(schedulePendingUpdateCleanup({ argv: ['app.exe'], schedule }), false);
});

test('removes only the pending update directory and preserves updater root files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bgm-update-cache-'));
  const cacheDir = getUpdaterCacheDir(root, root);
  const pendingDir = path.join(cacheDir, 'pending');
  const installer = path.join(cacheDir, 'installer.exe');
  const blockmap = path.join(cacheDir, 'current.blockmap');

  try {
    await fs.mkdir(pendingDir, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(pendingDir, 'downloaded-installer.exe'), 'temporary'),
      fs.writeFile(installer, 'keep'),
      fs.writeFile(blockmap, 'keep'),
    ]);

    assert.equal(await cleanupPendingUpdate({ cacheDir }), true);
    await assert.rejects(fs.access(pendingDir));
    await assert.doesNotReject(fs.access(installer));
    await assert.doesNotReject(fs.access(blockmap));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('retries cleanup when the pending directory is temporarily unavailable', async () => {
  let attempts = 0;
  const waits = [];
  const result = await cleanupPendingUpdate({
    cacheDir: 'C:\\cache',
    remove: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('file is locked');
    },
    waitForRetry: async (delay) => waits.push(delay),
    retryDelayMs: 17,
    logger: { warn() {} },
  });

  assert.equal(result, true);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [17, 17]);
});
