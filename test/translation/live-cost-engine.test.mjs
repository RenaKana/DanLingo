import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, normalizeSettings } from '../../src/core/config.ts';
import { cacheResource } from '../../src/core/resource.ts';
import { TranslationEngine } from '../../src/translation/index.ts';

async function flush() { for (let turn = 0; turn < 100; turn++) await Promise.resolve(); }
class Clock {
  time = 1000;
  sequence = 0;
  timers = new Map();
  now() { return this.time; }
  wallNow() { return 1800000000000 + this.time; }
  setTimeout(callback, delay) { const id = ++this.sequence; this.timers.set(id, { at: this.time + Math.max(0, delay), callback }); return id; }
  clearTimeout(id) { this.timers.delete(id); }
  async advance(ms) {
    const target = this.time + ms; await flush();
    for (let iterations = 0; ; iterations++) {
      assert.ok(iterations < 10000, 'deadline and capacity timers must not spin');
      const next = [...this.timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = Math.max(this.time, next[1].at); this.timers.delete(next[0]); next[1].callback(); await flush();
    }
    this.time = target; await flush();
  }
}
const settings = overrides => ({ ...DEFAULT_SETTINGS, enabled: true, batchSize: 2, concurrency: 8,
  liveAdaptiveConcurrency: false, ...overrides });
const room = id => cacheResource({ platform: 'youtube', scenario: 'live', resourceId: id });
function request(clock, count = 2, overrides = {}) {
  return { resourceId: room('room-one'), settings: settings(), apiKey: 'test-only-key', mode: 'deadline',
    items: Array.from({ length: count }, (_, i) => ({ id: `event-${i}`, text: `独立したコメント ${i}`, deadlineAt: clock.now() + 3000 })), ...overrides };
}
function harness(t) {
  const clock = new Clock(), calls = [], traces = [];
  const fetch = (_url, init) => new Promise((resolve, reject) => {
    const body = JSON.parse(init.body), raw = body.messages[1].content;
    const compact = !raw.startsWith('{');
    const rows = compact ? raw.split('\n').map(line => { const [id, text] = JSON.parse(line); return { id, text }; }) : JSON.parse(raw).items;
    const call = { init, body, rows, compact, at: clock.now(), resolved: false };
    call.respond = response => { assert.equal(call.resolved, false, 'each wire attempt settles once'); call.resolved = true; resolve(response); };
    call.succeed = (text = row => `译文:${row.text}`) => call.respond(Response.json({ choices: [{ message: { content: compact
      ? rows.map(row => JSON.stringify([row.id, text(row)])).join('\n')
      : JSON.stringify({ items: rows.map(row => ({ id: row.id, text: text(row) })) }) } }] }));
    call.fail = () => { call.resolved = true; reject(new TypeError('synthetic network failure')); };
    call.stream = () => {
      let controller, cancelled = 0;
      const encoder = new TextEncoder();
      call.respond(new Response(new ReadableStream({ start(value) { controller = value; }, cancel() { cancelled++; } }),
        { headers: { 'content-type': 'text/event-stream' } }));
      const frame = value => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      return { text: content => frame({ choices: [{ index: 0, delta: { content } }] }),
        usage: usage => frame({ choices: [], usage }), close: () => { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); },
        error: () => controller.error(new TypeError('synthetic stream disconnect')), cancelled: () => cancelled };
    };
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    calls.push(call);
  });
  const engine = new TranslationEngine({ fetch, clock, onTrace: event => traces.push(event) });
  t.after(() => engine.dispose());
  return { engine, clock, calls, traces,
    async drain() {
      for (let round = 0; round < 100; round++) {
        await flush();
        const unfinished = calls.filter(call => !call.resolved);
        if (!unfinished.length) { assert.equal(engine.stats().activeRequests, 0); return; }
        unfinished.forEach(call => call.succeed());
      }
      assert.fail('bounded batches must finish');
    } };
}

