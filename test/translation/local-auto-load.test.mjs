import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalAutoLoader } from '../../src/local/auto-load.ts';
import { normalizeLocalConfig } from '../../src/local/config.ts';
const settings={backend:'local',localModelId:'fixture',localPerformance:normalizeLocalConfig()};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const flush=()=>new Promise(setImmediate);

test('hybrid readiness inspection never loads, renews demand, or overrides a manual unload',async()=>{
  const h=harness(), loader=new LocalAutoLoader(h.options);
  assert.equal(await loader.peekReady(settings),undefined);
  assert.equal(h.loads.length,0);
  assert.deepEqual(h.controls,[{action:'state'}]);
  h.setState(h.ready());assert.equal((await loader.peekReady(settings)).phase,'ready');
  assert.equal(await loader.peekReady({...settings,localPerformance:normalizeLocalConfig({mode:'custom',parallel:7})}),undefined);
  await loader.setPaused(true);const reads=h.controls.length;
  assert.equal(await loader.peekReady(settings),undefined);
  assert.equal(h.controls.length,reads);assert.equal(h.loads.length,0);
});
function harness(){
  const saved={}, events=[], loads=[], controls=[];
  let state={phase:'idle'};
  const options={storage:{get:async()=>structuredClone(saved),set:async v=>Object.assign(saved,structuredClone(v))},changed:s=>events.push(s),
    control:async c=>{controls.push(c);if(c.action==='state')return{ok:true,state};const wait=deferred();loads.push({c,wait});return wait.promise;}};
  const ready=()=>({phase:'ready',model:{id:'fixture'},requested:settings.localPerformance});
  return{options,loads,controls,events,ready,setState:s=>state=s};
}
test('simultaneous viewers share one ensure; ordinary request returns loading without holding its deadline',async()=>{
  const h=harness(), loader=new LocalAutoLoader(h.options);
  const reads=await Promise.allSettled([loader.ready(settings),loader.ready(settings),loader.ready(settings)]);
  await flush();
  assert.ok(reads.every(r=>r.reason.message==='LOCAL_MODEL_LOADING'));assert.equal(h.loads.length,1);
  const waiter=loader.ready(settings,true);h.loads[0].wait.resolve({ok:true,state:h.ready()});assert.equal((await waiter).phase,'ready');
  h.setState(h.ready());assert.equal((await loader.ready(settings)).phase,'ready');assert.equal(h.loads.length,1);
});
test('failure latches across service-worker restart; explicit load/resume alone clears it',async()=>{
  const h=harness(), loader=new LocalAutoLoader(h.options);
  await assert.rejects(loader.ready(settings),/LOCAL_MODEL_LOADING/);h.loads[0].wait.resolve({ok:false,error:'LOCAL_GPU_DEVICE_FAILED'});await flush();
  const restarted=new LocalAutoLoader(h.options);await assert.rejects(restarted.ready(settings),/LOCAL_GPU_DEVICE_FAILED/);assert.equal(h.loads.length,1);
  await restarted.setPaused(false);await assert.rejects(restarted.ready(settings),/LOCAL_MODEL_LOADING/);assert.equal(h.loads.length,2);
  h.loads[1].wait.resolve({ok:true,state:h.ready()});await flush();
});
test('unload pauses all rooms for browser session and rejects a late shared load result',async()=>{
  const h=harness(), loader=new LocalAutoLoader(h.options);
  await assert.rejects(loader.ready(settings),/LOCAL_MODEL_LOADING/);
  const revision=await loader.setPaused(true);assert.ok(revision>h.loads[0].c.policyRevision);
  h.loads[0].wait.resolve({ok:true,state:h.ready()});await flush();assert.equal((await loader.status()).paused,true);
  const restarted=new LocalAutoLoader(h.options);await assert.rejects(restarted.ready(settings),/LOCAL_AUTOLOAD_PAUSED/);
  await restarted.invalidate();await assert.rejects(restarted.ready({...settings,localModelId:'another-room-model'}),/LOCAL_AUTOLOAD_PAUSED/);
  assert.equal(h.loads.length,1);
});
test('fatal loaded runtime failure does not reload per chat; new configuration gets independent load',async()=>{
  const h=harness();h.setState({...h.ready(),phase:'error',error:'LOCAL_GPU_DEVICE_LOST'});const loader=new LocalAutoLoader(h.options);
  await assert.rejects(loader.ready(settings),/LOCAL_GPU_DEVICE_LOST/);await assert.rejects(loader.ready(settings),/LOCAL_GPU_DEVICE_LOST/);assert.equal(h.loads.length,0);
  await assert.rejects(loader.ready({...settings,localModelId:'new'}),/LOCAL_MODEL_LOADING/);assert.equal(h.loads.length,1);
  h.loads[0].wait.resolve({ok:false,error:'LOCAL_MODEL_CHANGED'});await flush();
});

