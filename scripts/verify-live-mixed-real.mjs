import { browserExecutablePath, browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Bounded real Niconico LIVE + real Niconico VOD, one unchanged extension worker.
// Parent process supplies explicit settings and a session-only test credential in memory.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeSettings } from '../src/core/config.ts';
import { protectText } from '../src/translation/text.ts';
import { installObserver, attachNativeObserver } from './niconico-live-observer.mjs';
import { observeMixedRequestMetadata, summarizeMixedRequests } from './live-mixed-real-evidence.mjs';
import { auditMediaProgress } from './live-observation-health.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(done => setTimeout(done, ms));
const eventId = row => JSON.stringify([row.resourceId, row.adapterSession, row.sourceId]);
async function fingerprint(directory, prefix = '') {
  const files = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    assert.equal(entry.isSymbolicLink(), false, 'No symlink payloads');
    const name = prefix + entry.name, path = resolve(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, await fingerprint(path, name + '/'));
    else { assert.ok(entry.isFile()); files[name] = hash(await readFile(path)); }
  }
  return files;
}

// Observe only the production VOD bridge. This creates no synthetic player or messages.
function installVodObserver() {
  const s = window.__DL_MIXED_VOD__ = { sources: [], prepared: [], sourceCount: 0, preparedCount: 0, overflow: false, complete: false };
  window.addEventListener('message', event => {
    const d = event.data;
    if (event.source !== window || d?.bridge !== 'danlingo.native.v1') return;
    const at = performance.timeOrigin + performance.now();
    if (d.from === 'native' && d.type === 'sources') {
      for (const row of d.upserts || []) {
        s.sourceCount++;
        if (s.sources.length < 16000 && typeof row.originalText === 'string' && row.originalText.length <= 4000)
          s.sources.push({ id: row.id, sourceId: row.sourceId, resourceId: d.resourceId, originalText: row.originalText, observedAt: at });
        else s.overflow = true;
      }
      if (d.complete) s.complete = true;
    }
    if (d.from === 'content' && d.type === 'prepared') {
      for (const row of d.items || []) {
        s.preparedCount++;
        if (s.prepared.length < 16000 && typeof row.text === 'string' && row.text.length <= 4000)
          s.prepared.push({ id: row.id, text: row.text, observedAt: at });
        else s.overflow = true;
      }
    }
  });
}

