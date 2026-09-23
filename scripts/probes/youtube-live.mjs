import { browserLaunchOptions, loadPlaywright } from "../browser-runtime.mjs";
// REAL anonymous YouTube live L0. No extension/provider/mock/account/API key.
// Run: node scripts/probes/youtube-live.mjs [YouTube watch/live URLs...]
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { installYoutubeLiveProbe } from './youtube-live-session.mjs';

const root = resolve('.artifacts/live/l0/youtube');
await mkdir(root, { recursive: true });
const runDir = await mkdtemp(resolve(root, 'run-'));

const { chromium } = await loadPlaywright();
const urls = process.argv.slice(2);
if (!urls.length) urls.push('https://www.youtube.com/watch?v=rFZHOHl-L8A', 'https://www.youtube.com/watch?v=4xDzrJKXOOY');
for (const url of urls) {
  const parsed = new URL(url);
  if (parsed.origin !== 'https://www.youtube.com' || !/^\/(watch|@[^/]+\/live)$/.test(parsed.pathname)) throw new Error('Only YouTube watch/live URLs');
}
const report = { capturedAt: new Date().toISOString(), runDir, evidence: 'REAL anonymous YouTube website + same-origin live-chat requests; no translation or product acceptance', browserVersion: null, rooms: [], errors: [], limitations: [
  'The webpage private API is not a stable public contract. Only currently live non-replay sessions are accepted.',
  'Raw cookies, headers, API keys, context values and continuation values never enter artifacts.',
  'Chat deletions are only real-platform verified if naturally observed; this probe never posts or moderates messages.',
  'Native hidden-chat and fullscreen observations are per-room. No VOD/chat replay, exhaustive delivery or real Provider claim.',
] };
let browser;
const save = () => writeFile(resolve(runDir, 'report.json'), JSON.stringify(report, null, 2));
try {
  console.log(JSON.stringify({ phase: 'launch', runDir }));
  browser = await chromium.launch({ headless: true, ...browserLaunchOptions('chromium'), timeout: 30000 });
  report.browserVersion = browser.version();
  report.userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', userAgent: report.userAgent });
  for (const requestedUrl of urls) {
    const room = { requestedUrl, phases: [], nativeRequests: [], errors: [], checks: {} };
    report.rooms.push(room);
    const page = await context.newPage();
    const pending = new Set();
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin !== 'https://www.youtube.com' || url.pathname !== '/youtubei/v1/live_chat/get_live_chat') return;
      const operation = (async () => {
        const request = response.request();
        const posted = request.postDataBuffer();
        const compressed = posted?.[0] === 0x1f && posted?.[1] === 0x8b;
        let body = null;
        if (posted && posted.length < 1_000_000) {
          try { body = JSON.parse((compressed ? gunzipSync(posted, { maxOutputLength: 1_000_000 }) : posted).toString('utf8')); }
          catch { /* Body decoding is optional metadata; never include body or parsing errors in logs. */ }
        }
        const json = await response.json().catch(() => null);
        const renderer = json?.continuationContents?.liveChatContinuation;
        room.nativeRequests.push({ observedAt: new Date().toISOString(), phase: room.phase || 'load', path: url.pathname, method: request.method(), status: response.status(),
          queryKeys: [...url.searchParams.keys()], requestBodyEncoding: compressed ? 'gzip' : 'plain', requestKeys: Object.keys(body || {}), contextKeys: Object.keys(body?.context || {}),
          continuationLength: typeof body?.continuation === 'string' ? body.continuation.length : null,
          framePath: new URL(request.frame().url()).pathname, rendererKeys: Object.keys(renderer || {}),
          actionTypes: [...new Set((renderer?.actions || []).flatMap(Object.keys).filter(key => key !== 'clickTrackingParams'))],
          continuationTypes: (renderer?.continuations || []).flatMap(Object.keys),
        });
      })().catch(() => room.errors.push('Response metadata unavailable (details suppressed to avoid logging request/session data)'));
      pending.add(operation); void operation.finally(() => pending.delete(operation));
    });
    try {
      console.log(JSON.stringify({ phase: 'navigate', url: requestedUrl }));
      await page.goto(requestedUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForFunction(() => !!window.ytInitialPlayerResponse && !!window.ytInitialData, undefined, { timeout: 20000 });
      if (new URL(page.url()).pathname !== '/watch') {
        const videoId = await page.evaluate(() => window.ytInitialPlayerResponse?.videoDetails?.videoId);
        if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || '')) throw new Error('Live channel did not resolve to a video');
        await page.goto('https://www.youtube.com/watch?v=' + videoId, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForFunction(() => !!window.ytInitialPlayerResponse && !!window.ytInitialData, undefined, { timeout: 20000 });
      }
      room.page = await page.evaluate(() => ({ url: location.href, title: document.title, videoId: window.ytInitialPlayerResponse?.videoDetails?.videoId,
        isLive: window.ytInitialPlayerResponse?.videoDetails?.isLive, isLiveContent: window.ytInitialPlayerResponse?.videoDetails?.isLiveContent,
        playability: window.ytInitialPlayerResponse?.playabilityStatus?.status,
        liveBroadcastDetails: window.ytInitialPlayerResponse?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails }));
      room.initial = await page.evaluate(installYoutubeLiveProbe);
      room.nativeChatFrames = [];
      for (const frame of page.frames().filter(f => f.url().startsWith('https://www.youtube.com/live_chat'))) {
        room.nativeChatFrames.push(await frame.evaluate(() => {
          const pick = data => ({ keys: Object.keys(data || {}), continuationTypes: (data?.continuations || []).flatMap(Object.keys), headerKeys: Object.keys(data?.header || {}), actions: data?.actions?.length });
          return { initialKeys: Object.keys(window.ytInitialData || {}), initialContents: pick(window.ytInitialData?.contents?.liveChatRenderer), initialContinuation: pick(window.ytInitialData?.continuationContents?.liveChatContinuation), app: pick(document.querySelector('yt-live-chat-app')?.data), renderer: pick(document.querySelector('yt-live-chat-renderer')?.data) };
        }).catch(() => ({ unavailable: true })));
      }
      const pollPhase = async (name, requestCount) => {
        room.phase = name;
        await page.evaluate(name => window.__DANLINGO_YOUTUBE_L0__.phase(name), name);
        const start = Date.now();
        let completed = 0;
        while (completed < requestCount && Date.now() - start < 90000) {
          const step = await page.evaluate(() => window.__DANLINGO_YOUTUBE_L0__.poll());
          if (step.request) { completed++; console.log(JSON.stringify({ videoId: room.page.videoId, phase: name, status: step.request.status, items: step.request.items, emitted: step.request.emitted, waitMs: step.dueMs })); }
          if (completed < requestCount) await page.waitForTimeout(Math.max(20, step.deferredMs || step.dueMs || 1000));
        }
        room.probe = await page.evaluate(() => window.__DANLINGO_YOUTUBE_L0__.snapshot());
        const rows = room.probe.requests.filter(row => row.phase === name);
        room.phases.push({ name, completed, elapsedMs: Date.now() - start, responses: rows.filter(row => row.status === 200).length, emitted: rows.reduce((n, row) => n + (row.emitted || 0), 0), fullscreen: rows.some(row => row.fullscreen), nativeChatConnected: rows.some(row => row.nativeChatConnected) });
        await page.screenshot({ path: resolve(runDir, room.page.videoId + '-' + name + '.png') });
        await save();
      };
      await pollPhase('visible', 4);
      const hide = page.locator('ytd-live-chat-frame #show-hide-button button').first();
      room.hide = { nativeButtonPresent: await hide.count() > 0 };
      if (await hide.isVisible().catch(() => false)) {
        room.hide.buttonText = await hide.innerText();
        await hide.click();
        room.hide.method = 'native-show-hide-button';
      } else {
        await page.evaluate(() => { const frame = document.querySelector('ytd-live-chat-frame'); if (frame) frame.style.display = 'none'; });
        room.hide.method = 'CSS display none (native button unavailable)';
      }
      room.hide.after = await page.evaluate(() => ({ chatPresent: !!document.querySelector('ytd-live-chat-frame'), iframePresent: !!document.querySelector('ytd-live-chat-frame iframe'), chatDisplay: document.querySelector('ytd-live-chat-frame') ? getComputedStyle(document.querySelector('ytd-live-chat-frame')).display : null, collapsed: document.querySelector('ytd-live-chat-frame')?.hasAttribute('collapsed') }));
      await pollPhase('hidden-chat', 3);
      room.detached = await page.evaluate(() => { const nodes = [...document.querySelectorAll('ytd-live-chat-frame')]; for (const node of nodes) node.remove(); return { removed: nodes.length, remaining: document.querySelectorAll('ytd-live-chat-frame').length }; });
      await page.evaluate(async () => { const player = document.querySelector('#movie_player'); if (!player) throw new Error('No movie player fullscreen target'); await player.requestFullscreen(); });
      await pollPhase('fullscreen-detached-chat', 3);
      room.probe = await page.evaluate(() => window.__DANLINGO_YOUTUBE_L0__.snapshot());
      room.checks.baselineSuppressed = room.probe.baseline?.emitted === 0;
      room.checks.visibleNewMessages = room.phases.find(p => p.name === 'visible')?.emitted > 0;
      room.checks.hiddenNewMessages = room.phases.find(p => p.name === 'hidden-chat')?.emitted > 0;
      room.checks.fullscreenDetachedNewMessages = room.phases.find(p => p.name === 'fullscreen-detached-chat')?.emitted > 0 && room.detached.remaining === 0 && room.phases.find(p => p.name === 'fullscreen-detached-chat')?.fullscreen;
      const ids = room.probe.events.filter(e => e.op === 'add').map(e => e.id);
      room.checks.noDuplicateAdds = ids.length === new Set(ids).size;
      room.checks.noBaselineBackfill = !ids.some(id => room.probe.baseline.ids.includes(id));
      room.checks.realDeletionObserved = room.probe.events.some(e => e.op === 'remove' || e.op === 'remove-author');
      room.checks.nativeWebsiteRequestObserved = room.nativeRequests.some(r => r.framePath === '/live_chat' && r.status === 200);
      room.result = ['baselineSuppressed', 'visibleNewMessages', 'hiddenNewMessages', 'fullscreenDetachedNewMessages', 'noDuplicateAdds', 'noBaselineBackfill'].every(key => room.checks[key]) ? 'PASS_L0_SESSION_CONTINUITY' : 'INCOMPLETE';
      await page.evaluate(() => { window.__DANLINGO_YOUTUBE_L0__.stop(); if (document.fullscreenElement) return document.exitFullscreen(); });
    } catch (error) {
      room.errors.push(String(error.stack || error).slice(0, 1800));
      room.result = 'INCOMPLETE';
      room.probe = await page.evaluate(() => window.__DANLINGO_YOUTUBE_L0__?.snapshot()).catch(() => null);
      await page.screenshot({ path: resolve(runDir, 'room-' + report.rooms.length + '-failure.png') }).catch(() => {});
    } finally {
      await Promise.allSettled([...pending]);
      await page.close();
      await save();
    }
  }
} catch (error) { report.errors.push(String(error.stack || error).slice(0, 2000)); }
finally {
  await browser?.close();
  report.result = report.rooms.length >= 2 && report.rooms.every(room => room.result === 'PASS_L0_SESSION_CONTINUITY') ? 'PASS_TWO_REAL_LIVE_ROOMS' : 'INCOMPLETE';
  if (report.result === 'INCOMPLETE') process.exitCode = 1;
  await save();
}
console.log(JSON.stringify({ report: resolve(runDir, 'report.json'), result: report.result, rooms: report.rooms.map(room => ({ url: room.page?.url || room.requestedUrl, result: room.result, checks: room.checks, errors: room.errors })), errors: report.errors }, null, 2));
