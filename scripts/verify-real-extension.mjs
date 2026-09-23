import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Real service + real native player. No mock response, fault injection or personal browser profile.
import { settingsSection } from './settings-navigation.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, cp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { completionEndpoint, PROMPT_VERSION } from '../src/core/config.ts';
import { needsTranslation } from '../src/core/messages.ts';
import { findNativePlayer, isNativePlayer } from '../src/platforms/niconico/native.ts';
import { readTestKey } from './verify-real-provider.mjs';
import { readUsage } from '../src/translation/provider.ts';

const endpoint=completionEndpoint(process.env.DANLINGO_E2E_ENDPOINT || '',true);
const isEdge=process.env.DANLINGO_E2E_BROWSER==='edge';
const root=resolve('.artifacts/p1/real',isEdge?'edge':'chrome');
await mkdir(root,{recursive:true});
const apiKey=await readTestKey();
const redact=value=>String(value).split(apiKey).join('[redacted]');
const report={capturedAt:new Date().toISOString(),evidence:'REAL-provider-REAL-Niconico-native-staging-and-screenshots',endpoint,promptVersion:PROMPT_VERSION,
  permissionLimit:'Only test manifest pregrants configured provider host; native optional-host consent remains a separate manual check.',
  timingLimit:'Preparation/filter-entry media error is not a pixel appearance measurement. RAF/long-task observations include the website and video.',
  checks:{},requests:[],phases:[],errors:[]};
