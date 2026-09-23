import test from 'node:test';
import assert from 'node:assert/strict';
import { YoutubeNativeQueue } from '../../src/platforms/youtube/native-queue.ts';

const action = (id, text='これは新しいコメントです', author='author')=>({item:{liveChatTextMessageRenderer:{id,authorExternalChannelId:author,message:{runs:[{text}]},authorName:{simpleText:'name'}}}});
function harness(extra={}) {
  let now=0,seq=0,current=true,active=true;
  const timers=new Map(),submitted=[],sources=[],decisions=[],removed=[];
  const queue=new YoutubeNativeQueue({now:()=>now,setTimeout(fn,ms){timers.set(++seq,{at:now+ms,fn});return seq;},clearTimeout(id){timers.delete(id);},
    current:()=>current,active:()=>active,submit:a=>{submitted.push(a);return true;},source:e=>sources.push(e),decision:e=>decisions.push(e),removed:(ids,reason)=>removed.push({ids,reason}),eligible:text=>text!=='original',...extra});
  return {queue,submitted,sources,decisions,removed,timers,
    current(value){current=value;},active(value){active=value;},now:()=>now,
    prepare(id,text='译文',cached=false){const source=sources.find(s=>s.sourceId===id);queue.prepare(id,source.originalText,text,cached);},
    advance(ms){const end=now+ms;let steps=0;for(;;){const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end)break;assert.ok(++steps<1000);now=next[1].at;timers.delete(next[0]);next[1].fn();}now=end;},
  };
}
for(const ms of [500,1000,2000,3000,7500,60000])test(`native original timeout ${ms}ms is independent of extension callbacks`,()=>{
  const h=harness(),a=action('a');h.queue.add(a,ms);h.advance(ms-1);assert.equal(h.submitted.length,0);h.advance(1);
  assert.deepEqual(h.submitted,[a]);assert.equal(h.decisions[0].reason,'timeout');h.prepare('a','迟到');h.advance(ms);assert.equal(h.submitted.length,1);
});
test('ready tail stays behind slow head; original deadline releases head and then ready tail',()=>{
  const h=harness();h.queue.add(action('a'),2000);h.advance(100);h.queue.add(action('b'),2000);h.advance(100);h.prepare('b','第二条');
  assert.equal(h.submitted.length,0);h.advance(1800);assert.deepEqual(h.decisions.map(e=>[e.sourceId,e.translated,e.releasedAt]),[['a',false,2000],['b',true,2000]]);
});
test('both prepared messages release as soon as the head is ready, maintaining order and source metadata',()=>{
  const h=harness(),a=action('a'),before=structuredClone(a);h.queue.add(a,2000);h.queue.add(action('b'),2000);h.advance(90);h.prepare('b');h.advance(10);h.prepare('a','第一条',true);
  assert.deepEqual(h.decisions.map(e=>[e.sourceId,e.releasedAt]),[['a',100],['b',100]]);assert.equal(h.decisions[0].cached,true);
  assert.deepEqual(a,before);assert.deepEqual(h.submitted[0].item.liveChatTextMessageRenderer.authorName,a.item.liveChatTextMessageRenderer.authorName);
});
test('same text distinct events are independently presented; duplicate pending input is consumed once',()=>{
  const h=harness();h.queue.add(action('a'),500);h.queue.add(action('a'),500);h.queue.add(action('b'),500);h.prepare('a');h.prepare('b');assert.equal(h.sources.length,2);assert.equal(h.submitted.length,2);
});
test('pending deletion unblocks ready tail and prevents late resurrection',()=>{
  const h=harness();h.queue.add(action('a'),500);h.queue.add(action('b'),500);h.prepare('b');h.queue.remove(['a']);h.prepare('a');h.advance(500);
  assert.deepEqual(h.decisions.map(e=>e.sourceId),['b']);assert.deepEqual(h.removed,[{ids:['a'],reason:'removed'}]);
});
test('author removal only applies to entries present at that point',()=>{
  const h=harness();h.queue.add(action('old'),500);h.queue.removeAuthor('author');h.queue.add(action('new'),500);h.prepare('new');assert.deepEqual(h.decisions.map(e=>e.sourceId),['new']);
});
test('hidden deadline flushes original even when a tail already has translation',()=>{
  const h=harness();h.queue.add(action('a'),500);h.queue.add(action('b'),500);h.prepare('b');h.active(false);h.advance(500);
  assert.deepEqual(h.decisions.map(e=>[e.translated,e.reason]),[[false,'handoff'],[false,'handoff']]);
});
test('closure hands pending messages to the native owner and does not touch already shown translations',()=>{
  const h=harness();h.queue.add(action('shown'),500);h.prepare('shown');h.queue.add(action('pending'),500);h.queue.flush('handoff');h.advance(500);
  assert.deepEqual(h.decisions.map(e=>[e.sourceId,e.translated]),[['shown',true],['pending',false]]);assert.equal(h.timers.size,0);
});
test('old frame or room abandons pending actions without submitting to another owner',()=>{
  const h=harness();h.queue.add(action('old'),500);h.current(false);h.advance(500);assert.equal(h.submitted.length,0);assert.deepEqual(h.removed,[{ids:['old'],reason:'abandoned'}]);
});
test('capacity flush preserves native originals in order instead of losing chat',()=>{
  const h=harness({maxItems:2});h.queue.add(action('a'),500);h.queue.add(action('b'),500);h.prepare('b');h.queue.add(action('c'),500);h.advance(500);
  assert.deepEqual(h.decisions.map(e=>[e.sourceId,e.reason,e.translated]),[['a','overload',false],['b','overload',false],['c','timeout',false]]);
});
test('baseline and special cards stay with the site',()=>{
  const h=harness();h.queue.seed(['old']);assert.equal(h.queue.add(action('old'),500),false);
  assert.equal(h.queue.add({item:{liveChatPaidMessageRenderer:{id:'paid'}}},500),false);
  assert.equal(h.sources.length,0);
});

