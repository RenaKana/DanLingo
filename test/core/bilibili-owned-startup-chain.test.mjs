import * as performanceHistory from '../../src/translation/performance-history.ts';
import * as hybridCapacity from '../../src/translation/hybrid-capacity.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as config from '../../src/core/config.ts';
import * as resource from '../../src/core/resource.ts';
import * as metrics from '../../src/core/live-metrics.ts';
import * as messages from '../../src/core/messages.ts';
import * as scheduling from '../../src/core/scheduler.ts';
import * as sourceStream from '../../src/core/source-stream.ts';
import * as shadow from '../../src/core/bilibili-shadow.ts';
import * as videoPolicy from '../../src/core/video-policy.ts';
import * as timeoutRetry from '../../src/core/timeout-retry.ts';
import * as diagnostics from '../../src/core/adapter-diagnostic.ts';
import * as biliEmotes from '../../src/platforms/bilibili-live/emotes.ts';
import * as auditCache from '../../src/diagnostics/bilibili-audit-cache.ts';
import * as userFilterWire from '../../src/platforms/bilibili/user-filter-wire.ts';
import { createBilibiliShadowRules } from '../../src/platforms/bilibili/shadow-rules.ts';
import { USER_FILTER_NATIVE_CALLBACK, USER_FILTER_NATIVE_FUNCTIONS } from '../../src/platforms/bilibili/user-filter-contract.ts';
import * as i18nWire from '../../src/i18n/wire.ts';
import * as translation from '../../src/translation/index.ts';
import * as provider from '../../src/translation/provider.ts';
import * as modelTest from '../../src/translation/model-test.ts';
import * as performanceTest from '../../src/translation/performance-test.ts';
import * as connectionDiscovery from '../../src/translation/connection-discovery.ts';
import * as localConfig from '../../src/local/config.ts';
import * as localTypes from '../../src/local/types.ts';
import * as providerSettings from '../../src/local/provider-settings.ts';
import * as translationProfile from '../../src/local/translation-profile.ts';
import * as autoLoad from '../../src/local/auto-load.ts';
import * as modelCatalog from '../../src/core/model-catalog.ts';
import * as serviceHistory from '../../src/core/service-history.ts';
import * as onlineBudget from '../../src/core/online-budget.ts';
import * as shortcuts from '../../src/core/translation-shortcut.ts';
import * as settingsFrame from '../../src/core/settings-frame.ts';
import { LivePreviewHost, OWNED_SUPPLY_BUDGET_KEY, OWNED_SUPPLY_GRANT_KEY,
  NATIVE_SUPPLY_GUARD_KEY, OWNED_SUPPLY_GUARD_KEY } from '../../src/diagnostics/live-preview-host.ts';
import { NativeSupplyWatch } from '../../src/diagnostics/native-supply-watch.ts';
import * as experimentWatch from '../../src/diagnostics/bilibili-experiment-watch.ts';
import * as userFilterSimulation from '../../src/diagnostics/user-filter-simulation.ts';
import * as displayPlanSession from '../../src/diagnostics/display-plan-session.ts';
import { attachBilibiliNative, resolveBilibiliBinding } from '../../src/platforms/bilibili/video.ts';

const BUILD_ID = 'owned-chain-build';
const MODEL = { id: 'registered-hy-1-8b', name: 'Hy-MT2-1.8B-Q4', files: ['Hy-MT2-1.8B-Q4.gguf'],
  bytes: 1_800_000_000, architecture: 'hunyuan-dense', quantization: 'Q4', tokenizer: 'fixture',
  template: true, importedAt: 1, availability: 'ready', metadataVersion: 1, metadataComplete: true };
const VIDEO_URL = 'https://www.bilibili.com/video/BV1234567890';
const SESSION = { platform: 'bilibili', scenario: 'video', resourceId: 'av1:cid2',
  urlResourceId: 'BV1234567890:p1', sessionId: 'owned-chain', generation: 1 };
