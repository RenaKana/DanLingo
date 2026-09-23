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
  'OPFS/browser handle fixture only; no native external-folder grant, restart recovery, or real 19 GiB model/GPU evidence.',
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
  const extension=resolve(dir,'extension');await cp(resolve('.output/chrome-mv3'),extension,{recursive:true});
  const manifest=JSON.parse(await readFile(resolve(extension,'manifest.json'),'utf8'));manifest.host_permissions.push('http://127.0.0.1/*');await writeFile(resolve(extension,'manifest.json'),JSON.stringify(manifest));
  const brandedChrome=process.argv.includes('--chrome');
  const browserName=brandedChrome?'chrome':process.argv.includes('--edge')?'edge':'chromium';
  const browserOptions=browserLaunchOptions(browserName);
  report.browserExecutable=browserOptions.executablePath??browserExecutablePath(browserName,{playwrightBrowser:chromium});
  context=await chromium.launchPersistentContext(resolve(dir,'profile'),{headless:true,...browserOptions,viewport:{width:1180,height:880},...(brandedChrome?{ignoreDefaultArgs:['--disable-extensions']} : {}),args:[...(brandedChrome?[]:['--disable-extensions-except='+extension,'--load-extension='+extension]),'--disable-background-networking','--no-first-run']});
  await context.addInitScript(({directoryName})=>{
    if(location.protocol!=='chrome-extension:')return;
    globalThis.__danlingoFixturePickerCalls=[];
    globalThis.__danlingoFixturePickerResolved=false;
    globalThis.__danlingoFixtureFilePickerCalls=[];
    globalThis.__danlingoFixtureScanRequests=0;
    const originalSend=chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage=(message,...args)=>{if(message?.type==='local-control'&&message.control?.action==='directory-scan')globalThis.__danlingoFixtureScanRequests++;return originalSend(message,...args);};
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
  page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));page.on('dialog',d=>d.accept());await page.goto(origin+'/options.html');await page.waitForFunction(()=>document.querySelector('#result')?.textContent==='已保存');
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
  const waitExtensionPage=async(path)=>{await until(()=>context.pages().some(candidate=>candidate.url().includes(path)));return context.pages().find(candidate=>candidate.url().includes(path));};
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
  await check('language-dropdown-names-keyboard-and-custom-value',async()=>{
    await goto('watching');await page.locator('#target-language').locator('..').locator('.combobox-toggle').click();await page.locator('#target-language-choices [role=option]').filter({hasText:'日本語'}).click();
    assert.match(await page.locator('#target-language').inputValue(),/日本語/);await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#result').textContent==='已保存');assert.equal((await rpc({type:'settings'})).settings.targetLanguage,'ja');
    await page.locator('#target-language').fill('Français');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');assert.match(await page.locator('#target-language').inputValue(),/法文|法语/);
    await page.locator('#target-language').fill('Klingon');await page.keyboard.press('Escape');await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#result').textContent==='已保存');assert.equal((await rpc({type:'settings'})).settings.targetLanguage,'Klingon');
  });
  await check('directory-authorize-opfs-scan-reuse-no-autoselect-and-draft-isolation',async()=>{
    await seedDirectoryFixture();const legacyId=await seedLegacyModel();await goto('service');
    assert.equal(await page.locator('#local-file').count(),0);assert.equal(await page.locator('#local-import').count(),0);assert.equal(await page.locator('#local-import-cancel').count(),0);
    const dbShape=await page.evaluate(async()=>{const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('danlingo-local-models-v1',2);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});const result={version:db.version,stores:[...db.objectStoreNames]};db.close();return result;});
    assert.equal(dbShape.version,2);assert.deepEqual(dbShape.stores.sort(),['directories','models']);
    const launcher=await context.newPage();await launcher.goto(origin+'/popup.html');const site=await context.newPage();await site.goto('https://www.youtube.com/watch?v=fixture-folder');await site.locator('#focus').focus();await site.bringToFront();
    assert.equal((await launcher.evaluate(()=>chrome.runtime.sendMessage({type:'open-settings'}))).ok,true);await site.waitForFunction(()=>!!document.querySelector('[data-danlingo-settings]'));await until(()=>site.frames().some(f=>f.url().includes('?embedded=')));const frame=site.frames().find(f=>f.url().includes('?embedded='));
    await frame.waitForFunction(()=>document.querySelector('#result')?.textContent==='已保存');const embeddedRpc=m=>frame.evaluate(m=>chrome.runtime.sendMessage(m),m);const frameGoto=async id=>frame.locator('#category').evaluate((el,id)=>{el.value=id;el.dispatchEvent(new Event('change',{bubbles:true}));},id);
    await frame.locator('#model').fill('UNSAVED-ONLINE-DRAFT');await frameGoto('watching');await frame.locator('#target-language').fill('DRAFT-LANGUAGE');await frameGoto('service');await frame.locator('#backend').selectOption('local');await frame.waitForFunction(()=>document.querySelector('#local-settings')?.hidden===false);const earlyPath=resolve(dir,'directory-controls-early.png');await site.screenshot({path:earlyPath,fullPage:true});report.screenshots.push(earlyPath);
    const auth=await (async()=>{const pending=waitExtensionPage('/model-folders.html');await frame.locator('#local-folder-add').click();return pending;})();await auth.locator('#folder-authorize').waitFor();assert.equal(await auth.evaluate(()=>window.top===window),true);await auth.locator('#folder-authorize').click();
    await auth.waitForFunction(()=>document.querySelector('#folder-auth-status')?.textContent?.includes('已登记'));assert.equal(await auth.evaluate(()=>globalThis.__danlingoFixturePickerResolved),true);assert.deepEqual(await auth.evaluate(()=>globalThis.__danlingoFixturePickerCalls[0]),{mode:'read',id:'danlingo-models'});assert.equal(await site.evaluate(()=>globalThis.__danlingoFixturePickerResolved===true),false);
    await auth.close();await frame.waitForFunction(()=>document.querySelectorAll('.local-directory').length===1);await frame.waitForFunction(()=>/识别完成/.test(document.querySelector('#local-scan-status')?.textContent??''));
    let listing=await embeddedRpc({type:'local-control',control:{action:'list'}});assert.equal(listing.directories.length,1);assert.equal('handle' in listing.directories[0],false);assert.ok(listing.models.every(model=>!('handle' in model)&&!('blobs' in model)));
    let directory=listing.directories[0];let directoryModels=listing.models.filter(model=>model.source?.kind==='directory');assert.equal(directoryModels.length,3);assert.equal(listing.models.filter(model=>model.id===legacyId).length,1);assert.deepEqual(directoryModels.flatMap(model=>model.source.files.map(file=>file.path)).filter(path=>path.endsWith('/model.gguf')).sort(),['one/model.gguf','two/model.gguf']);assert.ok(directory.issues?.some(issue=>issue.path==='bad.gguf'));
    assert.equal(await frame.locator('#local-model').inputValue(),'');assert.equal(await frame.locator('#model').inputValue(),'UNSAVED-ONLINE-DRAFT');assert.equal(await frame.locator('#target-language').inputValue(),'DRAFT-LANGUAGE');
    await frameGoto('watching');await frameGoto('service');await frame.locator('#backend').selectOption('online');await frame.locator('#backend').selectOption('local');await embeddedRpc({type:'settings'});
    assert.equal(await frame.evaluate(()=>globalThis.__danlingoFixtureScanRequests),0,'opening/reentering settings does not scan');
    const initialIds=new Map(directoryModels.map(model=>[model.source.files[0].path,model.id]));const initialRevision=directory.revision;
    const row=frame.locator('.local-directory').first();await row.getByRole('button',{name:'刷新'}).click();await untilAsync(async()=>{const value=await embeddedRpc({type:'local-control',control:{action:'list'}});return value.directories?.[0]?.revision>initialRevision;});listing=await embeddedRpc({type:'local-control',control:{action:'list'}});directory=listing.directories[0];directoryModels=listing.models.filter(model=>model.source?.kind==='directory');assert.equal(directory.revision,initialRevision+1);for(const model of directoryModels)assert.equal(model.id,initialIds.get(model.source.files[0].path));
    const repeatBeforeRevision=directory.revision,directoryId=directory.id;const repeatAuthPending=waitExtensionPage('/model-folders.html');await frame.locator('#local-folder-add').click();const repeatAuth=await repeatAuthPending;await repeatAuth.locator('#folder-authorize').click();await repeatAuth.waitForFunction(()=>document.querySelector('#folder-auth-status')?.textContent?.includes('已登记'));await repeatAuth.close();await untilAsync(async()=>{const value=await embeddedRpc({type:'local-control',control:{action:'list'}});return value.directories?.[0]?.revision>repeatBeforeRevision;});listing=await embeddedRpc({type:'local-control',control:{action:'list'}});directory=listing.directories[0];assert.equal(directory.id,directoryId);
    const changedBytes=[...fixture('model.gguf',{'llama.block_count':5}).buffer,1,2,3];await page.evaluate(async({directoryName,bytes})=>{const root=await (await navigator.storage.getDirectory()).getDirectoryHandle(directoryName,{create:false}),directory=await root.getDirectoryHandle('one',{create:false}),handle=await directory.getFileHandle('model.gguf',{create:false}),writable=await handle.createWritable();await writable.write(new Uint8Array(bytes));await writable.close();return (await handle.getFile()).size;},{directoryName:fixtureDirectoryName,bytes:changedBytes});const beforeChangedListing=await embeddedRpc({type:'local-control',control:{action:'list'}});const beforeChangedRevision=beforeChangedListing.directories[0].revision;await row.getByRole('button',{name:'刷新'}).click();await untilAsync(async()=>{const value=await embeddedRpc({type:'local-control',control:{action:'list'}});return value.directories?.[0]?.revision>beforeChangedRevision&&value.models?.some(model=>model.source?.files?.some(file=>file.path==='one/model.gguf'&&model.id!==initialIds.get('one/model.gguf')));});listing=await embeddedRpc({type:'local-control',control:{action:'list'}});directoryModels=listing.models.filter(model=>model.source?.kind==='directory');const changed=directoryModels.find(model=>model.source.files[0].path==='one/model.gguf');assert.ok(changed);assert.notEqual(changed.id,initialIds.get('one/model.gguf'));assert.equal(await frame.locator('#local-model').inputValue(),'');
    await frame.locator('#local-model').selectOption(changed.id);await untilAsync(async()=>{const value=await embeddedRpc({type:'settings'});return (value.settings.localModelId??'')===changed.id;});assert.equal(await frame.locator('#local-delete').textContent(),'移除模型');assert.match(await frame.locator('#local-model option:checked').textContent(),/^model\.gguf · /);assert.match(await frame.locator('#local-model-meta').textContent(),/one\/model\.gguf/);assert.ok((await frame.locator('#local-model-meta').textContent()).includes(`${changedBytes.length} B`));
    const excluded=directoryModels.find(model=>model.name==='root.gguf');await frame.locator('#local-model-manager summary').click();
    await frame.locator(`.local-model-entry[data-model-id="${excluded.id}"] button`).click();await frame.locator('#local-delete-dismiss').click();assert.ok((await embeddedRpc({type:'local-control',control:{action:'list'}})).models.some(model=>model.id===excluded.id));
    await frame.locator(`.local-model-entry[data-model-id="${excluded.id}"] button`).click();await frame.locator('#local-delete-accept').click();await frame.waitForFunction(()=>document.querySelector('#local-delete-confirm').hidden);
    assert.equal((await embeddedRpc({type:'settings'})).settings.localModelId,changed.id,'removing another model keeps selection');
    await row.getByRole('button',{name:'刷新'}).click();await frame.waitForFunction(()=>!document.querySelector('#local-folder-refresh').disabled);
    assert.ok(!(await embeddedRpc({type:'local-control',control:{action:'list'}})).models.some(model=>model.name==='root.gguf'),'manual refresh does not restore excluded model');
    await frame.locator('#local-model-manager summary').click();
    for(const [width,height,label] of [[1180,880,'directory-desktop'],[390,800,'directory-390']]){await site.setViewportSize({width,height});assert.equal(await frame.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,label+' overflow');const path=resolve(dir,label+'.png');await site.screenshot({path,fullPage:true});report.screenshots.push(path);if(width===390){await frame.locator('#local-model').scrollIntoViewIfNeeded();const selectionPath=resolve(dir,'directory-390-selection.png');await site.screenshot({path:selectionPath,fullPage:true});report.screenshots.push(selectionPath);}}await site.setViewportSize({width:1180,height:880});
    await row.getByRole('button',{name:'移除'}).click();await row.getByRole('button',{name:'确认移除'}).click();await untilAsync(async()=>{const value=await embeddedRpc({type:'settings'});return (value.settings.localModelId??'')==='';});await frame.waitForFunction(()=>document.querySelector('#local-model').value==='');listing=await embeddedRpc({type:'local-control',control:{action:'list'}});assert.equal(listing.directories.length,0);assert.deepEqual(listing.models.map(model=>model.id),[legacyId]);assert.equal(await frame.locator('#model').inputValue(),'UNSAVED-ONLINE-DRAFT');assert.equal(await frame.locator('#target-language').inputValue(),'DRAFT-LANGUAGE');
    await page.evaluate(()=>localStorage.setItem('__danlingoFixturePickerMode','deny'));const denied=await context.newPage();await denied.goto(`${origin}/model-folders.html`);await denied.locator('#folder-authorize').click();await denied.waitForFunction(()=>document.querySelector('#folder-auth-status')?.textContent?.length>0);assert.match(await denied.locator('#folder-auth-status').textContent(),/需要|操作未完成/);await denied.close();await page.evaluate(()=>localStorage.removeItem('__danlingoFixturePickerMode'));await site.close();await launcher.close();
  });
  await check('direct-file-picker-read-only-registration-reselection-removal-and-preload-setting',async()=>{
    await goto('service');await page.locator('#backend').selectOption('online');await page.locator('#model').fill('FILE-UNSAVED-DRAFT');await page.locator('#backend').selectOption('local');
    assert.equal(await page.locator('#local-preload-entry').isChecked(),true);
    await page.evaluate(()=>localStorage.setItem('__danlingoFixtureFilePaths','["root.gguf","bad.gguf"]'));
    const adding=waitExtensionPage('/model-folders.html');await page.locator('#local-file-add').click();const auth=await adding;await auth.locator('#file-authorize').click();
    await auth.waitForFunction(()=>document.querySelector('#folder-auth-status').textContent.includes('已登记 1 个模型'));
    assert.match(await auth.locator('#folder-auth-status').textContent(),/bad\.gguf/);
    const pickerOptions=await auth.evaluate(()=>globalThis.__danlingoFixtureFilePickerCalls[0]);assert.equal(pickerOptions.multiple,true);assert.equal(pickerOptions.excludeAcceptAllOption,true);assert.deepEqual(pickerOptions.types[0].accept,{'application/octet-stream':['.gguf']});
    for(const [width,height,label] of [[660,520,'file-picker-desktop'],[390,600,'file-picker-390']]){await auth.setViewportSize({width,height});assert.equal(await auth.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);const path=resolve(dir,label+'.png');await auth.screenshot({path,fullPage:true});report.screenshots.push(path);}await auth.close();
    await page.waitForFunction(()=>document.querySelector('#local-model-manager')?.hidden===false);
    let listing=await rpc({type:'local-control',control:{action:'list'}});const model=listing.models.find(model=>model.source?.kind==='files');assert.ok(model);assert.equal(listing.directories.length,0);assert.equal(await page.locator('#local-model').inputValue(),'');assert.equal(await page.locator('#model').inputValue(),'FILE-UNSAVED-DRAFT');
    const raw=await page.evaluate(async id=>{const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('danlingo-local-models-v1',2);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});const result=await new Promise(resolve=>{const request=db.transaction('models').objectStore('models').get(id);request.onsuccess=()=>resolve({hasBlobs:'blobs' in request.result,handleKinds:request.result.fileHandles.map(handle=>handle.kind)});});db.close();return result;},model.id);assert.equal(raw.hasBlobs,false);assert.deepEqual(raw.handleKinds,['file']);
    await page.evaluate(()=>localStorage.setItem('__danlingoFixtureFilePaths','["root.gguf"]'));
    const repeated=waitExtensionPage('/model-folders.html');await page.locator('#local-file-add').click();const repeatAuth=await repeated;await repeatAuth.locator('#file-authorize').click();await repeatAuth.waitForFunction(()=>document.querySelector('#folder-auth-status').textContent.includes('已登记 1 个模型'));await repeatAuth.close();
    listing=await rpc({type:'local-control',control:{action:'list'}});assert.deepEqual(listing.models.filter(model=>model.source?.kind==='files').map(model=>model.id),[model.id]);
    for(const mode of ['cancel','deny']){await page.evaluate(mode=>localStorage.setItem('__danlingoFixtureFilePickerMode',mode),mode);const waiting=waitExtensionPage('/model-folders.html');await page.locator('#local-file-add').click();const dialog=await waiting;await dialog.locator('#file-authorize').click();await dialog.waitForFunction(()=>document.querySelector('#folder-auth-status').textContent.length>0);assert.match(await dialog.locator('#folder-auth-status').textContent(),mode==='cancel'?/已取消选择/:/需要重新授权/);await dialog.close();assert.deepEqual((await rpc({type:'local-control',control:{action:'list'}})).models.map(model=>model.id),listing.models.map(model=>model.id));}
    await page.evaluate(()=>localStorage.removeItem('__danlingoFixtureFilePickerMode'));
    await page.locator('#local-model').selectOption(model.id);await untilAsync(async()=>((await rpc({type:'settings'})).settings.localModelId??'')===model.id);
    await page.locator('#local-preload-entry').uncheck();await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#result').textContent==='已保存');assert.equal((await rpc({type:'settings'})).settings.localPreloadOnEntry,false);
    await page.reload();await page.waitForFunction(()=>document.querySelector('#result').textContent==='已保存');assert.equal(await page.locator('#local-preload-entry').isChecked(),false);assert.equal(await page.evaluate(()=>globalThis.__danlingoFixtureScanRequests),0);
    await page.locator('#local-preload-entry').check();await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#result').textContent==='已保存');assert.equal((await rpc({type:'settings'})).settings.localPreloadOnEntry,true);
    await page.locator('#local-model-manager summary').click();for(const [width,height,label] of [[1180,880,'local-manager-desktop'],[390,800,'local-manager-390']]){await page.setViewportSize({width,height});await page.locator('#local-model-manager').scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);const path=resolve(dir,label+'.png');await page.screenshot({path,fullPage:true});report.screenshots.push(path);}await page.setViewportSize({width:1180,height:880});
    await page.locator('#local-delete').click();await page.locator('#local-delete-accept').click();await page.waitForFunction(()=>document.querySelector('#local-delete-confirm').hidden);assert.equal((await rpc({type:'settings'})).settings.localModelId??'','');
    assert.equal((await rpc({type:'local-control',control:{action:'list'}})).models.filter(model=>model.source).length,0);
    assert.equal(await page.evaluate(async directoryName=>(await (await (await navigator.storage.getDirectory()).getDirectoryHandle(directoryName)).getFileHandle('root.gguf')).getFile().then(file=>file.size),fixtureDirectoryName),fixture('root.gguf').buffer.length);
    await page.locator('#backend').selectOption('online');
  });
  await check('legacy-blob-delete-confirmation-selection-and-draft-isolation',async()=>{
    await goto('service');await page.locator('#model').fill('DELETE-UNSAVED-DRAFT');await page.locator('#backend').selectOption('local');await page.waitForFunction(()=>[...document.querySelectorAll('#local-model option')].some(option=>option.value==='legacy-fixture-model'));assert.equal(await page.locator('#local-model').inputValue(),'');
    const before=(await rpc({type:'settings'})).settings,models=(await rpc({type:'local-control',control:{action:'list'}})).models;assert.equal(models.length,1);await page.locator('#local-model').selectOption(models[0].id);await page.waitForFunction(async()=>{const value=await chrome.runtime.sendMessage({type:'settings'});return value.settings.localModelId===document.querySelector('#local-model').value;});
    await page.locator('#local-delete').click();assert.equal(await page.locator('#local-delete-confirm').isVisible(),true);assert.match(await page.locator('#local-delete-description').textContent(),/原始 GGUF 文件不受影响/);await page.locator('#local-delete-dismiss').click();assert.equal((await rpc({type:'local-control',control:{action:'list'}})).models.length,models.length);await page.locator('#local-delete').click();await page.screenshot({path:resolve(dir,'legacy-delete-confirm.png'),fullPage:true});report.screenshots.push(resolve(dir,'legacy-delete-confirm.png'));await page.locator('#local-delete-accept').click();await page.waitForFunction(()=>document.querySelector('#local-result').textContent.includes('的扩展内副本'));assert.equal((await rpc({type:'settings'})).settings.localModelId??'','');assert.equal(await page.locator('#model').inputValue(),'DELETE-UNSAVED-DRAFT');assert.equal((await rpc({type:'settings'})).settings.backend,before.backend);assert.equal((await rpc({type:'local-control',control:{action:'list'}})).models.length,0);
  });
  await check('online-switch-uses-network-and-refreshes-key-and-thinking-state',async()=>{
    const saved=(await rpc({type:'settings'})).settings;
    assert.equal((await rpc({type:'save',settings:{...saved,backend:'local',enabled:false,model:'custom-again',thinkingEffort:'off',targetLanguage:'zh-Hans'},remember:false})).ok,true);
    await page.reload();await page.waitForFunction(()=>document.querySelector('#result').textContent==='已保存');
    await page.locator('#backend').selectOption('online');assert.doesNotMatch(await page.locator('#key-state').textContent(),/本地推理/);
    assert.equal(await page.locator('#thinking-effort').inputValue(),'default');
    const before=translations;await page.locator('#test-model').click();await page.waitForFunction(()=>document.querySelector('#test-result').textContent.includes('这是测试译文'));
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
  await check('embedded-session-isolation-draft-close-escape-focus-narrow',async()=>{
    assert.equal((await rpc({type:'open-settings'})).ok,false,'standalone UI cannot mint a popup grant');
    const launcher=await context.newPage();await launcher.goto(origin+'/popup.html');
    const site=await context.newPage();await site.goto('https://www.youtube.com/watch?v=fixture0001');await site.locator('#focus').focus();await site.bringToFront();
    assert.equal((await launcher.evaluate(()=>chrome.runtime.sendMessage({type:'open-settings'}))).ok,true);
    await site.waitForFunction(()=>!!document.querySelector('[data-danlingo-settings]'));
    await new Promise((resolve,reject)=>{const deadline=setTimeout(()=>reject(new Error('embedded frame not attached')),10000);const tick=()=>{const f=site.frames().find(f=>f.url().includes('?embedded='));if(f){clearTimeout(deadline);resolve();}else setTimeout(tick,30);};tick();});
    const frame=site.frames().find(f=>f.url().includes('?embedded='));await frame.waitForFunction(()=>document.querySelector('#result')?.textContent==='已保存');assert.equal((await frame.evaluate(()=>chrome.runtime.sendMessage({type:'settings'}))).ok,true);
    assert.equal(await site.evaluate(()=>document.querySelector('[data-danlingo-settings]').shadowRoot),null);
    const url=frame.url();await frame.locator('#model').fill('UNSAVED-IN-FRAME');let dialogs=0;site.on('dialog',async d=>{dialogs++;await d.dismiss();});await frame.locator('.settings-close').click();assert.equal(site.frames().some(f=>f.url()===url),true);assert.equal(dialogs,1);
    site.removeAllListeners('dialog');site.on('dialog',d=>d.accept());await site.setViewportSize({width:390,height:800});assert.equal(await frame.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    const screenshot=resolve(dir,'embedded-390.png');await site.screenshot({path:screenshot});report.screenshots.push(screenshot);
    await frame.locator('#model').focus();await site.keyboard.press('Escape');await site.waitForFunction(()=>!document.querySelector('[data-danlingo-settings]'));assert.equal(await site.evaluate(()=>document.activeElement.id),'focus');
    const rogue=await context.newPage();await rogue.goto(url);await rogue.waitForFunction(()=>document.body.textContent.includes('会话无效'));assert.equal((await rogue.evaluate(()=>chrome.runtime.sendMessage({type:'settings'}))).ok,false);await rogue.close();
    assert.equal(site.url(),'https://www.youtube.com/watch?v=fixture0001');await site.close();await launcher.close();
  });
  await check('outside-click-saves-valid-draft-and-keeps-invalid-or-unauthorized-draft',async()=>{
    const launcher=await context.newPage();await launcher.goto(origin+'/popup.html');const site=await context.newPage();await site.goto('https://www.youtube.com/watch?v=fixture0002');
    const open=async()=>{await site.bringToFront();assert.equal((await launcher.evaluate(()=>chrome.runtime.sendMessage({type:'open-settings'}))).ok,true);await site.waitForFunction(()=>!!document.querySelector('[data-danlingo-settings]'));await until(()=>site.frames().some(f=>f.url().includes('?embedded=')));const f=site.frames().find(f=>f.url().includes('?embedded='));await f.waitForFunction(()=>document.querySelector('#result')?.textContent==='已保存');return f;};
    let frame=await open();await frame.locator('#model').fill('outside-saved');await site.mouse.click(3,3);await site.waitForFunction(()=>!document.querySelector('[data-danlingo-settings]'));assert.equal((await rpc({type:'settings'})).settings.model,'outside-saved');
    frame=await open();await frame.locator('#endpoint').fill('not-a-service-url');await site.mouse.click(3,3);await frame.waitForFunction(()=>document.querySelector('#result').classList.contains('error'));assert.equal(await site.locator('[data-danlingo-settings]').count(),1);assert.equal((await rpc({type:'settings'})).settings.endpoint.includes('not-a-service-url'),false);
    await frame.locator('#endpoint').fill('https://not-authorized.invalid/v1');await site.mouse.click(3,3);await frame.waitForFunction(()=>document.querySelector('#result').textContent.includes('保存并授权服务'));assert.equal(await site.locator('[data-danlingo-settings]').count(),1);
    await frame.locator('#endpoint').fill(endpoint);await site.mouse.click(3,3);await site.waitForFunction(()=>!document.querySelector('[data-danlingo-settings]'));assert.equal(site.url(),'https://www.youtube.com/watch?v=fixture0002');await site.close();await launcher.close();
  });
  await check('delete-selected-legacy-copy-without-fallback-and-empty-reopen',async()=>{
    await seedLegacyModel('legacy-delete-first','legacy-first.gguf');await seedLegacyModel('legacy-delete-second','legacy-second.gguf');
    await page.reload();await page.waitForFunction(()=>document.querySelector('#result').textContent==='已保存');
    await goto('service');await page.locator('#model').fill('DELETE-UNSAVED-DRAFT');await page.locator('#backend').selectOption('local');
    const before=(await rpc({type:'settings'})).settings;
    let models=(await rpc({type:'local-control',control:{action:'list'}})).models;assert.equal(models.length,2);
    assert.equal(await page.locator('#local-model').inputValue(),'');const selected='legacy-delete-first';await page.locator('#local-model').selectOption(selected);await untilAsync(async()=>((await rpc({type:'settings'})).settings.localModelId??'')===selected);
    await page.locator('#local-delete').click();assert.equal(await page.locator('#local-delete-confirm').isVisible(),true);
    assert.match(await page.locator('#local-delete-description').textContent(),/原始 GGUF 文件不受影响/);
    await page.locator('#local-delete-dismiss').click();assert.equal((await rpc({type:'local-control',control:{action:'list'}})).models.length,models.length);
    await page.locator('#local-delete').click();await page.screenshot({path:resolve(dir,'local-delete-confirm.png'),fullPage:true});
    await page.locator('#local-delete-accept').click();await page.waitForFunction(()=>document.querySelector('#local-result').textContent.includes('的扩展内副本'));
    models=(await rpc({type:'local-control',control:{action:'list'}})).models;assert.ok(!models.some(model=>model.id===selected));
    const saved=(await rpc({type:'settings'})).settings;assert.equal(saved.localModelId??'','');assert.equal(await page.locator('#local-model').inputValue(),'');assert.equal(models.length,1);assert.equal(saved.backend,before.backend);assert.equal(saved.model,before.model);
    assert.equal(await page.locator('#model').inputValue(),'DELETE-UNSAVED-DRAFT');assert.equal(await page.locator('#backend').inputValue(),'local');
    for(const section of ['service','watching','live','performance','advanced','data']){await goto(section);const path=resolve(dir,'concise-'+section+'.png');await page.screenshot({path,fullPage:true});report.screenshots.push(path);}
    await goto('service');for(const model of models){await page.locator('#local-model').selectOption(model.id);await untilAsync(async()=>((await rpc({type:'settings'})).settings.localModelId??'')===model.id);await page.locator('#local-delete').click();await page.locator('#local-delete-accept').click();await page.waitForFunction(()=>document.querySelector('#local-delete-confirm').hidden);assert.equal(await page.locator('#local-model').inputValue(),'');}
    assert.equal((await rpc({type:'settings'})).settings.localModelId??'','');assert.equal(await page.locator('#local-delete').isDisabled(),true);
    assert.equal(await page.locator('#local-model').textContent(),'请选择模型');
    await page.reload();await page.waitForFunction(()=>document.querySelector('#result').textContent==='已保存');await page.locator('#backend').selectOption('local');
    assert.equal((await rpc({type:'local-control',control:{action:'list'}})).models.length,0);assert.equal(await page.locator('#local-delete').isDisabled(),true);
    await page.setViewportSize({width:390,height:800});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    await page.screenshot({path:resolve(dir,'local-empty-390.png'),fullPage:true});
  });
  assert.deepEqual(report.errors,[]);report.status='PASS';
}catch(error){report.status='FAIL';report.errors.push(error.stack??String(error));process.exitCode=1;}
finally{if(typeof release==='function')release();await context?.close();await new Promise(r=>server.close(r));await writeFile(resolve(dir,'report.json'),JSON.stringify(report,null,2));console.log('REPORT',resolve(dir,'report.json'));}
