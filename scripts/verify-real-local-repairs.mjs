import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Real existing GGUF + production live engine; YouTube DOM is an explicitly synthetic fixture.
import assert from 'node:assert/strict';
import { mkdir, cp, mkdtemp, writeFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/core/config.ts';
import { ROOM, watchHtml, chatHtml } from '../test/fixtures/youtube-native-chat.mjs';

const modelPath=process.argv[2]??'D:/Tool/Models/LmStudioModels/lmstudio-community/HY-MT1.5-1.8B-FP8/HY-MT1.5-1.8B-Q8_0.gguf';
const root=resolve('.artifacts/real-local-repairs');await mkdir(root,{recursive:true});
const directory=await mkdtemp(resolve(root,'run-')),extension=resolve(directory,'extension');
await cp(resolve('.output/chrome-mv3'),extension,{recursive:true});
const original=await stat(modelPath),started=Date.now(),source='この動画はとても面白いです。';
const report={capturedAt:new Date().toISOString(),evidence:'REAL_GGUF_PRODUCTION_LIVE_ENGINE_SYNTHETIC_YOUTUBE_DOM',modelPath,source,checks:{},network:{syntheticFulfilled:[],blocked:[]},samples:[],errors:[],limitations:['Synthetic native YouTube DOM, not actual YouTube or actual paid messages.','One cold generation is not warm steady-state/P95 performance.','CPU times and process working sets cover this isolated Chromium instance; no physical GPU utilization measurement.']};
let context,options,page,modelId,cdp,rpc;
const pause=ms=>new Promise(done=>setTimeout(done,ms));
async function until(fn,label,timeout=20000){const end=Math.min(started+235000,Date.now()+timeout);while(Date.now()<end){const value=await fn();if(value)return value;await pause(100);}throw new Error('Timeout: '+label);}
async function state(){return (await rpc({type:'local-control',control:{action:'state'}})).state;}
const frame=()=>page.frames().find(f=>new URL(f.url()||'about:blank').pathname==='/live_chat');
async function sample(label){
  const value={label,atMs:Date.now()-started,state:await state()};
  try{
    const processes=(await cdp.send('SystemInfo.getProcessInfo')).processInfo;value.processes=processes;
    const ids=processes.map(p=>p.id).filter(Number.isSafeInteger);assert.ok(ids.length&&ids.length<100);
    const command=`Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,WorkingSet64,PeakWorkingSet64,@{Name='CpuSeconds';Expression={$_.TotalProcessorTime.TotalSeconds}} | ConvertTo-Json -Compress`;
    value.memory=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',windowsHide:true,timeout:5000}).trim());
  }catch(error){value.telemetryError=error.message;}
  report.samples.push(value);console.log('SAMPLE',JSON.stringify(value));return value.state;
}
async function addRows(count,prefix,kind='paid'){
  await frame().evaluate(({count,prefix,kind,source})=>{
    const list=document.querySelector('yt-live-chat-item-list-renderer');
    for(let index=0;index<count;index++){
      const id=prefix+index,row=document.createElement(kind==='paid'?'yt-live-chat-paid-message-renderer':'yt-live-chat-text-message-renderer');
      row.dataset.case=id;row.style.cssText='display:block;background:#145e7a;padding:8px;margin:4px;color:#fff';
      row.data={id,message:{simpleText:source},authorName:{simpleText:'Synthetic donor'},purchaseAmountText:{simpleText:'$10.00'}};
      const author=document.createElement('span');author.className='author';author.textContent=id+' · $10.00 ';
      const message=document.createElement('span');message.id='message';message.textContent=source;row.append(author,message);list.append(row);
    }
    list.lastElementChild.scrollIntoView({block:'nearest'});
  },{count,prefix,kind,source});
}
async function translatedRows(prefix,count,timeout=20000){
  return until(async()=>{
    const rows=await frame().locator(`[data-case^="${prefix}"]`).evaluateAll(nodes=>nodes.map(node=>({state:node.getAttribute('data-danlingo-state'),text:node.querySelector('#message').textContent})));
    if(rows.some(row=>['failed','expired'].includes(row.state)))throw new Error('Native translation failed: '+JSON.stringify(rows));
    return rows.length===count&&rows.every(row=>row.state==='translated'&&row.text.trim()&&row.text!==source)?rows:null;
  },prefix+' all translated',timeout);
}
const watchdog=setTimeout(()=>{report.errors.push('240 second hard runtime budget');context?.close().finally(()=>{process.exitCode=1;});},240000);
try{
  assert.ok(original.size<2**31);
  const {chromium}=await loadPlaywright();
  context=await chromium.launchPersistentContext(await mkdtemp(resolve(directory,'profile-')),{headless:true,...browserLaunchOptions("chromium"),viewport:{width:1360,height:850},args:['--disable-extensions-except='+extension,'--load-extension='+extension,'--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--host-resolver-rules=MAP * ~NOTFOUND']});
  cdp=await context.browser().newBrowserCDPSession();
  const emptyChat=chatHtml.replace(/^owner\.handleAddChatItemAction_\(\{item:\{liveChatTextMessageRenderer:\{id:'baseline'.*$/m,'');
  assert.ok(!emptyChat.includes("id:'baseline'"));
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin==='https://www.youtube.com'&&['/watch','/live_chat'].includes(url.pathname)){
      report.network.syntheticFulfilled.push(url.href);return route.fulfill({status:200,contentType:'text/html',body:url.pathname==='/watch'?watchHtml:emptyChat});
    }
    if(['http:','https:'].includes(url.protocol)){report.network.blocked.push(url.href);return route.abort();}
    return route.continue();
  });
  const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
  options=await context.newPage();await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  rpc=message=>options.evaluate(message=>chrome.runtime.sendMessage(message),message);
  await options.locator('#backend').selectOption('local');await options.locator('#local-file').setInputFiles(modelPath);await options.locator('#local-import').click();
  modelId=await until(()=>options.locator('#local-model').inputValue(),'import');
  await options.locator('#local-load').click();await until(async()=>{const s=await state();if(s.phase==='error')throw new Error(s.error);return s.phase==='ready';},'load');
  const settings=normalizeSettings({...DEFAULT_SETTINGS,enabled:true,backend:'local',localModelId:modelId,model:'HY-MT1.5-1.8B-Q8_0',profile:'chat-completions',thinkingEffort:'default',superChatThinkingEffort:'inherit',superChatTimeoutMs:120000,requestTimeoutMs:120000,thinkingRequestTimeoutMs:120000,sourceLanguage:'ja',liveSourceLanguage:'ja',targetLanguage:'zh-Hans',batchSize:1,concurrency:1,liveAdaptiveConcurrency:false,liveMaxBatchWaitMs:0});
  assert.equal((await rpc({type:'save',settings,apiKey:'',remember:false})).ok,true);
  page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));await page.goto('https://www.youtube.com/watch?v='+ROOM);await page.bringToFront();
  await until(async()=>frame()&&await frame().locator('[data-danlingo-repairs]').count()===1,'repair UI');
  await sample('before-100');assert.equal((await state()).inferenceCalls,0);
  report.before=await rpc({type:'overview'});const inferenceStart=Date.now();
  await addRows(100,'sc-');
  await until(async()=>{
    const rows=await frame().locator('[data-case^="sc-"]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('data-danlingo-state')));
    const s=await state();assert.ok(s.inferenceCalls<=1,'at most one inference for all initial subscribers');
    return s.inferenceCalls===1&&rows.length===100&&rows.every(value=>value==='translating');
  },'100 pending subscribers and one real inference');
  report.pending=await rpc({type:'overview'});report.checks.hundredDistinctPendingBeforeFirstResponse=true;
  await sample('100-pending');
  let sampleAt=Date.now();
  await until(async()=>{
    const s=await state();assert.ok(s.inferenceCalls<=1,'no duplicate inference');
    if(Date.now()-sampleAt>20000){await sample('during-inference');sampleAt=Date.now();}
    return s.phase==='ready';
  },'real live generation',125000);
  report.generationMs=Date.now()-inferenceStart;
  report.rows=await translatedRows('sc-',100);assert.equal(new Set(report.rows.map(r=>r.text)).size,1);
  report.checks.hundredSubscribersOneRealInference=true;report.afterInitial=await rpc({type:'overview'});await sample('after-100');
  const cacheStart=Date.now();await addRows(1,'cached-');await translatedRows('cached-',1);report.cacheRepeatMs=Date.now()-cacheStart;assert.equal((await state()).inferenceCalls,1);report.checks.completedCacheNoInference=true;
  await addRows(1,'manual-','ordinary');
  await until(async()=>await frame().locator('[data-case="manual-0"]').getAttribute('data-danlingo-state')==='unprocessed','missed ordinary source before manual click');
  assert.equal(await frame().locator('[data-case="manual-0"] #message').textContent(),source);
  const manualStart=Date.now();await frame().getByRole('button',{name:'补翻全部漏译',exact:true}).click();await translatedRows('manual-',1);report.manualCacheMs=Date.now()-manualStart;
  assert.equal((await state()).inferenceCalls,1);report.checks.actualManualButtonUsesSuccessfulCache=true;
  await sample('after-cache-and-manual');report.final=await rpc({type:'overview'});
  report.screenshot=resolve(directory,'real-translated-native-chat.png');await page.screenshot({path:report.screenshot});
  assert.deepEqual(report.network.blocked,[]);assert.equal(report.network.syntheticFulfilled.length,2);report.checks.noExternalHttpCdnCloud=true;
  const after=await stat(modelPath);assert.equal(after.size,original.size);assert.equal(after.mtimeMs,original.mtimeMs);report.checks.originalFileSizeAndMtimeUnchanged=true;
  assert.deepEqual(report.errors,[]);report.status='PASS';
}catch(error){report.status='FAIL';report.errors.push(error.stack);process.exitCode=1;console.error(error);}
finally{
  try{if(rpc){report.finalState=await state();await rpc({type:'local-control',control:{action:'unload'}});if(modelId)await rpc({type:'local-control',control:{action:'delete',modelId}});report.checks.isolatedImportedCopyRemoved=true;}}catch(error){report.cleanupError=error.message;}
  clearTimeout(watchdog);await context?.close();report.totalMs=Date.now()-started;
  await writeFile(resolve(directory,'report.json'),JSON.stringify(report,null,2));await writeFile(resolve(root,'report.json'),JSON.stringify(report,null,2));console.log('REPORT',resolve(root,'report.json'),report.status,report.totalMs);
}
