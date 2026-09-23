import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, endpointOrigin, completionEndpoint, modelsEndpoint, normalizeSettings, normalizeThinkingEffort, thinkingEfforts, providerTimeoutMs } from '../../src/core/config.ts';

test('explicit private HTTP opt-in accepts only local and RFC1918 hosts', () => {
  for (const host of ['localhost', '127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.31.93']) {
    const endpoint=`http://${host}:8080/v1/chat/completions`;
    assert.throws(()=>endpointOrigin(endpoint));
    assert.equal(endpointOrigin(endpoint,true),`http://${host}:8080`);
  }
  for (const host of ['example.com', '192.168.31.93.example.com', '172.15.0.1', '172.32.0.1', '192.169.0.1', '169.254.169.254', '100.64.0.1', '8.8.8.8', '[::1]']) {
    assert.throws(()=>endpointOrigin(`http://${host}/v1/models`,true));
  }
});

test('versioned base and missing slashes normalize without changing the configured origin', () => {
  const result=normalizeSettings({endpoint:'http:192.168.31.93:8080/v1',allowLocalHttp:true});
  assert.equal(result.endpoint,'http://192.168.31.93:8080/v1/chat/completions');
  assert.equal(modelsEndpoint(result.endpoint,true),'http://192.168.31.93:8080/v1/models');
  assert.equal(completionEndpoint('https://service.test/proxy/v1/'),'https://service.test/proxy/v1/chat/completions');
  assert.equal(modelsEndpoint('https://service.test/proxy/v1/'),'https://service.test/proxy/v1/models');
  assert.equal(completionEndpoint('https://service.test/custom-completion'),'https://service.test/custom-completion');
  assert.throws(()=>modelsEndpoint('https://service.test/custom-completion'));
});

test('address normalization preserves credential and URL boundary validation', () => {
  for (const endpoint of ['https://user:secret@service.test/v1', 'https://service.test/v1?token=secret', 'https://service.test/v1#fragment', 'file:///v1', 'http://public.test/v1']) {
    assert.throws(()=>completionEndpoint(endpoint,true));
  }
  assert.equal(completionEndpoint('https://service.test/'),'https://service.test/v1/chat/completions');
  assert.notEqual(endpointOrigin('http://192.168.31.93:8080/v1',true),endpointOrigin('http://192.168.31.93:8081/v1',true));
});

test('fresh VOD settings default to all comments, a 60 video-second window and larger batches', () => {
  const result=normalizeSettings(undefined);
  assert.deepEqual(result,DEFAULT_SETTINGS);
  assert.equal(result.schemaVersion,3);
  assert.equal(result.translationScope,'all');
  assert.equal(result.prefetchSeconds,60);
  assert.equal(result.urgentSeconds,5);
  assert.equal(result.batchSize,100);
  assert.equal(result.maxBatchChars,12000);
  assert.equal(result.concurrency,2);
});

test('old defaults migrate once while customized limits and settings survive', () => {
  const result=normalizeSettings({batchSize:20,maxBatchChars:6000,prefetchSeconds:30,urgentSeconds:8,enabled:true,profile:'deepseek',model:'kept-model'});
  assert.equal(result.batchSize,100);
  assert.equal(result.maxBatchChars,12000);
  assert.equal(result.prefetchSeconds,60);
  assert.equal(result.urgentSeconds,5);
  assert.equal(result.thinkingEffort,'default');
  assert.equal(result.enabled,true);
  assert.equal(result.model,'kept-model');
  assert.deepEqual(normalizeSettings(result),result);
  const custom=normalizeSettings({batchSize:17,maxBatchChars:5999,prefetchSeconds:29,urgentSeconds:7,concurrency:3});
  assert.deepEqual([custom.batchSize,custom.maxBatchChars,custom.prefetchSeconds,custom.urgentSeconds,custom.concurrency],[17,5999,29,7,3]);
  const saved=normalizeSettings({...result,batchSize:20,maxBatchChars:6000,prefetchSeconds:30,urgentSeconds:8});
  assert.deepEqual([saved.batchSize,saved.maxBatchChars,saved.prefetchSeconds,saved.urgentSeconds],[20,6000,30,8]);
});

