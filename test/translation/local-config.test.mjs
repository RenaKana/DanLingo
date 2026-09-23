import test from 'node:test';
import assert from 'node:assert/strict';
import { applyLocalRecommendation, normalizeLocalConfig, resolveLocalConfig } from '../../src/local/config.ts';

test('shared context grows to cover sequences and estimated request size', () => {
  for (const [parallel, expected] of [[1,2048],[4,2048],[8,4096],[16,8192],[32,16384]]) {
    const c = resolveLocalConfig({ mode:'custom', parallel });
    assert.equal(c.contextTokens, expected);
    assert.ok(c.contextTokens >= parallel * c.estimatedTokensPerRequest * 1.5);
    assert.equal(c.kvUnified, true);
    assert.equal(c.continuousBatching, true);
  }
  assert.equal(resolveLocalConfig({ mode:'custom',parallel:4,estimatedTokensPerRequest:1000 }).contextTokens,8192);
  assert.equal(resolveLocalConfig({mode:'custom',parallel:32,estimatedTokensPerRequest:2048}).contextTokens,131072);
});

test('batch profiles and explicit controls resolve without changing saved preferences', () => {
  const input = {mode:'custom',parallel:8,batchPreset:'throughput',cpuThreads:2,warmup:false,flashAttention:'off'};
  const before = structuredClone(input), c = resolveLocalConfig(input);
  assert.deepEqual(input,before);
  assert.deepEqual([c.batch,c.microBatch,c.cpuThreads,c.warmup,c.flashAttention],[512,512,2,false,'off']);
  const compatibility = resolveLocalConfig({batchPreset:'compatibility'});
  assert.deepEqual([compatibility.batch,compatibility.microBatch],[128,128]);
  const custom = resolveLocalConfig({mode:'custom',batchPreset:'custom',batch:256,microBatch:64,contextTokens:8192});
  assert.deepEqual([custom.batch,custom.microBatch,custom.contextTokens],[256,64,8192]);
});

test('invalid capacities and generation settings fail before model replacement', () => {
  for (const input of [{parallel:0},{parallel:1.5},{contextTokens:0},{batch:0,microBatch:256},
    {batch:128,microBatch:256},{normalMaxTokens:0},{cpuThreads:0},{warmup:'yes'},{temperature:NaN},{flashAttention:'maybe'},
    {allowAutoFallback:'yes'},{reusePromptCache:'yes'},{promptMode:'plain'},{languageValidation:'best-effort'}]) {
    assert.throws(()=>normalizeLocalConfig(input),/CONFIG_INVALID/);
  }
  const defaults = normalizeLocalConfig();
  assert.equal(defaults.cpuThreads,'auto'); assert.equal(defaults.warmup,true);
  assert.equal(defaults.reusePromptCache,false);
  assert.equal(resolveLocalConfig({reusePromptCache:true}).reusePromptCache,true);
  assert.deepEqual([defaults.normalMaxTokens,defaults.superChatMaxTokens,defaults.manualMaxTokens],[128,256,512]);
  assert.deepEqual([defaults.allowAutoFallback,defaults.promptMode,defaults.languageValidation],[true,'auto','strict']);
});

test('custom controls accept finite native-sized values beyond the old product caps', () => {
  const config = normalizeLocalConfig({ mode:'custom', parallel:64, contextTokens:32768, batchPreset:'custom', batch:2048,
    microBatch:1536, estimatedTokensPerRequest:4096, normalMaxTokens:4096, superChatMaxTokens:8192,
    manualMaxTokens:16384, cpuThreads:12, temperature:0.35, allowAutoFallback:false, promptMode:'json', languageValidation:'off' });
  assert.deepEqual([config.parallel,config.contextTokens,config.batch,config.microBatch,config.estimatedTokensPerRequest,
    config.normalMaxTokens,config.superChatMaxTokens,config.manualMaxTokens,config.cpuThreads,config.temperature,
    config.allowAutoFallback,config.promptMode,config.languageValidation],
    [64,32768,2048,1536,4096,4096,8192,16384,12,0.35,false,'json','off']);
});

