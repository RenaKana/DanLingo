// Actual Edge + unmodified package, isolated profile, no provider or personal data.
// This is installation/UI evidence, not live-platform or GPU-inference acceptance.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { browserLaunchOptions, loadPlaywright } from './browser-runtime.mjs';

const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const root = resolve('.artifacts/edge-store', version);
await mkdir(root, { recursive: true });
const run = await mkdtemp(resolve(root, 'browser-'));
const extension = resolve(run, 'extension');
const build = resolve(process.env.DANLINGO_TEST_EXTENSION || '.output/chrome-mv3');
const baseline = process.env.DANLINGO_UPGRADE_BASELINE;
await cp(baseline ? resolve(baseline) : build, extension, { recursive: true });
const report = { status: 'RUNNING', version, evidence: 'INSTALLED_EDGE_ISOLATED_UNPACKED_EXTENSION', checks: [], screenshots: [], errors: [],
  limits: ['Not a signed Edge Add-ons installation.', 'No real provider, live website, file chooser, or GPU inference exercised.'] };
const { chromium } = await loadPlaywright();
let context;
const open = async () => {
  context = await chromium.launchPersistentContext(resolve(run, 'profile'), {
    ...browserLaunchOptions('edge'), headless: true, locale: 'en-US', viewport: { width: 1280, height: 800 },
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension,
      '--disable-background-networking', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND'],
  });
  context.setDefaultTimeout(15000);
  await context.route(/^https?:/, route => route.abort());
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 20000 });
  const origin = new URL(worker.url()).origin;
  // URL.origin is "null" for chrome-extension URLs in Node.
  const base = origin === 'null' ? 'chrome-extension://' + new URL(worker.url()).host : origin;
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(base + '/options.html');
  await page.locator('#ui-locale').waitFor();
  return { page, base };
};
try {
  let { page, base } = await open();
  report.browser = await page.evaluate(() => navigator.userAgent);
  assert.match(report.browser, /Edg\//);
  const before = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'overview' }));
  assert.equal(before.ok, true);
  assert.equal(before.settings.enabled, false);
  const previousVersion = await page.evaluate(() => chrome.runtime.getManifest().version);
  report.checks.push('clean-install-disabled-by-default');
  // Persist harmless settings and UI preferences through extension upgrade/restart.
  const savedSettings = { ...before.settings, targetLanguage: 'ja', onlineRequestLimitPerDay: 2500 };
  // Seed isolated storage directly: native service consent is a separate acceptance gate.
  await page.evaluate(settings => chrome.storage.local.set({ 'settings.v1': settings }), savedSettings);
  await page.selectOption('#ui-locale', 'de');
  await page.selectOption('#theme', 'dark');
  await page.waitForFunction(() => document.documentElement.lang === 'de' && document.documentElement.dataset.theme === 'dark');
  await context.close(); context = undefined;
  await cp(build, extension, { recursive: true });
  ({ page, base } = await open());
  assert.equal(await page.evaluate(() => chrome.runtime.getManifest().version), version);
  await page.waitForFunction(() => document.documentElement.lang === 'de' && document.documentElement.dataset.theme === 'dark');
  const restored = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'overview' }));
  assert.equal(restored.settings.targetLanguage, 'ja');
  assert.equal(restored.settings.onlineRequestLimitPerDay, 2500);
  assert.equal(restored.settings.enabled, false);
  report.checks.push(`same-path-same-id-${previousVersion}-to-${version}-preferences-and-settings-persist`);
  await page.selectOption('#theme', 'light');
  await page.selectOption('#ui-locale', 'en');
  const popup = await context.newPage(); await popup.goto(base + '/popup.html');
  const models = await context.newPage(); await models.goto(base + '/model-folders.html');
  const locales = await page.locator('#ui-locale option').evaluateAll(options => options.map(o => o.value).filter(v => v !== 'auto'));
  assert.equal(locales.length, 20);
  await page.locator('#model').fill('unsaved-review-draft');
  await page.locator('#model').focus();
  for (const locale of locales) {
    await page.evaluate(locale => chrome.storage.local.set({ 'ui.locale.v1': locale }), locale);
    for (const target of [page, popup, models]) {
      await target.waitForFunction(locale => document.documentElement.lang === locale, locale);
      assert.equal(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, locale);
      assert.equal(await target.locator('html').getAttribute('dir'), locale === 'ar' ? 'rtl' : 'ltr');
    }
    assert.equal(await page.locator('#model').inputValue(), 'unsaved-review-draft');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'model');
    report.checks.push(`${locale}-three-pages-draft-focus-direction-layout`);
  }
  const screenshotDir = resolve('docs/store-assets/screenshots');
  await mkdir(screenshotDir, { recursive: true });
  // Reload removes the deliberate unsaved test input. Screenshots contain real UI only.
  await page.reload(); await page.locator('#ui-locale').waitFor();
  const capture = async (locale, name, backend = 'online') => {
    await page.selectOption('#ui-locale', locale);
    await page.selectOption('#backend', backend);
    await page.waitForFunction(locale => document.documentElement.lang === locale, locale);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => document.fonts.ready);
    await page.locator('#ui-locale').blur();
    const path = resolve(screenshotDir, name + '.png');
    await page.screenshot({ path });
    report.screenshots.push(path);
  };
  await capture('en', '01-settings-en');
  await capture('en', '02-local-model-en', 'local');
  await capture('zh-CN', '03-settings-zh-CN');
  await capture('ar', '04-settings-ar');
  report.checks.push('four-real-settings-screenshots-1280x800');
  const final = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'overview' }));
  assert.equal(final.configVersion, restored.configVersion, 'UI language and backend drafts never save translation settings');
  assert.deepEqual(report.errors, []);
  report.status = 'PASS';
} catch (error) { report.status = 'FAIL'; report.failure = error.stack; process.exitCode = 1; }
finally {
  await context?.close();
  await writeFile(resolve(run, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ status: report.status, checks: report.checks.length, report: resolve(run, 'report.json'), failure: report.failure }));
