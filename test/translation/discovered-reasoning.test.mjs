import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, reasoningCapabilities, reasoningRequestFields, strategySettings } from '../../src/core/config.ts';
import { ChatCompletionsProvider } from '../../src/translation/provider.ts';
import { onlineSettings } from '../fixtures/online-settings.mjs';

const endpoint = 'https://api.deepseek.com/v1/chat/completions';
const model = 'deepseek-flash';
const observed = (patch = {}) => ({ model, endpoint, fetchedAt: Date.now(),
  effort: { supportedLevels: ['low', 'high', 'max'], defaultLevel: 'high' }, ...patch });
const settings = (patch = {}) => onlineSettings({ endpoint, model, profile: 'deepseek', thinkingEffort: 'default', modelReasoning: observed(), ...patch });

test('service metadata supplies efforts for new model names without changing the selected default', () => {
  for (const name of ['deepseek-flash', 'deepseek-v4.1-flash', 'a-future-model']) {
    const input = settings({ model: name, modelReasoning: observed({ model: name }) });
    const cap = reasoningCapabilities(input);
    assert.deepEqual(cap.efforts, ['default', 'off', 'low', 'high', 'max']);
    assert.equal(cap.source, 'service');
    assert.equal(cap.enabledDefaultEffort, 'high');
    assert.equal(cap.defaultEffort, 'default');
    assert.deepEqual(reasoningRequestFields(input), {});
    assert.deepEqual(reasoningRequestFields({ ...input, thinkingEffort: 'off' }), { thinking: { type: 'disabled' } });
    assert.deepEqual(reasoningRequestFields({ ...input, thinkingEffort: 'low' }), { thinking: { type: 'enabled' }, reasoning_effort: 'low' });
  }
});

test('authoritative metadata can narrow a known model fallback and supports new effort names', () => {
  const input = settings({ model: 'deepseek-v4-pro', modelReasoning: observed({ model: 'deepseek-v4-pro', effort: { supportedLevels: ['economy', 'high'] } }) });
  assert.throws(() => reasoningRequestFields({ ...input, thinkingEffort: 'max' }), /unsupported-thinking-effort/);
  assert.deepEqual(reasoningRequestFields({ ...input, thinkingEffort: 'economy' }), { thinking: { type: 'enabled' }, reasoning_effort: 'economy' });
});

test('default enabled effort is optional and dialect controls the wire format', () => {
  const input = settings({ profile: 'chat-completions', modelReasoning: observed({ effort: { supportedLevels: ['none', 'low', 'high'] } }) });
  assert.deepEqual(reasoningRequestFields({ ...input, thinkingEffort: 'off' }), { reasoning_effort: 'none' });
  assert.deepEqual(reasoningRequestFields({ ...input, thinkingEffort: 'high' }), { reasoning_effort: 'high' });
  assert.equal(reasoningCapabilities(input).enabledDefaultEffort, undefined);
  assert.deepEqual(reasoningRequestFields(settings({ superChatThinkingEffort: 'low' }), 'superchat'), { thinking: { type: 'enabled' }, reasoning_effort: 'low' });
  assert.equal(strategySettings(settings({ backend: 'local', thinkingEffort: 'economy' })).thinkingEffort, 'off');
});

test('missing, expired, different endpoint/model metadata cannot grant capabilities', () => {
  for (const modelReasoning of [undefined, observed({ fetchedAt: Date.now() - 86400001 }), observed({ fetchedAt: Date.now() + 60000 }),
    observed({ model: 'other' }), observed({ endpoint: 'https://other.example/v1/chat/completions' })]) {
    const input = settings({ modelReasoning, thinkingEffort: 'off' });
    assert.equal(reasoningCapabilities(input).verified, false);
    assert.throws(() => reasoningRequestFields(input), /unsupported-thinking-effort/);
  }
});

test('saved capability claims are ignored; explicit saved choices survive until authoritative validation', () => {
  const raw = settings({ thinkingEffort: 'economy' });
  const stored = normalizeSettings(raw, { stored: true });
  assert.equal(stored.thinkingEffort, 'economy');
  assert.equal(stored.modelReasoning, undefined);
  assert.throws(() => normalizeSettings(raw), /unsupported-thinking-effort/);
  const trusted = observed({ effort: { supportedLevels: ['economy'] } });
  assert.equal(normalizeSettings(raw, { modelReasoning: trusted }).thinkingEffort, 'economy');
});

test('actual provider sends off/effort once and never retries an unsupported service parameter', async () => {
  const bodies = [];
  const provider = new ChatCompletionsProvider({ fetch: async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response('', { status: 400 });
  } });
  for (const thinkingEffort of ['off', 'low']) {
    await assert.rejects(provider.complete({ settings: settings({ thinkingEffort }), apiKey: 'fixture', items: [{ id: 'one', text: 'テスト' }], budgetMs: 1000 }), { message: 'http-400', retryable: false });
  }
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0].thinking, { type: 'disabled' });
  assert.equal(bodies[0].reasoning_effort, undefined);
  assert.deepEqual(bodies[1].thinking, { type: 'enabled' });
  assert.equal(bodies[1].reasoning_effort, 'low');
  await assert.rejects(provider.complete({ settings: settings({ thinkingEffort: 'medium' }), apiKey: 'fixture', items: [{ id: 'one', text: 'テスト' }], budgetMs: 1000 }), { message: 'unsupported-thinking-effort' });
  assert.equal(bodies.length, 2);
});
