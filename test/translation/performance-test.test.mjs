import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../../src/core/config.ts';
import { PerformanceTest, percentile } from '../../src/translation/performance-test.ts';
import { hybridCapacityIdentity } from '../../src/translation/hybrid-capacity.ts';
import { resolveLocalConfig } from '../../src/local/config.ts';
import { withLocalRuntime } from '../../src/local/provider-settings.ts';
import { onlineSettings } from '../fixtures/online-settings.mjs';
const settings=onlineSettings({endpoint:'https://provider.example/v1/chat/completions',profile:'deepseek',model:'deepseek-v4-pro',thinkingEffort:'off',liveMaxBatchWaitMs:0,liveAdaptiveConcurrency:false,liveSourceLanguage:'ja'});
const config={count:10,mode:'latency',concurrency:1,batchSize:2,arrivalIntervalMs:0,strategy:'normal'};
function reply(init) { const body=JSON.parse(init.body);return Response.json({choices:[{message:{content:body.messages[1].content.split('\n').map(line=>{const [id,text]=JSON.parse(line);return JSON.stringify([id,'译文:'+text]);}).join('\n')}}]}); }
test('10 and 100 mean actual transport requests and never memoized responses',async()=>{
  for(const count of [10,100]) { let calls=0; const texts=new Set();const run=new PerformanceTest({...config,count},settings,'fixture',{fetch:async(_url,init)=>{calls++;texts.add(JSON.parse(init.body).messages[1].content);return reply(init);}});const report=await run.run();
    assert.equal(calls,count);assert.equal(report.actualRequests,count);assert.equal(report.successRequests,count);assert.equal(report.unsent,0);assert.equal(texts.size,count);assert.ok(report.meanMs>=0);assert.equal(report.successRate,1);
  }
});
test('load replay uses existing scheduler, batch settings and individual wait/request/ready times',async()=>{
  let active=0,max=0;const run=new PerformanceTest({...config,mode:'load',concurrency:2},settings,'fixture',{fetch:async(_url,init)=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,20));active--;return reply(init);}});
  const report=await run.run();assert.equal(report.actualRequests,10);assert.equal(max,2);assert.equal(report.successRequests,10);assert.equal(report.jobs.length,10);assert.ok(report.samples.every(row=>row.items===2));assert.ok(report.meanQueueMs>10);assert.ok(report.meanMs>=18);assert.ok(report.meanReadyMs>report.meanMs);assert.equal(report.withinBudgetRate,1);
  assert.ok(Math.abs(report.meanMs-report.samples.reduce((sum,row)=>sum+row.readyAt-row.sentAt,0)/10)<.001);
});
test('HTTP success with invalid translations produces no valid statistics',async()=>{
  const run=new PerformanceTest(config,settings,'fixture',{fetch:async()=>Response.json({choices:[{message:{content:'invalid'}}]})});const report=await run.run();assert.equal(report.actualRequests,10);assert.equal(report.successRequests,0);assert.equal(report.meanMs,null);assert.equal(report.p95Ms,null);assert.equal(report.failed,10);
});
test('stop cancels in-flight and does not send queued requests; usage remains unknown',async()=>{
  let calls=0;const run=new PerformanceTest({...config,count:100,concurrency:2},settings,'fixture',{fetch:async()=>{calls++;return new Promise(()=>{});}});const pending=run.run();await new Promise(r=>setTimeout(r,5));run.stop();const report=await pending;
  assert.equal(calls,2);assert.equal(report.state,'stopped');assert.equal(report.actualRequests,2);assert.equal(report.cancelled,2);assert.equal(report.unsent,98);assert.equal(report.usage,undefined);assert.equal(report.meanMs,null);
});
test('stopping load replay cancels the entire scheduled queue before any more transport',async()=>{
  let calls=0;const run=new PerformanceTest({...config,count:100,mode:'load',concurrency:2},settings,'fixture',{fetch:async()=>{calls++;return new Promise(()=>{});}});
  const pending=run.run();await new Promise(r=>setTimeout(r,5));assert.equal(calls,2);run.stop();const report=await pending;
  assert.equal(calls,2);assert.equal(report.actualRequests,2);assert.equal(report.unsent,98);assert.equal(report.cancelled,2);
});
test('latency benchmark retains live protocol and full selected thinking timeout',async()=>{
  let now=0, timeout, respond;
  const run=new PerformanceTest({...config,count:1},{...settings,thinkingEffort:'high',thinkingRequestTimeoutMs:120000},'fixture',{
    clock:{now:()=>now,setTimeout:(_fn,ms)=>{timeout=ms;return 1;},clearTimeout:()=>{}},
    fetch:async(_url,init)=>new Promise(resolve=>{respond=()=>resolve(reply(init));}),
  });
  const pending=run.run();assert.equal(timeout,120000);now=40000;respond();const report=await pending;assert.equal(report.meanMs,40000);assert.equal(report.successRequests,1);
});
test('percentiles use independent observations and no successful samples is null',()=>{assert.equal(percentile([], .95),null);assert.equal(percentile([50,10,100,20], .5),20);assert.equal(percentile([50,10,100,20], .95),100);});

