import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Run AFTER build: node --experimental-strip-types scripts/verify-live.mjs --fixture-only
import { settingsSection } from './settings-navigation.mjs';
// Real page + mock: --real-only --url https://www.youtube.com/watch?v=VIDEO_ID
// Real provider requires --real-only --real-provider, explicit DANLINGO_E2E_ENDPOINT,
// DANLINGO_E2E_MODEL / PROFILE / THINKING, and interactive non-echoing key entry.
import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/core/config.ts';
import { resourceFromUrl, liveEventId } from '../src/core/resource.ts';
import { needsTranslation } from '../src/core/messages.ts';
import { protectText } from '../src/translation/text.ts';
import { LIVE_FIXTURE_IDS, chatAdd, chatDelete, chatDeleteAuthor, installLiveFixtureRoutes, installLiveObserver, observedAdmissionOutcomes } from './live-fixture.mjs';
import { OBSERVATION_SCOPES, auditMediaProgress, auditHiddenScope, recordedPhaseEvidence } from './live-observation-health.mjs';
import { validateLifecycleAction } from './live-lifecycle-action-args.mjs';
import { decodeTranslationFixtureRequest, encodeTranslationFixtureResponse } from './translation-protocol-fixture.mjs';

const args = process.argv.slice(2);
function option(name, fallback) { const i = args.indexOf(name); if (i < 0) return fallback; assert.ok(args[i + 1] && !args[i + 1].startsWith('--'), `${name} requires a value`); return args[i + 1]; }
if (args.includes('--help')) {
  console.log('node --experimental-strip-types scripts/verify-live.mjs [--fixture-only | --real-only --url URL] [--browser chromium|edge] [--headed] [--seconds 30] [--real-provider] [--max-requests 1..200] [--lifecycle] [--next-url URL] [--observation-scope all|chat-closed|fullscreen-chat-closed] [--metrics-seconds 30..120] [--metrics-position before-phases|after-phases (all scope only)] [--lifecycle-action off-on|pause-resume (real-only; exclusive with lifecycle/next-url/focused scopes/metrics-position; default fixed window 30s plus original drain; TARGETED_LIFECYCLE_ACTION_ONLY)]');
  process.exit(0);
}
const realOnly = args.includes('--real-only'), realProvider = args.includes('--real-provider');
const observationScope = option('--observation-scope', 'all'), focusedScope = observationScope !== 'all';
assert.ok(OBSERVATION_SCOPES.includes(observationScope), 'Invalid --observation-scope');
assert.ok(!focusedScope || realOnly, 'Focused observation scopes require --real-only');
for (const id of LIVE_FIXTURE_IDS) assert.equal(resourceFromUrl('https://www.youtube.com/watch?v=' + id)?.resourceId, id, 'fixture IDs must satisfy production URL identity');
assert.ok(!(realOnly && args.includes('--fixture-only')), 'Choose exactly one page surface');
assert.ok(!realProvider || realOnly, 'Real-provider work is only available with explicit --real-only');
const browserName = option('--browser', 'chromium');
assert.ok(['chromium', 'edge'].includes(browserName), '--browser must be chromium or edge');
const realUrl = option('--url', process.env.DANLINGO_LIVE_URL);
if (realOnly) assert.ok(realUrl && resourceFromUrl(realUrl)?.platform === 'youtube' && resourceFromUrl(realUrl)?.scenario === 'live', '--real-only requires an explicit supported YouTube watch/live --url');
const observeSeconds = Number(option('--seconds', '30'));
assert.ok(Number.isInteger(observeSeconds) && observeSeconds >= 5 && observeSeconds <= 120, '--seconds must be 5..120');
const lifecycleAction = option('--lifecycle-action', null);
const lifecycle = args.includes('--lifecycle'), nextUrl = option('--next-url', null), metricsSeconds = Number(option('--metrics-seconds', focusedScope || lifecycleAction ? '30' : '0'));
const maxRequests = Number(option('--max-requests', '200')), metricsPosition = option('--metrics-position', 'after-phases');
validateLifecycleAction({ action: lifecycleAction, occurrences: args.filter(value => value === '--lifecycle-action').length,
  realOnly, lifecycle, nextUrl, observationScope, metricsSeconds, explicitMetricsPosition: args.includes('--metrics-position') });
assert.ok(Number.isInteger(maxRequests) && maxRequests >= 1 && maxRequests <= 200, '--max-requests must be 1..200');
assert.ok(['before-phases', 'after-phases'].includes(metricsPosition), 'Invalid --metrics-position');
assert.ok(!focusedScope || !args.includes('--metrics-position'), 'Focused scopes verify their fresh phase inside the fixed window; --metrics-position is only valid with --observation-scope all');
assert.ok(!focusedScope || !lifecycle && !nextUrl, 'Focused observation scopes cannot claim or run --lifecycle/--next-url; use scope all for lifecycle checks');
assert.ok(!focusedScope || Number.isInteger(metricsSeconds) && metricsSeconds >= 30 && metricsSeconds <= 120, 'Focused observation scopes require a complete 30..120 second metrics window');
assert.ok(!args.includes('--metrics-position') || metricsSeconds, '--metrics-position requires a fixed metrics window');
assert.ok(!lifecycle && !nextUrl && !metricsSeconds || realOnly, 'Lifecycle and fixed-window metrics require --real-only');
assert.ok(!nextUrl || lifecycle && resourceFromUrl(nextUrl)?.platform === 'youtube' && resourceFromUrl(nextUrl)?.resourceId !== resourceFromUrl(realUrl)?.resourceId, '--next-url requires --lifecycle and a different supported YouTube room');
assert.ok(!args.includes('--metrics-seconds') || Number.isInteger(metricsSeconds) && metricsSeconds >= 30 && metricsSeconds <= 120, '--metrics-seconds must be 30..120');
const root = resolve('.artifacts/live/verification');
await mkdir(root, { recursive: true });
const runDir = await mkdtemp(resolve(root, `${realOnly ? 'real' : 'fixture'}-${browserName}-`));
const report = { capturedAt: new Date().toISOString(), runDir, browser: browserName, requestedObservationScope: observationScope,
  ...(lifecycleAction ? { requestedLifecycleAction: lifecycleAction, scopeClassification: 'TARGETED_LIFECYCLE_ACTION_ONLY' } : {}),
  pageSurface: realOnly ? 'REAL_YOUTUBE_PAGE' : 'SYNTHETIC_YOUTUBE_FIXTURE', provider: realProvider ? 'REAL_EXPLICIT_PROVIDER' : 'LOCAL_MOCK_PROVIDER',
  status: 'running', phase: 'setup', checks: {}, screenshots: [], requests: [], errors: [], limitations: [
    'Production bundle copied to an isolated profile; only the test manifest pregrants the chosen provider origin.',
    'Native optional permission prompt and manual Chrome/Edge installation are not validated by this script.',
    'Fixture success is not real-platform or real-provider acceptance; real pages must independently produce live events and actual overlay renders.',
    'Timing measures DOM animation insertion relative to received events, not a physical display pixel timestamp.',
    'No YouTube account login, chat posting or moderation action is performed; fixture deletion actions only affect synthetic responses.',
  ] };
let context, options, page, rpc, worker, mock, fixture, apiKey = '', endpoint = '';
const budgetTasks = [];
const held = new Set();
const releaseHeld = () => { for (const release of held) release(); held.clear(); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const redact = value => apiKey ? String(value).split(apiKey).join('[redacted]') : String(value);
const persist = () => writeFile(resolve(runDir, 'report.json'), JSON.stringify(report, (_key, value) => typeof value === 'string' ? redact(value) : value, 2));
async function waitFor(check, label, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const result = await check(); if (result) return result; await delay(50); }
  throw new Error('Timed out: ' + label);
}
const untilPage = (fn, arg, label, timeout) => waitFor(() => page.evaluate(fn, arg), label, timeout);
const evidence = () => page.evaluate(() => window.__DL_LIVE_EVIDENCE__);
const rendered = text => page.evaluate(text => window.__DL_LIVE_EVIDENCE__.renders.find(row => row.text === text), text);
const translated = text => '【模拟译文】' + text;
async function screenshot(name) {
  // A newly inserted scrolling node starts just outside the clipping edge. Wait
  // for a readable portion to enter before capturing; never alter its animation.
  await waitFor(() => page.evaluate(() => {
    const host = document.getElementById('danlingo-live-overlay');
    const spans = [...(host?.shadowRoot?.querySelectorAll('span') || [])];
    if (!host || !spans.length) return true;
    const player = host.getBoundingClientRect();
    return spans.some(span => { const box = span.getBoundingClientRect(); return Math.min(box.right, player.right) - Math.max(box.left, player.left) >= 150; });
  }), 'readable overlay screenshot', 3000).catch(() => {});
  const path = resolve(runDir, `${name}.png`); await page.screenshot({ path }); report.screenshots.push(path); return path;
}
async function check(name, fn) {
  report.phase = name; await persist(); const result = await fn(); report.checks[name] = { status: 'passed', ...(result || {}) };
  console.log('PASS: ' + name); await persist();
}
async function save(patch) {
  const current = await rpc({ type: 'settings' });
  const result = await rpc({ type: 'save', settings: { ...current.settings, ...patch }, remember: false });
  assert.equal(result.ok, true, result.error); await page?.bringToFront(); return result;
}
async function connected(room) {
  await untilPage(room => { const s = window.__DL_LIVE_EVIDENCE__?.snapshots.at(-1); return s?.resourceId === room && s.connection === 'connected' && !s.playback.paused && s.playback.contentActive && s.playback.atLiveEdge; }, room, 'connected current live room');
  await waitFor(() => fixture.requests.some(row => row.room === room && row.index >= 1), 'baseline and continuation response');
}
async function inject(id, text, authorId) {
  const room = await page.evaluate(() => window.__DL_LIVE_FIXTURE__.state.room);
  fixture.enqueue(room, chatAdd(id, text, authorId));
  return untilPage(id => window.__DL_LIVE_EVIDENCE__.events.flatMap(row => row.events || []).find(event => event.sourceId === id), id, 'actual MAIN reader event ' + id);
}

