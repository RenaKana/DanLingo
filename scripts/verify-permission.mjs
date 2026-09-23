import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// No Key and no Provider call. Tests the options gesture against the exact release manifest.
import { settingsSection } from './settings-navigation.mjs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.DANLINGO_PLAYWRIGHT_MODULE).href);
const profile=await mkdtemp(resolve('.artifacts/profiles/p1-permission-'));
const extension=resolve('.output/chrome-mv3');
const isEdge=process.env.DANLINGO_E2E_BROWSER==='edge';
const endpoint=process.env.DANLINGO_E2E_ENDPOINT;
const origin=new URL(endpoint).origin;
const context=await chromium.launchPersistentContext(profile,{headless:true,
  ...browserLaunchOptions(isEdge ? "edge" : "chromium"),
  args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
const report={capturedAt:new Date().toISOString(),browser:isEdge?'edge':'chrome',releaseManifestUnmodified:true,origin};
try{
  const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
  const page=await context.newPage();await page.goto(new URL('/options.html',worker.url()).href);
  await page.locator('#endpoint').waitFor();
  report.before=await page.evaluate(origin=>chrome.permissions.contains({origins:[origin+'/*']}),origin);
  await page.locator('#endpoint').fill(endpoint);
  await settingsSection(page,'advanced'); await page.locator('#profile').evaluate(el=>el.closest('details').open=true); await page.locator('#profile').selectOption('deepseek'); await settingsSection(page,'service');
  await page.locator('#model').fill('deepseek-flash');
  await settingsSection(page,'advanced'); await page.locator('#local-http').check(); await settingsSection(page,'watching'); await page.locator('#enabled').uncheck();
  await page.locator('#save').click();
  const end=Date.now()+10000;
  do{
    report.result=await page.locator('#result').textContent();
    if(report.result!=='正在保存…')break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }while(Date.now()<end);
  report.after=await page.evaluate(origin=>chrome.permissions.contains({origins:[origin+'/*']}),origin);
  report.actualGrantVerified=report.before===false&&report.after===true&&report.result==='已保存';
  report.limitation=report.actualGrantVerified?'Headless gesture and permission state verified; visible consent wording not inspected.':'Native permission confirmation not operable in this headless run; manual check required.';
}catch(error){report.error=String(error.message).slice(0,300);}
finally{await context.close();await mkdir('.artifacts/p1/real',{recursive:true});await writeFile(`.artifacts/p1/real/permission-${report.browser}.json`,JSON.stringify(report,null,2));}
console.log(JSON.stringify(report,null,2));
