import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../../src/core/config.ts';
import { cacheResource } from '../../src/core/resource.ts';
import { TranslationEngine } from '../../src/translation/index.ts';

async function flush() { for (let turn = 0; turn < 100; turn++) await Promise.resolve(); }

class Clock {
  time = 1000;
  sequence = 0;
  timers = new Map();
  now() { return this.time; }
  wallNow() { return 1800000000000 + this.time; }
  setTimeout(callback, delay) {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.time + Math.max(0, delay), callback });
    return id;
  }
  clearTimeout(id) { this.timers.delete(id); }
  async advance(ms) {
    const target = this.time + ms;
    await flush();
    for (let iterations = 0; ; iterations++) {
      assert.ok(iterations < 10000, 'deadline and batching timers must not spin');
      const next = [...this.timers].filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = Math.max(this.time, next[1].at);
      this.timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    this.time = target;
    await flush();
  }
}

function harness(t, overrides = {}) {
  const clock = new Clock(), calls = [], traces = [];
  const config = { ...DEFAULT_SETTINGS, enabled: true, batchSize: 2, concurrency: 1,
    liveAdaptiveConcurrency: false, translationStream: false,
    endpoint: 'https://feasibility-provider.invalid/v1/chat/completions', ...overrides };
  const resourceId = cacheResource({ platform: 'youtube', scenario: 'live', resourceId: 'feasibility-room' });
  const privateValues = new Set(['synthetic-never-sent', config.endpoint, new URL(config.endpoint).origin,
    new URL(config.endpoint).hostname, resourceId]);
  let sequence = 0;
  const engine = new TranslationEngine({ clock, onTrace: event => traces.push(event), fetch: (_url, init) => new Promise((resolve, reject) => {
    const body = JSON.parse(init.body), content = body.messages[1].content;
    const compact = !content.startsWith('{');
    const rows = compact ? content.split('\n').map(line => {
      const [id, text] = JSON.parse(line); return { id, text };
    }) : JSON.parse(content).items;
    const call = { at: clock.now(), init, rows, compact };
    call.succeed = () => resolve(Response.json({ choices: [{ message: { content: compact
      ? rows.map(row => JSON.stringify([row.id, `译文:${row.text}`])).join('\n')
      : JSON.stringify({ items: rows.map(row => ({ id: row.id, text: `译文:${row.text}` })) }) } }] }));
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    calls.push(call);
  }) });
  t.after(async () => {
    engine.dispose();
    await flush();
    const serialized = JSON.stringify({ observed: traces, retained: engine.stats().recentTrace });
    for (const value of privateValues) assert.equal(serialized.includes(value), false, 'trace must omit source text, credentials and endpoint');
  });
  const request = (texts, budgetMs, extra = {}) => {
    const items = extra.items ?? texts.map(text => ({ id: `event-${++sequence}`, text, deadlineAt: clock.now() + budgetMs }));
    for (const item of items) privateValues.add(item.text);
    return engine.translate({ resourceId, settings: config, apiKey: 'synthetic-never-sent', mode: 'deadline', ...extra, items });
  };
  return { clock, calls, traces, engine, request, config,
    async learn(texts = ['暖機の一番目', '暖機の二番目'], elapsed = 800) {
      const before = calls.length, pending = request(texts, 3000);
      await flush();
      assert.equal(calls.length, before + 1);
      assert.deepEqual(calls[before].rows.map(row => row.text), texts);
      await clock.advance(elapsed);
      calls[before].succeed();
      assert.ok((await pending).items.every(item => item.status === 'translated'));
      await flush();
      assert.equal(engine.stats().activeRequests, 0);
    },
  };
}

