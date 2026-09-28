import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings } from '../../src/core/config.ts';
import { liveBufferMs } from '../../src/core/live-budget.ts';
import { getTimeoutRetryPolicy } from '../../src/core/timeout-retry.ts';
import { OnlineRequestBudget } from '../../src/core/online-budget.ts';

test('legacy concurrency migrates to two saved limits and backend switches select the corresponding limit', () => {
  const legacy = normalizeSettings({ concurrency: 6 });
  assert.equal(legacy.onlineConcurrency, 6);
  assert.equal(legacy.localConcurrency, 6);
  const online = normalizeSettings({ ...legacy, onlineConcurrency: 8, localConcurrency: 3 });
  assert.equal(online.concurrency, 8);
  const local = normalizeSettings({ ...online, backend: 'local' });
  assert.equal(local.concurrency, 3);
  assert.equal(local.onlineConcurrency, 8);
  assert.equal(normalizeSettings({ ...local, backend: 'online' }).concurrency, 8);
  const largeLocal = normalizeSettings({ backend: 'local', concurrency: 100 });
  assert.equal(largeLocal.localConcurrency, 100);
  assert.equal(largeLocal.onlineConcurrency, 64);
});

test('new defaults preserve explicit saved waits, limits and idle policy', () => {
  const defaults = normalizeSettings({});
  assert.equal(defaults.translationScope, 'auto');
  assert.equal(defaults.prefetchSeconds, 60);
  assert.equal(defaults.videoBatchSize, 20);
  assert.equal(defaults.onlineRequestLimitPerDay, 0);
  assert.equal(defaults.localIdleUnloadEnabled, true);
  assert.equal(defaults.localIdleUnloadMinutes, 5);
  assert.equal(defaults.liveBufferMs, 3000);
  assert.equal(liveBufferMs(undefined), 3000);
  for (const platform of ['bilibili', 'youtube', 'niconico']) {
    assert.equal(defaults[`${platform}TimeoutRetryEnabled`], false);
    assert.equal(getTimeoutRetryPolicy({ [`${platform}TimeoutRetryEnabled`]: true }, platform).timeoutMs, 4000);
    assert.equal(getTimeoutRetryPolicy({ ...defaults, [`${platform}TimeoutRetryEnabled`]: true }, platform).timeoutMs, 4000);
  }
  const saved = normalizeSettings({ liveBufferMs: 2000, onlineRequestLimitPerDay: 3000, localIdleUnloadEnabled: false, localIdleUnloadMinutes: 15 });
  assert.equal(saved.liveBufferMs, 2000);
  assert.equal(saved.onlineRequestLimitPerDay, 3000);
  assert.equal(saved.localIdleUnloadEnabled, false);
  assert.equal(saved.localIdleUnloadMinutes, 15);
});

test('an unlimited online budget admits requests even if usage storage is unavailable, and still respects cancellation', async () => {
  const budget = new OnlineRequestBudget({ indexedDB: { open() { throw new Error('fixture storage unavailable'); } } });
  for (let i = 0; i < 3; i++) {
    const state = await budget.reserve(0);
    assert.equal(state.status, 'available');
    assert.equal(state.limit, 0);
    assert.equal(state.remaining, null);
  }
  assert.equal((await budget.read(0)).status, 'available');
  await assert.rejects(budget.reserve(0, AbortSignal.abort()), /cancelled/);
  await assert.rejects(budget.reserve(1), /online-budget-storage-unavailable/);
});
