import * as performanceHistory from '../../src/translation/performance-history.ts';
import * as hybridCapacity from '../../src/translation/hybrid-capacity.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as config from '../../src/core/config.ts';
import * as messages from '../../src/core/messages.ts';
import * as resource from '../../src/core/resource.ts';
import * as metrics from '../../src/core/live-metrics.ts';
import * as diagnostics from '../../src/core/adapter-diagnostic.ts';
import * as videoPolicy from '../../src/core/video-policy.ts';
import * as timeoutRetry from '../../src/core/timeout-retry.ts';
import * as emotes from '../../src/platforms/bilibili-live/emotes.ts';
import * as provider from '../../src/translation/provider.ts';
import * as performanceTesting from '../../src/translation/performance-test.ts';
import * as connectionDiscovery from '../../src/translation/connection-discovery.ts';
import * as providerSettings from '../../src/local/provider-settings.ts';
import * as localConfig from '../../src/local/config.ts';
import * as translationProfile from '../../src/local/translation-profile.ts';
import * as autoLoad from '../../src/local/auto-load.ts';
import * as modelCatalog from '../../src/core/model-catalog.ts';
import * as serviceHistory from '../../src/core/service-history.ts';
import * as onlineBudget from '../../src/core/online-budget.ts';
import * as translationShortcut from '../../src/core/translation-shortcut.ts';
import * as settingsFrame from '../../src/core/settings-frame.ts';
import * as i18nWire from '../../src/i18n/wire.ts';
import * as auditRead from '../../src/diagnostics/bilibili-audit-cache.ts';
import * as userFilterWire from '../../src/platforms/bilibili/user-filter-wire.ts';
import * as shadow from '../../src/core/bilibili-shadow.ts';
import { LOCAL_CHANNEL } from '../../src/local/types.ts';
import { OWNED_SUPPLY_GRANT_KEY, OWNED_SUPPLY_GUARD_KEY } from '../../src/diagnostics/live-preview-host.ts';
import { onlineSettings } from '../fixtures/online-settings.mjs';