export async function run(settings, apiKey, { room, video = 'sm1715919', browser: browserName = 'edge' } = {}) {
  assert.match(room || '', /^lv\d+$/, 'Explicit currently live room is required');
  assert.match(video, /^sm\d+$/); assert.ok(['chromium', 'edge'].includes(browserName));
  assert.ok(typeof apiKey === 'string' && apiKey.length > 0 && apiKey.length <= 4096 && !/\s/.test(apiKey), 'Invalid in-memory test credential');
  for (const name of ['endpoint', 'model', 'profile', 'thinkingEffort']) assert.ok(typeof settings?.[name] === 'string' && settings[name], 'Explicit ' + name + ' is required');
  assert.equal(settings.concurrency, 2, 'This focused observation requires explicitly selected concurrency 2');
  assert.equal(settings.liveBufferMs, 2000, 'This focused observation requires explicitly selected 2000ms buffer');
  assert.equal(settings.translationScope, 'all', 'Explicit VOD full-pool scope is required for background mixed work');
  const config = normalizeSettings({ ...settings, enabled: false });
  for (const name of ['endpoint', 'model', 'profile', 'thinkingEffort', 'concurrency', 'batchSize', 'liveBufferMs', 'translationScope'])
    assert.equal(config[name], settings[name], 'Normalization changed explicit ' + name);
  // Stop browser work after 150s; reserve 30s for cancellation, cleanup and evidence writes.
  const startedAt = Date.now(), workDeadlineAt = startedAt + 150000, deadlineAt = startedAt + 180000, maxRequests = 120;
  const root = resolve('.artifacts/live/mixed-real'); await mkdir(root, { recursive: true });
  const runDir = await mkdtemp(resolve(root, browserName + '-'));
  const reportPath = resolve(runDir, 'report.json');
  const report = { capturedAt: new Date(startedAt).toISOString(), status: 'RUNNING', phase: 'setup', room, video, browser: browserName,
    evidence: 'REAL_NICONICO_LIVE_AND_VOD_ONE_PRODUCTION_BACKGROUND_REAL_EXPLICIT_PROVIDER', runDir,
    settings: config, requests: [], samples: [], checks: {}, errors: [],
    budget: { totalMs: 180000, browserWorkMs: 150000, cleanupReserveMs: 30000, maxRequests, acceptedInFlightOvershoot: config.concurrency, receiptMs: 30000, drainMs: 6000 },
    limitations: [
      'Only this explicit room/video/browser/configuration and fixed observation are covered; no complete lifecycle or performance matrix.',
      'Only the test manifest pregrants the selected Provider host. This is not native consent or manual installation acceptance.',
      'LIVE remains the foreground tab; VOD naturally pretranslates in the background. Native staging evidence here is LIVE only.',
      'Protected-text/time correlation cannot distinguish identical LIVE/VOD text; ambiguous and unknown requests remain explicit.',
      'Slots are observed after the original native method, not physical pixels. Concurrency is measured, never forced to the configured peak.',
      'No site responses, comments, control/prepared messages, model settings or Provider responses are fabricated.',
    ] };
  const redact = text => String(text).split(apiKey).join('[redacted]');
  const persist = () => writeFile(reportPath, JSON.stringify(report, (_key, value) => typeof value === 'string' ? redact(value) : value, 2));
  let context, options, live, vod, rpc, watchdog, closing = false, finalizing = false, navigationTask;
  const pendingNetwork = new Set(), requestMap = new Map();
  async function bounded(promise, maxMs, label) {
    let timer;
    const ms = Math.max(1, Math.min(maxMs, (finalizing ? deadlineAt - 1000 : workDeadlineAt) - Date.now()));
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out')), ms); })]); }
    finally { clearTimeout(timer); }
  }
  async function waitFor(check, label, maxMs = 10000) {
    const end = Math.min(Date.now() + maxMs, workDeadlineAt);
    while (Date.now() < end && !closing) { if (await bounded(check(), 3000, label)) return; await delay(100); }
    throw new Error(label + ' not observed within run budget');
  }
  function networkTask(promise) {
    const safe = promise.catch(() => {}); pendingNetwork.add(safe); void safe.then(() => pendingNetwork.delete(safe));
  }
  async function collectLive() {
    return bounded(live.evaluate(() => {
      const s = window.__DL_NICO_EXTENSION_EVIDENCE__;
      return { events: s.events, prepared: s.prepared, delivered: s.delivered, drops: s.drops, snapshots: s.snapshots,
        stages: s.stages, controls: s.controls, measurements: s.measurements,
        complete: s.events.length < 12000 && s.prepared.length < 12000 && s.delivered.length < 12000 && s.drops.length < 12000
          && s.wireRows.length < 12000 && s.snapshots.length < 1500 && s.controls.length < 1500 && s.stages.length < 24000 && s.measurements.length < 24000 };
    }), 4000, 'LIVE evidence collection');
  }
  async function restored() {
    return live.evaluate(() => {
      const s = window.__DL_NICO_EXTENSION_EVIDENCE__;
      return { input: s.native?.addToRender === s.originalAdd, dispatcher: EventTarget.prototype.dispatchEvent === s.originalDispatch,
        filters: JSON.stringify(s.filtersBefore) === JSON.stringify(s.native?.renderer.layerProcessorList.map(layer => layer.getStagingFilterNameList())),
        disabledControl: s.controls.at(-1)?.enabled === false };
    });
  }
  async function sampleLive() {
    return bounded(live.evaluate(() => {
      const s = window.__DL_NICO_EXTENSION_EVIDENCE__, v = document.querySelector("[data-layer-name='videoLayer'] video");
      return { at: performance.timeOrigin + performance.now(), hidden: document.hidden, online: navigator.onLine,
        enabled: s.controls.at(-1)?.enabled === true, atLiveEdge: !!document.querySelector('[data-live-status="live"]') && !document.querySelector('[data-live-status="chase"]'),
        video: v ? { time: v.currentTime, paused: v.paused, seeking: v.seeking, ended: v.ended, readyState: v.readyState } : null };
    }), 3000, 'Playback sample');
  }
  try {
    const build = resolve('.output/chrome-mv3'), extension = resolve(runDir, 'test-extension');
    const rawManifest = await readFile(resolve(build, 'manifest.json')), manifest = JSON.parse(rawManifest);
    assert.equal(manifest.version, '0.2.0');
    assert.deepEqual([...manifest.host_permissions].sort(), ['https://www.nicovideo.jp/*', 'https://live.nicovideo.jp/watch/*', 'https://www.youtube.com/*'].sort());
    report.build = { path: build, version: manifest.version, rawManifestSha256: hash(rawManifest), files: await fingerprint(build) };
    await cp(build, extension, { recursive: true });
    const endpointUrl = new URL(config.endpoint), hostPattern = `${endpointUrl.protocol}//${endpointUrl.hostname}/*`;
    manifest.host_permissions = [...new Set([...manifest.host_permissions, hostPattern])];
    await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const copiedFiles = await fingerprint(extension);
    report.build.copy = extension; report.build.copiedManifestSha256 = copiedFiles['manifest.json']; report.build.extraHost = hostPattern;
    report.checks.productionBytesUnchanged = Object.keys(copiedFiles).length === Object.keys(report.build.files).length
      && Object.entries(report.build.files).every(([name, digest]) => name === 'manifest.json' || copiedFiles[name] === digest);
    assert.equal(report.checks.productionBytesUnchanged, true);

    const { chromium } = await loadPlaywright();
    const launchOptions = browserLaunchOptions(browserName);
    report.executablePath = launchOptions.executablePath ?? browserExecutablePath(browserName, { playwrightBrowser: chromium });
    watchdog = setTimeout(() => { report.budget.timeLimitReachedAt = Date.now(); closing = true; void context?.close().catch(() => {}); }, Math.max(1, workDeadlineAt - Date.now()));
    await bounded(persist(), 3000, 'Initial report');
    context = await bounded(chromium.launchPersistentContext(resolve(runDir, 'profile'), { ...launchOptions, headless: false,
      viewport: { width: 1440, height: 1000 }, locale: 'ja-JP', timeout: Math.max(1, Math.min(30000, deadlineAt - Date.now())),
      args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--autoplay-policy=no-user-gesture-required'] }), 30000, 'Browser launch');
    context.setDefaultTimeout(5000); report.browserVersion = context.browser()?.version();
    context.on('request', request => {
      if (request.url() !== config.endpoint || request.method() !== 'POST') return;
      const row = { id: 'http-' + (report.requests.length + 1), startedAt: Date.now(), phase: report.phase,
        serviceWorker: !!request.serviceWorker(), workerUrl: request.serviceWorker()?.url(), items: [], status: 'pending' };
      try {
        Object.assign(row, observeMixedRequestMetadata(request.postDataJSON()));
      } catch { row.metadataUnavailable = true; }
      requestMap.set(request, row); report.requests.push(row);
      if (report.requests.length >= maxRequests && !report.budget.requestLimitReachedAt) {
        report.budget.requestLimitReachedAt = Date.now(); if (rpc) networkTask(rpc({ type: 'toggle', enabled: false }));
      }
      if (report.requests.length > maxRequests + config.concurrency) { report.budget.forcedClose = true; closing = true; networkTask(context.close()); }
    });
    context.on('requestfinished', request => {
      const row = requestMap.get(request); if (!row) return; row.completedAt = Date.now();
      networkTask(request.response().then(response => { row.status = response?.status() ?? 'unknown'; }));
    });
    context.on('requestfailed', request => { const row = requestMap.get(request); if (row) { row.completedAt = Date.now(); row.status = 'failed'; } });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
    report.workerUrl = worker.url(); report.extensionId = new URL(worker.url()).host;
    options = await context.newPage(); await options.goto(`chrome-extension://${report.extensionId}/options.html`);
    await options.waitForFunction(() => !!document.getElementById('key-state')?.textContent);
    rpc = payload => bounded(options.evaluate(payload => chrome.runtime.sendMessage(payload), payload), 4000, 'Trusted options RPC');
    const fresh = await rpc({ type: 'settings' }); assert.equal(fresh.hasKey, false);
    const saved = await rpc({ type: 'save', settings: config, apiKey, remember: false });
    assert.equal(saved.ok, true); assert.equal(saved.hasKey, true); assert.equal(saved.remembered, false);
    for (const name of ['endpoint', 'model', 'profile', 'thinkingEffort', 'concurrency', 'batchSize']) assert.equal(saved.settings[name], config[name]);
    live = await context.newPage(); await live.addInitScript(installObserver);
    await live.goto('https://live.nicovideo.jp/watch/' + room, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await live.bringToFront(); await live.locator('div[id^="renderer-parent-id-"]').first().waitFor({ state: 'attached', timeout: 20000 });
    report.program = await live.evaluate(() => { const p = JSON.parse(document.getElementById('embedded-data')?.getAttribute('data-props') || '{}').program; return p && { id: p.nicoliveProgramId, status: p.status }; });
    assert.equal(report.program?.id, room); assert.equal(report.program?.status, 'ON_AIR', 'Actual room must still be live');
    const play = live.getByRole('button', { name: '再生', exact: true }); if (await play.isVisible()) await play.click();
    await waitFor(() => live.evaluate(() => { const v = document.querySelector("[data-layer-name='videoLayer'] video"); return v && !v.paused && !v.seeking && !v.ended && v.readyState >= 2; }), 'Actual LIVE playback', 15000);
    assert.equal((await live.evaluate(attachNativeObserver)).found, true);
    assert.equal((await rpc({ type: 'toggle', enabled: true })).ok, true);
    await waitFor(() => live.evaluate(() => { const s = window.__DL_NICO_EXTENSION_EVIDENCE__; return s.events.length > 0 && s.snapshots.at(-1)?.connection === 'connected'; }), 'Fresh live event', 15000);
    await delay(2000); // Allow actual periodic live-presence publication before introducing VOD.
    vod = await context.newPage(); await vod.addInitScript(installVodObserver); await live.bringToFront();
    report.phase = 'mixed';
    await live.evaluate(() => { window.__DL_NICO_EXTENSION_EVIDENCE__.phase = 'mixed'; });
    report.samples.push(await sampleLive());
    const startAt = report.samples[0].at;
    report.window = { startAt, endAt: startAt + 30000, observedUntil: null };
    navigationTask = vod.goto('https://www.nicovideo.jp/watch/' + video, { waitUntil: 'domcontentloaded', timeout: 25000 })
      .then(() => { report.vodNavigation = 'loaded'; }).catch(error => { report.vodNavigation = 'failed'; report.errors.push(redact(error.message).slice(0, 400)); });
    await bounded(persist(), 3000, 'Window report');
    while (Date.now() < report.window.endAt + 6000 && !closing && !report.budget.requestLimitReachedAt) {
      report.samples.push(await sampleLive());
      await delay(Math.max(0, Math.min(500, report.window.endAt + 6000 - Date.now())));
    }
    if (!closing) report.samples.push(await sampleLive());
    report.window.observedUntil = report.samples.at(-1).at;
    await bounded(navigationTask, 3000, 'VOD navigation completion');
    report.live = await collectLive();
    report.vod = await bounded(vod.evaluate(() => window.__DL_MIXED_VOD__), 4000, 'VOD bridge evidence');
    await bounded(Promise.allSettled([...pendingNetwork]), 3000, 'Network evidence settlement');
    const sources = [...report.live.events.map(row => ({ kind: 'live', textSha256: hash(protectText(row.originalText).text), observedAt: row.receivedAt })),
      ...(report.vod?.sources || []).map(row => ({ kind: 'vod', textSha256: hash(protectText(row.originalText).text), observedAt: row.observedAt }))];
    report.dispatch = summarizeMixedRequests({ requests: report.requests, sources, window: report.window, concurrency: 2 });
    const events = report.live.events.filter(row => row.receivedAt >= startAt && row.receivedAt < report.window.endAt);
    report.liveChains = [];
    report.liveOutcomes = events.map(event => {
      const deliveries = report.live.delivered.filter(row => eventId(row) === eventId(event));
      const drops = report.live.drops.filter(row => eventId(row) === eventId(event));
      for (const delivery of deliveries.filter(row => row.translated)) {
        const prepared = report.live.prepared.find(row => eventId(row) === eventId(event) && row.originalText === event.originalText && row.observedAt <= delivery.releasedAt);
        const stage = prepared && report.live.stages.find(row => row.createdSlot && event.nativeSourceIdentity?.key
          && row.nativeSourceIdentity?.key === event.nativeSourceIdentity.key && row.text === prepared.text && row.originalText === event.originalText && Math.abs(row.at - delivery.displayAt) <= 2);
        const measurement = stage && report.live.measurements.find(row => row.text === prepared.text && row.at >= stage.at - 100 && row.at <= stage.at + 1);
        if (prepared && stage && measurement) report.liveChains.push({ id: eventId(event), originalText: event.originalText, text: prepared.text,
          receivedAt: event.receivedAt, preparedAt: prepared.observedAt, releasedAt: delivery.releasedAt, stageAt: stage.at, measuredWidth: measurement.width });
      }
      return { id: eventId(event), delivered: deliveries.length, dropped: drops.length, missing: deliveries.length + drops.length === 0,
        nativeIdentityObserved: !!event.nativeSourceIdentity?.key };
    });
    const snapshots = report.live.snapshots.filter(row => row.observedAt >= startAt && row.observedAt <= report.window.observedUntil);
    const windowIds = new Set(events.map(eventId));
    const translatedDeliveries = report.live.delivered.filter(row => row.translated && windowIds.has(eventId(row)));
    const healthy = report.samples.every(row => !row.hidden && row.online && row.enabled && row.atLiveEdge && row.video
      && !row.video.paused && !row.video.seeking && !row.video.ended && row.video.readyState >= 2);
    report.playbackHealth = auditMediaProgress(report.samples.map(row => ({ at: row.at, playback: { time: row.video?.time } })),
      { startAt, observedUntil: report.window.observedUntil });
    report.playbackHealth.maxObservedSampleGapMs = Math.max(0, ...report.samples.slice(1).map((row, index) => row.at - report.samples[index].at));
    let stallAnchor = report.samples[0], maxObservedStallMs = 0;
    for (const row of report.samples.slice(1)) {
      if (Number.isFinite(row.video?.time) && Number.isFinite(stallAnchor.video?.time) && row.video.time - stallAnchor.video.time <= 0.05)
        maxObservedStallMs = Math.max(maxObservedStallMs, row.at - stallAnchor.at);
      else stallAnchor = row;
    }
    report.playbackHealth.maxObservedStallMs = maxObservedStallMs;
    const bridgeHealthy = snapshots.length >= 20 && snapshots.every(row => !row.hidden && row.connection === 'connected'
      && row.playback?.contentActive && row.playback?.atLiveEdge && !row.playback.paused && !row.playback.seeking);
    report.checks = { ...report.checks, sameBackground: report.requests.length > 0 && report.requests.every(row => row.serviceWorker && row.workerUrl === report.workerUrl),
      fixedWindowComplete: report.window.observedUntil >= report.window.endAt + 6000 && report.samples.length >= 60,
      liveContinuouslyHealthy: healthy && report.playbackHealth.healthy && bridgeHealthy,
      actualVodLoaded: report.vodNavigation === 'loaded' && report.vod?.sources.some(row => row.resourceId === video),
      actualVodPrepared: report.vod?.prepared.some(row => row.observedAt >= startAt && row.observedAt < report.window.endAt
        && report.vod.sources.some(source => source.id === row.id && source.originalText !== row.text)),
      actualLivePreparedNativeChain: report.liveChains.some(row => row.originalText !== row.text),
      allTranslatedChainsObserved: translatedDeliveries.length === report.liveChains.length,
      liveDeadlinesObserved: report.liveChains.every(row => row.preparedAt <= row.receivedAt + config.liveBufferMs
        && row.releasedAt >= row.receivedAt + config.liveBufferMs - 25 && row.preparedAt <= row.releasedAt && row.stageAt >= row.releasedAt - 2),
      noDuplicateNativeSlots: events.every(event => !event.nativeSourceIdentity?.key || report.live.stages.filter(row => row.phase === 'mixed'
        && row.createdSlot && row.nativeSourceIdentity?.key === event.nativeSourceIdentity.key).length <= 1),
      liveEventConclusions: events.length > 0 && report.liveOutcomes.every(row => !row.missing && row.delivered + row.dropped === 1 && row.nativeIdentityObserved),
      bothWorkloadsDispatched: report.dispatch.shares.live > 0 && report.dispatch.shares.vod > 0,
      bothWorkloadsHadSuccessfulHttp: ['live', 'vod'].every(kind => report.dispatch.requests.some(row => row.kind === kind
        && row.startedAt >= startAt && row.startedAt < report.window.endAt && typeof row.status === 'number' && row.status >= 200 && row.status < 300)),
      dispatchAttributionComplete: report.dispatch.unresolvedRequests.length === 0,
      observedConcurrencyWithinLimit: report.dispatch.peakTotal <= 2,
      observedReservedSlot: report.dispatch.admissions.length > 0 && report.dispatch.admissions.every(row => row.reservation === 'OBSERVED_WITHIN_LIMIT'),
      sourceCaptureComplete: report.live.complete && report.vod && !report.vod.overflow,
      budgetNotExhausted: !report.budget.requestLimitReachedAt && !report.budget.timeLimitReachedAt && !report.budget.forcedClose };
    report.phase = 'disabled'; await live.evaluate(() => { window.__DL_NICO_EXTENSION_EVIDENCE__.phase = 'disabled'; });
    report.disableRequestedAt = Date.now(); assert.equal((await rpc({ type: 'toggle', enabled: false })).ok, true);
    await waitFor(async () => Object.values(await restored()).every(Boolean), 'Real native disable restoration', 6000);
    report.restored = await restored();
    await waitFor(() => live.evaluate(() => window.__DL_NICO_EXTENSION_EVIDENCE__.stages.some(row => row.phase === 'disabled' && row.createdSlot && row.text === row.originalText)), 'Native original after disable', 6000);
    report.checks.closedRestored = Object.values(report.restored).every(Boolean);
    report.disabledObservation = await collectLive();
    report.checks.originalAfterDisable = report.disabledObservation.stages.some(row => row.phase === 'disabled' && row.createdSlot && row.text === row.originalText);
    report.disabledControlAt = report.disabledObservation.controls.find(row => row.enabled === false && row.observedAt >= report.disableRequestedAt - 10)?.observedAt;
    report.checks.noPostDisableProvider = Number.isFinite(report.disabledControlAt) && !report.requests.some(row => row.startedAt > report.disabledControlAt + 10);
    const persisted = await rpc({ type: 'settings' });
    report.checks.selectedProviderPreserved = ['endpoint', 'model', 'profile', 'thinkingEffort', 'concurrency', 'batchSize'].every(name => persisted.settings[name] === config[name]);
    report.status = Object.values(report.checks).every(value => value === true) ? 'PASS_REAL_MIXED_OBSERVED_SCOPE' : 'INCOMPLETE_REAL_MIXED';
  } catch (error) { report.status = 'INCOMPLETE_REAL_MIXED'; report.errors.push(redact(error.message).slice(0, 800)); }
  finally {
    finalizing = true;
    if (rpc && !closing) {
      await rpc({ type: 'toggle', enabled: false }).catch(() => {});
      const deleted = await rpc({ type: 'delete-key' }).catch(() => null);
      report.keyDeleted = deleted?.ok === true && deleted.hasKey === false;
    }
    if (live && !closing) await bounded(live.evaluate(() => { for (const undo of window.__DL_NICO_EXTENSION_EVIDENCE__?.restorers || []) undo(); }), 2000, 'Observer restore').catch(() => {});
    closing = true;
    try { await bounded(context?.close(), 5000, 'Browser cleanup'); report.browserClosed = true; }
    catch { report.browserClosed = false; }
    try { await bounded(Promise.allSettled([...pendingNetwork]), 3000, 'Final network settlement'); }
    catch (error) { report.errors.push(error.message); report.status = 'INCOMPLETE_REAL_MIXED'; }
    try { await bounded(navigationTask, 1000, 'Final navigation settlement'); }
    catch (error) { report.errors.push(error.message); report.status = 'INCOMPLETE_REAL_MIXED'; }
    if (report.budget.timeLimitReachedAt || report.budget.requestLimitReachedAt || report.keyDeleted !== true || report.browserClosed !== true) report.status = 'INCOMPLETE_REAL_MIXED';
    report.finishedAt = new Date().toISOString(); report.budget.elapsedMs = Date.now() - startedAt;
    if (report.budget.elapsedMs >= 180000) report.status = 'INCOMPLETE_REAL_MIXED';
    try { await bounded(persist(), 2000, 'Final report persistence'); }
    catch (error) { report.status = 'INCOMPLETE_REAL_MIXED'; console.error(JSON.stringify({ report: reportPath, error: error.message })); }
    clearTimeout(watchdog);
    console.log(JSON.stringify({ report: reportPath, status: report.status, requests: report.requests.length, keyDeleted: report.keyDeleted }));
  }
  return { reportPath, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length === 3 && process.argv[2] === '--help') console.log(`Import { run } and call run(explicitSettings, apiKey, { room: 'lvID', video: 'smID', browser: 'edge'|'chromium' }).
No credential file/environment Key is read. Parent supplies the session test Key in memory.
Requires explicit concurrency=2, liveBufferMs=2000, translationScope='all'; preserves model/thinking.
Real pages and Provider only; 30s receipt + 6s drain, at most 120 POSTs plus already in-flight concurrency, 180s total.
Uses an isolated headed profile and traceable 0.2.0 copy with Provider host pregrant; no native installation/consent claim.`);
  else { console.error('This entry is parent-invoked only. Use --help; never pass credentials on the command line.'); process.exitCode = 1; }
}