const compiled = ts.transpileModule(readFileSync(new URL('../../entrypoints/background.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const compiledWatch = ts.transpileModule(readFileSync(new URL('../../entrypoints/watch.content.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const clone = value => value === undefined ? undefined : structuredClone(value);
const nativeFunction = source => new Function(`return (${source})`)();
const nativeBlockMap = {
  blockScroll: [1], blockTopBottom: [5, 4],
  blockColor: [2012, 2015, 2007, 2008, 2009, 2013, 2002, 2003, 2000, 2001, 2004, 5, 4, 1, 6],
  blockSpecial: [2005, 2012, 2015, 2002, 2003, 2000, 2001, 2004, 2006, 2013, 2008, 2009, 2011, 2007, 2014, 2010, 3000, 2016, 2017, 2018, 2020],
  preventShade: [4],
};

function fixture({ planned = false, backend = 'local' } = {}) {
  const h = { messages: [], responses: [], pageMessages: [], controls: [], fetches: [], prepared: [], earlyPrepared: [],
    openTabs: new Map([[41, VIDEO_URL]]), currentTab: 41, currentDocument: 'document-41',
    session: clone(SESSION), local: new Map(), ephemeral: new Map(), epoch: 3 };
  h.settings = { ...config.DEFAULT_SETTINGS, enabled: planned, bilibiliOwnedRelease: true,
    backend, localModelId: MODEL.id, model: MODEL.id, sourceLanguage: 'ja', targetLanguage: 'zh',
    localPerformance: { ...config.DEFAULT_SETTINGS.localPerformance, mode: 'custom', parallel: 3,
      normalMaxTokens: 192, languageValidation: 'off', warmup: true } };
  h.local.set(config.SETTINGS_KEY, clone(h.settings));
  h.modelState = { phase: 'idle', generation: 0, inferenceCalls: 0, active: 0, queued: 0 };
  h.shortcuts = [{ name: 'toggle-translation', shortcut: 'Alt+T' }];
  const area = values => ({ async setAccessLevel() {},
    async get(keys) { return Object.fromEntries((typeof keys === 'string' ? [keys] : keys)
      .map(key => [key, clone(values.get(key))])); },
    async set(patch) { for (const [key, value] of Object.entries(patch)) values.set(key, clone(value)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key); },
  });
  let listener;
  h.browser = {
    runtime: { id: 'owned-chain-extension', getURL: path => `chrome-extension://owned-chain-extension${path}`,
      getManifest: () => ({ version: 'fixture' }), getPlatformInfo: async () => ({}),
      sendMessage: async () => ({}), onMessage: { addListener: callback => { listener = callback; } } },
    storage: { local: area(h.local), session: area(h.ephemeral), onChanged: { addListener() {} } },
    permissions: { contains: async () => true },
    commands: { getAll: async () => clone(h.shortcuts), onCommand: { addListener() {} } },
    tabs: { get: async id => {
      if (!h.openTabs.has(id)) throw new Error('tab-closed');
      return { id, url: h.openTabs.get(id) };
    }, query: async () => [], onRemoved: { addListener: callback => { h.remove = callback; } },
      onUpdated: { addListener() {} }, sendMessage: async (id, message, options) => {
        h.pageMessages.push({ id, message: clone(message), options: clone(options) });
        if (h.contentReceive) return h.contentReceive(message, { id: h.browser.runtime.id });
        if (message.type === 'verify-resource-session') return { ok: id === h.currentTab &&
          resource.sameSession(message.session, h.session) && options.frameId === 0 };
        if (message.type === 'bilibili-native-supply-proof') return h.watch.proof(message);
        if (message.type === 'bilibili-native-supply-result') {
          h.watch.acceptResult(message.requestId, message.output);
          const owner = h.demands.find(item => item.id === message.output.id);
          if (owner && message.output.status === 'translated') {
            h.watch.prepared([{ ...owner, text: message.output.text, status: message.output.status }]);
            h.earlyPrepared.push({ requestSettled: h.requestSettled, prepared: h.prepared.length });
          }
          return { ok: true };
        }
        return { ok: true };
      } },
  };
  h.sender = (id = h.currentTab, documentId = h.currentDocument) => ({ id: h.browser.runtime.id,
    tab: { id, url: h.openTabs.get(id) ?? VIDEO_URL }, frameId: 0, documentId, url: VIDEO_URL });
  h.send = (message, sender = h.sender()) => {
    const override = h.rpcOverride?.(message, sender);
    if (override !== undefined) return Promise.resolve(override);
    if (message.type === 'session-open' && h.contentReceive) h.session = clone(message.session);
    h.messages.push({ message: clone(message), sender: clone(sender) });
    return new Promise(resolve => listener(message, sender, response => {
      h.responses.push({ type: message.type, response: clone(response) }); resolve(response);
    }));
  };
  h.localControl = async control => {
    h.controls.push(clone(control));
    if (control.action === 'list') return { ok: true, models: [clone(MODEL)], state: clone(h.modelState) };
    if (control.action === 'state') return { ok: true, state: clone(h.modelState) };
    if (control.action === 'ensure' && h.ensureLoad) return h.ensureLoad;
    if (control.action === 'load') {
      assert.equal(control.modelId, MODEL.id);
      assert.equal(control.config.warmup, false);
      h.modelState = { ...h.modelState, phase: 'ready', generation: h.modelState.generation + 1,
        model: clone(MODEL), runtime: { ...localConfig.resolveLocalConfig(control.config, MODEL.id),
          kvUnified: true, continuousBatching: true }, warmupMs: 0 };
      return { ok: true, state: clone(h.modelState) };
    }
    if (control.action === 'unload') {
      h.modelState = { ...h.modelState, phase: 'idle', generation: h.modelState.generation + 1,
        model: undefined, runtime: undefined, inferenceCalls: 0 };
      return { ok: true, state: clone(h.modelState) };
    }
    throw new Error(`Unexpected local control ${control.action}`);
  };
  h.createLocalFetch = (_modelId, gate) => async (_url, init) => {
    const attemptId = `attempt-${h.fetches.length + 1}`;
    await gate?.beforeSend(attemptId, init.signal);
    gate?.sent?.(attemptId);
    h.fetches.push(JSON.parse(init.body)); h.modelState.inferenceCalls++;
    if (h.localReplyGate) await h.localReplyGate;
    if (h.failLocalFetch) throw new Error('fixture-local-interface-unavailable');
    return new Response(JSON.stringify({ choices: [{ message: { content: h.replyText ?? '你好世界' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const imports = {
    '../src/i18n/wire.ts': i18nWire, '../src/core/build-identity': { BUILD_ID },
    '../src/platforms/bilibili/user-filter-wire': userFilterWire,
    '../src/diagnostics/bilibili-audit-cache': auditCache,
    '../src/diagnostics/live-preview-host': { LivePreviewHost, NATIVE_SUPPLY_GUARD_KEY, OWNED_SUPPLY_GUARD_KEY },
    'wxt/browser': { browser: h.browser }, 'wxt/utils/define-background': { defineBackground: fn => fn() },
    '../src/core/config': config, '../src/core/resource': resource, '../src/core/messages': messages,
    '../src/core/live-metrics': metrics,
    '../src/core/video-policy': videoPolicy, '../src/core/timeout-retry': timeoutRetry,
    '../src/platforms/bilibili-live/emotes': biliEmotes, '../src/core/adapter-diagnostic': diagnostics,
    '../src/translation': translation, '../src/translation/provider': provider,
    '../src/translation/model-test': modelTest, '../src/translation/performance-history': performanceHistory,
    '../src/translation/hybrid-capacity': hybridCapacity,
    '../src/translation/performance-test': performanceTest,
    '../src/local/bridge': { createLocalFetch: h.createLocalFetch, localControl: h.localControl },
    '../src/local/config': localConfig, '../src/local/types': localTypes,
    '../src/local/provider-settings': providerSettings, '../src/local/translation-profile': translationProfile,
    '../src/local/auto-load': autoLoad, '../src/core/model-catalog': modelCatalog,
    '../src/core/service-history': serviceHistory, '../src/core/online-budget': onlineBudget,
    '../src/core/translation-shortcut': shortcuts, '../src/core/settings-frame': settingsFrame,
    '../src/translation/connection-discovery': connectionDiscovery,
  };
  runInNewContext(compiled, { exports: {}, URL, Response, Error, AbortController, performance,
    crypto, TextEncoder, structuredClone, setTimeout, clearTimeout, setInterval, clearInterval,
    require: key => { assert.ok(key in imports, `Unexpected import ${key}`); return imports[key]; } });
  h.context = { ready: true, epoch: h.epoch, configVersion: 0, visible: true, session: h.session,
    settings: h.settings, clock: { mediaTimeMs: 120_000, paused: true, seeking: false,
      playbackRate: 2, contentActive: true } };
  h.context.video = { duration: 1200, pause() { h.context.clock.paused = true; },
    async play() { h.context.clock.paused = false; },
    get currentTime() { return h.context.clock.mediaTimeMs / 1000; },
    set currentTime(seconds) { h.context.clock.mediaTimeMs = seconds * 1000; } };
  h.demands = [{ id: 'd-1', sourceId: 'source-1', originalText: 'こんにちは世界',
    mediaTimeMs: 125_000, deadlineAtEpochMs: Date.now() + 30_000,
    epoch: h.epoch, predictionEpoch: 7, ruleRevision: 1 }];
  h.newWatch = () => new NativeSupplyWatch({ buildId: BUILD_ID, context: () => h.context,
    demands: () => h.demands, rpc: message => h.send(message), configure: () => {},
    control: () => {}, send: message => h.prepared.push(message), original: () => undefined,
    close: () => {} });
  h.watch = h.newWatch();
  if (!planned) h.watch.armSetting();
  return h;
}

test('owned-start crosses the actual background route and returns a qualified prepared item', async () => {
  const h = fixture();
  const started = await h.watch.action('owned-start');
  assert.equal(started.state, 'running');
  assert.equal(h.messages[0].message.type, 'session-open');
  assert.equal(h.messages.filter(row => row.message.type === 'session-open').length, 2);
  assert.deepEqual(h.messages.filter(row => row.message.type === 'bilibili-owned-supply-host')
    .map(row => row.message.action), ['status', 'prepare', 'start']);
  assert.equal(h.controls.filter(row => row.action === 'load').length, 1);
  assert.equal(h.fetches.length, 0, 'preparing and starting cannot transmit');
  const received = [];
  const item = h.demands[0];
  h.requestSettled = false;
  const outputs = await h.watch.request([{ ...item, text: item.originalText }],
    new AbortController().signal, output => received.push(output))
    .finally(() => { h.requestSettled = true; });
  assert.equal(outputs[0].status, 'translated', JSON.stringify({ outputs, fetches: h.fetches,
    messages: h.messages.map(row => row.message.action ?? row.message.type), pageMessages: h.pageMessages.map(row => row.message.type) }));
  assert.deepEqual([...new Set(received.filter(output => output.status === 'translated').map(output => output.id))], [item.id]);
  assert.ok(h.pageMessages.some(row => row.message.type === 'bilibili-native-supply-result'));
  assert.deepEqual(h.earlyPrepared, [{ requestSettled: false, prepared: 1 }],
    'the page result must prepare the item before translate returns its final response');
  assert.equal(h.prepared.length, 1);
  assert.equal(h.prepared[0].items[0].text, '你好世界');
  assert.equal(h.fetches.length, 1);
  const status = await h.watch.host('status');
  assert.equal(status.budget.total.actualSent.requests, 1);
  assert.ok(h.local.has(OWNED_SUPPLY_BUDGET_KEY));
});

test('wrong document and live other-tab ownership cannot take over a stopped task; orphan keeps its ledger', async () => {
  const h = fixture();
  await h.watch.action('owned-start');
  const item = h.demands[0];
  assert.equal((await h.watch.request([{ ...item, text: item.originalText }],
    new AbortController().signal, () => {}))[0].status, 'translated');
  const grant = clone(h.local.get(OWNED_SUPPLY_GRANT_KEY));
  const wrongDocument = await h.send({ type: 'bilibili-owned-supply-host', action: 'translate',
    runId: grant.runId, instanceId: grant.instanceId, epoch: grant.epoch, requestId: 'wrong-doc', items: [] },
  h.sender(41, 'old-document'));
  assert.equal(wrongDocument.ok, false);
  assert.equal(wrongDocument.error, 'owned-supply-content-owner-required');
  await h.watch.host('stop');
  assert.equal(h.local.get(OWNED_SUPPLY_GRANT_KEY).state, 'stopped');
  h.openTabs.set(42, VIDEO_URL);
  h.currentTab = 42; h.currentDocument = 'document-42';
  h.session = { ...SESSION, sessionId: 'new-document', generation: 2 };
  h.context.session = h.session; h.context.epoch = 4;
  h.watch = h.newWatch(); h.watch.armSetting();
  assert.equal((await h.send({ type: 'session-open', session: h.session })).ok, true);
  const otherTab = await h.watch.host('status');
  assert.equal(otherTab.ownerScope, 'other-tab');
  await assert.rejects(h.watch.action('owned-start'), /另一个视频页/);
  const forbidden = await h.send({ type: 'bilibili-owned-supply-host', action: 'retire-stopped',
    previous: { taskId: grant.taskId, runId: grant.runId, instanceId: grant.instanceId } });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.error, 'owned-supply-retired-owner-required');
  assert.equal(h.local.get(OWNED_SUPPLY_GRANT_KEY).reason, 'manual');
  h.openTabs.delete(41);
  assert.equal((await h.watch.host('status')).ownerScope, 'orphaned');
  const wrongIdentity = await h.send({ type: 'bilibili-owned-supply-host', action: 'retire-stopped',
    previous: { taskId: grant.taskId, runId: grant.runId, instanceId: 'different-instance' } });
  assert.equal(wrongIdentity.ok, false);
  assert.equal(wrongIdentity.error, 'owned-supply-retired-owner-required');
  assert.equal(h.local.get(OWNED_SUPPLY_GRANT_KEY).reason, 'manual');
  const resumed = await h.watch.action('owned-start');
  assert.equal(resumed.state, 'running');
  const next = h.local.get(OWNED_SUPPLY_GRANT_KEY);
  assert.equal(next.taskId, grant.taskId);
  assert.equal(next.runId, grant.runId);
  assert.notEqual(next.instanceId, grant.instanceId);
  assert.equal(next.tabId, 42);
  assert.equal((await h.watch.host('status')).budget.total.actualSent.requests, 1);
  assert.equal(h.fetches.length, 1, 'restart must not infer before a new subscription');
  assert.deepEqual(h.messages.filter(row => row.message.action === 'retire-stopped').map(row => row.message.previous?.instanceId),
    [grant.instanceId, 'different-instance', grant.instanceId]);
});

test('a foreign tab cannot stop a current owner', async () => {
  const h = fixture(); await h.watch.action('owned-start');
  const grant = h.local.get(OWNED_SUPPLY_GRANT_KEY);
  h.openTabs.set(42, VIDEO_URL);
  const otherTab = await h.send({ type: 'bilibili-owned-supply-host', action: 'stop',
    runId: grant.runId, instanceId: grant.instanceId }, h.sender(42, 'document-42'));
  assert.equal(otherTab.ok, false);
  assert.equal(otherTab.error, 'owned-supply-content-owner-required');
  assert.equal(h.local.get(OWNED_SUPPLY_GRANT_KEY).state, 'running');
  assert.equal(h.fetches.length, 0);
});

test('a new document in the same tab cleans the stopped grant before rebinding', async () => {
  const h = fixture();
  await h.watch.action('owned-start');
  const prior = clone(h.local.get(OWNED_SUPPLY_GRANT_KEY));
  await h.watch.host('stop');
  h.currentDocument = 'replacement-document';
  h.session = { ...SESSION, sessionId: 'replacement-session', generation: 2 };
  h.context.session = h.session; h.context.epoch = 4;
  h.watch = h.newWatch(); h.watch.armSetting();
  assert.equal((await h.send({ type: 'session-open', session: h.session })).ok, true);
  assert.equal((await h.watch.host('status')).ownerScope, 'same-tab-retired');
  assert.equal((await h.watch.action('owned-start')).state, 'running');
  const next = h.local.get(OWNED_SUPPLY_GRANT_KEY);
  assert.equal(next.taskId, prior.taskId);
  assert.equal(next.runId, prior.runId);
  assert.equal(next.documentId, h.currentDocument);
  assert.ok(h.messages.some(row => row.message.action === 'cleanup'));
  assert.ok(h.messages.some(row => row.message.action === 'prepare'));
  assert.equal(h.messages.some(row => row.message.action === 'resume'), false);
  assert.equal(h.fetches.length, 0);
});

function installNativePipeline(h) {
  h.mono = 10_000;
  const playbackCalls = { pause: 0, play: 0, seek: 0 };
  const pool = [{ dmid: '1', text: 'こんにちは世界', stime: 124.5, mode: 1, rawMode: 1,
    pool: 0, uhash: 'original-author', size: 25, color: 16777215, weight: 20 },
  ...Array.from({ length: 219 }, (_, index) => ({ dmid: String(index + 2),
    text: `遠方の本文${index}`, stime: 200 + index, mode: 1, rawMode: 1, pool: 0,
    uhash: `far-author-${index}`, size: 25, color: 16777215, weight: 20 }))];
  Object.assign(pool[0], h.nativeFirstRow);
  if (h.nativeSecondRow) Object.assign(pool[1], h.nativeSecondRow);
  for (const [index, time] of h.nearRows ?? []) pool[index].stime = time;
  const timeline = structuredClone(pool);
  const filtered = [], models = [], nativeMessages = [], contentMessages = [], videoHandlers = new Map();
  const setting = { visible: true, area: 100, fontSize: 1, limit: 300, preTime: 1,
    noDanmakuXTypes: [] };
  const video = { dataset: {}, currentTime: 120, duration: 600, playbackRate: 1, paused: false,
    seeking: false, readyState: 4, ended: false, isConnected: true, played: { length: 1 },
    buffered: { length: 0 }, matches: selector => selector === 'video',
    closest: selector => selector.includes('data-player-layout') ? video : null,
    pause() { playbackCalls.pause++; this.paused = true; },
    async play() { playbackCalls.play++; this.paused = false; },
    addEventListener: (kind, callback) => videoHandlers.set(kind, callback),
    removeEventListener: kind => videoHandlers.delete(kind) };
  let mediaTime = video.currentTime;
  Object.defineProperty(video, 'currentTime', { get: () => mediaTime,
    set: value => { playbackCalls.seek++; mediaTime = value; } });
  const manager = { config: { setting }, containerSize: { width: 500, height: 280 },
    container: { ownerDocument: { hidden: false } },
    dataBase: { dmArray: pool, timeLine: { list: timeline } }, lastTime: 0,
    cDmlist: [], visualArray: [], validate() { return true; },
    fetchAndInitDm(render) {
      const nativeCandidates = this.dataBase.timeLine.list.filter(row =>
        row.stime >= render && row.stime < render + setting.preTime);
      this.insert(nativeCandidates);
      this.lastTime = render + setting.preTime;
      return 'fetched';
    },
    insert(entries) {
      danmaku.hooks.beforeRender([], entries.slice());
      for (const source of entries) {
        filtered.push({ text: source.text, author: source.uhash, source });
        if (!this.validate(source) || source.on) continue;
        source.on = true;
        this.initRender(source);
      }
    },
    initRender(source) {
      const model = { textData: source, text: source.text, firstShow() { return 'shown'; } };
      models.push(model); this.cDmlist.push(model); return model;
    },
  };
  let blockStore;
  const danmaku = { manager, config: { setting }, timeController: { renderTime: 0, lastFetchDmTime: 0 },
    isRunning: true, hooks: { beforeRender(_active, entries) {
      if (!blockStore) return;
      for (const item of entries) {
        const history = blockStore.dmMap.get(item.dmid);
        if (!history?.modeStack?.length) continue;
        const state = blockStore.dmSettingStore.state;
        const lastMode = history.modeStack.at(-1).mode;
        if (nativeBlockMap.blockTopBottom.includes(lastMode) &&
            history.blockTopBottom !== !state.typeTopBottom) {
          history.index += state.typeTopBottom ? 1 : -1;
          const projected = history.modeStack[history.index];
          item.mode = projected.mode;
          item.rawMode = projected.rawMode;
          history.blockTopBottom = !state.typeTopBottom;
        }
        if (history.blockColor !== !state.typeColor) {
          item.color = state.typeColor ? history.color : 0xffffff;
          history.blockColor = !state.typeColor;
        }
      }
    } }, clear() { manager.cDmlist.length = 0; },
    getMetadata: () => ({ version: '1.1.24', lastCompiled: '2026-09-10T15:18:49+08:00' }) };
  const player = { getManifest: () => ({ aid: '1', cid: '2', bvid: 'BV1234567890', p: 1 }),
    danmaku: { getDanmakuX: () => danmaku }, mediaElement: () => video };
  if (h.nativeModeStack) {
    const dmSettingStore = { state: { status: true, dmarea: 50, dmdensity: 1,
      typeScroll: true, typeTopBottom: true, typeColor: h.nativeTypeColor ?? true, typeSpecial: true,
      seniorMode: false, preventshade: false } };
    blockStore = { blockList: [], reportFilter: [], dmMap: new Map([['1', h.nativeModeStack]]),
      DmBlockMap: nativeBlockMap, dmSettingStore,
      aiJudge: nativeFunction('function(n,r){return this.totalFiltleredDm+=1,Math.abs(n.weight)<r&&(this.aiCloudBlockCount+=1,!0)}'),
      reportFilterReg: nativeFunction('function(n){var r;return null!=(r=this.reportFilter)&&!!r.length&&this.reportFilter.some(function(r){if(new RegExp(r).test(n.text))return!0})}'),
    };
    for (const [name, source] of Object.entries(USER_FILTER_NATIVE_FUNCTIONS))
      blockStore[name] = nativeFunction(source);
    manager.config.scene = { isMini: false };
    manager.config.fn = { filter: nativeFunction(USER_FILTER_NATIVE_CALLBACK) };
    player.rootStore = { rootPlayer: player, danmakuStore: { danmakuX: danmaku },
      blockStore, dmSettingStore };
  }
  const binding = resolveBilibiliBinding(player, VIDEO_URL);
  assert.ok(binding);
  const rules = blockStore ? createBilibiliShadowRules({ player, danmaku,
    documentScope: 'owned-chain-native-rules', now: () => h.mono,
    allowPartialUserRules: () => true }) : { read: () => ({ known: true, revision: 4, fingerprint: 'partial-user-v4',
    nativeSettings: { visible: true }, match: source => source.dmid === '1'
      ? { state: 'unknown', reason: 'user-sender-partial' }
      : { state: 'retain', reason: 'allowed' }, ...h.rulesSnapshot }) };
  h.nativeRules = rules;
  const handlers = new Map(), docHandlers = new Map();
  const location = { href: VIDEO_URL, origin: 'https://www.bilibili.com' };
  const window = { addEventListener: (kind, callback) => handlers.set(kind, callback),
    removeEventListener() {}, postMessage(data) {
      if (data.from === 'content') { contentMessages.push(data); h.attachment?.onMessage({ data }); }
    } };
  const document = { visibilityState: 'visible', hidden: false,
    addEventListener: (kind, callback) => docHandlers.set(kind, callback), removeEventListener() {},
    querySelector: selector =>
    selector.includes('data-danlingo-player') && video.dataset.danlingoPlayer ? video : null,
    createElement: () => ({ style: {}, append() {}, hidden: false }),
    querySelectorAll: selector => selector === '[data-danlingo-player]' ? [video] : [] };
  manager.container.ownerDocument = document;
  const contentBrowser = { runtime: { id: h.browser.runtime.id, getManifest: () => ({ version: 'fixture' }),
    onMessage: { addListener: callback => { h.contentReceive = callback; }, removeListener() {} },
    sendMessage: message => h.send(message) } };
  const dependencies = {
    'wxt/browser': { browser: contentBrowser },
    'wxt/utils/define-content-script': { defineContentScript: value => value },
    '../src/diagnostics/native-supply-watch': { NativeSupplyWatch },
    '../src/core/config': config, '../src/core/messages': messages,
    '../src/core/scheduler': { ...scheduling, VideoScheduler: class extends scheduling.VideoScheduler {
      constructor(options) { super({ ...options, now: () => h.mono, nowEpochMs: () => Date.now() }); h.scheduler = this; }
    } },
    '../src/core/bilibili-shadow': shadow, '../src/core/source-stream': sourceStream,
    '../src/core/video-policy': videoPolicy, '../src/platforms/niconico/native': { BRIDGE: 'danlingo.native.v1' },
    '../src/core/resource': resource, '../src/core/adapter-diagnostic': diagnostics,
    '../src/core/build-identity': { BUILD_ID },
    '../src/i18n/text.ts': { t: id => id === 'watch.enableTranslation' ? '请启用翻译' : id },
    '../src/ui/localized-text': { bindLocalizedText: (node, render) => { node.textContent = render(); } },
    '../src/ui/bilibili-fullscreen-toggle': { mountBilibiliFullscreenToggle: () => ({ update() {}, dispose() {} }) },
    '../src/ui/progress': { createProgress: () => (h.progress = {
      nativeSupplyButton: {}, updateNativeSupply(view) { this.nativeSupplyView = view; },
      nativeSupplyHost: { style: {}, children: [], append(...children) { this.children.push(...children); } },
      attach() {}, update(...args) { this.message = args[2]; }, dispose() {} }) },
    '../src/ui/render-preview': { mountRenderPreview() { throw Error('render preview outside owned test'); } },
    '../src/i18n/wire.ts': i18nWire,
    '../src/diagnostics/bilibili-experiment-watch': experimentWatch,
    '../src/platforms/bilibili/user-filter-wire': userFilterWire,
    '../src/diagnostics/user-filter-simulation': userFilterSimulation,
    '../src/diagnostics/display-plan-session': displayPlanSession,
  };
  const exports = {};
  runInNewContext(compiledWatch, { exports, Error, URL, AbortController, crypto, TextEncoder,
    structuredClone, setTimeout, clearTimeout, setInterval, clearInterval,
    performance: { now: () => h.mono }, location, window, document,
    require: key => { assert.ok(key in dependencies, `Unexpected content import ${key}`); return dependencies[key]; } });
  h.attachment = attachBilibiliNative(binding, { now: () => h.mono, epochNow: () => Date.now(),
    shadowRules: rules, post: message => {
      nativeMessages.push(message);
      handlers.get('message')?.({ source: window, origin: location.origin, data: message });
    } });
  exports.default.main({ setInterval: callback => { h.contentTick = callback; return 1; },
    onInvalidated: () => {} });
  h.native = { pool, timeline, setting, video, videoHandlers, manager, document, docHandlers,
    filtered, models, nativeMessages, contentMessages, playbackCalls,
    stop: () => h.attachment.stop() };
  return h.native;
}

async function openPlannedPipeline(t, settingsPatch = {}, setup = () => {}) {
  const h = fixture({ planned: true });
  h.settings = { ...h.settings, ...settingsPatch };
  h.local.set(config.SETTINGS_KEY, clone(h.settings));
  h.context.settings = h.settings;
  h.modelState = { phase: 'ready', generation: 1, inferenceCalls: 0, active: 0, queued: 0,
    model: clone(MODEL), requested: localConfig.normalizeLocalConfig(h.settings.localPerformance),
    runtime: { ...localConfig.resolveLocalConfig(h.settings.localPerformance, MODEL.id),
      kvUnified: true, continuousBatching: true }, warmupMs: 0 };
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const previousFetch = globalThis.fetch;
  let externalFetches = 0;
  globalThis.fetch = async (...args) => {
    if (h.onlineTransport) return h.onlineTransport(...args);
    externalFetches++; throw Error('external fetch forbidden');
  };
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: VIDEO_URL } });
  t.after(() => {
    h.native?.stop();
    globalThis.fetch = previousFetch;
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
    else delete globalThis.location;
  });
  await setup(h);
  const native = installNativePipeline(h);
  return { h, native, externalFetches: () => externalFetches };
}

async function tickPlanned(h, until = () => false) {
  for (let n = 0; n < 30; n++) {
    h.attachment.tick();
    h.contentTick();
    await new Promise(resolve => setImmediate(resolve));
    if (until()) break;
    if (n % 5 === 4) await new Promise(resolve => setTimeout(resolve, 100));
    h.mono += 100;
  }
}

function fixedEpochClock(t) {
  const originalNow = Date.now;
  let current = originalNow();
  Date.now = () => current;
  t.after(() => { Date.now = originalNow; });
  return { now: () => current, advance: ms => { current += ms; } };
}

const ownedUpdates = native => native.nativeMessages.filter(row =>
  row.type === 'bilibili-shadow' && row.policy === 'owned');

async function configureHybridFixture(h, maxChars = 1000) {
  h.settings = { ...h.settings, endpoint: 'https://hybrid.invalid/v1/chat/completions', model: 'fixture-online',
    localPreloadOnEntry: false, thinkingEffort: 'default' };
  const identity = await hybridCapacity.hybridCapacityIdentity(config.normalizeSettings(h.settings));
  h.settings.bilibiliHybrid = { enabled: true, profiles: [{ identity, maxItems: 10, maxChars, manual: true }] };
  h.local.set(config.SETTINGS_KEY, clone(h.settings));
  h.ephemeral.set(config.KEY_STORAGE_KEY, { origin: 'https://hybrid.invalid', value: 'fixture-key' });
  h.onlineFetches = [];
  h.onlineTransport = async (url, init) => {
    assert.equal(String(url), 'https://hybrid.invalid/v1/chat/completions');
    const body = JSON.parse(init.body);
    h.onlineFetches.push(body);
    const envelope = JSON.parse(body.messages[1].content);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ items: envelope.items.map(item => ({ id: item.id, text: '在线你好世界' })) }) } }] });
  };
}

