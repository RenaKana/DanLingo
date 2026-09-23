import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { LocalController } from '../../src/local/controller.ts';
import { DirectoryScanManager } from '../../src/local/directory-manager.ts';
import { LocalIdleUnloader, LOCAL_IDLE_TIMEOUT_MS } from '../../src/local/idle-unload.ts';
import { LOCAL_CHANNEL, localError } from '../../src/local/types.ts';
import { translationCacheKey } from '../../src/translation/cache.ts';
import { DEFAULT_SETTINGS } from '../../src/core/config.ts';

const compiled = ts.transpileModule(readFileSync(new URL('../../entrypoints/offscreen/main.ts', import.meta.url), 'utf8')
  .replaceAll('import.meta.url', JSON.stringify('https://extension.invalid/offscreen.js')),
{ compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  let listener;
  const h = { workers: [], events: [], models: [{ id: 'old', availability: 'ready' }], validations: [], directories: [{ id: 'folder' }], now: 0, timers: new Map(), idleAllowed: true };
  let timerSequence = 0;
  class IdleUnloader extends LocalIdleUnloader {
    constructor(options) { super({ ...options, now: () => h.now,
      schedule: (callback, delay) => { const id = ++timerSequence; h.timers.set(id, { callback, due: h.now + delay }); return id; },
      cancel: id => h.timers.delete(id) }); }
  }
  class Worker {
    onmessage = null; onerror = null; messages = []; terminated = false;
    constructor(url) { this.scanner = url.pathname.includes('directory.worker'); h.workers.push(this); }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
    reply(message) { this.onmessage?.({ data: message }); }
  }
  const storage = {
    listModels: async () => structuredClone(h.models), listDirectories: async () => structuredClone(h.directories),
    validateModelSource: async id => { h.validations.push(id); await h.validate?.(id); },
    removeDirectory: async id => { h.removed = id; h.models = []; h.directories = []; return ['old']; },
    deleteModel: async () => { throw new Error('unexpected legacy delete'); },
  };
  const dependencies = {
    'wxt/browser': { browser: { runtime: { id: 'unit-extension', onMessage: { addListener: fn => { listener = fn; } }, sendMessage: async message => {
      if (message.type === 'local-idle-check') return { ok: true, idle: h.idleAllowed };
      h.events.push(structuredClone(message));
    } } } },
    '../../src/local/controller': { LocalController }, '../../src/local/storage': storage,
    '../../src/local/types': { LOCAL_CHANNEL, localError }, '../../src/local/directory-manager': { DirectoryScanManager },
    '../../src/local/idle-unload': { LocalIdleUnloader: IdleUnloader },
    '../../src/local/file-registration-client': { refreshFileReferencesInWorker: async () => [] },
    '../../src/local/benchmark-runner': { LocalBenchmarkRunner: class { isRunning() { return false; } } },
  };
  runInNewContext(compiled, { exports: {}, Error, URL, Worker, structuredClone, crypto, performance,
    require: key => { assert.ok(key in dependencies, key); return dependencies[key]; } });
  h.send = control => new Promise(resolve => listener({ channel: LOCAL_CHANNEL, ...control }, { id: 'unit-extension' }, resolve));
  h.advance = async ms => { h.now += ms; for (const [id, timer] of [...h.timers]) if (timer.due <= h.now) { h.timers.delete(id); timer.callback(); } await flush(); };
  h.load = async () => {
    const loading = h.send({ action: 'load', modelId: 'old', policyRevision: 1 }); await flush();
    const worker = h.workers.at(-1), id = worker.messages[0].id;
    worker.reply({ id, ok: true, model: { id: 'old', name: 'old' } });
    assert.equal((await loading).ok, true); return worker;
  };
  return h;
}

test('manual load validates source in the existing inference worker before reusing it', async () => {
  const h = harness(), worker = await h.load();
  const loading = h.send({ action: 'load', modelId: 'old', policyRevision: 2 }); await flush();
  const validation = worker.messages.at(-1);
  assert.equal(validation.action, 'validate-source'); assert.equal(validation.modelId, 'old');
  h.models[0].availability = 'changed';
  worker.reply({ id: validation.id, ok: false, error: 'LOCAL_SOURCE_CHANGED' });
  const reply = await loading;
  assert.equal(reply.ok, false); assert.equal(reply.error, 'LOCAL_SOURCE_CHANGED');
  assert.equal(reply.state.phase, 'idle'); assert.equal(worker.terminated, true);
  assert.deepEqual(h.validations, []);
  assert.deepEqual(h.events, [{ type: 'local-sources-updated' }]);
});

test('a manual load interrupted by a newer unload policy cannot revive the worker', async () => {
  const h = harness();
  const loading = h.send({ action: 'load', modelId: 'old', policyRevision: 1 }); await flush();
  const worker = h.workers[0];
  assert.equal(worker.messages[0].action, 'load');
  worker.reply({ id: worker.messages[0].id, stage: 'fingerprinting', verificationProgress: { bytesProcessed: 4, totalBytes: 12 } });
  const progress = (await h.send({ action: 'state' })).state;
  assert.deepEqual(progress.verificationProgress, { bytesProcessed: 4, totalBytes: 12 });
  const unloaded = await h.send({ action: 'unload', policyRevision: 2 });
  assert.equal(unloaded.state.phase, 'idle'); assert.equal(unloaded.state.verificationProgress, undefined);
  assert.equal((await loading).error, 'LOCAL_MODEL_CHANGED'); assert.equal(worker.terminated, true);
});

test('unchanged directory scan leaves the loaded runtime and its generation intact', async () => {
  const h = harness(), inference = await h.load(), before = (await h.send({ action: 'state' })).state;
  const scanning = h.send({ action: 'directory-scan', directoryId: 'folder' }); await flush();
  const scanner = h.workers.at(-1);
  scanner.reply({ requestId: scanner.messages[0].requestId, ok: true,
    result: { invalidatedIds: [], status: { phase: 'complete', directoryId: 'folder', checkedFiles: 1, modelsFound: 1, elapsedMs: 1, issues: [] } } });
  assert.equal((await scanning).ok, true);
  const after = (await h.send({ action: 'state' })).state;
  assert.equal(inference.terminated, false); assert.equal(after.phase, 'ready'); assert.equal(after.generation, before.generation);
  assert.equal(h.workers.filter(worker => !worker.scanner).length, 1);
});

test('removing a source unloads its runtime, rejects active work, and ignores late native results', async () => {
  const h = harness(), inference = await h.load();
  const completion = h.send({ action: 'complete', id: 'request-one', modelId: 'old', body: {} }); await flush();
  const removed = await h.send({ action: 'directory-remove', directoryId: 'folder' });
  assert.equal(removed.ok, true); assert.equal(removed.state.phase, 'idle'); assert.equal(h.removed, 'folder');
  assert.equal((await completion).error, 'LOCAL_MODEL_CHANGED'); assert.equal(inference.terminated, true);
  inference.reply({ id: 'request-one', ok: true, result: { text: 'late' } });
  assert.equal((await h.send({ action: 'state' })).state.phase, 'idle');
});

for (const code of ['LOCAL_SOURCE_MISSING', 'LOCAL_MODEL_NOT_IMPORTED']) test(`cold load ${code} reconciles the selected source before returning`, async () => {
  const h = harness(), loading = h.send({ action: 'ensure', modelId: 'old', policyRevision: 1 });
  await flush(); const worker = h.workers[0]; h.models[0].availability = 'missing';
  if (code === 'LOCAL_MODEL_NOT_IMPORTED') h.models = [];
  worker.reply({ id: worker.messages[0].id, ok: false, error: code });
  assert.equal((await loading).error, code);
  assert.deepEqual(h.events, [{ type: 'local-sources-updated' }]);
  assert.equal((await h.send({ action: 'state' })).state.phase, 'idle');
});

test('a replacement snapshot identity cannot hit a previous snapshot translation cache', () => {
  const settings = { ...DEFAULT_SETTINGS, backend: 'local', localModelId: 'snapshot-one' };
  assert.notEqual(translationCacheKey('room', 'same input', settings),
    translationCacheKey('room', 'same input', { ...settings, localModelId: 'snapshot-two' }));
});

test('offscreen idle timer terminates the model despite status polling and permits the next demand to load', async () => {
  const h = harness(), worker = await h.load();
  await h.advance(LOCAL_IDLE_TIMEOUT_MS - 1);
  assert.equal((await h.send({ action: 'state' })).state.phase, 'ready');
  await h.advance(1);
  assert.equal(worker.terminated, true); assert.equal((await h.send({ action: 'list' })).state.phase, 'idle');
  assert.equal(h.models[0].id, 'old'); assert.deepEqual(h.events, [{ type: 'local-idle-unloaded' }]);
  const reload = h.send({ action: 'ensure', modelId: 'old', policyRevision: 1 }); await flush();
  const next = h.workers.at(-1); next.reply({ id: next.messages[0].id, ok: true, model: { id: 'old' } });
  assert.equal((await reload).state.phase, 'ready'); assert.notEqual(next, worker);
});

test('offscreen retains active generation, resets the idle window after completion, and respects queued background work', async () => {
  const h = harness(), worker = await h.load();
  const completion = h.send({ action: 'complete', id: 'active', modelId: 'old', body: {} }); await flush();
  await h.advance(LOCAL_IDLE_TIMEOUT_MS * 2); assert.equal(worker.terminated, false);
  worker.reply({ id: 'active', ok: true, result: 'translated' }); assert.equal((await completion).ok, true);
  h.idleAllowed = false; await h.advance(LOCAL_IDLE_TIMEOUT_MS); assert.equal(worker.terminated, false);
  h.idleAllowed = true; await h.advance(LOCAL_IDLE_TIMEOUT_MS - 1); assert.equal(worker.terminated, false);
  await h.advance(1); assert.equal(worker.terminated, true);
});

test('real demand at the idle boundary reserves a full window but ordinary reads do not', async () => {
  const h = harness(), worker = await h.load(); await h.advance(LOCAL_IDLE_TIMEOUT_MS - 1);
  assert.equal((await h.send({ action: 'state', demand: true })).state.phase, 'ready');
  await h.advance(1); assert.equal(worker.terminated, false);
  await h.advance(LOCAL_IDLE_TIMEOUT_MS - 1); assert.equal(worker.terminated, true);
});
