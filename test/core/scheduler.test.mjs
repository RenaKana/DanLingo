import test from 'node:test';
import assert from 'node:assert/strict';
import { translationIdentity, VideoScheduler } from '../../src/core/scheduler.ts';
import { DEFAULT_SETTINGS } from '../../src/core/config.ts';
const clock = (mediaTimeMs=0, playbackRate=1) => ({ mediaTimeMs, playbackRate, paused:true, seeking:false, contentActive:true, durationMs:600000, buffered:[] });
const msg = (id, renderAtMs, originalText='これはテストです') => ({ id, sourceId:id, resourceId:'sm9', threadId:'1', fork:'main', platform:'niconico', originalText, mediaTimeMs:renderAtMs+2000, renderAtMs, translatable:true, style:{commands:[]} });
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(settings={}) {
  const calls=[], prepared=[]; let now=0;
  const config={...DEFAULT_SETTINGS,enabled:true,...settings};
  const scheduler = new VideoScheduler({ settings:config, now:()=>now, reset:()=>{},
    request:(resource,items,signal,priority)=>new Promise(resolve=>calls.push({resource,items,signal,priority,resolve})), prepared:items=>prepared.push(...items) });
  return {scheduler,calls,prepared,config,advance:ms=>{now+=ms;},finish(index,status='translated'){const c=calls[index];c.resolve(c.items.map(m=>({id:m.id,text:'译文:'+m.text,status})));}};
}

test('translation identity tracks effective local model and generation settings, not runtime capacity', () => {
  const settings = { ...DEFAULT_SETTINGS, backend: 'local', model: 'local-alias', localModelId: 'model-one',
    localPerformance: { temperature: 0.1, normalMaxTokens: 128, promptMode: 'json', languageValidation: 'strict', parallel: 1 } };
  const identity = translationIdentity(settings);
  const withLocal = change => translationIdentity({ ...settings, ...change });
  assert.notEqual(withLocal({ localModelId: 'model-two' }), identity);
  assert.notEqual(withLocal({ localPerformance: { ...settings.localPerformance, temperature: 0.2 } }), identity);
  assert.notEqual(withLocal({ localPerformance: { ...settings.localPerformance, normalMaxTokens: 256 } }), identity);
  assert.notEqual(withLocal({ localPerformance: { ...settings.localPerformance, promptMode: 'hy-mt' } }), identity);
  assert.notEqual(withLocal({ localPerformance: { ...settings.localPerformance, languageValidation: 'off' } }), identity);
  assert.notEqual(translationIdentity(DEFAULT_SETTINGS), identity);
  assert.equal(withLocal({ localPerformance: { ...settings.localPerformance, parallel: 8 } }), identity);
  assert.equal(withLocal({ concurrency: 16, requestTimeoutMs: 1000, thinkingRequestTimeoutMs: 1000 }), identity);
});

test('local generation changes abort stale preparation and schedule the current settings', async () => {
  const h = harness({ backend: 'local', model: 'local-alias', localModelId: 'snapshot-one',
    localPerformance: { temperature: 0.1, promptMode: 'json', languageValidation: 'strict' }, concurrency: 2, batchSize: 1 });
  h.scheduler.snapshot('sm9', 'a', clock(), [msg('1', 0)]);
  const oldCall = h.calls[0];
  h.scheduler.configure({ ...h.config, localPerformance: { ...h.config.localPerformance, temperature: 0.4 } });
  assert.equal(oldCall.signal.aborted, true);
  assert.equal(h.calls.length, 2);
  h.finish(0); await flush();
  assert.equal(h.prepared.length, 0, 'the old generation result is ignored');
  h.finish(1); await flush();
  assert.equal(h.prepared[0].id, '1');
  h.scheduler.dispose();
});