test('saved 250ms aggregation migrates to 150ms and an incomplete batch is dispatched by that boundary', async t => {
  const h = harness(t), previous = settings({ batchSize: 10, concurrency: 64, liveMaxBatchWaitMs: 250 });
  const migrated = normalizeSettings(previous);
  assert.equal(migrated.liveMaxBatchWaitMs, 150);
  for (const key of Object.keys(previous)) if (key !== 'liveMaxBatchWaitMs') assert.deepEqual(migrated[key], previous[key], key);
  const pending = h.engine.translate(request(h.clock, 1, { settings: migrated }));
  await h.clock.advance(149); assert.equal(h.calls.length, 0);
  await h.clock.advance(1); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].at, 1150); h.calls[0].succeed();
  assert.equal((await pending).items[0].status, 'translated');
});

test('direct engine requests cannot bypass the 150ms aggregation limit', async t => {
  const h = harness(t);
  for (const wait of [151, 250]) {
    const input = request(h.clock, 1, { settings: settings({ liveMaxBatchWaitMs: wait }) });
    const result = await h.engine.translate(input);
    assert.deepEqual(result.items, [{ id: input.items[0].id, text: input.items[0].text, status: 'failed', reason: 'invalid-settings' }]);
  }
  assert.equal(h.calls.length, 0);
});

test('64 API slots admit 128 unique items as full two-item batches and never a 65th active request', async t => {
  const h = harness(t);
  const pending = h.engine.translate(request(h.clock, 132, { settings: settings({ concurrency: 64 }) }));
  await flush();
  assert.equal(h.calls.length, 64); assert.equal(h.engine.stats().activeRequests, 64);
  assert.equal(h.engine.stats().queuedItems, 4); assert.ok(h.calls.every(call => call.rows.length === 2));
  await h.clock.advance(150); assert.equal(h.calls.length, 64, 'a batching timer cannot exceed the occupied API pool');
  h.calls[0].succeed(); await flush();
  assert.equal(h.calls.length, 65); assert.equal(h.engine.stats().activeRequests, 64);
  assert.equal(h.calls[64].rows.length, 2);
  await h.drain();
  assert.equal((await pending).items.filter(item => item.status === 'translated').length, 132);
  assert.equal(h.calls.length, 66);
  assert.ok(h.traces.filter(event => event.type === 'attempt').every(event => event.activeRequests <= 64));
});

test('raising configured concurrency fills more whole batches without fragmenting the same unique workload', async t => {
  for (const concurrency of [1, 8, 64]) {
    const h = harness(t), pending = h.engine.translate(request(h.clock, 32, { settings: settings({ concurrency, batchSize: 4 }) }));
    await flush(); assert.equal(h.calls.length, Math.min(concurrency, 8));
    assert.ok(h.calls.every(call => call.rows.length === 4));
    await h.drain(); await pending;
    assert.equal(h.calls.length, 8); assert.ok(h.calls.every(call => call.rows.length === 4));
  }
});

test('duplicates join one task during the batching wait, preserve occurrence IDs, then reuse completed cache', async t => {
  const h = harness(t), config = settings({ batchSize: 8 });
  const events = ['first', 'second', 'third'].map(id => ({ id, text: '本当に危なかった！', deadlineAt: h.clock.now() + 2500 }));
  const first = h.engine.translate(request(h.clock, 0, { settings: config, items: [events[0]] }));
  await flush();
  const peers = h.engine.translate(request(h.clock, 0, { settings: config, items: events.slice(1) }));
  await flush(); assert.equal(h.engine.stats().uniqueTasks, 1); assert.equal(h.engine.stats().mergedInputs, 2); assert.equal(h.calls.length, 0);
  await h.clock.advance(149); assert.equal(h.calls.length, 0);
  await h.clock.advance(1); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].rows.length, 1);
  h.calls[0].succeed(() => '真是好险！');
  assert.deepEqual([...(await first).items, ...(await peers).items].map(item => [item.id, item.text]),
    [['first', '真是好险！'], ['second', '真是好险！'], ['third', '真是好险！']]);
  await flush();
  const cached = await h.engine.translate(request(h.clock, 0, { settings: config, items: [{ ...events[0], id: 'fourth' }] }));
  assert.deepEqual(cached.items.map(item => [item.id, item.status, item.text]), [['fourth', 'cached', '真是好险！']]);
  assert.equal(h.calls.length, 1);
  const arrivals = h.traces.filter(event => event.type === 'arrival');
  assert.equal(arrivals.length, 4); assert.equal(new Set(arrivals.map(event => event.occurrenceId)).size, 4);
});

