import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalAutoLoader } from '../../src/local/auto-load.ts';
import { normalizeLocalConfig } from '../../src/local/config.ts';
const settings={backend:'local',localModelId:'fixture',localPerformance:normalizeLocalConfig()};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const flush=()=>new Promise(setImmediate);
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
