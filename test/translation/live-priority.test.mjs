import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, normalizeSettings, LIVE_PROMPT_VERSION } from '../../src/core/config.ts';
import { cacheResource } from '../../src/core/resource.ts';
import { TranslationEngine, MemoryTranslationCache, translationCacheKey } from '../../src/translation/index.ts';

async function flush() { for (let n = 0; n < 60; n++) await Promise.resolve(); }
class Clock {
  time = 1000;
  sequence = 0;
  timers = new Map();
  now() { return this.time; }
  wallNow() { return 1800000000000 + this.time; }
  setTimeout(callback, delay) {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.time + Math.max(0, delay), callback }); return id;
  }
  clearTimeout(id) { this.timers.delete(id); }
  async advance(ms) {
    const target = this.time + ms; await flush();
    for (let count = 0; ; count++) {
      assert.ok(count < 10000, 'engine must not spin');
      const next = [...this.timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = Math.max(this.time, next[1].at); this.timers.delete(next[0]); next[1].callback(); await flush();
    }
    this.time = target; await flush();
  }
}
const settings = extra => ({ ...DEFAULT_SETTINGS, enabled: true, batchSize: 1, ...extra });
const wireData = init => {
  const content = JSON.parse(init.body).messages[1].content;
  if (content.startsWith('{')) return JSON.parse(content);
  return { compact: true, items: content.split('\n').map(line => { const [id, text] = JSON.parse(line); return { id, text }; }) };
};
const response = (rows, compact) => Response.json({ choices: [{ message: { role: 'assistant', content: compact
  ? rows.map(({ id, text }) => JSON.stringify([id, text])).join('\n') : JSON.stringify({ items: rows }) } }] });