test('one slow learned response does not fragment a new short-budget batch in the same character bucket', async t => {
  const h = harness(t);
  await h.learn();
  const texts = ['短い予算の一番目', '短い予算の二番目'];
  const pending = h.request(texts, 300);
  await flush();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1].rows.map(row => row.text), texts);
  const attempt = h.traces.filter(event => event.type === 'attempt').at(-1);
  assert.equal(attempt.liveDispatch.trigger, 'batch-limit');
  assert.equal(attempt.liveDispatch.declined.deadlineRegression, 0);
  assert.equal(attempt.liveDispatch.timingDecline, undefined);
  assert.deepEqual(attempt.liveDispatch.estimate, { expectedMs: 800, samples: 1, charsBucket: 0, loadBucket: 0 });
  assert.deepEqual(attempt.liveDispatch.budgets, attempt.taskIds.map(taskId => ({ taskId, earliestMs: 300, latestMs: 300, subscribers: 1 })));
  await h.clock.advance(300);
  assert.ok((await pending).items.every(item => item.status === 'expired'));
  assert.equal(h.calls[1].init.signal.aborted, true);
  await h.clock.advance(1000);
  assert.equal(h.calls.length, 2);
  assert.equal(h.engine.stats().retries, 0);
});

test('cold-start requests below the scheduling seed can still complete within their own deadlines', async t => {
  const h = harness(t), pending = h.request(['冷たい一番目', '冷たい二番目'], 100);
  await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].rows.length, 2);
  await h.clock.advance(50);
  h.calls[0].succeed();
  assert.ok((await pending).items.every(item => item.status === 'translated'));
  assert.equal(h.engine.stats().retries, 0);
});

test('a provider speeding up after slow learning returns both short-budget occurrences in one request', async t => {
  const h = harness(t), ready = [];
  await h.learn();
  const pending = h.request(['速くなった一番目', '速くなった二番目'], 300, { onResult: item => ready.push(item) });
  await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].rows.length, 2);
  await h.clock.advance(100);
  h.calls[1].succeed();
  const result = await pending;
  assert.ok(result.items.every(item => item.status === 'translated'));
  assert.deepEqual(ready.map(item => item.id), result.items.map(item => item.id));
  await h.clock.advance(300);
  assert.equal(ready.length, 2);
  assert.equal(h.calls.length, 2);
});

test('a learned slow larger batch alone does not justify splitting an unmeasured smaller batch', async t => {
  const h = harness(t);
  await h.learn(['甲'.repeat(160), '乙'.repeat(160)]);
  const texts = ['丙'.repeat(160), '丁'.repeat(160)], pending = h.request(texts, 300);
  await flush();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1].rows.map(row => row.text), texts);
  await h.clock.advance(100);
  h.calls[1].succeed();
  assert.ok((await pending).items.every(item => item.status === 'translated'));
});

test('measured fast small batches remain split when measured larger batches would exceed the budget', async t => {
  const h = harness(t);
  await h.learn(['小'.repeat(60), '短'.repeat(60)], 100);
  await h.learn(['大'.repeat(160), '長'.repeat(160)], 800);
  const texts = ['先'.repeat(160), '後'.repeat(160)], pending = h.request(texts, 300);
  await flush();
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.calls[2].rows.map(row => row.text), [texts[0]]);
  const decision = h.traces.filter(event => event.type === 'attempt').at(-1).liveDispatch;
  assert.equal(decision.trigger, 'candidate-limit');
  assert.deepEqual(decision.declined, { characters: 0, inputTokens: 0, outputTokens: 0, deadlineRegression: 1, quota: 0 });
  assert.deepEqual(decision.timingDecline, {
    current: { expectedMs: 100, samples: 1, charsBucket: 0, loadBucket: 0 },
    expanded: { expectedMs: 800, samples: 1, charsBucket: 1, loadBucket: 0 },
    budgetMs: 300,
  });
  await h.clock.advance(100);
  h.calls[2].succeed();
  await h.clock.advance(50);
  assert.equal(h.calls.length, 4);
  assert.deepEqual(h.calls[3].rows.map(row => row.text), [texts[1]]);
  await h.clock.advance(100);
  h.calls[3].succeed();
  assert.ok((await pending).items.every(item => item.status === 'translated'));
  assert.equal(h.engine.stats().retries, 0);
});