for (const lane of ['local', 'online']) test(`hybrid ${lane} crosses watch, shared engine and MAIN without playback writes`, async t => {
  const { h, native, externalFetches } = await openPlannedPipeline(t, {}, async h => {
    await configureHybridFixture(h, lane === 'local' ? 1000 : 1);
  });
  await tickPlanned(h, () => native.contentMessages.some(row => row.type === 'prepared' && row.plannedSupply));
  const prepared = native.contentMessages.find(row => row.type === 'prepared' && row.plannedSupply);
  assert.ok(prepared, JSON.stringify(h.responses.filter(row => row.type === 'translate')));
  assert.equal(h.fetches.length, lane === 'local' ? 1 : 0);
  assert.equal(h.onlineFetches.length, lane === 'online' ? 1 : 0);
  const delivery = h.pageMessages.find(row => row.message.type === 'video-translation-result');
  assert.equal(delivery.message.output.backend, lane);
  assert.deepEqual(native.playbackCalls, { pause: 0, play: 0, seek: 0 });
  native.video.currentTime = 124; h.mono += 4000;
  native.manager.fetchAndInitDm(124);
  assert.equal(native.models[0]?.text, lane === 'local' ? '你好世界' : '在线你好世界');
  assert.equal(native.filtered[0]?.text, 'こんにちは世界');
  assert.equal(native.filtered[0]?.author, 'original-author');
  assert.equal(externalFetches(), 0);
});

