import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, strategySettings } from '../../src/core/config.ts';
import { TranslationEngine } from '../../src/translation/engine.ts';
import { MemoryTranslationCache, translationCacheKey } from '../../src/translation/cache.ts';

const flush = async () => { for (let i=0;i<60;i++) await Promise.resolve(); };
const settings = { ...DEFAULT_SETTINGS, enabled:true, profile:'deepseek', model:'deepseek-v4-pro', thinkingEffort:'off', endpoint:'https://provider.example/v1/chat/completions', batchSize:100, concurrency:4, liveMaxBatchWaitMs:0, liveAdaptiveConcurrency:false };
test('manual root operation has its own cache identity; equivalent auto URL spellings share identity',()=>{
  const key = value => translationCacheKey('room', '同じ文', { ...settings, ...value });
  assert.equal(key({endpoint:'https://provider.example'}), key({endpoint:'https://provider.example/v1/'}));
  assert.notEqual(key({endpoint:'https://provider.example', endpointMode:'completion'}), key({endpoint:'https://provider.example'}));
  assert.notEqual(key({endpoint:'https://provider.example', connectionOverride:{endpointMode:'completion'}}), key({endpoint:'https://provider.example'}));
});
function harness(t) {
  const calls=[]; let wall=0;
  const cache = new MemoryTranslationCache({now:()=>wall});
  const engine = new TranslationEngine({cache, fetch:(_url,init)=>new Promise((resolve,reject)=>{
    const body=JSON.parse(init.body), rows=body.messages[1].content.split('\n').map(line=>JSON.parse(line));
    const call={body,rows,init, reply:(prefix='译文:')=>resolve(Response.json({choices:[{message:{content:rows.map(([id,text])=>JSON.stringify([id,prefix+text])).join('\n')}}]}))};
    init.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}); calls.push(call);
  })});
  t.after(()=>engine.dispose());
  const request=(items,extra={})=>engine.translate({resourceId:'youtube:live:room',settings,apiKey:'fixture-only',mode:'deadline',items:items.map((id)=>({id,text:'本当に危なかった！',deadlineAt:performance.now()+3000})),...extra});
  return {engine,calls,request,expire:()=>{wall+=31*86400000;}};
}
test('100 occurrences from two entries share queued/inflight work and preserve 100 outputs; warm cache emits zero requests',async t=>{
  const h=harness(t), a=h.request(Array.from({length:50},(_,i)=>'a'+i)),b=h.request(Array.from({length:50},(_,i)=>'b'+i));
  await flush();assert.equal(h.calls.length,1);assert.equal(h.calls[0].rows.length,1);assert.equal(h.engine.stats().uniqueTasks,1);assert.equal(h.engine.stats().mergedInputs,99);
  h.calls[0].reply();const items=[...(await a).items,...(await b).items];assert.equal(items.length,100);assert.equal(new Set(items.map(x=>x.id)).size,100);assert.ok(items.every(x=>x.status==='translated'));
  await flush();assert.equal((await h.request(['cache'])).items[0].status,'cached');assert.equal(h.calls.length,1);
});
test('cache expiration, context, model and reasoning changes cause independent transport calls',async t=>{
  const h=harness(t);let pending=h.request(['one']);await flush();h.calls.at(-1).reply();await pending;await flush();h.expire();
  for(const extra of [{},{resourceId:'other-room'},{settings:{...settings,model:'deepseek-v4-flash'}},{settings:{...settings,thinkingEffort:'high'}}]) {
    const before=h.calls.length;pending=h.request(['new'],extra);await flush();assert.equal(h.calls.length,before+1);h.calls.at(-1).reply();await pending;await flush();
  }
});
test('one cancelled subscriber leaves shared work alive; matching source output is a valid cached translation',async t=>{
  const h=harness(t), controller=new AbortController();const a=h.request(['a'],{signal:controller.signal}),b=h.request(['b']);await flush();controller.abort();
  assert.equal(h.calls[0].init.signal.aborted,false);h.calls[0].reply('');assert.equal((await a).items[0].reason,'cancelled');assert.equal((await b).items[0].status,'translated');await flush();assert.equal((await h.request(['c'])).items[0].status,'cached');
});
test('forced repeat clicks coalesce and an older response cannot overwrite the force result',async t=>{
  const h=harness(t), old=h.request(['old']);await flush();const force=h.request(['force'],{force:true}),again=h.request(['again'],{force:true});await flush();assert.equal(h.calls.length,2);
  h.calls[1].reply('新:');await force;await again;h.calls[0].reply('旧:');await old;await flush();assert.match((await h.request(['cached'])).items[0].text,/^新:/);
});
test('normal and SC send different effective reasoning without exceeding shared capacity',async t=>{
  const h=harness(t), scSettings=strategySettings({...settings,concurrency:2,superChatThinkingEffort:'high',superChatTimeoutMs:15000},'superchat');
  const sc=h.request([],{settings:scSettings,items:[{id:'sc',text:'大切な応援メッセージです',strategy:'superchat',deadlineAt:performance.now()+15000}]});await flush();
  const normal=h.request(['normal'],{settings:{...settings,concurrency:2}});await flush();assert.equal(h.calls.length,2);assert.equal(h.engine.stats().activeRequests,2);assert.deepEqual(h.calls[0].body.thinking,{type:'enabled'});assert.deepEqual(h.calls[1].body.thinking,{type:'disabled'});
  h.calls[1].reply();assert.equal((await normal).items[0].status,'translated');assert.equal(h.calls[0].init.signal.aborted,false);h.calls[0].reply();await sc;
});
test('a slow earlier disk write cannot overwrite a newer force result',async t=>{
  let releaseOld, disk;
  const writes=[];
  const cache={get:async()=>disk,set:async(_key,text)=>{writes.push(text);if(writes.length===1) await new Promise(resolve=>releaseOld=resolve);disk=text;}};
  let n=0;const engine=new TranslationEngine({cache,provider:{complete:async request=>({items:new Map(request.items.map(item=>[item.id,{text:++n===1?'旧译文':'新译文'}]))})}});t.after(()=>engine.dispose());
  const request=force=>engine.translate({resourceId:'room',apiKey:'fixture',settings,mode:'deadline',force,items:[{id:crypto.randomUUID(),text:'遅いディスク書き込み',deadlineAt:performance.now()+3000}]});
  await request(false);await flush();await request(true);await flush();assert.deepEqual(writes,['旧译文']);releaseOld();await flush();assert.deepEqual(writes,['旧译文','新译文']);assert.equal(disk,'新译文');assert.equal((await request(false)).items[0].text,'新译文');
});