const realPlaybackState = () => page.evaluate(() => {
  const player = document.getElementById('movie_player'), video = player?.querySelector('video');
  const error = player?.querySelector('.ytp-error');
  const edge = video?.seekable.length ? video.seekable.end(video.seekable.length - 1) : null;
  const native = {};
  for (const name of ['isAtLiveHead', 'getCurrentTime', 'getDuration', 'getPlayerState']) {
    const available = typeof player?.[name] === 'function';
    let value = null, error = false;
    if (available) try { const result = player[name](); value = ['number', 'boolean', 'string'].includes(typeof result) ? result : null; } catch { error = true; }
    native[name] = { available, value, error };
  }
  const seekable = [];
  if (video) for (let i = 0; i < Math.min(video.seekable.length, 5); i++) seekable.push({ start: video.seekable.start(i), end: video.seekable.end(i) });
  return { time: video?.currentTime ?? null, paused: video?.paused ?? true, seeking: video?.seeking ?? false,
    readyState: video?.readyState ?? 0, errorCode: video?.error?.code ?? null,
    visibleError: !!error && error.getClientRects().length > 0 && getComputedStyle(error).visibility !== 'hidden',
    visibleErrorText: error?.getClientRects().length ? (error.textContent || '').trim().slice(0, 500) : null,
    ad: !!player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')),
    liveDistance: edge === null || !video ? null : edge - video.currentTime, seekable, native,
    duration: video ? Number.isFinite(video.duration) ? video.duration : String(video.duration) : null, fullscreen: !!document.fullscreenElement };
});
function liveHeadEvidence(value) {
  const native = value.native?.isAtLiveHead;
  // real-chromium-c6cfyr: this current player's native boolean was true while
  // HTML/native duration advertised an end exactly 3600s in the future.
  // A native false is equally authoritative: a nearby HTML end cannot override it.
  if (native?.available && !native.error && typeof native.value === 'boolean') return { source: 'native-isAtLiveHead', atLiveEdge: native.value };
  return { source: 'html-seekable-fallback', atLiveEdge: Number.isFinite(value.liveDistance) && value.liveDistance >= -1 && value.liveDistance <= 8 };
}
function healthyPlayback(value) {
  return !value.paused && !value.seeking && value.readyState >= 2 && !value.errorCode && !value.visibleError && !value.ad
    && liveHeadEvidence(value).atLiveEdge;
}
async function nativeButton(kind) {
  const surfaces = [{ surface: page, inChatFrame: false, path: 'top' }];
  if (kind === 'close-chat') for (const frame of page.frames()) {
    try { const url = new URL(frame.url()); if (url.origin === 'https://www.youtube.com' && url.pathname === '/live_chat') surfaces.push({ surface: frame, inChatFrame: true, path: '/live_chat' }); } catch { /* blank frame */ }
  }
  const inventories = [];
  for (const { surface, inChatFrame, path } of surfaces) {
    const candidates = await surface.evaluate(({ kind, inChatFrame }) => [...document.querySelectorAll('button,[role="button"]')].flatMap((button, index) => {
      const box = button.getBoundingClientRect(), style = getComputedStyle(button);
      if (!box.width || !box.height || style.visibility === 'hidden' || style.display === 'none' || button.disabled || button.getAttribute('aria-disabled') === 'true') return [];
      const chat = button.closest('ytd-live-chat-frame,yt-live-chat-header-renderer');
      const panel = button.closest('ytd-engagement-panel-section-list-renderer');
      const isChat = inChatFrame || !!chat || !!panel && /chat|チャット|聊天/i.test(panel.innerText.slice(0, 500));
      if (kind === 'close-chat' ? !isChat : !button.closest('#movie_player')) return [];
      const aria = button.getAttribute('aria-label') || '', title = button.getAttribute('title') || '', text = (button.innerText || '').trim().slice(0, 120);
      return [{ index, aria, title, text, tag: button.tagName, id: button.id, ancestor: (chat || panel)?.tagName || null,
        rect: { x: box.x, y: box.y, width: box.width, height: box.height } }];
    }), { kind, inChatFrame }).catch(() => []);
    inventories.push({ path, buttons: candidates.slice(0, 60) });
    const pattern = kind === 'close-chat' ? /close|hide|閉じ|非表示|关闭|隐藏|關閉|隱藏/i
      : kind === 'go-live' ? /(?:seek|jump|go|return|back).{0,20}live|live.{0,20}(?:seek|jump|behind)|現在ライブ配信中の時点まで進みます|ライブ.{0,20}(?:移動|戻|現在)|(?:移動|戻).{0,20}ライブ|(?:返回|转到|跳至|回到|轉到).{0,10}直播|^\s*(?:live|ライブ|直播)\s*$/i
      : kind === 'pause' ? /pause|一時停止|暂停|暫停/i
      : kind === 'play' ? /^(?:play|再生|播放)(?:\s|[（(]|$)/i
      : kind === 'theater' ? /theat(?:er|re)|シアター|影院|劇院|剧院/i
      : kind === 'fullscreen' ? /full.?screen|全画面|全屏|全螢幕/i : /$a/;
    const chosen = candidates.find(candidate => pattern.test(candidate.aria + ' ' + candidate.title + ' ' + candidate.text));
    if (chosen) {
      report.real.nativeControls[kind] = { path, selected: chosen, inventories };
      const button = surface.locator('button,[role="button"]').nth(chosen.index);
      // Revalidate the observed node before clicking a dynamic page index.
      assert.equal(await button.getAttribute('aria-label') || '', chosen.aria);
      assert.equal(await button.getAttribute('title') || '', chosen.title);
      await button.click({ timeout: 5000 }); return;
    }
  }
  report.real.nativeControls[kind] = { inventories, reason: 'No visible, named native control found in the relevant live-chat/player surface' };
  throw new Error('Native ' + kind + ' control unavailable; no CSS or DOM-removal substitute was used');
}
async function nativeChatHidden() {
  return page.evaluate(() => {
    const roots = [...document.querySelectorAll('ytd-live-chat-frame')];
    const rows = roots.map(node => { const box = node.getBoundingClientRect(); return { present: true, collapsed: node.hasAttribute('collapsed'),
      visible: !!box.width && !!box.height && getComputedStyle(node).visibility !== 'hidden' && getComputedStyle(node).display !== 'none', iframe: !!node.querySelector('iframe') }; });
    return { hidden: !rows.length || rows.every(row => row.collapsed || !row.visible || !row.iframe), roots: rows };
  });
}
async function observationScopeState() {
  const chat = await nativeChatHidden();
  const fullscreen = await page.evaluate(() => {
    const host = document.getElementById('danlingo-live-overlay');
    return { fullscreenActive: !!document.fullscreenElement,
      fullscreenContainsOverlay: !!host && !!document.fullscreenElement?.contains(host) };
  });
  return { chatHidden: chat.hidden, chatRoots: chat.roots, ...fullscreen };
}
async function enterFocusedScope() {
  report.phase = 'real-enter-' + observationScope;
  await nativeButton('close-chat');
  report.real.nativeChatAfterClose = await waitFor(async () => { const state = await nativeChatHidden(); return state.hidden ? state : false; }, 'native chat closed by its own control', 10000);
  if (observationScope === 'fullscreen-chat-closed') {
    await page.locator('#movie_player').hover(); await nativeButton('fullscreen');
    await untilPage(() => !!document.fullscreenElement && document.fullscreenElement.contains(document.getElementById('danlingo-live-overlay')), undefined, 'native fullscreen contains actual overlay', 10000);
  }
  const sample = { at: Date.now(), scopeState: await observationScopeState() };
  report.real.observationScope.entered = sample;
  assert.ok(auditHiddenScope([sample], observationScope).healthy, 'The requested native hidden-chat state must be established before observation');
  report.checks['native-observation-scope-entry'] = { status: 'passed', requestedScope: observationScope, ...sample };
}
async function realPhase(name, { marker = Date.now(), expectedSession = null, forbiddenIds = [], recordedWindow = null } = {}) {
  report.phase = 'real-' + name;
  const initial = recordedWindow ? recordedWindow.initialPlayback : await realPlaybackState();
  const initialSnapshot = recordedWindow ? recordedWindow.initialSnapshot : (await evidence()).snapshots.at(-1);
  if (recordedWindow) assert.ok(initialSnapshot && Number.isFinite(initial?.time) && marker === recordedWindow.startAt, 'Focused phase must use its actual recorded window-start playback and snapshot');
  let result, lastHealthyAt = null;
  const inspect = async () => {
    const observed = recordedWindow ? recordedWindow.observed : await evidence();
    const captured = recordedWindow ? recordedPhaseEvidence(observed, recordedWindow) : null;
    const current = captured ? captured.snapshot : observed.snapshots.at(-1);
    const playback = recordedWindow ? recordedWindow.finalSample.playback : await realPlaybackState();
    const until = recordedWindow?.observedUntil ?? Infinity;
    const batches = captured ? captured.batches : observed.events.filter(row => row.at >= marker && row.adapterSession === current?.adapterSession);
    const resource = resourceFromUrl(page.url());
    const ids = new Set(batches.flatMap(row => (row.events || []).filter(e => e.receivedAt >= marker).map(e => liveEventId(resource, e.sourceId))));
    const renders = captured ? captured.renders : observed.renders.filter(row => row.at >= marker);
    const freshRenders = renders.filter(row => ids.has(row.eventId) && row.adapterSession === current?.adapterSession && row.sourceAdapterSession === current?.adapterSession);
    assert.ok(!renders.some(row => forbiddenIds.includes(row.eventId)), 'old source ID replayed during ' + name);
    assert.ok(!renders.some(row => row.sourceAdapterSession && row.sourceAdapterSession !== row.adapterSession), 'stale generation render during ' + name);
    assert.equal(new Set(renders.map(row => JSON.stringify([row.adapterSession, row.eventId]))).size, renders.length, 'duplicate delivery during ' + name);
    const sources = batches.reduce((n, row) => n + (row.events?.length || 0), 0);
    const translatedRenders = freshRenders.filter(row => row.translationStatus === 'translated').length;
    const runtime = recordedWindow ? recordedWindow.finalSample.runtime : (await rpc({ type: 'overview' })).status;
    if (healthyPlayback(playback)) lastHealthyAt = recordedWindow ? recordedWindow.finalSample.at : Date.now();
    result = { name, startAt: marker, elapsedMs: (recordedWindow?.observedUntil ?? Date.now()) - marker, sourceEvents: sources, overlayRenders: renders.length, mockTranslatedRenders: realProvider ? null : translatedRenders,
      correlatedFreshRenders: freshRenders.length, translatedRenders, adapterSession: current?.adapterSession,
      connection: current?.connection, coverage: current?.coverage, playback, videoProgressSeconds: playback.time - initial.time, runtime,
      initialPlayback: initial, initialSnapshot, expectedSession, lastHealthyAt };
    if (recordedWindow) result.recordedWindow = { startAt: marker, endAt: recordedWindow.endAt, observedUntil: until,
      requiredScope: observationScope, sourceReceiptCohortOnly: true, freshWaitAfterWindow: false };
    report.real.phases[name] = result;
    if (playback.visibleError || playback.errorCode) {
      result.status = 'INCOMPLETE_NATIVE_PLAYER_ERROR';
      throw new Error('Actual native player failed during ' + name + '; source/render acceptance is incomplete, not a lack-of-chat timeout');
    }
    if (recordedWindow && !recordedWindow.scopeAudit.healthy) {
      result.status = 'INCOMPLETE_OBSERVATION_SCOPE_LOST';
      throw new Error('The requested native hidden-chat/fullscreen state was lost during the fixed window or drain');
    }
    if (recordedWindow && !recordedWindow.playbackHealthy) {
      result.status = 'INCOMPLETE_PLAYBACK_INTERRUPTED';
      throw new Error('Actual media did not remain healthy and advancing throughout the fixed window and drain');
    }
    return result.elapsedMs >= 2000 && current?.connection === 'connected' && healthyPlayback(playback) && result.videoProgressSeconds >= 1
      && (!expectedSession || current?.adapterSession === expectedSession) && sources > 0 && freshRenders.length > 0 && translatedRenders > 0;
  };
  if (recordedWindow) {
    if (!await inspect()) {
      result.status = 'INCOMPLETE_RECORDED_WINDOW_CHAIN';
      throw new Error('The complete selected-state window did not establish fresh source, translated overlay, connected current session and advancing live video; no additional wait or baseline reuse');
    }
  } else await waitFor(inspect, 'new actual live source and translated overlay during ' + name, observeSeconds * 1000);
  result.status = 'passed'; result.screenshot = await screenshot('real-' + name + '-' + (realProvider ? 'REAL-PROVIDER' : 'LOCAL-MOCK'));
  await persist(); console.log('PASS real: ' + name + ' new source + translated overlay + advancing live video');
  return result;
}

const eventIds = observed => [...new Set(observed.events.flatMap(batch => (batch.events || []).map(e => liveEventId({ platform: 'youtube', scenario: 'live', resourceId: batch.resourceId }, e.sourceId))))];
async function freshSession(previous, room = resourceFromUrl(page.url()).resourceId) {
  return waitFor(async () => {
    const snapshot = (await evidence()).snapshots.at(-1);
    const playback = await realPlaybackState();
    report.real.generationWait = { previous, room, at: Date.now(), snapshot, playback };
    assert.ok(!playback.visibleError && !playback.errorCode, 'Actual player entered an error state while waiting for a fresh adapter generation; this is not evidence of a toggle failure');
    return snapshot?.connection === 'connected' && snapshot.resourceId === room && snapshot.adapterSession !== previous ? snapshot.adapterSession : false;
  }, 'new connected adapter generation and baseline', 45000);
}
async function recoverPlayback() {
  await page.locator('#movie_player video').first().waitFor({ state: 'attached', timeout: 30000 });
  if ((await realPlaybackState()).paused) { await page.locator('#movie_player').hover(); await nativeButton('play'); }
  await waitFor(async () => { const p = await realPlaybackState(); return !p.paused && p.readyState >= 2 && !p.ad && !p.visibleError && !p.errorCode; }, 'real media recovery', 45000);
  if (!liveHeadEvidence(await realPlaybackState()).atLiveEdge) { await page.locator('#movie_player').hover(); await nativeButton('go-live'); }
  const start = await realPlaybackState();
  await waitFor(async () => { const p = await realPlaybackState(); return healthyPlayback(p) && p.time > start.time + 1; }, 'healthy advancing live media after recovery', 45000);
}
async function runLifecycle() {
  report.phase = 'real-lifecycle-precondition';
  report.real.lifecycle = { requested: true, secondRoom: nextUrl || 'NOT_REQUESTED', preconditionAt: Date.now(), preconditionPlayback: await realPlaybackState() };
  if (!healthyPlayback(report.real.lifecycle.preconditionPlayback)) {
    report.real.lifecycle.status = 'BLOCKED_PLAYBACK_BEFORE_LIFECYCLE';
    await persist();
    throw new Error('Lifecycle not started: actual live playback is already unhealthy before disable/reenable; see lifecycle.preconditionPlayback and fixed-window samples');
  }
  report.phase = 'real-lifecycle-disable-reenable';
  let before = await evidence();
  report.real.lifecycle.disableReenable = { beforeSnapshot: before.snapshots.at(-1), disabledAt: Date.now() };
  await rpc({ type: 'toggle', enabled: false });
  await untilPage(() => window.__DL_LIVE_EVIDENCE__.controls.at(-1)?.enabled === false, undefined, 'actual disable control');
  let quietAt = Date.now(); await delay(2500);
  assert.equal((await evidence()).renders.filter(row => row.at >= quietAt).length, 0, 'no new rendering while disabled');
  await rpc({ type: 'toggle', enabled: true });
  report.real.lifecycle.disableReenable.reenabledAt = Date.now();
  let generation = await freshSession(before.snapshots.at(-1)?.adapterSession);
  await realPhase('reenabled', { expectedSession: generation, forbiddenIds: eventIds(before) });
  before = await evidence();
  report.phase = 'real-lifecycle-native-pause-resume';
  await page.locator('#movie_player').hover(); await nativeButton('pause');
  await waitFor(async () => (await realPlaybackState()).paused, 'actual player paused');
  await untilPage(() => window.__DL_LIVE_EVIDENCE__.snapshots.at(-1)?.playback.paused, undefined, 'production reader sees paused playback');
  quietAt = Date.now(); await delay(2500);
  assert.equal((await evidence()).renders.filter(row => row.at >= quietAt).length, 0, 'no new rendering while native player paused');
  await page.locator('#movie_player').hover(); await nativeButton('play');
  await recoverPlayback(); generation = await freshSession(before.snapshots.at(-1)?.adapterSession);
  await realPhase('native-resume', { expectedSession: generation, forbiddenIds: eventIds(before) });
  await page.setViewportSize({ width: 1180, height: 820 });
  await realPhase('viewport-1180x820');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const wasTheater = await page.locator('ytd-watch-flexy').evaluate(node => node.hasAttribute('theater'));
  await page.locator('#movie_player').hover(); await nativeButton('theater');
  await untilPage(before => document.querySelector('ytd-watch-flexy')?.hasAttribute('theater') !== before, wasTheater, 'native theater state changed');
  await realPhase('native-theater-toggle');
  // Only the chat continuation endpoint is disrupted. Media/network clocks and
  // production bridge traffic remain untouched throughout this recovery check.
  before = await evidence();
  report.phase = 'real-lifecycle-scoped-chat-reconnect';
  const reconnect = report.real.lifecycle.reconnect = { scope: 'https://www.youtube.com/youtubei/v1/live_chat/get_live_chat', failures: [] };
  const pattern = /^https:\/\/www\.youtube\.com\/youtubei\/v1\/live_chat\/get_live_chat(?:\?|$)/;
  const failChat = async route => { reconnect.failures.push({ at: Date.now(), resourceType: route.request().resourceType() }); await route.abort('failed'); };
  await page.route(pattern, failChat);
  try {
    await waitFor(async () => {
      const snapshot = (await evidence()).snapshots.at(-1);
      if (reconnect.failures.length && ['reconnecting', 'disconnected'].includes(snapshot?.connection)) { reconnect.failureSnapshot = snapshot; return true; }
      return false;
    }, 'actual scoped chat request failure reaches production reconnect state', 30000);
  } finally { await page.unroute(pattern, failChat); reconnect.restoredAt = Date.now(); }
  await recoverPlayback(); generation = await freshSession(before.snapshots.at(-1)?.adapterSession);
  await realPhase('chat-network-recovered', { expectedSession: generation, forbiddenIds: eventIds(before) });
  reconnect.playback = await realPlaybackState();
  if (nextUrl) {
    report.phase = 'real-lifecycle-second-room-navigation';
    before = await evidence();
    const target = resourceFromUrl(nextUrl).resourceId;
    const link = await page.evaluate(target => [...document.querySelectorAll('a[href]')].flatMap((a, index) => {
      const url = new URL(a.href), id = url.searchParams.get('v') || /^\/live\/([^/]+)/.exec(url.pathname)?.[1];
      const rect = a.getBoundingClientRect();
      return url.origin === 'https://www.youtube.com' && id === target && rect.width && rect.height && getComputedStyle(a).visibility !== 'hidden' && (!a.target || a.target === '_self') ? [{ index, href: a.href, text: (a.textContent || '').slice(0, 120) }] : [];
    }), target);
    const navigation = report.real.lifecycle.navigation = { target, action: link.length ? 'actual-site-link' : 'page-goto', link: link[0] || null, beforeDocumentId: before.documentId };
    if (link.length) {
      const anchor = page.locator('a[href]').nth(link[0].index);
      assert.equal(await anchor.evaluate(a => a.href), link[0].href); await anchor.click();
    } else await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await waitFor(() => resourceFromUrl(page.url())?.resourceId === target, 'same-window second live room URL', 30000);
    await recoverPlayback(); generation = await freshSession(before.snapshots.at(-1)?.adapterSession, target);
    navigation.afterDocumentId = (await evidence()).documentId;
    navigation.classification = navigation.afterDocumentId === before.documentId ? 'SPA_SAME_DOCUMENT' : 'FULL_DOCUMENT_RELOAD';
    await realPhase('second-live-room', { expectedSession: generation, forbiddenIds: eventIds(before) });
  }
  report.real.lifecycle.status = 'passed-observed-scope';
}

async function runTargetedLifecycleAction() {
  report.phase = 'real-targeted-lifecycle-precondition';
  const before = await evidence(), originalSettings = (await rpc({ type: 'settings' })).settings;
  const previousSession = before.snapshots.at(-1)?.adapterSession, room = resourceFromUrl(page.url()).resourceId;
  const action = report.real.targetedLifecycle = { action: lifecycleAction, scope: 'TARGETED_LIFECYCLE_ACTION_ONLY', status: 'running',
    notCovered: ['other lifecycle actions', 'chat visibility/fullscreen transitions', 'viewport/theater changes', 'chat reconnect', 'room navigation', '90-second continuous-playback acceptance'],
    beforeSnapshot: before.snapshots.at(-1), forbiddenOldIds: eventIds(before), preconditionAt: Date.now(), preconditionPlayback: await realPlaybackState() };
  assert.equal(originalSettings.enabled, true, 'The targeted action must begin from the original enabled configuration');
  assert.ok(typeof previousSession === 'string' && before.snapshots.at(-1)?.resourceId === room
    && before.snapshots.at(-1)?.connection === 'connected' && healthyPlayback(action.preconditionPlayback), 'Targeted action needs healthy playback and a connected current generation');
  // The reader may take time to connect after initial playback readiness; reject a now-stalled precondition.
  await delay(250); action.preconditionConfirmedAt = Date.now(); action.preconditionConfirmedPlayback = await realPlaybackState();
  const advanced = action.preconditionConfirmedPlayback.time - action.preconditionPlayback.time;
  assert.ok(healthyPlayback(action.preconditionConfirmedPlayback) && advanced > 0.05
    && advanced <= (action.preconditionConfirmedAt - action.preconditionAt) / 1000 * 2 + 0.5, 'Targeted action not started: playback is no longer advancing');
  report.phase = 'real-targeted-' + lifecycleAction; action.actionAt = Date.now();
  if (lifecycleAction === 'off-on') {
    await rpc({ type: 'toggle', enabled: false });
    await untilPage(at => { const c = window.__DL_LIVE_EVIDENCE__.controls.at(-1); return c?.at >= at && c.enabled === false; }, action.actionAt, 'targeted actual disable acknowledged');
  } else {
    await page.locator('#movie_player').hover(); await nativeButton('pause');
    await waitFor(async () => (await realPlaybackState()).paused, 'targeted actual native player paused');
    await untilPage(at => { const s = window.__DL_LIVE_EVIDENCE__.snapshots.at(-1); return s?.at >= at && s.playback?.paused; }, action.actionAt, 'targeted production reader observes actual pause');
  }
  const quiet = action.quiet = { startAt: Date.now(), requiredMs: 2500, samples: [], sampleFailures: [] };
  const quietSample = async () => {
    const row = { at: Date.now() };
    try {
      row.playback = await realPlaybackState();
      Object.assign(row, await page.evaluate(at => { const e = window.__DL_LIVE_EVIDENCE__; return {
        snapshot: e?.snapshots.at(-1), control: e?.controls.at(-1), newRenderCount: e?.renders.filter(r => r.at >= at).length }; }, quiet.startAt));
    } catch { row.sampleFailure = true; quiet.sampleFailures.push({ at: row.at, operation: 'quiet-state-sample' }); }
    quiet.samples.push(row);
  };
  await quietSample();
  while (Date.now() < quiet.startAt + quiet.requiredMs) { await delay(Math.min(250, quiet.startAt + quiet.requiredMs - Date.now())); await quietSample(); }
  quiet.observedUntil = Date.now();
  quiet.healthy = !quiet.sampleFailures.length && quiet.samples.every(row => row.newRenderCount === 0
    && (lifecycleAction === 'off-on' ? row.control?.enabled === false : row.playback?.paused === true && row.snapshot?.playback?.paused === true));
  // Always restore after the measured quiet interval; violations remain recorded for the final action decision.
  action.restoreRequestedAt = Date.now();
  if (lifecycleAction === 'off-on') await rpc({ type: 'toggle', enabled: originalSettings.enabled });
  else { await page.locator('#movie_player').hover(); await nativeButton('play'); }
  await recoverPlayback();
  action.expectedSession = await freshSession(previousSession, room);
  action.recoveredAt = Date.now(); action.recoveredPlayback = await realPlaybackState();
  const restoredSettings = (await rpc({ type: 'settings' })).settings;
  action.originalConfigurationRestored = JSON.stringify(restoredSettings) === JSON.stringify(originalSettings);
  const recordedWindow = await fixedMetricsWindow({ preserveSamplingFailures: true });
  const metric = report.real.fixedWindow, observed = recordedWindow.observed;
  const windowBatches = observed.events.filter(batch => batch.resourceId === room && (batch.events || []).some(e => e.receivedAt >= recordedWindow.startAt && e.receivedAt < recordedWindow.endAt));
  const snapshots = [recordedWindow.initialSnapshot, ...observed.snapshots.filter(row => row.at >= recordedWindow.startAt && row.at <= recordedWindow.observedUntil)];
  const allRecoveryRenders = observed.renders.filter(row => row.at >= action.restoreRequestedAt && row.at <= recordedWindow.observedUntil);
  const windowRenders = allRecoveryRenders.filter(row => row.at >= recordedWindow.startAt);
  const sources = new Map(windowBatches.filter(batch => batch.adapterSession === action.expectedSession).flatMap(batch => (batch.events || [])
    .filter(source => source.receivedAt >= recordedWindow.startAt && source.receivedAt < recordedWindow.endAt)
    .map(source => [liveEventId({ platform: 'youtube', scenario: 'live', resourceId: room }, source.sourceId), source])));
  action.chains = windowRenders.flatMap(render => {
    const source = sources.get(render.eventId);
    if (!source || render.adapterSession !== action.expectedSession || render.sourceAdapterSession !== action.expectedSession
      || render.translationStatus !== 'translated' || !Number.isFinite(render.preparedAt)
      || render.preparedAt < source.receivedAt || render.preparedAt >= source.receivedAt + metric.bufferMs || render.changes.length) return [];
    return [{ eventId: render.eventId, sourceId: source.sourceId, adapterSession: action.expectedSession, receivedAt: source.receivedAt,
      preparedAt: render.preparedAt, displayAt: render.displayAt, renderedAt: render.at }];
  });
  const requests = (report.providerNetwork || []).filter(row => row.startedAt >= recordedWindow.startAt && row.startedAt < recordedWindow.endAt);
  action.providerEvidence = { kind: report.provider, windowRequests: requests.length, http200: requests.filter(row => row.status === 200).length,
    failed: requests.filter(row => row.status === 'failed').length, perEventHttpCorrelation: false,
    boundary: 'Chains link actual source IDs/generation to production preparedAt and translated overlay. Network metadata proves observed Provider calls, not per-event HTTP causality; cache use is not separately observable here.' };
  action.recoveryChainEvidence = { expectedSession: action.expectedSession, observed: action.chains.length > 0,
    timelyTranslatedChains: action.chains.length, fullWindowAcceptance: false,
    boundary: 'Expected-session chains remain recorded even if a later media failure resets the final snapshot generation. They do not remove failed samples or establish whole-window health.' };
  action.generationMaintained = snapshots.length > 0 && snapshots.every(row => row?.resourceId === room && row.adapterSession === action.expectedSession && row.connection === 'connected')
    && windowBatches.every(row => row.adapterSession === action.expectedSession);
  action.oldSourceReplays = allRecoveryRenders.filter(row => action.forbiddenOldIds.includes(row.eventId));
  action.oldSourceReplayCheck = { knownPriorSourceIds: action.forbiddenOldIds.length, replays: action.oldSourceReplays.length,
    status: !action.forbiddenOldIds.length ? 'NOT_EXERCISED_NO_PRIOR_SOURCE_IDS'
      : action.oldSourceReplays.length ? 'FAILED_OLD_SOURCE_REPLAY' : 'NO_KNOWN_OLD_SOURCE_REPLAY_OBSERVED' };
  action.performanceTarget = metric.summary.target.status;
  action.window = { ...metric.window, requestedSeconds: metricsSeconds, originalBufferMs: metric.bufferMs, freshWaitAfterWindow: false };
  action.status = 'recorded-awaiting-checks'; await persist();
  const phaseName = lifecycleAction === 'off-on' ? 'targeted-reenabled' : 'targeted-native-resume';
  await realPhase(phaseName, { marker: recordedWindow.startAt, expectedSession: action.expectedSession,
    forbiddenIds: action.forbiddenOldIds, recordedWindow });
  assert.ok(quiet.healthy, 'Targeted action did not retain the full 2.5 second no-new-render inactive interval');
  assert.ok(action.originalConfigurationRestored && action.generationMaintained && !action.oldSourceReplays.length,
    'Targeted action must restore configuration and retain the new generation without replaying old IDs');
  assert.ok(metric.summary.captureComplete && metric.summary.window.fixedWindowComplete && !metric.sampleFailures.length,
    'Targeted action requires intact fixed-window sampling and the original complete deadline drain');
  assert.ok(action.chains.length && (!realProvider || action.providerEvidence.http200 > 0),
    'Targeted recorded window lacks a timely fresh translation chain or actual real-Provider request evidence');
  action.status = 'passed-observed-action';
  report.checks['targeted-lifecycle-action'] = { status: 'passed', scope: action.scope, action: lifecycleAction,
    fixedWindowMs: recordedWindow.endAt - recordedWindow.startAt, performanceTarget: action.performanceTarget,
    oldSourceReplayCheck: action.oldSourceReplayCheck, fullLifecycleCovered: false };
}

async function fixedMetricsWindow({ requiredScope = 'all', preserveSamplingFailures = false } = {}) {
  const { summarizeLiveWindow } = await import('./live-acceptance-metrics.mjs');
  const settings = (await rpc({ type: 'settings' })).settings;
  const sampleFailures = [];
  const readEvidence = async stage => {
    try {
      const value = await evidence();
      if (preserveSamplingFailures && (!value || !Array.isArray(value.snapshots) || !Array.isArray(value.events) || !Array.isArray(value.renders))) throw new Error('missing-observer-evidence');
      return value;
    } catch (error) {
      if (!preserveSamplingFailures) throw error;
      sampleFailures.push({ at: Date.now(), operation: stage });
      return { documentId: null, snapshots: [], events: [], renders: [], admissionRejections: [], overflow: { evidenceUnavailable: 1 } };
    }
  };
  const takeSample = async () => {
    const row = { at: Date.now() };
    if (!preserveSamplingFailures) return { ...row, playback: await realPlaybackState(), runtime: (await rpc({ type: 'overview' })).status,
      ...(requiredScope === 'all' ? {} : { scopeState: await observationScopeState() }) };
    try { row.playback = await realPlaybackState(); } catch {
      row.playback = { time: null, paused: true, seeking: false, readyState: 0, errorCode: null, visibleError: false, ad: false, liveDistance: null, native: {} };
      row.playbackReadFailed = true; sampleFailures.push({ at: row.at, operation: 'fixed-window-playback-sample' });
    }
    try {
      row.runtime = (await rpc({ type: 'overview' })).status;
      if (!row.runtime || typeof row.runtime !== 'object') throw new Error('missing-runtime-sample');
    } catch { row.runtime = null; row.runtimeReadFailed = true; sampleFailures.push({ at: row.at, operation: 'fixed-window-runtime-sample' }); }
    return row;
  };
  const start = await readEvidence('fixed-window-initial-evidence'), initialSnapshotCapturedAt = Date.now(), firstSample = await takeSample();
  const startAt = firstSample.at, endAt = startAt + metricsSeconds * 1000;
  const observedUntil = endAt + settings.liveBufferMs + 1500;
  const metric = report.real.fixedWindow = { window: { startAt, endAt, observedUntil: null }, requestedSeconds: metricsSeconds, bufferMs: settings.liveBufferMs,
    requiredScope, initialPlayback: firstSample.playback, initialSnapshot: start.snapshots.at(-1), initialSnapshotCapturedAt,
    samples: [firstSample], ...(preserveSamplingFailures ? { sampleFailures } : {}), rawEvidencePath: resolve(runDir, 'fixed-window-evidence.json') };
  report.phase = 'real-fixed-window-metrics';
  while (Date.now() < observedUntil) {
    await delay(Math.min(1000, Math.max(0, observedUntil - Date.now())));
    if (Date.now() < observedUntil) metric.samples.push(await takeSample());
  }
  // Include the deadline-drain boundary, even after a failure; do not shorten the observation.
  metric.samples.push(await takeSample());
  const observed = await readEvidence('fixed-window-final-evidence'); metric.window.observedUntil = Date.now();
  const sameDocument = !!start.documentId && observed.documentId === start.documentId;
  if (!preserveSamplingFailures) assert.equal(observed.documentId, start.documentId, 'fixed metrics window must retain the same document');
  else if (!sameDocument) sampleFailures.push({ at: metric.window.observedUntil, operation: 'fixed-window-document-coverage' });
  const budgetInterrupted = !!report.requestBudget?.limitReachedAt && report.requestBudget.limitReachedAt <= metric.window.observedUntil;
  const captureComplete = JSON.stringify(observed.overflow) === JSON.stringify(start.overflow) && !budgetInterrupted
    && (!preserveSamplingFailures || sameDocument && !sampleFailures.length);
  const idFor = (batch, id) => JSON.stringify([batch.resourceId, batch.adapterSession, id]);
  const sources = [], outcomes = [], sourceRows = [];
  for (const batch of observed.events) for (const e of batch.events || []) {
    if (e.receivedAt < startAt || e.receivedAt >= endAt) continue;
    const source = { id: idFor(batch, e.sourceId), receivedAt: e.receivedAt, sentAtEpochMs: e.sentAtEpochMs,
      eligible: e.translatable === true && needsTranslation(e.originalText, settings.targetLanguage, settings.liveSourceLanguage) && !protectText(e.originalText).reason };
    sources.push(source); sourceRows.push({ ...source, sourceId: e.sourceId, authorId: e.authorId, adapterSession: batch.adapterSession, resourceId: batch.resourceId });
  }
  for (const render of observed.renders.filter(row => row.at >= startAt)) {
    let identity; try { identity = JSON.parse(render.eventId); } catch { continue; }
    if (!Array.isArray(identity) || !['translated', 'original'].includes(render.translationStatus)) continue;
    outcomes.push({ id: JSON.stringify([identity[2], render.sourceAdapterSession, identity[3]]), kind: render.translationStatus, at: render.at, preparedAt: render.preparedAt ?? undefined,
      textChangedAfterDisplay: render.changes.length > 0 });
  }
  outcomes.push(...observedAdmissionOutcomes(observed.admissionRejections, sources, metric.window));
  for (const batch of observed.events.filter(row => row.at >= startAt)) for (const source of sourceRows) {
    if (source.adapterSession !== batch.adapterSession || source.resourceId !== batch.resourceId || batch.at < source.receivedAt) continue;
    if (batch.removes?.includes(source.sourceId) || source.authorId && batch.removeAuthors?.includes(source.authorId)) {
      const display = outcomes.find(outcome => outcome.id === source.id && ['translated', 'original'].includes(outcome.kind));
      if (!display || batch.at < display.at) outcomes.push({ id: source.id, kind: 'removed', at: batch.at, reason: 'verified production moderation event before display' });
    }
  }
  const requests = (report.providerNetwork || []).filter(row => row.startedAt >= startAt && row.startedAt < endAt);
  const nativePlaybackHealthy = metric.samples.every(row => healthyPlayback(row.playback));
  metric.progressAudit = auditMediaProgress(metric.samples, metric.window);
  metric.scopeAudit = auditHiddenScope(metric.samples, requiredScope);
  const playbackHealthy = nativePlaybackHealthy && metric.progressAudit.healthy;
  metric.evidenceCaptureComplete = captureComplete;
  metric.summary = summarizeLiveWindow({ providerKind: realProvider ? 'real' : 'mock', bufferMs: settings.liveBufferMs, window: metric.window, sources, outcomes, requests,
    captureComplete: captureComplete && metric.scopeAudit.healthy, playbackHealthy });
  metric.coverage = { sourceEventIds: true, actualDomOutcomes: true,
    observedOverlayAdmissionRejections: outcomes.filter(row => row.kind === 'dropped' && row.reason === 'native-overlay-admission').length,
    hiddenSchedulerDropReason: 'only exact observed temporary-node overlay admission rejections are classified; other hidden drop paths remain unavailable and missing outcomes stay in the denominator', providerRequestsObserved: requests.length,
    healthyThroughout: playbackHealthy, nativePlaybackHealthy, advancingThroughout: metric.progressAudit.healthy,
    scopeMaintained: metric.scopeAudit.healthy, sessions: [...new Set(sourceRows.map(row => row.adapterSession))] };
  metric.observationStatus = budgetInterrupted ? 'INCOMPLETE_REQUEST_BUDGET' : sampleFailures.length ? 'INCOMPLETE_SAMPLE_EVIDENCE' : !metric.scopeAudit.healthy ? 'INCOMPLETE_OBSERVATION_SCOPE_LOST'
    : metric.coverage.healthyThroughout ? 'COMPLETE_FIXED_WINDOW_CAPTURE' : 'INCOMPLETE_PLAYBACK_INTERRUPTED';
  metric.firstUnhealthySample = metric.samples.find(row => !healthyPlayback(row.playback))
    || metric.samples[metric.progressAudit.firstFailure?.index] || null;
  report.checks['fixed-window-advancing-media'] = { status: playbackHealthy ? 'passed' : 'failed', nativePlaybackHealthy, progressAudit: metric.progressAudit };
  if (requiredScope !== 'all') report.checks['fixed-window-observation-scope'] = { status: metric.scopeAudit.healthy ? 'passed' : 'failed', ...metric.scopeAudit };
  await writeFile(metric.rawEvidencePath, JSON.stringify({ window: metric.window, sources, outcomes, requests, observed, samples: metric.samples,
    requiredScope, ...(preserveSamplingFailures ? { sampleFailures, sameDocument } : {}), progressAudit: metric.progressAudit, scopeAudit: metric.scopeAudit }, null, 2));
  await persist(); console.log('COMPLETE: fixed ' + metricsSeconds + 's window plus deadline drain; no early success stop');
  return { ...metric.window, initialPlayback: metric.initialPlayback, initialSnapshot: metric.initialSnapshot,
    finalSample: metric.samples.at(-1), observed, playbackHealthy, scopeAudit: metric.scopeAudit };
}

try {
  let config;
  if (realProvider) {
    for (const name of ['DANLINGO_E2E_ENDPOINT', 'DANLINGO_E2E_MODEL', 'DANLINGO_E2E_PROFILE', 'DANLINGO_E2E_THINKING']) assert.ok(process.env[name], `Set explicit ${name} before real-provider work`);
    assert.ok(['minimax', 'deepseek', 'gemini', 'chat-completions'].includes(process.env.DANLINGO_E2E_PROFILE), 'Invalid explicit Provider profile');
    config = normalizeSettings({ ...DEFAULT_SETTINGS, enabled: true, endpoint: process.env.DANLINGO_E2E_ENDPOINT, model: process.env.DANLINGO_E2E_MODEL,
      profile: process.env.DANLINGO_E2E_PROFILE, thinkingEffort: process.env.DANLINGO_E2E_THINKING,
      concurrency: Number(process.env.DANLINGO_E2E_CONCURRENCY || DEFAULT_SETTINGS.concurrency),
      batchSize: Number(process.env.DANLINGO_E2E_BATCH_SIZE || DEFAULT_SETTINGS.batchSize), allowLocalHttp: true });
    endpoint = config.endpoint;
    const { readTestKey } = await import('./verify-real-provider.mjs'); apiKey = await readTestKey();
    report.providerSettings = { endpoint, model: config.model, profile: config.profile, thinkingEffort: config.thinkingEffort, concurrency: config.concurrency, batchSize: config.batchSize };
  } else {
    apiKey = 'danlingo-live-local-test-only';
    mock = createServer(async (req, res) => {
      res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', 'authorization,content-type'); res.setHeader('content-type', 'application/json');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end('{}'); return; }
      try {
        assert.equal(req.headers.authorization, 'Bearer ' + apiKey);
        let body = ''; for await (const part of req) { body += part; assert.ok(body.length <= 1000000, 'mock body budget'); }
        const decoded = decodeTranslationFixtureRequest(JSON.parse(body)), { items } = decoded;
        assert.ok(Array.isArray(items) && items.length <= 200 && report.requests.length < (realOnly ? 2000 : 200), 'mock request budget');
        const row = { at: Date.now(), phase: report.phase, count: items.length, protocol: decoded.protocol,
          ...(realOnly ? {} : { texts: items.map(item => item.text) }), held: !realOnly && items.some(item => item.text.includes('HELD_')) };
        report.requests.push(row);
        if (row.held) await new Promise(done => held.add(done));
        row.releasedAt = Date.now(); row.responseClosed = res.destroyed;
        const outputs = items.map(item => ({ id: item.id, text: translated(item.text) })).reverse();
        const reply = encodeTranslationFixtureResponse(decoded, outputs);
        res.setHeader('content-type', reply.contentType); res.end(reply.body);
      } catch { report.errors.push('Local mock rejected an invalid or over-budget request'); if (!res.headersSent) res.writeHead(500); res.end('{}'); }
    });
    await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${mock.address().port}/v1/chat/completions`;
    config = normalizeSettings({ ...DEFAULT_SETTINGS, enabled: true, endpoint, model: 'danlingo-live-local-mock', profile: 'chat-completions', thinkingEffort: 'default',
      allowLocalHttp: true, liveSourceLanguage: realOnly ? 'auto' : 'ja', liveBufferMs: realOnly ? 2000 : 500, liveDensity: 12 });
  }
  const build = resolve('.output/chrome-mv3'), extension = resolve(runDir, 'test-extension');
  const sourceManifest = await readFile(resolve(build, 'manifest.json'), 'utf8');
  report.build = { path: build, manifestSha256: createHash('sha256').update(sourceManifest).digest('hex'), version: JSON.parse(sourceManifest).version };
  await cp(build, extension, { recursive: true });
  const manifest = JSON.parse(sourceManifest), origin = new URL(endpoint);
  manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), `${origin.protocol}//${origin.hostname}/*`])];
  await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const { chromium } = await loadPlaywright();
  const profile = await mkdtemp(resolve(runDir, 'profile-')); report.profile = profile;
  context = await chromium.launchPersistentContext(profile, { ...browserLaunchOptions(browserName), headless: !args.includes('--headed'), viewport: { width: 1440, height: 1000 }, locale: 'ja-JP',
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--autoplay-policy=no-user-gesture-required'] });
  const networkRows = new Map(); report.providerNetwork = [];
  report.requestBudget = { maxRequests, inFlightAllowance: config.concurrency };
  context.on('request', request => {
    if (request.method() !== 'POST' || request.url() !== endpoint) return;
    const row = { startedAt: Date.now() }; networkRows.set(request, row); report.providerNetwork.push(row);
    if (realProvider && report.providerNetwork.length >= maxRequests && !report.requestBudget.limitReachedAt) {
      report.requestBudget.limitReachedAt = Date.now();
      budgetTasks.push((async () => { if (rpc) await rpc({ type: 'toggle', enabled: false }).catch(() => {}); })());
    }
    if (realProvider && report.providerNetwork.length > maxRequests + config.concurrency && !report.requestBudget.forcedClose) {
      report.requestBudget.forcedClose = true; budgetTasks.push(context.close().catch(() => {}));
    }
  });
  context.on('requestfinished', async request => {
    const row = networkRows.get(request); if (!row) return;
    row.completedAt = Date.now(); row.status = (await request.response().catch(() => null))?.status() ?? null;
  });
  context.on('requestfailed', request => {
    const row = networkRows.get(request); if (row) { row.completedAt = Date.now(); row.status = 'failed'; }
  });
  report.browserVersion = context.browser()?.version() || null;
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = new URL(worker.url()).host;
  options = await context.newPage();
  options.on('pageerror', error => report.errors.push('options: ' + redact(error.message).slice(0, 500)));
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  rpc = payload => options.evaluate(payload => chrome.runtime.sendMessage(payload), payload);
  // Initial overview/cache loading can complete after navigation's load event. Do not
  // race that older response against a synthetic out-of-band configuration save.
  await waitFor(async () => !!(await options.locator('#key-state').textContent()) || !!(await options.locator('#result').textContent()), 'initial options overview completed');
  assert.equal(await options.locator('#result').innerText(), '', 'initial options load must succeed');
  const saved = await rpc({ type: 'save', settings: config, apiKey, remember: false });
  assert.equal(saved.ok, true, saved.error); assert.equal(saved.remembered, false);
  const persisted = await rpc({ type: 'settings' });
  assert.equal(persisted.settings.model, config.model, 'trusted background persisted the requested model');
  assert.equal(persisted.settings.concurrency, config.concurrency, 'trusted background persisted the requested concurrency');
  assert.equal(persisted.settings.batchSize, config.batchSize, 'trusted background persisted the requested batch size');
  report.configuration = { savedModel: saved.settings.model, persistedModel: persisted.settings.model, hasKey: persisted.hasKey, remembered: persisted.remembered,
    liveBufferMs: persisted.settings.liveBufferMs, liveDensity: persisted.settings.liveDensity, concurrency: persisted.settings.concurrency, batchSize: persisted.settings.batchSize };
  // Fixture setup uses a trusted RPC instead of the form's own save callback. Reload
  // once so subsequent UI tests start from persisted data, independent of broadcasts.
  await options.reload({ waitUntil: 'load' });
  await waitFor(async () => await options.locator('#model').inputValue() === config.model, 'options filled with saved configuration');
  report.checks.isolatedConfiguration = { status: 'passed', saved: true, keyRemembered: false, actualProviderKeyUsed: realProvider };
  page = await context.newPage();
  await page.addInitScript(installLiveObserver);
  if (!realOnly) {
    fixture = await installLiveFixtureRoutes(page);
    await page.goto(`https://www.youtube.com/watch?v=${LIVE_FIXTURE_IDS[0]}`, { waitUntil: 'domcontentloaded' }); await page.bringToFront();
    await connected(LIVE_FIXTURE_IDS[0]);
    await check('initial-snapshot-no-catch-up', async () => {
      await delay(700);
      assert.ok(!report.requests.some(row => row.texts?.some(text => text.includes('BASELINE'))));
      assert.ok(!(await evidence()).renders.some(row => row.text.includes('BASELINE')));
      assert.match(await page.locator('#danlingo-live-status').locator('#coverage').innerText(), /Top chat/);
      return { baselineSuppressed: true, coverage: 'top', screenshot: await screenshot('fixture-baseline') };
    });
    await check('four-buffers-and-options-preserve-provider', async () => {
      await settingsSection(options,'live');
      const before = (await rpc({ type: 'settings' })).settings;
      const timings = [];
      for (const buffer of [500, 1000, 2000, 3000]) {
        await options.locator('#live-buffer').selectOption(String(buffer)); await options.locator('#save').click();
        await waitFor(async () => (await options.locator('#result').innerText()).startsWith('已保存') && await options.locator('#save').isEnabled(), 'options save completed');
        await waitFor(async () => (await rpc({ type: 'settings' })).settings.liveBufferMs === buffer, 'buffer persisted through options UI');
        await page.bringToFront();
        await untilPage(buffer => window.__DL_LIVE_EVIDENCE__.controls.at(-1)?.bufferMs === buffer, buffer, 'isolated settings control');
        const id = 'buffer-' + buffer, text = `BUFFER_${buffer} 日本語のコメント`;
        const source = await inject(id, text);
        const shown = await waitFor(() => rendered(translated(text)), 'translated overlay for buffer ' + buffer);
        assert.equal(shown.eventId, liveEventId({ platform: 'youtube', scenario: 'live', resourceId: LIVE_FIXTURE_IDS[0] }, id));
        assert.equal(shown.translationStatus, 'translated'); assert.ok(Number.isFinite(shown.displayAt));
        assert.ok(Number.isFinite(shown.preparedAt) && shown.preparedAt >= source.receivedAt && shown.preparedAt < shown.displayAt, 'translated preparation is after receipt and before its display deadline');
        assert.equal(shown.sourceAdapterSession, shown.adapterSession);
        const elapsedMs = shown.at - source.receivedAt;
        assert.ok(elapsedMs >= buffer - 80 && elapsedMs <= buffer + 600, `display buffer ${buffer}: observed ${elapsedMs}ms`);
        const node = page.locator('#danlingo-live-overlay').locator('span').filter({ hasText: translated(text) }).first();
        const motion = await node.evaluate(element => { const animation = element.getAnimations()[0]; return { playState: animation?.playState, frames: animation?.effect?.getKeyframes(), pointerEvents: getComputedStyle(element).pointerEvents }; });
        assert.equal(motion.playState, 'running'); assert.equal(motion.pointerEvents, 'none'); assert.equal(motion.frames?.length, 2);
        timings.push({ bufferMs: buffer, elapsedMs, cssAnimation: true, eventId: shown.eventId, adapterSession: shown.adapterSession, translationStatus: shown.translationStatus, displayAt: shown.displayAt, preparedAt: shown.preparedAt });
      }
      const after = (await rpc({ type: 'settings' })).settings;
      for (const key of ['endpoint', 'model', 'profile', 'thinkingEffort', 'sourceLanguage', 'targetLanguage']) assert.equal(after[key], before[key], key);
      return { timings, providerPreferencesPreserved: true, screenshot: await screenshot('fixture-translated') };
    });
    await check('unicode-emoji-through-parser-provider-and-overlay', async () => {
      const id = 'unicode-glyphs', glyphs = ['😂', '👨‍👩‍👧‍👦', '👍🏽', '🇯🇵', '1️⃣', '❤️'];
      const text = 'UNICODE_EMOJI 日本語 ' + glyphs.join(' ');
      const action = chatAdd(id, 'UNICODE_EMOJI 日本語 ');
      const runs = action.addChatItemAction.item.liveChatTextMessageRenderer.message.runs;
      glyphs.forEach((glyph, index) => {
        if (index) runs.push({ text: ' ' });
        runs.push({ emoji: { emojiId: glyph, shortcuts: [':display-name:'] } });
      });
      fixture.enqueue(LIVE_FIXTURE_IDS[0], action);
      const source = await untilPage(id => window.__DL_LIVE_EVIDENCE__.events.flatMap(row => row.events || []).find(event => event.sourceId === id), id, 'structured Unicode emoji event');
      assert.equal(source.originalText, text);
      const shown = await waitFor(() => rendered(translated(text)), 'translated Unicode emoji overlay');
      assert.equal(shown.translationStatus, 'translated');
      assert.ok(shown.preparedAt < source.receivedAt + 3000);
      assert.ok(!shown.text.includes(':display-name:') && !shown.text.includes('[[DL:'));
      await untilPage(expected => {
        const host = document.getElementById('danlingo-live-overlay');
        const node = [...(host?.shadowRoot?.querySelectorAll('span') || [])].find(node => node.textContent === expected);
        if (!node) return false;
        const bounds = node.getBoundingClientRect(), playerBounds = host.getBoundingClientRect();
        return bounds.right <= playerBounds.right - 10 && bounds.right > playerBounds.left + 300;
      }, translated(text), 'actual emoji tail visible inside the player');
      return { sourceAndDisplayGlyphsPreserved: true, glyphs, eventId: shown.eventId,
        screenshot: await screenshot('fixture-unicode-emoji') };
    });
    await check('timeout-original-and-late-no-replacement', async () => {
      await save({ liveBufferMs: 500 });
      await untilPage(() => window.__DL_LIVE_EVIDENCE__.controls.at(-1)?.bufferMs === 500, undefined, '500ms buffer control');
      const text = 'HELD_TIMEOUT 日本語の遅いコメント 😂 1️⃣'; await inject('timeout', text);
      await waitFor(() => held.size > 0, 'actual held provider request');
      const shown = await waitFor(() => rendered(text), 'original fallback overlay');
      assert.equal(shown.translationStatus, 'original');
      assert.equal(shown.preparedAt, null, 'original fallback does not claim a preparation timestamp');
      releaseHeld(); await delay(700);
      assert.equal(await rendered(translated(text)), undefined); assert.deepEqual((await rendered(text)).changes, []);
      return { originalAt: shown.at, lateReplacement: false, screenshot: await screenshot('fixture-original-fallback') };
    });
    await check('deletion-before-display-and-author-removal-after-display', async () => {
      await save({ liveBufferMs: 3000 });
      await untilPage(() => window.__DL_LIVE_EVIDENCE__.controls.at(-1)?.bufferMs === 3000, undefined, '3000ms buffer control');
      const pendingText = 'REMOVE_PENDING 削除されるコメント'; const source = await inject('pending-delete', pendingText);
      fixture.enqueue(LIVE_FIXTURE_IDS[0], chatDelete('pending-delete'));
      await untilPage(() => window.__DL_LIVE_EVIDENCE__.events.some(row => row.removes?.includes('pending-delete')), undefined, 'actual MAIN deletion event');
      await delay(Math.max(0, source.receivedAt + 3300 - Date.now()));
      assert.equal(await rendered(pendingText), undefined); assert.equal(await rendered(translated(pendingText)), undefined);
      await save({ liveBufferMs: 500 });
      await untilPage(() => window.__DL_LIVE_EVIDENCE__.controls.at(-1)?.bufferMs === 500, undefined, '500ms buffer control');
      const visibleText = 'REMOVE_AUTHOR 表示後に削除'; await inject('author-visible', visibleText, 'remove-author');
      await waitFor(() => rendered(translated(visibleText)), 'author message rendered');
      fixture.enqueue(LIVE_FIXTURE_IDS[0], chatDeleteAuthor('remove-author'));
      await waitFor(async () => (await rendered(translated(visibleText)))?.removedAt, 'actual displayed author message removed');
      return { pendingSuppressed: true, visibleAuthorRemoved: true };
    });
    await check('player-click-through-hidden-chat-and-fullscreen', async () => {
      await page.locator('#hide-chat').click(); assert.ok(await page.locator('#chat').isHidden());
      const text = 'HIDDEN_CHAT 非表示でも続く'; await inject('hidden-chat', text); await waitFor(() => rendered(translated(text)), 'hidden-chat translation');
      const before = await page.locator('#fixture-click-count').innerText();
      await page.locator('#movie_player').click({ position: { x: 60, y: 30 } });
      assert.ok(Number(await page.locator('#fixture-click-count').innerText()) > Number(before));
      await page.locator('#fullscreen').click();
      await untilPage(() => !!document.fullscreenElement, undefined, 'actual fullscreen entry');
      const fsText = 'FULLSCREEN 全画面でも続く'; await inject('fullscreen', fsText); await waitFor(() => rendered(translated(fsText)), 'fullscreen translation');
      assert.ok(await page.evaluate(() => document.fullscreenElement.contains(document.getElementById('danlingo-live-overlay'))));
      assert.ok(await page.locator('#danlingo-live-status').isHidden());
      const shot = await screenshot('fixture-fullscreen'); await page.evaluate(() => document.exitFullscreen());
      return { pointerEventsPassThrough: true, hiddenNativeChatContinues: true, fullscreenContinues: true, screenshot: shot };
    });
    await check('disable-and-reenable-do-not-replay', async () => {
      await rpc({ type: 'toggle', enabled: false });
      await untilPage(() => window.__DL_LIVE_EVIDENCE__.controls.at(-1)?.enabled === false, undefined, 'disable acknowledged');
      const text = 'DISABLED_BASELINE 無効中のコメント'; fixture.enqueue(LIVE_FIXTURE_IDS[0], chatAdd('disabled', text));
      await delay(1500); assert.equal(await rendered(translated(text)), undefined);
      await rpc({ type: 'toggle', enabled: true }); await connected(LIVE_FIXTURE_IDS[0]); await delay(1500);
      assert.equal(await rendered(text), undefined); assert.equal(await rendered(translated(text)), undefined);
      const fresh = 'REENABLED_NEW 再開後の新着'; await inject('reenabled', fresh); await waitFor(() => rendered(translated(fresh)), 'new message after enabling');
      return { inactiveBaselineSuppressed: true, freshMessageTranslated: true };
    });
    await check('pause-ad-and-away-from-live-edge-stop-new-display', async () => {
      const states = [{ label: 'paused', patch: { paused: true } }, { label: 'ad', patch: { ad: true } }, { label: 'away', patch: { atLiveEdge: false } }];
      for (const state of states) {
        await page.evaluate(patch => window.__DL_LIVE_FIXTURE__.update(patch), state.patch);
        await untilPage(label => { const p = window.__DL_LIVE_EVIDENCE__.snapshots.at(-1)?.playback; return p && (label === 'paused' ? p.paused : label === 'ad' ? !p.contentActive : !p.atLiveEdge); }, state.label, 'inactive playback snapshot');
        const text = `INACTIVE_${state.label} 停止中のコメント`; fixture.enqueue(LIVE_FIXTURE_IDS[0], chatAdd('inactive-' + state.label, text));
        await delay(1700); assert.equal(await rendered(translated(text)), undefined);
        await page.evaluate(() => window.__DL_LIVE_FIXTURE__.update({ paused: false, ad: false, atLiveEdge: true }));
        await connected(LIVE_FIXTURE_IDS[0]); await delay(1200);
        assert.equal(await rendered(text), undefined); assert.equal(await rendered(translated(text)), undefined);
      }
      return { states: states.map(s => s.label), replayed: false };
    });
    await check('room-change-rejects-held-old-session-result', async () => {
      await save({ liveBufferMs: 3000 }); await untilPage(() => window.__DL_LIVE_EVIDENCE__.controls.at(-1)?.bufferMs === 3000, undefined, '3000ms buffer control');
      const old = 'HELD_OLD_ROOM 古い部屋のコメント'; await inject('old-room', old); await waitFor(() => held.size > 0, 'old room provider held');
      const before = (await evidence()).snapshots.at(-1);
      await page.locator('#room-b').click(); await connected(LIVE_FIXTURE_IDS[1]);
      const after = (await evidence()).snapshots.at(-1); assert.notEqual(after.adapterSession, before.adapterSession);
      releaseHeld(); await delay(500);
      assert.equal(await rendered(translated(old)), undefined);
      const fresh = 'ROOM_B_NEW 新しい部屋のコメント'; await inject('room-b-new', fresh); await waitFor(() => rendered(translated(fresh)), 'new room translated output');
      assert.equal(await rendered(old), undefined); assert.equal(await rendered(translated(old)), undefined);
      return { beforeRoom: before.resourceId, afterRoom: after.resourceId, oldSessionRejected: true, screenshot: await screenshot('fixture-room-b') };
    });
    await check('unsupported-all-chat-is-explicit', async () => {
      await page.locator('#all-chat').click();
      await untilPage(() => { const snapshot = window.__DL_LIVE_EVIDENCE__.snapshots.at(-1); return snapshot?.connection === 'disconnected' && snapshot.coverage === 'unknown' && snapshot.reason === 'unsupported-all-chat'; }, undefined, 'unsupported All-chat snapshot');
      await waitFor(async () => (await page.locator('#danlingo-live-status').locator('#state').innerText()).includes('全部聊天读取尚未支持'), 'truthful unsupported All-chat status');
      const state = await page.locator('#danlingo-live-status').locator('#state').innerText();
      assert.ok(!state.includes('暂停'), 'Unsupported All chat must not be mislabeled as pause');
      return { state, screenshot: await screenshot('fixture-unsupported-all-chat') };
    });
    await check('navigation-away-removes-live-ui', async () => {
      await page.locator('#home').click();
      await untilPage(() => location.pathname === '/' && !document.getElementById('danlingo-live-overlay') && !document.getElementById('danlingo-live-status'), undefined, 'old live overlay and status removed');
      await delay(1200);
      assert.equal(await page.locator('#danlingo-live-overlay').count(), 0); assert.equal(await page.locator('#danlingo-live-status').count(), 0);
      return { path: '/', overlayRemoved: true, statusRemoved: true, screenshot: await screenshot('fixture-navigation-away') };
    });
    report.fixture = { chatRequests: fixture.requests, evidence: await evidence() };
    assert.equal(report.errors.length, 0); report.status = 'PASS_FIXTURE_LOCAL_MOCK';
  } else {
    report.phase = 'real-page-observation';
    report.real = { requestedUrl: realUrl, maxSecondsPerPhase: observeSeconds, phases: {}, nativeControls: {},
      observationScope: { requested: observationScope, focused: focusedScope, lifecycleRequested: lifecycle,
        ...(lifecycleAction ? { classification: 'TARGETED_LIFECYCLE_ACTION_ONLY', lifecycleAction,
          notCovered: ['other lifecycle actions', 'chat visibility/fullscreen transitions', 'reconnect', 'second-room navigation', '90-second continuous-playback acceptance'] } : {}),
        requiredPhases: lifecycleAction ? [lifecycleAction === 'off-on' ? 'targeted-reenabled' : 'targeted-native-resume']
          : focusedScope ? [observationScope === 'chat-closed' ? 'native-chat-closed' : 'fullscreen-chat-closed']
          : ['visible-chat', 'native-chat-closed', 'fullscreen-chat-closed'],
        ...(focusedScope ? { notCovered: ['other observation scopes', 'disable/reenable', 'pause/resume', 'reload/reconnect', 'second-room navigation'],
          phaseEvidence: 'fresh receipt cohort and rendered outcomes from the complete selected-state fixed window' } : {}) } };
    await page.goto(realUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }); await page.bringToFront();
    await page.locator('#movie_player video').first().waitFor({ state: 'attached', timeout: 30000 });
    const initialPlayback = await realPlaybackState();
    if (initialPlayback.paused) {
      await page.locator('#movie_player video').first().evaluate(video => Promise.race([video.play(), new Promise((_, reject) => setTimeout(() => reject(new Error('Native playback did not start')), 10000))]));
      report.real.playMethod = 'explicit HTMLVideoElement.play; no readiness override, pause or seek';
    } else report.real.playMethod = 'site playback';
    await waitFor(async () => {
      const p = await realPlaybackState(); report.real.playbackReadiness = p;
      return !p.paused && !p.seeking && p.readyState >= 2 && !p.errorCode && !p.visibleError && !p.ad
        && (typeof p.native?.isAtLiveHead?.value === 'boolean' || Number.isFinite(p.liveDistance));
    }, 'actual playable stream and seekable range before live-point check', 45000);
    const beforeLivePoint = await realPlaybackState();
    report.real.livePoint = { before: beforeLivePoint, beforeEvidence: liveHeadEvidence(beforeLivePoint), action: 'none' };
    if (!liveHeadEvidence(beforeLivePoint).atLiveEdge) {
      await page.locator('#movie_player').hover();
      await nativeButton('go-live');
      report.real.livePoint.action = 'clicked observed native go-live button; no direct currentTime assignment';
      await waitFor(async () => { const p = await realPlaybackState(); report.real.livePoint.after = p; return !p.seeking && p.readyState >= 2; }, 'native go-live action settled', 15000);
    } else report.real.livePoint.after = beforeLivePoint;
    const livePointPlayback = await realPlaybackState();
    // Pause is a production intake gate. Establish real advancing playback before
    // waiting for the reader's connected state; never fabricate readyState or time.
    await waitFor(async () => { const p = await realPlaybackState(); report.real.playbackReadiness = p; report.real.livePoint.after = p; report.real.livePoint.afterEvidence = liveHeadEvidence(p); return healthyPlayback(p) && p.time > livePointPlayback.time + 1; }, 'advancing live video without ad/error/pause/DVR', 45000);
    await untilPage(() => window.__DL_LIVE_EVIDENCE__?.snapshots.at(-1)?.connection === 'connected', undefined, 'real production MAIN reader connected', 45000);
    report.real.finalUrl = page.url();
    report.real.metricsPosition = lifecycleAction ? 'immediately-after-targeted-lifecycle-action'
      : focusedScope ? 'selected-state-window-with-recorded-fresh-phase' : metricsPosition;
    if (lifecycleAction) {
      await runTargetedLifecycleAction();
    } else if (focusedScope) {
      await enterFocusedScope();
      const recordedWindow = await fixedMetricsWindow({ requiredScope: observationScope });
      const phaseName = report.real.observationScope.requiredPhases[0];
      await realPhase(phaseName, { marker: recordedWindow.startAt, recordedWindow });
      report.checks['focused-window-fresh-chain'] = { status: 'passed', requestedScope: observationScope,
        phase: phaseName, marker: recordedWindow.startAt, receiptEndAt: recordedWindow.endAt, observedUntil: recordedWindow.observedUntil,
        lifecycleCovered: false, performanceTarget: report.real.fixedWindow.summary.target.status };
      assert.ok(report.real.fixedWindow.summary.captureComplete && report.real.fixedWindow.summary.window.fixedWindowComplete,
        'A focused scope requires the complete fixed receipt window and deadline drain with intact evidence');
    } else {
      if (metricsSeconds && metricsPosition === 'before-phases') await fixedMetricsWindow();
      await realPhase('visible-chat');
      await nativeButton('close-chat');
      report.real.nativeChatAfterClose = await waitFor(async () => { const state = await nativeChatHidden(); return state.hidden ? state : false; }, 'native chat closed by its own control', 10000);
      await realPhase('native-chat-closed');
      await page.locator('#movie_player').hover();
      await nativeButton('fullscreen');
      await untilPage(() => !!document.fullscreenElement && document.fullscreenElement.contains(document.getElementById('danlingo-live-overlay')), undefined, 'native fullscreen contains actual overlay', 10000);
      await realPhase('fullscreen-chat-closed');
      await page.evaluate(() => document.exitFullscreen());
      if (metricsSeconds && metricsPosition === 'after-phases') await fixedMetricsWindow();
      if (lifecycle) await runLifecycle();
    }
    report.real.observationScope.passedPhases = Object.values(report.real.phases).filter(value => value.status === 'passed').map(value => value.name);
    report.real.providerCalls = (await rpc({ type: 'overview' })).engine?.providerCalls;
    if (report.real.fixedWindow?.coverage.healthyThroughout === false) {
      report.status = 'INCOMPLETE_REAL_OBSERVATION'; process.exitCode = 1;
      report.errors.push('The full fixed window was captured, but actual live playback became unhealthy; the observed receipt-cohort ratio is not continuous-playback acceptance');
    } else if (lifecycleAction) {
      const target = report.real.fixedWindow.summary.target.status;
      report.status = realProvider && target !== 'MET'
        ? `INCOMPLETE_TARGETED_LIFECYCLE_ACTION_ONLY_PERFORMANCE_${target}`
        : `PASS_REAL_PAGE_${realProvider ? 'REAL_PROVIDER' : 'LOCAL_MOCK'}_TARGETED_LIFECYCLE_ACTION_ONLY_${lifecycleAction.replaceAll('-', '_').toUpperCase()}`;
      if (realProvider && target !== 'MET') process.exitCode = 1;
    } else report.status = focusedScope
      ? `PASS_REAL_PAGE_${realProvider ? 'REAL_PROVIDER' : 'LOCAL_MOCK'}_${observationScope.replaceAll('-', '_').toUpperCase()}_OBSERVED_SCOPE`
      : realProvider ? 'PASS_REAL_PAGE_REAL_PROVIDER_OBSERVED_SCOPE' : 'PASS_REAL_PAGE_LOCAL_MOCK_OBSERVED_SCOPE';
  }
} catch (error) {
  report.status = realOnly ? 'INCOMPLETE_REAL_OBSERVATION' : 'FAIL_FIXTURE';
  report.errors.push(redact(error.stack || error).slice(0, 3500)); process.exitCode = 1;
  if (page) {
    if (!realOnly) report.fixtureAtFailure = await evidence().catch(() => null);
    else {
      report.real ||= {};
      report.real.playbackAtFailure = await realPlaybackState().catch(() => null);
      report.real.snapshotsAtFailure = await page.evaluate(() => window.__DL_LIVE_EVIDENCE__?.snapshots.slice(-12)).catch(() => null);
      const observed = await evidence().catch(() => null);
      if (observed) {
        report.real.evidenceAtFailurePath = resolve(runDir, 'failure-evidence.json');
        await writeFile(report.real.evidenceAtFailurePath, JSON.stringify(observed, null, 2));
      }
    }
    report.failureScreenshot = await screenshot('failure').catch(() => null);
  } else if (options) {
    report.optionsAtFailure = await options.evaluate(() => ({ readyState: document.readyState, model: document.getElementById('model')?.value,
      profile: document.getElementById('profile')?.value, result: document.getElementById('result')?.textContent, keyState: document.getElementById('key-state')?.textContent })).catch(() => null);
    const path = resolve(runDir, 'options-failure.png');
    await options.screenshot({ path, fullPage: true, mask: [options.locator('#api-key')] }).then(() => { report.failureScreenshot = path; }).catch(() => {});
  }
} finally {
  releaseHeld();
  if (rpc) {
    await rpc({ type: 'toggle', enabled: false }).catch(() => {});
    const deleted = await rpc({ type: 'delete-key' }).catch(() => null);
    report.testKeyDeleted = deleted?.ok === true && deleted.hasKey === false;
  }
  await context?.close().catch(() => {});
  await Promise.allSettled(budgetTasks);
  if (mock) { mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)); }
  if (realProvider && report.requestBudget?.limitReachedAt) {
    report.status = 'INCOMPLETE_REAL_PROVIDER_REQUEST_BUDGET'; process.exitCode = 1;
  }
  if (realProvider && report.testKeyDeleted !== true) {
    report.status = 'INCOMPLETE_CREDENTIAL_CLEANUP'; process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString(); await persist();
}
console.log(JSON.stringify({ report: resolve(runDir, 'report.json'), status: report.status, phase: report.phase, checks: Object.keys(report.checks), errors: report.errors }, null, 2));