test('hybrid online result reaches MAIN while the permitted local load is still pending', async t => {
  let finishLoad;
  const { h, native, externalFetches } = await openPlannedPipeline(t, {}, async h => {
    await configureHybridFixture(h);
    const readyState = clone(h.modelState);
    h.modelState = { phase: 'idle', generation: 1, inferenceCalls: 0, active: 0, queued: 0 };
    h.ensureLoad = new Promise(resolve => { finishLoad = () => resolve({ ok: true, state: readyState }); });
    t.after(() => finishLoad());
  });
  await tickPlanned(h, () => native.contentMessages.some(row => row.type === 'prepared' && row.plannedSupply));
  assert.equal(h.onlineFetches.length, 1);
  assert.equal(h.fetches.length, 0);
  assert.equal(h.controls.filter(control => control.action === 'ensure').length, 1);
  assert.equal(h.pageMessages.find(row => row.message.type === 'video-translation-result')?.message.output.backend, 'online');
  assert.equal(native.contentMessages.find(row => row.type === 'prepared' && row.plannedSupply)?.items[0].text, '在线你好世界');
  assert.deepEqual(native.playbackCalls, { pause: 0, play: 0, seek: 0 });
  assert.equal(externalFetches(), 0);
  finishLoad();
  await new Promise(resolve => setImmediate(resolve));
  await tickPlanned(h);
  assert.equal(h.onlineFetches.length, 1); assert.equal(h.fetches.length, 0, 'no migration or duplicate calculation after readiness');
});

