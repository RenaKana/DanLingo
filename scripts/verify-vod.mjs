// Production extension + synthetic native fixture + optional real anonymous Niconico page.
// Translation always uses this process's loopback mock; no keys or personal profiles are read.
// Run after building: node --experimental-strip-types scripts/verify-vod.mjs
// Focused alternatives: --fixture-only, --real-only, --reset-only.
// Add --progress-only to --real-only to check progress UI without playback/seek tests.
import assert from 'node:assert/strict';
import { browserLaunchOptions, loadPlaywright } from './browser-runtime.mjs';
import { mkdir, mkdtemp, cp, readFile, writeFile, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { findNativePlayer, isNativePlayer } from '../src/platforms/niconico/native.ts';
import { fixtureHtml, fixtureUrl, installBridgeObserver, installNativeFixture, installPlaybackObserver } from './vod-fixture.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node --experimental-strip-types scripts/verify-vod.mjs [--fixture-only | --real-only | --reset-only] [--progress-only]\nDefault: fixture plus anonymous Niconico checks, always with a local mock Provider. Set DANLINGO_E2E_BROWSER=edge for Edge. --help exits before creating artifacts or launching a browser.');
  process.exit(0);
}
assert.ok(args.every(arg => ['--fixture-only', '--real-only', '--reset-only', '--progress-only'].includes(arg)), 'Unknown VOD verification argument');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = path => access(path).then(() => true, () => false);
const fixtureOnly = process.argv.includes('--fixture-only');
const realOnly = process.argv.includes('--real-only');
const resetOnly = process.argv.includes('--reset-only');
const progressOnly = process.argv.includes('--progress-only');
assert.ok([fixtureOnly,realOnly,resetOnly].filter(Boolean).length<=1, 'Choose at most one focused run flag');
const isEdge = process.env.DANLINGO_E2E_BROWSER === 'edge';
const capturedAt = new Date().toISOString();
const root = resolve(process.env.DANLINGO_VOD_ARTIFACTS || '.artifacts/vod', isEdge ? 'edge' : 'chromium');
await mkdir(root, {recursive:true});
await mkdir(resolve('.artifacts/profiles'), {recursive:true});
const runDir = await mkdtemp(resolve(root, 'run-'));
const extension = resolve(runDir, 'test-extension');
await cp(resolve('.output/chrome-mv3'), extension, {recursive:true});
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), 'http://127.0.0.1/*'])];
await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest,null,2));
const {chromium} = await loadPlaywright();
const browserOptions = browserLaunchOptions(isEdge ? 'edge' : 'chromium');
const report = { capturedAt, runDir, evidence:'Production extension; LOCAL MOCK provider; fixture and real-site evidence explicitly separate',
  limitations:['Test manifest grants only loopback host; native host-permission consent is outside this check.',
    'Synthetic native fixture verifies bridge/UI contracts, not Niconico renderer internals.',
    'Real-site coverage uses an anonymous isolated profile and no real translation service.'],
  fixture:{status:realOnly||resetOnly?'not-requested':'pending',checks:{}}, real:{status:fixtureOnly||resetOnly?'not-requested':'pending',checks:{}}, requests:[],errors:[] };
