import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoScheduler } from '../../src/core/scheduler.ts';
import { TranslationEngine } from '../../src/translation/engine.ts';
import { MemoryTranslationCache, translationCacheKey } from '../../src/translation/cache.ts';
import { onlineSettings } from '../fixtures/online-settings.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, label) {
  for (let n=0; n<200; n++) { if (predicate()) return; await flush(); }
  assert.fail(`timed out waiting for ${label}`);
}
const source = n => ({id:`e${n}`,sourceId:`e${n}`,resourceId:'sm9',threadId:'1',fork:'main',platform:'niconico',
  originalText:`テスト文番号${n}です`,mediaTimeMs:n*1000,renderAtMs:n*1000-2000,translatable:true,style:{commands:[]}});
const clock = mediaTimeMs => ({mediaTimeMs,playbackRate:1,paused:true,seeking:false,contentActive:true,durationMs:600000,buffered:[]});
function setup(t, {settings,provider,cache}) {
  const engine=new TranslationEngine({provider,cache});
  const prepared=[], envelopes=[];
  const scheduler=new VideoScheduler({settings,now:()=>0,reset:()=>{},prepared:items=>prepared.push(...items),
    request:(resourceId,items,signal,priority,onResult)=>{
      envelopes.push(items);
      return engine.translate({resourceId,items:items.map(i=>({id:i.id,text:i.text,deadlineAt:performance.now()+i.remainingMs})),
        settings,apiKey:'fixture-only',signal,priority,mode:'vod',onResult}).then(response=>response.items);
    }});
  t.after(()=>{scheduler.dispose();engine.dispose();});
  return {engine,scheduler,prepared,envelopes};
}

test('99 cached items prepare while the one uncached provider item is still pending', async t => {
  const settings=onlineSettings({enabled:true,translationScope:'all',batchSize:100,videoBatchSize:100,concurrency:2});
  const cache=new MemoryTranslationCache();
  for (let n=0;n<99;n++) await cache.set(translationCacheKey('sm9',source(n).originalText,settings),`缓存译文${n}`,{resourceId:'sm9'});
  const calls=[];
  const {scheduler,prepared}=setup(t,{settings,cache,provider:{complete:request=>new Promise(resolve=>calls.push({request,resolve}))}});
  scheduler.snapshot('sm9','session',clock(0),Array.from({length:100},(_,n)=>({...source(n),mediaTimeMs:2000,renderAtMs:0})));
  await until(()=>prepared.length===99 && calls.length===1,'99 cache hits and one provider request');
  assert.equal(scheduler.getStats().cacheHits,99);
  assert.equal(scheduler.getStats().inflight,1);
  assert.equal(calls[0].request.items.length,1);
  calls[0].resolve({items:new Map([[calls[0].request.items[0].id,{text:'最后一条译文'}]])});
  await until(()=>prepared.length===100,'last provider result');
  assert.equal(scheduler.getStats().translated,100);
  assert.equal(new Set(prepared.map(item=>item.id)).size,100);
});

test('99 non-streaming successes remain ready while the last missing item retries', async t => {
  const settings=onlineSettings({enabled:true,translationScope:'all',batchSize:100,videoBatchSize:100,concurrency:2});
  const calls=[];
  const {scheduler,prepared}=setup(t,{settings,provider:{complete:request=>new Promise(resolve=>calls.push({request,resolve}))}});
  scheduler.snapshot('sm9','session',clock(0),Array.from({length:100},(_,n)=>({...source(n),mediaTimeMs:2000,renderAtMs:0})));
  await until(()=>calls.length===1,'first provider attempt');
  const first=calls[0];
  assert.equal(first.request.items.length,100);
  assert.equal(prepared.length,0,'a non-streaming provider has not completed its first response');
  first.resolve({items:new Map([
    ...first.request.items.slice(0,99).map(item=>[item.id,{text:`译文:${item.text}` }]),
    [first.request.items[99].id,{reason:'missing-id'}],
  ])});
  await until(()=>calls.length===2,'one retry');
  assert.equal(calls[1].request.items.length,1);
  assert.equal(prepared.length,99,'completed siblings are prepared before the retry finishes');
  assert.equal(scheduler.getStats().translated,99);
  calls[1].resolve({items:new Map([[calls[1].request.items[0].id,{text:'补齐译文'}]])});
  await until(()=>prepared.length===100,'retry completion');
  assert.equal(new Set(prepared.map(item=>item.id)).size,100);
});

