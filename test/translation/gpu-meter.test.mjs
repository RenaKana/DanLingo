import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { installGpuMeter } from '../../src/local/gpu-meter.js';
import { installGpuGuard } from '../../src/local/gpu-worker-guard.js';

const usage = { QUERY_RESOLVE:1, COPY_SRC:2, COPY_DST:4, MAP_READ:8 };

test('native flush bypasses Wllama dispatch, waits for meter and bounds concurrent flush operations',async()=>{
  const reports=[];let listener, resolveFlush, flushCalls=0;
  const device={lost:new Promise(()=>{}),addEventListener(){}},adapter={info:{isFallbackAdapter:false},features:new Set(),requestDevice:async()=>device};
  const gpu={requestAdapter:async()=>adapter};
  runInNewContext(`(${installGpuGuard.toString()})(installMeter)`,{
    navigator:{gpu},URL, self:{location:{href:'https://extension/local/worker.js?measureGpu=1'},
      postMessage:value=>reports.push(value),addEventListener:(name,fn)=>{assert.equal(name,'message');listener=fn;}},
    installMeter:()=>({flush(){flushCalls++;return new Promise(resolve=>{resolveFlush=resolve;});}}),
  });
  await (await gpu.requestAdapter()).requestDevice();
  let stopped=0;const dispatch=id=>listener({data:{verb:'danlingo.gpu.flush',id},stopImmediatePropagation(){stopped++;}});
  dispatch(1);await Promise.resolve();dispatch(2);
  assert.equal(stopped,2);assert.equal(flushCalls,1);
  assert.equal(reports.at(-1).error,'LOCAL_GPU_TIMING_BUSY');assert.equal(reports.at(-1).id,2);
  resolveFlush({executionMs:9,pendingTimingRecords:0});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reports.at(-1).verb,'danlingo.gpu.flushed');assert.equal(reports.at(-1).id,1);
  assert.equal(reports.at(-1).metrics.executionMs,9);
});
function fixture({ supported=true, holdReads=false } = {}) {
  const buffers=[], queries=[], encoders=[], reports=[];
  let lose, clock=0;
  const device={ features:new Set(supported?['timestamp-query']:[]), lost:new Promise(resolve=>lose=resolve),
    createBuffer(descriptor) {
      assert.equal(this,device);
      const buffer={ size:descriptor.size, descriptor, bytes:new ArrayBuffer(descriptor.size), destroys:0, mapped:false,
        destroy() { assert.equal(this,buffer); this.destroys++; this.rejectMap?.(new Error('destroyed')); return 'destroy-result'; },
        mapAsync(mode) { assert.equal(mode,1); this.mapped=true; return holdReads?new Promise((resolve,reject)=>{this.resolveMap=resolve;this.rejectMap=reject;}):Promise.resolve(); },
        getMappedRange() { assert.equal(this.mapped,true); return this.bytes; }, unmap() { this.mapped=false; },
      }; buffers.push(buffer);return buffer;
    },
    createQuerySet(descriptor) { assert.equal(this,device); const query={descriptor,destroys:0,destroy(){this.destroys++;}}; queries.push(query); return query; },
    createCommandEncoder(descriptor) {
      assert.equal(this,device); const ops=[], passes=[];
      const encoder={descriptor,passes,ops,timestamps:[],
        beginComputePass(passDescriptor) {
          assert.equal(this,encoder); passes.push(passDescriptor);
          const pass={ calls:[], end(){},
            setPipeline(value,...args){assert.equal(this,pass);if(pass.setError)throw pass.setError;pass.currentPipeline=value;pass.calls.push(['set',value,...args]);return 'set-result';},
            dispatchWorkgroups(...args){assert.equal(this,pass);if(pass.dispatchError)throw pass.dispatchError;pass.calls.push(['direct',...args]);return 'dispatch-result';},
            dispatchWorkgroupsIndirect(...args){assert.equal(this,pass);if(pass.dispatchError)throw pass.dispatchError;pass.calls.push(['indirect',...args]);return 'indirect-result';},
          };return pass;
        },
        resolveQuerySet(query,first,count,destination,offset) {assert.equal(this,encoder); ops.push(()=>{const view=new DataView(destination.bytes);for(let i=0;i<count;i++)view.setBigUint64(offset+i*8,encoder.timestamps[i]??0n,true);});},
        copyBufferToBuffer(source,from,destination,to,size) {assert.equal(this,encoder);ops.push(()=>new Uint8Array(destination.bytes,to,size).set(new Uint8Array(source.bytes,from,size)));},
        finish(descriptor) {assert.equal(this,encoder);return {ops,descriptor};},
      };encoders.push(encoder);return encoder;
    },
    destroy() {assert.equal(this,device);return 'device-destroy-result';},
  };
  device.queue={submit(commands){assert.equal(this,device.queue);for(const command of commands)for(const op of command.ops)op();return 'submit-result';}};
  // Exercise the actual serialization contract, without module closures or imports.
  const install=runInNewContext(`(${installGpuMeter.toString()})`,{queueMicrotask,performance:{now:()=>clock},GPUBufferUsage:usage,GPUMapMode:{READ:1}});
  return {device,buffers,queries,encoders,reports,lose,install,advance(ms){clock+=ms;},timing(on=true){return install(device,value=>reports.push(value),on);}};
}

