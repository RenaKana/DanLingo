import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectFiles } from '../../src/local/gguf.ts';
import { estimateLocalMemory, localMemoryRuntimeKey } from '../../src/local/memory-estimate.ts';
import { detectTemplateCapability, modelTemplateCapability } from '../../src/local/reasoning.ts';
import { localGenerationOptions } from '../../src/local/generation.ts';
import { normalizeLocalConfig, resolveLocalConfig } from '../../src/local/config.ts';

const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const str = value => Buffer.concat([u64(Buffer.byteLength(value)), Buffer.from(value)]);
function gguf(metadata, { tensorCount = 1, tensorBytes = 4096, name = 'metadata.gguf' } = {}) {
  const entries = Object.entries(metadata).map(([key, value]) => {
    const encoded = typeof value === 'number' ? Buffer.concat([u32(4), u32(value)])
      : Array.isArray(value) ? Buffer.concat([u32(9), u32(8), u64(value.length), ...value.map(str)])
      : Buffer.concat([u32(8), str(value)]);
    return Buffer.concat([str(key), encoded]);
  });
  const tensor = Buffer.concat([str('tensor.0'), u32(1), u64(4096), u32(15), u64(0)]);
  const header = Buffer.concat([u32(0x46554747), u32(3), u64(tensorCount), u64(entries.length), ...entries, ...(tensorCount ? [tensor] : [])]);
  const aligned = Buffer.concat([header, Buffer.alloc((32 - (header.length % 32)) % 32), Buffer.alloc(tensorBytes)]);
  return new File([aligned], name);
}
const base = {
  'general.architecture': 'llama', 'general.file_type': 15, 'general.alignment': 32,
  'llama.block_count': 32, 'llama.embedding_length': 4096, 'llama.attention.head_count': 32,
  'llama.attention.head_count_kv': 8, 'llama.attention.key_length': 128, 'llama.attention.value_length': 128,
  'llama.context_length': 8192, 'tokenizer.ggml.model': 'llama', 'tokenizer.ggml.tokens': ['hello'],
  'tokenizer.chat_template': '{% for message in messages %}{% if enable_thinking %}<think>{{ message }}</think>{% endif %}{% endfor %}',
};

test('GGUF metadata reads standard dimensions and bounded weight payload', async () => {
  const info = await inspectFiles([gguf(base, { tensorBytes: 4096 })]);
  assert.equal(info.weightBytes, 4096);
  assert.deepEqual([info.layerCount, info.embeddingLength, info.attentionHeads, info.kvHeads, info.keyLength, info.valueLength,
    info.kvKeyDimension, info.kvValueDimension, info.kvDimension, info.contextLength], [32, 4096, 32, 8, 128, 128, 1024, 1024, 2048, 8192]);
  assert.equal(info.templateCapability?.status, 'verified');
  assert.equal(info.templateCapability?.mode, 'boolean');
});

test('unknown architecture imports but memory formula reports missing components', async () => {
  const info = await inspectFiles([gguf({ ...base, 'general.architecture': 'future-arch' })]);
  const runtime = resolveLocalConfig({ mode: 'custom', contextTokens: 4096, parallel: 4 });
  const estimate = estimateLocalMemory(info, runtime);
  assert.equal(estimate.modelBytes, info.weightBytes);
  assert.equal(estimate.status, 'lower-bound');
  assert.ok(estimate.missing.includes('kvBytes'));
  assert.ok(estimate.missing.includes('computeBytes'));
});

test('unified KV estimate uses total context once and native calibration is scope-bound', async () => {
  const model = await inspectFiles([gguf(base)]);
  const one = resolveLocalConfig({ mode: 'custom', contextTokens: 4096, parallel: 1 });
  const four = resolveLocalConfig({ mode: 'custom', contextTokens: 4096, parallel: 4 });
  const oneEstimate = estimateLocalMemory(model, one);
  const fourEstimate = estimateLocalMemory(model, four);
  assert.equal(oneEstimate.kvBytes, fourEstimate.kvBytes);
  assert.equal(oneEstimate.computeBytes, undefined);
  const observation = { modelId: model.id, runtimeKey: localMemoryRuntimeKey(four), modelBytes: 10, kvBytes: 20, computeBytes: 30 };
  assert.equal(estimateLocalMemory(model, four, observation).source, 'native');
  assert.equal(estimateLocalMemory(model, one, observation).source, 'formula');
});