let phase='setup', providerMode='success', context, options, page, rpc;
const held = new Set();
const mock = createServer(async (req,res) => {
  res.setHeader('access-control-allow-origin','*');
  res.setHeader('access-control-allow-headers','authorization,content-type');
  res.setHeader('content-type','application/json');
  if (req.method==='OPTIONS') {res.writeHead(204);res.end();return;}
  if (req.method==='GET' && req.url==='/v1/models') {res.end(JSON.stringify({data:[{id:'vod-deterministic-mock'}]}));return;}
  if (req.method!=='POST' || req.url!=='/v1/chat/completions') {res.writeHead(404);res.end('{}');return;}
  try {
    let body=''; for await (const chunk of req) {body+=chunk;if(body.length>1000000)throw new Error('Mock body limit exceeded');}
    assert.equal(req.headers.authorization,'Bearer danlingo-vod-local-test-only');
    const json=JSON.parse(body), inputs=JSON.parse(json.messages.find(m=>m.role==='user').content).items;
    const row={at:Date.now(),phase,mode:providerMode,items:inputs.length,ids:inputs.map(m=>m.id),texts:inputs.map(m=>m.text),model:json.model};
    report.requests.push(row);
    if(report.requests.length>400)throw new Error('Mock request budget exceeded');
    if(providerMode==='hold')await new Promise(resolve=>held.add(resolve));
    const outputs=inputs.map(item=>({id:item.id,text:'【模拟译文】'+item.text})).reverse();
    row.completedAt=Date.now();
    res.end(JSON.stringify({choices:[{message:{role:'assistant',content:JSON.stringify({items:outputs})}}]}));
  }catch(error){report.errors.push('mock: '+String(error));res.writeHead(500);res.end('{}');}
});
await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
const endpoint=`http://127.0.0.1:${mock.address().port}/v1/chat/completions`;
const release=()=>{providerMode='success';for(const resolve of held)resolve();held.clear();};
const playerExpression=`(() => {const isNativePlayer=${isNativePlayer.toString()};return (${findNativePlayer.toString()})(location.pathname.split('/')[2]);})()`;
const native=(surface,action)=>surface.evaluate(`(async()=>{const p=${playerExpression};if(!p)throw new Error('Native player absent');${action}})()`);
async function until(surface,fn,arg,timeout=30000) {
  const end=Date.now()+timeout;
  while(Date.now()<end){const value=await surface.evaluate(fn,arg);if(value)return value;await delay(100);}
  throw new Error('Timed out awaiting state: '+String(fn).slice(0,180));
}
async function waitFor(check,label,timeout=30000) {
  const end=Date.now()+timeout;
  while(Date.now()<end){const value=await check();if(value)return value;await delay(100);}
  throw new Error('Timed out: '+label);
}
async function save(patch) {
  const current=(await rpc({type:'settings'})).settings;
  const response=await rpc({type:'save',settings:{...current,...patch},remember:false});
  assert.equal(response.ok,true,response.error);
  return response.settings;
}
const screenshot=async(name)=>{
  const path=resolve(runDir,name+'.png');
  // A covered site control may scroll before its click fails; keep video evidence
  // on the actual native player instead of the recommendations below it.
  if(phase==='real-niconico' && !(await page.evaluate(()=>!!document.fullscreenElement))) {
    const player=page.locator('[data-danlingo-player]');
    if(await player.count())await player.first().evaluate(node=>node.scrollIntoView({block:'center'}));
  }
  await page.screenshot({path});return path;
};
const bridgeState=()=>page.evaluate(()=>({snapshot:window.__DL_VOD__?.snapshot,sourceCount:window.__DL_VOD__?.sources.size,
  sourceGeneration:window.__DL_VOD__?.sourceGeneration,sourceComplete:window.__DL_VOD__?.sourceComplete,chunks:window.__DL_VOD__?.chunks,prepared:window.__DL_VOD__?.prepared.size}));
async function assertProgress(name) {
  const host=page.locator('#danlingo-progress');
  await host.waitFor({state:'visible'});
  const summary=host.locator('#progress-summary');
  assert.match(await summary.innerText(),/准备|翻译/);
  const box=await host.boundingBox();
  const panelBox=await host.locator('#panel').boundingBox();
  assert.ok(panelBox && panelBox.width<=420 && panelBox.height<=140,'Collapsed progress should stay compact');
  const playerBox=await host.evaluate(node=>{
    const surface=document.querySelector('[data-danlingo-player]');
    const player=surface?.closest('.PlayerPresenter')??surface;
    const rect=player.getBoundingClientRect();
    return {bottom:rect.bottom,width:rect.width,inside:player.contains(node)};
  });
  assert.ok(box && !playerBox.inside && box.y>=playerBox.bottom-1 && box.width<=playerBox.width+1,'Progress must flow below the complete player, outside the video');
  const secretLeak=await host.evaluate(node=>node.shadowRoot?.textContent ?? node.textContent);
  assert.ok(!secretLeak.includes('danlingo-vod-local-test-only') && !secretLeak.includes(endpoint));
  return {box,text:await summary.innerText(),screenshot:await screenshot(name)};
}
async function setScope(scope,seconds) {
  const host=page.locator('#danlingo-progress');
  if(!await host.locator('details').evaluate(node=>node.open))await host.locator('#progress-summary').click();
  await host.locator('#scope').selectOption(scope);
  await waitFor(async()=>(await rpc({type:'settings'})).settings.translationScope===scope,'player scope change persists');
  if(scope==='window' && seconds!==undefined){await host.locator('#window-seconds').fill(String(seconds));await host.locator('#apply-window').click();}
  await waitFor(async()=>{const s=(await rpc({type:'settings'})).settings;return s.translationScope===scope && (seconds===undefined||s.prefetchSeconds===seconds);},'player controls persist scope/window');
  if(await host.locator('details').evaluate(node=>node.open))await host.locator('#progress-summary').click();
}

