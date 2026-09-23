import { browserExecutablePath, browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// One anonymous, no-extension/no-Provider run; no existing profiles or reports are read.
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bufferEvidence, normalProgress, mediaProjection, mediaMessageProjection, mediaOmissionKinds, cdnResponseProjection, smallCdnBodyProjection, umpBodyProjection, UMP_REFERENCE, youtubeAppProjection } from './youtube-media-diagnostics.mjs';

const usage = 'node scripts/diagnose-youtube-media.mjs --url https://www.youtube.com/watch?v=VIDEO_ID_11 [--browser edge|chromium] [--launch playwright|minimal-CDP]';
const cli = process.argv.slice(2);
if (cli.length === 1 && cli[0] === '--help') { console.log(usage); process.exit(0); }
let url, browserName = 'edge', launchMode = 'playwright';
const seenArgs = new Set();
for (let i = 0; i < cli.length; i += 2) {
  if (!['--url', '--browser', '--launch'].includes(cli[i]) || seenArgs.has(cli[i]) || !cli[i + 1]) {
    console.error('Invalid arguments. ' + usage); process.exit(1);
  }
  seenArgs.add(cli[i]);
  if (cli[i] === '--url') url = cli[i + 1]; else if (cli[i] === '--browser') browserName = cli[i + 1]; else launchMode = cli[i + 1];
}
const room = /^https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})$/.exec(url || '')?.[1];
if (!room || !['edge', 'chromium'].includes(browserName) || !['playwright', 'minimal-CDP'].includes(launchMode) || process.platform !== 'win32') {
  console.error('Requires Windows, edge|chromium, and an exact HTTPS www.youtube.com/watch?v=11-character-ID URL without extra parameters.'); process.exit(1);
}

const runStart = performance.now(), runEpoch = Date.now();
const now = () => performance.now() - runStart;
const limits = { totalMs: 165000, workMs: 149000, launchMs: 20000, navigationMs: 30000,
  startupAfterNavigationMs: 30000, windowMs: 90000, intervalMs: 250,
  samples: 650, boundarySamples: 64, smallUmpReads: 128, pageEvents: 2000, media: 4000, cdn: 2000, activeRequests: 1000, players: 64 };
let runDir, reportPath, context, page, browserSession, pageSession, ownedPid, stopped = false;
let directChild, directBrowser;
let cleanupPromise;
const ownedIdentities = new Map();
let contextClosed = false, pageClock, playerCounter = 0, requestCounter = 0, playAttempted = false;
const players = new Map(), requests = new Map(), extensionTargets = new Set();
const bodyReads = new Set();
const boundaryReads = new Set();
let bodyReadCount = 0;
const report = { capturedAt: new Date(runEpoch).toISOString(), requestedOrigin: 'https://www.youtube.com', requestedRoom: room,
  browser: browserName, launchMode, umpReference: UMP_REFERENCE, headless: false, status: 'RUNNING', phase: 'setup', limits,
  samples: [], startupSamples: [], boundarySamples: [], pageEvents: [], media: [], cdn: [], actions: [], errors: [], clocks: [],
  overflow: { samples: 0, boundarySamples: 0, startupSamples: 0, pageEvents: 0, media: 0, cdn: 0, activeRequests: 0, players: 0, extensionTargets: 0 },
  coverage: { mediaEnabled: false, networkEnabled: false, targetDiscovery: false, pageProbeReads: 0,
    mediaCreated: 0, mediaEvents: 0, mediaProperties: 0, mediaErrors: 0, mediaMessages: 0, omittedMediaFields: 0,
    invalidMediaEvents: 0, retainedMediaEvents: 0, retainedMediaProperties: 0, pageEventOverflow: 0,
    smallNonUmpSkipped: 0, smallUmpBudgetSkipped: 0, smallUmpReadUnavailable: 0,
    mediaMessagesWithoutSafeCode: 0, mediaMessageLevels: { info: 0, debug: 0, warning: 0, error: 0, other: 0 },
    mediaOmittedKinds: { string: 0, number: 0, boolean: 0, object: 0, other: 0 } },
  isolation: { extensionWorkersAtStart: null, extensionWorkersAtEnd: null, maxExtensionWorkers: 0,
    extensionWorkerSeen: false, extensionTargetsSeen: false, extensionUiSeen: false },
  timing: { epochAtRunStartMs: runEpoch, unit: 'milliseconds',
    origin: 'Node monotonic time at diagnostic start. CDN/Media runMs is receipt time; mediaTimestampSeconds is a separate engine clock.',
    pageClock: 'Page performance.now is mapped to Node runMs using the first probe round-trip midpoint per document; clocks record uncertainty.',
    windowStartRule: 'Third healthy sample after TWO consecutive normal 250ms progress intervals in the same video and document. Initial positioning jumps do not count.',
    changeFromOldControls: 'The fixed 90 seconds begins at confirmed advancing playback, not navigation. Startup samples are separate; failures never restart or extend the window.' },
  limitations: [
    'A single anonymous control establishes only observations in this run, not a root cause.',
    'CDP Network and Media cover the main page target only; iframe/worker media may be absent. Missing Media coverage is explicit.',
    'HTTP 200 and completed bytes do not establish useful media delivery, successful append, decoding or healthy playback.',
    'Only containing continuous buffered ranges count as buffer ahead; seekable ranges are not buffered media.',
    'totalVideoFrames and webkitDecodedFrameCount retain their API names; counters alone do not establish decoded frame presentation.',
    'Media strings are strictly projected through known keys and enum values; unknown fields are counted and discarded.',
    'No request headers, bodies, full URLs, query strings, cookies, arbitrary Media text or native error text are saved.',
    'At most 128 completed UMP responses of <=4096 encoded bytes are inspected in memory, with at most four concurrent reads; other MIME types cannot consume this budget. Only format, hash, numeric parts/lengths/completeness and SabrError.code are retained.',
    'UMP schema comes from a pinned public third-party implementation, not an official YouTube contract; its numeric error code has no inferred meaning.',
    'Both arms are instrumented anonymous environments. minimal-CDP is not ordinary manual browsing; no webdriver property or browser security setting is spoofed.',
    'No Provider is configured or invoked. The browser receives a small OS environment allowlist and a fresh profile.',
  ] };