test('reasoning capability is evidence-based and effort choices never downgrade', () => {
  const effort = detectTemplateCapability('{% for message in messages %}{% if reasoning_effort == "low" %}<analysis>{% endif %}{% if reasoning_effort == "high" %}<think>{% endif %}{{ message }}{% endfor %}');
  assert.deepEqual(effort.supported, ['auto', 'low', 'high']);
  const runtime = resolveLocalConfig({ superChatReasoning: 'high' });
  const generated = localGenerationOptions(runtime, { strategy: 'superchat' }, effort);
  assert.equal(generated.reasoning, 'high');
  assert.deepEqual(generated.options.chat_template_kwargs, { reasoning_effort: 'high' });
  assert.throws(() => localGenerationOptions(resolveLocalConfig({ superChatReasoning: 'max' }), { strategy: 'superchat' }, effort), /LOCAL_REASONING_UNSUPPORTED/);
  assert.equal(normalizeLocalConfig({ superChatReasoning: 'max' }).superChatReasoning, 'max');
  const gptOss = detectTemplateCapability('{% if reasoning_effort == "low" %}<|channel|>analysis<|message|>{% endif %}{% if reasoning_effort == "medium" %}<|channel|>analysis<|message|>{% endif %} messages {% endif %}');
  assert.deepEqual(gptOss.supported, ['auto', 'low', 'medium']);
});

test('official gpt-oss Harmony reasoning header supports only documented efforts', () => {
  const harmony = `{# reasoning_effort comments must not create capability #}
{{- '<|start|>system<|message|>' -}}
{{- "Reasoning: " + reasoning_effort + "\\n" -}}
{{- '<|channel|>analysis<|message|>' -}}
{# {% if reasoning_effort == "max" %}<think>{% endif %} #}`;
  const capability = detectTemplateCapability(harmony, 'gpt-oss');
  assert.equal(capability.status, 'verified');
  assert.equal(capability.mode, 'effort');
  assert.deepEqual(capability.supported, ['auto', 'low', 'medium', 'high']);
  const high = localGenerationOptions(resolveLocalConfig({ superChatReasoning: 'high' }), { strategy: 'superchat' }, capability);
  assert.equal(high.reasoning, 'high');
  assert.deepEqual(high.options.chat_template_kwargs, { reasoning_effort: 'high' });
  assert.throws(() => localGenerationOptions(resolveLocalConfig({ superChatReasoning: 'max' }), { strategy: 'superchat' }, capability), /LOCAL_REASONING_UNSUPPORTED/);
});

test('effort-only templates keep their intrinsic default for ordinary requests', () => {
  const capability = detectTemplateCapability(`{{ '<|start|>system<|message|>' }}{{ "Reasoning: " + reasoning_effort }}{{ '<|channel|>analysis<|message|>' }}`, 'gpt-oss');
  const normal = localGenerationOptions(resolveLocalConfig({ superChatReasoning: 'high' }), { strategy: 'normal' }, capability);
  assert.equal(normal.reasoning, 'auto');
  assert.equal(Object.hasOwn(normal.options, 'chat_template_kwargs'), false);
});

test('Jinja comments cannot fake reasoning capability and legacy metadata stays unknown', () => {
  const commented = detectTemplateCapability(`{# messages {% if reasoning_effort == "high" %}<|channel|>analysis<|message|>{% endif %} #} plain text`);
  assert.equal(commented.status, 'unknown');
  assert.deepEqual(modelTemplateCapability({ id: 'legacy', name: 'legacy', files: [], bytes: 0, architecture: 'llama', quantization: 'unknown', tokenizer: 'llama', template: true, importedAt: 0 }), {
    status: 'unknown', mode: 'unknown', supported: ['auto', 'off', 'on'], evidence: 'unverified-template',
  });
});
