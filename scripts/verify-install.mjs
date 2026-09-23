import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Interactive final acceptance: exact release payload, real native host consent and real translation.
import { settingsSection } from './settings-navigation.mjs';
// User clicks Get models and the browser's own Allow button in an isolated profile.
// DANLINGO_E2E_BROWSER=chrome|edge limits the run; omitted means both browsers.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readTestKey } from './verify-real-provider.mjs';
import { completionEndpoint } from '../src/core/config.ts';
import { findNativePlayer, isNativePlayer } from '../src/platforms/niconico/native.ts';

const endpoint=completionEndpoint(process.env.DANLINGO_E2E_ENDPOINT||'',true);
const origin=new URL(endpoint).origin;
const selectedBrowser=process.env.DANLINGO_E2E_BROWSER||'all';
assert.ok(['all','chrome','edge'].includes(selectedBrowser),'DANLINGO_E2E_BROWSER must be chrome, edge, or all');
const requestedBrowsers=selectedBrowser==='all'?['chrome','edge']:[selectedBrowser];
let resumeProfile;
if(process.env.DANLINGO_E2E_RESUME_PROFILE){
  assert.notEqual(selectedBrowser,'all','Resume one previously authorized test browser at a time');
  resumeProfile=await realpath(process.env.DANLINGO_E2E_RESUME_PROFILE);
  const profileRoot=await realpath(resolve('.artifacts/profiles'));
  assert.equal(dirname(resumeProfile).toLowerCase(),profileRoot.toLowerCase(),'Only an existing isolated test profile can be resumed');
  assert.match(basename(resumeProfile),/^p1-install-[a-zA-Z0-9]+$/);
}
const extension=resolve('.output/chrome-mv3');
const manifest=await readFile(resolve(extension,'manifest.json'));
assert.deepEqual(JSON.parse(manifest).host_permissions,['https://www.nicovideo.jp/*', 'https://live.nicovideo.jp/watch/*', 'https://www.youtube.com/*']);
const {chromium}=await import(pathToFileURL(process.env.DANLINGO_PLAYWRIGHT_MODULE).href);
const apiKey=await readTestKey();
const redact=value=>String(value).split(apiKey).join('[redacted]');
const runName=selectedBrowser==='all'?'install':`install-${selectedBrowser}`;
const root=resolve('.artifacts/p1/real',resumeProfile?`${runName}-resume-${Date.now()}`:runName);await mkdir(root,{recursive:true});
const report={capturedAt:new Date().toISOString(),endpoint,releaseManifestSHA256:createHash('sha256').update(manifest).digest('hex'),
  evidence:'Exact release manifest; headed isolated browsers; native host consent requires the user; real Provider',requestedBrowsers,browsers:[],errors:[]};
