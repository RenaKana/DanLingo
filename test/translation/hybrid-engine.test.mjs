import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, LIVE_PROMPT_VERSION } from '../../src/core/config.ts';
import { MemoryTranslationCache, translationCacheKey } from '../../src/translation/cache.ts';
import { TranslationEngine } from '../../src/translation/engine.ts';
import { ProviderError } from '../../src/translation/provider.ts';
import { onlineSettings } from '../fixtures/online-settings.mjs';

const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const local = { ...DEFAULT_SETTINGS, enabled: true, backend: 'local', endpoint: '', model: 'hy-mt-fixture',
  localModelId: 'fixture-model', concurrency: 1, localCapacity: 1, batchSize: 1, liveMaxBatchWaitMs: 0 };
const online = onlineSettings({ enabled: true, concurrency: 1, batchSize: 1, liveMaxBatchWaitMs: 0 });
function request(text, id, overrides = {}) {
  const { hybrid: overridesHybrid, ...other } = overrides;
  return { resourceId: 'bilibili:fixture', settings: online, apiKey: 'fixture-key', mode: 'deadline',
    items: [{ id, text, deadlineAt: performance.now() + 4000 }],
    hybrid: { local, online, localReady: true, onlineReady: true, maxItems: 10, maxChars: 1000,
      p95Ms: 300, capacityKey: 'fixture-model', ...overridesHybrid }, ...other };
}
function memoryProvider(calls) {
  return { complete: data => new Promise(resolve => {
    data.onDispatch?.(data.items, data.settings.backend);
    calls.push({ data, finish: () => resolve({ items: new Map(data.items.map(item =>
      [item.id, { text: '中文译文' }])) }) });
  }) };
}

test('hybrid merges exact shared inputs before route and preserves each cancellation', async t => {
  const calls = [], engine = new TranslationEngine({ provider: memoryProvider(calls) });
  t.after(() => engine.dispose());
  const firstSignal = new AbortController(), secondSignal = new AbortController();
  const first = engine.translate(request('今日は晴れです', 'first', { signal: firstSignal.signal }));
  const second = engine.translate(request('今日は晴れです', 'second', { signal: secondSignal.signal }));
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].data.settings.backend, 'local');
  firstSignal.abort();
  assert.equal(calls[0].data.signal.aborted, false);
  calls[0].finish();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.items[0].reason, 'cancelled');
  assert.equal(b.items[0].status, 'translated');
  assert.equal(b.items[0].backend, 'local');
  const stats = engine.stats().hybrid;
  assert.deepEqual([stats.uniqueTasks, stats.mergedInputs, stats.subscriptions], [1, 1, 2]);
  assert.deepEqual([stats.local.actualRequests, stats.local.inputItems, stats.local.inputChars, stats.local.timelyQualified],
    [1, 1, '今日は晴れです'.length, 1]);
});

test('local cache wins over online and a rejected local cache falls through without dispatch', async t => {
  const cache = new MemoryTranslationCache(), calls = [], engine = new TranslationEngine({ cache, provider: memoryProvider(calls) });
  t.after(() => engine.dispose());
  const text = '今日は晴れです', resourceId = 'bilibili:fixture';
  const localKey = translationCacheKey(resourceId, text, local, LIVE_PROMPT_VERSION);
  const onlineKey = translationCacheKey(resourceId, text, online, LIVE_PROMPT_VERSION);
  await cache.set(localKey, '中文甲', { resourceId });
  await cache.set(onlineKey, '中文乙', { resourceId });
  let needed = 0;
  const first = await engine.translate(request(text, 'first', { hybrid: { localReady: false,
    onLocalNeeded: () => { needed++; } } }));
  assert.equal(first.items[0].text, '中文甲');
  assert.equal(first.items[0].backend, 'local');
  assert.equal(needed, 0);
  await cache.set(localKey, text, { resourceId });
  const second = await engine.translate(request(text, 'second', { hybrid: { localReady: false,
    onLocalNeeded: () => { needed++; } } }));
  assert.equal(second.items[0].text, '中文乙');
  assert.equal(second.items[0].backend, 'online');
  assert.equal(needed, 0);
  assert.equal(calls.length, 0);
  assert.equal(engine.stats().hybrid.local.cacheHits, 1);
  assert.equal(engine.stats().hybrid.online.cacheHits, 1);
});