test('small VOD batches can use 16 slots and send the separate high-thinking budget', () => {
  const h = harness({ profile: 'deepseek', model: 'deepseek-v4-pro', thinkingEffort: 'high', concurrency: 16, batchSize: 1 });
  h.scheduler.snapshot('sm9', 'a', clock(), Array.from({ length: 17 }, (_, n) => msg(String(n), n * 1000)));
  assert.equal(h.calls.length, 16);
  assert.ok(h.calls.every(call => call.items.length === 1 && call.items[0].remainingMs === 120000));
  h.advance(90000); h.scheduler.tick();
  assert.equal(h.scheduler.getStats().failed, 0); assert.ok(h.calls.every(call => !call.signal.aborted));
  h.scheduler.dispose();
});
test('paused opening includes negative preparation, then buffered and whole-video candidates with full concurrency', async () => {
  const h=harness({batchSize:1});
  h.scheduler.snapshot('sm9','a',{...clock(),buffered:[{startMs:170000,endMs:190000}]},[msg('far',300000),msg('buffered',180000),msg('zero',-2000)]);
  assert.deepEqual(h.calls.map(c=>c.items[0].id),['zero','buffered']);
  assert.equal(h.calls[0].priority,'near');assert.equal(h.calls[1].priority,'buffered');
  h.finish(0);await flush();assert.equal(h.calls[2].items[0].id,'far');
  assert.equal(h.prepared[0].id,'zero');h.scheduler.dispose();
});
test('same-video seek retains in-flight work and completed values, even after its original media time', async () => {
  const h=harness({concurrency:1,batchSize:1});
  h.scheduler.snapshot('sm9','a',clock(),[msg('1',2000),msg('2',45000)]);
  h.scheduler.snapshot('sm9','a',clock(40000));assert.equal(h.calls[0].signal.aborted,false);
  h.advance(6000);h.finish(0);await flush();assert.equal(h.prepared[0].id,'1');
  assert.equal(h.calls[1].items[0].id,'2');h.finish(1);await flush();
  h.scheduler.snapshot('sm9','a',clock(0));assert.equal(h.calls.length,2);assert.equal(h.scheduler.getStats().translated,2);
  h.scheduler.snapshot('sm9','b',clock(0),[msg('1',2000)]);assert.equal(h.calls.length,3);h.scheduler.dispose();
});
test('video changes isolate old completion and distinct equal-text events keep their identities', async () => {
  const h=harness();h.scheduler.snapshot('sm9','a',clock(),[msg('old',0)]);
  h.scheduler.snapshot('sm9','b',clock(),[msg('1',0),msg('2',1)]);assert.equal(h.calls[0].signal.aborted,true);
  h.finish(0);h.finish(1,'cached');await flush();assert.deepEqual(h.prepared.map(m=>m.id),['1','2']);assert.equal(h.scheduler.getStats().cacheHits,2);h.scheduler.dispose();
});
test('window uses video seconds, excludes far buffered positions, and fills as playback moves', async () => {
  const h=harness({translationScope:'window',prefetchSeconds:60});
  h.scheduler.snapshot('sm9','a',{...clock(0,2),buffered:[{startMs:300000,endMs:350000}]},[msg('zero',-2000),msg('near',30000),msg('later',70000),msg('far',320000)]);
  assert.deepEqual(h.calls.flatMap(c=>c.items.map(m=>m.id)),['zero','near']);
  h.finish(0);h.finish(1);await flush();h.scheduler.snapshot('sm9','a',clock(50000,2));
  assert.equal(h.calls[2].items[0].id,'later');assert.equal(h.scheduler.getStats().messages,1);h.scheduler.dispose();
});
test('source updates and removals cannot apply a stale in-flight result', async () => {
  const h=harness({concurrency:1});const old=msg('1',0,'古い文章');
  h.scheduler.snapshot('sm9','a',clock(),[old,msg('remove',1)]);
  h.scheduler.updateSources([msg('1',0,'新しい文章')],['remove'],false,true);assert.equal(h.calls[0].signal.aborted,true);h.finish(0);await flush();
  assert.equal(h.prepared.length,0);assert.equal(h.calls[1].items.length,1);assert.equal(h.calls[1].items[0].text,'新しい文章');
  h.finish(1);await flush();assert.equal(h.scheduler.getStats().messages,1);assert.equal(h.prepared[0].originalText,'新しい文章');h.scheduler.dispose();
});

test('removing one item retains its in-flight batch while a sibling remains current', async () => {
  const h = harness({ concurrency: 1, batchSize: 2 });
  h.scheduler.snapshot('sm9', 'a', clock(), [msg('remove', 0), msg('keep', 1)]);
  assert.deepEqual(h.calls[0].items.map(item => item.id), ['remove', 'keep']);
  h.scheduler.updateSources([], ['remove'], false, true);
  assert.equal(h.calls[0].signal.aborted, false);
  h.finish(0); await flush();
  assert.deepEqual(h.prepared.map(item => item.id), ['keep']);
  assert.equal(h.scheduler.getStats().inflight, 0);
  h.scheduler.dispose();
});

