// Isolated extension/browser fixtures. Never reads a personal browser or calls a provider.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { browserLaunchOptions, loadPlaywright } from './browser-runtime.mjs';
import { DEFAULT_SETTINGS } from '../src/core/config.ts';
import { LOCALES } from '../src/i18n/locale.ts';
import { catalogs } from '../src/i18n/catalogs.ts';
import { normalizeLocalConfig } from '../src/local/config.ts';
import { aggregateLocalBenchmark } from '../src/local/benchmark.ts';
const checkedLocales = process.env.DANLINGO_I18N_LOCALE ? LOCALES.filter(item => item.code === process.env.DANLINGO_I18N_LOCALE) : LOCALES;
const textOnly = process.env.DANLINGO_I18N_TEXT_ONLY === '1';
assert.ok(checkedLocales.length, 'Requested locale must be supported');
const benchmarkSamples = [{ id: 'fixture-sample', workload: 'short', admittedAt: 0, startedAt: 10, finishedAt: 100, status: 'success', queueMs: 10 }];
const fixtureReports = {
  performance: { id: 'fixture-performance', state: 'completed', backend: 'online', model: 'fixture-model',
    config: { count: 10, mode: 'latency', strategy: 'normal' }, completed: 10, planned: 10, actualRequests: 10, successRequests: 10,
    meanMs: 100, p50Ms: 100, p95Ms: 100, successRate: 1, failed: 0, timeout: 0, cancelled: 0, unsent: 0,
    throughput: 10, firstRequestMs: 100, stableMeanMs: 100, usageReports: 0, samples: [], jobs: [] },
  benchmark: { id: 'fixture-benchmark', modelId: 'fixture-gguf', startedAt: 1, status: 'completed', phase: 'done', options: { workloads: ['short'] },
    groups: [{ variantId: 'fixture-variant', name: 'fixture-variant', workload: 'short', config: normalizeLocalConfig(), status: 'completed',
      expected: 1, completed: 1, samples: benchmarkSamples, stats: aggregateLocalBenchmark(benchmarkSamples) }], corpusTokens: [], recommendation: {} },
};
const root = resolve('.artifacts/i18n-browser'); await mkdir(root, { recursive: true });
const run = await mkdtemp(resolve(root, 'run-'));
const report = { evidence: 'ISOLATED_BUILT_EXTENSION_WITH_OFFLINE_FIXTURES', scope: textOnly ? 'TEXT_AND_PRIMARY_LAYOUT_REGRESSION' : 'FULL_UI_REGRESSION', locales: checkedLocales.map(item => item.code), checks: [], screenshots: [], errors: [] };
let context;
try {
  const extension = resolve(run, 'extension'); await cp(resolve(process.env.DANLINGO_TEST_EXTENSION || '.output/chrome-mv3'), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions.push('https://fixture.invalid/*'); await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
  const requireWxt = createRequire(import.meta.resolve('wxt'));
  const { build } = await import(pathToFileURL(requireWxt.resolve('vite')).href);
  await build({ configFile: false, logLevel: 'error', build: { outDir: extension, emptyOutDir: false, minify: false,
    lib: { entry: resolve('scripts/i18n-widget-fixture.ts'), formats: ['es'], fileName: () => 'i18n-widget-fixture.js' } } });
  await writeFile(resolve(extension, 'i18n-widget-fixture.html'), '<!doctype html><html lang="en" dir="ltr"><meta charset="utf-8"><style>body{margin:24px;max-width:760px}section{margin-bottom:32px}video{display:block;width:100%;height:90px;background:#eee}</style><body><p id="site-copy">Website content stays LTR 日本語</p><section><div id="live-player"><video></video></div></section><section><div data-danlingo-player="fixture-video"><video></video></div></section><div id="chat-items"><div class="chat-item danmaku-item" data-id_str="123456789"><span class="danmaku-item-right">Native original 日本語</span></div></div><script type="module" src="i18n-widget-fixture.js"></script>');
  const { chromium } = await loadPlaywright();
  context = await chromium.launchPersistentContext(resolve(run, 'profile'), {
    headless: true, ...browserLaunchOptions('chromium'), locale: 'en-US', viewport: { width: 1360, height: 900 },
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--disable-background-networking', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND'],
  });
  context.setDefaultTimeout(15000); context.setDefaultNavigationTimeout(20000);
  await context.route(/^https?:/, route => route.abort());
  await context.addInitScript(fixtureReports => {
    if (!globalThis.chrome?.runtime?.id) return;
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    const fixtureModel = { id: 'fixture-gguf', name: 'Fixture.gguf', files: ['Fixture.gguf'], bytes: 1048576, architecture: 'llama', quantization: 'Q4_K', tokenizer: 'llama', template: true, importedAt: 1,
      source: { kind: 'directory', directoryId: 'fixture-directory', directoryName: 'Fixture folder', files: [{ path: 'Fixture.gguf', size: 1048576, lastModified: 1 }] } };
    const fixture = globalThis.__i18nFixture = { calls: [], deleteCalls: [], models: [fixtureModel], holdTest: false, releaseTest: null };
    // Host consent UI belongs to native-browser acceptance, not this isolated UI fixture.
    chrome.permissions.request = async () => true;
    chrome.runtime.sendMessage = async (message, ...rest) => {
      fixture.calls.push(message.type);
      if (message.type === 'performance-status') return { ok: true, report: fixtureReports.performance };
      if (message.type === 'local-control' && message.control?.action === 'benchmark-status') return { ok: true, report: fixtureReports.benchmark };
      if (message.type === 'local-control' && message.control?.action === 'delete') {
        fixture.deleteCalls.push(message.control.modelId);
        fixture.models = fixture.models.filter(model => model.id !== message.control.modelId);
        return { ok: true, models: fixture.models, settings: { localModelId: '' }, state: { phase: 'idle', backend: 'wllama', active: 0, queued: 0, completed: 0, failed: 0, cancelled: 0 } };
      }
      if (message.type === 'local-control' && message.control?.action === 'list') return {
        ok: true, models: fixture.models,
        directories: [{ id: 'fixture-directory', name: 'Fixture folder', addedAt: 1, revision: 1, status: 'permission-required', error: 'LOCAL_DIRECTORY_PERMISSION_REQUIRED' }],
        state: { phase: 'idle', backend: 'wllama', active: 0, queued: 0, completed: 0, failed: 0, cancelled: 0 },
      };
      if (message.type === 'test-model') {
        if (fixture.holdTest) await new Promise(done => fixture.releaseTest = done);
        return { ok: true, model: message.settings.model, elapsedMs: 100, sourceText: 'original fixture text', text: 'unchanged translated fixture' };
      }
      return original(message, ...rest);
    };
  }, fixtureReports);
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const origin = 'chrome-extension://' + new URL(worker.url()).host;
  const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(origin + '/options.html'); await page.locator('#ui-locale').waitFor();
  const rpc = message => page.evaluate(message => chrome.runtime.sendMessage(message), message);
  const configured = await rpc({ type: 'save', settings: { ...DEFAULT_SETTINGS, endpoint: 'https://fixture.invalid/v1', model: 'fixture-model', profile: 'chat-completions', thinkingEffort: 'default' }, apiKey: 'i18n-fixture-key', remember: false });
  assert.equal(configured.ok, true, configured.error); await page.reload(); await page.locator('#ui-locale').waitFor();
  await page.waitForFunction(() => document.querySelector('#model').value === 'fixture-model');
  const initial = await rpc({ type: 'overview' });
  await page.locator('#model').fill('unsaved-model'); await page.locator('#api-key').fill('unsaved-fixture-secret');
  await page.locator('#model').focus();
  const callsBefore = await page.evaluate(() => __i18nFixture.calls.filter(type => ['save', 'toggle', 'test-model', 'delete-key'].includes(type)).length);
  const setLanguage = async code => {
    await page.evaluate(code => chrome.storage.local.set({ 'ui.locale.v1': code }), code);
    await page.waitForFunction(code => document.documentElement.lang === code, code);
  };
  const screen = async (target, name) => { const path = resolve(run, name + '.png'); await target.screenshot({ path, fullPage: true }); report.screenshots.push(path); };
  const checkMarkedText = async (target, code) => {
    const mismatches = await target.evaluate(catalog => {
      const roots = [document];
      const collect = root => { for (const el of root.querySelectorAll('*')) if (el.shadowRoot) { roots.push(el.shadowRoot); collect(el.shadowRoot); } }; collect(document);
      const errors = [];
      for (const root of roots) for (const el of root.querySelectorAll('[data-i18n],[data-i18n-title],[data-i18n-placeholder],[data-i18n-aria-label]')) {
        for (const attr of ['', 'title', 'placeholder', 'aria-label']) {
          const key = el.getAttribute('data-i18n' + (attr ? '-' + attr : '')); if (!key) continue;
          const actual = attr ? el.getAttribute(attr) : el.textContent;
          if (actual !== catalog[key]) errors.push({ key, attr, actual, expected: catalog[key] });
        }
      }
      return errors;
    }, catalogs[code]);
    assert.deepEqual(mismatches, [], code + ' static text/attributes match catalog');
  };
  for (const { code, dir } of checkedLocales) {
    await setLanguage(code);
    assert.equal(await page.locator('html').getAttribute('dir'), dir);
    assert.equal(await page.locator('#model').inputValue(), 'unsaved-model');
    assert.equal(await page.locator('#api-key').inputValue(), 'unsaved-fixture-secret');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'model');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, code + ' desktop overflow');
    const untranslated = await page.evaluate(() => [...document.querySelectorAll('[data-i18n]')].filter(el => /^m_[a-f0-9]+$/.test(el.textContent.trim())).map(el => el.getAttribute('data-i18n')));
    assert.deepEqual(untranslated, [], code + ' unresolved message keys');
    await checkMarkedText(page, code);
    assert.equal(await page.locator('#thinking-effort option:checked').textContent(), catalogs[code].m_02c99682f183);
    if (['en', 'de', 'ja', 'hi', 'ar'].includes(code)) await screen(page, 'settings-' + code);
    report.checks.push('settings-' + code);
  }
  const after = await rpc({ type: 'overview' });
  assert.deepEqual(after.settings, initial.settings); assert.equal(after.configVersion, initial.configVersion);
  assert.equal(await page.evaluate(() => __i18nFixture.calls.filter(type => ['save', 'toggle', 'test-model', 'delete-key'].includes(type)).length), callsBefore);
  report.checks.push('all-languages-preserve-draft-focus-config-and-no-business-actions');

  const popup = await context.newPage(), models = await context.newPage();
  for (const target of [popup, models]) target.on('pageerror', error => report.errors.push(error.message));
  await popup.goto(origin + '/popup.html'); await models.goto(origin + '/model-folders.html');
  for (const { code, dir } of checkedLocales) {
    await setLanguage(code);
    for (const target of [popup, models]) {
      await target.waitForFunction(code => document.documentElement.lang === code, code);
      assert.equal(await target.locator('html').getAttribute('dir'), dir);
      assert.equal(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, code + ' companion overflow');
    }
    if (['en', 'de', 'ja', 'hi', 'ar'].includes(code)) { await screen(popup, 'popup-' + code); await screen(models, 'model-sources-' + code); }
    report.checks.push('cross-page-' + code);
  }
  await page.setViewportSize({ width: 360, height: 800 });
  for (const code of ['en', 'de', 'ja', 'hi', 'ar']) {
    await setLanguage(code);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, code + ' narrow overflow');
    await screen(page, 'narrow-' + code);
  }
  report.checks.push('representative-narrow-layouts');
  await page.setViewportSize({ width: 1360, height: 900 });
  console.log('i18n: starting held model test');
  await page.evaluate(() => { __i18nFixture.holdTest = true; }); await page.locator('#test-model').click();
  console.log('i18n: waiting for held request');
  try { await page.waitForFunction(() => !!__i18nFixture.releaseTest); }
  catch (error) { report.runningTaskFailure = await page.evaluate(() => ({ result: document.querySelector('#result')?.textContent, status: document.querySelector('#test-model-result')?.textContent, calls: __i18nFixture.calls, errors: [...document.querySelectorAll('.error')].map(el => el.textContent) })); throw error; }
  await setLanguage('en'); await setLanguage('ar');
  console.log('i18n: switched during held request');
  assert.equal(await page.locator('#test-model').isDisabled(), true);
  assert.equal(await page.locator('#model').inputValue(), 'unsaved-model');
  await page.evaluate(() => { __i18nFixture.holdTest = false; __i18nFixture.releaseTest(); });
  console.log('i18n: released held request');
  await page.waitForFunction(() => !document.querySelector('#test-model').disabled);
  assert.equal((await rpc({ type: 'overview' })).configVersion, initial.configVersion);
  report.checks.push('locale-switch-preserves-running-model-test');
  if (!textOnly) {
  for (const { code } of checkedLocales) {
    await setLanguage(code);
    for (const section of ['watching', 'live', 'performance', 'advanced', 'data', 'service']) {
      await page.locator('.sidebar nav a[href="#' + section + '"]').click();
      await page.locator('[data-section="' + section + '"]').waitFor({ state: 'visible' });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, code + '/' + section + ' overflow');
      if (section === 'data') {
        await page.locator('#delete-key').click();
        assert.equal(await page.locator('#delete-key-confirm').isVisible(), true);
        await checkMarkedText(page, code);
        await page.locator('[data-dismiss="delete-key"]').click();
      }
      if (['de', 'ar'].includes(code)) await screen(page, section + '-' + code);
    }
    report.checks.push('all-settings-sections-' + code);
    console.log('i18n: sections checked ' + code);
  }
  await page.locator('#backend').selectOption('local');
  await page.evaluate(() => { location.hash = 'performance'; });
  const group = page.locator('#lb-results details').first();
  await group.locator('summary').click();
  await page.locator('#lb-count').fill('17'); await page.locator('#lb-count').focus();
  await setLanguage('ja'); await setLanguage('de');
  assert.equal(await group.evaluate(el => el.open), true);
  assert.equal(await page.locator('#lb-count').inputValue(), '17');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'lb-count');
  assert.equal(await page.locator('#lb-results summary').count(), 1);
  assert.match(await page.locator('#lb-results').innerText(), /fixture-variant/);
  report.checks.push('performance-report-preserves-expanded-groups-drafts-and-focus');
  for (const { code } of checkedLocales) {
    await setLanguage(code);
    for (const section of ['service', 'performance', 'advanced']) {
      await page.evaluate(section => { location.hash = section; }, section);
      await page.locator('[data-section="' + section + '"]').waitFor({ state: 'visible' });
      await checkMarkedText(page, code);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (section === 'service') {
        await page.locator('#local-model-manager').evaluate(el => { el.open = true; });
        if (['en', 'de', 'ja', 'hi', 'ar'].includes(code)) await screen(page, 'local-model-' + code);
      }
    }
    report.checks.push('local-model-settings-' + code);
    console.log('i18n: local panels checked ' + code);
  }
  await page.evaluate(() => { location.hash = 'service'; });
  await page.locator('[data-section="service"]').waitFor({ state: 'visible' });
  await page.locator('[data-model-id="fixture-gguf"] [data-model-action="remove"]').click();
  await page.locator('[data-model-id="fixture-gguf"]').waitFor({ state: 'detached' });
  assert.equal(await page.locator('#local-delete-confirm').count(), 0);
  assert.deepEqual(await page.evaluate(() => __i18nFixture.deleteCalls), ['fixture-gguf']);
  await screen(page, 'local-model-removed');
  report.checks.push('local-model-single-click-removal');
  await page.locator('#ui-locale').selectOption('ja'); await popup.waitForFunction(() => document.documentElement.lang === 'ja');
  await popup.reload(); await popup.waitForFunction(() => document.documentElement.lang === 'ja');
  await page.locator('#ui-locale').selectOption('auto'); await popup.waitForFunction(() => document.documentElement.lang === 'en');
  report.checks.push('manual-preference-persists-and-auto-restores-browser-language');
  const widgets = await context.newPage(); widgets.on('pageerror', error => report.errors.push(error.message));
  await widgets.goto(origin + '/i18n-widget-fixture.html');
  await widgets.waitForFunction(() => !!window.__widgetFixture);
  for (const { code, dir } of checkedLocales) {
    await setLanguage(code);
    await widgets.waitForFunction(code => document.querySelector('#danlingo-live-status').shadowRoot.querySelector('#danlingo-live-repairs').lang === code, code);
    for (const host of ['#danlingo-live-status', '#danlingo-progress']) assert.equal(await widgets.locator(host).getAttribute('dir'), dir);
    await checkMarkedText(widgets, code);
    assert.equal(await widgets.locator('html').getAttribute('dir'), 'ltr');
    assert.equal(await widgets.locator('.danmaku-item-right').innerText(), 'Native original 日本語');
    await widgets.locator('#danlingo-progress summary').click();
    if (['en', 'de', 'ja', 'hi', 'ar'].includes(code)) await screen(widgets, 'widgets-' + code);
    await widgets.locator('#danlingo-progress summary').click();
    report.checks.push('injected-widgets-and-page-isolation-' + code);
  }
  // The summary also contains a one-click repair action; open it through its label.
  await widgets.locator('#danlingo-live-repairs .summary-title').click();
  const repairRow = widgets.locator('[data-source-id="original"]');
  await repairRow.locator('button').first().click();
  const runningCalls = await widgets.evaluate(() => __widgetFixture.calls.length);
  await setLanguage('de'); await setLanguage('ar');
  assert.equal(await widgets.evaluate(() => __widgetFixture.calls.length), runningCalls);
  await widgets.evaluate(() => __widgetFixture.resolve());
  await widgets.getByText('Manual result unchanged', { exact: true }).waitFor();
  assert.equal(await widgets.getByText('User original 日本語', { exact: true }).count(), 1);
  report.checks.push('locale-switch-preserves-manual-translation-and-user-content');
  }
  assert.deepEqual(report.errors, []);
  report.status = 'PASS';
} catch (error) { report.status = 'FAIL'; report.failure = error.stack; process.exitCode = 1; }
finally { await writeFile(resolve(run, 'report.json'), JSON.stringify(report, null, 2) + '\n'); await context?.close(); }
console.log(JSON.stringify({ status: report.status, checks: report.checks.length, report: resolve(run, 'report.json'), failure: report.failure }));