test('actual app buffer bytes, idempotent destroy accounting and batched reports', async()=>{
  const f=fixture(), meter=f.timing(false);
  const buffer=f.device.createBuffer({size:64,usage:16}), other=f.device.createBuffer({size:128,usage:16});
  assert.equal(meter.snapshot().allocatedBytes,192);assert.equal(meter.snapshot().peakAllocatedBytes,192);
  assert.equal(f.reports.length,0);await meter.flush();assert.equal(f.reports.length,1);
  assert.equal(buffer.destroy(),'destroy-result');buffer.destroy();
  assert.equal(meter.snapshot().allocatedBytes,128);assert.equal(meter.snapshot().peakAllocatedBytes,192);
  other.destroy();await meter.flush();assert.equal(meter.snapshot().allocatedBytes,0);
  assert.equal('executionMs' in meter.snapshot(),false);assert.equal(meter.snapshot().timestampQueries,false);
});

test('unsupported timestamp queries preserve pass descriptors and never fabricate timing',async()=>{
  const f=fixture({supported:false}), original=f.device.createCommandEncoder,meter=f.timing();
  const encoder=f.device.createCommandEncoder();encoder.beginComputePass({label:'app pass'}).end();f.device.queue.submit([encoder.finish()]);
  await meter.flush();assert.notEqual(f.device.createCommandEncoder,original);assert.equal(encoder.passes[0].label,'app pass');assert.equal(encoder.passes[0].timestampWrites,undefined);assert.equal(f.queries.length,0);
  assert.equal(meter.snapshot().timestampQueries,false);assert.equal('executionMs' in meter.snapshot(),false);
});

test('encoded compute timestamp deltas aggregate after submission and internal buffers are excluded',async()=>{
  const f=fixture(),meter=f.timing();
  const encoder=f.device.createCommandEncoder({label:'app encoder'});encoder.timestamps=[1000000n,3500000n,4000000n,4500000n];
  const descriptor={label:'app pass'};encoder.beginComputePass(descriptor).end();encoder.beginComputePass().end();
  assert.equal('timestampWrites' in descriptor,false);assert.equal(encoder.passes[0].label,'app pass');
  assert.equal(encoder.passes[1].timestampWrites.beginningOfPassWriteIndex,2);
  const command=encoder.finish({label:'app command'});assert.equal(command.descriptor.label,'app command');
  assert.equal(meter.snapshot().allocatedBytes,0);assert.equal('executionMs' in meter.snapshot(),false);
  assert.equal(f.device.queue.submit([command]),'submit-result');await meter.flush();
  assert.equal(meter.snapshot().executionMs,3);assert.equal(meter.snapshot().timedComputePasses,2);
  assert.equal(f.queries[0].destroys,1);assert.ok(f.buffers.every(buffer=>buffer.destroys===1));
  const next=f.device.createCommandEncoder();next.timestamps=[5n,1000005n];next.beginComputePass().end();f.device.queue.submit([next.finish()]);
  await meter.flush();assert.equal(meter.snapshot().executionMs,4);assert.equal(meter.snapshot().pendingTimingRecords,0);
});

test('existing timestamps and per-encoder exhaustion preserve passes and report uncovered work',async()=>{
  const f=fixture(),meter=f.timing(),encoder=f.device.createCommandEncoder();
  const descriptor={timestampWrites:{querySet:{app:true},beginningOfPassWriteIndex:0}};
  encoder.beginComputePass(descriptor).end();assert.equal(encoder.passes[0],descriptor);
  for(let i=0;i<1025;i++)encoder.beginComputePass({label:'pass'+i}).end();
  assert.equal(encoder.passes[1024].timestampWrites.endOfPassWriteIndex,2047);assert.equal(encoder.passes[1025].timestampWrites,undefined);
  f.device.queue.submit([encoder.finish()]);await meter.flush();
  assert.equal(f.queries[0].descriptor.count,2048);assert.equal(meter.snapshot().missedComputePasses,2);assert.equal(meter.snapshot().timedComputePasses,1024);
});

