import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Natural public messages only, copied extension + fresh anonymous profile +
// loopback provider. No send/purchase API and no independently opened socket.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/core/config.ts';
import { decodeTranslationFixtureRequest, encodeTranslationFixtureResponse } from './translation-protocol-fixture.mjs';

const mixedOnly = process.argv.includes('--mixed-emotes');
const activity = process.argv.includes('--activity');
const root = resolve('.artifacts/live'); await mkdir(root, { recursive: true });
const dir = await mkdtemp(resolve(root, activity ? 'bilibili-activity-real-' : mixedOnly ? 'bilibili-mixed-real-' : 'bilibili-repair-real-'));
const report = { evidence: 'anonymous real live page + copied production extension + loopback mock',
  startedAt: new Date().toISOString(), url: activity ? 'https://live.bilibili.com/213' : 'https://live.bilibili.com/22900497', maxObservationMs: 45000,
  settings: { liveSourceLanguage: 'auto', targetLanguage: 'en', provider: 'loopback-only', personalProfileUsed: false },
  provider: { requests: 0, items: 0, errors: [] }, checks: {}, realProvider: false, superchat: 'NOT_ACCEPTED_NO_NATURAL_SAMPLE' };
const prefix = '[Local mock] ', key = 'isolated-live-only', versions = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (fn, label, limit = 15000) => {
  const end = Date.now() + limit;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await delay(150); }
  throw new Error('Timed out: ' + label);
};
let server, context, page, options, rpc;
try {
  server = createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', 'content-type,authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
    try {
      assert.equal(req.headers.authorization, 'Bearer ' + key);
      assert.ok(report.provider.requests < 100, 'bounded local request budget');
      let body = ''; for await (const chunk of req) { body += chunk; assert.ok(body.length < 1000000); }
      const decoded = decodeTranslationFixtureRequest(JSON.parse(body));
      report.provider.requests++; report.provider.items += decoded.items.length;
      const reply = encodeTranslationFixtureResponse(decoded, decoded.items.map(item => {
        const version=(versions.get(item.text)||0)+1; versions.set(item.text,version);
        return { id: item.id, text: prefix + 'v'+version+' '+item.text };
      }));
      res.setHeader('content-type', reply.contentType); res.end(reply.body);
    } catch (error) { report.provider.errors.push(error.message); res.writeHead(500); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const extension = resolve(dir, 'extension'); await cp(resolve('.output/chrome-mv3'), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions.push('http://127.0.0.1/*'); await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
  const { chromium } = await loadPlaywright();
  context = await chromium.launchPersistentContext(resolve(dir, 'profile'), { ...browserLaunchOptions("chromium"),
    headless: true, viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', args: ['--disable-extensions-except=' + extension,
      '--load-extension=' + extension, '--disable-background-networking', '--disable-sync', '--no-first-run', '--autoplay-policy=no-user-gesture-required'] });
  report.browser = context.browser()?.version();
  await context.addInitScript(({ prefixValue, embedded }) => {
    const records = [], counts = {}, visible = new Set();
    window.__DL_LIVE_PROOF__ = { records, counts, visible, submitted: [], prepared: [], snapshots: [], screenPeak: 0, mixedVisible: new Set(), imageRowPeak: 0 };
    window.__DL_LIVE_PROOF__.roomDocument = () => {
      if (!embedded) return document;
      const frames = [...document.querySelectorAll('#player-ctnr iframe')].filter(frame => frame.getClientRects().length);
      if (frames.length !== 1) return null;
      try {
        const child = frames[0].contentDocument, url = new URL(child?.URL ?? '');
        return url.origin === location.origin && /^\/blanc\/[1-9]\d*\/?$/.test(url.pathname) && url.searchParams.get('liteVersion') === 'true' ? child : null;
      } catch { return null; }
    };
    // Independent observation: reconstruct logical aliases from the saved original,
    // preserving native image order; do not use translated DOM as translation input.
    window.__DL_LIVE_PROOF__.body = (element, record) => {
      if (!element || !record) return null;
      const realm = element.ownerDocument.defaultView;
      const tokens = new Set(record.emoteTokens ?? []), aliases = [...record.originalText.matchAll(/\[[^\[\]\s]{1,64}\]/gu)].map(m=>m[0]).filter(t=>tokens.has(t));
      let at = 0, valid = true, count = 0;
      const walk = node => {
        if (++count > 200) { valid=false; return ''; }
        if (node.nodeType === realm.Node.TEXT_NODE) return node.textContent;
        if (node instanceof realm.HTMLImageElement) { const alias=aliases[at++]; if(!alias)valid=false; return alias??''; }
        if (node instanceof realm.Element && node.classList.contains('content-message-icon')) return '';
        if (node!==element && !(node instanceof realm.HTMLElement&&node.tagName==='SPAN')) { valid=false; return ''; }
        return [...node.childNodes].map(walk).join('');
      };
      const result=walk(element); return valid&&at===aliases.length?result:null;
    };
    window.addEventListener('message', event => {
      const d = event.data;
      if (event.source !== window || event.origin !== location.origin || d?.bridge !== 'danlingo-live-v1') return;
      const proof = window.__DL_LIVE_PROOF__;
      counts[d.from + ':' + d.type] = (counts[d.from + ':' + d.type] || 0) + 1;
      if (d.from === 'adapter' && d.type === 'events') for (const row of (d.events ?? []).slice(0, 200)) if (records.length < 400) records.push({ sourceId: row.sourceId, nativeId: row.nativeId, originalText: row.originalText, translatable: row.translatable, emoteTokens: row.emoteTokens });
      if (d.type === 'prepared' && d.from === 'content' && proof.prepared.length < 400) proof.prepared.push({ sourceId: d.sourceId, text: d.text });
      if (d.type === 'submitted' && proof.submitted.length < 400) proof.submitted.push({ sourceId: d.sourceId, translated: d.translated, reason: d.reason });
      if (d.type === 'snapshot' && proof.snapshots.length < 400) proof.snapshots.push({ connection: d.connection, presentationActive: d.presentationActive, liveMetrics: d.liveMetrics });
    });
    setInterval(() => {
      const proof = window.__DL_LIVE_PROOF__;
      const roomDocument = proof.roomDocument(); if (!roomDocument) return;
      for (const row of roomDocument.querySelectorAll('#chat-items .danmaku-item-right')) {
        if (!row.getClientRects().length || roomDocument.defaultView.getComputedStyle(row).visibility === 'hidden') continue;
        const nativeId=row.closest('[data-id_str]')?.getAttribute('data-id_str');
        const record=proof.records.find(record=>record.sourceId==='dm:'+nativeId&&record.nativeId===nativeId);
        for (const prepared of proof.prepared) if (prepared.sourceId==='dm:'+nativeId && proof.body(row,record) === prepared.text && prepared.text.startsWith(prefixValue)) {
          visible.add(prepared.sourceId); if(record.emoteTokens?.length)proof.mixedVisible.add(prepared.sourceId);
        }
      }
      proof.imageRowPeak = Math.max(proof.imageRowPeak, [...roomDocument.querySelectorAll('#chat-items .danmaku-item-right')].filter(row=>row.querySelector('img')).length);
      proof.screenPeak = Math.max(proof.screenPeak, [...roomDocument.querySelectorAll('.bili-danmaku-x-dm')].filter(row => row.textContent.startsWith(prefixValue) && row.getClientRects().length).length);
    }, 100);
  }, { prefixValue: prefix, embedded: activity });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  options = await context.newPage(); await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  rpc = message => options.evaluate(value => chrome.runtime.sendMessage(value), message);
  const settings = normalizeSettings({ ...DEFAULT_SETTINGS, enabled: true, endpoint, allowLocalHttp: true, model: 'local-mock',
    thinkingEffort: 'default', sourceLanguage: 'auto', liveSourceLanguage: 'auto', targetLanguage: 'en', liveAdaptiveConcurrency: false, concurrency: 4, batchSize: 5, liveBufferMs: 2000 });
  assert.equal((await rpc({ type: 'save', settings, apiKey: key, remember: false })).ok, true);
  page = await context.newPage(); report.navigationStatus = (await page.goto(report.url, { waitUntil: 'domcontentloaded', timeout: 45000 }))?.status();
  await page.bringToFront();
  // Activity pages put the player below the promotional header and initialize it on visibility.
  if (activity) await page.locator('#player-ctnr').scrollIntoViewIfNeeded({ timeout: 15000 });
  await wait(() => page.evaluate(() => !!window.__DL_LIVE_PROOF__.roomDocument()?.querySelector('#chat-items')), 'real chat container', 30000);
  const room = activity ? page.frameLocator('#player-ctnr iframe') : page;
  const end = Date.now() + report.maxObservationMs;
  while (Date.now() < end) {
    const enough = await page.evaluate(mixedOnly => mixedOnly ? window.__DL_LIVE_PROOF__.mixedVisible.size > 0 : window.__DL_LIVE_PROOF__.visible.size >= 2, mixedOnly);
    if (enough) break; await delay(500);
  }
  report.checks.chain = await page.evaluate(() => {
    const p = window.__DL_LIVE_PROOF__;
    return { counts: p.counts, received: p.records.length, eligible: p.records.filter(row => row.translatable).length,
      withoutNativeId: p.records.filter(row => row.sourceId.startsWith('occ:')).length,
      prepared: p.prepared.length, submitted: p.submitted.length, submittedTranslated: p.submitted.filter(row => row.translated).length,
      nativeChatExactBodyCorrelations: p.visible.size, opaqueIdMatches: p.records.filter(row=>p.visible.has(row.sourceId)&&/[a-z]/i.test(row.nativeId)).length,
      matchedIdLengths:[...new Set(p.records.filter(row=>p.visible.has(row.sourceId)).map(row=>row.nativeId.length))],
      screenTranslatedDomPeak: p.screenPeak, lastSnapshot: p.snapshots.at(-1) ?? null };
  });
  report.checks.mixed = await page.evaluate(() => {
    const p=window.__DL_LIVE_PROOF__;
    return {captured:p.records.filter(r=>r.emoteTokens?.length).length,nativeConfirmed:p.mixedVisible.size,naturalImageRowPeak:p.imageRowPeak};
  });
  if (activity) report.checks.activity = await page.evaluate(() => {
    const d = window.__DL_LIVE_PROOF__.roomDocument(), w = d?.defaultView, init = w?.__NEPTUNE_IS_MY_WAIFU__?.roomInitRes?.data;
    return { childRoomPath: d ? new URL(d.URL).pathname : null, childVideoCount: d?.querySelectorAll('video').length ?? 0,
      childChatRows: d?.querySelectorAll('#chat-items .chat-item').length ?? 0, engineAvailable: typeof w?.LiveDanmakuEngine?.default?.prototype?.handleSocketMessage === 'function',
      roomId: init?.room_id ?? null, liveStatus: init?.live_status ?? null, statusInTopPage: !!document.querySelector('#danlingo-live-status') };
  });
  report.checks.chain.correlationLimit = 'Exact decoded wire nativeId == sourceId suffix == native chat data-id_str AND exact prepared body. No body/author/time identity guessing; no source bodies or raw IDs exported.';
  if (report.checks.chain.nativeChatExactBodyCorrelations > 0) {
    const sample = await page.evaluate(mixedOnly=> {
      const proof=window.__DL_LIVE_PROOF__;
      for(const row of proof.roomDocument().querySelectorAll('#chat-items .chat-item.danmaku-item[data-id_str]')) {
        const id=row.getAttribute('data-id_str'),button=row.querySelector('[data-danlingo-bili-retry]');
        if (proof.visible.has('dm:'+id)&&(!mixedOnly||proof.mixedVisible.has('dm:'+id))&&button&&!button.disabled) return id;
      }
    },mixedOnly);
    const logical=()=>page.evaluate(id=>{const p=window.__DL_LIVE_PROOF__,row=[...p.roomDocument().querySelectorAll('#chat-items [data-id_str]')].find(r=>r.getAttribute('data-id_str')===id);
      return p.body(row?.querySelector('.danmaku-item-right'),p.records.find(r=>r.sourceId==='dm:'+id));},sample);
    if (sample) {
      const native=room.locator('[data-id_str="'+sample+'"]'),body=native.locator('.danmaku-item-right');
      await body.evaluate(b=>{window.__DL_MIXED_IMAGE_NODES__=[...b.querySelectorAll('img')];});
      const first=await logical();await native.locator('[data-danlingo-bili-retry]').click();
      await wait(async()=> {const next=await logical(); return next!==first&&next?.startsWith(prefix);},'natural native first forced replacement');
      const imageNodesPreserved=await body.evaluate(b=>{const current=[...b.querySelectorAll('img')];return current.length===window.__DL_MIXED_IMAGE_NODES__.length&&current.every((n,i)=>n===window.__DL_MIXED_IMAGE_NODES__[i]);});
      assert.equal(imageNodesPreserved,true);
      report.checks.firstAutomaticForce={passed:true,distinctNativeBody:true,exactNativeIdentity:true,imageNodesPreserved};
    } else report.checks.firstAutomaticForce={status:'NOT_ACCEPTED_SAMPLE_DISAPPEARED'};
    if (!sample && mixedOnly) report.checks.recentForceClick={status:'NOT_ACCEPTED_NO_NATURAL_MIXED_SAMPLE'};
    else {
    await page.getByText('近期弹幕补翻', { exact: true }).click();
    const recent=sample?page.locator('[data-source-id="dm:'+sample+'"]'):page.locator('#danlingo-live-repairs');
    const button = recent.getByRole('button', { name: '强制重译', exact: true }).first();
    await button.waitFor({ state: 'visible', timeout: 10000 });
    const body=sample?room.locator('[data-id_str="'+sample+'"] .danmaku-item-right'):null;
    const beforeBody=body?await logical():undefined;
    const before = report.provider.requests; await button.click();
    await wait(() => report.provider.requests > before, 'natural record force translation');
    await wait(() => button.isEnabled(), 'manual response completion');
    if(body) await wait(async()=> {const next=await logical();return next!==beforeBody&&next?.startsWith(prefix);},'recent force native changed');
    report.checks.recentForceClick = { passed: true, localRequestObserved: true, nativeBodyChanged:!!body };
    await page.getByText('近期弹幕补翻', { exact: true }).click();
    }
  } else report.checks.recentForceClick = { status: 'NOT_ACCEPTED_NO_VISIBLE_TRANSLATED_SAMPLE' };
  report.checks.chatSingleButtonCount = await room.locator('#chat-items [data-danlingo-bili-retry]').count();
  report.checks.oneClickVisible = await page.getByRole('button',{name:'一键补翻漏译',exact:true}).isVisible();
  report.siteVerificationPrompt = await page.evaluate(() => /请在下图|安全验证|点击.*验证/.test(document.body.innerText + (window.__DL_LIVE_PROOF__.roomDocument()?.body.innerText ?? '')));
  report.screenshot = resolve(dir, 'natural-live-local-mock.png'); await page.screenshot({ path: report.screenshot });
  assert.equal(report.provider.errors.length, 0);
  report.result = report.siteVerificationPrompt ? 'NOT_ACCEPTED_SITE_VERIFICATION_REQUIRED' : mixedOnly ?
    report.checks.mixed.nativeConfirmed>0&&report.checks.firstAutomaticForce?.passed&&report.checks.recentForceClick?.passed?'NATURAL_MIXED_CHAIN_PASSED':'PARTIAL_NO_VERIFIED_NATURAL_MIXED_CHAIN' : report.checks.chain.received === 0 ? 'PARTIAL_NO_NATURAL_SAMPLE' :
    report.checks.chain.nativeChatExactBodyCorrelations > 0 && report.provider.requests > 0 && report.checks.chain.submittedTranslated > 0 ? 'NATURAL_ORDINARY_CHAIN_PASSED' : 'INCOMPLETE_ORDINARY_CHAIN';
  if (report.result === 'INCOMPLETE_ORDINARY_CHAIN') process.exitCode = 1;
} catch (error) { report.result = 'INCOMPLETE'; report.error = String(error.stack ?? error); process.exitCode = 1; }
finally {
  await rpc?.({ type: 'toggle', enabled: false }).catch(() => {}); await rpc?.({ type: 'delete-key' }).catch(() => {});
  await context?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  report.finishedAt = new Date().toISOString(); await writeFile(resolve(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ result: report.result, report: resolve(dir, 'report.json'), chain: report.checks.chain, error: report.error }, null, 2));
}