test('hybrid shared text survives one event revocation and only the remaining event reaches MAIN', async t => {
  let releaseReply;
  const replyGate = new Promise(resolve => { releaseReply = resolve; });
  const { h, native, externalFetches } = await openPlannedPipeline(t, {}, async fixture => {
    await configureHybridFixture(fixture);
    fixture.nativeSecondRow = { text: 'こんにちは世界', stime: 124.6 };
    fixture.localReplyGate = replyGate;
  });
  t.after(() => releaseReply());
  await tickPlanned(h, () => h.fetches.length === 1 &&
    h.messages.some(row => row.message.type === 'translate' && row.message.planning?.selectedCount === 2));
  const planned = h.messages.find(row => row.message.type === 'translate' && row.message.planning)?.message;
  assert.deepEqual(planned?.items.map(item => item.sourceId), ['1', '2']);
  assert.equal(h.fetches.length, 1, 'same text has one local calculation');
  const revoked = planned.items[0], retained = planned.items[1];
  assert.equal(h.scheduler.closeNativeEvent(revoked.id, revoked.text, revoked.epoch,
    revoked.predictionEpoch, 'fixture-revoked'), true);
  await tickPlanned(h, () => h.messages.some(row => row.message.type === 'cancel-video-items' &&
    row.message.ids.includes(revoked.id)));
  assert.ok(h.messages.some(row => row.message.type === 'cancel-video-items' &&
    row.message.ids.includes(revoked.id)), 'only the retired subscription is cancelled');
  releaseReply();
  await tickPlanned(h, () => native.contentMessages.some(row => row.type === 'prepared' &&
    row.plannedSupply && row.items.some(item => item.sourceId === '2')));
  const deliveries = h.pageMessages.filter(row => row.message.type === 'video-translation-result');
  assert.deepEqual(deliveries.map(row => row.message.output.id), [retained.id]);
  assert.equal(h.attachment.nativeSupply.summary().ready, 1);
  native.video.currentTime = 124; h.mono += 4000;
  native.manager.fetchAndInitDm(124);
  assert.deepEqual(native.models.map(model => model.textData.dmid), ['2']);
  assert.equal(native.models[0].text, '你好世界');
  assert.equal(h.fetches.length, 1);
  assert.equal(h.onlineFetches.length, 0);
  assert.equal(externalFetches(), 0);
});

for (const invalidation of ['configuration', 'resource']) test(`hybrid ${invalidation} invalidation cannot adopt an old in-flight reply`, async t => {
  let releaseReply;
  const replyGate = new Promise(resolve => { releaseReply = resolve; });
  const { h, native, externalFetches } = await openPlannedPipeline(t, {}, async fixture => {
    await configureHybridFixture(fixture);
    fixture.localReplyGate = replyGate;
  });
  t.after(() => releaseReply());
  await tickPlanned(h, () => h.fetches.length === 1);
  assert.equal(native.contentMessages.some(row => row.type === 'prepared' && row.plannedSupply), false);
  if (invalidation === 'configuration') {
    const sender = { id: h.browser.runtime.id, url: h.browser.runtime.getURL('/options.html') };
    assert.equal((await h.send({ type: 'toggle', enabled: false }, sender)).ok, true);
  } else {
    h.openTabs.set(h.currentTab, 'https://www.bilibili.com/video/BV9876543210');
    native.videoHandlers.get('seeking')?.();
  }
  releaseReply();
  await tickPlanned(h);
  assert.equal(native.contentMessages.some(row => row.type === 'prepared' && row.plannedSupply), false);
  assert.equal(h.pageMessages.some(row => row.message.type === 'video-translation-result'), false);
  assert.equal(h.fetches.length, 1);
  assert.equal(h.onlineFetches.length, 0);
  assert.deepEqual(native.playbackCalls, { pause: 0, play: 0, seek: 0 });
  assert.equal(externalFetches(), 0);
});

test('enabled owned plan crosses ordinary translate and per-item prepared into MAIN adoption without playback control', async t => {
  const { h, native, externalFetches } = await openPlannedPipeline(t);
  const sourceTexts = native.pool.map(row => row.text);
  const timelineTexts = native.timeline.map(row => row.text);
  assert.equal(native.pool.length, 220);
  assert.notEqual(native.pool[0], native.timeline[0]);
  assert.equal(Object.hasOwn(native.pool[0], 'on'), false, 'newly parsed Worker rows have no on flag');
  assert.equal(Object.hasOwn(native.timeline[0], 'on'), false);
  assert.equal(native.setting.preTime, 1);
  await tickPlanned(h, () => native.contentMessages.some(row => row.type === 'prepared' && row.plannedSupply));
  const predicted = native.nativeMessages.findLast(row => row.type === 'bilibili-shadow' && row.policy === 'owned');
  assert.equal(predicted?.known, true);
  assert.equal(predicted.items.length, 1, 'the five-second horizon selects only the nearby row');
  assert.equal(predicted.items[0].stimeMs, 124_500);
  assert.equal(predicted.items.find(row => row.sourceId === '1')?.reasons[0], 'user-sender-partial');
  const runningStatus = await h.contentReceive({ type: 'bilibili-native-supply', action: 'status' },
    { id: h.browser.runtime.id });
  assert.equal(runningStatus.reason, '');
  assert.doesNotMatch(h.progress.nativeSupplyView.status, /尚无入选/);
  const plannedRequest = h.messages.find(row => row.message.type === 'translate' && row.message.planning)?.message;
  assert.ok(plannedRequest, JSON.stringify({ types: h.messages.map(row => row.message.type),
    stats: h.scheduler.getStats() }));
  assert.deepEqual(plannedRequest.items.map(item => item.sourceId), ['1'], 'no request for the other 219 rows');
  assert.ok(h.pageMessages.some(row => row.message.type === 'video-translation-result' && row.message.planning),
    JSON.stringify({ responses: h.responses.filter(row => row.type === 'translate'), pageMessages: h.pageMessages.map(row => row.message), fetches: h.fetches.length,
      controls: h.controls, prepared: native.contentMessages.filter(row => row.type === 'prepared'), stats: h.scheduler.getStats() }));
  const prepared = native.contentMessages.find(row => row.type === 'prepared' && row.plannedSupply);
  assert.ok(prepared, JSON.stringify({ stats: h.scheduler.getStats(), fetches: h.fetches.length }));
  assert.equal(prepared.items[0].sourceId, '1');
  assert.equal(prepared.items[0].configIdentity, plannedRequest.planning.configIdentity);
  assert.equal(h.fetches.length, 1, 'only the in-memory local transport boundary sends a request');
  assert.equal(native.models.length, 0, 'translation is ready before formal native fetch');
  assert.equal(native.filtered.length, 0);
  assert.deepEqual(native.playbackCalls, { pause: 0, play: 0, seek: 0 });
  assert.equal(h.attachment.nativeSupply.summary().ready, 1, JSON.stringify({
    supply: h.attachment.nativeSupply.summary(),
    prepared: native.contentMessages.filter(row => row.type === 'prepared').length,
  }));
  native.video.currentTime = 124;
  h.mono += 4000;
  native.manager.fetchAndInitDm(124);
  assert.equal(native.filtered[0]?.text, 'こんにちは世界', JSON.stringify({
    filtered: native.filtered, supply: h.attachment.nativeSupply.summary(),
    events: h.attachment.nativeSupply.report().events?.slice(-4),
  }));
  assert.equal(native.filtered[0]?.author, 'original-author', 'native filter reads the original author');
  assert.equal(native.models[0]?.text, '你好世界', 'native model adopts the prepared translation');
  assert.deepEqual(native.pool.map(row => row.text), sourceTexts, 'all source-pool text stays untouched');
  assert.deepEqual(native.timeline.map(row => row.text), timelineTexts, 'all timeline text stays untouched');
  assert.deepEqual(native.playbackCalls, { pause: 0, play: 0, seek: 1 }, 'the one seek was test setup');
  assert.equal(externalFetches(), 0, 'no real network transport escaped the mock boundary');
  assert.equal(h.messages.some(row => row.message.type === 'bilibili-owned-supply-host' &&
    ['prepare', 'start', 'translate'].includes(row.message.action)), false, 'no legacy permit or budget');
});

