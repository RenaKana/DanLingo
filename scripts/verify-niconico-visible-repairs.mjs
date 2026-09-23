import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Real public LIVE page, unchanged production extension, loopback-only translation fixture.
// The independent observer reads the exact postrender frame selected by the actual UI scan.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/core/config.ts';
import { protectText } from '../src/translation/text.ts';
import { decodeTranslationFixtureRequest, encodeTranslationFixtureResponse } from './translation-protocol-fixture.mjs';

const args = process.argv.slice(2), opt = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const build = resolve(opt('--build-dir', '.output/chrome-mv3')), roomArg = opt('--room', 'discover');
assert.ok(roomArg === 'discover' || /^lv\d+$/.test(roomArg));
const browserName = opt('--browser', 'chromium'); assert.ok(['chromium', 'edge'].includes(browserName));
const base = resolve('.artifacts/live/niconico-visible-repairs'); await mkdir(base, { recursive: true });
const root = await mkdtemp(resolve(base, browserName + '-'));
const hash = text => createHash('sha256').update(String(text)).digest('hex');
const report = { capturedAt: new Date().toISOString(), root, status: 'INCOMPLETE', build, browserName,
  evidence: 'REAL_PUBLIC_NICONICO_LIVE_PRODUCTION_EXTENSION_LOOPBACK_MOCK', requests: [], scans: [], modules: [], checks: {},
  limitations: ['No fabricated chats, no chat sends, no real model/key.', 'Geometry from the last actual Pixi draw is not physical pixel presentation or opaque overlay compositing.', 'Unobserved natural exclusion categories remain unverified.', 'The isolated manifest alone pregrants loopback HTTP.'] };
let context, server, options, page, watchdog;
let fixturePhase = 'unavailable';
const delay = ms => new Promise(r => setTimeout(r, ms));
const prefix = '【本地模拟译文】';

