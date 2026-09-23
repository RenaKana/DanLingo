import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, normalizeSettings } from '../../src/core/config.ts';
import { withLocalRuntime } from '../../src/local/provider-settings.ts';
import { detectTranslationProfile, translationLoadOptions, translationPrompt, translationRawOptions, translationLanguageIssue } from '../../src/local/translation-profile.ts';
import { inspectFiles } from '../../src/local/gguf.ts';
import { nativeLoadError } from '../../src/local/load-diagnostics.ts';
import { normalizeLocalConfig, resolveLocalConfig } from '../../src/local/config.ts';
import { localCompletionCollector } from '../../src/local/completion.ts';
import { localGenerationOptions } from '../../src/local/generation.ts';
import { localPromptMode } from '../../src/translation/local-policy.ts';
import { buildProviderPayload, parseLocalProviderResult, ChatCompletionsProvider } from '../../src/translation/provider.ts';
import { TranslationEngine } from '../../src/translation/engine.ts';
import { testModel } from '../../src/translation/model-test.ts';

function ggufFixture(metadata = {}, name = 'fixture.gguf', tensorCount = 1) {
  const u32 = n => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(n); return bytes; };
  const u64 = n => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(n)); return bytes; };
  const str = value => Buffer.concat([u64(Buffer.byteLength(value)), Buffer.from(value)]);
  const values = { 'general.architecture': 'llama', 'general.file_type': 15,
    'tokenizer.ggml.model': 'llama', 'tokenizer.ggml.tokens': ['hello'],
    'tokenizer.chat_template': '{{ messages }}', ...metadata };
  const entries = Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => Buffer.concat([str(key),
    typeof value === 'number' ? Buffer.concat([u32(4), u32(value)])
      : Array.isArray(value) ? Buffer.concat([u32(9), u32(8), u64(value.length), ...value.map(str)])
        : Buffer.concat([u32(8), str(value)])]));
  return new File([Buffer.concat([u32(0x46554747), u32(3), u64(tensorCount), u64(entries.length), ...entries])], name);
}

const seedText = 'こんにちは';
const settingsFor = (profile, overrides = {}) => ({ ...DEFAULT_SETTINGS, enabled: true, backend: 'local',
  model: 'local-id', localModelId: 'local-id', localModelName: 'arbitrary.gguf', sourceLanguage: 'en',
  targetLanguage: 'ja', batchSize: 20, concurrency: 4, localCapacity: 4, localContextTokens: 2048,
  localTranslationProfile: profile, localPerformance: normalizeLocalConfig(), ...overrides });
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };

test('embedded architecture and identity select profiles; filenames do not', async () => {
  assert.equal(detectTranslationProfile({ 'general.architecture': 'llama', 'general.basename': 'Seed X PPO' }), 'seed-x');
  assert.equal(detectTranslationProfile({ 'general.architecture': 'gemma3', 'general.name': 'TranslateGemma 4B' }), 'translategemma');
  assert.equal(detectTranslationProfile({ 'general.architecture': 'gemma3', 'general.name': 'Seed-X-PPO' }), undefined);
  assert.equal(detectTranslationProfile({ 'general.architecture': 'llama', 'general.name': 'ordinary model', filename: 'Seed-X-PPO.gguf' }), undefined);

  const seed = await inspectFiles([ggufFixture({ 'general.name': 'Seed X PPO' }, 'unrelated.gguf')]);
  const gemma = await inspectFiles([ggufFixture({ 'general.architecture': 'gemma3', 'general.name': 'TranslateGemma' }, 'unrelated.gguf')]);
  const filenameOnly = await inspectFiles([ggufFixture({}, 'Seed-X-PPO.gguf')]);
  assert.equal(seed.translationProfile, 'seed-x');
  assert.equal(gemma.translationProfile, 'translategemma');
  assert.equal(filenameOnly.translationProfile, undefined);
});

test('Seed-X and TranslateGemma prompts keep their model-specific raw formats and reject invalid language requests', () => {
  const seed = translationPrompt('seed-x', 'auto', 'zh-Hans', seedText);
  assert.match(seed, /^Translate the following sentence into (?:Simplified )?Chinese:/);
  assert.ok(seed.endsWith(`${seedText} <zh>`));
  assert.doesNotMatch(seed, /<start_of_turn>|<\|im_start\|>/);

  const gemma = translationPrompt('translategemma', 'fr', 'ja', ' Bonjour ');
  assert.match(gemma, /^<start_of_turn>user\nYou are a professional French \(fr\) to Japanese \(ja\) translator\./);
  assert.match(gemma, /Produce only the Japanese translation/);
  assert.ok(gemma.endsWith('<end_of_turn>\n<start_of_turn>model\n'));
  assert.match(gemma, /Please translate the following French text into Japanese:\n\n\nBonjour/);
  assert.throws(() => translationPrompt('translategemma', 'auto', 'ja', seedText), /LOCAL_TRANSLATION_SOURCE_REQUIRED/);
  assert.throws(() => translationPrompt('translategemma', 'en', 'zz-ZZ', seedText), /LOCAL_TRANSLATION_LANGUAGE_UNSUPPORTED/);
});

