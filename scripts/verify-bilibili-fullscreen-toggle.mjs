// Real extension bridge and settings storage, on an offline Bilibili DOM fixture.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadPlaywright, browserLaunchOptions } from './browser-runtime.mjs';
import { FIRST_URL, videoHtml } from '../test/fixtures/bilibili-video-native.mjs';
const extension = resolve(process.env.DANLINGO_TEST_EXTENSION || 'D:/Tool/DanLingo-Workspace/testing/current/extension');
const root = resolve('.artifacts/fullscreen-toggle'); await mkdir(root,{recursive:true});
const dir = await mkdtemp(resolve(root,'run-'));
const report = { evidence:'BUILT_EXTENSION_OFFLINE_BILIBILI_FULLSCREEN_FIXTURE', checks:[], screenshots:[], errors:[], blockedHttp:[] };
// Reconstructed native controls from the supplied reference, not live-site evidence.
const nativeTv = '<path d="m8 3 3 4m7-4-3 4M22.5 16v-4A4.5 4.5 0 0 0 18 7.5H7A4.5 4.5 0 0 0 2.5 12v8A4.5 4.5 0 0 0 7 24.5h7" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/><text x="12.5" y="20" fill="currentColor" text-anchor="middle" font-family="Arial,Microsoft YaHei,sans-serif" font-size="12" font-weight="600">弹</text>';
const nativeCheck = '<path d="m17 22 3.2 3.2 6.3-7" fill="none" stroke="#00aeec" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>';
const nativeSettings = '<path d="m19.5 18 5 0 2.5 4.5-2.5 4.5h-5L17 22.5Z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="22" cy="22.5" r="1.7" fill="currentColor"/>';
const nativeSvg = mark => `<svg viewBox="0 0 28 28" width="30" height="30">${nativeTv}${mark}</svg>`;
const html = videoHtml.replace('</style>', `
  body{background:#fff;color:#252a32}#playerWrap{background:#23262b;border-color:#ddd;border-radius:0}#playerWrap video{background:#32363d;border-radius:0}
  #playerWrap:fullscreen{padding:0;width:100%;height:100%;border:0}#playerWrap:fullscreen video{height:100%}
  .bpx-player-dm-root{display:flex;align-items:center;gap:0;background:#fff;color:#61666d;min-height:48px;padding:6px 16px}
  .bpx-player-dm-root:before{content:'9人正在看';flex:none;font-size:14px;margin-right:24px}
  #playerWrap:fullscreen .bpx-player-dm-root{position:absolute;bottom:0;left:0;right:0;background:#505154;color:#fff}
  #playerWrap:fullscreen .bpx-player-dm-root:before{display:none}
  .bpx-player-dm-switch,.bpx-player-dm-setting{position:relative;box-sizing:border-box;display:flex;flex:none;width:30px;height:30px;line-height:30px;margin:0 12px 0 0;padding:0;border:0;background:none;color:#61666d;fill:#61666d;align-items:center;justify-content:center}
  #playerWrap:fullscreen .bpx-player-dm-switch,#playerWrap:fullscreen .bpx-player-dm-setting{color:rgba(255,255,255,.9);fill:rgba(255,255,255,.9)}
  #playerWrap:fullscreen .bpx-player-dm-setting{height:50px}
  .bpx-player-dm-switch svg,.bpx-player-dm-setting svg{display:block;width:30px;height:30px}
  .bpx-player-dm-switch input{position:absolute;inset:0;margin:0;opacity:0;width:100%;height:100%}
  .bpx-player-dm-root:after{content:'发个友善的弹幕见证当下';font-size:14px;color:#9499a0;background:#f1f2f3;border-radius:4px;padding:8px 20px;flex:1;min-width:0}
  #playerWrap:fullscreen .bpx-player-dm-root:after{color:#ddd;background:#ffffff18;flex:none;width:280px}
  @media(max-width:1000px){.bpx-player-dm-switch,.bpx-player-dm-setting{width:28px;height:28px;margin-right:16px}.bpx-player-dm-switch svg,.bpx-player-dm-setting svg{width:28px;height:28px}}
  </style>`).replace('<div class="bui-area">', `<div class="bui-area">${nativeSvg(nativeCheck)}`).replace('</div></div></div>\n      <div id="danmaku-stage">', `</div></div><button class="bpx-player-dm-setting" aria-label="弹幕设置">${nativeSvg(nativeSettings)}</button></div>\n      <div id="danmaku-stage">`);
