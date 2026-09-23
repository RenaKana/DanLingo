import { browserExecutablePath, loadPlaywright } from "./browser-runtime.mjs";
// One bounded, anonymous, no-extension Edge control. Does not use Playwright launch defaults.
// Run: node scripts/verify-youtube-media-direct.mjs
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const cli = process.argv.slice(2);
if (cli.length === 1 && cli[0] === '--help') {
  console.log('node scripts/verify-youtube-media-direct.mjs — one 90-second headed Edge control');
  process.exit(0);
}
assert.equal(cli.length, 0, 'This fixed control accepts no arguments');
assert.equal(process.platform, 'win32', 'This control is for Windows Edge');
const room = '4xDzrJKXOOY', seconds = 90;
const url = `https://www.youtube.com/watch?v=${room}`;
const root = resolve('.artifacts/live/media-direct');
await mkdir(root, { recursive: true });
const runDir = await mkdtemp(resolve(root, 'edge-'));
const profile = await mkdtemp(resolve(runDir, 'profile-'));
const report = {
  capturedAt: new Date().toISOString(), runDir, profile, requestedOrigin: 'https://www.youtube.com', requestedRoom: room,
  browser: 'edge', headless: false, seconds, status: 'RUNNING', phase: 'setup', samples: [], cdn: [], media: [],
  actions: [], screenshots: [], errors: [], diagnostics: {}, overflow: { cdn: 0, media: 0, activeRequests: 0 },
  limits: { wholeRunMs: 165000, devToolsStartupMs: 20000, connectMs: 15000, navigationMs: 30000, recordLimit: 2000 },
  limitations: [
    'One direct-launch control tests the launch-configuration bundle; it does not identify an individual flag or establish a root cause.',
    'The browser uses a new anonymous profile and default UA, language and window; no personal profile, login, extension or Provider is used.',
    'CDP observes the main page target. Out-of-process iframe/worker targets are not attached, so their network or Media events may be absent.',
    'CDN records contain only origin, status, completion bytes, timing and failure enums; request queries, headers, cookies and bodies are not collected.',
    'Media diagnostics retain only error/warning codes. Arbitrary messages, stack paths and attached data are not retained.',
    'Media properties are not modified. Playback starts only through an observed native Play button.',
    'The 90-second window begins after navigation and is not extended to compensate for ads or media errors.',
  ],
};
const reportPath = resolve(runDir, 'report.json');
const delay = ms => new Promise(done => setTimeout(done, ms));
const persist = () => writeFile(reportPath, JSON.stringify(report, null, 2));
let child, browser, context, page, pageSession, browserSession, stopPromise, stopped = false, ownedBrowserPid;
const activeRequests = new Map();
let nextRequestId = 0;

