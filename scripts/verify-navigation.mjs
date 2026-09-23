import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Production extension; isolated browser; deterministic LOCAL MOCK translation only.
// Run after the product build: node --experimental-strip-types scripts/verify-navigation.mjs
// --fixture-only / --real-only select independent acceptance surfaces.
import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findNativePlayer, isNativePlayer } from '../src/platforms/niconico/native.ts';
import { installBridgeObserver, installPlaybackObserver } from './vod-fixture.mjs';

const fixtureOnly = process.argv.includes('--fixture-only');
const realOnly = process.argv.includes('--real-only');
assert.ok(!(fixtureOnly && realOnly), 'Choose at most one focused mode');
const recommendationOffsetFlag = process.argv.indexOf('--recommendation-offset');
const recommendationOffset = recommendationOffsetFlag < 0 ? 0 : Number(process.argv[recommendationOffsetFlag + 1]);
assert.ok(Number.isInteger(recommendationOffset) && recommendationOffset >= 0 && recommendationOffset <= 4,
  'Recommendation offset must be an integer from 0 to 4');
const root = resolve('.artifacts/navigation');
await mkdir(root, { recursive: true });
const runDir = await mkdtemp(resolve(root, 'run-'));
const extension = resolve(runDir, 'test-extension');
await cp(resolve('.output/chrome-mv3'), extension, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), 'http://127.0.0.1/*'])];
await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest, null, 2));