test('profile startup options use a built-in parser while inference accepts exactly one raw user prompt', () => {
  for (const profile of ['seed-x', 'translategemma']) {
    assert.deepEqual(translationLoadOptions(profile), { jinja: false, chat_template: 'chatml' });
    const prompt = translationPrompt(profile, profile === 'seed-x' ? 'auto' : 'en', 'ja', seedText);
    assert.deepEqual(translationRawOptions(profile, [{ role: 'user', content: prompt }]).prompt, prompt);
    assert.throws(() => translationRawOptions(profile, [
      { role: 'user', content: prompt }, { role: 'user', content: 'again' },
    ]), /LOCAL_REQUEST_INVALID/);
    assert.throws(() => translationRawOptions(profile, [{ role: 'system', content: prompt }]), /LOCAL_REQUEST_INVALID/);
  }
});

test('trusted loaded profile replaces a stale settings value and stays out of normalized settings', () => {
  const settings = settingsFor('seed-x', { localTranslationProfile: 'seed-x', localPerformance: { promptMode: 'json' } });
  const stamped = withLocalRuntime(settings, { runtime: resolveLocalConfig(), model: {
    name: 'TranslateGemma.gguf', translationProfile: 'translategemma',
  } });
  assert.equal(stamped.localTranslationProfile, 'translategemma');
  assert.equal(stamped.localPerformance.promptMode, 'json');
  assert.notEqual(localPromptMode(stamped), 'json');
  const normalized = normalizeSettings({ ...settings, localTranslationProfile: 'seed-x' });
  assert.equal(Object.hasOwn(normalized, 'localTranslationProfile'), false);
});

test('dedicated profiles take precedence over generic JSON prompt selection', () => {
  const generic = settingsFor(undefined, { localPerformance: { promptMode: 'json' } });
  assert.equal(localPromptMode(generic), 'json');
  for (const profile of ['seed-x', 'translategemma']) {
    const specialized = settingsFor(profile, { localPerformance: { promptMode: 'json' } });
    assert.notEqual(localPromptMode(specialized), 'json');
  }
});

test('provider emits and accepts one plain-text profile completion, rejecting a batch', () => {
  const settings = settingsFor('translategemma', { localPerformance: { promptMode: 'json' } });
  const items = [{ id: 'a', text: 'Hello there.' }];
  const body = buildProviderPayload(settings, items, 'deadline');
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'user');
  assert.match(body.messages[0].content, /^<start_of_turn>user/);
  assert.doesNotMatch(body.messages[0].content, /\{"items"|JSONL|integer_id/);
  assert.throws(() => buildProviderPayload(settings, [...items, { id: 'b', text: 'How are you?' }], 'deadline'), /local-single-item-required/);

  const result = parseLocalProviderResult({ choices: [{ message: { content: 'こんにちは。' }, finish_reason: 'stop' }] }, items, settings);
  assert.deepEqual(result.items.get('a'), { text: 'こんにちは。' });
});

test('TranslateGemma exposes language readiness without rejecting auto for other local profiles', () => {
  assert.equal(translationLanguageIssue('translategemma', 'auto', 'zh-Hans'), 'LOCAL_TRANSLATION_SOURCE_REQUIRED');
  assert.equal(translationLanguageIssue('translategemma', 'ja', 'zz-ZZ'), 'LOCAL_TRANSLATION_LANGUAGE_UNSUPPORTED');
  assert.equal(translationLanguageIssue('translategemma', 'ja', 'zh-Hans'), undefined);
  assert.equal(translationLanguageIssue('seed-x', 'auto', 'zh-Hans'), undefined);
  assert.equal(translationLanguageIssue(undefined, 'auto', 'zh-Hans'), undefined);
});

test('TranslateGemma model test and normal video/live dispatch recover after selecting the source language', async t => {
  const requests = [];
  const options = { fetch: async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    assert.match(body.messages[0].content, /Japanese \(ja\) to Chinese \(zh-Hans\)/);
    return Response.json({ choices: [{ message: { content: '这个视频很有趣。' }, finish_reason: 'stop' }] });
  } };
  const base = settingsFor('translategemma', { sourceLanguage: 'auto', targetLanguage: 'zh-Hans' });
  await assert.rejects(testModel({ settings: base, apiKey: 'local-inference' }, options), /LOCAL_TRANSLATION_SOURCE_REQUIRED/);
  assert.equal(requests.length, 0);
  const corrected = { ...base, sourceLanguage: 'ja' };
  assert.equal((await testModel({ settings: corrected, apiKey: 'local-inference' }, options)).text, '这个视频很有趣。');
  for (const mode of ['vod', 'deadline']) {
    const engine = new TranslationEngine({ provider: new ChatCompletionsProvider(options) });
    t.after(() => engine.dispose());
    const request = { resourceId: 'gemma-readiness', apiKey: 'local-inference', mode,
      items: [{ id: 'a', text: 'この動画はとても面白いです。', deadlineAt: performance.now() + 3000 }] };
    const rejected = await engine.translate({ ...request, settings: base });
    assert.equal(rejected.items[0].reason, 'LOCAL_TRANSLATION_SOURCE_REQUIRED');
    const restored = await engine.translate({ ...request, settings: corrected });
    assert.equal(restored.items[0].status, 'translated');
    assert.equal(restored.items[0].text, '这个视频很有趣。');
  }
  assert.equal(requests.length, 3);
});

