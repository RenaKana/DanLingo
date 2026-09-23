import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectoryScanManager } from '../../src/local/directory-manager.ts';

const flush = () => new Promise(resolve => setImmediate(resolve));
const result = (id, phase = 'complete', extra = {}) => ({
  invalidatedIds: phase === 'complete' ? [`old-${id}`] : [],
  status: { phase, directoryId: id, checkedFiles: 1, modelsFound: 1, elapsedMs: 1, issues: [], ...extra },
});

function workerHarness() {
  const workers = [];
  const createWorker = () => {
    const worker = { messages: [], terminated: false, onmessage: null, onerror: null,
      postMessage(message) { this.messages.push(message); },
      terminate() { this.terminated = true; },
      message(message) { this.onmessage?.({ data: message }); },
      error(error = new Error('worker failed')) { this.onerror?.(error); },
    };
    workers.push(worker); return worker;
  };
  return { workers, createWorker };
}

test('coalesces same-directory scans and serializes different directories until reconciliation settles', async () => {
  const harness = workerHarness(), changed = [], releaseChanged = [];
  const manager = new DirectoryScanManager(harness.createWorker, async value => {
    changed.push(value.status.directoryId);
    await new Promise(resolve => releaseChanged.push(resolve));
  });

  const first = manager.scan('same');
  const coalesced = manager.scan('same');
  assert.strictEqual(coalesced, first, 'same directory shares one promise');
  const second = manager.scan('next');
  await flush();
  assert.equal(harness.workers.length, 1);
  assert.deepEqual(harness.workers[0].messages, [{ requestId: harness.workers[0].messages[0].requestId, directoryId: 'same' }]);

  const requestId = harness.workers[0].messages[0].requestId;
  harness.workers[0].message({ requestId, ok: true, result: result('same') });
  await flush();
  assert.deepEqual(changed, ['same']);
  assert.equal(harness.workers.length, 1, 'next scan waits for the reconciliation callback');
  assert.equal(manager.busy(), true);
  releaseChanged.shift()();
  const firstResult = await first;
  assert.equal(firstResult.status.phase, 'complete');
  await flush();
  assert.equal(harness.workers.length, 2);
  assert.equal(harness.workers[1].messages[0].directoryId, 'next');
  const nextRequestId = harness.workers[1].messages[0].requestId;
  harness.workers[1].message({ requestId: nextRequestId, ok: true, result: result('next') });
  await flush();
  releaseChanged.shift()();
  const secondResult = await second;
  assert.equal(secondResult.status.directoryId, 'next');
  assert.deepEqual(changed, ['same', 'next']);
  assert.equal(manager.busy(), false);
});

test('cancelling queued work resolves it without changing the previous directory index', async () => {
  const harness = workerHarness(), changed = [];
  const manager = new DirectoryScanManager(harness.createWorker, async value => { changed.push(value); });
  const active = manager.scan('active');
  const queued = manager.scan('queued');
  await flush();
  manager.cancel('queued');
  const queuedResult = await queued;
  assert.equal(queuedResult.status.phase, 'cancelled');
  assert.equal(queuedResult.status.directoryId, 'queued');
  assert.deepEqual(queuedResult.invalidatedIds, []);
  assert.deepEqual(changed, [], 'queued cancellation does not reconcile or invalidate the existing index');
  assert.equal(harness.workers.length, 1);
  const requestId = harness.workers[0].messages[0].requestId;
  harness.workers[0].message({ requestId, ok: true, result: result('active') });
  await active;
  assert.equal(manager.busy(), false);
});

test('cancelling an in-flight scan sends a worker cancel and preserves the prior index', async () => {
  const harness = workerHarness(), changed = [];
  const manager = new DirectoryScanManager(harness.createWorker, async value => { changed.push(value); });
  const pending = manager.scan('cancel-me');
  await flush();
  const worker = harness.workers[0], requestId = worker.messages[0].requestId;
  manager.cancel('cancel-me');
  assert.deepEqual(worker.messages[1], { cancel: true, requestId });
  worker.message({ requestId, ok: false, error: 'LOCAL_SCAN_CANCELLED' });
  const cancelled = await pending;
  assert.equal(cancelled.status.phase, 'cancelled');
  assert.deepEqual(cancelled.invalidatedIds, []);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].status.phase, 'cancelled');
  assert.equal(manager.busy(), false);
});

test('late worker messages and errors after settlement are ignored', async () => {
  const harness = workerHarness(), changed = [];
  const manager = new DirectoryScanManager(harness.createWorker, async value => { changed.push(value); });
  const pending = manager.scan('late');
  await flush();
  const worker = harness.workers[0], requestId = worker.messages[0].requestId;
  worker.message({ requestId, ok: true, result: result('late') });
  const complete = await pending;
  assert.equal(complete.status.phase, 'complete');
  worker.message({ requestId, ok: false, error: 'LOCAL_SCAN_FAILED' });
  worker.error();
  await flush();
  assert.equal(changed.length, 1);
  assert.equal(changed[0].status.phase, 'complete');
  assert.equal(worker.terminated, true);
});

test('worker errors are reconciled before the next queued directory starts', async () => {
  const harness = workerHarness(), changed = [], release = [];
  const manager = new DirectoryScanManager(harness.createWorker, async value => {
    changed.push(value);
    await new Promise(resolve => release.push(resolve));
  });
  const failed = manager.scan('failed');
  const next = manager.scan('after-failure');
  await flush();
  harness.workers[0].error();
  await flush();
  assert.equal(harness.workers.length, 1);
  assert.equal(changed[0].status.phase, 'error');
  assert.equal(changed[0].status.error, 'LOCAL_DIRECTORY_SCAN_FAILED');
  release.shift()();
  const failedResult = await failed;
  assert.equal(failedResult.status.phase, 'error');
  await flush();
  assert.equal(harness.workers.length, 2);
  const requestId = harness.workers[1].messages[0].requestId;
  harness.workers[1].message({ requestId, ok: true, result: result('after-failure') });
  await flush();
  release.shift()();
  await next;
  assert.equal(manager.busy(), false);
});
