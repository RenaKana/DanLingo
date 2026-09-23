import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  completionEndpoint,
  effectiveStrategy,
  modelsEndpoint,
  normalizeReasoningEffort,
  normalizeSettings,
  reasoningCapabilities,
  reasoningRequestFields,
  strategySettings,
} from '../../src/core/config.ts';
import {
  ConnectionError,
  connectionDisplay,
  normalizeConnection,
  resolveConnection,
} from '../../src/core/connection.ts';

test('root, versioned and full endpoints normalize idempotently while preserving safe query parameters', () => {
  assert.equal(completionEndpoint('https://api.example.invalid'), 'https://api.example.invalid/v1/chat/completions');
  assert.equal(completionEndpoint('https://api.example.invalid/v1/'), 'https://api.example.invalid/v1/chat/completions');
  assert.equal(completionEndpoint('https://api.example.invalid/v1/chat/completions'), 'https://api.example.invalid/v1/chat/completions');
  assert.equal(completionEndpoint('https://api.example.invalid/v1/chat/completions?region=us&api-version=2026-01-01'),
    'https://api.example.invalid/v1/chat/completions?region=us&api-version=2026-01-01');
  assert.equal(modelsEndpoint('https://api.example.invalid/v1?region=us'), 'https://api.example.invalid/v1/models?region=us');
  const normalized = normalizeSettings({ endpoint: 'https://api.example.invalid/v1?region=us', model: 'custom-model' });
  assert.equal(normalized.endpoint, 'https://api.example.invalid/v1/chat/completions?region=us');
  assert.equal(normalizeSettings(normalized).endpoint, normalized.endpoint);
  assert.equal(normalizeSettings(normalized).endpointInput, normalized.endpointInput);
  const explicitRoot = resolveConnection({ endpoint: 'https://api.example.invalid', endpointMode: 'completion' });
  assert.equal(explicitRoot.configuredCompletionEndpoint, 'https://api.example.invalid/');
  assert.equal(explicitRoot.configuredModelsEndpoint, undefined);
  const explicitFull = resolveConnection({ endpoint: 'https://api.example.invalid/v1/chat/completions', endpointMode: 'completion' });
  assert.equal(explicitFull.configuredCompletionEndpoint, 'https://api.example.invalid/v1/chat/completions');
  assert.equal(explicitFull.configuredModelsEndpoint, 'https://api.example.invalid/v1/models');
});

