import { browserLaunchOptions, loadPlaywright } from "../browser-runtime.mjs";
// Isolated gate for an exact, source-reviewed official player build. A core
// replay is explicitly reported, never passed off as the site's current build.
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [evidencePath] = process.argv.slice(2);
assert.ok(evidencePath, 'Pass the reviewed static evidence JSON');
const evidence = JSON.parse(await readFile(resolve(evidencePath), 'utf8'));
const core = evidence.resources.find(row => row.label === 'core');
assert.match(core.url, /^https:\/\/s1\.hdslb\.com\/bfs\/static\/player\/main\/core\.[a-f0-9]+\.js$/);
const coreResponse = await fetch(core.url);
assert.equal(coreResponse.status, 200);
const coreBody = Buffer.from(await coreResponse.arrayBuffer());
assert.equal(createHash('sha256').update(coreBody).digest('hex'), core.sha256.toLowerCase());
const root = resolve('.artifacts/bilibili-runtime-gate');
await mkdir(root, { recursive: true });
const dir = await mkdtemp(resolve(root, `reviewed-${evidence.version.version}-`));
const report = { startedAt: new Date().toISOString(), target: 'https://www.bilibili.com/video/BV1SQbW6dELM/',
  evidence: 'real anonymous page with replay of the exact source-reviewed official core; native observation only',
  replayedCore: { url: core.url, sha256: core.sha256 }, resources: [], providerCalls: 0, result: 'INCOMPLETE' };
const expected = { version: evidence.version.version, lastCompiled: evidence.version.lastCompiled };
const { chromium } = await loadPlaywright();
let context, page;
const pending = new Set();
try {
  context = await chromium.launchPersistentContext(resolve(dir, 'profile'), { ...browserLaunchOptions('chromium'), headless: true,
    viewport: { width: 1360, height: 920 }, locale: 'zh-CN', args: ['--disable-extensions', '--no-first-run', '--disable-sync', '--autoplay-policy=no-user-gesture-required'] });
  report.browser = context.browser()?.version();
  page = await context.newPage();
  await page.route('https://s1.hdslb.com/bfs/static/player/main/core.*.js', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: coreBody }));
  const reviewed = new Map(evidence.resources.filter(row => row.label !== 'core').map(row => [row.url, row]));
  page.on('response', response => {
    const match = reviewed.get(response.url());
    if (!match) return;
    const work = response.body().then(body => report.resources.push({ url: response.url(), status: response.status(),
      sha256: createHash('sha256').update(body).digest('hex'), reviewedSha256: match.sha256.toLowerCase() }));
    pending.add(work); work.finally(() => pending.delete(work)).catch(() => {});
  });
  report.navigationStatus = (await page.goto(report.target, { waitUntil: 'domcontentloaded', timeout: 45000 }))?.status();
  await page.waitForFunction(() => window.player?.danmaku?.getDanmakuX?.()?.manager?.dataBase?.dmArray?.length &&
    window.player?.mediaElement?.()?.duration > 0, null, { timeout: 30000 });
  report.surface = await page.evaluate(() => {
    const p = window.player, d = p.danmaku.getDanmakuX(), m = p.getManifest(), v = p.mediaElement();
    return { metadata: d.getMetadata(), identity: { bvid: m.bvid, aid: String(m.aid), cid: String(m.cid), p: m.p },
      media: { connected: v.isConnected, isVideo: v instanceof HTMLVideoElement, duration: v.duration },
      poolCount: d.manager.dataBase.dmArray.length,
      methods: { insert: String(d.manager.insert), validate: String(d.manager.validate), initRender: String(d.manager.initRender) } };
  });
  assert.deepEqual(report.surface.metadata, expected);
  assert.deepEqual(report.surface.identity, { bvid: 'BV1SQbW6dELM', aid: '117224320801605', cid: '41641968199', p: 1 });
  assert.equal(report.surface.media.isVideo && report.surface.media.connected, true);
  await page.evaluate(async () => {
    const d = window.player.danmaku.getDanmakuX(), manager = d.manager, hooks = d.hooks;
    const restore = [], events = [], stack = [];
    const wrap = (target, key, factory) => {
      const own = Object.getOwnPropertyDescriptor(target, key), original = target[key], fn = factory(original);
      Object.defineProperty(target, key, { ...(own ?? { configurable: true, writable: true }), value: fn });
      restore.push(() => { if (target[key] === fn) { if (own) Object.defineProperty(target, key, own); else delete target[key]; } });
    };
    wrap(manager, 'insert', original => function(items, ...args) {
      const frame = { items: new Set(items), hook: 0, filtered: new Set(), order: 0 }; stack.push(frame);
      try { return Reflect.apply(original, this, [items, ...args]); } finally { stack.pop(); }
    });
    wrap(hooks, 'beforeRender', original => function(...args) {
      const frame = stack.at(-1); if (frame) frame.hook = ++frame.order;
      return Reflect.apply(original, this, args);
    });
    wrap(manager, 'validate', original => function(item, ...args) {
      const result = Reflect.apply(original, this, [item, ...args]), frame = stack.at(-1);
      if (frame?.hook && result) { frame.order++; frame.filtered.add(item); }
      return result;
    });
    wrap(manager, 'initRender', original => function(item, ...args) {
      const frame = stack.at(-1), before = new Set(this.cDmlist);
      const proof = frame && { hookBeforeFilter: frame.hook > 0, filteredBeforeInit: frame.filtered.has(item),
        originalSource: frame.items.has(item) && this.dataBase.dmArray.includes(item), onBeforeInit: item.on === true, mode: item.mode };
      const result = Reflect.apply(original, this, [item, ...args]);
      if (proof && events.length < 80) {
        const model = this.cDmlist.find(value => !before.has(value) && value.textData === item);
        events.push({ ...proof, nativeModelCreated: !!model });
      }
      return result;
    });
    window.__DL_BUILD_AUDIT__ = { events, stop() { for (const fn of restore.reverse()) fn(); } };
    const video = window.player.mediaElement(); video.muted = true;
    // Seek only into a segment already decoded by the native site. Never insert
    // comments, fetch history, or manufacture an upstream/native event.
    const first = manager.dataBase.dmArray.filter(row => [1,4,5,6].includes(row.mode) && row.stime >= 3).sort((a,b) => a.stime-b.stime)[0];
    if (first) video.currentTime = Math.max(0, first.stime - 1);
    await video.play();
  });
  await page.waitForFunction(() => window.__DL_BUILD_AUDIT__.events.some(row => row.nativeModelCreated), null, { timeout: 22000 });
  report.sequence = await page.evaluate(() => {
    const result = window.__DL_BUILD_AUDIT__.events.slice(); window.__DL_BUILD_AUDIT__.stop(); window.player.mediaElement().pause(); return result;
  });
  assert.ok(report.sequence.length > 0 && report.sequence.every(row => row.hookBeforeFilter && row.filteredBeforeInit && row.originalSource && row.onBeforeInit));
  await Promise.all([...pending]);
  assert.ok(report.resources.length > 0 && report.resources.every(row => row.status === 200 && row.sha256 === row.reviewedSha256));
  report.result = 'NATIVE_SEQUENCE_OBSERVED';
} catch (error) {
  report.error = String(error.stack ?? error); process.exitCode = 1;
} finally {
  await context?.close(); report.finishedAt = new Date().toISOString();
  await writeFile(resolve(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ result: report.result, report: resolve(dir, 'report.json'), error: report.error }, null, 2));
}
