import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Actual Niconico LIVE + production extension. LOCAL MOCK is the default.
// --real-provider requires explicit settings and non-echoing interactive key entry.
// No fabricated chats, control/prepared messages, readiness or Provider responses in real mode.
import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/core/config.ts';
import { needsTranslation } from '../src/core/messages.ts';
import { protectText } from '../src/translation/text.ts';
import { installObserver, attachNativeObserver, installEarlyNativeObserver, inspectNativeRestoration, auditNativeSlotLifecycles } from './niconico-live-observer.mjs';
import { decodeTranslationFixtureRequest, encodeTranslationFixtureResponse } from './translation-protocol-fixture.mjs';

const args = process.argv.slice(2);
const option = (key, fallback) => { const i = args.indexOf(key); if (i < 0) return fallback; assert.ok(args[i + 1] && !args[i + 1].startsWith('--'), key + ' requires a value'); return args[i + 1]; };
if (args.includes('--help')) {
  console.log(`node --experimental-strip-types scripts/verify-niconico-live.mjs --room lvID [--browser edge|chromium] [--seconds 30..120] [--max-requests 1..200] [--headed] [--real-provider] [--lifecycle --next-room lvID] [--stages fullscreen,next-room] [--fullscreen-mode browser|monitor]
Default: isolated real LIVE page + local mock HTTP, 30-second fixed window + 6-second drain per observation.
--build-dir selects an existing frozen unpacked extension (default .output/chrome-mv3); it is copied without building. Reports use unique G3 directories.
Real Provider: explicitly set DANLINGO_E2E_ENDPOINT, DANLINGO_E2E_MODEL, DANLINGO_E2E_PROFILE, DANLINGO_E2E_THINKING; enter the test key in the non-echoing terminal prompt.
Optional language settings: DANLINGO_E2E_SOURCE_LANGUAGE, DANLINGO_E2E_TARGET_LANGUAGE, DANLINGO_E2E_LIVE_SOURCE_LANGUAGE (defaults auto, zh-Hans, ja).
Lifecycle defaults to off-on,resize,fullscreen,reconnect,next-room. --stages selects a nonempty subset; baseline is always retained. A selected-stage run does not establish the full lifecycle. Missing/failed stages remain INCOMPLETE.
Optional --stages active-next-room --next-room lvID keeps translation enabled across a full page navigation, then observes a fixed 30-second window plus the existing drain. It is an alternative to next-room; select only one navigation stage per run. This does not establish SPA navigation. Old in-flight work is recorded as observed, never fabricated or awaited indefinitely.
Optional --stages pause-resume or chase-live uses only enabled, visible original site buttons, confirms the actual paused/CHASE bridge state, observes 2.5 seconds of inactivity, returns to LIVE and records a complete 30-second recovery window plus 6-second drain. Unavailable controls remain INCOMPLETE. These stages do not establish full lifecycle, ads or player reconstruction.
To request both: --lifecycle --stages pause-resume,chase-live --max-requests 200. Baseline (--seconds) and both recovery windows share one request/time budget; it is never reset. Actual hover reveals the program player's controls before button checks.
--fullscreen-mode defaults to browser and requires the fullscreen lifecycle stage. Both modes select the real site settings menu; monitor additionally requires document.fullscreenElement.
--check-args validates options and prints the selected scope only; no artifacts, browser, network or credentials are opened.
No saved/personal browser profile or stored credential is reused. The isolated manifest pregrants only the selected Provider host pattern; native permission prompts/manual install are not covered.`);
  process.exit(0);
}
const flags = new Set(['--real-provider', '--lifecycle', '--headed', '--check-args']);
const valued = new Set(['--room', '--browser', '--seconds', '--max-requests', '--next-room', '--stages', '--fullscreen-mode', '--build-dir']);
for (let i = 0; i < args.length; i++) { assert.ok(flags.has(args[i]) || valued.has(args[i]), 'Unsupported argument; use --help'); if (valued.has(args[i])) i++; }
const realProvider = args.includes('--real-provider'), lifecycle = args.includes('--lifecycle');
const allLifecycleStages = ['off-on', 'resize', 'fullscreen', 'reconnect', 'next-room'];
const mediaLifecycleStages = ['pause-resume', 'chase-live'];
const optionalLifecycleStages = ['active-next-room', ...mediaLifecycleStages];
const selection = option('--stages', '');
assert.ok(args.filter(arg => arg === '--stages').length <= 1, '--stages must be specified only once');
assert.ok(!selection || lifecycle, '--stages requires --lifecycle');
const selectedStages = lifecycle ? (selection ? selection.split(',') : allLifecycleStages) : [];
assert.ok(selectedStages.every(s => [...allLifecycleStages, ...optionalLifecycleStages].includes(s)) && new Set(selectedStages).size === selectedStages.length, 'Unknown or repeated --stages entry');
assert.ok(!selectedStages.includes('active-next-room') || !selectedStages.includes('next-room'), 'Select active-next-room or next-room, not both in one run');
const fullscreenMode = option('--fullscreen-mode', 'browser');
assert.ok(['browser', 'monitor'].includes(fullscreenMode), '--fullscreen-mode must be browser or monitor');
assert.ok(!args.includes('--fullscreen-mode') || lifecycle && selectedStages.includes('fullscreen'), '--fullscreen-mode requires --lifecycle with fullscreen selected');
const room = option('--room', 'lv351372525'), nextRoom = option('--next-room', ''), browserName = option('--browser', 'edge'), seconds = Number(option('--seconds', '30'));
const maxRequests = Number(option('--max-requests', '100')), drainMs = 6000;
const build = resolve(option('--build-dir', '.output/chrome-mv3'));
assert.match(room, /^lv\d+$/); assert.ok(['edge', 'chromium'].includes(browserName));
assert.ok(Number.isInteger(seconds) && seconds >= 30 && seconds <= 120, '--seconds must be 30..120');
assert.ok(Number.isInteger(maxRequests) && maxRequests >= 1 && maxRequests <= 200, '--max-requests must be 1..200');
if (nextRoom) { assert.match(nextRoom, /^lv\d+$/); assert.ok(lifecycle && nextRoom !== room, '--next-room requires --lifecycle and a different room'); }
assert.ok(!selectedStages.includes('active-next-room') || nextRoom, 'active-next-room requires --next-room');
const fullLifecycleRequested = lifecycle && !selectedStages.some(name => mediaLifecycleStages.includes(name))
  && allLifecycleStages.every(name => selectedStages.includes(name));
if (args.includes('--check-args')) {
  console.log(JSON.stringify({ selectedStages, fullLifecycleRequested,
    mediaRecoveryWindowSeconds: selectedStages.some(name => mediaLifecycleStages.includes(name)) ? 30 : null, drainMs }));
  process.exit(0);
}
const base = resolve('.artifacts/live/goals/g3/extension'); await mkdir(base, { recursive: true });
const root = await mkdtemp(resolve(base, `${realProvider ? 'real-provider-' : ''}${browserName}-${room}-`));
const providerKind = realProvider ? 'real' : 'mock';
const report = { capturedAt: new Date().toISOString(), root, room, browser: browserName, providerKind,
  lifecycleScope: { requested: lifecycle, selectedStages, fullscreenMode: selectedStages.includes('fullscreen') ? fullscreenMode : null,
    fullLifecycleRequested },
  evidence: realProvider ? 'REAL_NICONICO_LIVE_FULL_PRODUCTION_EXTENSION_REAL_EXPLICIT_PROVIDER' : 'REAL_NICONICO_LIVE_FULL_PRODUCTION_EXTENSION_LOCAL_MOCK_HTTP',
  status: 'running', phase: 'setup', requests: [], providerRequests: [], stages: [], windows: [], rooms: [], checks: {}, errors: [], mediaFailures: [], limitations: [
    realProvider ? 'Only the explicitly selected service and interactively entered test key are used.' : 'Local mock credentials/responses only; no real Provider key or model is used.',
    'Only the copied test manifest pregrants the selected Provider host pattern; browser match patterns do not distinguish ports. Native consent/manual installation are not covered.',
    'BrowserContext network events observe the unchanged production Service Worker. Request budgets use trusted disable RPC and bounded context closure, allowing explicitly recorded in-flight concurrency.',
    'Native measurement/slot entry is observed; timestamps do not claim physical pixel presentation time.',
    'Only current ordinary LIVE comments in this bounded room/browser observation are covered, not Timeshift.',
    ...(selectedStages.some(name => mediaLifecycleStages.includes(name)) ? ['Optional pause/CHASE actions cover only observed inactivity and fresh LIVE recovery; no full-lifecycle, inserted-ad or player-reconstruction claim. Native observer identity changes leave the action INCOMPLETE.'] : []),
    'No fabricated chat, control or prepared messages; website content and the copied production extension drive the pipeline.',
  ] };
const prefix = '【模拟译文】';
let key = '', context, page, options, rpc, server, worker, config, closing = false, watchdog, deadlineAt = Infinity;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const redact = value => key ? String(value).split(key).join('[redacted]') : String(value);
const jsonSafe = value => JSON.stringify(value, (_name, v) => typeof v === 'string' ? redact(v) : v, 2);
const persist = () => writeFile(resolve(root, 'report.json'), jsonSafe(report));
const hash = value => createHash('sha256').update(value instanceof Uint8Array ? value : String(value)).digest('hex');
async function waitFor(check, name, timeout = 15000) {
  const end = Math.min(Date.now() + timeout, deadlineAt);
  while (Date.now() < end) { const result = await check(); if (result) return result; await delay(75); }
  throw new Error('Timed out: ' + name);
}
async function collect() {
  const observation = await page.evaluate(() => {
    const s = window.__DL_NICO_EXTENSION_EVIDENCE__, video = document.querySelector("[data-layer-name='videoLayer'] video");
    return { phase: s?.phase, capturedAt: performance.timeOrigin + performance.now(), documentTimeOrigin: performance.timeOrigin,
      earlyNativeObserver: s?.earlyNativeObserver ?? null,
      snapshots: s?.snapshots, events: s?.events, prepared: s?.prepared, delivered: s?.delivered, controls: s?.controls,
      stages: s?.stages, measurements: s?.measurements, drops: s?.drops, wireRows: s?.wireRows,
      nativeLifecycle: s?.nativeLifecycle ? { ...s.nativeLifecycle,
        currentHooks: !!s.nativeLifecycleHooks?.length && s.nativeLifecycleHooks.every(hook => hook.target[hook.method] === hook.observer) } : null,
      mainVideo: video ? { paused: video.paused, seeking: video.seeking, ended: video.ended, readyState: video.readyState, currentTime: video.currentTime } : null,
      captureComplete: !!s && s.snapshots.length < 1500 && s.controls.length < 1500 && s.events.length < 12000 && s.prepared.length < 12000 && s.delivered.length < 12000 && s.drops.length < 12000 && s.wireRows.length < 12000 && s.stages.length < 24000 && s.measurements.length < 24000
        && !!s.nativeLifecycle && !s.nativeLifecycle.truncated && s.nativeLifecycle.errors === 0,
      hidden: document.hidden, online: navigator.onLine, fullscreen: !!document.fullscreenElement,
      viewport: { width: innerWidth, height: innerHeight }, url: location.origin + location.pathname };
  });
  return { ...observation, ...await page.evaluate(inspectNativeRestoration) };
}

