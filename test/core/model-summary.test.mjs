import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../../src/core/config.ts';
import { translationModelSummary } from '../../src/core/model-summary.ts';

test('live bar summarizes supported online settings and never an old local model', () => {
  const settings = { ...DEFAULT_SETTINGS, backend: 'online', model: 'deepseek-v4-flash', profile: 'deepseek', thinkingEffort: 'off', superChatThinkingEffort: 'max' };
  assert.equal(translationModelSummary(settings, { phase: 'ready', paused: false, modelName: 'old.gguf' }), '在线 · deepseek-v4-flash · 思考 关闭 · SC 思考 max');
});
test('missing models and unknown/service-default thinking are omitted', () => {
  assert.equal(translationModelSummary({ ...DEFAULT_SETTINGS, model: '' }), '');
  assert.equal(translationModelSummary({ ...DEFAULT_SETTINGS, model: 'unverified-proxy-model', thinkingEffort: 'high' }), '在线 · unverified-proxy-model');
  assert.equal(translationModelSummary({ ...DEFAULT_SETTINGS, profile: 'deepseek', model: 'deepseek-v4-flash', thinkingEffort: 'default' }), '在线 · deepseek-v4-flash');
});
test('local model summary uses the matching loaded name and actual supported runtime choices only', () => {
  const settings = { ...DEFAULT_SETTINGS, backend: 'local', localModelId: 'one' };
  const runtime = { phase: 'ready', paused: false, modelId: 'one', modelName: 'Model Q4.gguf', normalThinking: 'off', superChatThinking: 'high' };
  assert.equal(translationModelSummary(settings, runtime), '本地 · Model Q4.gguf · 思考 关闭 · SC 思考 high');
  assert.equal(translationModelSummary(settings, { ...runtime, modelId: 'two' }), '');
  assert.equal(translationModelSummary(settings, { ...runtime, phase: 'loading' }), '');
});