test('deep-model encoder measures more than 64 passes and flush waits only for pending readbacks',async()=>{
  const f=fixture({holdReads:true}),meter=f.timing(),encoder=f.device.createCommandEncoder();
  for(let i=0;i<180;i++) {
    encoder.beginComputePass().end();
    encoder.timestamps.push(BigInt(i)*2000000n,BigInt(i)*2000000n+1000000n);
  }
  assert.equal(f.device.queue.submit([encoder.finish()]),'submit-result');
  let flushed=false;const flushing=meter.flush().then(value=>{flushed=true;return value;});
  await Promise.resolve();assert.equal(flushed,false);assert.equal(meter.snapshot().pendingTimingRecords,1);
  f.buffers.at(-1).resolveMap();const metrics=await flushing;
  assert.equal(metrics.executionMs,180);assert.equal(metrics.timedComputePasses,180);
  assert.equal(metrics.missedComputePasses,0);assert.equal(metrics.pendingTimingRecords,0);
  assert.equal(f.queries.length,1);assert.equal(f.queries[0].descriptor.count,2048);
  assert.ok(f.buffers.every(buffer=>buffer.size===180*2*8&&buffer.destroys===1));
});

test('pending timestamp resources are bounded and released on device loss without blocking submit',async()=>{
  const f=fixture({holdReads:true}),meter=f.timing();
  for(let i=0;i<80;i++){const encoder=f.device.createCommandEncoder();encoder.beginComputePass().end();assert.equal(f.device.queue.submit([encoder.finish()]),'submit-result');}
  assert.equal(f.queries.length,64);assert.equal(f.buffers.length,128);assert.equal(meter.snapshot().pendingTimingRecords,64);
  assert.equal(meter.snapshot().missedComputePasses,16);assert.equal(meter.snapshot().recordLimitMisses,16);
  assert.equal(meter.snapshot().peakTimingRecords,64);assert.equal('executionMs' in meter.snapshot(),false);
  f.lose();await meter.flush();assert.equal(meter.snapshot().pendingTimingRecords,0);
  assert.ok(f.queries.every(query=>query.destroys===1));assert.ok(f.buffers.every(buffer=>buffer.destroys===1));
});

test('invalid timestamp pairs are excluded, and destroy releases unsubmitted probes',async()=>{
  const f=fixture(),meter=f.timing(),encoder=f.device.createCommandEncoder();
  encoder.timestamps=[100n,50n,1000000n,2000000n];encoder.beginComputePass().end();encoder.beginComputePass().end();
  f.device.queue.submit([encoder.finish()]);await meter.flush();assert.equal(meter.snapshot().executionMs,1);assert.equal(meter.snapshot().missedComputePasses,1);
  const abandoned=f.device.createCommandEncoder();abandoned.beginComputePass().end();abandoned.finish();
  f.device.createBuffer({size:64,usage:16});assert.equal(f.device.destroy(),'device-destroy-result');
  await meter.flush();assert.equal(meter.snapshot().allocatedBytes,0);assert.equal(meter.snapshot().pendingTimingRecords,0);
  assert.ok(f.queries.every(query=>query.destroys===1));
});

test('readback rejection cleans resources, records missing coverage and allows later probes',async()=>{
  const f=fixture({holdReads:true}),meter=f.timing(),encoder=f.device.createCommandEncoder();
  encoder.beginComputePass().end();f.device.queue.submit([encoder.finish()]);
  f.buffers.find(buffer=>buffer.rejectMap).rejectMap(new Error('mapping failed'));
  await meter.flush();assert.equal(meter.snapshot().pendingTimingRecords,0);assert.equal(meter.snapshot().timingReadFailures,1);
  assert.equal(meter.snapshot().missedComputePasses,1);assert.equal('executionMs' in meter.snapshot(),false);
  assert.ok(f.buffers.every(buffer=>buffer.destroys===1));
  const next=f.device.createCommandEncoder();next.beginComputePass().end();f.device.queue.submit([next.finish()]);
  const read=f.buffers.at(-1);read.resolveMap();await meter.flush();assert.equal(meter.snapshot().timedComputePasses,1);
});

