import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelTestError, testModel } from '../../src/translation/model-test.ts';
import { onlineSettings } from '../fixtures/online-settings.mjs';

const request={settings:onlineSettings({profile:'deepseek',thinkingEffort:'high',model:'deepseek-v4-pro',endpoint:'https://provider.example/v1/chat/completions',sourceLanguage:'ja'}),apiKey:'test-only-key'};
const answer=items=>Response.json({choices:[{message:{content:JSON.stringify({items})}}]});
test('model test makes one production-shaped request with selected model, thinking and language',async()=>{
  let calls=0;
  const result=await testModel(request,{fetch:async(url,init)=>{
    calls++;
    assert.equal(url,request.settings.endpoint);
    assert.equal(init.method,'POST');assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');
    assert.equal(init.headers.Authorization,'Bearer test-only-key');
    const body=JSON.parse(init.body),data=JSON.parse(body.messages[1].content);
    assert.equal(body.model,'deepseek-v4-pro');assert.equal(body.reasoning_effort,'high');assert.deepEqual(body.thinking,{type:'enabled'});
    assert.equal(data.sourceLanguage,'ja');assert.equal(data.targetLanguage,'zh-Hans');assert.equal(data.items.length,1);
    assert.equal(data.items[0].text,'この動画はとても面白いです。');
    return answer([{id:data.items[0].id,text:'这个视频非常有趣。'}]);
  }});
  assert.equal(calls,1);assert.equal(result.text,'这个视频非常有趣。');assert.equal(result.model,'deepseek-v4-pro');assert.ok(result.elapsedMs>=0);
});
test('built-in samples follow the selected source; automatic detection uses Japanese',async()=>{
  for(const [sourceLanguage,sourceText] of [['auto','この動画はとても面白いです。'],['en','This video is very interesting.'],['ko','이 영상은 정말 재미있어요.']]) {
    const result=await testModel({...request,settings:{...request.settings,sourceLanguage}},{fetch:async(_url,init)=>{
      const data=JSON.parse(JSON.parse(init.body).messages[1].content);
      assert.equal(data.sourceLanguage,sourceLanguage);assert.equal(data.items[0].text,sourceText);
      return answer([{id:data.items[0].id,text:'测试译文'}]);
    }});
    assert.equal(result.sourceText,sourceText);
  }
});
test('custom then cleared model tests send the same sample as an untouched or visibly populated field', async () => {
  const observed = [];
  for (const text of [undefined, '今日は楽しい配信です。', '', '  \n ', 'この動画はとても面白いです。']) {
    const result = await testModel({ ...request, text }, { fetch: async (_url, init) => {
      const data = JSON.parse(JSON.parse(init.body).messages[1].content);
      observed.push(data.items[0].text);
      return answer([{ id: data.items[0].id, text: '今天的视频很有趣。' }]);
    } });
    assert.equal(result.sourceText, observed.at(-1));
  }
  assert.deepEqual(observed, ['この動画はとても面白いです。', '今日は楽しい配信です。',
    'この動画はとても面白いです。', 'この動画はとても面白いです。', 'この動画はとても面白いです。']);
});
test('HTTP 200 is not sufficient: invalid format, IDs, duplicates and blank translations fail',async()=>{
  for(const response of [()=>Response.json({choices:[{message:{content:'hello'}}]}),()=>answer([]),()=>answer([{id:'other',text:'译文'}]),()=>answer([{id:'model-test',text:''}]),()=>answer([{id:'model-test',text:'译文'},{id:'model-test',text:'重复'}])]) {
    await assert.rejects(testModel(request,{fetch:async()=>response()}),{message:'invalid-response'});
  }
});
test('provider rejection and network failures are fixed codes and never retry or expose the body',async()=>{
  for(const status of [400,401,403,404,422,429,500]) {
    let calls=0;
    await assert.rejects(testModel(request,{fetch:async()=>{calls++;return new Response('secret body',{status});}}),{message:`http-${status}`});
    assert.equal(calls,1);
  }
  await assert.rejects(testModel(request,{fetch:async()=>{throw new Error('private transport details');}}),{message:'network-error'});
});
test('model test uses the full selected thinking timeout and releases its lifetime guard',async()=>{
  let timeout,now=0,released=0;
  const callbacks=new Map();
  const pending=testModel(request,{
    fetch:async()=>new Promise(()=>{}),keepAlive:()=>()=>released++,
    clock:{now:()=>now,setTimeout:(fn,ms)=>{timeout=ms;callbacks.set(1,fn);return 1;},clearTimeout:id=>callbacks.delete(id)},
  });
  assert.equal(timeout,120000);
  now=120000;callbacks.get(1)();
  await assert.rejects(pending,{message:'timeout'});assert.equal(released,1);assert.equal(callbacks.size,0);
});
test('aborting a test terminates its request without retrying',async()=>{
  const controller=new AbortController();let released=0,calls=0;
  const pending=testModel({...request,signal:controller.signal},{fetch:async()=>{calls++;return new Promise(()=>{});},keepAlive:()=>()=>released++});
  controller.abort();await assert.rejects(pending,{message:'cancelled'});assert.equal(calls,1);assert.equal(released,1);
});

