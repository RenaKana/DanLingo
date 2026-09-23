import { browserLaunchOptions, loadPlaywright } from "../browser-runtime.mjs";
// L0 real YouTube page discovery. Anonymous isolated browser; no provider, personal profile or API credentials.
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve('.artifacts/live/l0/youtube');
await mkdir(root, { recursive: true });
const runDir = await mkdtemp(resolve(root, 'discovery-'));

const { chromium } = await loadPlaywright();
const urls = process.argv.slice(2);
if (!urls.length) urls.push('https://www.youtube.com/watch?v=rFZHOHl-L8A', 'https://www.youtube.com/watch?v=jiua2V9q9V0');
for (const url of urls) {
  const parsed = new URL(url);
  if (parsed.origin !== 'https://www.youtube.com' || !/^\/(watch|@[^/]+\/(live|streams)|results)$/.test(parsed.pathname)) throw new Error('Only YouTube watch/live/streams/results discovery pages');
}
const report = { capturedAt: new Date().toISOString(), runDir, evidence: 'REAL anonymous YouTube website discovery', pages: [], errors: [] };
let browser;
try {
  browser = await chromium.launch({ headless: true, ...browserLaunchOptions('chromium') });
  report.browserVersion = browser.version();
  report.userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', userAgent: report.userAgent });
  for (const url of urls) {
    const row = { requestedUrl: url, requests: [], errors: [] };
    report.pages.push(row);
    const page = await context.newPage();
    page.on('response', response => {
      const u = new URL(response.url());
      if (u.hostname === 'www.youtube.com' && (u.pathname.includes('/live_chat') || u.pathname.includes('/get_live_chat'))) row.requests.push({ path: u.pathname, status: response.status(), method: response.request().method() });
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(error => row.errors.push(String(error.message).slice(0, 300)));
    await page.waitForFunction(() => !!window.ytInitialPlayerResponse || !!window.ytInitialData, undefined, { timeout: 20000 }).catch(() => row.errors.push('No initial YouTube data within 20s'));
    await page.waitForTimeout(9000);
    row.page = await page.evaluate(() => {
      const find = (value, key, depth = 0, out = []) => {
        if (!value || typeof value !== 'object' || depth > 22 || out.length >= 25) return out;
        if (value[key]) out.push(value[key]);
        for (const v of Object.values(value)) find(v, key, depth + 1, out);
        return out;
      };
      const live = find(window.ytInitialData, 'liveChatRenderer');
      const player = window.ytInitialPlayerResponse;
      return {
        url: location.href, title: document.title,
        player: player ? { videoId: player.videoDetails?.videoId, title: player.videoDetails?.title, isLive: player.videoDetails?.isLive, isLiveContent: player.videoDetails?.isLiveContent, status: player.playabilityStatus?.status, reason: player.playabilityStatus?.reason, liveBroadcastDetails: player.microformat?.playerMicroformatRenderer?.liveBroadcastDetails } : null,
        liveChat: live.map(v => ({ keys: Object.keys(v), isReplay: v.isReplay, continuationTypes: (v.continuations || []).flatMap(Object.keys), continuationLengths: (v.continuations || []).flatMap(v => Object.values(v).map(x => x.continuation?.length)), header: v.header, initialDisplayState: v.initialDisplayState })).map(v => ({ ...v, header: v.header ? { keys: Object.keys(v.header), titles: find(v.header, 'title').filter(v => typeof v === 'string' || v.simpleText).slice(0, 10), dropdown: find(v.header, 'sortFilterSubMenuRenderer').map(v => ({ title: v.title, subMenuItems: v.subMenuItems?.map(x => ({ title: x.title, selected: x.selected, continuationLength: x.continuation?.reloadContinuationData?.continuation?.length })) })) } : null })),
        config: { clientName: window.ytcfg?.get('INNERTUBE_CLIENT_NAME'), clientVersion: window.ytcfg?.get('INNERTUBE_CLIENT_VERSION'), contextKeys: Object.keys(window.ytcfg?.get('INNERTUBE_CONTEXT') || {}), apiKeyPresent: !!window.ytcfg?.get('INNERTUBE_API_KEY') },
        links: [...document.querySelectorAll('a[href^="/watch?v="]')].slice(0, 35).map(a => ({ title: (a.getAttribute('title') || a.textContent || '').trim().slice(0, 120), url: new URL(a.getAttribute('href'), location.origin).href.split('&')[0], context: a.closest('ytd-rich-item-renderer,ytd-video-renderer')?.innerText?.slice(0, 250) })),
        bodyStart: document.body.innerText.slice(0, 1000),
      };
    });
    row.frames = page.frames().map(f => { const u = new URL(f.url()); return u.origin + u.pathname; });
    for (const frame of page.frames().filter(f => f.url().startsWith('https://www.youtube.com/live_chat'))) {
      row.chatFrame = await frame.evaluate(() => ({ initialKeys: Object.keys(window.ytInitialData || {}), continuationKeys: Object.keys(window.ytInitialData?.continuationContents?.liveChatContinuation || {}), config: { clientName: window.ytcfg?.get('INNERTUBE_CLIENT_NAME'), clientVersion: window.ytcfg?.get('INNERTUBE_CLIENT_VERSION'), apiKeyPresent: !!window.ytcfg?.get('INNERTUBE_API_KEY') }, bodyStart: document.body.innerText.slice(0, 400) })).catch(error => ({ error: error.message }));
    }
    await page.screenshot({ path: resolve(runDir, `page-${report.pages.length}.png`) }).catch(() => {});
    console.log(JSON.stringify(row));
    await page.close();
    await writeFile(resolve(runDir, 'report.json'), JSON.stringify(report, null, 2));
  }
} catch (error) { report.errors.push(String(error.stack || error).slice(0, 1800)); process.exitCode = 1; }
finally { await browser?.close(); await writeFile(resolve(runDir, 'report.json'), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify({ report: resolve(runDir, 'report.json'), errors: report.errors }));
