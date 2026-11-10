'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdateService } = require('../desktop/update-service');

class FakeUpdater extends EventEmitter {
  constructor() {
    super();
    this.checkCalls = 0;
    this.downloadCalls = 0;
    this.installCalls = 0;
    this.downloadPromise = null;
  }

  async checkForUpdates() {
    this.checkCalls += 1;
    this.emit('checking-for-update');
    await new Promise((resolve) => setImmediate(resolve));
    this.emit('update-available', {
      version: '0.2.14',
      releaseDate: '2026-11-10T00:00:00.000Z',
      releaseNotes: [{ note: '更新了自动更新' }],
      files: [{ size: 674279646 }],
    });
  }

  downloadUpdate(token) {
    this.downloadCalls += 1;
    this.downloadToken = token;
    this.emit('download-progress', { percent: 25, transferred: 10, total: 40, bytesPerSecond: 5 });
    return this.downloadPromise || Promise.resolve().then(() => {
      this.emit('update-downloaded', { version: '0.2.14', releaseNotes: '完成' });
    });
  }

  quitAndInstall() {
    this.installCalls += 1;
  }
}

test('update service maps updater events to a fixed serializable state', async () => {
  const updater = new FakeUpdater();
  const events = [];
  const service = createUpdateService({ updater, currentVersion: '0.2.13', emit: (state) => events.push(state) });

  await service.check({ manual: true });
  assert.equal(updater.checkCalls, 1);
  assert.equal(service.getState().status, 'available');
  assert.deepEqual({
    currentVersion: service.getState().currentVersion,
    version: service.getState().version,
    releaseDate: service.getState().releaseDate,
    releaseNotes: service.getState().releaseNotes,
    sizeBytes: service.getState().sizeBytes,
    enabled: service.getState().enabled,
  }, {
    currentVersion: '0.2.13',
    version: '0.2.14',
    releaseDate: '2026-11-10T00:00:00.000Z',
    releaseNotes: '更新了自动更新',
    sizeBytes: 674279646,
    enabled: true,
  });

  await service.download();
  assert.equal(updater.downloadCalls, 1);
  assert.equal(service.getState().status, 'downloaded');
  assert.equal(service.getState().percent, 100);
  assert.ok(events.every((state) => Object.keys(state).sort().join(',') === [
    'currentVersion', 'enabled', 'errorMessage', 'lastCheckedAt', 'percent', 'releaseDate', 'releaseNotes', 'sizeBytes', 'speed', 'status', 'total', 'transferred', 'version',
  ].join(',')));
});

test('update service prevents duplicate checks and persists the 24-hour check interval', async () => {
  const updater = new FakeUpdater();
  let persistedCheckAt = '';
  const now = () => new Date('2026-11-10T12:00:00.000Z');
  const service = createUpdateService({ updater, currentVersion: '0.2.13', now, onCheckAt: (value) => { persistedCheckAt = value; } });
  const first = service.check();
  const second = service.check();
  assert.strictEqual(first, second);
  await first;
  await service.check();
  assert.equal(updater.checkCalls, 1);
  assert.equal(persistedCheckAt, '2026-11-10T12:00:00.000Z');
  const restartedService = createUpdateService({ updater: new FakeUpdater(), currentVersion: '0.2.13', now, lastCheckAt: persistedCheckAt });
  await restartedService.check();
  assert.equal(restartedService.getState().lastCheckedAt, persistedCheckAt);
  await restartedService.check({ manual: true });
  assert.equal(restartedService.getState().status, 'available');
});

test('update service reports no-update/errors and cleans up updater listeners', async () => {
  const updater = new FakeUpdater();
  const service = createUpdateService({ updater, currentVersion: '0.2.13' });
  updater.checkForUpdates = async () => updater.emit('update-not-available');
  await service.check({ manual: true });
  assert.equal(service.getState().status, 'not-available');
  assert.ok(service.getState().lastCheckedAt);
  updater.checkForUpdates = async () => { throw new Error('offline'); };
  await service.check({ manual: true });
  assert.equal(service.getState().status, 'error');
  assert.equal(service.getState().errorMessage, 'offline');
  service.dispose();
  for (const event of ['checking-for-update', 'update-available', 'update-not-available', 'download-progress', 'update-downloaded', 'update-cancelled', 'error']) {
    assert.equal(updater.listenerCount(event), 0, event);
  }
});

test('update service refuses install while a batch is running', async () => {
  const updater = new FakeUpdater();
  let running = true;
  const service = createUpdateService({ updater, currentVersion: '0.2.13', isBatchRunning: () => running });
  await service.check({ manual: true });
  await service.download();
  assert.throws(() => service.install(), /批次运行中/);
  running = false;
  service.install();
  assert.equal(updater.installCalls, 1);
  assert.equal(service.getState().status, 'installing');
});

test('update service can cancel a download without leaving the current app unusable', async () => {
  const updater = new FakeUpdater();
  let resolveDownload;
  updater.downloadPromise = new Promise((resolve) => { resolveDownload = resolve; });
  const token = { cancelCalls: 0, cancel() { this.cancelCalls += 1; } };
  const service = createUpdateService({ updater, currentVersion: '0.2.13', createCancellationToken: () => token });
  await service.check({ manual: true });
  const downloading = service.download();
  assert.equal(service.getState().status, 'downloading');
  service.cancelDownload();
  assert.equal(token.cancelCalls, 1);
  assert.equal(service.getState().status, 'available');
  resolveDownload();
  await downloading;
  assert.equal(service.getState().status, 'available');
});

test('disabled update service never calls updater', async () => {
  const updater = new FakeUpdater();
  const service = createUpdateService({ updater, enabled: false, currentVersion: '0.2.13' });
  await service.check({ manual: true });
  await service.download();
  assert.equal(updater.checkCalls, 0);
  assert.equal(updater.downloadCalls, 0);
  assert.equal(service.getState().status, 'idle');
});