test('failed local tests retain exact assistant output and validation reason without accepting it', async () => {
  const sourceText = '666这个入是挂';
  const settings = { ...request.settings, backend: 'local', sourceLanguage: 'auto', targetLanguage: 'ja',
    localModelName: 'Index-Translate-2B.Q8_0', localPerformance: { promptMode: 'auto' } };
  for (const [text, finish, code] of [
    [sourceText, 'stop', 'untranslated-text'], ['This user is cheating', 'stop', 'wrong-target-language'],
    ['666このユーザーは', 'length', 'output-truncated'], ['', 'stop', 'invalid-response'],
    ['<img src=x onerror=alert(1)>', 'stop', 'wrong-target-language'],
  ]) {
    await assert.rejects(testModel({ settings, apiKey: 'local-inference', text: sourceText }, {
      fetch: async () => Response.json({ choices: [{ message: { content: text }, finish_reason: finish }] }),
    }), error => {
      assert.ok(error instanceof ModelTestError); assert.equal(error.code, code);
      assert.equal(error.result.passed, false); assert.equal(error.result.text, text);
      assert.equal(error.result.rawText, text); assert.equal(error.result.sourceText, sourceText);
      assert.equal(error.result.promptMode, 'index-translate'); assert.equal(error.result.model, settings.localModelName);
      assert.equal(error.result.targetLanguage, 'ja'); assert.ok(error.result.elapsedMs >= 0);
      return true;
    });
  }
});

test('malformed protocol output is displayed but HTTP error bodies and transport details stay private', async () => {
  for (const [fetch, code, text] of [
    [async () => Response.json({ choices: [{ message: { content: 'plain response without the requested JSON' } }] }), 'invalid-response', 'plain response without the requested JSON'],
    [async () => new Response('private gateway body', { status: 401 }), 'http-401', ''],
    [async () => { throw new Error('private transport detail'); }, 'network-error', ''],
  ]) {
    await assert.rejects(testModel(request, { fetch }), error => {
      assert.ok(error instanceof ModelTestError); assert.equal(error.code, code);
      assert.equal(error.result.text, text); assert.equal(error.result.passed, false);
      assert.doesNotMatch(JSON.stringify(error.result), /private gateway|private transport/);
      return true;
    });
  }
});

test('partial streamed assistant text survives an interrupted test', async () => {
  const content = '[0,"まだ途中';
  const response = new Response('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
  await assert.rejects(testModel({ ...request, mode: 'deadline', settings: { ...request.settings, translationStream: true } }, {
    fetch: async () => response,
  }), error => {
    assert.ok(error instanceof ModelTestError); assert.equal(error.result.text, content);
    assert.equal(error.result.passed, false); return true;
  });
});
