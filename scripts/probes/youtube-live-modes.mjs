import { browserLaunchOptions, loadPlaywright } from "../browser-runtime.mjs";
// Focused real Top chat vs Live chat reload-continuation check. No API key/provider/login.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installYoutubeLiveProbe } from './youtube-live-session.mjs';
const root = resolve('.artifacts/live/l0/youtube');
await mkdir(root, { recursive: true });
const runDir = await mkdtemp(resolve(root, 'modes-'));
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true, ...browserLaunchOptions("chromium") });
const context = await browser.newContext({ locale: 'en-US', userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36` });
const page = await context.newPage();
const report = { capturedAt: new Date().toISOString(), evidence: 'REAL anonymous same-origin current watch session; separate top/all reload baselines', url: 'https://www.youtube.com/watch?v=rFZHOHl-L8A', modes: [], errors: [] };
try {
  await page.goto(report.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(() => !!window.ytInitialPlayerResponse && !!window.ytInitialData);
  for (const mode of ['top', 'all']) {
    await page.evaluate(installYoutubeLiveProbe, mode);
    for (let n = 0; n < 2;) {
      const step = await page.evaluate(() => window.__DANLINGO_YOUTUBE_L0__.poll());
      if (step.request) n++;
      if (n < 2) await page.waitForTimeout(step.deferredMs || step.dueMs || 1000);
    }
    const snapshot = await page.evaluate(() => window.__DANLINGO_YOUTUBE_L0__.snapshot());
    report.modes.push({ requested: mode, snapshot });
    console.log(JSON.stringify({ mode, observed: snapshot.mode, baseline: snapshot.baseline.items, newEvents: snapshot.events.length, statuses: snapshot.requests.map(r => r.status) }));
  }
  report.result = report.modes.every(m => m.snapshot.requests.every(r => r.status === 200)) && report.modes[0].snapshot.mode === 'Top chat' && report.modes[1].snapshot.mode === 'Live chat' ? 'PASS_TOP_AND_ALL_RELOAD' : 'INCOMPLETE';
} catch (error) { report.errors.push(String(error.message).slice(0, 500)); report.result = 'INCOMPLETE'; }
finally { await browser.close(); await writeFile(resolve(runDir, 'report.json'), JSON.stringify(report, null, 2)); }
if (report.result !== 'PASS_TOP_AND_ALL_RELOAD') process.exitCode = 1;
console.log(JSON.stringify({ report: resolve(runDir, 'report.json'), result: report.result, errors: report.errors }));
