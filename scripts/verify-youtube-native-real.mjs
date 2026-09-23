import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Production bundle + genuine anonymous YouTube chat + loopback mock only.
// This script never builds, reads a personal profile/key, or contacts a real provider.
import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/core/config.ts';
import { decodeTranslationFixtureRequest, encodeTranslationFixtureResponse } from './translation-protocol-fixture.mjs';

export function parseArgs(args) {
  const values = {}, flags = new Set();
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (['--help', '--headed', '--check-args'].includes(name)) { assert.ok(!flags.has(name), 'Duplicate flag'); flags.add(name); continue; }
    assert.ok(['--url', '--seconds', '--browser'].includes(name) && !Object.hasOwn(values, name), 'Unknown or duplicate option');
    const value = args[++index]; assert.ok(value && !value.startsWith('--'), 'Option requires a value'); values[name] = value;
  }
  if (flags.has('--help')) return { help: true };
  assert.ok(values['--url'], 'An explicit --url is required');
  let url; try { url = new URL(values['--url']); } catch { throw new Error('Invalid watch URL'); }
  assert.ok(url.origin === 'https://www.youtube.com' && url.pathname === '/watch' && /^[\w-]{11}$/.test(url.searchParams.get('v')) &&
    !url.username && !url.password, 'An exact https://www.youtube.com/watch?v=VIDEO_ID URL is required');
  const seconds = Number(values['--seconds'] || '30'), browser = values['--browser'] || 'edge';
  assert.ok(Number.isInteger(seconds) && seconds >= 20 && seconds <= 60, '--seconds must be 20..60');
  assert.ok(['edge', 'chromium'].includes(browser), '--browser must be edge or chromium');
  return { url: `https://www.youtube.com/watch?v=${url.searchParams.get('v')}`, seconds, browser, headed: flags.has('--headed'), checkArgs: flags.has('--check-args') };
}