test('first-five-second counts use accepted item readiness from run start and exclude preflight time', async () => {
  let now = 10000, calls = 0;
  const run = new PerformanceTest({ ...config, count: 4 }, settings, 'private-key', {
    clock: () => now,
    fetch: async (_url, init) => { now += [500, 1200, 3400, 100][calls++]; return reply(init); },
  });
  now = 30000; // Simulated admission/model setup does not count as inference.
  const report = await run.run();
  assert.equal(report.startedAt, 30000);
  assert.equal(report.timing.firstValidMs, 500);
  assert.deepEqual([report.timing.readyWithin1s, report.timing.readyWithin2s, report.timing.readyWithin5s], [1, 2, 2]);
  assert.equal(report.timing.readySourceCharsWithin5s,
    'すごい！ (1-1)'.length + '今の動き、もう一度見たいです 😂 (2-1)'.length);
  assert.equal(report.timing.validItems, 4);
  assert.equal(report.timing.plannedItems, 4);
  assert.equal(report.timing.meanItemReadyMs, 1300);
  assert.equal(report.timing.p95ItemReadyMs, 3400);
  assert.equal(report.timing.itemsPerSecond, 4 / 5.2);
  assert.equal(report.timing.peakRequests, 1);
  assert.equal(report.measurement.corpus, 'danlingo-fixed-v1');
  assert.equal(JSON.stringify(report).includes('private-key'), false);
  assert.equal(JSON.stringify(report.measurement).includes('provider.example'), false);
});

test('invalid responses and cancelled work never inflate five-second availability', async () => {
  const run = new PerformanceTest({ ...config, count: 2 }, settings, 'fixture', { fetch: async () => Response.json({ choices: [{ message: { content: 'invalid' } }] }) });
  const report = await run.run();
  assert.equal(report.timing.firstValidMs, null); assert.equal(report.timing.validItems, 0);
  assert.equal(report.timing.readyWithin5s, 0); assert.equal(report.timing.plannedItems, 2);
  assert.equal(report.timing.readySourceCharsWithin5s, 0);
  assert.ok(report.errorCategories.runtime > 0);
});

test('load replay excludes a locally echoed short shared-Han source from timely capacity', async () => {
  const local = { ...DEFAULT_SETTINGS, backend: 'local', model: 'local-id', localModelId: 'local-id',
    liveSourceLanguage: 'zh', targetLanguage: 'ja', liveMaxBatchWaitMs: 0 };
  const report = await new PerformanceTest({ ...config, mode: 'load', count: 1, batchSize: 1, budgetMs: 5000 },
    local, 'local-inference', { fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      const unchanged = body.messages[1].content.split('\n').map(line => JSON.stringify(JSON.parse(line))).join('\n');
      return Response.json({ choices: [{ message: { content: unchanged } }] });
    } }).run();
  assert.equal(report.actualRequests, 1);
  assert.equal(report.timing.readyWithin5s, 0);
  assert.equal(report.timing.readySourceCharsWithin5s, 0);
  assert.equal(report.timing.validItems, 0);
  assert.ok(report.errorCategories.runtime > 0);
});