async function bounded(promise, ms, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); })]); }
  finally { clearTimeout(timer); }
}
function sanitizedError(error) {
  return String(error?.message || error).split('\n')[0].replace(/(?:https?|wss?):\/\/[^\s)]+/g, value => {
    try { return new URL(value).origin; } catch { return '[url]'; }
  }).slice(0, 400);
}
function ensureRunning() { if (stopped) throw new Error('Control already stopped'); }
function contentPlayback(sample) {
  return !!sample && sample.currentRoom === room && sample.currentTime > 0 && !sample.paused && !sample.seeking
    && sample.readyState >= 2 && !sample.ad && !sample.visibleError && !sample.errorCode;
}
function extensionWorkerEvidence() {
  const workers = context.serviceWorkers().filter(worker => worker.url().startsWith('chrome-extension:'));
  return { count: workers.length, origins: [...new Set(workers.map(worker => {
    const parsed = new URL(worker.url());
    return `${parsed.protocol}//${parsed.host}`;
  }))] };
}
function record(kind, row) {
  if (stopped) return;
  if (report[kind].length < report.limits.recordLimit) report[kind].push(row);
  else report.overflow[kind]++;
}
function cdnOrigin(value) {
  try { const parsed = new URL(value); return parsed.hostname === 'googlevideo.com' || parsed.hostname.endsWith('.googlevideo.com') ? parsed.origin : null; }
  catch { return null; }
}
function enumCode(value) { return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_:.-]{0,100}$/.test(value) ? value : null; }
function warningCodes(message) {
  // Do not retain raw Media text: it can contain signed URLs or other attached data.
  return [...new Set(String(message || '').match(/\b(?:PIPELINE_ERROR_[A-Z0-9_]+|DEMUXER_ERROR_[A-Z0-9_]+|DECODER_ERROR_[A-Z0-9_]+|CHUNK_DEMUXER_ERROR_[A-Z0-9_]+|MEDIA_ERR_[A-Z0-9_]+|net::ERR_[A-Z0-9_]+)\b/g) || [])].slice(0, 20);
}
function trackRequest(requestId, origin) {
  let row = activeRequests.get(requestId);
  if (!row) {
    if (activeRequests.size >= report.limits.recordLimit) { report.overflow.activeRequests++; return null; }
    row = { id: ++nextRequestId, origin, startedAt: Date.now() };
    activeRequests.set(requestId, row);
  } else row.origin = origin;
  return row;
}
async function installDiagnostics() {
  pageSession = await bounded(context.newCDPSession(page), 5000, 'Page CDP session');
  pageSession.on('Network.requestWillBeSent', event => {
    const origin = cdnOrigin(event.request.url);
    if (origin) trackRequest(event.requestId, origin);
    else activeRequests.delete(event.requestId);
  });
  pageSession.on('Network.responseReceived', event => {
    const origin = cdnOrigin(event.response.url); if (!origin) return;
    const request = trackRequest(event.requestId, origin); if (!request) return;
    record('cdn', { at: Date.now(), id: request.id, origin, event: 'response', status: event.response.status,
      protocol: enumCode(event.response.protocol), fromDiskCache: !!event.response.fromDiskCache, fromServiceWorker: !!event.response.fromServiceWorker });
  });
  pageSession.on('Network.loadingFinished', event => {
    const request = activeRequests.get(event.requestId); if (!request) return;
    record('cdn', { at: Date.now(), id: request.id, origin: request.origin, event: 'loadingFinished',
      encodedDataLength: event.encodedDataLength, elapsedMs: Date.now() - request.startedAt });
    activeRequests.delete(event.requestId);
  });
  pageSession.on('Network.loadingFailed', event => {
    const request = activeRequests.get(event.requestId); if (!request) return;
    record('cdn', { at: Date.now(), id: request.id, origin: request.origin, event: 'loadingFailed',
      failure: /^net::[A-Z0-9_]+$/.test(event.errorText || '') ? event.errorText : 'request-failed',
      canceled: !!event.canceled, blockedReason: enumCode(event.blockedReason), elapsedMs: Date.now() - request.startedAt });
    activeRequests.delete(event.requestId);
  });
  pageSession.on('Media.playerErrorsRaised', event => {
    for (const error of event.errors || []) record('media', { at: Date.now(), event: 'playerError',
      code: Number.isFinite(error.code) ? error.code : null,
      errorType: ['PipelineStatus', 'DecoderStatus', 'EncoderStatus', 'DemuxerStatus', 'MediaError'].includes(error.errorType) ? error.errorType : 'unclassified' });
  });
  pageSession.on('Media.playerMessagesLogged', event => {
    for (const message of event.messages || []) {
      if (!['warning', 'error'].includes(message.level)) continue;
      const codes = warningCodes(message.message);
      record('media', { at: Date.now(), event: 'playerMessage', level: message.level, codes, codeUnavailable: codes.length === 0 });
    }
  });
  await bounded(pageSession.send('Network.enable'), 5000, 'Network.enable'); report.diagnostics.networkEnabled = true;
  try { await bounded(pageSession.send('Media.enable'), 5000, 'Media.enable'); report.diagnostics.mediaEnabled = true; }
  catch (error) { report.diagnostics.mediaEnabled = false; report.diagnostics.mediaUnavailable = sanitizedError(error); }
}
async function snapshot() {
  return bounded(page.evaluate(() => {
    const player = document.getElementById('movie_player'), video = player?.querySelector('video');
    const error = player?.querySelector('.ytp-error');
    const visible = !!error && error.getClientRects().length > 0 && getComputedStyle(error).visibility !== 'hidden' && getComputedStyle(error).display !== 'none';
    const native = {};
    for (const name of ['isAtLiveHead', 'getPlayerState', 'getCurrentTime', 'getDuration']) {
      const available = typeof player?.[name] === 'function'; let value = null, threw = false;
      if (available) try { const result = player[name](); if (typeof result === 'boolean' || typeof result === 'number' && Number.isFinite(result)) value = result; } catch { threw = true; }
      native[name] = { available, value, threw };
    }
    const seekable = [];
    if (video) for (let i = 0; i < Math.min(video.seekable.length, 5); i++) seekable.push({ start: video.seekable.start(i), end: video.seekable.end(i) });
    const details = window.ytInitialPlayerResponse?.videoDetails;
    const errorText = visible ? (error.textContent || '').trim().replace(/https?:\/\/[^\s)]+/g, value => { try { return new URL(value).origin; } catch { return '[url]'; } }).slice(0, 500) : null;
    return { at: performance.timeOrigin + performance.now(), playerPresent: !!player, videoPresent: !!video,
      currentTime: video && Number.isFinite(video.currentTime) ? video.currentTime : null,
      paused: video?.paused ?? null, seeking: video?.seeking ?? null, ended: video?.ended ?? null,
      readyState: video?.readyState ?? null, errorCode: video?.error?.code ?? null, networkState: video?.networkState ?? null,
      visibleError: visible, nativeErrorText: errorText,
      ad: !!player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')),
      native, seekable, hidden: document.hidden, currentRoom: typeof details?.videoId === 'string' ? details.videoId : null,
      isLiveContent: details?.isLiveContent ?? null,
      extensionUiPresent: !!document.querySelector('#danlingo-live-overlay,#danlingo-live-status,#danlingo-progress') };
  }), 4000, 'Media snapshot');
}
async function clickObservedPlay() {
  const candidates = await bounded(page.evaluate(() => [...document.querySelectorAll('#movie_player button')].flatMap((button, index) => {
    const box = button.getBoundingClientRect(), style = getComputedStyle(button);
    if (!box.width || !box.height || style.visibility === 'hidden' || style.display === 'none' || button.disabled) return [];
    const label = button.getAttribute('aria-label') || button.getAttribute('title') || (button.innerText || '').trim();
    return /^(play|再生|播放)(\s|$|[（(])/i.test(label) ? [{ index, label: label.slice(0, 100) }] : [];
  })), 4000, 'Native Play discovery');
  if (!candidates.length) return false;
  const candidate = candidates[0], button = page.locator('#movie_player button').nth(candidate.index);
  const label = await button.evaluate(node => (node.getAttribute('aria-label') || node.getAttribute('title') || (node.innerText || '').trim()).slice(0, 100));
  assert.equal(label, candidate.label, 'Native Play identity must stay stable');
  await button.click({ timeout: 4000 });
  report.actions.push({ at: Date.now(), type: 'native-play-button', label: candidate.label });
  return true;
}
async function shot(name) {
  const path = resolve(runDir, name + '.png');
  await page.screenshot({ path, timeout: 4000 }); report.screenshots.push(path);
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function killOwnedPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) return;
  const killer = spawn(resolve(process.env.SystemRoot || 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  try { await bounded(new Promise((done, reject) => { killer.once('error', reject); killer.once('exit', code => done(code)); }), 5000, 'Owned process termination'); }
  finally { if (killer.exitCode === null) killer.kill(); }
}
async function stopOwnedBrowser() {
  if (stopPromise) return stopPromise;
  stopped = true;
  stopPromise = (async () => {
    report.cleanup = { browserCloseAttempted: !!browserSession, forcedPids: [] };
    // This session came only from DevToolsActivePort in our freshly created profile.
    if (browserSession) await bounded(browserSession.send('Browser.close'), 3000, 'Browser.close').catch(() => {});
    if (context) await bounded(context.close(), 3000, 'Context.close').catch(() => {});
    if (browser) await bounded(browser.close(), 3000, 'CDP disconnect').catch(() => {});
    if (child && child.exitCode === null) await delay(500);
    const pids = [...new Set([child?.exitCode === null ? child.pid : null, ownedBrowserPid].filter(Number.isInteger))];
    for (const pid of pids) if (pidAlive(pid)) {
      report.cleanup.forcedPids.push(pid);
      await killOwnedPid(pid).catch(error => report.errors.push('cleanup: ' + sanitizedError(error)));
    }
    report.cleanup.remainingOwnedPids = pids.filter(pidAlive);
    report.cleanup.childExitCode = child?.exitCode ?? null;
    report.cleanup.complete = report.cleanup.remainingOwnedPids.length === 0;
    if (!report.cleanup.complete) { report.status = 'INCOMPLETE_CLEANUP'; process.exitCode = 1; }
  })();
  return stopPromise;
}
async function run() {
  const executablePath = browserExecutablePath('edge');

  await access(executablePath);
  const { chromium } = await loadPlaywright();
  ensureRunning();
  const launchArgs = [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'];
  report.executablePath = executablePath;
  // Exact argv passed to spawn, with no page URL or user-controlled flags.
  report.launchArguments = launchArgs;
  const browserEnv = {};
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'PATH', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']) {
    if (process.env[name]) browserEnv[name] = process.env[name];
  }
  child = spawn(executablePath, launchArgs, { windowsHide: true, stdio: 'ignore', env: browserEnv });
  report.spawnedPid = child.pid;
  let spawnError;
  child.once('error', error => { spawnError = error; });
  report.phase = 'devtools-startup';
  const startupDeadline = Date.now() + report.limits.devToolsStartupMs;
  let wsEndpoint;
  while (Date.now() < startupDeadline) {
    ensureRunning();
    if (spawnError) throw spawnError;
    try {
      const lines = (await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
      const port = Number(lines[0]);
      if (Number.isInteger(port) && port > 0 && port < 65536 && /^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(lines[1] || '')) {
        wsEndpoint = `ws://127.0.0.1:${port}${lines[1]}`; break;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(200);
  }
  assert.ok(wsEndpoint, 'Our new profile did not produce DevToolsActivePort within 20 seconds');
  report.phase = 'cdp-attach';
  browser = await chromium.connectOverCDP(wsEndpoint, { timeout: report.limits.connectMs });
  ensureRunning();
  report.browserVersion = browser.version();
  browserSession = await bounded(browser.newBrowserCDPSession(), 5000, 'Browser CDP session');
  const processes = await bounded(browserSession.send('SystemInfo.getProcessInfo'), 5000, 'Owned browser PID');
  ownedBrowserPid = processes.processInfo.find(info => info.type === 'browser')?.id;
  assert.ok(Number.isInteger(ownedBrowserPid) && ownedBrowserPid > 0, 'Browser PID must come from our own CDP endpoint');
  report.browserPid = ownedBrowserPid;
  context = browser.contexts()[0]; assert.ok(context, 'Direct Edge default context must be present');
  context.setDefaultTimeout(4000);
  page = context.pages().find(candidate => candidate.url() === 'about:blank') || await bounded(context.newPage(), 5000, 'Observation page');
  report.navigator = await bounded(page.evaluate(() => ({ userAgent: navigator.userAgent, language: navigator.language, languages: navigator.languages, webdriver: navigator.webdriver })), 4000, 'Actual navigator settings');
  await installDiagnostics(); ensureRunning();
  report.phase = 'navigation';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: report.limits.navigationMs });
  await page.bringToFront(); ensureRunning();
  report.startedAt = Date.now(); report.endsAt = report.startedAt + seconds * 1000; report.phase = 'observation';
  const workersAtStart = extensionWorkerEvidence();
  report.extensionWorkersAtStart = workersAtStart.count;
  report.extensionWorkerOriginsAtStart = workersAtStart.origins;
  let previous, everAdvanced = false, lastPlayAttempt = 0, playingScreenshot = false;
  console.log('START: direct Edge, anonymous/no extension, 90-second observation');
  for (let index = 0; index <= seconds; index++) {
    await delay(Math.max(0, report.startedAt + index * 1000 - Date.now())); ensureRunning();
    const sample = await snapshot(); ensureRunning(); sample.elapsedMs = sample.at - report.startedAt;
    sample.timeAdvance = previous && sample.currentTime !== null && previous.currentTime !== null ? sample.currentTime - previous.currentTime : null;
    // A zero/unready -> live timestamp jump establishes position, not advancing content.
    sample.contentAdvanced = contentPlayback(previous) && contentPlayback(sample) && sample.timeAdvance > 0.2
      && sample.timeAdvance <= (sample.at - previous.at) / 1000 + 1;
    if (sample.contentAdvanced) {
      everAdvanced = true;
      if (!report.firstAdvancingSample) report.firstAdvancingSample = sample;
      report.lastAdvancingSample = sample;
    }
    report.samples.push(sample);
    if ((sample.visibleError || sample.errorCode) && !report.firstMediaError) { report.firstMediaError = sample; await shot('first-native-media-error'); }
    if (everAdvanced && !playingScreenshot) { playingScreenshot = true; await shot('playing-without-extension'); }
    if (!everAdvanced && !sample.visibleError && !sample.errorCode && sample.paused === true && index < 30 && Date.now() - lastPlayAttempt >= 4000) {
      lastPlayAttempt = Date.now(); await clickObservedPlay();
    }
    if (index % 15 === 0) {
      console.log(`SAMPLE ${index}s: time=${sample.currentTime} paused=${sample.paused} readyState=${sample.readyState} error=${sample.visibleError || !!sample.errorCode}`);
      await persist();
    }
    previous = sample;
  }
  report.completedAt = Date.now(); report.completedWindow = report.completedAt >= report.endsAt && report.samples.length === 91;
  const workersAtEnd = extensionWorkerEvidence();
  report.extensionWorkersAtEnd = workersAtEnd.count;
  report.extensionWorkerOriginsAtEnd = workersAtEnd.origins;
  // Preserve the complete observation even when an isolation assertion fails below.
  report.advancingSamples = report.samples.filter(sample => sample.contentAdvanced).length;
  report.pendingCdnAtWindowEnd = [...activeRequests.values()].map(row => ({ id: row.id, origin: row.origin, ageMs: Date.now() - row.startedAt }));
  report.phase = 'isolation-checks';
  assert.equal(report.extensionWorkersAtStart, 0, `Expected no extension workers at start; observed ${report.extensionWorkersAtStart}; see extensionWorkerOriginsAtStart`);
  assert.equal(report.extensionWorkersAtEnd, 0, `Expected no extension workers at end; observed ${report.extensionWorkersAtEnd}; see extensionWorkerOriginsAtEnd`);
  assert.ok(report.samples.every(sample => !sample.extensionUiPresent), 'No DanLingo UI must be present');
  report.status = !everAdvanced ? 'INCOMPLETE_NO_ADVANCING_PLAYBACK'
    : report.firstMediaError ? 'OBSERVED_MEDIA_ERROR_WITHOUT_EXTENSION' : 'NO_MEDIA_ERROR_OBSERVED_IN_90_SECONDS';
  report.phase = 'completed';
  await shot('final-90-seconds');
  if (!everAdvanced) process.exitCode = 1;
}

try { await bounded(run(), report.limits.wholeRunMs, 'Whole control'); }
catch (error) {
  stopped = true;
  report.status = 'INCOMPLETE_CONTROL'; report.errors.push(sanitizedError(error)); process.exitCode = 1;
  if (error?.code === 'ERR_ASSERTION') report.assertionFailure = {
    code: error.code, operator: enumCode(error.operator),
    actual: ['number', 'boolean'].includes(typeof error.actual) ? error.actual : null,
    expected: ['number', 'boolean'].includes(typeof error.expected) ? error.expected : null,
  };
  if (page) await shot('control-incomplete').catch(() => {});
} finally {
  await stopOwnedBrowser();
  report.finishedAt = new Date().toISOString(); await persist();
  console.log('RESULT: ' + report.status); console.log('Report: ' + reportPath);
}
