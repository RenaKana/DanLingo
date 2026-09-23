import { browserExecutablePath, browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// One 90-second anonymous Edge control, without loading DanLingo or any test extension.
// node scripts/verify-youtube-media-control.mjs [--headless]
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node scripts/verify-youtube-media-control.mjs [--headless]'); process.exit(0);
}
assert.ok(args.every(arg => arg === '--headless'), 'Only optional --headless is supported');
const url = 'https://www.youtube.com/watch?v=4xDzrJKXOOY';
const seconds = 90;
const root = resolve('.artifacts/live/media-control'); await mkdir(root, { recursive: true });
const runDir = await mkdtemp(resolve(root, 'edge-'));
const report = { capturedAt: new Date().toISOString(), runDir, requestedUrl: url, seconds,
  browser: 'edge', headless: args.includes('--headless'), status: 'RUNNING', samples: [], cdn: [],
  actions: [], screenshots: [], errors: [], cdnOverflow: 0, limitations: [
    'A single anonymous no-extension control can establish recurrence in this run; it cannot establish a root cause or rule out extension involvement in other runs.',
    'The control does not repeat extension toggles, chat-panel changes or fullscreen actions from the extension runs.',
    'Media properties are read without modification. Playback can start only through an observed native Play button.',
    'CDN evidence contains origin, HTTP status or failure code, and time only; request URLs, queries, headers, cookies and payloads are never saved.',
  ] };
