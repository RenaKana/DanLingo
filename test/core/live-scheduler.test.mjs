import * as performanceHistory from '../../src/translation/performance-history.ts';
import * as hybridCapacity from '../../src/translation/hybrid-capacity.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveScheduler } from '../../src/core/live-scheduler.ts';
import { DEFAULT_SETTINGS } from '../../src/core/config.ts';
import * as configModule from '../../src/core/config.ts';
import * as resourceModule from '../../src/core/resource.ts';
import * as diagnosticModule from '../../src/core/adapter-diagnostic.ts';
import * as metricsModule from '../../src/core/live-metrics.ts';
import * as videoPolicy from '../../src/core/video-policy.ts';
import * as auditRead from '../../src/diagnostics/bilibili-audit-cache.ts';
import * as livePreviewHost from '../../src/diagnostics/live-preview-host.ts';
import * as timeoutRetryModule from '../../src/core/timeout-retry.ts';
import * as biliEmotes from '../../src/platforms/bilibili-live/emotes.ts';
import * as userFilterWire from '../../src/platforms/bilibili/user-filter-wire.ts';
import * as biliView from '../../src/platforms/bilibili-live/view.ts';
import * as messageModule from '../../src/core/messages.ts';
import { addUsage, ProviderError } from '../../src/translation/provider.ts';
import { LOCAL_CHANNEL } from '../../src/local/types.ts';
import * as localConfig from '../../src/local/config.ts';
import * as providerSettings from '../../src/local/provider-settings.ts';
import * as localPolicy from '../../src/translation/local-policy.ts';
import * as localTranslationProfile from '../../src/local/translation-profile.ts';
import * as autoLoad from '../../src/local/auto-load.ts';
import * as modelCatalog from '../../src/core/model-catalog.ts';
import * as serviceHistory from '../../src/core/service-history.ts';
import * as onlineBudget from '../../src/core/online-budget.ts';
import * as translationShortcut from '../../src/core/translation-shortcut.ts';
import * as modelSummary from '../../src/core/model-summary.ts';
import * as settingsFrame from '../../src/core/settings-frame.ts';
import * as i18nText from '../../src/i18n/text.ts';
import * as i18nWire from '../../src/i18n/wire.ts';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const flush = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, label) {
  for (let n = 0; n < 40; n++) { if (predicate()) return; await flush(); }
  assert.fail(`timed out waiting for ${label}`);
}
const playing = { paused: false, seeking: false, contentActive: true, atLiveEdge: true };
const session = { platform: 'youtube', scenario: 'live', resourceId: 'abcdefghijk', sessionId: 'test-session', generation: 1 };
const msg = (id, receivedAt = 0, extra = {}) => ({ id, sourceId: id, originalText: 'これはテストです', receivedAt, translatable: true, ...extra });

function harness(t, settings = {}, options = {}) {
  let now = 0, nextId = 0;
  const timers = new Map(), calls = [], released = [], removed = [];
  const config = { ...DEFAULT_SETTINGS, enabled: true, liveBufferMs: 500, liveSourceLanguage: 'ja', ...settings };
  const clock = {
    now: () => now, wallNow: () => 1000000 + now,
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const scheduler = new LiveScheduler({ settings: config, clock,
    request: (resource, items, signal, onResult) => new Promise(resolve => calls.push({ resource, items, signal, onResult, resolve, at: now })),
    release: event => { released.push(event); return true; }, remove: ids => removed.push(ids), ...options });
  scheduler.start(session); scheduler.setConnection('connected'); scheduler.setPlayback(playing);
  t.after(() => scheduler.dispose());
  return { scheduler, config, calls, released, removed, now: () => now,
    jump(ms) { now += ms; },
    async advance(ms) {
      const target = now + ms;
      for (let n = 0; ; n++) {
        const next = [...timers.entries()].filter(([, value]) => value.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        assert.ok(n < 10000, 'fake clock encountered a timer loop');
        now = Math.max(now, next[1].at); timers.delete(next[0]); next[1].callback(); await flush();
      }
      now = target; await flush();
    },
    finish(index, status = 'translated') {
      const call = calls[index]; call.resolve(call.items.map(item => ({ id: item.id, text: `译文:${item.id}`, status })));
    },
  };
}

for (const buffer of [500, 1000, 2000, 3000]) test(`${buffer}ms buffer releases once at its original deadline`, async t => {
  const h = harness(t, { liveBufferMs: buffer });
  h.scheduler.ingest([msg('a')]);
  await h.advance(150); h.finish(0); await flush();
  await h.advance(buffer - 151); assert.equal(h.released.length, 0);
  await h.advance(1);
  assert.deepEqual(h.released.map(e => [e.source.id, e.text, e.displayAt, e.releasedAt]), [['a', '译文:a', buffer, buffer]]);
  assert.equal(h.released[0].preparedAt, 150, 'release retains the actual result acceptance time');
  await h.advance(1000); assert.equal(h.released.length, 1);
});

test('local generation changes abort live requests so old results cannot be released', async t => {
  const h = harness(t, { backend: 'local', model: 'local-alias', localModelId: 'snapshot-one',
    localPerformance: { temperature: 0.1, promptMode: 'json', languageValidation: 'strict' } });
  h.scheduler.ingest([msg('local-live')]); await flush();
  const oldCall = h.calls[0];
  h.scheduler.configure({ ...h.config, localPerformance: { ...h.config.localPerformance, temperature: 0.4 } });
  assert.equal(oldCall.signal.aborted, true);
  h.finish(0); await flush(); await h.advance(500);
  assert.equal(h.released.length, 0);
  assert.equal(h.scheduler.getStats().inflight, 0);
});

test('foreground sends immediately and leaves aggregation waiting to the central engine', async t => {
  const h = harness(t);
  h.scheduler.ingest([msg('a')]); await flush();
  assert.equal(h.calls[0].at, 0); assert.equal(h.calls[0].items[0].remainingMs, 500);
  await h.advance(100); h.scheduler.ingest([msg('b', 100)]); await flush();
  assert.equal(h.calls[1].at, 100); assert.equal(h.calls[1].items[0].remainingMs, 500);
});

test('Bilibili mixed-image scheduling retains raw originals and tokens but filters only the prose', async t => {
  const h = harness(t, { liveSourceLanguage: 'auto' });
  h.scheduler.start({ ...session, platform: 'bilibili', resourceId: 'room:22900497' });
  h.scheduler.setConnection('connected'); h.scheduler.setPlayback(playing);
  h.scheduler.ingest([
    msg('mixed', 0, { originalText: '今日は[泣ω]楽しい', emoteTokens: ['[泣ω]'] }),
    msg('chinese', 0, { originalText: '中文[happy]留言', emoteTokens: ['[happy]'] }),
    msg('pure', 0, { originalText: '[笑]！', emoteTokens: ['[笑]'] }),
    msg('bad-token', 0, { originalText: '今日は楽しい', emoteTokens: ['[missing]'] }),
  ]);
  await flush(); assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].items.map(({ id, text, emoteTokens }) => ({ id, text, emoteTokens })), [
    { id: 'mixed', text: '今日は[泣ω]楽しい', emoteTokens: ['[泣ω]'] },
  ]);
  assert.equal(h.scheduler.getStats().notRequired, 3);
});

test('transport envelopes use their own 200 item and 24000 character bounds', async t => {
  const h = harness(t, { batchSize: 1, maxBatchChars: 10, concurrency: 1 });
  h.scheduler.ingest(Array.from({ length: 401 }, (_, i) => msg(String(i)))); await flush();
  assert.deepEqual(h.calls.map(call => call.items.length), [200, 200, 1]);
  assert.ok(h.calls.every(call => call.at === 0));
  const chars = harness(t, { batchSize: 1, maxBatchChars: 10, concurrency: 1 });
  chars.scheduler.ingest(Array.from({ length: 49 }, (_, i) => msg(String(i), 0, { originalText: 'これは長文です'.repeat(142).slice(0, 990) })));
  await flush();
  assert.deepEqual(chars.calls.map(call => call.items.length), [24, 24, 1]);
  assert.ok(chars.calls.every(call => call.items.reduce((sum, item) => sum + item.text.length, 0) <= 24000));
});

