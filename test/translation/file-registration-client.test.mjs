import test from 'node:test';
import assert from 'node:assert/strict';
import { registerModelFilesInWorker, refreshFileReferencesInWorker } from '../../src/local/file-registration-client.ts';

class FakeWorker {
  static instances = [];
  onmessage = null;
  onerror = null;
  messages = [];
  terminated = false;
  constructor(url, options) { this.url = url; this.options = options; FakeWorker.instances.push(this); }
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  reply(data) { this.onmessage?.({ data }); }
}

test('file registration client forwards worker progress and returns only the matching result', async () => {
  const previous = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  FakeWorker.instances = [];
  try {
    const handles = [{ kind: 'file', name: 'model.gguf' }];
    const progress = [];
    const resultPromise = registerModelFilesInWorker(handles, 'existing-model', { onProgress: value => progress.push(value) });
    const worker = FakeWorker.instances[0];
    const request = worker.messages[0];
    assert.equal(request.action, 'register');
    assert.equal(request.expectedId, 'existing-model');
    assert.equal(request.handles, handles);
    worker.reply({ requestId: 'other-request', progress: { phase: 'scanning' } });
    worker.reply({ requestId: request.requestId, progress: { phase: 'scanning', stage: 'fingerprinting', fingerprintedBytes: 4 } });
    const result = { models: [{ id: 'new-model' }], issues: [] };
    worker.reply({ requestId: request.requestId, ok: true, result });
    assert.equal(await resultPromise, result);
    assert.deepEqual(progress, [{ phase: 'scanning', stage: 'fingerprinting', fingerprintedBytes: 4 }]);
    assert.equal(worker.options.type, 'module');
    assert.equal(worker.terminated, true);
  } finally { globalThis.Worker = previous; }
});

test('aborting refresh asks its worker to stop and rejects with the cancellation code', async () => {
  const previous = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  FakeWorker.instances = [];
  try {
    const abort = new AbortController();
    const refresh = refreshFileReferencesInWorker({ signal: abort.signal });
    const worker = FakeWorker.instances[0], request = worker.messages[0];
    assert.equal(request.action, 'refresh');
    const rejected = assert.rejects(refresh, /LOCAL_SCAN_CANCELLED/);
    abort.abort();
    assert.deepEqual(worker.messages[1], { requestId: request.requestId, cancel: true });
    worker.reply({ requestId: request.requestId, ok: false, error: 'LOCAL_SCAN_CANCELLED' });
    await rejected;
    assert.equal(worker.terminated, true);
  } finally { globalThis.Worker = previous; }
});
