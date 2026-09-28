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
import { LocalExperiment } from '../../src/diagnostics/bilibili-local-experiment.ts';
import * as userFilterSimulation from '../../src/diagnostics/user-filter-simulation.ts';
import * as displayPlanSession from '../../src/diagnostics/display-plan-session.ts';
import { RenderPreviewEngine } from '../../src/core/render-preview.ts';
import { resolveLocalConfig } from '../../src/local/config.ts';
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

test('mirror preserves exact identities, merges early exclusions and restores normal observations', () => {
  const updates = [];
  const mirror = new experimentWatch.BilibiliExperimentWatch(update => updates.push(update));
  const rows = messages.parseSources([source('1', '同じ文', 20000), source('2', '同じ文', 22000)], scope.resourceId, 'bilibili');
  mirror.setEpoch(1);
  assert.equal(updates.length, 0, 'clock snapshot owns visibility on a new epoch');
  mirror.updateSources(rows, [], true);
  assert.deepEqual(mirror.preview({ fromMs: 21000, toMs: 23000, prefetchSeconds: 5 }, 'ja', 'zh-Hans')
    .map(item => [item.id, item.text, item.translationEligible]), [
      [sourceId('2'), '同じ文', true],
    ]);
  assert.deepEqual(mirror.preview({ fromMs: 20000, toMs: 22000, prefetchSeconds: 5 }, 'ja', 'zh-Hans')
    .map(item => item.id), [sourceId('1'), sourceId('2')], 'both hard endpoints are inclusive');
  mirror.normalUpdate({ epoch: 1, revision: 1, reset: true, capability: 'unknown', display: 'visible',
    items: rows.map(row => ({ id: row.id, originalText: row.originalText, state: 'eligible' })) });
  mirror.filterUpdate({ revision: 1, reset: true, ready: true,
    items: [{ id: sourceId('1'), originalText: '同じ文', state: 'filtered' }] });
  assert.equal(updates.at(-1).items.find(row => row.id === sourceId('1')).state, 'filtered');
  assert.equal(updates.at(-1).items.find(row => row.id === sourceId('2')).state, 'eligible');
  mirror.filterUpdate({ revision: 2, reset: false, ready: true,
    items: [{ id: sourceId('1'), originalText: '同じ文', state: 'unknown' }] });
  assert.equal(updates.at(-1).items[0].state, 'eligible');
  mirror.filterUpdate({ revision: 3, reset: false, ready: true,
    items: [{ id: sourceId('2'), originalText: '別の文', state: 'filtered' }] });
  assert.equal(updates.at(-1).items[0].state, 'eligible', 'different source text cannot inherit an exclusion');
  mirror.updateSources([], [sourceId('1')], false);
  assert.equal(mirror.source(sourceId('1')), undefined);
  mirror.clearFilter();
  assert.equal(updates.at(-1).items[0].state, 'eligible');
});

