import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Isolated extension CSP/WASM/container verification. NO model is downloaded.
// Fixture headers deliberately have no weight tensors and cannot translate.
import assert from 'node:assert/strict';
import { mkdir, cp, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve('.artifacts/local-runtime');
await mkdir(root, { recursive: true });
const extension = resolve(root, 'test-extension');
await cp(resolve('.output/chrome-mv3'), extension, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(extension,'manifest.json'),'utf8'));
// An isolated harness forwards controls; production controller/offscreen/inference
// and CSP/WASM resources remain byte-for-byte production build output.
manifest.background = { service_worker: 'test-background.js' };
manifest.content_scripts = []; manifest.host_permissions = []; manifest.optional_host_permissions = [];
await writeFile(resolve(extension,'manifest.json'),JSON.stringify(manifest));
await writeFile(resolve(extension,'test-background.js'), `chrome.runtime.onMessage.addListener((m,s,reply)=>{if(m.type!=='local-test')return; (async()=>{if(!await chrome.offscreen.hasDocument())await chrome.offscreen.createDocument({url:'offscreen.html',reasons:['WORKERS','BLOBS'],justification:'Isolated local-runtime acceptance'});return chrome.runtime.sendMessage({channel:'danlingo-local-offscreen-v1',...m.control});})().then(reply);return true;});`);
await writeFile(resolve(extension,'test-page.html'),'<!doctype html><title>Local runtime isolated verification</title>');

const { chromium } = await loadPlaywright();
const profile = await mkdtemp(resolve(root,'profile-'));
const context = await chromium.launchPersistentContext(profile,{headless:true,...browserLaunchOptions("chromium"),args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
const report = { capturedAt: new Date().toISOString(), evidence:'real-browser-packaged-WASM-and-fixture-lifecycle-NO-real-model', checks:{}, network:[], errors:[] };
context.on('request',request=>{if(/^https?:/.test(request.url()))report.network.push(new URL(request.url()).origin);});
try {
  const background = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const id = new URL(background.url()).host;
  const page = await context.newPage(); await page.goto(`chrome-extension://${id}/test-page.html`);
  page.on('pageerror',error=>report.errors.push(error.message));
  const control = action => page.evaluate(control=>chrome.runtime.sendMessage({type:'local-test',control}),action);
  const state = await control({action:'state'}); assert.equal(state.state.phase,'idle');
  report.checks.offscreenCreated = true;
  report.capabilities = await page.evaluate(()=>({userAgent:navigator.userAgent,jspi:!!WebAssembly.Suspending,memory64:(()=>{try{new WebAssembly.Memory({address:'i64',initial:1n});return true;}catch{return false;}})()}));
  const wasm = await page.evaluate(async()=>{
    const worker = new Worker(chrome.runtime.getURL('/local/wllama-worker.js'),{type:'module'});
    try {
      return await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('WASM init timeout')),20000);
        worker.onerror=event=>{clearTimeout(timer);reject(new Error(event.message));};
        worker.onmessage=event=>{
          const m=event.data;
          if(m.err || m.verb==='signal.abort'){clearTimeout(timer);reject(new Error(String(m.err || m.args)));}
          if(m.callbackId===1){clearTimeout(timer);resolve({initialized:true});}
        };
        worker.postMessage({verb:'module.init',args:[new Blob([''],{type:'text/javascript'}),true],callbackId:1});
      });
    } finally {worker.terminate();}
  });
  report.checks.packagedWasmInitializedUnderMv3Csp = wasm.initialized;
  // A parseable header with NO weights exercises IndexedDB -> inference worker ->
  // packaged nested wllama worker -> engine error, without masquerading as a model.
  await page.evaluate(async()=>{
    const u32=n=>{const a=new Uint8Array(4);new DataView(a.buffer).setUint32(0,n,true);return a;};
    const u64=n=>{const a=new Uint8Array(8);new DataView(a.buffer).setBigUint64(0,BigInt(n),true);return a;};
    const str=s=>{const a=new TextEncoder().encode(s);return [u64(a.length),a];};
    const metadata=[['general.architecture','llama'],['general.file_type',15],['tokenizer.ggml.model','llama'],['tokenizer.ggml.tokens',['hello']],['tokenizer.chat_template','{{ messages }}']];
    const chunks=[u32(0x46554747),u32(3),u64(1),u64(metadata.length)];
    for(const [key,value] of metadata){chunks.push(...str(key));if(typeof value==='number')chunks.push(u32(4),u32(value));else if(Array.isArray(value))chunks.push(u32(9),u32(8),u64(1),...str(value[0]));else chunks.push(u32(8),...str(value));}
    const file=new File(chunks,'no-weights-fixture.gguf');
    await new Promise((resolve,reject)=>{const request=indexedDB.open('danlingo-local-models-v1',1);request.onupgradeneeded=()=>request.result.createObjectStore('models',{keyPath:'info.id'});request.onsuccess=()=>{const db=request.result;const tx=db.transaction('models','readwrite');tx.objectStore('models').put({info:{id:'no-weights-fixture',name:file.name,files:[file.name],bytes:file.size,architecture:'llama',quantization:'Q4_K_M',tokenizer:'llama',template:true,importedAt:Date.now()},blobs:[file]});tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(new Error('fixture DB write failed'));};});
  });
  let loadTimer;
  const invalidWeights = await Promise.race([control({action:'load',modelId:'no-weights-fixture'}),new Promise((_,reject)=>{loadTimer=setTimeout(()=>reject(new Error('Invalid weights load did not settle')),20000);})]).finally(()=>clearTimeout(loadTimer));
  assert.equal(invalidWeights.ok,false); assert.equal(invalidWeights.error,'LOCAL_MODEL_LOAD_REJECTED');
  report.checks.actualEngineRejectsHeaderWithoutWeights = true;
  await control({action:'delete',modelId:'no-weights-fixture'});
  const missing = await control({action:'load',modelId:'nonexistent-model'});
  assert.equal(missing.ok,false); assert.equal(missing.error,'LOCAL_MODEL_NOT_IMPORTED');
  report.checks.missingModelFailsExplicitly = true;
  await control({action:'unload'});
  const cdp=await context.newCDPSession(page);
  const targets=(await cdp.send('Target.getTargets')).targetInfos;
  report.remainingModelWorkers=targets.filter(target=>target.type==='worker'&&target.url.startsWith(`chrome-extension://${id}/`)&&/inference\.worker|wllama-worker/.test(target.url)).map(target=>target.url);
  assert.deepEqual(report.remainingModelWorkers,[]);report.checks.failedLoadAndUnloadLeaveNoModelWorkers=true;
  await cdp.detach();
  const before = await background.evaluate(()=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}));
  await page.close();
  const reopened = await context.newPage(); await reopened.goto(`chrome-extension://${id}/test-page.html`);
  const reopenedState = await reopened.evaluate(()=>chrome.runtime.sendMessage({type:'local-test',control:{action:'state'}}));
  const after = await background.evaluate(()=>chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}));
  assert.equal(before[0].documentId,after[0].documentId); assert.equal(reopenedState.state.phase,'idle');
  report.checks.settingsCloseRetainsSameOffscreen = true;
  assert.equal(report.network.length,0); report.checks.noHttpInferenceOrCdnRequest = true;
  report.realModelTranslation = 'NOT_TESTED: no supported local GGUF provided; initialization is not translation/performance evidence.';
  console.log(JSON.stringify(report,null,2));
} catch(error) { report.errors.push(error.message); throw error; }
finally { await writeFile(resolve(root,'report.json'),JSON.stringify(report,null,2)); await context.close(); }