const {chromium}=await loadPlaywright();
const context=await chromium.launchPersistentContext(resolve(dir,'profile'),{
  ...browserLaunchOptions(),headless:true,viewport:{width:1200,height:760},deviceScaleFactor:2,
  args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--disable-background-networking'],
});
try {
  await context.route(/^https?:/,r=>{
    if(r.request().url()===FIRST_URL)return r.fulfill({contentType:'text/html',body:html});
    report.blockedHttp.push(r.request().url());return r.abort();
  });
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const origin='chrome-extension://'+new URL(worker.url()).host;
  const options=await context.newPage();await options.goto(origin+'/options.html');
  const registered=await worker.evaluate(()=>chrome.commands.getAll());
  report.browserAssignedShortcut=registered.find(command=>command.name==='toggle-translation')?.shortcut??'';
  assert.deepEqual(await options.evaluate(()=>chrome.runtime.sendMessage({type:'translation-shortcut'})),{ok:true,shortcut:report.browserAssignedShortcut});
  let fixtureShortcut='Alt+T';
  const setShortcutFixture=async shortcut=>{
    fixtureShortcut=shortcut;
    await worker.evaluate(shortcut=>{
      globalThis.__nativeCommandsGetAll??=chrome.commands.getAll.bind(chrome.commands);
      globalThis.__fixtureTranslationShortcut=shortcut;
      chrome.commands.getAll=async()=>(await globalThis.__nativeCommandsGetAll()).map(command=>command.name==='toggle-translation'?{...command,shortcut:globalThis.__fixtureTranslationShortcut}:command);
    },shortcut);
  };
  await setShortcutFixture(fixtureShortcut);
  const hint=action=>fixtureShortcut?`${action}（${fixtureShortcut}）`:action;
  report.shortcutEvidence='Native commands API verified first; remapping states and screenshots use a controlled commands.getAll fixture.';
  const save=patch=>options.evaluate(async patch=>{
    const current=await chrome.runtime.sendMessage({type:'settings'});
    return chrome.runtime.sendMessage({type:'save',settings:{...current.settings,...patch}});
  },patch);
  assert.equal((await save({backend:'local',enabled:false,localPreloadOnEntry:false,localModelId:'unregistered-fullscreen-fixture'})).ok,true);
  await worker.evaluate(()=>chrome.storage.local.set({'ui.locale.v1':'zh-CN'}));
  const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
  await page.goto(FIRST_URL);
  await page.locator('#danlingo-disabled-notice').waitFor({state:'visible'});
  const toggle=page.locator('#danlingo-fullscreen-toggle');
  await toggle.waitFor({state:'visible'});
  assert.equal(await toggle.getAttribute('aria-pressed'),'false');
  assert.equal(await toggle.evaluate(el=>el.nextElementSibling?.classList.contains('bpx-player-dm-switch')),true);
  const originalNative=await page.locator('.bui-danmaku-switch-input').isChecked();
  const shot=async name=>{const path=resolve(dir,name+'.png');await page.locator('.bpx-player-dm-root').screenshot({path});report.screenshots.push(path);};
  const tooltip=page.locator('#danlingo-translation-tooltip');
  const tooltipShot=async name=>{
    await page.mouse.move(1,1);
    await toggle.hover();await tooltip.waitFor({state:'visible'});
    const expected=hint(await toggle.getAttribute('aria-pressed')==='true'?'关闭翻译':'开启翻译');
    await page.waitForFunction(expected=>document.querySelector('#danlingo-translation-tooltip')?.textContent===expected,expected);
    const row=await page.locator('.bpx-player-dm-root').boundingBox();
    const path=resolve(dir,name+'.png');
    await page.screenshot({path,clip:{x:row.x,y:row.y-44,width:Math.min(row.width,600),height:row.height+44}});
    report.screenshots.push(path);
  };
  const geometry = () => page.evaluate(() => {
    const selectors=['#danlingo-fullscreen-toggle','.bpx-player-dm-switch','.bpx-player-dm-setting'];
    return selectors.map(selector=>{const el=document.querySelector(selector),r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});
  });
  const checkGeometry = async () => {
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('#danlingo-fullscreen-toggle')).color===getComputedStyle(document.querySelector('.bpx-player-dm-switch')).fill);
    const [translation,native,settings]=await geometry();
    assert.equal(translation.width,native.width);
    assert.equal(translation.height,native.height);
    assert.equal(translation.y,native.y);
    assert.equal(native.x-translation.x-translation.width,settings.x-native.x-native.width);
    const colors=await page.evaluate(()=>[getComputedStyle(document.querySelector('#danlingo-fullscreen-toggle')).color,getComputedStyle(document.querySelector('.bpx-player-dm-switch')).fill]);
    assert.equal(colors[0],colors[1]);
    return {translation,native,settings};
  };
  report.normalGeometry=await checkGeometry();
  assert.equal(await toggle.getAttribute('title'),null);
  await tooltipShot('normal-tooltip-off');
  assert.equal(await tooltip.textContent(),hint('开启翻译'));
  assert.equal(await tooltip.evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(0, 0, 0)');
  assert.equal(await tooltip.evaluate((el)=>el.getBoundingClientRect().bottom<document.querySelector('#danlingo-fullscreen-toggle').getBoundingClientRect().top),true);
  await toggle.click();
  await page.waitForFunction(()=>document.querySelector('#danlingo-fullscreen-toggle')?.getAttribute('aria-pressed')==='true');
  assert.equal((await options.evaluate(()=>chrome.runtime.sendMessage({type:'settings'}))).settings.enabled,true);
  await tooltipShot('normal-tooltip-on');
  assert.equal(await tooltip.textContent(),hint('关闭翻译'));
  assert.equal(await page.locator('.bui-danmaku-switch-input').isChecked(),originalNative);
  assert.equal(await page.evaluate(()=>document.querySelector('video').paused),true);
  await page.mouse.move(1,1);await toggle.blur();await tooltip.waitFor({state:'hidden'});
  await save({enabled:false});
  await page.waitForFunction(()=>document.querySelector('#danlingo-fullscreen-toggle')?.getAttribute('aria-pressed')==='false');
  report.checks.push('normal player has an equally spaced gray toggle, saves translation and shows the native-style action tooltip');
  await page.locator('#fixture-fullscreen').click();
  report.geometry=await checkGeometry();
  await shot('fullscreen-off');
  await tooltipShot('fullscreen-tooltip-off');
  assert.equal(await tooltip.evaluate(el=>document.fullscreenElement.contains(el)),true);
  await toggle.click();
  await page.waitForFunction(()=>document.querySelector('#danlingo-fullscreen-toggle')?.getAttribute('aria-pressed')==='true');
  assert.equal((await options.evaluate(()=>chrome.runtime.sendMessage({type:'settings'}))).settings.enabled,true);
  assert.equal(await page.locator('.bui-danmaku-switch-input').isChecked(),originalNative);
  assert.equal(await page.evaluate(()=>document.querySelector('video').paused),true,'translation click must not play video');
  await shot('fullscreen-on');
  await tooltipShot('fullscreen-tooltip-on');
  assert.equal(await tooltip.textContent(),hint('关闭翻译'));
  const closeupPath=resolve(dir,'fullscreen-controls-on.png');
  await page.screenshot({path:closeupPath,clip:{x:8,y:report.geometry.translation.y-12,width:160,height:48}});
  report.screenshots.push(closeupPath);
  await page.setViewportSize({width:900,height:760});
  await page.waitForFunction(()=>document.querySelector('#danlingo-fullscreen-toggle')?.getBoundingClientRect().width===document.querySelector('.bpx-player-dm-switch')?.getBoundingClientRect().width);
  report.compactGeometry=await checkGeometry();
  await shot('fullscreen-compact');
  await page.setViewportSize({width:1200,height:760});
  report.checks.push('TV toggle matches native control dimensions, alignment and adjacent spacing at both viewport sizes');
  report.checks.push('fullscreen native-left switch saves translation and leaves native danmaku and playback unchanged');
  await toggle.focus();await page.keyboard.press('Space');
  await page.waitForFunction(()=>document.querySelector('#danlingo-fullscreen-toggle')?.getAttribute('aria-pressed')==='false');
  assert.equal((await options.evaluate(()=>chrome.runtime.sendMessage({type:'settings'}))).settings.enabled,false);
  report.checks.push('keyboard activation turns translation off without toggling playback');
  assert.equal((await save({enabled:true})).ok,true);
  await page.waitForFunction(()=>document.querySelector('#danlingo-fullscreen-toggle')?.getAttribute('aria-pressed')==='true');
  report.checks.push('external settings update synchronizes fullscreen button');
  await setShortcutFixture('Ctrl+Shift+Y');
  await tooltipShot('fullscreen-shortcut-remapped');
  assert.equal(await tooltip.textContent(),hint('关闭翻译'));
  await setShortcutFixture('');
  await tooltipShot('fullscreen-shortcut-unassigned');
  assert.equal(await tooltip.textContent(),'关闭翻译');
  await setShortcutFixture('Alt+T');
  report.checks.push('current browser binding is read and native-style hints refresh remapped and unassigned shortcut fixtures');
  await page.evaluate(()=>{const anchor=document.querySelector('.bpx-player-dm-switch');anchor.replaceWith(anchor.cloneNode(true));});
  await page.waitForFunction(()=>document.querySelector('#danlingo-fullscreen-toggle')?.nextElementSibling?.classList.contains('bpx-player-dm-switch'));
  assert.equal(await toggle.count(),1);
  report.checks.push('native control replacement preserves one correctly anchored toggle');
  await page.evaluate(()=>document.exitFullscreen());
  await tooltip.waitFor({state:'hidden'});
  await toggle.waitFor({state:'visible'});
  await checkGeometry();
  await tooltipShot('normal-shortcut-returned');
  assert.equal(await tooltip.textContent(),hint('关闭翻译'));
  report.checks.push('exit fullscreen keeps one normal-player toggle and removes the stale tooltip');
  assert.equal((await save({enabled:false,backend:'online',endpoint:'',model:''})).ok,true);
  await page.locator('#fixture-fullscreen').click();await toggle.waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('#danlingo-fullscreen-toggle')?.getAttribute('aria-pressed')==='false');
  await toggle.click();
  await page.waitForFunction(()=>{const b=document.querySelector('#danlingo-fullscreen-toggle');return b&&!b.disabled&&b.getAttribute('aria-pressed')==='false'&&b.getAttribute('aria-label').includes('服务地址');});
  await toggle.hover();await tooltip.waitFor({state:'visible'});
  assert.match(await tooltip.textContent(),/服务地址/);
  assert.equal((await options.evaluate(()=>chrome.runtime.sendMessage({type:'settings'}))).settings.enabled,false);
  report.checks.push('missing online setup returns visible error and preserves disabled setting');
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.blockedHttp,[]);
  report.status='PASS';
} catch(e){report.status='FAIL';report.errors.push(e.stack);process.exitCode=1;}
finally{await context.close();await writeFile(resolve(dir,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({dir,...report},null,2));}