test('one local slot and one online slot run independently; full online side skips', async t => {
  const calls = [], engine = new TranslationEngine({ maxQueuedItems: 1, provider: memoryProvider(calls) });
  t.after(() => engine.dispose());
  const a = engine.translate(request('一番目の文です', 'a', { hybrid: { maxItems: 1 } }));
  await flush();
  const b = engine.translate(request('二番目の文です', 'b', { hybrid: { maxItems: 1 } }));
  await flush();
  assert.deepEqual(calls.map(call => call.data.settings.backend), ['local', 'online']);
  const c = await engine.translate(request('三番目の文です', 'c', { hybrid: { maxItems: 1 } }));
  assert.equal(c.items[0].status, 'failed');
  assert.equal(c.items[0].reason, 'hybrid-no-capacity');
  assert.equal(calls.length, 2);
  calls.forEach(call => call.finish());
  assert.deepEqual([(await a).items[0].backend, (await b).items[0].backend], ['local', 'online']);
  const stats = engine.stats().hybrid;
  assert.deepEqual([stats.local.actualRequests, stats.online.actualRequests, stats.local.inputItems, stats.online.inputItems], [1, 1, 1, 1]);
});

test('hybrid local dispatch stays single-item even when the local profile permits batching', async t => {
  const calls = [], engine = new TranslationEngine({ provider: memoryProvider(calls) });
  t.after(() => engine.dispose());
  const multiLocal = { ...local, model: 'generic-fixture', concurrency: 3, localCapacity: 3, batchSize: 10 };
  const pending = engine.translate({ ...request('一番目の文です', 'a'),
    items: ['一番目の文です', '二番目の文です', '三番目の文です'].map((text, index) =>
      ({ id: String(index), text, deadlineAt: performance.now() + 4000 })),
    hybrid: { ...request('ignored', 'ignored').hybrid, local: multiLocal } });
  await flush();
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.data.settings.backend === 'local' && call.data.items.length === 1));
  calls.forEach(call => call.finish());
  assert.equal((await pending).items.filter(item => item.backend === 'local').length, 3);
});

test('no P95 only accepts an idle local slot; pure local work occupies that slot', async t => {
  const calls = [], engine = new TranslationEngine({ provider: memoryProvider(calls) });
  t.after(() => engine.dispose());
  const pure = engine.translate({ resourceId: 'bilibili:fixture', settings: local, apiKey: 'local-inference', mode: 'deadline',
    items: [{ id: 'pure', text: '先の純粋な本地文', deadlineAt: performance.now() + 4000 }] });
  await flush();
  const hybrid = engine.translate(request('次の文です', 'hybrid', { hybrid: { p95Ms: undefined } }));
  await flush();
  assert.deepEqual(calls.map(call => call.data.settings.backend), ['local', 'online']);
  calls.forEach(call => call.finish());
  assert.equal((await pure).items[0].status, 'translated');
  assert.equal((await hybrid).items[0].backend, 'online');
});

test('P95 admission counts every pure-local in-flight item inside a batch', async t => {
  const calls = [], engine = new TranslationEngine({ provider: memoryProvider(calls) });
  t.after(() => engine.dispose());
  const batchedLocal = { ...local, model: 'generic-fixture', batchSize: 10 };
  const pure = engine.translate({ resourceId: 'bilibili:fixture', settings: batchedLocal, apiKey: 'local-inference',
    mode: 'deadline', items: ['一番目の文です', '二番目の文です'].map((text, index) =>
      ({ id: String(index), text, deadlineAt: performance.now() + 4000 })) });
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].data.items.length, 2);
  const hybrid = engine.translate(request('追加する文です', 'overflow', { hybrid: { local: batchedLocal, p95Ms: 1500 } }));
  await flush();
  assert.equal(calls[1].data.settings.backend, 'online');
  calls.forEach(call => call.finish());
  assert.equal((await pure).items.length, 2);
  assert.equal((await hybrid).items[0].backend, 'online');
});

