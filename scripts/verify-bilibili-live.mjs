import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/core/config.ts';
import { decodeTranslationFixtureRequest, encodeTranslationFixtureResponse } from './translation-protocol-fixture.mjs';
import { liveHtml } from '../test/fixtures/bilibili-live-native.mjs';

const timeoutOnly=process.argv.includes('--timeout-retry'),emotesOnly=process.argv.includes('--mixed-emotes'),paidOnly=process.argv.includes('--paid-history');
const dir=resolve('.artifacts/bilibili/'+(timeoutOnly?'timeout-':emotesOnly?'mixed-emotes-':'live-')+new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(dir,{recursive:true});
const report={evidence:'production extension + synthetic native page + loopback mock only',checks:{},requests:[],errors:[],screenshots:[],realProvider:false};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async(fn,label,ms=15000)=>{const end=Date.now()+ms;while(Date.now()<end){const r=await fn();if(r)return r;await delay(40);}throw new Error('Timed out: '+label);};
const persist=()=>writeFile(resolve(dir,'report.json'),JSON.stringify(report,null,2));
let context,server,page,options,rpc;const held=new Set(),calls=new Map(),prefix='【模拟译文】';
const replyPlans=new Map(),replyWaits=new Map();
const holdReply=(text,...attempts)=>replyPlans.set(text,new Set(attempts));
const releaseReply=(text,attempt)=>{const key=JSON.stringify([text,attempt]);replyWaits.get(key)?.();replyWaits.delete(key);};
const release=()=>{for(const resolve of held)resolve();held.clear();};
const check=async(name,fn)=>{report.phase=name;try{report.checks[name]={status:'PASS',...await fn()};console.log('PASS '+name);}catch(e){report.checks[name]={status:'FAIL',error:e.message};throw e;}finally{await persist();}};
const evidence=()=>page.evaluate(()=>window.__BILI_FIXTURE__.evidence);
const messages=()=>page.evaluate(()=>window.__BILI_MESSAGES__);
const fire=(id,text,mode)=>page.evaluate(({id,text,mode})=>window.__BILI_FIXTURE__.fire(id,text,mode),{id,text,mode});
const insertion=id=>wait(async()=> (await evidence()).chat.find(r=>r.id===String(id)),'chat '+id);
const connected=()=>wait(async()=> (await messages()).filter(r=>r.type==='snapshot').at(-1)?.presentationActive===true,'active native binding');
try{
 server=createServer(async(req,res)=>{res.setHeader('access-control-allow-origin','*');res.setHeader('access-control-allow-headers','authorization,content-type');if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  if(req.method!=='POST'||req.url!=='/v1/chat/completions'){res.writeHead(404);res.end();return;}
  try{let body='';for await(const c of req){body+=c;if(body.length>1000000)throw Error('request too large');}const decoded=decodeTranslationFixtureRequest(JSON.parse(body));assert.ok(report.requests.length<150);
   const texts=decoded.items.map(r=>r.text);report.requests.push({phase:report.phase,texts,at:Date.now()});
   let block=report.phase==='one-click-stop-cancels-only-owned-work';const versions=new Map();for(const text of texts){const count=(calls.get(text)||0)+1;calls.set(text,count);versions.set(text,count);if(text.includes('HELD')&&count===1)block=true;}
   if(timeoutOnly||emotesOnly) await Promise.all(texts.filter(text=>replyPlans.get(text)?.has(versions.get(text))).map(text=>new Promise(resolve=>{
    const release=()=>{held.delete(release);resolve();};held.add(release);replyWaits.set(JSON.stringify([text,versions.get(text)]),release);
   })));
   else if(block)await new Promise(r=>held.add(r));else if(texts.some(t=>t.includes('ORDER_HEAD')))await delay(450);
   const reply=encodeTranslationFixtureResponse(decoded,decoded.items.map(r=>({id:r.id,text:prefix+'v'+versions.get(r.text)+' '+(r.text.includes('LONG')||r.text.includes('长译文')?'这是一段用于检查原生卡片换行和布局的长译文。'.repeat(10):'')+(r.text.includes('LOSE_EMOTE')&&versions.get(r.text)===1?r.text.replace(/\[\[DL:[^\]]+\]\]/,''):r.text)})));res.setHeader('content-type',reply.contentType);res.end(reply.body);
  }catch(e){report.errors.push(e.message);res.writeHead(500);res.end('{}');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const endpoint='http://127.0.0.1:'+server.address().port+'/v1/chat/completions';
 const build=resolve('.output/chrome-mv3'),extension=resolve(dir,'extension');await cp(build,extension,{recursive:true});
 const manifest=JSON.parse(await readFile(resolve(extension,'manifest.json'),'utf8'));manifest.host_permissions.push('http://127.0.0.1/*');await writeFile(resolve(extension,'manifest.json'),JSON.stringify(manifest));
 const {chromium}=await loadPlaywright();
 context=await chromium.launchPersistentContext(await mkdtemp(resolve(dir,'profile-')),{...browserLaunchOptions('chromium'),headless:true,viewport:{width:1280,height:900},args:['--disable-extensions-except='+extension,'--load-extension='+extension,'--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
 await context.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin==='https://live.bilibili.com')return route.fulfill({contentType:'text/html',body:liveHtml});if(u.origin==='https://fixture.invalid'&&u.pathname.startsWith('/emote/'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="11" fill="#ffc850"/><path d="M7 9h2m6 0h2M7 15q5 5 10 0" stroke="#333" fill="none"/></svg>'});if(u.origin===new URL(endpoint).origin||!['http:','https:'].includes(u.protocol))return route.continue();return route.abort();});
 await context.addInitScript(()=>{window.__BILI_MESSAGES__=[];window.addEventListener('message',e=>{if(e.source===window&&e.origin===location.origin&&e.data?.bridge==='danlingo-live-v1'&&window.__BILI_MESSAGES__.length<20000)window.__BILI_MESSAGES__.push(e.data);});});
 if(!timeoutOnly&&!emotesOnly)await context.addInitScript(()=>{window.__BILI_PREEXISTING_SC__=true;window.__BILI_DISABLE_HEARTBEAT__=true;window.__BILI_DELAY_ENGINE__=true;});
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');options=await context.newPage();await options.goto('chrome-extension://'+new URL(worker.url()).host+'/options.html');rpc=payload=>options.evaluate(payload=>chrome.runtime.sendMessage(payload),payload);
 const config=normalizeSettings({...DEFAULT_SETTINGS,enabled:true,endpoint,allowLocalHttp:true,model:'bilibili-fixture',thinkingEffort:'default',sourceLanguage:'ja',liveSourceLanguage:'ja',concurrency:4,batchSize:1,liveMaxBatchWaitMs:0,liveBufferMs:2000,liveAdaptiveConcurrency:false,superChatTimeoutMs:5000});
 assert.equal((await rpc({type:'save',settings:config,apiKey:'synthetic-bilibili-fixture-only',remember:false})).ok,true);
 page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));await page.goto('https://live.bilibili.com/777');await page.bringToFront();
 if(!timeoutOnly&&!emotesOnly){
  await wait(async()=>(await messages()).some(r=>r.type==='snapshot'&&r.reason==='native-entry-unavailable'),'pending engine initialization');
  assert.equal(report.requests.length,0,'no request is lost into a disconnected content bridge');
  await page.evaluate(()=>window.__BILI_FIXTURE__.enableEngine());
 }
 await connected();
 if(!timeoutOnly&&!emotesOnly){
  await check('preexisting-paid-history-translates-before-first-engine-event-and-force-uses-original',async()=>{
   const card=page.locator('[data-fixture-sc-history="preexisting"]'),body=card.locator('.input-contain .text');
   await wait(async()=>(await body.textContent()).startsWith(prefix),'preexisting SC');
   assert.equal((await messages()).filter(r=>r.type==='snapshot').at(-1).reason,'superchat-only');
   assert.equal(await page.locator('[data-id_str="preexisting-normal"] .danmaku-item-right').textContent(),'接続前の普通コメントです');
   assert.equal(report.requests.some(r=>r.texts.includes('接続前の普通コメントです')),false);
   await card.locator('[data-danlingo-bili-retry]').click();
   await wait(async()=>(await body.textContent()).startsWith(prefix+'v2 '),'preexisting force');
   assert.equal(await card.getAttribute('data-danmaku'),'接続前の醒目な応援メッセージです');
   assert.equal(await card.locator('.card-item-top-right').textContent(),'20电池');
   assert.equal(await card.locator('.input-trans-contain .text').textContent(),'native-translation-slot');
   const path=resolve(dir,'preexisting-20-battery.png');await page.screenshot({path});report.screenshots.push(path);
   await page.evaluate(()=>{window.__BILI_DISABLE_HEARTBEAT__=false;});
   await wait(async()=>(await messages()).filter(r=>r.type==='snapshot').at(-1)?.reason==='','ordinary engine upgrade');
   assert.ok((await body.textContent()).startsWith(prefix+'v2 '),'upgrade preserves the paid record');
   await card.evaluate(el=>el.remove());await page.locator('[data-id_str="preexisting-normal"]').evaluate(el=>el.remove());
   return{ordinaryHistoryUntouched:true,paidBeforeSocket:true,freshForce:true,metadataIntact:true};
  });
  await check('20-battery-history-only-card-with-zero-pin-time-translates-and-recycles-safely',async()=>{
   await page.evaluate(()=>{window.__GREAT_TOILET__?.({cmd:'SUPER_CHAT_MESSAGE',data:{id:9001,message:'二十電池の応援コメントです',price:2,end_time:0,time:0}});window.__BILI_FIXTURE__.historySc('cheap','二十電池の応援コメントです');});
   const card=page.locator('[data-fixture-sc-history="cheap"]'),body=card.locator('.input-contain .text');
   await wait(async()=>(await body.textContent()).startsWith(prefix),'history-only paid translation');
   const request=(await messages()).find(r=>r.type==='repair-request'&&r.originalText==='二十電池の応援コメントです');assert.equal(request.strategy,'superchat');
   assert.equal(await card.locator('.card-item-top-right').textContent(),'20电池');
   await card.evaluate(el=>{el.setAttribute('data-danmaku','別の新しい応援コメントです');el.setAttribute('data-ts',String(Date.now()));el.querySelector('.input-contain .text').textContent='別の新しい応援コメントです';});
   await wait(async()=>(await body.textContent()).includes(prefix+'v1 別の新しい応援コメントです'),'recycled paid original');
   await card.evaluate(el=>el.remove());return{noPriceFilter:true,noPinLifetimeRequiredForHistory:true,recycledOriginalIsolated:true};
  });
  await check('idless-paid-recycle-and-detach-cancel-stale-work-without-recreating-cards',async()=>{
   await page.evaluate(()=>window.__BILI_FIXTURE__.historySc('held-history','HELD_HISTORY 古い応援コメントです'));
   const card=page.locator('[data-fixture-sc-history="held-history"]'),body=card.locator('.input-contain .text');
   await wait(()=>report.requests.some(r=>r.texts.includes('HELD_HISTORY 古い応援コメントです')),'held old history');
   const old=(await messages()).find(r=>r.type==='repair-request'&&r.originalText==='HELD_HISTORY 古い応援コメントです');
   await card.evaluate(el=>{el.setAttribute('data-danmaku','再利用された新しい応援です');el.setAttribute('data-ts',String(Date.now()));el.querySelector('.input-contain .text').textContent='再利用された新しい応援です';});
   await wait(async()=>(await body.textContent()).startsWith(prefix+'v1 再利用された新しい応援です'),'new history wins');
   await wait(async()=>(await messages()).some(r=>r.type==='repair-cancel'&&r.requestId===old.requestId),'old request cancelled');
   release();await delay(100);assert.ok((await body.textContent()).startsWith(prefix+'v1 再利用された新しい応援です'));await card.evaluate(el=>el.remove());
   await page.evaluate(()=>window.__BILI_FIXTURE__.historySc('removed-history','HELD_REMOVED 消える応援コメントです'));
   await wait(()=>report.requests.some(r=>r.texts.includes('HELD_REMOVED 消える応援コメントです')),'held removed history');
   const removed=(await messages()).find(r=>r.type==='repair-request'&&r.originalText==='HELD_REMOVED 消える応援コメントです');
   await page.locator('[data-fixture-sc-history="removed-history"]').evaluate(el=>el.remove());
   await wait(async()=>(await messages()).some(r=>r.type==='repair-cancel'&&r.requestId===removed.requestId),'removed request cancelled');
   release();await delay(100);assert.equal(await page.locator('[data-fixture-sc-history="removed-history"]').count(),0);
   return{oldResponseCannotOverwrite:true,removedCardNotReinserted:true};
  });
  // Start the existing ordinary-message checks in a fresh native generation;
  // pre-extension originals above are real fixture renders, not new admissions.
  const seedSession=(await messages()).filter(r=>r.type==='snapshot').at(-1).adapterSession;
  await page.evaluate(()=>{window.__BILI_FIXTURE__.rebuild();for(const key of ['dispatch','screen','chat'])window.__BILI_FIXTURE__.evidence[key].length=0;});
  await wait(async()=>(await messages()).filter(r=>r.type==='snapshot').at(-1)?.adapterSession!==seedSession,'fresh ordinary verification generation');await connected();
 }
 if(paidOnly) { /* The bounded paid-history checks above are the complete requested probe. */ }
 else if(timeoutOnly) {
  const settings=async patch=>{
   const previous=(await messages()).filter(r=>r.type==='snapshot').at(-1)?.adapterSession;
   assert.equal((await rpc({type:'save',settings:{...config,...patch},remember:false})).ok,true);
   await wait(async()=> (await messages()).filter(r=>r.type==='snapshot').at(-1)?.adapterSession!==previous,'new settings generation');await connected();
  };
  const attempts=text=>report.requests.filter(r=>r.texts.includes(text));
  const attempted=(text,n)=>wait(()=>attempts(text).length===n,'provider attempt '+n+' for '+text);
  const body=id=>page.locator('[data-id_str="'+id+'"] .danmaku-item-right');
  const original='超时自动补翻测试のコメント';
  await check('same-language-and-symbols-stay-unneeded-with-zero-timeouts-and-manual-force-retained',async()=>{
   await settings({liveSourceLanguage:'zh',targetLanguage:'zh-Hans',bilibiliTimeoutRetryEnabled:true});
   const samples=[['same-zh','何意味'],['same-paper','论文我去'],['same-question','论文吗'],['symbols-only','？'],['same-repeat','走走走'],['laughter-only','www草！！！']];
   for(const [id,text] of samples){await fire(id,text);assert.equal((await insertion(id)).text,text);}
   await wait(async()=>{const rows=await messages();return samples.every(([id])=>rows.findLast(row=>row.type==='repair-record'&&row.sourceId==='dm:'+id)?.state==='unneeded');},'unneeded native records');
   await wait(async()=>(await messages()).filter(row=>row.type==='snapshot').at(-1)?.liveMetrics.original===samples.length,'original presentation metrics');
   const snapshot=(await messages()).filter(row=>row.type==='snapshot').at(-1);
   assert.equal(snapshot.liveMetrics.timedOut,0);assert.equal(snapshot.liveMetrics.pending,0);assert.equal(snapshot.recentEligible,0);
   assert.equal((await messages()).some(row=>row.type==='repair-request'&&samples.some(([id])=>row.sourceId==='dm:'+id)),false);
   for(const [,text] of samples)assert.equal(attempts(text).length,0);
   await page.getByText('近期弹幕补翻',{exact:true}).click();
   const recent=text=>page.locator('#danlingo-live-repairs .entry').filter({has:page.getByText(text,{exact:true})});
   for(const [,text] of samples){await wait(async()=>await recent(text).getAttribute('data-state')==='unneeded','unneeded recent row');assert.equal(await recent(text).locator('.state').textContent(),'无需翻译');}
   assert.match(await page.locator('#danlingo-live-status #metrics').textContent(),/超时原文 0/);
   const path=resolve(dir,'same-language-unneeded.png');await page.screenshot({path});report.screenshots.push(path);
   await recent(samples[0][1]).getByRole('button',{name:'强制重译',exact:true}).click();
   await wait(async()=>await body(samples[0][0]).textContent()===prefix+'v1 '+samples[0][1],'manual force updates native original');
   await wait(async()=>await recent(samples[0][1]).getAttribute('data-state')==='translated','manual force updates recent row');
   assert.equal(attempts(samples[0][1]).length,1);
   assert.equal((await evidence()).chat.filter(row=>row.id===samples[0][0]).length,1,'manual repair does not re-emit native occurrence');
   await page.getByText('近期弹幕补翻',{exact:true}).click();await settings({});
   return{unneeded:samples.length,automaticRequests:0,timedOut:0,manualForcePreserved:true};
  });
  await check('disabled-keeps-first-deadline-no-second-call',async()=>{
   const id='retry-off',text=original+'OFF';holdReply(text,1);const at=Date.now();await fire(id,text);
   assert.equal((await insertion(id)).text,text);assert.equal(attempts(text).length,1);
   releaseReply(text,1);await delay(150);assert.equal(await body(id).textContent(),text);
   assert.equal((await messages()).some(r=>r.type==='repair-request'&&r.sourceId==='dm:'+id),false);
   assert.equal((await messages()).findLast(r=>r.type==='repair-record'&&r.sourceId==='dm:'+id).state,'expired');
   await page.getByText('近期弹幕补翻',{exact:true}).click();
   const recent=page.locator('#danlingo-live-repairs .entry').filter({has:page.getByText(text,{exact:true})});
   await wait(async()=>await recent.getAttribute('data-state')==='expired','real timeout recent row');
   assert.equal(await recent.locator('.state').textContent(),'超时');
   await wait(async()=>(await page.locator('#danlingo-live-status #metrics').textContent()).includes('超时原文 1'),'real timeout counter');
   await page.getByText('近期弹幕补翻',{exact:true}).click();
   return{calls:1,originalMs:(await evidence()).chat.find(r=>r.id===id).at-at};
  });
  await check('hold-default-extra-1s-releases-second-translation-once-in-order',async()=>{
   await settings({bilibiliTimeoutRetryEnabled:true});
   const id='retry-hold',text=original+'HOLD',tail='retry-tail',tailText=original+'TAIL';holdReply(text,1,2);
   const at=Date.now();await fire(id,text);await fire(tail,tailText);await attempted(text,2);
   assert.equal(await body(id).count(),0);assert.equal(await body(tail).count(),0);
   const request=(await messages()).find(r=>r.type==='repair-request'&&r.sourceId==='dm:'+id);
   assert.equal(request.purpose,'timeout');assert.equal(request.manual,false);assert.equal(request.force,false);
   assert.ok(request.retryDeadlineAt-at>4700&&request.retryDeadlineAt-at<5300,'2s first + 3s second total');
   releaseReply(text,1);await delay(100);assert.equal(await body(id).count(),0,'late first result cannot complete second attempt');
   releaseReply(text,2);assert.equal((await insertion(id)).text,prefix+'v2 '+text);await insertion(tail);
   const e=await evidence();assert.deepEqual(e.chat.filter(r=>[id,tail].includes(r.id)).map(r=>r.id),[id,tail]);
   assert.equal(await body(tail).textContent(),prefix+'v1 '+tailText);
   assert.equal(e.dispatch.filter(r=>r.packet.info[1]===text).length,1);
   assert.equal(e.screen.filter(r=>r.id===id).length,1);assert.equal(e.screen.find(r=>r.id===id).text,prefix+'v2 '+text);
   return{calls:attempts(text).length,secondBudgetMs:3000,oneNativeDispatch:true,timelyTailPreserved:true};
  });
  await check('second-timeout-original-at-configured-deadline-and-no-third-attempt',async()=>{
   await settings({liveBufferMs:500,bilibiliTimeoutRetryEnabled:true,bilibiliTimeoutRetryExtraMs:500});
   const id='retry-expires',text=original+'EXPIRES';holdReply(text,1,2);const at=Date.now();await fire(id,text);
   const shown=await insertion(id);assert.equal(shown.text,text);
   assert.ok(shown.at-at>=1400&&shown.at-at<2050,'500ms first + 1000ms second');assert.equal(attempts(text).length,2);
   releaseReply(text,1);releaseReply(text,2);await delay(250);
   assert.equal(await body(id).textContent(),text);assert.equal(attempts(text).length,2);
   assert.equal((await evidence()).screen.filter(r=>r.id===id).length,1);
   return{calls:2,totalWaitMs:shown.at-at,lateSecondRejected:true};
  });
  await check('release-original-then-update-native-chat-and-recent-not-screen',async()=>{
   await settings({liveBufferMs:500,bilibiliTimeoutRetryEnabled:true,bilibiliTimeoutRetryMode:'release'});
   const id='retry-release',text=original+'LONG_RELEASE';holdReply(text,1,2);const at=Date.now();await fire(id,text);
   const shown=await insertion(id);assert.equal(shown.text,text);assert.ok(shown.at-at<1000);await attempted(text,2);
   releaseReply(text,2);await wait(async()=> (await body(id).textContent()).startsWith(prefix+'v2 '),'automatic chat replacement');
   releaseReply(text,1);await delay(150);
   const e=await evidence();assert.equal(e.screen.filter(r=>r.id===id).length,1);assert.equal(e.screen.find(r=>r.id===id).text,text);
   await page.getByText('近期弹幕补翻',{exact:true}).click();
   const recent=page.locator('[data-source-id="dm:'+id+'"]');
   await wait(async()=> (await recent.locator('.text').textContent())===(await body(id).textContent()),'shared recent result');
   assert.equal(await page.locator('[data-id_str="'+id+'"] .author').textContent(),'Fixture author: ');
   const screenshot=resolve(dir,'timeout-release-and-recent.png');await page.screenshot({path:screenshot});report.screenshots.push(screenshot);
   await page.getByText('近期弹幕补翻',{exact:true}).click();
   return{originalMs:shown.at-at,calls:2,chatUpdated:true,recentUpdated:true,screenOccurrences:1};
  });
  await check('released-removed-row-updates-recent-only-no-resurrection',async()=>{
   const id='retry-removed',text=original+'REMOVED';holdReply(text,1,2);await fire(id,text);await insertion(id);await attempted(text,2);
   await body(id).evaluate(n=>n.closest('.chat-item').remove());releaseReply(text,2);
   await wait(async()=> (await messages()).some(r=>r.type==='repair-applied'&&r.sourceId==='dm:'+id&&r.application==='recent-only'),'recent-only receipt');
   assert.equal(await body(id).count(),0);assert.equal((await evidence()).screen.filter(r=>r.id===id).length,1);releaseReply(text,1);
   return{recentOnly:true,noReinsertion:true};
  });
  await check('manual-force-after-automatic-second-result-wins-with-distinct-third-text',async()=>{
   const id='retry-manual',text=original+'MANUAL';holdReply(text,1,2);await fire(id,text);await insertion(id);await attempted(text,2);releaseReply(text,2);
   await wait(async()=>await body(id).textContent()===prefix+'v2 '+text,'second result baseline');
   await page.locator('[data-id_str="'+id+'"] [data-danlingo-bili-retry]').click();
   await wait(async()=>await body(id).textContent()===prefix+'v3 '+text,'manual force third result');releaseReply(text,1);
   assert.equal((await evidence()).screen.filter(r=>r.id===id).length,1);return{distinctResults:true,manualForceRetained:true};
  });
  await check('hide-cancels-held-retry-and-settings-off-restores-native-original',async()=>{
   await settings({liveBufferMs:500,bilibiliTimeoutRetryEnabled:true});
   const id='retry-hidden',text=original+'HIDDEN';holdReply(text,1,2);await fire(id,text);await attempted(text,2);
   await page.locator('#hide-screen').click();assert.equal(await body(id).count(),0,'visible chat retains shared retry');
   await page.locator('#hide-chat').click();assert.equal((await insertion(id)).text,text);
   releaseReply(text,2);await page.locator('#hide-chat').click();await page.locator('#hide-screen').click();await connected();
   assert.equal(await body(id).textContent(),text);releaseReply(text,1);
   const settingId='retry-disabled-in-flight',settingText=original+'SETTING';holdReply(settingText,1,2);await fire(settingId,settingText);await attempted(settingText,2);
   await settings({liveBufferMs:500,bilibiliTimeoutRetryEnabled:false});assert.equal((await insertion(settingId)).text,settingText);
   releaseReply(settingText,2);releaseReply(settingText,1);await delay(150);assert.equal(await body(settingId).textContent(),settingText);
   return{oneHiddenRetainsTask:true,bothHiddenFallBack:true,settingsChangeCancels:true};
  });
  await check('room-change-rejects-old-second-result-and-new-room-still-translates',async()=>{
   await settings({liveBufferMs:500,bilibiliTimeoutRetryEnabled:true});
   const id='retry-old-room',text=original+'ROOM';holdReply(text,1,2);await fire(id,text);await attempted(text,2);
   const previousSession=(await messages()).filter(row=>row.type==='snapshot').at(-1).adapterSession;
   await page.evaluate(()=>window.__BILI_FIXTURE__.room(22900498));
   await wait(async()=>{const snapshot=(await messages()).filter(row=>row.type==='snapshot').at(-1);return snapshot?.resourceId==='room:22900498'&&snapshot.adapterSession!==previousSession&&snapshot.presentationActive===true;},'new room native binding');
   releaseReply(text,1);releaseReply(text,2);
   await fire('retry-new-room',original+'NEW_ROOM');assert.ok((await insertion('retry-new-room')).text.startsWith(prefix));
   assert.equal(await body(id).count(),0);assert.equal((await evidence()).screen.filter(r=>r.id===id).length,0);
   return{oldResultRejected:true,newRoomTranslates:true};
  });
  assert.deepEqual(report.errors,[]);
 } else if(emotesOnly) {
  const emotes={'[笑]':{url:'http://fixture.invalid/emote/smile.svg',width:24,height:24},'[泣ω]':{url:'https://fixture.invalid/emote/cry.svg',width:24,height:24}};
  const mixed=(id,text,extra={})=>page.evaluate(({id,text,emotes,extra})=>window.__BILI_FIXTURE__.fire(id,text,4,emotes,extra),{id,text,emotes,extra});
  const row=id=>page.locator('[data-id_str="'+id+'"]');
  const logicalBody=id=>row(id).locator('.danmaku-item-right').evaluate(body=>[...body.childNodes].map(n=>n.nodeType===Node.TEXT_NODE?n.textContent:n instanceof HTMLImageElement?n.alt:n.textContent).join(''));
  const settings=async patch=>{const old=(await messages()).filter(r=>r.type==='snapshot').at(-1)?.adapterSession;assert.equal((await rpc({type:'save',settings:{...config,...patch},remember:false})).ok,true);await wait(async()=> (await messages()).filter(r=>r.type==='snapshot').at(-1)?.adapterSession!==old,'settings session');await connected();};
  const requestText=marker=>report.requests.flatMap(r=>r.texts).find(t=>t.includes(marker));
  const attempts=marker=>report.requests.filter(r=>r.texts.some(t=>t.includes(marker))).length;
  await check('mixed-automatic-both-surfaces-counted-and-original-preserved',async()=>{
   const id='mixed-auto',text='今日は[笑]とても楽しい[泣ω][笑]';await mixed(id,text);await insertion(id);
   assert.equal(await logicalBody(id),prefix+'v1 '+text);assert.equal(await row(id).locator('img').count(),3);
   await wait(async()=> (await messages()).filter(r=>r.type==='snapshot').at(-1)?.liveMetrics.translated===1,'mixed native confirmation');
   const e=await evidence();assert.equal(e.dispatch.length,1);assert.equal(e.dispatch[0].packet.info[1],text);assert.equal(e.screen[0].imageCount,3);assert.equal(e.screen[0].text,prefix+'v1 '+text);
   const sent=requestText('今日は');assert.ok(sent.includes('[[DL:bili'));assert.ok(!sent.includes('[笑]')&&!sent.includes('[泣ω]')&&!sent.includes('http'));
   assert.equal(await row(id).getByRole('button',{name:'强制重译',exact:true}).isEnabled(),true);return{bothSurfaces:true,nativeConfirmed:1,registeredEmotesProtected:true};
  });
  await check('mixed-force-A-to-B-and-recent-C-preserve-image-nodes',async()=>{
   const id='mixed-auto',text='今日は[笑]とても楽しい[泣ω][笑]';
   await row(id).evaluate(r=>{window.__MIXED_IMAGES__=[...r.querySelectorAll('img')];window.__IMAGE_CLICKS__=0;window.__MIXED_IMAGES__[0].addEventListener('click',()=>window.__IMAGE_CLICKS__++);});
   await row(id).getByRole('button',{name:'强制重译',exact:true}).click();await wait(async()=> await logicalBody(id)===prefix+'v2 '+text,'first mixed force B');
   await page.getByText('近期弹幕补翻',{exact:true}).click();const recent=page.locator('[data-source-id="dm:'+id+'"]');
   await recent.getByRole('button',{name:'强制重译',exact:true}).focus();await page.keyboard.press('Enter');await wait(async()=> await logicalBody(id)===prefix+'v3 '+text,'recent mixed force C');
   assert.equal(await recent.locator('.text').textContent(),prefix+'v3 '+text);await page.getByText('近期弹幕补翻',{exact:true}).click();
   const intact=await row(id).evaluate(r=>{const images=[...r.querySelectorAll('img')];images[0].click();return images.every((img,i)=>img===window.__MIXED_IMAGES__[i])&&window.__IMAGE_CLICKS__===1;});assert.equal(intact,true);
   assert.equal(await row(id).locator('.author').textContent(),'Fixture author: ');assert.equal((await evidence()).screen.filter(r=>r.id===id).length,1);return{distinctVersions:3,imageNodesAndEventsPreserved:true,screenNotReemitted:true};
  });
  await check('mixed-invalid-result-falls-back-and-manual-repair-retains-emotes',async()=>{
   const id='mixed-invalid',text='LOSE_EMOTE ここは[笑]原文です';await mixed(id,text);assert.equal((await insertion(id)).text,text);assert.equal(await logicalBody(id),text);
   await row(id).getByRole('button',{name:'强制重译',exact:true}).click();await wait(async()=> await logicalBody(id)===prefix+'v2 '+text,'repair invalid result');
   assert.equal(await row(id).locator('img').count(),1);return{invalidResultRejected:true,manualRepair:true};
  });
  await check('pure-emotes-effects-and-unregistered-images-do-not-enter-translation',async()=>{
   const count=report.requests.length;await mixed('pure','[笑][泣ω]！！');await mixed('special','ここは[笑]特殊効果です',{animation:{type:'unknown'}});await insertion('special');
   assert.equal(await logicalBody('pure'),'[笑][泣ω]！！');assert.equal(await row('pure').locator('button').count(),0);assert.equal(await row('special').locator('button').count(),0);assert.equal(report.requests.length,count);return{purePreserved:true,specialPreserved:true};
  });
  await check('mixed-timeout-second-attempt-keeps-images-on-release-and-hold',async()=>{
   for(const mode of ['release','hold']) {
    await settings({liveBufferMs:500,bilibiliTimeoutRetryEnabled:true,bilibiliTimeoutRetryMode:mode,bilibiliTimeoutRetryExtraMs:2000});
    const id='mixed-retry-'+mode,text='RETRY_'+mode+' 今日は[笑]待ちます';
    // Registered aliases become the same collision-safe token before provider admission.
    const protectedText=text.replace('[笑]','[[DL:bili0_0]]');holdReply(protectedText,1,2);await mixed(id,text);await wait(()=>attempts('RETRY_'+mode)===2,'second mixed request');
    if(mode==='release'){await insertion(id);assert.equal(await logicalBody(id),text);}else assert.equal(await row(id).count(),0);
    releaseReply(protectedText,2);await insertion(id);await wait(async()=> await logicalBody(id)===prefix+'v2 '+text,'mixed second result');
    releaseReply(protectedText,1);assert.equal(await row(id).locator('img').count(),1);
    const screen=(await evidence()).screen.filter(r=>r.id===id);assert.equal(screen.length,1);assert.equal(screen[0].text,mode==='hold'?prefix+'v2 '+text:text);
   }
   return{releaseUpdatesChatOnly:true,holdSubmitsTranslatedOnce:true};
  });
  await check('mixed-one-click-long-layout-and-recent-only-after-removal',async()=>{
   await settings({liveSourceLanguage:'auto'});const id='mixed-bulk',text='长译文 中文[笑]漏译记录';await mixed(id,text);assert.equal((await insertion(id)).text,text);
   await page.getByRole('button',{name:'一键补翻漏译',exact:true}).click();await wait(async()=> (await logicalBody(id)).startsWith(prefix+'v1 '),'mixed one-click');
   const images=await row(id).locator('img').count();assert.equal(images,1);const screenshot=resolve(dir,'mixed-emotes-native-and-recent.png');await page.screenshot({path:screenshot});report.screenshots.push(screenshot);
   const e=(await evidence()).screen.length;await row(id).evaluate(r=>r.remove());
   const recent=page.locator('[data-source-id="dm:'+id+'"]');if(!await recent.isVisible())await page.getByText('近期弹幕补翻',{exact:true}).click();await recent.getByRole('button',{name:'强制重译',exact:true}).click();await wait(async()=> (await recent.locator('.text').textContent()).startsWith(prefix+'v2 '),'missing row force');
   assert.equal(await row(id).count(),0);assert.equal((await evidence()).screen.length,e);assert.equal((await recent.locator('.text').textContent()).endsWith(text),true);return{oneClickWorks:true,recentOnlyNoResurrection:true};
  });
  assert.deepEqual(report.errors,[]);
 } else {
 await check('shared-native-dispatch-and-repeat-occurrences',async()=>{await fire(1,'同じ日本語のコメントです');await fire(2,'同じ日本語のコメントです');await insertion(1);await insertion(2);const e=await evidence();assert.equal(e.dispatch.length,2);assert.deepEqual(e.chat.map(r=>r.text),e.screen.map(r=>r.text));assert.ok(e.chat.every(r=>r.text.startsWith(prefix)));assert.equal(report.requests.filter(r=>r.texts.includes('同じ日本語のコメントです')).length,1);assert.equal(await page.locator('#danlingo-live-overlay').count(),0);return{occurrences:2,providerComputations:1};});
 await check('opaque-id-first-automatic-A-force-B-and-native-rebuild',async()=>{
  const id='0123456789abcdef0123456789abcdefABC',text='最初の自動翻訳から強制再翻訳します';await fire(id,text);await insertion(id);
  const row=page.locator('[data-id_str="'+id+'"]'),body=row.locator('.danmaku-item-right');
  await wait(async()=> (await body.textContent())===prefix+'v1 '+text,'automatic A');
  await wait(async()=> (await messages()).filter(r=>r.type==='snapshot').at(-1)?.liveMetrics?.translated===3,'one count per message not per surface');
  await row.getByRole('button',{name:'强制重译',exact:true}).click();
  await wait(async()=> (await body.textContent())===prefix+'v2 '+text,'first force changes native body to distinct B');
  await page.getByText('近期弹幕补翻',{exact:true}).click();
  const recent=page.locator('[data-source-id="dm:'+id+'"]');await wait(async()=> (await recent.locator('.text').textContent())===prefix+'v2 '+text,'shared recent result');
  await recent.getByRole('button',{name:'强制重译',exact:true}).click();await wait(async()=> (await body.textContent())===prefix+'v3 '+text,'recent force changes native body to C');
  await page.getByText('近期弹幕补翻',{exact:true}).click();
  await body.evaluate((node,text)=>{node.textContent=text;},prefix+'v1 '+text);
  await wait(async()=> (await body.textContent())===prefix+'v3 '+text,'native body rebuilt from automatic model A');
  assert.equal(await row.locator('.author').textContent(),'Fixture author: ');
  assert.equal((await evidence()).screen.filter(r=>r.id===id).length,1);
  await wait(async()=> (await messages()).filter(r=>r.type==='snapshot').at(-1)?.liveMetrics?.repairApplied===2,'manual receipts counted separately');
  return{nativeOpaqueId:true,firstForceReplaced:true,recentForceReplaced:true,screenNotReemitted:true};
 });
 await check('missing-and-invalid-id-translate-without-guess-binding',async()=>{
  await fire(null,'身元不明の普通コメントです');await fire('bad id','不正な識別子の普通コメントです');
  await wait(async()=> (await evidence()).chat.some(r=>r.id==='bad id'),'native invalid id row');
  await wait(async()=> (await messages()).filter(r=>r.type==='snapshot').at(-1)?.liveMetrics?.unconfirmed>=2,'unconfirmed expiry is not drop',13000);
  assert.equal(await page.locator('[data-id_str="undefined"] [data-danlingo-bili-retry]').count(),0);
  assert.equal(await page.locator('[data-id_str="bad id"] [data-danlingo-bili-retry]').count(),0);
  const metrics=(await messages()).filter(r=>r.type==='snapshot').at(-1).liveMetrics;
  assert.equal(metrics.abandoned,0);assert.equal(metrics.translated,3);return{unconfirmed:metrics.unconfirmed,dropped:metrics.abandoned};
 });
 await check('ordered-release-and-deadline-original-no-late-rewrite',async()=>{await fire(3,'ORDER_HEAD 順序の先頭です');await fire(4,'速い後続のコメントです');await insertion(4);assert.deepEqual((await evidence()).chat.filter(r=>['3','4'].includes(r.id)).map(r=>r.id),['3','4']);const start=Date.now();await fire(5,'HELD_TIMEOUT 遅い日本語です');const row=await insertion(5);assert.equal(row.text,'HELD_TIMEOUT 遅い日本語です');assert.ok(row.at-start<2800);release();await delay(200);assert.equal(await page.locator('[data-id_str="5"] .danmaku-item-right').textContent(),row.text);return{fallbackMs:row.at-start};});
 await check('one-surface-hidden-and-video-paused',async()=>{await page.locator('#hide-screen').click();await page.evaluate(()=>window.__BILI_FIXTURE__.pause(true));await fire(6,'一つの表示が停止しています');assert.ok((await insertion(6)).text.startsWith(prefix));await page.locator('#hide-screen').click();await page.evaluate(()=>window.__BILI_FIXTURE__.pause(false));await page.locator('#hide-chat').click();await fire(7,'画面だけが表示されています');assert.ok((await insertion(7)).text.startsWith(prefix));await page.locator('#hide-chat').click();return{sharedWorkRetained:true};});
 await check('actual-single-repair-and-forced-retranslation-clicks',async()=>{await fire(8,'HELD_MANUAL 補翻する原文です');await insertion(8);await page.locator('[data-id_str="8"] [data-danlingo-bili-retry]').click();await wait(async()=> (await page.locator('[data-id_str="8"] .danmaku-item-right').textContent()).startsWith(prefix),'single repair');release();const before=report.requests.length;await page.locator('[data-id_str="8"] [data-danlingo-bili-retry]').click();await wait(()=>report.requests.length>before,'forced request');await wait(async()=>!(await page.locator('[data-id_str="8"] [data-danlingo-bili-retry]').isDisabled()),'force complete');assert.equal((await evidence()).screen.filter(r=>r.id==='8').length,1);return{originalUsed:true,screenNotReemitted:true};});
 await check('recent-record-repair-after-screen-disappears',async()=>{await fire(9,'HELD_RECENT 過去の日本語です');await insertion(9);await page.locator('[data-id_str="9"]').evaluate(n=>n.remove());await page.getByText('近期弹幕补翻',{exact:true}).click();const row=page.locator('[data-source-id="dm:9"]');await row.getByRole('button',{name:'强制重译',exact:true}).click();await wait(async()=> (await row.locator('.text').textContent())?.startsWith(prefix),'recent result');assert.equal(await page.locator('[data-id_str="9"]').count(),0);assert.equal((await evidence()).screen.filter(r=>r.id==='9').length,1);await page.getByText('近期弹幕补翻',{exact:true}).click();release();return{savedOriginal:true,recordOnly:true};});
 await check('superchat-body-only-long-layout-and-manual-click',async()=>{await page.evaluate(()=>window.__BILI_FIXTURE__.sc(11,'LONG 醒目な応援メッセージです'));const card=page.locator('[data-fixture-sc="11"]');await wait(async()=> (await card.locator('.content-message').textContent()).includes(prefix),'SC automatic');assert.equal(await card.locator('.content-price').textContent(),'¥30');assert.equal(await card.locator('.content-name').textContent(),'Fixture SC author');assert.equal(await card.locator('.content-message-icon').textContent(),'★');const before=report.requests.length;await card.locator('[data-danlingo-bili-retry]').click();await wait(()=>report.requests.length>before,'SC forced click');const path=resolve(dir,'sc-long-native.png');await page.screenshot({path});report.screenshots.push(path);return{nativeIdentity:true,metadataPreserved:true};});
 await check('superchat-expanded-card-shared-id-and-unsupported-history-original',async()=>{
  const detail=page.locator('[data-fixture-sc-detail="11"]');
  await wait(async()=> (await detail.locator('.input-contain > .text').textContent()).startsWith(prefix),'expanded SC');
  assert.equal(await detail.locator('.input-trans-contain > .text').textContent(),'native-translation-slot');
  assert.equal(await page.locator('[data-fixture-sc-history="11"] .text').textContent(),'LONG 醒目な応援メッセージです');
  assert.equal(await page.locator('[data-fixture-sc-history="11"] [data-danlingo-bili-retry]').count(),0);
  return{sameIdBodyUpdate:true,nativeOtherSlotPreserved:true,unidentifiedHistoryNotGuessed:true};
 });
 await check('superchat-delete-expiry-no-resurrection',async()=>{await page.evaluate(()=>window.__BILI_FIXTURE__.sc(12,'HELD_DELETE 削除される応援です'));await wait(()=>report.requests.some(r=>r.texts.some(t=>t.includes('HELD_DELETE'))),'SC request');await page.evaluate(()=>window.__BILI_FIXTURE__.deleteSc(12));release();await delay(200);assert.equal(await page.locator('[data-fixture-sc="12"]').count(),0);await page.evaluate(()=>window.__BILI_FIXTURE__.sc(13,'HELD_EXPIRE 期限切れの応援です',350));await delay(550);release();assert.equal(await page.locator('[data-fixture-sc="13"]').count(),0);return{noReinsertion:true};});
 await check('fullscreen-native-screen-and-player-rebuild',async()=>{await page.locator('#fullscreen').click();await wait(()=>page.evaluate(()=>!!document.fullscreenElement),'fullscreen');await fire(14,'全画面の新しいコメントです');assert.ok((await insertion(14)).text.startsWith(prefix));const path=resolve(dir,'fullscreen-native.png');await page.screenshot({path});report.screenshots.push(path);await page.evaluate(()=>document.exitFullscreen());const old=(await messages()).filter(r=>r.type==='snapshot').at(-1).adapterSession;await page.evaluate(()=>window.__BILI_FIXTURE__.rebuild());await wait(async()=> (await messages()).filter(r=>r.type==='snapshot').at(-1)?.adapterSession!==old,'rebuild session');await connected();return{rebuiltSession:true};});
 await check('one-click-loaded-chunks-over-200-and-fixed-snapshot',async()=>{
  // Same target-language text bypasses automatic inference but is a valid explicit repair.
  const current=await rpc({type:'settings'});await rpc({type:'save',settings:{...current.settings,liveSourceLanguage:'auto'},remember:false});await connected();
  await page.evaluate(()=>{for(let i=0;i<260;i++)window.__BILI_FIXTURE__.fire('batch-'+i,'中文补翻候选测试');});
  await wait(async()=> (await messages()).filter(r=>r.type==='repair-record'&&r.sourceId==='dm:batch-259').length>0,'batch capture');
  const one=page.getByRole('button',{name:'一键补翻漏译',exact:true});assert.equal(await one.isVisible(),true);
  await one.click();
  await wait(async()=> (await messages()).some(r=>r.type==='repair-candidates'&&r.scope==='loaded'&&r.chunkIndex===2&&r.done),'loaded scan >200');
  await page.evaluate(()=>window.__BILI_FIXTURE__.fire('not-in-snapshot','不应追加到当前批次'));
  await wait(async()=> (await messages()).filter(r=>r.type==='repair-start'&&r.sourceId?.startsWith('dm:batch-')).length>=260,'all snapshot candidates requested',25000);
  await wait(async()=>await page.locator('[data-id_str="batch-259"] .danmaku-item-right').textContent()===prefix+'v1 中文补翻候选测试','last chunk native write');
  const starts=(await messages()).filter(r=>r.type==='repair-start'&&r.sourceId?.startsWith('dm:batch-'));
  assert.equal(new Set(starts.map(r=>r.sourceId)).size,260);
  assert.equal((await messages()).some(r=>r.type==='repair-start'&&r.sourceId==='dm:not-in-snapshot'),false);
  assert.ok(starts.every(r=>r.originalText==='中文补翻候选测试'&&r.force===false));
  const chunks=(await messages()).filter(r=>r.type==='repair-candidates'&&r.scope==='loaded');
  assert.equal(chunks.at(-1).done,true);assert.ok(chunks.every(r=>r.candidates.length<=100));
  const path=resolve(dir,'one-click-repairs.png');await page.screenshot({path});report.screenshots.push(path);
  await page.getByText('近期弹幕补翻',{exact:true}).click();
  await rpc({type:'save',settings:current.settings,remember:false});await connected();
  return{fixedSnapshot:260,chunkSizes:chunks.map(r=>r.candidates.length),savedOriginal:true};
 });
 await check('room-switch-isolation-and-disable-restoration',async()=>{await fire(15,'HELD_ROOM 古い部屋の日本語です');await wait(()=>report.requests.some(r=>r.texts.some(t=>t.includes('HELD_ROOM'))),'old room request');await page.evaluate(()=>window.__BILI_FIXTURE__.room(22900498));await connected();release();await fire(16,'新しい部屋のコメントです');assert.ok((await insertion(16)).text.startsWith(prefix));assert.equal(await page.locator('[data-id_str="15"]').count(),0);const current=await rpc({type:'settings'});await rpc({type:'save',settings:{...current.settings,enabled:false},remember:false});await wait(()=>page.evaluate(()=>!window.__BILI_FIXTURE__.hooked()),'restore native method');return{oldResponsesRejected:true,hookRestored:true};});
 await check('one-click-stop-cancels-only-owned-work',async()=>{
  const current=await rpc({type:'settings'});await rpc({type:'save',settings:{...current.settings,enabled:true,liveSourceLanguage:'auto'},remember:false});await connected();
  await page.evaluate(()=>{for(let i=0;i<8;i++)window.__BILI_FIXTURE__.fire('stop-'+i,'中文停止测试'+i);});
  await insertion('stop-7');await page.getByRole('button',{name:'一键补翻漏译',exact:true}).click();
  await wait(()=>report.requests.filter(r=>r.phase==='one-click-stop-cancels-only-owned-work').length>=4,'batch transport started');
  await fire('single-unrelated','独立单条补翻');await insertion('single-unrelated');
  await page.getByText('近期弹幕补翻',{exact:true}).click();
  await page.locator('[data-id_str="single-unrelated"] [data-danlingo-bili-retry]').click();
  await page.getByText('近期弹幕补翻',{exact:true}).click();
  await page.getByRole('button',{name:'停止补翻',exact:true}).click();
  const before=(await messages()).filter(r=>r.type==='repair-start'&&r.sourceId?.startsWith('dm:stop-')).length;
  await wait(()=>report.requests.some(r=>r.texts.includes('独立单条补翻')),'unrelated single still admitted');release();
  await wait(async()=> (await page.locator('[data-id_str="single-unrelated"] .danmaku-item-right').textContent()).startsWith(prefix),'unrelated single completes');
  await delay(200);assert.equal((await messages()).filter(r=>r.type==='repair-start'&&r.sourceId?.startsWith('dm:stop-')).length,before);
  for(let i=0;i<8;i++)assert.equal(await page.locator('[data-id_str="stop-'+i+'"] .danmaku-item-right').textContent(),'中文停止测试'+i);
  await page.getByText('近期弹幕补翻',{exact:true}).click();
  return{pendingCancelled:true,noLateBodyWrite:true,unrelatedSingleRetained:true};
 });
 await check('unknown-core-version-fails-closed',async()=>{
  // This gate concerns ordinary native rendering. Paid DOM translation is now
  // independent, so remove the earlier paid fixture before counting requests.
  await page.evaluate(()=>document.querySelector('#cards').replaceChildren());
  const current=await rpc({type:'settings'});await rpc({type:'save',settings:{...current.settings,enabled:true},remember:false});await connected();
  await page.evaluate(()=>window.__BILI_FIXTURE__.version('unreviewed'));
  await wait(async()=> (await messages()).filter(r=>r.type==='snapshot').at(-1)?.reason==='native-entry-unavailable','unsupported ordinary engine snapshot');
  const count=report.requests.length;await fire(17,'未対応のバージョンです');assert.equal((await insertion(17)).text,'未対応のバージョンです');await delay(100);assert.equal(report.requests.length,count);
  return{originalPreserved:true,noProviderAdmission:true};
 });
 }
 report.result='PASS';
}catch(e){report.result='FAIL';report.error=e.stack;process.exitCode=1;console.error(e.message);}finally{release();await context?.close();await new Promise(r=>server?server.close(r):r());await persist();console.log(resolve(dir,'report.json'));}