const compiled = ts.transpileModule(readFileSync(new URL('../../entrypoints/background.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const videoUrl = 'https://www.bilibili.com/video/BV1xx411c7mD/';
const session = { platform: 'bilibili', scenario: 'video', resourceId: 'av117318021548752:cid42173138507',
  urlResourceId: 'BV1xx411c7mD:p1', sessionId: 'planned-document', generation: 1 };
const firstId = messages.bilibiliSourceEventId(session.resourceId, '101');
const secondId = messages.bilibiliSourceEventId(session.resourceId, '102');
const baseSettings = onlineSettings({ enabled: true, bilibiliOwnedRelease: true,
  endpoint: 'https://provider.example/v1/chat/completions', sourceLanguage: 'ja' });
const flush = () => new Promise(resolve => setImmediate(resolve));

function background(options = {}) {
  let listener;
  const h = { calls: [], tabMessages: [], retired: [], cancelled: [], currentUrl: videoUrl,
    permissions: async () => true,
    local: { [config.SETTINGS_KEY]: { ...baseSettings } },
    sessionStorage: { [config.KEY_STORAGE_KEY]: { origin: 'https://provider.example', value: 'test-key' } },
    sender: { id: 'test-extension', frameId: 0, documentId: 'watch-doc', url: videoUrl, tab: { id: 7 } } };
  const storage = values => ({ setAccessLevel: async () => {}, get: async key => {
    const keys = typeof key === 'string' ? [key] : key;
    return Object.fromEntries(keys.map(name => [name, values[name]]));
  }, set: async patch => { await options.writeHook?.(patch, values === h.sessionStorage ? 'session' : 'local'); Object.assign(values, patch); }, remove: async key => {
    for (const name of Array.isArray(key) ? key : [key]) delete values[name];
  } });
  const browser = { runtime: { id: 'test-extension', getURL: path => `chrome-extension://test-extension${path}`,
    getManifest: () => ({ version: 'fixture' }), onMessage: { addListener: fn => { listener = fn; } },
    sendMessage: async () => {}, getPlatformInfo: async () => ({}) },
    commands: { onCommand: { addListener: () => {} } },
    storage: { local: storage(h.local), session: storage(h.sessionStorage), onChanged: { addListener: () => {} } },
    permissions: { contains: (...args) => h.permissions(...args) },
    tabs: { get: async tabId => {
      if (tabId === 7) return { id: 7, url: h.currentUrl };
      if (h.otherTabPresent) return { id: tabId, url: videoUrl };
      throw new Error('tab-closed');
    }, query: async () => [{ id: 7, url: h.currentUrl }],
    sendMessage: async (_id, message, options) => {
      h.tabMessages.push({ message, options });
      if (message.type === 'verify-resource-session') return { ok: true };
    }, onRemoved: { addListener: () => {} }, onUpdated: { addListener: () => {} } } };
  class Engine {
    translate(request) { h.calls.push(request); return h.translate ? h.translate(request) :
      Promise.resolve({ items: request.items.map(item => ({ id: item.id, status: 'translated', text: '译文' })) }); }
    cancelItems(signal, ids) { h.cancelled.push({ signal, ids }); }
    stats() { return options.engineStats?.() ?? {}; }
    resetFailureState() {}
    setLiveSession() {}
    hasLiveWork() { return false; }
  }
  class Cache { async stats() { return {}; } async clear() {} }
  class Host {
    constructor({ purpose }) { this.purpose = purpose; }
    get active() { return false; }
    async acceptsTransport() { return false; }
    async stopForTab() {}
    async stop() {}
    async status() { return { ok: true, grant: null }; }
    async retireOwned(grant) {
      h.retired.push({ ...grant });
      delete h.local[OWNED_SUPPLY_GUARD_KEY];
    }
  }
  const dependencies = {
    'wxt/browser': { browser }, 'wxt/utils/define-background': { defineBackground: fn => fn() },
    '../src/diagnostics/live-preview-host': { LivePreviewHost: Host, OWNED_SUPPLY_GRANT_KEY, OWNED_SUPPLY_GUARD_KEY,
      NATIVE_SUPPLY_GUARD_KEY: 'bilibiliNativeSupply.zeroTransport.v1' },
    '../src/diagnostics/bilibili-audit-cache': auditRead,
    '../src/platforms/bilibili/user-filter-wire': userFilterWire,
    '../src/core/build-identity': { BUILD_ID: 'fixture' }, '../src/i18n/wire.ts': i18nWire,
    '../src/core/config': config, '../src/core/messages': messages, '../src/core/resource': resource,
    '../src/core/live-metrics': metrics, '../src/core/adapter-diagnostic': diagnostics,
    '../src/core/video-policy': videoPolicy, '../src/core/bilibili-shadow': shadow,
    '../src/core/timeout-retry': timeoutRetry, '../src/local/config': localConfig,
    '../src/local/provider-settings': providerSettings, '../src/local/translation-profile': translationProfile,
    '../src/local/auto-load': autoLoad, '../src/core/model-catalog': modelCatalog,
    '../src/core/settings-frame': settingsFrame, '../src/core/service-history': serviceHistory,
    '../src/core/online-budget': onlineBudget, '../src/core/translation-shortcut': translationShortcut,
    '../src/platforms/bilibili-live/emotes': emotes,
    '../src/translation': { TranslationEngine: Engine, IndexedDbTranslationCache: Cache },
    '../src/translation/provider': provider, '../src/translation/model-test': {},
    '../src/translation/performance-history': performanceHistory,
    '../src/translation/hybrid-capacity': hybridCapacity,
    '../src/translation/performance-test': { ...performanceTesting, ...options.performanceTesting },
    '../src/translation/connection-discovery': connectionDiscovery,
    '../src/local/types': { LOCAL_CHANNEL }, '../src/local/bridge': {
      createLocalFetch: modelId => options.createLocalFetch?.(modelId, h) ?? (() => { throw new Error('unexpected local inference'); }),
      localControl: control => options.localControl?.(control, h) ?? Promise.reject(new Error('unexpected local control')),
    },
  };
  const exports = {};
  runInNewContext(compiled, { exports, Error, URL, AbortController, performance, crypto, TextEncoder,
    structuredClone, setTimeout, clearTimeout, setInterval, clearInterval,
    require: key => { if (!(key in dependencies)) throw new Error(`Unexpected import ${key}`); return dependencies[key]; } });
  h.send = (message, sender = h.sender) => new Promise(resolve => listener(message, sender, resolve));
  h.open = () => h.send({ type: 'session-open', session });
  return h;
}

function planned(overrides = {}) {
  const now = Date.now();
  const due = sourceId => ({ id: messages.bilibiliSourceEventId(session.resourceId, sourceId), sourceId,
    text: 'こんにちは', epoch: 3,
    predictionEpoch: 7, ruleRevision: 2, configIdentity: '0:1', remainingMs: 5000, deadlineAtEpochMs: now + 5000 });
  return { type: 'translate', resourceId: session.resourceId, session, configVersion: 0,
    requestId: crypto.randomUUID(), sentAt: performance.timeOrigin + performance.now(),
    planning: { epoch: 3, configIdentity: '0:1' }, priority: 'near',
    items: [due('101'), due('102')], ...overrides };
}

test('planned owned video uses ordinary settings, shared engine/cache and individual non-VOD deadlines', async () => {
  const h = background();
  assert.equal((await h.open()).ok, true);
  const message = planned();
  message.sentAt -= 600;
  message.items[0].remainingMs = 1000;
  message.items[0].deadlineAtEpochMs = Date.now() + 500;
  assert.equal((await h.send(message)).ok, true);
  assert.equal(h.calls.length, 1);
  const call = h.calls[0];
  assert.equal(call.mode, undefined);
  assert.equal(call.settings.endpoint, baseSettings.endpoint);
  assert.equal(call.apiKey, 'test-key');
  assert.equal(call.resourceId, resource.cacheResource(session));
  assert.equal(call.quotaScope, 'tab:7');
  assert.ok(call.items[0].deadlineAt - performance.now() <= 420);
  assert.ok(call.items[1].deadlineAt - performance.now() > 3000);
});

test('invalid planning identity, stale session and malformed due rows are rejected before the shared engine', async () => {
  const h = background(); await h.open();
  for (const mutate of [
    m => { m.planning.configIdentity = '0:2'; },
    m => { m.configVersion = 1; },
    m => { m.session = { ...session, generation: 2 }; },
    m => { m.items[0].epoch = 4; },
    m => { m.items[0].sourceId = ''; },
    m => { m.items[0].sourceId = '102'; },
    m => { m.items[0].configIdentity = '0:2'; },
    m => { m.items[0].deadlineAtEpochMs = Infinity; },
    m => { m.items[0].strategy = 'manual'; },
    m => { m.force = true; },
  ]) {
    const message = planned(); mutate(message);
    assert.equal((await h.send(message)).ok, false);
  }
  assert.equal(h.calls.length, 0);
});

test('planned translation requires the saved owned setting and skips model preparation when all deadlines expired', async () => {
  const off = background(); await off.open();
  off.local[config.SETTINGS_KEY].bilibiliOwnedRelease = false;
  assert.equal((await off.send(planned())).ok, false);
  assert.equal(off.calls.length, 0);

  const expired = background(); await expired.open();
  expired.local[config.SETTINGS_KEY].backend = 'local';
  expired.local[config.SETTINGS_KEY].localModelId = 'test-model';
  const message = planned();
  for (const item of message.items) {
    item.deadlineAtEpochMs = Date.now() - 10;
    item.remainingMs = 1;
  }
  const reply = await expired.send(message);
  assert.equal(reply.ok, true);
  assert.deepEqual(Array.from(reply.items, item => [item.id, item.status]),
    [[firstId, 'expired'], [secondId, 'expired']]);
  assert.equal(expired.calls.length, 0, 'no engine admission or local-model preparation');
});

test('one expired planned row does not discard its still-current sibling', async () => {
  const h = background(); await h.open();
  h.translate = async request => ({ items: request.items.map(item => item.deadlineAt <= performance.now()
    ? { id: item.id, text: item.text, status: 'expired', reason: 'deadline' }
    : { id: item.id, text: '译文', status: 'translated' }) });
  const message = planned();
  message.items[0].deadlineAtEpochMs = Date.now() - 10;
  message.items[0].remainingMs = 1;
  const reply = await h.send(message);
  assert.equal(reply.ok, true);
  assert.deepEqual(Array.from(reply.items, item => [item.id, item.status]),
    [[firstId, 'expired'], [secondId, 'translated']]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].mode, undefined);
});

test('planned result keeps due identity, then per-item cancellation rejects only the revoked subscriber', async () => {
  const h = background(); await h.open();
  let finish;
  h.translate = () => new Promise(resolve => { finish = resolve; });
  const message = planned();
  const pending = h.send(message); await flush();
  const call = h.calls[0];
  call.onResult({ id: firstId, text: '译文一', status: 'cached' }); await flush();
  assert.equal(h.tabMessages.filter(row => row.message.type === 'video-translation-result').length, 1);
  const delivered = h.tabMessages.at(-1).message;
  assert.equal(delivered.planning.configIdentity, '0:1');
  assert.equal(delivered.output.sourceId, '101');
  assert.equal(delivered.output.predictionEpoch, 7);
  assert.equal((await h.send({ type: 'cancel-video-items', requestId: message.requestId,
    session, ids: [firstId] })).ok, true);
  assert.deepEqual(h.cancelled[0].ids, [firstId]);
  assert.equal(h.cancelled[0].signal, call.signal);
  assert.equal(call.signal.aborted, false);
  call.onResult({ id: firstId, text: '过期译文', status: 'translated' });
  call.onResult({ id: secondId, text: '訳文二', status: 'translated' }); await flush();
  assert.deepEqual(h.tabMessages.filter(row => row.message.type === 'video-translation-result')
    .map(row => row.message.output.id), [firstId, secondId]);
  finish({ items: [] }); assert.equal((await pending).ok, true);
});

test('planned admission cancellation and navigation revoke the request before dispatch or delivery', async () => {
  const h = background(); await h.open();
  let releasePermission;
  h.permissions = () => new Promise(resolve => { releasePermission = resolve; });
  const blocked = planned();
  const admission = h.send(blocked); await flush();
  await h.send({ type: 'cancel', requestId: blocked.requestId });
  releasePermission(true);
  assert.equal((await admission).ok, false);
  assert.equal(h.calls.length, 0);

  // A result prepared by the shared engine is still bound to the current tab resource.
  h.permissions = async () => true;
  let finish;
  h.translate = () => new Promise(resolve => { finish = resolve; });
  const message = planned();
  const pending = h.send(message); await flush();
  h.currentUrl = 'https://www.bilibili.com/video/BV1xx411c7mE/';
  h.calls[0].onResult({ id: firstId, text: '过期译文', status: 'translated' }); await flush();
  assert.equal(h.tabMessages.filter(row => row.message.type === 'video-translation-result').length, 0);
  finish({ items: [] });
  assert.equal((await pending).ok, false);
});

test('retirement accepts only the current Bilibili content document and its same-tab or orphaned grant', async () => {
  const h = background(); await h.open();
  const retire = () => h.send({ type: 'bilibili-owned-supply-retire', session });
  assert.equal((await retire()).ok, true);
  const grant = { taskId: 'legacy-task', runId: 'legacy-run', instanceId: 'legacy-instance',
    tabId: 7, documentId: 'old-document', state: 'stopped' };
  h.local[OWNED_SUPPLY_GRANT_KEY] = grant;
  h.local[OWNED_SUPPLY_GUARD_KEY] = { enabled: true, kind: 'owned-supply', tabId: 7, runId: grant.runId };
  assert.equal((await retire()).ok, true);
  assert.equal(h.retired.length, 1);
  h.local[OWNED_SUPPLY_GRANT_KEY] = { ...grant, tabId: 8 };
  h.local[OWNED_SUPPLY_GUARD_KEY] = { enabled: true, kind: 'owned-supply', tabId: 8, runId: grant.runId };
  h.otherTabPresent = true;
  assert.equal((await retire()).ok, false);
  assert.equal(h.retired.length, 1);
  h.otherTabPresent = false;
  assert.equal((await retire()).ok, true);
  assert.equal(h.retired.length, 2);
  h.local[OWNED_SUPPLY_GUARD_KEY] = { enabled: true, kind: 'owned-supply', tabId: 8, runId: grant.runId };
  assert.equal((await h.send({ type: 'bilibili-owned-supply-retire', session },
    { ...h.sender, documentId: 'spoofed-document' })).ok, false);
  assert.equal(h.retired.length, 2);
});

const testUi = { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' };

for (const backend of ['local', 'online']) test(`hybrid background preserves saved ${backend} configuration and defers loading until cache misses`, async () => {
  const controls = [];
  const h = background({ localControl: async control => {
    controls.push(control);
    if (control.action === 'state') return { ok: true, state: { phase: 'idle' } };
    if (control.action === 'list') return { ok: true, models: [{ id: 'local-model', name: 'Hy-MT2' }] };
    throw Error('unexpected-model-load');
  } });
  Object.assign(h.local[config.SETTINGS_KEY], { backend, localModelId: 'local-model', localPreloadOnEntry: false,
    localConcurrency: 1, onlineConcurrency: 3, batchSize: 100, videoBatchSize: 20, translationStream: false });
  const identity = await hybridCapacity.hybridCapacityIdentity(config.normalizeSettings(h.local[config.SETTINGS_KEY]));
  h.local[config.SETTINGS_KEY].bilibiliHybrid = { enabled: true, adaptive: true, onlineStreaming: true,
    profiles: [{ identity, maxItems: 8, maxChars: 400, manual: true }] };
  assert.equal(await hybridCapacity.hybridCapacityIdentity(config.normalizeSettings(h.local[config.SETTINGS_KEY])), identity);
  await h.open();
  assert.equal((await h.send(planned())).ok, true);
  const route = h.calls[0].hybrid;
  assert.equal(route.localReady, false); assert.equal(route.onlineReady, true);
  assert.equal(route.local.concurrency, 1); assert.equal(route.online.concurrency, 3);
  assert.equal(route.local.batchSize, 1); assert.equal(route.online.backend, 'online');
  assert.equal(route.adaptive, true); assert.equal(route.onlineStreaming, true);
  assert.equal(route.local.translationStream, false); assert.equal(route.online.translationStream, true);
  assert.equal(route.online.batchSize, 20); assert.equal(route.capacityKey, identity);
  assert.equal(route.maxItems, 8); assert.equal(route.maxChars, 400);
  assert.equal(controls.every(control => ['state', 'list'].includes(control.action)), true);
  assert.equal(h.local[config.SETTINGS_KEY].backend, backend);
  assert.equal(h.local[config.SETTINGS_KEY].translationStream, false);
  assert.equal(h.calls[0].settings.translationStream, false);
  h.permissions = async () => false;
  await h.send(planned());
  assert.equal(h.calls[1].hybrid.onlineReady, false, 'revoked online permission does not reject local/cache admission');
  h.permissions = async () => true;
  h.translate = async request => ({ items: request.items.map(item => ({ ...item, status: 'failed', reason: 'http-403', backend: 'local' })) });
  await h.send(planned());
  h.translate = undefined;
  await h.send(planned());
  assert.equal(h.calls[3].hybrid.onlineReady, true, 'a local failure cannot reject the online credential');
  h.translate = async request => ({ items: request.items.map(item => ({ ...item, status: 'failed', reason: 'http-401', backend: 'online' })) });
  await h.send(planned());
  h.translate = undefined;
  await h.send(planned());
  assert.equal(h.calls[5].hybrid.onlineReady, false, 'an online credential failure disables only its lane');
});

test('hybrid streaming leaves ordinary video translation on the global streaming setting', async () => {
  const h = background();
  Object.assign(h.local[config.SETTINGS_KEY], { backend: 'online', translationStream: false,
    bilibiliHybrid: { enabled: true, adaptive: true, onlineStreaming: true, profiles: [] } });
  await h.open();
  const ordinary = planned();
  delete ordinary.planning;
  assert.equal((await h.send(ordinary)).ok, true);
  assert.equal(h.calls[0].hybrid, undefined);
  assert.equal(h.calls[0].settings.translationStream, false);
  assert.equal(h.local[config.SETTINGS_KEY].translationStream, false);
});

test('hybrid stream unsupported notice is shown only while hybrid streaming is enabled', async () => {
  const h = background({ engineStats: () => ({ lastError: { reason: 'hybrid-stream-unsupported' } }) });
  h.local[config.SETTINGS_KEY].bilibiliHybrid = { enabled: true, adaptive: false, onlineStreaming: true, profiles: [] };
  await h.open();
  const status = () => h.send({ type: 'status', session,
    status: { resourceId: session.resourceId, state: 'ready' } });
  assert.equal((await status()).engineNotice, 'hybrid-stream-unsupported');
  h.local[config.SETTINGS_KEY].bilibiliHybrid.onlineStreaming = false;
  assert.equal((await status()).engineNotice, '');
});

test('hybrid capacity lookup is settings-only, zero-load, and stale capacities cannot be saved', async () => {
  const h = background();
  const draft = { ...baseSettings, backend: 'local', localModelId: 'local-model' };
  assert.equal((await h.send({ type: 'hybrid-capacity', settings: draft })).ok, false);
  const reply = await h.send({ type: 'hybrid-capacity', settings: draft }, testUi);
  assert.equal(reply.ok, true); assert.equal(typeof reply.identity, 'string');
  assert.equal(reply.profile, undefined); assert.equal(reply.recommendation, undefined);
  const result = await h.send({ type: 'save', settings: { ...draft, bilibiliHybrid: { enabled: true, profiles: [] } } }, testUi);
  assert.equal(result.ok, false); assert.match(result.error, /容量/);
  assert.equal(h.calls.length, 0);
});
const replayConfig = { mode: 'latency', count: 1, concurrency: 1, batchSize: 1, arrivalIntervalMs: 0, strategy: 'normal' };

test('background saves completed model tests, reports storage failure and retries without rerunning translation', async () => {
  let calls = 0, failStorage = true;
  class RecordedPerformanceTest extends performanceTesting.PerformanceTest {
    constructor(config, settings, key, options) {
      super(config, settings, key, { ...options, fetch: async (_url, init) => {
        calls++;
        const body = JSON.parse(init.body);
        return Response.json({ choices: [{ message: { content: body.messages[1].content.split('\n').map(line => {
          const [id] = JSON.parse(line); return JSON.stringify([id, '测试译文']);
        }).join('\n') } }] });
      } });
    }
  }
  const h = background({ performanceTesting: { PerformanceTest: RecordedPerformanceTest },
    writeHook: async (patch) => { if (failStorage && Object.hasOwn(patch, performanceHistory.PERFORMANCE_HISTORY_KEY)) throw new Error('fixture storage unavailable'); },
  });
  assert.equal((await h.send({ type: 'performance-history' }, h.sender)).ok, false);
  const started = await h.send({ type: 'performance-start', settings: baseSettings, config: replayConfig }, testUi);
  assert.equal(started.ok, true);
  let status;
  for (let i = 0; i < 100; i++) {
    status = await h.send({ type: 'performance-status' }, testUi);
    if (status.saveState === 'failed') break;
    await flush();
  }
  assert.equal(status.report.state, 'completed'); assert.equal(status.saveState, 'failed');
  assert.equal((await h.send({ type: 'settings' }, testUi)).performancePaused, false);
  failStorage = false;
  assert.equal((await h.send({ type: 'performance-history-save' }, testUi)).ok, true);
  const history = await h.send({ type: 'performance-history' }, testUi);
  assert.equal(history.ok, true); assert.equal(history.records.length, 1); assert.equal(calls, 1);
  assert.equal(history.records[0].id, started.report.id);
  assert.equal(history.records[0].measurement.extensionVersion, 'fixture');
  assert.equal(history.records[0].timing.validItems, 1);
  const restored = new performanceHistory.PerformanceHistory({ get: async () => h.local, set: async () => {} });
  assert.equal((await restored.list())[0].id, started.report.id);
});

const localBatchSettings = { ...baseSettings, backend: 'local', localModelId: 'saved',
  liveSourceLanguage: 'ja', targetLanguage: 'zh-Hans',
  localPerformance: { ...localConfig.normalizeLocalConfig(), mode: 'custom', parallel: 2, promptMode: 'auto' } };

test('temporary online replay from saved local settings sends the draft model and records online history without changing selection', async () => {
  const requests = [], permissionChecks = [], localActions = [];
  class OfflineTransportPerformanceTest extends performanceTesting.PerformanceTest {
    constructor(config, settings, key, options) {
      super(config, settings, key, { ...options, fetch: async (url, init) => {
        const body = JSON.parse(init.body);
        requests.push({ url, authorization: init.headers.Authorization, body, localActionsAtSend: [...localActions] });
        return Response.json({ choices: [{ message: { content: body.messages[1].content.split('\n').map(line => {
          const [id] = JSON.parse(line); return JSON.stringify([id, '测试译文']);
        }).join('\n') } }] });
      } });
    }
  }
  const h = background({ performanceTesting: { PerformanceTest: OfflineTransportPerformanceTest },
    localControl: async control => {
      localActions.push(control.action);
      if (control.action !== 'state') throw new Error('online replay must not load a local model');
      return { ok: true, state: { phase: 'idle', queued: 0, active: 0 } };
    } });
  const saved = { ...localBatchSettings, model: 'Saved Model', thinkingEffort: 'default' };
  h.local[config.SETTINGS_KEY] = saved;
  h.permissions = async ({ origins }) => { permissionChecks.push([...origins]); return true; };
  const draft = { ...saved, backend: 'online', model: 'MiniMax-M3-Temporary', thinkingEffort: 'off' };
  const started = await h.send({ type: 'performance-start', settings: draft, config: replayConfig }, testUi);
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.batch, undefined); assert.equal(started.report.model, draft.model);
  await until(async () => (await h.send({ type: 'performance-status' }, testUi)).saveState === 'saved');
  const history = await h.send({ type: 'performance-history' }, testUi);
  assert.equal(history.ok, true); assert.equal(history.records.length, 1);
  assert.equal(history.records[0].id, started.report.id);
  assert.equal(history.records[0].backend, 'online'); assert.equal(history.records[0].model, draft.model);
  assert.equal(history.records[0].measurement.thinkingEffort, 'off');
  assert.equal(requests.length, 1); assert.equal(requests[0].url, draft.endpoint);
  assert.equal(requests[0].body.model, draft.model);
  assert.equal(requests[0].authorization, 'Bearer test-key');
  assert.deepEqual(permissionChecks, [['https://provider.example/*']]);
  assert.deepEqual(h.local[config.SETTINGS_KEY], saved);
  assert.equal(h.local[config.SETTINGS_KEY].backend, 'local');
  assert.equal(h.local[config.SETTINGS_KEY].localModelId, 'saved');
  assert.equal(h.local[config.SETTINGS_KEY].model, 'Saved Model');
  assert.ok(requests[0].localActionsAtSend.length > 0 && requests[0].localActionsAtSend.every(action => action === 'state'));

  h.permissions = async () => false;
  assert.equal((await h.send({ type: 'performance-start', settings: draft, config: replayConfig }, testUi)).ok, false);
  h.permissions = async () => true;
  const otherOrigin = { ...draft, endpoint: 'https://other-provider.example/v1/chat/completions' };
  assert.equal((await h.send({ type: 'performance-start', settings: otherOrigin, config: replayConfig }, testUi)).ok, false);
  assert.equal(requests.length, 1);
});

const deferred = () => {
  let resolve;
  return { promise: new Promise(done => { resolve = done; }), resolve: () => resolve() };
};
async function until(check) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await flush(); }
  assert.fail('background did not reach the expected phase');
}
function localBatchFixture(options = {}) {
  const events = [];
  const models = options.models ?? ['a', 'b'].map(id => ({ id, name: `Model ${id}`, availability: 'ready',
    translationProfile: id === 'b' ? 'translategemma' : 'seed-x' }));
  let generation = 0;
  let state = { phase: 'idle', generation, queued: 0, active: 0, inferenceCalls: 0 };
  class FakePerformanceTest extends performanceTesting.PerformanceTest {
    stopped = false;
    stop(reason) { this.stopped = true; super.stop(reason); options.onStop?.(this, events); }
    async run() {
      events.push(`test:${this.report.model}`);
      await options.onRun?.(this, events);
      this.report.state = this.stopped ? 'stopped' : 'completed';
      this.report.finishedAt = performance.now();
      return this.snapshot();
    }
  }
  const h = background({ performanceTesting: { PerformanceTest: FakePerformanceTest },
    createLocalFetch: () => async () => { throw new Error('fake replay should not use inference'); },
    localControl: async control => {
      events.push(`${control.action}${control.modelId ? ':' + control.modelId : ''}`);
      if (control.action === 'list') { await options.onList?.(); return { ok: true, models, state }; }
      if (control.action === 'state') return { ok: true, state };
      if (control.action === 'unload') {
        generation++;
        state = { phase: 'idle', generation, queued: 0, active: 0, inferenceCalls: 0 };
        await options.onUnload?.(events);
        return { ok: options.failUnloadAt !== events.filter(event => event === 'unload').length, state };
      }
      if (control.action === 'load') {
        generation++;
        const loadedGeneration = generation;
        state = { phase: 'loading', generation, queued: 0, active: 0, inferenceCalls: 0 };
        await options.onLoad?.(control, events);
        if (loadedGeneration !== generation) return { ok: false, error: 'LOCAL_MODEL_CHANGED', state };
        if (options.failLoad === control.modelId) return { ok: false, error: 'LOCAL_LOAD_FAILED', state };
        const model = models.find(model => model.id === control.modelId);
        state = { phase: 'ready', generation, model, queued: 0, active: 0, inferenceCalls: 0,
          runtime: localConfig.resolveLocalConfig(control.config, control.modelId) };
        return { ok: true, state };
      }
      throw new Error(`unexpected local action: ${control.action}`);
    }, writeHook: async (patch, area) => {
      if (area === 'session' && Object.hasOwn(patch, 'performancePause.v1')) {
        events.push('pause-write'); await options.onPause?.();
      }
      if (Object.hasOwn(patch, performanceHistory.PERFORMANCE_HISTORY_KEY)) {
        events.push('save'); await options.onSave?.(patch);
      }
    } });
  h.local[config.SETTINGS_KEY] = { ...localBatchSettings, localModelId: 'saved' };
  return { h, events };
}
const batchStart = (h, overrides = {}) => h.send({ type: 'performance-start', settings: localBatchSettings,
  config: replayConfig, modelIds: ['a', 'b'], ...overrides }, testUi);
