import { browserLaunchOptions, loadPlaywright } from "../browser-runtime.mjs";
// Real Niconico LIVE + current production MAIN adapter; deterministic local prepared text only.
// No extension/background/provider acceptance is implied by this focused adapter experiment.
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import ts from 'typescript';
const watchId = process.argv[2];
const isEdge = process.argv.includes('--edge');
if (!/^lv\d+$/.test(watchId || '')) throw new Error('Expected active lv ID');
const root = resolve('.artifacts/live/l0/niconico', watchId, isEdge ? 'production-main-edge' : 'production-main'); await mkdir(root, { recursive: true });
const source = await readFile('src/platforms/niconico-live/native.ts', 'utf8');
const budgetSource = await readFile('src/core/live-budget.ts', 'utf8');
const compiled = ts.transpileModule(budgetSource + '\n' + source.replace(/^import .*live-budget.ts';\r?\n/m, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/^export /gm, '');
const { chromium } = await loadPlaywright();
const report = { capturedAt: new Date().toISOString(), watchId, sourceSha256: createHash('sha256').update(source).digest('hex'),
  evidence: 'REAL LIVE page + production MAIN code; deterministic prepared text, no Provider/extension background', browser: isEdge ? 'Edge' : 'Chromium', mediaFailures: [], errors: [] };
let context, page, closing = false;
try {
  context = await chromium.launchPersistentContext(await mkdtemp(resolve(root, 'profile-')), { headless: true,
    ...browserLaunchOptions(isEdge ? "edge" : "chromium"), viewport: { width: 1440, height: 1000 }, locale: 'ja-JP' });
  page = context.pages()[0] || await context.newPage();
  page.on('requestfailed', request => {
    const url = new URL(request.url());
    if (/dlive|delivery|domand/.test(url.hostname) && report.mediaFailures.length < 30) report.mediaFailures.push({ origin: url.origin, error: request.failure()?.errorText,
      at: new Date().toISOString(), duringCleanup: closing });
  });
  await page.addInitScript({ content: compiled + '\nwindow.__DL_PRODUCTION_STOP__ = startNiconicoLiveBridge();' });
  await page.addInitScript(() => {
    const s = window.__DL_PRODUCTION_EVIDENCE__ = { phase: 'startup', events: [], deliveries: [], snapshots: [], timers: [], wireCounts: {}, nativeCalls: [] };
    const originalDispatch = EventTarget.prototype.dispatchEvent;
    const dispatch = function(event) {
      if (event.type === 'onMessage' && event.detail?.message?.payload) {
        const p = event.detail.message.payload;
        const key = s.phase + ':' + (p.case === 'message' ? p.value?.data?.case : p.case);
        s.wireCounts[key] = (s.wireCounts[key] || 0) + 1;
      }
      return Reflect.apply(originalDispatch, this, [event]);
    };
    EventTarget.prototype.dispatchEvent = dispatch;
    s.stopProtocolObserver = () => { if (EventTarget.prototype.dispatchEvent === dispatch) EventTarget.prototype.dispatchEvent = originalDispatch; };
    window.addEventListener('message', event => {
      const d = event.data;
      if (event.source !== window || d?.bridge !== 'danlingo-live-v1' || d.from !== 'adapter') return;
      if (d.type === 'snapshot') { if (s.snapshots.length < 120) s.snapshots.push({ ...d, phase: s.phase }); s.latest = d; }
      if (d.type === 'delivered' && s.deliveries.length < 600) s.deliveries.push({ ...d, phase: s.phase });
      if (d.type === 'events') for (const item of d.events) {
        if (s.events.length >= 600) continue;
        const row = { ...item, phase: s.phase, adapterSession: d.adapterSession }; s.events.push(row);
        s.timers.push(setTimeout(() => window.postMessage({ bridge: 'danlingo-live-v1', from: 'content', type: 'prepared', platform: 'niconico',
          resourceId: d.resourceId, adapterSession: d.adapterSession, sourceId: item.sourceId, originalText: item.originalText,
          text: '译·' + item.originalText }, location.origin), s.phase === 'on-time' ? 50 : 1500));
      }
    });
  });
  await page.goto('https://live.nicovideo.jp/watch/' + watchId, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(17000);
  report.program = await page.evaluate(() => {
    const p = JSON.parse(document.getElementById('embedded-data')?.getAttribute('data-props') || '{}').program;
    return p && { id: p.nicoliveProgramId, title: p.title, status: p.status, vposBaseTime: p.vposBaseTime };
  });
  if (report.program?.status !== 'ON_AIR') throw new Error('Room not ON_AIR');
  const play = page.getByRole('button', { name: '再生', exact: true }); if (await play.isVisible()) await play.click();
  await page.waitForFunction(() => {
    const v = document.querySelector("[data-layer-name='videoLayer'] video");
    return v && !v.paused && !v.seeking && !v.ended && v.readyState >= 2;
  }, undefined, { timeout: 15000 }).catch(() => { throw new Error('Actual program video did not become ready within 15s (no ad-video fallback)'); });
  report.before = await page.evaluate(() => {
    const s = window.__DL_PRODUCTION_EVIDENCE__;
    for (const el of document.querySelectorAll('div[id^="renderer-parent-id-"]')) {
      const k = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
      for (let f = k && el[k], i = 0; f && i < 20; f = f.return, i++) if (f.stateNode?.addToRender && f.stateNode.renderer?.layerProcessorList) {
        s.native = f.stateNode;
        const rawAdd = s.native.addToRender, descriptor = Object.getOwnPropertyDescriptor(s.native, 'addToRender');
        const observer = function(chat, ...rest) {
          if (s.nativeCalls.length < 400) {
            const v = document.querySelector("[data-layer-name='videoLayer'] video");
            s.nativeCalls.push({ phase: s.phase, at: performance.now(), no: chat?.no, textLength: chat?.content?.length,
              multiline: /[\r\n]/u.test(chat?.content || ''), slash: chat?.content?.startsWith('/'), mail: chat?.mail,
              premium: chat?.premium, yourpost: chat?.yourpost, deleted: chat?.deleted, dateFinite: Number.isFinite(chat?.date),
              vposFinite: Number.isFinite(chat?.vpos), hidden: document.hidden, readyState: v?.readyState, seeking: v?.seeking, paused: v?.paused });
          }
          return Reflect.apply(rawAdd, this, [chat, ...rest]);
        };
        s.native.addToRender = observer; s.originalAdd = observer; s.originalDispatch = EventTarget.prototype.dispatchEvent;
        s.stopInputObserver = () => { if (s.native.addToRender === observer) { if (descriptor) Object.defineProperty(s.native, 'addToRender', descriptor); else delete s.native.addToRender; } };
        s.originalFilters = s.native.renderer.layerProcessorList.map(l => l.getStagingFilterNameList());
        return { found: true, filters: s.originalFilters };
      }
    }
    return { found: false };
  });
  if (!report.before.found) throw new Error('Native renderer absent');
  await page.evaluate(() => {
    const s = window.__DL_PRODUCTION_EVIDENCE__; s.phase = 'on-time';
    s.control = () => window.postMessage({ bridge: 'danlingo-live-v1', from: 'content', type: 'control', enabled: true, bufferMs: 500 }, location.origin);
    s.control(); s.heartbeat = setInterval(s.control, 1000);
  });
  await page.waitForFunction(() => window.__DL_PRODUCTION_EVIDENCE__.deliveries.some(d => d.translated), undefined, { timeout: 18000 });
  await page.waitForTimeout(900); await page.screenshot({ path: resolve(root, 'on-time-native.png') });
  await page.waitForTimeout(4000);
  await page.evaluate(() => { window.__DL_PRODUCTION_EVIDENCE__.phase = 'late'; });
  await page.waitForTimeout(6500);
  await page.evaluate(() => { const s = window.__DL_PRODUCTION_EVIDENCE__; s.phase = 'lease-expiry'; clearInterval(s.heartbeat); });
  await page.waitForTimeout(7500);
  report.observation = await page.evaluate(() => {
    const s = window.__DL_PRODUCTION_EVIDENCE__;
    for (const timer of s.timers) clearTimeout(timer);
    return { events: s.events, deliveries: s.deliveries, snapshots: s.snapshots, wireCounts: s.wireCounts, nativeCalls: s.nativeCalls,
      restored: { input: s.native.addToRender === s.originalAdd, dispatcher: EventTarget.prototype.dispatchEvent === s.originalDispatch,
        filters: JSON.stringify(s.originalFilters) === JSON.stringify(s.native.renderer.layerProcessorList.map(l => l.getStagingFilterNameList())) } };
  });
  const o = report.observation, events = new Map(o.events.map(e => [e.sourceId, e]));
  const onTime = o.deliveries.filter(d => events.get(d.sourceId)?.phase === 'on-time');
  const late = o.deliveries.filter(d => events.get(d.sourceId)?.phase === 'late');
  report.checks = { realNativeTranslation: onTime.some(d => d.translated), lateFallsBack: late.length > 0 && late.every(d => !d.translated),
    uniqueDeliveries: new Set(o.deliveries.map(d => d.adapterSession + ':' + d.sourceId)).size === o.deliveries.length,
    leaseInputRestore: o.restored.input, leaseFilterRestore: o.restored.filters, leaseProtocolRestore: o.restored.dispatcher,
    liveStateVerified: o.snapshots.some(s => s.playback.contentActive && !s.playback.paused && s.playback.atLiveEdge) };
  report.result = Object.values(report.checks).every(Boolean) ? 'PASS-production-MAIN-real-page-local-prepared-only' : 'INCOMPLETE';
  if (report.result === 'INCOMPLETE') process.exitCode = 1;
} catch (error) {
  report.errors.push(String(error.message).slice(0, 500)); process.exitCode = 1;
  if (page) report.failureState = await page.evaluate(() => {
    const s = window.__DL_PRODUCTION_EVIDENCE__;
    return { phase: s?.phase, events: s?.events, deliveries: s?.deliveries, snapshots: s?.snapshots, wireCounts: s?.wireCounts, nativeCalls: s?.nativeCalls,
      hidden: document.hidden, visibilityState: document.visibilityState,
      liveControls: [...document.querySelectorAll('[data-live-status]')].map(e => e.getAttribute('data-live-status')),
      mainVideo: [...document.querySelectorAll("[data-layer-name='videoLayer'] video")].map(v => ({ paused: v.paused, ended: v.ended, readyState: v.readyState, currentTime: v.currentTime })) };
  }).catch(() => null);
}
finally {
  if (page) await page.evaluate(() => {
    const s = window.__DL_PRODUCTION_EVIDENCE__; clearInterval(s?.heartbeat); window.__DL_PRODUCTION_STOP__?.();
    s?.stopInputObserver?.(); s?.stopProtocolObserver?.();
  }).catch(() => {});
  closing = true;
  await context?.close();
  await writeFile(resolve(root, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(resolve(root, 'run-' + report.capturedAt.replace(/[:.]/g, '-') + '.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ report: resolve(root, 'report.json'), result: report.result, checks: report.checks,
  events: report.observation?.events.length, deliveries: report.observation?.deliveries.length, errors: report.errors }, null, 2));
