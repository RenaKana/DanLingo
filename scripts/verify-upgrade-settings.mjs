import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Production extension/settings/background, isolated Chromium, loopback fixtures.
// Counts are server-observed POSTs; fixtures are not real provider/model latency.
import assert from 'node:assert/strict';
import { mkdir, cp, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/core/config.ts';
import { decodeTranslationFixtureRequest, encodeTranslationFixtureResponse } from './translation-protocol-fixture.mjs';
import { settingsSection, settingsDetails } from './settings-navigation.mjs';

const root = resolve('.artifacts/upgrade-settings'); await mkdir(root,{recursive:true});
const directory = await mkdtemp(resolve(root,'run-'));
const report = {capturedAt:new Date().toISOString(),evidence:'PRODUCTION_EXTENSION_SETTINGS_BACKGROUND_LOOPBACK_FIXTURE',checks:{},requests:[],models:[],runs:{},screenshots:[],errors:[],limitations:['Isolated Chromium and loopback mock; native permission prompt is bypassed only in the test copy by granting loopback host permission. Browser fixture routing permits only this server port.','Translation samples and timing here exercise real extension transport and accounting against fixed responses; no paid API, real translation quality or local-model performance is measured.']};
let scenario='setup', mode='success', active=0, maxActive=0, context, page;
const held = new Set();
const release=()=>{for(const done of held)done();held.clear();};
const pause=ms=>new Promise(done=>setTimeout(done,ms));
async function until(fn,label,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await pause(30);}throw new Error('Timeout: '+label);}
const server=createServer(async(req,res)=>{
  res.setHeader('access-control-allow-origin','*');res.setHeader('access-control-allow-headers','authorization,content-type');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  if(req.method==='GET'){
    report.models.push({scenario,path:req.url,authorized:req.headers.authorization==='Bearer fixture-settings-key'});
    if(mode==='unauthorized'){res.writeHead(401);res.end('{}');return;}
    res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'fixture-generic'},{id:'fixture-secondary'}]}));return;
  }
  if(req.method!=='POST'){res.writeHead(404);res.end();return;}
  active++;maxActive=Math.max(maxActive,active);const started=Date.now();
  let decremented=false;const finished=()=>{if(!decremented){decremented=true;active--;}};res.once('close',finished);
  try{
    let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>100000)throw new Error('fixture body limit');}
    const payload=JSON.parse(raw),decoded=decodeTranslationFixtureRequest(payload),capturedMode=mode;
    assert.ok(report.requests.length<300,'bounded POST budget');
    report.requests.push({scenario,path:req.url,at:started,items:decoded.items.length,protocol:decoded.protocol,stream:decoded.stream,model:payload.model,authorized:req.headers.authorization==='Bearer fixture-settings-key'});
    if(capturedMode==='held')await new Promise(done=>{held.add(done);res.once('close',()=>{held.delete(done);done();});});
    else await pause(capturedMode==='load'?30:5);
    if(res.destroyed)return;
    if(capturedMode==='invalid'){res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'INVALID FIXTURE RESPONSE'}}]}));return;}
    if(capturedMode==='unauthorized'){res.writeHead(401);res.end('{}');return;}
    const reply=encodeTranslationFixtureResponse(decoded,decoded.items.map(item=>({id:item.id,text:'【模拟译文】'+item.text})),{prompt_tokens:10,completion_tokens:5,total_tokens:15});
    res.setHeader('content-type',reply.contentType);res.end(reply.body);
  }catch(error){report.errors.push(error.message);if(!res.headersSent)res.writeHead(500);res.end('{}');}
  finally{finished();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`;
const rpc=message=>page.evaluate(message=>chrome.runtime.sendMessage(message),message);
const posts=label=>report.requests.filter(row=>row.scenario===label);
async function check(name,run){try{await run();report.checks[name]='PASS';console.log('PASS',name);}catch(error){report.checks[name]='FAIL: '+error.message;report.errors.push(name+': '+error.message);console.error('FAIL',name,error.message);}}
try{
  const uiOnly=process.argv.includes('--ui-only');
  const extension=resolve(directory,'extension');await cp(resolve(process.argv.slice(2).find(arg=>!arg.startsWith('--'))??'.output/chrome-mv3'),extension,{recursive:true});
  const manifest=JSON.parse(await readFile(resolve(extension,'manifest.json'),'utf8'));
  assert.ok(manifest.background,'A full production build is required, not the offscreen-only filtered build');
  manifest.host_permissions=[...new Set([...(manifest.host_permissions??[]),'http://127.0.0.1/*'])];
  await writeFile(resolve(extension,'manifest.json'),JSON.stringify(manifest));
  const {chromium}=await loadPlaywright();
  context=await chromium.launchPersistentContext(await mkdtemp(resolve(directory,'profile-')),{headless:true,...browserLaunchOptions("chromium"),viewport:{width:1360,height:900},args:['--disable-extensions-except='+extension,'--load-extension='+extension,'--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
  await context.route('**/*',route=>{const url=new URL(route.request().url());return !['http:','https:'].includes(url.protocol)||url.origin===origin?route.continue():route.abort();});
  const background=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
  const url=`chrome-extension://${new URL(background.url()).host}/options.html`;
  page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));await page.goto(url);await page.locator('#endpoint').waitFor();
  if(uiOnly || process.argv.includes('--ui'))await check('ui-fresh-profile-default-is-auto',async()=>{await page.locator('#performance-start').waitFor({state:'attached'});assert.equal(await page.locator('#profile').inputValue(),'auto');});
  const settings=normalizeSettings({...DEFAULT_SETTINGS,backend:'online',enabled:true,endpoint:origin,allowLocalHttp:true,model:'fixture-generic',profile:'generic',protocol:'auto',thinkingEffort:'default',translationStream:false,liveBufferMs:3000,liveSourceLanguage:'ja',targetLanguage:'zh-CN',concurrency:2,batchSize:2,liveBatchMaxChars:2000,liveMaxBatchWaitMs:0,liveAdaptiveConcurrency:false});
  assert.equal((await rpc({type:'save',settings,apiKey:'fixture-settings-key',remember:false})).ok,true);
  await page.reload();await page.locator('#endpoint').waitFor();
  for(const width of [1360,560]){
    await page.setViewportSize({width,height:900});
    const path=resolve(root,`settings-${width}.png`);await page.screenshot({path,fullPage:true});report.screenshots.push(path);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'settings horizontal overflow at '+width);
  }
  await page.setViewportSize({width:1360,height:900});report.checks.desktopAnd560pxPreview='PASS';
  if(!uiOnly){
  const baseline=await rpc({type:'overview'});
  const run=async(label,config,fixtureMode='success')=>{
    scenario=label;mode=fixtureMode;maxActive=0;
    const start=await rpc({type:'performance-start',settings,config,apiKey:'fixture-settings-key'});assert.equal(start.ok,true,JSON.stringify(start));
    const result=await until(async()=>{const value=await rpc({type:'performance-status'});return value.report?.state!=='running'?value.report:null;},label,30000);
    report.runs[label]={...result,observedPosts:posts(label).length,maxConcurrentPosts:maxActive};return result;
  };
  const config={count:10,mode:'latency',concurrency:1,batchSize:1,arrivalIntervalMs:0,strategy:'normal'};
  for(const count of [10,100])await check(`latency-${count}-exact-transport-and-statistics`,async()=>{
    const result=await run('latency-'+count,{...config,count});
    assert.equal(posts(scenario).length,count);assert.equal(result.actualRequests,count);assert.equal(result.successRequests,count);assert.equal(result.failed,0);assert.equal(result.unsent,0);
    assert.equal(result.usageReports,count);assert.equal(result.usage.totalTokens,count*15);
    const mean=result.samples.reduce((sum,row)=>sum+row.readyAt-row.sentAt,0)/count;assert.ok(Math.abs(result.meanMs-mean)<0.0001);
    assert.ok(result.meanMs>0);assert.ok(result.p95Ms>=result.p50Ms);
  });
  await check('load-10-two-items-two-slots-exact-counts',async()=>{
    const result=await run('load-10',{...config,mode:'load',count:10,concurrency:2,batchSize:2},'load');
    assert.equal(result.actualRequests,10);assert.equal(posts(scenario).length,10);assert.equal(result.successRequests,10);assert.ok(posts(scenario).every(row=>row.items===2));assert.equal(maxActive,2);assert.equal(result.withinBudgetRate,1);
    assert.ok(result.meanQueueMs>=0);assert.ok(result.meanReadyMs>=result.meanMs);
  });
  await check('invalid-results-have-no-valid-average',async()=>{
    const result=await run('invalid-10',config,'invalid');assert.equal(result.actualRequests,10);assert.equal(posts(scenario).length,10);assert.equal(result.successRequests,0);assert.equal(result.failed,10);assert.equal(result.meanMs,null);assert.equal(result.p50Ms,null);assert.equal(result.p95Ms,null);
  });
  for(const testMode of ['latency','load'])await check(`stop-${testMode}-cancels-inflight-and-unsent`,async()=>{
    scenario='stop-'+testMode;mode='held';maxActive=0;
    const start=await rpc({type:'performance-start',settings,config:{...config,count:100,mode:testMode,concurrency:2,batchSize:2},apiKey:'fixture-settings-key'});assert.equal(start.ok,true);
    await until(()=>posts(scenario).length===2,'two held POSTs');assert.equal((await rpc({type:'performance-stop'})).ok,true);
    const result=await until(async()=>{const value=await rpc({type:'performance-status'});return value.report?.state==='stopped'?value.report:null;},'stopped report');
    report.runs[scenario]={...result,observedPosts:posts(scenario).length};
    release();assert.equal(posts(scenario).length,2);assert.equal(result.actualRequests,2);assert.equal(result.cancelled,2);assert.equal(result.unsent,98);assert.equal(result.meanMs,null);
  });
  await check('tests-do-not-write-live-cache-or-live-engine',async()=>{
    const after=await rpc({type:'overview'});assert.deepEqual(after.cache,baseline.cache);assert.deepEqual(after.engine,baseline.engine);
    report.cacheBefore=baseline.cache;report.cacheAfter=after.cache;
  });
  await check('root-prefix-and-gemini-paths-share-endpoint-resolution',async()=>{
    mode='success';
    for(const [input,base]of[[origin,'/v1'],[origin+'/proxy/v1?tenant=blue','/proxy/v1'],[origin+'/v1beta/openai/?tenant=blue','/v1beta/openai']]){
      scenario='path-'+base;
      const draft={...settings,endpoint:input};
      const models=await rpc({type:'models',settings:draft,apiKey:'fixture-settings-key'});assert.equal(models.ok,true,JSON.stringify(models));
      const tested=await rpc({type:'test-model',settings:draft,apiKey:'fixture-settings-key'});assert.equal(tested.ok,true,JSON.stringify(tested));
      const query=input.includes('?')?'?tenant=blue':'';
      assert.equal(report.models.at(-1).path,base+'/models'+query);assert.equal(posts(scenario).at(-1).path,base+'/chat/completions'+query);
      assert.equal(report.models.at(-1).authorized,true);assert.equal(posts(scenario).at(-1).authorized,true);
    }
  });
  await check('authentication-failure-does-not-probe-other-paths',async()=>{
    scenario='unauthorized-models';mode='unauthorized';const before=report.models.length;
    const result=await rpc({type:'models',settings,apiKey:'fixture-settings-key'});assert.equal(result.ok,false);assert.equal(report.models.length,before+1);assert.match(result.error,/Key|凭据/);
  });
  await check('local-offscreen-persists-across-settings-close',async()=>{
    assert.equal((await rpc({type:'local-control',control:{action:'state'}})).ok,true);
    const before=await background.evaluate(()=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}));
    await page.close();page=await context.newPage();await page.goto(url);await page.locator('#endpoint').waitFor();
    const state=await rpc({type:'local-control',control:{action:'state'}});assert.equal(state.ok,true);
    const after=await background.evaluate(()=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}));assert.equal(before[0].documentId,after[0].documentId);report.offscreen={sameDocument:true,phase:state.state.phase};
  });
  }
  if(uiOnly || process.argv.includes('--ui')){
    await check('ui-effective-address-typing-is-local-and-preserves-query',async()=>{
      const before=report.requests.length+report.models.length;
      await page.locator('#endpoint').fill(origin+'/proxy/v1?tenant=blue');
      await until(async()=>(await page.locator('#connection-status').textContent()).includes('/proxy/v1/chat/completions?tenant=blue'),'effective address');
      assert.equal(report.requests.length+report.models.length,before);
      await page.locator('#endpoint').fill(origin);
      await until(async()=>(await page.locator('#connection-status').textContent()).includes('/v1/chat/completions'),'root normalized');
    });
    await check('ui-performance-10-button-sends-10-transports',async()=>{
      await settingsSection(page,'performance');
      scenario='ui-10';mode='success';
      await page.locator('#performance-count').selectOption('10');await page.locator('#performance-mode').selectOption('latency');await page.locator('#performance-concurrency').fill('1');
      await page.locator('#performance-start').click();
      await until(async()=>(await page.locator('#performance-progress').textContent()).includes('已完成'),'UI performance completion');
      assert.equal(posts(scenario).length,10);assert.match(await page.locator('#performance-progress').textContent(),/实际发出 10 次/);assert.match(await page.locator('#performance-result').textContent(),/成功请求 n=10/);assert.equal(await page.locator('#performance-copy').isEnabled(),true);
      await page.locator('#performance-copy').click();await until(async()=>(await page.locator('#performance-progress').textContent()).includes('复制'),'copy result feedback');
    });
    await check('ui-performance-100-stop-cancels-unsent',async()=>{
      scenario='ui-stop';mode='held';await page.locator('#performance-count').selectOption('100');await page.locator('#performance-concurrency').fill('2');
      await page.locator('#performance-start').click();await until(()=>posts(scenario).length===2,'UI held POSTs');
      await settingsSection(page,'service');await page.locator('#backend').selectOption('local');await page.locator('#running-task').click();
      await page.locator('[data-section="performance"]').waitFor({state:'visible'});
      assert.equal(await page.locator('#performance-stop').isVisible(),true,'running online test retains stop after backend draft switch');
      await page.locator('#performance-stop').click();await until(async()=>(await page.locator('#performance-progress').textContent()).includes('已停止'),'UI stopped');
      release();assert.equal(posts(scenario).length,2);assert.match(await page.locator('#performance-result').textContent(),/尚未发送任务 98/);
      await settingsSection(page,'service');await page.locator('#backend').selectOption('online');
    });
    await check('ui-superchat-config-persists-and-keeps-online-key',async()=>{
      await settingsSection(page,'advanced'); await page.locator('#profile').evaluate(el=>el.closest('details').open=true);
      await page.locator('#profile').selectOption('deepseek'); await settingsSection(page,'service'); await page.locator('#thinking-effort').selectOption('off'); await settingsSection(page,'live'); await page.locator('#superchat-thinking').selectOption('high');await page.locator('#superchat-timeout').fill('18000');
      await page.locator('#save').click();await until(async()=>(await rpc({type:'settings'})).settings?.superChatTimeoutMs===18000,'SC saved');
      await page.reload();await page.locator('#performance-start').waitFor({state:'attached'});const saved=await rpc({type:'settings'});
      assert.equal(saved.settings.superChatThinkingEffort,'high');assert.equal(saved.settings.superChatTimeoutMs,18000);assert.equal(saved.hasKey,true);assert.equal(saved.settings.backend,'online');
    });
    await check('ui-local-file-errors-and-reopen-preserve-online-config',async()=>{
      await settingsSection(page,'service');
      mode='success';await page.locator('#backend').selectOption('local');await page.locator('#local-settings').waitFor({state:'visible'});
      await page.locator('#local-file').setInputFiles({name:'unsupported.safetensors',mimeType:'application/octet-stream',buffer:Buffer.from('fixture')});await page.locator('#local-import').click();
      await until(async()=>/不支持|只支持/.test(await page.locator('#local-result').textContent()),'unsupported local file');
      assert.equal((await rpc({type:'local-control',control:{action:'list'}})).models.length,0);
      await page.locator('#local-file').setInputFiles({name:'corrupt.gguf',mimeType:'application/octet-stream',buffer:Buffer.from('GGUF')});await page.locator('#local-import').click();
      await until(async()=>/头|无效|损坏/.test(await page.locator('#local-result').textContent()),'corrupt GGUF error');
      const before=await background.evaluate(()=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}));
      for(const width of [1360,560]){await page.setViewportSize({width,height:900});const path=resolve(root,`local-settings-${width}.png`);await page.screenshot({path,fullPage:true});report.screenshots.push(path);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
      await page.close();page=await context.newPage();await page.goto(url);await page.locator('#performance-start').waitFor({state:'attached'});
      const after=await background.evaluate(()=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}));assert.equal(before[0].documentId,after[0].documentId);
      const preserved=await rpc({type:'settings'});assert.equal(preserved.settings.backend,'online');assert.equal(preserved.hasKey,true);assert.equal(preserved.settings.model,'fixture-generic');
    });
    await check('ui-saved-local-model-and-online-settings-roundtrip',async()=>{
      const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;},u64=n=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;},str=s=>[u64(Buffer.byteLength(s)),Buffer.from(s)];
      const metadata=[['general.architecture','llama'],['general.file_type',15],['tokenizer.ggml.model','llama'],['tokenizer.ggml.tokens',['hello']],['tokenizer.chat_template','{{ messages }}']];
      const chunks=[u32(0x46554747),u32(3),u64(1),u64(metadata.length)];for(const[key,value]of metadata){chunks.push(...str(key));if(typeof value==='number')chunks.push(u32(4),u32(value));else if(Array.isArray(value))chunks.push(u32(9),u32(8),u64(1),...str(value[0]));else chunks.push(u32(8),...str(value));}
      await page.locator('#backend').selectOption('local');
      await page.locator('#local-file').setInputFiles({name:'no-weights-fixture.gguf',mimeType:'application/octet-stream',buffer:Buffer.concat(chunks)});await page.locator('#local-import').click();
      await until(async()=>!!(await page.locator('#local-model').inputValue()),'header fixture import');
      const selected=await page.locator('#local-model').inputValue();await page.locator('#save').click();
      await until(async()=>(await rpc({type:'settings'})).settings?.backend==='local','local backend saved');
      await page.reload();await page.locator('#local-model').waitFor();await until(async()=>(await page.locator('#local-model').inputValue())===selected,'imported id persisted');
      const local=await rpc({type:'settings'});assert.equal(local.hasKey,true);assert.equal(local.settings.model,'fixture-generic');assert.equal(local.settings.localModelId,selected);
      await page.locator('#local-load').click();await until(async()=>(await rpc({type:'local-control',control:{action:'state'}})).state.phase==='error','real engine rejects weightless fixture');
      await until(async()=>/权重|未能加载|加载失败/.test(await page.locator('#local-result').textContent()),'visible native load rejection');
      await page.locator('#local-unload').click();await until(async()=>(await rpc({type:'local-control',control:{action:'state'}})).state.phase==='idle','unload after failure');
      await page.locator('#backend').selectOption('online');await page.locator('#save').click();await until(async()=>(await rpc({type:'settings'})).settings?.backend==='online','online restored');
      const restored=await rpc({type:'settings'});assert.equal(restored.hasKey,true);assert.equal(restored.settings.model,'fixture-generic');assert.equal(restored.settings.profile,'deepseek');assert.equal(restored.settings.thinkingEffort,'off');assert.equal(restored.settings.superChatThinkingEffort,'high');
      assert.equal((await rpc({type:'local-control',control:{action:'delete',modelId:selected}})).ok,true);
      report.localFixture='GGUF metadata only: imported and persisted; actual engine correctly rejected missing weights. No model translation claim.';
    });
  }
  console.log(JSON.stringify({checks:report.checks,posts:report.requests.length,models:report.models.length,screenshots:report.screenshots},null,2));
  if(Object.values(report.checks).some(value=>value.startsWith('FAIL')))throw new Error('One or more settings acceptance checks failed; see report.json');
}catch(error){report.errors.push(error.message);throw error;}
finally{release();await context?.close();await new Promise(done=>server.close(done));await writeFile(resolve(directory,'report.json'),JSON.stringify(report,null,2));await writeFile(resolve(root,'report.json'),JSON.stringify(report,null,2));}