test('pre-dispatch cancellation refunds local reservation; actual sends spend UTF-16 window', async t => {
  const calls = [], cancelled = new AbortController();
  let engine;
  engine = new TranslationEngine({ provider: memoryProvider(calls), onTrace: event => {
    if (event.type === 'queued' && event.taskId === 't1') engine.cancelItems(cancelled.signal, ['first']);
  } });
  t.after(() => engine.dispose());
  const a = engine.translate(request('最初の文です', 'first', { signal: cancelled.signal, hybrid: { maxItems: 1 } }));
  assert.equal((await a).items[0].reason, 'cancelled');
  const b = engine.translate(request('😀', 'second', { hybrid: { maxItems: 1, maxChars: 2 } }));
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].data.settings.backend, 'local');
  assert.equal(engine.stats().hybrid.local.inputChars, 2);
  calls[0].finish();
  assert.equal((await b).items[0].backend, 'local');
  const c = engine.translate(request('三番目の文です', 'third', { hybrid: { maxItems: 1 } }));
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].data.settings.backend, 'online');
  calls[1].finish(); await c;
});

test('local retries consume another window entry and never migrate to online', async t => {
  for (const p95Ms of [300, undefined]) {
    let attempts = 0;
    const engine = new TranslationEngine({ provider: { complete: async data => {
      data.onDispatch?.(data.items, data.settings.backend);
      if (++attempts === 1) throw new ProviderError('network-error', true);
      return { items: new Map([[data.items[0].id, { text: '中文译文' }]]) };
    } } });
    t.after(() => engine.dispose());
    const pending = engine.translate(request('再試行の文です', 'retry', { mode: 'vod', priority: 'near',
      hybrid: { maxItems: 2, p95Ms } }));
    assert.equal((await pending).items[0].backend, 'local');
    assert.equal(attempts, 2);
    assert.equal(engine.stats().hybrid.local.inputItems, 2);
    assert.equal(engine.stats().hybrid.online.actualRequests, 0);
  }
});

test('local retry skips a full next queue round without switching to online', async t => {
  for (const p95Ms of [300, undefined]) {
    const calls = [], engine = new TranslationEngine({ provider: { complete: data => new Promise((resolve, reject) => {
      data.onDispatch?.(data.items, data.settings.backend);
      calls.push({ data, resolve, reject });
    }) } });
    t.after(() => engine.dispose());
    const first = engine.translate(request('失敗する文です', 'first', { mode: 'vod', priority: 'near',
      hybrid: { maxItems: 3, p95Ms } }));
    await flush();
    assert.equal(calls.length, 1);
    const waitingText = '待機中の文です';
    const second = p95Ms === undefined
      ? engine.translate({ resourceId: 'bilibili:fixture', settings: local, apiKey: 'local-inference', mode: 'vod',
        items: [{ id: 'second', text: waitingText, deadlineAt: performance.now() + 4000 }] })
      : engine.translate(request(waitingText, 'second', { mode: 'vod', priority: 'near',
        hybrid: { maxItems: 3, p95Ms } }));
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(engine.stats().queuedItems, 1);
    calls[0].reject(new ProviderError('network-error', true));
    const failed = (await first).items[0];
    assert.equal(failed.status, 'failed');
    assert.equal(failed.reason, 'hybrid-local-limit');
    assert.equal(failed.backend, 'local');
    await flush();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].data.items[0].text, waitingText);
    calls[1].resolve({ items: new Map([[calls[1].data.items[0].id, { text: '中文译文' }]]) });
    assert.equal((await second).items[0].status, 'translated');
    assert.equal(engine.stats().retries, 0);
    assert.equal(engine.stats().hybrid.online.actualRequests, 0);
  }
});

test('online results retain online cache identity and local wakeup starts only after a miss', async t => {
  const cache = new MemoryTranslationCache(), calls = [];
  const engine = new TranslationEngine({ cache, provider: memoryProvider(calls) });
  t.after(() => engine.dispose());
  const text = 'オンライン側の結果です';
  let wakeups = 0;
  const pending = engine.translate(request(text, 'first', { hybrid: { localReady: false,
    onLocalNeeded: () => { wakeups++; } } }));
  await flush();
  assert.equal(wakeups, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].data.settings.backend, 'online');
  calls[0].finish();
  assert.equal((await pending).items[0].backend, 'online');
  await flush();
  const resourceId = 'bilibili:fixture';
  assert.equal(await cache.get(translationCacheKey(resourceId, text, local, LIVE_PROMPT_VERSION)), undefined);
  assert.equal(await cache.get(translationCacheKey(resourceId, text, online, LIVE_PROMPT_VERSION)), '中文译文');
  const cached = await engine.translate(request(text, 'second', { hybrid: { localReady: false,
    onLocalNeeded: () => { wakeups++; } } }));
  assert.equal(cached.items[0].backend, 'online');
  assert.equal(cached.items[0].status, 'cached');
  assert.equal(wakeups, 1);
  assert.equal(calls.length, 1);
});