test('slow learning preserves separate deadlines for short and long subscribers sharing a batched task', async t => {
  const h = harness(t);
  await h.learn();
  const short = h.request([], 0, { items: [{ id: 'short', text: '同じ発言', deadlineAt: h.clock.now() + 100 }] });
  const long = h.request([], 0, { items: [
    { id: 'long', text: '同じ発言', deadlineAt: h.clock.now() + 500 },
    { id: 'peer', text: '一緒に送る発言', deadlineAt: h.clock.now() + 500 },
  ] });
  await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].rows.length, 2);
  const sharedBudget = h.traces.filter(event => event.type === 'attempt').at(-1).liveDispatch.budgets
    .find(budget => budget.subscribers === 2);
  assert.equal(sharedBudget.earliestMs, 100);
  assert.equal(sharedBudget.latestMs, 500);
  await h.clock.advance(100);
  assert.deepEqual((await short).items, [{ id: 'short', text: '同じ発言', status: 'expired', reason: 'deadline' }]);
  assert.equal(h.calls[1].init.signal.aborted, false);
  await h.clock.advance(100);
  h.calls[1].succeed();
  assert.deepEqual((await long).items.map(item => [item.id, item.status]), [['long', 'translated'], ['peer', 'translated']]);
  assert.equal(h.calls.length, 2);
});

test('live latency learning does not impose playback deadlines or batch fragmentation on VOD', async t => {
  const h = harness(t);
  await h.learn();
  const texts = ['録画の一番目', '録画の二番目'];
  const pending = h.request(texts, 100, { resourceId: 'sm9', mode: 'vod', priority: 'near' });
  await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].compact, false);
  assert.deepEqual(h.calls[1].rows.map(row => row.text), texts);
  assert.equal(h.traces.filter(event => event.type === 'attempt').at(-1).liveDispatch, undefined);
  await h.clock.advance(800);
  assert.equal(h.calls[1].init.signal.aborted, false);
  h.calls[1].succeed();
  assert.ok((await pending).items.every(item => item.status === 'translated'));
});

test('zero-beneficiary backfill keeps the EDF anchor, expires skipped work once and charges only dispatched quota', async t => {
  const h = harness(t), outputs = [];
  await h.learn();
  const blocker = h.request(['占用甲', '占用乙'], 3000);
  await flush();
  const at = h.clock.now();
  const pending = h.request([], 0, { quotaScope: 'backfill-quota', onResult: row => outputs.push(row), items: [
    { id: 'anchor', text: '最早甲', deadlineAt: at + 900 },
    { id: 'skipped', text: '跳過乙', deadlineAt: at + 920 },
    { id: 'later', text: '後来丙', deadlineAt: at + 2000 },
  ] });
  await h.clock.advance(400);
  h.calls[1].succeed(); await blocker; await flush();
  assert.deepEqual(h.calls[2].rows.map(row => row.text), ['最早甲', '後来丙']);
  const decision = h.traces.filter(row => row.type === 'attempt').at(-1).liveDispatch;
  assert.equal(decision.backfill.items, 2);
  assert.equal(decision.backfill.replacements.length, 1);
  await h.clock.advance(600);
  h.calls[2].succeed();
  assert.deepEqual((await pending).items.map(row => [row.id, row.status]),
    [['anchor', 'expired'], ['skipped', 'expired'], ['later', 'translated']]);
  assert.equal(new Set(outputs.map(row => row.id)).size, 3);
  assert.equal(outputs.length, 3);
  assert.equal(h.calls.length, 3, 'bypassed task expires without a new request');
  // Two dispatched three-character sources used 6 characters. The bypassed source
  // must not consume the remaining quota, even though it was in the initial EDF batch.
  for (const character of ['あ', 'い', 'う']) {
    const seeded = h.request([character.repeat(19998)], 3000, { mode: 'vod', quotaScope: 'backfill-quota',
      settings: { ...h.config, maxBatchChars: 24000 } });
    await flush(); h.calls.at(-1).succeed();
    assert.equal((await seeded).items[0].status, 'translated');
  }
  const exceeded = h.request(['追加'], 3000, { mode: 'vod', quotaScope: 'backfill-quota' });
  assert.equal((await exceeded).items[0].reason, 'quota-exceeded');
});