// The page retains the temporary ID ledger. Only snapshot() aggregates cross the
// browser boundary; no chat text, author, action, token or message ID is exported.
export function installNativeEvidence() {
  if (window.top !== window) return;
  let admitting = false, started = 0, ended = 0, sequence = 0, lastSubmitted = 0;
  let baseline = null, observer = null, activeSnapshot = false, latest = null;
  const rows = new Map(), bySource = new Map();
  const totals = { received: 0, eligible: 0, prepared: 0, submitted: 0, submittedTranslated: 0, displayedAcknowledgements: 0,
    nativePresented: 0, nativeMockPresented: 0, nativeOriginalPresented: 0, acknowledgedNativeMock: 0, removed: 0,
    duplicateSources: 0, duplicateSubmitted: 0, duplicateDisplayed: 0, submissionOrderViolations: 0, visibleAtSource: 0,
    sourceBeforePreparedViolations: 0, displayedWithoutSubmitted: 0, ledgerOverload: 0, observerErrors: 0, nativeIdentityChanges: 0 };
  const delays = [];
  const key = (session, id) => `${session}\u0000${id}`;
  const dataOf = row => row?.polymerController?.data || row?.inst?.data || row?.data;
  function nativeRows() {
    if (!baseline || baseline.frame.contentDocument !== baseline.doc || !baseline.element.isConnected) return [];
    return [...baseline.element.querySelectorAll('yt-live-chat-text-message-renderer')].slice(-2000);
  }
  function inspect() {
    try {
      if (!baseline) return;
      if (baseline.frame.contentDocument !== baseline.doc || !baseline.element.isConnected) { totals.nativeIdentityChanges = 1; return; }
      for (const element of nativeRows()) {
        const data = dataOf(element);
        if (!data?.id || !element.getClientRects().length) continue;
        const match = bySource.get(data.id);
        const text = element.querySelector('#message')?.textContent;
        if (!match || match.native || typeof text !== 'string') continue;
        const marker = text.includes('【DL MOCK】');
        // Data and actual #message DOM must agree on the local marker.
        const message = data.message;
        const dataText = typeof message?.simpleText === 'string' ? message.simpleText : (message?.runs || []).map(run => typeof run.text === 'string' ? run.text : '').join('');
        if (marker !== dataText.includes('【DL MOCK】')) continue;
        match.native = true; match.marker = marker; totals.nativePresented++;
        if (marker) { totals.nativeMockPresented++; if (!match.prepared) totals.sourceBeforePreparedViolations++; }
        else totals.nativeOriginalPresented++;
        delays.push(Math.max(0, performance.now() - match.at));
        if (marker && match.displayed) totals.acknowledgedNativeMock++;
      }
    } catch { totals.observerErrors++; }
  }
  function snapshot() {
    inspect();
    const sorted = [...delays].sort((a, b) => a - b);
    const percentile = p => sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : null;
    const admitted = [...rows.values()];
    return { ...totals, activeSnapshot, inputElapsedMs: Math.max(0, (ended || performance.now()) - started),
      pendingSubmission: admitted.filter(row => !row.submitted && !row.removed).length,
      unpresented: admitted.filter(row => row.submitted && !row.native && !row.removed).length,
      endToEnd: admitted.filter(row => row.prepared && row.submitted && row.displayed && row.native && row.marker).length,
      nativeDelayMs: { p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), samples: sorted.length }, latest };
  }
  window.addEventListener('message', event => {
    try {
      if (event.source !== window || event.origin !== location.origin) return;
      const d = event.data;
      if (d?.bridge !== 'danlingo-live-v1' || d.platform !== 'youtube') return;
      if (d.from === 'adapter' && d.type === 'snapshot') {
        activeSnapshot = d.presentationActive === true && d.connection === 'connected';
        const counts = {};
        for (const name of ['received', 'submitted', 'presented', 'translated', 'original', 'timedOut', 'overloaded', 'removed', 'abandoned', 'pending', 'translatedChars', 'cachedTranslated']) {
          const value = d.liveMetrics?.[name]; counts[name] = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
        }
        latest = { presentationActive: d.presentationActive === true, connected: d.connection === 'connected',
          nativeEntryUnavailable: d.reason === 'native-chat-entry-unavailable', chatHidden: d.reason === 'chat-hidden', counts };
        return;
      }
      if (d.from === 'adapter' && d.type === 'events') {
        for (const id of Array.isArray(d.removes) ? d.removes : []) {
          const row = rows.get(key(d.adapterSession, id));
          if (row && !row.removed) { row.removed = true; totals.removed++; }
        }
        if (!admitting) return;
        for (const source of Array.isArray(d.events) ? d.events : []) {
          if (typeof source.sourceId !== 'string') continue;
          const id = key(d.adapterSession, source.sourceId);
          if (rows.has(id)) { totals.duplicateSources++; continue; }
          if (rows.size >= 10000) { totals.ledgerOverload++; continue; }
          const row = { id: source.sourceId, at: performance.now(), order: ++sequence, eligible: source.translatable === true };
          rows.set(id, row); bySource.set(source.sourceId, row); totals.received++; if (row.eligible) totals.eligible++;
          if (row.eligible && nativeRows().some(element => dataOf(element)?.id === source.sourceId)) totals.visibleAtSource++;
        }
        return;
      }
      const row = rows.get(key(d.adapterSession, d.sourceId));
      if (!row) return;
      if (d.from === 'content' && d.type === 'prepared') { if (!row.prepared) { row.prepared = true; totals.prepared++; } }
      if (d.from === 'adapter' && d.type === 'submitted') {
        if (row.submitted) { totals.duplicateSubmitted++; return; }
        row.submitted = true; totals.submitted++; if (d.translated === true) totals.submittedTranslated++;
        if (row.order < lastSubmitted) totals.submissionOrderViolations++;
        lastSubmitted = Math.max(lastSubmitted, row.order); inspect();
      }
      if (d.from === 'adapter' && d.type === 'displayed') {
        if (row.displayed) { totals.duplicateDisplayed++; return; }
        row.displayed = true; totals.displayedAcknowledgements++;
        if (!row.submitted) totals.displayedWithoutSubmitted++;
        if (row.native && row.marker) totals.acknowledgedNativeMock++;
        inspect();
      }
    } catch { totals.observerErrors++; }
  });
  window.__DL_NATIVE_REAL_EVIDENCE__ = {
    bind() {
      const room = new URL(location.href).searchParams.get('v'), player = document.querySelector('#movie_player');
      if (player?.getVideoData?.()?.video_id !== room) return false;
      let budget = 5000;
      const find = (value, depth = 0) => {
        if (!value || typeof value !== 'object' || depth > 24 || --budget < 0) return null;
        if (value.liveChatRenderer) return value.liveChatRenderer;
        for (const child of Object.values(value)) { const result = find(child, depth + 1); if (result) return result; }
        return null;
      };
      const watch = document.querySelector('ytd-watch-flexy');
      const root = find(watch?.data) || find(window.ytInitialData);
      const token = root?.continuations?.find(value => value.reloadContinuationData)?.reloadContinuationData?.continuation;
      for (const frame of document.querySelectorAll('ytd-live-chat-frame iframe')) {
        try {
          const url = new URL(frame.contentWindow.location.href), explicit = url.searchParams.get('v');
          if (url.origin !== location.origin || url.pathname !== '/live_chat' || !(explicit ? explicit === room : token && url.searchParams.get('continuation') === token)) continue;
          const doc = frame.contentDocument, element = doc?.querySelector('yt-live-chat-item-list-renderer');
          const owner = [element?.polymerController, element?.inst, element].find(value => value &&
            ['handleAddChatItemAction_', 'handleLiveChatAction_', 'handleLiveChatActions_'].every(name => typeof value[name] === 'function'));
          if (!owner) continue;
          const methods = ['handleAddChatItemAction_', 'handleLiveChatAction_', 'handleLiveChatActions_'].map(name => ({ name, fn: owner[name], own: Object.getOwnPropertyDescriptor(owner, name) }));
          baseline = { frame, doc, element, owner, methods };
          observer = new MutationObserver(inspect); observer.observe(element, { childList: true, subtree: true, characterData: true });
          return true;
        } catch { /* No arbitrary frame access or fallback binding. */ }
      }
      return false;
    },
    begin() { admitting = true; started = performance.now(); },
    end() { admitting = false; ended = performance.now(); },
    snapshot,
    restoration() {
      if (!baseline) return { identityCurrent: false, functionsRestored: false, descriptorsRestored: false };
      const identityCurrent = baseline.frame.contentDocument === baseline.doc && baseline.element.isConnected;
      const functionsRestored = baseline.methods.every(row => baseline.owner[row.name] === row.fn);
      const descriptorsRestored = baseline.methods.every(row => {
        const current = Object.getOwnPropertyDescriptor(baseline.owner, row.name);
        if (!row.own) return !current;
        return !!current && ['value', 'get', 'set', 'writable', 'configurable', 'enumerable'].every(name => current[name] === row.own[name]);
      });
      return { identityCurrent, functionsRestored, descriptorsRestored };
    },
    stop() { admitting = false; observer?.disconnect(); },
  };
}