test('proxy prefixes and Gemini OpenAI compatibility paths are retained', () => {
  const gemini = resolveConnection({ endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/?project=demo' });
  assert.equal(gemini.baseEndpoint, 'https://generativelanguage.googleapis.com/v1beta/openai?project=demo');
  assert.equal(gemini.configuredCompletionEndpoint, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions?project=demo');
  assert.equal(gemini.configuredModelsEndpoint, 'https://generativelanguage.googleapis.com/v1beta/openai/models?project=demo');
  assert.equal(gemini.protocol, 'chat-completions');
  assert.equal(gemini.brand, 'gemini');
  const proxy = resolveConnection({ endpoint: 'https://gateway.example.invalid/tenant/a/v1/' });
  assert.equal(proxy.configuredCompletionEndpoint, 'https://gateway.example.invalid/tenant/a/v1/chat/completions');
  assert.equal(proxy.configuredModelsEndpoint, 'https://gateway.example.invalid/tenant/a/v1/models');
});

test('ambiguous custom gateways preserve their operation path and allow an explicit base override', () => {
  const custom = normalizeConnection({ endpoint: 'https://gateway.example.invalid/translate' });
  assert.equal(custom.configuredCompletionEndpoint, 'https://gateway.example.invalid/translate');
  assert.equal(custom.requiresManualPath, true);
  assert.equal(custom.modelsEndpoint, undefined);
  assert.throws(() => modelsEndpoint('https://gateway.example.invalid/translate'), (error) => {
    assert.ok(error instanceof ConnectionError);
    assert.equal(error.code, 'ambiguous-models-endpoint');
    return true;
  });
  assert.equal(completionEndpoint('https://gateway.example.invalid/translate', false, { endpointMode: 'base' }),
    'https://gateway.example.invalid/translate/chat/completions');
  assert.equal(modelsEndpoint('https://gateway.example.invalid/translate', false, { endpointMode: 'base' }),
    'https://gateway.example.invalid/translate/models');
});

test('protocol detection is independent from inferred brand and model name', () => {
  const unknown = resolveConnection({ endpoint: 'https://gateway.example.invalid/v1', protocol: 'auto' });
  assert.deepEqual({ protocol: unknown.protocol, protocolSource: unknown.protocolSource, brand: unknown.brand },
    { protocol: 'chat-completions', protocolSource: 'auto', brand: 'unknown' });
  assert.equal(resolveConnection({ endpoint: 'https://gateway.example.invalid/v1', protocolOverride: 'chat-completions' }).protocolSource, 'manual');
  assert.equal(normalizeSettings({ endpoint: 'https://gateway.example.invalid/v1', model: 'gemini-2.5-flash' }).profile, 'chat-completions',
    'custom domains do not infer a vendor dialect from model name');
  assert.equal(normalizeSettings({ endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'arbitrary-model', reasoningProfileOverride: 'auto' }).profile, 'gemini');
  assert.equal(connectionDisplay(unknown).status, 'recognized');
});

test('migrated explicit reasoning profiles survive while auto is available as an advanced override', () => {
  const migrated = normalizeSettings({ schemaVersion: 2, endpoint: 'https://gateway.example.invalid/v1', model: 'custom', profile: 'deepseek', thinkingEffort: 'high' }, {stored:true});
  assert.equal(migrated.profile, 'deepseek');
  assert.equal(migrated.reasoningProfileOverride, undefined);
  const automatic = normalizeSettings({ endpoint: 'https://gateway.example.invalid/v1', model: 'deepseek-reasoner', reasoningProfileOverride: 'auto' });
  assert.equal(automatic.profile, 'chat-completions');
  assert.equal(automatic.thinkingEffort, 'default');
  const explicit = normalizeSettings({ endpoint: 'https://gateway.example.invalid/v1', model: 'deepseek-v4-pro', reasoningProfileOverride: 'deepseek', thinkingEffort: 'high' });
  assert.equal(explicit.profile, 'deepseek');
  assert.equal(explicit.reasoningProfileOverride, 'deepseek');
});

test('model-aware reasoning capabilities and wire fields reject unsupported off modes', () => {
  const reasoner = { profile: 'deepseek', model: 'deepseek-reasoner' };
  assert.deepEqual(reasoningCapabilities(reasoner).efforts, ['default']);
  assert.throws(() => normalizeReasoningEffort(reasoner, 'off'), { message: 'unsupported-thinking-effort' });
  assert.throws(()=>reasoningRequestFields({ ...DEFAULT_SETTINGS, ...reasoner, thinkingEffort:'max' }),/unsupported-thinking-effort/);
  assert.deepEqual(reasoningRequestFields({ ...DEFAULT_SETTINGS, ...reasoner, model:'deepseek-v4-pro', thinkingEffort: 'high' }),
    { thinking: { type: 'enabled' }, reasoning_effort: 'high' });
  const o3 = { ...DEFAULT_SETTINGS, profile: 'chat-completions', model: 'o3-mini', thinkingEffort: 'high' };
  assert.deepEqual(reasoningCapabilities(o3).efforts, ['default', 'low', 'medium', 'high']);
  assert.deepEqual(reasoningRequestFields(o3), { reasoning_effort: 'high' });
  assert.throws(() => reasoningRequestFields({ ...o3, thinkingEffort: 'off' }), { message: 'unsupported-thinking-effort' });
});

test('Super Chat strategy resolves independent effort and timeout without mutating saved settings', () => {
  const settings = normalizeSettings({ ...DEFAULT_SETTINGS, profile: 'deepseek', model: 'deepseek-v4-pro', thinkingEffort: 'off',
    superChatThinkingEffort: 'high', superChatTimeoutMs: 45000 });
  const normal = effectiveStrategy(settings, 'normal');
  const superchat = effectiveStrategy(settings, 'superchat');
  assert.deepEqual([normal.thinkingEffort, normal.timeoutMs], ['off', 12000]);
  assert.deepEqual([superchat.thinkingEffort, superchat.timeoutMs], ['high', 45000]);
  assert.equal(effectiveStrategy({ ...settings, superChatThinkingEffort: 'inherit' }, 'superchat').thinkingEffort, 'off');
  const adapted = strategySettings(settings, 'superchat');
  assert.deepEqual([adapted.thinkingEffort, adapted.requestTimeoutMs, adapted.thinkingRequestTimeoutMs], ['high', 45000, 45000]);
  assert.equal(settings.thinkingEffort, 'off');
});

test('live adaptive concurrency defaults off while explicit saved true survives normalization', () => {
  assert.equal(DEFAULT_SETTINGS.liveAdaptiveConcurrency, false);
  assert.equal(normalizeSettings(undefined).liveAdaptiveConcurrency, false);
  assert.equal(normalizeSettings({ liveAdaptiveConcurrency: true }).liveAdaptiveConcurrency, true);
});
