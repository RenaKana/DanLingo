import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../../src/core/config.ts';
import { TranslationEngine } from '../../src/translation/engine.ts';
import { HYBRID_JSONL_PROMPT_VERSION, ProviderError } from '../../src/translation/provider.ts';
import { MemoryTranslationCache, translationCacheKey } from '../../src/translation/cache.ts';
import { onlineSettings } from '../fixtures/online-settings.mjs';

const flush = async () => { for (let n = 0; n < 100; n++) await Promise.resolve(); };
class Clock {
  time = 1000; sequence = 0; timers = new Map();
  now() { return this.time; }
  wallNow() { return 1800000000000 + this.time; }
  setTimeout(callback, delay) { const id = ++this.sequence; this.timers.set(id, { at: this.time + Math.max(0, delay), callback }); return id; }
  clearTimeout(id) { this.timers.delete(id); }
  async advance(ms) {
    const target = this.time + ms; await flush();
    for (let n = 0; ; n++) {
      assert.ok(n < 10000, 'scheduler timers must not spin');
      const next = [...this.timers].filter(([, row]) => row.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = Math.max(this.time, next[1].at); this.timers.delete(next[0]); next[1].callback(); await flush();
    }
    this.time = target; await flush();
  }
}

function harness(t, options = {}) {
  const clock = new Clock(), calls = [], traces = [], cache = new MemoryTranslationCache({ now: () => clock.wallNow() });
  const local = { ...DEFAULT_SETTINGS, enabled: true, backend: 'local', endpoint: '', model: 'hy-mt-fixture',
    localModelId: 'fixture-model', concurrency: 1, localCapacity: 1, batchSize: 1 };
  const online = onlineSettings({ enabled: true, concurrency: options.concurrency ?? 1, batchSize: options.batchSize ?? 4,
    translationStream: options.streaming === true });
  let sequence = 0;
  const state = { localReady: options.localReady ?? false, localDelay: 50, onlineDelay: count => 100 + 20 * count };
  const provider = { complete(request) {
    const backend = request.settings.backend, sentAt = clock.now();
    request.onDispatch?.(request.items, backend);
    const row = { backend, at: sentAt, request, finished: false }; calls.push(row);
    const streaming = request.responseProtocol === 'hybrid-jsonl-v1' && request.settings.translationStream;
    const observation = { dispatchedAt: sentAt, observedAt: sentAt, inputChars: request.items.reduce((n, item) => n + item.text.length, 0),
      items: request.items.length, streaming: !!streaming, contentChunks: 0, outputChars: 0, validItems: 0 };
    request.onObservation?.({ ...observation });
    return new Promise((resolve, reject) => {
      const delay = backend === 'local' ? state.localDelay : state.onlineDelay(request.items.length);
      const timer = clock.setTimeout(() => {
        row.finished = true;
        const outputs = request.items.map(item => [item.id, { text: `译文-${item.id}` }]);
        const chars = outputs.reduce((n, [, output], index) => n + JSON.stringify([index, output.text]).length + 1, 0);
        request.onObservation?.({ ...observation, observedAt: clock.now(), outputChars: chars, validItems: outputs.length, lastItemAt: clock.now() });
        if (streaming) for (const [id, output] of [...outputs].reverse()) request.onItem?.(id, output);
        resolve({ items: new Map(outputs), usage: { promptTokens: 100 + observation.inputChars, completionTokens: chars } });
      }, delay);
      request.signal.addEventListener('abort', () => { clock.clearTimeout(timer); reject(new ProviderError('cancelled')); }, { once: true });
    });
  } };
  const engine = new TranslationEngine({ clock, provider, cache, onTrace: row => traces.push(row) });
  t.after(() => engine.dispose());
  const send = (count = 1, budget = 2000, extra = {}) => {
    const items = Array.from({ length: count }, () => { const id = `row-${String(++sequence).padStart(5, '0')}`; return { id, text: `原文-${id}`, deadlineAt: clock.now() + budget }; });
    return engine.translate({ resourceId: 'bilibili:adaptive-fixture', settings: online, apiKey: 'fixture-key', items,
      hybrid: { local, online, localReady: state.localReady, onlineReady: true, maxItems: 1000, maxChars: 60000,
        p95Ms: 30, capacityKey: 'fixture-model', adaptive: options.adaptive !== false, onlineStreaming: options.streaming === true }, ...extra });
  };
  const warm = async (count = 4, step = 250) => {
    for (let n = 0; n < 8; n++) { const result = send(count); await clock.advance(step); assert.ok((await result).items.every(item => item.status === 'translated')); }
  };
  return { clock, engine, calls, traces, cache, local, online, state, send, warm };
}

test('planned hybrid streaming uses a separate cache identity and keeps deadline mode unchanged', async t => {
  const h = harness(t, { streaming: true, adaptive: false });
  const seen = [];
  const pending = h.send(2, 1000, { onResult: item => seen.push(item) }); await flush();
  assert.equal(h.calls[0].request.mode, undefined);
  assert.equal(h.calls[0].request.responseProtocol, 'hybrid-jsonl-v1');
  await h.clock.advance(200);
  assert.equal((await pending).items.filter(item => item.status === 'translated').length, 2);
  assert.equal(seen.length, 2);
  const item = h.calls[0].request.items[0];
  const resource = 'bilibili:adaptive-fixture';
  const policy = { ttlMs: 86400000, maxEntries: 5000 };
  assert.ok(await h.cache.get(translationCacheKey(resource, item.text, h.online, HYBRID_JSONL_PROMPT_VERSION), policy));
  assert.equal(await h.cache.get(translationCacheKey(resource, item.text, h.online), policy), undefined);
  assert.equal(h.engine.stats().hybrid.performance.online.lastBatchItems, 2);
  assert.equal(h.engine.stats().hybrid.performance.online.charsPerSecond, undefined);
});

test('adaptive switch does not split translation cache and flags cannot alter live or VOD requests', async t => {
  const h = harness(t);
  const text = '已有的混合缓存', resourceId = 'bilibili:adaptive-fixture';
  await h.cache.set(translationCacheKey(resourceId, text, h.online), '已有译文', { resourceId });
  const cached = await h.send(1, 1000, { items: [{ id: 'cached', text, deadlineAt: h.clock.now() + 1000 }] });
  assert.equal(cached.items[0].status, 'cached'); assert.equal(h.calls.length, 0);
  for (const mode of ['deadline', 'vod']) {
    const done = h.send(1, 1000, { mode, hybrid: { local: h.local, online: { ...h.online, translationStream: true },
      localReady: false, onlineReady: true, maxItems: 1, maxChars: 100, capacityKey: 'fixture-model', adaptive: true, onlineStreaming: true } });
    await h.clock.advance(400); await done;
    assert.equal(h.calls.at(-1).request.responseProtocol, undefined);
    assert.equal(h.calls.at(-1).request.onObservation, undefined);
  }
});

test('paired replay: bounded aggregation saves one request with equal timely results and lower mock prompt usage', async t => {
  const replay = async adaptive => {
    const h = harness(t, { adaptive }); await h.warm();
    const before = h.calls.length, usageBefore = h.engine.stats().usage.promptTokens;
    const a = h.send(); await h.clock.advance(20); const b = h.send();
    await h.clock.advance(500); const rows = [...(await a).items, ...(await b).items];
    return { requests: h.calls.length - before, timely: rows.filter(row => row.status === 'translated').length,
      prompt: h.engine.stats().usage.promptTokens - usageBefore, sizes: h.calls.slice(before).map(row => row.request.items.length) };
  };
  const baseline = await replay(false), adaptive = await replay(true);
  assert.equal(baseline.timely, 2); assert.equal(adaptive.timely, baseline.timely);
  assert.equal(baseline.requests, 2); assert.equal(adaptive.requests, 1);
  assert.ok(adaptive.prompt < baseline.prompt); assert.deepEqual(adaptive.sizes, [2]);
  t.diagnostic(JSON.stringify({ scenario: 'stable-aggregation', baseline, adaptive, evidence: 'mock-service-usage' }));
});

test('paired short-deadline replay does not wait for aggregation or expire a still-viable attempt', async t => {
  const comparison = [];
  for (const adaptive of [false, true]) {
    const h = harness(t, { adaptive }); await h.warm();
    const requestsBefore = h.calls.length, usageBefore = { ...h.engine.stats().usage };
    const started = h.clock.now(), pending = h.send(1, 130); await flush();
    assert.equal(h.calls.at(-1).at, started);
    await h.clock.advance(150);
    assert.equal((await pending).items[0].status, 'translated');
    comparison.push({ adaptive, timely: 1, requests: h.calls.length - requestsBefore,
      prompt: h.engine.stats().usage.promptTokens - usageBefore.promptTokens,
      completion: h.engine.stats().usage.completionTokens - usageBefore.completionTokens });
  }
  t.diagnostic(JSON.stringify({ scenario: 'short-deadline', comparison, evidence: 'mock-service-usage' }));
});

test('paired high fixed latency replay keeps coverage and reduces repeated prompt overhead', async t => {
  const replay = async adaptive => {
    const h = harness(t, { adaptive }); h.state.onlineDelay = count => 1200 + 20 * count;
    await h.warm(4, 1500);
    const before = h.calls.length, usageBefore = { ...h.engine.stats().usage };
    const a = h.send(1, 3000); await h.clock.advance(20); const b = h.send(1, 3000);
    await h.clock.advance(3000);
    return { timely: [...(await a).items, ...(await b).items].filter(row => row.status === 'translated').length,
      requests: h.calls.length - before,
      prompt: h.engine.stats().usage.promptTokens - usageBefore.promptTokens,
      completion: h.engine.stats().usage.completionTokens - usageBefore.completionTokens };
  };
  const baseline = await replay(false), adaptive = await replay(true);
  assert.equal(baseline.timely, 2); assert.equal(adaptive.timely, 2);
  assert.equal(baseline.requests, 2); assert.equal(adaptive.requests, 1);
  assert.ok(adaptive.prompt < baseline.prompt);
  t.diagnostic(JSON.stringify({ scenario: 'high-fixed-latency', baseline, adaptive, evidence: 'mock-service-usage' }));
});

test('paired variable service replay tightens on slowdown and resumes after complete timely requests', async t => {
  const replay = async adaptive => {
    const h = harness(t, { adaptive }); await h.warm();
    const phases = [
      { name: 'steady', fixed: 100, perItem: 20, budget: 1400 },
      { name: 'slower-1', fixed: 150, perItem: 60, budget: 1400 },
      { name: 'slower-2', fixed: 250, perItem: 90, budget: 1400 },
      { name: 'stall', fixed: 1200, perItem: 100, budget: 900 },
      ...Array.from({ length: 5 }, (_, i) => ({ name: `recover-${i + 1}`, fixed: 100, perItem: 20, budget: 1400 })),
    ];
    const rows = [];
    for (const phase of phases) {
      h.state.onlineDelay = count => phase.fixed + phase.perItem * count;
      const before = h.calls.length, beforeStats = h.engine.stats();
      const pending = h.send(4, phase.budget);
      await h.clock.advance(2000);
      const result = await pending, stats = h.engine.stats();
      rows.push({ phase: phase.name, timely: result.items.filter(item => item.status === 'translated').length,
        requests: h.calls.length - before, sizes: h.calls.slice(before).map(row => row.request.items.length),
        prompt: stats.usage.promptTokens - beforeStats.usage.promptTokens,
        completion: stats.usage.completionTokens - beforeStats.usage.completionTokens,
        unknownUsageRequests: stats.usageUnavailableCalls - beforeStats.usageUnavailableCalls,
        status: stats.hybrid.performance?.online?.status });
    }
    return rows;
  };
  const baseline = await replay(false), adaptive = await replay(true);
  assert.equal(adaptive[0].timely, baseline[0].timely);
  assert.equal(adaptive[1].status, 'slowing');
  assert.equal(adaptive[3].status, 'slowing');
  assert.ok(adaptive[3].unknownUsageRequests > 0, 'aborted requests must not masquerade as zero billable usage');
  assert.ok(adaptive.slice(2).some(row => row.sizes.some(size => size < 4)), 'slowdown tightens allowed batches');
  assert.equal(adaptive.at(-1).status, 'stable');
  assert.ok(adaptive.every(row => row.sizes.every(size => size <= 4)), 'manual batch ceiling is retained');
  t.diagnostic(JSON.stringify({ scenario: 'variable-service', baseline, adaptive, evidence: 'mock-service-usage' }));
});

test('an in-flight local slowdown diverts only new work without changing limits, queue ownership or concurrency', async t => {
  const h = harness(t, { localReady: true }); await h.warm(1);
  assert.equal(h.engine.stats().hybrid.performance.local.status, 'stable');
  h.state.localDelay = 800;
  const running = h.send(1, 2000); await h.clock.advance(600);
  const next = h.send(1, 500); await flush();
  assert.equal(h.calls.at(-2).backend, 'local'); assert.equal(h.calls.at(-1).backend, 'online');
  assert.equal(h.calls.at(-2).request.signal.aborted, false);
  assert.equal(h.calls.at(-1).request.settings.concurrency, 1);
  await h.clock.advance(500);
  assert.equal((await next).items[0].backend, 'online');
  assert.equal((await running).items[0].backend, 'local');
  assert.equal(h.calls.filter(row => row.backend === 'online').length, 1);
});

test('cold start is immediate and cancellation is not reported as a provider slowdown', async t => {
  const h = harness(t), controller = new AbortController();
  const pending = h.send(1, 2000, { signal: controller.signal }); await flush();
  assert.equal(h.calls.length, 1);
  controller.abort(); await flush();
  assert.equal((await pending).items[0].reason, 'cancelled');
  assert.equal(h.engine.stats().hybrid.performance.online.samples, 0);
  assert.equal(h.engine.stats().hybrid.performance.online.status, 'learning');
  assert.equal(h.calls.length, 1);
});

test('one expired subscriber prevents a shared successful request from counting toward healthy recovery', async t => {
  const h = harness(t); await h.warm();
  const text = '同一条任务共享订阅';
  const early = h.send(1, 80, { items: [{ id: 'early', text, deadlineAt: h.clock.now() + 80 }] });
  const later = h.send(1, 1000, { items: [{ id: 'later', text, deadlineAt: h.clock.now() + 1000 }] });
  await h.clock.advance(250);
  assert.equal((await early).items[0].status, 'expired');
  assert.equal((await later).items[0].status, 'translated');
  assert.equal(h.engine.stats().hybrid.performance.online.status, 'slowing');
});

test('expansion preserves a viable later subscriber even when an earlier subscriber is already predicted late', async t => {
  const h = harness(t);
  // Control prediction independently from transport to exercise the shared-deadline decision.
  h.engine.hybridPerformance.estimate = (_key, shape) => ({ ready: true, samples: 8, status: 'stable',
    expectedMs: shape.items === 1 ? 200 : 600, outputChars: shape.items * 20, outputCeiling: 10000 });
  const text = '共享同一句弹幕';
  const early = h.send(1, 150, { items: [{ id: 'early', text, deadlineAt: h.clock.now() + 150 }] });
  const later = h.send(1, 500, { items: [{ id: 'later', text, deadlineAt: h.clock.now() + 500 }] });
  const extra = h.send(1, 1000);
  await flush();
  assert.equal(h.calls[0].request.items.length, 1, 'the added item must not turn the viable 500ms subscriber into a late result');
  await h.clock.advance(500);
  assert.equal((await later).items[0].status, 'translated');
  await early; await extra;
});

test('explicit unsupported streaming stops queued attempts without format fallback or repeated probes', async t => {
  const h = harness(t, { streaming: true, batchSize: 1 });
  let attempts = 0;
  h.engine.provider = { async complete(request) {
    attempts++; request.onDispatch(request.items, 'online');
    throw new ProviderError('hybrid-stream-unsupported', false, 400);
  } };
  const pending = h.send(3);
  await flush(); await pending;
  assert.equal(attempts, 1);
  await h.send();
  assert.equal(attempts, 1);
  assert.equal(h.engine.stats().lastError.reason, 'hybrid-stream-unsupported');
});
