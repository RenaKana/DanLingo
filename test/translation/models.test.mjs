import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverModels, discoverModelCatalog } from '../../src/translation/provider.ts';

const request={endpoint:'http://192.168.31.93:8080/prefix/v1',allowLocalHttp:true,apiKey:'test-model-key',timeoutMs:1000};
test('model discovery is a bounded GET with exact base, no cookies, redirects, or message text', async () => {
  let calls=0;
  const models=await discoverModels(request,async(url,init)=>{
    calls++;
    assert.equal(url,'http://192.168.31.93:8080/prefix/v1/models');
    assert.equal(init.method,'GET');
    assert.equal(init.headers.Authorization,'Bearer test-model-key');
    assert.equal(init.body,undefined);
    assert.equal(init.credentials,'omit');
    assert.equal(init.redirect,'error');
    return Response.json({data:[{id:'model-b'}, {id:'model-a'}, {id:'model-b'}, {id:''}, {id:34}, {id:'a'.repeat(101)}, {id:'bad\nvalue'}]});
  });
  assert.equal(calls,1);
  assert.deepEqual(models,['model-b','model-a']);
});

test('discovery extracts only declared effort fields and leaves the names-only API intact', async () => {
  let calls=0;
  const fetcher=async()=>{calls++;return Response.json({data:[
    {id:'next-model',effort:{supported_levels:['minimal','ultra'],default_level:'ultra',private_field:'secret'},pricing:'secret'},
    {id:'__proto__',effort:{supported_levels:['xhigh'],default_level:'xhigh'}},
    {id:'no-effort'},
  ]});};
  const catalog=await discoverModelCatalog(request,fetcher);
  assert.deepEqual(catalog.models,['next-model','__proto__','no-effort']);
  assert.deepEqual(catalog.capabilities['next-model'],{supportedLevels:['minimal','ultra'],defaultLevel:'ultra'});
  assert.deepEqual(catalog.capabilities['__proto__'],{supportedLevels:['xhigh'],defaultLevel:'xhigh'});
  assert.equal(Object.hasOwn(catalog.capabilities,'no-effort'),false);
  assert.ok(!JSON.stringify(catalog).includes('secret'));
  assert.deepEqual(await discoverModels(request,fetcher),catalog.models);
  assert.equal(calls,2);
});

test('conflicting or malformed duplicate rows do not grant any effort metadata', async () => {
  const result=await discoverModelCatalog(request,async()=>Response.json({data:[
    {id:'conflict',effort:{supported_levels:['low'],default_level:'low'}},
    {id:'conflict',effort:{supported_levels:['high'],default_level:'high'}},
    {id:'unknown',effort:{supported_levels:['high']}}, {id:'unknown',effort:{supported_levels:['high\n']}},
    {id:'same',effort:{supported_levels:['low','ultra'],default_level:'low'}},
    {id:'same',effort:{supported_levels:['ultra','low'],default_level:'low'}},
    {id:'conflict',effort:{supported_levels:['low'],default_level:'low'}},
  ]}));
  assert.deepEqual(result.models,['conflict','unknown','same']);
  assert.equal(Object.hasOwn(result.capabilities,'conflict'),false);
  assert.equal(Object.hasOwn(result.capabilities,'unknown'),false);
  assert.deepEqual(result.capabilities.same,{supportedLevels:['low','ultra'],defaultLevel:'low'});
});
test('discovery reports fixed failures without leaking remote bodies or transport errors', async () => {
  for(const status of [401,403,404,429,500]) await assert.rejects(
    discoverModels(request,async()=>new Response('echoed secret',{status})), {message:`http-${status}`});
  await assert.rejects(discoverModels(request,async()=>{throw new Error('echoed secret');}),{message:'network-error'});
  await assert.rejects(discoverModels(request,async()=>new Response('{}',{status:302})),{message:'redirect-blocked'});
});
test('model list shape and response byte limit are enforced', async () => {
  await assert.rejects(discoverModels(request,async()=>Response.json({models:['model']})),{message:'invalid-response'});
  await assert.rejects(discoverModels(request,async()=>Response.json({data:[]})),{message:'empty-model-list'});
  await assert.rejects(discoverModels(request,async()=>new Response('{}',{headers:{'content-length':String(1024*1024+1)}})),{message:'response-too-large'});
});
test('discovery timeout and cancellation finish without retrying', async () => {
  let calls=0;
  const pending=async(_url,{signal})=>new Promise((resolve,reject)=>{
    calls++; const timer=setTimeout(resolve,4000);
    signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true});
  });
  await assert.rejects(discoverModels(request,pending),{message:'timeout'});
  const controller=new AbortController();
  const cancelled=discoverModels({...request,signal:controller.signal},pending);
  controller.abort();
  await assert.rejects(cancelled,{message:'cancelled'});
  assert.equal(calls,2);
});
test('invalid destination and Key fail before any fetch', async () => {
  let calls=0;
  const fetcher=async()=>{calls++;return Response.json({data:[{id:'model'}]});};
  for(const patch of [{apiKey:''},{apiKey:'bad\nkey'},{allowLocalHttp:false},{endpoint:'http://public.test/v1'}]) {
    await assert.rejects(discoverModels({...request,...patch},fetcher));
  }
  assert.equal(calls,0);
});