const networkRows = new WeakMap(), networkTasks = new Set();
function trackNetworkTask(task) { networkTasks.add(task); void task.finally(() => networkTasks.delete(task)); }
function installNetworkObserver() {
  context.on('request', request => {
    if (request.url() !== config.endpoint || request.method() !== 'POST') return;
    const row = { id: 'http-' + (report.providerRequests.length + 1), startedAt: Date.now(), phase: report.phase,
      serviceWorker: !!request.serviceWorker(), items: [], status: 'pending' };
    // Deliberately never read request headers, cookies or Authorization.
    try {
      const body = request.postDataJSON(), user = decodeTranslationFixtureRequest(body);
      row.model = body.model; row.sourceLanguage = user.sourceLanguage; row.targetLanguage = user.targetLanguage;
      row.protocol = user.protocol;
      row.thinking = body.thinking?.type ?? null; row.reasoningEffort = body.reasoning_effort ?? null;
      row.items = user.items.slice(0, 200).map(item => ({ engineId: String(item.id).slice(0, 100), textSha256: hash(item.text) }));
    } catch { row.metadataUnavailable = true; }
    networkRows.set(request, row); report.providerRequests.push(row);
    if (report.providerRequests.length >= maxRequests && !report.budget.requestLimitReachedAt) {
      report.budget.requestLimitReachedAt = Date.now();
      trackNetworkTask((async () => { if (rpc) await rpc({ type: 'toggle', enabled: false }).catch(() => {}); })());
    }
    // Disable is asynchronous: permit only the configured concurrency already in flight.
    if (report.providerRequests.length > maxRequests + config.concurrency) {
      report.budget.forcedClose = true; closing = true;
      trackNetworkTask(context.close().catch(() => {}));
    }
  });
  context.on('requestfinished', request => {
    const row = networkRows.get(request); if (!row) return;
    row.completedAt = Date.now();
    trackNetworkTask((async () => { const response = await request.response(); row.status = response?.status() ?? 'unknown'; })().catch(() => { row.status = 'unknown'; }));
  });
  context.on('requestfailed', request => {
    const row = networkRows.get(request); if (!row) return;
    row.completedAt = Date.now(); row.status = 'failed'; row.failure = redact(request.failure()?.errorText || 'request-failed').slice(0, 160);
  });
}
const canonicalId = row => JSON.stringify(['niconico', row.resourceId, row.adapterSession, row.sourceId]);
function canonicalRows(observation) {
  const sources = (observation.events || []).map(e => ({ id: canonicalId(e), receivedAt: e.receivedAt,
    deadlineAt: (e.scheduledAt ?? e.receivedAt) + config.liveBufferMs, sentAtEpochMs: e.sentAtEpochMs,
    eligible: e.translatable === true && needsTranslation(e.originalText, config.targetLanguage, config.liveSourceLanguage) && !protectText(e.originalText).reason,
    originalTextSha256: hash(e.originalText), phase: e.phase, nativeSourceIdentity: e.nativeSourceIdentity }));
  const outcomes = (observation.delivered || []).map(d => {
    const e = observation.events.find(e => canonicalId(e) === canonicalId(d));
    const prepared = observation.prepared.find(p => canonicalId(p) === canonicalId(d) && p.originalText === e?.originalText && p.observedAt <= d.releasedAt);
    const stage = observation.stages.find(s => s.createdSlot && e?.nativeSourceIdentity?.key && s.nativeSourceIdentity?.key === e.nativeSourceIdentity.key && s.originalText === e.originalText && Math.abs(s.at - d.displayAt) <= 2);
    const measurement = stage && observation.measurements.find(m => m.text === stage.text && m.at <= stage.at + 1 && m.at >= stage.at - 100);
    const changedAfterDisplay = !!stage && observation.stages.some(s => s.createdSlot && s.no === stage.no
      && s.sentAtEpochMs === stage.sentAtEpochMs && s.at > stage.at + 2 && s.text !== stage.text && s.phase === d.phase);
    return { id: canonicalId(d), kind: d.translated ? 'translated' : 'original', at: d.displayAt,
      ...(prepared ? { preparedAt: prepared.observedAt } : {}), releasedAt: d.releasedAt,
      nativeSlotObserved: !!stage, preparedMeasurementObserved: !!measurement,
      nativeSourceIdentity: stage?.nativeSourceIdentity ?? null,
      originalTextPreserved: !!stage && stage.originalText === e?.originalText,
      textChangedAfterDisplay: changedAfterDisplay,
      ...(stage ? { displayTextSha256: hash(stage.text) } : {}), phase: d.phase };
  });
  for (const d of observation.drops || []) outcomes.push({ id: canonicalId(d), kind: 'dropped', at: d.observedAt, reason: d.reason, phase: d.phase });
  return { sources, outcomes };
}
function correlateChains(observation) {
  return (observation.delivered || []).filter(d => d.translated).flatMap(d => {
    const e = observation.events.find(e => canonicalId(e) === canonicalId(d));
    const p = observation.prepared.find(p => canonicalId(p) === canonicalId(d) && p.originalText === e?.originalText && p.observedAt <= d.releasedAt);
    const stage = p && observation.stages.find(s => s.createdSlot && e?.nativeSourceIdentity?.key && s.nativeSourceIdentity?.key === e.nativeSourceIdentity.key && s.text === p.text && s.originalText === p.originalText && Math.abs(s.at - d.displayAt) <= 2);
    const measurement = stage && observation.measurements.find(m => m.text === p.text && m.at <= stage.at + 1 && m.at >= stage.at - 100);
    if (!e || !p || !stage || !measurement) return [];
    const protectedHash = hash(protectText(e.originalText).text);
    const candidates = report.providerRequests.filter(r => typeof r.status === 'number' && r.status >= 200 && r.status < 300
      && r.completedAt <= p.observedAt + 10 && r.items.some(item => item.textSha256 === protectedHash));
    const fresh = candidates.filter(r => r.startedAt >= e.receivedAt - 10);
    return [{ id: canonicalId(e), sourceId: e.sourceId, adapterSession: e.adapterSession, resourceId: e.resourceId,
      originalText: e.originalText, text: p.text, receivedAt: e.receivedAt, preparedAt: p.observedAt,
      releasedAt: d.releasedAt, nativeSlotAt: stage.at, displayAt: d.displayAt, measuredWidth: measurement.width,
      actualBufferMs: d.releasedAt - e.receivedAt, sourceTextPreserved: stage.originalText === e.originalText,
      providerRequestCandidates: candidates.map(r => r.id), freshProviderRequestCandidates: fresh.map(r => r.id),
      correlation: 'protected-text-and-time-only; engine HTTP IDs are not source IDs; duplicates/cache may share requests' }];
  });
}
async function assertConfiguration() {
  const saved = await rpc({ type: 'settings' }); assert.equal(saved.ok, true, 'settings RPC failed');
  for (const name of ['endpoint', 'model', 'profile', 'thinkingEffort', 'sourceLanguage', 'targetLanguage', 'liveSourceLanguage', 'concurrency', 'batchSize']) {
    assert.equal(saved.settings[name], config[name], 'Provider/language setting changed: ' + name);
  }
  assert.equal(saved.remembered, false, 'test credential must remain session-only');
  return saved;
}
async function toggle(enabled, name) {
  assert.ok(!enabled || !report.budget.requestLimitReachedAt && Date.now() < deadlineAt, 'Do not re-enable after the bounded Provider budget');
  report.phase = name;
  await page.evaluate(name => { window.__DL_NICO_EXTENSION_EVIDENCE__.phase = name; }, name);
  assert.equal((await rpc({ type: 'toggle', enabled })).ok, true, 'toggle RPC failed'); await page.bringToFront();
  await waitFor(() => page.evaluate(enabled => window.__DL_NICO_EXTENSION_EVIDENCE__.controls.at(-1)?.enabled === enabled, enabled), 'actual isolated control ' + enabled);
  await assertConfiguration();
}
async function disableAndRestore(name) {
  const restoration = { name, status: 'running', before: await page.evaluate(inspectNativeRestoration, { captureBeforeDisable: true }), after: null };
  (report.nativeRestorations ||= []).push(restoration); await persist();
  try {
    await toggle(false, name);
    await waitFor(async () => {
      restoration.after = await page.evaluate(inspectNativeRestoration);
      const r = restoration.after.restored; return r?.input && r.dispatcher && r.filters;
    }, 'native hooks/filters restored');
    restoration.status = 'PASS';
    return await collect();
  } catch (error) {
    restoration.status = 'INCOMPLETE'; throw error;
  } finally {
    restoration.after = await page.evaluate(inspectNativeRestoration).catch(() => restoration.after);
    restoration.finishedAt = Date.now(); await persist();
  }
}
async function openRoom(id, { activeNavigation = false } = {}) {
  report.phase = 'startup-' + id;
  await page.goto('https://live.nicovideo.jp/watch/' + id, { waitUntil: 'domcontentloaded', timeout: 45000 }); await page.bringToFront();
  await page.locator('div[id^="renderer-parent-id-"]').first().waitFor({ state: 'attached', timeout: 25000 });
  const program = await page.evaluate(() => { const p = JSON.parse(document.getElementById('embedded-data')?.getAttribute('data-props') || '{}').program; return p && { id: p.nicoliveProgramId, status: p.status, title: p.title, vposBaseTime: p.vposBaseTime }; });
  assert.equal(program?.id, id, 'actual program must match requested room'); assert.equal(program?.status, 'ON_AIR', 'requested room must currently be ON_AIR');
  const play = page.getByRole('button', { name: '再生', exact: true }); if (await play.isVisible()) await play.click();
  await waitFor(() => page.evaluate(() => { const v = document.querySelector("[data-layer-name='videoLayer'] video"); return v && !v.paused && !v.seeking && !v.ended && v.readyState >= 2; }), 'actual program video ready', 20000);
  let nativeBefore;
  if (activeNavigation) {
    const proof = await waitFor(() => page.evaluate(() => {
      const proof = window.__DL_NICO_EXTENSION_EVIDENCE__?.earlyNativeObserver;
      return proof && proof.status !== 'running' ? proof : null;
    }), 'early observer baseline result');
    nativeBefore = { ...proof.native, earlyProof: proof };
    assert.equal(proof.status, 'PASS', 'active navigation cannot establish an observer baseline before production: ' + (proof.reason || proof.native?.reason || 'unknown'));
    assert.equal(proof.native?.baseline?.beforeProductFilter, true, 'native baseline must precede production attachment');
  } else {
    nativeBefore = await page.evaluate(attachNativeObserver); assert.equal(nativeBefore.found, true, 'native observer attached while disabled');
  }
  const state = { program, nativeBefore }; report.rooms.push(state); if (!report.program) report.program = program;
  return state;
}
function auditPlaybackSnapshots(observation, resourceId, startAt, endAt) {
  const snapshots = (observation.snapshots || []).filter(s => s.platform === 'niconico' && s.resourceId === resourceId
    && s.observedAt >= startAt && s.observedAt < endAt);
  const unhealthy = snapshots.filter(s => s.hidden || s.connection !== 'connected' || !s.playback
    || s.playback.paused || s.playback.seeking || !s.playback.contentActive || !s.playback.atLiveEdge);
  return { observed: snapshots.length, healthy: snapshots.length > 0 && unhealthy.length === 0, unhealthy,
    scope: 'Actual adapter bridge snapshots in the fixed receipt window, including session changes; no inferred delivery acknowledgments.' };
}
async function observeWindow(name, roomState, windowSeconds = seconds) {
  report.phase = name;
  const startAt = await page.evaluate(name => { window.__DL_NICO_EXTENSION_EVIDENCE__.phase = name; return performance.timeOrigin + performance.now(); }, name);
  const endAt = startAt + windowSeconds * 1000;
  const result = { name, room: roomState.program.id, status: 'running', window: { startAt, endAt, observedUntil: null }, playbackSamples: [] };
  report.windows.push(result); await persist();
  // Fixed receipt window, with real playback/control samples throughout, not just at its end.
  while (Date.now() < endAt && !closing) {
    result.playbackSamples.push(await page.evaluate(() => {
      const v = document.querySelector("[data-layer-name='videoLayer'] video"), s = window.__DL_NICO_EXTENSION_EVIDENCE__;
      return { at: performance.timeOrigin + performance.now(), online: navigator.onLine, hidden: document.hidden,
        enabled: s.controls.at(-1)?.enabled === true, atLiveEdge: !!document.querySelector('[data-live-status="live"]') && !document.querySelector('[data-live-status="chase"]'),
        video: v ? { paused: v.paused, seeking: v.seeking, ended: v.ended, readyState: v.readyState, time: v.currentTime } : null };
    }));
    await delay(Math.max(0, Math.min(1000, endAt - Date.now())));
  }
  if (closing) throw new Error('Browser closed by bounded run budget');
  await page.screenshot({ path: resolve(root, name + '-' + (realProvider ? 'real-provider' : 'local-mock') + '.png') });
  await delay(drainMs);
  const observation = await collect(); result.window.observedUntil = Date.now();
  const { sources, outcomes } = canonicalRows(observation);
  const sourceIds = new Set(sources.filter(s => s.receivedAt >= startAt && s.receivedAt < endAt).map(s => s.id));
  result.canonicalSources = sources.filter(s => sourceIds.has(s.id)); result.canonicalOutcomes = outcomes.filter(o => sourceIds.has(o.id));
  const samples = result.playbackSamples;
  const continuouslyHealthy = samples.length >= Math.floor(windowSeconds / 1.5) && samples.every(s => s.online && !s.hidden && s.enabled && s.atLiveEdge
    && s.video && !s.video.paused && !s.video.seeking && !s.video.ended && s.video.readyState >= 2);
  const advancing = samples.length > 3 && samples.every((s, i) => i < 3 || s.video && samples[i - 3].video && s.video.time - samples[i - 3].video.time >= 0.1);
  // A brief seek/reset can fall between the one-second video samples.
  result.playbackSnapshotAudit = auditPlaybackSnapshots(observation, roomState.program.id, startAt, endAt);
  const { summarizeLiveWindow } = await import('./live-acceptance-metrics.mjs');
  result.metrics = summarizeLiveWindow({ providerKind, bufferMs: config.liveBufferMs, window: result.window,
    sources, outcomes, requests: report.providerRequests, minimumEligible: 20, captureComplete: observation.captureComplete,
    playbackHealthy: continuouslyHealthy && advancing && result.playbackSnapshotAudit.healthy });
  result.chains = correlateChains(observation).filter(c => sourceIds.has(c.id));
  result.playback = observation.mainVideo;
  result.nativeSlotAudit = result.canonicalSources.map(source => {
    const slots = source.nativeSourceIdentity?.key ? observation.stages.filter(s => s.createdSlot && s.nativeSourceIdentity?.key === source.nativeSourceIdentity.key
      && s.at >= source.receivedAt && s.at <= result.window.observedUntil && s.phase === name) : [];
    return { id: source.id, nativeSourceIdentity: source.nativeSourceIdentity ?? null,
      successfulSlotCreations: slots.map(s => {
        const control = observation.controls.filter(c => c.observedAt <= s.at).at(-1);
        return { at: s.at, layer: s.layer, repositoryId: s.repositoryId, slotId: s.outputSlotId, displayTextSha256: hash(s.text), isOriginal: s.text === s.originalText,
          observedControlEnabled: control?.enabled ?? null, observedControlAt: control?.observedAt ?? null };
      }) };
  });
  result.observedDisableControls = observation.controls.filter(c => c.enabled === false && c.observedAt >= startAt && c.observedAt <= result.window.observedUntil);
  result.postDisableNativeRecreations = result.nativeSlotAudit.flatMap(row => row.successfulSlotCreations.slice(1)
    .filter(slot => slot.observedControlEnabled === false).map(slot => ({ id: row.id, nativeSourceIdentity: row.nativeSourceIdentity, ...slot })));
  result.nativeSlotAuditLimit = 'Only exact observed decoded source ID -> native no/date/usec identities are associated. Missing identity is unverified; slot creation is not physical pixel presentation.';
  result.nativeSlotLifecycles = auditNativeSlotLifecycles(observation, { sources: result.canonicalSources, phase: name, observedUntil: result.window.observedUntil });
  const integrityCounts = ['missingOutcome', 'duplicateDeliveries', 'changedAfterDisplay', 'preparedAfterDeadline', 'missingPreparationEvidence', 'conflictingTerminalOutcomes', 'invalidChronology', 'conflictingSources'];
  const translatedOutcomes = result.canonicalOutcomes.filter(o => o.kind === 'translated');
  result.checks = { completeCapture: observation.captureComplete, actualRoom: observation.url === 'https://live.nicovideo.jp/watch/' + roomState.program.id,
    healthyThroughoutSampledWindow: continuouslyHealthy, videoAdvancedThroughoutSampledWindow: advancing,
    healthyThroughoutObservedBridgeSnapshots: result.playbackSnapshotAudit.healthy,
    completeIntegrityEvidence: integrityCounts.every(k => result.metrics.counts[k] === 0),
    budgetUnaffected: !report.budget.requestLimitReachedAt && !report.budget.timeLimitReachedAt,
    translatedNativeEvidenceComplete: translatedOutcomes.every(o => o.nativeSlotObserved && o.preparedMeasurementObserved && Number.isFinite(o.preparedAt)),
    nativeIdentitiesObserved: result.nativeSlotAudit.every(row => !!row.nativeSourceIdentity),
    noDuplicateNativeSlotCreation: result.nativeSlotAudit.every(row => row.successfulSlotCreations.length <= 1),
    completeNativeSlotLifecycleEvidence: result.nativeSlotLifecycles.evidenceComplete,
    noConcurrentNativeSlots: result.nativeSlotLifecycles.noConcurrentNativeSlots === true,
    activeProgramVideo: !!observation.mainVideo && !observation.mainVideo.paused && !observation.mainVideo.seeking && !observation.mainVideo.ended && observation.mainVideo.readyState >= 2,
    actualSourceEvents: sourceIds.size > 0, actualNativePreparedDelivery: result.chains.length > 0,
    actualProviderNetworkObserved: report.providerRequests.some(r => r.startedAt >= startAt && r.startedAt < endAt && r.serviceWorker && typeof r.status === 'number' && r.status >= 200 && r.status < 300),
    noEarlyRelease: result.canonicalOutcomes.filter(o => ['translated', 'original'].includes(o.kind)).every(o => {
      const s = result.canonicalSources.find(s => s.id === o.id); return !!s && o.releasedAt >= s.deadlineAt - 20;
    }), originalSourcePreserved: result.canonicalOutcomes.filter(o => ['translated', 'original'].includes(o.kind)).every(o => o.originalTextPreserved),
    uniqueDeliveryAcknowledgments: new Set(result.canonicalOutcomes.filter(o => ['translated', 'original'].includes(o.kind)).map(o => o.id)).size === result.canonicalOutcomes.filter(o => ['translated', 'original'].includes(o.kind)).length };
  result.status = Object.values(result.checks).every(Boolean) ? 'PASS' : 'INCOMPLETE';
  roomState.observation = observation;
  await assertConfiguration(); await persist();
  console.log(name + ': ' + result.status + ', sources=' + result.canonicalSources.length + ', native prepared chains=' + result.chains.length);
  return result;
}
async function mediaActionState(captureReference = false) {
  return page.evaluate(captureReference => {
    const s = window.__DL_NICO_EXTENSION_EVIDENCE__, v = document.querySelector("[data-layer-name='videoLayer'] video");
    let currentNative;
    for (const element of document.querySelectorAll('div[id^="renderer-parent-id-"]')) {
      const key = Object.keys(element).find(k => k.startsWith('__reactFiber$'));
      for (let f = key && element[key], i = 0; f && i < 20; f = f.return, i++) {
        if (f.stateNode?.addToRender && f.stateNode.renderer?.layerProcessorList?.length) { currentNative = f.stateNode; break; }
      }
      if (currentNative) break;
    }
    if (captureReference) s.mediaActionReference = { native: s.native, renderer: s.native?.renderer,
      layers: [...(s.native?.renderer?.layerProcessorList || [])],
      processors: (s.native?.renderer?.layerProcessorList || []).map(l => l.processor) };
    const ref = s.mediaActionReference, layers = currentNative?.renderer?.layerProcessorList;
    return { at: performance.timeOrigin + performance.now(), hidden: document.hidden, online: navigator.onLine,
      documentTimeOrigin: performance.timeOrigin, url: location.origin + location.pathname,
      live: !!document.querySelector('[data-live-status="live"]'), chase: !!document.querySelector('[data-live-status="chase"]'),
      video: v ? { paused: v.paused, seeking: v.seeking, ended: v.ended, readyState: v.readyState, time: v.currentTime } : null,
      bridge: s.snapshots.at(-1) ?? null, enabled: s.controls.at(-1)?.enabled === true,
      nativeObserverUnchanged: !!ref?.native && currentNative === ref.native && currentNative === s.native
        && currentNative.renderer === ref.renderer && layers.length === ref.layers.length
        && layers.every((l, i) => l === ref.layers[i] && l.processor === ref.processors[i]) };
  }, captureReference);
}
function mediaLiveReady(state) {
  const p = state.bridge?.playback, v = state.video;
  return state.enabled && state.online && !state.hidden && state.nativeObserverUnchanged && state.live && !state.chase
    && v && !v.paused && !v.seeking && !v.ended && v.readyState >= 2
    && state.bridge?.connection === 'connected' && p?.contentActive && p.atLiveEdge && !p.paused && !p.seeking;
}
async function sampleMediaAction(action, phase) {
  const state = await mediaActionState();
  const record = (action.observations ||= {})[phase] ||= { samples: [], count: 0, truncated: false, limit: 320 };
  record.count++; record.last = state;
  if (record.samples.length < record.limit) record.samples.push(state); else record.truncated = true;
  return state;
}
async function mediaControlDiagnostics() {
  return page.evaluate(() => {
    const video = document.querySelector("[data-layer-name='videoLayer'] video"), player = video?.closest('[data-player-layout]');
    const controls = [...(player?.querySelectorAll('button') || [])].slice(0, 40).map(e => ({
      tag: e.tagName, className: e.className, role: e.getAttribute('role'), type: e.getAttribute('type'),
      ariaLabel: e.getAttribute('aria-label'), title: e.getAttribute('title'), text: e.textContent?.trim().slice(0, 100), disabled: e.disabled,
      liveStatus: e.getAttribute('data-live-status'), stepSeconds: e.getAttribute('data-step-sec'),
      hasLayoutBox: e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0,
      childTags: [...e.children].slice(0, 6).map(child => ({ tag: child.tagName, className: child.getAttribute('class'),
        ariaLabel: child.getAttribute('aria-label'), viewBox: child.getAttribute('viewBox') })) }));
    const messages = [...document.querySelectorAll('[role="alert"], [role="dialog"]')].filter(e => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0)
      .slice(0, 6).map(e => ({ role: e.getAttribute('role'), text: e.textContent?.trim().slice(0, 300) }));
    return { at: performance.timeOrigin + performance.now(), playerFound: !!player, controls, messages };
  });
}
async function originalMediaButton(label, evidence) {
  const button = page.getByRole('button', { name: label, exact: true });
  const row = { label, startedAt: Date.now() }; evidence.buttons.push(row);
  const player = page.locator('[data-player-layout]').filter({ has: page.locator("[data-layer-name='videoLayer'] video") });
  row.hover = { selector: '[data-player-layout] containing the actual videoLayer video', matches: await player.count() };
  row.hover.visible = row.hover.matches === 1 && await player.isVisible();
  assert.ok(row.hover.visible, 'Actual Nico program player unavailable or ambiguous for control hover');
  await player.hover({ timeout: 5000 });
  await button.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  row.matches = await button.count();
  row.visible = row.matches === 1 && await button.isVisible();
  row.enabled = row.visible && await button.isEnabled();
  if (!row.visible || !row.enabled) {
    row.controlDiagnostics = await mediaControlDiagnostics(); row.availableControls = row.controlDiagnostics.controls;
  }
  assert.ok(row.visible && row.enabled, 'Original Nico control unavailable or ambiguous: ' + label + ' (visible=' + row.visible + ', enabled=' + row.enabled + ', matches=' + row.matches + ')');
  row.attributes = await button.evaluate(e => ({ tag: e.tagName, ariaLabel: e.getAttribute('aria-label'), title: e.getAttribute('title'),
    liveStatus: e.getAttribute('data-live-status'), stepSeconds: e.getAttribute('data-step-sec') }));
  if (label === 'ライブ再生に戻る (End)') assert.equal(row.attributes.liveStatus, 'chase', 'Return-to-LIVE control must expose the official CHASE marker');
  row.startedAt = await page.evaluate(() => performance.timeOrigin + performance.now());
  await button.click({ timeout: 5000 });
  row.finishedAt = await page.evaluate(() => performance.timeOrigin + performance.now()); return row;
}
async function observeMediaLifecycle(name, roomState, row) {
  const action = row.mediaAction = { name, scope: 'Real original site button -> observed inactive state -> fresh ordinary LIVE recovery only',
    buttons: [], inactiveSamples: [], inactiveMs: 2500, recoveryWindowSeconds: 30, drainMs,
    sourceEvidence: { bundle: 'pc-watch.286b6a0d.js', controls: 'vc.629883f31c.js modules 667 and 18796',
      liveBackButton: 'Official LIVE handler seeks -30000ms even when the configured button label says 10 seconds.' } };
  const before = await collect(), saved = await assertConfiguration();
  action.before = await mediaActionState(true);
  assert.ok(mediaLiveReady(action.before), 'Media lifecycle requires actual healthy LIVE and a current native observer before the action');
  assert.equal(saved.settings.enabled, true, 'Media action must keep translation enabled');
  const oldSessions = new Set([...before.events, ...before.snapshots].map(e => e.adapterSession));
  await page.evaluate(name => { window.__DL_NICO_EXTENSION_EVIDENCE__.phase = name; }, name + '-deactivating'); report.phase = name + '-deactivating';
  const trigger = await originalMediaButton(name === 'pause-resume' ? '一時停止 (Space)' : '10秒戻し (←)', action);
  const isInactive = state => state.enabled && state.online && !state.hidden && state.nativeObserverUnchanged
    && state.bridge?.observedAt >= trigger.startedAt
    && (name === 'pause-resume' ? state.video?.paused === true && state.bridge.playback?.paused === true
      : state.chase && !state.live && state.bridge.playback?.atLiveEdge === false);
  action.inactiveState = await waitFor(async () => { const state = await sampleMediaAction(action, 'deactivating'); return isInactive(state) ? state : null; }, 'actual Nico ' + name + ' inactive DOM and bridge state', 15000);
  action.inactiveObservedAt = action.inactiveState.bridge.observedAt;
  action.inactiveStartAt = action.inactiveState.at;
  await page.evaluate(name => { window.__DL_NICO_EXTENSION_EVIDENCE__.phase = name; }, name + '-inactive'); report.phase = name + '-inactive';
  const quietEnd = action.inactiveStartAt + action.inactiveMs;
  do {
    action.inactiveSamples.push(await mediaActionState());
    assert.ok(!closing && Date.now() < deadlineAt && !report.budget.requestLimitReachedAt, 'Media inactivity observation interrupted by the bounded budget');
    if (Date.now() >= quietEnd) break;
    await delay(Math.min(100, quietEnd - Date.now()));
  } while (true);
  const inactive = await collect(); action.inactiveEndAt = inactive.capturedAt;
  // Read-only observations cannot infer a native queue commit from a passed deadline.
  // A later original delivery is allowed only when its recorded releasedAt proves the earlier commit.
  const insideQuiet = at => at >= action.inactiveStartAt && at <= action.inactiveEndAt;
  action.inactivePrepared = inactive.prepared.filter(p => insideQuiet(p.observedAt));
  action.inactiveEvents = inactive.events.filter(e => insideQuiet(e.observedAt));
  action.inactiveDeliveries = inactive.delivered.filter(d => insideQuiet(d.observedAt));
  action.committedOriginalDeliveries = action.inactiveDeliveries.filter(d => !d.translated && d.releasedAt < action.inactiveObservedAt
    && inactive.events.some(e => canonicalId(e) === canonicalId(d) && e.receivedAt < action.inactiveObservedAt));
  action.inactiveOriginalSlots = inactive.stages.filter(s => insideQuiet(s.at) && s.createdSlot && s.text === s.originalText).length;
  action.inactiveWireEvents = inactive.wireRows.filter(w => insideQuiet(w.observedAt)).length;
  action.preRecovery = { events: inactive.events.length, wireEvents: inactive.wireRows.length,
    inFlightRequestIds: report.providerRequests.filter(r => !r.completedAt).map(r => r.id) };
  await persist();
  await page.evaluate(name => { window.__DL_NICO_EXTENSION_EVIDENCE__.phase = name; }, name + '-recovering'); report.phase = name + '-recovering';
  action.recoveryRequestedAt = await page.evaluate(() => performance.timeOrigin + performance.now());
  if (name === 'pause-resume') {
    await originalMediaButton('再生 (Space)', action);
    const resumed = await waitFor(async () => {
      const state = await sampleMediaAction(action, 'resuming');
      return state.video && !state.video.paused && !state.video.seeking && !state.video.ended && state.video.readyState >= 2
        && state.bridge?.observedAt >= action.recoveryRequestedAt && state.bridge.playback?.paused === false ? state : null;
    }, 'actual program resume after the original Play button', 15000);
    if (resumed.chase) await originalMediaButton('ライブ再生に戻る (End)', action);
  } else await originalMediaButton('ライブ再生に戻る (End)', action);
  action.recoveredState = await waitFor(async () => {
    const state = await sampleMediaAction(action, 'recovering');
    return state.bridge?.observedAt >= action.recoveryRequestedAt && mediaLiveReady(state) ? state : null;
  }, 'fresh original LIVE DOM, program playback and bridge recovery', 20000);
  const result = await observeWindow(name + '-recovered', roomState, 30), after = roomState.observation;
  action.after = await mediaActionState();
  const beforeRecoveryEvents = after.events.filter(e => e.observedAt < action.recoveryRequestedAt);
  const oldSourceIds = new Set([...beforeRecoveryEvents, ...after.wireRows.filter(w => w.observedAt < action.recoveryRequestedAt)].map(e => e.sourceId));
  const oldNativeKeys = new Set([...beforeRecoveryEvents, ...after.wireRows.filter(w => w.observedAt < action.recoveryRequestedAt)].map(e => e.nativeSourceIdentity?.key).filter(Boolean));
  const freshEvents = after.events.filter(e => e.observedAt >= action.recoveryRequestedAt);
  const terminals = [...after.delivered, ...after.drops];
  const alreadyTerminal = new Set([...before.delivered, ...before.drops].map(canonicalId));
  action.interruptedSources = beforeRecoveryEvents.filter(e => !alreadyTerminal.has(canonicalId(e))).map(e => ({ id: canonicalId(e),
    nativeSourceIdentity: e.nativeSourceIdentity ?? null, deadlineAt: (e.scheduledAt ?? e.receivedAt) + config.liveBufferMs,
    outcomes: terminals.filter(t => canonicalId(t) === canonicalId(e)).map(t => ({ kind: t.reason ? 'dropped' : t.translated ? 'translated' : 'original',
      reason: t.reason, observedAt: t.observedAt, releasedAt: t.releasedAt, displayAt: t.displayAt,
      nativeSlotObserved: !!t.reason || !!e.nativeSourceIdentity?.key && after.stages.some(s => s.createdSlot
        && s.nativeSourceIdentity?.key === e.nativeSourceIdentity.key && s.originalText === e.originalText && Math.abs(s.at - t.displayAt) <= 2) })) }));
  const currentSource = d => after.events.find(e => canonicalId(e) === canonicalId(d));
  const bridgeAllowsTranslation = at => {
    const s = after.snapshots.filter(s => s.observedAt <= at).at(-1), p = s?.playback;
    return s?.connection === 'connected' && !s.hidden && p?.contentActive && p.atLiveEdge && !p.paused && !p.seeking;
  };
  action.preparedWhileObservedInactive = after.prepared.filter(p => p.observedAt >= trigger.startedAt
    && (insideQuiet(p.observedAt) || !bridgeAllowsTranslation(p.observedAt)));
  action.translatedWhileObservedInactive = after.delivered.filter(d => d.translated && d.displayAt >= trigger.startedAt
    && (insideQuiet(d.displayAt) || !bridgeAllowsTranslation(d.displayAt)));
  action.staleTranslatedDeliveries = after.delivered.filter(d => d.translated && d.displayAt >= action.inactiveObservedAt
    && (!currentSource(d) || oldSessions.has(d.adapterSession) || currentSource(d).observedAt < action.recoveryRequestedAt));
  action.staleRecoveryPreparations = after.prepared.filter(p => p.observedAt >= action.recoveryRequestedAt
    && (!currentSource(p) || oldSessions.has(p.adapterSession) || currentSource(p).observedAt < action.recoveryRequestedAt));
  action.uncommittedOldOriginalDeliveries = after.delivered.filter(d => !d.translated && d.displayAt >= action.inactiveObservedAt
    && currentSource(d)?.observedAt < action.recoveryRequestedAt && !(d.releasedAt < action.inactiveObservedAt));
  action.replayedTranslatedSlots = after.stages.filter(s => s.createdSlot && s.at >= action.recoveryRequestedAt
    && oldNativeKeys.has(s.nativeSourceIdentity?.key) && s.text !== s.originalText
    && after.prepared.some(p => p.text === s.text));
  const savedAfter = await assertConfiguration();
  const affectedTerminalIds = new Set(terminals.filter(t => t.observedAt >= trigger.startedAt).map(canonicalId));
  action.checks = {
    actualInactiveThroughoutQuietInterval: action.inactiveSamples.length >= 20 && action.inactiveSamples.every(isInactive)
      && action.inactiveEndAt - action.inactiveStartAt >= action.inactiveMs,
    noNewEventsWhileInactive: action.inactiveEvents.length === 0,
    noPreparedWhileObservedInactive: action.preparedWhileObservedInactive.length === 0,
    noTranslatedDeliveryWhileObservedInactive: action.translatedWhileObservedInactive.length === 0,
    inactiveDeliveriesOnlyPreviouslyDisplayedOrCommittedOriginal: action.inactiveDeliveries.every(d => d.displayAt < action.inactiveStartAt
      || action.committedOriginalDeliveries.includes(d)),
    interruptedSourcesRetainOneOutcome: action.interruptedSources.every(e => e.outcomes.length === 1),
    interruptedDeliveriesHaveNativeEvidence: action.interruptedSources.every(e => e.outcomes.every(o => o.nativeSlotObserved)),
    noStaleTranslatedDelivery: action.staleTranslatedDeliveries.length === 0,
    noStaleRecoveryPreparation: action.staleRecoveryPreparations.length === 0,
    noUncommittedOldOriginalReplay: action.uncommittedOldOriginalDeliveries.length === 0,
    noTranslatedReplayOfOldNativeSource: action.replayedTranslatedSlots.length === 0,
    actualFreshRecoverySources: freshEvents.length > 0 && freshEvents.every(e => e.resourceId === roomState.program.id
      && e.receivedAt >= action.recoveryRequestedAt && !oldSessions.has(e.adapterSession) && !oldSourceIds.has(e.sourceId)
      && !!e.nativeSourceIdentity?.key && !oldNativeKeys.has(e.nativeSourceIdentity.key)),
    recoveredSessionChanged: !oldSessions.has(action.recoveredState.bridge.adapterSession),
    freshPreparedNativeChain: result.chains.length > 0 && result.chains.every(c => !oldSessions.has(c.adapterSession) && !oldSourceIds.has(c.sourceId)),
    noUnknownTerminalSource: terminals.filter(t => t.observedAt >= trigger.startedAt).every(t => !!currentSource(t)),
    noRepeatedTerminalOutcome: [...affectedTerminalIds].every(id => terminals.filter(t => canonicalId(t) === id).length === 1),
    sameDocumentAndRoom: action.after.documentTimeOrigin === action.before.documentTimeOrigin && action.after.url === action.before.url,
    nativeObserverRemainedCurrent: action.inactiveSamples.every(s => s.nativeObserverUnchanged) && action.recoveredState.nativeObserverUnchanged && action.after.nativeObserverUnchanged,
    stayedEnabled: after.controls.filter(c => c.observedAt >= trigger.startedAt).every(c => c.enabled) && action.after.enabled,
    settingsUnchanged: JSON.stringify(savedAfter.settings) === JSON.stringify(saved.settings),
    completeCapture: after.captureComplete,
    completeTransitionObservations: Object.values(action.observations || {}).every(record => !record.truncated),
    fullRecoveryWindow: result.status === 'PASS' && result.window.endAt - result.window.startAt === 30000,
  };
  action.window = result.name; action.status = Object.values(action.checks).every(Boolean) ? 'PASS' : 'INCOMPLETE';
  action.limitations = ['Old already-committed original slots retain their old identities; unhandled site originals are not extension deliveries.',
    'Only the naturally observed interrupted sources and in-flight requests are covered; a zero count does not establish cancellation stress.',
    'Missing outcomes remain missing; no synthetic source, playback mutation, additional wait to select a better window, ad or player-reconstruction claim.'];
  return { status: action.status, window: result.name, checks: action.checks, scope: action.scope };
}
async function stage(name, action) {
  const row = { name, startedAt: Date.now(), status: 'running' }; report.stages.push(row);
  try {
    assert.ok(!closing && !report.budget.requestLimitReachedAt && Date.now() < deadlineAt, 'Stage not executed after bounded run budget');
    row.detail = await action(row); row.status = row.detail?.status === 'INCOMPLETE' ? 'INCOMPLETE' : 'PASS';
  }
  catch (error) {
    row.status = 'INCOMPLETE'; row.error = redact(error.message).slice(0, 600);
    if (row.mediaAction && page && !closing) {
      row.mediaAction.failureState = await sampleMediaAction(row.mediaAction, 'failure').catch(() => null);
      row.mediaAction.failureControlDiagnostics = await mediaControlDiagnostics().catch(() => null);
    }
  }
  row.finishedAt = Date.now(); await persist(); return row;
}