test('local single-item provider delivers progress before the 100th item', async t => {
  const settings=onlineSettings({enabled:true,backend:'local',endpoint:'',model:'',localModelId:'fixture-model',
    localPerformance:{promptMode:'hy-mt',languageValidation:'off'},translationScope:'all',batchSize:100,concurrency:2,localCapacity:2});
  const calls=[];
  const {scheduler,prepared}=setup(t,{settings,provider:{complete:request=>new Promise(resolve=>calls.push({request,resolve}))}});
  scheduler.snapshot('sm9','session',clock(0),Array.from({length:100},(_,n)=>source(n)));
  await until(()=>calls.length>0,'first local item');
  assert.ok(calls.every(call=>call.request.items.length===1));
  const first=calls[0];
  first.resolve({items:new Map([[first.request.items[0].id,{text:'第一条译文'}]])});
  await until(()=>prepared.length===1,'local early result');
  assert.equal(scheduler.getStats().translated,1);
  assert.ok(prepared.length<100);
});

test('same pool and playback trajectory, measured after preparation settles', async t => {
  async function run(scope) {
    const settings=onlineSettings({enabled:true,translationScope:scope,prefetchSeconds:60,
      batchSize:20,videoBatchSize:20,concurrency:2});
    const pool=Array.from({length:240},(_,n)=>source(n));
    const cache=new MemoryTranslationCache();
    for (const n of [0,40,120,160,230]) await cache.set(
      translationCacheKey('sm9',pool[n].originalText,settings),`缓存译文${n}`,{resourceId:'sm9'});
    const provider={complete:async request=>({items:new Map(request.items.map(item=>[item.id,{text:`译文:${item.text}`}]))})};
    const {scheduler,envelopes,engine,prepared}=setup(t,{settings,provider,cache});
    const checkpoints=[];
    const capture=position=>{
      // Only sampled playback positions count; skipped footage between them was not viewed.
      const due=pool.filter(item=>item.renderAtMs>=position-2000 && item.renderAtMs<=position+5000);
      const ready=new Set(prepared.map(item=>item.id));
      checkpoints.push({position,due:due.length,available:due.filter(item=>ready.has(item.id)).length,
        cacheHits:engine.stats().cacheHits});
    };
    scheduler.snapshot('sm9','session',clock(0),pool);
    await until(()=>scheduler.getStats().queued===0 && scheduler.getStats().inflight===0,`${scope} first window`);
    capture(0);
    scheduler.snapshot('sm9','session',clock(120000));
    await until(()=>scheduler.getStats().queued===0 && scheduler.getStats().inflight===0,`${scope} second window`);
    capture(120000);
    return {requestCount:envelopes.length,inputCount:envelopes.reduce((sum,batch)=>sum+batch.length,0),
      providerCalls:engine.stats().providerCalls,cacheHits:engine.stats().cacheHits,checkpoints};
  }
  const all=await run('all'), auto=await run('auto');
  t.diagnostic(`240-message offline fixture, positions 0s then 120s: all=${JSON.stringify(all)}, auto=${JSON.stringify(auto)}`);
  assert.deepEqual(auto.checkpoints.map(({position,due,available})=>({position,due,available})),
    all.checkpoints.map(({position,due,available})=>({position,due,available})));
  assert.ok(auto.checkpoints.every(({due,available})=>available===due),JSON.stringify(auto.checkpoints));
  assert.ok(all.checkpoints.every(({due,available})=>available===due),JSON.stringify(all.checkpoints));
  assert.ok(auto.checkpoints[0].cacheHits>=1 && auto.checkpoints[1].cacheHits>=2);
  assert.ok(all.cacheHits>=auto.cacheHits);
  assert.ok(auto.inputCount<all.inputCount,JSON.stringify({all,auto}));
  assert.ok(auto.requestCount<all.requestCount,JSON.stringify({all,auto}));
  assert.ok(auto.providerCalls<=all.providerCalls,JSON.stringify({all,auto}));
});

