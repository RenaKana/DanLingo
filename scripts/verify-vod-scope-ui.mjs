// Current-source isolated extension and offline VOD controls; never visits a platform or personal browser profile.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build as buildExtension } from 'wxt';
import { loadPlaywright, browserLaunchOptions } from './browser-runtime.mjs';
import { settingsSection } from './settings-navigation.mjs';
import { catalogs } from '../src/i18n/catalogs.ts';

const root = resolve('.artifacts/vod-scope-ui'); await mkdir(root, { recursive: true });
const run = await mkdtemp(resolve(root, 'run-'));
const report = { evidence: 'ISOLATED_CURRENT_SOURCE_EXTENSION_OFFLINE_UI', checks: [], screenshots: [], errors: [],
  limitations: ['Mock extension permission and fixture.invalid endpoint; no provider, native platform, or personal extension profile.'] };
const screenshot = async (locator, name) => {
  const path = resolve(run, name + '.png'); await locator.screenshot({ path }); report.screenshots.push(path);
};
let context;
try {
  const extension = resolve(run, 'extension');
  if (process.env.DANLINGO_TEST_EXTENSION) {
    await cp(resolve(process.env.DANLINGO_TEST_EXTENSION), extension, { recursive: true });
  } else {
    const output = resolve(run, 'build'); await mkdir(output, { recursive: true });
    await buildExtension({ root: process.cwd(), outDir: output });
    await cp(resolve(output, 'chrome-mv3'), extension, { recursive: true });
  }
  const manifestFile = resolve(extension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.host_permissions.push('https://fixture.invalid/*');
  await writeFile(manifestFile, JSON.stringify(manifest));
  const requireWxt = createRequire(import.meta.resolve('wxt'));
  const { build: buildFixture } = await import(pathToFileURL(requireWxt.resolve('vite')).href);
  await buildFixture({ configFile: false, logLevel: 'error', build: { outDir: extension, emptyOutDir: false, minify: false,
    lib: { entry: resolve('scripts/vod-scope-widget-fixture.ts'), formats: ['es'], fileName: () => 'vod-scope-widget-fixture.js' } } });
  await writeFile(resolve(extension, 'vod-scope-widget-fixture.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><style>body{margin:24px;max-width:760px;font:14px sans-serif}.PlayerPresenter{height:140px;background:#eee}.PlayerPresenter video{width:100%;height:140px}</style><body><div class="PlayerPresenter"><div data-danlingo-player="fixture-video"><video></video></div></div><script type="module" src="vod-scope-widget-fixture.js"></script>');

  const { chromium } = await loadPlaywright();
  context = await chromium.launchPersistentContext(resolve(run, 'profile'), {
    headless: true, ...browserLaunchOptions('chromium'), channel: 'chromium', locale: 'zh-CN', viewport: { width: 1100, height: 850 },
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--disable-background-networking', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND'],
  });
  context.setDefaultTimeout(15000); context.setDefaultNavigationTimeout(20000);
  await context.route(/^https?:/, route => route.abort());
  await context.addInitScript(() => { if (globalThis.chrome?.runtime?.id) chrome.permissions.request = async () => true; });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const origin = 'chrome-extension://' + new URL(worker.url()).host;
  await worker.evaluate(() => chrome.storage.local.set({ 'ui.locale.v1': 'zh-CN' }));
  const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(origin + '/options.html');
  await page.waitForFunction(() => document.querySelector('#result')?.textContent === '已保存');
  const rpcSettings = async () => (await page.evaluate(() => chrome.runtime.sendMessage({ type: 'settings' }))).settings;
  const save = async () => {
    await page.locator('#save').click();
    await page.waitForFunction(() => !document.querySelector('#save').disabled && document.querySelector('#result')?.textContent === '已保存');
  };
  const reload = async () => {
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#result')?.textContent === '已保存');
  };
  const watching = () => settingsSection(page, 'watching');
  const advanced = async () => {
    await settingsSection(page, 'advanced');
    const details = page.locator('#video-batch-size').locator('xpath=ancestor::details[1]');
    if (!await details.evaluate(el => el.open)) await details.locator(':scope > summary').click();
  };
  const values = async (scope, seconds) => {
    await watching();
    assert.equal(await page.locator('#translation-scope').inputValue(), scope);
    assert.equal(await page.locator('#prefetch').inputValue(), String(seconds));
    assert.equal(await page.locator('#prefetch').isVisible(), scope !== 'all');
    await advanced();
    assert.equal(await page.locator('#video-batch-size').inputValue(), '20');
    assert.equal(await page.locator('#batch-size').inputValue(), '100');
  };

  const defaults = await rpcSettings();
  assert.equal(defaults.translationScope, 'auto'); assert.equal(defaults.videoBatchSize, 20);
  await values('auto', 60);
  report.checks.push('new-install-auto-scope-and-separate-video-batch-default');
  await watching(); await screenshot(page.locator('[data-section="watching"]'), 'settings-zh-auto');
  await settingsSection(page, 'service');
  await page.locator('#endpoint').fill('https://fixture.invalid/v1');
  await page.locator('#model').fill('fixture-model');
  await advanced(); await screenshot(page.locator('#video-batch-size').locator('xpath=ancestor::details[1]'), 'batch-zh');
  await save(); await reload(); await values('auto', 60);
  report.checks.push('auto-and-video-batch-20-save-reload');

  await watching(); await page.locator('#translation-scope').selectOption('window');
  await page.locator('#prefetch').fill('90'); await save(); await reload(); await values('window', 90);
  assert.equal((await rpcSettings()).translationScope, 'window');
  report.checks.push('window-90-save-reload');
  await watching(); await page.locator('#translation-scope').selectOption('all'); await save(); await reload(); await values('all', 90);
  assert.equal((await rpcSettings()).translationScope, 'all');
  report.checks.push('full-pool-save-reload-and-window-control-hidden');
  await watching(); await page.locator('#translation-scope').selectOption('auto'); await save(); await reload(); await values('auto', 90);
  await page.locator('#ui-locale').selectOption('en');
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  await watching(); await screenshot(page.locator('[data-section="watching"]'), 'settings-en-auto');
  await advanced(); await screenshot(page.locator('#video-batch-size').locator('xpath=ancestor::details[1]'), 'batch-en');
  assert.match(await page.locator('#video-batch-size').locator('xpath=ancestor::label[1]').innerText(), /Online video messages/);
  report.checks.push('english-settings-labels-and-collapsed-layout');

  const widget = await context.newPage(); widget.on('pageerror', error => report.errors.push(error.message));
  await widget.goto(origin + '/vod-scope-widget-fixture.html');
  await widget.waitForFunction(() => !!window.__vodFixture && !!document.querySelector('#danlingo-progress'));
  for (const [code, summaryText, coverageText] of [
    ['en', 'Prepared 7 / 10', 'Loaded candidates 24'],
    ['zh-CN', '已准备 7 / 10', '已加载候选 24'],
  ]) {
    await page.evaluate(code => chrome.storage.local.set({ 'ui.locale.v1': code }), code);
    await widget.waitForFunction(code => document.querySelector('#danlingo-progress').lang === code, code);
    const host = widget.locator('#danlingo-progress');
    const details = host.locator('#progress-details');
    const summary = host.locator('#progress-details > summary');
    const arrow = summary.locator('svg.expand-chevron');
    const assertArrow = async expectedAngle => {
      const state = await arrow.evaluate(async element => {
        const motions = element.getAnimations().filter(animation => animation.playState === 'running');
        if (motions.length) await Promise.all(motions.map(animation => animation.finished.catch(() => {})));
        const icon = element.getBoundingClientRect(), row = element.parentElement.getBoundingClientRect();
        const glyph = element.querySelector('path')?.getBBox();
        const transform = getComputedStyle(element).transform;
        const matrix = transform === 'none' ? null : new DOMMatrixReadOnly(transform);
        const angle = matrix ? ((Math.round(Math.atan2(matrix.b, matrix.a) * 180 / Math.PI) % 360) + 360) % 360 : 0;
        return { width: icon.width, height: icon.height, centerDelta: Math.abs((icon.top + icon.bottom - row.top - row.bottom) / 2),
          glyphWidth: glyph?.width, glyphCenterDelta: glyph ? Math.abs(glyph.x + glyph.width / 2 - 8) : Infinity, angle };
      });
      assert.ok(Math.abs(state.width - 16) <= 0.5, `Chevron view box width ${state.width} should be 16px`);
      assert.ok(Math.abs(state.height - 16) <= 0.5, `Chevron view box height ${state.height} should be 16px`);
      assert.ok(Math.abs(state.glyphWidth - 10) <= 0.5, `Chevron visible width ${state.glyphWidth} should be 10px`);
      assert.ok(state.glyphCenterDelta <= 0.5, `Chevron visible horizontal center delta ${state.glyphCenterDelta}px should be at most 0.5px`);
      assert.ok(state.centerDelta <= 1, `Chevron vertical center delta ${state.centerDelta}px should be at most 1px`);
      assert.ok(Math.min((state.angle - expectedAngle + 360) % 360, (expectedAngle - state.angle + 360) % 360) <= 2,
        `Chevron angle ${state.angle}deg should be ${expectedAngle}deg`);
    };
    assert.equal(await host.locator('#dismiss-progress').count(), 0, 'Progress no longer has a separate dismiss button');
    assert.equal(await host.locator('#restore-progress').count(), 0, 'Progress no longer has a restore button');
    assert.equal(await details.evaluate(el => el.open), false);
    assert.equal(await arrow.count(), 1);
    await assertArrow(0);
    assert.match(await summary.innerText(), new RegExp(summaryText));
    assert.equal(await host.locator('#progress-details .body').isVisible(), false);
    assert.equal(await host.locator('#native-supply-host').isVisible(), false);
    if (code === 'zh-CN') await screenshot(host, 'progress-collapsed-default');
    await summary.click();
    assert.equal(await details.evaluate(el => el.open), true);
    await assertArrow(180);
    assert.match(await host.locator('#coverage').innerText(), new RegExp(coverageText));
    assert.match(await host.locator('#filtered').innerText(), /3/);
    assert.match(await host.locator('#skipped').innerText(), /2/);
    assert.match(await host.locator('#native-stage').innerText(), /5/);
    assert.match(await host.locator('#native-stage').innerText(), /2/);
    assert.equal(await host.locator('#window-seconds').inputValue(), '5');
    assert.equal(await host.locator('#native-supply-host').isVisible(), true);
    assert.equal(await host.locator('#native-supply-reason').innerText(), catalogs[code]['m_0b8707b8d4ba']);
    assert.equal(await host.locator('#hybrid-details').isVisible(), true);
    assert.equal(await host.locator('#hybrid-details details').count(), 0, 'Planning statistics share the outer progress disclosure');
    assert.equal((await host.locator('#hybrid-local-requests').innerText()).trim(), '4');
    assert.equal((await host.locator('#hybrid-online-requests').innerText()).trim(), '2');
    await screenshot(host, 'progress-' + code);
    if (code === 'en') {
      const before = await widget.evaluate(() => window.__vodFixture.state());
      for (const language of ['de', 'ja', 'ar', 'zh-TW', 'en']) {
        await page.evaluate(language => chrome.storage.local.set({ 'ui.locale.v1': language }), language);
        await widget.waitForFunction(language => document.querySelector('#danlingo-progress').lang === language, language);
        assert.equal(await host.locator('#native-supply-reason').innerText(), catalogs[language]['m_0b8707b8d4ba']);
        assert.equal(await details.evaluate(el => el.open), true);
        assert.deepEqual(await widget.evaluate(() => window.__vodFixture.state()), before);
        assert.equal(await host.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, language);
        await screenshot(host, 'progress-localized-' + language);
      }
      report.checks.push('advance-plan-status-switches-language-without-reinitialization');
    }
    if (code === 'zh-CN') {
      await widget.setViewportSize({ width: 390, height: 850 });
      assert.equal(await host.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true,
        'Expanded progress details must fit a narrow viewport');
      await screenshot(host, 'progress-expanded-mobile');
      await widget.setViewportSize({ width: 1100, height: 850 });
    }
    await widget.evaluate(() => window.__vodFixture.hidden());
    assert.match(await host.locator('#scope-state').innerText(), code === 'en' ? /hidden.*paused/ : /隐藏.*暂停/);
    await screenshot(host, 'progress-hidden-' + code);
    await widget.evaluate(() => window.__vodFixture.show());
    await summary.click();
    assert.equal(await details.evaluate(el => el.open), false);
    if (code === 'zh-CN') {
      const updatedPrepared = await widget.evaluate(() => window.__vodFixture.updateProgress());
      assert.equal(updatedPrepared, 8);
      assert.equal(await details.evaluate(el => el.open), false, 'Progress updates must not auto-expand details');
      assert.match(await summary.innerText(), /已准备 8 \/ 10/);
      await screenshot(host, 'progress-collapsed-updated');
      await summary.click();
      assert.equal(await details.evaluate(el => el.open), true);
      await widget.keyboard.press('Escape');
      assert.equal(await details.evaluate(el => el.open), false, 'Escape must collapse the whole progress detail panel');
      await assertArrow(0);
      await screenshot(host, 'progress-collapsed-escape');
      await summary.click();
      assert.equal(await details.evaluate(el => el.open), true, 'Details must be expandable again after Escape');
      await assertArrow(180);
      assert.equal(await host.locator('#native-supply-host').isVisible(), true);
      assert.equal(await host.locator('#hybrid-details').isVisible(), true);
      await screenshot(host, 'progress-expanded-again');
      await summary.click();
      assert.equal(await details.evaluate(el => el.open), false, 'Clicking the progress summary again must collapse all details');
      await assertArrow(0);
      await screenshot(host, 'progress-collapsed-again');

      await summary.click();
      await host.locator('#scope').selectOption('window');
      await widget.waitForFunction(() => window.__vodFixture?.state().saves.length === 1);
      await host.locator('#window-seconds').fill('75');
      await host.locator('#apply-window').click();
      await widget.waitForFunction(() => window.__vodFixture?.state().saves.some(row => row.scope === 'window' && row.seconds === 75));
      assert.equal(await host.locator('#window-seconds').inputValue(), '75');
      await host.locator('#retry').click();
      assert.equal((await widget.evaluate(() => window.__vodFixture?.state())).retries, 1);
      const width = await host.evaluate(element => element.getBoundingClientRect().width);
      assert.ok(width <= 640, `progress width ${width} should stay within the 640px cap`);
      report.checks.push('progress-window-save-retry');
    }
    report.checks.push('progress-collapsed-details-native-counts-and-hidden-pause-' + code);
  }
  assert.deepEqual(report.errors, []);
  report.status = 'PASS';
} catch (error) { report.status = 'FAIL'; report.errors.push(error.stack ?? String(error)); process.exitCode = 1; }
finally {
  await context?.close();
  await writeFile(resolve(run, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, checks: report.checks, screenshots: report.screenshots, report: resolve(run, 'report.json'), errors: report.errors }));
}

