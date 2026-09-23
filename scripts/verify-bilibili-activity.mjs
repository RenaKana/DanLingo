import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Production extension, captured activity DOM shape, synthetic native room, local-only provider.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/core/config.ts';
import { liveHtml } from '../test/fixtures/bilibili-live-native.mjs';
import { decodeTranslationFixtureRequest, encodeTranslationFixtureResponse } from './translation-protocol-fixture.mjs';

const root = resolve('.artifacts/bilibili/activity'); await mkdir(root, { recursive: true });
const dir = await mkdtemp(resolve(root, 'run-'));
const report = { evidence: 'PRODUCTION_EXTENSION_ROOM_ALIASES_AND_CLIENT_RENDERED_IFRAME_FIXTURE_LOOPBACK_ONLY', checks: [], errors: [] };
// Client-rendered rooms have no roomInitRes. Mirror the public initialized-player API.
function roomHtml(id, ssr = false, ready = true) {
  const roomId = id === '7777' ? '545068' : id;
  const shortId = roomId === '545068' ? '7777' : '0';
  let html = liveHtml.replaceAll('22900497', roomId).replace("short_id:'777'", `short_id:'${shortId}'`);
  if (!ssr) html = html.replaceAll('__NEPTUNE_IS_MY_WAIFU__', '__UNUSED_SSR_FIXTURE__')
    .replace(`ROOMID:'${roomId}'`, `ROOMID:'${roomId}',SHORT_ROOMID:'${shortId}'`)
    .replace('const original=Engine.prototype', `window.EmbedPlayer={instance:{getVideoEl:()=>video,getPlayerInfo:()=>({liveStatus:window.__fixtureLiveStatus??1,timeShift:window.__fixtureTimeShift??0})}};const original=Engine.prototype`);
  return ready ? html : html.replace('window.EmbedPlayer=', 'window.__UNREADY_PLAYER__=');
}
const parentHtml = `<!doctype html><meta charset="utf-8"><title>活动直播夹具</title><style>body{margin:20px;font:15px sans-serif;background:#edf2f4}iframe{width:100%;height:680px;border:0}#player-ctnr{width:100%}button{margin:8px}</style>
<button id="switch">切换主播</button><div class="player"><div id="player-ctnr"><div><iframe src="/blanc/47867?liteVersion=true"></iframe></div></div></div>
<script>document.querySelector('#switch').onclick=()=>document.querySelector('iframe').src='/blanc/7777?liteVersion=true';</script>`;
const calls = []; let hold, context, server;
const check = async (name, fn) => { await fn(); report.checks.push(name); console.log('PASS', name); };
try {
  server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const decoded = decodeTranslationFixtureRequest(JSON.parse(body));
    calls.push(...decoded.items.map(row => row.text));
    if (decoded.items.some(row => row.text.includes('HELD'))) await new Promise(resolve => { hold = resolve; });
    if (res.destroyed) return;
    const reply = encodeTranslationFixtureResponse(decoded, decoded.items.map(row => ({ id: row.id, text: '活动译文 ' + row.text })));
    res.setHeader('content-type', reply.contentType); res.end(reply.body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const extension = resolve(dir, 'extension'); await cp(resolve('.output/chrome-mv3'), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions.push('http://127.0.0.1/*'); await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
  assert.ok(manifest.content_scripts.every(script => !script.all_frames), 'background authority remains top-document only');
  const { chromium } = await loadPlaywright();
  context = await chromium.launchPersistentContext(resolve(dir, 'profile'), { headless: true, ...browserLaunchOptions("chromium"), viewport: { width: 1280, height: 960 }, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--disable-background-networking'] });
  await context.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin === 'https://live.bilibili.com') {
      const room = /^\/(?:blanc\/)?(\d+)\/?$/.exec(u.pathname)?.[1];
      return route.fulfill({ contentType: 'text/html', body: room && room !== '213' ? roomHtml(room, u.searchParams.has('ssr'), !u.searchParams.has('unready')) : parentHtml });
    }
    if (u.origin === new URL(endpoint).origin || !['http:', 'https:'].includes(u.protocol)) return route.continue();
    return route.abort();
  });
  await context.addInitScript(() => {
    if (window.top !== window) return;
    window.__activityMessages = [];
    window.addEventListener('message', event => { if (event.source === window && event.origin === location.origin && event.data?.bridge === 'danlingo-live-v1') window.__activityMessages.push(event.data); });
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const settingsPage = await context.newPage(); await settingsPage.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  const rpc = payload => settingsPage.evaluate(payload => chrome.runtime.sendMessage(payload), payload);
  const settings = normalizeSettings({ ...DEFAULT_SETTINGS, enabled: true, endpoint, allowLocalHttp: true, model: 'activity-fixture', thinkingEffort: 'default', sourceLanguage: 'ja', liveSourceLanguage: 'ja', targetLanguage: 'zh-Hans', batchSize: 1, liveBufferMs: 2000 });
  assert.equal((await rpc({ type: 'save', settings, apiKey: 'fixture-only', remember: false })).ok, true);
  const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  await page.goto('https://live.bilibili.com/213'); await page.bringToFront();
  const currentFrame = () => page.frames().find(frame => /\/blanc\//.test(frame.url()));
  const connected = room => page.waitForFunction(room => window.__activityMessages.some(d => d.type === 'snapshot' && d.resourceId === 'room:' + room && d.presentationActive), room);
  await connected('47867');
  const fire = (id, text) => currentFrame().evaluate(({ id, text }) => window.__BILI_FIXTURE__.fire(id, text), { id, text });
  const body = id => page.frameLocator('iframe').locator(`[data-id_str="${id}"] .danmaku-item-right`);
  await check('embedded-room-translates-and-status-stays-in-parent', async () => {
    await fire('activity-1', '活動ページのテストです');
    await body('activity-1').filter({ hasText: '活动译文' }).waitFor();
    assert.equal(await page.locator('#danlingo-live-status').isVisible(), true);
    assert.equal(await page.frameLocator('iframe').locator('#danlingo-live-status').count(), 0);
    const latest = await page.evaluate(() => window.__activityMessages.filter(d => d.type === 'snapshot').at(-1));
    assert.equal(latest.urlResourceId, '213'); assert.equal(latest.resourceId, 'room:47867');
    await page.screenshot({ path: resolve(dir, 'activity-translated.png') });
  });
  await check('embedded-native-row-repair-and-original-controls', async () => {
    const row = page.frameLocator('iframe').locator('[data-id_str="activity-1"]');
    await row.getByRole('button', { name: '显示原文', exact: true }).click();
    assert.equal(await body('activity-1').textContent(), '活動ページのテストです');
    await row.getByRole('button', { name: '强制重译', exact: true }).click();
    await page.waitForFunction(() => window.__activityMessages.filter(d => d.type === 'repair-result' && d.sourceId === 'dm:activity-1').length > 0);
    assert.match(await body('activity-1').textContent(), /^活动译文/);
    const count = calls.length;
    await row.getByRole('button', { name: '显示原文', exact: true }).click();
    assert.equal(await body('activity-1').textContent(), '活動ページのテストです'); assert.equal(calls.length, count);
    await row.getByRole('button', { name: '显示译文', exact: true }).click();
    assert.match(await body('activity-1').textContent(), /^活动译文/);
  });
  await check('switching-host-on-same-url-retires-old-session-and-late-results', async () => {
    await fire('activity-held', 'HELD 古い部屋のコメント');
    const deadline = Date.now() + 15000;
    while (!hold) { assert.ok(Date.now() < deadline, 'held request reaches provider'); await new Promise(resolve => setTimeout(resolve, 20)); }
    await page.locator('#switch').click(); await connected('545068'); hold(); hold = undefined;
    await fire('activity-2', '新しい部屋のテストです'); await body('activity-2').filter({ hasText: '活动译文' }).waitFor();
    assert.equal(page.url(), 'https://live.bilibili.com/213');
    assert.equal(await page.frameLocator('iframe').locator('[data-id_str="activity-held"]').count(), 0);
    assert.equal(await page.evaluate(() => window.__activityMessages.some(d => d.type === 'session-ended' && d.resourceId === 'room:47867')), true);
    const latest = await page.evaluate(() => window.__activityMessages.filter(d => d.type === 'snapshot').at(-1)); assert.equal(latest.resourceId, 'room:545068');
  });
  await check('same-url-frame-reload-rebinds-and-hidden-frame-stops', async () => {
    const before = await page.evaluate(() => window.__activityMessages.filter(d => d.type === 'snapshot').at(-1).adapterSession);
    await currentFrame().goto(currentFrame().url());
    await page.waitForFunction(old => window.__activityMessages.some(d => d.type === 'snapshot' && d.presentationActive && d.resourceId === 'room:545068' && d.adapterSession !== old), before);
    await page.locator('iframe').evaluate(el => { el.hidden = true; });
    await page.waitForFunction(() => !document.querySelector('#danlingo-live-status'));
    await fire('while-hidden', '非表示のメッセージ');
    assert.equal(calls.includes('非表示のメッセージ'), false);
    const seen = await page.evaluate(() => window.__activityMessages.length);
    await page.locator('iframe').evaluate(el => { el.hidden = false; });
    await page.waitForFunction(count => window.__activityMessages.slice(count).some(d => d.type === 'snapshot' && d.presentationActive), seen);
  });
  await check('ambiguous-second-player-fails-closed', async () => {
    const messagesBefore = await page.evaluate(() => window.__activityMessages.length);
    await page.locator('iframe').evaluate(el => { el.parentElement.append(el.cloneNode()); });
    await page.waitForFunction(count => window.__activityMessages.slice(count).some(d => d.type === 'session-ended'), messagesBefore);
    assert.equal(await page.locator('#danlingo-live-status').count(), 0);
  });
  await check('embedded-room-aliases-do-not-require-liteVersion-or-a-specific-wrapper', async () => {
    await page.locator('iframe').last().evaluate(el => el.remove());
    await page.locator('#player-ctnr').evaluate(el => { el.id = 'activity-player'; });
    for (const path of ['/956712?from=activity', '/blanc/956712', '/blanc/956712/?liteVersion=false']) {
      const seen = await page.evaluate(() => window.__activityMessages.length);
      await page.locator('iframe').evaluate((el, path) => { el.src = path; }, path);
      await page.waitForFunction(count => window.__activityMessages.slice(count).some(d => d.type === 'snapshot' && d.presentationActive && d.resourceId === 'room:956712'), seen);
      const frame = page.frames().find(f => f !== page.mainFrame());
      await frame.evaluate(() => window.__BILI_FIXTURE__.fire('alias', '埋め込みの別形式リンクです'));
      await body('alias').filter({ hasText: '活动译文' }).waitFor();
    }
  });
  await check('top-level-short-and-canonical-aliases-translate-and-popup-recognizes-live', async () => {
    for (const path of ['/blanc/7777', '/7777', '/blanc/545068/?from=share&liteVersion=false', '/956712?ssr=1']) {
      const canonical = path.includes('956712') ? '956712' : '545068';
      await page.goto('https://live.bilibili.com' + path); await page.bringToFront(); await connected(canonical);
      await page.evaluate(() => window.__BILI_FIXTURE__.fire('top-alias', 'トップページの別形式リンクです'));
      await page.locator('[data-id_str="top-alias"] .danmaku-item-right').filter({ hasText: '活动译文' }).waitFor();
      const summary = await rpc({ type: 'overview' });
      assert.equal(summary.status?.resourceId, 'room:' + canonical); assert.equal(summary.status?.connection, 'connected');
      assert.equal(summary.bilibiliLiveCandidate, true);
    }
    const popup = await context.newPage(); await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
    await page.bringToFront(); await popup.locator('#status').filter({ hasText: /^已连接$/ }).waitFor();
    assert.equal(await popup.locator('#scenario').textContent(), '直播');
    await popup.screenshot({ path: resolve(dir, 'popup-connected.png') }); await popup.close();
  });
  await check('client-rendered-replay-stops-intake-and-resumes-only-at-live-edge', async () => {
    await page.goto('https://live.bilibili.com/blanc/956712'); await connected('956712');
    await page.evaluate(() => { window.__fixtureTimeShift = 30; });
    await page.waitForFunction(() => window.__activityMessages.filter(d => d.type === 'snapshot').at(-1)?.connection === 'ended');
    await page.evaluate(() => window.__BILI_FIXTURE__.fire('replay', '追っかけ再生中のコメントです'));
    assert.equal(calls.includes('追っかけ再生中のコメントです'), false);
    const seen = await page.evaluate(() => window.__activityMessages.length);
    await page.evaluate(() => { window.__fixtureTimeShift = 0; });
    await page.waitForFunction(count => window.__activityMessages.slice(count).some(d => d.type === 'snapshot' && d.presentationActive), seen);
    await page.evaluate(() => window.__BILI_FIXTURE__.fire('back-live', 'ライブに復帰しました'));
    await page.locator('[data-id_str="back-live"] .danmaku-item-right').filter({ hasText: '活动译文' }).waitFor();
  });
  await check('uninitialized-client-room-shows-waiting-instead-of-open-a-page', async () => {
    await page.goto('https://live.bilibili.com/blanc/812345?unready=1');
    const popup = await context.newPage(); await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
    await page.bringToFront();
    await popup.locator('#status').filter({ hasText: '已识别 Bilibili 直播，正在等待原生直播间就绪' }).waitFor();
    assert.equal(await popup.locator('#scenario').textContent(), '直播');
    await popup.screenshot({ path: resolve(dir, 'popup-waiting.png') }); await popup.close();
  });
  assert.deepEqual(report.errors, []); report.status = 'PASS'; report.providerRequests = calls.length;
} catch (error) { report.status = 'FAIL'; report.errors.push(error.stack ?? String(error)); process.exitCode = 1; }
finally {
  hold?.(); await context?.close(); if (server) await new Promise(resolve => server.close(resolve));
  await writeFile(resolve(dir, 'report.json'), JSON.stringify(report, null, 2)); console.log('REPORT', resolve(dir, 'report.json'));
}