test('local P95 must strictly fit the remaining deadline before admission', async t => {
  const calls = [], engine = new TranslationEngine({ provider: memoryProvider(calls) });
  t.after(() => engine.dispose());
  const pending = engine.translate(request('期日が近い文です', 'near', { hybrid: { p95Ms: 4000 } }));
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].data.settings.backend, 'online');
  calls[0].finish();
  assert.equal((await pending).items[0].backend, 'online');
});

test('local 429 cooldown does not hold the online side', async t => {
  const calls = [];
  const engine = new TranslationEngine({ provider: { complete: async data => {
    calls.push(data.settings.backend);
    data.onDispatch?.(data.items, data.settings.backend);
    if (data.settings.backend === 'local') throw new ProviderError('http-429', true, 429, 5000);
    return { items: new Map(data.items.map(item => [item.id, { text: '中文译文' }])) };
  } } });
  t.after(() => engine.dispose());
  const localResult = await engine.translate(request('最初の文です', 'first', { hybrid: { maxItems: 2 } }));
  assert.equal(localResult.items[0].status, 'original');
  const onlineResult = await engine.translate(request('次の文です', 'second', { hybrid: { maxItems: 2 } }));
  assert.equal(onlineResult.items[0].backend, 'online');
  assert.deepEqual(calls, ['local', 'online']);
});

test('online queue batches items beyond its two active request slots', async t => {
  const calls = [], engine = new TranslationEngine({ maxQueuedItems: 25, provider: memoryProvider(calls) });
  t.after(() => engine.dispose());
  const onlineBatch = { ...online, concurrency: 2, batchSize: 20, liveMaxBatchWaitMs: 0 };
  const context = { ...request('ignored', 'ignored'),
    items: Array.from({ length: 20 }, (_, index) =>
      ({ id: String(index), text: `日本語の文章${index}`, deadlineAt: performance.now() + 4000 })),
    hybrid: { ...request('ignored', 'ignored').hybrid, localReady: false, online: onlineBatch } };
  const first = engine.translate(context);
  await flush();
  assert.equal(calls.length, 1);
  const second = engine.translate({ ...context,
    items: Array.from({ length: 10 }, (_, index) =>
      ({ id: String(index + 20), text: `日本語の文章${index + 20}`, deadlineAt: performance.now() + 4000 })) });
  await flush();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.data.items.length).sort((a, b) => a - b), [5, 20]);
  calls.forEach(call => call.finish());
  const [a, b] = await Promise.all([first, second]);
  assert.equal([...a.items, ...b.items].filter(item => item.backend === 'online').length, 25);
  assert.equal(b.items.filter(item => item.reason === 'hybrid-no-capacity').length, 5);
  assert.equal(engine.stats().hybrid.online.inputItems, 25);
});

test('runtime readiness and local capacity changes retain the same in-flight online calculation', async t => {
  const calls = [], engine = new TranslationEngine({ provider: memoryProvider(calls) });
  t.after(() => engine.dispose());
  const first = engine.translate(request('共有する日本語です', 'a', { hybrid: { localReady: false } }));
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].data.settings.backend, 'online');
  const second = engine.translate(request('共有する日本語です', 'b', { hybrid: {
    localReady: true, local: { ...local, localCapacity: 3, localContextTokens: 8192 } } }));
  await flush();
  assert.equal(calls.length, 1);
  calls[0].finish();
  assert.deepEqual([(await first).items[0].backend, (await second).items[0].backend], ['online', 'online']);
  assert.equal(engine.stats().hybrid.mergedInputs, 1);
});

