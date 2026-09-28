// Built settings and paused synthetic watch UI, isolated profile; no provider requests.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadPlaywright, browserLaunchOptions } from './browser-runtime.mjs';
import { settingsSection } from './settings-navigation.mjs';
import { FIRST_URL, videoHtml } from '../test/fixtures/bilibili-video-native.mjs';

const extension = resolve(process.argv[2] ?? '../DanLingo-Workspace/testing/current/extension');
const artifact = resolve('.artifacts/bilibili-native-supply-ui');
await mkdir(artifact, { recursive: true });
const directory = await mkdtemp(resolve(artifact, 'run-'));
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json')));
const report = { evidence: 'ISOLATED_BUILT_EXTENSION_UI_NO_MODEL', version: manifest.version,
  checks: [], screenshots: [], errors: [], passed: false };
const { chromium } = await loadPlaywright();
const context = await chromium.launchPersistentContext(resolve(directory, 'profile'), {
  ...browserLaunchOptions(), headless: true, viewport: { width: 1100, height: 920 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
try {
  await context.route(/^https?:/, route => route.abort());
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await worker.evaluate(() => chrome.storage.local.set({ 'ui.locale.v1': 'zh-CN' }));
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  const ready = () => page.waitForFunction(() => document.querySelector('#result')?.textContent === '已保存');
  const open = async () => { await ready(); await settingsSection(page, 'watching'); };
  await open();
  const strict = page.locator('#bilibili-native-translation-only');
  const shadow = page.locator('#bilibili-shadow-scheduler');
  const owned = page.locator('#bilibili-owned-release');
  assert.equal(await strict.isChecked(), false);
  assert.equal(await shadow.isChecked(), false);
  assert.equal(await owned.isChecked(), false);
  report.checks.push('both-options-default-off');

  await worker.evaluate(async () => {
    const stored = (await chrome.storage.local.get('settings.v1'))['settings.v1'];
    await chrome.storage.local.set({ 'settings.v1': { ...stored, backend: 'local', enabled: false,
      localPreloadOnEntry: false, localModelId: 'isolated-ui-placeholder' } });
  });
  await page.reload(); await open();
  await strict.check(); await page.locator('#save').click(); await ready();
  await page.reload(); await open();
  assert.equal(await strict.isChecked(), true);
  assert.equal(await shadow.isChecked(), true);
  const enabled = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'settings' }));
  assert.equal(enabled.settings.bilibiliNativeTranslationOnly, true);
  assert.equal(enabled.settings.bilibiliShadowScheduler, true);
  assert.equal(enabled.settings.enabled, false);
  report.checks.push('strict-enables-shadow-persists-with-ordinary-translation-off');

  await strict.uncheck(); await shadow.uncheck(); await owned.check();
  await page.locator('#save').click(); await ready(); await page.reload(); await open();
  const ownedSettings = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'settings' }));
  assert.equal(ownedSettings.settings.bilibiliOwnedRelease, true);
  assert.equal(ownedSettings.settings.bilibiliNativeTranslationOnly, false);
  assert.equal(ownedSettings.settings.bilibiliShadowScheduler, false);
  assert.equal(ownedSettings.settings.enabled, false);
  report.checks.push('owned-option-persists-independently-with-no-model-permit');

  for (const width of [1100, 390]) {
    await page.setViewportSize({ width, height: 920 });
    await settingsSection(page, 'watching');
    assert.equal(await strict.isVisible(), true);
    assert.equal(await owned.isVisible(), true);
    const path = resolve(directory, `settings-${width}.png`);
    await page.locator('[data-section="watching"]').screenshot({ path });
    report.screenshots.push(path);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  }
  report.checks.push('settings-visible-at-1100-and-390-no-horizontal-overflow');

  await context.route(FIRST_URL, route => route.fulfill({ contentType: 'text/html', body: videoHtml }));
  const watch = await context.newPage();
  watch.on('pageerror', error => report.errors.push(error.message));
  await watch.goto(FIRST_URL);
  const start = watch.getByRole('button', { name: '启动 / 继续剩余额度', exact: true });
  await start.waitFor({ state: 'visible', timeout: 15000 });
  assert.equal(await watch.getByRole('button', { name: '启动新预算', exact: true }).isVisible(), true);
  const stop = watch.getByRole('button', { name: '结束', exact: true });
  await stop.click();
  await start.waitFor({ state: 'visible' });
  for (const width of [1100, 390]) {
    await watch.setViewportSize({ width, height: 920 });
    const panel = watch.locator('#danlingo-progress');
    const path = resolve(directory, `watch-controls-${width}.png`);
    await panel.screenshot({ path });
    report.screenshots.push(path);
    assert.equal(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
  }
  report.checks.push('synthetic-watch-controls-visible-stop-without-grant-is-zero-call');
  await watch.close();

  await strict.uncheck(); await shadow.uncheck(); await owned.uncheck(); await page.locator('#save').click(); await ready();
  await page.reload(); await open();
  assert.equal(await strict.isChecked(), false);
  assert.equal(await shadow.isChecked(), false);
  const restored = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'settings' }));
  assert.equal(restored.settings.bilibiliNativeTranslationOnly, false);
  assert.equal(restored.settings.bilibiliShadowScheduler, false);
  assert.equal(restored.settings.bilibiliOwnedRelease, false);
  assert.equal(restored.settings.enabled, false);
  const guards = await worker.evaluate(() => chrome.storage.local.get([
    'bilibiliNativeSupply.grant.v1', 'bilibiliNativeSupply.budget.v1', 'bilibiliNativeSupply.zeroTransport.v1',
    'bilibiliOwnedSupply.grant.v1', 'bilibiliOwnedSupply.budget.v1', 'bilibiliOwnedSupply.zeroTransport.v1',
  ]));
  assert.deepEqual(guards, {});
  report.checks.push('both-options-disabled-saved-reopened-no-native-experiment');
  assert.deepEqual(report.errors, []);
  report.passed = true;
} finally {
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
  await context.close();
  console.log(JSON.stringify({ directory, ...report }));
}
