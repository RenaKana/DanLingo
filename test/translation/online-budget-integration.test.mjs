import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, normalizeSettings } from '../../src/core/config.ts';
import { ChatCompletionsProvider, ProviderError, discoverModels } from '../../src/translation/provider.ts';
import { TranslationEngine } from '../../src/translation/engine.ts';
import { testModel } from '../../src/translation/model-test.ts';
import { PerformanceTest } from '../../src/translation/performance-test.ts';

const settings = { ...DEFAULT_SETTINGS, enabled: true, endpoint: 'https://fixture.invalid/v1/chat/completions',
  model: 'deepseek-v4-pro', profile: 'deepseek', thinkingEffort: 'off', liveSourceLanguage: 'ja', liveMaxBatchWaitMs: 0 };
const request = extra => ({ settings, apiKey: 'fixture-only', items: [{ id: 'a', text: 'A small synthetic sentence.' }], budgetMs: 2000, mode: 'vod', ...extra });
function reply(init) {
  const body = JSON.parse(init.body), text = body.messages[1]?.content;
  let parsed;
  try { parsed = JSON.parse(text); } catch {}
  const content = parsed?.items
    ? JSON.stringify({ items: parsed.items.map(item => ({ id: item.id, text: '这是合成样本的译文。' })) })
    : text.split('\n').map(line => JSON.stringify([JSON.parse(line)[0], '这是合成样本的译文。'])).join('\n');
  return Response.json({ choices: [{ message: { content } }] });
}
// This gate tests propagation at generation call sites; real IndexedDB atomicity is tested separately.
function boundary(limit, transport = reply) {
  let used = 0, sends = 0;
  const options = {
    beforeOnlineRequest: async signal => {
      if (signal.aborted) throw new ProviderError('cancelled');
      if (used >= limit) throw new ProviderError('online-daily-limit-reached');
      used++;
    },
    fetch: async (_url, init) => { sends++; return transport(init); },
  };
  return { options, get used() { return used; }, get sends() { return sends; } };
}

test('daily cap defaults to 3000 and accepts positive safe integers only', () => {
  assert.equal(normalizeSettings({}).onlineRequestLimitPerDay, 3000);
  assert.equal(normalizeSettings({ onlineRequestLimitPerDay: 1 }).onlineRequestLimitPerDay, 1);
  for (const value of [0, -1, 1.5, NaN, Infinity, '3000', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizeSettings({ onlineRequestLimitPerDay: value }), /invalid-online-request-limit/);
  }
});

test('concurrent generation calls share the host gate and fail without retry permission', async () => {
  const gate = boundary(3), provider = new ChatCompletionsProvider(gate.options);
  const outcomes = await Promise.allSettled(Array.from({ length: 20 }, () => provider.complete(request())));
  assert.equal(gate.used, 3); assert.equal(gate.sends, 3);
  assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 3);
  for (const row of outcomes.filter(row => row.status === 'rejected')) {
    assert.equal(row.reason.code, 'online-daily-limit-reached'); assert.equal(row.reason.retryable, false);
    assert.equal(row.reason.category, 'budget');
  }
});

test('local inference and model discovery do not reserve online generation quota', async () => {
  const gate = boundary(0), provider = new ChatCompletionsProvider(gate.options);
  await provider.complete(request({ settings: { ...settings, backend: 'local' } }));
  assert.equal(gate.used, 0); assert.equal(gate.sends, 1);
  const models = await discoverModels({ endpoint: settings.endpoint, allowLocalHttp: false, apiKey: 'fixture-only', timeoutMs: 2000 }, async () => Response.json({ data: [{ id: 'synthetic-model' }] }));
  assert.deepEqual(models, ['synthetic-model']); assert.equal(gate.used, 0);
});

test('invalid and pre-cancelled requests never enter the quota gate', async () => {
  const gate = boundary(3), provider = new ChatCompletionsProvider(gate.options);
  await assert.rejects(provider.complete(request({ signal: AbortSignal.abort() })), /cancelled/);
  await assert.rejects(provider.complete(request({ apiKey: '' })), /api-key-missing/);
  assert.equal(gate.used, 0); assert.equal(gate.sends, 0);
});