for (const hybrid of [false, true]) test(`${hybrid ? 'hybrid local' : 'ordinary local'} repeated and long pauses preserve a prepared owned row through resume and native adoption`, async t => {
  const clock = fixedEpochClock(t);
  const { h, native, externalFetches } = await openPlannedPipeline(t, {}, async fixture => {
    if (hybrid) await configureHybridFixture(fixture);
  });
  assert.notEqual(native.pool[0], native.timeline[0], 'the native pool is a Worker clone');
  const originalPoolTexts = native.pool.map(row => row.text);
  const originalTimelineTexts = native.timeline.map(row => row.text);
  await tickPlanned(h, () => native.contentMessages.some(row => row.type === 'prepared' && row.plannedSupply));
  const initial = ownedUpdates(native).at(-1);
  assert.deepEqual(initial.items.map(row => row.sourceId), ['1']);
  assert.equal(h.attachment.nativeSupply.summary().ready, 1);
  const deadline = initial.items[0].deadlineAtEpochMs;
  const generation = initial.predictionEpoch;
  const requests = h.messages.filter(row => row.message.type === 'translate' && row.message.planning).length;
  assert.equal(requests, 1);

  for (const pausedMs of [400, 90_000]) {
    native.video.paused = true;
    const before = ownedUpdates(native).length;
    await tickPlanned(h, () => ownedUpdates(native).length > before && ownedUpdates(native).at(-1).suspended === true);
    let update = ownedUpdates(native).at(-1);
    assert.equal(update.known, true, 'a normal pause suspends rather than invalidates the owned list');
    assert.equal(update.suspended, true);
    assert.equal(update.predictionEpoch, generation);
    assert.deepEqual(update.items.map(row => row.sourceId), ['1']);
    clock.advance(pausedMs);
    await tickPlanned(h, () => ownedUpdates(native).at(-1)?.sampledAtEpochMs === clock.now());
    update = ownedUpdates(native).at(-1);
    assert.equal(update.suspended, true);
    assert.equal(update.predictionEpoch, generation);
    assert.equal(h.attachment.nativeSupply.summary().ready, 1, 'prepared text survives the pause');
    assert.equal(h.messages.filter(row => row.message.type === 'translate' && row.message.planning).length,
      requests, 'pause does not create another model input');
    assert.equal(h.fetches.length, 1);

    native.video.paused = false;
    await tickPlanned(h, () => ownedUpdates(native).at(-1)?.suspended === false);
    update = ownedUpdates(native).at(-1);
    assert.equal(update.known, true);
    assert.equal(update.predictionEpoch, generation);
    assert.equal(h.attachment.nativeSupply.summary().ready, 1);
  }
  assert.equal(ownedUpdates(native).at(-1).items[0].deadlineAtEpochMs, deadline + 90_400,
    'only elapsed paused time moves the still needed preparation deadline');
  assert.equal(h.messages.filter(row => row.message.type === 'translate' && row.message.planning).length,
    requests, 'repeated resume does not duplicate translation');
  native.video.currentTime = 124;
  h.mono += 4000;
  native.manager.fetchAndInitDm(124);
  assert.equal(native.filtered[0]?.text, originalTimelineTexts[0], 'native filtering reads original text');
  assert.equal(native.filtered[0]?.author, 'original-author');
  assert.equal(native.models[0]?.text, '你好世界', 'formal native fetch adopts the prepared text');
  if (hybrid) assert.equal(h.onlineFetches.length, 0);
  assert.deepEqual(native.pool.map(row => row.text), originalPoolTexts);
  assert.deepEqual(native.timeline.map(row => row.text), originalTimelineTexts);
  assert.deepEqual(native.playbackCalls, { pause: 0, play: 0, seek: 1 }, 'only test setup seeks');
  assert.equal(externalFetches(), 0);
});

test('paused background heartbeat loss keeps the source pool until the same MAIN session resumes', async t => {
  const clock = fixedEpochClock(t);
  const { h, native, externalFetches } = await openPlannedPipeline(t);
  await tickPlanned(h, () => native.contentMessages.some(row => row.type === 'prepared' && row.plannedSupply));
  assert.equal(h.scheduler.getStats().candidates, native.pool.length);
  native.video.paused = true;
  await tickPlanned(h, () => ownedUpdates(native).at(-1)?.suspended === true);
  const sourceChunks = native.nativeMessages.filter(row => row.type === 'sources').length;
  const requests = h.messages.filter(row => row.message.type === 'translate' && row.message.planning).length;
  const initialSession = h.attachment.session;

  native.document.visibilityState = 'hidden'; native.document.hidden = true;
  assert.equal(typeof native.docHandlers.get('visibilitychange'), 'function');
  native.docHandlers.get('visibilitychange')();
  assert.equal(h.scheduler.currentNativeDemand().length, 0, 'hiding the document immediately revokes demand');
  h.mono += 7000; clock.advance(7000);
  h.contentTick();
  assert.match(h.progress.nativeSupplyView.status, /控制未就绪/);
  assert.equal(h.scheduler.getStats().candidates, native.pool.length,
    'a missed heartbeat does not erase the already acknowledged unchanged source pool');
  assert.equal(h.scheduler.currentNativeDemand().length, 0);

  native.document.visibilityState = 'visible'; native.document.hidden = false;
  native.docHandlers.get('visibilitychange')();
  const resumeUpdates = ownedUpdates(native).length;
  await tickPlanned(h, () => ownedUpdates(native).length > resumeUpdates && ownedUpdates(native).at(-1)?.suspended === true &&
    h.progress.nativeSupplyView.status.includes('等待播放'));
  assert.equal(h.attachment.session, initialSession);
  assert.equal(native.nativeMessages.filter(row => row.type === 'sources').length, sourceChunks,
    'the unchanged MAIN publisher need not resend the full pool');
  assert.equal(h.scheduler.getStats().candidates, native.pool.length);
  assert.equal(h.messages.filter(row => row.message.type === 'translate' && row.message.planning).length,
    requests, 'background recovery while paused does not create another translation request');
  native.video.paused = false;
  native.videoHandlers.get('playing')?.();
  await tickPlanned(h, () => ownedUpdates(native).at(-1)?.items.some(row => row.sourceId === '1') &&
    h.scheduler.getStats().messages === 1);
  assert.equal(h.scheduler.getStats().messages, 1, 'new selection rejoins the retained source without a pool resend');
  assert.equal(native.nativeMessages.filter(row => row.type === 'sources').length, sourceChunks);
  assert.deepEqual(native.playbackCalls, { pause: 0, play: 0, seek: 0 });
  assert.equal(externalFetches(), 0);
});

for (const hybrid of [false, true]) test(`${hybrid ? 'hybrid local' : 'ordinary local'} in-flight pause retains its deadline and delivers once`, async t => {
  const clock = fixedEpochClock(t);
  let releaseReply;
  const replyGate = new Promise(resolve => { releaseReply = resolve; });
  const { h, native, externalFetches } = await openPlannedPipeline(t, {}, async fixture => {
    if (hybrid) await configureHybridFixture(fixture);
    fixture.localReplyGate = replyGate;
  });
  t.after(() => releaseReply());
  await tickPlanned(h, () => h.fetches.length === 1);
  const request = h.messages.find(row => row.message.type === 'translate' && row.message.planning)?.message;
  assert.deepEqual(request?.items.map(row => row.sourceId), ['1']);
  const originalDeadline = request.items[0].deadlineAtEpochMs;
  const originalGeneration = ownedUpdates(native).at(-1).predictionEpoch;
  assert.ok(originalDeadline - clock.now() > 1000);
  assert.equal(native.contentMessages.some(row => row.type === 'prepared' && row.plannedSupply), false);

  native.video.paused = true;
  await tickPlanned(h, () => ownedUpdates(native).at(-1)?.suspended === true);
  clock.advance(500);
  await tickPlanned(h, () => ownedUpdates(native).at(-1)?.sampledAtEpochMs === clock.now());
  assert.equal(ownedUpdates(native).at(-1).predictionEpoch, originalGeneration);
  assert.equal(h.fetches.length, 1, 'pausing an in-flight request does not start another');
  releaseReply();
  await tickPlanned(h, () => native.contentMessages.some(row => row.type === 'prepared' && row.plannedSupply));
  const prepared = native.contentMessages.find(row => row.type === 'prepared' && row.plannedSupply);
  assert.ok(prepared, 'a timely in-flight reply can still be delivered during pause');
  assert.equal(prepared.items[0].deadlineAtEpochMs, originalDeadline,
    'the already dispatched request retains its original finite deadline');
  assert.equal(h.attachment.nativeSupply.summary().ready, 1);
  native.video.paused = false;
  await tickPlanned(h, () => ownedUpdates(native).at(-1)?.suspended === false);
  assert.equal(ownedUpdates(native).at(-1).predictionEpoch, originalGeneration);
  assert.equal(h.messages.filter(row => row.message.type === 'translate' && row.message.planning).length, 1);
  assert.equal(h.fetches.length, 1);
  if (hybrid) assert.equal(h.onlineFetches.length, 0);
  native.video.currentTime = 124;
  h.mono += 4000;
  native.manager.fetchAndInitDm(124);
  assert.equal(native.filtered[0]?.text, 'こんにちは世界');
  assert.equal(native.filtered[0]?.author, 'original-author');
  assert.equal(native.models[0]?.text, '你好世界');
  assert.deepEqual(native.playbackCalls, { pause: 0, play: 0, seek: 1 });
  assert.equal(externalFetches(), 0);
});

for (const hybrid of [false, true]) test(`${hybrid ? 'hybrid local' : 'ordinary local'} reply after its in-flight deadline is never prepared or resent`, async t => {
  const clock = fixedEpochClock(t);
  let releaseReply;
  const replyGate = new Promise(resolve => { releaseReply = resolve; });
  const { h, native, externalFetches } = await openPlannedPipeline(t, {}, async fixture => {
    if (hybrid) await configureHybridFixture(fixture);
    fixture.localReplyGate = replyGate;
  });
  t.after(() => releaseReply());
  await tickPlanned(h, () => h.fetches.length === 1);
  const request = h.messages.find(row => row.message.type === 'translate' && row.message.planning)?.message;
  const originalDeadline = request?.items[0]?.deadlineAtEpochMs;
  assert.ok(originalDeadline > clock.now());
  const generation = ownedUpdates(native).at(-1).predictionEpoch;
  native.video.paused = true;
  await tickPlanned(h, () => ownedUpdates(native).at(-1)?.suspended === true);
  clock.advance(originalDeadline - clock.now() + 1000);
  await tickPlanned(h, () => ownedUpdates(native).at(-1)?.sampledAtEpochMs === clock.now());
  assert.equal(ownedUpdates(native).at(-1).predictionEpoch, generation);
  releaseReply();
  await tickPlanned(h);
  assert.equal(native.contentMessages.some(row => row.type === 'prepared' && row.plannedSupply), false,
    JSON.stringify({ reason: 'the result cannot escape after its originally issued deadline',
      now: clock.now(), originalDeadline,
      prepared: native.contentMessages.filter(row => row.type === 'prepared' && row.plannedSupply),
      requests: h.messages.filter(row => row.message.type === 'translate' && row.message.planning)
        .map(row => row.message.items.map(item => item.deadlineAtEpochMs)),
      responses: h.responses.filter(row => row.type === 'translate'),
    }));
  assert.equal(h.attachment.nativeSupply.summary().ready, 0);
  native.video.paused = false;
  await tickPlanned(h, () => ownedUpdates(native).at(-1)?.suspended === false);
  assert.equal(ownedUpdates(native).at(-1).predictionEpoch, generation);
  assert.equal(h.messages.filter(row => row.message.type === 'translate' && row.message.planning).length, 1,
    'resume cannot resend an already issued native demand');
  assert.equal(h.fetches.length, 1);
  if (hybrid) assert.equal(h.onlineFetches.length, 0);
  native.video.currentTime = 124;
  h.mono += 4000;
  native.manager.fetchAndInitDm(124);
  assert.equal(native.filtered.length, 0, 'an expired reply cannot fall back to original rendering');
  assert.equal(native.models.length, 0);
  assert.deepEqual(native.playbackCalls, { pause: 0, play: 0, seek: 1 });
  assert.equal(externalFetches(), 0);
});

