import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Bounded synthetic YouTube regression for Trusted Types DOM writes and native repair-scan isolation.
// This imports the production native.ts/repairs.ts through scoped, read-only browser routes.
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { ROOM, watchHtml, chatHtml, chatAdd } from '../test/fixtures/youtube-native-chat.mjs';

const YOUTUBE = 'https://www.youtube.com';
const CSP = "require-trusted-types-for 'script'; trusted-types 'none'";
const MODULE_ROOT = '/__danlingo_trusted_types_modules__/';
const modulePath = relative => YOUTUBE + MODULE_ROOT + relative.replace(/\.ts$/u, '.js');
const delay = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node scripts/verify-youtube-trusted-types.mjs\nSynthetic CSP/Trusted Types + YouTube native bridge regression. No build, provider, account, or real YouTube traffic.');
  process.exit(0);
}
assert.equal(args.length, 0, 'Unsupported argument');

const base = resolve('.artifacts/live/youtube-trusted-types');
await mkdir(base, { recursive: true });
const runDir = await mkdtemp(resolve(base, 'run-'));
const reportPath = resolve(runDir, 'report.json');
const report = {
  capturedAt: new Date().toISOString(),
  runDir,
  status: 'running',
  evidence: 'SYNTHETIC_YOUTUBE_TRUSTED_TYPES_NATIVE_REPAIR_REGRESSION',
  sourceModule: 'src/platforms/youtube/native.ts',
  routePolicy: 'Only fixture HTML and scoped transpiled production modules are fulfilled; every other request aborts.',
  csp: CSP,
  checks: {},
  screenshots: [],
  blockedNetworkRequests: 0,
  pageErrors: 0,
  warningCount: 0,
  limitations: [
    'Synthetic YouTube watch/chat DOM and local browser module routes; does not prove real YouTube Polymer, provider, account, or extension-bundle behavior.',
    'The scan fault is injected only into the browser module prototype and is restored before the stop/heartbeat check.',
  ],
};
const persist = () => writeFile(reportPath, JSON.stringify(report, null, 2));
await persist();

const moduleSources = new Map();
const compiling = new Set();
const importPattern = /(?:\bfrom\s*|\bimport\s*)['"]([^'"]+\.ts)['"]/gu;
function resolveSourceImport(from, specifier) {
  return posix.normalize(posix.join(posix.dirname(from), specifier));
}
async function compileSource(relative) {
  if (moduleSources.has(relative)) return;
  if (compiling.has(relative)) return;
  compiling.add(relative);
  const source = await readFile(resolve(relative), 'utf8');
  const dependencies = [...source.matchAll(importPattern)].map(match => resolveSourceImport(relative, match[1]));
  for (const dependency of dependencies) await compileSource(dependency);
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    fileName: relative,
  }).outputText.replace(/(['"])(\.\.?\/[^'"]+\.ts)\1/gu, (_match, quote, specifier) => {
    const dependency = resolveSourceImport(relative, specifier);
    return quote + modulePath(dependency) + quote;
  });
  moduleSources.set(relative, output);
  compiling.delete(relative);
}
await compileSource('src/platforms/youtube/native.ts');
await compileSource('src/platforms/youtube/repairs.ts');

const moduleRoutes = new Map([...moduleSources].map(([relative, source]) => [new URL(modulePath(relative)).pathname, source]));
const moduleUrl = modulePath('src/platforms/youtube/native.ts');
const repairsUrl = modulePath('src/platforms/youtube/repairs.ts');

const moduleRouteFor = url => moduleRoutes.get(url.pathname);
const fixtureFor = url => {
  if (url.origin !== YOUTUBE) return null;
  if (url.pathname === '/watch' && url.searchParams.get('v') === ROOM) return watchHtml;
  if (url.pathname === '/live_chat' && (url.searchParams.get('continuation') === 'fixture-token' || url.searchParams.get('v') === ROOM)) return chatHtml;
  return null;
};
const waitFor = async (label, fn, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(40);
  }
  throw new Error(`Timed out: ${label}${lastError ? ` (${lastError.message})` : ''}`);
};
const jsonEvidence = page => page.evaluate(() => {
  const evidence = window.__YT_TRUSTED_TYPES_EVIDENCE__;
  return evidence ? structuredClone(evidence) : { snapshots: [], events: [], submitted: [], displayed: [] };
});
const frameOf = page => page.frames().find(frame => {
  try { return new URL(frame.url() || 'about:blank').pathname === '/live_chat'; } catch { return false; }
});
const frameState = async page => {
  const frame = frameOf(page);
  if (!frame) return null;
  return frame.evaluate(() => ({
    hooks: window.__YT_NATIVE_CHAT__?.hooks?.() || null,
    inserts: window.__YT_NATIVE_CHAT__?.observed?.inserts || [],
    rows: [...document.querySelectorAll('[data-fixture-id]')].map(row => ({ id: row.dataset.fixtureId, text: row.querySelector('#message')?.textContent || '' })),
  }));
};
const sendControl = (page, enabled = true) => page.evaluate(({ enabled }) => {
  window.postMessage({
    bridge: 'danlingo-live-v1', from: 'content', type: 'control', enabled,
    bufferMs: 300, targetLanguage: 'zh-Hans', sourceLanguage: 'auto', configVersion: 1,
    superChatTimeoutMs: 15000, youtubeTimeoutRetryEnabled: false,
    youtubeTimeoutRetryExtraMs: 1000, youtubeTimeoutRetryMode: 'hold',
  }, location.origin);
}, { enabled });
const sendPrepared = (page, session, sourceId, originalText, text) => page.evaluate(({ session, sourceId, originalText, text }) => {
  window.postMessage({
    bridge: 'danlingo-live-v1', from: 'content', type: 'prepared', platform: 'youtube',
    resourceId: 'DLnative001', adapterSession: session, sourceId, originalText, text,
    cached: false, preparedDelayMs: 0,
  }, location.origin);
}, { session, sourceId, originalText, text });