test('a singleton duration does not authorize backfill of an unmeasured two-item batch', async t => {
  const h = harness(t);
  const warm = h.request(['暖機甲'], 3000);
  await h.clock.advance(950); h.calls[0].succeed(); await warm;
  const at = h.clock.now();
  const pending = h.request([], 0, { items: [
    { id: 'first', text: '先行甲', deadlineAt: at + 300 },
    { id: 'second', text: '先行乙', deadlineAt: at + 320 },
    { id: 'later', text: '後続丙', deadlineAt: at + 2000 },
  ] });
  await flush();
  assert.deepEqual(h.calls[1].rows.map(row => row.text), ['先行甲', '先行乙']);
  assert.equal(h.traces.filter(row => row.type === 'attempt').at(-1).liveDispatch.backfill, undefined);
  await h.clock.advance(2200); await pending;
});

test('a later subscriber on the EDF anchor preserves a batch with a forecast beneficiary', async t => {
  const h = harness(t);
  await h.learn();
  const at = h.clock.now();
  const pending = h.request([], 0, { items: [
    { id: 'short', text: '共通甲', deadlineAt: at + 300 },
    { id: 'long', text: '共通甲', deadlineAt: at + 2000 },
    { id: 'peer', text: '先行乙', deadlineAt: at + 320 },
    { id: 'later', text: '後続丙', deadlineAt: at + 2200 },
  ] });
  await flush();
  assert.deepEqual(h.calls[1].rows.map(row => row.text), ['共通甲', '先行乙']);
  assert.equal(h.traces.filter(row => row.type === 'attempt').at(-1).liveDispatch.backfill, undefined);
  await h.clock.advance(400); h.calls[1].succeed(); await flush();
  await h.clock.advance(2300); await pending;
});

test('backfill never increases payload size to accommodate a later deadline', async t => {
  const h = harness(t);
  await h.learn();
  const at = h.clock.now();
  const pending = h.request([], 0, { items: [
    { id: 'first', text: '先行甲', deadlineAt: at + 300 },
    { id: 'second', text: '先行乙', deadlineAt: at + 320 },
    { id: 'long', text: '長'.repeat(160), deadlineAt: at + 2000 },
    { id: 'later', text: '後続丙', deadlineAt: at + 2200 },
  ] });
  await flush();
  assert.deepEqual(h.calls[1].rows.map(row => row.text), ['先行甲', '後続丙']);
  await h.clock.advance(400); h.calls[1].succeed(); await flush();
  await h.clock.advance(2300); await pending;
});

test('a quota-rejected VOD peer does not waste a batch slot or delay another eligible scope', async t => {
  const h = harness(t, { batchSize: 3, maxBatchChars: 10 });
  for (const character of ['あ', 'い', 'う']) {
    const seed = h.request([character.repeat(20000)], 3000, { mode: 'vod', quotaScope: 'exhausted',
      settings: { ...h.config, maxBatchChars: 24000 } });
    await flush(); h.calls.at(-1).succeed(); await seed;
  }
  const first = h.request(['先頭甲'], 3000, { mode: 'vod', quotaScope: 'first' });
  const denied = h.request(['拒'.repeat(7)], 3000, { mode: 'vod', quotaScope: 'exhausted' });
  const later = h.request(['後続丙'], 3000, { mode: 'vod', quotaScope: 'later' });
  const last = h.request(['後続丁'], 3000, { mode: 'vod', quotaScope: 'last' });
  await flush();
  assert.equal((await denied).items[0].reason, 'quota-exceeded');
  assert.deepEqual(h.calls[3].rows.map(row => row.text), ['先頭甲', '後続丙', '後続丁']);
  h.calls[3].succeed();
  assert.equal((await first).items[0].status, 'translated');
  assert.equal((await later).items[0].status, 'translated');
  assert.equal((await last).items[0].status, 'translated');
  assert.equal(h.calls.length, 4);
});

