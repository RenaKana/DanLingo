import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, localGenerationProfile, normalizeSettings, providerTimeoutMs, strategySettings } from '../../src/core/config.ts';
import { TranslationEngine } from '../../src/translation/engine.ts';
import { translationCacheKey } from '../../src/translation/cache.ts';
import { liveTokenEstimate } from '../../src/translation/telemetry.ts';

const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const settings = { ...DEFAULT_SETTINGS, enabled: true, backend: 'local', localModelId: 'fixture-model',
  concurrency: 32, localCapacity: 4, localContextTokens: 4096, batchSize: 1, liveMaxBatchWaitMs: 0 };

for (const profile of ['chat-completions', 'deepseek', 'minimax', 'gemini']) {
  test(`local ${profile} dispatch ignores retained online thinking preferences`, async t => {
    const calls = [];
    const engine = new TranslationEngine({ provider: { complete: async request => {
      calls.push(request);
      return { items: new Map(request.items.map(item => [item.id, { text: '译文' }])) };
    } } });
    t.after(() => engine.dispose());
    // Deliberately include an online effort unsupported by some profiles. Local
    // timeout and generation must not try to validate the online dialect.
    const base = { ...settings, profile, thinkingEffort: 'max', superChatThinkingEffort: 'high', requestTimeoutMs: 12345, thinkingRequestTimeoutMs: 90000, superChatTimeoutMs: 23456 };
    for (const strategy of ['normal', 'superchat', 'manual']) {
      const effective = strategySettings(base, strategy);
      assert.equal(providerTimeoutMs(effective), strategy === 'superchat' ? 23456 : 12345);
      assert.equal(providerTimeoutMs(base, strategy), strategy === 'superchat' ? 23456 : 12345);
      assert.equal(localGenerationProfile(effective).maxTokens, strategy === 'superchat' ? 256 : strategy === 'manual' ? 512 : 128);
      const result = await engine.translate({ settings: effective, resourceId: 'room', apiKey: '', mode: 'vod',
        items: [{ id: strategy, text: `hello ${strategy}`, strategy, deadlineAt: performance.now() + 3000 }] });
      assert.equal(result.items[0].status, 'translated');
    }
    assert.equal(calls.length, 3);
  });
}

test('persisted settings validate local performance but cannot spoof observed capacity or strategy', () => {
  const normalized = normalizeSettings({ ...settings, localPerformance: { mode: 'custom', parallel: 8, temperature: 0.2 }, localGenerationStrategy: 'manual' });
  assert.equal(normalized.localPerformance.parallel, 8);
  assert.equal(normalized.localPerformance.temperature, 0.2);
  assert.equal(normalized.localCapacity, undefined);
  assert.equal(normalized.localContextTokens, undefined);
  assert.equal(normalized.localGenerationStrategy, undefined);
  assert.equal(normalizeSettings({ ...settings, localPerformance: { parallel: 33 } }).localPerformance.parallel, 33);
  assert.throws(() => normalizeSettings({ ...settings, localPerformance: { parallel: -1 } }), /LOCAL_CONFIG_INVALID/);
});

test('local cache keys follow generation behavior and ignore parallel capacity and unrelated SC changes', () => {
  const key = (value, strategy = 'normal') => translationCacheKey('room', 'hello', strategySettings({ ...settings, ...value }, strategy));
  assert.equal(key({}), key({ localCapacity: 8, localPerformance: { parallel: 8, superChatReasoning: 'on' }, superChatThinkingEffort: 'high' }));
  assert.notEqual(key({}), key({ localPerformance: { temperature: 0.2 } }));
  assert.notEqual(key({}), key({ localPerformance: { normalMaxTokens: 256 } }));
  assert.notEqual(key({}, 'superchat'), key({ localPerformance: { superChatReasoning: 'off' } }, 'superchat'));
  assert.notEqual(key({}), key({}, 'manual'));
});

for (const [application, capacity, expected] of [[32, 4, 4], [2, 8, 2], [32, undefined, 1]]) {
  test(`local admission application=${application} native=${capacity} peaks at ${expected}`, async t => {
    const calls = []; let active = 0, peak = 0;
    const engine = new TranslationEngine({ provider: { complete: request => new Promise(resolve => {
      active++; peak = Math.max(peak, active);
      calls.push(() => { active--; resolve({ items: new Map(request.items.map(item => [item.id, { text: '译文' }])) }); });
    }) } });
    t.after(() => engine.dispose());
    const result = engine.translate({ settings: { ...settings, concurrency: application, localCapacity: capacity }, resourceId: 'room', apiKey: '', mode: 'vod',
      items: Array.from({ length: 12 }, (_, index) => ({ id: String(index), text: `message ${index}`, deadlineAt: performance.now() + 3000 })) });
    await flush();
    assert.equal(calls.length, expected);
    for (let settled = 0; settled < 12;) {
      const ready = calls.splice(0);
      for (const resolve of ready) { resolve(); settled++; }
      await flush();
    }
    assert.equal(peak, expected);
    assert.equal((await result).items.filter(item => item.status === 'translated').length, 12);
  });
}

for (const mode of ['vod', 'deadline']) {
  test(`local ${mode} batch respects whole-request output budget`, async t => {
    const batches = [];
    const engine = new TranslationEngine({ provider: { complete: async request => {
      batches.push(request.items);
      return { items: new Map(request.items.map(item => [item.id, { text: '译文' }])) };
    } } });
    t.after(() => engine.dispose());
    const response = await engine.translate({ settings: { ...settings, batchSize: 100 }, resourceId: 'room', apiKey: '', mode,
      items: Array.from({ length: 10 }, (_, index) => ({ id: String(index), text: `Hi ${index}`, deadlineAt: performance.now() + 3000 })) });
    assert.equal(response.items.filter(item => item.status === 'translated').length, 10);
    assert.ok(batches.length >= 3);
    assert.ok(batches.every(batch => batch.reduce((sum, item) => sum + liveTokenEstimate(item.text).output, 0) <= 128));
  });
}

test('local Super Chat leaves one of four observed slots available to normal chat', async t => {
  const calls = [];
  const engine = new TranslationEngine({ provider: { complete: request => new Promise(resolve => {
    calls.push({ strategy: request.strategy, reply: () => resolve({ items: new Map(request.items.map(item => [item.id, { text: '译文' }])) }) });
  }) } });
  t.after(() => engine.dispose());
  const sc = engine.translate({ settings: strategySettings(settings, 'superchat'), resourceId: 'room', apiKey: '', mode: 'deadline',
    items: Array.from({ length: 4 }, (_, index) => ({ id: `sc${index}`, text: `support ${index}`, strategy: 'superchat', deadlineAt: performance.now() + 5000 })) });
  await flush();
  assert.equal(calls.length, 3);
  const normal = engine.translate({ settings: strategySettings(settings, 'normal'), resourceId: 'room', apiKey: '', mode: 'deadline',
    items: [{ id: 'normal', text: 'hello everyone', deadlineAt: performance.now() + 3000 }] });
  await flush();
  assert.equal(calls.length, 4);
  assert.equal(calls[3].strategy, 'normal');
  calls.splice(0).forEach(call => call.reply());
  await flush();
  calls.splice(0).forEach(call => call.reply());
  assert.equal((await normal).items[0].status, 'translated');
  assert.equal((await sc).items.filter(item => item.status === 'translated').length, 4);
});
