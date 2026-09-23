import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalController } from '../../src/local/controller.ts';
import { inspectFiles, inspectGguf } from '../../src/local/gguf.ts';
import { emptyGpuInfo, observeGpuLog, verifyGpuOffload } from '../../src/local/gpu.ts';
import { installGpuGuard } from '../../src/local/gpu-worker-guard.js';
import { runInNewContext } from 'node:vm';

export function ggufFixture(overrides = {}, name = 'fixture.gguf', tensorCount = 1) {
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const str = s => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
  const metadata = { 'general.architecture': 'llama', 'general.file_type': 15, 'tokenizer.ggml.model': 'llama', 'tokenizer.ggml.tokens': ['hello'], 'tokenizer.chat_template': '{{ messages }}', ...overrides };
  const entries = Object.entries(metadata).filter(([,value]) => value !== undefined).map(([key, value]) => Buffer.concat([str(key), typeof value === 'number' ? Buffer.concat([u32(4),u32(value)]) : Array.isArray(value) ? Buffer.concat([u32(9),u32(8),u64(value.length),...value.map(str)]) : Buffer.concat([u32(8),str(value)])]));
  return new File([Buffer.concat([u32(0x46554747),u32(3),u64(tensorCount),u64(entries.length),...entries])], name);
}
class FakeWorker {
  onmessage = null; onerror = null; messages = []; terminated = false;
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  reply(id, data) { this.onmessage?.({data:{ id, ...data }}); }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function setup() { const workers = []; const controller = new LocalController(() => { const worker = new FakeWorker(); workers.push(worker); return worker; }); return { controller, workers }; }
async function loaded(env, modelId = 'model-a') { const promise = env.controller.load(modelId, {mode:'custom',parallel:1}); const worker = env.workers.at(-1); worker.reply(worker.messages[0].id, {ok:true,model:{id:modelId,name:modelId}}); await promise; return worker; }

test('GGUF checks metadata beyond filename while retaining structural companion validation', async () => {
  assert.equal((await inspectFiles([ggufFixture()])).quantization, 'Q4_K_M');
  assert.equal((await inspectGguf(ggufFixture({'general.architecture':'hunyuan-dense','general.file_type':7}))).architecture,'hunyuan-dense');
  assert.equal((await inspectGguf(ggufFixture({'general.architecture':'clip','general.file_type':99}))).architecture,'clip');
  assert.equal((await inspectFiles([ggufFixture({'general.file_type':99})])).quantization,'GGUF_TYPE_99');
  for (const [overrides, reason] of [
    [{'tokenizer.chat_template':undefined},'CHAT_TEMPLATE_MISSING'],
    [{'tokenizer.ggml.tokens':undefined},'TOKENIZER_MISSING'],
  ]) await assert.rejects(inspectGguf(ggufFixture(overrides)), new RegExp(reason));
  await assert.rejects(inspectFiles([new File(['{}'],'model.safetensors')]), /FORMAT_UNSUPPORTED/);
  await assert.rejects(inspectFiles([ggufFixture(),ggufFixture()]), /SINGLE_COMPLETE/);
  await assert.rejects(inspectGguf(new Blob(['GGUF'])), /HEADER_INVALID/);
});

test('GGUF imports complete shards in split.no order and rejects duplicate, missing, or mixed sets', async () => {
  const shard = (no, name = `model-${String(no + 1).padStart(5,'0')}-of-00002.gguf`, architecture = 'llama') => ggufFixture({
    'general.architecture': architecture, 'split.no': no, 'split.count': 2, 'split.tensors.count': 2,
  }, name, 1);
  const first = shard(0), second = shard(1);
  const info = await inspectFiles([second, first]);
  assert.deepEqual(info.files, [first.name, second.name]);
  assert.equal(info.bytes, first.size + second.size);
  const metadataOnlyInFirst = ggufFixture({ 'general.architecture': undefined, 'general.file_type': undefined,
    'tokenizer.ggml.model': undefined, 'tokenizer.ggml.tokens': undefined, 'tokenizer.chat_template': undefined,
    'split.no': 1, 'split.count': 2, 'split.tensors.count': 2 }, 'model-00002-of-00002.gguf');
  assert.deepEqual((await inspectFiles([metadataOnlyInFirst, first])).files, [first.name, metadataOnlyInFirst.name]);
  await assert.rejects(inspectFiles([first, shard(1, 'unrelated-00002-of-00002.gguf')]), /SHARD_MIXED/);
  await assert.rejects(inspectFiles([first]), /SHARD_SET_INCOMPLETE/);
  await assert.rejects(inspectFiles([first, shard(0, 'duplicate-00001-of-00002.gguf')]), /SHARD_DUPLICATE/);
  await assert.rejects(inspectFiles([first, ggufFixture()]), /SHARD_MIXED/);
  await assert.rejects(inspectFiles([first, shard(1, 'model-00002-of-00002.gguf', 'qwen2')]), /SHARD_MIXED/);
  await assert.rejects(inspectFiles([ggufFixture({}, 'model-00001-of-00002.gguf')]), /SHARD_METADATA_MISSING/);
});
test('concurrent load clicks share one model and re-opening has no extra load', async () => {
  const env = setup(); const a = env.controller.load('a'); const b = env.controller.load('a');
  assert.equal(env.workers.length,1);
  const worker = env.workers[0]; worker.reply(worker.messages[0].id,{ok:true,model:{id:'a'}});
  await Promise.all([a,b]); await env.controller.load('a'); assert.equal(env.workers.length,1);
});
test('one inference slot serializes settings/tab requests and retains counts', async () => {
  const env = setup(); const worker = await loaded(env);
  const a = env.controller.complete('a','model-a',{}); const b = env.controller.complete('b','model-a',{});
  await flush(); assert.equal(worker.messages.filter(m=>m.action==='complete').length,1);
  worker.reply('a',{ok:true,result:'first'}); assert.equal(await a,'first'); await flush();
  assert.equal(worker.messages.filter(m=>m.action==='complete').length,2);
  worker.reply('b',{ok:true,result:'second'}); assert.equal(await b,'second');
  assert.equal(env.controller.snapshot().inferenceCalls,2); assert.equal(env.controller.snapshot().queued,0);
});
test('unload kills loading/runtime workers and rejects stale generation', async () => {
  const env = setup(); const first = env.controller.load('a'); const rejected = assert.rejects(first,/MODEL_CHANGED/);
  const old = env.workers[0]; env.controller.unload(); assert.equal(old.terminated,true); await rejected;
  const worker = await loaded(env,'b');
  const inference = env.controller.complete('a','b',{}); const stale = assert.rejects(inference,/MODEL_CHANGED/); await flush();
  env.controller.unload(); worker.reply('a',{ok:true,result:'stale'}); await stale;
  assert.equal(env.controller.snapshot().phase,'idle'); assert.equal(env.controller.snapshot().queued,0);
});
test('queued cancellation does not execute or cancel another request', async () => {
  const env = setup(); const worker = await loaded(env);
  const a = env.controller.complete('a','model-a',{}); const b = env.controller.complete('b','model-a',{});
  const cancelled = assert.rejects(b,/CANCELLED/); env.controller.abort('b'); await flush();
  assert.equal(worker.messages.some(m=>m.action==='abort'),false);
  worker.reply('a',{ok:true,result:'ok'}); await a; await cancelled;
  assert.equal(env.controller.snapshot().inferenceCalls,1);
});
test('active abort stays serialized until worker settles, late success is rejected', async () => {
  const env=setup(); const worker=await loaded(env);
  const first=env.controller.complete('active','model-a',{}); const rejected=assert.rejects(first,/CANCELLED/);
  const next=env.controller.complete('next','model-a',{}); await flush(); env.controller.abort('active');
  assert.equal(worker.messages.at(-1).action,'abort');
  await flush(); assert.equal(worker.messages.filter(m=>m.action==='complete').length,1);
  worker.reply('active',{ok:true,result:'late'}); await rejected; await flush();
  worker.reply('next',{ok:true,result:'next'}); assert.equal(await next,'next');
});
test('unknown abort IDs never poison future requests', async () => {
  const env=setup(); const worker=await loaded(env);
  for(let i=0;i<1000;i++)env.controller.abort('unknown-'+i);
  const request=env.controller.complete('unknown-0','model-a',{}); await flush();
  worker.reply('unknown-0',{ok:true,result:'ok'}); assert.equal(await request,'ok');
});

test('GPU readiness requires native full offload and model buffer; logger discards prompt content', () => {
  const info = emptyGpuInfo(); info.vendor = 'nvidia'; info.deviceCreated = true;
  observeGpuLog(info, 'load_tensors: offloaded 0/29 layers to GPU');
  observeGpuLog(info, 'load_tensors: WebGPU0 model buffer size = 1760.25 MiB');
  assert.throws(() => verifyGpuOffload(info), /OFFLOAD_UNVERIFIED/);
  observeGpuLog(info, 'load_tensors: offloaded 29/29 layers to GPU');
  observeGpuLog(info, 'tokenizer.chat_template = secret-template');
  observeGpuLog(info, { prompt: 'secret-prompt' });
  verifyGpuOffload(info); assert.equal(info.verified, true);
  assert.equal(JSON.stringify(info).includes('secret'), false);
  assert.equal(info.nativeBackend, 'WebGPU0');
  const noNative = emptyGpuInfo(); noNative.vendor = 'nvidia'; noNative.deviceCreated = true;
  assert.throws(() => verifyGpuOffload(noNative), /OFFLOAD_UNVERIFIED/);
});

test('native GPU guard rejects software adapters and reports actual device loss', async () => {
  for (const info of [{ vendor:'google', architecture:'swiftshader', isFallbackAdapter:true }, { vendor:'nvidia', architecture:'blackwell' }]) {
    const events = []; const gpu = { requestAdapter: async () => ({ info }) };
    runInNewContext(`(${installGpuGuard.toString()})();`, { navigator: { gpu }, self: { postMessage: value => events.push(value) } });
    await assert.rejects(gpu.requestAdapter(), /SOFTWARE_ADAPTER/);
    assert.equal(events.at(-1).args[0].error, 'LOCAL_GPU_SOFTWARE_ADAPTER');
  }
  let lose; const events = [], device = { lost: new Promise(done => lose=done), addEventListener() {} };
  const gpu = { requestAdapter: async () => ({ info:{ vendor:'nvidia', architecture:'blackwell', isFallbackAdapter:false }, requestDevice:async()=>device }) };
  runInNewContext(`(${installGpuGuard.toString()})();`, { navigator: { gpu }, self: { postMessage: value => events.push(value) } });
  const adapter=await gpu.requestAdapter(); await adapter.requestDevice();
  assert.equal(events.at(-1).args[0].deviceCreated,true);lose();await flush();
  assert.equal(events.at(-1).args[0].error,'LOCAL_GPU_DEVICE_LOST');
});

test('fatal GPU loss releases active and queued requests and allows fresh model load', async () => {
  const env=setup(), worker=await loaded(env);
  const active=env.controller.complete('active','model-a',{}), queued=env.controller.complete('queued','model-a',{});
  const a=assert.rejects(active,/GPU_DEVICE_LOST/), b=assert.rejects(queued,/GPU_DEVICE_LOST/);await flush();
  worker.onmessage({data:{fatal:true,error:'LOCAL_GPU_DEVICE_LOST'}});await Promise.all([a,b]);
  assert.equal(worker.terminated,true);assert.equal(env.controller.snapshot().phase,'error');assert.equal(env.controller.snapshot().queued,0);
  await loaded(env,'reloaded');assert.equal(env.controller.snapshot().phase,'ready');
});


test('32 shared callers overlap on eight runtime slots in one worker and retain metrics', async () => {
  let clock=0; const workers=[];
  const controller=new LocalController(()=>{const worker=new FakeWorker();workers.push(worker);return worker;},()=>clock);
  const loading=controller.load('a',{mode:'custom',parallel:16}); const worker=workers[0];
  const requested=worker.messages[0].config;
  worker.reply(worker.messages[0].id,{ok:true,model:{id:'a'},requested,runtime:{...requested,parallel:8,contextTokens:4096},nativeSlots:8}); await loading;
  const promises=Array.from({length:32},(_,i)=>controller.complete('r'+i,'a',{}));
  assert.equal(workers.length,1); assert.equal(controller.snapshot().active,8); assert.equal(controller.snapshot().queued,24);
  let dispatched=0;
  for(let i=0;i<32;i++) {
    assert.ok(controller.snapshot().active<=8); clock+=10;
    worker.reply('r'+i,{ok:true,result:{value:i,danlingo_local:{queueMs:-1,inferenceMs:10,gpuExecutionMs:null,reasoning:false,maxTokens:128}}});
    const calls=worker.messages.filter(m=>m.action==='complete').length;
    assert.equal(calls,Math.min(32,9+i)); dispatched=calls;
  }
  const results=await Promise.all(promises);
  assert.equal(dispatched,32); assert.equal(results[8].danlingo_local.queueMs,10);
  assert.equal(controller.snapshot().completed,32); assert.equal(controller.snapshot().peakActive,8);
  assert.equal(controller.snapshot().active,0); assert.equal(controller.snapshot().queued,0);
  assert.equal(controller.snapshot().lastMetrics.queueMs,240);
});

test('warming and telemetry do not publish ready or release native slots', async () => {
  const env=setup(), loading=env.controller.load('a',{mode:'custom',parallel:8}), worker=env.workers[0];
  worker.onmessage({data:{stage:'warming'}}); assert.equal(env.controller.snapshot().phase,'warming');
  assert.equal(env.controller.snapshot().runtime,undefined);
  await assert.rejects(env.controller.complete('early','a',{}),/NOT_LOADED/);
  worker.onmessage({data:{telemetry:{nativeSlots:4,nativePeakActive:2,gpu:{allocatedBytes:123}}}});
  assert.equal(env.controller.snapshot().phase,'warming'); assert.equal(env.controller.snapshot().nativeSlots,4);
  worker.reply(worker.messages[0].id,{ok:true,model:{id:'a'},runtime:{...worker.messages[0].config,parallel:2,contextTokens:2048},nativeSlots:2,warmupMs:15});
  await loading; const a=env.controller.complete('a','a',{}), b=env.controller.complete('b','a',{}), c=env.controller.complete('c','a',{});
  worker.onmessage({data:{id:'a',telemetry:{nativePeakActive:2}}});
  assert.equal(env.controller.snapshot().active,2); assert.equal(env.controller.snapshot().queued,1);
  worker.reply('a',{ok:true,result:1}); worker.reply('b',{ok:true,result:2}); worker.reply('c',{ok:true,result:3});
  await Promise.all([a,b,c]); assert.equal(env.controller.snapshot().warmupMs,15);
});

test('normalized configuration is load identity and replacement rejects all old work', async () => {
  const env=setup(), loading=env.controller.load('a',{mode:'custom',parallel:2}); const worker=env.workers[0];
  const shared=env.controller.load('a',{parallel:2,mode:'custom'}); assert.equal(env.workers.length,1);
  worker.reply(worker.messages[0].id,{ok:true,model:{id:'a'}}); await Promise.all([loading,shared]);
  await env.controller.load('a',{mode:'custom',parallel:2}); assert.equal(env.workers.length,1);
  const jobs=[0,1,2].map(i=>env.controller.complete('old'+i,'a',{})); const rejects=jobs.map(job=>assert.rejects(job,/MODEL_CHANGED/));
  const replacement=env.controller.load('a',{mode:'custom',parallel:4}); assert.equal(worker.terminated,true); assert.equal(env.workers.length,2);
  await Promise.all(rejects); worker.reply('old0',{ok:true,result:'late'});
  const next=env.workers[1]; next.reply(next.messages[0].id,{ok:true,model:{id:'a'}}); await replacement;
  assert.equal(env.controller.snapshot().runtime.parallel,4); assert.equal(env.controller.snapshot().completed,0);
});

test('runtime accepts native parallel values above the former 32-slot cap and keeps warnings separate', async () => {
  const env = setup(); const loading = env.controller.load('a', { mode:'custom', parallel:64 }); const worker = env.workers[0];
  worker.reply(worker.messages[0].id, { ok:true, model:{id:'a'}, runtime:{ ...worker.messages[0].config, parallel:64, contextTokens:32768 },
    fallbackReasons:[], warnings:['LOCAL_CONTEXT_ABOVE_TRAINING_LIMIT'] });
  await loading;
  assert.equal(env.controller.snapshot().runtime.parallel,64);
  assert.deepEqual(env.controller.snapshot().fallbackReasons,[]);
  assert.deepEqual(env.controller.snapshot().warnings,['LOCAL_CONTEXT_ABOVE_TRAINING_LIMIT']);
});

test('normal capacity remains available and a single SC yields cooperatively only once', async () => {
  const env=setup(), loading=env.controller.load('a',{mode:'custom',parallel:2}), worker=env.workers[0];
  worker.reply(worker.messages[0].id,{ok:true,model:{id:'a'}}); await loading;
  const s1=env.controller.complete('s1','a',{strategy:'superchat'}), s2=env.controller.complete('s2','a',{strategy:'superchat'});
  assert.equal(env.controller.snapshot().active,1); assert.equal(env.controller.snapshot().queued,1);
  const n=env.controller.complete('n','a',{strategy:'normal'}); assert.equal(env.controller.snapshot().active,2);
  worker.reply('s1',{ok:true,result:1}); assert.equal(worker.messages.at(-1).id,'s2');
  worker.reply('s2',{ok:true,result:2}); worker.reply('n',{ok:true,result:3}); await Promise.all([s1,s2,n]);
  const one=setup(), single=await loaded(one);
  const sc=one.controller.complete('sc','model-a',{strategy:'superchat'}); const cancelled=assert.rejects(sc,/CANCELLED/);
  const normal=one.controller.complete('normal','model-a',{}); one.controller.abort('sc');
  assert.equal(single.messages.filter(m=>m.action==='abort').length,1);
  assert.equal(single.messages.filter(m=>m.action==='complete').length,1);
  assert.equal(one.controller.snapshot().cancelled,0); assert.equal(one.controller.snapshot().active,1);
  single.reply('sc',{ok:true,result:'late'}); await cancelled;
  assert.equal(one.controller.snapshot().cancelled,1); single.reply('normal',{ok:true,result:'ok'}); await normal;
});

test('outstanding bound counts active plus waiting, queued abort is immediate and failures counted', async () => {
  const env=setup(), worker=await loaded(env);
  const jobs=Array.from({length:128},(_,i)=>env.controller.complete('r'+i,'model-a',{}));
  const settlements=jobs.map(job=>job.catch(error=>error.message));
  assert.equal(env.controller.snapshot().queued,127); await assert.rejects(env.controller.complete('overflow','model-a',{}),/QUEUE_FULL/);
  env.controller.abort('r127'); assert.equal(await settlements[127],'LOCAL_CANCELLED');
  assert.equal(env.controller.snapshot().queued,126); assert.equal(env.controller.snapshot().cancelled,1);
  worker.reply('r0',{ok:false,error:'LOCAL_INFERENCE_FAILED'}); assert.equal(await settlements[0],'LOCAL_INFERENCE_FAILED');
  assert.equal(env.controller.snapshot().failed,1); assert.equal(env.controller.snapshot().active,1);
  env.controller.unload(); await Promise.all(settlements); assert.equal(env.controller.snapshot().active,0);
});

test('fatal GPU loss rejects every native slot and waiter, and stale telemetry is ignored', async () => {
  const env=setup(), loading=env.controller.load('a',{mode:'custom',parallel:2}), worker=env.workers[0];
  worker.reply(worker.messages[0].id,{ok:true,model:{id:'a'},nativeEvidence:['native slots: 2']}); await loading;
  assert.deepEqual(env.controller.snapshot().nativeEvidence,['native slots: 2']);
  const jobs=[0,1,2].map(i=>env.controller.complete('r'+i,'a',{}));
  const rejected=jobs.map(job=>assert.rejects(job,/GPU_DEVICE_LOST/));
  worker.onmessage({data:{fatal:true,error:'LOCAL_GPU_DEVICE_LOST'}}); await Promise.all(rejected);
  assert.equal(env.controller.snapshot().failed,3); assert.equal(env.controller.snapshot().active,0);
  worker.onmessage({data:{telemetry:{nativePeakActive:999}}}); assert.notEqual(env.controller.snapshot().nativePeakActive,999);
  assert.equal(worker.terminated,true);
});

test('worker failure during content verification clears progress and stops the load', async () => {
  const env = setup(), loading = env.controller.load('a'), worker = env.workers[0];
  const rejected = assert.rejects(loading, /WORKER_FAILED/);
  worker.onmessage({ data: { stage: 'fingerprinting', verificationProgress: { bytesProcessed: 4, totalBytes: 16 } } });
  assert.equal(env.controller.snapshot().verificationProgress.bytesProcessed, 4);
  worker.onerror({ message: 'synthetic worker failure' });
  await rejected;
  const state = env.controller.snapshot();
  assert.equal(state.phase, 'error');
  assert.equal(state.verificationProgress, undefined);
  assert.equal(state.stage, undefined);
  assert.equal(worker.terminated, true);
});