test('crossing to a faster measured bucket cannot reinsert a task reported as skipped', async t => {
  const h = harness(t, { batchSize: 3 });
  await h.learn(['小'.repeat(50), '短'.repeat(50), '少'.repeat(50)], 400);
  await h.learn(['大'.repeat(100), '長'.repeat(100), '多'.repeat(100)], 800);
  const at = h.clock.now(), texts = ['甲'.repeat(100), '乙'.repeat(100), '丙'.repeat(100), '丁'.repeat(3)];
  const pending = h.request([], 0, { items: texts.map((text, index) => ({
    id: `bucket-${index}`, text, deadlineAt: at + [100, 600, 620, 2000][index],
  })) });
  await flush();
  assert.deepEqual(h.calls[2].rows.map(row => row.text), [texts[0], texts[3], texts[2]]);
  const trace = h.traces.filter(row => row.type === 'attempt').at(-1);
  assert.equal(trace.liveDispatch.backfill.replacements.length, 1);
  assert.ok(trace.liveDispatch.backfill.replacements.every(row => !trace.taskIds.includes(row.skippedTaskId)));
  await h.clock.advance(500); h.calls[2].succeed(); await flush();
  await h.clock.advance(2000); await pending;
});

test('quota rejection does not refill a backfill with a deadline-late peer', async t => {
  const h = harness(t, { batchSize: 3 }), outputs = [];
  await h.learn(['小'.repeat(50), '短'.repeat(50), '少'.repeat(50)], 400);
  await h.learn(['大'.repeat(100), '長'.repeat(100), '多'.repeat(100)], 800);

  for (const character of ['あ', 'い', 'う']) {
    const seed = h.request([character.repeat(20000)], 3000, { mode: 'vod', quotaScope: 'scopeD',
      settings: { ...h.config, maxBatchChars: 24000 } });
    await flush();
    h.calls.at(-1).succeed();
    await seed;
    await flush();
  }

  const at = h.clock.now();
  const submit = (id, text, deadlineAt, quotaScope) => h.request([], 0, { quotaScope,
    onResult: output => outputs.push(output), items: [{ id, text, deadlineAt }] });
  const aText = 'A'.repeat(150), bText = 'B'.repeat(150), cText = 'C'.repeat(150);
  const dText = 'D'.repeat(10), eText = 'E'.repeat(10);
  const pending = [
    submit('A', aText, at + 100, 'scopeA'),
    submit('B', bText, at + 200, 'scopeB'),
    submit('C', cText, at + 300, 'scopeC'),
    submit('D', dText, at + 1000, 'scopeD'),
    submit('E', eText, at + 600, 'scopeE'),
  ];
  await flush();

  const liveCalls = () => h.calls.filter(call => call.compact);
  assert.equal(liveCalls().length, 3);
  const actualLive = liveCalls().at(-1);
  assert.deepEqual(actualLive.rows.map(row => row.text), [aText, eText]);
  const finalAttempt = h.traces.filter(event => event.type === 'attempt').at(-1);
  const liveBindings = h.traces.filter(event => event.type === 'bind').slice(-5).map(event => event.taskId);
  const [aTask, bTask, cTask, dTask, eTask] = liveBindings;
  assert.deepEqual(finalAttempt.taskIds, [aTask, eTask]);
  assert.deepEqual(finalAttempt.liveDispatch.backfill.forecast, { expectedMs: 800, samples: 1, charsBucket: 1, loadBucket: 0 });
  assert.equal(finalAttempt.liveDispatch.declined.quota, 1);
  assert.deepEqual(finalAttempt.liveDispatch.backfill.replacements, [{ skippedTaskId: cTask, selectedTaskId: eTask }]);
  assert.ok(finalAttempt.liveDispatch.backfill.replacements.every(row => row.selectedTaskId !== dTask));

  await h.clock.advance(400);
  actualLive.succeed();
  const results = await Promise.all(pending);
  assert.deepEqual(results.map(result => result.items[0].status), ['expired', 'expired', 'expired', 'deferred', 'translated']);
  assert.equal(results[3].items[0].reason, 'quota-exceeded');
  assert.equal(results[4].items[0].status, 'translated');
  assert.deepEqual(outputs.map(output => output.id).sort(), ['A', 'B', 'C', 'D', 'E']);
  assert.equal(outputs.length, 5);
  assert.equal(liveCalls().some(call => call.rows.some(row => row.text === bText)), false);
  assert.equal(h.engine.stats().activeRequests, 0);
});