test('replay records and uses the explicit five-second budget without changing saved settings', async () => {
  const original = { ...settings, liveBufferMs: 200 };
  const report = await new PerformanceTest({ ...config, mode: 'load', count: 1, batchSize: 1, budgetMs: 5000 }, original, 'fixture', {
    fetch: async (_url, init) => { await new Promise(resolve => setTimeout(resolve, 230)); return reply(init); },
  }).run();
  assert.equal(report.measurement.budgetMs, 5000); assert.equal(report.withinBudgetRate, 1);
  assert.equal(report.timing.validItems, 1); assert.equal(original.liveBufferMs, 200);
  assert.throws(() => new PerformanceTest({ ...config, budgetMs: -1 }, settings, 'fixture'), /invalid-performance-config/);
});

test('TranslateGemma auto source fails before creating a zero-request completed run', async () => {
  const local = { ...DEFAULT_SETTINGS, backend: 'local', model: 'local-id', localModelId: 'local-id',
    localTranslationProfile: 'translategemma', localCapacity: 4, liveSourceLanguage: 'auto', sourceLanguage: 'ja' };
  let calls = 0;
  for (const mode of ['latency', 'load']) {
    assert.throws(() => new PerformanceTest({ ...config, mode, concurrency: 4 }, local, 'local-inference', {
      fetch: async () => { calls++; return Response.json({}); },
    }), /LOCAL_TRANSLATION_SOURCE_REQUIRED/);
    assert.throws(() => new PerformanceTest({ ...config, mode }, { ...local, liveSourceLanguage: 'ja', targetLanguage: 'zz-ZZ' }, 'local-inference'), /LOCAL_TRANSLATION_LANGUAGE_UNSUPPORTED/);
  }
  assert.equal(calls, 0);
});

test('TranslateGemma explicit live source sends all ten requests in latency and load modes', async () => {
  const local = { ...DEFAULT_SETTINGS, backend: 'local', model: 'local-id', localModelId: 'local-id',
    localTranslationProfile: 'translategemma', localCapacity: 4, liveSourceLanguage: 'ja', sourceLanguage: 'auto',
    liveMaxBatchWaitMs: 0 };
  for (const mode of ['latency', 'load']) {
    let calls = 0;
    const report = await new PerformanceTest({ ...config, mode, concurrency: 4, batchSize: 1 }, local, 'local-inference', {
      fetch: async (_url, init) => {
        calls++;
        const prompt = JSON.parse(init.body).messages[0].content;
        assert.match(prompt, /Japanese \(ja\) to Chinese \(zh-Hans\)/);
        const placeholders = prompt.match(/\[\[DL:[^\]]+\]\]/g) ?? [];
        return Response.json({ choices: [{ message: { content: '谢谢你的直播！' + placeholders.join('') }, finish_reason: 'stop' }] });
      },
    }).run();
    assert.equal(calls, 10); assert.equal(report.actualRequests, 10);
    assert.equal(report.successRequests, 10); assert.equal(report.unsent, 0);
  }
});

test('local capacity identity survives matching runtime and is discarded on runtime fallback', async () => {
  const original = { ...DEFAULT_SETTINGS, backend: 'local', model: 'local-model', localModelId: 'local-model',
    liveSourceLanguage: 'ja', localConcurrency: 2, localPerformance: {
      mode: 'custom', parallel: 2, contextTokens: 2048, batchPreset: 'custom', batch: 256, microBatch: 128,
    } };
  const identity = await hybridCapacityIdentity({ ...original, sourceLanguage: original.liveSourceLanguage });
  const runtime = resolveLocalConfig(original.localPerformance, original.localModelId);
  for (const [actualRuntime, shouldMatch] of [[runtime, true], [{ ...runtime, parallel: 1 }, false]]) {
    const effective = withLocalRuntime(original, { runtime: actualRuntime });
    const run = new PerformanceTest({ ...config, count: 1, mode: 'load', batchSize: 1, concurrency: 2, budgetMs: 5000 },
      effective, 'fixture', { fetch: async (_url, init) => reply(init) });
    run.report.measurement.capacityIdentity = identity;
    const report = await run.run();
    assert.equal(report.measurement.capacityIdentity, shouldMatch ? identity : undefined);
    assert.equal(report.actualRequests, 1);
  }
});