test('submit rejection preserves the app exception and releases never-submitted probes',async()=>{
  const f=fixture();const failure=new Error('submit failure');f.device.queue.submit=()=>{throw failure;};
  const meter=f.timing(),encoder=f.device.createCommandEncoder();encoder.beginComputePass().end();const command=encoder.finish();
  assert.throws(()=>f.device.queue.submit([command]),error=>error===failure);await meter.flush();
  assert.equal(meter.snapshot().pendingTimingRecords,0);assert.equal(meter.snapshot().missedComputePasses,1);
  assert.ok(f.buffers.every(buffer=>buffer.destroys===1));assert.equal(f.queries[0].destroys,1);
});


test('async pipeline latency preserves binding and results, counts concurrent pending work without GPU timestamps',async()=>{
  const f=fixture({supported:false}), calls=[], deferred=[];
  f.device.createComputePipelineAsync=function(...args){assert.equal(this,f.device);calls.push(args);return new Promise((resolve,reject)=>deferred.push({resolve,reject}));};
  const meter=f.timing(false), descriptor={label:'dynamic shape'};
  const first=f.device.createComputePipelineAsync(descriptor,'extra');f.advance(10);
  const second=f.device.createComputePipelineAsync({label:'other shape'});
  assert.equal(meter.snapshot().pipelineCreationPending,2);assert.equal(meter.snapshot().pipelineCreationCount,0);
  assert.equal(calls[0][0],descriptor);assert.equal(calls[0][1],'extra');
  f.advance(20);const pipeline={pipeline:true};deferred[0].resolve(pipeline);assert.equal(await first,pipeline);
  assert.equal(meter.snapshot().pipelineCreationPending,1);assert.equal(meter.snapshot().pipelineCreationAsyncMs,30);
  f.advance(5);const failure=new Error('compile rejection');const rejected=assert.rejects(second,error=>error===failure);deferred[1].reject(failure);await rejected;
  await meter.flush();const snapshot=meter.snapshot();
  assert.equal(snapshot.pipelineCreationPending,0);assert.equal(snapshot.pipelineCreationCount,2);assert.equal(snapshot.pipelineCreationAsyncCount,2);
  assert.equal(snapshot.pipelineCreationMs,55);assert.equal(snapshot.pipelineCreationMaxMs,30);assert.equal(snapshot.pipelineCreationFailures,1);
  assert.equal(snapshot.timestampQueries,false);assert.equal('executionMs' in snapshot,false);
  assert.equal(f.reports.at(-1).pipelineCreationMs,55);
});

test('sync pipeline creation preserves returned object and thrown error, including async API synchronous throws',async()=>{
  const f=fixture(), expected={pipeline:true}, failure=new Error('validation failure');
  f.device.createComputePipeline=function(descriptor){assert.equal(this,f.device);f.advance(4);if(descriptor.fail)throw failure;return expected;};
  f.device.createComputePipelineAsync=function(){assert.equal(this,f.device);f.advance(2);throw failure;};
  const meter=f.timing(false);
  assert.equal(f.device.createComputePipeline({}),expected);assert.throws(()=>f.device.createComputePipeline({fail:true}),error=>error===failure);
  assert.throws(()=>f.device.createComputePipelineAsync({}),error=>error===failure);
  await meter.flush();const snapshot=meter.snapshot();
  assert.equal(snapshot.pipelineCreationAsyncMaxMs,2);assert.equal(snapshot.pipelineCreationSyncMaxMs,4);assert.equal(snapshot.pipelineCreationSyncCount,2);assert.equal(snapshot.pipelineCreationSyncMs,8);
  assert.equal(snapshot.pipelineCreationAsyncCount,1);assert.equal(snapshot.pipelineCreationAsyncMs,2);
  assert.equal(snapshot.pipelineCreationCount,3);assert.equal(snapshot.pipelineCreationMs,10);
  assert.equal(snapshot.pipelineCreationFailures,2);assert.equal(snapshot.pipelineCreationPending,0);assert.equal(snapshot.pipelineCreationMaxMs,4);
});



