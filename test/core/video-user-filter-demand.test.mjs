import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoScheduler } from '../../src/core/scheduler.ts';
import { TranslationEngine } from '../../src/translation/engine.ts';
import { MemoryTranslationCache, translationCacheKey } from '../../src/translation/cache.ts';
import { onlineSettings } from '../fixtures/online-settings.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let n = 0; n < 100; n++) { if (predicate()) return; await flush(); }
  assert.fail('expected asynchronous state was not reached');
}
const source = (id, originalText = 'これはテストです', mediaTimeMs = 2000) => ({
  id, sourceId: id, resourceId: 'sm9', threadId: '1', fork: 'main', platform: 'bilibili',
  originalText, mediaTimeMs, renderAtMs: mediaTimeMs - 2000, translatable: true, style: { commands: [] },
});
const clock = (mediaTimeMs = 0, seeking = false) => ({
  mediaTimeMs, playbackRate: 1, paused: true, seeking, contentActive: true, durationMs: 600000, buffered: [],
});
const filter = (revision, rows, extra = {}) => ({
  epoch: 0, revision, reset: true,
  items: rows.map(([m, state]) => ({ id: m.id, originalText: m.originalText, state })), ...extra,
});
function harness(t, { cache = new MemoryTranslationCache(), settings = onlineSettings({
  enabled: true, translationScope: 'all', batchSize: 8, videoBatchSize: 8, concurrency: 1,
}), provider } = {}) {
  const calls = [], prepared = [], removed = [], cancellations = [];
  const engine = new TranslationEngine({ cache, provider: provider ?? {
    complete: request => new Promise(resolve => calls.push({ request, resolve })),
  } });
  const scheduler = new VideoScheduler({ settings, now: () => 0,
    reset: () => {}, prepared: items => prepared.push(...items), removed: ids => removed.push(...ids),
    cancelItems: (signal, ids) => { cancellations.push({ signal, ids }); engine.cancelItems(signal, ids); },
    request: (resourceId, items, signal, priority, onResult) => engine.translate({
      resourceId, items: items.map(item => ({ id: item.id, text: item.text, deadlineAt: performance.now() + item.remainingMs })),
      settings, apiKey: 'fixture-only', signal, priority, mode: 'vod', onResult,
    }).then(response => response.items),
  });
  t.after(() => { scheduler.dispose(); engine.dispose(); });
  return { engine, scheduler, calls, prepared, removed, cancellations };
}

test('atomic source filtering keeps the unblocked author of identical text; all excluded sends nothing', async t => {
  const h = harness(t);
  const blocked = source('author-a'), retained = source('author-b');
  h.scheduler.snapshot('sm9', 'session', clock());
  h.scheduler.updateSources([blocked, retained], [], true, true, filter(1, [[blocked, 'exclude'], [retained, 'retain']]));
  await until(() => h.calls.length === 1);
  assert.equal(h.calls[0].request.items.length, 1);
  assert.deepEqual(h.removed.slice(-1), ['author-a']);
  h.calls[0].resolve({ items: new Map([[h.calls[0].request.items[0].id, { text: '翻訳です' }]]) });
  await until(() => h.prepared.length === 1);
  assert.deepEqual(h.prepared.map(item => item.id), ['author-b']);

  const second = harness(t);
  second.scheduler.snapshot('sm9', 'session', clock());
  second.scheduler.updateSources([blocked, retained], [], true, true, filter(1, [[blocked, 'exclude'], [retained, 'exclude']]));
  await flush();
  assert.equal(second.calls.length, 0);
  assert.equal(second.engine.stats().subscribers, 0);
  assert.equal(second.scheduler.getStats().filtered, 2);
});

test('queued partial cancellation removes only the invalid event before provider admission', async t => {
  const h = harness(t);
  const a = source('a', '最初の文章です'), b = source('b', '別の文章です');
  h.scheduler.snapshot('sm9', 'session', clock(), [a, b]);
  h.scheduler.updateUserFilter(filter(1, [[a, 'exclude']]));
  assert.deepEqual(h.cancellations.map(entry => entry.ids), [['a']]);
  await until(() => h.calls.length === 1);
  assert.equal(h.calls[0].request.items.length, 1);
  assert.equal(h.calls[0].request.items[0].text, b.originalText);
  h.calls[0].resolve({ items: new Map([[h.calls[0].request.items[0].id, { text: '残る翻訳です' }]]) });
  await until(() => h.prepared.length === 1);
  assert.deepEqual(h.prepared.map(item => item.id), ['b']);
  assert.equal(h.scheduler.getStats().filtered, 1);
});

test('in-flight shared text retains the valid subscriber, while a fully invalid batch aborts', async t => {
  const h = harness(t);
  const a = source('a'), b = source('b');
  h.scheduler.snapshot('sm9', 'session', clock(), [a, b]);
  await until(() => h.calls.length === 1);
  h.scheduler.updateUserFilter(filter(1, [[a, 'exclude']]));
  assert.equal(h.calls[0].request.signal.aborted, false);
  assert.equal(h.engine.stats().subscribers, 1);
  h.calls[0].resolve({ items: new Map([[h.calls[0].request.items[0].id, { text: '共有訳文です' }]]) });
  await until(() => h.prepared.length === 1);
  assert.deepEqual(h.prepared.map(item => item.id), ['b']);

  const other = harness(t);
  other.scheduler.snapshot('sm9', 'session', clock(), [a, b]);
  await until(() => other.calls.length === 1);
  other.scheduler.updateUserFilter(filter(1, [[a, 'exclude'], [b, 'exclude']]));
  assert.equal(other.calls[0].request.signal.aborted, true);
  other.calls[0].resolve({ items: new Map([[other.calls[0].request.items[0].id, { text: '遅れた訳文' }]]) });
  await flush();
  assert.equal(other.prepared.length, 0);
  assert.equal(other.engine.stats().subscribers, 0);
});

