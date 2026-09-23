import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Production extension + synthetic native YouTube DOM + loopback provider only.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/core/config.ts';
import { decodeTranslationFixtureRequest, encodeTranslationFixtureResponse } from './translation-protocol-fixture.mjs';
import { ROOM, watchHtml, chatHtml, chatAdd } from '../test/fixtures/youtube-native-chat.mjs';

const build = resolve(process.argv[2] || '.output/chrome-mv3');
const root = resolve('.artifacts/live/youtube-repairs'); await mkdir(root, { recursive: true });
const dir = await mkdtemp(resolve(root, 'fixture-'));
const report = { evidence: 'PRODUCTION_EXTENSION_SYNTHETIC_YOUTUBE_LOOPBACK_PROVIDER', checks: {}, requests: [], errors: [], screenshots: [],
  limitations: ['Synthetic paid renderers, ticker and expanded DOM; real YouTube Polymer and actual paid chat remain unverified.', 'Loopback fixture responses do not measure real model quality or latency.'] };
const held = new Map(); let context, server, page;
const pause = ms => new Promise(done => setTimeout(done, ms));
async function until(fn, label, timeout = 20000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await fn(); if (value) return value; await pause(40); } throw new Error('Timeout: ' + label); }
async function check(name, fn) { try { await fn(); report.checks[name] = 'PASS'; console.log('PASS', name); } catch (error) { report.checks[name] = 'FAIL: ' + error.message; throw error; } }
const release = key => { for (const done of held.get(key) || []) done(); held.delete(key); };
const count = text => report.requests.filter(row => row.texts.some(value => value.includes(text))).length;
const frame = () => page.frames().find(value => new URL(value.url() || 'about:blank').pathname === '/live_chat');
const preexistingText='接入前に届いた応援メッセージです';
const historicalChatHtml=chatHtml.replace('</script>',`{
  const row=document.createElement('yt-live-chat-paid-message-renderer');row.dataset.case='preexisting-paid';
  row.data={id:'preexisting-paid',message:{simpleText:${JSON.stringify(preexistingText)}},purchaseAmountText:{simpleText:'$5'}};
  const body=document.createElement('span');body.id='message';body.textContent=row.data.message.simpleText;row.append(body);
  document.querySelector('yt-live-chat-item-list-renderer').append(row);
}</script>`);
const body = selector => frame().locator(selector + ' #message').textContent();
const translated = selector => until(async () => (await body(selector))?.startsWith('【模拟译文】'), selector + ' translated');
async function addDom(id, text, kind = 'paid', instance = id) {
  await frame().evaluate(({ id, text, kind, instance }) => {
    const tag = kind === 'ordinary' ? 'yt-live-chat-text-message-renderer' : kind === 'ticker' ? 'yt-live-chat-ticker-paid-message-item-renderer' : 'yt-live-chat-paid-message-renderer';
    const row = document.createElement(tag); row.dataset.case = instance;
    row.style.cssText = 'display:block;background:' + (kind === 'ordinary' ? '#20252b' : '#145e7a') + ';padding:8px;margin:4px;color:#fff';
    const data = { id, message: { simpleText: text }, authorName: { simpleText: 'Synthetic donor' }, purchaseAmountText: { simpleText: '$10.00' }, bodyBackgroundColor: 4279512698,
      authorBadges: [{ liveChatAuthorBadgeRenderer: { tooltip: 'Synthetic member' } }] };
    row.data = kind === 'ticker' ? { id: 'ticker-' + id, showItemEndpoint: { showLiveChatItemEndpoint: { renderer: { liveChatPaidMessageRenderer: data } } } } : data;
    const author = document.createElement('span'); author.className = 'author'; author.textContent = 'Synthetic donor · $10.00 ◆ ';
    author.addEventListener('click', () => row.dataset.authorClicked = 'yes');
    const message = document.createElement('span'); message.id = 'message'; message.textContent = text;
    row.append(author, message); document.querySelector('yt-live-chat-item-list-renderer').append(row);
    row.scrollIntoView({ block: 'nearest' });
  }, { id, text, kind, instance });
}