test('an orphaned request finally cannot clear pending ownership for a replacement ID', async () => {
  const h = harness({ concurrency: 2, batchSize: 1 });
  h.scheduler.snapshot('sm9', 'a', clock(), [msg('same', 0, '古い文章です')]);
  const oldCall = h.calls[0];
  h.scheduler.updateSources([msg('same', 0, '新しい文章です')], [], false, true);
  assert.equal(oldCall.signal.aborted, true);
  assert.equal(h.calls.length, 2);
  h.finish(0); await flush();
  assert.equal(h.calls.length, 2, 'old finally leaves the replacement pending');
  assert.equal(h.scheduler.getStats().queued, 1);
  h.finish(1); await flush();
  assert.deepEqual(h.prepared.map(item => item.originalText), ['新しい文章です']);
  h.scheduler.dispose();
});
test('deferred work remains pending until its retry time; failures are separate from progress', async () => {
  const h=harness();h.scheduler.snapshot('sm9','a',clock(),[msg('1',0)]);
  h.calls[0].resolve([{id:'1',status:'deferred',retryAfterMs:5000}]);await flush();
  assert.equal(h.scheduler.getStats().failed,0);assert.equal(h.scheduler.getStats().queued,1);h.scheduler.tick();assert.equal(h.calls.length,1);
  h.advance(5000);h.scheduler.tick();assert.equal(h.calls.length,2);h.finish(1,'failed');await flush();assert.equal(h.scheduler.getStats().failed,1);assert.equal(h.scheduler.getStats().translated,0);
  h.scheduler.retryFailures();assert.equal(h.calls.length,3);h.scheduler.dispose();
});
test('scheduling preferences preserve translations while language changes invalidate them', async () => {
  const h=harness();h.scheduler.snapshot('sm9','a',clock(),[msg('1',0)]);h.finish(0);await flush();
  h.scheduler.configure({...h.config,translationScope:'window'});assert.equal(h.calls.length,1);assert.equal(h.scheduler.getStats().translated,1);
  h.scheduler.configure({...h.config,targetLanguage:'en'});assert.equal(h.calls.length,2);assert.equal(h.scheduler.getStats().translated,0);h.scheduler.dispose();
});
test('ad and seeking clocks do not submit translation work; pause alone does', () => {
  const h=harness();h.scheduler.snapshot('sm9','a',{...clock(),contentActive:false},[msg('1',0)]);
  h.scheduler.snapshot('sm9','a',{...clock(),seeking:true});assert.equal(h.calls.length,0);
  h.scheduler.snapshot('sm9','a',clock());assert.equal(h.calls.length,1);h.scheduler.dispose();
});

test('completed preparation reports excluded comments separately within the selected video range', async () => {
  const h = harness({ sourceLanguage: 'ja' });
  const sources = [msg('plain', 0), msg('face', 1, 'この頃に生まれたかったಠ\u2060益\u2060ಠ'), msg('han', 2, '聖地巡礼'),
    { ...msg('special', 3), translatable: false }, msg('symbols', 4, 'www'), msg('art', 5, 'すごい┻━┻'),
    { ...msg('far-special', 300000), translatable: false }];
  h.scheduler.snapshot('sm9', 'a', clock(), sources);
  assert.deepEqual(h.calls.flatMap(c => c.items.map(m => m.id)), ['plain', 'face', 'han']);
  h.finish(0); await flush();
  let stats = h.scheduler.getStats();
  assert.equal(stats.translated, 3); assert.equal(stats.messages, 3); assert.equal(stats.total, 7);
  assert.deepEqual(stats.skipped, { special: 2, language: 1, emoticon: 1 });
  assert.equal(stats.failed, 0); assert.equal(stats.queued, 0);
  h.scheduler.configure({ ...h.config, translationScope: 'window', prefetchSeconds: 60 });
  stats = h.scheduler.getStats();
  assert.equal(stats.total, 6); assert.equal(stats.translated, 3);
  assert.deepEqual(stats.skipped, { special: 1, language: 1, emoticon: 1 });
  assert.equal(h.calls.length, 1, 'Changing the progress range must reuse prepared translations');
  h.scheduler.dispose();
});

test('skip counts follow source edits, removals, language changes and video disposal', () => {
  const h = harness({ sourceLanguage: 'ja' });
  h.scheduler.snapshot('sm9', 'a', clock(), [msg('han', 0, '聖地巡礼'), { ...msg('special', 1), translatable: false }, msg('art', 2, 'すごい┻━┻')]);
  h.scheduler.configure({ ...h.config, sourceLanguage: 'auto' });
  assert.deepEqual(h.scheduler.getStats().skipped, { special: 1, language: 1, emoticon: 1 });
  h.scheduler.updateSources([msg('special', 1)], ['art'], false, false);
  const stats = h.scheduler.getStats();
  assert.equal(stats.total, 2); assert.equal(stats.messages, 1); assert.equal(stats.sourceComplete, false);
  assert.deepEqual(stats.skipped, { special: 0, language: 1, emoticon: 0 });
  h.scheduler.snapshot('sm10', 'b', clock(), []);
  assert.equal(h.scheduler.getStats().total, 0);
  assert.deepEqual(h.scheduler.getStats().skipped, { special: 0, language: 0, emoticon: 0 });
  h.scheduler.dispose();
});
