// Real built extension + isolated Edge profile; no user data, model loading, or provider traffic.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadPlaywright, browserLaunchOptions } from './browser-runtime.mjs';
import { settingsSection } from './settings-navigation.mjs';
import { LOCALES } from '../src/i18n/locale.ts';

const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/verify-settings-preferences.mjs <built-extension-directory>');
await mkdir('.artifacts', { recursive: true });
const directory = await mkdtemp(resolve('.artifacts/settings-preferences-'));
const extension = resolve(directory, 'extension');
await cp(resolve(source), extension, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions.push('https://fixture.invalid/*');
await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
const report = { evidence: 'ISOLATED_EDGE_BUILT_EXTENSION_REAL_SETTINGS_STORAGE', checks: [], screenshots: [], errors: [],
  limitations: ['No real provider, GPU inference or user browser profile was used.'] };
const { chromium } = await loadPlaywright();
let context, page;
const check = async (name, action) => { await action(); report.checks.push(name); console.log('PASS', name); };
try {
  context = await chromium.launchPersistentContext(resolve(directory, 'profile'), {
    ...browserLaunchOptions('edge'), headless: true, locale: 'zh-CN', viewport: { width: 1360, height: 920 },
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--disable-background-networking', '--no-first-run'],
  });
  context.setDefaultTimeout(12000);
  await context.route(/^https?:/, route => route.abort());
  await context.addInitScript(() => {
    if (!globalThis.chrome?.runtime?.id) return;
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    const fixture = globalThis.__settingsUiFixture = { calls: [], overviews: 0, broadcasts: 0, status: null };
    chrome.runtime.onMessage.addListener(message => { if (message?.type === 'settings-updated') fixture.broadcasts++; });
    chrome.runtime.sendMessage = async (message, ...rest) => {
      fixture.calls.push(message.type);
      const response = await original(message, ...rest);
      if (message.type === 'overview') {
        fixture.overviews++;
        if (fixture.status) return { ...response, status: fixture.status };
      }
      return response;
    };
  });
  report.browserVersion = context.browser()?.version();
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15000 });
  const origin = 'chrome-extension://' + new URL(worker.url()).host;
  await worker.evaluate(() => chrome.storage.local.set({ 'ui.locale.v1': 'zh-CN' }));
  page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(origin + '/options.html');
  await page.waitForFunction(() => document.querySelector('#result')?.textContent === '已保存');
  const rpc = message => page.evaluate(message => chrome.runtime.sendMessage(message), message);
  const section = name => settingsSection(page, name);
  const save = async () => {
    await page.locator('#save').click();
    await page.waitForFunction(() => !document.querySelector('#save').disabled && document.querySelector('#result')?.textContent === '已保存');
  };
  const screenshot = async (name, target = page) => {
    const path = resolve(directory, name + '.png'); await target.screenshot({ path, fullPage: true }); report.screenshots.push(path);
  };
  const openRequestSettings = async () => {
    await section('advanced');
    const details = page.locator('#online-concurrency').locator('xpath=ancestor::details[1]');
    if (await details.count() && !await details.evaluate(el => el.open)) await details.locator(':scope > summary').click();
  };

  await check('fresh-defaults-and-early-render', async () => {
    const { settings, onlineBudget } = await rpc({ type: 'settings' });
    assert.equal(settings.onlineRequestLimitPerDay, 0); assert.equal(onlineBudget.status, 'available');
    assert.equal(settings.localIdleUnloadEnabled, true); assert.equal(settings.localIdleUnloadMinutes, 5);
    assert.equal(settings.liveBufferMs, 3000);
    for (const platform of ['bilibili', 'youtube', 'niconico']) {
      assert.equal(settings[platform + 'TimeoutRetryEnabled'], false);
      assert.equal(settings[platform + 'TimeoutRetryExtraMs'], 1000);
    }
    assert.match(await page.locator('#online-budget-status').textContent(), /不限制/);
    await section('live'); await screenshot('live-defaults');
    assert.equal(await page.locator('#live-buffer').inputValue(), '3000');
    assert.doesNotMatch(await page.locator('.live-settings').textContent(), /（默认关闭）/);
    assert.doesNotMatch(await page.locator('.live-settings').innerText(), /第二轮|排队|重发|首轮设置/);
    for (const platform of ['bilibili', 'youtube', 'niconico']) {
      assert.equal(await page.locator('#' + platform + '-retry-options').isVisible(), false);
      assert.equal(await page.locator('#' + platform + '-timeout-retry-extra').isDisabled(), true);
    }
    await section('service'); await page.locator('#backend').selectOption('local');
    await screenshot('local-idle-defaults');
  });
  await check('independent-settings-save-reopen-and-backend-selection', async () => {
    await page.locator('#local-idle-unload-minutes').fill('9');
    await page.locator('#local-idle-unload-enabled').uncheck();
    assert.equal(await page.locator('#local-idle-unload-minutes').isDisabled(), true);
    await page.locator('#backend').selectOption('online');
    await page.locator('#endpoint').fill('https://fixture.invalid/v1');
    await page.locator('#model').fill('fixture-model');
    await openRequestSettings();
    await page.locator('#online-concurrency').fill('8'); await page.locator('#local-concurrency').fill('3');
    await screenshot('separate-concurrency');
    await section('live');
    await page.locator('#bilibili-timeout-retry').check(); await page.locator('#youtube-timeout-retry').check();
    await page.locator('#live-buffer').fill('4500');
    await save();
    let { settings } = await rpc({ type: 'settings' });
    assert.equal(settings.onlineConcurrency, 8); assert.equal(settings.localConcurrency, 3); assert.equal(settings.concurrency, 8);
    assert.equal(settings.localIdleUnloadEnabled, false); assert.equal(settings.localIdleUnloadMinutes, 9);
    assert.equal(settings.liveBufferMs, 4500); assert.equal(settings.bilibiliTimeoutRetryEnabled, true);
    assert.equal(settings.youtubeTimeoutRetryEnabled, true); assert.equal(settings.niconicoTimeoutRetryEnabled, false);
    await page.reload(); await page.waitForFunction(() => document.querySelector('#result')?.textContent === '已保存');
    await section('service'); await page.locator('#backend').selectOption('local');
    assert.equal(await page.locator('#local-idle-unload-enabled').isChecked(), false);
    assert.equal(await page.locator('#local-idle-unload-minutes').inputValue(), '9');
    await page.locator('#local-idle-unload-enabled').check(); await page.locator('#local-idle-unload-minutes').fill('7');
    await page.locator('#backend').selectOption('online'); await save();
    settings = (await rpc({ type: 'settings' })).settings;
    assert.equal(settings.localIdleUnloadEnabled, true); assert.equal(settings.localIdleUnloadMinutes, 7);
    const switched = await rpc({ type: 'save', settings: { ...settings, backend: 'local' } });
    assert.equal(switched.ok, true); assert.equal(switched.settings.concurrency, 3); assert.equal(switched.settings.onlineConcurrency, 8);
    assert.equal((await rpc({ type: 'save', settings })).settings.concurrency, 8);
  });
  await check('retry-sections-toggle-independently-and-preserve-hidden-values', async () => {
    await section('live');
    const platforms = ['bilibili', 'youtube', 'niconico'];
    for (const platform of platforms) await page.locator('#' + platform + '-timeout-retry').uncheck();
    for (const [index, platform] of platforms.entries()) {
      await page.locator('#' + platform + '-timeout-retry').check();
      assert.equal(await page.locator('#' + platform + '-retry-options').isVisible(), true);
      for (const other of platforms.filter(item => item !== platform)) assert.equal(await page.locator('#' + other + '-retry-options').isVisible(), false);
      await page.locator('#' + platform + '-timeout-retry-extra').fill(String(1200 + index * 100));
      await page.locator('#' + platform + '-timeout-retry-mode').selectOption('release');
      await page.locator('#' + platform + '-timeout-retry').uncheck();
      assert.equal(await page.locator('#' + platform + '-retry-options').isVisible(), false);
      assert.equal(await page.locator('#' + platform + '-timeout-retry-extra').isDisabled(), true);
    }
    await save(); await page.reload(); await page.waitForFunction(() => document.querySelector('#result')?.textContent === '已保存');
    await section('live');
    for (const [index, platform] of platforms.entries()) {
      assert.equal(await page.locator('#' + platform + '-timeout-retry').isChecked(), false);
      await page.locator('#' + platform + '-timeout-retry').check();
      assert.equal(await page.locator('#' + platform + '-timeout-retry-extra').inputValue(), String(1200 + index * 100));
      assert.equal(await page.locator('#' + platform + '-timeout-retry-mode').inputValue(), 'release');
      await page.locator('#' + platform + '-timeout-retry').uncheck();
    }
    await section('service');
  });
  await check('daily-limit-zero-and-positive-values-roundtrip', async () => {
    await section('service'); await page.locator('#online-request-limit').fill('12'); await save();
    assert.equal((await rpc({ type: 'settings' })).settings.onlineRequestLimitPerDay, 12);
    await page.locator('#online-request-limit').fill('0'); await save();
    assert.equal((await rpc({ type: 'settings' })).settings.onlineRequestLimitPerDay, 0);
    assert.match(await page.locator('#online-budget-status').textContent(), /不限制/);
  });
  await check('native-target-language-selects-match-all-interface-languages', async () => {
    await section('watching');
    const expected = LOCALES.map(({code, name}) => ({ value: code === 'zh-CN' ? 'zh-Hans' : code === 'zh-TW' ? 'zh-Hant' : code, label: name }));
    const choices = target => target.evaluate(el => [...el.options].filter(option => !option.disabled).map(option => ({ value: option.value, label: option.textContent })));
    const language = page.locator('#target-language');
    assert.equal(await language.evaluate(el => el.tagName), 'SELECT');
    assert.deepEqual(await choices(language), expected);
    assert.equal(await page.locator('#target-language-choices').count(), 0);
    const arrow = async (target, locator) => {
      const box = await locator.boundingBox();
      const rtl = await locator.evaluate(el => getComputedStyle(el).direction === 'rtl');
      await target.mouse.click(rtl ? box.x + 10 : box.x + box.width - 10, box.y + box.height / 2);
    };
    await arrow(page, language);
    await page.waitForFunction(() => document.querySelector('#target-language').matches(':open'));
    const broadcasts = await page.evaluate(() => __settingsUiFixture.broadcasts);
    await rpc({ type: 'toggle', displayMode: 'original' });
    await page.waitForFunction(before => __settingsUiFixture.broadcasts > before, broadcasts);
    assert.equal(await language.evaluate(el => el.matches(':open')), true);
    await arrow(page, language);
    assert.equal(await language.evaluate(el => el.matches(':open')), false, 'a second arrow click closes the options page selector');
    await language.selectOption('uk'); await save();
    assert.equal((await rpc({ type: 'settings' })).settings.targetLanguage, 'uk');

    const popup = await context.newPage(); popup.on('pageerror', error => report.errors.push(error.message));
    await popup.setViewportSize({ width: 360, height: 600 }); await popup.goto(origin + '/popup.html');
    await popup.waitForFunction(() => document.querySelector('#language')?.value === 'uk');
    const quickLanguage = popup.locator('#language');
    assert.equal(await quickLanguage.evaluate(el => el.tagName), 'SELECT');
    assert.deepEqual(await choices(quickLanguage), expected);
    const toggles = await popup.evaluate(() => __settingsUiFixture.calls.filter(type => type === 'toggle').length);
    await arrow(popup, quickLanguage);
    await popup.waitForFunction(() => document.querySelector('#language').matches(':open'));
    const refreshes = await popup.evaluate(() => __settingsUiFixture.overviews);
    await popup.waitForFunction(before => __settingsUiFixture.overviews >= before + 2, refreshes);
    assert.equal(await quickLanguage.evaluate(el => el.matches(':open')), true, 'polling leaves native popup selector open');
    await arrow(popup, quickLanguage);
    assert.equal(await quickLanguage.evaluate(el => el.matches(':open')), false, 'a second arrow click closes the popup selector');
    assert.equal(await popup.evaluate(() => __settingsUiFixture.calls.filter(type => type === 'toggle').length), toggles);
    await quickLanguage.selectOption('pt-BR');
    await page.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: 'settings' })).settings.targetLanguage === 'pt-BR');
    assert.equal(await popup.evaluate(() => __settingsUiFixture.calls.filter(type => type === 'toggle').length), toggles + 1);
    await popup.reload(); await popup.waitForFunction(() => document.querySelector('#language')?.value === 'pt-BR');
    await screenshot('popup-language-select', popup);

    // Seed an existing setting through the background to exercise upgrade compatibility.
    await rpc({ type: 'toggle', targetLanguage: 'Klingon (tlh)' });
    await popup.waitForFunction(() => document.querySelector('#language')?.value === 'Klingon (tlh)');
    await page.waitForFunction(() => document.querySelector('#target-language')?.value === 'Klingon (tlh)');
    for (const control of [language, quickLanguage]) {
      // Inspect the option itself; Playwright isDisabled retargets through its wrapping label.
      assert.equal(await control.locator('option:checked').evaluate(el => el.disabled && el.matches(':disabled')), true);
      assert.deepEqual(await choices(control), expected);
    }
    await popup.locator('#mode').selectOption('translated');
    await page.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: 'settings' })).settings.displayMode === 'translated');
    assert.equal((await rpc({ type: 'settings' })).settings.targetLanguage, 'Klingon (tlh)', 'unrelated actions preserve a legacy target');
    await quickLanguage.selectOption('ja');
    await page.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: 'settings' })).settings.targetLanguage === 'ja');
    await page.waitForFunction(() => document.querySelector('#target-language')?.value === 'ja');
    assert.equal(await quickLanguage.locator('option').count(), 20);
    assert.equal(await language.locator('option').count(), 20);
    await popup.close();
    await page.reload(); await page.waitForFunction(() => document.querySelector('#target-language')?.value === 'ja');
  });
  await check('popup-theme-icon-cycles-persists-and-keeps-settings-in-place', async () => {
    await page.locator('#theme').selectOption('system');
    const before = (await rpc({ type: 'settings' })).settings;
    const popup = await context.newPage(); popup.on('pageerror', error => report.errors.push(error.message));
    await popup.setViewportSize({ width: 360, height: 600 });
    await popup.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
    await popup.goto(origin + '/popup.html');
    const theme = popup.locator('#theme');
    await popup.waitForFunction(() => document.querySelector('#theme')?.dataset.themePreference === 'system');
    assert.equal(await theme.evaluate(el => el.tagName), 'BUTTON');
    assert.equal(await popup.locator('#ui-locale').count(), 0);
    assert.equal(await popup.locator('.popup-toolbar #settings').count(), 1);
    const toolbar = await popup.locator('.popup-toolbar').boundingBox();
    const fields = await popup.locator('.popup-field-grid').boundingBox();
    assert.ok(toolbar.y + toolbar.height <= fields.y);
    const waitPreference = value => popup.waitForFunction(async value => {
      const stored = await chrome.storage.local.get('ui.preferences.v1');
      return document.querySelector('#theme').dataset.themePreference === value && stored['ui.preferences.v1']?.theme === value;
    }, value);
    await screenshot('popup-theme-system', popup);
    await theme.click(); await waitPreference('light');
    await theme.evaluate(async el => { await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished)); });
    await screenshot('popup-theme-light', popup);
    await theme.focus(); await popup.keyboard.press('Space'); await waitPreference('dark');
    await theme.evaluate(async el => { await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished)); });
    assert.equal(await theme.locator('.theme-icon-dark').evaluate(el => getComputedStyle(el).opacity), '1');
    assert.equal(await theme.locator('.theme-icon-light').evaluate(el => getComputedStyle(el).opacity), '0');
    await screenshot('popup-theme-dark', popup);
    await popup.reload(); await waitPreference('dark');
    await theme.focus(); await popup.keyboard.press('Enter'); await waitPreference('system');
    await popup.emulateMedia({ colorScheme: 'dark' });
    await popup.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    assert.equal(await theme.getAttribute('data-theme-preference'), 'system', 'auto keeps its system icon when system colors change');
    await popup.emulateMedia({ colorScheme: 'light' });
    await popup.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    // Multiple activations during the same transition must keep the last choice.
    await theme.evaluate(el => { el.click(); el.click(); el.click(); el.click(); el.click(); });
    await waitPreference('dark');
    await popup.reload(); await waitPreference('dark');
    await popup.emulateMedia({ reducedMotion: 'reduce' });
    await theme.click(); await waitPreference('system');
    assert.equal(await theme.locator('.theme-icon-system').evaluate(el => getComputedStyle(el).transform), 'none');
    assert.equal(await theme.locator('.theme-icon-system').evaluate(el => getComputedStyle(el).transitionProperty), 'opacity');
    assert.deepEqual((await rpc({ type: 'settings' })).settings, before);
    assert.equal(await popup.evaluate(() => __settingsUiFixture.calls.filter(type => type === 'toggle').length), 0);
    await popup.close();
  });
  await check('compact-popup-and-settings-locales-themes-and-zoom', async () => {
    const popup = await context.newPage(); popup.on('pageerror', error => report.errors.push(error.message));
    await popup.goto(origin + '/popup.html'); await popup.locator('#language').waitFor();
    for (const code of ['zh-CN', 'en', 'de', 'ar']) {
      await page.locator('#ui-locale').selectOption(code);
      await popup.waitForFunction(code => document.documentElement.lang === code, code);
      for (const width of [360, 320]) {
        await popup.setViewportSize({ width, height: 600 });
        for (const scenario of ['video', 'live']) {
          const before = await popup.evaluate(scenario => {
            __settingsUiFixture.status = { state: 'ready', scenario, platform: 'youtube', connection: 'connected', coverage: 'all',
              recentEligible: 100, recentTranslated: 93, translated: 93, timedOut: 2, overloaded: 0, prepared: 93, messages: 100, nearPrepared: 8, nearTotal: 10, queued: 7 };
            return __settingsUiFixture.overviews;
          }, scenario);
          await popup.waitForFunction(before => __settingsUiFixture.overviews > before, before);
          assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, code + '/' + width + '/' + scenario + ' width');
          assert.equal(await popup.evaluate(() => document.querySelector('main').getBoundingClientRect().bottom <= innerHeight), true, code + '/' + width + '/' + scenario + ' height');
        }
      }
      const theme = code === 'ar' || code === 'de' ? 'dark' : 'light';
      await page.locator('#theme').selectOption(theme);
      await popup.waitForFunction(theme => document.querySelector('#theme').dataset.themePreference === theme, theme);
      await popup.locator('#theme').evaluate(async el => { await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished)); });
      await screenshot('compact-popup-' + code, popup);
      await popup.evaluate(() => { document.documentElement.style.zoom = '1.25'; });
      assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, code + ' zoom width');
      assert.equal(await popup.evaluate(() => document.querySelector('#settings').getBoundingClientRect().bottom <= innerHeight), true, code + ' zoom controls');
      await popup.evaluate(() => { document.documentElement.style.zoom = ''; });
      await page.setViewportSize({ width: 1280, height: 720 }); await section('live');
      await screenshot('compact-live-' + code);
      await page.setViewportSize({ width: 360, height: 800 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, code + ' settings width');
      await screenshot('compact-live-narrow-' + code);
    }
    await popup.close(); await page.locator('#ui-locale').selectOption('zh-CN'); await page.locator('#theme').selectOption('light');
  });
  await check('changed-settings-fit-narrow-screen', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await section('live'); await screenshot('live-narrow');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await openRequestSettings(); await screenshot('concurrency-narrow');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  });
  assert.deepEqual(report.errors, []); report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL'; report.errors.push(error.stack ?? String(error)); process.exitCode = 1;
} finally {
  await context?.close();
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log('REPORT', resolve(directory, 'report.json'));
}
