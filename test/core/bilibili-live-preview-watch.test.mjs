import * as nativeSupplyWatch from '../../src/diagnostics/native-supply-watch.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as config from '../../src/core/config.ts';
import * as messages from '../../src/core/messages.ts';
import * as resource from '../../src/core/resource.ts';
import * as diagnostics from '../../src/core/adapter-diagnostic.ts';
import * as scheduling from '../../src/core/scheduler.ts';
import * as stream from '../../src/core/source-stream.ts';
import * as policy from '../../src/core/video-policy.ts';
import * as shadow from '../../src/core/bilibili-shadow.ts';
import * as experimentWatch from '../../src/diagnostics/bilibili-experiment-watch.ts';
import * as i18nWire from '../../src/i18n/wire.ts';
import * as userFilterSimulation from '../../src/diagnostics/user-filter-simulation.ts';
import * as displayPlanSession from '../../src/diagnostics/display-plan-session.ts';
import { RenderPreviewEngine } from '../../src/core/render-preview.ts';
import { BRIDGE } from '../../src/platforms/niconico/native.ts';
import * as userFilterWire from '../../src/platforms/bilibili/user-filter-wire.ts';

const flush = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, label) {
  for (let n = 0; n < 40; n++) { if (predicate()) return; await flush(); }
  assert.fail(`timed out waiting for ${label}`);
}
const url = 'https://www.bilibili.com/video/BV1234567890';
const scope = { resourceId: 'av123:cid456', urlResourceId: 'BV1234567890:p1', session: 's1', epoch: 1 };
const source = (id, text, mediaTimeMs) => ({ sourceId: id, threadId: '456', fork: 'main', platform: 'bilibili',
  originalText: text, mediaTimeMs, renderAtMs: mediaTimeMs - 2000, translatable: true, style: { position: '1' } });
const sourceId = id => messages.bilibiliSourceEventId(scope.resourceId, id);
const userFilterSummary = (revision, featureEnabled = true, restored = false) => ({
  contract: 'bilibili-user-filter-v1', featureEnabled, revision, restored,
  categories: Object.fromEntries(['keyword', 'regexp', 'sender', 'account'].map(name => [name,
    { status: 'ready', total: 1, enabled: 1, supported: 1 }])),
  observation: { started: false, playing: false, restored: true, selectedRuleHit: false },
});
const clock = (mediaTimeMs = 20000, paused = true, extra = {}) => ({ mediaTimeMs, durationMs: 100000,
  playbackRate: 1, paused, seeking: false, contentActive: true, commentsVisible: true, ...extra });

