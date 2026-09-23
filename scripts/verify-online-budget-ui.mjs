// Built extension/background/IndexedDB with a synthetic transport. No real provider or personal profile.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadPlaywright, browserLaunchOptions } from './browser-runtime.mjs';
import { DEFAULT_SETTINGS } from '../src/core/config.ts';

const { chromium } = await loadPlaywright();
const root = resolve('.artifacts/online-budget-ui'); await mkdir(root, { recursive: true });
const directory = await mkdtemp(resolve(root, 'run-'));
const extension = resolve(directory, 'extension'), profile = resolve(directory, 'profile');
const report = { evidence: 'BUILT_EXTENSION_REAL_BUDGET_STORAGE_SYNTHETIC_TRANSPORT', checks: {}, screenshots: [], errors: [] };
await cp(resolve('.output/chrome-mv3'), extension, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions.push('https://fixture.invalid/*');
await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
const settings = { ...DEFAULT_SETTINGS, onlineRequestLimitPerDay: 3, endpoint: 'https://fixture.invalid/v1', model: 'deepseek-v4-pro', profile: 'deepseek', thinkingEffort: 'off', liveSourceLanguage: 'ja', liveMaxBatchWaitMs: 0 };
let context, page, worker, origin;
async function launch() {
  context = await chromium.launchPersistentContext(profile, { headless: true,
    ...browserLaunchOptions(),
    viewport: { width: 1360, height: 900 },
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND'] });
  await context.route(/^https?:/, route => route.abort());
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  origin = 'chrome-extension://' + new URL(worker.url()).host;
  await worker.evaluate(() => {
    globalThis.__quotaFixture = { sends: 0, fail: false };
    globalThis.fetch = async (_url, init) => {
      if (init?.method !== 'POST') return Response.json({ data: [{ id: 'deepseek-v4-pro' }] });
      __quotaFixture.sends++;
      if (__quotaFixture.fail) return new Response('', { status: 503 });
      const body = JSON.parse(init.body), raw = body.messages[1].content;
      let parsed; try { parsed = JSON.parse(raw); } catch {}
      const content = parsed?.items ? JSON.stringify({ items: parsed.items.map(item => ({ id: item.id, text: '这是合成测试的译文。' })) })
        : raw.split('\n').map(line => JSON.stringify([JSON.parse(line)[0], '这是合成测试的译文。'])).join('\n');
      return Response.json({ choices: [{ message: { content } }] });
    };
  });
  page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(origin + '/options.html'); await page.locator('#online-request-limit').waitFor();
}
const rpc = message => page.evaluate(message => chrome.runtime.sendMessage(message), message);
const check = async (name, run) => { await run(); report.checks[name] = 'PASS'; console.log('PASS', name); };
try {
  await launch();
  await check('shared-cap-charges-tests-and-transport-failures', async () => {
    const saved = await rpc({ type: 'save', settings, apiKey: 'synthetic-key', remember: true });
    assert.equal(saved.ok, true); assert.equal(saved.onlineBudget.used, 0);
    await page.reload();
    assert.equal(await page.locator('#online-request-limit').inputValue(), '3');
    const first = await rpc({ type: 'test-model', settings, text: 'A synthetic request.' }); assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal((await rpc({ type: 'online-budget-status' })).onlineBudget.used, 1);
    await worker.evaluate(() => { __quotaFixture.fail = true; });
    assert.equal((await rpc({ type: 'test-model', settings, text: 'A synthetic failing request.' })).ok, false);
    assert.equal((await rpc({ type: 'online-budget-status' })).onlineBudget.used, 2);
    await worker.evaluate(() => { __quotaFixture.fail = false; });
    const run = await rpc({ type: 'performance-start', settings, config: { count: 10, mode: 'latency', concurrency: 2, batchSize: 1, arrivalIntervalMs: 0, strategy: 'normal' } });
    assert.equal(run.ok, true, JSON.stringify(run));
    await page.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: 'performance-status' })).report?.state === 'stopped');
    const state = (await rpc({ type: 'online-budget-status' })).onlineBudget;
    assert.equal(state.used, 3); assert.equal(state.remaining, 0); assert.equal(state.status, 'exhausted');
    assert.equal(await worker.evaluate(() => __quotaFixture.sends), 3);
  });
  await check('unsaved-higher-limit-cannot-bypass-saved-cap', async () => {
    // Wait for the completed performance lease to resume watching.
    await page.waitForFunction(async () => !(await chrome.runtime.sendMessage({ type: 'overview' })).performancePaused);
    const denied = await rpc({ type: 'test-model', settings: { ...settings, onlineRequestLimitPerDay: 1000 }, text: 'A blocked synthetic request.' });
    assert.equal(denied.ok, false); assert.match(denied.error, /上限/);
    assert.equal(await worker.evaluate(() => __quotaFixture.sends), 3);
  });
  await check('counter-refresh-preserves-draft-and-popup-shows-stop-reason', async () => {
    await page.locator('#online-request-limit').fill('7');
    await page.waitForFunction(() => document.querySelector('#online-budget-status').textContent.includes('3 / 3'));
    assert.equal(await page.locator('#online-request-limit').inputValue(), '7');
    const popup = await context.newPage(); await popup.goto(origin + '/popup.html');
    await popup.waitForFunction(() => document.querySelector('#online-budget-status').textContent.includes('已达每日上限'));
    const path = resolve(directory, 'popup-exhausted.png'); await popup.locator('main').screenshot({ path }); report.screenshots.push(path);
    await popup.close();
    for (const width of [1360, 360]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator('#online-request-limit').scrollIntoViewIfNeeded();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      const path = resolve(directory, 'settings-' + width + '.png'); await page.screenshot({ path }); report.screenshots.push(path);
    }
  });
  await check('raising-cap-and-restarting-browser-preserve-used-count', async () => {
    const saved = await rpc({ type: 'save', settings: { ...settings, onlineRequestLimitPerDay: 5 }, remember: true });
    assert.equal(saved.ok, true); assert.equal(saved.onlineBudget.used, 3); assert.equal(saved.onlineBudget.remaining, 2);
    await context.close(); await launch();
    const state = (await rpc({ type: 'online-budget-status' })).onlineBudget;
    assert.equal(state.used, 3); assert.equal(state.limit, 5);
    const result = await rpc({ type: 'test-model', settings, text: 'A synthetic request after restart.' }); assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal((await rpc({ type: 'online-budget-status' })).onlineBudget.used, 4);
  });
  await check('corrupted-counter-blocks-sends-and-shows-storage-error', async () => {
    const state = (await rpc({ type: 'online-budget-status' })).onlineBudget;
    await page.evaluate(day => new Promise((resolve, reject) => {
      const open = indexedDB.open('danlingo-online-request-budget', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('daily-usage', 'readwrite');
        tx.objectStore('daily-usage').put({ day, used: 'corrupt' });
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error);
      };
    }), state.day);
    const before = await worker.evaluate(() => __quotaFixture.sends);
    const denied = await rpc({ type: 'test-model', settings, text: 'Must not reach transport.' });
    assert.equal(denied.ok, false); assert.match(denied.error, /计数/);
    assert.equal(await worker.evaluate(() => __quotaFixture.sends), before);
    const unavailable = (await rpc({ type: 'online-budget-status' })).onlineBudget;
    assert.equal(unavailable.status, 'unavailable'); assert.equal(unavailable.used, null);
  });
  assert.deepEqual(report.errors, []); report.status = 'PASS';
} catch (error) { report.status = 'FAIL'; report.errors.push(error.stack ?? String(error)); process.exitCode = 1; }
finally { await context?.close(); await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log('REPORT', resolve(directory, 'report.json')); }
