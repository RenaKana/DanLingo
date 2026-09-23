// P0 evidence collection. Isolated, anonymous browser; never logs credentials.
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const watchId = process.argv[2] || 'sm9';
if (!/^(sm|so|nm)\d+$/.test(watchId)) throw new Error('Expected a Niconico watch ID');
const root = resolve('.artifacts/p0/niconico', watchId);
await mkdir(root, { recursive: true });
await mkdir(resolve(root, 'sources'), { recursive: true });
const modulePath = process.env.DANLINGO_PLAYWRIGHT_MODULE;
const { chromium } = modulePath
  ? await import(pathToFileURL(modulePath).href)
  : await import('playwright');
const context = await chromium.launchPersistentContext(resolve('.artifacts/profiles/p0-niconico'), {
  headless: true,
  channel: 'chromium',
  viewport: { width: 1440, height: 1000 },
  locale: 'ja-JP',
  args: process.env.DANLINGO_PROBE_EXTENSION === '1' ? [
    '--disable-extensions-except=' + resolve('probes/niconico'),
    '--load-extension=' + resolve('probes/niconico'),
  ] : [],
});
const report = { capturedAt: new Date().toISOString(), watchId, evidence: 'real-page-inspection-only', errors: [], modules: [] };
const pending = [];
const page = context.pages()[0] || await context.newPage();
page.on('pageerror', error => report.errors.push(String(error.message).slice(0, 300)));
page.on('response', response => {
  const url = new URL(response.url());
  if (url.hostname !== 'resource.video.nimg.jp' || !url.pathname.endsWith('.js')) return;
  const task = (async () => {
    const source = await response.body();
    const hash = createHash('sha256').update(source).digest('hex');
    const file = basename(url.pathname);
    await writeFile(resolve(root, 'sources', file), source);
    report.modules.push({ url: url.origin + url.pathname, file, sha256: hash, bytes: source.length });
  })().catch(error => report.errors.push('Source capture: ' + String(error.message).slice(0, 120)));
  pending.push(task);
});
try {
  await page.goto('https://www.nicovideo.jp/watch/' + watchId, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.locator('video').first().waitFor({ state: 'attached', timeout: 25000 }).catch(() => report.errors.push('No video element within 25s'));
  report.title = await page.title();
  if (process.env.DANLINGO_PROBE_EXTENSION === '1') {
    await page.waitForFunction(() => {
      const s = window.__DANLINGO_P0__?.snapshot();
      return s?.attached > 0 && s.layers.some(layer => layer.poolCount > 0);
    }, undefined, { timeout: 25000 }).catch(() => report.errors.push('Native populated instance/filter not found within 25s'));
    report.native = await page.evaluate(() => window.__DANLINGO_P0__?.snapshot() ?? null);
    if (process.env.DANLINGO_PROBE_VERIFY === '1') {
      const originals = await page.evaluate(() => window.__DANLINGO_P0__.sourceSample());
      await page.evaluate(() => window.__DANLINGO_P0__.enable(true));
      report.lastStep = 'play';
      const playButton = page.getByRole('button', { name: '再生する', exact: true });
      if (await playButton.isVisible()) await playButton.click();
      else await page.evaluate(() => window.__DANLINGO_P0__.playerVideo('play'));
      await page.waitForFunction(() => {
        const s = window.__DANLINGO_P0__.snapshot();
        return s.translated >= 3 && s.currentTime > 2;
      }, undefined, { timeout: 25000 });
      await page.evaluate(() => window.__DANLINGO_P0__.playerVideo('pause'));
      report.simulated = await page.evaluate(() => window.__DANLINGO_P0__.snapshot());
      await page.screenshot({ path: resolve(root, 'simulated-native.png') });
      await page.evaluate(() => window.__DANLINGO_P0__.seek(45));
      await page.waitForFunction(() => Math.abs(window.__DANLINGO_P0__.snapshot().currentTime - 45) < 1, undefined, { timeout: 10000 });
      report.seek = await page.evaluate(() => window.__DANLINGO_P0__.snapshot());
      const after = new Map((await page.evaluate(() => window.__DANLINGO_P0__.sourceSample())).map(m => [m.id, m]));
      report.originalsPreserved = originals.length > 0 && originals.every(m => after.get(m.id)?.body === m.body && after.get(m.id)?.vposMs === m.vposMs);
      if (!report.originalsPreserved) throw new Error('Original message sample changed during simulated translation');
      report.lastStep = 'rate';
      await page.evaluate(() => window.__DANLINGO_P0__.playerVideo('rate', 1.25));
      await page.waitForFunction(() => window.__DANLINGO_P0__.snapshot().playbackRate === 1.25);
      report.rate = await page.evaluate(() => window.__DANLINGO_P0__.snapshot().playbackRate);
      await page.evaluate(() => window.__DANLINGO_P0__.playerVideo('rate', 0.5));
      await page.waitForFunction(() => window.__DANLINGO_P0__.snapshot().playbackRate === 0.5);
      report.slowRate = await page.evaluate(() => window.__DANLINGO_P0__.snapshot().playbackRate);
      await page.evaluate(() => window.__DANLINGO_P0__.playerVideo('rate', 1));
      report.lastStep = 'fullscreen';
      await page.evaluate(() => window.__DANLINGO_P0__.playerVideo('fullscreen'));
      await page.waitForFunction(() => document.fullscreenElement !== null);
      report.fullscreen = await page.evaluate(() => ({ active: document.fullscreenElement !== null, native: window.__DANLINGO_P0__.snapshot().state }));
      await page.screenshot({ path: resolve(root, 'fullscreen.png') });
      await page.evaluate(() => document.exitFullscreen());
      report.lastStep = 'navigation';
      const next = await page.evaluate(() => [...document.querySelectorAll('a[href]')]
        .map(a => ({ href: a.href, visible: a.getBoundingClientRect().width > 0 }))
        .find(a => a.visible && /^https:\/\/www\.nicovideo\.jp\/watch\/sm\d+/.test(a.href) && new URL(a.href).pathname !== location.pathname)?.href);
      if (!next) throw new Error('No real related-video link available for navigation verification');
      const nextId = new URL(next).pathname.split('/')[2];
      await page.evaluate(href => [...document.querySelectorAll('a[href]')].find(a => a.href === href)?.click(), next);
      await page.waitForFunction(id => {
        const s = window.__DANLINGO_P0__?.snapshot();
        return s?.identity?.watchId === id && s.layers.some(layer => layer.poolCount > 0);
      }, nextId, { timeout: 30000 });
      report.navigation = await page.evaluate(() => window.__DANLINGO_P0__.snapshot());
      report.lastStep = 'restore';
      report.restored = await page.evaluate(() => window.__DANLINGO_P0__.stop());
      if (report.restored.filtersAfterStop.some(filters => filters.includes('danlingo-p0-simulated'))) throw new Error('P0 native filter remained after stop');
      const beforeNames = report.native.layers.map(layer => layer.filters.filter(name => name !== 'danlingo-p0-simulated'));
      if (JSON.stringify(beforeNames) !== JSON.stringify(report.restored.filtersAfterStop)) throw new Error('Other native staging filters changed');
      report.simulatedVerification = 'PASS: real native staging, playback/pause, seek, rate, fullscreen, source sample preservation and native filter restoration; simulated translation only';
    }
  }
  report.page = await page.evaluate(() => {
    const videos = [...document.querySelectorAll('video')].map(v => ({
      class: v.className, currentTime: v.currentTime, duration: Number.isFinite(v.duration) ? v.duration : null,
      paused: v.paused, readyState: v.readyState, videoWidth: v.videoWidth, videoHeight: v.videoHeight,
    }));
    const canvas = [...document.querySelectorAll('canvas')].map(c => ({
      class: c.className, width: c.width, height: c.height, parentClass: c.parentElement?.className,
    }));
    const react = [];
    for (const element of document.querySelectorAll('canvas,video')) {
      let ancestor = element;
      for (let depth = 0; ancestor && depth < 5; depth++, ancestor = ancestor.parentElement) {
        const key = Object.keys(ancestor).find(k => k.startsWith('__reactFiber$'));
        if (!key) continue;
        let fiber = ancestor[key];
        for (let i = 0; fiber && i < 15; i++, fiber = fiber.return) {
          react.push({
            element: element.tagName, ancestorDepth: depth, fiberDepth: i,
            type: typeof fiber.type === 'string' ? fiber.type : fiber.type?.displayName || fiber.type?.name,
            propKeys: Object.keys(fiber.memoizedProps || {}).slice(0, 25),
            instanceType: fiber.stateNode?.constructor?.name,
          });
        }
      }
    }
    return { videos, canvas, react, title: document.title,
      globals: Object.keys(window).filter(k => /player|comment|nico/i.test(k)),
      buttons: [...document.querySelectorAll('button')].map(b => ({ text: b.textContent?.trim().slice(0, 60), aria: b.getAttribute('aria-label'), title: b.title })).slice(0, 100),
    };
  });
  await page.screenshot({ path: resolve(root, 'page.png'), fullPage: false });
} catch (error) {
  report.errors.push('Probe: ' + String(error.message).slice(0, 400));
} finally {
  await Promise.allSettled(pending);
  await writeFile(resolve(root, 'report.json'), JSON.stringify(report, null, 2));
  await context.close();
}
console.log(JSON.stringify({ report: resolve(root, 'report.json'), modules: report.modules.length, title: report.title, native: report.native, simulatedVerification: report.simulatedVerification, originalsPreserved: report.originalsPreserved, errors: report.errors }, null, 2));
if (process.env.DANLINGO_PROBE_VERIFY === '1' && !report.simulatedVerification) process.exitCode = 1;