test('client correlation fields do not exclude an incoming native chat action',()=>{
  const h=harness(),incoming={...action('a'),clientId:'native-correlation',clientMessageId:'correlation'};
  assert.equal(h.queue.add(incoming,500),true);h.prepare('a');
  assert.equal(h.submitted.length,1);assert.equal(h.submitted[0].clientId,incoming.clientId);assert.equal(h.submitted[0].clientMessageId,incoming.clientMessageId);
  assert.equal(h.queue.add(incoming,500),false); // Once released, leave native duplicate semantics intact.
});
test('native source mutations after interception do not change pending originals',()=>{
  const h=harness(),a=action('a');h.queue.add(a,500);a.item.liveChatTextMessageRenderer.message.runs[0].text='changed';h.advance(500);assert.equal(h.submitted[0].item.liveChatTextMessageRenderer.message.runs[0].text,'これは新しいコメントです');
});
test('partial native failure is never retried or reported as successful submission',()=>{
  const h=harness({submit:()=>false});h.queue.add(action('a'),500);h.advance(500);assert.equal(h.decisions.length,0);assert.deepEqual(h.removed,[{ids:['a'],reason:'abandoned'}]);assert.equal(h.queue.size,0);
});
test('an invalid or stale translated payload leaves native deadline protection intact',()=>{
  const h=harness();const a=action('a');a.item.liveChatTextMessageRenderer.message.runs.push({emoji:{emojiId:'custom'}});h.queue.add(a,500);h.prepare('a','丢了表情');h.advance(500);assert.deepEqual(h.submitted,[a]);
});

test('intake work consumes the original budget and accepted prepare reports accurately',()=>{
  const h=harness(); const a=action('a');
  Object.defineProperty(a.item.liveChatTextMessageRenderer,'message',{get(){h.advance(100);return {simpleText:'これは新しいコメントです'};},enumerable:true});
  h.queue.add(a,500);
  assert.equal(h.sources[0].receivedAt,0);
  h.advance(500-h.now());
  assert.equal(h.decisions[0].releasedAt,500);
  assert.equal(h.queue.prepare('a',h.sources[0].originalText,'遅い訳',false),false);
});

