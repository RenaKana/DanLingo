import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatCompletionsProvider, ProviderError } from '../../src/translation/provider.ts';
import { onlineSettings } from '../fixtures/online-settings.mjs';

test('dispatch callback observes only final live inputs after asynchronous online gate', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const seen = [], sends = [];
  const settings = onlineSettings({ enabled: true, thinkingEffort: 'off' });
  const provider = new ChatCompletionsProvider({ beforeOnlineRequest: () => gate, fetch: async (_url, init) => {
    sends.push(init);
    const body = JSON.parse(init.body);
    const items = JSON.parse(body.messages[1].content).items;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ items: items.map(item => ({ id: item.id, text: '中文译文' })) }) } }] });
  } });
  const active = new Set(['keep', 'drop']);
  const pending = provider.complete({ settings, apiKey: 'fixture-key', budgetMs: 3000, mode: 'vod',
    items: [{ id: 'keep', text: '日本語テキストです' }, { id: 'drop', text: '除去する日本語です' }],
    isItemCurrent: id => active.has(id), onDispatch: (items, backend) => seen.push({ items, backend }) });
  active.delete('drop');
  assert.equal(seen.length, 0);
  release();
  await pending;
  assert.equal(sends.length, 1);
  assert.deepEqual(seen, [{ items: [{ id: 'keep', text: '日本語テキストです' }], backend: 'online' }]);
});

test('rejected online budget gate never reports a transport dispatch', async () => {
  let sends = 0, dispatches = 0;
  const provider = new ChatCompletionsProvider({ beforeOnlineRequest: async () => {
    throw new ProviderError('online-daily-limit-reached');
  }, fetch: async () => { sends++; throw new Error('unexpected transport'); } });
  await assert.rejects(provider.complete({ settings: onlineSettings({ enabled: true }), apiKey: 'fixture-key',
    budgetMs: 1000, mode: 'vod', items: [{ id: 'a', text: '日本語テキストです' }],
    onDispatch: () => { dispatches++; } }), error => error.code === 'online-daily-limit-reached');
  assert.equal(sends, 0);
  assert.equal(dispatches, 0);
});