test('room, target language, explicit source language and live prompt mode remain isolated in tasks and cache', async t => {
  const h = harness(t), common = { settings: settings({ batchSize: 1 }), items: [{ id: 'same-event', text: '同じ短い言葉', deadlineAt: h.clock.now() + 2500 }] };
  const scopes = [request(h.clock, 0, common), request(h.clock, 0, { ...common, resourceId: room('room-two') }),
    request(h.clock, 0, { ...common, settings: { ...common.settings, targetLanguage: 'en' } }),
    request(h.clock, 0, { ...common, settings: { ...common.settings, sourceLanguage: 'ja' } }),
    request(h.clock, 0, { ...common, mode: 'vod', priority: 'near' })];
  const pending = scopes.map(scope => h.engine.translate(scope)); await flush();
  assert.equal(h.calls.length, 5); assert.equal(h.calls.filter(call => call.compact).length, 4);
  h.calls.forEach((call, i) => call.succeed(() => `作用域译文 ${i}`));
  const initial = await Promise.all(pending); await flush();
  assert.equal(new Set(initial.map(result => result.items[0].text)).size, 5);
  const cached = await Promise.all(scopes.map(scope => h.engine.translate(scope)));
  assert.equal(h.calls.length, 5); assert.ok(cached.every(result => result.items[0].status === 'cached'));
  assert.deepEqual(cached.map(result => result.items[0].text), initial.map(result => result.items[0].text));
});

test('onResult delivers a completed batch while another batch in the same envelope remains unresolved', async t => {
  const h = harness(t), ready = []; let resolved = false;
  const pending = h.engine.translate(request(h.clock, 4, { onResult: item => ready.push(item) })).then(result => { resolved = true; return result; });
  await flush(); assert.equal(h.calls.length, 2);
  h.calls[1].succeed(); await flush();
  assert.deepEqual(ready.map(item => item.id), ['event-2', 'event-3']); assert.equal(resolved, false);
  assert.equal(h.engine.stats().activeRequests, 1); assert.equal(h.calls[0].init.signal.aborted, false);
  h.calls[0].succeed(); const result = await pending;
  assert.deepEqual(result.items.map(item => item.id), ['event-0', 'event-1', 'event-2', 'event-3']);
  assert.equal(ready.length, 4); assert.ok(result.items.every(item => item.status === 'translated'));
});

test('streamed success completes all waiters without cancelling final usage collection', async t => {
  const h = harness(t), ready = [], controller = new AbortController();
  const pending = h.engine.translate(request(h.clock, 2, { settings: settings({ translationStream: true }), signal: controller.signal,
    onResult: item => ready.push(item) }));
  await flush(); assert.equal(h.calls[0].body.stream, true);
  const stream = h.calls[0].stream(); await flush();
  stream.text('[0,"先に完成"]\n[1,"二番目も完成"]\n'); await flush();
  assert.equal(ready.length, 2); assert.ok((await pending).items.every(item => item.status === 'translated'));
  assert.equal(h.engine.stats().subscribers, 0); assert.equal(h.engine.stats().activeRequests, 1);
  controller.abort(); await h.clock.advance(20);
  assert.equal(h.calls[0].init.signal.aborted, false); assert.equal(stream.cancelled(), 0);
  assert.equal(h.engine.stats().usageReports, 0, 'usage is pending rather than fabricated when only content has arrived');
  stream.usage({ prompt_tokens: 71, completion_tokens: 19, total_tokens: 90, prompt_tokens_details: { cached_tokens: 23 } });
  stream.close(); await flush();
  assert.deepEqual(h.engine.stats().usage, { promptTokens: 71, completionTokens: 19, totalTokens: 90, cachedInputTokens: 23 });
  assert.equal(h.engine.stats().usageReports, 1); assert.equal(h.engine.stats().usageUnavailableCalls, 0);
  assert.equal(h.engine.stats().activeRequests, 0); assert.equal(h.calls.length, 1); assert.equal(ready.length, 2);
});