try {
  const profile=await mkdtemp(resolve('.artifacts/profiles/vod-'));
  report.profile=profile;
  context=await chromium.launchPersistentContext(profile,{headless:true,
    ...browserOptions,viewport:{width:1440,height:1000},locale:'ja-JP',
    args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
  report.browserVersion=context.browser()?.version();
  const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
  const extensionId=new URL(worker.url()).host;
  options=await context.newPage();await options.goto(`chrome-extension://${extensionId}/options.html`);
  rpc=payload=>options.evaluate(payload=>chrome.runtime.sendMessage(payload),payload);
  await until(options,()=>!!document.getElementById('key-state')?.textContent);
  const initial=(await rpc({type:'settings'})).settings;
  const configured=await rpc({type:'save',settings:{...initial,endpoint,model:'vod-deterministic-mock',profile:'chat-completions',thinkingEffort:'default',
    allowLocalHttp:true,enabled:true,sourceLanguage:'ja',targetLanguage:'zh-Hans',translationScope:'all',prefetchSeconds:60,urgentSeconds:5,
    concurrency:4,batchSize:100,maxBatchChars:12000,requestTimeoutMs:12000,cacheMaxEntries:20000},apiKey:'danlingo-vod-local-test-only',remember:false});
  assert.equal(configured.ok,true,configured.error);
  assert.equal(configured.hasKey,true);
  report.settings=configured.settings;
  await rpc({type:'clear-cache'});
  await options.reload();await options.locator('#thinking-effort').waitFor();
  await until(options,value=>document.getElementById('endpoint')?.value===value&&document.getElementById('thinking-effort')?.value==='default',endpoint);
  report.optionsScreenshot=resolve(runDir,'options-thinking-default.png');
  await options.screenshot({path:report.optionsScreenshot,fullPage:true});

  if(resetOnly) {
    phase='fixture-reset';providerMode='hold';
    page=await context.newPage();await page.addInitScript(installBridgeObserver);await page.addInitScript(installNativeFixture);
    await page.route('https://www.nicovideo.jp/**',route=>route.fulfill({status:200,contentType:'text/html',body:fixtureHtml}));
    await page.goto(fixtureUrl,{waitUntil:'domcontentloaded'});await page.bringToFront();
    await waitFor(()=>report.requests.length>0,'initial held provider request');
    const before=await bridgeState();
    const engineBefore=(await rpc({type:'overview'})).engine;
    assert.ok(engineBefore.activeRequests>0,'Clear-cache regression requires provider work in flight');
    await page.evaluate(()=>{window.__DL_FIXTURE__.change('far-0','キャッシュ消去中に変わったコメント');window.__DL_FIXTURE__.remove('far-1');window.__DL_FIXTURE__.add('reset-added',240000,'キャッシュ消去中の追加コメント');});
    const cleared=await rpc({type:'clear-cache'});assert.equal(cleared.ok,true,cleared.error);
    release();
    await until(page,previous=>{const s=window.__DL_VOD__,rows=[...s.sources.values()];return s.sourceGeneration!==previous&&s.sourceComplete&&rows.length===5120&&rows.some(row=>row.sourceId==='reset-added')&&rows.some(row=>row.originalText==='キャッシュ消去中に変わったコメント')&&!rows.some(row=>row.sourceId==='far-1');},before.sourceGeneration,45000);
    await until(page,()=>window.__DL_VOD__.prepared.size===5120&&[...window.__DL_VOD__.prepared.values()].some(row=>row.text==='【模拟译文】キャッシュ消去中に変わったコメント'),undefined,60000);
    const after=await bridgeState();
    const rendered=await page.evaluate(()=>window.__DL_FIXTURE__.render('far-0'));
    assert.equal(rendered.text,'【模拟译文】キャッシュ消去中に変わったコメント');
    report.reset={status:'passed',before,after,activeRequestsAtReset:engineBefore.activeRequests,rendered,screenshot:await screenshot('fixture-reset-progress')};
    console.log('PASS: clear-cache while requests in flight resumes fresh source generation with add/change/remove');
    await rpc({type:'toggle',enabled:false});await page.close();page=null;
  }

  if(!realOnly && !resetOnly) {
    phase='fixture-all';
    page=await context.newPage();
    await page.addInitScript(installBridgeObserver);await page.addInitScript(installNativeFixture);
    await page.route('https://www.nicovideo.jp/**',route=>route.fulfill({status:200,contentType:'text/html',body:fixtureHtml}));
    await page.goto(fixtureUrl,{waitUntil:'domcontentloaded'});await page.bringToFront();
    await until(page,()=>window.__DL_VOD__?.sourceComplete && window.__DL_VOD__.sources.size===5120,undefined,45000);
    const pool=await bridgeState();
    assert.ok(pool.chunks.length>1 && pool.chunks.every(c=>c.count<=500),'Full source pool must be chunked');
    assert.ok(await page.evaluate(()=>[...window.__DL_VOD__.sources.values()].some(m=>m.mediaTimeMs>125000)));
    assert.ok(await page.evaluate(()=>[...window.__DL_VOD__.sources.values()].some(m=>m.sourceId==='zero' && m.renderAtMs<0)));
    report.fixture.checks.fullPool={count:pool.sourceCount,chunks:pool.chunks.length,maxChunkRows:Math.max(...pool.chunks.map(c=>c.count)),past125Seconds:true};
    await until(page,()=>['zero','negative-render'].every(id=>[...window.__DL_VOD__.prepared.values()].some(row=>JSON.parse(row.id).at(-1)===id)),undefined,30000);
    report.fixture.checks.beginningBeforeFilterWait=await page.evaluate(()=>({
      at:performance.now(),filters:window.__DL_FIXTURE__.player.commentRenderer.layerProcessorList.map(layer=>layer.getStagingFilterNameList()),
      drawn:window.__DL_FIXTURE__.state.drawn,refreshSnapshots:window.__DL_FIXTURE__.state.refreshSnapshots,
      prepared:[...window.__DL_VOD__.prepared.values()].filter(row=>['zero','negative-render'].includes(JSON.parse(row.id).at(-1))),
    }));
    // Preparing and installing the native filter are separate asynchronous bridge steps.
    // Wait for the actual filter, but do not manually redraw stale opening comments.
    await until(page,()=>window.__DL_FIXTURE__.player.commentRenderer.layerProcessorList.every(layer=>layer.getStagingFilterNameList().includes('danlingo-text-v1')));
    assert.deepEqual(await page.evaluate(()=>({play:window.__DL_FIXTURE__.state.playCalls,pause:window.__DL_FIXTURE__.state.pauseCalls,paused:window.__DL_FIXTURE__.state.paused})),{play:0,pause:0,paused:true});
    const beginning=await page.evaluate(()=>['zero','negative-render'].map(id=>window.__DL_FIXTURE__.state.drawn[id]));
    report.fixture.checks.beginningAfterFilterWait=await page.evaluate(()=>({at:performance.now(),filters:window.__DL_FIXTURE__.player.commentRenderer.layerProcessorList.map(layer=>layer.getStagingFilterNameList()),drawn:window.__DL_FIXTURE__.state.drawn,refreshSnapshots:window.__DL_FIXTURE__.state.refreshSnapshots}));
    assert.ok(beginning.every(row=>row?.text==='【模拟译文】'+row.original),'Paused opening vpos=0/negative comments must be redrawn by the native bridge without a user play/seek');
    report.fixture.checks.openPaused={zeroAndNegativePrepared:true,playCalls:0,pauseCalls:0,beginning};
    const firstInputs=report.requests.filter(row=>row.phase==='fixture-all').slice(0,4).flatMap(row=>row.texts);
    assert.ok(firstInputs.includes('初めから準備するコメント'),'Near queue should enter first active batches');
    assert.ok(firstInputs.some(text=>text.startsWith('バッファ範囲')),'Buffered queue should precede the remote bulk');
    report.fixture.checks.priority={nearInFirstActiveBatches:true,bufferedInFirstActiveBatches:true};
    await until(page,()=>window.__DL_VOD__.prepared.size===5120,undefined,120000);
    await waitFor(async()=>{const s=(await rpc({type:'overview'})).engine;return s.activeRequests===0&&s.pendingItems===0;},'all mock requests settled');
    report.fixture.checks.allPrepared={count:5120,requests:report.requests.filter(r=>r.phase==='fixture-all').length};
    report.fixture.checks.progress=await assertProgress('fixture-paused-progress');
    console.log('PASS: fixture paused-first translation, chunked 5120 pool, priority, full-video preparation');

    phase='fixture-source-change';
    await page.evaluate(()=>{window.__DL_FIXTURE__.add('added',210000,'新しく追加されたコメント');window.__DL_FIXTURE__.change('far-0','内容が変わったコメント');window.__DL_FIXTURE__.remove('far-1');});
    await until(page,()=>{const rows=[...window.__DL_VOD__.sources.values()];return rows.length===5120&&rows.some(m=>m.sourceId==='added')&&rows.some(m=>m.sourceId==='far-0'&&m.originalText==='内容が変わったコメント')&&!rows.some(m=>m.sourceId==='far-1');});
    await until(page,()=>['新しく追加されたコメント','内容が変わったコメント'].every(text=>[...window.__DL_VOD__.prepared.values()].some(m=>m.text==='【模拟译文】'+text)));
    const changedRender=await page.evaluate(()=>window.__DL_FIXTURE__.render('far-0'));
    assert.equal(changedRender.text,'【模拟译文】内容が変わったコメント');
    report.fixture.checks.sourceReconciliation={add:true,change:true,remove:true,changedRender};
    await waitFor(async()=>{const s=(await rpc({type:'overview'})).engine;return s.activeRequests===0&&s.pendingItems===0;},'changed source requests settled');
    phase='fixture-cached-seek';
    const beforeSeek=report.requests.length;
    await page.evaluate(()=>window.__DL_FIXTURE__.seek(300));
    await until(page,()=>window.__DL_VOD__.snapshot.clock.mediaTimeMs===300000);
    const replay=await page.evaluate(()=>window.__DL_FIXTURE__.render('far-2'));
    assert.equal(replay.text,'【模拟译文】'+replay.original);
    // Observe several scheduler/bridge cycles while all source IDs remain the same.
    const seekMark=await page.evaluate(()=>performance.now());
    await until(page,at=>performance.now()-at>1800,seekMark);
    assert.equal(report.requests.length,beforeSeek,'Same-video seek must reuse completed translations');
    report.fixture.checks.cachedSeek={additionalProviderCalls:0,replay};

    phase='fixture-translation-coverage';
    await page.evaluate(()=>{
      const f=window.__DL_FIXTURE__;
      const device=f.chat('regression-device',7750,'ミクちゃん19周年おめでとうございます');
      device.comment.commands=['184','device:Switch'];
      const special=f.chat('regression-special',10000,'特別な配置のコメント');
      special.comment.commands=['184','device:Switch','full','ender'];
      f.rows.push(device,special,
        f.chat('regression-face',156320,'この頃に生まれたかったಠ\u2060益\u2060ಠ'),
        f.chat('regression-art',10000,'すごい┻━┻'),f.chat('regression-symbols',10000,'www'));
    });
    await until(page,()=>['ミクちゃん19周年おめでとうございます','この頃に生まれたかったಠ\u2060益\u2060ಠ'].every(text=>
      [...window.__DL_VOD__.prepared.values()].some(row=>row.text==='【模拟译文】'+text)));
    await until(page,()=>document.getElementById('danlingo-progress')?.shadowRoot.querySelector('#progress-summary')?.textContent==='已准备 5122 / 5122');
    const coverageHost=page.locator('#danlingo-progress');
    await coverageHost.locator('#progress-summary').click();
    assert.equal(await coverageHost.locator('#coverage').innerText(),'当前范围 5125 条 · 需翻译 5122 条');
    assert.equal(await coverageHost.locator('#skipped').innerText(),'保留原文 3 条：语言判断/符号 1 · 特殊样式 1 · 未识别颜文字 1');
    const coverageRender=await page.evaluate(()=>['regression-device','regression-face','regression-special','regression-art','regression-symbols'].map(window.__DL_FIXTURE__.render));
    for(const row of coverageRender)assert.equal(row.text,['regression-device','regression-face'].includes(row.id)?'【模拟译文】'+row.original:row.original);
    const coverageInputs=report.requests.filter(row=>row.phase==='fixture-translation-coverage').flatMap(row=>row.texts);
    assert.equal(coverageInputs.length,2,'Only the device comment and protected face sentence should reach the provider');
    assert.ok(coverageInputs.includes('ミクちゃん19周年おめでとうございます'));
    assert.ok(coverageInputs.some(text=>/^この頃に生まれたかった\[\[DL:[A-Za-z0-9_:.-]+\]\]$/.test(text)),'The face must travel as one protected placeholder');
    report.fixture.checks.translationCoverage={prepared:5122,total:5125,excluded:3,coverageRender,inputs:coverageInputs,screenshot:await screenshot('fixture-translation-coverage')};
    await coverageHost.locator('#progress-summary').click();
    console.log('PASS: device metadata and joined-face sentences prepare/render; excluded comments remain original and progress explains coverage');

    phase='fixture-late';providerMode='hold';
    await page.evaluate(()=>{window.__DL_FIXTURE__.seek(60);window.__DL_FIXTURE__.player.getVideoElement().play();window.__DL_FIXTURE__.add('late',62000,'途中で翻訳が届くコメント');});
    await waitFor(()=>report.requests.some(row=>row.phase==='fixture-late'),'held late request');
    const beforeLate=await page.evaluate(()=>window.__DL_FIXTURE__.render('late'));
    assert.equal(beforeLate.text,beforeLate.original);
    release();
    await until(page,()=>[...window.__DL_VOD__.prepared.values()].some(row=>row.text==='【模拟译文】途中で翻訳が届くコメント'));
    const afterLate=await page.evaluate(()=>window.__DL_FIXTURE__.render('late'));
    assert.equal(afterLate.text,beforeLate.original,'An already-staged active comment must not change midflight');
    await page.evaluate(()=>{window.__DL_FIXTURE__.player.getVideoElement().pause();window.__DL_FIXTURE__.seek(60);});
    await until(page,()=>window.__DL_VOD__.snapshot.clock.paused && window.__DL_VOD__.snapshot.clock.mediaTimeMs===60000);
    const replayLate=await page.evaluate(()=>window.__DL_FIXTURE__.render('late'));
    assert.equal(replayLate.text,'【模拟译文】'+replayLate.original);
    assert.deepEqual(await page.evaluate(()=>({play:window.__DL_FIXTURE__.state.playCalls,pause:window.__DL_FIXTURE__.state.pauseCalls})),{play:1,pause:1});
    report.fixture.checks.noMidflightReplacement={beforeLate,afterLate,replayLate,playCalls:1,pauseCalls:1};
    await page.locator('#fixture-fullscreen').click();
    await until(page,()=>document.fullscreenElement?.id==='fixture-stage');
    await page.locator('#danlingo-progress').waitFor({state:'hidden'});
    report.fixture.checks.fullscreenHidden={hidden:true,screenshot:await screenshot('fixture-fullscreen-no-progress')};
    await page.evaluate(()=>document.exitFullscreen());
    await assertProgress('fixture-exit-fullscreen-progress');
    console.log('PASS: fixture source add/change/remove, cached seek, no playback interference or midflight replacement');

    phase='fixture-window';
    await setScope('window',5);
    await rpc({type:'toggle',enabled:false});await rpc({type:'clear-cache'});
    await page.reload({waitUntil:'domcontentloaded'});
    await until(page,()=>window.__DL_VOD__?.sourceComplete);
    await rpc({type:'toggle',enabled:true});
    await until(page,()=>window.__DL_VOD__.prepared.size>=2);
    await waitFor(async()=>{const s=(await rpc({type:'overview'})).engine;return s.activeRequests===0&&s.pendingItems===0;},'window scope requests settled');
    const windowMark=await page.evaluate(()=>performance.now());
    await until(page,at=>performance.now()-at>1800,windowMark);
    const windowRequests=report.requests.filter(row=>row.phase==='fixture-window');
    assert.ok(windowRequests.length>0);
    assert.ok(windowRequests.every(row=>row.texts.every(text=>!text.startsWith('未来のコメント'))),'Window mode must not consume remote full-video bulk');
    assert.deepEqual(await page.evaluate(()=>({play:window.__DL_FIXTURE__.state.playCalls,pause:window.__DL_FIXTURE__.state.pauseCalls})),{play:0,pause:0});
    report.fixture.checks.windowControl={scope:'window',seconds:5,requests:windowRequests.length,remoteBulkExcluded:true,screenshot:await screenshot('fixture-window-progress')};
    const progress=page.locator('#danlingo-progress');
    await progress.locator('#dismiss-progress').click();
    await rpc({type:'toggle',targetLanguage:'zh-Hant'});
    await until(page,()=>document.querySelector('#danlingo-progress')?.shadowRoot.querySelector('#restore-progress')?.hidden===false);
    assert.equal(await progress.locator('#panel').isVisible(),false);
    await page.evaluate(()=>document.getElementById('danlingo-progress').remove());
    await progress.waitFor({state:'visible'});
    assert.equal(await progress.locator('#panel').isVisible(),false,'Reattaching must preserve the current video dismissal');
    assert.equal(await page.locator('#danlingo-progress').count(),1);
    await progress.locator('#restore-progress').click();
    await progress.locator('#progress-summary').click();
    assert.equal(await progress.locator('details').evaluate(node=>node.open),true);
    await progress.locator('#dismiss-progress').click();
    await page.locator('#fixture-fullscreen').click();await until(page,()=>!!document.fullscreenElement);
    await progress.waitFor({state:'hidden'});await page.evaluate(()=>document.exitFullscreen());
    await progress.locator('#restore-progress').waitFor({state:'visible'});
    assert.equal(await progress.locator('#panel').isVisible(),false,'Exiting fullscreen must preserve dismissal');
    await page.evaluate(()=>{
      history.pushState({},'', '/watch/sm999999992');
      window.__DL_FIXTURE__.player.watch.video.id='sm999999992';
    });
    await until(page,()=>window.__DL_VOD__.snapshot?.resourceId==='sm999999992');
    await progress.locator('#panel').waitFor({state:'visible'});
    assert.equal(await progress.locator('details').evaluate(node=>node.open),false);
    assert.equal(await page.locator('#danlingo-progress').count(),1);
    await assertProgress('fixture-new-video-progress');
    await page.evaluate(()=>document.getElementById('fixture-stage').style.position='absolute');
    await progress.waitFor({state:'detached'});
    await page.evaluate(()=>document.getElementById('fixture-stage').style.position='relative');
    await progress.waitFor({state:'visible'});
    report.fixture.checks.progressLifecycle={dismissedAcrossUpdatesAndRemount:true,restoredOnNewVideo:true,fullscreenHidden:true,singleInstance:true,unsafeLayoutHidden:true};
    report.fixture.status='passed';report.fixture.final=await bridgeState();
    await rpc({type:'toggle',enabled:false});await page.close();page=null;
    console.log('PASS: fixture player scope/window controls persist and bound translation work');
  }

  if(!fixtureOnly && !resetOnly) {
    phase='real-niconico';
    await save({enabled:true,translationScope:'all',prefetchSeconds:60});await rpc({type:'clear-cache'});
    page=await context.newPage();await page.addInitScript(installBridgeObserver);await page.addInitScript(installPlaybackObserver);
    const startCalls=report.requests.length;
    let realAvailable=false;
    try {
      await page.goto('https://www.nicovideo.jp/watch/sm1715919',{waitUntil:'domcontentloaded',timeout:45000});await page.bringToFront();
      await until(page,()=>window.__DL_VOD__?.sourceComplete&&window.__DL_VOD__.sources.size>0,undefined,35000);
      realAvailable=true;
    }catch(error){report.real.status='unavailable';report.real.reason=String(error).slice(0,600);report.real.screenshot=await screenshot('real-unavailable').catch(()=>null);}
    if(realAvailable) {
      const before=await native(page,'return {paused:p.getVideoElement().paused,time:p.getCurrentTime(),pool:p.commentRenderer.layerProcessorList.reduce((n,l)=>n+(l.stagingChatManager?.chatList?.length??0),0)};');
      report.real.checks.openPaused={before};
      const originals=await native(page,"return p.commentRenderer.layerProcessorList.flatMap(l=>(l.stagingChatManager?.chatList??[]).slice(0,150).map(c=>({id:String(c.id),text:c.comment?.body,vposMs:c.vposMs}))); ");
      await until(page,()=>window.__DL_VOD__.prepared.size>0,undefined,30000);
      const after=await native(page,'return {paused:p.getVideoElement().paused,time:p.getCurrentTime()};');
      const playbackCalls=await page.evaluate(()=>window.__DL_PLAYBACK__);
      report.real.checks.openPaused={before,after,prepared:await page.evaluate(()=>window.__DL_VOD__.prepared.size),mockCalls:report.requests.length-startCalls,
        playbackCalls,sitePlaybackStateChanged:before.paused!==after.paused};
      assert.ok(playbackCalls.every(call=>!call.extensionCaller),'The extension must never call video.play or video.pause');
      report.real.checks.progress=await assertProgress('real-initial-progress');
      const sources=await page.evaluate(()=>[...window.__DL_VOD__.sources.values()]);
      report.real.checks.fullPool={observed:sources.length,nativePool:before.pool,sourceComplete:true,latestVposMs:Math.max(...sources.map(row=>row.mediaTimeMs))};
      if (!progressOnly) {
      await until(page,()=>window.__DL_VOD__.snapshot.clock.contentActive);
      await native(page,`
        window.__DL_NATIVE_STAGES__=[];
        for(const layer of p.commentRenderer.layerProcessorList)layer.addStagingFilter('danlingo-vod-evidence',(chat,settings)=>{
          if(settings.visible)window.__DL_NATIVE_STAGES__.push({id:String(chat.id),original:chat.comment?.body,text:settings.content,vposMs:chat.vposMs,mediaMs:p.getCurrentTime()*1000,at:performance.now()});
          return settings;
        });
        p.getVideoElement().pause();p.setCurrentTime(0);
      `);
      await until(page,()=>{const c=window.__DL_VOD__.snapshot.clock;return c.paused&&!c.seeking&&c.mediaTimeMs<1000;});
      async function playNative() {
        const button=page.getByRole('button',{name:'再生する',exact:true});
        if(await button.isVisible()) {
          await page.locator('[data-danlingo-player]').hover().catch(()=>{});
          try{await button.click({timeout:2000});return 'website play button';}
          catch(error){
            report.real.playButtonLimit=String(error.message).split('\n').slice(0,2).join(' ');
            // The anonymous site's paused storyboard may cover an otherwise visible
            // native control. Keep playback authorization explicit in this test.
          }
        }
        await native(page,'await p.getVideoElement().play();');return 'explicit harness native play';
      }
      const initialPlayMethod=await playNative();
      await until(page,()=>window.__DL_VOD__.snapshot.clock.mediaTimeMs>=4500,undefined,15000);
      await native(page,'p.getVideoElement().pause();');
      const firstStages=await page.evaluate(()=>window.__DL_NATIVE_STAGES__);
      report.real.checks.shortPlay={method:initialPlayMethod,stages:firstStages,translated:firstStages.filter(row=>row.text?.startsWith('【模拟译文】')).length,screenshot:await screenshot('real-native-short-play-LOCAL-MOCK')};
      const selection=await page.evaluate(()=>{
        const s=window.__DL_VOD__,rows=[...s.sources.values()].filter(row=>s.prepared.has(row.id)&&row.renderAtMs>=10000);
        return rows.map(row=>({start:Math.max(0,(row.renderAtMs-500)/1000),count:rows.filter(other=>other.renderAtMs>=row.renderAtMs&&other.renderAtMs<row.renderAtMs+7000).length})).sort((a,b)=>b.count-a.count)[0];
      });
      assert.ok(selection?.count>0,'Real player has no prepared future comments available for a seek check');
      const beforeJumpCalls=report.requests.length;
      await native(page,`window.__DL_NATIVE_STAGES__=[];p.setCurrentTime(${selection.start});`);
      await until(page,time=>{const c=window.__DL_VOD__.snapshot.clock;return c.paused&&!c.seeking&&Math.abs(c.mediaTimeMs-time*1000)<500;},selection.start);
      const seekPlayMethod=await playNative();
      await until(page,()=>window.__DL_NATIVE_STAGES__.some(row=>row.text?.startsWith('【模拟译文】')),undefined,12000);
      await until(page,time=>window.__DL_VOD__.snapshot.clock.mediaTimeMs>time*1000+4000,selection.start,12000);
      await native(page,'p.getVideoElement().pause();');
      const jumpStages=await page.evaluate(()=>window.__DL_NATIVE_STAGES__);
      assert.ok(jumpStages.some(row=>row.text?.startsWith('【模拟译文】')),'Actual native staging after prepared seek must use the mapped mock translation');
      report.real.checks.preparedSeek={selection,method:seekPlayMethod,additionalProviderCalls:report.requests.length-beforeJumpCalls,
        translated:jumpStages.filter(row=>row.text?.startsWith('【模拟译文】')).length,stages:jumpStages,screenshot:await screenshot('real-native-prepared-seek-LOCAL-MOCK')};
      }
      await native(page,'await p.stage.requestFullscreen();');await until(page,()=>document.fullscreenElement!==null);
      await page.locator('#danlingo-progress').waitFor({state:'hidden'});
      report.real.checks.fullscreenHidden={hidden:true,screenshot:await screenshot('real-fullscreen-no-progress')};
      await page.evaluate(()=>document.exitFullscreen());
      await assertProgress('real-exit-fullscreen-progress');
      await page.locator('#danlingo-progress #dismiss-progress').click();
      await page.locator('#danlingo-progress #restore-progress').waitFor({state:'visible'});
      await page.locator('#danlingo-progress #restore-progress').click();
      await page.locator('#danlingo-progress #progress-summary').click();
      assert.equal(await page.locator('#danlingo-progress details').evaluate(node=>node.open),true);
      report.real.checks.progressControls={closeAndRestore:true,details:true,screenshot:await screenshot('real-progress-details')};
      const afterSources=new Map((await native(page,"return p.commentRenderer.layerProcessorList.flatMap(l=>(l.stagingChatManager?.chatList??[]).slice(0,150).map(c=>({id:String(c.id),text:c.comment?.body,vposMs:c.vposMs}))); ")).map(row=>[row.id,row]));
      assert.ok(originals.length && originals.every(row=>row.text===afterSources.get(row.id)?.text && row.vposMs===afterSources.get(row.id)?.vposMs));
      report.real.checks.originalPoolPreserved=true;
      report.real.status='passed';report.real.final=await bridgeState();
      console.log(progressOnly?'PASS: real Niconico progress placement, close/restore/details, fullscreen hiding and original preservation; LOCAL MOCK provider':'PASS: real anonymous Niconico pool, native short play/prepared seek, original preservation and non-overlapping progress with local mock');
    }
  }
  assert.equal(report.errors.length,0);
  report.result=resetOnly?'PASS focused cache-reset regression':report.real.status==='unavailable'?(realOnly?'REAL SITE UNAVAILABLE; no fixture requested':'PASS fixture; real Niconico unavailable (see explicit limitation)'):realOnly?'PASS real-site checks; fixture not requested':'PASS requested VOD browser checks';
}catch(error){
  report.errors.push(String(error.stack??error).slice(0,3000));process.exitCode=1;
  if(phase.startsWith('fixture'))report.fixture.status='failed';else if(phase.startsWith('real'))report.real.status='failed';
  if(page){report.lastBridge=await bridgeState().catch(()=>null);await screenshot('failure').catch(()=>{});}
}finally{
  release();
  if(rpc){await rpc({type:'toggle',enabled:false}).catch(()=>{});await rpc({type:'delete-key'}).catch(()=>{});}
  await context?.close();
  mock.closeAllConnections();await new Promise(resolve=>mock.close(resolve));
  await writeFile(resolve(runDir,'report.json'),JSON.stringify(report,null,2));
  await writeFile(resolve(root,'report.json'),JSON.stringify(report,null,2));
}
console.log(JSON.stringify({report:resolve(runDir,'report.json'),result:report.result,fixture:report.fixture.status,real:report.real.status,requests:report.requests.length,errors:report.errors},null,2));
