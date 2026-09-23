import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../../src/core/config.ts';
import { discoverConnectionModels } from '../../src/translation/connection-discovery.ts';
const settings={...DEFAULT_SETTINGS,endpoint:'https://gateway.example/team/proxy?tenant=test'};
test('custom proxy checks two bounded prefix-preserving GET candidates and returns effective base',async()=>{
  const calls=[];const result=await discoverConnectionModels(settings,'fixture',{fetch:async(url,init)=>{calls.push({url,init});return calls.length===1?new Response('',{status:404}):Response.json({data:[{id:'fixture-model'}]});}});
  assert.deepEqual(calls.map(call=>call.url),['https://gateway.example/team/proxy/models?tenant=test','https://gateway.example/team/proxy/v1/models?tenant=test']);
  assert.ok(calls.every(call=>call.init.method==='GET'&&call.init.redirect==='error'));assert.equal(result.effectiveEndpoint,'https://gateway.example/team/proxy/v1?tenant=test');assert.equal(result.effectiveEndpointMode,'base');assert.deepEqual(result.models,['fixture-model']);
});
test('authentication, permissions, throttling and network errors stop candidate probing immediately',async()=>{
  for(const status of [401,403,429,500]) {let calls=0;await assert.rejects(discoverConnectionModels(settings,'fixture',{fetch:async()=>{calls++;return new Response('',{status});}}),{message:`http-${status}`});assert.equal(calls,1);}
});
test('known Gemini compatibility base uses one model endpoint without inserted v1',async()=>{
  let url;await discoverConnectionModels({...settings,endpoint:'https://gateway.example/v1beta/openai'},'fixture',{fetch:async(value)=>{url=value;return Response.json({data:[{id:'gemini-model'}]});}});assert.equal(url,'https://gateway.example/v1beta/openai/models');
});
test('nested manual full-path override cannot silently discover an auto-normalized root',async()=>{
  let calls=0;
  await assert.rejects(discoverConnectionModels({...settings,endpoint:'https://gateway.example',connectionOverride:{endpointMode:'completion'}},'fixture',{
    fetch:async()=>{calls++;return Response.json({data:[{id:'model'}]});},
  }),{message:'models-endpoint-ambiguous'});
  assert.equal(calls,0);
});
