import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../../src/core/config.ts';
import { ChatCompletionsProvider } from '../../src/translation/provider.ts';

const items=[{id:'original-7',text:'原文'}];
const models={minimax:'MiniMax-M3',deepseek:'deepseek-v4-pro',gemini:'gemini-2.5-pro','chat-completions':'unknown-model'};
const request=(profile,thinkingEffort)=>({
  settings:{...DEFAULT_SETTINGS,model:models[profile],profile,thinkingEffort},apiKey:'test-only-key',items,budgetMs:1000,
});
const response=()=>Response.json({choices:[{message:{content:JSON.stringify({items:[{id:'original-7',text:'译文'}]})}}]});

test('thinking profiles emit only their documented wire fields',async t=>{
  const cases=[
    ['minimax',undefined,{thinking:{type:'disabled'}}],
    ['minimax','default',{}],['minimax','off',{thinking:{type:'disabled'}}],
    ['deepseek',undefined,{thinking:{type:'disabled'}}],
    ['deepseek','default',{}],['deepseek','off',{thinking:{type:'disabled'}}],
    ['deepseek','high',{thinking:{type:'enabled'},reasoning_effort:'high'}],
    ['deepseek','max',{thinking:{type:'enabled'},reasoning_effort:'max'}],
    ['gemini',undefined,{reasoning_effort:'low'}],['gemini','default',{}],
    ['gemini','low',{reasoning_effort:'low'}],['gemini','medium',{reasoning_effort:'medium'}],['gemini','high',{reasoning_effort:'high'}],
    ['chat-completions',undefined,{}],['chat-completions','default',{}],
  ];
  for(const [profile,effort,expected] of cases) await t.test(`${profile} ${effort ?? 'legacy'}`,async()=>{
    let calls=0;
    const provider=new ChatCompletionsProvider({fetch:async(url,init)=>{
      calls++;
      assert.equal(url,DEFAULT_SETTINGS.endpoint);
      assert.equal(init.method,'POST');
      assert.equal(init.headers.Authorization,'Bearer test-only-key');
      assert.equal(init.redirect,'error');
      assert.equal(init.credentials,'omit');
      const body=JSON.parse(init.body);
      const {model,stream,messages,...extra}=body;
      assert.equal(model,models[profile]);
      assert.equal(stream,false);
      assert.deepEqual(extra,expected);
      assert.equal(messages[0].role,'system');
      assert.equal(messages[1].role,'user');
      assert.deepEqual(JSON.parse(messages[1].content),{sourceLanguage:'auto',targetLanguage:'zh-Hans',items});
      return response();
    }});
    const result=await provider.complete(request(profile,effort));
    assert.deepEqual(result.items.get('original-7'),{text:'译文'});
    assert.equal(calls,1);
  });
});

test('unsupported explicit choices fail before transport instead of dropping requested thinking',async()=>{
  let calls=0;
  const provider=new ChatCompletionsProvider({fetch:async()=>{calls++;return response();}});
  for(const [profile,effort] of [['minimax','low'],['deepseek','low'],['deepseek','medium'],['gemini','off'],['gemini','max'],['gemini','minimal'],['chat-completions','high'],['chat-completions','off'],['deepseek',null]]) {
    await assert.rejects(provider.complete(request(profile,effort)),{name:'ProviderError',message:'unsupported-thinking-effort',retryable:false});
  }
  assert.equal(calls,0);
});

test('provider rejection is surfaced without an automatic fallback request',async()=>{
  let calls=0;
  const provider=new ChatCompletionsProvider({fetch:async()=>{calls++;return new Response('model does not support requested effort',{status:400});}});
  await assert.rejects(provider.complete(request('deepseek','max')),{name:'ProviderError',message:'http-400',retryable:false});
  assert.equal(calls,1);
});
