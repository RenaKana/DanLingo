import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as config from '../../src/core/config.ts';
import * as messages from '../../src/core/messages.ts';
import * as resource from '../../src/core/resource.ts';
import * as diagnostics from '../../src/core/adapter-diagnostic.ts';
import * as metrics from '../../src/core/live-metrics.ts';
import * as timeoutRetry from '../../src/core/timeout-retry.ts';
import * as biliEmotes from '../../src/platforms/bilibili-live/emotes.ts';
import * as scheduling from '../../src/core/scheduler.ts';
import * as stream from '../../src/core/source-stream.ts';
import { BRIDGE } from '../../src/platforms/niconico/native.ts';
import * as provider from '../../src/translation/provider.ts';
import * as performanceTesting from '../../src/translation/performance-test.ts';
import * as connectionDiscovery from '../../src/translation/connection-discovery.ts';
import { LOCAL_CHANNEL } from '../../src/local/types.ts';
import * as providerSettings from '../../src/local/provider-settings.ts';
import * as translationProfile from '../../src/local/translation-profile.ts';
import * as autoLoad from '../../src/local/auto-load.ts';
import * as modelCatalog from '../../src/core/model-catalog.ts';
import * as serviceHistory from '../../src/core/service-history.ts';
import * as onlineBudget from '../../src/core/online-budget.ts';
import * as translationShortcut from '../../src/core/translation-shortcut.ts';
import * as settingsFrame from '../../src/core/settings-frame.ts';