test('VOD limits allow a one-hour window and bound large batches', () => {
  const result=normalizeSettings({schemaVersion:2,translationScope:'window',prefetchSeconds:9999,urgentSeconds:0,batchSize:999,maxBatchChars:99999});
  assert.deepEqual([result.prefetchSeconds,result.urgentSeconds,result.batchSize,result.maxBatchChars],[3600,1,200,24000]);
  assert.equal(normalizeSettings({schemaVersion:2,translationScope:'window',prefetchSeconds:5,urgentSeconds:30}).urgentSeconds,5);
  assert.equal(normalizeSettings({schemaVersion:2,translationScope:'all',prefetchSeconds:5,urgentSeconds:30}).urgentSeconds,30);
  assert.equal(normalizeSettings({prefetchSeconds:-1}).prefetchSeconds,5);
});

test('missing thinking settings use provider defaults and explicit unsupported efforts are rejected', () => {
  const allowed={minimax:['default','off'],deepseek:['default','off','low','high','max'],gemini:['default','low','medium','high'],'chat-completions':['default']};
  for(const [profile,values] of Object.entries(allowed)) {
    assert.deepEqual(thinkingEfforts(profile),values);
    for(const value of values) assert.equal(normalizeThinkingEffort(profile,value),value);
    const model = {minimax:'MiniMax-M3',deepseek:'deepseek-v4-pro',gemini:'gemini-2.5-pro','chat-completions':'unknown'}[profile];
    assert.equal(normalizeSettings({profile,model}).thinkingEffort,profile==='gemini'?'low':profile==='chat-completions'?'default':'off');
    for(const value of ['default','off','low','medium','high','max','minimal','',null,4].filter(value=>!values.includes(value))) {
      assert.throws(()=>normalizeSettings({profile,model,thinkingEffort:value}),{message:'unsupported-thinking-effort'});
    }
  }
});

test('thinking and service-default receive 120s independently of the old off timeout', () => {
  const old = { schemaVersion: 2, profile: 'deepseek', model: 'deepseek-v4-pro', requestTimeoutMs: 9000, concurrency: 4 };
  for (const thinkingEffort of ['high', 'max', 'default']) {
    const migrated = normalizeSettings({ ...old, thinkingEffort });
    assert.equal(migrated.thinkingRequestTimeoutMs, 120000);
    assert.equal(migrated.requestTimeoutMs, 9000);
    assert.equal(providerTimeoutMs(migrated), 120000);
    assert.equal(migrated.concurrency, 4);
    assert.deepEqual(normalizeSettings(migrated), migrated);
  }
  assert.equal(providerTimeoutMs(normalizeSettings({ ...old, thinkingEffort: 'off' })), 9000);
  assert.equal(providerTimeoutMs(normalizeSettings({ profile: 'chat-completions', model: 'any-name' })), 120000);
  assert.equal(providerTimeoutMs(DEFAULT_SETTINGS), 12000);
});

test('custom thinking timeout and higher concurrency persist within the supported limits', () => {
  const custom = normalizeSettings({ ...DEFAULT_SETTINGS, profile: 'deepseek', model:'deepseek-v4-pro', thinkingEffort: 'high',
    requestTimeoutMs: 70000, thinkingRequestTimeoutMs: 95000, concurrency: 12 });
  assert.equal(providerTimeoutMs(custom), 95000); assert.equal(custom.concurrency, 12);
  assert.deepEqual(normalizeSettings(custom), custom);
  const bounded = normalizeSettings({ ...custom, requestTimeoutMs: 999999, thinkingRequestTimeoutMs: 999999, concurrency: 99 });
  assert.deepEqual([bounded.requestTimeoutMs, bounded.thinkingRequestTimeoutMs, bounded.concurrency], [120000, 120000, 64]);
  assert.equal(DEFAULT_SETTINGS.concurrency, 2);
});
test('entry preload defaults on and preserves an explicit off value', () => {
  assert.equal(normalizeSettings({}).localPreloadOnEntry, true);
  assert.equal(normalizeSettings({ localPreloadOnEntry: false }).localPreloadOnEntry, false);
});