test('known flash kernel creation alone is not use; successful dispatch observes it with timing disabled',async()=>{
  const f=fixture({supported:false});f.device.createComputePipeline=function(descriptor){assert.equal(this,f.device);return {label:descriptor.label};};
  const meter=f.timing(false), pipeline=f.device.createComputePipeline({label:'flash_attn_vec_blk_kvt32_wg1024',compute:{entryPoint:'main'}});
  await meter.flush();assert.equal(meter.snapshot().flashAttentionObserved,false);assert.equal(meter.snapshot().flashAttentionKernel,undefined);
  const encoder=f.device.createCommandEncoder(),pass=encoder.beginComputePass();
  assert.equal(pass.setPipeline(pipeline,'extra'),'set-result');assert.equal(pass.calls[0][2],'extra');
  assert.equal(meter.snapshot().flashAttentionObserved,false);pass.dispatchWorkgroups(0);
  assert.equal(meter.snapshot().flashAttentionObserved,false);
  assert.equal(pass.dispatchWorkgroups(2,3,4),'dispatch-result');
  assert.equal(meter.snapshot().flashAttentionObserved,true);assert.equal(meter.snapshot().flashAttentionKernel,'flash_attn_vec_blk_kvt32_wg1024');
  await meter.flush();const reportCount=f.reports.length;pass.dispatchWorkgroups(1);await meter.flush();assert.equal(f.reports.length,reportCount);
  assert.equal(meter.snapshot().timestampQueries,false);assert.equal('executionMs' in meter.snapshot(),false);
});

test('async entrypoint recognition, non-FA pipeline switching and indirect dispatch preserve selection',async()=>{
  const f=fixture();f.device.createComputePipelineAsync=async descriptor=>({label:descriptor.label});
  const meter=f.timing(), fa=await f.device.createComputePipelineAsync({label:'app',compute:{entryPoint:'flash_attn_tile'}});
  const ordinary=await f.device.createComputePipelineAsync({label:'flash_attn_tile_not_exact',compute:{entryPoint:'main'}});
  const encoder=f.device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(fa);pass.setPipeline(ordinary);pass.dispatchWorkgroups(1);
  assert.equal(meter.snapshot().flashAttentionObserved,false);
  pass.setPipeline(fa);const indirect={buffer:true};assert.equal(pass.dispatchWorkgroupsIndirect(indirect,16),'indirect-result');
  assert.equal(pass.calls.at(-1)[1],indirect);assert.equal(pass.calls.at(-1)[2],16);
  assert.equal(meter.snapshot().flashAttentionKernel,'flash_attn_tile');
  pass.end();f.device.queue.submit([encoder.finish()]);await meter.flush();assert.equal(meter.snapshot().timedComputePasses,1);
});

test('failed dispatch never supplies FA evidence and failed set preserves the previous pipeline',async()=>{
  const f=fixture();f.device.createComputePipeline=descriptor=>({label:descriptor.label});const meter=f.timing(false);
  const ordinary=f.device.createComputePipeline({label:'ordinary'}),fa=f.device.createComputePipeline({label:'flash_attn_vec_reduce'});
  const pass=f.device.createCommandEncoder().beginComputePass();pass.setPipeline(ordinary);
  const failure=new Error('invalid command');pass.setError=failure;assert.throws(()=>pass.setPipeline(fa),error=>error===failure);pass.dispatchWorkgroups(1);
  assert.equal(meter.snapshot().flashAttentionObserved,false);pass.setError=undefined;pass.setPipeline(fa);pass.dispatchError=failure;
  assert.throws(()=>pass.dispatchWorkgroups(1),error=>error===failure);assert.equal(meter.snapshot().flashAttentionObserved,false);
  pass.dispatchError=undefined;pass.dispatchWorkgroups(1);assert.equal(meter.snapshot().flashAttentionKernel,'flash_attn_vec_reduce');
});

test('pipeline labels are character-filtered and bounded without suppressing known-kernel recognition',async()=>{
  const f=fixture();f.device.createComputePipeline=descriptor=>({label:descriptor.resultLabel});const meter=f.timing(false);
  f.device.createComputePipeline({label:'unsafe\nlabel',compute:{entryPoint:'x'.repeat(81)},resultLabel:'秘密'});
  assert.equal(meter.snapshot().pipelineLabels.length,0);
  for(let i=0;i<40;i++)f.device.createComputePipeline({label:'safe-'+i});
  assert.equal(meter.snapshot().pipelineLabels.length,32);assert.ok(meter.snapshot().pipelineLabels.every(name=>/^[A-Za-z0-9_. -]{1,80}$/.test(name)));
  const fa=f.device.createComputePipeline({resultLabel:'flash_attn_vec'}),pass=f.device.createCommandEncoder().beginComputePass();pass.setPipeline(fa);pass.dispatchWorkgroups(1);
  assert.equal(meter.snapshot().flashAttentionObserved,true);assert.equal(meter.snapshot().pipelineLabels.length,32);
});