const batchStatus = h => h.send({ type: 'performance-status' }, testUi);
async function batchDone(h) {
  await until(async () => (await batchStatus(h)).batch?.phase === 'done');
  return batchStatus(h);
}

test('local batch validates before loading, uses one lease, saves each model and preserves saved selection', async () => {
  const { h, events } = localBatchFixture();
  const invalid = await batchStart(h, { modelIds: ['a', 'a'] });
  assert.equal(invalid.ok, false); assert.equal(events.length, 0);
  const started = await batchStart(h);
  assert.equal(started.ok, true, JSON.stringify(started)); assert.equal(started.report, null);
  const done = await batchDone(h);
  assert.equal(done.batch.state, 'completed'); assert.equal(done.batch.completed, 2);
  assert.equal(done.batch.index, 1); assert.equal(done.batch.modelName, 'Model b'); assert.equal(done.batch.phase, 'done');
  assert.deepEqual(events.filter(event => /^(unload|load:|test:|save$)/.test(event)).slice(0, 8),
    ['unload', 'load:a', 'test:Model a', 'save', 'unload', 'load:b', 'test:Model b', 'save']);
  const history = await h.send({ type: 'performance-history' }, testUi);
  assert.equal(history.records.length, 2);
  assert.deepEqual(new Set(history.records.map(record => record.model)), new Set(['Model a', 'Model b']));
  assert.deepEqual(new Set(history.records.map(record => record.measurement.localTranslationProfile)), new Set(['seed-x', 'translategemma']));
  assert.equal(h.local[config.SETTINGS_KEY].localModelId, 'saved');
  assert.equal((await h.send({ type: 'settings' }, testUi)).performancePaused, false);
});

