import { browserLaunchOptions, loadPlaywright } from "../browser-runtime.mjs";
// Anonymous, isolated Niconico LIVE L0 source/runtime inspection. No Provider/account stores.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installWireObserver, attachNativeExperiment } from './niconico-live-native.mjs';

const watchId = process.argv[2] || 'discover';
const verify = process.argv.includes('--verify');
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error('Missing ' + name);
  return process.argv[index + 1];
};
const browserName = option('--browser', 'chromium');
const observeMs = Number(option('--observe-ms', watchId === 'discover' ? '4000' : '30000'));
if (!['chromium', 'edge'].includes(browserName) || !Number.isFinite(observeMs) || observeMs < 1000 || observeMs > 60000) throw new Error('Invalid browser or observation duration');
if (watchId !== 'discover' && !/^lv\d+$/.test(watchId)) throw new Error('Expected discover or lv watch ID');
const base = resolve('.artifacts/live/goals/g3/discovery');
await mkdir(base, { recursive: true });
const root = await mkdtemp(resolve(base, browserName + '-' + watchId + '-'));
await mkdir(resolve(root, 'sources'), { recursive: true });
const profile = await mkdtemp(resolve(root, 'profile-'));
const { chromium } = await loadPlaywright();
const report = { capturedAt: new Date().toISOString(), watchId, browserName, observeMs, evidence: 'real-anonymous-live-page; no extension or Provider; optional L0 marker is not product acceptance', modules: [], requests: [], websocket: [], errors: [] };
const cleanUrl = raw => { try {
  const u = new URL(raw);
  // Message/media paths can contain short-lived anonymous session capabilities as well as query tokens.
  const path = /(?:dwango|dmc|domand|delivery)/.test(u.hostname)
    ? u.pathname.split('/').map(s => !s || /^(?:api|v\d+|view|segment|backward|playlist|master\.m3u8)$/.test(s) ? s : '[opaque]').join('/')
    : u.pathname.replace(/[A-Za-z0-9_=-]{48,}/g, '[opaque]');
  return u.origin + path;
} catch { return ''; } };
let context, page;
const pending = new Set();
try {
  context = await chromium.launchPersistentContext(profile, {
    ...browserLaunchOptions(browserName),
    headless: true, viewport: { width: 1440, height: 1000 }, locale: 'ja-JP',
  });
  report.browserVersion = context.browser()?.version();
  page = context.pages()[0] || await context.newPage();
  if (watchId !== 'discover') await page.addInitScript(installWireObserver);
  page.on('pageerror', error => report.errors.push(error.message.slice(0, 200)));
  page.on('request', req => {
    if (/live2?|dwango|nimg/.test(new URL(req.url()).hostname)) report.requests.push({ url: cleanUrl(req.url()), method: req.method(), resource: req.resourceType() });
  });
  page.on('websocket', ws => {
    const row = { url: cleanUrl(ws.url()), frames: [], openedAt: Date.now() }; report.websocket.push(row);
    ws.on('close', () => { row.closedAt = Date.now(); });
    ws.on('socketerror', () => { row.socketErrorObserved = true; });
    ws.on('framereceived', event => {
      if (row.frames.length >= 100) return;
      if (typeof event.payload !== 'string') { row.frames.push({ binary: true, bytes: event.payload.length }); return; }
      try {
        const data = JSON.parse(event.payload);
        const info = { type: data.type, dataKeys: Object.keys(data.data || {}), receivedAt: Date.now() };
        // Persist enum-like protocol diagnostics only, never arbitrary capability-bearing payloads.
        if (['disconnect', 'error'].includes(data.type)) {
          for (const key of ['reason', 'code']) {
            const value = data.data?.[key];
            if (typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)) info[key] = value;
          }
        }
        for (const name of ['currentMs', 'begin', 'end', 'vposBaseTime', 'hashedUserId', 'serverTime']) {
          if (name === 'hashedUserId') continue;
          if (data.data?.[name] != null) info[name] = data.data[name];
        }
        for (const name of ['viewUri', 'uri']) if (data.data?.[name]) info[name] = cleanUrl(data.data[name]);
        row.frames.push(info);
      } catch { row.frames.push({ nonJson: true, bytes: event.payload.length }); }
    });
  });
  page.on('response', response => {
    const url = new URL(response.url());
    if (!/(?:^|\.)(?:nimg\.jp|nicovideo\.jp)$/.test(url.hostname) || !url.pathname.endsWith('.js')) return;
    const operation = (async () => {
      const source = await response.body();
      const hash = createHash('sha256').update(source).digest('hex');
      const file = hash.slice(0, 12) + '-' + basename(url.pathname);
      await writeFile(resolve(root, 'sources', file), source);
      report.modules.push({ url: cleanUrl(response.url()), file, sha256: hash, bytes: source.length });
    })().catch(error => report.errors.push('Source capture: ' + error.message.slice(0, 100)));
    pending.add(operation); void operation.finally(() => pending.delete(operation));
  });
  await page.goto(watchId === 'discover' ? 'https://live.nicovideo.jp/' : 'https://live.nicovideo.jp/watch/' + watchId, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(observeMs);
  if (verify) {
    report.liveEligibility = await page.evaluate(() => {
      const embedded = JSON.parse(document.getElementById('embedded-data')?.getAttribute('data-props') || '{}');
      return { programId: embedded.program?.nicoliveProgramId, status: embedded.program?.status, pathname: location.pathname, hasSeekQuery: new URL(location.href).searchParams.has('from') };
    });
    if (report.liveEligibility.status !== 'ON_AIR' || report.liveEligibility.programId !== watchId || report.liveEligibility.hasSeekQuery) throw new Error('Selected room is not an active default LIVE watch page');
    const play = page.getByRole('button', { name: '再生', exact: true });
    if (await play.isVisible()) await play.click();
    report.attachment = await page.evaluate(attachNativeExperiment);
    if (!report.attachment.found) throw new Error('Native pre-measurement input/staging interface not found');
    await page.evaluate(() => { window.__DL_NL_WIRE__.phase = 'enabled'; });
    await page.waitForTimeout(10000);
    await page.screenshot({ path: resolve(root, 'native-marker.png') });
    await page.evaluate(() => { window.__DL_NL_NATIVE__.disable(); window.__DL_NL_WIRE__.phase = 'disabled'; });
    await page.waitForTimeout(3500);
    report.native = await page.evaluate(() => window.__DL_NL_NATIVE__.stop());
    const n = report.native;
    report.nativeChecks = { receivedRealComments: n.rows.length > 0, boundedQueue: n.maxQueued <= 17 && n.queueSize === 0,
      releasedOnce: n.rows.length > 0 && n.rows.every(r => r.releaseCalls === 1), originalInputsPreserved: n.rows.length > 0 && n.rows.every(r => r.originalPreserved),
      preMeasurementReplacement: n.measurements.length > 0 && n.staged.some(s => s.marked && s.createdSlot),
      stylesPreserved: n.staged.filter(s => s.marked).every(s => s.stylePreserved),
      filtersRestored: JSON.stringify(n.nativeFiltersBefore) === JSON.stringify(n.nativeFiltersNow), inputRestored: n.inputMethodRestored,
      postDisableOriginal: n.staged.some(s => s.phase === 'disabled' && !s.marked && s.text === s.original) };
    report.nativeResult = Object.values(report.nativeChecks).every(Boolean) ? 'PASS-L0-native-marker-only' : 'INCOMPLETE';
    if (report.nativeResult === 'INCOMPLETE') process.exitCode = 1;
  }
  if (watchId !== 'discover') report.protocol = await page.evaluate(() => {
    const s = window.__DL_NL_WIRE__; s.stop();
    return { messages: s.messages, counts: s.counts, originalsPreserved: s.originals.every(row => row.chat.content === row.content && row.chat.vpos === row.vpos) };
  });
  report.page = await page.evaluate(() => {
    const result = {
      title: document.title, text: document.body.innerText.slice(0, 14000),
      liveLinks: [...document.querySelectorAll('a[href]')].map(a => ({ href: a.href.split('?')[0], text: a.textContent?.trim().slice(0, 150) })).filter(a => /\/watch\/lv\d+$/.test(a.href)),
      videos: [...document.querySelectorAll('video')].map(v => ({ currentTime: v.currentTime, paused: v.paused, readyState: v.readyState, width: v.videoWidth, duration: Number.isFinite(v.duration) ? v.duration : null })),
      canvas: [...document.querySelectorAll('canvas')].map(c => ({ width: c.width, height: c.height, class: c.className, parentClass: c.parentElement?.className })),
      globals: Object.keys(window).filter(k => /webpack|nico|player|comment/i.test(k)),
      buttons: [...document.querySelectorAll('button')].map(b => ({ text: b.textContent?.trim().slice(0, 60), aria: b.getAttribute('aria-label'), title: b.title })),
      embeddedKeys: [], program: null, react: [],
    };
    const embed = document.getElementById('embedded-data');
    if (embed) try {
      const data = JSON.parse(embed.getAttribute('data-props') || embed.textContent || '{}');
      result.embeddedKeys = Object.keys(data);
      const p = data.program;
      if (p) result.program = Object.fromEntries(['nicoliveProgramId', 'title', 'status', 'beginTime', 'endTime', 'openTime', 'vposBaseTime', 'stream', 'isPayProgram', 'providerType'].filter(k => k in p).map(k => [k, k === 'stream' ? Object.keys(p[k] || {}) : p[k]]));
    } catch {}
    const visited = new Set();
    for (const element of document.querySelectorAll('canvas,video')) {
      let parent = element;
      for (let depth = 0; parent && depth < 6; depth++, parent = parent.parentElement) {
        const key = Object.keys(parent).find(k => /^__react(?:Fiber|InternalInstance)\$/.test(k));
        let fiber = key && parent[key];
        for (let i = 0; fiber && i < 35; i++, fiber = fiber.return) {
          if (visited.has(fiber)) continue; visited.add(fiber);
          const objectKeys = object => object && typeof object === 'object' ? Object.keys(object).slice(0, 60) : [];
          result.react.push({ element: element.tagName, depth: i, type: typeof fiber.type === 'string' ? fiber.type : fiber.type?.displayName || fiber.type?.name,
            propKeys: objectKeys(fiber.memoizedProps), stateKeys: objectKeys(fiber.memoizedState), instanceType: fiber.stateNode?.constructor?.name, instanceKeys: objectKeys(fiber.stateNode),
            methods: fiber.stateNode && Object.getOwnPropertyNames(Object.getPrototypeOf(fiber.stateNode)).filter(k => k !== 'constructor').slice(0, 70),
          });
        }
      }
    }
    return result;
  });
  await page.screenshot({ path: resolve(root, 'page.png') });
} catch (error) { report.errors.push(String(error.stack || error).slice(0, 1000)); process.exitCode = 1; }
finally {
  await Promise.allSettled([...pending]);
  await context?.close();
  await writeFile(resolve(root, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(resolve(root, 'run-' + report.capturedAt.replace(/[:.]/g, '-') + '.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ report: resolve(root, 'report.json'), title: report.page?.title, program: report.page?.program, liveLinks: report.page?.liveLinks.slice(0, 30), modules: report.modules.length, websocket: report.websocket, nativeResult: report.nativeResult, nativeChecks: report.nativeChecks, protocolCounts: report.protocol?.counts, errors: report.errors }, null, 2));