test('automatic idle unload preserves policy and the next real admission reloads the same model',async()=>{
  const h=harness();h.setState(h.ready());const loader=new LocalAutoLoader(h.options);
  assert.equal((await loader.ready(settings)).phase,'ready');assert.equal(h.controls[0].demand,true);
  h.setState({phase:'idle'});await loader.observe({phase:'idle'});assert.equal((await loader.status()).paused,false);
  await assert.rejects(loader.ready(settings),/LOCAL_MODEL_LOADING/);assert.equal(h.loads.length,1);
  assert.equal(h.loads[0].c.modelId,'fixture');assert.equal(h.loads[0].c.policyRevision,0);
  h.loads[0].wait.resolve({ok:true,state:h.ready()});await flush();assert.equal((await loader.status()).paused,false);
});

test('explicit draft load is reused by viewers and survives a service-worker restart without another load',async()=>{
  const h=harness(), loader=new LocalAutoLoader(h.options);
  const draft=normalizeLocalConfig({mode:'custom',parallel:7}), state={...h.ready(),generation:3,requested:draft};
  h.setState(state);await loader.retainExplicitLoad(settings,state);
  assert.equal((await loader.ready(settings)).requested.parallel,7);
  const restarted=new LocalAutoLoader(h.options);
  assert.equal((await restarted.ready(settings)).requested.parallel,7);
  assert.equal(h.loads.length,0);
  assert.equal(settings.localPerformance.parallel,normalizeLocalConfig().parallel);
});

test('failed explicit draft load stays failed instead of retrying with saved parameters',async()=>{
  const h=harness(), loader=new LocalAutoLoader(h.options);
  const state={...h.ready(),generation:3,requested:normalizeLocalConfig({mode:'custom',parallel:7}),phase:'error',error:'LOCAL_GPU_DEVICE_FAILED'};
  h.setState(state);await loader.retainExplicitLoad(settings,state);
  await assert.rejects(loader.ready(settings),/LOCAL_GPU_DEVICE_FAILED/);
  await assert.rejects(new LocalAutoLoader(h.options).ready(settings),/LOCAL_GPU_DEVICE_FAILED/);
  assert.equal(h.loads.length,0);
});

test('fatal worker reset after a draft load does not silently reload with saved parameters',async()=>{
  const h=harness(), loader=new LocalAutoLoader(h.options);
  const state={...h.ready(),generation:3,requested:normalizeLocalConfig({mode:'custom',parallel:7})};
  h.setState(state);await loader.retainExplicitLoad(settings,state);
  const failed={...state,generation:4,phase:'error',error:'LOCAL_GPU_DEVICE_LOST'};h.setState(failed);await loader.observe(failed);
  await assert.rejects(loader.ready(settings),/LOCAL_GPU_DEVICE_LOST/);assert.equal(h.loads.length,0);
});

for(const ending of ['unload','config-change'])test(`explicit parameters expire on ${ending}`,async()=>{
  const h=harness(), loader=new LocalAutoLoader(h.options);
  const state={...h.ready(),generation:3,requested:normalizeLocalConfig({mode:'custom',parallel:7})};
  h.setState(state);await loader.retainExplicitLoad(settings,state);
  const next=ending==='config-change'?{...settings,localPerformance:normalizeLocalConfig({mode:'custom',parallel:2})}:settings;
  if(ending==='unload'){h.setState({phase:'idle',generation:4});await loader.observe({phase:'idle',generation:4});}
  await assert.rejects(loader.ready(next),/LOCAL_MODEL_LOADING/);await flush();
  assert.equal(h.loads.length,1);assert.deepEqual(h.loads[0].c.config,next.localPerformance);
  h.loads[0].wait.resolve({ok:true,state:{...h.ready(),requested:next.localPerformance}});await flush();
});