test('local batch stop during lease, model list, load, replay, save or switch never starts the next model', async t => {
  for (const phase of ['lease', 'list', 'load', 'run', 'save', 'unload']) await t.test(phase, async () => {
    const gate = deferred(); let held = false;
    const options = {
      onPause: phase === 'lease' ? () => gate.promise : undefined,
      onList: phase === 'list' ? () => { if (!held) { held = true; return gate.promise; } } : undefined,
      onLoad: phase === 'load' ? control => { if (control.modelId === 'a') return gate.promise; } : undefined,
      onRun: phase === 'run' ? () => gate.promise : undefined,
      onSave: phase === 'save' ? () => gate.promise : undefined,
      onUnload: phase === 'unload' ? events => events.filter(event => event === 'unload').length === 2 ? gate.promise : undefined : undefined,
    };
    const { h, events } = localBatchFixture(options);
    const started = await batchStart(h);
    assert.equal(started.ok, true, JSON.stringify(started));
    const target = { lease: 'pause-write', list: 'list', load: 'load:a', run: 'test:Model a', save: 'save', unload: 'unload' }[phase];
    await until(() => phase === 'unload' ? events.filter(event => event === target).length >= 2 : events.includes(target));
    if (phase === 'run') {
      const running = await batchStatus(h);
      assert.equal((await h.send({ type: 'performance-history-delete', ids: [running.report.id] }, testUi)).ok, false);
    }
    await h.send({ type: 'performance-stop' }, testUi);
    if (phase === 'load' || phase === 'run') await until(() => events.includes('unload'));
    gate.resolve();
    const done = await batchDone(h);
    assert.equal(done.batch.state, 'stopped');
    assert.equal(events.includes('load:b'), false);
    assert.equal((await h.send({ type: 'settings' }, testUi)).performancePaused, false);
  });
});