test('saturated local queue and subscriber pools do not block online or pure online requests', async t => {
  const calls = [], engine = new TranslationEngine({ maxQueuedItems: 2, maxSubscribers: 2, provider: memoryProvider(calls) });
  t.after(() => engine.dispose());
  const pureLocal = { ...local, concurrency: 2, localCapacity: 2 };
  const pure = engine.translate({ resourceId: 'bilibili:fixture', settings: pureLocal, apiKey: 'local-inference',
    mode: 'deadline', items: ['純粋なローカル一', '純粋なローカル二'].map((text, index) =>
      ({ id: `local-${index}`, text, deadlineAt: performance.now() + 4000 })) });
  await flush();
  assert.equal(calls.filter(call => call.data.settings.backend === 'local').length, 2);
  const pureOnline = engine.translate({ resourceId: 'bilibili:fixture', settings: online, apiKey: 'fixture-key',
    mode: 'deadline', items: [{ id: 'pure-online', text: '純粋なオンラインです', deadlineAt: performance.now() + 4000 }] });
  const hybridOnline = engine.translate(request('分流する文です', 'hybrid', { hybrid: { localReady: false } }));
  await flush();
  assert.equal(calls.filter(call => call.data.settings.backend === 'online').length, 1);
  // The online backend is configured for one active request; its second item remains queued.
  calls.forEach(call => call.finish());
  await flush();
  calls.splice(3).forEach(call => call.finish());
  assert.equal((await pure).items.filter(item => item.status === 'translated').length, 2);
  assert.equal((await pureOnline).items[0].status, 'translated');
  assert.equal((await hybridOnline).items[0].backend, 'online');
});

test('local byte saturation does not consume the independent online byte allowance', async t => {
  const text = '独立した容量の確認です', resourceId = 'bilibili:fixture';
  const localKey = translationCacheKey(resourceId, text, local, LIVE_PROMPT_VERSION);
  const onlineKey = translationCacheKey(resourceId, text, online, LIVE_PROMPT_VERSION);
  const logicalKey = JSON.stringify(['hybrid', localKey, onlineKey, '', 'fixture-model', '']);
  const encoder = new TextEncoder();
  const localBytes = encoder.encode(localKey).length + encoder.encode(text).length + 256;
  const hybridBytes = encoder.encode(logicalKey).length + encoder.encode(text).length + 256;
  const byteLimit = Math.max(localBytes, hybridBytes) + 1;
  assert.ok(localBytes + hybridBytes > byteLimit);
  const calls = [], engine = new TranslationEngine({ maxQueuedBytes: byteLimit, provider: memoryProvider(calls) });
  t.after(() => engine.dispose());
  const pure = engine.translate({ resourceId, settings: local, apiKey: 'local-inference', mode: 'deadline',
    items: [{ id: 'pure', text, deadlineAt: performance.now() + 4000 }] });
  await flush();
  const hybrid = engine.translate(request('別の文です', 'online', { hybrid: { localReady: false } }));
  await flush();
  assert.deepEqual(calls.map(call => call.data.settings.backend), ['local', 'online']);
  assert.ok(engine.stats().pendingBytes > byteLimit);
  calls.forEach(call => call.finish());
  assert.equal((await pure).items[0].status, 'translated');
  assert.equal((await hybrid).items[0].backend, 'online');
});

test('missing online endpoint while unavailable still permits local cache and local execution', async t => {
  const calls = [], cache = new MemoryTranslationCache();
  const engine = new TranslationEngine({ cache, provider: memoryProvider(calls) });
  t.after(() => engine.dispose());
  const unavailable = { ...online, endpoint: '', model: '' };
  const options = { settings: unavailable, hybrid: { online: unavailable, onlineReady: false } };
  const first = engine.translate(request('最初の未設定文です', 'a', options));
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].data.settings.backend, 'local');
  calls[0].finish();
  assert.equal((await first).items[0].backend, 'local');
  await flush();
  const second = await engine.translate(request('最初の未設定文です', 'b', options));
  assert.equal(second.items[0].status, 'cached');
  assert.equal(second.items[0].backend, 'local');
  assert.equal(calls.length, 1);
});

test('unchanged online output is skipped without timely credit, cache write or endpoint migration', async t => {
  const cache = new MemoryTranslationCache(), calls = [];
  const engine = new TranslationEngine({ cache, provider: { complete: async data => {
    data.onDispatch?.(data.items, data.settings.backend);
    calls.push(data.settings.backend);
    return { items: new Map(data.items.map(item => [item.id, { text: item.text }])) };
  } } });
  t.after(() => engine.dispose());
  const text = 'そのままの文章です';
  const output = await engine.translate(request(text, 'unchanged', { hybrid: { localReady: false } }));
  assert.equal(output.items[0].status, 'failed');
  assert.equal(output.items[0].reason, 'unqualified-translation');
  assert.equal(output.items[0].backend, 'online');
  assert.deepEqual(calls, ['online']);
  assert.equal(engine.stats().hybrid.online.timelyQualified, 0);
  await flush();
  assert.equal(await cache.get(translationCacheKey('bilibili:fixture', text, online, LIVE_PROMPT_VERSION)), undefined);
});