async function assertProjectedOwnedChain(t, { firstRow, stack, admittedStyle, typeColor = true }) {
  const { h, native, externalFetches } = await openPlannedPipeline(t, {}, fixture => {
    fixture.nativeFirstRow = firstRow;
    fixture.nativeModeStack = stack;
    fixture.nativeTypeColor = typeColor;
  });
  const sourceTexts = native.pool.map(row => row.text);
  const timelineTexts = native.timeline.map(row => row.text);
  const originalAuthor = native.timeline[0].uhash;
  const snapshot = h.nativeRules.read();
  assert.equal(snapshot.known, true, snapshot.reason ?? '');
  assert.deepEqual(snapshot.match(native.timeline[0]), { state: 'unknown', reason: 'mode-stack-adjustment' },
    'the strict shadow forecast cannot admit this pending native adjustment');

  await tickPlanned(h, () => native.contentMessages.some(row => row.type === 'prepared' && row.plannedSupply));
  const predicted = native.nativeMessages.findLast(row => row.type === 'bilibili-shadow' && row.policy === 'owned');
  assert.equal(predicted?.known, true);
  assert.deepEqual(predicted.items.map(row => row.sourceId), ['1'],
    'the real-rule owned projection must select the nearby row before translation');
  const request = h.messages.find(row => row.message.type === 'translate' && row.message.planning)?.message;
  assert.deepEqual(request?.items.map(row => row.sourceId), ['1'], 'ordinary scheduler sends only that row');
  assert.equal(h.responses.find(row => row.type === 'translate')?.response.items[0]?.status, 'translated');
  const prepared = native.contentMessages.find(row => row.type === 'prepared' && row.plannedSupply);
  assert.deepEqual(prepared.items.map(row => row.sourceId), ['1']);
  assert.equal(h.fetches.length, 1, 'only the existing in-memory local transport is used');
  assert.equal(native.models.length, 0, 'planning does not invoke native rendering early');
  assert.deepEqual(native.playbackCalls, { pause: 0, play: 0, seek: 0 });

  native.video.currentTime = 124;
  h.mono += 4000;
  native.manager.fetchAndInitDm(124);
  assert.equal(native.filtered.length, 1, 'native filter receives the original row');
  assert.equal(native.filtered[0].text, sourceTexts[0]);
  assert.equal(native.filtered[0].author, originalAuthor);
  assert.equal(native.filtered[0].source, native.timeline[0]);
  assert.deepEqual(Object.fromEntries(Object.keys(admittedStyle).map(key =>
    [key, native.filtered[0].source[key]])), admittedStyle,
    'the native beforeRender hook supplies the projected mode and color');
  assert.equal(native.models[0]?.text, '你好世界', 'native model adopts the prepared translation');
  assert.equal(native.models[0]?.textData.uhash, originalAuthor);
  assert.equal(h.attachment.nativeSupply.report().counts.adopted, 1);
  assert.deepEqual(native.pool.map(row => row.text), sourceTexts, 'source-pool text remains original');
  assert.deepEqual(native.timeline.map(row => row.text), timelineTexts, 'timeline text remains original');
  assert.deepEqual(native.playbackCalls, { pause: 0, play: 0, seek: 1 }, 'only test setup seeks');
  assert.equal(externalFetches(), 0, 'no external network call');
}

test('owned projection crosses the full chain when native color history changes before render', async t => {
  await assertProjectedOwnedChain(t, {
    firstRow: { color: 0x336699 },
    stack: { modeStack: [
      { mode: 1, rawMode: 1, color: 0x336699 },
      { mode: 1, rawMode: 1, color: 0xffffff },
    ], index: 1, blockColor: false, blockSpecial: false, blockTopBottom: false, preventShade: false },
    admittedStyle: { mode: 1, rawMode: 1, color: 0xffffff },
    typeColor: false,
  });
});

test('owned projection crosses the full chain when the pending item differs from its mode stack', async t => {
  await assertProjectedOwnedChain(t, {
    firstRow: { mode: 1, rawMode: 1 },
    stack: { modeStack: [
      { mode: 4, rawMode: 4, color: 0xffffff },
      { mode: 5, rawMode: 5, color: 0xffffff },
    ], index: 0, blockColor: false, blockSpecial: false, blockTopBottom: true, preventShade: false },
    admittedStyle: { mode: 5, rawMode: 5, color: 0xffffff },
  });
});

test('zero-selection rejection reasons agree across MAIN, status, export, and the planned label', async t => {
  const { h, native, externalFetches } = await openPlannedPipeline(t, {}, h => {
    h.nearRows = [[1, 124.6], [2, 124.7]];
    h.rulesSnapshot = { match: source => source.dmid === '3'
      ? { state: 'exclude', reason: 'native-user-keyword' }
      : { state: 'unknown', reason: 'mode-stack-adjustment' } };
  });
  await tickPlanned(h, () => h.native?.nativeMessages.some(row => row.type === 'snapshot' &&
    row.nativeSupply?.ownedRelease?.known &&
    row.nativeSupply.ownedRelease.rejected['native-user-keyword'] === 1));
  const main = native.nativeMessages.findLast(row => row.type === 'snapshot')?.nativeSupply?.ownedRelease;
  assert.equal(main?.known, true);
  assert.equal(main.totals.selected, 0);
  assert.equal(main.rejected['mode-stack-adjustment'], 2);
  assert.equal(main.rejected['native-user-keyword'], 1);
  const status = await h.contentReceive({ type: 'bilibili-native-supply', action: 'status' },
    { id: h.browser.runtime.id });
  const exported = await h.contentReceive({ type: 'bilibili-native-supply', action: 'export' },
    { id: h.browser.runtime.id });
  assert.equal(status.state, 'running');
  assert.equal(status.reason, 'no-selected-candidates');
  assert.deepEqual(status.ownedRelease.rejected, main.rejected);
  assert.deepEqual(exported.ownedRelease.rejected, main.rejected);
  assert.equal(exported.reason, status.reason);
  await tickPlanned(h, () => h.progress.nativeSupplyView.status.includes('尚无入选'));
  assert.match(h.progress.nativeSupplyView.status,
    /尚无入选；累计未入选：模式历史可能变化 2、关键词屏蔽 1/);
  assert.equal(h.fetches.length, 0);
  assert.equal(native.contentMessages.some(row => row.type === 'prepared' && row.plannedSupply), false);
  assert.deepEqual(native.playbackCalls, { pause: 0, play: 0, seek: 0 });
  assert.equal(externalFetches(), 0);
});

test('unknown native rejection code remains visible in zero-selection status', async t => {
  const { h, native, externalFetches } = await openPlannedPipeline(t, {}, h => {
    h.rulesSnapshot = { match: () => ({ state: 'unknown', reason: 'future-native-rule-unverified' }) };
  });
  await tickPlanned(h, () => h.native?.nativeMessages.some(row => row.type === 'snapshot' &&
    row.nativeSupply?.ownedRelease?.rejected['future-native-rule-unverified'] === 1));
  const status = await h.contentReceive({ type: 'bilibili-native-supply', action: 'status' },
    { id: h.browser.runtime.id });
  assert.equal(status.state, 'running');
  assert.equal(status.reason, 'no-selected-candidates');
  assert.equal(status.ownedRelease.totals.selected, 0);
  assert.equal(status.ownedRelease.rejected['future-native-rule-unverified'], 1);
  await tickPlanned(h, () => h.progress.nativeSupplyView.status.includes('future-native-rule-unverified'));
  assert.match(h.progress.nativeSupplyView.status, /future-native-rule-unverified 1/);
  assert.equal(h.fetches.length, 0);
  assert.deepEqual(native.playbackCalls, { pause: 0, play: 0, seek: 0 });
  assert.equal(externalFetches(), 0);
});

test('owned plan skips a missing translation at native admission instead of restoring source text', async t => {
  const { h, native, externalFetches } = await openPlannedPipeline(t);
  h.replyText = native.pool[0].text;
  await tickPlanned(h, () => h.responses.some(row => row.type === 'translate'));
  assert.equal(h.fetches.length, 1);
  assert.ok(h.responses.find(row => row.type === 'translate')?.response.items[0]?.status,
    'the ordinary transport completed; exact source text is rejected at the planned result gate');
  assert.equal(native.contentMessages.some(row => row.type === 'prepared' && row.plannedSupply), false);
  native.video.currentTime = 124;
  native.manager.fetchAndInitDm(124);
  assert.equal(native.filtered.length, 0, 'no source fallback enters the renderer');
  assert.equal(native.models.length, 0);
  assert.ok(h.attachment.nativeSupply.report().events.some(row => row.type === 'ownedSuppressed' &&
    row.reason === 'no-qualified-result'));
  assert.deepEqual(native.playbackCalls, { pause: 0, play: 0, seek: 1 });
  assert.equal(externalFetches(), 0);
});

