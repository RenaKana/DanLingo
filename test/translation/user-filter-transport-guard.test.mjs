import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatCompletionsProvider, ProviderError, setProviderTransportGuard } from '../../src/translation/provider.ts';
import { onlineSettings } from '../fixtures/online-settings.mjs';
import { TranslationEngine } from '../../src/translation/engine.ts';

for (const backend of ['online', 'local']) test(`${backend}: task zero budget stops actual transport, including an already-created provider`, async t => {
  let calls = 0, checks = 0;
  const provider = new ChatCompletionsProvider({ fetch: async () => { calls++; throw Error('transport reached'); } });
  t.after(() => setProviderTransportGuard());
  setProviderTransportGuard(async () => { checks++; throw new ProviderError('user-filters-zero-model-budget'); });
  const settings = onlineSettings({ backend, endpoint: backend === 'local' ? 'http://127.0.0.1:2333/v1/chat/completions' : undefined,
    ...(backend === 'online' ? { endpoint: 'https://api.minimax.cn/v1/chat/completions' } : { allowLocalHttp: true }) });
  await assert.rejects(provider.complete({ settings, apiKey: 'fixture', items: [{ id: 'one', text: 'hello world' }],
    mode: 'vod', budgetMs: 2000 }), /user-filters-zero-model-budget/);
  assert.equal(checks, 1); assert.equal(calls, 0);
  setProviderTransportGuard();
  await assert.rejects(provider.complete({ settings, apiKey: 'fixture', items: [{ id: 'one', text: 'hello world' }],
    mode: 'vod', budgetMs: 2000 }));
  assert.equal(calls, 1, 'cleanup restores transport to the injected in-memory spy only');
});

for (const backend of ['online', 'local']) test(`${backend}: a partial cancellation during the final async gate removes only that provider input`, async t => {
  let unblock, entered;
  const gated = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { unblock = resolve; });
  const sent = [];
  setProviderTransportGuard(async () => { entered(); await wait; });
  t.after(() => setProviderTransportGuard());
  const provider = new ChatCompletionsProvider({ fetch: async (_url, init) => {
    sent.push(JSON.parse(init.body)); throw new ProviderError('fixture-complete');
  } });
  const engine = new TranslationEngine({ provider });
  t.after(() => engine.dispose());
  const settings = onlineSettings({ enabled: true, backend, sourceLanguage: 'en', targetLanguage: 'zh',
    batchSize: 20, concurrency: 1, ...(backend === 'local' ? { localModelId: 'fixture', localCapacity: 1 } : {}) });
  const controller = new AbortController();
  const response = engine.translate({ resourceId: 'fixture', settings, apiKey: 'fixture', mode: 'vod', signal: controller.signal,
    items: [{ id: 'drop', text: 'revoked-unique-input', deadlineAt: performance.now() + 5000 },
      { id: 'keep', text: 'retained-unique-input', deadlineAt: performance.now() + 5000 }] });
  await gated;
  engine.cancelItems(controller.signal, ['drop']); unblock();
  await response;
  assert.equal(sent.length, 1);
  assert.equal(JSON.stringify(sent[0]).includes('revoked-unique-input'), false);
  assert.equal(JSON.stringify(sent[0]).includes('retained-unique-input'), true);
});