test('fixed playback samples native display time before delayed provider work settles', async t => {
  class SimClock {
    time=0; sequence=0; timers=new Map();
    now() { return this.time; }
    wallNow() { return Date.UTC(2026,8,25)+this.time; }
    setTimeout(callback,delay) {
      const id=++this.sequence;
      this.timers.set(id,{at:this.time+Math.max(0,delay),callback});
      return id;
    }
    clearTimeout(id) { this.timers.delete(id); }
    async advanceTo(target) {
      for (let n=0;n<2000;n++) {
        const next=[...this.timers].filter(([,timer])=>timer.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];
        if (!next) { this.time=target; await this.drain(); return; }
        this.time=next[1].at;this.timers.delete(next[0]);next[1].callback();
        await this.drain();
      }
      assert.fail('virtual timer loop did not settle');
    }
    async drain() { for (let n=0;n<60;n++) await Promise.resolve(); }
  }
  async function run(scope) {
    const sim=new SimClock();
    const settings=onlineSettings({enabled:true,translationScope:scope,prefetchSeconds:20,
      batchSize:10,videoBatchSize:10,concurrency:2});
    const pool=Array.from({length:120},(_,n)=>({...source(n),mediaTimeMs:n*1000+2000,renderAtMs:n*1000}));
    const cache=new MemoryTranslationCache({now:()=>sim.wallNow()});
    for (const n of [0,8,60,68,110]) await cache.set(
      translationCacheKey('sm9',pool[n].originalText,settings),`缓存译文${n}`,{resourceId:'sm9'});
    let providerCalls=0,providerInputs=0;
    const provider={complete:request=>new Promise((resolve,reject)=>{
      providerCalls++;providerInputs+=request.items.length;
      const timer=sim.setTimeout(()=>{
        request.signal.removeEventListener('abort',abort);
        resolve({items:new Map(request.items.map(item=>[item.id,{text:`译文:${item.text}`}]))});
      },2500);
      const abort=()=>{sim.clearTimeout(timer);reject(new Error('cancelled'));};
      request.signal.addEventListener('abort',abort,{once:true});
    })};
    const prepared=new Set(),samples=[];
    const engine=new TranslationEngine({provider,cache,clock:sim});
    const scheduler=new VideoScheduler({settings,now:()=>sim.now(),reset:()=>{},
      prepared:items=>items.forEach(item=>prepared.add(item.id)),
      request:(resourceId,items,signal,priority,onResult)=>engine.translate({resourceId,
        items:items.map(item=>({id:item.id,text:item.text,deadlineAt:sim.now()+item.remainingMs})),
        settings,apiKey:'fixture-only',signal,priority,mode:'vod',onResult}).then(response=>response.items)});
    t.after(()=>{scheduler.dispose();engine.dispose();});
    const positions=[...Array.from({length:11},(_,n)=>n),...Array.from({length:11},(_,n)=>n+60)];
    for (const [index,position] of positions.entries()) {
      await sim.advanceTo(index*1000);
      if (position===60) scheduler.snapshot('sm9','session',{...clock(position*1000),seeking:true,paused:false},undefined,1);
      scheduler.snapshot('sm9','session',{...clock(position*1000),paused:false},index===0?pool:undefined,position>=60?1:0);
      await sim.drain();
      const item=pool[position];
      samples.push({id:item.id,mediaSeconds:position,wallMs:sim.now(),result:prepared.has(item.id)?'timely':'original'});
    }
    const timely=samples.filter(sample=>sample.result==='timely').length;
    return {displayed:samples.length,timely,original:samples.length-timely,providerCalls,providerInputs,
      cacheHits:engine.stats().cacheHits,samples};
  }
  const all=await run('all'),auto=await run('auto');
  assert.deepEqual(all.samples.map(({id,mediaSeconds,wallMs})=>({id,mediaSeconds,wallMs})),
    auto.samples.map(({id,mediaSeconds,wallMs})=>({id,mediaSeconds,wallMs})));
  for (const result of [all,auto]) {
    assert.equal(result.displayed,22);
    assert.equal(result.timely+result.original,result.displayed);
    assert.equal(result.samples[1].result,'original','the 2.5s provider delay is observed at display time');
    assert.ok(result.providerCalls>0 && result.providerInputs>0 && result.cacheHits>0);
  }
  const counts=({displayed,timely,original,providerCalls,providerInputs,cacheHits})=>
    ({displayed,timely,original,providerCalls,providerInputs,cacheHits});
  t.diagnostic(`120-message virtual playback 0-10s, seek, 60-70s; 2.5s provider: all=${JSON.stringify(counts(all))}, auto=${JSON.stringify(counts(auto))}`);
});