test('configuration change stops an in-flight local batch; failed save halts and retry does not replay', async () => {
  const gate = deferred();
  const active = localBatchFixture({ onLoad: control => control.modelId === 'a' ? gate.promise : undefined });
  await batchStart(active.h); await until(() => active.events.includes('load:a'));
  await active.h.send({ type: 'toggle', enabled: false }, testUi);
  gate.resolve();
  assert.equal((await batchDone(active.h)).batch.state, 'stopped');
  assert.equal(active.events.includes('load:b'), false);

  let failSave = true;
  const failed = localBatchFixture({ onSave: () => { if (failSave) throw new Error('storage down'); } });
  await batchStart(failed.h);
  const done = await batchDone(failed.h);
  assert.equal(done.batch.state, 'failed'); assert.equal(done.batch.errorCode, 'PERFORMANCE_BATCH_SAVE_FAILED');
  assert.equal(done.batch.modelId, 'a'); assert.equal(done.saveState, 'failed');
  assert.equal(failed.events.includes('load:b'), false);
  failSave = false;
  assert.equal((await failed.h.send({ type: 'performance-history-save' }, testUi)).ok, true);
  assert.equal(failed.events.filter(event => event === 'test:Model a').length, 1);
  assert.equal((await failed.h.send({ type: 'performance-history' }, testUi)).records.length, 1);
});