test('cancellation while quota reservation is pending never starts transport later', async () => {
  let release, sends = 0;
  const provider = new ChatCompletionsProvider({
    beforeOnlineRequest: () => new Promise(resolve => { release = resolve; }),
    fetch: async (_url, init) => { sends++; return reply(init); },
  });
  const controller = new AbortController(), pending = provider.complete(request({ signal: controller.signal }));
  controller.abort(); await assert.rejects(pending, /cancelled/);
  release(); await new Promise(setImmediate); assert.equal(sends, 0);
});

test('storage rejection fails closed and attempted transport failures keep their charge', async () => {
  let sends = 0;
  const blocked = new ChatCompletionsProvider({ beforeOnlineRequest: async () => { throw new ProviderError('online-budget-storage-unavailable'); }, fetch: async () => { sends++; } });
  await assert.rejects(blocked.complete(request()), error => error.code === 'online-budget-storage-unavailable' && !error.retryable);
  assert.equal(sends, 0);
  const gate = boundary(1, () => { throw new Error('synthetic failure'); });
  await assert.rejects(new ChatCompletionsProvider(gate.options).complete(request()), /network-error/);
  assert.equal(gate.used, 1); assert.equal(gate.sends, 1);
});

test('cache hits and merged work are free; manual bypass reserves another attempt', async () => {
  const gate = boundary(2), engine = new TranslationEngine({ provider: new ChatCompletionsProvider(gate.options) });
  const input = { resourceId: 'synthetic-resource', settings, apiKey: 'fixture-only', items: [{ id: 'a', text: 'Synthetic sentence for the cache.', deadlineAt: performance.now() + 2000 }], mode: 'vod' };
  try {
    const rows = await Promise.all([engine.translate(input), engine.translate(input)]);
    assert.ok(rows.every(row => row.items[0].status === 'translated')); assert.equal(gate.used, 1);
    assert.equal((await engine.translate(input)).items[0].status, 'cached'); assert.equal(gate.used, 1);
    assert.equal((await engine.translate({ ...input, bypassCache: true, namespace: 'manual', forceTranslate: true, items: input.items.map(item => ({ ...item, strategy: 'manual' })) })).items[0].status, 'translated');
    assert.equal(gate.used, 2); assert.equal(gate.sends, 2);
  } finally { engine.dispose(); }
});

test('automatic retry reaches the shared cap and then keeps the original without looping', async () => {
  const gate = boundary(1, () => new Response('', { status: 503 }));
  const engine = new TranslationEngine({ provider: new ChatCompletionsProvider(gate.options) });
  try {
    const result = await engine.translate({ resourceId: 'synthetic-retry', settings, apiKey: 'fixture-only', items: [{ id: 'a', text: 'Synthetic retry input.', deadlineAt: performance.now() + 2500 }], mode: 'vod' });
    assert.equal(result.items[0].reason, 'online-daily-limit-reached'); assert.equal(result.items[0].text, 'Synthetic retry input.');
    assert.equal(gate.used, 1); assert.equal(gate.sends, 1);
  } finally { engine.dispose(); }
});

test('model tests and both performance modes consume the same cap and stop on exhaustion', async () => {
  for (const mode of ['latency', 'load']) {
    const gate = boundary(3);
    await testModel({ settings, apiKey: 'fixture-only', text: 'This is a synthetic model test.' }, gate.options);
    assert.equal(gate.used, 1);
    const run = new PerformanceTest({ count: 10, mode, concurrency: 2, batchSize: 1, arrivalIntervalMs: 0, strategy: 'normal' }, settings, 'fixture-only', gate.options);
    const report = await run.run();
    assert.equal(gate.used, 3); assert.equal(gate.sends, 3);
    assert.equal(report.state, 'stopped'); assert.match(report.stopReason, /每日|今日/);
    assert.equal(report.actualRequests, 2);
  }
});
