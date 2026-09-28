// Retired experimental controls stay absent; legacy values cannot reactivate them.
// Built settings UI only, isolated profile, no provider/platform requests.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadPlaywright, browserLaunchOptions } from './browser-runtime.mjs';
import { settingsSection } from './settings-navigation.mjs';

const extension = resolve(process.argv[2] ?? '../DanLingo-Workspace/testing/current/extension');
const artifact = resolve('.artifacts/bilibili-shadow-ui');
await mkdir(artifact, { recursive: true });
const directory = await mkdtemp(resolve(artifact, 'run-'));
const report = { evidence: 'ISOLATED_BUILT_EXTENSION_UI_NO_MODEL', version: JSON.parse(await readFile(resolve(extension, 'manifest.json'))).version,
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
  await ready(); await settingsSection(page, 'watching');
  const retired = page.locator('#bilibili-shadow-scheduler, #bilibili-native-translation-only');
  assert.equal(await retired.count(), 0);
  report.checks.push('retired-controls-absent');
  await worker.evaluate(async () => {
    const stored = (await chrome.storage.local.get('settings.v1'))['settings.v1'];
    await chrome.storage.local.set({ 'settings.v1': { ...stored, backend: 'local', enabled: false,
      localPreloadOnEntry: false, localModelId: 'isolated-ui-placeholder',
      bilibiliShadowScheduler: true, bilibiliNativeTranslationOnly: true,
      bilibiliOwnedRelease: true, bilibiliUserFilters: true } });
  });
  await page.reload(); await ready(); await settingsSection(page, 'watching');
  const normalized = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'settings' }));
  assert.equal(normalized.settings.bilibiliShadowScheduler, false);
  assert.equal(normalized.settings.bilibiliNativeTranslationOnly, false);
  assert.equal(normalized.settings.bilibiliOwnedRelease, true);
  assert.equal(normalized.settings.bilibiliUserFilters, true);
  assert.equal(await retired.count(), 0);
  report.checks.push('legacy-flags-ignored-with-planning-preserved');
  for (const width of [1100, 390]) {
    await page.setViewportSize({ width, height: 920 });
    await settingsSection(page, 'watching');
    const path = resolve(directory, `settings-${width}.png`);
    await page.locator('[data-section="watching"]').screenshot({ path });
    report.screenshots.push(path);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  }
  await page.locator('#save').click(); await ready();
  const saved = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'settings' }));
  assert.equal(saved.settings.bilibiliShadowScheduler, false);
  assert.equal(saved.settings.bilibiliNativeTranslationOnly, false);
  assert.equal(saved.settings.enabled, false);
  report.checks.push('retired-flags-saved-off-translation-stays-off');
  assert.deepEqual(report.errors, []);
  report.passed = true;
} finally {
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
  await context.close();
  console.log(JSON.stringify({ directory, ...report }));
}