const compiled = ts.transpileModule(readFileSync(new URL('../../entrypoints/watch.content.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function harness(savedEnabled = false, overrides = {}) {
  const h = { now: 10000, sent: [], runtime: [], requests: [], prepared: [], events: [], configured: [], renderFeeds: [], settings: {
    ...config.DEFAULT_SETTINGS, enabled: savedEnabled, sourceLanguage: 'ja', targetLanguage: 'zh-Hans',
    endpoint: 'https://provider.example/v1/chat/completions', model: 'test', translationScope: 'all', prefetchSeconds: 60,
    ...overrides,
  } };
  const handlers = new Map(), location = { href: url, origin: 'https://www.bilibili.com' };
  h.video = { dataset: { danlingoPlayer: scope.session }, matches: selector => selector === 'video',
    isConnected: true, currentTime: 20, paused: true, seeking: false, ended: false };
  const document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', querySelectorAll: selector => selector === '[data-danlingo-player]' ? [h.video] : [] };
  const window = { postMessage: data => { h.sent.push(data); if (data.type === 'prepared') h.prepared.push(data); h.afterControl?.(data); },
    addEventListener: (type, callback) => handlers.set(type, callback), removeEventListener() {} };
  const browser = { runtime: { id: 'test-extension', getManifest: () => ({ version: '0.4.14' }),
    onMessage: { addListener: listener => { h.receive = (message, sender = { id: 'test-extension' }) => listener(message, sender); }, removeListener() {} },
    sendMessage: async message => {
      h.runtime.push(message);
      if (message.type === 'settings') return { ok: true, settings: h.settings, hasKey: true, configVersion: 4 };
      if (message.type === 'bilibili-display-plan-guard') return { ok: true, zeroModelGuard: true, buildId: 'watch-build-test' };
      if (message.type === 'bilibili-render-preview-guard') return { ok: true, zeroModelGuard: true, buildId: 'watch-build-test' };
      if (message.type === 'bilibili-live-preview-host') return h.host(message);
      if (message.type === 'bilibili-experiment-translate') return new Promise((resolve, reject) => h.requests.push({ message, resolve, reject }));
      if (message.type === 'bilibili-experiment-watch-event') { h.events.push(message); return { ok: true }; }
      if (message.type === 'translate') return { ok: true, items: message.items.map(item => ({ id: item.id, status: 'original' })) };
      return { ok: true };
    } } };
  const dependencies = {
    'wxt/browser': { browser }, 'wxt/utils/define-content-script': { defineContentScript: value => value },
    '../src/core/build-identity': { BUILD_ID: 'watch-build-test' },
    '../src/core/config': config, '../src/core/messages': messages, '../src/core/scheduler': {
      ...scheduling, VideoScheduler: class extends scheduling.VideoScheduler {
        constructor(options) { super({ ...options, now: () => h.now }); h.scheduler = this; }
        configure(settings) { h.configured.push({ ...settings }); super.configure(settings); }
      },
    },
    '../src/core/source-stream': stream, '../src/core/video-policy': policy, '../src/platforms/niconico/native': { BRIDGE },
    '../src/diagnostics/native-supply-watch': nativeSupplyWatch,
    '../src/core/bilibili-shadow': shadow,
    '../src/core/resource': resource, '../src/core/adapter-diagnostic': diagnostics,
    '../src/i18n/text.ts': { t: id => id === 'watch.enableTranslation' ? '请启用翻译' : id },
    '../src/ui/localized-text': { bindLocalizedText: (node, render) => { node.textContent = render(); } },
    '../src/ui/bilibili-fullscreen-toggle': { mountBilibiliFullscreenToggle: () => ({ update() {}, dispose() {} }) },
    '../src/ui/progress': { createProgress: onChange => { h.change = onChange; return { attach() {}, update() {}, dispose() {}, nativeSupplyButton: {}, updateNativeSupply() {}, renderPreviewHost: {} }; } },
    '../src/ui/render-preview': { mountRenderPreview: (_host, options) => {
      let engine = null, lastReport = null, enabled = false, mode = 'original';
      const translations = new Map();
      const api = {
        setMode(value) { mode = value; engine?.setMode(value === 'original' ? 'original' : 'stored-translation'); },
        setLiveState(value) { h.liveUiState = value; },
        setEnabled(value) {
          enabled = value;
          if (value && !engine) {
            engine = new RenderPreviewEngine({ mode: mode === 'original' ? 'original' : 'stored-translation',
              targetLanguage: 'ja', resolveTranslation: event => translations.get(event.id), measure: text => ({
                widthPx: text.includes('幅超過') ? 1500 : 80, heightPx: 30, lines: 1 }) });
            engine.setLayout({ widthPx: 600, heightPx: 240, fontSizePx: 20, lineHeightPx: 28,
              paddingXPx: 6, paddingYPx: 2, gapPx: 16 }, h.video.currentTime * 1000);
          }
        },
        feed(input) {
          h.renderFeeds.push(input);
          if (!enabled || !engine) return [];
          for (const translation of input.existingTranslations ?? []) translations.set(translation.id, translation);
          return engine.sync({ ...input, mediaTimeMs: h.video.currentTime * 1000,
            eligibility: event => input.eligibilityById?.[event.id] ?? (event.unknown ? 'unknown' : 'retain') });
        },
        isVisible: () => enabled && h.visible !== false,
        report: includeText => engine?.report(includeText) ?? lastReport ?? { records: [], counts: {} },
        cleanup() { engine?.close(h.video.currentTime * 1000); lastReport = engine?.report() ?? lastReport; engine = null; enabled = false; },
        reveal() {}, dispose() { api.cleanup(); },
      };
      h.renderUi = api;
      h.renderTick = () => engine?.tick({ mediaTimeMs: h.video.currentTime * 1000,
        wallTimeMs: h.now, paused: h.video.paused, seeking: h.video.seeking });
      h.renderSample = keys => engine?.sampleVisible(keys, h.video.currentTime * 1000, h.now);
      h.renderOptions = options;
      return api;
    } },
    '../src/i18n/wire.ts': i18nWire, '../src/diagnostics/bilibili-experiment-watch': experimentWatch,
    '../src/platforms/bilibili/user-filter-wire': userFilterWire,
    '../src/diagnostics/user-filter-simulation': userFilterSimulation,
    '../src/diagnostics/display-plan-session': displayPlanSession,
  };
  const exports = {};
  runInNewContext(compiled, { exports, Error, URL, AbortController, crypto, TextEncoder, structuredClone,
    performance: { now: () => h.now }, location, window, document, setTimeout, clearInterval() {}, require: key => {
      assert.ok(key in dependencies, `unexpected import: ${key}`); return dependencies[key];
    } });
  exports.default.main({ setInterval: callback => { h.tick = (advance = 500) => { h.now += advance; callback(); }; },
    onInvalidated: callback => { h.dispose = callback; } });
  h.post = value => handlers.get('message')({ source: window, origin: location.origin,
    data: { bridge: BRIDGE, from: 'native', ...scope, ...value } });
  h.snapshot = (ms = 20000, paused = true, extra = {}) => {
    h.video.currentTime = ms / 1000; h.video.paused = paused; h.video.seeking = extra.seeking === true;
    h.post({ type: 'snapshot', clock: clock(ms, paused, extra) });
  };
  h.sources = (rows, userFilter) => h.post({ type: 'sources', sourceGeneration: 0, revision: 1, index: 0, reset: true,
    complete: true, collectionComplete: true, removes: [], upserts: rows, ...(userFilter ? { userFilter } : {}) });
  h.filter = (revision, items, ready = true, reset = revision === 1) => h.post({ type: 'bilibili-experiment-filter',
    sourceGeneration: 0, runId: 'run1', revision, reset, ready, items });
  h.rules = (revision, items) => h.post({ type: 'bilibili-user-filter', sourceGeneration: 0,
    revision, index: 0, complete: true, detectedAt: h.now,
    summary: { ...userFilterSummary(revision), contract: 'bilibili-core-ba67b466-user-rules-v1', enabled: true,
      mainBuildId: 'watch-build-test', readEvidence: Object.fromEntries(['storeFound', 'methodsMatch',
        'callbackMatches', 'listComplete', 'switchKnown', 'accountScopeKnown'].map(key => [key, true])) }, items });
  h.hostMessages = []; h.hostRequests = [];
  h.host = message => {
    h.hostMessages.push(message);
    if (message.action === 'translate') return new Promise(resolve => h.hostRequests.push({ message, resolve }));
    return Promise.resolve({ ok: true, grant: h.grant, budget: { phases: { main: {
      remaining: { requests: 10, items: 20, utf16Chars: 500 }, actualSent: { requests: h.hostRequests.length },
    } } } });
  };
  return h;
}

const liveAction = (h, action, input) => h.receive({ type: 'bilibili-live-preview', action, input });
function setup(h) {
  const rows = [source('1', 'A live comment one', 50000), source('2', 'A live comment two', 52000),
    source('3', 'Outside the live range', 86000)].map(row => ({ ...row, displayPlanEligible: true }));
  h.snapshot(); h.sources(rows);
  h.afterControl = data => {
    if (data.type !== 'control' || data.displayPlanPlayback !== 'prepare-live') return;
    assert.equal(data.enabled, false);
    h.now++;
    h.snapshot(45000, true);
    h.post({ type: 'snapshot', clock: clock(45000, true), displayPlanPlayback: {
      started: false, restored: false, seekCount: 0, owner: 'live-preview',
      restoreDisposition: 'pending', playbackListeners: 2,
    } });
    h.rules(1, rows.map(row => ({ id: sourceId(row.sourceId), originalText: row.originalText, state: 'unknown' })));
  };
  return rows;
}
async function prepared(h) {
  const page = await liveAction(h, 'prepare', { fromMs: 45000 });
  assert.equal(page.ok, true, page.error);
  assert.equal(page.report.nativePrepared, 0);
  h.grant = { state: 'prepared', runId: 'run-live', instanceId: 'instance-live',
    configIdentity: 'fixture-config', modelId: 'fixture-local-model', epoch: page.epoch,
    fromMs: 45000, toMs: 85000, buildId: page.buildId, session: page.session };
  const bound = await liveAction(h, 'bind');
  assert.equal(bound.ok, true, bound.error);
  assert.equal(bound.report.state, 'ready');
  return bound;
}

test('watch page and UI share prepare/bind/start; pause holds supply and an exact result reaches the same renderer', async t => {
  const h = harness(false, { backend: 'local', localModelId: 'fixture-local-model' });
  t.after(() => h.dispose());
  const rows = setup(h); await flush();
  await prepared(h);
  assert.equal(h.hostMessages.some(message => message.action === 'translate'), false);
  assert.equal(h.runtime.some(message => message.type === 'translate' || message.type === 'bilibili-experiment-translate'), false);
  await h.renderOptions.onLiveAction('start');
  assert.equal(h.hostMessages.filter(message => message.action === 'start').length, 1);
  assert.equal(h.sent.filter(message => message.type === 'control').at(-1).displayPlanPlayback, 'play');
  h.snapshot(45000, true); await flush();
  assert.equal(h.hostRequests.length, 0, 'UI start does not infer while the native clock remains paused');
  h.snapshot(45000, false);
  await until(() => h.hostRequests.length > 0, 'first selected live request');
  const request = h.hostRequests[0].message;
  assert.equal(request.items.every(item => [sourceId('1'), sourceId('2')].includes(item.id)), true);
  assert.equal(request.items.some(item => item.id === sourceId('3')), false);
  const item = request.items[0];
  await h.receive({ type: 'bilibili-live-preview-result', runId: h.grant.runId,
    instanceId: 'other-instance', requestId: request.requestId,
    output: { id: item.id, status: 'translated', text: 'wrong result' } });
  assert.equal(h.renderFeeds.some(feed => feed.existingTranslations?.length), false);
  await h.receive({ type: 'bilibili-live-preview-result', runId: h.grant.runId,
    instanceId: h.grant.instanceId, requestId: request.requestId,
    output: { id: item.id, status: 'translated', text: 'テスト訳文', preview: {
      runId: h.grant.runId, instanceId: h.grant.instanceId, configIdentity: h.grant.configIdentity,
      requestId: request.requestId, originalText: item.text, taskId: 'task-fixture',
      resultId: 'result-fixture', kind: 'new-inference',
    } } });
  await until(() => h.renderFeeds.some(feed => feed.existingTranslations?.some(row => row.id === item.id)),
    'exact live translation fed to renderer');
  const translation = h.renderFeeds.flatMap(feed => feed.existingTranslations ?? []).find(row => row.id === item.id);
  assert.deepEqual([translation.resourceId, translation.epoch, translation.sourceId,
    translation.originalText, translation.origin, translation.resultId],
  [scope.resourceId, 1, rows.find(row => sourceId(row.sourceId) === item.id).sourceId,
    item.text, 'live-local', 'result-fixture']);
  h.video.currentTime = 50;
  h.renderTick();
  const committed = h.renderUi.report(true).records.find(row => row.id === item.id);
  assert.equal(committed.origin, 'live-local');
  assert.equal(committed.resultId, 'result-fixture');
  assert.equal(committed.chosenText, 'テスト訳文');
  assert.equal(h.prepared.length, 0, 'native prepared output is never used for this preview');
  const beforePause = (await liveAction(h, 'status')).report.plan.B.events.find(row => row.id === sourceId('2'));
  assert.notEqual(beforePause?.state, 'frozen');
  h.snapshot(50000, true); await flush();
  const paused = (await liveAction(h, 'status')).report;
  assert.equal(paused.state, 'paused');
  assert.notEqual(paused.plan.B.events.find(row => row.id === sourceId('2'))?.state, 'frozen',
    'paused playback cannot freeze a newly reached bucket');
  assert.equal(h.hostRequests.length, 1, 'pause does not send another inference');
  assert.equal(paused.plan.supplyStopped, false);
  const retained = h.renderUi.report().records.length;
  h.snapshot(85000, false); await flush();
  const cutoff = await liveAction(h, 'export');
  assert.equal(cutoff.report.plan.supplyStopped, true);
  assert.equal(cutoff.report.state, 'draining');
  assert.ok(cutoff.mainCutoff);
  assert.equal(cutoff.report.render.records.length, retained, 'the renderer retains its selected tail');
  assert.equal(h.hostMessages.some(message => message.action === 'drain' && message.reason === 'range-complete'), true);
  h.snapshot(87000, false); await flush();
  assert.equal(h.hostRequests.length, 1, 'no new request after the hard 85 second cutoff');
  h.snapshot(103000, false);
  const tail = await liveAction(h, 'export');
  assert.equal(tail.report.state, 'stopped');
  assert.ok(tail.tailCutoff);
});

test('a seek invalidates pending callbacks and removes the old live renderer identity', async t => {
  const h = harness(false, { backend: 'local', localModelId: 'fixture-local-model' });
  t.after(() => h.dispose());
  setup(h); await flush(); await prepared(h);
  assert.equal((await liveAction(h, 'start')).ok, true);
  h.snapshot(45000, false);
  await until(() => h.hostRequests.length > 0, 'pending request before seek');
  const pending = h.hostRequests[0].message;
  h.video.currentTime = 45.5;
  h.post({ type: 'snapshot', epoch: 2, clock: clock(45500, false, { seeking: true }) });
  await flush();
  assert.equal((await liveAction(h, 'status')).report.state, 'stopped');
  const before = h.renderFeeds.length;
  await h.receive({ type: 'bilibili-live-preview-result', runId: h.grant.runId,
    instanceId: h.grant.instanceId, requestId: pending.requestId,
    output: { id: pending.items[0].id, status: 'translated', text: '遅れた訳文', preview: {
      runId: h.grant.runId, instanceId: h.grant.instanceId, configIdentity: h.grant.configIdentity,
      requestId: pending.requestId, originalText: pending.items[0].text,
      resultId: 'stale-result', taskId: 'stale-task', kind: 'new-inference',
    } } });
  h.hostRequests[0].resolve({ ok: true, items: [] }); await flush();
  assert.equal(h.renderFeeds.length, before, 'late callback cannot re-enter the renderer');
  assert.equal(h.renderUi.report().records.some(row => row.origin === 'live-local'), false);
  assert.equal(h.prepared.length, 0);
});

test('start waits for initial preview visibility before opening the host or playing', async t => {
  const h = harness(false, { backend: 'local', localModelId: 'fixture-local-model' });
  t.after(() => h.dispose());
  h.visible = false;
  setup(h); await flush(); await prepared(h);
  const starting = liveAction(h, 'start');
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(h.hostMessages.some(message => message.action === 'start' || message.action === 'translate'), false);
  assert.equal(h.sent.some(message => message.displayPlanPlayback === 'play'), false);
  assert.equal(h.hostRequests.length, 0);
  h.visible = true;
  const started = await starting;
  assert.equal(started.ok, true, started.error);
  assert.equal(h.hostMessages.filter(message => message.action === 'start').length, 1);
  assert.equal(h.sent.filter(message => message.displayPlanPlayback === 'play').length, 1);
  assert.equal(h.hostRequests.length, 0, 'actual playback clock must still start the planner');
});

test('invisible preview times out with no host start, playback, or inference', async t => {
  const h = harness(false, { backend: 'local', localModelId: 'fixture-local-model' });
  t.after(() => h.dispose());
  h.visible = false;
  setup(h); await flush(); await prepared(h);
  const result = await liveAction(h, 'start');
  assert.deepEqual([result.ok, result.error], [false, 'live-preview-not-visible']);
  assert.equal(h.hostMessages.some(message => message.action === 'start' || message.action === 'translate'), false);
  assert.equal(h.sent.some(message => message.displayPlanPlayback === 'play'), false);
  assert.equal(h.hostRequests.length, 0);
  assert.equal((await liveAction(h, 'status')).report.state, 'ready', 'a visible retry remains possible');
});