test('IPC capacity covers the display buffer and stays independently bounded at 1024', async t => {
  const h = harness(t, { concurrency: 1, batchSize: 1 }, { maxItems: 1100 });
  for (let i = 0; i < 1050; i++) h.scheduler.ingest([msg(String(i))]);
  await flush();
  assert.equal(h.calls.length, 1024); assert.equal(h.scheduler.getStats().inflight, 1024);
  assert.equal(h.scheduler.getStats().queued, 1050);
  h.finish(0); await flush();
  assert.equal(h.calls.length, 1025); assert.equal(h.calls[1024].items.length, 26);
  assert.equal(h.calls[1024].at, 0, 'completion feeds remaining events without an additional batching delay');
});

test('later requests completing first cannot overtake a slow first message', async t => {
  const h = harness(t, { batchSize: 1 });
  h.scheduler.ingest([msg('first')]); await flush(); await h.advance(100);
  h.scheduler.ingest([msg('second', 100)]); await flush(); h.finish(1); await flush();
  await h.advance(400);
  assert.deepEqual(h.released.map(e => [e.source.id, e.translated]), [['first', false]]);
  await h.advance(100);
  assert.deepEqual(h.released.map(e => [e.source.id, e.translated]), [['first', false], ['second', true]]);
  h.finish(0); await flush(); assert.equal(h.released.length, 2);
});

test('out-of-order receive timestamps preserve event arrival order', async t => {
  const h = harness(t); await h.advance(100);
  h.scheduler.ingest([msg('first', 100), msg('second', 0)]);
  await h.advance(500);
  assert.deepEqual(h.released.map(e => [e.source.id, e.displayAt]), [['first', 600], ['second', 600]]);
});

test('equal text with different IDs remains two events and reordered partial results match by ID', async t => {
  const h = harness(t);
  h.scheduler.ingest([msg('a'), msg('b'), msg('c'), msg('a')]); await h.advance(150);
  assert.deepEqual(h.calls[0].items.map(i => i.id), ['a', 'b', 'c']);
  h.calls[0].resolve([{ id: 'c', text: '丙', status: 'cached' }, { id: 'a', text: '甲', status: 'translated' }]);
  await flush(); await h.advance(350);
  assert.deepEqual(h.released.map(e => [e.source.id, e.text]), [['a', '甲'], ['b', 'これはテストです'], ['c', '丙']]);
  assert.equal(h.scheduler.getStats().cacheHits, 1); assert.equal(h.scheduler.getStats().timedOut, 1);
  assert.equal(h.scheduler.getStats().recentEligible, 3); assert.equal(h.scheduler.getStats().recentTranslated, 2);
});

test('each item prepares before an unresolved sibling and releases only at its own deadline', async t => {
  const prepared = [], h = harness(t, {}, { prepare: event => prepared.push(event) });
  await h.advance(100); h.scheduler.ingest([msg('a'), msg('b', 100)]); await flush();
  await h.advance(50);
  h.calls[0].onResult({ id: 'a', text: '甲', status: 'translated' });
  h.calls[0].onResult({ id: 'a', text: '不能覆盖', status: 'translated' });
  h.calls[0].onResult({ id: 'unknown', text: '无效条目', status: 'translated' });
  assert.deepEqual(prepared.map(e => [e.source.id, e.preparedAt]), [['a', 150]]);
  assert.equal(h.released.length, 0); assert.equal(h.scheduler.getStats().inflight, 1);
  await h.advance(350);
  assert.deepEqual(h.released.map(e => [e.source.id, e.text]), [['a', '甲']]);
  assert.equal(h.calls[0].signal.aborted, false, 'released first waiter cannot cancel its pending sibling');
  await h.advance(50); h.calls[0].resolve([{ id: 'a', text: '晚到更改', status: 'cached' }, { id: 'b', text: '乙', status: 'cached' }]); await flush();
  await h.advance(50);
  assert.deepEqual(h.released.map(e => [e.source.id, e.text, e.displayAt]), [['a', '甲', 500], ['b', '乙', 600]]);
  assert.deepEqual(prepared.map(e => e.source.id), ['a', 'b']);
  assert.equal(h.scheduler.getStats().rawEligible, 2); assert.equal(h.scheduler.getStats().onTimeReady, 2);
  assert.deepEqual(h.scheduler.getStats().readinessMs, { p50: 150, p95: 450, p99: 450, samples: 2 });
});

test('equal-text occurrences each accept shared translation output and retain their own display event', async t => {
  const h = harness(t); h.scheduler.ingest([msg('one'), msg('two')]); await flush();
  await h.advance(20);
  for (const id of ['two', 'one']) h.calls[0].onResult({ id, text: '共享译文', status: 'translated' });
  await h.advance(480);
  assert.deepEqual(h.released.map(e => [e.source.id, e.text]), [['one', '共享译文'], ['two', '共享译文']]);
  assert.equal(h.scheduler.getStats().received, 2); assert.equal(h.scheduler.getStats().onTimeReady, 2);
});

test('raw eligibility counts every accepted event including overload while not-required remains separate', async t => {
  const h = harness(t, {}, { maxItems: 2 });
  h.scheduler.ingest([msg('a'), msg('skip', 0, { translatable: false }), msg('overload')]); await flush();
  h.calls[0].onResult({ id: 'a', text: '译文', status: 'cached' });
  await h.advance(500);
  const stats = h.scheduler.getStats();
  assert.equal(stats.received, 3); assert.equal(stats.rawEligible, 2); assert.equal(stats.notRequired, 1);
  assert.equal(stats.onTimeReady, 1); assert.equal(stats.overloaded, 1);
});

test('translation or slow cache results arriving at the deadline cannot replace original text', async t => {
  for (const status of ['translated', 'cached']) {
    const h = harness(t);
    h.scheduler.ingest([msg('a')]); await h.advance(150);
    // Simulate storage/network consuming the remaining 350ms before the timer gets CPU time.
    h.jump(350); h.finish(0, status); await flush(); h.scheduler.tick();
    assert.deepEqual(h.released.map(e => [e.text, e.translated]), [['これはテストです', false]]);
    assert.equal(h.released[0].preparedAt, undefined, 'late output cannot acquire timely preparation evidence');
    assert.equal(h.calls[0].items[0].remainingMs, 350);
    await h.advance(1000); assert.equal(h.released.length, 1); assert.equal(h.scheduler.getStats().cacheHits, 0);
  }
});

test('microtask queue delay reduces the request budget before request invocation', async t => {
  const h = harness(t, { batchSize: 1 });
  h.scheduler.ingest([msg('a')]); h.jump(120); await flush();
  assert.equal(h.calls[0].items[0].remainingMs, 380);
  await h.advance(380); assert.equal(h.released[0].releasedAt, 500);
});

test('an event expiring during transport preparation cannot invalidate a later sibling', async t => {
  const h = harness(t); h.jump(100);
  h.scheduler.ingest([msg('expired', 0), msg('later', 100)]); h.jump(400); await flush();
  assert.deepEqual(h.calls[0].items.map(item => [item.id, item.remainingMs]), [['later', 100]]);
  h.calls[0].onResult({ id: 'later', text: '及时译文', status: 'translated' });
  h.scheduler.tick(); await h.advance(100);
  assert.deepEqual(h.released.map(event => [event.source.id, event.translated]), [['expired', false], ['later', true]]);
});

test('partial failure and provider rejection fall back on schedule without retry storms', async t => {
  const h = harness(t);
  h.scheduler.ingest([msg('a'), msg('b'), msg('c')]); await h.advance(150);
  h.calls[0].resolve([{ id: 'a', text: '', status: 'translated' }, { id: 'b', status: 'failed' }, { id: 'c', status: 'deferred', retryAfterMs: 100 }]);
  await flush(); await h.advance(350);
  assert.equal(h.calls.length, 1); assert.equal(h.released.length, 3); assert.ok(h.released.every(e => !e.translated));
  const rejected = harness(t, {}, { request: async () => { throw new Error('offline'); } });
  rejected.scheduler.ingest([msg('a')]); await rejected.advance(500);
  assert.equal(rejected.released[0].text, 'これはテストです');
});

test('retraction deletes pending events, aborts emptied batches and blocks stale completions', async t => {
  const h = harness(t, { batchSize: 1 });
  h.scheduler.ingest([msg('a')]); h.scheduler.ingest([msg('b')]); await flush();
  h.scheduler.remove(['a']); assert.equal(h.calls[0].signal.aborted, true);
  h.finish(0); h.finish(1); await flush();
  h.scheduler.ingest([msg('a')]); await h.advance(500);
  assert.deepEqual(h.released.map(e => e.source.id), ['b']);
  assert.deepEqual(h.removed, [['a']]); assert.equal(h.scheduler.getStats().removed, 1);
});

