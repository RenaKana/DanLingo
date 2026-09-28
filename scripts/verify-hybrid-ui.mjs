// Isolated Edge UI acceptance. No personal profile, platform page or provider request.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { browserLaunchOptions, loadPlaywright } from './browser-runtime.mjs';
import { settingsSection } from './settings-navigation.mjs';

const sourceFixture = process.argv.includes('--source-fixture');
const extensionSource = resolve('D:/Tool/DanLingo-Workspace/testing/current/extension');
const root = resolve('.artifacts/hybrid-ui');
await mkdir(root, { recursive: true });
const directory = await mkdtemp(resolve(root, 'run-'));
const extension = sourceFixture ? resolve(directory, 'extension') : extensionSource;
const report = { evidence: sourceFixture ? 'CURRENT_SOURCE_COMPONENT_FIXTURE' : 'ISOLATED_EDGE_FIXED_BUILD_UI',
  directory, checks: [], screenshots: [], blockedHttp: [], errors: [], passed: false };
let context;
try {
  if (sourceFixture) {
    await cp(extensionSource, extension, { recursive: true });
    const entry = resolve(directory, 'hybrid-fixture-entry.ts');
    const modulePath = resolve('entrypoints/options/hybrid-ui.ts').replaceAll('\\', '/');
    await writeFile(entry, `import { mountHybridUI } from ${JSON.stringify(modulePath)};
const base = { backend: 'online', localModelId: 'fixture-local', model: 'fixture-online',
  endpoint: 'https://fixture.invalid/v1', localConcurrency: 2, onlineRequestLimitPerDay: 0 };
let draft = { ...base }, requestCount = 0, suggestionAvailable = true;
const ui = mountHybridUI({ container: document.querySelector('#hybrid-host'),
  readSettings: () => ({ ...draft, bilibiliHybrid: ui.read() }),
  requestCapacity: async settings => {
    requestCount++;
    const identity = settings.localModelId === 'no-record-model' ? '${'c'.repeat(64)}'
      : settings.localModelId === 'changed-model' ? '${'b'.repeat(64)}' : '${'a'.repeat(64)}';
    return { ok: true, identity, profile: settings.bilibiliHybrid?.profiles.find(p => p.identity === identity),
      recommendation: suggestionAvailable ? { identity, maxItems: requestCount === 2 ? 4 : 3, maxChars: 1200,
        p95Ms: 450, manual: false, sourceRecordId: 'fixture-record' } : undefined };
  }, changed: () => { window.__hybridFixture.dirty++; }, enabledChanged: () => {}, reveal: () => {} });
window.__hybridFixture = { ui, get draft() { return draft; }, setModel(model) { draft.localModelId = model; return ui.refresh(); },
  setSuggestion(available) { suggestionAvailable = available; }, get requests() { return requestCount; }, dirty: 0 };
ui.fill({ enabled: false, profiles: [] });`);
    const requireWxt = createRequire(import.meta.resolve('wxt'));
    const { build } = await import(pathToFileURL(requireWxt.resolve('vite')).href);
    await build({ configFile: false, logLevel: 'error', build: { outDir: extension,
      emptyOutDir: false, lib: { entry, formats: ['es'], fileName: () => 'hybrid-fixture.js' } } });
    const sourceCss = await readFile('entrypoints/options/options.css', 'utf8');
    await writeFile(resolve(extension, 'hybrid-fixture.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${sourceCss}</style>
      <style>body{font:14px sans-serif;margin:24px;color:#222}#hybrid-host{max-width:720px}</style>
      <body><div id="hybrid-host"></div><script type="module" src="hybrid-fixture.js"></script>`);
  }
  const { chromium } = await loadPlaywright();
  context = await chromium.launchPersistentContext(resolve(directory, 'profile'), {
    headless: true, ...browserLaunchOptions('edge'), locale: 'zh-CN', viewport: { width: 1100, height: 850 },
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension,
      '--disable-background-networking', '--disable-component-update', '--disable-sync',
      '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND'],
  });
  context.setDefaultTimeout(15000);
  await context.route(/^https?:/i, route => { report.blockedHttp.push(route.request().url()); return route.abort(); });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15000 });
  const origin = 'chrome-extension://' + new URL(worker.url()).host;
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  if (sourceFixture) {
    await page.goto(origin + '/hybrid-fixture.html');
    await page.locator('#bilibili-hybrid').waitFor();
    assert.equal(await page.locator('#bilibili-hybrid').isChecked(), false);
    report.checks.push('off-by-default');
    await page.locator('#bilibili-hybrid').check();
    await page.waitForFunction(() => window.__hybridFixture.requests >= 1);
    assert.equal(await page.locator('#hybrid-max-items').inputValue(), '3');
    assert.equal(await page.locator('#hybrid-max-chars').inputValue(), '1200');
    assert.equal((await page.evaluate(() => window.__hybridFixture.ui.read())).profiles.length, 0);
    report.checks.push('suggestion-prefills-but-does-not-apply');
    await page.locator('#hybrid-apply').click();
    assert.equal((await page.evaluate(() => window.__hybridFixture.ui.read())).profiles[0].manual, false);
    await page.locator('#hybrid-max-items').fill('2');
    const manual = (await page.evaluate(() => window.__hybridFixture.ui.read())).profiles[0];
    assert.equal(manual.manual, true);
    assert.equal(manual.p95Ms, 450);
    assert.equal(manual.sourceRecordId, 'fixture-record');
    await page.evaluate(() => window.__hybridFixture.ui.refresh());
    assert.equal(await page.locator('#hybrid-max-items').inputValue(), '2');
    assert.equal((await page.evaluate(() => window.__hybridFixture.ui.read())).profiles[0].manual, true);
    assert.match(await page.locator('#hybrid-status').innerText(), /建议 4 条/);
    const wide = resolve(directory, 'hybrid-source-wide.png');
    await page.locator('#hybrid-host').screenshot({ path: wide }); report.screenshots.push(wide);
    await page.evaluate(() => window.__hybridFixture.setModel('changed-model'));
    await page.waitForFunction(() => document.querySelector('#hybrid-max-items')?.value === '3');
    assert.equal((await page.evaluate(() => window.__hybridFixture.ui.read())).profiles.length, 1);
    await page.setViewportSize({ width: 390, height: 780 });
    const narrow = resolve(directory, 'hybrid-source-narrow.png');
    await page.locator('#hybrid-host').screenshot({ path: narrow }); report.screenshots.push(narrow);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    report.checks.push('manual-profile-retained-and-identity-change-needs-new-choice');
    await page.evaluate(() => window.__hybridFixture.ui.fill({ enabled: true,
      profiles: Array.from({ length: 50 }, (_, index) => ({ identity: (100 + index).toString(16).padStart(64, '0'),
        maxItems: 2, maxChars: 1000, manual: true })) }));
    await page.locator('#hybrid-apply').waitFor({ state: 'visible' });
    await page.locator('#hybrid-apply').click();
    const bounded = await page.evaluate(() => window.__hybridFixture.ui.read().profiles);
    assert.equal(bounded.length, 50);
    assert.equal(new Set(bounded.map(profile => profile.identity)).size, 50);
    assert.equal(bounded.some(profile => profile.identity === (100).toString(16).padStart(64, '0')), false);
    report.checks.push('fifty-profile-bound-deduplicates-and-retains-newest');
    await page.evaluate(() => window.__hybridFixture.setSuggestion(false));
    await page.evaluate(() => window.__hybridFixture.setModel('no-record-model'));
    assert.equal(await page.locator('#hybrid-max-items').inputValue(), '');
    assert.equal(await page.locator('#hybrid-max-chars').inputValue(), '');
    assert.equal(await page.locator('#hybrid-apply').isDisabled(), true);
    assert.match(await page.locator('#hybrid-status').innerText(), /手填上限或主动运行现有性能测试/);
    assert.equal(await page.evaluate(() => window.__hybridFixture.ui.ensureSelected().then(() => false, () => true)), true);
    await page.locator('#hybrid-max-items').fill('2');
    await page.locator('#hybrid-max-chars').fill('900');
    await page.evaluate(() => window.__hybridFixture.ui.ensureSelected());
    await page.evaluate(() => window.__hybridFixture.setSuggestion(true));
    await page.evaluate(() => window.__hybridFixture.ui.refresh());
    assert.equal(await page.locator('#hybrid-max-items').inputValue(), '2');
    assert.equal(await page.locator('#hybrid-max-chars').inputValue(), '900');
    assert.equal((await page.evaluate(() => window.__hybridFixture.ui.read())).profiles.at(-1).manual, true);
    report.checks.push('missing-record-requires-manual-limit-and-new-record-preserves-it');
  } else {
    const buildInfo = JSON.parse(await readFile(resolve(extension, 'danlingo-build.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
    assert.equal(buildInfo.version, manifest.version);
    report.build = { version: manifest.version, builtAt: buildInfo.builtAt };
    await page.addInitScript(() => {
      if (!chrome?.runtime?.id) return;
      const trace = window.__hybridTrace = { capacity: [], saves: [], permissionRequests: [], denied: false,
        noSuggestion: false,
        localActions: [], testMessages: 0 };
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.permissions.request = async request => { trace.permissionRequests.push(structuredClone(request)); return !trace.denied; };
      chrome.runtime.sendMessage = (message, ...rest) => {
        if (message?.type === 'overview') return send(message, ...rest).then(response => ({ ...response,
          settings: trace.saves.at(-1)?.settings ?? { ...response.settings, backend: 'local', localModelId: 'fixture-local',
            endpoint: 'https://fixture.invalid/v1', endpointInput: 'https://fixture.invalid/v1', model: 'fixture-online' },
          hasOnlineKey: trace.saves.length > 0 }));
        if (message?.type === 'hybrid-capacity') {
          trace.capacity.push(structuredClone(message));
          const identity = message.settings.localConcurrency === 3 ? 'b'.repeat(64) : 'a'.repeat(64);
          const profile = message.settings.bilibiliHybrid?.profiles?.find(item => item.identity === identity);
          return Promise.resolve({ ok: true, identity, profile,
            recommendation: trace.noSuggestion ? undefined : { identity, maxItems: 3, maxChars: 1200,
              sourceRecordId: 'fixture-record', manual: false } });
        }
        if (message?.type === 'save') { trace.saves.push(structuredClone(message)); return Promise.resolve({
          ok: true, settings: message.settings, hasOnlineKey: true, remembered: false }); }
        if (message?.type === 'model-catalog') return Promise.resolve({ ok: true, catalog: { models: ['fixture-online', 'fixture-online-2'], fetchedAt: 1 } });
        if (message?.type === 'local-control') {
          trace.localActions.push(message.control?.action);
          if (message.control?.action === 'list') return Promise.resolve({ ok: true,
            models: [{ id: 'fixture-local', name: 'fixture.gguf', files: ['fixture.gguf'], bytes: 0,
              architecture: 'fixture', quantization: 'Q4_K_M', tokenizer: 'fixture', template: false,
              importedAt: 1, availability: 'ready' }], directories: [],
            state: { phase: 'idle', backend: 'fixture', generation: 0, queued: 0, active: 0,
              completed: 0, failed: 0, cancelled: 0, peakActive: 0, inferenceCalls: 0 } });
        }
        if (message?.type === 'test-model' || message?.type === 'performance-start') trace.testMessages++;
        return send(message, ...rest);
      };
    });
    await worker.evaluate(() => chrome.storage.local.set({ 'ui.locale.v1': 'zh-CN' }));
    await page.goto(origin + '/options.html');
    await settingsSection(page, 'watching');
    await page.locator('#bilibili-hybrid').waitFor();
    assert.equal(await page.locator('#bilibili-hybrid').isChecked(), false);
    report.checks.push('off-by-default');
    await page.locator('#bilibili-hybrid').check();
    await page.waitForFunction(() => window.__hybridTrace.capacity.length >= 1);
    assert.equal(await page.locator('#hybrid-apply').isEnabled(), true);
    assert.equal((await page.evaluate(() => window.__hybridTrace.saves.length)), 0);
    report.checks.push('enable-uses-capacity-message-without-save-or-test');
    await settingsSection(page, 'service');
    assert.equal(await page.locator('#local-settings').isVisible(), true);
    assert.equal(await page.locator('#endpoint').isVisible(), true);
    await settingsSection(page, 'watching');
    await page.locator('#hybrid-apply').click();
    await page.locator('#hybrid-max-items').fill('2');
    await page.locator('#bilibili-owned-release').check();
    await page.evaluate(() => { window.__hybridTrace.noSuggestion = true; });
    await settingsSection(page, 'advanced');
    const concurrency = page.locator('#local-concurrency');
    await concurrency.locator('xpath=ancestor::details[1]').locator(':scope > summary').click();
    await concurrency.fill('3');
    await settingsSection(page, 'watching');
    await page.waitForFunction(() => document.querySelector('#hybrid-status')?.textContent?.includes('主动运行现有性能测试'));
    assert.equal(await page.locator('#hybrid-max-items').inputValue(), '');
    assert.equal(await page.locator('#hybrid-max-chars').inputValue(), '');
    assert.equal(await page.locator('#hybrid-apply').isDisabled(), true);
    const beforeSave = await page.evaluate(() => window.__hybridTrace.saves.length);
    await page.locator('#save').click();
    await page.waitForFunction(before => document.querySelector('#save')?.disabled === false, beforeSave);
    assert.equal(await page.evaluate(() => window.__hybridTrace.saves.length), beforeSave);
    report.checks.push('configuration-change-must-choose-matching-capacity');
    await page.locator('#hybrid-max-items').fill('2');
    await page.locator('#hybrid-max-chars').fill('900');
    await page.evaluate(() => {
      window.__hybridTrace.noSuggestion = false;
      document.querySelector('#local-concurrency').dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelector('#hybrid-status')?.textContent?.includes('建议 3 条'));
    assert.equal(await page.locator('#hybrid-max-items').inputValue(), '2');
    assert.equal(await page.locator('#hybrid-max-chars').inputValue(), '900');
    await settingsSection(page, 'service');
    await page.locator('#api-key').fill('fixture-key-only');
    await page.evaluate(() => { window.__hybridTrace.denied = true; });
    await page.locator('#save').click();
    await page.waitForFunction(() => !document.querySelector('#save')?.disabled);
    assert.equal(await page.evaluate(() => window.__hybridTrace.saves.length), 0);
    await page.evaluate(() => { window.__hybridTrace.denied = false; });
    await page.locator('#save').click();
    await page.waitForFunction(() => window.__hybridTrace.saves.length === 1);
    await page.waitForFunction(() => !document.querySelector('#save')?.disabled);
    const saved = await page.evaluate(() => window.__hybridTrace.saves[0].settings);
    assert.equal(saved.backend, 'local');
    assert.equal(saved.onlineRequestLimitPerDay, 0);
    assert.equal(saved.bilibiliHybrid.enabled, true);
    assert.ok(saved.bilibiliHybrid.profiles.some(profile => profile.identity === 'b'.repeat(64) && profile.maxItems === 2 && profile.maxChars === 900 && profile.manual));
    assert.deepEqual(await page.evaluate(() => window.__hybridTrace.permissionRequests), [
      { origins: ['https://fixture.invalid/*'] }, { origins: ['https://fixture.invalid/*'] }]);
    report.checks.push('local-global-backend-kept-online-origin-permission-and-budget-reused');
    const width = async () => page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    await page.setViewportSize({ width: 390, height: 780 });
    await settingsSection(page, 'watching');
    assert.equal(await page.locator('#bilibili-hybrid').isChecked(), true);
    assert.equal(await page.locator('#hybrid-controls').isVisible(), true);
    assert.equal(await page.locator('#hybrid-max-items').inputValue(), '2');
    assert.equal(await page.locator('#hybrid-max-chars').inputValue(), '900');
    assert.ok((await width()).document <= (await width()).viewport + 1);
    const screenshot = resolve(directory, 'hybrid-narrow.png');
    await page.locator('#hybrid-host').screenshot({ path: screenshot }); report.screenshots.push(screenshot);
    report.checks.push('narrow-layout-without-horizontal-overflow');
    const trace = await page.evaluate(() => window.__hybridTrace);
    assert.equal(trace.permissionRequests.length, 2);
    assert.equal(trace.testMessages, 0);
    assert.equal(trace.localActions.some(action => ['load', 'benchmark-start', 'ensure'].includes(action)), false);
  }
  assert.deepEqual(report.blockedHttp, []);
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) { report.errors.push(error?.stack ?? String(error)); process.exitCode = 1; }
finally {
  await context?.close();
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks, screenshots: report.screenshots,
    report: resolve(directory, 'report.json'), errors: report.errors }));
}