// Execute the actual entrypoints with browser APIs at their external boundary mocked.
const compiled = new Map(['background', 'watch.content'].map(name => [name, ts.transpileModule(
  readFileSync(new URL(`../../entrypoints/${name}.ts`, import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText]));
function load(name, dependencies, globals = {}) {
  const exports = {};
  runInNewContext(compiled.get(name), { exports, URL, AbortController, performance, crypto, TextEncoder, structuredClone, setTimeout, clearTimeout, setInterval, clearInterval,
    require: key => { if (!(key in dependencies)) throw new Error(`Unexpected import ${key}`); return dependencies[key]; },
    ...globals });
  return exports.default;
}
const url = id => `https://www.nicovideo.jp/watch/${id}`;
const flush = () => new Promise(resolve => setImmediate(resolve));
const settings = { ...config.DEFAULT_SETTINGS, enabled: true, endpoint: 'https://provider.example/v1/chat/completions', sourceLanguage: 'ja' };
const input = resourceId => ({ type: 'translate', resourceId, requestId: crypto.randomUUID(),
  items: [{ id: `${resourceId}-one`, text: 'これはテストです', remainingMs: 12000 }] });

function background(options = {}) {
  const h = { currentUrl: url('sm2'), activeId: 7, calls: [], messages: [], permissions: async () => true, getHook: async () => {}, tabHook: async () => {},
    translate: async request => ({ items: request.items.map(item => ({ id: item.id, status: 'translated', text: '测试译文' })) }), ...options.hooks };
  const local = { [config.SETTINGS_KEY]: { ...settings, ...options.settings } };
  const session = { [config.KEY_STORAGE_KEY]: { origin: 'https://provider.example', value: 'unit-test-only' }, ...options.session };
  h.localStorage = local; h.sessionStorage = session;
  const storage = (values, area) => ({ setAccessLevel: async () => {},
    get: async () => { await h.getHook(); return { ...values }; },
    set: async patch => { await h.writeHook?.(area, patch); Object.assign(values, patch); }, remove: async key => { await h.removeHook?.(area, key); delete values[key]; } });
  let listener;
  const browser = { runtime: { id: 'test-extension', getURL: path => `chrome-extension://test-extension${path}`,
    onMessage: { addListener: fn => { listener = fn; } }, sendMessage: async message => { h.messages.push(structuredClone(message)); }, getPlatformInfo: async () => ({}),
    openOptionsPage: async () => { h.optionsOpens = (h.optionsOpens ?? 0) + 1; await h.openOptionsHook?.(); } },
    commands: { onCommand: { addListener: fn => { h.command = fn; } } },
    storage: { local: storage(local, 'local'), session: storage(session, 'session') }, permissions: { contains: (...args) => h.permissions(...args) },
    tabs: { get: async () => { await h.tabHook(); return { id: 7, url: h.currentUrl }; }, query: async () => [{ id: h.activeId, url: h.currentUrl }],
      sendMessage: async (_id, message, options) => {
        if (message.type === 'settings-host-probe') return h.settingsProbe?.();
        if (message.type === 'settings-host-open') return h.openSettingsHost?.(message);
        if (['verify-live-session', 'verify-resource-session'].includes(message.type)) return { ok: h.prove ? await h.prove(message.session) : true };
        if (message.type === 'get-adapter-diagnostic') return h.diagnostic?.(message, options);
        if (message.type === 'verify-adapter-diagnostic') return h.verifyDiagnostic?.(message, options);
      },
      onRemoved: { addListener: () => {} }, onUpdated: { addListener: fn => { h.updated = fn; } } } };
  class Engine {
    translate(request) { h.calls.push(request); return h.translate(request); }
    stats() { return h.stats ?? {}; }
    resetFailureState() {}
    setLiveSession(scope, active) { h.livePresence = { scope, active }; }
    hasLiveWork() { return h.livePresence?.active === true; }
  }
  class Cache { async stats() { return {}; } async clear() {} }
  load('background', { 'wxt/browser': { browser }, 'wxt/utils/define-background': { defineBackground: fn => fn() },
    '../src/core/config': config, '../src/core/messages': messages, '../src/core/resource': resource, '../src/core/live-metrics': metrics,
    '../src/core/adapter-diagnostic': diagnostics,
    '../src/core/timeout-retry': timeoutRetry,
    '../src/local/provider-settings': providerSettings,
    '../src/local/translation-profile': translationProfile,
    '../src/local/auto-load': autoLoad, '../src/core/model-catalog': modelCatalog, '../src/core/settings-frame': settingsFrame,
    '../src/core/service-history': serviceHistory, '../src/core/online-budget': onlineBudget, '../src/core/translation-shortcut': translationShortcut,
    '../src/platforms/bilibili-live/emotes': biliEmotes,
    '../src/translation': { TranslationEngine: Engine, IndexedDbTranslationCache: Cache }, '../src/translation/provider': provider, '../src/translation/model-test': {},
    '../src/translation/performance-test': options.performanceTesting ?? performanceTesting, '../src/translation/connection-discovery': connectionDiscovery,
    '../src/local/types': { LOCAL_CHANNEL }, '../src/local/bridge': { createLocalFetch: () => { throw new Error('Unexpected local inference'); }, localControl: control => {
      if (h.localControl) return h.localControl(control);
      throw new Error('Unexpected local control');
    } } });
  h.sender = { id: 'test-extension', frameId: 0, url: url('sm1'), tab: { id: 7, url: url('sm1') } };
  h.send = (message, sender = h.sender) => new Promise(resolve => listener(message, sender, resolve));
  h.overview = () => h.send({ type: 'overview' }, { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' });
  return h;
}

const testUi = { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' };
const popupUi = { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' };

for (const currentUrl of ['https://example.invalid/page', 'chrome://newtab/', 'file:///D:/example.html', '']) test(`settings open independently outside supported sites: ${currentUrl || 'unavailable URL'}`, async () => {
  const h = background({ hooks: { currentUrl } });
  const result = await h.send({ type: 'open-settings' }, popupUi);
  assert.equal(result.ok, true); assert.equal(result.mode, 'standalone'); assert.equal(h.optionsOpens, 1);
  assert.equal(h.sessionStorage[settingsFrame.SETTINGS_FRAME_KEY], undefined);
});

test('settings fall back independently when page integration is absent or fails', async () => {
  const absent = background();
  assert.equal((await absent.send({ type: 'open-settings' }, popupUi)).mode, 'standalone');
  const failed = background({ hooks: { settingsProbe: () => ({ ok: true, hostDocument: 'host-document' }), openSettingsHost: () => ({ ok: false }) } });
  assert.equal((await failed.send({ type: 'open-settings' }, popupUi)).mode, 'standalone');
  assert.equal(failed.optionsOpens, 1); assert.equal(Object.keys(failed.sessionStorage[settingsFrame.SETTINGS_FRAME_KEY]).length, 0);
});

test('supported settings stay embedded and unrelated senders cannot open privileged settings', async () => {
  const h = background({ hooks: { settingsProbe: () => ({ ok: true, hostDocument: 'host-document' }), openSettingsHost: () => ({ ok: true }) } });
  const result = await h.send({ type: 'open-settings' }, popupUi);
  assert.equal(result.mode, 'embedded'); assert.equal(h.optionsOpens, undefined);
  assert.equal((await h.send({ type: 'open-settings' }, testUi)).ok, false);
  assert.equal((await h.send({ type: 'open-settings' })).ok, false);
  assert.equal((await h.send({ type: 'open-settings' }, { ...popupUi, id: 'other-extension' })).ok, false);
});

test('standalone settings open errors remain retryable', async () => {
  const h = background({ hooks: { currentUrl: 'chrome://newtab/', openOptionsHook: () => { throw new Error('settings window unavailable'); } } });
  assert.equal((await h.send({ type: 'open-settings' }, popupUi)).ok, false);
  h.openOptionsHook = undefined;
  assert.equal((await h.send({ type: 'open-settings' }, popupUi)).ok, true); assert.equal(h.optionsOpens, 2);
});

const replayConfig = { mode: 'latency', count: 1, concurrency: 1, batchSize: 1, arrivalIntervalMs: 0, strategy: 'normal' };
function testPriorityHarness(options = {}) {
  let h;
  class PerformanceTest {
    constructor(_config, settings) { this.report = { id: crypto.randomUUID(), state: 'running', backend: settings.backend, model: settings.model }; }
    snapshot() { return { ...this.report }; }
    run() { h.testStarted = true; return new Promise((resolve, reject) => {
      h.finishTest = (failure = false) => { this.report.state = failure ? 'stopped' : 'completed'; failure ? reject(new Error('fixture failure')) : resolve(this.snapshot()); };
    }); }
    stop() { h.finishTest?.(); }
  }
  h = background({ ...options, performanceTesting: { PerformanceTest } });
  h.startTest = async () => h.send({ type: 'performance-start', settings: (await h.send({ type: 'settings' }, testUi)).settings, config: replayConfig }, testUi);
  h.isPaused = async () => (await h.send({ type: 'settings' }, testUi)).performancePaused;
  h.waitResumed = async () => { for (let i = 0; i < 50 && await h.isPaused(); i++) await flush(); assert.equal(await h.isPaused(), false); };
  return h;
}

for (const ending of ['success','failure','cancel']) test(`performance ${ending} pauses admissions and resumes without changing saved enabled`, async () => {
  const h = testPriorityHarness();
  let resolveOld;
  h.translate = request => new Promise(resolve => { resolveOld = () => resolve({ items: [] }); });
  const old = h.send(input('sm2')); await flush();
  assert.equal(h.calls.length, 1);
  const started = await h.startTest(); assert.equal(started.ok, true, started.error);
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(await h.isPaused(), true);
  assert.equal(h.localStorage[config.SETTINGS_KEY].enabled, true);
  assert.match((await h.send(input('sm2'))).error, /性能测试/);
  if (ending === 'cancel') await h.send({ type: 'performance-stop' }, testUi);
  else h.finishTest(ending === 'failure');
  await h.waitResumed(); resolveOld(); assert.equal((await old).ok, false);
  assert.equal(h.localStorage[config.SETTINGS_KEY].enabled, true);
  h.translate = async () => ({ items: [] }); assert.equal((await h.send(input('sm2'))).ok, true);
});

test('user disabling during a test survives completion and does not cancel the test', async () => {
  const h = testPriorityHarness(); assert.equal((await h.startTest()).ok, true);
  assert.equal((await h.send({ type: 'toggle', enabled: false }, testUi)).ok, true);
  assert.equal(await h.isPaused(), true);
  h.finishTest(); await h.waitResumed();
  assert.equal(h.localStorage[config.SETTINGS_KEY].enabled, false);
  assert.match((await h.send(input('sm2'))).error, /翻译已关闭/);
});

test('shortcut toggles atomically, clears manual auto-load pause only when enabling, and respects test priority', async () => {
  const h = testPriorityHarness({ session: { [autoLoad.LOCAL_AUTOLOAD_KEY]: { revision: 4, paused: true } } });
  assert.equal((await h.startTest()).ok, true);
  h.command('toggle-translation'); h.command('toggle-translation');
  for (let i = 0; i < 8; i++) await flush();
  assert.equal(h.localStorage[config.SETTINGS_KEY].enabled, true);
  assert.equal(h.sessionStorage[autoLoad.LOCAL_AUTOLOAD_KEY].paused, false);
  assert.equal(await h.isPaused(), true);
  h.finishTest(); await h.waitResumed();
});

test('local benchmark waits for real native idle and owns pause through restoration', async () => {
  let active = 1, report = null, h;
  const controls = [];
  h = testPriorityHarness({ hooks: { localControl: async control => {
    controls.push(control.action);
    if (control.action === 'state') return { ok: true, state: { phase: active ? 'generating' : 'ready', active, queued: 0 } };
    if (control.action === 'benchmark-start') { assert.equal(active, 0); report = { id: 'native-1', status: 'running', phase: 'loading' }; return { ok: true, report }; }
    return { ok: true, report };
  } } });
  const starting = h.send({ type: 'local-control', control: { action: 'benchmark-start', modelId: 'test-model' } }, testUi);
  for (let i = 0; i < 8; i++) await flush();
  assert.equal(await h.isPaused(), true); assert.ok(!controls.includes('benchmark-start'));
  active = 0; assert.equal((await starting).ok, true);
  report = { ...report, status: 'running', phase: 'restoring' };
  await h.send({ type: 'local-control', control: { action: 'benchmark-status' } }, testUi); assert.equal(await h.isPaused(), true);
  report = { ...report, status: 'completed', phase: 'done' };
  await h.send({ type: 'local-benchmark-finished' }, { id: 'test-extension', url: 'chrome-extension://test-extension/offscreen.html' });
  await h.waitResumed(); assert.equal(h.localStorage[config.SETTINGS_KEY].enabled, true);
});

test('native benchmark startup failure releases pause', async () => {
  const h = testPriorityHarness({ hooks: { localControl: async control => control.action === 'state'
    ? { ok: true, state: { phase: 'idle', active: 0, queued: 0 } } : { ok: false, error: 'LOCAL_MODEL_NOT_FOUND' } } });
  const reply = await h.send({ type: 'local-control', control: { action: 'benchmark-start', modelId: 'missing' } }, testUi);
  assert.equal(reply.ok, false); await h.waitResumed();
});

test('native stop during start IPC cancels the benchmark after ownership is acknowledged', async () => {
  let replyStart, entered, report;
  const insideStart = new Promise(resolve => { entered = resolve; });
  const h = testPriorityHarness({ hooks: { localControl: async control => {
    if (control.action === 'state') return { ok: true, state: { phase: 'ready', active: 0, queued: 0 } };
    if (control.action === 'benchmark-start') {
      report = { id: 'starting', status: 'running', phase: 'loading' }; entered();
      return new Promise(resolve => { replyStart = () => resolve({ ok: true, report }); });
    }
    if (control.action === 'benchmark-stop') report = { ...report, status: 'cancelled', phase: 'done' };
    return { ok: true, report };
  } } });
  const start = h.send({ type: 'local-control', control: { action: 'benchmark-start', modelId: 'fixture' } }, testUi);
  await insideStart;
  await h.send({ type: 'local-control', control: { action: 'benchmark-stop' } }, testUi);
  assert.equal(await h.isPaused(), true); replyStart();
  assert.equal((await start).report.status, 'cancelled'); await h.waitResumed();
});

test('a save cancels an ordinary performance replay still waiting to drain', async () => {
  const h = testPriorityHarness({ hooks: { stats: { pendingItems: 1 } } });
  const pending = h.startTest();
  for (let i = 0; i < 8; i++) await flush();
  assert.equal(await h.isPaused(), true);
  const saved = (await h.send({ type: 'settings' }, testUi)).settings;
  assert.equal((await h.send({ type: 'save', settings: { ...saved, targetLanguage: 'ko' } }, testUi)).ok, true);
  h.stats = {};
  assert.equal((await pending).ok, false); assert.equal(h.testStarted, undefined); await h.waitResumed();
});

test('worker recovery retains an offscreen benchmark lease and clears dead online leases', async () => {
  let report = { id: 'survived', status: 'running', phase: 'restoring' };
  const h = testPriorityHarness({ session: { 'performancePause.v1': { id: 'lease', kind: 'local-benchmark' } }, hooks: { localControl: async control =>
    control.action === 'state' ? { ok: true, state: { phase: 'ready', active: 0, queued: 0 } } : { ok: true, report } } });
  assert.equal(await h.isPaused(), true);
  report = { ...report, status: 'failed', phase: 'done' };
  await h.send({ type: 'local-control', control: { action: 'benchmark-status' } }, testUi); await h.waitResumed();
  const online = testPriorityHarness({ session: { 'performancePause.v1': { id: 'dead', kind: 'performance' } } });
  assert.equal(await online.isPaused(), false); assert.equal(online.sessionStorage['performancePause.v1'], undefined);
});

test('concurrent benchmark completion and polling release exactly one pause lease', async () => {
  let report = { id: 'single-release', status: 'running', phase: 'restoring' }, removeCount = 0, unblock, enter;
  const blocked = new Promise(resolve => { enter = resolve; });
  const h = testPriorityHarness({ session: { 'performancePause.v1': { id: 'lease', kind: 'local-benchmark' } }, hooks: { localControl: async control =>
    control.action === 'state' ? { ok: true, state: { phase: 'ready', active: 0, queued: 0 } } : { ok: true, report } } });
  assert.equal(await h.isPaused(), true);
  h.removeHook = async (_area, key) => { if (key === 'performancePause.v1') { removeCount++; enter(); await new Promise(resolve => { unblock = resolve; }); } };
  report = { ...report, status: 'completed', phase: 'done' };
  const event = h.send({ type: 'local-benchmark-finished' }, { id: 'test-extension', url: 'chrome-extension://test-extension/offscreen.html' });
  await blocked;
  const poll = h.send({ type: 'local-control', control: { action: 'benchmark-status' } }, testUi); await flush();
  assert.equal(removeCount, 1); assert.equal(await h.isPaused(), true);
  unblock(); await Promise.all([event, poll]); await h.waitResumed();
  assert.equal(removeCount, 1);
});

for (const first of ['selection', 'save']) test(`concurrent ${first} and other form writes preserve immediate model choice and saved fields`, async () => {
  const h = background(), ui = { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' };
  const original = (await h.send({ type: 'settings' }, ui)).settings;
  h.localControl = async control => {
    assert.equal(control.action, 'list'); return { ok: true, models: [{ id: 'new-model' }] };
  };
  let release, entered;
  const blocked = new Promise(resolve => { entered = resolve; });
  let block = true;
  h.writeHook = async (area, patch) => {
    if (area !== 'local' || !patch[config.SETTINGS_KEY] || !block) return;
    block = false; entered(); await new Promise(resolve => { release = resolve; });
  };
  const selection = () => h.send({ type: 'select-local-model', modelId: 'new-model' }, ui);
  const save = () => h.send({ type: 'save', settings: { ...original, localModelId: 'old-form-value', targetLanguage: 'en', enabled: false }, remember: false }, ui);
  const a = first === 'selection' ? selection() : save(); await blocked;
  const b = first === 'selection' ? save() : selection(); await flush();
  release();
  for (const reply of await Promise.all([a, b])) assert.equal(reply.ok, true, reply.error);
  const saved = (await h.send({ type: 'settings' }, ui)).settings;
  assert.equal(saved.localModelId, 'new-model');
  assert.equal(saved.targetLanguage, 'en'); assert.equal(saved.enabled, false);
  assert.equal(saved.backend, 'online'); assert.equal(saved.model, original.model);
});

test('invalid immediate model choice leaves all persisted fields unchanged', async () => {
  const h = background(), ui = { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' };
  const original = (await h.send({ type: 'settings' }, ui)).settings;
  h.localControl = async () => ({ ok: true, models: [] });
  assert.equal((await h.send({ type: 'select-local-model', modelId: 'missing-model' }, ui)).ok, false);
  assert.deepEqual((await h.send({ type: 'settings' }, ui)).settings, original);
});

function modelDeletionHarness(options = {}) {
  const h = background({ settings: { localModelId: 'model-a', enabled: false, ...options.settings } });
  h.models = [{ id: 'model-a' }, { id: 'model-b' }];
  h.localActions = [];
  h.localState = { phase: 'ready', model: { id: options.loaded ?? 'model-a' } };
  h.localControl = async control => {
    h.localActions.push(control);
    if (control.action === 'delete') {
      await h.deleting?.(control);
      if (h.deleteFailure) return { ok: false, error: 'LOCAL_STORAGE_QUOTA_OR_IO' };
      h.models = h.models.filter(model => model.id !== control.modelId);
      if (h.localState.model?.id === control.modelId) h.localState = { phase: 'idle' };
    } else assert.equal(control.action, 'list');
    return { ok: true, models: h.models, state: h.localState };
  };
  h.remove = (modelId, sender = testUi) => h.send({ type: 'local-control', control: { action: 'delete', modelId } }, sender);
  return h;
}

test('deleting selected model clears the choice and pauses local reload without fallback selection', async () => {
  const h = modelDeletionHarness({ settings: { backend: 'local' } });
  const before = { ...h.localStorage[config.SETTINGS_KEY] };
  const reply = await h.remove('model-a');
  assert.equal(reply.ok, true, reply.error);
  assert.deepEqual(reply.models, [{ id: 'model-b' }]);
  assert.equal(reply.state.phase, 'idle');
  assert.equal(h.sessionStorage[autoLoad.LOCAL_AUTOLOAD_KEY].paused, true);
  assert.equal(h.localActions.find(control => control.action === 'delete').policyRevision, h.sessionStorage[autoLoad.LOCAL_AUTOLOAD_KEY].revision);
  assert.deepEqual(structuredClone(h.localStorage[config.SETTINGS_KEY]), { ...before, localModelId: '' });
  const last = await h.remove('model-b');
  assert.equal(last.ok, true); assert.equal(last.models.length, 0);
  assert.equal(h.localStorage[config.SETTINGS_KEY].localModelId ?? '', '');
});

test('deleting an unused model leaves the current model and auto-load policy alone', async () => {
  const h = modelDeletionHarness(), before = { ...h.localStorage[config.SETTINGS_KEY] };
  const reply = await h.remove('model-b');
  assert.equal(reply.ok, true); assert.equal(reply.state.model.id, 'model-a');
  assert.deepEqual(h.localStorage[config.SETTINGS_KEY], before);
  assert.equal(h.sessionStorage[autoLoad.LOCAL_AUTOLOAD_KEY], undefined);
  assert.equal(h.localActions.find(control => control.action === 'delete').policyRevision, undefined);
});

test('invalid, missing or untrusted deletion cannot delete models or change selection', async () => {
  const h = modelDeletionHarness(), before = { ...h.localStorage[config.SETTINGS_KEY] };
  for (const id of ['', undefined, 'missing-model']) assert.equal((await h.remove(id)).ok, false);
  assert.equal((await h.remove('model-a', h.sender)).ok, false);
  assert.equal(h.localActions.some(control => control.action === 'delete'), false);
  assert.deepEqual(h.localStorage[config.SETTINGS_KEY], before);
});

test('storage deletion failure keeps the model choice and reports the error', async () => {
  const h = modelDeletionHarness(), before = { ...h.localStorage[config.SETTINGS_KEY] }; h.deleteFailure = true;
  const reply = await h.remove('model-a');
  assert.equal(reply.ok, false); assert.equal(reply.error, 'LOCAL_STORAGE_QUOTA_OR_IO');
  assert.equal(h.models.length, 2); assert.deepEqual(h.localStorage[config.SETTINGS_KEY], before);
});

test('model deletion is refused while a performance test owns the runtime', async () => {
  const h = testPriorityHarness(); await h.startTest();
  const reply = await h.send({ type: 'local-control', control: { action: 'delete', modelId: 'model-a' } }, testUi);
  assert.equal(reply.ok, false); assert.match(reply.error, /性能测试/);
  assert.equal(await h.isPaused(), true); h.finishTest(); await h.waitResumed();
});

test('selection queued behind deletion revalidates the model and cannot resurrect its choice', async () => {
  const h = modelDeletionHarness(); let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  h.deleting = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
  const deletion = h.remove('model-a'); await started;
  const selection = h.send({ type: 'select-local-model', modelId: 'model-a' }, testUi);
  await flush(); release();
  assert.equal((await deletion).ok, true); assert.equal((await selection).ok, false);
  assert.equal(h.localStorage[config.SETTINGS_KEY].localModelId ?? '', '');
});

test('saving a stale draft during deletion cannot restore a deleted model selection', async () => {
  const h = modelDeletionHarness(); let release, entered;
  const before = (await h.send({ type: 'settings' }, testUi)).settings;
  const started = new Promise(resolve => { entered = resolve; });
  h.deleting = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
  const deletion = h.remove('model-a'); await started;
  const saving = h.send({ type: 'save', settings: { ...before, targetLanguage: 'ko' }, remember: false }, testUi);
  await flush(); release();
  assert.equal((await deletion).ok, true); assert.equal((await saving).ok, true);
  assert.equal(h.localStorage[config.SETTINGS_KEY].localModelId ?? '', '');
  assert.equal(h.localStorage[config.SETTINGS_KEY].targetLanguage, 'ko');
});

function sourceEventHarness(options = {}) {
  const h = background({ settings: { backend: 'local', enabled: false, localModelId: 'selected', ...options.settings }, session: options.session });
  h.models = options.models ?? [{ id: 'selected', availability: 'permission-required' }];
  h.localState = options.state ?? { phase: 'ready', model: { id: h.localStorage[config.SETTINGS_KEY].localModelId }, requested: h.localStorage[config.SETTINGS_KEY].localPerformance };
  h.localActions = [];
  h.localControl = async control => {
    h.localActions.push(control);
    if (control.action === 'list') return { ok: true, models: h.models, state: h.localState };
    if (control.action === 'state') return { ok: true, state: h.localState };
    if (control.action === 'unload') {
      h.localState = { phase: 'idle' };
      return { ok: true, models: h.models, state: h.localState };
    }
    throw new Error(`Unexpected local control ${control.action}`);
  };
  h.sourceEvent = (sender = { id: 'test-extension', url: 'chrome-extension://test-extension/offscreen.html' }) =>
    h.send({ type: 'local-sources-updated' }, sender);
  return h;
}

const offscreenUi = { id: 'test-extension', url: 'chrome-extension://test-extension/offscreen.html' };
test('automatic idle release checks queued work and never changes selection or pauses on-demand loading', async () => {
  const h = sourceEventHarness();
  const check = () => h.send({ type: 'local-idle-check' }, offscreenUi);
  assert.equal((await check()).idle, true);
  h.stats = { pendingItems: 1, activeRequests: 0 }; assert.equal((await check()).idle, false);
  h.stats = { pendingItems: 0, activeRequests: 1 }; assert.equal((await check()).idle, false);
  h.stats = { pendingItems: 0, activeRequests: 0 }; assert.equal((await check()).idle, true);
  const saved = structuredClone(h.localStorage[config.SETTINGS_KEY]);
  h.localState = { phase: 'idle' };
  assert.equal((await h.send({ type: 'local-idle-unloaded' }, offscreenUi)).ok, true);
  assert.deepEqual(h.localStorage[config.SETTINGS_KEY], saved);
  const local = (await h.send({ type: 'settings' }, testUi)).localRuntime;
  assert.equal(local.paused, false); assert.equal(local.phase, 'idle');
  assert.equal(h.localActions.some(control => control.action === 'unload' || control.action === 'ensure'), false);
  for (const type of ['local-idle-check', 'local-idle-unloaded']) {
    assert.equal((await h.send({ type }, testUi)).ok, false);
    assert.equal((await h.send({ type }, { ...offscreenUi, id: 'other' })).ok, false);
  }
});

test('active translation admission prevents automatic idle release until it settles', async () => {
  const h = sourceEventHarness({ settings: { enabled: true } }); let finish;
  h.translate = () => new Promise(resolve => { finish = resolve; });
  const pending = h.send(input('sm2')); await flush(); assert.equal(typeof finish, 'function');
  assert.equal((await h.send({ type: 'local-idle-check' }, offscreenUi)).idle, false);
  finish({ items: [] }); await pending;
  assert.equal((await h.send({ type: 'local-idle-check' }, offscreenUi)).idle, true);
});

test('performance test leases prevent automatic idle release while their native work is between calls', async () => {
  const h = testPriorityHarness(); assert.equal((await h.startTest()).ok, true);
  assert.equal((await h.send({ type: 'local-idle-check' }, offscreenUi)).idle, false);
  h.finishTest(); await h.waitResumed();
  assert.equal((await h.send({ type: 'local-idle-check' }, offscreenUi)).idle, true);
});

test('folder source events are accepted only from the offscreen document', async () => {
  const h = sourceEventHarness();
  for (const sender of [
    { id: 'other-extension', url: 'chrome-extension://test-extension/offscreen.html' },
    { id: 'test-extension', url: 'chrome-extension://test-extension/offscreen.html', tab: { id: 7, url: url('sm1') } },
    { id: 'test-extension', url: 'chrome-extension://test-extension/background.html' },
  ]) {
    const reply = await h.sourceEvent(sender);
    assert.equal(reply.ok, false, JSON.stringify(sender));
  }
  assert.deepEqual(h.localActions, []);
});

test('permission loss pauses and unloads only the selected folder model while preserving its choice', async () => {
  const h = sourceEventHarness({ models: [{ id: 'selected', availability: 'permission-required' }, { id: 'other', availability: 'missing' }] });
  const before = { ...h.localStorage[config.SETTINGS_KEY] };
  const reply = await h.sourceEvent();
  assert.equal(reply.ok, true);
  assert.equal(h.localStorage[config.SETTINGS_KEY].localModelId, 'selected');
  assert.equal(h.sessionStorage[autoLoad.LOCAL_AUTOLOAD_KEY].paused, true);
  assert.equal(h.localActions.filter(action => action.action === 'unload').length, 1);
  assert.equal(h.localActions.some(action => action.action === 'delete'), false);
  assert.deepEqual({ ...h.localStorage[config.SETTINGS_KEY], localModelId: 'selected' }, { ...before, localModelId: 'selected' });
});

test('retiring the selected folder model clears only that choice and never selects another model', async () => {
  const h = sourceEventHarness({ models: [{ id: 'selected', availability: 'missing' }, { id: 'other', availability: 'ready' }] });
  const reply = await h.sourceEvent();
  assert.equal(reply.ok, true);
  assert.equal(h.localStorage[config.SETTINGS_KEY].localModelId ?? '', '');
  assert.equal(h.sessionStorage[autoLoad.LOCAL_AUTOLOAD_KEY].paused, true);
  assert.equal(h.localActions.filter(action => action.action === 'unload').length, 1);
  assert.ok(h.models.some(model => model.id === 'other'), 'the remaining model is not an implicit replacement');
});

test('refreshing an unselected retired source preserves the selected choice and runtime', async () => {
  const h = sourceEventHarness({ models: [{ id: 'selected', availability: 'ready' }, { id: 'other', availability: 'missing' }] });
  const reply = await h.sourceEvent();
  assert.equal(reply.ok, true);
  assert.equal(h.localStorage[config.SETTINGS_KEY].localModelId, 'selected');
  assert.equal(h.localState.phase, 'ready');
  assert.equal(h.localActions.some(action => action.action === 'unload'), false);
  assert.equal(h.sessionStorage[autoLoad.LOCAL_AUTOLOAD_KEY], undefined);
  assert.equal(h.messages.some(message => message.type === 'settings-updated'), false, 'an unrelated scan must not reset current translations');
});

test('retiring a stored local choice while online preserves in-flight online translation', async () => {
  const h = sourceEventHarness({ settings: { backend: 'online', enabled: true }, models: [{ id: 'selected', availability: 'missing' }] });
  let finish;
  h.translate = request => { h.signal = request.signal; return new Promise(resolve => { finish = resolve; }); };
  const pending = h.send(input('sm2')); await flush(); assert.ok(h.signal);
  assert.equal((await h.sourceEvent()).ok, true);
  assert.equal(h.signal.aborted, false);
  assert.equal(h.localStorage[config.SETTINGS_KEY].localModelId ?? '', '');
  const update = h.messages.findLast(message => message.type === 'settings-updated');
  assert.equal(update.resetTranslations, false);
  finish({ items: [{ id: 'sm2-one', status: 'translated', text: '继续在线翻译' }] });
  assert.equal((await pending).ok, true);
});

test('source retirement cancels an in-flight local translation and ignores its late result', async () => {
  const h = sourceEventHarness({ settings: { enabled: true }, models: [{ id: 'selected', availability: 'missing' }] });
  let resolveTranslation;
  h.translate = request => {
    h.translationSignal = request.signal;
    return new Promise(resolve => { resolveTranslation = resolve; });
  };
  const pending = h.send(input('sm2'));
  await flush();
  assert.ok(h.translationSignal, 'translation reached the local engine');
  const source = h.sourceEvent();
  await flush();
  assert.equal(h.translationSignal.aborted, true);
  const sourceReply = await source;
  assert.equal(sourceReply.ok, true);
  resolveTranslation({ items: [{ id: 'sm2-one', status: 'translated', text: '迟到结果' }] });
  const reply = await pending;
  assert.equal(reply.ok, false);
  assert.match(reply.error, /配置或播放位置已变化|请求已取消/);
});

test('serialized source reconciliation cannot clear a newer manual model selection', async () => {
  const h = background({ settings: { backend: 'local', enabled: false, localModelId: 'old-model' } });
  let releaseList, enteredList, listCalls = 0;
  const listed = new Promise(resolve => { enteredList = resolve; });
  h.localState = { phase: 'idle' };
  h.localControl = async control => {
    if (control.action === 'list') {
      listCalls++;
      if (listCalls === 1) { enteredList(); await new Promise(resolve => { releaseList = resolve; }); return { ok: true, models: [{ id: 'old-model', availability: 'missing' }], state: h.localState }; }
      return { ok: true, models: [{ id: 'new-model', availability: 'ready' }], state: h.localState };
    }
    if (control.action === 'unload') return { ok: true, state: h.localState };
    throw new Error(`Unexpected local control ${control.action}`);
  };
  const event = h.send({ type: 'local-sources-updated' }, { id: 'test-extension', url: 'chrome-extension://test-extension/offscreen.html' });
  await listed;
  const selection = h.send({ type: 'select-local-model', modelId: 'new-model' }, testUi);
  await flush();
  releaseList();
  const [eventReply, selectionReply] = await Promise.all([event, selection]);
  assert.equal(eventReply.ok, true);
  assert.equal(selectionReply.ok, true, selectionReply.error);
  assert.equal(h.localStorage[config.SETTINGS_KEY].localModelId, 'new-model');
  assert.equal(h.sessionStorage[autoLoad.LOCAL_AUTOLOAD_KEY].paused, false);
});

test('manual selection after a cleared choice resumes on-demand auto-loading', async () => {
  const h = background({ settings: { backend: 'local', enabled: false, localModelId: '' } });
  h.sessionStorage[autoLoad.LOCAL_AUTOLOAD_KEY] = { revision: 3, paused: true };
  h.localControl = async control => {
    assert.equal(control.action, 'list');
    return { ok: true, models: [{ id: 'new-model', availability: 'ready' }], state: { phase: 'idle' } };
  };
  const reply = await h.send({ type: 'select-local-model', modelId: 'new-model' }, testUi);
  assert.equal(reply.ok, true, reply.error);
  assert.equal(h.localStorage[config.SETTINGS_KEY].localModelId, 'new-model');
  assert.equal(h.sessionStorage[autoLoad.LOCAL_AUTOLOAD_KEY].paused, false);
});

test('settings category fragments retain exact UI document authorization', async () => {
  const h = background();
  for (const hash of ['', '#service', '#watching', '#live', '#performance', '#advanced', '#data']) {
    const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' + hash };
    const reply = await h.send({type:'settings'},sender); assert.equal(reply.ok,true,hash);
    assert.equal((await h.send({type:'save',settings:reply.settings,remember:false},sender)).ok,true,hash);
  }
  for (const url of ['chrome-extension://other/options.html#service','chrome-extension://test-extension/options.html/other#service','chrome-extension://test-extension/options.html?untrusted=1#service','https://test-extension/options.html#service','invalid']) {
    assert.equal((await h.send({type:'settings'},{id:'test-extension',url})).ok,false,url);
  }
  assert.equal((await h.send({type:'settings'},{id:'other',url:'chrome-extension://test-extension/options.html#service'})).ok,false);
});

test('SPA video uses current tab URL for translation, scope save and status with stale sender URL', async () => {
  const h = background();
  assert.equal((await h.send(input('sm2'))).ok, true);
  assert.equal(h.calls[0].resourceId, 'sm2');
  const saved = await h.send({ type: 'scheduling-settings', resourceId: 'sm2', translationScope: 'window', prefetchSeconds: 90 });
  assert.equal(saved.ok, true); assert.equal(saved.settings.prefetchSeconds, 90);
  await h.send({ type: 'status', status: { resourceId: 'sm2', state: 'ready', prepared: 3 } });
  const overview = await h.overview();
  assert.equal(overview.status.resourceId, 'sm2'); assert.equal(overview.status.prepared, 3);
});

test('homepage document can read settings and translate after entering a video', async () => {
  const h = background(); h.sender.url = 'https://www.nicovideo.jp/';
  h.currentUrl = 'https://www.nicovideo.jp/';
  assert.equal((await h.send({ type: 'settings' })).hasKey, true);
  h.currentUrl = url('sm2');
  assert.equal((await h.send(input('sm2'))).ok, true);
});

test('untrusted extension, subframes and non-Niconico origins remain rejected', async () => {
  const h = background();
  for (const patch of [{ id: 'other' }, { frameId: 1 }, { tab: { id: -1 } }, { url: 'not-a-url' },
    { url: 'https://www.nicovideo.jp.evil.example/watch/sm2' }, { url: 'http://www.nicovideo.jp/watch/sm2' },
    { url: 'https://evil.example/watch/sm2' }]) {
    const result = await h.send(input('sm2'), { ...h.sender, ...patch });
    assert.equal(result.ok, false); assert.equal(result.error, '不支持的消息来源');
  }
  assert.equal(h.calls.length, 0);
});

test('old video requests and unavailable current URL defer without provider admission', async () => {
  const h = background();
  for (const current of [url('sm2'), 'https://www.nicovideo.jp/', 'https://elsewhere.example/']) {
    h.currentUrl = current;
    const result = await h.send(input('sm1'));
    assert.equal(result.ok, false); assert.equal(result.retryAfterMs, 500);
  }
  assert.equal(h.calls.length, 0);
});

test('navigation during asynchronous permission read is checked again before provider admission', async () => {
  const h = background();
  h.permissions = async () => { h.currentUrl = url('sm3'); return true; };
  const result = await h.send(input('sm2'));
  assert.equal(result.retryAfterMs, 500); assert.equal(h.calls.length, 0);
});

test('navigation during scope configuration read cannot save an old video action', async () => {
  const h = background(); await h.send({ type: 'settings' });
  h.getHook = async () => { h.currentUrl = url('sm3'); };
  const result = await h.send({ type: 'scheduling-settings', resourceId: 'sm2', translationScope: 'window', prefetchSeconds: 90 });
  assert.equal(result.retryAfterMs, 500);
  assert.equal((await h.send({ type: 'settings' })).settings.translationScope, 'all');
});

test('late old status cannot replace current status and overview hides a previous video', async () => {
  const h = background();
  await h.send({ type: 'status', status: { resourceId: 'sm2', state: 'ready', prepared: 5 } });
  await h.send({ type: 'status', status: { resourceId: 'sm1', state: 'degraded', prepared: 99 } });
  assert.equal((await h.overview()).status.prepared, 5);
  h.currentUrl = url('sm3'); assert.equal((await h.overview()).status, null);
});

test('old provider response after navigation is not delivered to the new video', async () => {
  const h = background(); let resolve;
  h.translate = () => new Promise(done => { resolve = done; });
  const pending = h.send(input('sm2')); await flush();
  h.currentUrl = url('sm3'); resolve({ items: [{ id: 'sm2-one', status: 'translated', text: '旧译文' }] });
  const result = await pending;
  assert.equal(result.retryAfterMs, 500); assert.equal(result.items, undefined);
});

function youtube(h) {
  h.currentUrl = 'https://www.youtube.com/watch?v=abcdefghijk';
  h.sender = { ...h.sender, url: h.currentUrl, documentId: 'current-document' };
  const session = { platform: 'youtube', scenario: 'live', resourceId: 'abcdefghijk', sessionId: 'live-document', generation: 1 };
  const message = () => ({ ...input(session.resourceId), session, sentAt: resource.clockStamp(), items: [{ id: 'live-id', text: 'これはテストです', remainingMs: 1500 }] });
  return { session, message };
}

test('disabled entry preload leaves room/session and presence heartbeats passive', async () => {
  const h = sourceEventHarness({ settings: { enabled: true, localPreloadOnEntry: false }, state: { phase: 'idle' } }), live = youtube(h);
  for (let count = 0; count < 3; count++) {
    assert.equal((await h.send({ type: 'session-open', session: live.session })).ok, true);
    assert.equal((await h.send({ type: 'live-presence', session: live.session, active: true })).ok, true);
  }
  await flush(); assert.deepEqual(h.localActions, []);
  assert.equal((await h.send({ type: 'settings' }, testUi)).settings.localModelId, 'selected');
});

function entryPreloadHarness(options = {}) {
  const h = sourceEventHarness({ ...options, settings: { enabled: true, ...options.settings }, state: { phase: 'idle' } });
  const control = h.localControl;
  h.localControl = async request => {
    if (request.action !== 'ensure') return control(request);
    h.localActions.push(request);
    h.localState = { phase: 'ready', model: { id: request.modelId }, requested: request.config };
    return { ok: true, state: h.localState };
  };
  return h;
}

test('verified room entry preloads before any message, but idle heartbeats do not reload', async () => {
  const h = entryPreloadHarness(), live = youtube(h);
  assert.equal((await h.send({ type: 'session-open', session: live.session })).ok, true);
  await flush(); assert.equal(h.localActions.filter(action => action.action === 'ensure').length, 1);
  assert.equal(h.calls.length, 0, 'no translation was needed to start loading');
  h.localState = { phase: 'idle' };
  await h.send({ type: 'local-idle-unloaded' }, offscreenUi);
  const before = h.localActions.length;
  for (let i = 0; i < 3; i++) {
    await h.send({ type: 'session-open', session: live.session });
    await h.send({ type: 'live-presence', session: live.session, active: true });
  }
  await flush(); assert.equal(h.localActions.length, before);
  await h.send({ type: 'session-open', session: { ...live.session, generation: 2 } });
  await flush(); assert.equal(h.localActions.filter(action => action.action === 'ensure').length, 2);
});

test('worker restart remembers an already visited session and does not treat its heartbeat as entry', async () => {
  const first = entryPreloadHarness(), live = youtube(first);
  await first.send({ type: 'session-open', session: live.session }); await flush();
  const restarted = entryPreloadHarness({ session: structuredClone(first.sessionStorage) }); youtube(restarted);
  await restarted.send({ type: 'session-open', session: live.session }); await flush();
  assert.deepEqual(restarted.localActions, []);
});

for (const settings of [{ localPreloadOnEntry: false }, { enabled: false }, { backend: 'online' }, { displayMode: 'original' }, { localModelId: '' }]) {
  test(`entry preload respects settings ${JSON.stringify(settings)}`, async () => {
    const h = entryPreloadHarness({ settings }), live = youtube(h);
    await h.send({ type: 'session-open', session: live.session }); await flush();
    assert.deepEqual(h.localActions, []);
  });
}

test('entry preload respects manual unload and refuses an unattested room', async () => {
  const paused = entryPreloadHarness({ session: { [autoLoad.LOCAL_AUTOLOAD_KEY]: { revision: 1, paused: true } } }), live = youtube(paused);
  await paused.send({ type: 'session-open', session: live.session }); await flush(); assert.deepEqual(paused.localActions, []);
  const stale = entryPreloadHarness(), invalid = youtube(stale); stale.prove = () => false;
  assert.equal((await stale.send({ type: 'session-open', session: invalid.session })).ok, false);
  await flush(); assert.deepEqual(stale.localActions, []);
});

test('Niconico video entry preloads once and a new video loads again after idle release', async () => {
  const h = entryPreloadHarness(); h.sender.documentId = 'nico-current';
  const status = resourceId => ({ type: 'status', status: { state: 'ready', resourceId } });
  await h.send(status('sm2')); await flush();
  assert.equal(h.localActions.filter(action => action.action === 'ensure').length, 1);
  h.localState = { phase: 'idle' }; await h.send(status('sm2')); await flush();
  assert.equal(h.localActions.filter(action => action.action === 'ensure').length, 1);
  h.currentUrl = url('sm3'); h.updated(7, { url: h.currentUrl });
  await h.send(status('sm3')); await flush();
  assert.equal(h.localActions.filter(action => action.action === 'ensure').length, 2);
});

test('Bilibili video session preloads without waiting for translation', async () => {
  const h = entryPreloadHarness(), video = bili(h);
  await h.send({ type: 'session-open', session: video.session }); await flush();
  assert.equal(h.localActions.filter(action => action.action === 'ensure').length, 1);
  assert.equal(h.calls.length, 0);
});

for (const kind of ['directory', 'files']) test(`removing an unavailable ${kind} reference does not select or unload another model`, async () => {
  const h = modelDeletionHarness({ settings: { backend: 'local' } });
  h.models[1] = { id: 'model-b', source: { kind }, availability: 'missing' };
  const reply = await h.remove('model-b'); assert.equal(reply.ok, true, reply.error);
  assert.equal(h.localState.model.id, 'model-a'); assert.equal(h.localStorage[config.SETTINGS_KEY].localModelId, 'model-a');
  assert.equal(h.sessionStorage[autoLoad.LOCAL_AUTOLOAD_KEY], undefined);
});
function bili(h, scenario = 'video') {
  h.currentUrl = scenario === 'video' ? 'https://www.bilibili.com/video/BV1xx411c7mD/?p=2' : 'https://live.bilibili.com/777';
  h.sender = { ...h.sender, url: h.currentUrl, documentId: 'bili-document' };
  const session = { platform: 'bilibili', scenario, resourceId: scenario === 'video' ? 'av2:cid62132' : 'room:22900497',
    urlResourceId: scenario === 'video' ? 'BV1xx411c7mD:p2' : '777', sessionId: 'bili-session', generation: 1 };
  return { session, message: () => ({ ...input(session.resourceId), session, sentAt: resource.clockStamp() }) };
}
test('Bilibili binds attested native CID rather than URL candidate and rejects stale documents', async () => {
  const h = background(), video = bili(h);
  assert.equal((await h.send(video.message())).ok, false);
  assert.equal((await h.send({ type:'session-open', session:video.session })).ok, true);
  assert.equal((await h.send(video.message())).ok, true);
  assert.equal(h.calls[0].resourceId, '["bilibili","video","av2:cid62132"]');
  assert.equal(h.calls[0].mode, 'vod');
  assert.equal((await h.send(video.message(), { ...h.sender, documentId:'stale' })).ok,false);
  h.currentUrl=h.currentUrl.replace('p=2','p=1'); assert.equal((await h.send(video.message())).ok,false);
});
test('Bilibili same-URL CID replacement cancels old response without cross-CID delivery', async () => {
  const h = background(), video = bili(h); await h.send({ type:'session-open', session:video.session });
  let complete; h.translate=() => new Promise(resolve => { complete=resolve; });
  const pending=h.send(video.message()); await flush();
  const next={...video.session,resourceId:'av2:cid62133',generation:2};
  assert.equal((await h.send({type:'session-open',session:next})).ok,true);
  complete({items:[{id:'old',status:'translated',text:'旧结果'}]});
  const result=await pending; assert.equal(result.ok,false); assert.equal(result.items,undefined);
  assert.equal((await h.send({type:'session-open',session:video.session})).ok,false);
});
test('Bilibili current top-document attestation rejects stale open despite identical URL', async () => {
  const h=background(),video=bili(h); h.prove=s => s.generation===2;
  assert.equal((await h.send({type:'session-open',session:video.session})).ok,false);
  assert.equal((await h.send({type:'session-open',session:{...video.session,generation:2}})).ok,true);
  assert.equal(h.calls.length,0);
});
test('Bilibili SC and manual repair reuse shared engine with separate strategy and fixed budget', async () => {
  const h=background(),live=bili(h,'live'); await h.send({type:'session-open',session:live.session});
  for(const [strategy,purpose,manual] of [['superchat','superchat',false],['superchat','manual',true],['manual','manual',true]]) {
    const message=live.message(); Object.assign(message,{repairPurpose:purpose,forceTranslate:manual,force:false});
    message.items[0].strategy=strategy; message.items[0].remainingMs=60000;
    assert.equal((await h.send(message)).ok,true); assert.equal(h.calls.at(-1).mode,'deadline');
    assert.equal(h.calls.at(-1).quotaScope,'tab:7'); assert.equal(h.calls.at(-1).items[0].strategy,strategy);
    assert.ok(h.calls.at(-1).items[0].deadlineAt-performance.now()<=15000);
  }
});

test('Bilibili timeout retry is opt-in, uses normal strategy and shares quota without forcing cache', async () => {
  const h = background(), live = bili(h, 'live');
  await h.send({ type: 'session-open', session: live.session });
  const retry = () => {
    const message = live.message();
    Object.assign(message, { repairPurpose: 'timeout', forceTranslate: false, force: false });
    message.items[0].strategy = 'normal'; message.items[0].remainingMs = 60000;
    return message;
  };
  assert.equal((await h.send(retry())).ok, false);
  assert.equal(h.calls.length, 0);
  const saved = { ...settings, liveBufferMs: 2000, bilibiliTimeoutRetryEnabled: true, bilibiliTimeoutRetryExtraMs: 1500 };
  const ui = { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' };
  assert.equal((await h.send({ type: 'save', settings: saved, remember: false }, ui)).ok, true);
  assert.equal((await h.send(retry())).ok, true);
  const call = h.calls.at(-1);
  assert.equal(call.mode, 'deadline'); assert.equal(call.quotaScope, 'tab:7');
  assert.equal(call.force, false); assert.equal(call.forceTranslate, false);
  assert.equal(call.items[0].strategy, 'normal');
  assert.equal(call.settings.requestTimeoutMs, saved.requestTimeoutMs);
  assert.equal(call.settings.thinkingEffort, saved.thinkingEffort);
  const remaining = call.items[0].deadlineAt - performance.now();
  assert.ok(remaining > 3000 && remaining <= 3500, 'second budget is first budget + configured extra');
  const delayed = retry(); delayed.sentAt -= 800; delayed.items[0].remainingMs = 1200;
  assert.equal((await h.send(delayed)).ok, true);
  assert.ok(h.calls.at(-1).items[0].deadlineAt - performance.now() <= 400, 'handoff time consumes the second deadline');
  const before = h.calls.length;
  for (const patch of [{ force: true }, { forceTranslate: true }]) assert.equal((await h.send({ ...retry(), ...patch })).ok, false);
  for (const strategy of ['manual', 'superchat']) {
    const invalid = retry(); invalid.items[0].strategy = strategy;
    assert.equal((await h.send(invalid)).ok, false);
  }
  assert.equal(h.calls.length, before, 'retry cannot borrow manual/SC settings or force cache bypass');
  const yt = youtube(h); await h.send({ type: 'session-open', session: yt.session });
  assert.equal((await h.send({ ...yt.message(), repairPurpose: 'timeout', forceTranslate: false, force: false })).ok, false);
  assert.equal(h.calls.length, before, 'Bilibili option cannot enable retries on another platform');
});
test('live background requires a registered top-frame document/session and selects deadline itself', async () => {
  const h = background(), live = youtube(h);
  assert.equal((await h.send(live.message())).ok, false);
  assert.equal((await h.send({ type: 'session-open', session: live.session }, { ...h.sender, frameId: 2 })).ok, false);
  assert.equal((await h.send({ type: 'session-open', session: live.session })).ok, true);
  assert.equal((await h.send({ ...live.message(), mode: 'vod', settings: { endpoint: 'https://evil.test' }, apiKey: 'page-key' })).ok, true);
  assert.equal(h.calls[0].mode, 'deadline');
  assert.equal(h.calls[0].resourceId, '["youtube","live","abcdefghijk"]');
  assert.equal(h.calls[0].settings.endpoint, settings.endpoint);
  assert.equal(h.calls[0].settings.sourceLanguage, 'auto');
  assert.equal(h.calls[0].settings.thinkingEffort, settings.thinkingEffort);
  assert.equal(h.calls[0].apiKey, 'unit-test-only');
  assert.equal((await h.send(live.message(), { ...h.sender, documentId: 'old-document' })).ok, false);
});
test('manual and Super Chat deadlines are fresh, finite and selected by background policy', async () => {
  const h = background(), live = youtube(h);
  await h.send({ type: 'session-open', session: live.session });
  const send = async (strategy, manual, force) => {
    const message = live.message(); message.forceTranslate = manual; message.force = force;
    message.items[0].strategy = strategy; message.items[0].remainingMs = 999999;
    assert.equal((await h.send(message)).ok, true);
    return h.calls.at(-1);
  };
  const ordinary = await send('normal', false, true);
  assert.equal(ordinary.force, false); assert.ok(ordinary.items[0].deadlineAt - performance.now() <= settings.liveBufferMs);
  const manual = await send('manual', true, true);
  assert.equal(manual.force, true); assert.ok(manual.items[0].deadlineAt - performance.now() > 12000); assert.ok(manual.items[0].deadlineAt - performance.now() <= 15000);
  const sc = await send('superchat', false, false);
  assert.equal(sc.settings.requestTimeoutMs, settings.superChatTimeoutMs ?? 15000);
  assert.ok(sc.items[0].deadlineAt - performance.now() <= 15000);
});

test('live handoff and slow permission reads consume the original deadline budget', async () => {
  const h = background(), live = youtube(h);
  await h.send({ type: 'session-open', session: live.session });
  h.permissions = async () => { await new Promise(done => setTimeout(done, 20)); return true; };
  const m = live.message(); m.sentAt -= 200; m.items[0].remainingMs = 100;
  let deadlineRemaining;
  h.translate = async r => { deadlineRemaining = r.items[0].deadlineAt - performance.now(); return { items: [] }; };
  assert.equal((await h.send(m)).ok, true);
  assert.ok(deadlineRemaining < 0, 'expired transit/storage budget is not renewed at admission');
});

test('YouTube pinned repair uses normal settings with a manual lane and 15-second budget', async () => {
  const h = background(), live = youtube(h); await h.send({type:'session-open',session:live.session});
  const m = {...live.message(),repairPurpose:'pinned',forceTranslate:false,force:false};
  m.items[0].strategy='manual';m.items[0].remainingMs=15000;
  assert.equal((await h.send(m)).ok,true);
  const call=h.calls.at(-1);assert.equal(call.items[0].strategy,'manual');assert.equal(call.settings.thinkingEffort,settings.thinkingEffort);
  assert.equal(call.forceTranslate,false);assert.equal(call.force,false);
  assert.ok(call.items[0].deadlineAt-performance.now()>12000);assert.ok(call.items[0].deadlineAt-performance.now()<=15000);
  const sc={...live.message(),repairPurpose:'manual',forceTranslate:true,force:true};sc.items[0].strategy='superchat';
  assert.equal((await h.send(sc)).ok,true);assert.equal(h.calls.at(-1).items[0].strategy,'superchat');assert.equal(h.calls.at(-1).force,true);
  for(const patch of [{force:true},{forceTranslate:true},{repairPurpose:'unknown'}])assert.equal((await h.send({...m,requestId:crypto.randomUUID(),...patch})).ok,false);
});

test('YouTube repair cancellation during tab/config/permission admission never calls provider',async()=>{
  for(const phase of ['tabHook','getHook','permissions']) {
    const h=background(),live=youtube(h);await h.send({type:'session-open',session:live.session});
    let release, entered=false;const gate=new Promise(resolve=>release=resolve);
    h[phase]=async()=>{entered=true;await gate;return true;};
    const m={...live.message(),repairPurpose:'manual',forceTranslate:true,force:true};m.items[0].strategy='manual';m.items[0].remainingMs=15000;
    const pending=h.send(m);await flush();assert.equal(entered,true,phase);
    await h.send({type:'cancel',requestId:m.requestId});h[phase]=async()=>true;release();
    assert.equal((await pending).ok,false,phase);assert.equal(h.calls.length,0,phase);
    assert.equal((await h.send({...m,sentAt:resource.clockStamp()})).ok,true,'cancelled admission released its slot');
  }
});

test('cancelled repair admission cannot delete a replacement request using the same ID',async()=>{
  const h=background(),live=youtube(h);await h.send({type:'session-open',session:live.session});
  let releasePermission,releaseProvider;
  h.permissions=()=>new Promise(resolve=>releasePermission=resolve);
  const m={...live.message(),repairPurpose:'manual',forceTranslate:true,force:true};m.items[0].strategy='manual';
  const old=h.send(m);await flush();await h.send({type:'cancel',requestId:m.requestId});
  h.permissions=async()=>true;h.translate=()=>new Promise(resolve=>releaseProvider=resolve);
  const replacement=h.send({...m,sentAt:resource.clockStamp()});await flush();assert.equal(h.calls.length,1);
  releasePermission(true);assert.equal((await old).ok,false);assert.equal(h.calls[0].signal.aborted,false);
  await h.send({type:'cancel',requestId:m.requestId});assert.equal(h.calls[0].signal.aborted,true);
  releaseProvider({items:[]});assert.equal((await replacement).ok,false);
});
test('idempotent live heartbeat keeps in-flight response but session generation/navigation invalidates it', async () => {
  const h = background(), live = youtube(h); let resolve;
  await h.send({ type: 'session-open', session: live.session });
  h.translate = () => new Promise(done => { resolve = done; });
  const first = h.send(live.message()); await flush();
  await h.send({ type: 'session-open', session: live.session });
  resolve({ items: [] }); assert.equal((await first).ok, true);
  const second = h.send(live.message()); await flush();
  await h.send({ type: 'session-open', session: { ...live.session, generation: 2 } });
  resolve({ items: [] }); assert.equal((await second).ok, false);
  assert.equal((await h.send({ type: 'session-open', session: live.session })).ok, false);
  live.session.generation = 2;
  const third = h.send(live.message()); await flush();
  h.updated(7, { url: 'https://www.youtube.com/watch?v=mnopqrstuvw' });
  resolve({ items: [] }); assert.equal((await third).ok, false);
  assert.equal((await h.send(live.message())).ok, false);
});
test('live status separates connection and coverage from VOD pool progress', async () => {
  const h = background(), live = youtube(h);
  await h.send({ type: 'session-open', session: live.session });
  await h.send({ type: 'status', session: live.session, status: { resourceId: live.session.resourceId, state: 'ready',
    connection: 'connected', coverage: 'top', recentEligible: 10, recentTranslated: 6, timedOut: 4, prepared: 100, nearTotal: 100 } });
  const status = (await h.overview()).status;
  assert.equal(status.scenario, 'live'); assert.equal(status.connection, 'connected'); assert.equal(status.coverage, 'top');
  assert.equal(status.prepared, undefined); assert.equal(status.nearTotal, undefined);
  assert.equal(status.timedOut, 4);
});
test('current top-document proof rejects a delayed old-document session-open', async () => {
  const h = background(), live = youtube(h);
  h.prove = s => s.sessionId === 'new-document';
  const oldSender = { ...h.sender, documentId: 'old-document' };
  const newSession = { ...live.session, sessionId: 'new-document' };
  const delayedOld = h.send({ type: 'session-open', session: live.session }, oldSender);
  assert.equal((await h.send({ type: 'session-open', session: newSession })).ok, true);
  assert.equal((await delayedOld).ok, false);
  assert.equal((await h.send({ ...live.message(), session: newSession })).ok, true);
  assert.equal(h.calls.length, 1);
});
test('live IPC admission is independently bounded at 1024 while VOD keeps 18 reserved positions', async () => {
  const h = background(), resolves = [], pending = [];
  h.livePresence = { active: true };
  h.translate = r => new Promise(resolve => resolves.push({ resolve, signal: r.signal }));
  for (let i = 0; i < 18; i++) { pending.push(h.send(input('sm2'))); await flush(); }
  assert.equal(h.calls.length, 18);
  assert.equal((await h.send(input('sm2'))).ok, false);
  const live = youtube(h); h.sender.tab = { id: 8, url: h.currentUrl };
  await h.send({ type: 'session-open', session: live.session });
  for (let i = 0; i < 1006; i++) { pending.push(h.send(live.message())); await flush(); }
  assert.equal(h.calls.length, 1024);
  assert.equal(h.calls.filter(r => r.mode === 'deadline').length, 1006);
  assert.equal((await h.send(live.message())).ok, false);
  assert.ok(resolves.every(r => !r.signal.aborted), 'running VOD is allowed to finish');
  resolves.forEach(r => r.resolve({ items: [] })); await Promise.all(pending);
});

function content(initialUrl = url('sm1')) {
  const h = { calls: [], sent: [], runtimeSent: [], views: [], intervals: [], invalidated: [], now: 10000 };
  const location = { href: initialUrl, origin: new URL(initialUrl).origin };
  const handlers = new Map();
  const window = { postMessage: payload => h.sent.push(payload), addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener() {} };
  const safeConfig = { ok: true, settings: { ...settings }, hasKey: true };
  const browser = { runtime: { id: 'test-extension', sendMessage: async message => {
    h.runtimeSent.push(message);
    if (message.type === 'settings') return safeConfig;
    if (message.type === 'translate') return new Promise(resolve => h.calls.push({ ...message, resolve }));
    return { ok: true };
  }, onMessage: { addListener: fn => { h.receive = (message, sender = { id: 'test-extension' }) => fn(message, sender); h.settingsChanged = message => {
    if (message.type === 'settings-updated') Object.assign(safeConfig, { settings: message.settings, hasKey: message.hasKey });
    return fn(message, { id: 'test-extension' });
  }; }, removeListener() {} } } };
  const entry = load('watch.content', { 'wxt/browser': { browser },
    'wxt/utils/define-content-script': { defineContentScript: options => options },
    '../src/core/config': config, '../src/core/messages': messages, '../src/core/resource': resource,
    '../src/core/adapter-diagnostic': diagnostics,
    '../src/core/scheduler': { ...scheduling, VideoScheduler: class extends scheduling.VideoScheduler {
      constructor(options) { super({ ...options, now: () => h.now }); }
    } },
    '../src/core/source-stream': stream, '../src/platforms/niconico/native': { BRIDGE },
    '../src/ui/progress': { createProgress: () => ({ attach() {}, dispose() {}, update: (settings, stats, notice) => h.views.push({ stats, notice }) }) },
  }, { window, location, performance: { now: () => h.now }, clearInterval() {} });
  entry.main({ setInterval: fn => { h.intervals.push(fn); }, onInvalidated: fn => h.invalidated.push(fn) });
  h.post = data => handlers.get('message')({ source: window, origin: location.origin, data: { bridge: BRIDGE, from: 'native', ...data } });
  h.video = (id, session = id) => {
    location.href = url(id);
    const scope = { resourceId: id, session, epoch: 1 };
    h.post({ ...scope, type: 'snapshot', clock: { mediaTimeMs: 0, durationMs: 100000, playbackRate: 1, paused: true, contentActive: true, seeking: false } });
    h.post({ ...scope, type: 'sources', sourceGeneration: 0, revision: 1, index: 0, reset: true, complete: true, removes: [],
      upserts: [{ sourceId: 'one', threadId: 'thread', fork: 'main', originalText: 'これはテストです', mediaTimeMs: 0, renderAtMs: -2000, translatable: true, style: {} }] });
  };
  h.tick = () => { h.now += 1000; for (const fn of h.intervals) fn(); };
  h.dispose = () => { for (const fn of h.invalidated) fn(); };
  h.location = location; h.safeConfig = safeConfig;
  return h;
}

test('late failed content response cannot overwrite a new video notice or preparation', async () => {
  const h = content(); await flush(); h.video('sm1'); await flush(); h.video('sm2'); await flush();
  h.calls[1].resolve({ ok: true, items: h.calls[1].items.map(item => ({ id: item.id, status: 'translated', text: '新视频译文' })) });
  await flush(); h.calls[0].resolve({ ok: false, error: 'OLD VIDEO FAILURE' }); await flush(); h.tick();
  assert.equal(h.views.at(-1).notice, ''); assert.equal(h.views.at(-1).stats.translated, 1);
  assert.equal(h.sent.filter(d => d.type === 'prepared').length, 1);
  assert.equal(h.sent.find(d => d.type === 'prepared').resourceId, 'sm2'); h.dispose();
});

test('late content response is ignored as soon as URL changes, before the next native snapshot', async () => {
  const h = content(); await flush(); h.video('sm1'); await flush(); h.location.href = url('sm2');
  h.calls[0].resolve({ ok: true, items: h.calls[0].items.map(item => ({ id: item.id, status: 'translated', text: '旧译文' })) });
  await flush(); assert.equal(h.sent.filter(d => d.type === 'prepared').length, 0); h.dispose();
});

test('content response from an old same-video session or configuration cannot change notices', async () => {
  for (const transition of ['session', 'configuration']) {
    const h = content(); await flush(); h.video('sm1', 'first'); await flush();
    if (transition === 'session') h.video('sm1', 'replacement');
    else h.settingsChanged({ type: 'settings-updated', ...h.safeConfig, settings: { ...settings, model: 'MiniMax-M3-highspeed' } });
    await flush(); h.calls[0].resolve({ ok: false, error: 'STALE RESPONSE' }); await flush(); h.tick();
    assert.equal(h.views.at(-1).notice, ''); h.dispose();
  }
});

test('video-changing rejection remains queued and retries instead of failing the comment', async () => {
  const h = content(); await flush(); h.video('sm1'); await flush();
  h.calls[0].resolve({ ok: false, error: '视频正在切换', retryAfterMs: 1 }); await flush(); h.tick();
  assert.equal(h.views.at(-1).stats.failed, 0); assert.equal(h.views.at(-1).stats.queued, 1);
  assert.equal(h.calls.length, 2);
  h.dispose();
});

test('thinking progress reports waiting and final timeout identifies its actual budget', async () => {
  const h = content(); await flush();
  h.settingsChanged({ type: 'settings-updated', ...h.safeConfig, settings: { ...settings,
    profile: 'deepseek', model: 'deepseek-v4-pro', thinkingEffort: 'high', thinkingRequestTimeoutMs: 90000 } });
  h.video('sm1'); await flush(); h.tick();
  assert.match(h.views.at(-1).notice, /等待模型思考.*90 秒/);
  assert.equal(h.views.at(-1).stats.failed, 0);
  h.calls[0].resolve({ ok: true, items: h.calls[0].items.map(item => ({ id: item.id, status: 'failed', reason: 'timeout' })) });
  await flush(); h.tick();
  assert.match(h.views.at(-1).notice, /超过 90 秒/); assert.equal(h.views.at(-1).stats.failed, 1);
  h.dispose();
});

const failedDiagnostic = candidate => ({ ...diagnostics.adapterDiagnostic(candidate, 'unsupported-version'),
  nativeVersion: '1.1.22', nativeCompiled: '2026-07-14T14:26:03+08:00' });
function diagnosticResponder(h) {
  const candidate = diagnostics.diagnosticCandidate(h.currentUrl);
  h.diagnostic = async (message, options) => {
    assert.equal(options.frameId, 0);
    return { ok: true, requestId: message.requestId, documentSession: 'current-document', diagnostic: failedDiagnostic(candidate) };
  };
  h.verifyDiagnostic = async message => ({ ok: message.documentSession === 'current-document' });
  return candidate;
}

test('Bilibili diagnostic is queryable without any attested CID, including after background restart', async () => {
  for (let restart = 0; restart < 2; restart++) {
    const h = background(), video = bili(h), candidate = diagnosticResponder(h);
    const result = await h.overview();
    assert.equal(result.status, null); assert.deepEqual(result.adapterDiagnostic, failedDiagnostic(candidate));
    assert.equal((await h.send(video.message())).ok, false, 'diagnostic cannot open a translation session');
    assert.equal(h.calls.length, 0);
    await h.send({ type: 'session-open', session: video.session });
    await h.send({ type: 'status', session: video.session, status: { resourceId: video.session.resourceId, state: 'ready' } });
    const ready = await h.overview(); assert.equal(ready.status.state, 'ready'); assert.equal(ready.adapterDiagnostic, null);
  }
});

test('Bilibili diagnosis rejects replaced documents, stale candidates, navigation and tab changes', async () => {
  for (const transition of ['document', 'candidate', 'reload', 'roundtrip', 'navigation', 'active-tab']) {
    const h = background(); bili(h); diagnosticResponder(h);
    const read = h.diagnostic;
    h.diagnostic = async (...args) => {
      const result = await read(...args);
      if (transition === 'document') h.verifyDiagnostic = () => ({ ok: false });
      if (transition === 'candidate') result.diagnostic.urlResourceId = 'BV1xx411c7mD:p1';
      if (transition === 'reload') h.updated(7, { status: 'loading' });
      if (transition === 'roundtrip') { h.updated(7, { url: 'https://www.bilibili.com/' }); h.updated(7, { url: h.currentUrl }); }
      if (transition === 'navigation') h.currentUrl = 'https://www.bilibili.com/video/BV1xx411c7mD/?p=3';
      if (transition === 'active-tab') h.activeId = 8;
      return result;
    };
    const result = await h.overview(); assert.equal(result.adapterDiagnostic, null, transition); assert.equal(result.status, null);
    assert.equal(h.calls.length, 0);
  }
});

test('Bilibili overview rejects cached ready state after current document stops attesting its CID', async () => {
  const h = background(), video = bili(h); diagnosticResponder(h);
  await h.send({ type: 'session-open', session: video.session });
  await h.send({ type: 'status', session: video.session, status: { resourceId: video.session.resourceId, state: 'ready' } });
  assert.equal((await h.overview()).status.state, 'ready');
  h.prove = () => false; // New CID is current, its session-open has not reached the background yet.
  const result = await h.overview();
  assert.equal(result.status, null); assert.equal(result.adapterDiagnostic.code, 'unsupported-version');
  assert.equal(h.calls.length, 0);
});

test('Bilibili current ready status wins when it arrives during a diagnostic query', async () => {
  const h = background(), video = bili(h); diagnosticResponder(h);
  const read = h.diagnostic;
  h.diagnostic = async (...args) => {
    const reply = await read(...args);
    await h.send({ type: 'session-open', session: video.session });
    await h.send({ type: 'status', session: video.session, status: { resourceId: video.session.resourceId, state: 'ready' } });
    return reply;
  };
  const result = await h.overview();
  assert.equal(result.status.state, 'ready'); assert.equal(result.adapterDiagnostic, null);
});

test('identified Bilibili page with missing content script has its own diagnostic', async () => {
  const h = background(); bili(h);
  assert.equal((await h.overview()).adapterDiagnostic.code, 'content-unresponsive');
  h.currentUrl = 'https://www.bilibili.com/'; assert.equal((await h.overview()).adapterDiagnostic, null);
});

test('Bilibili content retains failure after settings refresh, expires it, and rejects wrong source and URL', async () => {
  const href = 'https://www.bilibili.com/video/BV1SQbW6dELM/';
  const h = content(href), candidate = diagnostics.diagnosticCandidate(href); await flush();
  const query = { type: 'get-adapter-diagnostic', requestId: 'query-1', urlResourceId: candidate };
  h.post({ type: 'unavailable', diagnostic: failedDiagnostic(candidate), reason: 'untrusted arbitrary text' });
  const reply = await h.receive(query);
  assert.deepEqual(reply.diagnostic, failedDiagnostic(candidate));
  assert.equal(h.runtimeSent.some(m => ['session-open','status','translate'].includes(m.type)), false);
  h.settingsChanged({ type: 'settings-updated', ...h.safeConfig });
  assert.equal((await h.receive(query)).diagnostic.code, 'unsupported-version');
  assert.equal(h.receive(query, { id: 'other' }), undefined);
  assert.equal(h.receive(query, { id: 'test-extension', tab: { id: 7 } }), undefined);
  assert.equal((await h.receive({ ...query, type: 'verify-adapter-diagnostic', documentSession: 'old', diagnostic: reply.diagnostic })).ok, false);
  assert.equal((await h.receive({ ...query, type: 'verify-adapter-diagnostic', documentSession: reply.documentSession, diagnostic: reply.diagnostic })).ok, true);
  h.now += 6001;
  assert.equal((await h.receive({ ...query, type: 'verify-adapter-diagnostic', documentSession: reply.documentSession, diagnostic: reply.diagnostic })).ok, false,
    'a diagnostic that expires between query and verification cannot be returned');
  assert.equal((await h.receive(query)).diagnostic.code, 'native-unresponsive');
  h.location.href = href + '?p=2';
  assert.equal((await h.receive(query)).ok, false);
  h.post({ type: 'unavailable', diagnostic: failedDiagnostic(candidate) });
  assert.equal((await h.receive({ ...query, urlResourceId: candidate.replace(':p1', ':p2') })).diagnostic.code, 'native-unresponsive');
  h.dispose();
});

test('Bilibili valid snapshot clears failed diagnosis and recovery never authenticates a URL candidate', async () => {
  const href = 'https://www.bilibili.com/video/BV1SQbW6dELM/', h = content(href); await flush();
  const candidate = diagnostics.diagnosticCandidate(href), diagnostic = failedDiagnostic(candidate);
  h.post({ type: 'unavailable', diagnostic });
  const query = { type: 'get-adapter-diagnostic', requestId: 'query-1', urlResourceId: candidate };
  const previous = await h.receive(query);
  h.post({ type: 'snapshot', resourceId: 'av117224320801605:cid41641968199', urlResourceId: candidate, session: 'native-session', epoch: 0,
    clock: { mediaTimeMs: 1000, durationMs: 338000, playbackRate: 1, paused: false, contentActive: true } });
  await flush();
  assert.equal((await h.receive(query)).diagnostic.code, 'waiting-status');
  assert.equal((await h.receive({ ...query, type: 'verify-adapter-diagnostic', documentSession: previous.documentSession, diagnostic: previous.diagnostic })).ok, false);
  assert.ok(h.runtimeSent.some(m => m.type === 'status' && m.session.resourceId === 'av117224320801605:cid41641968199'));
  h.post({ type: 'unavailable', diagnostic }); await flush();
  assert.ok(h.runtimeSent.some(m => m.type === 'session-close'));
  assert.equal((await h.receive(query)).diagnostic.code, 'unsupported-version'); h.dispose();
});