try {
  const languageSettings = { sourceLanguage: process.env.DANLINGO_E2E_SOURCE_LANGUAGE || DEFAULT_SETTINGS.sourceLanguage,
    targetLanguage: process.env.DANLINGO_E2E_TARGET_LANGUAGE || DEFAULT_SETTINGS.targetLanguage,
    liveSourceLanguage: process.env.DANLINGO_E2E_LIVE_SOURCE_LANGUAGE || 'ja' };
  if (realProvider) {
    for (const name of ['DANLINGO_E2E_ENDPOINT', 'DANLINGO_E2E_MODEL', 'DANLINGO_E2E_PROFILE', 'DANLINGO_E2E_THINKING']) assert.ok(process.env[name], 'Set explicit ' + name + ' before real-provider work');
    assert.ok(['minimax', 'deepseek', 'gemini', 'chat-completions'].includes(process.env.DANLINGO_E2E_PROFILE), 'Invalid explicit Provider profile');
    config = normalizeSettings({ ...DEFAULT_SETTINGS, ...languageSettings, enabled: false, endpoint: process.env.DANLINGO_E2E_ENDPOINT,
      model: process.env.DANLINGO_E2E_MODEL, profile: process.env.DANLINGO_E2E_PROFILE, thinkingEffort: process.env.DANLINGO_E2E_THINKING,
      concurrency: Number(process.env.DANLINGO_E2E_CONCURRENCY || DEFAULT_SETTINGS.concurrency),
      batchSize: Number(process.env.DANLINGO_E2E_BATCH_SIZE || DEFAULT_SETTINGS.batchSize), allowLocalHttp: true });
    const { readTestKey } = await import('./verify-real-provider.mjs'); key = await readTestKey();
  } else {
    key = 'niconico-live-local-test-only';
    server = createServer(async (req, res) => {
      res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', 'authorization,content-type'); res.setHeader('content-type', 'application/json');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end('{}'); return; }
      try {
        assert.ok(req.headers.authorization === 'Bearer ' + key, 'mock authorization mismatch');
        let body = ''; for await (const part of req) { body += part; assert.ok(body.length <= 1000000); }
        const decoded = decodeTranslationFixtureRequest(JSON.parse(body)), { items } = decoded;
        assert.ok(Array.isArray(items) && items.length <= 200 && report.requests.length < maxRequests + 2, 'bounded mock request budget');
        const row = { receivedAtEpochMs: Date.now(), phase: report.phase, protocol: decoded.protocol, items: items.map(i => ({ id: i.id, text: i.text })) }; report.requests.push(row);
        await delay(30); row.respondedAtEpochMs = Date.now();
        const reply = encodeTranslationFixtureResponse(decoded, items.map(i => ({ id: i.id, text: prefix + i.text })).reverse(),
          { prompt_tokens: items.length * 10, completion_tokens: items.length * 8, total_tokens: items.length * 18 });
        res.setHeader('content-type', reply.contentType); res.end(reply.body);
      } catch { report.errors.push('Local mock rejected invalid/over-budget request'); if (!res.headersSent) res.writeHead(500); res.end('{}'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    config = normalizeSettings({ ...DEFAULT_SETTINGS, ...languageSettings, enabled: false,
      endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, model: 'danlingo-niconico-local-mock', profile: 'chat-completions', thinkingEffort: 'default', allowLocalHttp: true });
  }
  report.providerSettings = Object.fromEntries(['endpoint', 'model', 'profile', 'thinkingEffort', 'sourceLanguage', 'targetLanguage', 'liveSourceLanguage', 'concurrency', 'batchSize'].map(k => [k, config[k]]));
  const extension = resolve(root, 'test-extension');
  const manifestText = await readFile(resolve(build, 'manifest.json'), 'utf8'), manifest = JSON.parse(manifestText);
  report.build = { path: build, version: manifest.version, manifestSha256: hash(manifestText), js: [] };
  for (const dir of ['', 'content-scripts', 'chunks']) {
    const files = await readdir(resolve(build, dir), { withFileTypes: true }).catch(() => []);
    for (const file of files) if (file.isFile() && file.name.endsWith('.js')) {
      const bytes = await readFile(resolve(build, dir, file.name)); report.build.js.push({ path: [dir, file.name].filter(Boolean).join('/'), sha256: hash(bytes) });
    }
  }
  await cp(build, extension, { recursive: true });
  const endpointUrl = new URL(config.endpoint), hostPattern = `${endpointUrl.protocol}//${endpointUrl.hostname}/*`;
  manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), hostPattern])];
  report.pregrantedProvider = { origin: endpointUrl.origin, browserHostPattern: hostPattern };
  await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest, null, 2));
  report.build.copiedJavaScriptByteIdentical = (await Promise.all(report.build.js.map(async file => hash(await readFile(resolve(extension, file.path))) === file.sha256))).every(Boolean);
  assert.equal(report.build.copiedJavaScriptByteIdentical, true, 'copied production JS must remain byte-identical');
  const { chromium } = await loadPlaywright();
  const totalBudgetMs = lifecycle ? Math.min(900000, 150000 + 6 * (seconds * 1000 + drainMs)) : 100000 + seconds * 1000 + drainMs;
  deadlineAt = Date.now() + totalBudgetMs;
  report.budget = { maxRequests, inFlightAllowance: config.concurrency, totalBudgetMs, deadlineAt, fixedWindowSeconds: seconds, drainMs,
    ...(selectedStages.some(name => mediaLifecycleStages.includes(name)) ? { mediaLifecycle: {
      actions: selectedStages.filter(name => mediaLifecycleStages.includes(name)), recoveryWindowSeconds: 30, inactiveMsPerAction: 2500,
      baselineAndRecoveryShareRequestAndTimeBudget: true } } : {}) };
  context = await chromium.launchPersistentContext(await mkdtemp(resolve(root, 'profile-')), { ...browserLaunchOptions(browserName), headless: !args.includes('--headed'), viewport: { width: 1440, height: 1000 }, locale: 'ja-JP',
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--autoplay-policy=no-user-gesture-required'] });
  watchdog = setTimeout(() => { report.budget.timeLimitReachedAt = Date.now(); closing = true; void context.close().catch(() => {}); }, Math.max(1, deadlineAt - Date.now()));
  installNetworkObserver(); report.browserVersion = context.browser()?.version();
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
  options = await context.newPage(); await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  rpc = payload => options.evaluate(payload => chrome.runtime.sendMessage(payload), payload);
  await waitFor(async () => !!(await options.locator('#key-state').textContent()), 'options initial state');
  const save = await rpc({ type: 'save', settings: config, apiKey: key, remember: false }); assert.equal(save.ok, true, 'test configuration save failed');
  const saved = await assertConfiguration(); assert.equal(saved.settings.enabled, false);
  report.configuration = { ...report.providerSettings, bufferMs: saved.settings.liveBufferMs, enabledBeforeObservation: saved.settings.enabled, hasKey: saved.hasKey, remembered: saved.remembered };
  page = await context.newPage();
  if (selectedStages.includes('active-next-room')) {
    await page.addInitScript({ content: `(${installObserver.toString()})();
if (location.pathname === ${JSON.stringify('/watch/' + nextRoom)}) (${installEarlyNativeObserver.toString()})(${attachNativeObserver.toString()});` });
  } else await page.addInitScript(installObserver);
  page.on('requestfailed', req => { const url = new URL(req.url()); if (/dlive|delivery/.test(url.hostname) && report.mediaFailures.length < 80) report.mediaFailures.push({ origin: url.origin, error: req.failure()?.errorText, at: Date.now(), duringCleanup: closing }); });
  let roomState = await openRoom(room); report.nativeBefore = roomState.nativeBefore;
  await toggle(true, 'enabled'); await stage('baseline', () => observeWindow('baseline', roomState));
  report.beforeDisable = await collect();
  if (lifecycle) {
    for (const name of mediaLifecycleStages) if (selectedStages.includes(name)) await stage(name, row => observeMediaLifecycle(name, roomState, row));
    if (selectedStages.includes('off-on')) await stage('off-on', async () => {
      const restored = await disableAndRestore('off-on-disabled');
      const disabledAt = Date.now(), count = report.providerRequests.length; await delay(1800);
      const quiet = await collect();
      assert.ok(!quiet.controls.filter(c => c.observedAt >= disabledAt).some(c => c.enabled), 'disabled control unexpectedly re-enabled');
      await toggle(true, 're-enabled');
      const result = await observeWindow('re-enabled', roomState);
      return { status: result.status, restored: restored.restored, requestsDuringDisabledTransition: report.providerRequests.slice(count).filter(r => r.startedAt < disabledAt + 1800).length, window: result.name };
    });
    if (selectedStages.includes('resize')) await stage('resize', async () => {
      await page.setViewportSize({ width: 1180, height: 820 }); await page.bringToFront();
      const geometry = await collect(); assert.equal(geometry.viewport.width, 1180, 'actual resized viewport');
      const result = await observeWindow('resized', roomState); return { status: result.status, viewport: geometry.viewport, window: result.name };
    });
    if (selectedStages.includes('fullscreen')) await stage('fullscreen', async row => {
      await page.bringToFront();
      const candidates = page.getByRole('button', { name: 'フルスクリーン', exact: true });
      const inspectButtons = elements => elements.slice(0, 40).map(e => ({ ariaLabel: e.getAttribute('aria-label'), title: e.getAttribute('title'),
        text: e.textContent?.trim().slice(0, 120), disabled: e.disabled, rect: { x: e.getBoundingClientRect().x, y: e.getBoundingClientRect().y, width: e.getBoundingClientRect().width, height: e.getBoundingClientRect().height } }));
      const fullscreenState = () => {
        const v = document.querySelector("[data-layer-name='videoLayer'] video");
        const targets = [...document.querySelectorAll('[data-browser-fullscreen="target"]')].map(e => {
          const r = e.getBoundingClientRect(); return { tag: e.tagName, className: String(e.className).slice(0, 300), containsProgramVideo: !!v && e.contains(v),
            rect: { x: r.x, y: r.y, width: r.width, height: r.height }, spansViewportWidth: r.width >= innerWidth - 4 };
        });
        return { enabled: document.fullscreenEnabled, element: document.fullscreenElement?.tagName ?? null,
          webkitElement: document.webkitFullscreenElement?.tagName ?? null, visibility: document.visibilityState,
          siteViewportFill: targets.some(t => t.containsProgramVideo && t.spansViewportWidth)
            && document.querySelectorAll('[data-browser-fullscreen="parent"]').length > 0, targets,
          fullscreenParentCount: document.querySelectorAll('[data-browser-fullscreen="parent"]').length,
          focused: document.hasFocus(), width: innerWidth, height: innerHeight, errors: window.__DL_NICO_EXTENSION_EVIDENCE__.fullscreenErrors || [] };
      };
      const settingsButton = page.getByRole('button', { name: '設定', exact: true });
      const layoutButton = page.getByRole('button', { name: 'フルスクリーンサイズ', exact: true });
      // Actual native labels/roles observed by the anonymous js14J2 menu probe.
      const modeLabels = { browser: 'ブラウザサイズ', monitor: 'モニターサイズ' };
      const modeButton = mode => page.getByRole('button', { name: modeLabels[mode], exact: true });
      const inspectModes = async () => {
        const rows = [];
        for (const mode of ['browser', 'monitor']) {
          const button = modeButton(mode); await button.waitFor({ state: 'visible', timeout: 10000 });
          rows.push({ mode, role: 'button', accessibleName: modeLabels[mode], text: (await button.textContent())?.trim(),
            value: await button.getAttribute('value'), pressed: await button.getAttribute('aria-pressed'), selected: await button.getAttribute('aria-selected') });
        }
        return rows;
      };
      const requestedModeEntered = state => fullscreenMode === 'monitor' ? !!state.element : state.siteViewportFill;
      row.fullscreen = { requestedMode: fullscreenMode, requestedModeVerified: false, before: await page.evaluate(fullscreenState),
        setting: { path: ['設定', 'フルスクリーンサイズ', modeLabels[fullscreenMode]] }, browserFullscreenApi: 'NOT_VERIFIED' };
      try {
        const videoBounds = await page.locator("[data-layer-name='videoLayer'] video").boundingBox();
        assert.ok(videoBounds && videoBounds.width > 0 && videoBounds.height > 0, 'actual program video bounds unavailable');
        await page.mouse.move(videoBounds.x + videoBounds.width / 2, videoBounds.y + videoBounds.height / 2);
        await settingsButton.waitFor({ state: 'visible', timeout: 10000 });
        if (await settingsButton.getAttribute('aria-expanded') !== 'true') await settingsButton.click();
        await layoutButton.waitFor({ state: 'visible', timeout: 10000 }); await layoutButton.click();
        row.fullscreen.setting.before = await inspectModes();
        await modeButton(fullscreenMode).click();
        await layoutButton.waitFor({ state: 'visible', timeout: 10000 }); await layoutButton.click();
        row.fullscreen.setting.after = await inspectModes();
        const selected = row.fullscreen.setting.after.find(option => option.mode === fullscreenMode);
        assert.equal(selected.text, fullscreenMode, 'actual native setting UI value');
        assert.equal(selected.pressed, 'true', 'requested native fullscreen size is selected');
        assert.ok(row.fullscreen.setting.after.filter(option => option.mode !== fullscreenMode).every(option => option.pressed !== 'true'), 'other fullscreen size must not be selected');
        row.fullscreen.setting.selectionVerified = true;
        await page.screenshot({ path: resolve(root, 'fullscreen-mode-selected.png') });
        await settingsButton.click();
        await modeButton(fullscreenMode).waitFor({ state: 'hidden', timeout: 10000 });
        await waitFor(async () => await settingsButton.getAttribute('aria-expanded') !== 'true', 'actual settings menu closed', 5000);
        row.fullscreen.setting.afterClose = { expanded: await settingsButton.getAttribute('aria-expanded'), pressed: await settingsButton.getAttribute('aria-pressed') };
        row.fullscreen.candidates = await candidates.evaluateAll(inspectButtons);
        let button;
        for (let i = 0; i < await candidates.count(); i++) if (await candidates.nth(i).isVisible()) { button = candidates.nth(i); row.fullscreen.selectedIndex = i; break; }
        if (!button) row.fullscreen.allButtonLabels = await page.locator('button').evaluateAll(inspectButtons);
        assert.ok(button, 'actual site fullscreen control unavailable');
        await page.evaluate(() => { const s = window.__DL_NICO_EXTENSION_EVIDENCE__; s.fullscreenErrors = [];
          document.addEventListener('fullscreenerror', () => s.fullscreenErrors.push(performance.timeOrigin + performance.now()), { once: true }); });
        await button.click();
        await waitFor(async () => { row.fullscreen.entered = await page.evaluate(fullscreenState); return requestedModeEntered(row.fullscreen.entered); }, 'actual requested native fullscreen mode entered: ' + fullscreenMode, 8000);
        await delay(500);
        row.fullscreen.entered = await page.evaluate(fullscreenState);
        assert.ok(requestedModeEntered(row.fullscreen.entered), 'requested native fullscreen mode remained active after entry');
        row.fullscreen.requestedModeVerified = true;
        row.fullscreen.mode = row.fullscreen.entered.element ? 'browser-fullscreen-api' : 'site-viewport-fill';
        row.fullscreen.buttonLabelsAfter = await page.locator('button').evaluateAll(inspectButtons);
        row.fullscreen.visibleMenuItemsAfter = await page.getByRole('menuitem').evaluateAll(inspectButtons);
        const result = await observeWindow(row.fullscreen.entered.element ? 'fullscreen' : 'site-viewport-fill', roomState);
        row.fullscreen.siteModeWindowStatus = result.status;
        row.fullscreen.browserFullscreenApi = row.fullscreen.entered.element ? 'VERIFIED' : 'NOT_VERIFIED';
        row.fullscreen.windowEnd = await page.evaluate(fullscreenState);
        row.fullscreen.requestedModeVerified = requestedModeEntered(row.fullscreen.windowEnd);
        return { status: row.fullscreen.requestedModeVerified ? result.status : 'INCOMPLETE', requestedMode: fullscreenMode, actualSiteMode: row.fullscreen.mode,
          siteModeWindowStatus: result.status, browserFullscreenApi: row.fullscreen.browserFullscreenApi, window: result.name };
      } finally {
        if (await settingsButton.getAttribute('aria-expanded').catch(() => null) === 'true') await settingsButton.click().catch(() => {});
        row.fullscreen.after = await page.evaluate(fullscreenState).catch(() => null);
        row.fullscreen.browserFullscreenApi = row.fullscreen.entered?.element ? 'VERIFIED' : 'NOT_VERIFIED';
        if (!row.fullscreen.requestedModeVerified) await page.screenshot({ path: resolve(root, 'fullscreen-incomplete.png') }).catch(() => {});
        row.fullscreen.exit = { button: { accessibleName: 'フルスクリーン解除 (Esc)', status: 'NOT_ATTEMPTED' },
          escape: { key: 'Escape', status: 'NOT_ATTEMPTED' } };
        try {
          if (row.fullscreen.after?.element || row.fullscreen.after?.siteViewportFill) {
            const exit = row.fullscreen.exit;
            const waitForExit = () => waitFor(async () => {
              const state = await page.evaluate(fullscreenState); return !state.element && !state.siteViewportFill;
            }, 'actual site fullscreen mode exited', 5000);
            exit.button.startedAt = Date.now(); exit.button.before = row.fullscreen.after;
            try {
              // This real native control was observed in KMFOYe; it invokes the site's selected mode exit.
              const videoBounds = await page.locator("[data-layer-name='videoLayer'] video").boundingBox();
              assert.ok(videoBounds && videoBounds.width > 0 && videoBounds.height > 0, 'actual program video bounds unavailable for exit');
              await page.mouse.move(videoBounds.x + videoBounds.width / 2, videoBounds.y + videoBounds.height / 2);
              const exitButton = page.getByRole('button', { name: exit.button.accessibleName, exact: true });
              await exitButton.waitFor({ state: 'visible', timeout: 5000 });
              exit.button.controls = await exitButton.evaluateAll(inspectButtons);
              exit.button.clickAttemptedAt = Date.now();
              await exitButton.click({ timeout: 5000 }); exit.button.clickCompletedAt = Date.now();
              await waitForExit(); exit.button.status = 'PASS';
            } catch (error) {
              exit.button.status = 'INCOMPLETE'; exit.button.error = redact(error.message).slice(0, 600);
              exit.button.after = await page.evaluate(fullscreenState).catch(() => null);
              // Record any real Escape cleanup separately; it cannot turn a failed native-button exit into PASS.
              if (exit.button.after?.element || exit.button.after?.siteViewportFill) {
                exit.escape.startedAt = Date.now(); exit.escape.before = exit.button.after;
                try {
                  await page.keyboard.press('Escape'); exit.escape.keyCompletedAt = Date.now();
                  await waitForExit(); exit.escape.status = 'PASS';
                } catch (escapeError) {
                  exit.escape.status = 'INCOMPLETE'; exit.escape.error = redact(escapeError.message).slice(0, 600);
                } finally {
                  exit.escape.after = await page.evaluate(fullscreenState).catch(() => null); exit.escape.finishedAt = Date.now();
                }
              }
              throw error;
            } finally {
              if (!exit.button.after) exit.button.after = await page.evaluate(fullscreenState).catch(() => null);
              exit.button.finishedAt = Date.now();
            }
          }
        } finally {
          row.fullscreen.afterExit = await page.evaluate(fullscreenState).catch(() => null);
        }
      }
    });
    if (selectedStages.includes('reconnect')) await stage('reconnect', async () => {
      const offlineAt = Date.now(); await context.setOffline(true);
      let observedOffline;
      try { await delay(1800); observedOffline = await collect(); }
      finally { await context.setOffline(false); }
      assert.equal(observedOffline.online, false, 'actual browser offline state');
      assert.ok(observedOffline.snapshots.some(s => s.observedAt >= offlineAt && s.connection === 'disconnected'), 'actual disconnected snapshot');
      await waitFor(() => page.evaluate(() => navigator.onLine && window.__DL_NICO_EXTENSION_EVIDENCE__.snapshots.at(-1)?.playback?.contentActive), 'actual online program recovery', 20000);
      const result = await observeWindow('reconnected', roomState); return { status: result.status, offlineMs: 1800, actualDisconnected: true, window: result.name };
    });
    if (selectedStages.includes('active-next-room')) await stage('active-next-room', async row => {
      const savedBefore = await assertConfiguration(); assert.equal(savedBefore.settings.enabled, true, 'translation must be enabled before active navigation');
      const before = await collect(); roomState.observation = before;
      assert.equal(before.controls.at(-1)?.enabled, true, 'actual old-room translation control must remain enabled');
      const oldSessions = new Set([...before.snapshots, ...before.events].map(e => e.adapterSession));
      const oldSourceIds = new Set(before.events.map(e => e.sourceId));
      const nativeIdentity = e => e.nativeSourceIdentity?.key ? JSON.stringify([e.nativeSourceIdentity.key, e.originalText]) : null;
      const oldNativeIdentities = new Set(before.events.map(nativeIdentity).filter(Boolean));
      const terminalIds = new Set([...before.delivered, ...before.drops].map(canonicalId));
      const pending = before.events.filter(e => !terminalIds.has(canonicalId(e)) && (e.scheduledAt ?? e.receivedAt) + config.liveBufferMs > before.capturedAt);
      const pendingHashes = new Set(pending.map(e => hash(protectText(e.originalText).text)));
      const inFlight = report.providerRequests.filter(r => r.status === 'pending' && !r.completedAt);
      row.navigation = { from: roomState.program.id, to: nextRoom, requestedAt: Date.now(),
        kind: 'full page navigation in the same browser context and tab; not SPA', translationTogglePerformed: false,
        oldDocumentTimeOrigin: before.documentTimeOrigin, oldAdapterSessions: [...oldSessions],
        oldWork: { sampledAt: before.capturedAt, pendingSourceCount: pending.length, inFlightRequestCount: inFlight.length,
          pendingSourceIds: pending.map(canonicalId), inFlightRequestIds: inFlight.map(r => r.id),
          pendingSourceCorrelatedRequestIds: inFlight.filter(r => r.items.some(item => pendingHashes.has(item.textSha256))).map(r => r.id),
          pressureCoverage: pending.length || inFlight.length ? 'OBSERVED_IN_FLIGHT_AT_NAVIGATION_SAMPLE' : 'NOT_EXERCISED_NO_OLD_WORK_OBSERVED',
          limitation: 'Only actual work present at the navigation sample is covered; full document replacement does not establish SPA or forced late-response handling.' } };
      await persist();
      roomState = await openRoom(nextRoom, { activeNavigation: true });
      await waitFor(() => page.evaluate(() => window.__DL_NICO_EXTENSION_EVIDENCE__.controls.at(-1)?.enabled === true), 'new document reads unchanged enabled configuration');
      const savedAfter = await assertConfiguration(); assert.deepEqual(savedAfter.settings, savedBefore.settings, 'active navigation must not change any translation setting');
      const result = await observeWindow('active-next-room', roomState, 30);
      const after = roomState.observation;
      const rows = [...after.snapshots, ...after.events, ...after.prepared, ...after.delivered, ...after.drops];
      const firstEnabled = after.controls.findIndex(c => c.enabled);
      const oldIdentitySlots = after.stages.filter(s => s.createdSlot && oldNativeIdentities.has(nativeIdentity(s)));
      row.navigation.newDocumentTimeOrigin = after.documentTimeOrigin;
      row.navigation.earlyObserverProof = after.earlyNativeObserver;
      row.navigation.startupDisabledControlsBeforeFirstEnabled = firstEnabled < 0 ? after.controls.length : after.controls.slice(0, firstEnabled).filter(c => !c.enabled).length;
      row.navigation.oldIdentitySlotCount = oldIdentitySlots.length;
      row.navigation.checks = {
        completeOldDocumentCapture: before.captureComplete,
        oldNativeIdentityCoverage: before.events.length > 0 && before.events.every(e => !!nativeIdentity(e)),
        newDocumentEstablished: after.documentTimeOrigin !== before.documentTimeOrigin,
        unchangedEnabledConfiguration: savedAfter.settings.enabled === true,
        allNewResourceRows: rows.length > 0 && rows.every(e => e.resourceId === nextRoom),
        noOldAdapterSession: rows.every(e => !oldSessions.has(e.adapterSession)),
        noOldSourceReaccepted: after.events.every(e => !oldSourceIds.has(e.sourceId)),
        noOldNativeMessageSlot: oldIdentitySlots.length === 0,
        noDisableAfterNewDocumentEnabled: firstEnabled >= 0 && after.controls.slice(firstEnabled).every(c => c.enabled),
        observerBaselineBeforeProduction: after.earlyNativeObserver?.status === 'PASS' && after.earlyNativeObserver?.native?.baseline?.beforeProductFilter === true,
        freshSourceProviderNativeChain: result.chains.some(c => c.resourceId === nextRoom && c.freshProviderRequestCandidates.length > 0),
      };
      return { status: result.status === 'PASS' && Object.values(row.navigation.checks).every(Boolean) ? 'PASS' : 'INCOMPLETE',
        navigation: row.navigation, providerKind, window: result.name, fixedWindowSeconds: 30, drainMs };
    });
    if (selectedStages.includes('next-room')) await stage('next-room', async () => {
      assert.ok(nextRoom, '--lifecycle needs --next-room to verify navigation stage');
      roomState.observation = await disableAndRestore('before-room-navigation');
      roomState = await openRoom(nextRoom); await toggle(true, 'next-room-enabled');
      const result = await observeWindow('next-room', roomState);
      assert.ok(roomState.observation.events.every(e => e.resourceId === nextRoom), 'old-room event leaked into new document');
      return { status: result.status, from: room, to: nextRoom, navigation: 'same browser context and tab; full real page navigation', window: result.name };
    });
  }
  roomState.observation = await disableAndRestore('disabled'); await delay(1500); report.observation = await collect();
  roomState.observation = report.observation; report.overview = await rpc({ type: 'overview' });
  report.chains = report.rooms.flatMap(r => correlateChains(r.observation || {}));
  report.lifecycleScope.completedStages = report.stages.filter(s => s.status === 'PASS' && s.name !== 'baseline').map(s => s.name);
  report.lifecycleScope.fullLifecycleEstablished = report.lifecycleScope.fullLifecycleRequested && allLifecycleStages.every(name => report.lifecycleScope.completedStages.includes(name));
  report.realProviderTarget = { requiredRate: 0.9, minimumEligiblePerWindow: 20,
    windows: report.windows.map(w => ({ name: w.name, status: w.metrics?.target?.status ?? 'INCOMPLETE_EVIDENCE' })),
    status: !realProvider ? 'NOT_REAL_PROVIDER' : report.windows.length && report.stages.every(s => s.status === 'PASS')
      && report.windows.every(w => w.status === 'PASS' && w.metrics?.target?.status === 'MET' && w.checks.translatedNativeEvidenceComplete) ? 'MET' : 'NOT_ESTABLISHED' };
  report.canonical = report.rooms.map(r => ({ room: r.program.id, ...canonicalRows(r.observation || {}) }));
  report.checks = { realLiveRooms: report.rooms.every(r => r.program.status === 'ON_AIR'), productionBytesUnchanged: report.build.copiedJavaScriptByteIdentical,
    providerNetworkObserved: report.providerRequests.some(r => r.serviceWorker && typeof r.status === 'number' && r.status >= 200 && r.status < 300),
    actualPreparedNativeChain: report.chains.length > 0, freshProtectedTextHttpCorrelation: report.chains.some(c => c.freshProviderRequestCandidates.length > 0),
    allRequestedStagesCompleted: report.stages.every(s => s.status === 'PASS'), inputRestored: report.observation.restored?.input === true,
    filtersRestored: report.observation.restored?.filters === true, protocolObserverRestored: report.observation.restored?.dispatcher === true,
    requestBudgetWithinConcurrency: report.providerRequests.length <= maxRequests + config.concurrency,
    budgetNotExhausted: !report.budget.requestLimitReachedAt && !report.budget.timeLimitReachedAt };
  report.postDisableOriginalStages = report.observation.stages.filter(s => s.phase === 'disabled' && s.text === s.originalText && s.createdSlot).length;
  report.checks.postDisableOriginalObserved = report.postDisableOriginalStages > 0;
  report.status = Object.values(report.checks).every(Boolean)
    ? (realProvider ? 'PASS_REAL_NICONICO_FULL_EXTENSION_REAL_PROVIDER_CHAIN' : 'PASS_REAL_NICONICO_FULL_EXTENSION_LOCAL_MOCK')
    : (realProvider ? 'INCOMPLETE_REAL_NICONICO_REAL_PROVIDER' : 'INCOMPLETE_REAL_NICONICO_LOCAL_MOCK');
} catch (error) {
  report.status = realProvider ? 'INCOMPLETE_REAL_NICONICO_REAL_PROVIDER' : 'INCOMPLETE_REAL_NICONICO_LOCAL_MOCK';
  report.errors.push(redact(error.message).slice(0, 800));
  if (page && !closing) { report.failureState = await collect().catch(() => null); await page.screenshot({ path: resolve(root, 'failure.png') }).catch(() => {}); }
} finally {
  clearTimeout(watchdog);
  if (context && !closing) await context.setOffline(false).catch(() => {});
  if (rpc && !closing) { await rpc({ type: 'toggle', enabled: false }).catch(() => {}); const result = await rpc({ type: 'delete-key' }).catch(() => null); report.keyDeleted = result?.ok === true && result.hasKey === false; }
  if (!realProvider) report.mockKeyDeleted = report.keyDeleted === true;
  if (page && !closing) await page.evaluate(() => { for (const restore of window.__DL_NICO_EXTENSION_EVIDENCE__?.restorers || []) restore(); }).catch(() => {});
  closing = true; await context?.close().catch(() => {}); await Promise.allSettled([...networkTasks]);
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  report.finishedAt = new Date().toISOString();
  if (report.status.startsWith('PASS') && report.keyDeleted !== true) { report.status = 'INCOMPLETE_CREDENTIAL_CLEANUP'; report.errors.push('Test key deletion could not be verified before context close'); }
  if (!report.status.startsWith('PASS')) process.exitCode = 1;
  await persist();
}
console.log(jsonSafe({ report: resolve(root, 'report.json'), status: report.status, providerKind, browser: browserName, room,
  requests: report.providerRequests.length, nativePreparedChains: report.chains?.length, stages: report.stages.map(s => ({ name: s.name, status: s.status, error: s.error })), checks: report.checks, errors: report.errors }));