test('engine keeps specialized model requests single-item at configured batch size', async t => {
  const requests = [];
  const engine = new TranslationEngine({ provider: { complete: request => new Promise(resolve => requests.push({ request, resolve })) } });
  t.after(() => engine.dispose());
  const settings = settingsFor('seed-x', { batchSize: 20, localPerformance: { promptMode: 'json' } });
  const pending = engine.translate({ settings, resourceId: 'profile-test', apiKey: '', mode: 'deadline',
    items: Array.from({ length: 4 }, (_, index) => ({ id: String(index), text: `message ${index}`, deadlineAt: performance.now() + 3000 })) });
  await flush();
  assert.equal(requests.length, 4);
  assert.ok(requests.every(({ request }) => request.items.length === 1));
  for (const { request, resolve } of requests) resolve({ items: new Map(request.items.map(item => [item.id, { text: '翻訳しました。' }])) });
  assert.ok((await pending).items.every(item => item.status === 'translated'));
});

test('completion collector consumes raw text, preserves terminal state through usage, and retains chat deltas', () => {
  const raw = localCompletionCollector();
  raw.onData({ choices: [{ text: 'raw output', finish_reason: 'length' }] });
  raw.onData({ choices: [], usage: { completion_tokens: 2 } });
  const rawResult = raw.result();
  assert.equal(rawResult.choices[0].message.content, 'raw output');
  assert.equal(rawResult.choices[0].finish_reason, 'length');
  assert.deepEqual(rawResult.usage, { completion_tokens: 2 });

  const chat = localCompletionCollector();
  chat.onData({ choices: [{ delta: { content: 'chat output' }, finish_reason: 'stop' }] });
  assert.equal(chat.result().choices[0].message.content, 'chat output');

  const incomplete = localCompletionCollector();
  incomplete.onData({ choices: [{ text: 'partial output' }] });
  assert.throws(() => incomplete.result(), /LOCAL_INFERENCE_INCOMPLETE/);
});

test('only a recognized Seed-X GGUF may import without an embedded chat template', async () => {
  const seed = await inspectFiles([ggufFixture({ 'general.name': 'Seed-X-PPO', 'tokenizer.chat_template': undefined })]);
  assert.equal(seed.translationProfile, 'seed-x');
  assert.equal(seed.template, false);
  assert.deepEqual(seed.templateCapability.supported, ['auto']);
  const runtime = resolveLocalConfig();
  const generation = localGenerationOptions(runtime, {}, seed);
  assert.equal(generation.reasoning, 'auto');
  assert.equal(generation.options.chat_template_kwargs, undefined);
  assert.throws(() => localGenerationOptions({ ...runtime, superChatReasoning: 'off' }, { strategy: 'superchat' }, seed), /LOCAL_REASONING_UNSUPPORTED/);
  await assert.rejects(inspectFiles([ggufFixture({ 'tokenizer.chat_template': undefined })]), /LOCAL_CHAT_TEMPLATE_MISSING/);
});

test('NLLB and mBART rejection precedes missing vocabulary, and zero-tensor vocabulary is not a model', async () => {
  for (const architecture of ['nllb', 'mbart']) {
    await assert.rejects(inspectFiles([ggufFixture({ 'general.architecture': architecture,
      'tokenizer.ggml.model': undefined, 'tokenizer.ggml.tokens': undefined })]), /LOCAL_NLLB_UNSUPPORTED/);
  }
  await assert.rejects(inspectFiles([ggufFixture({}, 'vocab.gguf', 0)]), /LOCAL_VOCAB_ONLY/);
});

test('native load diagnostics keep only template and architecture categories', () => {
  const template = nativeLoadError('Chat template parsing error: private-template-marker');
  const architecture = nativeLoadError('unknown model architecture: private-architecture-marker');
  const unknown = nativeLoadError('native warning with private-log-marker');
  assert.equal(template, 'LOCAL_CHAT_TEMPLATE_UNSUPPORTED');
  assert.equal(architecture, 'LOCAL_NATIVE_UNSUPPORTED');
  assert.equal(unknown, undefined);
  assert.doesNotMatch(JSON.stringify([template, architecture, unknown]), /private-(?:template|architecture|log)-marker/);
});
