import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Built extension UI in an isolated profile; transport replies are fixtures, never a real provider.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '../src/core/config.ts';
const root=resolve('.artifacts/settings-redesign');await mkdir(root,{recursive:true});
const dir=await mkdtemp(resolve(root,'run-')); const report={evidence:'BUILT_EXTENSION_ISOLATED_PROFILE_UI_FIXTURES',checks:{},screenshots:[],errors:[]};
const {chromium}=await loadPlaywright();
let context,page;
const check=async(name,run)=>{await run();report.checks[name]='PASS';console.log('PASS',name);};
try{
  const extension=resolve(dir,'extension');await cp(resolve('.output/chrome-mv3'),extension,{recursive:true});
  const manifest=JSON.parse(await readFile(resolve(extension,'manifest.json'),'utf8'));manifest.host_permissions.push('https://fixture.invalid/*');await writeFile(resolve(extension,'manifest.json'),JSON.stringify(manifest));
  context=await chromium.launchPersistentContext(resolve(dir,'profile'),{headless:true,...browserLaunchOptions("chromium"),viewport:{width:1360,height:900},args:['--disable-extensions-except='+extension,'--load-extension='+extension,'--disable-background-networking','--no-first-run','--host-resolver-rules=MAP * ~NOTFOUND']});
  await context.route(/^https?:/,route=>route.abort());
  const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker'); const origin='chrome-extension://'+new URL(worker.url()).host;
  await context.addInitScript(()=>{
    if(!globalThis.chrome?.runtime?.id)return;
    const original=chrome.runtime.sendMessage.bind(chrome.runtime);
    const fixture=globalThis.__uiFixture={calls:[],hold:false,deny:false,release:null,modelHold:false,releaseModel:null};
    chrome.permissions.request=async()=>!fixture.deny;
    chrome.runtime.sendMessage=async(message,...rest)=>{
      fixture.calls.push(message.type);
      if(message.type==='save'&&fixture.hold)await new Promise(done=>fixture.release=done);
      if(message.type==='test-model'){
        if(fixture.modelHold)await new Promise(done=>fixture.releaseModel=done);
        return {ok:true,model:message.settings.model,elapsedMs:100,sourceText:'fixture',text:'模拟译文'};
      }
      return original(message,...rest);
    };
  });
  page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));page.on('dialog',dialog=>dialog.accept());
  await page.goto(origin+'/options.html'); await page.locator('#category').waitFor({state:'attached'});
  const rpc=message=>page.evaluate(message=>chrome.runtime.sendMessage(message),message);
  assert.equal((await rpc({type:'save',settings:{...DEFAULT_SETTINGS,endpoint:'https://fixture.invalid/v1',model:'fixture-model',profile:'chat-completions',thinkingEffort:'default'},apiKey:'ui-fixture-key',remember:false})).ok,true);
  await page.reload(); await page.waitForFunction(()=>document.querySelector('#result').textContent==='已保存');
  const goto=async id=>{if(await page.locator('#category').isVisible())await page.locator('#category').selectOption(id);else await page.locator(`nav a[href="#${id}"]`).click();await page.waitForFunction(id=>!document.querySelector(`[data-section="${id}"]`).hidden,id);};
  const screen=async name=>{const path=resolve(dir,name+'.png');await page.screenshot({path,fullPage:true});report.screenshots.push(path);};
  await check('all-original-controls-retained-once-and-six-sections',async()=>{
    const html=await readFile(resolve('entrypoints/options/index.html'),'utf8');const ids=[...html.matchAll(/id="([^"]+)"/g)].map(m=>m[1]);
    for(const id of ids)assert.equal(await page.locator('#'+id).count(),1,id);
    assert.equal(await page.locator('[data-section]').count(),6);
    assert.equal(await page.locator('#lp-superChatReasoning').evaluate(el=>el.closest('[data-section]').dataset.section),'live');
    assert.equal(await page.locator('#lp-parallel').evaluate(el=>el.closest('[data-section]').dataset.section),'advanced');
    assert.equal(await page.locator('#lb-start').evaluate(el=>el.closest('[data-section]').dataset.section),'performance');
  });
  await screen('service-light');
  await page.locator('#theme').selectOption('dark');await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');await screen('service-dark');
  await page.setViewportSize({width:360,height:800});await screen('service-360');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.setViewportSize({width:1360,height:900});
  if(!process.argv.includes('--preview-only')){
    await check('navigation-history-draft-and-no-hidden-focus',async()=>{
      await page.locator('#model').fill('draft-model');await goto('watching');await page.locator('#target-language').fill('fr');
      await goto('advanced');await page.goBack();await page.waitForFunction(()=>location.hash==='#watching');
      assert.equal(await page.locator('#target-language').inputValue(),'fr');await page.goForward();await page.waitForFunction(()=>location.hash==='#advanced');
      await goto('service');assert.equal(await page.locator('#model').inputValue(),'draft-model');
      assert.match(await page.locator('#result').textContent(),/未保存/);
      assert.equal(await page.evaluate(()=>[...document.querySelectorAll('[data-section][hidden] input,[data-section][hidden] button')].some(el=>el.getClientRects().length>0)),false);
      await page.locator('#model').focus();await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.closest('[data-section]')?.dataset.section),'service');
    });
    await check('reload-category-remains-authorized',async()=>{
      await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#result').textContent==='已保存');
      await goto('advanced');await page.reload();await page.waitForFunction(()=>document.querySelector('#result').textContent==='已保存');
      assert.equal((await rpc({type:'settings'})).ok,true);assert.equal(new URL(page.url()).hash,'#advanced');
    });
    await check('cross-section-invalid-field-revealed-and-focused',async()=>{
      await goto('advanced');await page.locator('#concurrency').evaluate(el=>el.closest('details').open=true);await page.locator('#concurrency').fill('0');
      await goto('service');const before=await page.evaluate(()=>__uiFixture.calls.filter(x=>x==='save').length);
      await page.locator('#save').click();await page.waitForFunction(()=>document.activeElement.id==='concurrency');assert.equal(new URL(page.url()).hash,'#advanced');
      assert.equal(await page.evaluate(()=>__uiFixture.calls.filter(x=>x==='save').length),before);await page.locator('#concurrency').fill('2');
    });
    await check('test-controls-excluded-and-save-race-preserves-new-draft',async()=>{
      await goto('performance');await page.locator('#performance-concurrency').fill('0');
      await goto('service');await page.evaluate(()=>__uiFixture.hold=true);await page.locator('#save').click();await page.waitForFunction(()=>!!__uiFixture.release);
      await page.locator('#model').fill('edited-during-save');await goto('watching');await page.locator('#target-language').fill('ko');
      await page.evaluate(()=>{__uiFixture.hold=false;__uiFixture.release();});await page.waitForFunction(()=>!document.querySelector('#save').disabled);
      assert.match(await page.locator('#result').textContent(),/未保存/);await goto('service');assert.equal(await page.locator('#model').inputValue(),'edited-during-save');
      assert.equal((await rpc({type:'overview'})).settings.model,'draft-model');
      await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#result').textContent==='已保存');
      assert.equal((await rpc({type:'overview'})).settings.targetLanguage,'ko');
      await goto('performance');await page.locator('#performance-concurrency').fill('1');
    });
    await check('permission-denial-keeps-draft-and-connection-test-survives-navigation',async()=>{
      await goto('service');await page.locator('#model').fill('denied-draft');await page.evaluate(()=>__uiFixture.deny=true);await page.locator('#save').click();
      await page.waitForFunction(()=>document.querySelector('#result').classList.contains('error'));assert.equal((await rpc({type:'overview'})).settings.model,'edited-during-save');
      await page.evaluate(()=>{__uiFixture.deny=false;__uiFixture.modelHold=true;});await page.locator('#test-model').click();await page.waitForFunction(()=>!!__uiFixture.releaseModel);
      await goto('watching');assert.equal(await page.locator('#running-task').isVisible(),true);await page.locator('#running-task').click();
      await page.locator('#model').fill('new-draft');await page.evaluate(()=>__uiFixture.releaseModel());await page.waitForFunction(()=>!document.querySelector('#test-model').disabled);
      assert.equal(await page.locator('#test-result').textContent(),'');assert.equal(await page.locator('#model').inputValue(),'new-draft');
    });
    await check('backend-switch-hides-controls-without-losing-online-draft',async()=>{
      await page.locator('#backend').selectOption('local');assert.equal(await page.locator('#endpoint').isVisible(),false);assert.equal(await page.locator('#local-model').isVisible(),true);
      await goto('live');assert.equal(await page.locator('#superchat-thinking').isVisible(),false);assert.equal(await page.locator('#lp-superChatReasoning').isVisible(),true);
      await goto('service');await page.locator('#backend').selectOption('online');assert.equal(await page.locator('#model').inputValue(),'new-draft');
    });
    await check('destructive-actions-confirmation-and-local-feedback',async()=>{
      await goto('data');await page.locator('#delete-key').click();assert.equal((await rpc({type:'overview'})).hasKey,true);await page.locator('[data-dismiss="delete-key"]').click();assert.equal((await rpc({type:'overview'})).hasKey,true);
      await page.locator('#clear-cache').click();await page.locator('[data-confirm="clear-cache"]').click();await page.waitForFunction(()=>document.querySelector('#clear-cache-result').textContent==='缓存已清空');
      assert.match(await page.locator('#result').textContent(),/未保存/);
    });
    await check('themes-sync-popup-and-dont-touch-translation-settings',async()=>{
      const before=await rpc({type:'overview'});const popup=await context.newPage();await popup.goto(origin+'/popup.html');await popup.locator('#settings').waitFor();
      await page.locator('#theme').selectOption('light');await popup.waitForFunction(()=>document.documentElement.dataset.theme==='light');
      await page.locator('#theme').selectOption('dark');await popup.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
      const after=await rpc({type:'overview'});assert.deepEqual(after.settings,before.settings);assert.deepEqual(after.engine,before.engine);
      const path=resolve(dir,'popup-dark.png');await popup.locator('main').screenshot({path});report.screenshots.push(path);await popup.close();
      await page.emulateMedia({colorScheme:'light'});await page.locator('#theme').selectOption('system');await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');
      await page.emulateMedia({colorScheme:'dark'});await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
    });
    await check('all-sections-narrow-and-200-percent-layout',async()=>{
      for(const width of [360,680]){await page.setViewportSize({width,height:900});if(width===680)await page.evaluate(()=>document.documentElement.style.zoom='2');
        for(const section of ['service','watching','live','performance','advanced','data']){await goto(section);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,section+' at '+width);}
        await page.evaluate(()=>document.documentElement.style.zoom='');}
    });
  }
  assert.deepEqual(report.errors,[]);report.status='PASS';
}catch(error){report.status='FAIL';report.errors.push(error.stack??String(error));process.exitCode=1;}
finally{await context?.close();await writeFile(resolve(dir,'report.json'),JSON.stringify(report,null,2));console.log('REPORT',resolve(dir,'report.json'));}