test('unavailable real-rule contract is surfaced instead of reporting the plan running', async t => {
  const { h, externalFetches } = await openPlannedPipeline(t, {}, h => {
    h.rulesSnapshot = { known: false, reason: 'native-setting-unverified' };
  });
  await tickPlanned(h);
  const status = await h.contentReceive({ type: 'bilibili-native-supply', action: 'status' }, { id: h.browser.runtime.id });
  assert.equal(status.state, 'unavailable');
  assert.match(status.reason, /native-setting-unverified/);
  assert.match(h.progress.nativeSupplyView.status, /native-setting-unverified/);
  assert.equal(i18nWire.messageFromSource(h.progress.message)?.id, 'm_c1acce982a08',
    'normal rule coverage must not turn into the generic unknown-error message');
  assert.equal(h.fetches.length, 0);
  assert.equal(externalFetches(), 0);
  assert.deepEqual(h.native.playbackCalls, { pause: 0, play: 0, seek: 0 });
});

test('an unacknowledged MAIN control does not appear as a working plan', async t => {
  const { h } = await openPlannedPipeline(t);
  h.attachment.nativeSupply.configurePlanned = () => ({ activated: false, changed: false });
  await tickPlanned(h);
  const status = await h.contentReceive({ type: 'bilibili-native-supply', action: 'status' }, { id: h.browser.runtime.id });
  assert.equal(status.state, 'unavailable');
  assert.equal(status.reason, 'planned-control-unconfirmed');
  assert.match(h.progress.nativeSupplyView.status, /名单控制尚未接通/);
  assert.equal(h.fetches.length, 0);
});

test('disabled translation and original display make no planned model request', async t => {
  for (const settingsPatch of [{ enabled: false }, { displayMode: 'original' }]) {
    await t.test(JSON.stringify(settingsPatch), async subtest => {
      const { h, native, externalFetches } = await openPlannedPipeline(subtest, settingsPatch);
      await tickPlanned(h);
      assert.equal(h.messages.filter(row => row.message.type === 'translate').length, 0);
      assert.equal(h.fetches.length, 0);
      assert.equal(native.contentMessages.some(row => row.type === 'prepared' && row.plannedSupply), false);
      native.manager.fetchAndInitDm(124);
      assert.equal(native.models[0]?.text, 'こんにちは世界', 'ordinary native original remains visible');
      assert.equal(externalFetches(), 0);
    });
  }
});

test('local interface failure leaves the planned native event untranslated and suppressed', async t => {
  const { h, native, externalFetches } = await openPlannedPipeline(t);
  h.failLocalFetch = true;
  await tickPlanned(h, () => h.responses.some(row => row.type === 'translate'));
  assert.ok(h.fetches.length > 0, 'the virtual local interface was attempted');
  assert.equal(h.responses.find(row => row.type === 'translate')?.response.items[0]?.reason, 'network-error');
  assert.equal(native.contentMessages.some(row => row.type === 'prepared' && row.plannedSupply), false);
  native.video.currentTime = 124;
  native.manager.fetchAndInitDm(124);
  assert.equal(native.models.length, 0);
  assert.deepEqual(native.playbackCalls, { pause: 0, play: 0, seek: 1 });
  assert.equal(externalFetches(), 0);
});

test('a stale initial retirement session-open retries on the new page generation', async t => {
  const held = [];
  let firstGeneration;
  const { h, native, externalFetches } = await openPlannedPipeline(t, {}, h => {
    h.rpcOverride = message => {
      if (message.type !== 'session-open') return undefined;
      firstGeneration ??= message.session.generation;
      if (message.session.generation > firstGeneration + 1) return undefined;
      return new Promise(resolve => held.push({ session: clone(message.session), resolve }));
    };
  });
  const staleGeneration = () => firstGeneration + 1;
  await tickPlanned(h, () => held.some(row => row.session.generation === staleGeneration()));
  assert.ok(held.some(row => row.session.generation === staleGeneration()),
    'the retirement identity proof was in flight');
  native.videoHandlers.get('seeking')?.();
  await tickPlanned(h, () => native.contentMessages.some(row =>
    row.type === 'control' && row.generation > staleGeneration()));
  assert.ok(native.contentMessages.some(row => row.type === 'control' && row.generation > staleGeneration()),
    'the source reset rotated the page generation before that proof settled');
  assert.equal(h.messages.filter(row => row.message.type === 'bilibili-owned-supply-retire').length, 0,
    JSON.stringify({ staleGeneration: staleGeneration(), held: held.map(row => row.session.generation),
      controls: native.contentMessages.filter(row => row.type === 'control').map(row => row.generation),
      sent: h.messages.filter(row => ['session-open', 'bilibili-owned-supply-retire'].includes(row.message.type))
        .map(row => [row.message.type, row.message.session?.generation]) }));
  assert.equal(h.fetches.length, 0, 'no model call is made while retirement is unresolved');
  for (const pending of held.splice(0)) pending.resolve({ ok: false, error: '视频正在切换' });
  await tickPlanned(h, () => native.contentMessages.some(row => row.type === 'prepared' && row.plannedSupply));
  assert.ok(h.messages.some(row => row.message.type === 'bilibili-owned-supply-retire' &&
    row.message.session.generation > staleGeneration()), JSON.stringify({
      staleGeneration: staleGeneration(), types: h.messages.map(row => [row.message.type, row.message.session?.generation]),
      controls: native.contentMessages.filter(row => row.type === 'control').map(row => row.generation),
    }));
  assert.equal(native.contentMessages.filter(row => row.type === 'prepared' && row.plannedSupply).length, 1);
  assert.equal(h.fetches.length, 1);
  assert.deepEqual(native.playbackCalls, { pause: 0, play: 0, seek: 0 });
  assert.equal(externalFetches(), 0);
});

test('player shortcut lookup reads current browser assignment without changing settings', async () => {
  const h = fixture();
  const before = clone(h.local.get(config.SETTINGS_KEY));
  assert.deepEqual(await h.send({ type: 'translation-shortcut' }), { ok: true, shortcut: 'Alt+T' });
  h.shortcuts[0].shortcut = 'Ctrl+Shift+Y';
  assert.deepEqual(await h.send({ type: 'translation-shortcut' }), { ok: true, shortcut: 'Ctrl+Shift+Y' });
  h.shortcuts[0].shortcut = '';
  assert.deepEqual(await h.send({ type: 'translation-shortcut' }), { ok: true, shortcut: '' });
  assert.deepEqual(h.local.get(config.SETTINGS_KEY), before);
  assert.equal(h.fetches.length, 0);
});

test('fullscreen video switch changes only enabled and broadcasts the saved value', async () => {
  const h = fixture();
  assert.equal((await h.send({ type: 'session-open', session: h.session })).ok, true);
  const before = config.normalizeSettings(clone(h.local.get(config.SETTINGS_KEY)));
  const enabled = await h.send({ type: 'video-translation-toggle', session: h.session, enabled: true,
    endpoint: 'https://ignored.invalid', targetLanguage: 'ignored', settings: { backend: 'online' } });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.settings.enabled, true);
  const after = h.local.get(config.SETTINGS_KEY);
  assert.deepEqual(after, { ...before, enabled: true });
  assert.ok(h.pageMessages.some(row => row.message.type === 'settings-updated' && row.message.settings.enabled));
  const disabled = await h.send({ type: 'video-translation-toggle', session: h.session, enabled: false });
  assert.equal(disabled.ok, true);
  assert.equal(disabled.settings.enabled, false);
  assert.equal(h.fetches.length, 0);
});

test('fullscreen switch rejects stale documents sessions and malformed state without changing settings', async () => {
  const h = fixture();
  assert.equal((await h.send({ type: 'session-open', session: h.session })).ok, true);
  const before = clone(h.local.get(config.SETTINGS_KEY));
  const request = { type: 'video-translation-toggle', session: h.session, enabled: true };
  for (const [message, sender] of [
    [request, h.sender(41, 'old-document')],
    [{ ...request, session: { ...h.session, generation: 99 } }, h.sender()],
    [{ ...request, enabled: 'true' }, h.sender()],
    [request, { ...h.sender(), frameId: 1 }],
    [request, { ...h.sender(), url: 'https://www.youtube.com/watch?v=other' }],
  ]) assert.equal((await h.send(message, sender)).ok, false);
  h.openTabs.set(41, 'https://www.bilibili.com/video/BV0000000000');
  assert.equal((await h.send(request)).ok, false);
  assert.deepEqual(h.local.get(config.SETTINGS_KEY), before);
  assert.equal(h.fetches.length, 0);
});

test('fullscreen switch keeps the existing online configuration requirement', async () => {
  const h = fixture({ backend: 'online' });
  assert.equal((await h.send({ type: 'session-open', session: h.session })).ok, true);
  const result = await h.send({ type: 'video-translation-toggle', session: h.session, enabled: true });
  assert.equal(result.ok, false);
  assert.equal(h.local.get(config.SETTINGS_KEY).enabled, false);
  assert.equal(h.fetches.length, 0);
});