function request(clock, text, extra = {}) {
  return { resourceId: 'sm9', apiKey: 'test-only-key', settings: settings(), mode: 'vod', priority: 'near',
    items: [{ id: text, text, deadlineAt: clock.now() + 2000 }], ...extra };
}
function liveRequest(clock, text, extra = {}) {
  return request(clock, text, { resourceId: cacheResource({ platform: 'youtube', scenario: 'live', resourceId: 'abc_DEF-123' }), mode: 'deadline', ...extra });
}
function harness(t, extra = {}) {
  const clock = new Clock(), calls = [];
  const fetch = (url, init) => new Promise((resolve, reject) => {
    const data = wireData(init);
    calls.push({ url, init, data, at: clock.now(), resolve,
      succeed: (rows = data.items.map(({ id, text }) => ({ id, text: `译:${text}` }))) => resolve(response(rows, data.compact)) });
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  const engine = new TranslationEngine({ fetch, clock, ...extra });
  t.after(() => engine.dispose());
  return { engine, clock, calls };
}

test('live deadlines outrank queued near VOD and order live requests by deadline without aborting active VOD', async t => {
  const { engine, clock, calls } = harness(t);
  const config = settings({ concurrency: 1 });
  const active = engine.translate(request(clock, 'active-vod', { settings: config })); await flush();
  const queued = engine.translate(request(clock, 'queued-near-vod', { settings: config }));
  const later = engine.translate(liveRequest(clock, 'live-later', { settings: config }));
  const sooner = engine.translate(liveRequest(clock, 'live-sooner', { settings: config,
    items: [{ id: 'soon', text: 'live-sooner', deadlineAt: clock.now() + 500 }] }));
  await flush(); assert.equal(calls.length, 1); assert.equal(calls[0].init.signal.aborted, false);
  calls[0].succeed(); await active; await flush();
  assert.equal(calls[1].data.items[0].text, 'live-sooner'); calls[1].succeed(); await sooner; await flush();
  assert.equal(calls[2].data.items[0].text, 'live-later'); calls[2].succeed(); await later; await flush();
  assert.equal(calls[3].data.items[0].text, 'queued-near-vod'); calls[3].succeed();
  assert.equal((await queued).items[0].status, 'translated');
});

test('concurrency two reserves one slot during active live presence and lets live fill it', async t => {
  const { engine, clock, calls } = harness(t);
  engine.setLiveSession('tab-live', true);
  const vod = ['vod-a', 'vod-b', 'vod-c'].map(text => engine.translate(request(clock, text)));
  await flush(); assert.equal(calls.length, 1); assert.equal(engine.stats().activeRequests, 1);
  const live = engine.translate(liveRequest(clock, 'live-a')); await flush();
  assert.equal(calls.length, 2); assert.equal(calls[1].data.items[0].text, 'live-a');
  calls[0].succeed(); await flush();
  assert.equal(calls.length, 3); assert.equal(calls[2].data.items[0].text, 'vod-b');
  assert.equal(engine.stats().activeRequests, 2);
  calls[1].succeed(); await live; await flush();
  assert.equal(calls.length, 3, 'reserved slot remains idle between live arrivals');
  calls[2].succeed(); await flush(); calls[3].succeed();
  assert.ok((await Promise.all(vod)).every(result => result.items[0].status === 'translated'));
});

test('concurrency one pauses new VOD while an already running VOD finishes naturally', async t => {
  const { engine, clock, calls } = harness(t);
  const config = settings({ concurrency: 1 });
  const first = engine.translate(request(clock, 'already-running', { settings: config })); await flush();
  engine.setLiveSession('tab-live', true);
  const next = engine.translate(request(clock, 'next-vod', { settings: config })); await flush();
  assert.equal(calls.length, 1); assert.equal(calls[0].init.signal.aborted, false);
  calls[0].succeed(); assert.equal((await first).items[0].status, 'translated'); await flush();
  assert.equal(calls.length, 1);
  const live = engine.translate(liveRequest(clock, 'live', { settings: config })); await flush();
  assert.equal(calls[1].data.items[0].text, 'live'); calls[1].succeed(); await live; await flush();
  assert.equal(calls.length, 2);
  engine.setLiveSession('tab-live', false); await flush();
  assert.equal(calls[2].data.items[0].text, 'next-vod'); calls[2].succeed(); await next;
});

test('unrefreshed presence expires after six seconds and automatically resumes queued VOD', async t => {
  const { engine, clock, calls } = harness(t);
  engine.setLiveSession('sleeping-tab', true);
  const pending = engine.translate(request(clock, 'vod', { settings: settings({ concurrency: 1 }) }));
  await clock.advance(5999); assert.equal(calls.length, 0);
  await clock.advance(1); assert.equal(calls.length, 1); assert.equal(calls[0].at, 7000);
  calls[0].succeed(); assert.equal((await pending).items[0].status, 'translated');
});

test('presence renewal extends its lease and closing one tab leaves another live reservation intact', async t => {
  const { engine, clock, calls } = harness(t);
  engine.setLiveSession('tab-a', true); engine.setLiveSession('tab-b', true);
  const pending = engine.translate(request(clock, 'vod', { settings: settings({ concurrency: 1 }) }));
  await clock.advance(5000); engine.setLiveSession('tab-b', true); engine.setLiveSession('tab-a', false);
  await clock.advance(1000); assert.equal(calls.length, 0);
  await clock.advance(4999); assert.equal(calls.length, 0);
  await clock.advance(1); assert.equal(calls[0].at, 12000);
  calls[0].succeed(); await pending;
});

test('live HTTP 429 returns original once and respects cooldown without retrying the same event', async t => {
  const { engine, clock, calls } = harness(t);
  const pending = engine.translate(liveRequest(clock, 'live-rate-limited')); await flush();
  calls[0].resolve(new Response('{}', { status: 429, headers: { 'retry-after': '1' } }));
  const result = await pending;
  assert.deepEqual(result.items, [{ id: 'live-rate-limited', text: 'live-rate-limited', status: 'original', reason: 'http-429' }]);
  await clock.advance(2500);
  assert.equal(calls.length, 1); assert.equal(engine.stats().retries, 0);
  const fresh = engine.translate(liveRequest(clock, 'fresh-live')); await flush();
  assert.equal(calls.length, 2); calls[1].succeed(); assert.equal((await fresh).items[0].status, 'translated');
});

test('missing live result IDs preserve successful peers and never retry missing entries', async t => {
  const { engine, clock, calls } = harness(t);
  const pending = engine.translate(liveRequest(clock, '', { settings: settings({ batchSize: 10 }),
    items: [{ id: 'a', text: 'first', deadlineAt: clock.now() + 500 }, { id: 'b', text: 'second', deadlineAt: clock.now() + 500 }] }));
  await clock.advance(150); calls[0].succeed([{ id: calls[0].data.items[1].id, text: '第二条' }]);
  const result = await pending;
  assert.deepEqual(result.items, [{ id: 'a', text: 'first', status: 'original', reason: 'missing-id' }, { id: 'b', text: '第二条', status: 'translated' }]);
  await clock.advance(1000); assert.equal(calls.length, 1); assert.equal(engine.stats().retries, 0);
});

test('slow cache hits and misses that exhaust live budgets never return late translations or start fetch', async t => {
  for (const hit of [undefined, '过期缓存译文']) {
    let finishCache;
    const cache = { getMany: () => new Promise(resolve => { finishCache = resolve; }), set: async () => {}, clear: async () => {}, stats: async () => ({}) };
    const { engine, clock, calls } = harness(t, { cache });
    const req = liveRequest(clock, 'slow-cache', { items: [{ id: 'event', text: 'slow-cache', deadlineAt: clock.now() + 500 }] });
    const pending = engine.translate(req);
    clock.time += 500; // Main-thread delay: cache promise settles before overdue timer callbacks run.
    const key = translationCacheKey(req.resourceId, 'slow-cache', req.settings, LIVE_PROMPT_VERSION);
    finishCache(hit === undefined ? new Map() : new Map([[key, hit]]));
    assert.deepEqual((await pending).items, [{ id: 'event', text: 'slow-cache', status: 'expired', reason: 'deadline' }]);
    assert.equal(calls.length, 0);
  }
});

test('a 300ms cache lookup leaves only 200ms for the actual live provider request', async t => {
  let finishCache;
  const { engine, clock, calls } = harness(t, { cache: { getMany: () => new Promise(resolve => { finishCache = resolve; }) } });
  const pending = engine.translate(liveRequest(clock, 'short-budget', { items: [{ id: 'a', text: 'short-budget', deadlineAt: clock.now() + 500 }] }));
  await clock.advance(300); finishCache(new Map()); await flush();
  assert.equal(calls.length, 1); assert.equal(calls[0].at, 1300);
  await clock.advance(199); assert.equal(calls[0].init.signal.aborted, false);
  await clock.advance(1);
  assert.equal(calls[0].init.signal.aborted, true); assert.equal((await pending).items[0].status, 'expired');
  await clock.advance(1000); assert.equal(calls.length, 1);
});

test('identical live text coalesces provider work while preserving every event ID and deadline', async t => {
  const { engine, clock, calls } = harness(t);
  const first = engine.translate(liveRequest(clock, 'same', { items: [{ id: 'first-id', text: 'same', deadlineAt: clock.now() + 100 }] }));
  const second = engine.translate(liveRequest(clock, 'same', { items: [
    { id: 'second-id', text: 'same', deadlineAt: clock.now() + 500 }, { id: 'third-id', text: 'same', deadlineAt: clock.now() + 500 }] }));
  await flush(); assert.equal(calls.length, 1); assert.equal(calls[0].data.items.length, 1);
  await clock.advance(100); assert.equal((await first).items[0].status, 'expired');
  assert.equal(calls[0].init.signal.aborted, false);
  calls[0].succeed();
  assert.deepEqual((await second).items.map(item => [item.id, item.text, item.status]), [['second-id', '译:same', 'translated'], ['third-id', '译:same', 'translated']]);
});

test('pre-live sm cache remains readable through the engine while live cache uses a separate namespace', async t => {
  const cache = new MemoryTranslationCache({ now: () => 1800000001000 });
  const config = normalizeSettings({ ...DEFAULT_SETTINGS, schemaVersion: 2, enabled: true, model: 'existing-model', thinkingEffort:'default' });
  const text = '既存の文章';
  await cache.set(translationCacheKey('sm9', text, config), '历史译文', { resourceId: 'sm9' });
  const { engine, clock, calls } = harness(t, { cache });
  const old = await engine.translate(request(clock, text, { settings: config }));
  assert.equal(old.items[0].status, 'cached'); assert.equal(old.items[0].text, '历史译文'); assert.equal(calls.length, 0);
  const live = engine.translate(liveRequest(clock, text, { settings: config })); await clock.advance(150);
  assert.equal(calls.length, 1); calls[0].succeed(); assert.equal((await live).items[0].status, 'translated');
  const oldAgain = await engine.translate(request(clock, text, { settings: config }));
  assert.equal(oldAgain.items[0].text, '历史译文'); assert.equal(oldAgain.items[0].status, 'cached');
});