test('a native moderation command can complete before the following ready message is released',()=>{
  const h=harness(); h.queue.add(action('a'),500); h.queue.add(action('b'),500);
  assert.equal(h.queue.prepare('b',h.sources[1].originalText,'第二条',false),true);
  assert.equal(h.queue.prepare('b',h.sources[1].originalText,'重复',false),false);
  h.queue.remove(['a'],false); assert.equal(h.submitted.length,0);
  h.queue.pump(); assert.deepEqual(h.decisions.map(e=>e.sourceId),['b']);
});

test('main thread delay beyond the tail deadline discards an already prepared translation',()=>{
  let now=0; const h=harness({now:()=>now});
  h.queue.add(action('a'),500); h.queue.add(action('b'),500);
  now=50; h.prepare('b','已准备'); now=700; h.queue.pump();
  assert.deepEqual(h.decisions.map(e=>[e.translated,e.reason]),[[false,'timeout'],[false,'timeout']]);
});

test('timeout retry holds once, rejects the first-round late result, and accepts the second result before its deadline',()=>{
  const retries=[];
  const h=harness({
    retryPolicy:()=>({timeoutMs:1000,hold:true}),
    retry:(source,deadline)=>{ retries.push({source,deadline}); return true; },
  });
  const a=action('retry-hold'); h.queue.add(a,500); h.advance(500);
  assert.deepEqual(retries.map(({source,deadline})=>[source.sourceId,deadline]),[['retry-hold',1500]]);
  assert.equal(h.submitted.length,0);
  assert.equal(h.queue.prepare('retry-hold',h.sources[0].originalText,'首轮迟到',false),false);
  assert.equal(h.queue.retryResult('retry-hold',h.sources[0].originalText,'二轮译文',false),true);
  assert.equal(h.submitted.length,1);
  assert.equal(h.submitted[0].item.liveChatTextMessageRenderer.message.runs[0].text,'二轮译文');
  assert.deepEqual(h.decisions.map(({sourceId,translated,reason})=>[sourceId,translated,reason]),[['retry-hold',true,'ready']]);
  h.advance(1000); assert.equal(h.submitted.length,1); assert.equal(retries.length,1);
});

test('timeout retry release mode presents the original once and rejects a later native result',()=>{
  const retries=[];
  const h=harness({
    retryPolicy:()=>({timeoutMs:1000,hold:false}),
    retry:source=>{ retries.push(source.sourceId); return true; },
  });
  h.queue.add(action('retry-release'),500); h.advance(500);
  assert.deepEqual(retries,['retry-release']); assert.equal(h.submitted.length,1);
  assert.equal(h.decisions[0].translated,false); assert.equal(h.decisions[0].reason,'timeout');
  assert.equal(h.queue.retryResult('retry-release',h.sources[0].originalText,'迟到译文',false),false);
  h.advance(1000); assert.equal(h.submitted.length,1);
});

test('non-translatable native messages do not start an automatic timeout retry',()=>{
  const retries=[];
  const h=harness({
    eligible:()=>false,
    retryPolicy:()=>({timeoutMs:1000,hold:true}),
    retry:source=>{ retries.push(source.sourceId); return true; },
  });
  h.queue.add(action('no-retry'),500);
  assert.equal(h.submitted.length,1); assert.equal(h.decisions[0].translated,false);
  assert.deepEqual(retries,[]); assert.equal(h.queue.retryResult('no-retry',h.sources[0].originalText,'不应出现',false),false);
});

test('handoff cancels a held retry and rejects its late result',()=>{
  const retries=[], cancelled=[];
  const h=harness({
    retryPolicy:()=>({timeoutMs:1000,hold:true}),
    retry:(source,deadline)=>{ retries.push({source,deadline}); return true; },
    cancelRetry:id=>cancelled.push(id),
  });
  h.queue.add(action('retry-stale'),500); h.advance(500); assert.equal(retries.length,1);
  h.current(false); h.queue.pump();
  assert.deepEqual(cancelled,['retry-stale']); assert.deepEqual(h.removed,[{ids:['retry-stale'],reason:'abandoned'}]);
  assert.equal(h.queue.retryResult('retry-stale',h.sources[0].originalText,'迟到译文',false),false);
  assert.equal(h.submitted.length,0);
});