const playerExpression=`(()=>{const isNativePlayer=${isNativePlayer.toString()};return (${findNativePlayer.toString()})('sm1715919');})()`;
const native=(page,action)=>page.evaluate(`(async()=>{const p=${playerExpression};if(!p)throw new Error('Native player absent');${action}})()`);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(page,predicate,arg,timeout=30000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){if(await page.evaluate(predicate,arg))return;await delay(150);}
  throw new Error('Expected browser state did not arrive before timeout');
}
async function status(browser,phase){
  const state={at:new Date().toISOString(),pid:process.pid,browser,phase,report:resolve(root,'report.json')};
  await writeFile(resolve(root,'status.json'),JSON.stringify(state,null,2));console.log(JSON.stringify(state));
}
for(const browserName of requestedBrowsers){
  let context,options,page,rpc;
  const row={browser:browserName,checks:{},requests:[]};report.browsers.push(row);
  try{
    const profile=resumeProfile??await mkdtemp(resolve('.artifacts/profiles/p1-install-'));
    row.profile=profile;row.resumedPreviouslyAuthorizedProfile=!!resumeProfile;
    context=await chromium.launchPersistentContext(profile,{headless:false,
      ...browserLaunchOptions(browserName),
      viewport:{width:1280,height:900},locale:'zh-CN',args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
    row.browserVersion=context.browser()?.version();
    const requests=new Map();
    context.on('request',request=>{
      if(request.url()!==endpoint||request.method()!=='POST')return;
      const record={at:Date.now()};requests.set(request,record);row.requests.push(record);
      if(row.requests.length>=40){row.requestBudgetReached=true;void rpc?.({type:'toggle',enabled:false}).catch(()=>{});}
    });
    context.on('response',response=>{const record=requests.get(response.request());if(record){record.status=response.status();record.responseHeadersMs=Date.now()-record.at;}});
    context.on('requestfailed',request=>{const record=requests.get(request);if(record){record.failed=true;record.elapsedMs=Date.now()-record.at;}});
    const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
    options=await context.newPage();await options.goto(new URL('/options.html',worker.url()).href);await options.bringToFront();
    rpc=payload=>options.evaluate(payload=>chrome.runtime.sendMessage(payload),payload);
    await until(options,()=>!!document.getElementById('key-state')?.textContent);
    row.checks.grantedBefore=await options.evaluate(origin=>chrome.permissions.contains({origins:[origin+'/*']}),origin);
    assert.equal(row.checks.grantedBefore,!!resumeProfile,resumeProfile?'Previously granted host permission was not retained':'Fresh profile already has host permission');
    await options.locator('#endpoint').fill(endpoint);
    await settingsSection(options,'advanced'); await options.locator('#profile').evaluate(el=>el.closest('details').open=true); await options.locator('#profile').selectOption('deepseek'); await settingsSection(options,'service');
    await options.locator('#model').fill('deepseek-flash');
    await settingsSection(options,'watching'); await options.locator('#source-language').selectOption('ja');
    await settingsSection(options,'advanced'); await options.locator('#local-http').check(); await settingsSection(options,'service'); await options.locator('#remember').uncheck();
    await options.locator('#api-key').fill(apiKey);
    // A resumed profile must already hold the user's grant; no permission is pregranted by this script.
    if(resumeProfile)await options.locator('#get-models').click();
    await status(browserName,resumeProfile?'reusing-existing-grant-querying-models':'waiting-for-user-to-click-get-models-and-allow-native-provider-host');
    await until(options,()=>{
      const result=document.getElementById('models-result')?.textContent;
      if(result?.startsWith('未授权'))throw new Error('User declined host permission');
      return result?.startsWith('已获取');
    },undefined,resumeProfile?30000:600000);
    row.checks.grantedAfter=await options.evaluate(origin=>chrome.permissions.contains({origins:[origin+'/*']}),origin);
    assert.equal(row.checks.grantedAfter,true);
    row.models=await options.locator('#model-list option').evaluateAll(nodes=>nodes.map(n=>n.value).filter(Boolean));
    assert.ok(row.models.includes('deepseek-flash'));
await options.locator('#model-list').selectOption('deepseek-flash'); await settingsSection(options,'watching'); await options.locator('#enabled').check();
    await options.locator('#save').click();await until(options,()=>document.getElementById('result')?.textContent==='已保存');
    row.checks.savedWithKey=(await rpc({type:'settings'})).hasKey;assert.equal(row.checks.savedWithKey,true);
    await options.screenshot({path:resolve(root,browserName+'-settings.png'),fullPage:true});
    await status(browserName,'host-granted-verifying-real-video');
    page=await context.newPage();
    await page.addInitScript(()=>{
      const state=window.__DL_INSTALL__={snapshot:null,sources:new Map(),samples:[],clocks:[],controls:[]};
      window.addEventListener('message',event=>{
        const d=event.data;if(event.source!==window||d?.bridge!=='danlingo.native.v1')return;
        if(d.from==='native'&&d.type==='snapshot'){
          state.snapshot=d;
          if(!state.clocks.length||performance.now()-state.clocks.at(-1).at>2000){state.clocks.push({at:performance.now(),...d.clock,counts:d.counts});if(state.clocks.length>40)state.clocks.shift();}
        }
        if(d.from==='native'&&d.type==='sources'){
          if(d.reset)state.sources.clear();
          for(const id of d.removes)state.sources.delete(id);
          for(const m of d.upserts)state.sources.set(m.id,m.originalText);
        }
        if(d.from==='content'&&d.type==='control'){state.controls.push({enabled:d.enabled,displayMode:d.displayMode,clear:d.clear});if(state.controls.length>4)state.controls.shift();}
        if(d.from==='content'&&d.type==='prepared')for(const m of d.items){const original=state.sources.get(m.id);if(original&&original!==m.text&&state.samples.length<20)state.samples.push({id:m.id,original,text:m.text});}
      });
    });
    await page.goto('https://www.nicovideo.jp/watch/sm1715919',{waitUntil:'domcontentloaded',timeout:45000});await page.bringToFront();
    await until(page,()=>window.__DL_INSTALL__?.sources.size>0);
    await native(page,'p.getVideoElement().muted=true;'); // Only this temporary test window is muted.
    const play=page.getByRole('button',{name:'再生する',exact:true});
    if(await play.isVisible())await play.click();else await native(page,'await p.getVideoElement().play();');
    row.playbackStart=await page.evaluate(()=>({clock:window.__DL_INSTALL__.snapshot?.clock,hidden:document.hidden}));
    await until(page,()=>window.__DL_INSTALL__.snapshot?.counts?.translated>=3&&window.__DL_INSTALL__.samples.length>=3,undefined,60000);
    row.native=await page.evaluate(()=>({clock:window.__DL_INSTALL__.snapshot.clock,counts:window.__DL_INSTALL__.snapshot.counts,samples:window.__DL_INSTALL__.samples}));
    row.overview=await rpc({type:'overview'});assert.ok(row.overview.engine.providerCalls>0);
    row.checks.realNativeTranslated=true;await page.screenshot({path:resolve(root,browserName+'-native.png')});
    await delay(4000);row.result='PASS';await status(browserName,'passed');
  }catch(error){
    row.error=redact(error.stack??error).slice(0,2000);report.errors.push(browserName+': '+row.error);process.exitCode=1;
    if(rpc)row.overview=await rpc({type:'overview'}).catch(()=>null);
    if(page&&!page.isClosed()){
      row.diagnostics=await page.evaluate(()=>{
        const s=window.__DL_INSTALL__;
        return {url:location.href,hidden:document.hidden,clock:s?.snapshot?.clock,counts:s?.snapshot?.counts,sources:s?.sources.size,samples:s?.samples,clocks:s?.clocks,controls:s?.controls,
          videos:[...document.querySelectorAll('video')].map(v=>({currentTime:v.currentTime,paused:v.paused,ended:v.ended,readyState:v.readyState,errorCode:v.error?.code}))};
      }).catch(()=>null);
      await page.screenshot({path:resolve(root,browserName+'-failure.png')}).catch(()=>{});
    }
  }
  finally{
    if(rpc){await rpc({type:'toggle',enabled:false}).catch(()=>{});await rpc({type:'delete-key'}).catch(()=>{});}
    await context?.close();await writeFile(resolve(root,'report.json'),redact(JSON.stringify(report,null,2)));
  }
  if(row.result!=='PASS')break;
}
report.result=report.browsers.length===requestedBrowsers.length&&report.browsers.every(row=>row.result==='PASS')?'PASS':'INCOMPLETE';
await writeFile(resolve(root,'report.json'),redact(JSON.stringify(report,null,2)));
await status('all',report.result.toLowerCase());console.log(JSON.stringify({result:report.result,report:resolve(root,'report.json'),errors:report.errors},null,2));