test('author deletion removes all queued messages from that author only', async t => {
  const h = harness(t);
  h.scheduler.ingest([msg('a', 0, { authorId: 'user-1' }), msg('b', 0, { authorId: 'user-2' }), msg('c', 0, { authorId: 'user-1' })]);
  await h.advance(150); h.scheduler.removeAuthor('user-1'); h.finish(0); await flush(); await h.advance(350);
  assert.deepEqual(h.released.map(e => e.source.id), ['b']); assert.deepEqual(h.removed, [['a', 'c']]);
});

test('session generation change isolates old results even when the event ID is reused', async t => {
  const h = harness(t, { batchSize: 1 });
  h.scheduler.ingest([msg('same')]); await flush();
  h.scheduler.start({ ...session, generation: 2 }); h.scheduler.setConnection('connected'); h.scheduler.setPlayback(playing);
  assert.equal(h.calls[0].signal.aborted, true);
  h.scheduler.ingest([msg('same')]); await flush();
  h.calls[0].onResult({ id: 'same', text: '旧会话流式结果', status: 'translated' });
  h.calls[1].onResult({ id: 'same', text: '新会话', status: 'translated' });
  h.calls[0].resolve([{ id: 'same', text: '旧会话', status: 'translated' }]);
  h.calls[1].resolve([{ id: 'same', text: '新会话', status: 'translated' }]); await flush(); await h.advance(500);
  assert.deepEqual(h.released.map(e => e.text), ['新会话']); assert.equal(h.scheduler.getStats().received, 1);
});

test('disconnect clears work and reconnect never replays the disconnected baseline', async t => {
  const h = harness(t, { batchSize: 1 });
  h.scheduler.ingest([msg('old')]); await flush(); h.scheduler.setConnection('reconnecting');
  h.scheduler.ingest([msg('offline')]); h.finish(0); await flush(); await h.advance(1000);
  h.scheduler.setConnection('connected'); h.scheduler.ingest([msg('old', 1000), msg('offline', 1000), msg('fresh', 1000)]);
  await flush(); h.finish(1); await flush(); await h.advance(500);
  assert.deepEqual(h.released.map(e => e.source.id), ['fresh']);
});

for (const [label, state] of Object.entries({ pause: { paused: true }, ad: { contentActive: false }, seeking: { seeking: true }, 'away from live edge': { atLiveEdge: false } })) {
  test(`${label} clears pending work and resumes from new events only`, async t => {
    const h = harness(t, { batchSize: 1 }); h.scheduler.ingest([msg('old')]); await flush();
    h.scheduler.setPlayback({ ...playing, ...state }); h.scheduler.ingest([msg('inactive')]);
    assert.equal(h.calls[0].signal.aborted, true); h.finish(0); await flush(); await h.advance(1000);
    h.scheduler.setPlayback(playing); h.scheduler.ingest([msg('old', 1000), msg('inactive', 1000), msg('new', 1000)]);
    await flush(); h.finish(1); await flush(); await h.advance(500);
    assert.deepEqual(h.released.map(e => e.source.id), ['new']);
  });
}

test('item, byte and renderer capacity drops are bounded and never replayed', async t => {
  const h = harness(t, {}, { maxItems: 1 });
  h.scheduler.ingest([msg('a'), msg('b')]); await h.advance(500); h.scheduler.ingest([msg('b', 500)]); await h.advance(500);
  assert.deepEqual(h.released.map(e => e.source.id), ['a']); assert.equal(h.scheduler.getStats().overloaded, 1);
  const bytes = harness(t, {}, { maxBytes: 1 }); bytes.scheduler.ingest([msg('a')]); await bytes.advance(500);
  assert.equal(bytes.released.length, 0); assert.equal(bytes.scheduler.getStats().dropped, 1);
  let attempts = 0;
  const renderer = harness(t, {}, { release: () => { attempts++; return false; } });
  renderer.scheduler.ingest([msg('a')]); await renderer.advance(2000);
  assert.equal(attempts, 1); assert.equal(renderer.scheduler.getStats().overloaded, 1); assert.equal(renderer.scheduler.getStats().released, 0);
});

test('old arrivals and main-thread stalls drop stale events instead of burst catch-up', async t => {
  const aged = harness(t, {}, { maxAgeMs: 100 }); await aged.advance(1000);
  aged.scheduler.ingest([msg('old', 800)]); assert.equal(aged.scheduler.getStats().dropped, 1); assert.equal(aged.calls.length, 0);
  const h = harness(t); h.scheduler.ingest([msg('a'), msg('b')]); await h.advance(150); h.finish(0); await flush();
  h.jump(5000); h.scheduler.tick();
  assert.equal(h.released.length, 0); assert.equal(h.scheduler.getStats().dropped, 2); assert.equal(h.scheduler.getStats().queued, 0);
  h.scheduler.ingest([msg('fresh', h.now())]); await h.advance(500);
  assert.deepEqual(h.released.map(e => e.source.id), ['fresh']);
});

test('only Niconico native scheduling changes display time; buffers already assigned stay fixed', async t => {
  const h = harness(t); h.scheduler.start({ ...session, platform: 'niconico', resourceId: 'lv9' });
  h.scheduler.setConnection('connected'); h.scheduler.setPlayback(playing);
  h.scheduler.ingest([msg('native', 0, { scheduledAt: 100 })]);
  h.scheduler.configure({ ...h.config, liveBufferMs: 3000 }); await h.advance(600);
  assert.equal(h.released[0].displayAt, 600);
  const youtube = harness(t); youtube.scheduler.ingest([msg('youtube', 0, { scheduledAt: 100 })]); await youtube.advance(500);
  assert.equal(youtube.released[0].displayAt, 500);
});