test('cached result is withdrawn and republished after unblocking without another model call', async t => {
  const settings = onlineSettings({ enabled: true, translationScope: 'all', batchSize: 1, videoBatchSize: 1 });
  const cache = new MemoryTranslationCache();
  const m = source('cached');
  await cache.set(translationCacheKey('sm9', m.originalText, settings), '既存の翻訳です', { resourceId: 'sm9' });
  const h = harness(t, { settings, cache });
  h.scheduler.snapshot('sm9', 'session', clock(), [m]);
  await until(() => h.prepared.length === 1);
  h.scheduler.updateUserFilter(filter(1, [[m, 'exclude']]));
  assert.ok(h.removed.includes(m.id));
  assert.equal(h.scheduler.getStats().translated, 0);
  h.scheduler.updateUserFilter(filter(2, [[m, 'retain']]));
  assert.deepEqual(h.prepared.map(item => item.id), ['cached', 'cached']);
  assert.equal(h.calls.length, 0);
  assert.equal(h.scheduler.getStats().cacheHits, 1);

  const blocked = source('cached-at-entry');
  h.scheduler.updateSources([blocked], [m.id], false, true, filter(3, [[blocked, 'exclude']]));
  await flush();
  assert.equal(h.prepared.length, 2);
  h.scheduler.updateUserFilter(filter(4, [[blocked, 'unknown']]));
  await until(() => h.prepared.length === 3);
  assert.equal(h.prepared[2].id, blocked.id);
  assert.equal(h.calls.length, 0);
});

test('late result from an excluded request cannot fill the restored subscription', async t => {
  const h = harness(t, { settings: onlineSettings({ enabled: true, translationScope: 'all',
    batchSize: 1, videoBatchSize: 1, concurrency: 1 }) });
  const m = source('same');
  h.scheduler.snapshot('sm9', 'session', clock(), [m]);
  await until(() => h.calls.length === 1);
  h.scheduler.updateUserFilter(filter(1, [[m, 'exclude']]));
  assert.equal(h.calls[0].request.signal.aborted, true);
  h.scheduler.updateUserFilter(filter(2, [[m, 'retain']]));
  h.calls[0].resolve({ items: new Map([[h.calls[0].request.items[0].id, { text: '古い訳文です' }]]) });
  await until(() => h.calls.length === 2);
  assert.equal(h.prepared.length, 0);
  h.calls[1].resolve({ items: new Map([[h.calls[1].request.items[0].id, { text: '現在の訳文です' }]]) });
  await until(() => h.prepared.length === 1);
  assert.equal(h.prepared[0].text, '現在の訳文です');
});

test('revision chunks and epochs reject stale exclusion without promoting native unknown', async t => {
  const settings = onlineSettings({ enabled: true, translationScope: 'auto', prefetchSeconds: 30, batchSize: 1, videoBatchSize: 1 });
  const h = harness(t, { settings });
  const far = source('far', '遠い文章です', 300000), near = source('near');
  h.scheduler.snapshot('sm9', 'session', clock());
  h.scheduler.updateSources([far, near], [], true, true, filter(3, [[near, 'exclude']]));
  h.scheduler.updateUserFilter(filter(3, [[far, 'retain']], { reset: false }));
  h.scheduler.updateUserFilter(filter(3, [[near, 'retain']]));
  h.scheduler.updateUserFilter(filter(2, [[near, 'retain']], { reset: false }));
  assert.equal(h.calls.length, 0);
  assert.equal(h.scheduler.getStats().filtered, 1);
  h.scheduler.updateEligibility({ epoch: 0, revision: 1, reset: true, capability: 'filtered-pool', display: 'visible', items: [] });
  assert.equal(h.scheduler.getStats().effectiveScope, 'all');
  assert.equal(h.calls.length, 0, 'user retain does not grant native eligibility');
  h.scheduler.updateEligibility({ epoch: 0, revision: 2, reset: false, capability: 'filtered-pool', display: 'visible',
    items: [{ id: far.id, originalText: far.originalText, state: 'eligible' }] });
  assert.equal(h.calls.length, 0, 'far work enters the engine asynchronously');
  await until(() => h.calls.length === 1);
  h.scheduler.snapshot('sm9', 'session', clock(0, true), undefined, 1);
  h.scheduler.updateUserFilter(filter(100, [[far, 'exclude']], { epoch: 0 }));
  h.scheduler.updateUserFilter(filter(0, [[near, 'exclude']], { epoch: 1 }));
  h.scheduler.snapshot('sm9', 'session', clock(), undefined, 1);
  assert.equal(h.scheduler.getStats().filtered, 1);
  h.scheduler.updateUserFilter(filter(0, [[near, 'retain']], { epoch: 1, reset: false }));
  assert.equal(h.scheduler.getStats().filtered, 0);
});