function installObservation() {
  const state = window.__DL_VISIBLE_AUDIT__ = { scans: [], controls: [], snapshots: [], wires: new Map(), errors: [], native: null };
  const keyOf = p => JSON.stringify([p.no, p.date, p.date_usec ?? p.dateUsec ?? 0]);
  const dispatch = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function(event) {
    try {
      const envelope = event.type === 'onMessage' && event.detail?.message;
      const chat = envelope?.payload?.case === 'message' && envelope.payload.value?.data?.case === 'chat' && envelope.payload.value.data.value;
      if (chat && envelope.meta?.at) {
        state.wires.set(keyOf({ no: chat.no, date: Number(envelope.meta.at.seconds), date_usec: Number(envelope.meta.at.nanos) / 1000 }), envelope.meta.id);
        if (state.wires.size > 2000) state.wires.delete(state.wires.keys().next().value);
      }
    } catch { /* Observation must not interfere with native dispatch. */ }
    return Reflect.apply(dispatch, this, [event]);
  };
  state.discover = () => {
    for (const element of document.querySelectorAll('div[id^="renderer-parent-id-"]')) {
      let fiber = element[Object.keys(element).find(k => /^__react(?:Fiber|InternalInstance)\$/.test(k))];
      for (let depth = 0; fiber && depth < 20; depth++, fiber = fiber.return) {
        const component = fiber.stateNode;
        if (typeof component?.addToRender === 'function' && component?.renderer?.pixiRenderer && Array.isArray(component.renderer.layerProcessorList)) return component.renderer;
      }
    }
    return null;
  };
  function snapshot(renderer) {
    const pixi = renderer.pixiRenderer, canvas = renderer.element, screen = pixi.screen, canvasBox = canvas.getBoundingClientRect();
    let left = Math.max(0, canvasBox.left), top = Math.max(0, canvasBox.top), right = Math.min(innerWidth, canvasBox.right), bottom = Math.min(innerHeight, canvasBox.bottom);
    const ancestors = []; let domVisible = !document.hidden, supported = true;
    for (let el = canvas; el; el = el.parentElement) {
      const css = getComputedStyle(el), box = el.getBoundingClientRect();
      ancestors.push({ tag: el.tagName, display: css.display, visibility: css.visibility, opacity: css.opacity, transform: css.transform, overflowX: css.overflowX, overflowY: css.overflowY });
      if (css.display === 'none' || css.visibility !== 'visible' || Number(css.opacity) <= 0) domVisible = false;
      if ((css.clipPath && css.clipPath !== 'none') || (css.maskImage && css.maskImage !== 'none')) supported = false;
      if (css.transform !== 'none') { const m = new DOMMatrixReadOnly(css.transform); if (!m.is2D || m.b || m.c || m.a <= 0 || m.d <= 0) supported = false; }
      if (['hidden','clip','scroll','auto'].includes(css.overflowX)) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
      if (['hidden','clip','scroll','auto'].includes(css.overflowY)) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
    }
    const rows = [], exclusions = { offscreen: 0, hidden: 0, detached: 0, reset: 0, special: 0, unknownEffect: 0 };
    for (const layer of renderer.layerProcessorList) for (const slot of layer.slotRepository?.stagingList || []) {
      const raw = slot.chat?.parsedOriginalChat ?? slot.chat, object = slot.displayObject;
      if (!raw || !raw.content) { exclusions.reset++; continue; }
      if (!object || object.parent !== layer.displayObject || layer.displayObject.parent !== renderer.stage) { exclusions.detached++; continue; }
      const chain = [object, layer.displayObject, renderer.stage];
      if (chain.some(o => o.mask || o.filters?.length)) { exclusions.unknownEffect++; supported = false; continue; }
      if (!domVisible || chain.some(o => o.visible !== true || o.renderable !== true || !(o.worldAlpha > 0))) { exclusions.hidden++; continue; }
      const b = object.getBounds(true), x0 = canvasBox.left + (b.x - (screen.x || 0)) / screen.width * canvasBox.width,
        y0 = canvasBox.top + (b.y - (screen.y || 0)) / screen.height * canvasBox.height,
        x1 = x0 + b.width / screen.width * canvasBox.width, y1 = y0 + b.height / screen.height * canvasBox.height;
      if (x1 <= left || x0 >= right || y1 <= top || y0 >= bottom || !(x1 > x0 && y1 > y0) || !(right > left && bottom > top)) { exclusions.offscreen++; continue; }
      if (typeof raw.content !== 'string' || /[\r\n]/.test(raw.content) || raw.content.startsWith('/') || (Number(raw.premium) & 6) || raw.yourpost || raw.deleted) { exclusions.special++; continue; }
      rows.push({ key: keyOf(raw), wireId: state.wires.get(keyOf(raw)) ?? null, originalText: raw.content, bounds: { x0, y0, x1, y1 }, mail: raw.mail || '' });
    }
    return { at: performance.now(), rows, exclusions, supported, renderingToScreen: pixi.renderingToScreen,
      lastObjectIsStage: pixi._lastObjectRendered === renderer.stage, screen: { width: screen.width, height: screen.height },
      canvas: { x: canvasBox.x, y: canvasBox.y, width: canvasBox.width, height: canvasBox.height, backingWidth: canvas.width, backingHeight: canvas.height }, clip: { left, top, right, bottom }, ancestors };
  }
  addEventListener('message', event => {
    const d = event.data; if (event.source !== window || d?.bridge !== 'danlingo-live-v1') return;
    if (d.type === 'control') state.controls.push({ enabled: d.enabled, at: performance.now() });
    if (d.type === 'snapshot') { state.snapshots.push(d); if (state.snapshots.length > 100) state.snapshots.shift(); }
    if (d.type === 'repair-scan' && d.scope === 'visible') {
      const scan = { scanId: d.scanId, requestedAt: performance.now() }; state.scans.push(scan);
      const renderer = state.discover(); if (!renderer) { scan.error = 'Native renderer not discovered'; return; }
      const pixi = renderer.pixiRenderer;
      const capture = () => {
        if (pixi.renderingToScreen !== true || pixi._lastObjectRendered !== renderer.stage) return;
        pixi.off('postrender', capture);
        try { scan.frame = snapshot(renderer); } catch (e) { scan.error = String(e); }
      };
      pixi.on('postrender', capture); setTimeout(() => pixi.off('postrender', capture), 1200);
    }
    if (d.type === 'repair-candidates' && d.scope === 'visible') {
      const scan = state.scans.find(s => s.scanId === d.scanId); if (scan) { scan.response = d; scan.respondedAt = performance.now(); }
    }
  });
}

