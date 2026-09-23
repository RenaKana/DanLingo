import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Isolated extension UI fixture: verifies the three Bilibili timeout-retry settings round-trip.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '../src/core/config.ts';

const root = resolve('.artifacts/bilibili-timeout-settings');
await mkdir(root, { recursive: true });
const directory = await mkdtemp(resolve(root, 'run-'));
const extension = resolve(directory, 'extension');
await cp(resolve('.output/chrome-mv3'), extension, { recursive: true });

const manifestPath = resolve(extension, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), 'https://fixture.invalid/*'])];
await writeFile(manifestPath, JSON.stringify(manifest));


const { chromium } = await loadPlaywright();
let context;
let page;
const errors = [];
const report = {
  status: 'RUNNING',
  evidence: 'BUILT_EXTENSION_ISOLATED_PROFILE_UI_FIXTURES',
  runDirectory: directory,
  checks: {},
  screenshots: [],
  errors,
  limitation: 'Fixture extension UI only; no real Bilibili page, provider, or screen-danmaku proof.',
};
const check = async (name, run) => { await run(); report.checks[name] = 'PASS'; };
const writeReports = async () => {
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(resolve(root, 'report.json'), JSON.stringify({
    status: report.status,
    evidence: report.evidence,
    runDirectory: report.runDirectory,
    checks: report.checks,
    screenshots: report.screenshots,
    errors: report.errors,
    limitation: report.limitation,
  }, null, 2));
};

try {
  context = await chromium.launchPersistentContext(resolve(directory, 'profile'), {
    headless: true,
    ...browserLaunchOptions('chromium'),
    viewport: { width: 1360, height: 900 },
    args: [
      '--disable-extensions-except=' + extension,
      '--load-extension=' + extension,
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--no-first-run',
      '--host-resolver-rules=MAP * ~NOTFOUND',
    ],
  });
  await context.route(/^https?:/, route => route.abort());
  await context.addInitScript(() => {
    if (globalThis.chrome?.permissions) {
      chrome.permissions.request = async () => true;
      chrome.permissions.contains = async () => true;
    }
  });

  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const origin = 'chrome-extension://' + new URL(worker.url()).host;
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/options.html');
  await page.locator('#bilibili-timeout-retry').waitFor({ state: 'attached' });

  const rpc = message => page.evaluate(value => chrome.runtime.sendMessage(value), message);
  const baseline = await rpc({ type: 'overview' });
  assert.equal(baseline.ok, true);
  const fixtureSettings = { ...DEFAULT_SETTINGS, endpoint: 'https://fixture.invalid/v1', model: 'fixture-model' };
  const permission = await page.evaluate(() => chrome.permissions.request({ origins: ['https://fixture.invalid/*'] }));
  assert.equal(permission, true);
  const seeded = await rpc({ type: 'save', settings: fixtureSettings, apiKey: '', remember: false });
  assert.equal(seeded.ok, true, seeded.error ?? 'settings seed failed');
  await page.reload();
  await page.locator('#bilibili-timeout-retry').waitFor({ state: 'attached' });
  const goto = async id => {
    const category = page.locator('#category');
    if (await category.isVisible()) await category.selectOption(id);
    else await page.locator(`nav a[href="#${id}"]`).click();
    await page.waitForFunction(section => !document.querySelector(`[data-section="${section}"]`)?.hidden, id);
  };
  await goto('live');

  const retry = page.locator('#bilibili-timeout-retry');
  const extra = page.locator('#bilibili-timeout-retry-extra');
  const mode = page.locator('#bilibili-timeout-retry-mode');
  await check('defaults-off-with-1000ms-hold-and-dependent-controls-disabled', async () => {
    assert.equal(await retry.isChecked(), false);
    assert.equal(await extra.isDisabled(), true);
    assert.equal(await mode.isDisabled(), true);
    assert.equal(await extra.inputValue(), '1000');
    assert.equal(await mode.inputValue(), 'hold');
  });
  const screenshot = resolve(directory, 'live-section.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  report.screenshots.push(screenshot);

  await check('enable-edit-disable-preserves-values', async () => {
    await retry.check();
    assert.equal(await extra.isDisabled(), false);
    assert.equal(await mode.isDisabled(), false);
    await extra.fill('2500');
    await mode.selectOption('release');
    await retry.uncheck();
    assert.equal(await extra.isDisabled(), true);
    assert.equal(await mode.isDisabled(), true);
    assert.equal(await extra.inputValue(), '2500');
    assert.equal(await mode.inputValue(), 'release');
  });

  await page.locator('#save').click();
  await page.waitForFunction(() => document.querySelector('#result')?.textContent === '已保存');
  let saved = await rpc({ type: 'overview' });
  await check('disabled-values-persist-after-save', async () => {
    assert.equal(saved.settings.bilibiliTimeoutRetryEnabled, false);
    assert.equal(saved.settings.bilibiliTimeoutRetryExtraMs, 2500);
    assert.equal(saved.settings.bilibiliTimeoutRetryMode, 'release');
  });

  await page.reload();
  await page.locator('#bilibili-timeout-retry').waitFor({ state: 'attached' });
  await goto('live');
  await check('saved-values-reload-with-dependent-controls-disabled', async () => {
    assert.equal(await retry.isChecked(), false);
    assert.equal(await extra.isDisabled(), true);
    assert.equal(await mode.isDisabled(), true);
    assert.equal(await extra.inputValue(), '2500');
    assert.equal(await mode.inputValue(), 'release');
  });

  await retry.check();
  await page.locator('#save').click();
  await page.waitForFunction(() => document.querySelector('#result')?.textContent === '已保存');
  saved = await rpc({ type: 'overview' });
  await check('enable-persisted-retry', async () => {
    assert.equal(saved.settings.bilibiliTimeoutRetryEnabled, true);
    assert.equal(saved.settings.bilibiliTimeoutRetryExtraMs, 2500);
    assert.equal(saved.settings.bilibiliTimeoutRetryMode, 'release');
  });
  assert.deepEqual(errors, []);
  report.status = 'PASS';
  await writeReports();
  console.log(JSON.stringify({ status: 'PASS', report: resolve(root, 'report.json'), screenshot }));
} catch (error) {
  report.status = 'FAIL';
  report.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  await writeReports();
  throw error;
} finally {
  await page?.close();
  await context?.close();
}
