import test from 'node:test';
import assert from 'node:assert/strict';
import { TranslationEngine } from '../../src/translation/engine.ts';
import { onlineSettings } from '../fixtures/online-settings.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let n = 0; n < 100; n++) { if (predicate()) return; await flush(); }
  assert.fail('provider was not reached');
}
const settings = onlineSettings({ enabled: true, batchSize: 10, concurrency: 1 });
const request = (signal, items) => ({ resourceId: 'sm9', settings, apiKey: 'fixture-only',
  mode: 'vod', priority: 'near', signal, items: items.map(([id, text]) => ({ id, text, deadlineAt: performance.now() + 5000 })) });

test('same signal and item ID select only one subscription, preserving an identical text peer', async t => {
  const calls = [];
  const engine = new TranslationEngine({ provider: { complete: data => new Promise(resolve => calls.push({ data, resolve })) } });
  t.after(() => engine.dispose());
  const controller = new AbortController(), other = new AbortController();
  const a = engine.translate(request(controller.signal, [['a', '同じ文章です'], ['b', '同じ文章です']]));
  const peer = engine.translate(request(other.signal, [['a', '同じ文章です']]));
  await until(() => calls.length === 1);
  assert.equal(calls[0].data.items.length, 1);
  engine.cancelItems(controller.signal, ['a']);
  assert.equal(calls[0].data.signal.aborted, false);
  assert.equal(engine.stats().subscribers, 2);
  calls[0].resolve({ items: new Map([[calls[0].data.items[0].id, { text: '共有の翻訳です' }]]) });
  const [first, second] = await Promise.all([a, peer]);
  assert.deepEqual(first.items.map(item => item.status), ['original', 'translated']);
  assert.equal(first.items[0].reason, 'cancelled');
  assert.equal(second.items[0].status, 'translated');
  assert.equal(engine.stats().providerCalls, 1);
});

test('queued item cancellation prunes the provider envelope; cancelling all sends nothing', async t => {
  const calls = [];
  const engine = new TranslationEngine({ provider: { complete: async data => {
    calls.push(data);
    return { items: new Map(data.items.map(item => [item.id, { text: '翻訳です' }])) };
  } } });
  t.after(() => engine.dispose());
  const controller = new AbortController();
  const pending = engine.translate(request(controller.signal, [['a', '最初の文章です'], ['b', '次の文章です']]));
  engine.cancelItems(controller.signal, ['a']);
  const result = await pending;
  assert.deepEqual(result.items.map(item => item.status), ['original', 'translated']);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].items.map(item => item.text), ['次の文章です']);

  const empty = new AbortController();
  const cancelled = engine.translate(request(empty.signal, [['c', '最後の文章です']]));
  engine.cancelItems(empty.signal, ['c']);
  assert.equal((await cancelled).items[0].reason, 'cancelled');
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(engine.stats().providerCalls, 1);
});

test('last pre-send check handles cancellation during dispatch trace', async t => {
  const calls = [];
  const controller = new AbortController();
  let engine;
  engine = new TranslationEngine({
    provider: { complete: async data => {
      calls.push(data);
      return { items: new Map(data.items.map(item => [item.id, { text: '翻訳です' }])) };
    } },
    onTrace: event => { if (event.type === 'attempt') engine.cancelItems(controller.signal, ['a']); },
  });
  t.after(() => engine.dispose());
  const result = await engine.translate(request(controller.signal, [['a', '最初の文章です'], ['b', '次の文章です']]));
  assert.deepEqual(result.items.map(item => item.status), ['original', 'translated']);
  assert.deepEqual(calls[0].items.map(item => item.text), ['次の文章です']);
  assert.equal(engine.stats().providerCalls, 1);

  const only = new AbortController();
  const zeroCalls = [];
  let zeroEngine;
  zeroEngine = new TranslationEngine({ provider: { complete: async data => { zeroCalls.push(data); return { items: new Map() }; } },
    onTrace: event => { if (event.type === 'attempt') zeroEngine.cancelItems(only.signal, ['only']); } });
  t.after(() => zeroEngine.dispose());
  const none = await zeroEngine.translate(request(only.signal, [['only', '最後の文章です']]));
  assert.equal(none.items[0].reason, 'cancelled');
  assert.equal(zeroCalls.length, 0);
  assert.equal(zeroEngine.stats().providerCalls, 0);
});

test('an entire signal aborted during dispatch settles without provider admission', async t => {
  const controller = new AbortController();
  let engine, calls = 0;
  engine = new TranslationEngine({ provider: { complete: async () => { calls++; return { items: new Map() }; } },
    onTrace: event => { if (event.type === 'attempt') controller.abort(); } });
  t.after(() => engine.dispose());
  const result = await engine.translate(request(controller.signal, [['a', '最初の文章です']]));
  assert.equal(result.items[0].reason, 'cancelled');
  assert.equal(calls, 0);
  assert.equal(engine.stats().providerCalls, 0);
  assert.equal(engine.stats().subscribers, 0);
});

test('late orphan result cannot complete a new subscription with the same ID', async t => {
  const calls = [];
  const engine = new TranslationEngine({ provider: { complete: data => new Promise(resolve => calls.push({ data, resolve })) } });
  t.after(() => engine.dispose());
  const old = new AbortController(), fresh = new AbortController();
  const stale = engine.translate(request(old.signal, [['same', '古い文章です']]));
  await until(() => calls.length === 1);
  engine.cancelItems(old.signal, ['same']);
  const current = engine.translate(request(fresh.signal, [['same', '新しい文章です']]));
  calls[0].resolve({ items: new Map([[calls[0].data.items[0].id, { text: '古い訳文です' }]]) });
  assert.equal((await stale).items[0].reason, 'cancelled');
  await until(() => calls.length === 2);
  assert.equal(engine.stats().subscribers, 1);
  calls[1].resolve({ items: new Map([[calls[1].data.items[0].id, { text: '新しい訳文です' }]]) });
  assert.equal((await current).items[0].text, '新しい訳文です');
});