const persist = () => writeFile(resolve(runDir, 'report.json'), JSON.stringify(report, null, 2));
const delay = ms => new Promise(done => setTimeout(done, ms));
let context, page;
function sanitizedError(error) {
  return String(error?.message || error).split('\n')[0].replace(/https?:\/\/[^\s)]+/g, value => {
    try { return new URL(value).origin; } catch { return '[url]'; }
  }).slice(0, 400);
}
function cdnOrigin(value) {
  try { const parsed = new URL(value); return parsed.hostname === 'googlevideo.com' || parsed.hostname.endsWith('.googlevideo.com') ? parsed.origin : null; }
  catch { return null; }
}
function recordCdn(row) { if (report.cdn.length < 2000) report.cdn.push(row); else report.cdnOverflow++; }
async function snapshot() {
  return page.evaluate(() => {
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
    if (video) for (let index = 0; index < Math.min(video.seekable.length, 5); index++) seekable.push({ start: video.seekable.start(index), end: video.seekable.end(index) });
    const details = window.ytInitialPlayerResponse?.videoDetails;
    return { at: performance.timeOrigin + performance.now(), playerPresent: !!player, videoPresent: !!video,
      currentTime: video && Number.isFinite(video.currentTime) ? video.currentTime : null,
      paused: video?.paused ?? null, seeking: video?.seeking ?? null, ended: video?.ended ?? null,
      readyState: video?.readyState ?? null, errorCode: video?.error?.code ?? null, networkState: video?.networkState ?? null,
      visibleError: visible, nativeErrorText: visible ? (error.textContent || '').trim().slice(0, 500) : null,
      ad: !!player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')),
      native, seekable, hidden: document.hidden,
      currentRoom: typeof details?.videoId === 'string' ? details.videoId : null,
      isLiveContent: details?.isLiveContent ?? null,
      extensionUiPresent: !!document.querySelector('#danlingo-live-overlay,#danlingo-live-status,#danlingo-progress') };
  });
}
async function clickObservedPlay() {
  const candidates = await page.evaluate(() => [...document.querySelectorAll('#movie_player button')].flatMap((button, index) => {
    const box = button.getBoundingClientRect(), style = getComputedStyle(button);
    if (!box.width || !box.height || style.visibility === 'hidden' || style.display === 'none' || button.disabled) return [];
    const aria = button.getAttribute('aria-label') || '', title = button.getAttribute('title') || '', text = (button.innerText || '').trim().slice(0, 80);
    return /^(play|再生|播放)(\s|$|[（(])/i.test(aria || title || text) ? [{ index, aria, title, text }] : [];
  }));
  if (!candidates.length) return false;
  const candidate = candidates[0], button = page.locator('#movie_player button').nth(candidate.index);
  assert.equal(await button.getAttribute('aria-label') || '', candidate.aria, 'Native button identity must stay stable');
  await button.click({ timeout: 4000 });
  report.actions.push({ at: Date.now(), type: 'native-play-button', observed: candidate });
  return true;
}
async function shot(name) {
  const path = resolve(runDir, name + '.png'); await page.screenshot({ path }); report.screenshots.push(path);
}

try {

  const { chromium } = await loadPlaywright();
  const browserOptions = browserLaunchOptions('edge');
  const executablePath = browserOptions.executablePath ?? browserExecutablePath('edge');
  const profile = resolve(runDir, 'profile'); report.profile = profile; report.executablePath = executablePath;
  context = await chromium.launchPersistentContext(profile, { ...browserOptions, headless: report.headless,
    viewport: { width: 1440, height: 1000 }, locale: 'ja-JP', args: ['--disable-extensions'] });
  report.browserVersion = context.browser()?.version() || null;
  context.on('response', response => {
    const origin = cdnOrigin(response.url()); if (origin) recordCdn({ at: Date.now(), origin, event: 'response', status: response.status() });
  });
  context.on('requestfailed', request => {
    const origin = cdnOrigin(request.url()); if (!origin) return;
    const code = request.failure()?.errorText || '';
    recordCdn({ at: Date.now(), origin, event: 'failure', failure: /^net::[A-Z0-9_]+$/.test(code) ? code : 'request-failed' });
  });
  page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); await page.bringToFront();
  report.startedAt = Date.now(); report.endsAt = report.startedAt + seconds * 1000;
  report.extensionWorkersAtStart = context.serviceWorkers().filter(worker => worker.url().startsWith('chrome-extension:')).length;
  let previous, everAdvanced = false, lastPlayAttempt = 0, playingScreenshot = false;
  console.log('START: 90-second no-extension Edge control');
  for (let index = 0; index <= seconds; index++) {
    await delay(Math.max(0, report.startedAt + index * 1000 - Date.now()));
    const sample = await snapshot(); sample.elapsedMs = sample.at - report.startedAt;
    sample.timeAdvance = previous && sample.currentTime !== null && previous.currentTime !== null ? sample.currentTime - previous.currentTime : null;
    if (sample.timeAdvance > 0.2 && sample.paused === false && sample.readyState >= 2 && !sample.ad && !sample.visibleError && !sample.errorCode) {
      everAdvanced = true;
      if (!report.firstAdvancingSample) report.firstAdvancingSample = sample;
    }
    report.samples.push(sample);
    if ((sample.visibleError || sample.errorCode) && !report.firstMediaError) {
      report.firstMediaError = sample; await shot('first-native-media-error');
    }
    if (everAdvanced && !playingScreenshot) { playingScreenshot = true; await shot('playing-without-extension'); }
    if (!everAdvanced && !sample.visibleError && !sample.errorCode && sample.paused === true
      && index < 30 && Date.now() - lastPlayAttempt >= 4000) {
      lastPlayAttempt = Date.now(); await clickObservedPlay();
    }
    if (index % 15 === 0) {
      console.log(`SAMPLE ${index}s: time=${sample.currentTime} paused=${sample.paused} readyState=${sample.readyState} nativeError=${sample.visibleError} mediaError=${sample.errorCode}`);
      await persist();
    }
    previous = sample;
  }
  report.completedAt = Date.now(); report.completedWindow = report.completedAt >= report.endsAt && report.samples.length === 91;
  report.extensionWorkersAtEnd = context.serviceWorkers().filter(worker => worker.url().startsWith('chrome-extension:')).length;
  assert.equal(report.extensionWorkersAtStart, 0); assert.equal(report.extensionWorkersAtEnd, 0);
  assert.ok(report.samples.every(sample => !sample.extensionUiPresent), 'No DanLingo UI must be present');
  report.advancingSamples = report.samples.filter(sample => sample.timeAdvance > 0.2 && sample.paused === false && sample.readyState >= 2 && !sample.ad && !sample.visibleError && !sample.errorCode).length;
  report.status = !everAdvanced ? 'INCOMPLETE_NO_ADVANCING_PLAYBACK'
    : report.firstMediaError ? 'OBSERVED_MEDIA_ERROR_WITHOUT_EXTENSION' : 'NO_MEDIA_ERROR_OBSERVED_IN_90_SECONDS';
  await shot('final-90-seconds');
  if (!everAdvanced) process.exitCode = 1;
} catch (error) {
  report.status = 'INCOMPLETE_CONTROL'; report.errors.push(sanitizedError(error)); process.exitCode = 1;
  if (page) await shot('control-incomplete').catch(() => {});
} finally {
  await context?.close().catch(() => {}); await persist();
  console.log('RESULT: ' + report.status); console.log('Report: ' + resolve(runDir, 'report.json'));
}
