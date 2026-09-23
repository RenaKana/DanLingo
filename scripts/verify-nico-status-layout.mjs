import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Real page, unchanged release payload, no credential or Provider configuration.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.argv.length !== 3 || !/^lv\d+$/.test(process.argv[2])) throw new Error('Usage: node scripts/verify-nico-status-layout.mjs lvID');
const room = process.argv[2], build = resolve('.output/chrome-mv3');
await mkdir('.artifacts/live/ui-layout', { recursive: true });
const folder = await mkdtemp(resolve('.artifacts/live/ui-layout/status-'));
const report = { capturedAt: new Date().toISOString(), room, status: 'RUNNING', checks: {}, layouts: [], errors: [],
  providerRequests: 0, limitations: ['Real page layout only. No Key, translation performance, native installation or permission consent is tested.'] };
const manifest = JSON.parse(await readFile(resolve(build, 'manifest.json')));
assert.equal(manifest.version, '0.2.0');
report.liveScriptSha256 = createHash('sha256').update(await readFile(resolve(build, 'content-scripts/live.js'))).digest('hex');
let context;
const timer = setTimeout(() => { report.errors.push('70-second run budget'); void context?.close(); }, 70000);
try {
  const { chromium } = await loadPlaywright();
  context = await chromium.launchPersistentContext(resolve(folder, 'profile'), {
    ...browserLaunchOptions("edge"), headless: false,
    viewport: { width: 1180, height: 820 }, locale: 'ja-JP', timeout: 15000,
    args: ['--disable-extensions-except=' + build, '--load-extension=' + build],
  });
  context.setDefaultTimeout(10000); report.browserVersion = context.browser().version();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const options = await context.newPage();
  await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  const initial = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'settings' }));
  assert.equal(initial.ok, true); assert.equal(initial.hasKey, false); assert.equal(initial.settings.enabled, false);
  report.checks.initialNoKeyDisabled = true;
  context.on('request', request => { if (request.url() === initial.settings.endpoint) report.providerRequests++; });
  const page = await context.newPage();
  await page.goto('https://live.nicovideo.jp/watch/' + room, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.bringToFront();
  async function inspect(name) {
    await page.waitForFunction(() => {
      const host = document.getElementById('danlingo-live-status');
      const player = document.querySelector('[data-layer-name="videoLayer"] video')?.closest('[data-player-layout]');
      return host && !host.hidden && host.previousElementSibling === player;
    }, null, { timeout: 12000 });
    await page.locator('#danlingo-live-status').scrollIntoViewIfNeeded();
    const layout = await page.evaluate(() => {
      const video = document.querySelector('[data-layer-name="videoLayer"] video');
      const player = video.closest('[data-player-layout]'), host = document.getElementById('danlingo-live-status');
      const rect = element => { const b = element.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, bottom: b.bottom }; };
      return { mainVideoPresent: !!video, playerPresent: !!player, hidden: host.hidden,
        sameParent: host.parentElement === player.parentElement, directlyAfterMainPlayer: host.previousElementSibling === player,
        outsideVideos: [...document.querySelectorAll('video')].filter(v => !player.contains(v)).length,
        firstVideoOutsideMainPlayer: !player.contains(document.querySelector('video')),
        player: rect(player), status: rect(host), panelText: host.shadowRoot.textContent.replace(/^[\s\S]*<\/style>/, '').slice(-250) };
    });
    report.layouts.push({ name, ...layout });
    assert.equal(layout.hidden, false); assert.equal(layout.sameParent, true); assert.equal(layout.directlyAfterMainPlayer, true);
    assert.ok(layout.status.y >= layout.player.bottom - 1, 'Status must be below the main player');
    await page.screenshot({ path: resolve(folder, name + '.png') });
  }
  await inspect('normal');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await inspect('resized');
  const after = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'settings' }));
  report.checks.finalNoKeyDisabled = after.ok && after.hasKey === false && after.settings.enabled === false;
  report.checks.noProviderRequests = report.providerRequests === 0;
  report.checks.layoutsPassed = report.layouts.length === 2;
  report.checks.scriptUnchanged = report.liveScriptSha256 === createHash('sha256').update(await readFile(resolve(build, 'content-scripts/live.js'))).digest('hex');
  report.status = Object.values(report.checks).every(Boolean) ? 'PASS_REAL_NICO_STATUS_LAYOUT' : 'INCOMPLETE';
} catch (error) { report.status = 'INCOMPLETE'; report.errors.push(String(error.message).slice(0, 600)); }
finally {
  try { await context?.close(); report.browserClosed = true; } catch { report.browserClosed = false; report.status = 'INCOMPLETE'; }
  clearTimeout(timer); report.finishedAt = new Date().toISOString();
  await writeFile(resolve(folder, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: resolve(folder, 'report.json'), status: report.status, providerRequests: report.providerRequests }));
  if (report.status !== 'PASS_REAL_NICO_STATUS_LAYOUT') process.exitCode = 1;
}