const { chromium } = await loadPlaywright();
const report = {
  capturedAt: new Date().toISOString(), runDir,
  evidence: 'Production bundle; LOCAL MOCK provider; synthetic SPA and actual anonymous Niconico separately identified',
  limitations: ['Only the copied test manifest adds loopback permission; no personal browser configuration or real credentials are used.',
    'Synthetic staging is a bridge contract check; actual Niconico staging is separately recorded.',
    'Real playback is never paused or sought by this harness. Explicit play is used only if needed to observe native staging.'],
  fixture: { status: realOnly ? 'not-requested' : 'pending', visits: [] },
  real: { status: fixtureOnly ? 'not-requested' : 'pending', recommendationOffset, visits: [], links: [] },
  requests: [], senders: [], errors: [],
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let phase = 'setup', context, options, page, rpc, worker, activeRealVisit;
const held = new Set();
const mock = createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization,content-type');
  res.setHeader('content-type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'GET' && req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'navigation-local-mock' }] })); return; }
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end('{}'); return; }
  try {
    let body = '';
    for await (const chunk of req) { body += chunk; assert.ok(body.length < 1000000, 'Mock body budget'); }
    assert.equal(req.headers.authorization, 'Bearer danlingo-navigation-local-test-only');
    const json = JSON.parse(body);
    const inputs = JSON.parse(json.messages.find(message => message.role === 'user').content).items;
    const row = { at: Date.now(), phase, model: json.model, items: inputs.length, ids: inputs.map(item => item.id),
      texts: inputs.map(item => item.text), held: inputs.some(item => item.text.includes('NAV_HELD_A')) };
    report.requests.push(row);
    assert.ok(report.requests.length <= 100, 'Navigation mock request budget exceeded');
    if (row.held) await new Promise(resolve => held.add(resolve));
    row.releasedAt = Date.now();
    const items = inputs.map(item => ({ id: item.id, text: '【模拟译文】' + item.text })).reverse();
    row.responseConnectionClosed = res.destroyed;
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ items }) } }] }));
  } catch (error) {
    report.errors.push('mock: ' + String(error));
    res.writeHead(500); res.end('{}');
  }
});
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${mock.address().port}/v1/chat/completions`;
const release = () => { for (const resolve of held) resolve(); held.clear(); };
const playerExpression = `(() => {const isNativePlayer=${isNativePlayer.toString()};return (${findNativePlayer.toString()})(location.pathname.split('/')[2]);})()`;
const native = action => page.evaluate(`(async()=>{const p=${playerExpression};if(!p)throw new Error('Native player absent');${action}})()`);
async function waitFor(check, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await check(); if (result) return result; await delay(100); }
  throw new Error('Timed out: ' + label);
}
const until = (fn, arg, label, timeout) => waitFor(() => page.evaluate(fn, arg), label || String(fn).slice(0, 100), timeout);
const bridgeState = () => page.evaluate(() => ({
  documentId: window.__DL_NAV__.documentId, url: location.href, scope: window.__DL_VOD__.scope,
  snapshot: window.__DL_VOD__.snapshot, sourceCount: window.__DL_VOD__.sources.size,
  prepared: window.__DL_VOD__.prepared.size, sourceComplete: window.__DL_VOD__.sourceComplete,
  mismatchedPrepared: window.__DL_NAV__.mismatchedPrepared, transitions: window.__DL_NAV__.transitions,
}));
async function screenshot(name) {
  const player = page.locator('[data-danlingo-player]');
  if (await player.count()) await player.first().evaluate(node => node.scrollIntoView({ block: 'center' }));
  const path = resolve(runDir, name + '.png');
  await page.screenshot({ path }); return path;
}
async function save(patch) {
  const settings = (await rpc({ type: 'settings' })).settings;
  const response = await rpc({ type: 'save', settings: { ...settings, ...patch }, remember: false });
  assert.equal(response.ok, true, response.error); return response;
}
async function overlay(name) {
  const host = page.locator('#danlingo-progress');
  await host.waitFor({ state: 'visible' });
  await waitFor(async () => /已准备 [1-9]/.test(await host.locator('#progress-summary').innerText()), 'progress publication after native preparation');
  const text = await host.locator('#progress-summary').innerText();
  assert.match(text, /已准备 [1-9]/);
  // The full-width, static host reserves normal document flow below the player;
  // only its visible inline-flex panel is the compact progress control.
  const hostBox = await host.boundingBox();
  const box = await host.locator('#panel').boundingBox();
  const placement = await host.evaluate(element => {
    const anchor = element.previousElementSibling, rect = anchor?.getBoundingClientRect();
    return { position: getComputedStyle(element).position, anchorHasVideo: !!anchor?.querySelector('video'),
      anchorBox: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null };
  });
  assert.equal(await host.locator('details').evaluate(element => element.open), false, 'Progress is collapsed during navigation');
  assert.ok(box && box.width <= 420 && box.height <= 140, 'Collapsed progress remains compact');
  assert.equal(placement.position, 'static', 'Progress host remains in normal document flow');
  assert.ok(hostBox && placement.anchorHasVideo && placement.anchorBox && hostBox.y >= placement.anchorBox.y + placement.anchorBox.height - 1, 'Progress remains below the player without covering video');
  assert.ok(box.x >= hostBox.x - 1 && box.x + box.width <= hostBox.x + hostBox.width + 1, 'Compact panel remains within its player column');
  return { text, box, hostBox, ...placement, screenshot: await screenshot(name) };
}
async function scopeThroughUi(scope, seconds) {
  const host = page.locator('#danlingo-progress');
  if (!await host.locator('details').evaluate(node => node.open)) await host.locator('#progress-summary').click();
  await host.locator('#scope').selectOption(scope);
  await waitFor(async () => (await rpc({ type: 'settings' })).settings.translationScope === scope, 'scope save from current SPA video');
  if (seconds !== undefined) {
    await host.locator('#window-seconds').fill(String(seconds)); await host.locator('#apply-window').click();
    await waitFor(async () => (await rpc({ type: 'settings' })).settings.prefetchSeconds === seconds, 'window save from current SPA video');
  }
  const note = await host.locator('#note').textContent();
  assert.ok(!note.includes('视频已切换') && !note.includes('不支持的消息来源'), note);
  if (await host.locator('details').evaluate(node => node.open)) await host.locator('#progress-summary').click();
  return { translationScope: scope, seconds, note };
}

function installNavigationObserver() {
  const state = window.__DL_NAV__ = { documentId: crypto.randomUUID(), transitions: [], mismatchedPrepared: [], stages: [] };
  window.addEventListener('message', event => {
    const d = event.data;
    if (event.source !== window || d?.bridge !== 'danlingo.native.v1') return;
    if (d.from === 'native' && d.type === 'snapshot' && state.transitions.at(-1)?.session !== d.session) {
      state.transitions.push({ resourceId: d.resourceId, session: d.session, at: performance.now() });
    }
    if (d.from === 'content' && d.type === 'prepared' &&
        (d.resourceId !== location.pathname.split('/')[2] || d.session !== window.__DL_VOD__.snapshot?.session)) {
      state.mismatchedPrepared.push({ resourceId: d.resourceId, session: d.session, ids: d.items.map(item => item.id) });
    }
  });
}

const fixtureIds = ['sm999999981', 'sm999999982', 'sm999999983'];
const fixtureHtml = `<!doctype html><html lang="ja"><meta charset="utf-8"><title>Navigation fixture · LOCAL MOCK</title>
<style>body{margin:0;background:#15191d;color:#edf4f8;font:16px system-ui}main{max-width:1120px;margin:32px auto}nav{display:flex;gap:18px;margin:20px 0}a{color:#afe2c5}h1{font-size:20px}#fixture-stage{position:relative;background:#19354a;width:100%;aspect-ratio:16/9}video{width:100%;height:100%}.comment{position:absolute;top:32%;left:10%;font-size:26px}.label{position:absolute;bottom:12px;left:16px;color:#b1c9d8;font-size:12px}</style>
<main><h1>Synthetic SPA navigation · LOCAL MOCK</h1><nav><a href="/">Homepage</a><a href="/watch/sm999999981">Video A</a><a href="/watch/sm999999982">Video B</a><a href="/watch/sm999999983">Video C</a></nav><div id="fixture-root">Homepage — choose a video</div></main></html>`;
function installNavigationFixture() {
  const install = () => {
    const state = window.__DL_NAV_FIXTURE__ = { visits: [], current: null, playCalls: 0, pauseCalls: 0 };
    function mount() {
      const previous = state.current;
      if (previous) previous.player.isDisposed = true;
      const root = document.getElementById('fixture-root'), resourceId = location.pathname.split('/')[2];
      root.replaceChildren(); state.current = null;
      if (!resourceId) { root.textContent = 'Homepage — choose a video'; return; }
      root.innerHTML = '<div id="fixture-stage"><video></video><div class="comment"></div><div class="label">SYNTHETIC NATIVE PLAYER · LOCAL MOCK TRANSLATION</div></div>';
      const stage = root.firstElementChild, video = stage.querySelector('video');
      const current = { resourceId, paused: true, drawn: {}, stages: [], playCalls: 0, pauseCalls: 0, time: 0 };
      const chat = (id, vposMs, text) => ({ id, thread: 'navigation-fixture', fork: 'main', vposMs, position: 'naka', size: 'medium', color: '#ffffff', font: 'defont',
        comment: { body: text, commands: ['184', 'naka', 'white'], postedAt: '2026-09-01T00:00:00Z' } });
      const rows = Array.from({ length: 8 }, (_, index) => chat('comment-' + index, index * 1000, `${resourceId} 動画のコメント${index}`));
      const filters = new Map();
      const layer = { stagingChatManager: { chatList: rows }, processor: { contentLengthMs: 120000 },
        addStagingFilter: (name, fn) => filters.set(name, fn), removeStagingFilter: name => filters.delete(name), getStagingFilterNameList: () => [...filters.keys()] };
      const render = id => {
        const row = rows.find(row => row.id === id); let settings = { visible: true, content: row.comment.body };
        for (const filter of filters.values()) settings = filter(row, settings);
        const result = { resourceId, id, original: row.comment.body, text: settings.content, at: performance.now() };
        current.drawn[id] = result; current.stages.push(result); stage.querySelector('.comment').textContent = result.text; return result;
      };
      Object.defineProperties(video, { paused: { get: () => current.paused }, seeking: { get: () => false },
        currentTime: { get: () => current.time }, duration: { get: () => 120 }, readyState: { get: () => 4 }, playbackRate: { get: () => 1 },
        buffered: { get: () => ({ length: 1, start: () => 0, end: () => 20 }) }, played: { get: () => ({ length: 0 }) } });
      video.play = async () => { state.playCalls++; current.playCalls++; current.paused = false; video.dispatchEvent(new Event('playing')); };
      video.pause = () => { state.pauseCalls++; current.pauseCalls++; current.paused = true; };
      const player = { watch: { video: { id: resourceId, duration: 120 } }, context: {}, isDisposed: false, _isInterrupting: false, stage,
        getCurrentTime: () => current.time, getVideoElement: () => video, getPlaybackRate: () => 1,
        isPlaying: () => !current.paused, isSeeking: () => false, isReady: () => true, isDummyVideo: () => false,
        commentRenderer: { parentElement: stage, layerProcessorList: [layer], refreshComments: () => { render('comment-0'); render('comment-1'); } } };
      video.__reactFiber$danlingoNavigation = { memoizedProps: { player }, return: null };
      Object.assign(current, { player, rows, render, addHeld: () => rows.push(chat('held-a', 9000, `${resourceId} NAV_HELD_A 遅れて届くコメント`)) });
      state.current = current; state.visits.push(current); render('comment-0');
    }
    document.querySelector('nav').addEventListener('click', event => {
      const link = event.target.closest('a'); if (!link) return;
      event.preventDefault(); history.pushState({}, '', link.getAttribute('href')); mount();
    });
    window.addEventListener('popstate', mount); mount();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true }); else install();
}

async function fixtureVisit(id, label, documentId) {
  await until(id => { const s = window.__DL_VOD__; return s.snapshot?.resourceId === id && s.sourceComplete && s.sources.size === 8 && s.prepared.size === 8; }, id, label + ' source/prepared pool');
  await until(() => window.__DL_NAV_FIXTURE__.current.drawn['comment-0']?.text.startsWith('【模拟译文】'), undefined, label + ' native paused refresh');
  const state = await bridgeState();
  assert.equal(state.documentId, documentId, 'SPA navigation retains the injected document');
  assert.equal(state.mismatchedPrepared.length, 0, 'Old session outputs must not be republished');
  assert.ok(await page.evaluate(id => [...window.__DL_VOD__.sources.values()].every(row => row.resourceId === id) &&
    [...window.__DL_VOD__.prepared.values()].every(row => row.originalText.startsWith(id)), id), 'Only current video sources/outputs count');
  const drawn = await page.evaluate(() => window.__DL_NAV_FIXTURE__.current.drawn['comment-0']);
  const visit = { label, ...state, drawn, overlay: await overlay('fixture-' + label + '-LOCAL-MOCK') };
  report.fixture.visits.push(visit); return visit;
}

async function installRealProbe() {
  return native(`
    const session=window.__DL_VOD__.snapshot?.session;
    window.__DL_NAV__.stages=[];
    for(const layer of p.commentRenderer.layerProcessorList) {
      layer.removeStagingFilter('danlingo-navigation-evidence');
      layer.addStagingFilter('danlingo-navigation-evidence',(chat,settings)=>{
        const s=window.__DL_VOD__, id=JSON.stringify([location.pathname.split('/')[2],String(chat.thread??''),String(chat.fork??''),String(chat.id??'')]);
        const prepared=s.prepared.get(id);
        if(settings.visible && window.__DL_NAV__.stages.length<250)window.__DL_NAV__.stages.push({
          resourceId:p.watch.video.id,session,id,original:chat.comment?.body,text:settings.content,
          preparedInCurrentSession:prepared?.scope===s.scope,mediaMs:p.getCurrentTime()*1000,at:performance.now()});
        return settings;
      });
    }
    return {paused:p.getVideoElement().paused,time:p.getCurrentTime(),contentActive:!p._isInterrupting};
  `);
}
async function realDiagnostics() {
  const capturedAt = new Date().toISOString();
  const settings = await rpc({ type: 'settings' }).then(response => {
    if (response.ok && response.settings) { report.settings = response.settings; return response.settings; }
    return { unavailable: response.error || 'Settings unavailable' };
  }).catch(error => ({ unavailable: String(error.message) }));
  const state = page ? await page.evaluate(() => {
    const s = window.__DL_VOD__, root = document.querySelector('#danlingo-progress')?.shadowRoot;
    return {
      url: location.href, scope: s?.scope ?? null, clock: s?.snapshot?.clock ?? null,
      sourceCount: s?.sources.size ?? 0, sourceComplete: s?.sourceComplete === true, prepared: s?.prepared.size ?? 0,
      sources: [...(s?.sources.values() ?? [])].slice(0, 20).map(row => ({
        id: row.id, sourceId: row.sourceId, threadId: row.threadId, fork: row.fork,
        originalText: row.originalText, mediaTimeMs: row.mediaTimeMs, renderAtMs: row.renderAtMs,
        translatable: row.translatable, style: row.style,
      })),
      progress: {
        summary: root?.querySelector('#progress-summary')?.textContent ?? null,
        title: root?.querySelector('summary')?.title ?? null,
        coverage: root?.querySelector('#coverage')?.textContent ?? null,
        skipped: root?.querySelector('#skipped')?.textContent ?? null,
        skippedHidden: root?.querySelector('#skipped')?.hidden ?? null,
      },
    };
  }).catch(error => ({ unavailable: String(error.message) })) : { unavailable: 'No real page available' };
  return { capturedAt, ...activeRealVisit, settings, ...state };
}
async function realVisit(id, label, documentId) {
  activeRealVisit = { resourceId: id, label };
  await until(id => window.__DL_VOD__?.snapshot?.resourceId === id, id, label + ' actual native bridge', 45000);
  const initial = await native('return {paused:p.getVideoElement().paused,time:p.getCurrentTime(),contentActive:!p._isInterrupting};');
  await until(id => { const s = window.__DL_VOD__; return s.snapshot.resourceId === id && s.sourceComplete && s.sources.size > 0; }, id, label + ' actual native source pool', 35000);
  await until(() => window.__DL_VOD__.snapshot.clock.contentActive, undefined, label + ' site ad/interrupt ended', 45000);
  await until(id => { const s = window.__DL_VOD__; return s.snapshot.resourceId === id && s.prepared.size > 0 && [...s.prepared.values()].every(row => row.scope === s.scope); }, id, label + ' new-session mock prepared output', 30000);
  // Evidence must run after the production translation filter, otherwise it
  // observes input text even while the actual renderer displays translations.
  await waitFor(() => native("return p.commentRenderer.layerProcessorList.every(layer=>layer.getStagingFilterNameList().includes('danlingo-text-v1'));"), label + ' production staging filter');
  await installRealProbe();
  const state = await bridgeState();
  if (documentId) assert.equal(state.documentId, documentId, 'Real recommendation click must retain the document (SPA)');
  assert.equal(state.mismatchedPrepared.length, 0, 'No old-session prepared output accepted');
  const visit = { label, ...state, initial, diagnostics: await realDiagnostics(), overlay: await overlay('real-' + label + '-LOCAL-MOCK'), playMethod: 'site playback / paused native refresh; harness made no playback call' };
  report.real.visits.push(visit);
  if (!await page.evaluate(id => window.__DL_NAV__.stages.some(row => row.resourceId === id && row.text?.startsWith('【模拟译文】') && row.preparedInCurrentSession), id)) {
    const paused = await native('return p.getVideoElement().paused;');
    if (paused) {
      const button = page.getByRole('button', { name: '再生する', exact: true });
      if (await button.count() && await button.first().isVisible()) {
        try { await button.first().click({ timeout: 2000 }); visit.playMethod = 'actual website play button'; }
        catch (error) { visit.playButtonObstacle = String(error.message).split('\n')[0]; }
      }
      if (await native('return p.getVideoElement().paused;')) {
        await native('await Promise.race([p.getVideoElement().play(),new Promise((_,reject)=>setTimeout(()=>reject(new Error("Explicit harness play did not start")),5000))]);');
        visit.playMethod = 'explicit harness native play (no pause or seek)';
      }
    }
    await until(id => window.__DL_NAV__.stages.some(row => row.resourceId === id && row.text?.startsWith('【模拟译文】') && row.preparedInCurrentSession), id, label + ' translated text in actual native staging', 25000);
  }
  visit.stages = await page.evaluate(id => window.__DL_NAV__.stages.filter(row => row.resourceId === id && row.text?.startsWith('【模拟译文】') && row.preparedInCurrentSession).slice(0, 12), id);
  assert.ok(visit.stages.length > 0, 'Native staging evidence belongs to current resource and session');
  visit.nativeScreenshot = await screenshot('real-' + label + '-native-LOCAL-MOCK');
  visit.playbackCalls = await page.evaluate(() => window.__DL_PLAYBACK__);
  assert.ok(visit.playbackCalls.every(call => !call.extensionCaller), 'Extension must not call play/pause');
  return visit;
}

async function clickRecommendation(seen) {
  // Candidates come from the rendered page. The right rail and explicit recommendation
  // ancestors identify actual recommendation UI; header/history links are excluded.
  const candidates = await page.locator('a[href*="/watch/"]').evaluateAll((nodes, seen) => nodes.map((node, index) => {
    const href = new URL(node.getAttribute('href'), location.href), rect = node.getBoundingClientRect();
    let ancestor = node.parentElement, context = '';
    for (let i = 0; ancestor && i < 5; i++, ancestor = ancestor.parentElement) context += ' ' + ancestor.className + ' ' + (ancestor.getAttribute('data-testid') || '') + ' ' + (ancestor.getAttribute('aria-label') || '');
    const id = href.pathname.match(/^\/watch\/((?:sm|nm|so)\d+)$/)?.[1];
    const recommendationContext = /recommend|related|関連|おすすめ/i.test(context);
    const rightRail = rect.x >= innerWidth * .65 && rect.y > 80;
    return { index, href: href.href, id, text: (node.innerText || node.getAttribute('title') || node.querySelector('img')?.alt || '').trim().slice(0, 160),
      target: node.getAttribute('target') || '', rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      context: context.slice(0, 350), recommendationContext, rightRail, eligible: href.origin === location.origin && id && !seen.includes(id) &&
        rect.width > 20 && rect.height > 15 && getComputedStyle(node).visibility !== 'hidden' && (!node.target || node.target === '_self') && (recommendationContext || rightRail) };
  }).filter(row => row.eligible), seen);
  assert.ok(candidates.length, 'No eligible same-tab recommendation link observed in actual page UI');
  // An explicit offset lets another observed recommendation supply a positive
  // navigation sample when a prior run had no comments inside its time window.
  // Keep that prior run incomplete; do not silently retry or relax assertions.
  const ordered = [
    ...candidates.filter(row => row.recommendationContext && row.text),
    ...candidates.filter(row => !row.recommendationContext && row.text),
    ...candidates.filter(row => !row.text),
  ];
  const candidate = ordered[recommendationOffset];
  assert.ok(candidate, 'Requested recommendation offset is absent in actual page UI');
  report.real.links.push({ from: page.url(), recommendationOffset, selected: candidate, alternatives: ordered.slice(0, 5) });
  await page.locator('a[href*="/watch/"]').nth(candidate.index).click({ timeout: 10000 });
  await waitFor(() => new URL(page.url()).pathname === '/watch/' + candidate.id, 'recommendation click changed URL', 20000);
  return candidate.id;
}

try {
  const profile = await mkdtemp(resolve(runDir, 'profile-')); report.profile = profile;
  context = await chromium.launchPersistentContext(profile, { headless: true, ...browserLaunchOptions('chromium'),
    viewport: { width: 1440, height: 1000 }, locale: 'ja-JP', args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
  report.browserVersion = context.browser()?.version();
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await worker.evaluate(() => {
    self.__DL_NAV_SENDERS__ = [];
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (!sender.tab || !['translate', 'scheduling-settings', 'cancel', 'status', 'settings'].includes(message?.type)) return;
      const row = { at: Date.now(), type: message.type, resourceId: message.resourceId || message.status?.resourceId,
        senderUrl: sender.url, senderTabUrl: sender.tab.url, documentId: sender.documentId, frameId: sender.frameId, tabId: sender.tab.id };
      self.__DL_NAV_SENDERS__.push(row);
      if (self.__DL_NAV_SENDERS__.length > 600) self.__DL_NAV_SENDERS__.shift();
      chrome.tabs.get(sender.tab.id).then(tab => { row.currentTabUrl = tab.url; }).catch(() => {});
    });
  });
  options = await context.newPage(); await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  rpc = payload => options.evaluate(payload => chrome.runtime.sendMessage(payload), payload);
  await waitFor(() => options.locator('#key-state').textContent(), 'options ready');
  const initial = (await rpc({ type: 'settings' })).settings;
  const configured = await rpc({ type: 'save', settings: { ...initial, endpoint, model: 'navigation-local-mock', profile: 'chat-completions',
    thinkingEffort: 'default', allowLocalHttp: true, enabled: true, sourceLanguage: 'ja', targetLanguage: 'zh-Hans', translationScope: 'all',
    prefetchSeconds: 25, urgentSeconds: 5, concurrency: 4, batchSize: 50, maxBatchChars: 12000, requestTimeoutMs: 25000 },
    apiKey: 'danlingo-navigation-local-test-only', remember: false });
  assert.equal(configured.ok, true, configured.error); assert.equal(configured.hasKey, true);
  report.settings = configured.settings; await rpc({ type: 'clear-cache' });

  if (!realOnly) {
    phase = 'fixture-navigation'; page = await context.newPage();
    await page.addInitScript(installBridgeObserver); await page.addInitScript(installNavigationObserver); await page.addInitScript(installNavigationFixture);
    await page.route('https://www.nicovideo.jp/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: fixtureHtml }));
    await page.goto('https://www.nicovideo.jp/', { waitUntil: 'domcontentloaded' }); await page.bringToFront();
    const documentId = await page.evaluate(() => window.__DL_NAV__.documentId);
    await page.getByRole('link', { name: 'Video A', exact: true }).click();
    const a = await fixtureVisit(fixtureIds[0], 'A', documentId);
    await page.evaluate(() => window.__DL_NAV_FIXTURE__.current.addHeld());
    await waitFor(() => held.size > 0, 'held A provider request entered');
    phase = 'fixture-B-held-A';
    await page.getByRole('link', { name: 'Video B', exact: true }).click();
    const b = await fixtureVisit(fixtureIds[1], 'B', documentId); assert.notEqual(b.snapshot.session, a.snapshot.session);
    release(); await waitFor(() => report.requests.some(row => row.held && row.releasedAt), 'old A reply released');
    const releaseTime = await page.evaluate(() => performance.now());
    await until(at => performance.now() - at > 1200 && ![...window.__DL_VOD__.prepared.values()].some(row => row.originalText.includes('NAV_HELD_A')), releaseTime, 'old held reply cannot enter B');
    report.fixture.heldRequestIsolation = { released: true, oldPreparedInCurrentPool: false, request: report.requests.find(row => row.held) };
    report.fixture.scopeSaveOnB = await scopeThroughUi('window', 37); await scopeThroughUi('all');
    phase = 'fixture-history';
    await page.getByRole('link', { name: 'Video C', exact: true }).click();
    const c = await fixtureVisit(fixtureIds[2], 'C', documentId); assert.notEqual(c.snapshot.session, b.snapshot.session);
    await page.goBack(); const back = await fixtureVisit(fixtureIds[1], 'back-B', documentId); assert.notEqual(back.snapshot.session, b.snapshot.session);
    await page.goForward(); const forward = await fixtureVisit(fixtureIds[2], 'forward-C', documentId); assert.notEqual(forward.snapshot.session, c.snapshot.session);
    report.fixture.playback = await page.evaluate(() => ({ playCalls: window.__DL_NAV_FIXTURE__.playCalls, pauseCalls: window.__DL_NAV_FIXTURE__.pauseCalls,
      navigationEntries: performance.getEntriesByType('navigation').length, totalFixtureRowsAcrossVisits: window.__DL_NAV_FIXTURE__.visits.reduce((n, visit) => n + visit.rows.length, 0) }));
    assert.equal(report.fixture.playback.playCalls, 0); assert.equal(report.fixture.playback.pauseCalls, 0);
    assert.equal(report.fixture.playback.navigationEntries, 1); assert.ok(report.fixture.playback.totalFixtureRowsAcrossVisits < 100);
    const senders = await worker.evaluate(() => self.__DL_NAV_SENDERS__);
    report.fixture.staleSenderEvidence = senders.filter(row => ['translate', 'scheduling-settings'].includes(row.type) && row.resourceId === fixtureIds[1]);
    assert.ok(report.fixture.staleSenderEvidence.some(row => row.type === 'translate' && row.senderUrl === 'https://www.nicovideo.jp/' && new URL(row.currentTabUrl).pathname === '/watch/' + fixtureIds[1]));
    assert.ok(report.fixture.staleSenderEvidence.some(row => row.type === 'scheduling-settings' && row.senderUrl === 'https://www.nicovideo.jp/'));
    report.fixture.status = 'passed';
    console.log('PASS fixture: same-document homepage > A > B > C > back B > forward C; held A isolated; B UI save; native mock staging; no play/pause; <100 fixture rows');
    await rpc({ type: 'toggle', enabled: false }); await page.close(); page = null;
  }
  if (!fixtureOnly) {
    phase = 'real-navigation';
    const realConfigured = await save({ enabled: true, translationScope: 'window', prefetchSeconds: 25 });
    report.real.settingsAfterSave = realConfigured.settings; report.settings = realConfigured.settings;
    await rpc({ type: 'clear-cache' });
    page = await context.newPage(); await page.addInitScript(installBridgeObserver); await page.addInitScript(installNavigationObserver); await page.addInitScript(installPlaybackObserver);
    await page.goto('https://www.nicovideo.jp/watch/sm1715919', { waitUntil: 'domcontentloaded', timeout: 45000 }); await page.bringToFront();
    const a = await realVisit('sm1715919', 'A');
    const bId = await clickRecommendation(['sm1715919']);
    const b = await realVisit(bId, 'B', a.documentId); assert.notEqual(b.snapshot.session, a.snapshot.session);
    report.real.scopeSaveOnB = await scopeThroughUi('window', 37);
    const cId = await clickRecommendation(['sm1715919', bId]);
    const c = await realVisit(cId, 'C', a.documentId); assert.notEqual(c.snapshot.session, b.snapshot.session);
    const senders = await worker.evaluate(() => self.__DL_NAV_SENDERS__);
    report.real.staleSenderEvidence = senders.filter(row => ['translate', 'scheduling-settings'].includes(row.type) && [bId, cId].includes(row.resourceId));
    assert.ok(report.real.staleSenderEvidence.some(row => row.type === 'translate' && row.senderUrl.includes('/watch/sm1715919') && row.currentTabUrl !== row.senderUrl));
    report.real.status = 'passed';
    console.log('PASS real: actual recommendation clicks A > B > C retain one document; new sessions, mock prepared outputs, progress and native staging; B scope save; no extension play/pause');
  }
  assert.equal(report.errors.length, 0);
  report.result = 'PASS requested navigation acceptance (LOCAL MOCK translation only)';
} catch (error) {
  report.errors.push(String(error.stack ?? error).slice(0, 3500)); process.exitCode = 1;
  if (phase.startsWith('fixture')) report.fixture.status = 'failed';
  if (phase.startsWith('real')) {
    report.real.status = 'incomplete';
    report.real.reason = String(error.message).slice(0, 600);
    report.real.diagnosticsAtFailure = await realDiagnostics();
    report.real.bodyExcerpt = await page?.locator('body').innerText().then(text => text.slice(0, 6000)).catch(() => null);
    report.real.probeAtFailure = await page?.evaluate(() => ({ stages: window.__DL_NAV__?.stages, playback: window.__DL_PLAYBACK__ })).catch(() => null);
  }
  if (page) { report.lastBridge = await bridgeState().catch(() => null); report.failureScreenshot = await screenshot('failure').catch(() => null); }
} finally {
  release();
  report.senders = await worker?.evaluate(() => self.__DL_NAV_SENDERS__).catch(() => []) || [];
  if (rpc) {
    await rpc({ type: 'toggle', enabled: false }).catch(() => {});
    const deleted = await rpc({ type: 'delete-key' }).catch(() => null);
    report.testKeyDeleted = deleted?.ok === true && deleted.hasKey === false;
  }
  await context?.close(); mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
  await writeFile(resolve(runDir, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(resolve(root, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ report: resolve(runDir, 'report.json'), result: report.result, fixture: report.fixture.status,
  real: report.real.status, mockRequests: report.requests.length, errors: report.errors }, null, 2));
