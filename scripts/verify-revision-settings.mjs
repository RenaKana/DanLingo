import { browserExecutablePath, browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Isolated extension + loopback provider + simulated supported host. No user profile or credentials.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
const root=resolve('.artifacts/revision-settings');await mkdir(root,{recursive:true});const dir=await mkdtemp(resolve(root,'run-'));
const fixtureDirectoryName=`danlingo-directory-fixture-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const report={evidence:'ISOLATED_CHROMIUM_LOOPBACK_PROVIDER_AND_OPFS_DIRECTORY_FIXTURE',checks:{},errors:[],screenshots:[],limitations:[
  'The unauthorized-service check simulates a denied host-permission request; it does not exercise the native prompt.',
  'OPFS-backed File System handle fixture; no native external picker UI, external-folder grant, restart recovery, or real large-model/GPU evidence.',
  'Permission revocation after a persisted native grant is not simulated; offscreen-worker/native reauthorization remains unverified.',
]};
let requests=0,translations=0,fail=false,release,holdTranslation=false,pendingTranslations=[];const server=http.createServer((req,res)=>{
  if(req.url?.endsWith('/models')){requests++;const finish=()=>{res.writeHead(fail?500:200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{id:'alpha-model'},{id:'beta-model'}]}));};if(release===false)release=finish;else finish();}
  else if(req.url?.endsWith('/chat/completions')){
    translations++;let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{
      const body=JSON.parse(raw),content=body.messages.find(row=>row.role==='user').content;
      const output=content.trim().startsWith('[')?content.trim().split('\n').map(line=>JSON.stringify([JSON.parse(line)[0],'这是测试译文。'])).join('\n')
        :JSON.stringify({items:JSON.parse(content).items.map(row=>({id:row.id,text:'这是测试译文。'}))});
      const finish=()=>{if(res.destroyed)return;res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:output},finish_reason:'stop'}]}));};
      if(holdTranslation)pendingTranslations.push(finish);else finish();
    });
  }
  else{res.writeHead(404);res.end();}
});await new Promise(r=>server.listen(0,'127.0.0.1',r));const endpoint=`http://127.0.0.1:${server.address().port}/v1`;
const {chromium}=await loadPlaywright();
let context,page;const check=async(name,run)=>{await run();report.checks[name]='PASS';console.log('PASS',name);};
const until=async predicate=>{const deadline=Date.now()+15000;while(!predicate()){if(Date.now()>deadline)throw new Error('fixture condition timed out');await new Promise(r=>setTimeout(r,25));}};
const untilAsync=async predicate=>{const deadline=Date.now()+15000;while(!(await predicate())){if(Date.now()>deadline)throw new Error('fixture condition timed out');await new Promise(r=>setTimeout(r,50));}};
const fixture=(name,extra={})=>{
  const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;},u64=n=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;},str=s=>Buffer.concat([u64(Buffer.byteLength(s)),Buffer.from(s)]);
  const meta={'general.architecture':'llama','general.file_type':15,'tokenizer.ggml.model':'llama','tokenizer.ggml.tokens':['hello'],'tokenizer.chat_template':'{{ messages }}','llama.block_count':4,'llama.embedding_length':128,'llama.attention.head_count':4,'llama.attention.head_count_kv':2,...extra};
  const entries=Object.entries(meta).map(([key,value])=>Buffer.concat([str(key),typeof value==='number'?Buffer.concat([u32(4),u32(value)]):Array.isArray(value)?Buffer.concat([u32(9),u32(8),u64(value.length),...value.map(str)]):Buffer.concat([u32(8),str(value)])]));
  return{name,mimeType:'application/octet-stream',buffer:Buffer.concat([u32(0x46554747),u32(3),u64(1),u64(entries.length),...entries])};
};
try{
  const extension=resolve(dir,'extension');await cp(resolve(process.env.DANLINGO_TEST_EXTENSION || '.output/chrome-mv3'),extension,{recursive:true});
  const manifest=JSON.parse(await readFile(resolve(extension,'manifest.json'),'utf8'));manifest.host_permissions.push('http://127.0.0.1/*');await writeFile(resolve(extension,'manifest.json'),JSON.stringify(manifest));
  const brandedChrome=process.argv.includes('--chrome');
  const browserName=brandedChrome?'chrome':process.argv.includes('--edge')?'edge':'chromium';
  const browserOptions=browserLaunchOptions(browserName);
  report.browserExecutable=browserOptions.executablePath??browserExecutablePath(browserName,{playwrightBrowser:chromium});
  context=await chromium.launchPersistentContext(resolve(dir,'profile'),{headless:true,...browserOptions,locale:'zh-CN',viewport:{width:1180,height:880},...(brandedChrome?{ignoreDefaultArgs:['--disable-extensions']} : {}),args:[...(brandedChrome?[]:['--disable-extensions-except='+extension,'--load-extension='+extension]),'--lang=zh-CN','--disable-background-networking','--no-first-run']});
  await context.addInitScript(({directoryName})=>{
    if(location.protocol!=='chrome-extension:')return;
    globalThis.__danlingoFixturePickerCalls=[];
    globalThis.__danlingoFixturePickerResolved=false;
    globalThis.__danlingoFixtureFilePickerCalls=[];
    globalThis.__danlingoFixtureScanRequests=0;
    globalThis.__danlingoFixtureDeleteCalls=[];
    globalThis.__danlingoFixtureFailNextDelete=false;
    const originalSend=chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage=(message,...args)=>{
      if(message?.type==='local-control'&&message.control?.action==='directory-scan')globalThis.__danlingoFixtureScanRequests++;
      if(message?.type==='local-control'&&message.control?.action==='delete'){
        globalThis.__danlingoFixtureDeleteCalls.push(message.control.modelId);
        if(globalThis.__danlingoFixtureFailNextDelete){globalThis.__danlingoFixtureFailNextDelete=false;return Promise.resolve({ok:false,error:'ISOLATED_DELETE_FAILURE'});}
      }
      return originalSend(message,...args);
    };
    Object.defineProperty(globalThis,'showOpenFilePicker',{configurable:true,writable:true,value:async options=>{
      globalThis.__danlingoFixtureFilePickerCalls.push(options);
      const mode=localStorage.getItem('__danlingoFixtureFilePickerMode');
      if(mode==='cancel')throw new DOMException('Cancelled by isolated fixture','AbortError');
      if(mode==='deny')throw new DOMException('Denied by isolated fixture','NotAllowedError');
      const root=await (await navigator.storage.getDirectory()).getDirectoryHandle(directoryName,{create:false});
      const paths=JSON.parse(localStorage.getItem('__danlingoFixtureFilePaths')||'["root.gguf"]');
      return Promise.all(paths.map(async path=>{const parts=path.split('/');let directory=root;for(const name of parts.slice(0,-1))directory=await directory.getDirectoryHandle(name);return directory.getFileHandle(parts.at(-1));}));
    }});
    Object.defineProperty(globalThis,'showDirectoryPicker',{configurable:true,writable:true,value:async options=>{
      globalThis.__danlingoFixturePickerCalls.push({...options});
      if(localStorage.getItem('__danlingoFixturePickerMode')==='deny')throw new DOMException('Denied by isolated fixture','NotAllowedError');
      const root=await navigator.storage.getDirectory();
      const handle=await root.getDirectoryHandle(directoryName,{create:false});
      globalThis.__danlingoFixturePickerResolved=true;
      return handle;
    }});
    const proto=globalThis.FileSystemDirectoryHandle?.prototype;
    if(!proto||proto.__danlingoFixturePatched)return;
    Object.defineProperty(proto,'__danlingoFixturePatched',{value:true,configurable:false});
    const queryPermission=typeof proto.queryPermission==='function'?proto.queryPermission:null;
    const requestPermission=typeof proto.requestPermission==='function'?proto.requestPermission:null;
    Object.defineProperty(proto,'queryPermission',{configurable:true,value:async function(options){
      if(new URL(location.href).searchParams.get('danlingoFixturePermission')==='deny')return 'prompt';
      return queryPermission?queryPermission.call(this,options):'granted';
    }});
    Object.defineProperty(proto,'requestPermission',{configurable:true,value:async function(options){
      if(new URL(location.href).searchParams.get('danlingoFixturePermission')==='deny')return 'denied';
      return requestPermission?requestPermission.call(this,options):'granted';
    }});
  },{directoryName:fixtureDirectoryName});
  report.browserVersion=context.browser()?.version();
  if(brandedChrome){const cdp=await context.browser().newBrowserCDPSession();await cdp.send('Extensions.loadUnpacked',{path:extension});await cdp.detach();}
  await context.route('https://www.youtube.com/**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><title>Supported host fixture</title><button id="focus">Watching page</button>'}));
  const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker'),origin='chrome-extension://'+new URL(worker.url()).host;
  page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));page.on('dialog',d=>d.accept());await page.goto(origin+'/options.html');await page.evaluate(()=>chrome.storage.local.set({'ui.locale.v1':'zh-CN'}));await page.reload();await page.waitForFunction(()=>document.querySelector('#result')?.textContent==='已保存');
  const rpc=m=>page.evaluate(m=>chrome.runtime.sendMessage(m),m),goto=async id=>{await page.locator('#category').evaluate((el,id)=>{el.value=id;el.dispatchEvent(new Event('change',{bubbles:true}));},id);};
  const directoryBytes=[
    {path:'one/model.gguf',bytes:Array.from(fixture('model.gguf').buffer)},
    {path:'two/model.gguf',bytes:Array.from(fixture('model.gguf').buffer)},
    {path:'root.gguf',bytes:Array.from(fixture('root.gguf').buffer)},
    {path:'bad.gguf',bytes:Array.from(Buffer.from('not a GGUF fixture'))},
  ];
  const seedDirectoryFixture=async()=>page.evaluate(async({directoryName,files})=>{
    const opfs=await navigator.storage.getDirectory(),root=await opfs.getDirectoryHandle(directoryName,{create:true});
    for(const file of files){let directory=root;const parts=file.path.split('/');for(const part of parts.slice(0,-1))directory=await directory.getDirectoryHandle(part,{create:true});const handle=await directory.getFileHandle(parts.at(-1),{create:true});const writable=await handle.createWritable();await writable.write(new Uint8Array(file.bytes));await writable.close();}
    return root.name;
  },{directoryName:fixtureDirectoryName,files:directoryBytes});
  const seedLegacyModel=async(id='legacy-fixture-model',name='legacy-fixture.gguf')=>page.evaluate(async({id,name,bytes})=>{
    const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('danlingo-local-models-v1',2);request.onupgradeneeded=()=>{const database=request.result;if(!database.objectStoreNames.contains('models'))database.createObjectStore('models',{keyPath:'info.id'});if(!database.objectStoreNames.contains('directories'))database.createObjectStore('directories',{keyPath:'id'});};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    const info={id,name,files:[name],bytes:bytes.length,architecture:'llama',quantization:'Q4_K_M',tokenizer:'llama',template:true,importedAt:Date.now(),metadataVersion:1};
    await new Promise((resolve,reject)=>{const tx=db.transaction('models','readwrite');tx.objectStore('models').put({info,blobs:[new File([new Uint8Array(bytes)],name,{type:'application/octet-stream'})]});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();return id;
  },{id,name,bytes:Array.from(fixture(name).buffer)});
  await check('settings-open-outside-supported-sites-and-reuse-unsaved-tab',async()=>{
    await context.route('https://unsupported.invalid/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Unrelated page fixture</title><p>This page has no extension integration.</p>'}));
    await page.close();const launcher=await context.newPage();await launcher.goto(origin+'/popup.html');const site=await context.newPage();await site.goto('https://unsupported.invalid/page');await site.bringToFront();
    const opened=context.waitForEvent('page');const result=await launcher.evaluate(()=>chrome.runtime.sendMessage({type:'open-settings'}));assert.equal(result.ok,true,result.error);assert.equal(result.mode,'standalone');page=await opened;page.on('pageerror',error=>report.errors.push(error.message));page.on('dialog',dialog=>dialog.accept());await page.waitForURL(origin+'/options.html');await page.waitForFunction(()=>document.querySelector('#result')?.textContent==='已保存');
    assert.equal((await rpc({type:'settings'})).ok,true);assert.equal(site.url(),'https://unsupported.invalid/page');assert.equal(await site.locator('[data-danlingo-settings]').count(),0);
    await page.locator('#model').fill('UNSAVED-STANDALONE-DRAFT');await site.bringToFront();assert.equal((await launcher.evaluate(()=>chrome.runtime.sendMessage({type:'open-settings'}))).ok,true);
    assert.equal(context.pages().filter(candidate=>candidate.url()===origin+'/options.html').length,1);assert.equal(await page.locator('#model').inputValue(),'UNSAVED-STANDALONE-DRAFT');await site.close();await launcher.close();await page.reload();await page.waitForFunction(()=>document.querySelector('#result')?.textContent==='已保存');
  });
  await check('editable-model-cache-reopen-failure-and-stale-refresh',async()=>{
    await page.locator('#local-http').evaluate(el=>{el.checked=true;el.dispatchEvent(new Event('change',{bubbles:true}));});
    await page.locator('#endpoint').fill(endpoint);await page.locator('#api-key').fill('isolated-fixture-key');await page.locator('#model').fill('custom-unlisted');await page.locator('#get-models').click();
    await page.waitForFunction(()=>document.querySelector('#models-result').textContent.includes('已获取'));assert.equal(await page.locator('#model').inputValue(),'custom-unlisted');
    await page.locator('.model-control .combobox-toggle').click();assert.equal(await page.locator('#model-choices [role=option]').count(),2);
    await page.locator('#model-choices [role=option]').first().click();assert.equal(await page.locator('#model').inputValue(),'alpha-model');
    await page.locator('#model').fill('custom-again');await page.keyboard.press('Escape');await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#result').textContent==='已保存');
    const count=requests;await page.reload();await page.waitForFunction(()=>document.querySelector('#models-cache')?.textContent.includes('缓存于'));assert.equal(requests,count);
    fail=true;await page.locator('#get-models').click();await page.waitForFunction(()=>document.querySelector('#models-result').classList.contains('error'));assert.equal(await page.locator('#model').inputValue(),'custom-again');
    await page.locator('.model-control .combobox-toggle').click();assert.equal(await page.locator('#model-choices [role=option]').count(),2);await page.keyboard.press('Escape');
    fail=false;release=false;await page.locator('#get-models').click();await page.waitForFunction(()=>document.querySelector('#get-models').disabled);await page.locator('#endpoint').fill(endpoint+'/other');
    while(release===false)await new Promise(r=>setTimeout(r,20));release();release=undefined;await page.waitForFunction(()=>!document.querySelector('#get-models').disabled);
    assert.equal(await page.locator('#endpoint').inputValue(),endpoint+'/other');assert.equal(await page.locator('#model').inputValue(),'custom-again');
    await page.locator('#endpoint').fill(endpoint);await page.waitForFunction(()=>document.querySelector('#models-cache').textContent.includes('缓存于'));
  });
  await check('native-language-dropdown-presets-and-save',async()=>{
    await goto('watching');assert.equal(await page.locator('#target-language').evaluate(el=>el.tagName),'SELECT');
    assert.equal(await page.locator('#target-language option:not(:disabled)').count(),20);
    await page.locator('#target-language').selectOption('ja');assert.equal(await page.locator('#target-language option:checked').textContent(),'日本語');
    await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#result').textContent==='已保存');assert.equal((await rpc({type:'settings'})).settings.targetLanguage,'ja');
    await page.locator('#target-language').selectOption('pt-BR');await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#result').textContent==='已保存');assert.equal((await rpc({type:'settings'})).settings.targetLanguage,'pt-BR');
  });
  await check('directory-authorize-opfs-scan-reuse-no-autoselect-and-draft-isolation',async()=>{
    await seedDirectoryFixture();const legacyId=await seedLegacyModel();await goto('service');
    assert.equal(await page.locator('#local-file').count(),0);assert.equal(await page.locator('#local-import').count(),0);assert.equal(await page.locator('#local-import-cancel').count(),0);
    const dbShape=await page.evaluate(async()=>{const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('danlingo-local-models-v1',2);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});const result={version:db.version,stores:[...db.objectStoreNames]};db.close();return result;});
    assert.equal(dbShape.version,2);assert.deepEqual(dbShape.stores.sort(),['directories','models']);
    await page.locator('#model').fill('UNSAVED-ONLINE-DRAFT');await goto('watching');await page.locator('#target-language').selectOption('uk');await goto('service');await page.locator('#backend').selectOption('local');await page.waitForFunction(()=>document.querySelector('#local-settings')?.hidden===false);assert.equal(await page.locator('#local-model-manager').evaluate(el=>el.open),true);
    const earlyPath=resolve(dir,'directory-controls-early.png');await page.screenshot({path:earlyPath,fullPage:true});report.screenshots.push(earlyPath);
    await page.locator('#local-folder-add').click();await page.waitForFunction(()=>globalThis.__danlingoFixturePickerResolved===true);assert.deepEqual(await page.evaluate(()=>globalThis.__danlingoFixturePickerCalls[0]),{mode:'read',id:'danlingo-models'});
    await page.waitForFunction(()=>document.querySelectorAll('.local-directory').length===1);await page.waitForFunction(()=>/已登记 3 个模型/.test(document.querySelector('#local-result')?.textContent??''));
    let listing=await rpc({type:'local-control',control:{action:'list'}});assert.equal(listing.directories.length,1);assert.equal('handle' in listing.directories[0],false);assert.ok(listing.models.every(model=>!('handle' in model)&&!('blobs' in model)));
    let directory=listing.directories[0];let directoryModels=listing.models.filter(model=>model.source?.kind==='directory');assert.equal(directoryModels.length,3);assert.equal(listing.models.filter(model=>model.id===legacyId).length,1);assert.deepEqual(directoryModels.flatMap(model=>model.source.files.map(file=>file.path)).filter(path=>path.endsWith('/model.gguf')).sort(),['one/model.gguf','two/model.gguf']);assert.ok(directory.issues?.some(issue=>issue.path==='bad.gguf'));
    assert.equal((await rpc({type:'settings'})).settings.localModelId??'','');assert.equal(await page.locator('#model').inputValue(),'UNSAVED-ONLINE-DRAFT');assert.equal(await page.locator('#target-language').inputValue(),'uk');const scanRequestsAfterRegistration=await page.evaluate(()=>globalThis.__danlingoFixtureScanRequests);assert.equal(scanRequestsAfterRegistration,1,'adding the authorized directory scans it once');
    await goto('watching');await goto('service');await page.locator('#backend').selectOption('online');await page.locator('#backend').selectOption('local');await rpc({type:'settings'});
    assert.equal(await page.evaluate(()=>globalThis.__danlingoFixtureScanRequests),scanRequestsAfterRegistration,'opening/reentering settings does not rescan');
    const initialIds=new Map(directoryModels.map(model=>[model.source.files[0].path,model.id]));const initialRevision=directory.revision;
    const row=page.locator('.local-directory').first();await row.getByRole('button',{name:'刷新'}).click();await untilAsync(async()=>{const value=await rpc({type:'local-control',control:{action:'list'}});return value.directories?.[0]?.revision>initialRevision;});listing=await rpc({type:'local-control',control:{action:'list'}});directory=listing.directories[0];directoryModels=listing.models.filter(model=>model.source?.kind==='directory');assert.equal(directory.revision,initialRevision+1);for(const model of directoryModels)assert.equal(model.id,initialIds.get(model.source.files[0].path));
    const repeatBeforeRevision=directory.revision,directoryId=directory.id,pickerCalls=await page.evaluate(()=>globalThis.__danlingoFixturePickerCalls.length);await page.locator('#local-folder-add').click();await page.waitForFunction(calls=>globalThis.__danlingoFixturePickerCalls.length===calls+1,pickerCalls);await untilAsync(async()=>{const value=await rpc({type:'local-control',control:{action:'list'}});return value.directories?.[0]?.revision>repeatBeforeRevision;});listing=await rpc({type:'local-control',control:{action:'list'}});directory=listing.directories[0];assert.equal(directory.id,directoryId);
    const changedBytes=[...fixture('model.gguf',{'llama.block_count':5}).buffer,1,2,3];await page.evaluate(async({directoryName,bytes})=>{const root=await (await navigator.storage.getDirectory()).getDirectoryHandle(directoryName,{create:false}),directory=await root.getDirectoryHandle('one',{create:false}),handle=await directory.getFileHandle('model.gguf',{create:false}),writable=await handle.createWritable();await writable.write(new Uint8Array(bytes));await writable.close();return (await handle.getFile()).size;},{directoryName:fixtureDirectoryName,bytes:changedBytes});const beforeChangedListing=await rpc({type:'local-control',control:{action:'list'}});const beforeChangedRevision=beforeChangedListing.directories[0].revision;await row.getByRole('button',{name:'刷新'}).click();await untilAsync(async()=>{const value=await rpc({type:'local-control',control:{action:'list'}});return value.directories?.[0]?.revision>beforeChangedRevision&&value.models?.some(model=>model.source?.files?.some(file=>file.path==='one/model.gguf'&&model.id!==initialIds.get('one/model.gguf')));});listing=await rpc({type:'local-control',control:{action:'list'}});directoryModels=listing.models.filter(model=>model.source?.kind==='directory');const changed=directoryModels.find(model=>model.source.files[0].path==='one/model.gguf');assert.ok(changed);assert.notEqual(changed.id,initialIds.get('one/model.gguf'));assert.equal((await rpc({type:'settings'})).settings.localModelId??'','');
    const changedRow=page.locator(`#local-model-entries [data-model-id="${changed.id}"]`);assert.match(await changedRow.locator('.local-source-kind').textContent(),/文件夹|目录/);assert.match(await changedRow.locator('.subtle').textContent(),/one\/model\.gguf/);const settingsBeforeLoad=(await rpc({type:'settings'})).settings;await changedRow.locator('[data-model-action="load"]').click();await untilAsync(async()=>((await rpc({type:'settings'})).settings.localModelId??'')===changed.id);await untilAsync(async()=>(await rpc({type:'local-control',control:{action:'state'}})).state.phase==='error');assert.equal((await rpc({type:'settings'})).settings.backend,settingsBeforeLoad.backend);assert.equal((await rpc({type:'settings'})).settings.model,settingsBeforeLoad.model);assert.equal(await page.locator('#model').inputValue(),'UNSAVED-ONLINE-DRAFT');assert.equal(await page.locator('#target-language').inputValue(),'uk');
    const excluded=directoryModels.find(model=>model.name==='root.gguf'),excludedRow=page.locator(`#local-model-entries [data-model-id="${excluded.id}"]`);
    await excludedRow.locator('[data-model-action="remove"]').click();await untilAsync(async()=>!(await rpc({type:'local-control',control:{action:'list'}})).models.some(model=>model.id===excluded.id));assert.equal(await page.locator('#local-delete-confirm').count(),0);
    assert.equal((await rpc({type:'settings'})).settings.localModelId,changed.id,'removing another model keeps selection');
    await row.getByRole('button',{name:'刷新'}).click();await page.waitForFunction(()=>!document.querySelector('#local-folder-refresh').disabled);
    assert.ok(!(await rpc({type:'local-control',control:{action:'list'}})).models.some(model=>model.name==='root.gguf'),'manual refresh does not restore excluded model');
    for(const [width,height,label] of [[1180,880,'directory-desktop'],[390,800,'directory-390']]){await page.setViewportSize({width,height});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,label+' overflow');const path=resolve(dir,label+'.png');await page.screenshot({path,fullPage:true});report.screenshots.push(path);if(width===390){await changedRow.scrollIntoViewIfNeeded();const selectionPath=resolve(dir,'directory-390-selection.png');await page.screenshot({path:selectionPath,fullPage:true});report.screenshots.push(selectionPath);}}await page.setViewportSize({width:1180,height:880});
    await row.getByRole('button',{name:'移除'}).click();await row.getByRole('button',{name:'确认移除'}).click();await untilAsync(async()=>{const value=await rpc({type:'settings'});return (value.settings.localModelId??'')==='';});listing=await rpc({type:'local-control',control:{action:'list'}});assert.equal(listing.directories.length,0);assert.deepEqual(listing.models.map(model=>model.id),[legacyId]);assert.equal(await page.locator('#model').inputValue(),'UNSAVED-ONLINE-DRAFT');assert.equal(await page.locator('#target-language').inputValue(),'uk');
    await page.evaluate(()=>localStorage.setItem('__danlingoFixturePickerMode','deny'));await page.locator('#local-folder-add').click();await page.waitForFunction(()=>/需要|操作未完成/.test(document.querySelector('#local-result').textContent));assert.equal((await rpc({type:'local-control',control:{action:'list'}})).directories.length,0);await page.evaluate(()=>localStorage.removeItem('__danlingoFixturePickerMode'));
  });
  await check('direct-file-picker-read-only-registration-reselection-removal-and-preload-setting',async()=>{
    await goto('service');await page.locator('#backend').selectOption('online');await page.locator('#model').fill('FILE-UNSAVED-DRAFT');await page.locator('#backend').selectOption('local');
    assert.equal(await page.locator('#local-preload-entry').isChecked(),true);
    await page.evaluate(()=>localStorage.setItem('__danlingoFixtureFilePaths','["root.gguf","bad.gguf"]'));
    await page.locator('#local-file-add').click();await page.waitForFunction(()=>globalThis.__danlingoFixtureFilePickerCalls.length===1);
    const pickerOptions=await page.evaluate(()=>globalThis.__danlingoFixtureFilePickerCalls[0]);assert.equal(pickerOptions.multiple,true);assert.equal(pickerOptions.excludeAcceptAllOption,true);assert.deepEqual(pickerOptions.types[0].accept,{'application/octet-stream':['.gguf']});
    await page.waitForFunction(()=>/bad\.gguf/.test(document.querySelector('#local-result')?.textContent??''));
    let listing=await rpc({type:'local-control',control:{action:'list'}});const fileModels=listing.models.filter(model=>model.source?.kind==='files');assert.equal(fileModels.length,1);const model=fileModels[0];assert.equal(listing.directories.length,0);assert.equal((await rpc({type:'settings'})).settings.localModelId??'','');assert.equal(await page.locator('#model').inputValue(),'FILE-UNSAVED-DRAFT');
    const raw=await page.evaluate(async id=>{const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('danlingo-local-models-v1',2);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});const result=await new Promise(resolve=>{const request=db.transaction('models').objectStore('models').get(id);request.onsuccess=()=>resolve({hasBlobs:'blobs' in request.result,handleKinds:request.result.fileHandles.map(handle=>handle.kind)});});db.close();return result;},model.id);assert.equal(raw.hasBlobs,false);assert.deepEqual(raw.handleKinds,['file']);
    await page.evaluate(()=>localStorage.setItem('__danlingoFixtureFilePaths','["root.gguf"]'));await page.locator('#local-file-add').click();await page.waitForFunction(()=>globalThis.__danlingoFixtureFilePickerCalls.length===2);
    listing=await rpc({type:'local-control',control:{action:'list'}});assert.deepEqual(listing.models.filter(model=>model.source?.kind==='files').map(model=>model.id),[model.id]);
    for(const [index,mode] of ['cancel','deny'].entries()){await page.evaluate(mode=>localStorage.setItem('__danlingoFixtureFilePickerMode',mode),mode);await page.locator('#local-file-add').click();await page.waitForFunction(count=>globalThis.__danlingoFixtureFilePickerCalls.length===count+1,index+2);await page.waitForFunction(mode=>mode==='cancel'?/已取消选择|已取消/.test(document.querySelector('#local-result').textContent):/需要重新授权|操作未完成/.test(document.querySelector('#local-result').textContent),mode);assert.deepEqual((await rpc({type:'local-control',control:{action:'list'}})).models.map(model=>model.id),listing.models.map(model=>model.id));}
    await page.evaluate(()=>localStorage.removeItem('__danlingoFixtureFilePickerMode'));
    const modelRow=page.locator(`#local-model-entries [data-model-id="${model.id}"]`),settingsBeforeLoad=(await rpc({type:'settings'})).settings;assert.equal(await page.locator('#local-model-manager').evaluate(el=>el.open),true);await page.locator('#local-preload-entry').uncheck();await modelRow.locator('[data-model-action="load"]').click();await untilAsync(async()=>((await rpc({type:'settings'})).settings.localModelId??'')===model.id);await untilAsync(async()=>(await rpc({type:'local-control',control:{action:'state'}})).state.phase==='error','weightless header fixture rejected');await untilAsync(async()=>page.locator('#local-result').evaluate(el=>el.classList.contains('error')&&!!el.textContent?.trim()),'visible native load rejection');
    const afterLoad=(await rpc({type:'settings'})).settings;assert.equal(afterLoad.backend,settingsBeforeLoad.backend);assert.equal(afterLoad.model,settingsBeforeLoad.model);assert.equal(afterLoad.localPreloadOnEntry,true);assert.equal(await page.locator('#model').inputValue(),'FILE-UNSAVED-DRAFT');
    assert.equal(await page.locator('#local-stop').isVisible(),false,'failed load has no loaded model to unload');
    await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#result').textContent==='已保存');assert.equal((await rpc({type:'settings'})).settings.localPreloadOnEntry,false);
    await page.reload();await page.waitForFunction(()=>document.querySelector('#result').textContent==='已保存');assert.equal(await page.locator('#local-preload-entry').isChecked(),false);assert.equal(await page.evaluate(()=>globalThis.__danlingoFixtureScanRequests),0);assert.equal((await rpc({type:'settings'})).settings.localModelId,model.id);
    await page.locator('#local-preload-entry').check();await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#result').textContent==='已保存');assert.equal((await rpc({type:'settings'})).settings.localPreloadOnEntry,true);
    for(const [width,height,label] of [[1180,880,'local-manager-desktop'],[390,800,'local-manager-390']]){await page.setViewportSize({width,height});await modelRow.scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);const path=resolve(dir,label+'.png');await page.screenshot({path,fullPage:true});report.screenshots.push(path);}await page.setViewportSize({width:1180,height:880});
    await page.locator('#backend').selectOption('local');await modelRow.locator('[data-model-action="remove"]').click();await untilAsync(async()=>!(await rpc({type:'local-control',control:{action:'list'}})).models.some(item=>item.id===model.id));assert.equal((await rpc({type:'settings'})).settings.localModelId??'','');
    assert.equal((await rpc({type:'local-control',control:{action:'list'}})).models.filter(model=>model.source).length,0);
    assert.equal(await page.evaluate(async directoryName=>(await (await (await navigator.storage.getDirectory()).getDirectoryHandle(directoryName)).getFileHandle('root.gguf')).getFile().then(file=>file.size),fixtureDirectoryName),fixture('root.gguf').buffer.length);
    await page.locator('#backend').selectOption('online');
  });
  await check('legacy-blob-row-single-click-removal-and-draft-isolation',async()=>{
    await goto('service');await page.locator('#model').fill('DELETE-UNSAVED-DRAFT');await page.locator('#backend').selectOption('local');
    const before=(await rpc({type:'settings'})).settings,models=(await rpc({type:'local-control',control:{action:'list'}})).models;assert.equal(models.length,1);const selected=models[0].id,row=page.locator(`#local-model-entries [data-model-id="${selected}"]`);await page.waitForFunction(()=>document.querySelector('#local-model-manager')?.open===true);
    await row.locator('[data-model-action="load"]').click();await untilAsync(async()=>((await rpc({type:'settings'})).settings.localModelId??'')===selected);await untilAsync(async()=>(await rpc({type:'local-control',control:{action:'state'}})).state.phase==='error','weightless legacy fixture rejected');
    const afterLoad=(await rpc({type:'settings'})).settings;assert.equal(afterLoad.backend,before.backend);assert.equal(afterLoad.model,before.model);assert.equal(await page.locator('#model').inputValue(),'DELETE-UNSAVED-DRAFT');
    assert.equal(await page.locator('#local-stop').isVisible(),false,'failed load has no loaded model to unload');
    await row.locator('[data-model-action="remove"]').click();await untilAsync(async()=>!(await rpc({type:'local-control',control:{action:'list'}})).models.some(model=>model.id===selected));assert.equal(await page.locator('#local-delete-confirm').count(),0);
    const removedPath=resolve(dir,'legacy-model-removed.png');await page.screenshot({path:removedPath,fullPage:true});report.screenshots.push(removedPath);assert.equal((await rpc({type:'settings'})).settings.localModelId??'','');assert.equal(await page.locator('#model').inputValue(),'DELETE-UNSAVED-DRAFT');assert.equal((await rpc({type:'settings'})).settings.backend,before.backend);assert.equal((await rpc({type:'local-control',control:{action:'list'}})).models.length,0);
  });
  await check('online-switch-uses-network-and-refreshes-key-and-thinking-state',async()=>{
    const saved=(await rpc({type:'settings'})).settings;
    assert.equal((await rpc({type:'save',settings:{...saved,backend:'local',enabled:false,model:'custom-again',thinkingEffort:'off',targetLanguage:'zh-Hans'},remember:false})).ok,true);
    await page.reload();await page.waitForFunction(()=>document.querySelector('#result').textContent==='已保存');
    await page.locator('#backend').selectOption('online');assert.doesNotMatch(await page.locator('#key-state').textContent(),/本地推理/);
    assert.equal(await page.locator('#thinking-effort').inputValue(),'default');
    const before=translations;await page.locator('#test-model').click();await page.waitForFunction(()=>document.querySelector('#test-result-output').textContent.includes('这是测试译文'));
    assert.equal(translations,before+1);assert.equal((await rpc({type:'local-control',control:{action:'state'}})).state.inferenceCalls,0);
    await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#result').textContent==='已保存');
    const actual=await rpc({type:'settings'});assert.equal(actual.settings.backend,'online');assert.equal(actual.settings.thinkingEffort,'default');assert.equal(actual.hasOnlineKey,true);
  });
  await check('service-history-presets-failed-refresh-and-cross-origin-key-clearing',async()=>{
    let rows=(await rpc({type:'service-history'})).addresses;assert.ok(rows.some(row=>row.endpoint===endpoint));
    assert.doesNotMatch(JSON.stringify(rows),/isolated-fixture-key/);
    await page.locator('#api-key').fill('typed-only-fixture-key');
    const expand=page.locator('#endpoint').locator('..').locator('.combobox-toggle');await expand.click();
    await page.locator('#endpoint-choices [role=option]').filter({hasText:/^OpenAI ·/}).click();assert.equal(await page.locator('#endpoint').inputValue(),'https://api.openai.com/v1');assert.equal(await page.locator('#api-key').inputValue(),'');
    await expand.click();await page.locator('#endpoint-choices [role=option]').filter({hasText:endpoint}).click();assert.equal(await page.locator('#local-http').isChecked(),true);
    fail=true;await page.locator('#endpoint').fill(endpoint+'/invalid');await page.locator('#get-models').click();await page.waitForFunction(()=>document.querySelector('#models-result').classList.contains('error'));fail=false;
    rows=(await rpc({type:'service-history'})).addresses;assert.ok(!rows.some(row=>row.endpoint.endsWith('/invalid')));
    await page.reload();await page.waitForFunction(()=>document.querySelector('#result').textContent==='已保存');
    await expand.click();assert.ok(await page.locator('#endpoint-choices [role=option]').filter({hasText:'DeepSeek'}).count());await page.keyboard.press('Escape');
    const path=resolve(dir,'service-history.png');await page.screenshot({path,fullPage:true});report.screenshots.push(path);
  });
  await check('shortcut-shows-actual-binding-and-opens-native-customization',async()=>{
    await goto('watching');const actual=await page.evaluate(async()=>{const rows=await chrome.commands.getAll();return rows.find(row=>row.name==='toggle-translation')?.shortcut||'未设置';});
    assert.equal(await page.locator('#translation-shortcut').textContent(),actual);
    const opened=context.waitForEvent('page');await page.locator('#customize-shortcut').click();const shortcut=await opened;await shortcut.waitForURL(/(?:chrome|edge):\/\/extensions\/shortcuts/);await shortcut.close();
    await goto('service');
  });
  await check('performance-priority-pauses-and-resumes-on-completion-and-stop',async()=>{
    const saved=(await rpc({type:'settings'})).settings;
    holdTranslation=true;const before=translations;
    const start=await rpc({type:'performance-start',settings:saved,config:{count:1,mode:'latency',concurrency:1,batchSize:1,arrivalIntervalMs:0,strategy:'normal'}});
    assert.equal(start.ok,true,start.error);assert.equal((await rpc({type:'settings'})).performancePaused,true);
    await until(()=>translations>before&&pendingTranslations.length>0);
    holdTranslation=false;pendingTranslations.splice(0).forEach(f=>f());await page.waitForFunction(async()=>!(await chrome.runtime.sendMessage({type:'settings'})).performancePaused);
    assert.equal((await rpc({type:'settings'})).settings.enabled,saved.enabled);
    holdTranslation=true;assert.equal((await rpc({type:'performance-start',settings:saved,config:{count:2,mode:'latency',concurrency:1,batchSize:1,arrivalIntervalMs:0,strategy:'normal'}})).ok,true);
    await rpc({type:'performance-stop'});await page.waitForFunction(async()=>!(await chrome.runtime.sendMessage({type:'settings'})).performancePaused);holdTranslation=false;pendingTranslations.splice(0).forEach(f=>f());
  });
  await check('settings-open-always-standalone-and-rejects-non-popup-openers',async()=>{
    assert.equal((await rpc({type:'open-settings'})).ok,false,'only the extension popup can request the settings page');
    const folders=await context.newPage();await folders.goto(origin+'/model-folders.html');assert.equal((await folders.evaluate(()=>chrome.runtime.sendMessage({type:'open-settings'}))).ok,false,'model management cannot open settings on behalf of another surface');await folders.close();
    const launcher=await context.newPage();await launcher.goto(origin+'/popup.html');const site=await context.newPage();await site.goto('https://www.youtube.com/watch?v=fixture0001');await site.locator('#focus').focus();await site.bringToFront();
    const opened=await launcher.evaluate(()=>chrome.runtime.sendMessage({type:'open-settings'}));assert.equal(opened.ok,true);assert.equal(opened.mode,'standalone');assert.equal(page.url().split('#')[0],origin+'/options.html');assert.equal(context.pages().filter(candidate=>candidate.url().split('#')[0]===origin+'/options.html').length,1);assert.equal(await site.locator('[data-danlingo-settings]').count(),0);assert.equal(site.frames().some(frame=>frame.url().includes('/options.html')),false);assert.equal(site.url(),'https://www.youtube.com/watch?v=fixture0001');
    await page.locator('#model').fill('UNSAVED-STANDALONE-DRAFT');await site.bringToFront();assert.equal((await launcher.evaluate(()=>chrome.runtime.sendMessage({type:'open-settings'}))).ok,true);assert.equal(await page.locator('#model').inputValue(),'UNSAVED-STANDALONE-DRAFT');await site.close();await launcher.close();await page.reload();await page.waitForFunction(()=>document.querySelector('#result')?.textContent==='已保存');
  });
  await check('standalone-settings-explicit-save-and-invalid-draft-preservation',async()=>{
    const launcher=await context.newPage();await launcher.goto(origin+'/popup.html');const site=await context.newPage();await site.goto('https://www.youtube.com/watch?v=fixture0002');await site.bringToFront();
    const before=(await rpc({type:'settings'})).settings;await page.locator('#model').fill('outside-saved');await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#result').textContent==='已保存');assert.equal((await rpc({type:'settings'})).settings.model,'outside-saved');
    await page.locator('#endpoint').fill('not-a-service-url');await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#result').classList.contains('error'));assert.equal((await rpc({type:'settings'})).settings.endpoint,before.endpoint);assert.equal(await page.locator('#endpoint').inputValue(),'not-a-service-url');
    // Headless Chromium cannot answer a native optional-host permission prompt.
    await page.evaluate(()=>{globalThis.__permissionRequest=chrome.permissions.request;chrome.permissions.request=async options=>options.origins?.includes('https://not-authorized.invalid/*')?false:__permissionRequest.call(chrome.permissions,options);});
    await page.locator('#endpoint').fill('https://not-authorized.invalid/v1');await page.locator('#api-key').fill('fixture-unsaved-key');await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#result').textContent.includes('未授权服务地址，配置未保存'),null,{timeout:5000}).catch(async()=>{const state=await page.locator('#result').evaluate(el=>({text:el.textContent,className:el.className}));throw new Error('unauthorized address result: '+JSON.stringify(state));});assert.equal((await rpc({type:'settings'})).settings.endpoint,before.endpoint);
    await page.evaluate(()=>{chrome.permissions.request=__permissionRequest;delete globalThis.__permissionRequest;});
    assert.equal((await launcher.evaluate(()=>chrome.runtime.sendMessage({type:'open-settings'}))).ok,true);assert.equal(await page.locator('#endpoint').inputValue(),'https://not-authorized.invalid/v1');assert.equal(await site.locator('[data-danlingo-settings]').count(),0);await site.close();await launcher.close();await page.reload();await page.waitForFunction(()=>document.querySelector('#result')?.textContent==='已保存');
  });
  await check('delete-selected-model-row-without-fallback-and-empty-reopen',async()=>{
    await seedLegacyModel('legacy-delete-first','legacy-first.gguf');await seedLegacyModel('legacy-delete-second','legacy-second.gguf');
    await page.reload();await page.waitForFunction(()=>document.querySelector('#result').textContent==='已保存');
    await goto('service');await page.locator('#model').fill('DELETE-UNSAVED-DRAFT');await page.locator('#backend').selectOption('local');
    const before=(await rpc({type:'settings'})).settings;let models=(await rpc({type:'local-control',control:{action:'list'}})).models;assert.equal(models.length,2);assert.equal(await page.locator('#local-model-manager').evaluate(el=>el.open),true);
    const selected='legacy-delete-first',row=page.locator(`#local-model-entries [data-model-id="${selected}"]`);assert.deepEqual(await row.locator('[data-model-action]').evaluateAll(buttons=>buttons.map(button=>button.dataset.modelAction)),['load','remove']);
    await row.locator('[data-model-action="load"]').click();await untilAsync(async()=>((await rpc({type:'settings'})).settings.localModelId??'')===selected);await untilAsync(async()=>(await rpc({type:'local-control',control:{action:'state'}})).state.phase==='error','weightless legacy fixture rejected');
    const afterLoad=(await rpc({type:'settings'})).settings;assert.equal(afterLoad.backend,before.backend);assert.equal(afterLoad.model,before.model);assert.equal(await page.locator('#model').inputValue(),'DELETE-UNSAVED-DRAFT');
    assert.equal(await page.locator('#local-stop').isVisible(),false,'failed load has no loaded model to unload');
    await page.evaluate(()=>{globalThis.__danlingoFixtureFailNextDelete=true;});
    const callsBefore=await page.evaluate(()=>globalThis.__danlingoFixtureDeleteCalls.length);
    await row.locator('[data-model-action="remove"]').click();await untilAsync(async()=>page.locator('#local-result').evaluate(el=>el.classList.contains('error')&&!!el.textContent?.trim()),'visible delete failure');
    assert.equal(await page.evaluate(()=>globalThis.__danlingoFixtureDeleteCalls.length),callsBefore+1,'one delete RPC for one click');assert.equal((await rpc({type:'local-control',control:{action:'list'}})).models.length,models.length);assert.equal((await rpc({type:'settings'})).settings.localModelId,selected);
    await untilAsync(async()=>page.evaluate(id=>document.activeElement?.closest('[data-model-id]')?.dataset.modelId===id&&document.activeElement?.dataset.modelAction==='remove',selected),'failed removal returns focus to same row');
    await row.locator('[data-model-action="remove"]').click();await untilAsync(async()=>!(await rpc({type:'local-control',control:{action:'list'}})).models.some(model=>model.id===selected),'single click removes selected model');
    await untilAsync(async()=>page.evaluate(()=>document.activeElement?.closest('[data-model-id]')?.dataset.modelId==='legacy-delete-second'&&document.activeElement?.dataset.modelAction==='remove'),'successful removal focuses adjacent row');
    assert.equal(await page.evaluate(id=>globalThis.__danlingoFixtureDeleteCalls.filter(modelId=>modelId===id).length,selected),2,'failed click and retry each send one delete RPC');assert.equal(await page.locator('#local-delete-confirm').count(),0);
    const removedPath=resolve(dir,'local-model-removed.png');await page.screenshot({path:removedPath,fullPage:true});report.screenshots.push(removedPath);
    models=(await rpc({type:'local-control',control:{action:'list'}})).models;assert.ok(!models.some(model=>model.id===selected));const saved=(await rpc({type:'settings'})).settings;assert.equal(saved.localModelId??'','');assert.equal(models.length,1);assert.equal(saved.backend,before.backend);assert.equal(saved.model,before.model);assert.equal(await page.locator('#model').inputValue(),'DELETE-UNSAVED-DRAFT');assert.equal(await page.locator('#backend').inputValue(),'local');
    for(const section of ['service','watching','live','performance','advanced','data']){await goto(section);const path=resolve(dir,'concise-'+section+'.png');await page.screenshot({path,fullPage:true});report.screenshots.push(path);}
    await goto('service');for(const model of models){const remaining=page.locator(`#local-model-entries [data-model-id="${model.id}"]`);await remaining.locator('[data-model-action="remove"]').click();await remaining.waitFor({state:'detached'});}
    await untilAsync(async()=>page.evaluate(()=>document.activeElement?.id==='local-folder-add'),'empty model list focuses add folder');
    assert.equal((await rpc({type:'settings'})).settings.localModelId??'','');models=(await rpc({type:'local-control',control:{action:'list'}})).models;assert.equal(models.length,0);assert.equal(await page.locator('#local-model-manager .local-model-entry').count(),0);
    await page.reload();await page.waitForFunction(()=>document.querySelector('#result').textContent==='已保存');await page.locator('#backend').selectOption('local');assert.equal((await rpc({type:'local-control',control:{action:'list'}})).models.length,0);assert.equal(await page.locator('#local-model-manager').evaluate(el=>el.open),true);
    await page.setViewportSize({width:390,height:800});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);await page.screenshot({path:resolve(dir,'local-empty-390.png'),fullPage:true});
  });
  assert.deepEqual(report.errors,[]);report.status='PASS';
}catch(error){report.status='FAIL';report.errors.push(error.stack??String(error));process.exitCode=1;}
finally{if(typeof release==='function')release();await context?.close();await new Promise(r=>server.close(r));await writeFile(resolve(dir,'report.json'),JSON.stringify(report,null,2));console.log('REPORT',resolve(dir,'report.json'));}