test('matching auto recommendations apply only to their model and preserve generation policy', () => {
  const recommendation = { modelId:'model-a', measuredAt:1234, parallel:8, contextTokens:4096, batch:512, microBatch:512, flashAttention:'on', cpuThreads:4 };
  const input = { mode:'auto', temperature:0.2, normalMaxTokens:222, superChatMaxTokens:333, manualMaxTokens:444, superChatReasoning:'off', autoRecommendation:recommendation };
  const before = structuredClone(input);
  const matched = resolveLocalConfig(input, 'model-a');
  assert.deepEqual([matched.parallel,matched.contextTokens,matched.batch,matched.microBatch,matched.flashAttention,matched.cpuThreads],[8,4096,512,512,'on',4]);
  assert.deepEqual([matched.temperature,matched.normalMaxTokens,matched.superChatMaxTokens,matched.manualMaxTokens,matched.superChatReasoning],[0.2,222,333,444,'off']);
  assert.deepEqual(input,before);
  const mismatch = resolveLocalConfig(input, 'model-b');
  assert.deepEqual([mismatch.parallel,mismatch.contextTokens,mismatch.batch,mismatch.microBatch,mismatch.flashAttention,mismatch.cpuThreads],[4,2048,512,256,'auto','auto']);
});

test('non-auto modes ignore a matching auto recommendation', () => {
  const runtime = resolveLocalConfig({ mode:'custom', parallel:2, contextTokens:8192, batchPreset:'custom', batch:256, microBatch:128,
    flashAttention:'off', cpuThreads:2, autoRecommendation:{ modelId:'model-a', measuredAt:1, parallel:16, contextTokens:16384, batch:1024, microBatch:512, flashAttention:'on', cpuThreads:8 } }, 'model-a');
  assert.deepEqual([runtime.parallel,runtime.contextTokens,runtime.batch,runtime.microBatch,runtime.flashAttention,runtime.cpuThreads],[2,8192,256,128,'off',2]);
});

test('auto recommendation validation rejects malformed capacity and scope values and clones nested data', () => {
  const valid = { modelId:'model-a', measuredAt:1234, parallel:8, contextTokens:4096, batch:512, microBatch:256, flashAttention:'auto', cpuThreads:'auto' };
  for (const autoRecommendation of [
    { ...valid, modelId:'' }, { ...valid, measuredAt:NaN }, { ...valid, parallel:0 },
    { ...valid, contextTokens:0 }, { ...valid, batch:0 }, { ...valid, microBatch:1024, batch:512 },
    { ...valid, flashAttention:'maybe' }, { ...valid, cpuThreads:0 },
  ]) assert.throws(() => normalizeLocalConfig({ autoRecommendation }), /CONFIG_INVALID/);
  const nested = { ...valid, extra:{ parallel:1 } };
  const normalized = normalizeLocalConfig({ autoRecommendation:nested });
  assert.notEqual(normalized.autoRecommendation, nested);
  assert.deepEqual(normalized.autoRecommendation, valid);
  normalized.autoRecommendation.parallel = 16;
  assert.equal(nested.parallel, 8);
});

test('applyLocalRecommendation stores only capacity controls and preserves current generation settings', () => {
  const current = { mode:'custom', parallel:2, contextTokens:8192, batchPreset:'throughput', batch:512, microBatch:512,
    flashAttention:'off', cpuThreads:2, temperature:0.2, normalMaxTokens:222, superChatMaxTokens:333, manualMaxTokens:444, superChatReasoning:'on' };
  const before = structuredClone(current);
  const applied = applyLocalRecommendation(current, 'model-a', { mode:'custom', parallel:8, contextTokens:'auto', batchPreset:'balanced', batch:512, microBatch:512,
    flashAttention:'on', cpuThreads:4, temperature:0, normalMaxTokens:128, superChatMaxTokens:256, manualMaxTokens:512, superChatReasoning:'off', warmup:false, estimatedTokensPerRequest:256, measureGpu:false }, 9876);
  assert.equal(applied.mode, 'auto');
  assert.deepEqual(applied.autoRecommendation, { modelId:'model-a', measuredAt:9876, parallel:8, contextTokens:4096, batch:512, microBatch:256, flashAttention:'on', cpuThreads:4 });
  assert.deepEqual([applied.temperature,applied.normalMaxTokens,applied.superChatMaxTokens,applied.manualMaxTokens,applied.superChatReasoning],[0.2,222,333,444,'on']);
  assert.deepEqual(current,before);
  assert.deepEqual(Object.keys(applied.autoRecommendation).sort(),['batch','contextTokens','cpuThreads','flashAttention','measuredAt','microBatch','modelId','parallel']);
  const throughput = applyLocalRecommendation(current, 'model-a', normalizeLocalConfig({ mode:'custom',batchPreset:'throughput',microBatch:256 }));
  assert.equal(throughput.autoRecommendation.microBatch,512);
  assert.equal(applyLocalRecommendation(current,'model-a',normalizeLocalConfig({mode:'balanced'})).autoRecommendation.parallel,4);
  assert.equal(applyLocalRecommendation(current,'model-a',applied).autoRecommendation.parallel,8);
});