test('local batch reports the unavailable model and treats a failed final unload as failure', async () => {
  const missing = localBatchFixture({ models: [{ id: 'a', name: 'A', availability: 'ready' },
    { id: 'b', name: 'B', availability: 'permission-required' }] });
  await batchStart(missing.h);
  const invalid = await batchDone(missing.h);
  assert.equal(invalid.batch.state, 'failed'); assert.equal(invalid.batch.errorCode, 'PERFORMANCE_BATCH_MODEL_NOT_READY');
  assert.equal(invalid.batch.modelId, 'b'); assert.equal(missing.events.includes('load:a'), false);

  const unload = localBatchFixture({ failUnloadAt: 3 });
  await batchStart(unload.h, { modelIds: ['a'] });
  const failed = await batchDone(unload.h);
  assert.equal(failed.batch.state, 'failed'); assert.equal(failed.batch.errorCode, 'PERFORMANCE_BATCH_UNLOAD_FAILED');
});

test('history deletion is trusted-only and cannot resurrect a report while its save is pending', async () => {
  const gate = deferred();
  const { h, events } = localBatchFixture({ onSave: async () => gate.promise });
  await batchStart(h, { modelIds: ['a'] });
  await until(() => events.includes('save'));
  const current = await batchStatus(h);
  assert.equal((await h.send({ type: 'performance-history-delete', ids: [current.report.id] }, h.sender)).ok, false);
  const deletion = h.send({ type: 'performance-history-delete', ids: [current.report.id] }, testUi);
  gate.resolve();
  assert.equal((await deletion).ok, true);
  await batchDone(h);
  assert.equal((await h.send({ type: 'performance-history-save' }, testUi)).ok, false);
  assert.equal((await batchStatus(h)).saveState, 'deleted');
  assert.equal((await h.send({ type: 'performance-history' }, testUi)).records.some(row => row.id === current.report.id), false);
});