try {
  server = createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', 'authorization,content-type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end('{}'); return; }
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body), decoded = decodeTranslationFixtureRequest(payload);
      const texts = decoded.items.map(item => item.text); assert.ok(report.requests.length < 60, 'bounded fixture request budget');
      report.requests.push({ texts, reasoning: payload.reasoning_effort, thinking: payload.thinking, at: Date.now() });
      const key = texts.find(text => /HELD_(SC|STALE|TIMEOUT|PIN|BULK)/.test(text));
      if (key) await new Promise(done => { const kind = key.match(/HELD_\w+/)[0]; held.set(kind, [...(held.get(kind) || []), done]); });
      const reply = encodeTranslationFixtureResponse(decoded, decoded.items.map(item => ({ id: item.id,
        text: item.text.includes('IDENTITY') && count('IDENTITY') === 1 ? item.text : '【模拟译文】' + item.text })));
      res.setHeader('content-type', reply.contentType); res.end(reply.body);
    } catch (error) { report.errors.push(error.message); if (!res.headersSent) res.writeHead(500); res.end('{}'); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const extension = resolve(dir, 'extension'); await cp(build, extension, { recursive: true });
  const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), 'http://127.0.0.1/*'])];
  await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
  const { chromium } = await loadPlaywright();
  context = await chromium.launchPersistentContext(await mkdtemp(resolve(dir, 'profile-')), {
    ...browserLaunchOptions("chromium"), headless: true, viewport: { width: 1360, height: 850 },
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
  });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://www.youtube.com' && ['/watch', '/live_chat'].includes(url.pathname)) return route.fulfill({ status: 200, contentType: 'text/html', body: url.pathname === '/watch' ? watchHtml : historicalChatHtml });
    if (url.origin === new URL(endpoint).origin || !['http:', 'https:'].includes(url.protocol)) return route.continue();
    return route.abort();
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const options = await context.newPage(); await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  const config = normalizeSettings({ ...DEFAULT_SETTINGS, enabled: true, endpoint, allowLocalHttp: true, model: 'fixture-deepseek', profile: 'deepseek', thinkingEffort: 'off',
    concurrency: 4, batchSize: 1, liveBufferMs: 2000, liveMaxBatchWaitMs: 0, liveSourceLanguage: 'auto', liveAdaptiveConcurrency: false,
    superChatThinkingEffort: 'high', superChatTimeoutMs: 15000 });
  assert.equal((await options.evaluate(settings => chrome.runtime.sendMessage({ type: 'save', settings, apiKey: 'synthetic-fixture-only', remember: false }), config)).ok, true);
  page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  await page.goto('https://www.youtube.com/watch?v=' + ROOM); await page.bringToFront();
  await until(async () => frame() && await frame().locator('[data-danlingo-repairs]').count() === 1, 'native repair controls');

  await check('paid-row-existing-before-adapter-translates-and-force-retains-original',async()=>{
    await translated('[data-case="preexisting-paid"]');assert.equal(count(preexistingText),1);
    await frame().locator('[data-case="preexisting-paid"] [data-danlingo-retry]').click();
    await until(()=>count(preexistingText)===2,'preexisting paid forced inference');
    await until(async()=>await frame().locator('[data-case="preexisting-paid"]').getAttribute('data-danlingo-state')==='translated','preexisting force complete');
    assert.equal(await frame().locator('[data-case="preexisting-paid"]').evaluate(el=>el.data.message.simpleText),preexistingText);
    await frame().locator('[data-case="preexisting-paid"]').evaluate(el=>el.remove());
  });

  await check('superchat-three-appearances-one-transport-and-normal-not-blocked', async () => {
    for (const [kind, instance] of [['paid', 'sc-list'], ['ticker', 'sc-ticker'], ['paid', 'sc-expanded']]) await addDom('sc-shared', 'HELD_SC 応援しています', kind, instance);
    await until(() => count('HELD_SC') === 1, 'held SC transport');
    await frame().evaluate(action => window.__YT_NATIVE_CHAT__.add(action), chatAdd('ordinary-independent', '普通のコメントは待たされません'));
    await translated('[data-fixture-id="ordinary-independent"]');
    assert.equal(count('HELD_SC'), 1);
    assert.equal(await body('[data-case="sc-list"]'), 'HELD_SC 応援しています');
    release('HELD_SC');
    for (const instance of ['sc-list', 'sc-ticker', 'sc-expanded']) await translated(`[data-case="${instance}"]`);
    assert.equal(count('HELD_SC'), 1);
    const sc = report.requests.find(row => row.texts.some(text => text.includes('HELD_SC'))), normal = report.requests.find(row => row.texts.some(text => text.includes('普通のコメント')));
    assert.equal(sc.reasoning, 'high'); assert.deepEqual(sc.thinking, { type: 'enabled' }); assert.deepEqual(normal.thinking, { type: 'disabled' });
    await frame().locator('[data-case="sc-list"] .author').click();
    assert.equal(await frame().locator('[data-case="sc-list"]').getAttribute('data-author-clicked'), 'yes');
    assert.equal(await frame().locator('[data-case="sc-list"] .author').textContent(), 'Synthetic donor · $10.00 ◆ ');
  });
  await check('rerender-and-new-display-reuse-result-without-transport', async () => {
    await frame().evaluate(() => { document.querySelector('[data-case="sc-list"] #message').textContent = 'HELD_SC 応援しています'; });
    await translated('[data-case="sc-list"]');
    await addDom('sc-shared', 'HELD_SC 応援しています', 'paid', 'sc-recreated'); await translated('[data-case="sc-recreated"]');
    assert.equal(count('HELD_SC'), 1);
  });
  await check('unchanged-repair-controls-do-not-rewrite-dom-on-periodic-scans', async () => {
    await frame().locator('[data-case="sc-list"][data-danlingo-state="translated"] [data-danlingo-retry]').waitFor();
    const mutations = await frame().evaluate(() => new Promise(resolve => {
      const row = document.querySelector('[data-case="sc-list"]');
      let count = 0;
      const observer = new MutationObserver(records => { count += records.length; });
      observer.observe(row, { subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['data-danlingo-state', 'disabled', 'hidden', 'title'] });
      // Covers four real adapter polling ticks; no synthetic call to render().
      setTimeout(() => { count += observer.takeRecords().length; observer.disconnect(); resolve(count); }, 1100);
    }));
    assert.equal(mutations, 0);
  });
  await check('native-timeout-retry-has-new-budget-and-merges-clicks', async () => {
    await frame().evaluate(action => window.__YT_NATIVE_CHAT__.add(action), chatAdd('timeout', 'HELD_TIMEOUT 補翻を試します'));
    await until(async () => await frame().locator('[data-fixture-id="timeout"]').getAttribute('data-danlingo-state') === 'expired', 'ordinary original timeout');
    release('HELD_TIMEOUT');
    const before = count('HELD_TIMEOUT');
    await frame().locator('[data-fixture-id="timeout"] [data-danlingo-retry]').click();
    await frame().evaluate(() => { const button = document.querySelector('[data-fixture-id="timeout"] [data-danlingo-retry]'); button.click(); button.click(); });
    await until(() => count('HELD_TIMEOUT') > before, 'fresh manual transport'); release('HELD_TIMEOUT');
    await translated('[data-fixture-id="timeout"]'); assert.equal(count('HELD_TIMEOUT') - before, 1);
  });
  await check('loaded-rescan-captures-missed-and-skips-unneeded', async () => {
    await addDom('missed', '自動取得されなかった本文', 'ordinary');
    await addDom('unneeded', '你好', 'ordinary');
    await frame().getByRole('button', { name: '补翻全部漏译', exact: true }).click();
    await translated('[data-case="missed"]');
    assert.equal(count('自動取得されなかった本文'), 1); assert.equal(count('你好'), 0);
    await frame().locator('[data-case="unneeded"] [data-danlingo-retry]').click();
    await translated('[data-case="unneeded"]'); assert.equal(count('你好'), 1);
  });
  await check('force-retranslation-in-recent-records-is-explicit', async () => {
    await frame().locator('[data-danlingo-repairs] summary').click();
    const item = frame().locator('[data-danlingo-repairs] details > div > div').filter({ hasText: '自動取得されなかった本文' });
    await item.getByRole('button', { name: '强制重译', exact: true }).click();
    await until(() => count('自動取得されなかった本文') === 2, 'forced transport');
    await until(async () => await item.getByRole('button', { name: '强制重译', exact: true }).isEnabled(), 'force result');
    await frame().locator('[data-danlingo-repairs] summary').click();
  });
  await check('recycled-dom-and-detached-recent-message-never-cross-write', async () => {
    await addDom('old', 'HELD_STALE 古い本文', 'ordinary');
    await frame().locator('[data-case="old"] [data-danlingo-retry]').click();
    await until(() => count('HELD_STALE') === 1, 'held old manual transport');
    await frame().evaluate(() => { const row = document.querySelector('[data-case="old"]'); row.data = { id: 'replacement', message: { simpleText: '別のメッセージ' } }; row.querySelector('#message').textContent = '別のメッセージ'; });
    release('HELD_STALE');
    await until(async () => { await frame().locator('[data-danlingo-repairs] details').evaluate(node => { node.open = true; }); return (await frame().locator('[data-danlingo-repairs] details').textContent()).includes('【模拟译文】HELD_STALE'); }, 'detached original retained result');
    assert.equal(await body('[data-case="old"]'), '別のメッセージ');
  });
  await check('sticker-without-body-does-not-create-request', async () => {
    const before = report.requests.length;
    await frame().evaluate(() => { const row = document.createElement('yt-live-chat-paid-sticker-renderer'); row.data = { id: 'sticker', purchaseAmountText: { simpleText: '$20' }, sticker: { accessibility: { accessibilityData: { label: 'Sticker' } } } }; document.querySelector('yt-live-chat-item-list-renderer').append(row); });
    await page.waitForTimeout(600); assert.equal(report.requests.length, before);
  });
  await frame().locator('[data-danlingo-repairs] details').evaluate(node => { node.open = false; });
  await check('pinned-auto-normal-settings-independent-15-second-budget', async () => {
    await addDom('pin-auto', 'HELD_PIN 最初の置頂コメント', 'ordinary');
    await frame().evaluate(() => { const row=document.querySelector('[data-case="pin-auto"]'), banner=document.createElement('yt-live-chat-banner-renderer');banner.append(row);document.querySelector('yt-live-chat-item-list-renderer').after(banner); });
    await until(()=>count('HELD_PIN')===1,'automatic pinned request');
    await frame().evaluate(action=>window.__YT_NATIVE_CHAT__.add(action),chatAdd('while-pin','置頂を待たずに流れる普通コメント'));
    await translated('[data-fixture-id="while-pin"]');
    await frame().evaluate(action=>window.__YT_NATIVE_CHAT__.add(action),chatAdd('pin-budget-timer','HELD_TIMEOUT 時間境界確認'));
    await until(async()=>await frame().locator('[data-fixture-id="pin-budget-timer"]').getAttribute('data-danlingo-state')==='expired','ordinary 2-second expiry');
    assert.equal(await frame().locator('[data-case="pin-auto"]').getAttribute('data-danlingo-state'),'translating');
    release('HELD_TIMEOUT');release('HELD_PIN');await translated('[data-case="pin-auto"]');
    const pinnedRequest=report.requests.find(row=>row.texts.some(text=>text.includes('HELD_PIN')));
    assert.deepEqual(pinnedRequest.thinking,{type:'disabled'});
    await addDom('pin-auto','HELD_PIN 最初の置頂コメント','ordinary','pin-copy');await translated('[data-case="pin-copy"]');assert.equal(count('HELD_PIN'),1);
  });
  await check('identical-success-is-recoverable-with-fresh-provider-request', async()=>{
    await frame().evaluate(action=>window.__YT_NATIVE_CHAT__.add(action),chatAdd('identity','IDENTITY 翻訳されていません'));
    await until(async()=>await frame().locator('[data-fixture-id="identity"]').getAttribute('data-danlingo-state')==='suspected','suspected identity result');
    assert.equal(await body('[data-fixture-id="identity"]'),'IDENTITY 翻訳されていません');
    await frame().locator('[data-fixture-id="identity"] [data-danlingo-retry]').click();await translated('[data-fixture-id="identity"]');assert.equal(count('IDENTITY'),2);
  });
  await check('latest-batch-bounded-cancel-and-force-use-originals',async()=>{
    for(let i=1;i<=3;i++)await addDom('bulk-'+i,'HELD_BULK 原文'+i,'ordinary');
    await frame().evaluate(()=>{for(let i=1;i<=3;i++)document.querySelector('[data-case="bulk-'+i+'"]').data.timestampUsec=String((Date.now()+3600000+i)*1000);});
    await frame().getByRole('spinbutton',{name:'重翻条数'}).fill('3');
    await frame().getByRole('button',{name:'重翻最新',exact:true}).click();
    await until(()=>count('HELD_BULK')===2,'two bulk transports');
    assert.equal(count('HELD_BULK 原文1'),0);
    await frame().getByRole('button',{name:'停止',exact:true}).click();release('HELD_BULK');
    await until(async()=>(await frame().locator('[data-danlingo-repair-status]').textContent()).includes('已停止 3/3'),'batch cancelled');
    for(let i=1;i<=3;i++)assert.equal(await body('[data-case="bulk-'+i+'"]'),'HELD_BULK 原文'+i);
    assert.equal(count('HELD_BULK'),2);
    // New force requests cannot reuse the cancelled outputs or the displayed translation as source.
    await frame().getByRole('spinbutton',{name:'重翻条数'}).fill('1');
    await frame().getByRole('button',{name:'重翻最新',exact:true}).click();
    await until(()=>count('HELD_BULK')===3,'fresh force after cancel');release('HELD_BULK');await translated('[data-case="bulk-3"]');
    await until(async()=>(await frame().locator('[data-danlingo-repair-status]').textContent()).includes('已结束 1/1'),'batch finished');
    await frame().getByRole('button',{name:'重翻最新',exact:true}).click();await until(()=>count('HELD_BULK')===4,'force bypasses completed cache');
    const last=report.requests.at(-1);assert.deepEqual(last.texts,['HELD_BULK 原文3']);release('HELD_BULK');
    await until(async()=>(await frame().locator('[data-danlingo-repair-status]').textContent()).includes('已结束 1/1'),'second force finished');
  });
  await check('superchat-explicit-force-retains-superchat-strategy',async()=>{
    await frame().locator('[data-case="sc-list"] [data-danlingo-retry]').click();
    await until(()=>count('HELD_SC')===2,'SC forced request');
    const forced=report.requests.at(-1);assert.equal(forced.reasoning,'high');assert.deepEqual(forced.thinking,{type:'enabled'});
    assert.deepEqual(forced.texts,['HELD_SC 応援しています']);release('HELD_SC');
    await until(async()=>await frame().locator('[data-case="sc-list"]').getAttribute('data-danlingo-state')==='translated','SC force complete');
  });
  const screenshot = resolve(dir, 'superchat-manual.png'); await page.screenshot({ path: screenshot }); report.screenshots.push(screenshot);
  assert.deepEqual(report.errors, []); report.status = 'PASS';
} catch (error) { report.status = 'FAIL'; report.error = error.stack; process.exitCode = 1; console.error(error); }
finally {
  for (const key of held.keys()) release(key);
  await context?.close(); if (server) await new Promise(done => server.close(done));
  await writeFile(resolve(dir, 'report.json'), JSON.stringify(report, null, 2)); console.log(resolve(dir, 'report.json'));
}