try {
  server = createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', 'authorization,content-type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end('{}'); return; }
    try {
      assert.ok(report.requests.length < 40, 'Bounded 40 request budget');
      let body = ''; for await (const part of req) { body += part; assert.ok(body.length < 1000000); }
      const decoded = decodeTranslationFixtureRequest(JSON.parse(body));
      report.requests.push({ at: Date.now(), fixturePhase, items: decoded.items.map(i => ({ id: i.id, textSha256: hash(i.text) })) });
      // Deliberately fail only the loopback test service until genuine native
      // originals are visible. The website's comments and slots remain untouched.
      if (fixturePhase === 'unavailable') { res.writeHead(503); res.end('{"error":{"message":"Intentional loopback recovery fixture"}}'); return; }
      const reply = encodeTranslationFixtureResponse(decoded, decoded.items.map(i => ({ id: i.id, text: prefix + i.text })), { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 });
      res.setHeader('content-type', reply.contentType); res.end(reply.body);
    } catch (e) { res.writeHead(503); res.end('{}'); report.mockError = e.message; }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const extension = resolve(root, 'extension'); await cp(build, extension, { recursive: true });
  const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), 'http://127.0.0.1/*'])];
  await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest, null, 2));
  report.copiedNativeSha256 = hash(await readFile(resolve(extension, 'content-scripts/niconico-live-main.js'), 'utf8'));
  assert.equal(report.copiedNativeSha256, hash(await readFile(resolve(build, 'content-scripts/niconico-live-main.js'), 'utf8')));
  const { chromium } = await loadPlaywright();
  context = await chromium.launchPersistentContext(resolve(root, 'profile'), { ...browserLaunchOptions(browserName), headless: !args.includes('--headed'), locale: 'ja-JP', viewport: { width: 1440, height: 1000 },
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--autoplay-policy=no-user-gesture-required'] });
  watchdog = setTimeout(() => { report.timeLimit = true; void context.close(); }, 105000);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  options = await context.newPage(); await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  const rpc = payload => options.evaluate(payload => chrome.runtime.sendMessage(payload), payload);
  await options.locator('#key-state').waitFor();
  const settings = normalizeSettings({ ...DEFAULT_SETTINGS, enabled: false, endpoint, model: 'nico-visible-loopback', profile: 'chat-completions', thinkingEffort: 'default', liveSourceLanguage: 'ja', targetLanguage: 'zh-Hans', allowLocalHttp: true });
  assert.equal((await rpc({ type: 'save', settings, apiKey: 'visible-local-fixture-only', remember: false })).ok, true);
  page = await context.newPage(); await page.addInitScript(installObservation);
  const moduleTasks = [];
  page.on('response', response => {
    if (/^https:\/\/nicolive\.cdn\.nimg\.jp\/.*chunk\.comment-renderer[^/]*\.js$/.test(response.url())) moduleTasks.push((async () => {
      const body = await response.body(); report.modules.push({ url: response.url(), sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length });
      await writeFile(resolve(root, 'official-comment-renderer.js'), body);
    })().catch(e => { report.moduleCaptureError = e.message; }));
  });
  let room = roomArg;
  if (room === 'discover') {
    await page.goto('https://live.nicovideo.jp/', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForSelector('a[href*="/watch/lv"]', { timeout: 10000 });
    const links = await page.locator('a[href*="/watch/lv"]').evaluateAll(nodes => [...new Set(nodes.map(n => /\/watch\/(lv\d+)/.exec(n.href)?.[1]).filter(Boolean))]);
    report.discoveredRooms = links.slice(0, 25); room = links[0]; assert.match(room, /^lv\d+$/);
  }
  report.room = room;
  await page.goto('https://live.nicovideo.jp/watch/' + room, { waitUntil: 'domcontentloaded', timeout: 30000 });
  report.program = await page.evaluate(() => { const p = JSON.parse(document.getElementById('embedded-data')?.getAttribute('data-props') || '{}').program; return { id: p?.nicoliveProgramId, status: p?.status }; });
  assert.equal(report.program.id, room); assert.equal(report.program.status, 'ON_AIR');
  const play = page.getByRole('button', { name: '再生', exact: true }); if (await play.isVisible()) await play.click();
  await page.bringToFront();
  await page.waitForFunction(() => { const v = document.querySelector("[data-layer-name='videoLayer'] video"); return v && !v.paused && v.readyState >= 2 && v.videoWidth > 0 && window.__DL_VISIBLE_AUDIT__.discover(); }, null, { timeout: 25000 });
  report.liveWindowStartedAt = Date.now();
  assert.equal((await rpc({ type: 'toggle', enabled: true })).ok, true); await page.bringToFront();
  await page.waitForFunction(() => window.__DL_VISIBLE_AUDIT__.snapshots.some(s => s.playback?.contentActive && s.playback?.atLiveEdge && !s.playback?.paused), null, { timeout: 10000 });
  // Wait for the actual fallback setup before opening a menu. During initial
  // adapter/session attachment the production content UI may detach its host.
  const faultDeadline = Date.now() + 15000;
  while (!report.requests.some(r => r.fixturePhase === 'unavailable') && Date.now() < faultDeadline) await delay(100);
  assert.ok(report.requests.some(r => r.fixturePhase === 'unavailable'), 'A real comment must reach the unavailable loopback service');
  await delay(2500);
  await page.waitForFunction(() => {
    const renderer = window.__DL_VISIBLE_AUDIT__.discover();
    return renderer?.layerProcessorList.some(layer => layer.slotRepository?.stagingList?.some(slot => {
      const raw = slot.chat?.parsedOriginalChat ?? slot.chat;
      return typeof raw?.content === 'string' && raw.content.trim() && !raw.content.startsWith('/') && !(Number(raw.premium) & 6) && !raw.yourpost && slot.displayObject?.visible;
    }));
  }, null, { timeout: 15000 });
  await page.getByText('近期弹幕补翻', { exact: true }).click();
  await page.getByRole('button', { name: '补翻当前可见未译', exact: true }).waitFor({ state: 'visible', timeout: 5000 });
  report.fixtureRecovery = { unavailableResponses: report.requests.filter(r => r.fixturePhase === 'unavailable').length, recoveredAt: Date.now(),
    purpose: 'Real ordinary comments use native original fallback while the loopback service fails; recover the service before actual visible-repair UI clicks.' };
  fixturePhase = 'healthy';
  report.uiBeforeClick = await page.locator('#danlingo-live-repairs').evaluate(host => {
    const menu = host.shadowRoot.querySelector('.menu'), button = host.shadowRoot.querySelector('#visible-scan');
    const rect = button.getBoundingClientRect(), ancestry = [];
    for (let el = host; el; el = el.parentElement || el.getRootNode()?.host) {
      const css = getComputedStyle(el), box = el.getBoundingClientRect();
      ancestry.push({ tag: el.tagName, id: el.id, className: el.className, position: css.position, zIndex: css.zIndex, transform: css.transform, overflow: css.overflow,
        bounds: { x: box.x, y: box.y, width: box.width, height: box.height } });
    }
    return { popoverOpen: menu.matches(':popover-open'), buttonBounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, ancestry,
      hitElements: document.elementsFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2).slice(0, 5).map(el => ({ tag: el.tagName, id: el.id, className: el.className })) };
  });
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (!await page.getByRole('button', { name: '补翻当前可见未译', exact: true }).isVisible()) {
      (report.menuReopenedAt ||= []).push(Date.now());
      await page.getByText('近期弹幕补翻', { exact: true }).click();
    }
    const beforeUi = await page.locator('#danlingo-live-repairs').evaluate(host => [...host.shadowRoot.querySelectorAll('.entry')].map(el => ({ sourceId: el.dataset.sourceId, state: el.querySelector('.line span')?.textContent })));
    const clickedAt = Date.now();
    await page.getByRole('button', { name: '补翻当前可见未译', exact: true }).click({ timeout: 5000 });
    await delay(1600);
    const result = await page.evaluate(() => window.__DL_VISIBLE_AUDIT__.scans.at(-1));
    if (result?.response) report.scans.push({ ...result, beforeUi, clickedAt });
    const completed = await page.locator('#danlingo-live-repairs').evaluate(host => [...host.shadowRoot.querySelectorAll('.entry')].filter(el => el.querySelector('.line span')?.textContent === '已翻译').map(el => el.dataset.sourceId));
    if (result?.response?.candidates.some(c => !['已翻译', '排队中', '翻译中'].includes(beforeUi.find(r => r.sourceId === c.sourceId)?.state) && completed.includes(c.sourceId)
      && report.requests.some(r => r.fixturePhase === 'healthy' && r.at >= clickedAt && r.items.some(i => i.textSha256 === hash(protectText(c.originalText).text))))) break;
    await delay(1000);
  }
  await delay(1500);
  report.ui = await page.locator('#danlingo-live-repairs').evaluate(host => ({ note: host.shadowRoot.querySelector('#scan-note')?.textContent,
    entries: [...host.shadowRoot.querySelectorAll('.entry')].map(el => ({ sourceId: el.dataset.sourceId, state: el.querySelector('.line span')?.textContent, originalText: el.querySelector('.source')?.textContent, text: el.querySelector('.text')?.textContent })) }));
  await page.screenshot({ path: resolve(root, 'visible-repairs.png') });
  const observed = report.scans.filter(s => s.frame && s.response?.candidates?.length);
  for (const scan of observed) {
    scan.comparison = scan.response.candidates.map(c => { const matches = scan.frame.rows.filter(r => r.originalText === c.originalText && (r.key === c.sourceId || r.wireId === c.sourceId)); return { sourceId: c.sourceId, matches: matches.length, matchingBounds: matches.map(r => r.bounds) }; });
    scan.unreturnedVisible = scan.frame.rows.filter(r => !scan.response.candidates.some(c => c.originalText === r.originalText && (c.sourceId === r.key || c.sourceId === r.wireId))).length;
    scan.manualResultChains = scan.response.candidates.filter(c => !['已翻译', '排队中', '翻译中'].includes(scan.beforeUi.find(r => r.sourceId === c.sourceId)?.state))
      .filter(c => report.ui.entries.some(e => e.sourceId === c.sourceId && e.state === '已翻译' && e.text?.startsWith(prefix)))
      .map(c => ({ sourceId: c.sourceId, priorState: scan.beforeUi.find(r => r.sourceId === c.sourceId)?.state ?? 'absent',
        freshHttp: report.requests.some(r => r.fixturePhase === 'healthy' && r.at >= scan.clickedAt && r.items.some(i => i.textSha256 === hash(protectText(c.originalText).text))) }));
  }
  report.checks = { activeRealLive: report.program.status === 'ON_AIR', realPostrenderContract: observed.length > 0 && observed.every(s => s.frame.renderingToScreen && s.frame.lastObjectIsStage),
    candidatesHaveSameFrameIdentityAndBounds: observed.length > 0 && observed.every(s => s.comparison.every(c => c.matches > 0)),
    allObservedVisibleOrdinaryReturned: observed.length > 0 && observed.every(s => s.unreturnedVisible === 0),
    productionUiAction: report.scans.length > 0 && report.scans.every(s => s.response?.scanId === s.scanId),
    actualLoopbackRequest: report.requests.length > 0, recentUiMockTranslation: report.ui.entries.some(e => e.state === '已翻译' && e.text?.startsWith(prefix)),
    visibleUntranslatedToFreshHttpToRecentResult: observed.some(s => s.manualResultChains.some(c => c.freshHttp)),
    officialRendererCaptured: report.modules.length > 0 };
  report.status = Object.values(report.checks).every(Boolean) ? 'PASS' : 'INCOMPLETE';
  await rpc({ type: 'toggle', enabled: false }); await Promise.allSettled(moduleTasks);
} catch (e) { report.error = e.message; }
finally {
  clearTimeout(watchdog); if (page && !page.isClosed() && !report.ui) { report.pageState = await page.evaluate(() => ({ title: document.title, text: document.body.innerText.slice(0, 1000) })).catch(() => null); await page.screenshot({ path: resolve(root, 'incomplete.png') }).catch(() => {}); }
  await context?.close().catch(() => {}); if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  report.finishedAt = new Date().toISOString();
  // Retain geometric/source identity evidence without saving public chat bodies in JSON.
  const safe = JSON.stringify(report, (key, value) => ['originalText', 'text'].includes(key) && typeof value === 'string' ? { sha256: hash(value), length: value.length } : value, 2);
  await writeFile(resolve(root, 'report.json'), safe);
  console.log(JSON.stringify({ status: report.status, report: resolve(root, 'report.json'), room: report.room, checks: report.checks, error: report.error, scans: report.scans.length, requests: report.requests.length }));
  if (report.status !== 'PASS') process.exitCode = 1;
}
