import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Production extension + a real anonymous Niconico page + a deterministic local mock.
// No real translation service is called. Use an isolated profile; never read a personal one.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, cp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findNativePlayer, isNativePlayer } from '../src/platforms/niconico/native.ts';
import { verifySettings } from './settings-checks.mjs';
import { settingsSection } from './settings-navigation.mjs';

const isEdge = process.env.DANLINGO_E2E_BROWSER === 'edge';
const settingsOnly = process.argv.includes('--settings-only');
const root = resolve(settingsOnly ? '.artifacts/settings-ui' : '.artifacts/p1', isEdge ? 'edge' : '.');
await mkdir(root, { recursive: true });
// Headless Chromium cannot interact with the native optional-host consent bubble.
// Only the test copy grants this loopback origin at install time; shipped code/manifest stay intact.
const testExtension = resolve(root, 'test-extension');
await cp(resolve('.output/chrome-mv3'), testExtension, { recursive: true });
const testManifest = JSON.parse(await readFile(resolve(testExtension, 'manifest.json'), 'utf8'));
testManifest.host_permissions.push('http://127.0.0.1/*');
await writeFile(resolve(testExtension, 'manifest.json'), JSON.stringify(testManifest, null, 2));
const { chromium } = process.env.DANLINGO_PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(process.env.DANLINGO_PLAYWRIGHT_MODULE).href) : await import('playwright');
const report = { capturedAt: new Date().toISOString(), evidence: 'production-code-real-page-MOCK-provider', permissionLimit: 'Test copy grants only loopback host at install; native optional-host consent still needs manual Chrome/Edge acceptance.', checks: {}, errors: [], requests: [], modelQueries: [] };
let mode = 'success';
const held = new Set();
const release = () => { for (const done of held) done(); held.clear(); };
let context;
const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type' }); res.end(); return; }
  if (req.method === 'GET' && req.url === '/v1/models') {
    const requestMode = mode;
    report.modelQueries.push({at:Date.now(),authorized:req.headers.authorization==='Bearer danlingo-local-test-only'});
    res.setHeader('content-type','application/json');
    if (requestMode === 'models-held') await new Promise(done => held.add(done));
    if (requestMode === 'models-unsupported') { res.writeHead(404); res.end('{}'); return; }
    if (requestMode === 'models-empty') { res.end(JSON.stringify({data:[]})); return; }
    res.end(JSON.stringify({data:[{id:'deterministic-mock'},{id:'second-mock'}]})); return;
  }
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
  let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 100000) { res.writeHead(413); res.end(); return; } }
  const json = JSON.parse(body);
  const data = JSON.parse(json.messages.find(m => m.role === 'user').content);
  const request = { at: Date.now(), mode, model:json.model,thinking:json.thinking,reasoningEffort:json.reasoning_effort,items: data.items.length, ids: data.items.map(m => m.id), chars: data.items.reduce((n, m) => n + m.text.length, 0), sourceLanguage: data.sourceLanguage, targetLanguage: data.targetLanguage };
  report.requests.push(request);
  res.setHeader('content-type', 'application/json'); res.setHeader('access-control-allow-origin', '*');
  if (mode === 'unauthorized') { res.writeHead(401); res.end('{}'); return; }
  if (mode === 'limited') { res.writeHead(429, { 'retry-after': '2' }); res.end('{}'); return; }
  if (mode === 'rejected-params') { res.writeHead(422); res.end('private provider body'); return; }
  if (mode === 'invalid-response') { res.end(JSON.stringify({choices:[{message:{content:'not a translation envelope'}}]})); return; }
  if (mode === 'held') await new Promise(done => held.add(done));
  const outputs = data.items.map((item, i) => ({ id: item.id,
    text: (i % 2 ? '【模拟译文】看懂了' : '【模拟译文】这是一条较长的中文，用于检查原生布局') + (item.text.match(/\[\[DL:[A-Za-z0-9_.:-]+\]\]|__DL_[A-Za-z0-9_]+__|⟦DL:[A-Za-z0-9_.:-]+⟧/g) ?? []).join(''),
  })).reverse(); // Deliberately reverse the output order: array position must not be used.
  if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 4000));
  if (mode === 'partial') outputs.pop();
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ items: outputs }) } }] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
const playerExpression = `(() => { const isNativePlayer = ${isNativePlayer.toString()}; return (${findNativePlayer.toString()})(location.pathname.split('/')[2]); })()`;
const native = async (page, action) => page.evaluate(`(async () => { const p = ${playerExpression}; if (!p) throw new Error('Native player absent'); ${action} })()`);
function usePollingWaits(surface) {
  // Await asynchronous runtime RPC predicates explicitly; a Promise itself is not a pass.
  // Node owns polling so hidden-document animation frame throttling cannot skip the checks.
  surface.waitForFunction = async (fn, arg, options = {}) => {
    const until = Date.now() + (options.timeout ?? 30000);
    for (;;) {
      const result = await surface.evaluate(fn, arg);
      if (result) return result;
      if (Date.now() >= until) throw new Error('Timed out awaiting actual state: '+String(fn).slice(0,180));
      await new Promise(resolve=>setTimeout(resolve,100));
    }
  };
}
let page;
let options;
try {
  const profile = await mkdtemp(resolve('.artifacts/profiles/p1-extension-'));
  report.profile = profile;
  context = await chromium.launchPersistentContext(profile, {
    headless: true, ...browserLaunchOptions(isEdge ? "edge" : "chromium"),
    viewport: { width: 1440, height: 1000 }, locale: 'ja-JP',
    args: ['--disable-extensions-except=' + testExtension, '--load-extension=' + testExtension],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  worker.on('console', msg => { if (msg.type() === 'error') report.errors.push('background console error'); });
  const extensionId = new URL(worker.url()).host;
  options = await context.newPage();
  usePollingWaits(options);
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.locator('#endpoint').waitFor();
  report.initialRpc = await options.evaluate(async () => ({ url: location.href, expected: chrome.runtime.getURL('/options.html'), response: await chrome.runtime.sendMessage({type:'settings'}) }));
  await options.waitForFunction(() => document.getElementById('result')?.textContent === '已保存', undefined, {timeout:10000});
  assert.equal(await options.locator('#result').innerText(), '已保存');
  await options.locator('#endpoint').fill(endpoint.replace('http://','http:').replace('/chat/completions',''));
  await settingsSection(options,'advanced');await options.locator('#profile').evaluate(el=>el.closest('details').open=true);await options.locator('#profile').selectOption('chat-completions');await settingsSection(options,'service');
  await options.locator('#model').fill('not-in-model-list');
  await options.locator('#api-key').fill('danlingo-local-test-only');
  await options.locator('#remember').uncheck();
  await settingsSection(options,'watching'); await options.locator('#source-language').selectOption('ja');
  await options.locator('#enabled').check();
  await settingsSection(options,'advanced');await options.locator('summary').filter({ hasText: '请求与预取参数' }).click();
  await options.locator('#local-http').check();await settingsSection(options,'service');
  await options.locator('#get-models').click();
  await options.waitForFunction(()=>document.getElementById('models-result')?.textContent?.startsWith('已获取 2 个模型'),undefined,{timeout:10000});
  assert.equal(await options.locator('#model').inputValue(),'deterministic-mock');
  // The connection layer retains the authored address and separately resolves the request URL.
  assert.equal(await options.locator('#endpoint').inputValue(),endpoint.replace('http://','http:').replace('/chat/completions',''));
  assert.ok((await options.locator('#connection-status').textContent()).includes(endpoint));
  assert.equal((await options.evaluate(()=>chrome.runtime.sendMessage({type:'settings'}))).hasKey,false,'Discovery must not save credentials');
  await options.locator('#save').click();
  await options.waitForFunction(() => document.getElementById('result')?.textContent !== '正在保存…');
  const saved = await options.locator('#result').innerText();
  assert.equal(saved, '已保存'); report.checks.settingsSaved = true;
  console.log('PASS: options settings and loopback host permission');
  await options.screenshot({ path: resolve(root, 'options.png'), fullPage: true });

  const rpc = payload => options.evaluate(payload => chrome.runtime.sendMessage(payload), payload);
  const settings = (await rpc({ type: 'settings' })).settings;
  assert.equal(settings.endpoint,endpoint);
  const models=await rpc({type:'models',settings});
  assert.deepEqual(models.models,['deterministic-mock','second-mock']);
  assert.equal(report.modelQueries.length,2);
  assert.ok(report.modelQueries.every(query=>query.authorized));
  const otherOrigin=new URL(settings.endpoint);otherOrigin.port=String(Number(otherOrigin.port)+1);
  const blockedModels=await rpc({type:'models',settings:{...settings,endpoint:otherOrigin.href}});
  assert.equal(blockedModels.ok,false);
  assert.equal(blockedModels.error,'请为此服务填写 API Key');
  report.checks.modelDiscovery={queries:2,autoSelected:true,didNotSaveKey:true,reusedSameOriginKey:true,blockedOtherOriginKey:true};
  if (settingsOnly) {
    report.checks.serviceSettings = await verifySettings({ options, rpc, report, root, endpoint, settings, setMode: value => { mode = value; }, release });
    report.result = 'PASS: production extension settings, local mock provider only; no real model or native permission prompt tested';
  } else {
  // Each run starts with a fresh cache while retaining only its isolated browser's playback consent.
  await rpc({ type: 'clear-cache' });
  page = context.pages()[0] ?? await context.newPage();
  usePollingWaits(page);
  await page.addInitScript(() => {
    window.__DL_E2E__ = { snapshot: null, sources: [], prepared: [], scopes: [] };
    window.addEventListener('message', event => {
      const d = event.data;
      if (event.source !== window || d?.bridge !== 'danlingo.native.v1') return;
      const state = window.__DL_E2E__;
      if (d.from === 'native' && d.type === 'snapshot') {
        state.snapshot = d;
        const scope = `${d.resourceId}:${d.session}:${d.epoch}`;
        if (state.scopes.at(-1) !== scope) state.scopes.push(scope);
      }
      if (d.from === 'native' && d.type === 'sources') {
        const pool = new Map((d.reset ? [] : state.sources).map(m => [m.id, m]));
        for (const id of d.removes) pool.delete(id);
        for (const m of d.upserts) pool.set(m.id, m);
        state.sources = [...pool.values()];
      }
      if (d.from === 'content' && d.type === 'prepared') {
        state.prepared.push({ at: performance.now(), scope: `${d.resourceId}:${d.session}:${d.epoch}`, items: d.items });
        if (state.prepared.length > 100) state.prepared.shift();
      }
    });
  });
  await page.goto('https://www.nicovideo.jp/watch/sm1715919', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.bringToFront();
  await page.waitForFunction(() => window.__DL_E2E__?.sources.length > 0, undefined, { timeout: 30000 });
  const play = page.getByRole('button', { name: '再生する', exact: true });
  if (await play.isVisible()) await play.click();
  else await native(page, 'await p.getVideoElement().play();');
  await page.waitForFunction(() => window.__DL_E2E__?.snapshot?.clock?.contentActive === true, undefined, { timeout: 30000 });
  await native(page, 'p.getVideoElement().pause();');
  await page.waitForFunction(() => window.__DL_E2E__.prepared.length > 0, undefined, { timeout: 20000 });
  const originals = await native(page, "return p.commentRenderer.layerProcessorList.flatMap(l => (l.stagingChatManager?.chatList ?? []).slice(0,200).map(c=>({id: String(c.id),body: c.comment?.body,vposMs:c.vposMs})));");
  await native(page, 'await p.getVideoElement().play();');
  await page.waitForFunction(() => window.__DL_E2E__.snapshot?.counts?.translated >= 3, undefined, { timeout: 30000 });
  await native(page, 'p.getVideoElement().pause();');
  report.checks.nativeTranslated = await page.evaluate(() => window.__DL_E2E__.snapshot.counts);
  report.checks.preparedBatches = await page.evaluate(() => window.__DL_E2E__.prepared.length);
  assert.ok(report.requests.some(r => r.items > 1), 'No actual multi-item HTTP request');
  report.checks.realMultiItemMockRequest = true;
  report.checks.nativeFilters = await native(page, 'return p.commentRenderer.layerProcessorList.map(l=>l.getStagingFilterNameList());');
  const after = new Map((await native(page, "return p.commentRenderer.layerProcessorList.flatMap(l => (l.stagingChatManager?.chatList ?? []).slice(0,200).map(c=>({id: String(c.id),body: c.comment?.body,vposMs:c.vposMs})));")).map(row => [row.id, row]));
  assert.ok(originals.length && originals.every(row => row.body === after.get(row.id)?.body && row.vposMs === after.get(row.id)?.vposMs));
  report.checks.originalSamplePreserved = true;
  await page.screenshot({ path: resolve(root, 'native-mock.png') });
  const beforeReplay = await rpc({ type: 'overview' });
  assert.ok(beforeReplay.cache.entries > 0);
  await options.waitForFunction(async () => {
    const r = await chrome.runtime.sendMessage({ type: 'overview' });
    return r.status?.sourceComplete && r.status.queued === 0 && r.engine.activeRequests === 0;
  }, undefined, { timeout: 30000 });
  const replayCalls = (await rpc({ type: 'overview' })).engine.providerCalls;
  await native(page, 'p.setCurrentTime(0);');
  await page.waitForFunction(() => window.__DL_E2E__.snapshot.clock.mediaTimeMs < 1000);
  const afterReplay = await rpc({ type: 'overview' });
  assert.equal(afterReplay.engine.providerCalls, replayCalls, 'Same-video replay reuses the prepared pool');
  report.checks.replayReuse = { additionalProviderCalls: 0, durableCacheEntries: afterReplay.cache.entries };

  // Exercise production cancellation/notice paths against controlled HTTP failures.
  const save = async patch => {
    const response = await rpc({type:'save', settings:{...settings,...patch}, remember:false});
    assert.equal(response.ok, true, response.error);
  };
  await rpc({type:'toggle',enabled:false});
  await rpc({type:'clear-cache'});
  mode='unauthorized';
  const before401=report.requests.length;
  await save({enabled:true});
  await options.waitForFunction(async () => (await chrome.runtime.sendMessage({type:'overview'})).engine.lastError?.status === 401, undefined, {timeout:10000});
  await page.waitForFunction(() => window.__DL_E2E__.snapshot?.clock.paused === true);
  await native(page, 'p.setCurrentTime(50);');
  await page.waitForFunction(() => Math.abs(window.__DL_E2E__.snapshot.clock.mediaTimeMs-50000)<1000);
  const started401=report.requests.slice(before401).filter(r=>r.mode==='unauthorized').length;
  assert.ok(started401>0 && started401<=2, '401 should stop admitting new work after bounded active batches');
  report.checks.unauthorized={requests:started401,error:(await rpc({type:'overview'})).engine.lastError};
  console.log('PASS: real-page mock HTTP 401 pauses further admissions');

  await rpc({type:'toggle',enabled:false});
  mode='limited';
  const before429=report.requests.length;
  await save({enabled:true});
  await options.waitForFunction(async () => (await chrome.runtime.sendMessage({type:'overview'})).engine.lastError?.status === 429, undefined, {timeout:10000});
  const retryWait = Date.now();
  for (;;) {
    const observed = report.requests.slice(before429).filter(r=>r.mode==='limited');
    if (observed.some((r,i)=>i>0 && r.at-observed[i-1].at>=1900)) break;
    if (Date.now()-retryWait>10000) throw new Error('No observed mock HTTP retry after Retry-After');
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  await rpc({type:'toggle',enabled:false});
  const limited=report.requests.slice(before429).filter(r=>r.mode==='limited');
  assert.ok(limited.length>=2 && limited.some((r,i)=>i>0 && r.at-limited[i-1].at>=1900));
  report.checks.rateLimitBackoff={requests:limited.length,intervalsMs:limited.slice(1).map((r,i)=>r.at-limited[i].at)};

  mode='slow';
  await rpc({type:'clear-cache'});
  const beforeSlow=report.requests.length;
  const beforeSlowStats=(await rpc({type:'overview'})).engine;
  await save({enabled:true,requestTimeoutMs:1000});
  const slowWait=Date.now();
  while(!report.requests.slice(beforeSlow).some(r=>r.mode==='slow')) {
    if(Date.now()-slowWait>10000)throw new Error('No mock slow request observed');
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  // The subscriber deadline can cancel transport immediately before its timeout callback.
  // Both are bounded fallback; require new expiry evidence instead of a particular racing label.
  await options.waitForFunction(async baseline => {
    const s=(await chrome.runtime.sendMessage({type:'overview'})).engine;
    return s.providerCalls>baseline.providerCalls && (s.expired>baseline.expired || s.lastError?.reason==='timeout');
  },beforeSlowStats,{timeout:12000});
  const slowState=(await rpc({type:'overview'})).engine;
  report.checks.slowFallback={newExpired:slowState.expired-beforeSlowStats.expired,transportTimeout:slowState.lastError?.reason==='timeout'};
  const oldScope=await page.evaluate(()=>window.__DL_E2E__.scopes.at(-1));
  await native(page,'p.setCurrentTime(90);');
  await page.waitForFunction(old=>window.__DL_E2E__.scopes.at(-1)!==old,oldScope);
  const afterSeekMark=await page.evaluate(()=>({scope:window.__DL_E2E__.scopes.at(-1),at:performance.now()}));
  mode='success';
  await save({enabled:true});
  await page.waitForFunction(mark=>window.__DL_E2E__.prepared.some(batch=>batch.at>mark.at && batch.scope===mark.scope),afterSeekMark,{timeout:10000});
  assert.ok(await page.evaluate(mark=>window.__DL_E2E__.prepared.filter(b=>b.at>mark.at).every(b=>b.scope===mark.scope),afterSeekMark));
  report.checks.timeoutAndSeekIsolation={slowRequests:report.requests.slice(beforeSlow).filter(r=>r.mode==='slow').length,recovered:true};
  console.log('PASS: HTTP 429 backoff, timeout fallback and seek generation isolation');

  await native(page,'p.setPlaybackRate(1.25);');
  await page.waitForFunction(()=>window.__DL_E2E__.snapshot.clock.playbackRate===1.25);
  await native(page,'p.setPlaybackRate(0.5);');
  await page.waitForFunction(()=>window.__DL_E2E__.snapshot.clock.playbackRate===0.5);
  await native(page,'p.setPlaybackRate(1);');
  await page.bringToFront();
  await native(page,'await p.stage.requestFullscreen();');
  await page.waitForFunction(()=>document.fullscreenElement!==null);
  await page.screenshot({path:resolve(root,'fullscreen-mock.png')});
  await page.evaluate(()=>document.exitFullscreen());
  report.checks.nativeRateAndFullscreen=true;

  // A real second resource (not a fixture) must rediscover its own player and prepare translated text.
  await page.goto('https://www.nicovideo.jp/watch/sm9',{waitUntil:'domcontentloaded',timeout:45000});
  await page.bringToFront();
  await page.waitForFunction(()=>window.__DL_E2E__?.sources.length>0 && window.__DL_E2E__.snapshot.resourceId==='sm9',undefined,{timeout:30000});
  if(await play.isVisible())await play.click();else await native(page,'await p.getVideoElement().play();');
  console.log('CHECK: second video content readiness');
  await page.waitForFunction(()=>window.__DL_E2E__.snapshot.clock.contentActive,undefined,{timeout:35000});
  await native(page,'p.setCurrentTime(40);p.getVideoElement().pause();');
  await page.waitForFunction(()=>{
    const c=window.__DL_E2E__.snapshot.clock;
    return Math.abs(c.mediaTimeMs-40000)<500 && !c.seeking && c.paused;
  },undefined,{timeout:20000});
  const secondScope=await page.evaluate(()=>window.__DL_E2E__.scopes.at(-1));
  await page.waitForFunction(scope=>window.__DL_E2E__.prepared.some(b=>b.scope===scope),secondScope,{timeout:20000});
  await native(page,'await p.getVideoElement().play();');
  await page.waitForFunction(()=>window.__DL_E2E__.snapshot.counts.translated>0,undefined,{timeout:40000});
  await native(page,'p.getVideoElement().pause();');
  report.checks.secondVideo={resourceId:'sm9',counts:await page.evaluate(()=>window.__DL_E2E__.snapshot.counts)};
  console.log('PASS: second video production native mock rendering');
  await page.screenshot({path:resolve(root,'sm9-native-mock.png')});

  // Simulate the pagehide/pageshow event path; actual BFCache residency is recorded separately.
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
  await page.waitForFunction(`!${playerExpression}.commentRenderer.layerProcessorList.some(l=>l.getStagingFilterNameList().includes('danlingo-text-v1'))`);
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
  await page.waitForFunction(`${playerExpression}.commentRenderer.layerProcessorList.some(l=>l.getStagingFilterNameList().includes('danlingo-text-v1'))`);
  report.checks.pageTransitionEventRecovery='PASS: synthetic events on real page; actual BFCache residency not established';

  await rpc({ type: 'toggle', enabled: false });
  await page.waitForFunction(`!${playerExpression}.commentRenderer.layerProcessorList.some(l=>l.getStagingFilterNameList().includes('danlingo-text-v1'))`);
  report.checks.disabledRestoresNative = true;
  const safe = await rpc({ type: 'settings' });
  assert.ok(!('apiKey' in safe) && !('apiKey' in safe.settings));
  report.checks.settingsResponseHasNoKey = true;
  const popup=await context.newPage();
  await popup.setViewportSize({width:350,height:480});
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.bringToFront();
  await popup.screenshot({path:resolve(root,'popup.png'),fullPage:true});
  await popup.close();
  // Stop the actual extension Service Worker, then wake it through the normal runtime contract.
  const beforeRestart=await rpc({type:'overview'});
  const sw=await context.newCDPSession(options);
  const versions=new Map();
  sw.on('ServiceWorker.workerVersionUpdated',event=>{for(const version of event.versions)versions.set(version.versionId,version);});
  await sw.send('ServiceWorker.enable');
  let version;
  const versionWait=Date.now();
  while(!(version=[...versions.values()].find(v=>v.scriptURL===worker.url())) && Date.now()-versionWait<3000)await new Promise(resolve=>setTimeout(resolve,50));
  if(version){
    await sw.send('ServiceWorker.stopWorker',{versionId:version.versionId});
    const resumed=await rpc({type:'overview'});
    assert.equal(resumed.ok,true);assert.equal(resumed.hasKey,true);
    assert.equal(resumed.cache.entries,beforeRestart.cache.entries);
    assert.equal(resumed.engine.providerCalls,0);
    report.checks.backgroundRestart={verified:true,cacheEntries:resumed.cache.entries,keySessionPreserved:resumed.hasKey};
  } else report.checks.backgroundRestart={verified:false,reason:'No extension worker version exposed by CDP'};
  await sw.detach();
  // Cross-origin changes must not reuse the previous endpoint's secret, even when a key input is blank.
  const changed=await rpc({type:'save',settings:{...settings,endpoint:'https://www.nicovideo.jp/danlingo-test-never-called',enabled:false},remember:false});
  assert.equal(changed.ok,true);assert.equal(changed.hasKey,false);
  report.checks.endpointChangeClearsKey=true;
  report.overview = await rpc({ type: 'overview' });
  report.result = 'PASS: production code with test loopback host grant, real native text preparation/render, original preservation, batch HTTP mapping, replay cache and disable; deterministic MOCK only';
  }
} catch (error) {
  report.errors.push(String(error.stack ?? error).slice(0, 2000));
  if (options) {
    report.optionsStatus = await options.locator('#result').textContent().catch(() => 'options unavailable');
    await options.screenshot({ path: resolve(root, 'options-failure.png'), fullPage: true }).catch(() => {});
  }
  if (page) {
    report.lastBridge = await page.evaluate(() => window.__DL_E2E__ ? { snapshot: window.__DL_E2E__.snapshot, preparedCount: window.__DL_E2E__.prepared.length } : null).catch(() => null);
    await page.screenshot({ path: resolve(root, 'failure.png') }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  release();
  await writeFile(resolve(root, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(resolve(root, 'run-'+report.capturedAt.replaceAll(/[:.]/g,'-')+'.json'), JSON.stringify(report, null, 2));
  await context?.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
console.log(JSON.stringify({ report: resolve(root, 'report.json'), result: report.result, checks: report.checks, requests: report.requests.length, errors: report.errors }, null, 2));