async function digestBuild(root) {
  const hash = createHash('sha256'); let files = 0;
  async function visit(dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) { hash.update(relative(root, path).replaceAll('\\', '/') + '\0'); hash.update(await readFile(path)); files++; }
    }
  }
  await visit(root); return { files, sha256: hash.digest('hex') };
}

export async function main(args) {
  const config = parseArgs(args);
  if (config.help) { console.log('node --experimental-strip-types scripts/verify-youtube-native-real.mjs --url https://www.youtube.com/watch?v=VIDEO_ID [--seconds 20..60] [--browser edge|chromium] [--headed] [--check-args]\nDefault: Edge, 30-second genuine chat window, then disable and drain 6 seconds. Isolated production extension + local mock only. No real provider, personal profile, chat posting, moderation, screenshots, traces or media-health acceptance.'); return; }
  if (config.checkArgs) { console.log(JSON.stringify({ valid: true, browser: config.browser, seconds: config.seconds, drainSeconds: 6, provider: 'LOCAL_MOCK_ONLY' })); return; }
  const build = resolve('.output/chrome-mv3');
  await access(resolve(build, 'manifest.json'));
  const base = resolve('.artifacts/live/native-real'); await mkdir(base, { recursive: true });
  const runDir = await mkdtemp(resolve(base, 'verify-'));
  const report = { capturedAt: new Date().toISOString(), status: 'INCOMPLETE', phase: 'setup', browser: config.browser,
    inputSeconds: config.seconds, drainSeconds: 6, pageSurface: 'GENUINE_YOUTUBE_CHAT', provider: 'LOCAL_MOCK_ONLY',
    checks: {}, network: { nativeChatResponses: 0, mockRequests: 0, mockItems: 0, mockCompleted: 0, mockErrors: 0, pageErrors: 0 },
    limitations: ['Current production bundle copied into a new isolated profile; only that test manifest gains loopback permission.',
      'The mock prefixes genuine comment input with a local marker and is not a real translation provider.',
      'DOM insertion is not physical screen presentation. No media health, daily Chrome profile, account, full lifecycle or long-term acceptance.',
      'No chat bodies, authors, message IDs or continuation tokens are written to this report. No screenshots, trace or HAR are recorded.'] };
  let context, page, options, server, rpc, accepting = true, watchdog;
  const delay = ms => new Promise(done => setTimeout(done, ms));
  const save = () => writeFile(resolve(runDir, 'report.json'), JSON.stringify(report, null, 2));
  const waitFor = async (fn, milliseconds, label) => {
    const until = Date.now() + milliseconds;
    while (Date.now() < until) { if (await fn()) return; await delay(100); }
    throw new Error(label);
  };
  try {
    report.build = await digestBuild(build);
    const fixtureKey = 'danlingo-native-loopback-fixture-only';
    server = createServer(async (req, res) => {
      res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', 'authorization,content-type');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (!accepting || req.method !== 'POST' || req.url !== '/v1/chat/completions' || req.headers.authorization !== `Bearer ${fixtureKey}`) { res.writeHead(403); res.end('{}'); return; }
      try {
        assert.ok(report.network.mockRequests < 2000, 'mock-budget');
        let bytes = 0; const chunks = [];
        for await (const chunk of req) { bytes += chunk.length; assert.ok(bytes <= 1000000, 'mock-body-budget'); chunks.push(chunk); }
        const decoded = decodeTranslationFixtureRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        report.network.mockRequests++; report.network.mockItems += decoded.items.length;
        await delay(80);
        const outputs = decoded.items.map(item => ({ id: item.id, text: '【DL MOCK】' + item.text })).reverse();
        const response = encodeTranslationFixtureResponse(decoded, outputs);
        res.setHeader('content-type', response.contentType); res.end(response.body); report.network.mockCompleted++;
      } catch { report.network.mockErrors++; if (!res.headersSent) res.writeHead(500); res.end('{}'); }
    });
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
    const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
    const extension = resolve(runDir, 'test-extension'); await cp(build, extension, { recursive: true });
    const copyDigest = await digestBuild(extension);
    assert.ok(copyDigest.sha256 === report.build.sha256 && copyDigest.files === report.build.files, 'bundle-copy-mismatch');
    report.checks.productionBundleCopiedExactly = true;
    const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
    manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), 'http://127.0.0.1/*'])];
    await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const { chromium } = await loadPlaywright();
    const profile = await mkdtemp(resolve(runDir, 'profile-'));
    context = await chromium.launchPersistentContext(profile, { ...browserLaunchOptions(config.browser), headless: !config.headed, viewport: { width: 1440, height: 1000 }, locale: 'ja-JP',
      args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
    report.browserVersion = context.browser()?.version() || null;
    // A hard run deadline covers setup as well as the independent input window.
    watchdog = setTimeout(() => { report.watchdogExpired = true; void context.close(); }, 150000);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
    const extensionId = new URL(worker.url()).host;
    options = await context.newPage(); await options.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    rpc = payload => options.evaluate(payload => chrome.runtime.sendMessage(payload), payload);
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, enabled: false, endpoint, model: 'native-real-loopback-mock', profile: 'chat-completions',
      thinkingEffort: 'default', allowLocalHttp: true, liveBufferMs: 2000, liveSourceLanguage: 'auto', targetLanguage: 'zh-Hans', translationStream: true });
    const saved = await rpc({ type: 'save', settings, apiKey: fixtureKey, remember: false });
    assert.equal(saved.ok, true, 'isolated-configuration');
    const persisted = await rpc({ type: 'settings' });
    assert.ok(persisted.settings?.endpoint === endpoint && persisted.settings?.enabled === false && persisted.hasKey === true && persisted.remembered !== true, 'isolated-loopback-only');
    report.checks.isolatedMockConfiguration = true;
    page = await context.newPage(); await page.addInitScript(installNativeEvidence);
    page.on('pageerror', () => { report.network.pageErrors++; });
    page.on('response', response => {
      try {
        const url = new URL(response.url());
        if (url.origin !== 'https://www.youtube.com' || url.pathname !== '/youtubei/v1/live_chat/get_live_chat' || response.status() !== 200) return;
        report.network.nativeChatResponses++;
        const inWindow = report.phase === 'fixed-input-window';
        void response.json().then(body => {
          const actions = body?.continuationContents?.liveChatContinuation?.actions;
          if (!Array.isArray(actions)) return;
          const ordinary = actions.filter(a => a?.addChatItemAction?.item?.liveChatTextMessageRenderer).length;
          const withClientId = actions.filter(a => a?.addChatItemAction?.item?.liveChatTextMessageRenderer && a.addChatItemAction.clientId).length;
          report.network.nativeOrdinaryWithClientId = (report.network.nativeOrdinaryWithClientId || 0) + withClientId;
          report.network.nativeOrdinaryActions = (report.network.nativeOrdinaryActions || 0) + ordinary;
          if (inWindow) report.network.nativeOrdinaryActionsDuringWindow = (report.network.nativeOrdinaryActionsDuringWindow || 0) + ordinary;
        }).catch(() => {});
      } catch { /* Only aggregate known native responses. */ }
    });
    report.phase = 'navigate-watch-page'; await save();
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 45000 }); await page.bringToFront();
    report.phase = 'bind-disabled-native-list';
    await waitFor(() => page.evaluate(() => window.__DL_NATIVE_REAL_EVIDENCE__?.bind()), 20000, 'native-list-unavailable');
    report.checks.originalNativeMethodsCaptured = true;
    const enabled = await rpc({ type: 'toggle', enabled: true }); assert.equal(enabled.ok, true, 'enable-failed');
    await page.bringToFront();
    await waitFor(() => page.evaluate(() => window.__DL_NATIVE_REAL_EVIDENCE__.snapshot().activeSnapshot), 15000, 'native-adapter-unavailable');
    report.phase = 'fixed-input-window'; await page.evaluate(() => window.__DL_NATIVE_REAL_EVIDENCE__.begin());
    await save();
    // Each wait is <=1 second; no retry can extend the input deadline.
    const inputUntil = Date.now() + config.seconds * 1000;
    while (Date.now() < inputUntil) await delay(Math.min(1000, inputUntil - Date.now()));
    await page.evaluate(() => window.__DL_NATIVE_REAL_EVIDENCE__.end());
    report.input = await page.evaluate(() => window.__DL_NATIVE_REAL_EVIDENCE__.snapshot());
    report.phase = 'disable-and-drain';
    const disabled = await rpc({ type: 'toggle', enabled: false }); assert.equal(disabled.ok, true, 'disable-failed');
    for (let second = 0; second < 6; second++) await delay(1000);
    accepting = false;
    report.final = await page.evaluate(() => window.__DL_NATIVE_REAL_EVIDENCE__.snapshot());
    report.restoration = await page.evaluate(() => window.__DL_NATIVE_REAL_EVIDENCE__.restoration());
    const e = report.final;
    Object.assign(report.checks, {
      genuineNativeTraffic: report.network.nativeChatResponses > 0 && e.received > 0,
      preparedThroughLocalMock: report.network.mockRequests > 0 && e.prepared > 0,
      nativeEndToEndPresentation: e.endToEnd > 0 && e.nativeMockPresented > 0,
      sourceHeldBeforePreparation: e.eligible > 0 && e.visibleAtSource === 0 && e.sourceBeforePreparedViolations === 0,
      noDuplicateOrOvertake: e.duplicateSources === 0 && e.duplicateSubmitted === 0 && e.duplicateDisplayed === 0 && e.submissionOrderViolations === 0 && e.displayedWithoutSubmitted === 0,
      boundedObservation: e.ledgerOverload === 0 && e.observerErrors === 0 && e.nativeIdentityChanges === 0 && e.pendingSubmission === 0,
      allSubmissionsObservedOrRemoved: e.unpresented === 0,
      exactNativeRestoration: Object.values(report.restoration).every(value => value === true),
      disabledAfterWindow: e.activeSnapshot === false,
      mockRequestsValid: report.network.mockErrors === 0,
    });
    report.status = Object.values(report.checks).every(value => value === true) ? 'PASS_REAL_NATIVE_CHAT_LOCAL_MOCK_ONLY' : 'INCOMPLETE';
    report.phase = 'complete';
  } catch (error) {
    report.error = error?.name === 'TimeoutError' ? 'bounded-browser-timeout' : report.watchdogExpired ? 'hard-run-deadline' : 'verification-failed-at-recorded-phase';
    const networkCode = String(error?.message || '').match(/net::ERR_[A-Z_]+/)?.[0];
    if (networkCode) report.error = networkCode;
    else if (['native-list-unavailable','native-adapter-unavailable','enable-failed','disable-failed','isolated-configuration','isolated-loopback-only'].includes(error?.message)) report.error = error.message;
  } finally {
    accepting = false; clearTimeout(watchdog);
    if (rpc) await rpc({ type: 'toggle', enabled: false }).catch(() => {});
    await page?.evaluate(() => window.__DL_NATIVE_REAL_EVIDENCE__?.stop()).catch(() => {});
    await context?.close().catch(() => {});
    if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
    await save();
  }
  console.log(JSON.stringify({ report: resolve(runDir, 'report.json'), status: report.status, checks: report.checks, network: report.network }));
  if (report.status !== 'PASS_REAL_NATIVE_CHAT_LOCAL_MOCK_ONLY') process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(() => { console.error('Invalid arguments or unavailable local prerequisites; run --help.'); process.exitCode = 1; });
}