test('a network failure after one parsed stream result preserves success and never re-translates that item', async t => {
  const h = harness(t), ready = [];
  const pending = h.engine.translate(request(h.clock, 2, { settings: settings({ translationStream: true }), onResult: item => ready.push(item) }));
  await flush(); const stream = h.calls[0].stream(); await flush();
  stream.text('[0,"保留这条有效译文"]\n'); await flush(); assert.equal(ready[0].status, 'translated');
  stream.error(); const result = await pending; await flush();
  assert.equal(result.items[0].text, '保留这条有效译文'); assert.equal(result.items[0].status, 'translated');
  assert.equal(result.items[1].status, 'original'); assert.equal(result.items[1].reason, 'network-error');
  await h.clock.advance(500); assert.equal(h.calls.length, 1); assert.equal(h.engine.stats().retries, 0);
  assert.equal(h.engine.stats().usageUnavailableCalls, 1);
  assert.equal(h.traces.filter(event => event.type === 'settled')[0].usageKnown, false);
});

test('long-text token budgets split batches while sending every complete source unchanged', async t => {
  const h = harness(t), texts = ['甲', '乙', '丙'].map(character => `${character}の長い発言。`.repeat(50));
  const pending = h.engine.translate(request(h.clock, 0, { settings: settings({ batchSize: 100, maxBatchChars: 12000,
    liveMaxInputTokens: 4096, liveMaxOutputTokens: 4096 }),
    items: texts.map((text, i) => ({ id: `long-${i}`, text, deadlineAt: h.clock.now() + 2500 })) }));
  await h.clock.advance(150); assert.equal(h.calls.length, 3); assert.ok(h.calls.every(call => call.rows.length === 1));
  assert.deepEqual(h.calls.flatMap(call => call.rows.map(row => row.text)), texts);
  await h.drain(); assert.ok((await pending).items.every(item => item.status === 'translated'));
});

test('429 cooldown is shared across live groups and queued batches resume within the same API cap', async t => {
  const h = harness(t), config = settings({ concurrency: 2 }), pending = h.engine.translate(request(h.clock, 6, { settings: config }));
  await flush(); assert.equal(h.calls.length, 2);
  h.calls[0].respond(new Response('{}', { status: 429, headers: { 'retry-after': '1' } })); await flush();
  assert.equal(h.engine.stats().rateLimitedUntil, h.clock.now() + 1000);
  const peer = h.engine.translate(request(h.clock, 2, { settings: config, resourceId: room('second-room') }));
  h.calls[1].succeed(); await flush(); assert.equal(h.calls.length, 2, 'a freed slot and different room both obey provider cooldown');
  await h.clock.advance(999); assert.equal(h.calls.length, 2);
  await h.clock.advance(1); assert.equal(h.calls.length, 4); assert.equal(h.engine.stats().activeRequests, 2);
  await h.drain(); const results = await Promise.all([pending, peer]);
  assert.equal(results[0].items.filter(item => item.status === 'original' && item.reason === 'http-429').length, 2);
  assert.ok(results[1].items.every(item => item.status === 'translated')); assert.equal(h.engine.stats().retries, 0);
  assert.ok(h.traces.filter(event => event.type === 'attempt').every(event => event.activeRequests <= 2));
});

test('adaptive cold start uses configured capacity and isolated network failure cannot collapse it to one', async t => {
  const h = harness(t), pending = h.engine.translate(request(h.clock, 32, { settings: settings({ concurrency: 8, liveAdaptiveConcurrency: true }) }));
  await flush(); assert.equal(h.calls.length, 8); assert.equal(h.engine.stats().activeRequests, 8);
  h.calls[0].fail(); await flush();
  assert.equal(h.calls.length, 9, 'network loss frees one slot for a whole queued batch without lowering user capacity');
  assert.equal(h.engine.stats().activeRequests, 8); assert.equal(h.calls[8].rows.length, 2);
  await h.drain(); const result = await pending;
  assert.equal(result.items.filter(item => item.status === 'translated').length, 30);
  assert.equal(result.items.filter(item => item.reason === 'network-error').length, 2);
  assert.equal(h.engine.stats().retries, 0);
});
