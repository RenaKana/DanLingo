import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Built settings UI and real embedded-frame authorization; performance data is a fixture.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { settingsSection } from './settings-navigation.mjs';

const root=resolve('.artifacts/performance-copy');await mkdir(root,{recursive:true});
const directory=await mkdtemp(resolve(root,'run-')),extension=resolve(directory,'extension');
const baseline=process.argv.includes('--baseline');
const report={evidence:'BUILT_SETTINGS_UI_WITH_FIXTURE_REPORT_AND_ISOLATED_BROWSER',baseline,checks:{},screenshots:[],errors:[]};
const fixture={id:'copy-fixture',state:'completed',config:{count:10,mode:'latency',concurrency:4,batchSize:1,arrivalIntervalMs:0,strategy:'normal'},model:'Fixture HY-MT Q8',backend:'local',startedAt:1,finishedAt:2001,planned:10,admitted:10,completed:10,actualRequests:10,successRequests:10,failed:0,timeout:0,cancelled:0,unsent:0,meanMs:670.5,p50Ms:660.7,p95Ms:744.4,successRate:1,meanQueueMs:0,meanReadyMs:670.5,withinBudgetRate:1,throughput:4.98,firstRequestMs:659.8,stableMeanMs:671.7,usageReports:10,samples:[],jobs:[],notes:[],localInferenceCalls:21,usage:{promptTokens:329,completionTokens:211,totalTokens:540,cachedInputTokens:0}};
let context;
const check=async(name,run)=>{await run();report.checks[name]='PASS';console.log('PASS',name);};
try{
  await cp(resolve('.output/chrome-mv3'),extension,{recursive:true});
  const {chromium}=await loadPlaywright();
  context=await chromium.launchPersistentContext(resolve(directory,'profile'),{headless:true,...browserLaunchOptions("chromium"),viewport:{width:1360,height:1000},args:['--disable-extensions-except='+extension,'--load-extension='+extension,'--disable-background-networking','--disable-component-update','--no-first-run']});
  const hostUrl='https://www.youtube.com/danlingo-copy-fixture';
  await context.route('**/*',route=>{const url=route.request().url();return url===hostUrl?route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><title>Isolated settings host</title><p>Settings clipboard fixture</p>'}):/^https?:/.test(url)?route.abort():route.continue();});
  const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
  const origin='chrome-extension://'+new URL(worker.url()).host;
  await context.addInitScript(fixture=>{
    if(!globalThis.chrome?.runtime?.id)return;
    const send=chrome.runtime.sendMessage.bind(chrome.runtime);
    globalThis.__copyFixture={report:structuredClone(fixture),mode:'native',writes:[],legacyCalls:0,starts:0};
    chrome.runtime.sendMessage=(message,...rest)=>{
      if(message?.type==='performance-status')return Promise.resolve({ok:true,report:structuredClone(__copyFixture.report)});
      if(message?.type==='performance-start'){__copyFixture.starts++;__copyFixture.report={...structuredClone(fixture),id:'next-'+__copyFixture.starts};return Promise.resolve({ok:true,report:structuredClone(__copyFixture.report)});}
      return send(message,...rest);
    };
    const write=navigator.clipboard?.writeText.bind(navigator.clipboard),legacy=document.execCommand.bind(document);
    if(navigator.clipboard)Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async text=>{
      __copyFixture.writes.push(text);
      if(__copyFixture.mode==='success')return;
      if(__copyFixture.mode==='deny'||__copyFixture.mode==='legacy')throw new DOMException('Fixture clipboard rejection','NotAllowedError');
      return write(text);
    }});
    document.execCommand=(command,...args)=>{
      if(command!=='copy')return legacy(command,...args);
      __copyFixture.legacyCalls++;
      if(__copyFixture.mode==='deny')return false;
      if(__copyFixture.mode==='legacy'){__copyFixture.legacyText=document.activeElement?.value;return true;}
      return legacy(command,...args);
    };
  },fixture);
  const page=await context.newPage();await page.goto(origin+'/options.html');await settingsSection(page,'performance');
  await page.locator('#performance-result').filter({hasText:'660.7 ms'}).waitFor({state:'attached'});
  const details=page.locator('#performance-result').locator('..');await details.locator('summary').click();
  const before=await page.locator('#performance-result').textContent();
  const capture=async(target,name)=>{const path=resolve(directory,name+'.png');await target.locator('.performance-panel').screenshot({path});report.screenshots.push(path);};
  await capture(page,'before-copy');
  await page.evaluate(()=>__copyFixture.mode='deny');await page.locator('#performance-copy').click();
  if(baseline){
    await page.waitForFunction(()=>document.querySelector('#performance-progress').textContent.includes('剪贴板不可用'));
    assert.notEqual(await page.locator('#performance-result').textContent(),before);assert.equal(await page.locator('#performance-result pre').count(),1);
    report.checks.originalSummaryReplacedOnClipboardFailure='REPRODUCED';await capture(page,'original-failure');
  }else{
    await check('denied-clipboard-keeps-summary-and-selects-separate-json',async()=>{
      await page.locator('#performance-copy-fallback').waitFor({state:'visible'});
      assert.equal(await page.locator('#performance-result').textContent(),before);
      const text=await page.locator('#performance-copy-text').inputValue();assert.deepEqual(JSON.parse(text),fixture);
      assert.equal(await page.locator('#performance-copy-text').evaluate(el=>el.selectionStart===0&&el.selectionEnd===el.value.length&&document.activeElement===el),true);
      assert.match(await page.locator('#performance-progress').textContent(),/已完成.*10\/10/);
      assert.equal(await details.evaluate(el=>el.open),true);
      await capture(page,'manual-copy-preserves-summary');
    });
    await check('legacy-copy-fallback-succeeds-without-replacing-results',async()=>{
      await page.evaluate(()=>__copyFixture.mode='legacy');await page.locator('#performance-copy').click();
      await page.waitForFunction(()=>document.querySelector('#performance-copy-status').textContent==='已复制当前测试结果');
      assert.deepEqual(JSON.parse(await page.evaluate(()=>__copyFixture.legacyText)),fixture);
      assert.equal(await page.locator('#performance-result').textContent(),before);assert.equal(await page.locator('#performance-copy-fallback').isVisible(),false);
      assert.equal(await page.locator('#performance-copy').evaluate(el=>document.activeElement===el),true);
    });
    await check('clipboard-api-success-preserves-summary',async()=>{
      await page.evaluate(()=>__copyFixture.mode='success');await page.locator('#performance-copy').click();
      await page.waitForFunction(()=>document.querySelector('#performance-copy-status').textContent==='已复制当前测试结果');
      assert.deepEqual(JSON.parse(await page.evaluate(()=>__copyFixture.writes.at(-1))),fixture);
      assert.equal(await page.locator('#performance-result').textContent(),before);
    });
    await check('new-test-clears-stale-manual-copy',async()=>{
      await page.evaluate(()=>__copyFixture.mode='deny');await page.locator('#performance-copy').click();await page.locator('#performance-copy-fallback').waitFor({state:'visible'});
      await page.evaluate(()=>{
        document.querySelector('#backend').value='local';
        const models=document.querySelector('#local-model');models.add(new Option('Fixture model','copy-fixture-model'));models.value='copy-fixture-model';
      });await page.locator('#performance-start').click();
      await page.waitForFunction(()=>__copyFixture.starts===1);
      assert.equal(await page.locator('#performance-copy-fallback').isVisible(),false);assert.equal(await page.locator('#performance-copy-text').inputValue(),'');
      assert.equal(await page.locator('#performance-copy-status').textContent(),'');
    });
  }
  // Open the production host dialog through a real, authorized popup request.
  const host=await context.newPage();await host.goto(hostUrl);
  const popup=await context.newPage();await popup.goto(origin+'/popup.html');await popup.locator('#settings').waitFor();await host.bringToFront();
  const opened=await popup.evaluate(()=>chrome.runtime.sendMessage({type:'open-settings'}));assert.equal(opened.mode,'embedded');
  let frame;for(let i=0;i<100;i++){frame=host.frames().find(f=>f.url().startsWith(origin+'/options.html?embedded='));if(frame)break;await new Promise(done=>setTimeout(done,30));}assert.ok(frame,'embedded settings frame');
  await settingsSection(frame,'performance');await frame.locator('#performance-result').filter({hasText:'660.7 ms'}).waitFor({state:'attached'});
  const frameElement=await frame.frameElement();report.frameAllow=await frameElement.getAttribute('allow');
  report.clipboardPolicyAllowed=await frame.evaluate(()=>document.featurePolicy?.allowsFeature('clipboard-write'));
  if(baseline){assert.equal(report.clipboardPolicyAllowed,false);report.checks.embeddedClipboardPolicyDenied='REPRODUCED';}
  else await check('real-embedded-copy-policy-and-write',async()=>{
    assert.equal(report.clipboardPolicyAllowed,true);assert.equal(report.frameAllow,'clipboard-write');
    await frame.locator('#performance-result').locator('..').locator('summary').click();
    const summary=await frame.locator('#performance-result').textContent();
    await frame.locator('#performance-copy').click();
    await frame.waitForFunction(()=>document.querySelector('#performance-copy-status').textContent==='已复制当前测试结果');
    assert.equal(await frame.evaluate(()=>__copyFixture.legacyCalls),0,'native Clipboard API succeeded');
    assert.equal(await frame.locator('#performance-result').textContent(),summary);
    // Read the copied text using a paste gesture, without adding clipboard-read permissions.
    await frame.evaluate(()=>{const input=document.createElement('textarea');input.id='paste-probe';document.body.append(input);input.focus();});
    await host.keyboard.press('Control+V');
    await frame.waitForFunction(()=>document.querySelector('#paste-probe').value.startsWith('{'));
    assert.deepEqual(JSON.parse(await frame.locator('#paste-probe').inputValue()),fixture);
    await frame.locator('#paste-probe').evaluate(el=>el.remove());
    await capture(frame,'embedded-copy-success');
    await host.setViewportSize({width:560,height:900});await frame.evaluate(()=>__copyFixture.mode='deny');await frame.locator('#performance-copy').click();await frame.locator('#performance-copy-fallback').waitFor({state:'visible'});
    assert.equal(await frame.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);await capture(frame,'embedded-manual-copy-560');
  });
  report.status='PASS';
}catch(error){report.status='FAIL';report.errors.push(error.stack??String(error));process.exitCode=1;}
finally{await context?.close();await writeFile(resolve(directory,'report.json'),JSON.stringify(report,null,2));console.log('REPORT',resolve(directory,'report.json'));}