const extension=resolve(root,'test-extension');
await cp('.output/chrome-mv3',extension,{recursive:true,force:true});
const manifest=JSON.parse(await readFile(resolve(extension,'manifest.json'),'utf8'));
manifest.host_permissions.push(`${new URL(endpoint).protocol}//${new URL(endpoint).hostname}/*`);
await writeFile(resolve(extension,'manifest.json'),JSON.stringify(manifest,null,2));
const {chromium}=await import(pathToFileURL(process.env.DANLINGO_PLAYWRIGHT_MODULE).href);
const playerExpression=`(() => { const isNativePlayer=${isNativePlayer.toString()}; return (${findNativePlayer.toString()})(location.pathname.split('/')[2]); })()`;
const native=(page,action)=>page.evaluate(`(async()=>{const p=${playerExpression};if(!p)throw new Error('Native player absent');${action}})()`);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(page,fn,arg,timeout=30000){
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await page.evaluate(fn,arg))return;await delay(100);}
  throw new Error('State wait timed out: '+String(fn).slice(0,120));
}
const quantiles=values=>{
  const a=values.filter(Number.isFinite).sort((a,b)=>a-b);
  const at=q=>a.length?Number(a[Math.min(a.length-1,Math.ceil(q*a.length)-1)].toFixed(2)):null;
  return {n:a.length,p50:at(.5),p95:at(.95),p99:at(.99),max:a.at(-1)??null};
};
let context,options,page,rpc;
const pendingResponses=new Set();
try {
  const profile=await mkdtemp(resolve('.artifacts/profiles/p1-real-'));
  context=await chromium.launchPersistentContext(profile,{headless:true,
    ...browserLaunchOptions(isEdge ? "edge" : "chromium"),
    viewport:{width:1440,height:1000},locale:'ja-JP',args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
  report.browserVersion=context.browser()?.version();
  const requests=new Map();
  context.on('request',request=>{
    if(request.url()!==endpoint || request.method()!=='POST')return;
    const body=request.postDataJSON();
    const inputs=JSON.parse(body.messages.find(m=>m.role==='user').content).items;
    const row={at:Date.now(),model:body.model,thinking:body.thinking,items:inputs.length,chars:inputs.reduce((n,m)=>n+m.text.length,0),ids:inputs.map(m=>m.id)};
    requests.set(request,row);report.requests.push(row);
    // Independent hard stop on accidental test request storms. At most already-active requests can finish.
    if(report.requests.length>=80){report.errors.push('Real test request budget reached');void rpc?.({type:'toggle',enabled:false}).catch(()=>{});}
  });
  context.on('requestfailed',request=>{
    const row=requests.get(request);if(row){row.elapsedMs=Date.now()-row.at;row.failed=true;}
  });
  context.on('response',response=>{
    const row=requests.get(response.request());if(!row)return;
    const operation=(async()=>{
      row.status=response.status();
      try{
        const body=await response.json();row.elapsedMs=Date.now()-row.at;
        row.usage=readUsage(body.usage);
        // Never store raw remote errors, reasoning contents or headers.
        const outputs=JSON.parse(body.choices?.[0]?.message?.content).items;
        if(Array.isArray(outputs))row.mappedIds=outputs.filter(x=>typeof x.id==='string').map(x=>x.id);
      }catch{row.bodyUnavailable=true;}
    })();
    pendingResponses.add(operation);void operation.finally(()=>pendingResponses.delete(operation));
  });
  const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
  const extensionId=new URL(worker.url()).host;
  options=await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  rpc=payload=>options.evaluate(payload=>chrome.runtime.sendMessage(payload),payload);
  await until(options,()=>!!document.getElementById('key-state')?.textContent);
  await options.locator('#endpoint').fill(endpoint.replace('/chat/completions',''));
  await settingsSection(options,'advanced'); await options.locator('#profile').evaluate(el=>el.closest('details').open=true); await options.locator('#profile').selectOption('deepseek');
  await options.locator('#local-http').check();
  await settingsSection(options,'service'); await options.locator('#api-key').fill(apiKey);
  await settingsSection(options,'watching'); await options.locator('#source-language').selectOption('ja');
  await options.locator('#enabled').uncheck();
  await settingsSection(options,'service'); await options.locator('#get-models').click();
  await until(options,()=>document.getElementById('models-result')?.textContent?.startsWith('已获取'),undefined,15000);
  const models=await options.locator('#model-list option').evaluateAll(nodes=>nodes.map(n=>n.value).filter(Boolean));
  const model=process.env.DANLINGO_E2E_MODEL || models.find(m=>m==='deepseek-flash') || models[0];
  assert.ok(models.includes(model));await options.locator('#model-list').selectOption(model);
  await options.locator('#save').click();
  await until(options,()=>document.getElementById('result')?.textContent==='已保存');
  report.models=models;report.settings=(await rpc({type:'settings'})).settings;
  report.checks.realModelDiscoveryAndSave=true;
  await options.screenshot({path:resolve(root,'options-real.png'),fullPage:true});
  await rpc({type:'clear-cache'});
  page=context.pages()[0]??await context.newPage();
  await page.addInitScript(()=>{
    const state=window.__DL_REAL__={snapshot:null,sources:new Map(),prepared:new Map(),stages:[],seen:new Set(),phase:'startup',frames:[],longTasks:[],enabledFrames:false};
    window.addEventListener('message',event=>{
      const d=event.data;
      if(event.source!==window || d?.bridge!=='danlingo.native.v1')return;
      const scope=`${d.resourceId}:${d.session}:${d.epoch}`;
      if(d.from==='native'&&d.type==='snapshot'){
        state.snapshot=d;
      }
      if(d.from==='native'&&d.type==='sources'){
        if(d.reset)state.sources.clear();
        for(const id of d.removes)state.sources.delete(id);
        for(const m of d.upserts)state.sources.set(m.id,m);
      }
      if(d.from==='content'&&d.type==='control'&&d.clear)state.prepared.clear();
      if(d.from==='content'&&d.type==='forget')for(const id of d.ids)state.prepared.delete(id);
      if(d.from==='content'&&d.type==='prepared')for(const m of d.items)state.prepared.set(m.id,{at:performance.now(),text:m.text});
    });
    let last;
    const frame=at=>{if(state.enabledFrames && last!==undefined && !document.hidden)state.frames.push({phase:state.phase,ms:at-last});last=at;requestAnimationFrame(frame);};
    requestAnimationFrame(frame);
    try{new PerformanceObserver(list=>{for(const e of list.getEntries())if(state.enabledFrames)state.longTasks.push({phase:state.phase,ms:e.duration});}).observe({type:'longtask',buffered:false});}catch{}
  });
  async function attachObserver(){
    await until(page,`!!${playerExpression}?.commentRenderer.layerProcessorList.every(l=>l.getStagingFilterNameList().includes('danlingo-text-v1'))`);
    return native(page,`
      for(const layer of p.commentRenderer.layerProcessorList){
        layer.removeStagingFilter('danlingo-evidence-v1');
        layer.addStagingFilter('danlingo-evidence-v1',(chat,settings)=>{
          const s=window.__DL_REAL__,d=s.snapshot;
          const id=JSON.stringify([p.watch.video.id,String(chat.thread??''),String(chat.fork??''),String(chat.id??'')]);
          const source=s.sources.get(id);
          if(!source?.translatable||!settings.visible)return settings;
          const scope=d?p.watch.video.id+':'+d.session+':'+d.epoch:'';
          const key=scope+':'+id;
          if(s.seen.has(key))return settings;s.seen.add(key);
          const ready=s.prepared.get(id);
          s.stages.push({phase:s.phase,id,original:chat.comment.body,text:settings.content,mediaMs:p.getCurrentTime()*1000,
            expectedStagingMs:source.renderAtMs,vposMs:chat.vposMs,position:chat.position,color:chat.color,size:chat.size,
            preparedBeforeFilter:!!ready&&ready.at<=performance.now(),preparedTextMatches:ready?.text===settings.content});
          return settings;
        });
      }
      return p.commentRenderer.layerProcessorList.map(l=>l.getStagingFilterNameList());
    `);
  }
  async function loadVideo(id){
    await rpc({type:'toggle',enabled:true});
    await page.goto('https://www.nicovideo.jp/watch/'+id,{waitUntil:'domcontentloaded',timeout:45000});
    await page.bringToFront();
    await until(page,()=>window.__DL_REAL__?.sources.size>0);
    await attachObserver();
    const originals=await native(page,'return p.commentRenderer.layerProcessorList.flatMap(l=>(l.stagingChatManager?.chatList??[]).map(c=>({id:String(c.id),body:c.comment?.body,vposMs:c.vposMs})));');
    const play=page.getByRole('button',{name:'再生する',exact:true});
    if(await play.isVisible())await play.click();else await native(page,'await p.getVideoElement().play();');
    await until(page,()=>window.__DL_REAL__.snapshot.clock.contentActive);
    return originals;
  }
  async function phase(name,seconds){
    const start=await page.evaluate(name=>{const s=window.__DL_REAL__;s.phase=name;s.enabledFrames=true;return {mediaMs:s.snapshot.clock.mediaTimeMs,at:performance.now()};},name);
    const engineBefore=(await rpc({type:'overview'})).engine;
    await until(page,mark=>window.__DL_REAL__.snapshot.clock.mediaTimeMs>=mark, start.mediaMs+seconds*1000,seconds*1000+30000);
    const data=await page.evaluate(name=>{const s=window.__DL_REAL__;s.enabledFrames=false;return {stages:s.stages.filter(x=>x.phase===name),frames:s.frames.filter(x=>x.phase===name).map(x=>x.ms),longTasks:s.longTasks.filter(x=>x.phase===name).map(x=>x.ms),clock:s.snapshot.clock};},name);
    const eligible=data.stages.filter(row=>needsTranslation(row.original,'zh-Hans','ja'));
    const prepared=eligible.filter(row=>row.preparedBeforeFilter && row.preparedTextMatches);
    // A native seek can reconstruct comments already in flight. Keep those observations,
    // but separate them from the timing of newly due comments after playback resumes.
    const newlyDue=eligible.filter(row=>row.expectedStagingMs>=start.mediaMs);
    const current=(await rpc({type:'overview'}));
    const result={name,start,mediaEndMs:data.clock.mediaTimeMs,observedEligible:eligible.length,preparedInTime:prepared.length,
      preparedRate:eligible.length?prepared.length/eligible.length:null,changedText:eligible.filter(row=>row.text!==row.original).length,
      stagingMediaErrorMs:quantiles(eligible.map(row=>Math.abs(row.mediaMs-row.expectedStagingMs))),
      newlyDue: {count:newlyDue.length,prepared:newlyDue.filter(row=>row.preparedBeforeFilter&&row.preparedTextMatches).length,
        stagingMediaErrorMs:quantiles(newlyDue.map(row=>Math.abs(row.mediaMs-row.expectedStagingMs)))},
      stagedFromEarlierTimes:eligible.length-newlyDue.length,
      rafIntervalsMs:quantiles(data.frames),longTasks:quantiles(data.longTasks),engineBefore,engineAfter:current.engine,status:current.status,
      samples:eligible};
    report.phases.push(result);console.log(JSON.stringify({phase:name,eligible:result.observedEligible,prepared:result.preparedInTime,changed:result.changedText,calls:current.engine.providerCalls}));
    await page.screenshot({path:resolve(root,name+'.png')});
    assert.ok(!report.errors.length,'Real request budget exceeded');
  }
  const originals=await loadVideo('sm1715919');
  await phase('first-play',12);
  await phase('steady',28);
  await native(page,'p.getVideoElement().pause();');
  const rows=await page.evaluate(()=>[...window.__DL_REAL__.sources.values()]);
  const bins=Array.from({length:6},(_,n)=>60+n*10).map(start=>({start,count:rows.filter(m=>m.translatable&&needsTranslation(m.originalText,'zh-Hans','ja')&&m.renderAtMs>=start*1000&&m.renderAtMs<(start+20)*1000).length})).sort((a,b)=>b.count-a.count);
  report.denseSelection={...bins[0],method:'Densest 20-second window among 60..110 seconds in the production-observed source window'};
  async function seek(time){
    await native(page,`p.setCurrentTime(${time});p.getVideoElement().pause();`);
    await until(page,time=>{const c=window.__DL_REAL__.snapshot.clock;return Math.abs(c.mediaTimeMs-time*1000)<500&&!c.seeking&&c.paused;},time);
    await native(page,'await p.getVideoElement().play();');
  }
  await seek(bins[0].start);await phase('dense-seek',20);
  await native(page,'p.getVideoElement().pause();');
  await seek(bins[0].start);await phase('cache-replay',12);
  await native(page,'p.getVideoElement().pause();');
  const after=new Map((await native(page,'return p.commentRenderer.layerProcessorList.flatMap(l=>(l.stagingChatManager?.chatList??[]).map(c=>({id:String(c.id),body:c.comment?.body,vposMs:c.vposMs})));')).map(m=>[m.id,m]));
  assert.ok(originals.length&&originals.every(m=>m.body===after.get(m.id)?.body&&m.vposMs===after.get(m.id)?.vposMs));
  report.checks.originalPoolPreserved=true;
  await native(page,'await p.stage.requestFullscreen();');
  await page.screenshot({path:resolve(root,'fullscreen-real.png')});
  await page.evaluate(()=>document.exitFullscreen());
  await loadVideo('sm9');await phase('second-video',22);
  await native(page,'p.getVideoElement().pause();');
  await until(options,async()=>{const s=(await chrome.runtime.sendMessage({type:'overview'})).engine;return s.activeRequests===0&&s.pendingItems===0;},undefined,15000);
  report.overview=await rpc({type:'overview'});
  await Promise.allSettled([...pendingResponses]);
  report.requestLatencyMs=quantiles(report.requests.filter(r=>r.status===200&&!r.failed&&r.elapsedMs!==undefined).map(r=>r.elapsedMs));
  report.completedMultiItemCalls=report.requests.filter(r=>r.status===200&&!r.failed&&r.items>1&&r.mappedIds?.length>1).length;
  assert.ok(report.completedMultiItemCalls>0,'No completed real multi-item request');
  assert.ok(report.phases.filter(p=>p.changedText>0).length>=3,'Insufficient real native translated text');
  const replayPhase=report.phases.find(p=>p.name==='cache-replay');
  assert.ok(replayPhase.observedEligible>0 && replayPhase.preparedInTime>0,'No prepared replay staging evidence');
  assert.equal(replayPhase.engineAfter.providerCalls,replayPhase.engineBefore.providerCalls,'Prepared replay should not submit more translations');
  assert.ok(!report.errors.length);
  report.result='PASS: real model discovery, real multi-item translation, native staging, real screenshot evidence and replay cache';
}catch(error){
  report.errors.push(redact(error.stack??error).slice(0,2000));process.exitCode=1;
  if(page)await page.screenshot({path:resolve(root,'failure.png')}).catch(()=>{});
}finally{
  if(rpc){await rpc({type:'toggle',enabled:false}).catch(()=>{});await rpc({type:'delete-key'}).catch(()=>{});}
  await context?.close();
  await writeFile(resolve(root,'report.json'),redact(JSON.stringify(report,null,2)));
  await writeFile(resolve(root,'run-'+report.capturedAt.replaceAll(/[:.]/g,'-')+'.json'),redact(JSON.stringify(report,null,2)));
}
console.log(JSON.stringify({report:resolve(root,'report.json'),result:report.result,errors:report.errors,latency:report.requestLatencyMs,calls:report.requests.length},null,2));