test('filter parser bounds the native bridge and preview range is constrained', () => {
  assert.equal(experimentWatch.validExperimentRange({ fromMs: 1000, toMs: 1000, prefetchSeconds: 5 }), false);
  assert.equal(experimentWatch.validExperimentRange({ fromMs: 1000, toMs: 2000, prefetchSeconds: 5 }), true);
  assert.equal(experimentWatch.parseExperimentFilter({ revision: 1, reset: false, ready: true,
    items: [{ id: 'x', originalText: 'x', state: 'retain' }] }), null);
});

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
  const document = { addEventListener() {}, removeEventListener() {}, querySelectorAll: selector => selector === '[data-danlingo-player]' ? [h.video] : [] };
  const window = { postMessage: data => { h.sent.push(data); if (data.type === 'prepared') h.prepared.push(data); },
    addEventListener: (type, callback) => handlers.set(type, callback), removeEventListener() {} };
  const browser = { runtime: { id: 'test-extension', getManifest: () => ({ version: '0.4.14' }),
    onMessage: { addListener: listener => { h.receive = (message, sender = { id: 'test-extension' }) => listener(message, sender); }, removeListener() {} },
    sendMessage: async message => {
      h.runtime.push(message);
      if (message.type === 'settings') return { ok: true, settings: h.settings, hasKey: true, configVersion: 4 };
      if (message.type === 'bilibili-display-plan-guard') return { ok: true, zeroModelGuard: true, buildId: 'watch-build-test' };
      if (message.type === 'bilibili-render-preview-guard') return { ok: true, zeroModelGuard: true, buildId: 'watch-build-test' };
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
      let engine = null, lastReport = null, enabled = false;
      const api = {
        setEnabled(value) {
          enabled = value;
          if (value && !engine) {
            engine = new RenderPreviewEngine({ mode: 'original', measure: text => ({
              widthPx: text.includes('幅超過') ? 1500 : 80, heightPx: 30, lines: 1 }) });
            engine.setLayout({ widthPx: 600, heightPx: 240, fontSizePx: 20, lineHeightPx: 28,
              paddingXPx: 6, paddingYPx: 2, gapPx: 16 }, h.video.currentTime * 1000);
          }
        },
        feed(input) {
          h.renderFeeds.push(input);
          if (!enabled || !engine) return [];
          return engine.sync({ ...input, mediaTimeMs: h.video.currentTime * 1000,
            eligibility: event => input.eligibilityById?.[event.id] ?? (event.unknown ? 'unknown' : 'retain') });
        },
        isVisible: () => enabled,
        report: () => engine?.report() ?? lastReport ?? { records: [], counts: {} },
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
  return h;
}

test('experiment waits for real playback and native ready, crops requests, and restores saved state', async () => {
  const h = harness(false); h.snapshot(); h.sources([
    source('0', 'これは範囲外です', 18000), source('1', 'これは対象です', 22000),
    source('2', 'これは対象です', 23000), source('3', 'これは範囲外です', 32000),
  ]); await flush();
  const preview = await h.receive({ type: 'bilibili-experiment-preview', fromMs: 20000, toMs: 30000, prefetchSeconds: 5 });
  assert.equal(preview.version, '0.4.14');
  assert.equal(preview.buildId, 'watch-build-test');
  assert.deepEqual(preview.items.map(item => item.id), [sourceId('1'), sourceId('2')]);
  const configured = await h.receive({ type: 'bilibili-experiment-configure', runId: 'run1', configVersion: 4,
    fromMs: 20000, toMs: 30000, prefetchSeconds: 5, filterEnabled: true });
  assert.equal(configured.ok, true);
  assert.equal(configured.buildId, 'watch-build-test');
  assert.equal(h.sent.at(-1).type, 'bilibili-experiment-control');
  assert.equal(h.sent.at(-1).sourceGeneration, 0);
  await assert.rejects(() => h.change('all', 3600), /实验期间/);
  assert.equal(h.runtime.some(row => row.type === 'scheduling-settings'), false);
  h.filter(1, [{ id: sourceId('1'), originalText: 'これは対象です', state: 'filtered' }]);
  await flush(); assert.equal(h.requests.length, 0, 'ready alone cannot pretranslate while paused');
  h.snapshot(21000, false); await flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.sent.filter(row => row.type === 'control').at(-1).enabled, true);
  assert.equal(h.sent.filter(row => row.type === 'control').at(-1).displayMode, 'translated');
  assert.equal(h.requests[0].message.session.generation, configured.session.generation);
  assert.deepEqual(h.requests[0].message.items.map(item => item.id), [sourceId('2')]);
  const request = h.requests[0].message;
  for (const invalid of [{ runId: 'wrong' }, { configVersion: 5 }, { requestId: 'wrong' }])
    h.receive({ type: 'bilibili-experiment-result', runId: 'run1', requestId: request.requestId,
      configVersion: 4, resourceId: scope.resourceId, session: request.session,
      output: { id: sourceId('2'), status: 'translated', text: '即时' }, ...invalid });
  assert.equal(h.prepared.length, 0);
  h.receive({ type: 'bilibili-experiment-result', runId: 'run1', requestId: request.requestId,
    configVersion: 4, resourceId: scope.resourceId, session: request.session,
    output: { id: sourceId('2'), status: 'translated', text: '即时' } });
  assert.equal(h.prepared.length, 1);
  assert.ok(h.events.some(row => row.event === 'item-result'));
  assert.ok(h.events.some(row => row.event === 'prepared'));
  h.snapshot(22000, true); await flush();
  assert.equal(h.sent.filter(row => row.type === 'control').at(-1).enabled, false);
  assert.ok(h.runtime.some(row => row.type === 'bilibili-experiment-stopped' && row.reason === 'paused'));
  assert.ok(h.runtime.some(row => row.type === 'bilibili-experiment-cancel' && row.requestId === request.requestId));
  assert.equal(h.settings.enabled, false);
  h.snapshot(23000, false); h.tick(); await flush();
  assert.equal(h.requests.length, 1, 'saved disabled mode stays disabled after stop');
  h.dispose();
});

test('the first source packet applies its user filter before ordinary translation dispatch', async () => {
  const excludedText = 'This message is excluded';
  const includedText = 'This message should be translated';
  const h = harness(true, { sourceLanguage: 'en', bilibiliUserFilters: true });
  h.snapshot(22000, false);
  await flush();
  h.sources([source('1', excludedText, 22000), source('2', includedText, 23000)], {
    revision: 1, items: [{ id: sourceId('1'), originalText: excludedText, state: 'exclude' }],
  });
  await until(() => h.runtime.some(message => message.type === 'translate'), 'initial ordinary source dispatch');
  assert.deepEqual(h.runtime.filter(message => message.type === 'translate')
    .flatMap(message => message.items.map(item => item.id)), [sourceId('2')]);
  h.dispose();
});

test('seek cleanup retries a rule snapshot dropped before the new playback epoch and confirms the restored state', async () => {
  const h = harness(false, { sourceLanguage: 'en', bilibiliUserFilters: true });
  h.snapshot(22000, false); await flush();
  const text = 'This message should be filtered after the seek';
  h.sources([source('1', text, 22000)]); await flush();

  const row = { id: sourceId('1'), originalText: text, state: 'exclude' };
  const early = { type: 'bilibili-user-filter', epoch: 2, sourceGeneration: 0, revision: 1,
    index: 0, complete: true, detectedAt: h.now, summary: userFilterSummary(1), items: [row] };
  const cleanup = h.receive({ type: 'bilibili-user-filters-control', action: 'cleanup' });
  await flush();
  const refreshesBeforeSeek = h.sent.filter(message => message.type === 'control' && message.userFilterRefresh).length;
  h.post(early);
  assert.equal(h.scheduler.getStats().filtered, 0, 'the transaction is stale until its epoch clock arrives');

  h.post({ type: 'snapshot', epoch: 2, clock: clock(26000, false, { seeking: true }) });
  const refreshesAfterSeek = h.sent.filter(message => message.type === 'control' && message.userFilterRefresh).length;
  assert.equal(refreshesAfterSeek, refreshesBeforeSeek + 1, 'the adopted seek epoch requests the dropped rule transaction again');
  h.post({ ...early, epoch: 2 });

  const result = await cleanup;
  assert.equal(result.ok, true);
  assert.equal(result.report.restored, true, 'cleanup completes only after a valid current-epoch confirmation');
  assert.equal(h.scheduler.getStats().filtered, 1, 'the resent exclusion is applied in the new epoch');
  h.dispose();
});

test('apply latency stays fixed across same-revision heartbeats and updates for a new revision', async () => {
  const h = harness(false); h.snapshot(); await flush();
  const postRevision = (revision, detectedAt) => h.post({ type: 'bilibili-user-filter', sourceGeneration: 0, revision,
    index: 0, complete: true, detectedAt, summary: userFilterSummary(revision), items: [] });
  const latency = async (expectedRevision) => {
    const status = await h.receive({ type: 'bilibili-user-filters-control', action: 'status' });
    assert.equal(status.report.coverage?.revision, expectedRevision, JSON.stringify(status));
    return status.report.applyLatencyMs;
  };

  postRevision(1, 9500);
  assert.equal(await latency(1), 500);
  h.now = 30000; h.snapshot();
  postRevision(1, 9500);
  assert.equal(await latency(1), 500, 'a same-revision heartbeat does not restart its apply timer');
  h.now = 40000; h.snapshot();
  postRevision(2, 39750);
  assert.equal(await latency(2), 250, 'a new revision starts a fresh measurement');
  h.dispose();
});

test('ordinary coverage status clears a stale rule lease and disconnects after player loss', async () => {
  const h = harness(false, { bilibiliUserFilters: true }); h.snapshot(); await flush();
  h.post({ type: 'bilibili-user-filter', sourceGeneration: 0, revision: 1, index: 0, complete: true,
    detectedAt: h.now, summary: userFilterSummary(1), items: [] });
  const read = () => h.receive({ type: 'get-bilibili-user-filter-status' });
  assert.equal((await read()).view.connected, true);
  assert.equal((await read()).view.summary.revision, 1);
  h.now += 7000; h.snapshot();
  assert.equal((await read()).view.stale, true);
  assert.equal((await read()).view.summary, null, 'a clock cannot renew the rule lease');
  h.tick(7000);
  assert.equal((await read()).view.connected, false);
  assert.equal((await read()).view.summary, null);
  assert.equal(await h.receive({ type: 'get-bilibili-user-filter-status' }, { id: 'foreign' }), undefined);
  h.dispose();
});

test('filter heartbeat expires and configuration change exits without accepting late output', async () => {
  const h = harness(false); h.snapshot(); h.sources([source('1', 'これは対象です', 22000)]); await flush();
  await h.receive({ type: 'bilibili-experiment-configure', runId: 'run1', configVersion: 4,
    fromMs: 20000, toMs: 30000, prefetchSeconds: 5, filterEnabled: false });
  h.filter(1, []); h.snapshot(21000, false); await flush();
  const request = h.requests[0];
  h.tick(1600); await flush();
  assert.ok(h.runtime.some(row => row.type === 'bilibili-experiment-stopped' && row.reason === 'filter-lease-expired'));
  request.resolve({ ok: true, items: [{ id: sourceId('1'), status: 'translated', text: '遅延' }] });
  await flush(); assert.equal(h.prepared.length, 0);
  await h.receive({ type: 'bilibili-experiment-configure', runId: 'run1', configVersion: 4,
    fromMs: 20000, toMs: 30000, prefetchSeconds: 5, filterEnabled: false });
  h.receive({ type: 'settings-updated', ok: true, settings: { ...h.settings, prefetchSeconds: 50 },
    hasKey: true, configVersion: 5 });
  assert.ok(h.runtime.some(row => row.type === 'bilibili-experiment-stopped' && row.reason === 'configuration-changed'));
  h.dispose();
});

test('seek exits and the hard end disables later experimental submissions', async () => {
  for (const transition of ['seek', 'end']) {
    const h = harness(false); h.snapshot(); h.sources([source('1', 'これは対象です', 22000),
      source('2', 'これは後半です', 29000)]); await flush();
    await h.receive({ type: 'bilibili-experiment-configure', runId: 'run1', configVersion: 4,
      fromMs: 20000, toMs: 30000, prefetchSeconds: 5, filterEnabled: false });
    h.filter(1, []); h.snapshot(21000, false); await flush();
    const request = h.requests[0];
    if (transition === 'seek') h.post({ type: 'snapshot', epoch: 2, clock: clock(26000, false, { seeking: true }) });
    else h.snapshot(30000, false);
    await flush();
    assert.ok(h.runtime.some(row => row.type === 'bilibili-experiment-stopped' &&
      row.reason === (transition === 'seek' ? 'seek' : 'range-complete')));
    assert.equal(h.sent.filter(row => row.type === 'control').at(-1).enabled, false);
    request.resolve({ ok: true, items: [{ id: sourceId('1'), status: 'translated', text: '遅延' }] });
    await flush(); h.tick(); await flush();
    assert.equal(h.requests.length, 1);
    assert.equal(h.prepared.length, 0);
    h.dispose();
  }
});

test('stopping restores saved enabled, scope and prefetch without persisting the temporary override', async () => {
  const h = harness(true); h.snapshot(); h.sources([source('1', 'これは対象です', 22000)]); await flush();
  const before = h.runtime.filter(row => row.type === 'translate').length;
  assert.ok(before > 0, 'ordinary enabled behavior is present before experiment');
  await h.receive({ type: 'bilibili-experiment-configure', runId: 'run1', configVersion: 4,
    fromMs: 20000, toMs: 30000, prefetchSeconds: 5, filterEnabled: false });
  const stop = await h.receive({ type: 'bilibili-experiment-stop', runId: 'run1' });
  await flush();
  assert.equal(stop.ok, true);
  assert.equal(h.settings.enabled, true);
  assert.equal(h.settings.translationScope, 'all');
  assert.equal(h.settings.prefetchSeconds, 60);
  assert.equal(h.runtime.some(row => row.type === 'scheduling-settings'), false);
  assert.equal(h.sent.filter(row => row.type === 'control').at(-1).enabled, true);
  assert.ok(h.runtime.filter(row => row.type === 'translate').length > before,
    'saved ordinary path resumes after stop');
  h.dispose();
});

test('a hidden native switch remains hidden across experiment configuration and stop', async () => {
  const h = harness(true);
  h.snapshot(20000, true, { commentsVisible: false });
  h.sources([source('1', 'これは対象です', 22000)]); await flush();
  assert.equal(h.runtime.filter(row => row.type === 'translate').length, 0);
  await h.receive({ type: 'bilibili-experiment-configure', runId: 'run1', configVersion: 4,
    fromMs: 20000, toMs: 30000, prefetchSeconds: 5, filterEnabled: false });
  h.filter(1, []);
  h.snapshot(21000, false, { commentsVisible: false }); await flush();
  assert.equal(h.requests.length, 0);
  await h.receive({ type: 'bilibili-experiment-stop', runId: 'run1' });
  h.tick(); await flush();
  assert.equal(h.runtime.filter(row => row.type === 'translate').length, 0,
    'filter restoration does not turn a hidden ordinary renderer into unknown');
  h.snapshot(22000, false, { commentsVisible: true }); await flush();
  assert.equal(h.runtime.filter(row => row.type === 'translate').length, 1);
  h.dispose();
});

test('ordinary and default diagnostic batches retain the saved limit and reject invalid single-dispatch flags', async () => {
  for (const flag of [undefined, false]) {
    const h = harness(true, { backend: 'local', localModelId: 'fixture-model',
      videoBatchSize: 4, batchSize: 5, concurrency: 2, localConcurrency: 2, urgentSeconds: 8 });
    h.snapshot(); h.sources(Array.from({ length: 7 }, (_, i) => source(String(i + 1), `これは対象の文${i + 1}です`, 22000 + i * 1000)));
    await until(() => h.runtime.filter(message => message.type === 'translate').length === 2, 'saved ordinary local batches');
    const groups = [['1', '2', '3', '4', '5'], ['6', '7']].map(ids => ids.map(sourceId));
    assert.deepEqual(h.runtime.filter(message => message.type === 'translate').map(message => message.items.map(item => item.id)), groups);
    const command = { type: 'bilibili-experiment-configure', runId: 'run1', configVersion: 4,
      fromMs: 20000, toMs: 30000, prefetchSeconds: 8, filterEnabled: false };
    assert.equal((await h.receive({ ...command, singleDispatch: 'true' })).ok, false);
    const configured = await h.receive({ ...command, ...(flag === undefined ? {} : { singleDispatch: flag }) });
    assert.equal(configured.ok, true);
    assert.deepEqual([configured.version, configured.effectiveBatchLimit, configured.concurrency, configured.singleDispatch],
      ['0.4.14', 5, 2, false]);
    h.filter(1, []); h.snapshot(21000, false);
    await until(() => h.requests.length === 2, 'saved diagnostic local batches');
    assert.deepEqual(h.requests.map(request => request.message.items.map(item => item.id)), groups);
    assert.equal(h.configured.at(-1).videoBatchSize, 4);
    assert.equal(h.configured.at(-1).batchSize, 5);
    assert.equal(policy.videoBatchLimit(h.configured.at(-1)), 5);
    assert.equal(h.configured.at(-1).concurrency, 2);
    await h.receive({ type: 'bilibili-experiment-stop', runId: 'run1' });
    await until(() => h.runtime.filter(message => message.type === 'translate').length === 4, 'restored ordinary local batches');
    assert.deepEqual(h.runtime.filter(message => message.type === 'translate').slice(2).map(message => message.items.map(item => item.id)), groups);
    assert.equal(h.configured.at(-1).videoBatchSize, 4);
    assert.equal(h.configured.at(-1).batchSize, 5);
    assert.equal(h.settings.videoBatchSize, 4);
    assert.equal(h.settings.batchSize, 5);
    const restoredPreview = await h.receive({ type: 'bilibili-experiment-preview', fromMs: 20000, toMs: 30000, prefetchSeconds: 8 });
    assert.equal(restoredPreview.effectiveBatchLimit, policy.videoBatchLimit(h.configured.at(-1)),
      'preview receipt reports the saved limit after the experiment restores ordinary scheduling');
    assert.equal(h.runtime.some(message => message.type === 'scheduling-settings'), false);
    h.dispose();
  }
});

test('single dispatch frees two request slots on success, failure, rejection, cache hit and cancellation', async () => {
  const h = harness(false, { backend: 'local', localModelId: 'fixture-model',
    videoBatchSize: 5, batchSize: 7, concurrency: 2, localConcurrency: 2 });
  const rows = Array.from({ length: 7 }, (_, i) => source(String(i + 1), `これは対象の文${i + 1}です`, 22000 + i * 1000));
  h.snapshot(); h.sources(rows); await flush();
  const configured = await h.receive({ type: 'bilibili-experiment-configure', runId: 'run1', configVersion: 4,
    fromMs: 20000, toMs: 30000, prefetchSeconds: 8, filterEnabled: false, singleDispatch: true });
  assert.equal(configured.ok, true);
  assert.deepEqual([configured.version, configured.effectiveBatchLimit, configured.concurrency, configured.singleDispatch],
    ['0.4.14', 1, 2, true]);
  h.filter(1, []); h.snapshot(21000, false);
  await until(() => h.requests.length === 2, 'two single-item admissions');
  assert.deepEqual(h.requests.map(request => request.message.items.map(item => item.id)), [['1'], ['2']].map(ids => ids.map(sourceId)));
  assert.equal(h.scheduler.getStats().inflight, 2);
  assert.equal(h.configured.at(-1).videoBatchSize, 1);
  assert.equal(h.configured.at(-1).batchSize, 1);
  assert.equal(policy.videoBatchLimit(h.configured.at(-1)), 1);
  assert.equal(h.configured.at(-1).concurrency, 2);
  const complete = (index, status, text) => h.requests[index].resolve({ ok: true,
    items: [{ id: h.requests[index].message.items[0].id, status, ...(text ? { text } : {}) }] });
  complete(0, 'translated', '译文一');
  await until(() => h.requests.length === 3, 'success releases a slot');
  assert.deepEqual(h.prepared.flatMap(packet => packet.items.map(item => item.id)), [sourceId('1')]);
  complete(1, 'failed');
  await until(() => h.requests.length === 4, 'failed result releases a slot');
  h.requests[2].reject(new Error('background-rejected'));
  await until(() => h.requests.length === 5, 'rejected promise releases a slot');
  complete(3, 'cached', '缓存译文四');
  await until(() => h.requests.length === 6, 'cache hit releases a slot');
  assert.deepEqual(h.prepared.flatMap(packet => packet.items.map(item => item.id)), [sourceId('1'), sourceId('4')]);
  assert.equal(h.scheduler.getStats().cacheHits, 1);
  h.filter(2, [{ id: sourceId('5'), originalText: rows[4].originalText, state: 'filtered' }]);
  await until(() => h.requests.length === 7, 'filtered request cancellation releases a slot');
  assert.ok(h.runtime.some(message => message.type === 'bilibili-experiment-cancel' &&
    message.requestId === h.requests[4].message.requestId));
  assert.ok(h.requests.every(request => request.message.items.length === 1));
  assert.deepEqual(h.requests.map(request => request.message.items[0].id), Array.from({ length: 7 }, (_, i) => sourceId(String(i + 1))));
  assert.equal(h.scheduler.getStats().inflight, 2);
  const late = index => h.receive({ type: 'bilibili-experiment-result', runId: 'run1',
    requestId: h.requests[index].message.requestId, configVersion: 4, resourceId: scope.resourceId,
    session: h.requests[index].message.session,
    output: { id: h.requests[index].message.items[0].id, status: 'translated', text: '迟到的译文' } });
  late(4); complete(4, 'translated', '迟到的译文'); await flush();
  assert.deepEqual(h.prepared.flatMap(packet => packet.items.map(item => item.id)), [sourceId('1'), sourceId('4')]);
  assert.equal((await h.receive({ type: 'bilibili-experiment-stop', runId: 'run1' })).ok, true);
  late(5); complete(5, 'translated', '停止后的译文'); late(6); complete(6, 'translated', '停止后的译文');
  await flush();
  assert.deepEqual(h.prepared.flatMap(packet => packet.items.map(item => item.id)), [sourceId('1'), sourceId('4')]);
  assert.equal(h.configured.at(-1).videoBatchSize, 5);
  assert.equal(h.configured.at(-1).batchSize, 7);
  assert.equal(policy.videoBatchLimit(h.configured.at(-1)), 7);
  assert.equal(h.configured.at(-1).concurrency, 2);
  h.dispose();
});

test('two one-item HY-MT local requests share work; cancelling one keeps the peer and cache', async t => {
  const sourceText = '今日は楽しいです', translatedText = '今天很开心';
  const requests = [], calls = [], prepared = [], cancelled = [];
  const settings = Object.freeze({ ...config.DEFAULT_SETTINGS, enabled: false, backend: 'local',
    localModelId: 'fixture-hy-mt', model: 'fixture-hy-mt', sourceLanguage: 'ja', targetLanguage: 'zh-Hans',
    concurrency: 2, localConcurrency: 2, batchSize: 7, videoBatchSize: 1,
    localPerformance: { promptMode: 'hy-mt', languageValidation: 'strict' } });
  const localState = { phase: 'ready', backend: 'wllama', generation: 8,
    model: { id: 'fixture-hy-mt', name: 'fixture-hy-mt.gguf' },
    runtime: resolveLocalConfig({ mode: 'custom', parallel: 2 }) };
  const experiment = new LocalExperiment({ settings, localState, configVersion: 4,
    resourceId: scope.resourceId, runId: 'run1', allowTexts: [sourceText],
    budget: { maxInputItems: 4, maxInputChars: 200, maxAttempts: 4 },
    assertCurrent: async () => {},
    createLocalFetch: modelId => {
      assert.equal(modelId, settings.localModelId);
      return (_url, init) => new Promise(resolve => calls.push({ body: JSON.parse(init.body), signal: init.signal, resolve }));
    } });
  t.after(() => experiment.stop());
  await experiment.start();
  const translate = (id, signal, received) => {
    const items = [{ id: sourceId(id), text: sourceText, deadlineAt: performance.now() + 30000 }];
    requests.push(items);
    return experiment.translate(items, signal, 'near', received);
  };
  const controller = new AbortController();
  const first = translate('one', controller.signal, output => cancelled.push(output));
  const second = translate('two', undefined, output => prepared.push(output));
  await until(() => calls.length === 1 && experiment.snapshot().engine?.mergedInputs === 1, 'one shared local fetch');
  assert.ok(requests.every(items => items.length === 1));
  assert.equal(calls[0].body.messages.length, 1, 'HY-MT uses a single-item user prompt');
  assert.match(calls[0].body.messages[0].content, /将以下文本翻译为简体中文/);
  assert.ok(calls[0].body.messages[0].content.endsWith(`\n\n${sourceText}`));
  controller.abort();
  const cancelledResult = (await first).items[0];
  assert.deepEqual([cancelledResult.id, cancelledResult.status, cancelledResult.reason],
    [sourceId('one'), 'original', 'cancelled']);
  assert.equal(calls[0].signal.aborted, false, 'the remaining subscriber owns the shared local fetch');
  calls[0].resolve(Response.json({ choices: [{ message: { content: translatedText, finish_reason: 'stop' } }] }));
  const completed = (await second).items[0];
  assert.deepEqual([completed.id, completed.status, completed.text], [sourceId('two'), 'translated', translatedText]);
  assert.deepEqual(prepared.map(output => [output.id, output.status, output.text]),
    [[sourceId('two'), 'translated', translatedText]]);
  assert.equal(cancelled.some(output => output.status === 'translated' || output.status === 'cached'), false);
  await flush();
  const cached = (await translate('three', undefined, output => prepared.push(output))).items[0];
  assert.deepEqual([cached.id, cached.status, cached.text], [sourceId('three'), 'cached', translatedText]);
  assert.deepEqual(prepared.map(output => output.id), [sourceId('two'), sourceId('three')]);
  assert.equal(calls.length, 1);
  const report = experiment.snapshot();
  assert.equal(report.providerCalls, 1);
  assert.equal(report.sentInputItems, 1);
  assert.equal(report.engine.mergedInputs, 1);
  assert.equal(report.engine.cacheHits, 1);
  assert.equal(report.safety.cache, 'memory-only');
  assert.equal(report.safety.persistentCacheWrites, 0);
  assert.equal(report.safety.runtimeParallel, 2);
});

test('display plan waits for complete rules, owns only selected simulated demand, and cleans up without native prepared', async () => {
  const h = harness(false); h.snapshot(20000, false);
  const rows = ['1', '2', '3'].map((id, i) => ({ ...source(id, `日本語の文章です${id}`, 25100 + i), displayPlanEligible: true }));
  h.sources(rows); await flush();
  const control = action => h.receive({ type: 'bilibili-display-plan-control', action });
  await control('run');
  assert.equal((await control('status')).report.simulation.B.events.length, 0);
  const summary = { ...userFilterSummary(1), contract: 'bilibili-core-ba67b466-user-rules-v1', enabled: true,
    mainBuildId: 'watch-build-test', readEvidence: Object.fromEntries(['storeFound', 'methodsMatch', 'callbackMatches',
      'listComplete', 'switchKnown', 'accountScopeKnown'].map(key => [key, true])) };
  const decisions = rows.map(row => ({ id: sourceId(row.sourceId), originalText: row.originalText, state: 'unknown' }));
  const rules = (index, complete, items, value = summary) => h.post({ type: 'bilibili-user-filter', sourceGeneration: 0,
    revision: value.revision, index, complete, detectedAt: h.now, summary: value, items });
  rules(0, false, decisions.slice(0, 1));
  assert.equal((await control('status')).report.simulation.B.events.length, 0);
  rules(1, true, decisions.slice(1)); await new Promise(resolve => setTimeout(resolve, 30));
  const running = await control('status');
  assert.equal(running.report.simulation.A.events.length, 3);
  assert.equal(running.report.simulation.B.events.length, 2);
  assert.equal(running.report.simulation.B.orphanInputs, 0);
  assert.equal(h.runtime.some(row => row.type === 'translate' || row.type === 'bilibili-experiment-translate'), false);
  assert.equal(h.prepared.length, 0);
  assert.equal(h.sent.some(row => row.userFilterObserve === 'start'), false);
  h.tick(7000);
  assert.ok((await h.receive({ type: 'bilibili-display-plan-control', action: 'status' })).ok === false, 'stale bridge rejects live actions');
  h.snapshot(20100, false);
  assert.ok((await control('status')).report.simulation.B.events.every(row => row.state === 'revoked'));
  const cleanup = control('cleanup');
  h.now++;
  rules(0, true, decisions, { ...summary, revision: 2, featureEnabled: h.settings.bilibiliUserFilters });
  h.post({ type: 'snapshot', clock: clock(20000), displayPlanPlayback: { started: false, restored: true, seekCount: 0 } });
  assert.equal((await cleanup).report.restored, true);
  assert.equal(h.sent.filter(row => row.type === 'control').at(-1).enabled, false);
  h.dispose();
});

test('changing translation configuration stops the plan and restores its override before releasing the guard', async () => {
  const h = harness(false); h.snapshot(20000, false); h.sources([]); await flush();
  const action = value => h.receive({ type: 'bilibili-display-plan-control', action: value });
  await action('run');
  const summary = { ...userFilterSummary(1), contract: 'bilibili-core-ba67b466-user-rules-v1', enabled: true,
    mainBuildId: 'watch-build-test', readEvidence: Object.fromEntries(['storeFound', 'methodsMatch', 'callbackMatches',
      'listComplete', 'switchKnown', 'accountScopeKnown'].map(key => [key, true])) };
  h.post({ type: 'bilibili-user-filter', sourceGeneration: 0, revision: 1, index: 0, complete: true,
    detectedAt: h.now, summary, items: [] });
  h.receive({ type: 'settings-updated', ok: true, settings: { ...h.settings, targetLanguage: 'en' },
    configVersion: 5, hasKey: true });
  assert.equal(h.sent.filter(row => row.type === 'control').at(-1).displayPlanPlayback, 'restore');
  assert.equal(h.runtime.some(row => row.type === 'bilibili-display-plan-guard' && row.action === 'cleanup'), false);
  h.now++;
  h.post({ type: 'bilibili-user-filter', sourceGeneration: 0, revision: 2, index: 0, complete: true,
    detectedAt: h.now, summary: { ...summary, revision: 2, featureEnabled: h.settings.bilibiliUserFilters }, items: [] });
  h.post({ type: 'snapshot', clock: clock(20000), displayPlanPlayback: { started: false, restored: true, seekCount: 0 } });
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.ok(h.runtime.some(row => row.type === 'bilibili-display-plan-guard' && row.action === 'cleanup'));
  assert.equal((await action('status')).enabled, false);
  assert.equal(h.prepared.length, 0); h.dispose();
});

const renderRuleSummary = revision => ({ ...userFilterSummary(revision),
  contract: 'bilibili-core-ba67b466-user-rules-v1', enabled: true,
  mainBuildId: 'watch-build-test', readEvidence: Object.fromEntries(['storeFound', 'methodsMatch',
    'callbackMatches', 'listComplete', 'switchKnown', 'accountScopeKnown'].map(key => [key, true])) });
const renderRules = (h, revision, rows, featureEnabled = true) => h.post({ type: 'bilibili-user-filter',
  sourceGeneration: 0, revision, index: 0, complete: true, detectedAt: h.now,
  summary: { ...renderRuleSummary(revision), featureEnabled }, items: rows });
const renderControl = (h, action, sender) => h.receive({ type: 'bilibili-render-preview-control', action }, sender);

test('render control alone starts B, feeds only its real selected events, and early rejection suppresses its own subscription', async () => {
  const h = harness(false); h.snapshot(20000, false);
  const rows = [source('1', '幅超過の日本語の文章です', 25100), source('2', '日本語の文章です二', 25101),
    source('3', '日本語の文章です三', 25102)].map(row => ({ ...row, displayPlanEligible: true }));
  h.sources(rows); await flush();
  assert.equal(h.renderFeeds.length, 0);
  const idle = await renderControl(h, 'status');
  assert.equal(idle.enabled, false);
  assert.equal(idle.report.simulation, null);
  assert.equal(h.renderFeeds.length, 0);
  const started = await renderControl(h, 'run');
  assert.equal(started.ok, true, started.error);
  assert.equal(started.enabled, true);
  assert.equal(started.report.simulation.A, undefined, 'render task does not instantiate the unbounded comparison');
  assert.equal(started.report.simulation.B.events.length, 0, 'unconfirmed rules cannot freeze a selection');
  renderRules(h, 1, rows.map(row => ({ id: sourceId(row.sourceId), originalText: row.originalText, state: 'unknown' })));
  await new Promise(resolve => setTimeout(resolve, 30));
  const running = await renderControl(h, 'export');
  const selected = running.report.simulation.B.events;
  assert.equal(selected.length, 2);
  assert.deepEqual(selected.map(row => row.id), [sourceId('1'), sourceId('2')]);
  assert.equal(running.report.simulation.B.previewExcludedSubscriptions, 1);
  assert.equal(running.report.simulation.B.subscriptions, 1);
  assert.deepEqual(h.renderFeeds.at(-1).events.map(row => row.id), selected.map(row => row.id));
  assert.equal(running.report.render.records.find(row => row.id === sourceId('1')).state, 'oversize');
  assert.equal(h.runtime.some(row => row.type === 'translate' || row.type === 'bilibili-experiment-translate'), false);
  assert.equal(h.prepared.length, 0);
  h.dispose();
});

test('an already due selected object is withdrawn by a new exclude, while epoch change clears its peer', async () => {
  const h = harness(false); h.snapshot(20000, false);
  const rows = [source('1', '日本語の文章です一', 25100), source('2', '日本語の文章です二', 25101)]
    .map(row => ({ ...row, displayPlanEligible: true }));
  h.sources(rows); await flush();
  assert.equal((await renderControl(h, 'run')).ok, true);
  renderRules(h, 1, rows.map(row => ({ id: sourceId(row.sourceId), originalText: row.originalText, state: 'unknown' })));
  h.snapshot(25110, false);
  assert.equal(h.renderTick().active.length, 2);
  const alreadyDue = (await renderControl(h, 'export')).report.simulation.B.events.find(row => row.id === sourceId('1'));
  assert.equal(alreadyDue.state, 'due');
  renderRules(h, 2, [
    { id: sourceId('1'), originalText: rows[0].originalText, state: 'exclude' },
    { id: sourceId('2'), originalText: rows[1].originalText, state: 'unknown' },
  ]);
  const lastFeed = h.renderFeeds.at(-1);
  assert.equal(lastFeed.eligibilityById[sourceId('1')], 'exclude');
  assert.equal(lastFeed.events.find(row => row.id === sourceId('1')).state, 'due');
  assert.equal(h.renderUi.report().records.find(row => row.id === sourceId('1')).reason, 'rule-excluded');
  assert.equal(h.renderTick().active.length, 1);
  h.video.currentTime = 30;
  h.post({ type: 'snapshot', epoch: 2, clock: clock(30000, false) });
  assert.equal(h.renderFeeds.at(-1).epoch, 2);
  assert.equal(h.renderUi.report().records.find(row => row.id === sourceId('2')).state, 'environment-reset');
  assert.equal(h.renderTick().active.length, 0);
  h.dispose();
});

test('render RPC requires same-extension no-tab sender, and cleanup retains sample history but restores user override', async () => {
  const h = harness(false); h.snapshot(20000, false);
  for (const sender of [{ id: 'other-extension' }, { id: 'test-extension', tab: { id: 7 } }])
    assert.equal(await renderControl(h, 'run', sender), undefined);
  assert.equal(h.renderFeeds.length, 0);
  const row = { ...source('1', '日本語の文章です', 25100), displayPlanEligible: true };
  h.sources([row]); await flush();
  assert.equal((await renderControl(h, 'run')).ok, true);
  renderRules(h, 1, [{ id: sourceId('1'), originalText: row.originalText, state: 'unknown' }]);
  h.snapshot(25110, false);
  const active = h.renderTick().active;
  assert.equal(active.length, 1);
  h.video.currentTime = 25.2;
  h.renderSample(active.map(item => item.key));
  assert.equal(h.renderUi.report().counts.visibleDistinct, 1);
  h.post({ type: 'snapshot', clock: clock(25200, false), displayPlanPlayback: {
    started: true, restored: false, seekCount: 0, owner: 'render-preview', restoreDisposition: 'pending', playbackListeners: 2 } });
  const cleanup = renderControl(h, 'cleanup');
  h.now++;
  renderRules(h, 2, [{ id: sourceId('1'), originalText: row.originalText, state: 'unknown' }], false);
  let settled = false; cleanup.then(() => { settled = true; });
  await flush(); assert.equal(settled, false, 'rule confirmation alone does not prove playback restoration');
  h.post({ type: 'snapshot', clock: clock(25200, false), displayPlanPlayback: {
    started: false, restored: true, seekCount: 0, owner: 'render-preview', restoreDisposition: 'restored-baseline', playbackListeners: 0 } });
  const restored = await cleanup;
  assert.equal(restored.ok, true, restored.error);
  assert.equal(restored.report.restored, true);
  assert.equal(restored.report.render.counts.committed ?? 0, 0);
  assert.equal(restored.report.render.counts.visibleDistinct, 1, 'the past sample is retained as history');
  assert.equal(restored.report.render.records[0].state, 'closed');
  assert.equal(h.renderTick(), undefined, 'mock renderer has no activity after cleanup');
  assert.equal(h.settings.enabled, false);
  assert.equal(h.settings.translationScope, 'all');
  assert.equal(h.settings.prefetchSeconds, 60);
  assert.equal(h.sent.filter(message => message.type === 'control').at(-1).bilibiliUserFilters, false);
  h.dispose();
});



