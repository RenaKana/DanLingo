import test from 'node:test';
import assert from 'node:assert/strict';
import { localGenerationOptions } from '../../src/local/generation.ts';
import { resolveLocalConfig } from '../../src/local/config.ts';
import { localCompletionCollector } from '../../src/local/completion.ts';

test('native stream collection preserves truncation, text and timings through an empty usage trailer',()=>{
  const states=[], stream=localCompletionCollector(active=>states.push(active));
  stream.onData({choices:[{delta:{reasoning_content:'internal',content:'こん'}}]});
  stream.onData({choices:[{delta:{content:'にちは'},finish_reason:'length'}],timings:{prompt_ms:5,predicted_ms:7}});
  stream.onData({choices:[],usage:{completion_tokens:4}});
  const result=stream.result();
  assert.equal(result.choices[0].message.content,'こんにちは');
  assert.equal(result.choices[0].message.reasoning_content,'internal');
  assert.equal(result.choices[0].finish_reason,'length');
  assert.equal(result.usage.completion_tokens,4); assert.equal(result.timings.prompt_ms,5);
  assert.deepEqual(states,[true,true,false]);
});

test('native stream without a terminal event cannot become a successful translation',()=>{
  const stream=localCompletionCollector(); stream.onData({choices:[{delta:{content:'partial'}}]});
  assert.throws(()=>stream.result(),/LOCAL_INFERENCE_INCOMPLETE/);
});

test('native prompt reuse is opt-in and force requests always bypass it',()=>{
  const defaults=resolveLocalConfig(), optedIn=resolveLocalConfig({reusePromptCache:true});
  assert.equal(localGenerationOptions(defaults,{}).options.cache_prompt,false);
  assert.equal(localGenerationOptions(defaults,{cache_prompt:true}).options.cache_prompt,false);
  assert.equal(localGenerationOptions(optedIn,{}).options.cache_prompt,true);
  assert.equal(localGenerationOptions(optedIn,{cache_prompt:false}).options.cache_prompt,false);
});

test('worker generation defaults cap ordinary, SC and manual requests independently',()=>{
  const runtime=resolveLocalConfig();
  for(const [strategy,cap] of [['normal',128],['superchat',256],['manual',512],['unknown',128]]) {
    const generation=localGenerationOptions(runtime,{strategy,max_tokens:9999});
    assert.equal(generation.maxTokens,cap);assert.equal(generation.options.max_tokens,cap);
    assert.equal(generation.options.temperature,0.1);
  }
  assert.equal(localGenerationOptions(runtime,{max_tokens:42}).maxTokens,42);
});

test('explicit per-request thinking controls are isolated and SC auto omits template kwargs',()=>{
  for(const mode of ['on','off','auto']) {
    const runtime=resolveLocalConfig({superChatReasoning:mode}),before=structuredClone(runtime);
    const normal=localGenerationOptions(runtime,{strategy:'normal'});
    const sc=localGenerationOptions(runtime,{strategy:'superchat'});
    const manual=localGenerationOptions(runtime,{strategy:'manual'});
    assert.equal(normal.reasoning,false);assert.equal(normal.options.chat_template_kwargs.enable_thinking,false);
    assert.equal(manual.reasoning,false);assert.equal(manual.options.chat_template_kwargs.enable_thinking,false);
    if(mode==='auto') {assert.equal(sc.reasoning,'auto');assert.equal(Object.hasOwn(sc.options,'chat_template_kwargs'),false);}
    else {assert.equal(sc.reasoning,mode==='on');assert.equal(sc.options.chat_template_kwargs.enable_thinking,mode==='on');}
    normal.options.chat_template_kwargs.enable_thinking=true;
    assert.equal(localGenerationOptions(runtime,{strategy:'normal'}).options.chat_template_kwargs.enable_thinking,false);
    assert.deepEqual(runtime,before);
  }
});

test('configured output budgets are preserved beyond the old 1024 clamp and malformed requests cannot bypass them',()=>{
  const runtime=resolveLocalConfig({normalMaxTokens:8192,superChatMaxTokens:8192,manualMaxTokens:8192});
  for(const strategy of ['normal','superchat','manual']) {
    for(const max_tokens of [1e9,Infinity,NaN,'9000',undefined,-1])assert.equal(localGenerationOptions(runtime,{strategy,max_tokens}).maxTokens,8192);
    assert.equal(localGenerationOptions(runtime,{strategy,max_tokens:0}).maxTokens,1);
    assert.equal(localGenerationOptions(runtime,{strategy,max_tokens:12.9}).maxTokens,12);
  }
  assert.equal(localGenerationOptions({...runtime,normalMaxTokens:16384},{}).maxTokens,16384);
  assert.equal(localGenerationOptions(runtime,{cache_prompt:false}).options.cache_prompt,false);
});