let browser;
let context;
let nativePage;
let repairsPage;
const warnings = [];
const pageErrors = [];
try {

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ ...browserLaunchOptions('chromium'), headless: true });
  context = await browser.newContext();
  context.on('page', page => {
    page.on('pageerror', () => { pageErrors.push(true); });
    page.on('console', message => {
      if (message.type() === 'warning' && message.text() === '[DanLingo] YouTube repair controls could not be updated; live collection remains active.') warnings.push(message.text());
    });
  });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    const fixture = fixtureFor(url);
    if (fixture !== null) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'content-security-policy': CSP }, body: fixture });
    const source = moduleRouteFor(url);
    if (url.origin === YOUTUBE && source !== undefined) return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: source });
    report.blockedNetworkRequests++;
    return route.abort();
  });
  await context.addInitScript(() => {
    if (window.top !== window) return;
    const evidence = { snapshots: [], events: [], submitted: [], displayed: [] };
    window.__YT_TRUSTED_TYPES_EVIDENCE__ = evidence;
    window.addEventListener('message', event => {
      if (event.source !== window || event.origin !== location.origin || event.data?.bridge !== 'danlingo-live-v1' || event.data?.from !== 'adapter') return;
      const data = event.data;
      if (data.type === 'snapshot') {
        const metrics = data.liveMetrics || {};
        evidence.snapshots.push({ at: Date.now(), connection: data.connection, adapterSession: data.adapterSession,
          resourceId: data.resourceId, presentationActive: data.presentationActive === true, reason: data.reason || '',
          observationMs: metrics.observationMs, received: metrics.received, submitted: metrics.submitted,
          presented: metrics.presented, translated: metrics.translated, pending: metrics.pending });
      } else if (data.type === 'events') {
        for (const item of Array.isArray(data.events) ? data.events : []) evidence.events.push({ sourceId: item.sourceId, originalText: item.originalText, translatable: item.translatable === true });
      } else if (data.type === 'submitted') evidence.submitted.push({ sourceId: data.sourceId, translated: data.translated === true, reason: data.reason });
      else if (data.type === 'displayed') evidence.displayed.push({ sourceId: data.sourceId, translated: data.translated === true });
    });
  });
  nativePage = await context.newPage({ viewport: { width: 1320, height: 850 } });
  await nativePage.goto(`${YOUTUBE}/watch?v=${ROOM}`, { waitUntil: 'domcontentloaded' });
  await waitFor('native fixture frame', () => frameOf(nativePage));
  const trustedTypes = await nativePage.evaluate(() => {
    const probe = document.createElement('div');
    try {
      probe.innerHTML = '<span>trusted-types-probe</span>';
      return { rejected: false, name: '', childCount: probe.childNodes.length };
    } catch (error) {
      return { rejected: true, name: error?.name || '', childCount: probe.childNodes.length };
    }
  });
  assert.equal(trustedTypes.rejected, true, 'browser must reject an innerHTML string under Trusted Types');
  assert.equal(trustedTypes.name, 'TypeError');
  report.checks.trustedTypesProbe = { status: 'PASS', rejected: true, errorName: trustedTypes.name };

  await nativePage.evaluate(async url => {
    const { startYoutubeLiveBridge } = await import(url);
    if (typeof startYoutubeLiveBridge !== 'function') throw new Error('native entry export missing');
    window.__YT_TRUSTED_TYPES_STOP__ = startYoutubeLiveBridge();
  }, moduleUrl);
  await sendControl(nativePage);
  const connected = await waitFor('native bridge connected', async () => {
    const evidence = await jsonEvidence(nativePage);
    const snapshot = [...evidence.snapshots].reverse().find(item => item.connection === 'connected' && item.presentationActive);
    const state = await frameState(nativePage);
    return snapshot && state?.hooks?.add && state.hooks.action && state.hooks.batch ? { evidence, snapshot } : false;
  });
  const baselineSession = connected.snapshot.adapterSession;
  assert.equal(typeof baselineSession, 'string');
  report.checks.nativeEntry = { status: 'PASS', sourceModule: 'src/platforms/youtube/native.ts', connected: true, hooksIntact: true };

  await nativePage.evaluate(async url => {
    const { YoutubeChatRepairs } = await import(url);
    window.__YT_TRUSTED_TYPES_SCAN_ORIGINAL__ = YoutubeChatRepairs.prototype.scan;
    YoutubeChatRepairs.prototype.scan = function () { throw new Error('fixture repair scan failure'); };
  }, repairsUrl);
  const faultStartedAt = Date.now();
  let keepalive = true;
  const keepaliveLoop = (async () => {
    while (keepalive) {
      await sendControl(nativePage);
      await delay(800);
    }
  })();
  try {
    const faultFrame = await waitFor('fault frame', () => frameOf(nativePage));
    const incoming = chatAdd('fault-safe', '新しい日本語コメント');
    await faultFrame.evaluate(action => window.__YT_NATIVE_CHAT__.add(action), incoming);
    const sourceEvent = await waitFor('fault-window source event', async () => (await jsonEvidence(nativePage)).events.find(item => item.sourceId === 'fault-safe'));
    const faultSession = (await jsonEvidence(nativePage)).snapshots.at(-1)?.adapterSession;
    assert.equal(faultSession, baselineSession, 'scan failures must not replace the live binding/session');
    await sendPrepared(nativePage, baselineSession, sourceEvent.sourceId, sourceEvent.originalText, '故障期间仍可呈现的译文');
    await waitFor('fault-window translated submission', async () => (await jsonEvidence(nativePage)).submitted.find(item => item.sourceId === 'fault-safe' && item.translated));
    await waitFor('fault-window native presentation', async () => {
      const state = await frameState(nativePage);
      return state?.rows?.find(row => row.id === 'fault-safe' && row.text === '故障期间仍可呈现的译文');
    });
    while (Date.now() - faultStartedAt < 7200) await delay(100);
  } finally {
    keepalive = false;
    await keepaliveLoop;
  }
  const faultEvidence = await jsonEvidence(nativePage);
  const faultSnapshots = faultEvidence.snapshots.filter(snapshot => snapshot.at >= faultStartedAt - 100 && snapshot.connection === 'connected');
  const snapshotTimes = faultSnapshots.map(snapshot => snapshot.at);
  const maxGapMs = snapshotTimes.slice(1).reduce((max, at, index) => Math.max(max, at - snapshotTimes[index]), 0);
  const spanMs = snapshotTimes.length ? snapshotTimes.at(-1) - snapshotTimes[0] : 0;
  assert.ok(faultSnapshots.length >= 15, `expected repeated connected snapshots, got ${faultSnapshots.length}`);
  assert.ok(spanMs >= 6000, `connected snapshot span ${spanMs}ms is too short`);
  assert.ok(maxGapMs <= 1400, `connected snapshot max gap ${maxGapMs}ms is too large`);
  assert.ok(faultSnapshots.every(snapshot => snapshot.adapterSession === baselineSession), 'scan fault changed binding/session');
  assert.ok(faultSnapshots.at(-1).observationMs >= 6000, 'native observation did not cross six seconds');
  assert.equal(warnings.length, 1, 'repair scan warning must be emitted once per binding');
  assert.equal(pageErrors.length, 0, 'repair scan isolation must not create unhandled page errors');
  report.warningCount = warnings.length;
  report.pageErrors = pageErrors.length;
  report.checks.scanFaultIsolation = { status: 'PASS', connectedSnapshots: faultSnapshots.length, connectedSpanMs: spanMs, maxGapMs,
    warningCount: warnings.length, pageErrors: pageErrors.length, bindingSessionStable: true, sourcePreparedPresented: true };

  await nativePage.evaluate(async url => {
    const { YoutubeChatRepairs } = await import(url);
    YoutubeChatRepairs.prototype.scan = window.__YT_TRUSTED_TYPES_SCAN_ORIGINAL__;
    delete window.__YT_TRUSTED_TYPES_SCAN_ORIGINAL__;
  }, repairsUrl);
  const recovered = await waitFor('repairs scan recovery', async () => {
    const state = await frameState(nativePage);
    const row = state?.rows?.find(item => item.id === 'fault-safe');
    if (!row) return false;
    const frame = frameOf(nativePage);
    return frame?.evaluate(() => {
      const item = document.querySelector('[data-fixture-id="fault-safe"]');
      const retry = item?.querySelector('[data-danlingo-retry]');
      const svg = retry?.querySelector(':scope > svg');
      return !!retry && svg?.namespaceURI === 'http://www.w3.org/2000/svg' && svg.querySelectorAll(':scope > path').length > 0;
    });
  });
  assert.equal(recovered, true);
  await delay(500);
  assert.equal(warnings.length, 1, 'scan recovery must not re-log the same binding warning');
  const beforeStop = (await jsonEvidence(nativePage)).snapshots.length;
  await nativePage.evaluate(() => { window.__YT_TRUSTED_TYPES_STOP__?.(); window.__YT_TRUSTED_TYPES_STOP__ = null; });
  await delay(800);
  const afterStop = (await jsonEvidence(nativePage)).snapshots.length;
  assert.ok(afterStop <= beforeStop + 1, `native heartbeat continued after stop (${beforeStop} -> ${afterStop})`);
  report.checks.stopHeartbeat = { status: 'PASS', snapshotsBeforeStop: beforeStop, snapshotsAfterStop: afterStop, noContinuedHeartbeat: true };

  repairsPage = await context.newPage({ viewport: { width: 900, height: 800 } });
  await repairsPage.goto(`${YOUTUBE}/live_chat?v=${ROOM}`, { waitUntil: 'domcontentloaded' });
  await waitFor('repairs fixture page', () => repairsPage.locator('yt-live-chat-item-list-renderer').count().then(count => count === 1));
  const iconResult = await repairsPage.evaluate(async repairsUrl => {
    const { YoutubeChatRepairs } = await import(repairsUrl);
    const list = document.querySelector('yt-live-chat-item-list-renderer');
    if (!list) throw new Error('fixture chat list missing');
    list.replaceChildren();
    const sent = [];
    const manager = new YoutubeChatRepairs({ doc: document, resourceId: 'DLnative001', active: () => true, eligible: () => true, timeoutMs: () => 15000, send: payload => sent.push(payload) });
    const row = document.createElement('yt-live-chat-text-message-renderer');
    row.data = { id: 'icon-smoke', message: { simpleText: '严格 CSP 下的普通原文' }, authorName: { simpleText: 'Fixture author' } };
    row.style.cssText = 'display:block;padding:10px;border:1px solid #444;margin:4px';
    const author = document.createElement('span'); author.className = 'author'; author.textContent = 'Fixture author';
    const body = document.createElement('span'); body.id = 'message'; body.textContent = row.data.message.simpleText;
    row.append(author, body); list.append(row);
    manager.scan();
    const buttonInfo = selector => {
      const button = row.querySelector(selector), svg = button?.querySelector(':scope > svg');
      return { label: button?.getAttribute('aria-label'), icon: svg?.dataset.danlingoIcon, namespace: svg?.namespaceURI,
        paths: [...(svg?.children || [])].map(path => path.getAttribute('d')).filter(Boolean) };
    };
    return { retry: buttonInfo('[data-danlingo-retry]'), original: buttonInfo('[data-danlingo-original]'),
      requestCount: sent.length, nativeText: row.data.message.simpleText, renderedText: body.textContent };
  }, repairsUrl);
  for (const button of [iconResult.retry, iconResult.original]) {
    assert.equal(button.namespace, 'http://www.w3.org/2000/svg');
    assert.ok(button.paths.length > 0 && button.paths.every(Boolean));
  }
  assert.equal(iconResult.retry.label, '强制重译');
  assert.equal(iconResult.original.label, '显示原文');
  assert.equal(iconResult.requestCount, 0, 'ordinary icon scan must not request translation');
  assert.equal(iconResult.nativeText, iconResult.renderedText);
  const screenshot = resolve(runDir, 'youtube-trusted-types-icons.png');
  await repairsPage.screenshot({ path: screenshot });
  report.screenshots.push(screenshot);
  report.checks.repairsIcons = { status: 'PASS', basicIconCreation: true, svgPathButtons: true,
    accessibleLabels: true, noExtraRequest: true, nativeMessageDataPreserved: true, screenshot };
  report.status = 'passed';
  await persist();
  console.log(JSON.stringify({ status: report.status, runDir, screenshot, checks: Object.keys(report.checks) }));
} catch (error) {
  report.status = 'failed';
  report.pageErrors = pageErrors.length;
  report.warningCount = warnings.length;
  report.failure = error?.message || String(error);
  await persist();
  throw error;
} finally {
  await Promise.allSettled([nativePage?.close(), repairsPage?.close()]);
  await context?.close();
  await browser?.close();
}