const entrypoints = new Map(['background', 'live.content'].map(name => [name, ts.transpileModule(
  readFileSync(new URL(`../../entrypoints/${name}.ts`, import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText]));
function loadEntrypoint(name, dependencies, globals = {}) {
  const exports = {};
  runInNewContext(entrypoints.get(name), { exports, URL, AbortController, performance, crypto, TextEncoder,
    structuredClone,
    require: key => { assert.ok(key in dependencies, `Unexpected import ${key}`); return dependencies[key]; }, ...globals });
  return exports.default;
}

function liveContentHarness(overrides = {}, now) {
  const h = { calls: [], prepared: [], posts: [], timers: new Map() }, handlers = new Map();
  const clockStamp = () => now ?? resourceModule.clockStamp();
  const location = { href: 'https://www.youtube.com/watch?v=abcdefghijk', origin: 'https://www.youtube.com' };
  const safe = { ok: true, settings: { ...DEFAULT_SETTINGS, enabled: true, ...overrides }, hasKey: true, configVersion: 3 };
  const browser = { runtime: { id: 'test-extension', sendMessage: async message => {
    (h.sent ??= []).push(message);
    if (message.type === 'settings') return safe;
    if (message.type === 'translate') return new Promise(resolve => h.calls.push({ ...message, resolve }));
    return { ok: true };
  }, onMessage: { addListener: listener => { h.receive = listener; }, removeListener() {} } } };
  class Scheduler {
    constructor(options) { h.options = options; }
    start(value) { h.session = value; }
    dispose() {} configure(value) { h.configured = value; } setConnection() {} setPlayback() {} setPresentation() {}
    getStats() { return { received: 0, recentEligible: 0, recentTranslated: 0 }; }
  }
  const view = { attach() {}, configure() {}, update() {}, clear() {}, dispose() {}, repairControl() {} };
  const recentView = { host: {}, capture() {}, prepared() {}, delivered() {}, failed() {}, scanStatus() {}, clear() {}, cancelPending() {}, invalidate() {}, dispose() {} };
  const window = { postMessage(message) { h.posts.push(message); }, addEventListener: (type, listener) => handlers.set(type, listener), removeEventListener() {} };
  const entry = loadEntrypoint('live.content', { 'wxt/browser': { browser },
    '../src/i18n/text.ts': i18nText,
    'wxt/utils/define-content-script': { defineContentScript: options => options },
    '../src/core/config': configModule, '../src/core/resource': { ...resourceModule, clockStamp }, '../src/core/live-metrics': metricsModule, '../src/core/live-scheduler': { LiveScheduler: Scheduler },
    '../src/core/model-summary': modelSummary,
    '../src/core/timeout-retry': timeoutRetryModule,
    '../src/platforms/bilibili-live/emotes': biliEmotes,
    '../src/platforms/bilibili-live/view': biliView,
    '../src/core/messages': messageModule, '../src/translation/text': { protectText: () => ({}) },
    '../src/ui/live-overlay': { createLiveOverlay: () => view }, '../src/ui/live-status': { createLiveStatus: () => view },
    '../src/ui/live-repairs': { createLiveRepairs: options => { h.recentOptions = options; return recentView; } },
  }, { location, document: { querySelector: () => null }, clearInterval() {}, window,
    setTimeout(callback, delay) { const token = {}; h.timers.set(token, { callback, delay }); return token; },
    clearTimeout(token) { h.timers.delete(token); } });
  entry.main({ setInterval() { return 1; }, onInvalidated() {} });
  h.start = async () => {
    await flush();
    handlers.get('message')({ source: window, origin: location.origin, data: { bridge: 'danlingo-live-v1', from: 'adapter', type: 'snapshot',
      platform: 'youtube', resourceId: 'abcdefghijk', adapterSession: 'adapter-session', stamp: clockStamp(),
      connection: 'connected', coverage: 'top', playback: playing, presentationActive: true } });
    await flush();
  };
  h.push = (patch = {}, sender = { id: 'test-extension' }) => h.receive({ type: 'live-translation-result',
    requestId: h.calls[0]?.requestId, session: h.session, configVersion: 3,
    output: { id: 'a', text: '提前译文', status: 'translated' }, ...patch }, sender);
  h.repair = patch => handlers.get('message')({ source: window, origin: location.origin, data: {
    bridge: 'danlingo-live-v1', from: 'adapter', type: 'repair-request', platform: 'youtube', resourceId: 'abcdefghijk',
    adapterSession: 'adapter-session', requestId: crypto.randomUUID(), sourceId: 'ordinary-row', originalText: 'これはテストです',
    strategy: 'manual', purpose: 'timeout', manual: false, force: false, ...patch } });
  return h;
}

for (const budget of [1, 120001, 2147483647]) test(`content admits the configured ${budget}ms timeout retry budget without manual-repair clamping`, async () => {
  const now = 1000000, h = liveContentHarness({ liveBufferMs: budget, youtubeTimeoutRetryEnabled: true, youtubeTimeoutRetryExtraMs: 0 }, now);
  await h.start(); h.repair({ timeoutMs: budget, retryDeadlineAt: now + budget }); await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].repairPurpose, 'timeout');
  assert.equal(h.calls[0].items[0].remainingMs, budget);
  assert.equal([...h.timers.values()][0].delay, budget);
  h.calls[0].resolve({ ok: true, items: [{ id: h.calls[0].items[0].id, text: '测试译文', status: 'translated' }] }); await flush();
  assert.equal(h.timers.size, 0);
});

test('content rejects overflowing timeout retries and still bounds manual repair admission', async () => {
  const now = 1000000, h = liveContentHarness({ youtubeTimeoutRetryEnabled: true }, now); await h.start();
  for (const timeoutMs of [0, 1.1, 2147483648]) h.repair({ timeoutMs, retryDeadlineAt: now + 5000 });
  for (const timeoutMs of [1, 120001]) h.repair({ timeoutMs, purpose: undefined, manual: true });
  await flush(); assert.equal(h.calls.length, 0); assert.equal(h.timers.size, 0);
});

test('content accepts only matching background result envelopes and cleans them up after completion', async () => {
  const h = liveContentHarness(); await h.start();
  const controller = new AbortController();
  const pending = h.options.request(h.session, [{ id: 'a', text: '原文', remainingMs: 1500 }], controller.signal, output => h.prepared.push(output));
  await flush(); assert.equal(h.calls.length, 1);
  h.push({}, { id: 'other-extension' }); h.push({}, { id: 'test-extension', tab: { id: 7 } });
  h.push({ requestId: 'unknown' }); h.push({ configVersion: 2 }); h.push({ session: { ...h.session, generation: 2 } });
  h.push({ output: { id: 'unknown', text: '无效 ID', status: 'translated' } });
  h.push({ output: { id: 'a', text: '', status: 'translated' } });
  assert.equal(h.prepared.length, 0);
  h.push(); h.push(); assert.equal(h.prepared.length, 1, 'a valid item arrives before the request promise settles and prepares once');
  h.calls[0].resolve({ ok: true, items: [{ id: 'a', text: '最终译文', status: 'translated' }] });
  const final = await pending;
  assert.equal(final[0].text, '最终译文', 'final aggregate remains available as fallback');
  h.push(); assert.equal(h.prepared.length, 1, 'completed request no longer receives incremental pushes');
});

test('content cancellation rejects an outstanding push even before its promise settles', async () => {
  const h = liveContentHarness(); await h.start();
  const controller = new AbortController();
  const pending = h.options.request(h.session, [{ id: 'a', text: '原文', remainingMs: 1500 }], controller.signal, output => h.prepared.push(output));
  await flush(); controller.abort(); h.push(); assert.equal(h.prepared.length, 0);
  h.calls[0].resolve({ ok: true, items: [{ id: 'a', text: '晚到', status: 'translated' }] });
  assert.equal((await pending).length, 0);
});

test('test-priority update cancels repairs, disables page translation, and resumes without changing user enabled', async () => {
  const h = liveContentHarness(); await h.start();
  h.repair({ purpose: undefined, manual: true, force: true }); await flush(); assert.equal(h.calls.length, 1);
  const request = h.calls[0];
  const response = { type: 'settings-updated', ok: true, settings: { ...DEFAULT_SETTINGS, enabled: true }, hasKey: true, configVersion: 3 };
  h.receive({ ...response, performancePaused: true }, { id: 'test-extension' });
  assert.equal(h.configured.enabled, false); assert.equal(h.posts.filter(row => row.type === 'control').at(-1).enabled, false);
  assert.ok(h.sent.some(row => row.type === 'cancel' && row.requestId === request.requestId));
  h.repair({ purpose: undefined, manual: true, force: true }); await flush(); assert.equal(h.calls.length, 1);
  request.resolve({ ok: true, items: [{ id: request.items[0].id, text: 'late text', status: 'translated' }] }); await flush();
  assert.equal(h.posts.some(row => row.type === 'repair-result' && row.output?.text === 'late text'), false);
  h.receive({ ...response, performancePaused: false }, { id: 'test-extension' });
  assert.equal(h.configured.enabled, true); assert.equal(h.posts.filter(row => row.type === 'control').at(-1).enabled, true);
});

function liveBackgroundHarness(experiment = false) {
  const h = { buildId: 'test-build-id', calls: [], pushes: [], experimentCalls: [], storageEvents: [], url: experiment
    ? 'https://www.bilibili.com/video/BV1yvhW6sEzi/#danlingo-audit' : 'https://www.youtube.com/watch?v=abcdefghijk' };
  const local = { [configModule.SETTINGS_KEY]: { ...DEFAULT_SETTINGS, enabled: !experiment, batchSize: 1, maxBatchChars: experiment ? 100 : 10,
    backend: experiment ? 'local' : 'online', localModelId: experiment ? 'fixture-local-model' : undefined, model: 'fixture-model',
    endpoint: 'https://provider.example/v1/chat/completions' } };
  h.savedSettings = local[configModule.SETTINGS_KEY];
  h.experimentSession = { platform: 'bilibili', scenario: 'video', resourceId: 'av2:cid62131',
    urlResourceId: 'BV1yvhW6sEzi:p1', sessionId: 'experiment-document', generation: 1 };
  h.localState = { phase: 'ready', backend: 'wllama', model: { id: 'fixture-local-model', name: 'fixture-model' },
    generation: 2, runtime: { parallel: 1, contextTokens: 2048 }, active: 0, queued: 0 };
  const storedSession = { [configModule.KEY_STORAGE_KEY]: { origin: 'https://provider.example', value: 'test-only' } };
  h.emitStorageChange = async (changes, area = 'local') => {
    h.storageEvents.push({ changes: structuredClone(changes), area });
    return h.onStorageChanged?.(changes, area);
  };
  const storage = (values, area) => ({ setAccessLevel: async () => {}, get: async () => ({ ...values }),
    set: async patch => {
      const changes = Object.fromEntries(Object.entries(patch).map(([key, newValue]) => [key, {
        ...(Object.hasOwn(values, key) ? { oldValue: structuredClone(values[key]) } : {}), newValue: structuredClone(newValue),
      }]));
      Object.assign(values, patch);
      await h.emitStorageChange(changes, area);
    },
    remove: async key => {
      const keys = Array.isArray(key) ? key : [key];
      const changes = Object.fromEntries(keys.filter(item => Object.hasOwn(values, item)).map(item => [item, { oldValue: structuredClone(values[item]) }]));
      for (const item of keys) delete values[item];
      if (Object.keys(changes).length) await h.emitStorageChange(changes, area);
    } });
  let listener;
  const browser = { runtime: { id: 'test-extension', getManifest: () => ({ version: h.backgroundVersion ?? '0.4.14' }),
    getURL: path => `chrome-extension://test-extension${path}`,
    onMessage: { addListener: value => { listener = value; } }, sendMessage: async message => { h.runtimeMessages ??= []; h.runtimeMessages.push(structuredClone(message)); } },
    storage: { onChanged: { addListener: fn => { h.onStorageChanged = fn; } }, local: storage(local, 'local'), session: storage(storedSession, 'session') }, permissions: { contains: async () => true },
    tabs: { get: async () => ({ url: h.url }), sendMessage: async (tabId, message, options) => {
      if (message.type === 'verify-live-session') return { ok: true };
      if (experiment && message.type === 'verify-resource-session') {
        if (h.deferNextScope) {
          h.deferNextScope = false; h.scopeBlocked = true;
          await new Promise(resolve => { h.releaseScope = resolve; });
        }
        return { ok: resourceModule.sameSession(message.session, h.experimentSession) };
      }
       if (experiment && message.type === 'bilibili-experiment-preview') return { ok: true,
         version: h.watchVersion ?? '0.4.14',
        buildId: h.watchBuildId ?? h.buildId,
        session: { ...h.experimentSession }, resourceId: h.experimentSession.resourceId,
        items: h.previewItems ?? [{ id: 'dmid-1', text: '测试原文', mediaTimeMs: 10000, translationEligible: true }] };
      if (experiment && message.type === 'bilibili-experiment-configure') {
        if (h.watchExperiment) return { ok: false, error: 'experiment-not-ready' };
        h.experimentSession = { ...h.experimentSession, generation: h.experimentSession.generation + 1 };
        h.watchExperiment = message.runId;
        h.configured = { tabId, message, options };
        return { ok: true, session: { ...h.experimentSession }, version: h.watchVersion ?? '0.4.14',
          buildId: h.watchBuildId ?? h.buildId,
          effectiveBatchLimit: h.watchBatchLimit ?? (message.singleDispatch ? 1 : videoPolicy.videoBatchLimit(h.savedSettings)),
          concurrency: h.watchConcurrency ?? h.savedSettings.concurrency,
          singleDispatch: h.watchSingleDispatch ?? message.singleDispatch };
      }
      if (experiment && message.type === 'bilibili-experiment-stop') {
        h.watchStop = { tabId, message, options };
        if (h.watchExperiment !== message.runId) return { ok: false, error: 'run-mismatch' };
        h.watchExperiment = null;
        return { ok: true };
      }
      if (experiment && message.type === 'bilibili-experiment-result') h.pushes.push({ tabId, message, options });
      if (message.type === 'live-translation-result') h.pushes.push({ tabId, message, options });
    }, onRemoved: { addListener() {} }, onUpdated: { addListener() {} } } };
  class Engine {
    translate(request) { return new Promise(resolve => h.calls.push({ request, resolve })); }
    stats() { return { pendingItems: 0, activeRequests: 0 }; }
    setLiveSession() {} resetFailureState() {} hasLiveWork() { return true; }
  }
  class Cache { async clear() {} }
  const unexpectedNewFlow = () => { throw new Error('This live-delivery fixture must not start model discovery, performance tests or local inference'); };
  class Experiment {
    constructor(options) { h.experimentOptions = options; this.options = options; this.state = 'created'; this.reason = null; }
    async start() { await this.options.assertCurrent(); this.state = 'running'; }
    async translate(items, signal, _priority, onResult) {
      await this.options.assertCurrent();
      h.experimentItems = items;
      const outputs = items.map(item => ({ id: item.id, text: 'Translated text', status: 'translated' }));
      if (h.deferExperiment) return new Promise(resolve => h.experimentCalls.push({ items, signal,
        resolve: () => { if (!signal.aborted) outputs.forEach(onResult); resolve({ items: outputs }); } }));
      outputs.forEach(onResult); return { items: outputs };
    }
    stop(reason) { this.state = 'stopped'; this.reason = reason; }
    snapshot() { return { state: this.state, stopReason: this.reason,
      incomplete: this.state === 'stopped' && this.reason !== 'range-complete',
      configVersion: this.options.configVersion }; }
  }
  loadEntrypoint('background', { 'wxt/browser': { browser }, 'wxt/utils/define-background': { defineBackground: fn => fn() },
    '../src/i18n/wire.ts': i18nWire, '../src/core/build-identity': { BUILD_ID: h.buildId },
    '../src/core/adapter-diagnostic': diagnosticModule,
    '../src/core/video-policy': videoPolicy,
    '../src/diagnostics/bilibili-audit-cache': auditRead,
    '../src/diagnostics/live-preview-host': livePreviewHost,
    '../src/diagnostics/bilibili-local-experiment': { LocalExperiment: Experiment },
    '../src/core/timeout-retry': timeoutRetryModule,
    '../src/platforms/bilibili-live/emotes': biliEmotes,
    '../src/platforms/bilibili/user-filter-wire': userFilterWire,
    '../src/core/config': configModule, '../src/core/messages': messageModule, '../src/core/resource': resourceModule, '../src/core/live-metrics': metricsModule,
    '../src/translation': { TranslationEngine: Engine, IndexedDbTranslationCache: Cache },
    '../src/translation/provider': { addUsage, ProviderError, ChatCompletionsProvider: unexpectedNewFlow,
      setProviderTransportGuard: guard => { h.providerTransportGuard = guard; } }, '../src/translation/model-test': {},
    '../src/translation/performance-history': performanceHistory,
    '../src/translation/hybrid-capacity': hybridCapacity,
    '../src/translation/performance-test': { PerformanceTest: unexpectedNewFlow },
    '../src/local/auto-load': autoLoad, '../src/core/model-catalog': modelCatalog, '../src/core/settings-frame': settingsFrame,
    '../src/core/service-history': serviceHistory, '../src/core/online-budget': onlineBudget, '../src/core/translation-shortcut': { ...translationShortcut, registerTranslationShortcutHandler() {} },
    '../src/local/bridge': { createLocalFetch: unexpectedNewFlow,
      localControl: experiment ? async control => control.action === 'state' ? { ok: true, state: h.localState } : unexpectedNewFlow() : unexpectedNewFlow }, '../src/local/config': localConfig,
    '../src/local/translation-profile': localTranslationProfile,
    '../src/translation/local-policy': localPolicy,
    '../src/local/types': { LOCAL_CHANNEL }, '../src/local/provider-settings': providerSettings, '../src/translation/connection-discovery': { discoverConnectionModels: unexpectedNewFlow } });
  h.sender = { id: 'test-extension', frameId: 0, documentId: experiment ? 'experiment-document' : 'live-document', url: h.url, tab: { id: 7, url: h.url } };
  h.send = (message, sender = h.sender) => new Promise(resolve => listener(message, sender, resolve));
  h.translate = () => h.send({ type: 'translate', resourceId: session.resourceId, session, requestId: crypto.randomUUID(),
    sentAt: resourceModule.clockStamp(), configVersion: 0, items: ['a', 'b'].map(id => ({ id, text: 'これはテストです', remainingMs: 1500 })) });
  return h;
}

test('background delivers validated live items before aggregate completion with session and configuration scope', async () => {
  const h = liveBackgroundHarness(); await h.send({ type: 'session-open', session });
  const pending = h.translate(); await flush(); assert.equal(h.calls.length, 1, 'live transport exceeds the API batch-size setting');
  const call = h.calls[0];
  assert.equal(call.request.items.length, 2); assert.equal(typeof call.request.onResult, 'function');
  call.request.onResult({ id: 'unknown', text: '未知', status: 'translated' });
  call.request.onResult({ id: 'a', text: '提前', status: 'translated' });
  assert.equal(h.pushes.length, 1);
  const push = h.pushes[0];
  assert.equal(push.tabId, 7); assert.equal(push.options.documentId, 'live-document'); assert.equal(push.options.frameId, 0);
  assert.equal(push.message.session.generation, session.generation); assert.equal(push.message.configVersion, 0);
  assert.equal(push.message.output.id, 'a');
  await h.send({ type: 'clear-cache' }, { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' });
  call.request.onResult({ id: 'b', text: '旧配置', status: 'translated' }); assert.equal(h.pushes.length, 1);
  call.resolve({ items: [] }); assert.equal((await pending).ok, false);
});

for (const singleDispatch of [false, true]) test(`dispatch comparison explicitly selects ${singleDispatch ? 'single' : 'existing'} watch dispatch without changing engine settings`, async () => {
  const h = liveBackgroundHarness(true);
  h.savedSettings.maxBatchChars = 12000;
  h.localState.model.name = 'HY-MT-fixture.gguf';
  h.localState.runtime.parallel = 4;
  h.previewItems = [{ id: 'dmid-1', text: '测试原文', mediaTimeMs: 53000, translationEligible: true }];
  await h.send({ type: 'session-open', session: { ...h.experimentSession } });
  const range = { fromMs: 52000, toMs: 67000, prefetchSeconds: 5, resourceId: h.experimentSession.resourceId };
  const preview = await h.send({ type: 'bilibili-experiment-preview', ...range });
  assert.equal(preview.dispatchComparisonReady, true);
  assert.equal(preview.local.singleItem, true);
  const before = structuredClone(h.savedSettings), writes = structuredClone(h.storageEvents);
  const start = { type: 'bilibili-experiment-start', ...range, runId: 'dispatch-test', filterEnabled: true,
    dispatchComparison: true, singleDispatch, allowTexts: ['测试原文'],
    budget: { maxInputItems: 1, maxInputChars: 4, maxAttempts: 1 } };
  assert.equal((await h.send({ ...start, singleDispatch: 'true' })).error, 'invalid-experiment-start');
  assert.equal((await h.send({ ...start, singleDispatch: true, dispatchComparison: false })).error, 'invalid-experiment-start');
  assert.equal((await h.send({ ...start, filterEnabled: false })).error, 'invalid-dispatch-comparison-context');
  h.localState.runtime.parallel = 1;
  assert.equal((await h.send(start)).error, 'invalid-dispatch-comparison-context');
  h.localState.runtime.parallel = 4;
  h.localState.model.name = 'Generic-JSON-model.gguf';
  assert.equal((await h.send(start)).error, 'invalid-dispatch-comparison-context');
  h.localState.model.name = 'HY-MT-fixture.gguf';
  const begun = await h.send(start);
  assert.equal(begun.ok, true);
  assert.deepEqual([begun.dispatch.effectiveBatchLimit, begun.dispatch.concurrency, begun.dispatch.singleDispatch],
    [singleDispatch ? 1 : videoPolicy.videoBatchLimit(before), 2, singleDispatch]);
  assert.equal(h.configured.message.singleDispatch, singleDispatch);
  assert.equal(h.configured.message.filterEnabled, true);
  assert.equal(h.experimentOptions.settings.concurrency, 2);
  assert.equal(h.experimentOptions.localState.runtime.parallel, 4);
  assert.deepEqual(structuredClone(h.experimentOptions.settings), before);
  await h.send({ type: 'bilibili-experiment-stop', runId: start.runId, reason: 'manual' });
  assert.deepEqual(h.savedSettings, before);
  assert.deepEqual(h.storageEvents, writes);
});

async function dispatchHarness(singleDispatch, count = 3) {
  const h = liveBackgroundHarness(true);
  h.savedSettings.maxBatchChars = 12000;
  h.savedSettings.batchSize = 5;
  h.savedSettings.concurrency = 2;
  h.localState.model.name = 'HY-MT-fixture.gguf';
  h.localState.runtime.parallel = 4;
  h.previewItems = Array.from({ length: count }, (_, index) => ({
    id: `dmid-${index + 1}`, text: `原文${index + 1}`, mediaTimeMs: 53000 + index * 1000,
    translationEligible: true,
  }));
  await h.send({ type: 'session-open', session: { ...h.experimentSession } });
  const range = { fromMs: 52000, toMs: 67000, prefetchSeconds: 5, resourceId: h.experimentSession.resourceId };
  const start = { type: 'bilibili-experiment-start', ...range, runId: 'dispatch-gate', filterEnabled: true,
    dispatchComparison: true, singleDispatch, allowTexts: h.previewItems.map(item => item.text),
    budget: { maxInputItems: count, maxInputChars: h.previewItems.reduce((sum, item) => sum + item.text.length, 0),
      maxAttempts: count } };
  const packet = (id, items) => ({ type: 'bilibili-experiment-translate', runId: start.runId,
    requestId: id, resourceId: range.resourceId, session: { ...h.experimentSession },
    configVersion: 0, priority: 'near', items });
  const item = index => ({ id: h.previewItems[index].id, text: h.previewItems[index].text, remainingMs: 1500 });
  return { h, range, start, packet, item };
}

test('background build identity is returned only to a trusted extension UI', async () => {
  const h = liveBackgroundHarness();
  const options = await h.send({ type: 'build-identity' }, {
    id: 'test-extension', url: 'chrome-extension://test-extension/options.html', frameId: 0,
  });
  const { nativeSupply, ownedSupply, protections, ...identity } = options;
  assert.deepEqual(identity, { ok: true, component: 'background', version: '0.4.14', buildId: 'test-build-id', idle: true });
  for (const supply of [nativeSupply, ownedSupply]) {
    assert.equal(supply.ok, true); assert.equal(supply.grant, null);
    assert.equal(supply.activeRequests, 0); assert.equal(supply.onlineCalls, 0);
  }
  assert.equal(protections.effectiveZeroTransport, false);
  const runner = await h.send({ type: 'build-identity' }, {
    id: 'test-extension', url: 'chrome-extension://test-extension/dispatch-runner.html', frameId: 0,
  });
  assert.deepEqual(runner, options);
  assert.equal((await h.send({ type: 'settings' }, {
    id: 'test-extension', url: 'chrome-extension://test-extension/dispatch-runner.html', frameId: 0,
  })).ok, true, 'runner can inspect settings for guarded preparation');
  assert.equal((await h.send({ type: 'save-settings', settings: { enabled: true } }, {
    id: 'test-extension', url: 'chrome-extension://test-extension/dispatch-runner.html', frameId: 0,
  })).ok, false, 'runner has no general settings write access');
  const page = await h.send({ type: 'build-identity' }, h.sender);
  assert.equal(page.ok, false);
});

test('dispatch comparison requires matching preview and configured watch identity and effective policy', async () => {
  const mismatched = await dispatchHarness(true);
  mismatched.h.watchVersion = '0.4.13';
  assert.equal((await mismatched.h.send({ type: 'bilibili-experiment-preview', ...mismatched.range })).error,
    'experiment-build-mismatch');
  const mismatchedBuild = await dispatchHarness(true);
  mismatchedBuild.h.watchBuildId = 'same-version-different-build';
  assert.equal((await mismatchedBuild.h.send({ type: 'bilibili-experiment-preview', ...mismatchedBuild.range })).error,
    'experiment-build-mismatch');
  for (const override of [{ watchBatchLimit: 2 }, { watchConcurrency: 3 }, { watchSingleDispatch: false }]) {
    const { h, range, start } = await dispatchHarness(true);
    const preview = await h.send({ type: 'bilibili-experiment-preview', ...range });
    assert.deepEqual(structuredClone(preview.dispatch), { backgroundVersion: '0.4.14', watchVersion: '0.4.14',
      backgroundBuildId: 'test-build-id', watchBuildId: 'test-build-id',
      savedBatchLimit: 5, concurrency: 2 });
    Object.assign(h, override);
    assert.equal((await h.send(start)).error, 'experiment-dispatch-handshake-mismatch');
    assert.equal(h.watchExperiment, null, 'a mismatched configured watch is cleared');
  }
  const { h, range, start } = await dispatchHarness(true);
  assert.equal((await h.send({ type: 'bilibili-experiment-preview', ...range })).ok, true);
  const begun = await h.send(start);
  assert.equal(begun.ok, true);
  assert.deepEqual(structuredClone(begun.dispatch), { backgroundVersion: '0.4.14', watchVersion: '0.4.14',
    backgroundBuildId: 'test-build-id', watchBuildId: 'test-build-id',
    savedBatchLimit: 5, effectiveBatchLimit: 1, concurrency: 2, comparison: true, singleDispatch: true,
    checkedPackets: 0, admittedPackets: 0, rawPacketSizes: {}, peakRequests: 0, violationReason: null });
  await h.send({ type: 'bilibili-experiment-stop', runId: start.runId });
});

for (const incoming of ['two-valid', 'duplicate-ids', 'invalid-second']) test(`single dispatch rejects entire raw ${incoming} packet before model`, async () => {
  const { h, range, start, packet, item } = await dispatchHarness(true);
  const preview = await h.send({ type: 'bilibili-experiment-preview', ...range });
  assert.equal((await h.send(start)).ok, true);
  const items = [item(0), incoming === 'two-valid' ? item(1)
    : incoming === 'duplicate-ids' ? item(0) : { id: 'bad', text: 'outside-preview', remainingMs: 0 }];
  const denied = await h.send({ ...packet('raw-two', items), configVersion: preview.configVersion });
  assert.equal(denied.error, 'experiment-dispatch-policy-violation');
  assert.equal(h.experimentItems, undefined, 'no translation reaches the model on an invalid raw envelope');
  const stopped = await h.send({ type: 'bilibili-experiment-status', runId: start.runId });
  assert.equal(stopped.report.state, 'stopped');
  assert.equal(stopped.report.stopReason, 'dispatch-policy-violation');
  assert.equal(stopped.report.incomplete, true);
  assert.deepEqual(structuredClone(stopped.dispatch.rawPacketSizes), { 2: 1 });
  assert.deepEqual([stopped.dispatch.checkedPackets, stopped.dispatch.admittedPackets, stopped.dispatch.peakRequests], [1, 0, 0]);
  assert.equal(stopped.dispatch.violationReason, 'single-dispatch-raw-packet-size');
  assert.equal(h.watchStop.message.runId, start.runId);
});

test('third concurrent comparison request stops before translation and retains all-packet evidence', async () => {
  const { h, range, start, packet, item } = await dispatchHarness(false);
  h.deferExperiment = true;
  const preview = await h.send({ type: 'bilibili-experiment-preview', ...range });
  assert.equal((await h.send(start)).ok, true);
  const request = (id, index) => h.send({ ...packet(id, [item(index)]), configVersion: preview.configVersion });
  const first = request('first', 0); await until(() => h.experimentCalls.length === 1, 'first admitted request');
  const second = request('second', 1); await until(() => h.experimentCalls.length === 2, 'second admitted request');
  assert.equal((await request('third', 2)).error, 'experiment-dispatch-policy-violation');
  assert.equal(h.experimentCalls.length, 2, 'the third request cannot reach model translation');
  const stopped = await h.send({ type: 'bilibili-experiment-status', runId: start.runId });
  assert.deepEqual([stopped.report.stopReason, stopped.report.incomplete, stopped.dispatch.peakRequests],
    ['dispatch-policy-violation', true, 2]);
  assert.deepEqual([stopped.dispatch.checkedPackets, stopped.dispatch.admittedPackets], [3, 2]);
  assert.deepEqual(structuredClone(stopped.dispatch.rawPacketSizes), { 1: 3 });
  assert.equal(stopped.dispatch.violationReason, 'more-than-two-active-watch-requests');
  assert.ok(h.experimentCalls.every(call => call.signal.aborted));
  h.experimentCalls.forEach(call => call.resolve());
  assert.equal((await first).ok, false); assert.equal((await second).ok, false);
});

test('a request awaiting scope cannot enter a run after another packet stops it', async () => {
  const { h, range, start, packet, item } = await dispatchHarness(true);
  const preview = await h.send({ type: 'bilibili-experiment-preview', ...range });
  assert.equal((await h.send(start)).ok, true);
  h.deferNextScope = true;
  const waiting = h.send({ ...packet('waiting', [item(0)]), configVersion: preview.configVersion });
  await until(() => h.scopeBlocked, 'request paused in scope verification');
  const violation = await h.send({ ...packet('violation', [item(0), item(1)]),
    configVersion: preview.configVersion });
  assert.equal(violation.error, 'experiment-dispatch-policy-violation');
  h.releaseScope();
  assert.equal((await waiting).error, 'experiment-context-changed');
  const stopped = await h.send({ type: 'bilibili-experiment-status', runId: start.runId });
  assert.deepEqual([stopped.dispatch.checkedPackets, stopped.dispatch.admittedPackets], [1, 0]);
  assert.deepEqual(structuredClone(stopped.dispatch.rawPacketSizes), { 2: 1 });
  assert.equal(h.experimentItems, undefined);
});

test('cancelled request yields a slot to its replacement without publishing its late result', async () => {
  const { h, range, start, packet, item } = await dispatchHarness(true);
  h.deferExperiment = true;
  const preview = await h.send({ type: 'bilibili-experiment-preview', ...range });
  assert.equal((await h.send(start)).ok, true);
  const request = (id, index) => h.send({ ...packet(id, [item(index)]), configVersion: preview.configVersion });
  const first = request('first', 0); await until(() => h.experimentCalls.length === 1, 'first admitted request');
  const second = request('second', 1); await until(() => h.experimentCalls.length === 2, 'second admitted request');
  assert.equal((await h.send({ type: 'bilibili-experiment-cancel', runId: start.runId,
    requestId: 'first', session: { ...h.experimentSession } })).ok, true);
  assert.equal(h.experimentCalls[0].signal.aborted, true);
  const replacement = request('replacement', 2);
  await until(() => h.experimentCalls.length === 3, 'replacement admitted after cancel');
  h.experimentCalls[0].resolve();
  assert.equal((await first).ok, false);
  assert.equal(h.pushes.length, 0);
  const running = await h.send({ type: 'bilibili-experiment-status', runId: start.runId });
  assert.equal(running.report.state, 'running');
  assert.deepEqual([running.dispatch.checkedPackets, running.dispatch.admittedPackets, running.dispatch.peakRequests], [3, 3, 2]);
  assert.equal(running.dispatch.violationReason, null);
  assert.equal((await request('first', 0)).error, 'invalid-experiment-batch', 'cancelled request IDs cannot re-enter');
  h.experimentCalls[1].resolve(); h.experimentCalls[2].resolve();
  assert.equal((await second).ok, true); assert.equal((await replacement).ok, true);
  assert.equal(h.pushes.length, 2);
  await h.send({ type: 'bilibili-experiment-stop', runId: start.runId });
});

test('ordinary non-comparison experiment retains multi-item request behavior', async () => {
  const h = liveBackgroundHarness(true), resourceId = h.experimentSession.resourceId;
  h.previewItems = [
    { id: 'dmid-1', text: '原文一', mediaTimeMs: 10000, translationEligible: true },
    { id: 'dmid-2', text: '原文二', mediaTimeMs: 10001, translationEligible: true },
  ];
  await h.send({ type: 'session-open', session: { ...h.experimentSession } });
  const range = { fromMs: 9000, toMs: 11000, prefetchSeconds: 5, resourceId };
  const preview = await h.send({ type: 'bilibili-experiment-preview', ...range });
  const start = { type: 'bilibili-experiment-start', ...range, runId: 'ordinary-experiment',
    filterEnabled: false, allowTexts: ['原文一', '原文二'],
    budget: { maxInputItems: 2, maxInputChars: 6, maxAttempts: 2 } };
  assert.equal((await h.send(start)).ok, true);
  const response = await h.send({ type: 'bilibili-experiment-translate', runId: start.runId,
    requestId: 'ordinary-batch', resourceId, session: { ...h.experimentSession },
    configVersion: preview.configVersion, priority: 'near', items: [
      { id: 'dmid-1', text: '原文一', remainingMs: 1500 },
      { id: 'dmid-2', text: '原文二', remainingMs: 1500 },
    ] });
  assert.equal(response.ok, true);
  assert.equal(h.experimentItems.length, 2);
  const status = await h.send({ type: 'bilibili-experiment-status', runId: start.runId });
  assert.deepEqual([status.dispatch.comparison, status.dispatch.checkedPackets, status.dispatch.admittedPackets],
    [false, 1, 1]);
  assert.deepEqual(structuredClone(status.dispatch.rawPacketSizes), { 2: 1 });
  await h.send({ type: 'bilibili-experiment-stop', runId: start.runId });
});

test('Bilibili local experiment scopes preview, start, incremental results and retained report to the watch document', async () => {
  const h = liveBackgroundHarness(true);
  const resourceId = h.experimentSession.resourceId;
  assert.equal((await h.send({ type: 'session-open', session: { ...h.experimentSession } })).ok, true);
  const range = { fromMs: 9000, toMs: 11000, prefetchSeconds: 5, resourceId };
  const wrongDocument = { ...h.sender, documentId: 'another-document' };
  assert.equal((await h.send({ type: 'bilibili-experiment-preview', ...range }, wrongDocument)).ok, false);

  const preview = await h.send({ type: 'bilibili-experiment-preview', ...range });
  assert.equal(preview.ok, true);
  assert.equal(preview.items.length, 1);
  assert.equal(preview.items[0].id, 'dmid-1');
  const start = { type: 'bilibili-experiment-start', ...range, runId: 'experiment-one',
    filterEnabled: true, allowTexts: ['测试原文'], budget: { maxInputItems: 1, maxInputChars: 4, maxAttempts: 1 } };
  h.savedSettings.enabled = true;
  assert.equal((await h.send(start)).error, 'experiment-requires-disabled-idle-local');
  h.savedSettings.enabled = false;
  const begun = await h.send(start);
  assert.equal(begun.ok, true);
  assert.equal(begun.report.state, 'running');
  assert.equal(h.configured.options.documentId, 'experiment-document');
  assert.equal(h.experimentSession.generation, preview.session.generation + 1);

  const requestId = 'request-one', experimentSession = { ...h.experimentSession };
  const rejected = await h.send({ type: 'bilibili-experiment-translate', runId: start.runId, requestId,
    resourceId, session: experimentSession, configVersion: preview.configVersion, priority: 'near',
    items: [{ id: 'dmid-1', text: '测试原文', remainingMs: 0 }] });
  assert.equal(rejected.error, 'experiment-item-outside-preview');
  const translated = await h.send({ type: 'bilibili-experiment-translate', runId: start.runId, requestId,
    resourceId, session: experimentSession, configVersion: preview.configVersion, priority: 'near',
    items: [{ id: 'dmid-1', text: '测试原文', remainingMs: 1500 }] });
  assert.equal(translated.ok, true);
  assert.equal(translated.items[0].text, 'Translated text');
  assert.equal(Number.isFinite(h.experimentItems[0].deadlineAt), true);
  assert.equal(h.experimentItems[0].deadlineAt > performance.now(), true);
  assert.equal(h.pushes.length, 1);
  assert.equal(h.pushes[0].message.type, 'bilibili-experiment-result');
  assert.equal(h.pushes[0].message.output.id, 'dmid-1');
  assert.equal(h.pushes[0].message.session.generation, experimentSession.generation);
  assert.equal(h.pushes[0].options.documentId, 'experiment-document');

  const event = (event, details) => h.send({ type: 'bilibili-experiment-watch-event',
    runId: start.runId, session: experimentSession, event, atMs: 200, ...details });
  assert.equal((await event('item-result', { requestId, id: 'dmid-1', status: 'translated', text: 'Translated text' })).ok, true);
  assert.equal((await event('filter-revision', { revision: 2, reset: false, ready: true,
    items: [{ id: 'dmid-1', state: 'filtered' }] })).ok, true);
  const running = await h.send({ type: 'bilibili-experiment-status', runId: start.runId });
  assert.equal(running.report.state, 'running');
  assert.equal(running.watchEvents[0].id, 'dmid-1');
  assert.equal(running.watchEvents[0].status, 'translated');
  assert.equal(running.watchEvents[0].text, 'Translated text');
  assert.equal(running.watchEvents[1].items[0].state, 'filtered');

  const stopped = await h.send({ type: 'bilibili-experiment-stop', runId: start.runId, reason: 'range-complete' });
  assert.equal(stopped.report.state, 'stopped');
  assert.equal(stopped.report.stopReason, 'range-complete');
  assert.equal(h.watchStop.message.runId, start.runId);
  const retained = await h.send({ type: 'bilibili-experiment-status', runId: start.runId });
  assert.equal(retained.ok, true);
  assert.deepEqual(retained.watchEvents, running.watchEvents);
  assert.equal(retained.report.stopReason, 'range-complete');
  assert.equal((await h.send({ type: 'bilibili-experiment-status', runId: start.runId }, wrongDocument)).ok, false);
});

test('Bilibili watch range completion leaves cleanup to the document-scoped UI stop before another run', async () => {
  const h = liveBackgroundHarness(true), resourceId = h.experimentSession.resourceId;
  const range = { fromMs: 9000, toMs: 11000, prefetchSeconds: 5, resourceId };
  const start = runId => ({ type: 'bilibili-experiment-start', ...range, runId,
    filterEnabled: runId === 'experiment-B', allowTexts: ['测试原文'],
    budget: { maxInputItems: 1, maxInputChars: 4, maxAttempts: 1 } });
  assert.equal((await h.send({ type: 'session-open', session: { ...h.experimentSession } })).ok, true);
  assert.equal((await h.send({ type: 'bilibili-experiment-preview', ...range })).ok, true);
  assert.equal((await h.send(start('experiment-A'))).ok, true);
  assert.equal(h.watchExperiment, 'experiment-A');

  const ended = await h.send({ type: 'bilibili-experiment-stopped', runId: 'experiment-A',
    session: { ...h.experimentSession }, reason: 'range-complete' });
  assert.equal(ended.report.stopReason, 'range-complete');
  assert.equal(h.watchStop, undefined, 'watch completion alone does not clear its own experiment state');
  const wrongDocument = { ...h.sender, documentId: 'another-document' };
  assert.equal((await h.send({ type: 'bilibili-experiment-stop', runId: 'experiment-A' }, wrongDocument)).ok, false);
  assert.equal(h.watchExperiment, 'experiment-A');

  const stopped = await h.send({ type: 'bilibili-experiment-stop', runId: 'experiment-A', reason: 'range-complete' });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.report.stopReason, 'range-complete');
  assert.equal(h.watchStop.message.runId, 'experiment-A');
  assert.equal(h.watchStop.options.documentId, 'experiment-document');
  assert.equal(h.watchExperiment, null);
  assert.equal((await h.send({ type: 'bilibili-experiment-preview', ...range })).ok, true);
  assert.equal((await h.send(start('experiment-B'))).ok, true, 'the same watch accepts the next run after cleanup');
});

test('Bilibili cache replay requires zero budget, natural admission and current source identity without a loaded model', async () => {
  const h = liveBackgroundHarness(true), resourceId = h.experimentSession.resourceId;
  h.localState = { phase: 'idle', backend: 'wllama', generation: 3, active: 0, queued: 0 };
  const savedBefore = structuredClone(h.savedSettings);
  const range = { fromMs: 9000, toMs: 11000, prefetchSeconds: 5, resourceId };
  await h.send({ type: 'session-open', session: { ...h.experimentSession } });
  assert.equal((await h.send({ type: 'bilibili-experiment-preview', ...range })).ok, true);
  const storageBeforeReplay = structuredClone(h.storageEvents); // session-open records its existing preload identity.
  const cacheReplay = { resourceId, localModelId: h.savedSettings.localModelId,
    sourceLanguage: h.savedSettings.sourceLanguage, targetLanguage: h.savedSettings.targetLanguage,
    entries: [{ sourceId: 'dmid-1', text: '测试原文', translatedText: 'Existing translation', sourceRunId: 'prior-real-run' }] };
  const start = { type: 'bilibili-experiment-start', ...range, runId: 'cache-control', filterEnabled: false,
    allowTexts: ['测试原文'], budget: { maxInputItems: 0, maxInputChars: 0, maxAttempts: 0 }, cacheReplay };
  assert.equal((await h.send({ ...start, filterEnabled: true })).error, 'invalid-experiment-cache-replay');
  assert.equal((await h.send({ ...start, budget: { ...start.budget, maxAttempts: 1 } })).error, 'invalid-experiment-budget');
  assert.equal((await h.send({ ...start, cacheReplay: { ...cacheReplay,
    entries: [{ ...cacheReplay.entries[0], sourceId: 'another-source' }] } })).error, 'invalid-experiment-cache-replay');
  assert.equal((await h.send({ ...start, cacheReplay: { ...cacheReplay,
    entries: [{ ...cacheReplay.entries[0], text: 'changed source text' }] } })).error, 'invalid-experiment-cache-replay');
  assert.equal((await h.send(start, { ...h.sender, documentId: 'another-document' })).error, 'experiment-preview-required');
  h.localState.active = 1;
  assert.equal((await h.send(start)).error, 'experiment-local-model-not-loaded');
  h.localState.active = 0;
  assert.equal((await h.send(start)).ok, true);
  assert.deepEqual(h.experimentOptions.cacheReplay, cacheReplay);
  assert.equal(h.experimentOptions.localState.phase, 'idle');
  assert.equal(h.configured.message.filterEnabled, false);
  await h.experimentOptions.assertCurrent();
  h.localState.queued = 1;
  await assert.rejects(h.experimentOptions.assertCurrent(), /experiment-model-changed/);
  h.localState.queued = 0;
  await h.send({ type: 'bilibili-experiment-stop', runId: start.runId, reason: 'manual' });
  assert.deepEqual(h.savedSettings, savedBefore);
  assert.deepEqual(h.storageEvents, storageBeforeReplay);
});
