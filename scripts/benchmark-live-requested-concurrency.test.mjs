import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/core/config.ts';
import { REQUESTED_PLAN, uniqueBurstCorpus, requestedBudget, readOfficialStdinConfig } from './benchmark-live-requested-concurrency.mjs';
import { runChainCondition } from './benchmark-live-chain.mjs';

test('official stdin binds destination and restores terminal mode without echoing input', async () => {
  const input = new PassThrough(), modes = [];
  input.isTTY = true; input.isRaw = false; input.setRawMode = value => modes.push(value);
  const result = readOfficialStdinConfig(input);
  input.write('sk-synthetic-only-'); input.write('abcdefghijklmnop\r');
  const config = await result;
  assert.equal(config.settings.endpoint, 'https://api.deepseek.com/chat/completions');
  assert.equal(config.settings.model, 'deepseek-v4-flash');
  assert.equal(config.settings.thinkingEffort, 'off');
  assert.equal(config.apiKey, 'sk-synthetic-only-abcdefghijklmnop');
  assert.deepEqual(modes, [true, false]);
  assert.equal(input.listenerCount('data'), 0);
});

test('official stdin rejects malformed input with a sanitized error', async () => {
  const input = new PassThrough();
  const pending = readOfficialStdinConfig(input);
  input.write('not-a-key\n');
  await assert.rejects(pending, /^Error: invalid-credential-input$/);
  assert.equal(input.listenerCount('data'), 0);
});

test('explicit 2500ms cell remains valid without changing the default, uniqueness or quota bounds', () => {
  assert.deepEqual(REQUESTED_PLAN.map(row => [row.concurrency, row.bufferMs]),
    [[32, 2000], [32, 2500], [32, 3000], [64, 2000], [64, 2500], [64, 3000]]);
  assert.equal(normalizeSettings({}).liveBufferMs, 2000);
  assert.equal(normalizeSettings({ liveBufferMs: 2500 }).liveBufferMs, 2500);
  const corpus = uniqueBurstCorpus([{ text: 'おはようございます' }]);
  assert.equal(corpus.length, 1000);
  assert.equal(new Set(corpus.map(row => row.textSha256)).size, 1000);
  assert.equal(requestedBudget(0, 0), 300);
  assert.equal(requestedBudget(650, 5), 150);
  assert.equal(requestedBudget(800, 5), 0);
  assert.throws(() => uniqueBurstCorpus([{ text: 'あ'.repeat(900) }]), /quota/);
});

for (const concurrency of [32, 64]) test(`isolated 2500ms burst actually fills ${concurrency} mock slots and retains all deadlines`, async () => {
  const corpus = uniqueBurstCorpus([{ text: 'おはようございます' }]);
  const settings = { ...DEFAULT_SETTINGS, enabled: true, displayMode: 'translated', model: 'deepseek-v4-flash', profile: 'deepseek',
    thinkingEffort: 'off', sourceLanguage: 'auto', liveSourceLanguage: 'auto', targetLanguage: 'zh-Hans',
    endpoint: 'https://synthetic.invalid/v1/chat/completions', translationStream: false, batchSize: 10 };
  const result = await runChainCondition({ cell: { id: `mock${concurrency}`, concurrency, bufferMs: 2500, postQuota: 120 },
    corpus, settings, apiKey: 'synthetic-not-sent', run: { actualPosts: 0, maxRequests: 120, stop: null },
    feedMs: 1000, rate: 1000, burst: true,
    transport: async (_url, init) => {
      const rows = JSON.parse(init.body).messages.find(row => row.role === 'user').content.split('\n').map(JSON.parse);
      await new Promise(resolve => setTimeout(resolve, 100));
      return Response.json({ choices: [{ message: { content: rows.map(([id]) => JSON.stringify([id, '早上好'])).join('\n') } }] });
    } });
  assert.equal(result.status, 'COMPLETE_CONTROLLED_CHAIN');
  assert.equal(result.peakActualConcurrency, concurrency);
  assert.equal(result.actualPosts, 100);
  assert.equal(result.summary.onTimeReadyItems, 1000);
  assert.equal(result.summary.localCacheItems, 0);
  assert.equal(result.summary.dropped, 0);
  assert.ok(result.occurrences.every(row => row.releaseCallbackCount === 1 && row.scheduledArrivalAt === 0
    && Math.abs(row.displayAt - row.receivedAt - 2500) < 0.001));
});