class Failure extends Error { constructor(code) { super(code); this.safeCode = code; } }
function check() { if (stopped || now() >= limits.workMs) throw new Failure('work-deadline'); }
async function bounded(promise, ms, code) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Failure(code)), Math.max(1, ms)); })]); }
  finally { clearTimeout(timer); }
}
async function step(promise, ms, code) {
  check();
  try {
    const result = await bounded(promise, Math.min(ms, limits.workMs - now()), code); check(); return result;
  } catch (error) {
    if (error instanceof Failure) throw error;
    // Keep the operation label even when Playwright rejects before our outer timeout.
    // Do not copy message, stack, cause or arbitrary attached browser data.
    const wrapped = new Failure(code);
    wrapped.name = ['Error', 'TimeoutError', 'AssertionError', 'TypeError'].includes(error?.name) ? error.name : 'Error';
    if (['ENOENT', 'EACCES', 'EPERM', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(error?.code)) wrapped.code = error.code;
    throw wrapped;
  }
}
const delay = ms => new Promise(done => setTimeout(done, Math.max(0, ms)));
function record(kind, row) {
  if (stopped) return;
  const cap = limits[kind] || limits.samples;
  if (report[kind].length < cap) report[kind].push(row); else report.overflow[kind]++;
}
function failure(error) {
  // Never persist browser/Playwright error messages: even their first line can contain a signed URL.
  return { phase: report.phase, runMs: now(), code: error instanceof Failure ? error.safeCode : 'operation-failed',
    kind: ['Error', 'TimeoutError', 'AssertionError', 'TypeError'].includes(error?.name) ? error.name : 'unclassified',
    systemCode: ['ENOENT', 'EACCES', 'EPERM', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(error?.code) ? error.code : null };
}
async function persist() { if (reportPath) await bounded(writeFile(reportPath, JSON.stringify(report, null, 2)), 2000, 'report-write-timeout'); }
const hardTimer = setTimeout(async () => {
  stopped = true; report.status = 'INCOMPLETE_HARD_DEADLINE'; report.finishedAt = new Date().toISOString();
  report.elapsedMs = now();
  try { await bounded(cleanup(), 8500, 'hard-cleanup-timeout'); } catch {}
  if (reportPath) try { writeFileSync(reportPath, JSON.stringify(report, null, 2)); } catch {}
  console.error('INCOMPLETE_HARD_DEADLINE'); process.exit(1);
}, limits.totalMs - 10000);

function pageProbe(bufferEvidence, youtubeAppProjection, requestedRoom, eventCap) {
  if (window !== window.top) return;
  const generations = new WeakMap(); let nextGeneration = 0, eventCount = 0, overflow = 0;
  const observedPlayers = new WeakSet();
  let applicationErrorCount = 0, unknownApplicationErrors = 0, lastApplicationErrorCode = null;
  let events = [];
  const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  function capture(eventVideo) {
    const player = document.getElementById('movie_player');
    if (player && !observedPlayers.has(player)) {
      observedPlayers.add(player);
      try { player.addEventListener('onError', event => {
        applicationErrorCount++;
        const code = typeof event === 'number' ? event : event?.data;
        // Documented YouTube IFrame onError numeric codes only.
        if ([2, 5, 100, 101, 150, 153].includes(code)) lastApplicationErrorCode = code;
        else unknownApplicationErrors++;
      }); } catch { /* Availability is recorded separately below. */ }
    }
    const activeVideo = player?.querySelector('video');
    const video = eventVideo || activeVideo;
    if (video && !generations.has(video)) generations.set(video, ++nextGeneration);
    const error = player?.querySelector('.ytp-error');
    const visibleError = !!error && error.getClientRects().length > 0
      && getComputedStyle(error).visibility !== 'hidden' && getComputedStyle(error).display !== 'none';
    const ranges = []; let rangesUnavailable = !video, truncatedRanges = 0;
    if (video) try {
      const buffered = video.buffered; truncatedRanges = Math.max(0, buffered.length - 32);
      for (let i = 0; i < Math.min(buffered.length, 32); i++) ranges.push({ start: buffered.start(i), end: buffered.end(i) });
    } catch { rangesUnavailable = true; }
    const currentTime = finite(video?.currentTime);
    let quality; try { quality = video?.getVideoPlaybackQuality?.(); } catch {}
    let nativeState = null, atLiveHead = null;
    try { const state = player?.getPlayerState?.(); if ([-1, 0, 1, 2, 3, 5].includes(state)) nativeState = state; } catch {}
    try { const state = player?.isAtLiveHead?.(); if (typeof state === 'boolean') atLiveHead = state; } catch {}
    const details = window.ytInitialPlayerResponse?.videoDetails;
    let playerResponse = null, videoData = null;
    try { playerResponse = player?.getPlayerResponse?.() || null; } catch {}
    try { videoData = player?.getVideoData?.() || null; } catch {}
    const safeLanguage = value => ['ja-JP', 'ja', 'en-US', 'en', 'zh-CN', 'zh', 'en-GB'].includes(value) ? value : 'other';
    let intlLocale = null; try { intlLocale = safeLanguage(Intl.DateTimeFormat().resolvedOptions().locale); } catch {}
    const uaData = navigator.userAgentData;
    return { pageMs: performance.now(), pageTimeOriginEpochMs: performance.timeOrigin,
      automation: { webdriver: typeof navigator.webdriver === 'boolean' ? navigator.webdriver : null,
        language: safeLanguage(navigator.language), languages: Array.from(navigator.languages || []).slice(0, 8).map(safeLanguage), intlLocale,
        uaCH: { available: !!uaData, mobile: typeof uaData?.mobile === 'boolean' ? uaData.mobile : null,
          platform: ['Windows', 'macOS', 'Linux', 'Android', 'Chrome OS', 'iOS'].includes(uaData?.platform) ? uaData.platform : 'unavailable-or-other',
          brands: Array.from(uaData?.brands || []).slice(0, 8).map(item => ({
            brand: ['Chromium', 'Microsoft Edge', 'Google Chrome'].includes(item.brand) ? item.brand : 'other-brand',
            version: /^\d{1,4}(?:\.\d{1,5}){0,3}$/.test(item.version || '') ? item.version : null })) },
        visibility: document.visibilityState === 'visible' ? 'visible' : 'hidden',
        innerWidth, innerHeight, devicePixelRatio },
      youtube: { current: youtubeAppProjection(playerResponse, videoData, requestedRoom),
        initial: youtubeAppProjection(window.ytInitialPlayerResponse, null, requestedRoom),
        applicationErrorCount, unknownApplicationErrors, lastApplicationErrorCode },
      playerPresent: !!player, videoPresent: !!video, videoGeneration: video ? generations.get(video) : null,
      eventVideoIsActive: eventVideo ? eventVideo === activeVideo : null,
      currentTime, paused: video?.paused ?? null, seeking: video?.seeking ?? null, ended: video?.ended ?? null,
      readyState: video?.readyState ?? null, networkState: video?.networkState ?? null,
      playbackRate: finite(video?.playbackRate), errorCode: video?.error?.code ?? null,
      visibleError, nativeState, atLiveHead, hidden: document.hidden,
      ad: !!player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')),
      roomMatches: details?.videoId === requestedRoom, isLiveContent: typeof details?.isLiveContent === 'boolean' ? details.isLiveContent : null,
      extensionUiPresent: !!document.querySelector('#danlingo-live-overlay,#danlingo-live-status,#danlingo-progress'),
      buffered: ranges, truncatedRanges, ...bufferEvidence(rangesUnavailable || truncatedRanges ? null : ranges, currentTime),
      totalVideoFrames: finite(quality?.totalVideoFrames), droppedVideoFrames: finite(quality?.droppedVideoFrames),
      corruptedVideoFrames: finite(quality?.corruptedVideoFrames), webkitDecodedFrameCount: finite(video?.webkitDecodedFrameCount),
      webkitDroppedFrameCount: finite(video?.webkitDroppedFrameCount) };
  }
  for (const type of ['waiting', 'stalled', 'error', 'emptied', 'playing', 'ended', 'abort']) {
    document.addEventListener(type, event => {
      if (!(event.target instanceof HTMLVideoElement)) return;
      if (eventCount >= eventCap) { overflow++; return; }
      eventCount++; events.push({ type, ...capture(event.target) });
    }, true);
  }
  Object.defineProperty(window, '__dlAnonymousMediaProbe', { value: { read() {
    const sample = capture(); const drained = events; events = [];
    return { sample, events: drained, eventOverflow: overflow };
  } }, configurable: false });
}

function cdnOrigin(value) {
  try { const parsed = new URL(value); return parsed.protocol === 'https:' && (parsed.hostname === 'googlevideo.com'
    || parsed.hostname.endsWith('.googlevideo.com')) ? parsed.origin : null; } catch { return null; }
}
function playerId(raw) {
  if (typeof raw !== 'string' || raw.length > 256) return null;
  if (!players.has(raw)) {
    if (players.size >= limits.players) { report.overflow.players++; return null; }
    players.set(raw, ++playerCounter);
  }
  return players.get(raw);
}
function extensionTarget(info) {
  if (typeof info?.url !== 'string' || !info.url.startsWith('chrome-extension:')) return;
  report.isolation.extensionTargetsSeen = true;
  if (extensionTargets.size < 200) extensionTargets.add(info.targetId); else report.overflow.extensionTargets++;
}
function workerCount() {
  const count = context.serviceWorkers().filter(worker => worker.url().startsWith('chrome-extension:')).length;
  report.isolation.maxExtensionWorkers = Math.max(report.isolation.maxExtensionWorkers, count); return count;
}
async function ownedProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const shell = resolve(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const command = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if($p){ [pscustomobject]@{pid=$p.ProcessId; executable=$p.ExecutablePath; created=$p.CreationDate.ToUniversalTime().ToString('o'); commandLine=$p.CommandLine} | ConvertTo-Json -Compress }`;
  const result = await promisify(execFile)(shell, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 2500, maxBuffer: 32768 });
  if (!result.stdout.trim()) return null;
  const row = JSON.parse(result.stdout);
  const args = typeof row.commandLine === 'string' ? row.commandLine.match(/(?:[^\s"]+|"[^"]*")+/g)?.map(arg => arg.replaceAll('"', '')) || [] : [];
  const expectedExecutable = report.launch.executablePath.replaceAll('\\', '/').toLowerCase();
  const matches = String(row.executable || '').replaceAll('\\', '/').toLowerCase() === expectedExecutable
    && args.includes(`--user-data-dir=${report.profile}`);
  return { ...row, args, matches };
}
function safeLaunchArguments(args) {
  return args.slice(1).map(arg => {
    if (arg === `--user-data-dir=${report.profile}`) return '--user-data-dir=<owned-profile>';
    if (arg === 'about:blank') return arg;
    const split = arg.indexOf('='), name = split < 0 ? arg : arg.slice(0, split);
    if (!/^--[A-Za-z0-9-]+$/.test(name)) return '<unrecognized-argument>';
    if (split < 0) return name;
    const value = arg.slice(split + 1);
    return !/(?:auth|token|cookie|password|key)/i.test(name) && /^[A-Za-z0-9,._:/=+\-]*$/.test(value) && !/https?:\/\//i.test(value)
      ? arg : name + '=<redacted>';
  });
}
async function installDiagnostics() {
  browserSession = await step(context.browser().newBrowserCDPSession(), 3000, 'browser-session-timeout');
  const processInfo = await step(browserSession.send('SystemInfo.getProcessInfo'), 3000, 'owned-pid-timeout');
  const pid = processInfo.processInfo.find(info => info.type === 'browser')?.id;
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) throw new Failure('owned-browser-pid-unavailable');
  ownedPid = pid; report.ownedBrowserPid = pid;
  // This reads only the PID identified by our owned browser CDP session, before any navigation.
  try {
    const identity = await step(ownedProcess(pid), 3000, 'owned-command-line-timeout');
    if (!identity?.matches) throw new Failure('owned-command-line-validation');
    ownedIdentities.set(pid, { created: identity.created, executable: identity.executable });
    report.launch.actualArguments = safeLaunchArguments(identity.args);
    report.launch.actualCommandLineSha256 = createHash('sha256').update(identity.commandLine).digest('hex');
    report.launch.actualCommandLineSource = 'Win32_Process owned CDP PID before navigation; owned profile substituted, unrecognized values redacted';
    if (directChild?.pid && directChild.pid !== pid) {
      const spawned = await step(ownedProcess(directChild.pid), 3000, 'spawned-identity-timeout');
      if (spawned && !spawned.matches) throw new Failure('spawned-identity-mismatch');
      if (spawned) ownedIdentities.set(directChild.pid, { created: spawned.created, executable: spawned.executable });
    }
    report.launch.ownedProcessIdentities = [...ownedIdentities.entries()].map(([processId, value]) => ({ pid: processId, ...value }));
  } catch (error) { report.launch.actualCommandLineUnavailable = true; report.errors.push(failure(error)); }
  browserSession.on('Target.targetCreated', event => extensionTarget(event.targetInfo));
  browserSession.on('Target.targetInfoChanged', event => extensionTarget(event.targetInfo));
  await step(browserSession.send('Target.setDiscoverTargets', { discover: true }), 3000, 'target-discovery-timeout');
  report.coverage.targetDiscovery = true;
  const initialTargets = await step(browserSession.send('Target.getTargets'), 3000, 'target-inventory-timeout');
  initialTargets.targetInfos.forEach(extensionTarget);
  context.on('serviceworker', worker => {
    if (worker.url().startsWith('chrome-extension:')) report.isolation.extensionWorkerSeen = true;
  });
  pageSession = await step(context.newCDPSession(page), 3000, 'page-session-timeout');
  pageSession.on('Network.requestWillBeSent', event => {
    const origin = cdnOrigin(event.request.url);
    if (!origin) { requests.delete(event.requestId); return; }
    if (!requests.has(event.requestId) && requests.size >= limits.activeRequests) { report.overflow.activeRequests++; return; }
    requests.set(event.requestId, { id: ++requestCounter, origin, startedRunMs: now(), status: null });
  });
  pageSession.on('Network.responseReceived', event => {
    const row = requests.get(event.requestId); if (!row || cdnOrigin(event.response.url) !== row.origin) return;
    row.status = Number.isInteger(event.response.status) ? event.response.status : null;
    row.response = cdnResponseProjection(event.response);
    record('cdn', { runMs: now(), id: row.id, origin: row.origin, event: 'response', status: row.status, ...row.response });
  });
  pageSession.on('Network.loadingFinished', event => {
    const row = requests.get(event.requestId); if (!row) return;
    record('cdn', { runMs: now(), ...row, event: 'completed', bytes: Number.isFinite(event.encodedDataLength) ? event.encodedDataLength : null });
    requests.delete(event.requestId);
    const small = event.encodedDataLength >= 0 && event.encodedDataLength <= 4096;
    if (small && row.response?.mime !== 'application/vnd.yt-ump') report.coverage.smallNonUmpSkipped++;
    if (small && row.response?.mime === 'application/vnd.yt-ump' && (bodyReadCount >= limits.smallUmpReads || bodyReads.size >= 4)) report.coverage.smallUmpBudgetSkipped++;
    if (!stopped && small && row.response?.mime === 'application/vnd.yt-ump' && bodyReadCount < limits.smallUmpReads && bodyReads.size < 4) {
      bodyReadCount++;
      const pending = bounded(pageSession.send('Network.getResponseBody', { requestId: event.requestId }), 1500, 'body-read-timeout')
        .then(result => {
          // Network buffering is capped below; reject oversized strings before decoding.
          const bytes = typeof result.body === 'string' && result.body.length <= 8192 ? Buffer.from(result.body, result.base64Encoded ? 'base64' : 'utf8') : null;
          const projection = !bytes || bytes.length > 4096 ? { kind: 'not-inspected-size-limit' }
            : { ...smallCdnBodyProjection(bytes), sha256: createHash('sha256').update(bytes).digest('hex'), ump: umpBodyProjection(bytes) };
          record('cdn', { runMs: now(), id: row.id, event: 'small-body-classification', ...projection });
          captureBoundary('small-ump-response', row.id);
        }).catch(() => { report.coverage.smallUmpReadUnavailable++; record('cdn', { runMs: now(), id: row.id, event: 'small-body-classification', kind: 'unavailable' }); })
        .finally(() => bodyReads.delete(pending));
      bodyReads.add(pending);
    }
  });
  pageSession.on('Network.loadingFailed', event => {
    const row = requests.get(event.requestId); if (!row) return;
    const known = ['net::ERR_ABORTED', 'net::ERR_FAILED', 'net::ERR_TIMED_OUT', 'net::ERR_CONNECTION_CLOSED',
      'net::ERR_CONNECTION_RESET', 'net::ERR_CONNECTION_REFUSED', 'net::ERR_CONNECTION_TIMED_OUT',
      'net::ERR_NAME_NOT_RESOLVED', 'net::ERR_NETWORK_CHANGED', 'net::ERR_INTERNET_DISCONNECTED',
      'net::ERR_HTTP2_PROTOCOL_ERROR', 'net::ERR_QUIC_PROTOCOL_ERROR', 'net::ERR_BLOCKED_BY_CLIENT'];
    record('cdn', { runMs: now(), ...row, event: 'failed', code: known.includes(event.errorText) ? event.errorText : 'unclassified-network-failure', canceled: !!event.canceled });
    requests.delete(event.requestId);
  });
  pageSession.on('Media.playersCreated', event => {
    report.coverage.mediaCreated += event.players?.length || 0;
    for (const raw of event.players || []) record('media', { runMs: now(), event: 'created', player: playerId(raw) });
  });
  pageSession.on('Media.playerEventsAdded', event => {
    const player = playerId(event.playerId);
    for (const item of event.events || []) {
      report.coverage.mediaEvents++;
      if (typeof item.value !== 'string' || item.value.length > 8192) { report.coverage.invalidMediaEvents++; continue; }
      let parsed; try { parsed = JSON.parse(item.value); } catch { report.coverage.invalidMediaEvents++; continue; }
      const projected = mediaProjection(parsed); report.coverage.omittedMediaFields += projected.omitted;
      const omitted = mediaOmissionKinds(parsed);
      for (const kind of Object.keys(omitted)) report.coverage.mediaOmittedKinds[kind] += omitted[kind];
      if (Object.keys(projected.values).length) report.coverage.retainedMediaEvents++;
      record('media', { runMs: now(), event: 'event', player, mediaTimestampSeconds: Number.isFinite(item.timestamp) ? item.timestamp : null,
        values: projected.values, omittedFields: projected.omitted });
      if (projected.values.event === 'kWebMediaPlayerDestroyed' || projected.values.pipeline_state === 'kStopping') captureBoundary('media-stopping-or-destroyed', player);
    }
  });
  pageSession.on('Media.playerPropertiesChanged', event => {
    const player = playerId(event.playerId);
    for (const property of event.properties || []) {
      report.coverage.mediaProperties++;
      const projected = mediaProjection({ [property.name]: property.value }); report.coverage.omittedMediaFields += projected.omitted;
      const omitted = mediaOmissionKinds({ [property.name]: property.value });
      for (const kind of Object.keys(omitted)) report.coverage.mediaOmittedKinds[kind] += omitted[kind];
      if (Object.keys(projected.values).length) {
        report.coverage.retainedMediaProperties++;
        record('media', { runMs: now(), event: 'property', player, values: projected.values });
      }
    }
  });
  pageSession.on('Media.playerErrorsRaised', event => {
    const player = playerId(event.playerId);
    for (const error of event.errors || []) {
      report.coverage.mediaErrors++;
      record('media', { runMs: now(), event: 'error', player, code: Number.isFinite(error.code) ? error.code : null,
        errorType: ['PipelineStatus', 'DecoderStatus', 'EncoderStatus', 'DemuxerStatus', 'MediaError'].includes(error.errorType) ? error.errorType : 'unclassified' });
    }
  });
  pageSession.on('Media.playerMessagesLogged', event => {
    const player = playerId(event.playerId);
    for (const message of event.messages || []) {
      report.coverage.mediaMessages++;
      const projected = mediaMessageProjection(message.level, message.message);
      report.coverage.mediaMessageLevels[projected.level]++;
      if (projected.codeUnavailable) report.coverage.mediaMessagesWithoutSafeCode++;
      record('media', { runMs: now(), event: 'message', player, ...projected });
    }
  });
  await step(pageSession.send('Network.enable', { maxTotalBufferSize: 262144, maxResourceBufferSize: 65536 }), 3000, 'network-enable-timeout'); report.coverage.networkEnabled = true;
  try { await step(pageSession.send('Media.enable'), 3000, 'media-enable-timeout'); report.coverage.mediaEnabled = true; }
  catch (error) { report.errors.push(failure(error)); }
  await step(context.addInitScript({ content: `(${pageProbe.toString()})(${bufferEvidence.toString()}, ${youtubeAppProjection.toString()}, ${JSON.stringify(room)}, ${limits.pageEvents});` }), 3000, 'probe-install-timeout');
}

function captureBoundary(reason, id) {
  if (stopped || !['startup', 'observation'].includes(report.phase) || report.boundarySamples.length + boundaryReads.size >= limits.boundarySamples) return;
  const pending = snapshot().then(sample => record('boundarySamples', { reason, id, ...sample }))
    .catch(() => record('boundarySamples', { reason, id, unavailable: true, runMs: now() }))
    .finally(() => boundaryReads.delete(pending));
  boundaryReads.add(pending);
}

async function snapshot(deadline = limits.workMs) {
  const before = now();
  if (before >= deadline) throw new Failure('sample-deadline');
  const raw = await step(page.evaluate(() => window.__dlAnonymousMediaProbe?.read() || null), Math.min(1500, deadline - before), 'sample-timeout');
  const after = now(); if (!raw?.sample) throw new Failure('page-probe-unavailable');
  report.coverage.pageProbeReads++;
  if (!pageClock || pageClock.pageTimeOriginEpochMs !== raw.sample.pageTimeOriginEpochMs) {
    pageClock = { documentSequence: report.clocks.length + 1, pageTimeOriginEpochMs: raw.sample.pageTimeOriginEpochMs,
      pageToRunOffsetMs: (before + after) / 2 - raw.sample.pageMs, estimatedUncertaintyMs: (after - before) / 2 };
    report.clocks.push(pageClock);
  }
  const convert = item => ({ ...item, documentSequence: pageClock.documentSequence,
    runMs: item.pageMs + pageClock.pageToRunOffsetMs, receivedRunMs: after });
  for (const event of raw.events || []) record('pageEvents', convert(event));
  report.coverage.pageEventOverflow = Math.max(report.coverage.pageEventOverflow, raw.eventOverflow || 0);
  const sample = convert(raw.sample); sample.extensionWorkers = workerCount();
  report.isolation.extensionUiSeen ||= sample.extensionUiPresent;
  return sample;
}
async function playOnce(deadline) {
  if (playAttempted || now() >= deadline) return null;
  playAttempted = true;
  const action = { runMs: now(), type: 'one-initial-native-play-attempt', clickIssued: false, outcome: 'pending' };
  report.actions.push(action);
  try {
    const index = await step(page.evaluate(() => [...document.querySelectorAll('#movie_player button')].findIndex(button => {
      const box = button.getBoundingClientRect(), style = getComputedStyle(button);
      const label = button.getAttribute('aria-label') || button.getAttribute('title') || (button.innerText || '').trim();
      return !!box.width && !!box.height && style.visibility !== 'hidden' && style.display !== 'none' && !button.disabled
        && /^(play|再生|播放)(\s|$|[（(])/i.test(label);
    })), Math.min(1000, deadline - now()), 'native-play-observation-timeout');
    if (index < 0) { action.outcome = 'native-play-not-observed'; return null; }
    const button = page.locator('#movie_player button').nth(index);
    const stillPlay = await step(button.evaluate(node => /^(play|再生|播放)(\s|$|[（(])/i.test(
      node.getAttribute('aria-label') || node.getAttribute('title') || (node.innerText || '').trim())),
    Math.min(1000, deadline - now()), 'native-play-identity-timeout');
    if (!stillPlay || now() >= deadline) { action.outcome = 'skipped-native-state-changed-or-deadline'; return null; }
    action.clickIssued = true;
    await step(button.click({ timeout: Math.max(1, Math.min(1500, deadline - now())) }), Math.min(1700, deadline - now()), 'native-play-click-timeout');
    action.outcome = 'click-completed'; return null;
  } catch (error) {
    action.outcome = 'outcome-unknown'; action.error = failure(error);
    // Autoplay can replace the observed Play button while the optional click waits.
    // This is action uncertainty, not media failure. Never retry or move the startup deadline.
    if (now() >= deadline) return null;
    const after = await snapshot(deadline);
    after.reason = 'after-initial-play-outcome-unknown'; record('startupSamples', after);
    action.afterSampleIndex = report.startupSamples.length - 1;
    return after;
  } finally { action.finishedRunMs = now(); }
}
function isolationValid() {
  return report.coverage.targetDiscovery && report.isolation.extensionWorkersAtStart === 0
    && report.isolation.extensionWorkersAtEnd === 0 && report.isolation.maxExtensionWorkers === 0
    && !report.isolation.extensionWorkerSeen && !report.isolation.extensionTargetsSeen && !report.isolation.extensionUiSeen;
}
function summarize() {
  const rows = report.samples, first = rows[0], last = rows.at(-1);
  report.isolation.valid = isolationValid();
  report.coverage.mediaPlayerCount = players.size;
  report.coverage.missingMedia = [!report.coverage.mediaEnabled && 'domain-not-enabled',
    !report.coverage.mediaCreated && 'no-created-events',
    !players.size && 'no-player-identities',
    !report.coverage.mediaEvents && !report.coverage.mediaProperties && 'no-events-or-properties',
    !report.coverage.retainedMediaEvents && !report.coverage.retainedMediaProperties && 'no-allowlisted-events-or-properties-retained',
    report.overflow.media > 0 && 'media-record-overflow', report.overflow.players > 0 && 'player-map-overflow'].filter(Boolean);
  report.coverage.missingPage = [rows.some(row => !row.valid) && 'buffer-unavailable',
    rows.some(row => row.totalVideoFrames === null && row.webkitDecodedFrameCount === null) && 'frame-counters-unavailable',
    report.coverage.pageEventOverflow > 0 && 'page-event-overflow'].filter(Boolean);
  const gaps = rows.slice(1).map((row, i) => row.runMs - rows[i].runMs);
  const firstError = rows.find(row => row.visibleError || row.errorCode);
  const firstUnhealthy = rows.find(row => !row.videoPresent || row.paused || row.seeking || row.ended || row.readyState < 3
    || row.visibleError || row.errorCode || row.ad || !row.roomMatches);
  let firstStall = null, anchor = first;
  for (const row of rows.slice(1)) {
    if (row.runMs - anchor.runMs < 750) continue;
    if (row.documentSequence !== anchor.documentSequence || row.videoGeneration !== anchor.videoGeneration
      || row.currentTime === null || anchor.currentTime === null || row.currentTime - anchor.currentTime < 0.05) { firstStall = row; break; }
    anchor = row;
  }
  const span = first && last ? last.runMs - first.runMs : 0;
  report.observation = { completeWindow: !!report.window && span >= limits.windowMs && span <= limits.windowMs + 1500,
    sampledSpanMs: span, maxGapMs: gaps.length ? Math.max(...gaps) : null, sampleCount: rows.length,
    firstErrorRunMs: firstError?.runMs ?? null, firstUnhealthyRunMs: firstUnhealthy?.runMs ?? null,
    firstStallRunMs: firstStall?.runMs ?? null, zeroBufferSamples: rows.filter(row => row.valid && row.bufferAheadSeconds === 0).length,
    completedCdnRequests: report.cdn.filter(row => row.event === 'completed').length,
    completedCdnBytes: report.cdn.filter(row => row.event === 'completed').reduce((sum, row) => sum + (row.bytes || 0), 0),
    diagnosis: 'NOT_ASSIGNED: inspect the synchronized pre-failure buffer/frame/Media timeline; HTTP status is never used as playback health.' };
  if (!report.isolation.valid) report.status = 'INCOMPLETE_CONTROL_ISOLATION';
  else if (!report.window) report.status = 'INCOMPLETE_NO_CONFIRMED_ADVANCING_PLAYBACK';
  else if (!report.observation.completeWindow || (report.observation.maxGapMs || 0) > 1000) report.status = 'INCOMPLETE_OBSERVATION_COVERAGE';
  else if (firstError) report.status = 'OBSERVED_NATIVE_OR_MEDIA_ERROR_WITHOUT_EXTENSION';
  else if (firstStall || firstUnhealthy) report.status = 'OBSERVED_PLAYBACK_INTERRUPTION_WITHOUT_EXTENSION';
  else report.status = 'NO_PLAYBACK_INTERRUPTION_OBSERVED_IN_90_SECONDS';
  report.pendingCdn = [...requests.values()].map(row => ({ ...row, ageMs: now() - row.startedRunMs }));
}

async function run() {
  const root = resolve('.artifacts/live/goals/g4/media-diagnosis'); await mkdir(root, { recursive: true });
  runDir = await mkdtemp(resolve(root, browserName + '-' + launchMode + '-')); reportPath = resolve(runDir, 'report.json');
  report.runDir = runDir; await persist();
  report.sourceSha256 = {};
  for (const path of ['scripts/diagnose-youtube-media.mjs', 'scripts/youtube-media-diagnostics.mjs']) {
    report.sourceSha256[path] = createHash('sha256').update(await readFile(resolve(path))).digest('hex');
  }

  const { chromium } = await step(loadPlaywright(), 5000, 'playwright-import-timeout');
  const executablePath = browserExecutablePath(browserName, { playwrightBrowser: chromium });
  await step(access(executablePath), 2000, 'browser-executable-unavailable');
  const profile = await mkdtemp(resolve(runDir, 'anonymous-')); report.profile = profile;
  report.launch = { mode: launchMode, executablePath, freshProfileScope: runDir, profile,
    startedRunMs: now(), startedAt: new Date().toISOString(), locale: 'ja-JP', viewport: { width: 1440, height: 1000 },
    commandLineCapturePhase: 'owned process before navigation', ordinaryManualBrowser: false };
  const browserEnv = {};
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'PATH', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']) {
    if (process.env[name]) browserEnv[name] = process.env[name];
  }
  report.phase = 'launch';
  if (launchMode === 'playwright') {
    report.launch.explicitArguments = ['--disable-extensions', '--disable-component-extensions-with-background-pages', '--lang=ja-JP'];
    context = await step(chromium.launchPersistentContext(profile, { ...browserLaunchOptions(browserName, { executablePath }), headless: false, timeout: limits.launchMs,
      viewport: { width: 1440, height: 1000 }, locale: 'ja-JP', args: report.launch.explicitArguments, env: browserEnv }), limits.launchMs + 1000, 'launch-timeout');
  } else {
    const args = [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-component-extensions-with-background-pages', '--lang=ja-JP', 'about:blank'];
    report.launch.explicitArguments = args;
    directChild = spawn(executablePath, args, { windowsHide: true, stdio: 'ignore', env: browserEnv });
    let spawnFailed = false; directChild.once('error', () => { spawnFailed = true; });
    ownedPid = directChild.pid; report.launch.spawnedPid = ownedPid;
    const deadline = now() + limits.launchMs;
    let endpoint;
    while (now() < deadline && !spawnFailed && directChild.exitCode === null) {
      check();
      try {
        const lines = (await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
        const port = Number(lines[0]);
        if (Number.isInteger(port) && port > 0 && port < 65536 && /^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(lines[1] || '')) {
          endpoint = `ws://127.0.0.1:${port}${lines[1]}`; break;
        }
      } catch { /* Only this freshly created profile's DevTools file is inspected. */ }
      await delay(100);
    }
    if (!endpoint) throw new Failure('minimal-cdp-startup-unavailable');
    directBrowser = await step(chromium.connectOverCDP(endpoint, { timeout: 5000 }), 5500, 'minimal-cdp-connect-timeout');
    context = directBrowser.contexts()[0];
    if (!context) throw new Failure('minimal-cdp-context-unavailable');
  }
  context.setDefaultTimeout(1500);
  const version = context.browser()?.version(); report.browserVersion = /^\d+(?:\.\d+){1,4}$/.test(version || '') ? version : null;
  page = context.pages()[0] || await step(context.newPage(), 3000, 'new-page-timeout');
  report.phase = 'diagnostics'; await installDiagnostics();
  if (report.launch.actualCommandLineUnavailable) throw new Failure('launch-evidence-unavailable');
  report.isolation.extensionWorkersAtStart = workerCount();
  if (report.isolation.extensionWorkersAtStart || report.isolation.extensionTargetsSeen) throw new Failure('extension-present-before-navigation');
  // Apply the same observable locale and viewport instrumentation to both anonymous arms.
  await step(page.setViewportSize(report.launch.viewport), 2000, 'viewport-timeout');
  if (launchMode === 'minimal-CDP') await step(pageSession.send('Emulation.setLocaleOverride', { locale: 'ja-JP' }), 2000, 'locale-timeout');
  report.launch.intlLocaleSource = launchMode === 'playwright' ? 'Playwright context locale' : 'CDP Emulation locale';
  report.launch.diagnosticUserAgentOverride = false;
  report.launch.languageComparability = 'Record actual navigator.language/languages, Intl locale and low-entropy UA-CH per arm. Playwright context locale behavior is part of that arm; no extra UA/header override is added by this diagnostic.';
  report.launch.readyRunMs = now(); report.launch.readyAt = new Date().toISOString();
  report.phase = 'navigation';
  await step(page.goto(url, { waitUntil: 'domcontentloaded', timeout: limits.navigationMs }), limits.navigationMs + 500, 'navigation-timeout');
  await step(page.bringToFront(), 1500, 'foreground-timeout');
  report.isolation.extensionWorkersAtStart = workerCount();
  report.phase = 'startup'; report.startup = { startRunMs: now(), timeoutMs: limits.startupAfterNavigationMs };
  const startupEnd = now() + limits.startupAfterNavigationMs;
  let previous, advancingIntervals = 0;
  while (now() < startupEnd) {
    const sample = await snapshot(startupEnd); sample.normalProgress = normalProgress(previous, sample);
    record('startupSamples', sample);
    advancingIntervals = sample.normalProgress ? advancingIntervals + 1 : 0;
    if (advancingIntervals >= 2) {
      report.window = { startRunMs: sample.runMs, endRunMs: sample.runMs + limits.windowMs,
        anchorStartupIndex: report.startupSamples.length - 1, confirmedAdvancingIntervals: advancingIntervals };
      record('samples', sample); break;
    }
    let afterPlay = null;
    if (!playAttempted && sample.paused === true && !sample.visibleError && !sample.errorCode && !sample.ad) afterPlay = await playOnce(startupEnd);
    if (afterPlay) advancingIntervals = 0;
    previous = afterPlay || sample; await delay(Math.min(limits.intervalMs, Math.max(0, startupEnd - now()))); check();
  }
  report.startup.endRunMs = now();
  if (report.window) {
    report.phase = 'observation'; console.log('START: fixed 90 seconds from two confirmed advancing intervals; no extensions/Provider');
    let index = 1;
    while (true) {
      const target = Math.min(report.window.endRunMs, report.window.startRunMs + index * limits.intervalMs);
      await delay(Math.max(0, target - now())); check();
      const sample = await snapshot(); sample.normalProgress = normalProgress(report.samples.at(-1), sample);
      record('samples', sample);
      if (sample.runMs >= report.window.endRunMs) break;
      index = Math.max(index + 1, Math.floor((now() - report.window.startRunMs) / limits.intervalMs) + 1);
      if (index % 60 === 0) { console.log(`OBSERVING: ${Math.floor((sample.runMs - report.window.startRunMs) / 1000)}s`); await persist(); }
    }
    report.window.observedEndRunMs = report.samples.at(-1).runMs;
  }
  report.isolation.extensionWorkersAtEnd = workerCount();
  const finalTargets = await step(browserSession.send('Target.getTargets'), 2000, 'final-target-inventory-timeout');
  finalTargets.targetInfos.forEach(extensionTarget);
  await bounded(Promise.allSettled([...bodyReads]), 2000, 'body-drain-timeout');
  await bounded(Promise.allSettled([...boundaryReads]), 2000, 'boundary-drain-timeout');
  report.coverage.smallBodyReads = bodyReadCount;
  summarize(); report.phase = 'completed';
}
function pidAlive(pid) { if (!Number.isInteger(pid)) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
function cleanup() { return cleanupPromise ||= cleanupOwned(); }
async function cleanupOwned() {
  stopped = true; report.cleanup = { contextCloseAttempted: !!context, forcedOwnedPids: [], identityChecks: [], complete: false };
  report.cleanup.startedRunMs = now(); report.cleanup.startedAt = new Date().toISOString();
  if (directBrowser && browserSession) try { await bounded(browserSession.send('Browser.close'), 2000, 'direct-browser-close-timeout'); } catch {}
  if (context) try { await bounded(context.close(), 4000, 'context-close-timeout'); contextClosed = true; } catch (error) { report.errors.push(failure(error)); }
  const tracked = [...new Set([ownedPid, directChild?.pid].filter(Number.isInteger))];
  for (const targetPid of tracked) {
    if (!pidAlive(targetPid)) continue;
    let identity;
    try { identity = await ownedProcess(targetPid); } catch { report.cleanup.identityChecks.push({ pid: targetPid, result: 'unavailable-not-terminated' }); continue; }
    const original = ownedIdentities.get(targetPid);
    if (!identity) continue;
    if (!identity.matches || original && original.created !== identity.created) {
      report.cleanup.identityChecks.push({ pid: targetPid, result: 'mismatch-not-terminated' }); continue;
    }
    report.cleanup.identityChecks.push({ pid: targetPid, result: 'owned-executable-profile-and-creation-matched' });
    report.cleanup.forcedOwnedPids.push(targetPid);
    // Both possible roots came from this launch. Recheck executable/profile and creation before killing.
    const killer = spawn(resolve(process.env.SystemRoot || 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(targetPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    try { await bounded(new Promise((done, reject) => { killer.once('error', reject); killer.once('exit', done); }), 4000, 'owned-process-termination-timeout'); }
    catch (error) { report.errors.push(failure(error)); }
    finally { if (killer.exitCode === null) killer.kill(); }
  }
  report.cleanup.remainingTrackedPids = tracked.filter(pidAlive);
  report.cleanup.contextClosed = contextClosed;
  report.cleanup.complete = report.cleanup.remainingTrackedPids.length === 0 && (!context || contextClosed || tracked.length > 0);
  report.cleanup.completionMethod = report.cleanup.complete ? report.cleanup.forcedOwnedPids.length ? 'owned-process-termination' : 'graceful-owned-process-exit' : 'incomplete';
  if (directBrowser) try { await bounded(directBrowser.close(), 1000, 'direct-disconnect-timeout'); } catch {}
  report.cleanup.finishedRunMs = now(); report.cleanup.finishedAt = new Date().toISOString();
  if (!report.cleanup.complete) report.status = 'INCOMPLETE_CLEANUP';
}
try { await bounded(run(), limits.workMs, 'work-deadline'); }
catch (error) {
  report.errors.push(failure(error));
  // Preserve all failure samples. Never turn an interrupted window into a success summary.
  try { summarize(); } catch {}
  report.status = 'INCOMPLETE_DIAGNOSTIC';
} finally {
  try { await cleanup(); } catch (error) { report.errors.push(failure(error)); report.status = 'INCOMPLETE_CLEANUP'; }
  report.finishedAt = new Date().toISOString(); report.elapsedMs = now();
  if (report.status.startsWith('INCOMPLETE')) process.exitCode = 1;
  try { await persist(); } catch { console.error('Report persistence failed'); process.exitCode = 1; }
  clearTimeout(hardTimer);
  console.log('RESULT: ' + report.status); if (reportPath) console.log('Report: ' + reportPath);
  // A failed Playwright disconnect must not keep the diagnostic's Node process alive past its cap.
  process.exit(process.exitCode || 0);
}
