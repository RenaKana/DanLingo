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
import { DEFAULT_SETTINGS, normalizeSettings } from '../../src/core/config.ts';

const compiled = ts.transpileModule(readFileSync(new URL('../../entrypoints/offscreen/main.ts', import.meta.url), 'utf8')
  .replaceAll('import.meta.url', JSON.stringify('https://extension.invalid/offscreen.js')),
{ compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const flush = () => new Promise(resolve => setImmediate(resolve));
const policyReply = settings => ({ ok: true, policy: { enabled: settings.localIdleUnloadEnabled, timeoutMs: settings.localIdleUnloadMinutes * 60_000 } });
function harness({ deferSettingsRead = false, settingsReadFails = false, settings = DEFAULT_SETTINGS } = {}) {
  let listener;
  let resolveInitialSettings;
  const initialSettings = structuredClone(settings);
  const initialRead = deferSettingsRead
    ? new Promise(resolve => { resolveInitialSettings = resolve; })
    : Promise.resolve(policyReply(initialSettings));
  const h = { workers: [], events: [], models: [{ id: 'old', availability: 'ready' }], validations: [], directories: [{ id: 'folder' }], now: 0, timers: new Map(), idleAllowed: true,
    storedSettings: structuredClone(settings), policyReads: 0 };
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
    resolveModelFiles: async id => { h.validations.push(id); await h.validate?.(id);
      return { info: { id, name: 'fixture.gguf' }, files: [new File(['fixture'], 'fixture.gguf')], timings: { sourceMs: 3, metadataMs: 0 } }; },
    removeDirectory: async id => { h.removed = id; h.models = []; h.directories = []; return ['old']; },
    deleteModel: async () => { throw new Error('unexpected legacy delete'); },
  };
  const dependencies = {
    'wxt/browser': { browser: {
      // Chromium offscreen documents expose runtime only, even with storage permission.
      runtime: { id: 'unit-extension', onMessage: { addListener: fn => { listener = fn; } }, sendMessage: async message => {
        if (message.type === 'local-idle-policy-get') {
          h.policyReads++;
          if (settingsReadFails) throw new Error('background unavailable');
          return initialRead;
        }
        if (message.type === 'local-idle-check') return { ok: true, idle: h.idleAllowed };
        h.events.push(structuredClone(message));
      } },
    } },
    '../../src/local/controller': { LocalController }, '../../src/local/storage': storage,
    '../../src/local/types': { LOCAL_CHANNEL, localError }, '../../src/local/directory-manager': { DirectoryScanManager },
    '../../src/local/idle-unload': { LocalIdleUnloader: IdleUnloader },
    '../../src/local/file-registration-client': { refreshFileReferencesInWorker: async options => h.refresh ? h.refresh(options) : [] },
    '../../src/local/benchmark-runner': { LocalBenchmarkRunner: class { isRunning() { return false; } } },
  };
  runInNewContext(compiled, { exports: {}, Error, URL, Worker, structuredClone, crypto, performance, AbortController,
    require: key => { assert.ok(key in dependencies, key); return dependencies[key]; } });
  h.settingsRead = async () => { await initialRead; await flush(); };
  h.resolveSettingsRead = () => resolveInitialSettings?.(policyReply(initialSettings));
  h.changeSettings = updates => {
    h.storedSettings = structuredClone({ ...h.storedSettings, ...updates });
    return h.send({ action: 'idle-policy', policy: policyReply(h.storedSettings).policy });
  };
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

test('manual load validates source even if an existing native instance could be reused', async () => {
  const h = harness(), worker = await h.load();
  h.validate = async () => { h.models[0].availability = 'changed'; throw new Error('LOCAL_SOURCE_CHANGED'); };
  const reply = await h.send({ action: 'load', modelId: 'old', policyRevision: 2 });
  assert.equal(reply.ok, false); assert.equal(reply.error, 'LOCAL_SOURCE_CHANGED');
  assert.equal(reply.state.phase, 'idle'); assert.equal(worker.terminated, true);
  assert.deepEqual(h.validations, ['old', 'old']);
  assert.deepEqual(h.events, [{ type: 'local-sources-updated' }]);
});

test('cold load prepares the source once and sends File objects only to its inference worker', async () => {
  const h = harness(), worker = await h.load();
  assert.deepEqual(h.validations, ['old']);
  const message = worker.messages[0];
  assert.equal(message.prepared.info.id, 'old');
  assert.equal(message.prepared.files[0] instanceof File, true);
  assert.equal(await message.prepared.files[0].text(), 'fixture');
  for (let i = 0; i < 3; i++) assert.equal((await h.send({ action: 'ensure', modelId: 'old', policyRevision: 1 })).ok, true);
  assert.deepEqual(h.validations, ['old'], 'ready automatic requests must not reacquire sources');
  assert.equal(h.workers.length, 1);
  const state = (await h.send({ action: 'state' })).state;
  assert.equal(state.loadTimings.metadataMs, 0);
  assert.equal(JSON.stringify(state).includes('prepared'), false);
});

test('registration confirmation checks persisted sources without loading GPU or returning File objects', async () => {
  const h = harness();
  h.validate = async id => { if (id === 'denied') throw new Error('LOCAL_DIRECTORY_PERMISSION_REQUIRED'); };
  const reply = await h.send({ action: 'files-changed', modelIds: ['old', 'denied'] });
  assert.equal(reply.ok, true);
  assert.deepEqual(h.validations, ['old', 'denied']);
  assert.equal(reply.issues[0].modelId, 'denied');
  assert.equal(reply.issues[0].error, 'LOCAL_DIRECTORY_PERMISSION_REQUIRED');
  assert.equal(h.workers.length, 0);
  assert.equal(reply.prepared, undefined); assert.equal(reply.files, undefined);
});

test('two cold callers share one pending source preparation', async () => {
  const h = harness(); let release;
  h.validate = () => new Promise(resolve => { release = resolve; });
  const first = h.send({ action: 'ensure', modelId: 'old', policyRevision: 1 });
  const second = h.send({ action: 'load', modelId: 'old', policyRevision: 1 });
  await flush(); assert.deepEqual(h.validations, ['old']); assert.equal(h.workers.length, 0);
  release(); await flush();
  const worker = h.workers[0];
  worker.reply({ id: worker.messages[0].id, ok: true, model: { id: 'old' } });
  assert.equal((await first).ok, true); assert.equal((await second).ok, true);
  assert.equal(h.workers.length, 1);
});

test('a synchronous worker creation failure does not pin a rejected load promise', async () => {
  let attempts = 0;
  const worker = { postMessage(message) { this.message = message; }, terminate() {}, onmessage: null, onerror: null };
  const controller = new LocalController(() => { if (++attempts === 1) throw new Error('LOCAL_WORKER_FAILED'); return worker; });
  await assert.rejects(controller.load('retry'), /LOCAL_WORKER_FAILED/);
  const loading = controller.load('retry');
  worker.onmessage({ data: { id: worker.message.id, ok: true, model: { id: 'retry' } } });
  assert.equal((await loading).phase, 'ready'); assert.equal(attempts, 2);
});

test('a delayed manual source check cannot load after a newer unload policy', async () => {
  const h = harness(); let release;
  h.validate = () => new Promise(resolve => { release = resolve; });
  const loading = h.send({ action: 'load', modelId: 'old', policyRevision: 1 }); await flush();
  assert.equal((await h.send({ action: 'unload', policyRevision: 2 })).state.phase, 'idle');
  release(); assert.equal((await loading).error, 'LOCAL_MODEL_CHANGED'); assert.equal(h.workers.length, 0);
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

for (const withFiles of [false, true]) test(`global refresh retains folder counts and timings with file references=${withFiles}`, async () => {
  const h = harness();
  if (withFiles) h.refresh = async options => {
    options.onProgress({ phase: 'scanning', checkedFiles: 2, modelsFound: 1, elapsedMs: 1, issues: [],
      timings: { enumerationMs: 1, fileAccessMs: 2, headerMs: 0, registrationMs: 3 } });
    return [];
  };
  const scanning = h.send({ action: 'directory-scan' }); await flush();
  const scanner = h.workers[0];
  scanner.reply({ requestId: scanner.messages[0].requestId, ok: true, result: { invalidatedIds: [],
    status: { phase: 'complete', directoryId: 'folder', checkedFiles: 3, modelsFound: 3, elapsedMs: 10, issues: [],
      timings: { enumerationMs: 2, fileAccessMs: 3, headerMs: 4, registrationMs: 1 } } } });
  const reply = await scanning;
  assert.equal(reply.ok, true); assert.equal(reply.scan.phase, 'complete');
  assert.equal(reply.scan.checkedFiles, withFiles ? 5 : 3); assert.equal(reply.scan.modelsFound, withFiles ? 4 : 3);
  assert.equal(reply.scan.timings.headerMs, 4); assert.equal(reply.scan.timings.registrationMs, withFiles ? 4 : 1);
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

test('saved idle-unload settings disable unloading and apply the custom timeout when re-enabled', async () => {
  const h = harness(); await h.settingsRead();
  assert.equal(h.policyReads, 1);
  const worker = await h.load();

  h.changeSettings({ localIdleUnloadEnabled: false });
  await h.advance(LOCAL_IDLE_TIMEOUT_MS * 2);
  assert.equal(worker.terminated, false);
  assert.equal((await h.send({ action: 'state' })).state.phase, 'ready');

  h.changeSettings({ localIdleUnloadEnabled: true, localIdleUnloadMinutes: 1 });
  await h.advance(60_000 - 1);
  assert.equal(worker.terminated, false);
  await h.advance(1);
  assert.equal(worker.terminated, true);
  assert.deepEqual(h.events, [{ type: 'local-idle-unloaded' }]);
});

for (const enabled of [false, true]) test(`offscreen startup applies saved custom idle policy, enabled=${enabled}`, async () => {
  const h = harness({ settings: { ...DEFAULT_SETTINGS, localIdleUnloadEnabled: enabled, localIdleUnloadMinutes: 2 } });
  const worker = await h.load();
  await h.advance(119_999); assert.equal(worker.terminated, false);
  await h.advance(1); assert.equal(worker.terminated, enabled);
});

test('a policy message received during the initial background read wins over its stale result', async () => {
  const initial = normalizeSettings({ ...DEFAULT_SETTINGS, localIdleUnloadEnabled: true, localIdleUnloadMinutes: 1 });
  const h = harness({ deferSettingsRead: true, settings: initial });
  const worker = await h.load();

  h.changeSettings({ localIdleUnloadEnabled: false, localIdleUnloadMinutes: 1 });
  h.resolveSettingsRead();
  await h.settingsRead();
  assert.equal(h.policyReads, 1);

  await h.advance(60_000);
  assert.equal(worker.terminated, false);
  assert.equal((await h.send({ action: 'state' })).state.phase, 'ready');
  assert.deepEqual(h.events, []);
});

test('unavailable idle preferences do not prevent offscreen file confirmation or folder scans', async () => {
  const h = harness({ settingsReadFails: true });
  const files = await h.send({ action: 'files-changed', modelIds: ['old'] });
  assert.equal(files.ok, true); assert.deepEqual(Array.from(files.issues), []);
  assert.deepEqual(h.validations, ['old']);
  const scanning = h.send({ action: 'directory-scan', directoryId: 'folder' }); await flush();
  const scanner = h.workers[0];
  scanner.reply({ requestId: scanner.messages[0].requestId, ok: true, result: { invalidatedIds: [],
    status: { phase: 'complete', directoryId: 'folder', checkedFiles: 1, modelsFound: 1, elapsedMs: 1, issues: [] } } });
  assert.equal((await scanning).ok, true);
  const worker = await h.load();
  await h.advance(LOCAL_IDLE_TIMEOUT_MS * 2);
  assert.equal(worker.terminated, false, 'preferences unavailable must leave automatic unload disabled');
  await h.changeSettings({ localIdleUnloadEnabled: true, localIdleUnloadMinutes: 1 });
  await h.advance(60_000);
  assert.equal(worker.terminated, true, 'later policy delivery restores automatic unload');
});
