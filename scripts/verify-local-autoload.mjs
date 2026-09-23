import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Real GGUF/GPU with production background/controller, simulated room-session producer.
import assert from 'node:assert/strict';
import {cp,mkdir,mkdtemp,readFile,writeFile,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const model=process.argv[2]??'D:/Tool/Models/LmStudioModels/lmstudio-community/HY-MT1.5-1.8B-FP8/HY-MT1.5-1.8B-Q8_0.gguf';
const original=await stat(model),root=resolve('.artifacts/local-autoload');await mkdir(root,{recursive:true});const dir=await mkdtemp(resolve(root,'run-')),extension=resolve(dir,'extension');
await cp(resolve('.output/chrome-mv3'),extension,{recursive:true});const manifest=JSON.parse(await readFile(resolve(extension,'manifest.json'),'utf8'));
manifest.content_scripts=manifest.content_scripts.filter(entry=>entry.js?.some(path=>path.includes('settings-host')));
manifest.content_scripts.push({matches:['https://live.nicovideo.jp/watch/*'],js:['session-fixture.js'],run_at:'document_idle'});
await writeFile(resolve(extension,'manifest.json'),JSON.stringify(manifest));
await writeFile(resolve(extension,'session-fixture.js'),`const session={platform:'niconico',scenario:'live',resourceId:location.pathname.split('/').pop(),sessionId:crypto.randomUUID(),generation:0};
chrome.runtime.onMessage.addListener(m=>{if(m.type==='verify-live-session')return Promise.resolve({ok:JSON.stringify(m.session)===JSON.stringify(session)});});
chrome.runtime.sendMessage({type:'session-open',session}).then(r=>document.documentElement.dataset.session=String(r.ok));
document.getElementById('translate').addEventListener('click',async()=>{const reply=await chrome.runtime.sendMessage({type:'translate',resourceId:session.resourceId,session,requestId:crypto.randomUUID(),sentAt:performance.timeOrigin+performance.now(),items:[{id:crypto.randomUUID(),text:'这个视频非常有趣。',strategy:'normal',remainingMs:120000}]});document.getElementById('result').textContent=JSON.stringify(reply);});`);
const report={evidence:'REAL_GGUF_GPU_PRODUCTION_BACKGROUND_WITH_SIMULATED_LIVE_SESSIONS',checks:{},errors:[],network:[],model,bytes:original.size};
const {chromium}=await loadPlaywright();
let context;
const until=async(fn,label)=>{const deadline=Date.now()+180000;while(Date.now()<deadline){const r=await fn();if(r)return r;await new Promise(r=>setTimeout(r,100));}throw new Error('Timeout: '+label);};
try{
 context=await chromium.launchPersistentContext(resolve(dir,'profile'),{headless:true,...browserLaunchOptions("chromium"),args:['--disable-extensions-except='+extension,'--load-extension='+extension,'--disable-background-networking','--no-first-run']});
 await context.route('https://live.nicovideo.jp/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><button id="translate">translate fixture</button><pre id="result"></pre>'}));
 await context.route(/https?:\/\/(?!live\.nicovideo\.jp)/,r=>{report.network.push(new URL(r.request().url()).origin);return r.abort();});
 const background=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker'),origin='chrome-extension://'+new URL(background.url()).host;
 const options=await context.newPage();options.on('pageerror',e=>report.errors.push(e.message));options.on('dialog',d=>d.accept());await options.goto(origin+'/options.html');await options.waitForFunction(()=>document.querySelector('#result')?.textContent==='已保存');
 await options.locator('#backend').selectOption('local');await options.locator('#local-file').setInputFiles(model);await options.waitForFunction(()=>document.querySelector('#local-model').value&&!document.querySelector('#local-file').disabled,{},{timeout:180000});
 const saved=await options.evaluate(()=>chrome.runtime.sendMessage({type:'settings'}));report.modelId=saved.settings.localModelId;assert.ok(report.modelId);
 // Arrange a saved enabled configuration as on a new browser startup, without invoking a UI load/save handler.
 await options.evaluate(s=>chrome.storage.local.set({'settings.v1':{...s,backend:'local',enabled:true,sourceLanguage:'zh',liveSourceLanguage:'zh',targetLanguage:'ja',requestTimeoutMs:120000,liveBufferMs:120000}}),saved.settings);
 await options.close();
 const rooms=await Promise.all([11,22].map(async id=>{const p=await context.newPage();await p.goto('https://live.nicovideo.jp/watch/lv'+id);await p.waitForFunction(()=>document.documentElement.dataset.session==='true');return p;}));
 const launcher=await context.newPage();await launcher.goto(origin+'/popup.html');
 const rpc=m=>launcher.evaluate(m=>chrome.runtime.sendMessage(m),m),state=async()=>(await rpc({type:'local-control',control:{action:'state'}})).state;
 report.cold=await until(async()=>{const s=await state();if(s?.phase==='error')throw new Error(s.error);return s?.phase==='ready'?s:null;},'shared automatic model load');
 assert.equal(report.cold.gpu.verified,true);assert.equal(report.cold.model.id,report.modelId);assert.equal(report.cold.generation,1,'two cold rooms share one native load');report.checks.coldWithoutSettingsAndSharedLoad=true;
 await rooms[0].locator('#translate').click();await rooms[0].waitForFunction(()=>document.getElementById('result').textContent,{},{timeout:120000});report.translation=JSON.parse(await rooms[0].locator('#result').textContent());assert.equal(report.translation.ok,true);assert.ok(report.translation.items.some(row=>row.status==='translated'));report.checks.realTranslationAfterAutoload=true;
 await rpc({type:'local-control',control:{action:'unload'}});assert.equal((await state()).phase,'idle');
 await rooms[0].goto('https://live.nicovideo.jp/watch/lv33');await rooms[0].waitForFunction(()=>document.documentElement.dataset.session==='true');assert.equal((await rpc({type:'settings'})).localRuntime.paused,true);assert.equal((await state()).phase,'idle');report.checks.roomChangeKeepsPause=true;
 const cdp=await context.newCDPSession(launcher);await cdp.send('ServiceWorker.enable');await cdp.send('ServiceWorker.stopAllWorkers');
 const restarted=await rpc({type:'settings'});assert.equal(restarted.localRuntime.paused,true);assert.equal((await state()).phase,'idle');report.checks.backgroundRestartKeepsPause=true;
 await rpc({type:'toggle',enabled:false});await rpc({type:'toggle',enabled:true});
 report.resumed=await until(async()=>{const s=await state();if(s.phase==='error')throw new Error(s.error);return s.phase==='ready'?s:null;},'reenable resumes');assert.ok(report.resumed.generation>report.cold.generation);report.checks.reenableLoadsAgain=true;
 await rpc({type:'local-control',control:{action:'unload'}});assert.equal((await state()).phase,'idle');
 assert.deepEqual(report.network,[]);assert.equal((await stat(model)).mtimeMs,original.mtimeMs);assert.equal((await stat(model)).size,original.size);report.checks.originalUntouchedNoOnlineFallback=true;report.status='PASS';
}catch(e){report.status='FAIL';report.errors.push(e.stack??String(e));process.exitCode=1;}
finally{await context?.close();await writeFile(resolve(dir,'report.json'),JSON.stringify(report,null,2));console.log('REPORT',resolve(dir,'report.json'));console.log(JSON.stringify({status:report.status,checks:report.checks,errors:report.errors}));}
