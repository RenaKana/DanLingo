// Real settings/background in an isolated profile, with a loopback model-list fixture.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { browserLaunchOptions, loadPlaywright } from './browser-runtime.mjs';
import { settingsSection } from './settings-navigation.mjs';

const baseline = process.argv.includes('--baseline');
const catalogLifetime = process.argv.includes('--catalog-lifetime');
if (baseline && catalogLifetime) throw new Error('--baseline and --catalog-lifetime are separate scenarios');
const source = resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? process.env.DANLINGO_TEST_EXTENSION ?? '.output/chrome-mv3');
const root = resolve('.artifacts/online-service');
await mkdir(root, { recursive: true });
const directory = await mkdtemp(resolve(root, catalogLifetime ? 'catalog-lifetime-' : baseline ? 'baseline-' : 'fixed-'));
const report = { evidence: 'ISOLATED_CHROMIUM_EXTENSION_LOOPBACK_FIXTURE', baseline, catalogLifetime,
  OSClockChanged: false, checks: [], screenshots: [], requests: [], errors: [],
  limitations: ['Disposable profile and synthetic Key; no personal browser settings or real provider credentials.', 'Fixture host access is pregranted in the extension copy; native permission prompt is not tested.'] };
let status = 200, context;
let supportedLevels = ['low', 'high'];
const server = createServer((req, res) => {
  report.requests.push({ method: req.method, path: req.url, authorized: req.headers.authorization === 'Bearer fixture-online-service-key' });
  res.writeHead(req.url === '/v1/models' ? status : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(status === 200 ? { data: [
    { id: 'deepseek-flash', ...(catalogLifetime ? { effort: { supported_levels: supportedLevels, default_level: 'high' } } : {}) },
    { id: 'deepseek-flash-fixture' },
  ] } : { error: 'PRIVATE_REMOTE_BODY' }));
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
try {
  const extension = resolve(directory, 'extension');
  await cp(source, extension, { recursive: true });
  const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
  report.version = manifest.version;
  manifest.host_permissions = [...new Set([...manifest.host_permissions, 'http://127.0.0.1/*'])];
  await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
  const { chromium } = await loadPlaywright();
  context = await chromium.launchPersistentContext(resolve(directory, 'profile'), {
    ...browserLaunchOptions('chromium'), headless: true, locale: 'zh-CN', viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--disable-background-networking', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
  });
  context.setDefaultTimeout(12000);
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/options.html#service`);
  await page.evaluate(() => chrome.storage.local.set({ 'ui.locale.v1': 'zh-CN' }));
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#result')?.textContent === '已保存');
  const screenshot = async name => { const path = resolve(directory, name + '.png'); await page.screenshot({ path, fullPage: true }); report.screenshots.push(path); };
  const lookup = async failed => {
    await page.locator('#get-models').click();
    await page.waitForFunction(failed => !document.querySelector('#get-models').disabled && document.querySelector('#models-result').classList.contains('error') === failed, failed);
    return page.locator('#models-result').textContent();
  };
  await page.locator('#endpoint').fill(endpoint);
  await page.locator('#model').fill('deepseek-flash');
  await page.locator('#api-key').fill('fixture-online-service-key');
  assert.equal(await page.locator('#local-http').isChecked(), false);
  report.initialError = await lookup(true);
  assert.equal(report.requests.length, 0);
  assert.equal(await page.locator('#model').inputValue(), 'deepseek-flash');
  assert.equal(await page.locator('#api-key').inputValue(), 'fixture-online-service-key');
  if (catalogLifetime) {
    assert.match(report.initialError, /HTTP.*需单独启用/);
    await page.locator('#local-http').check();
    const profileDetails = page.locator('#profile').locator('xpath=ancestor::details[1]');
    if (!await profileDetails.evaluate(element => element.open)) await profileDetails.locator(':scope > summary').click();
    await page.locator('#profile').selectOption('deepseek');
    report.successMessage = await lookup(false);
    assert.deepEqual(report.requests, [{ method: 'GET', path: '/v1/models', authorized: true }]);
    await page.waitForFunction(() => {
      const option = document.querySelector('#thinking-effort option[value="low"]');
      return option && !option.disabled;
    });
    const reasoningUi = () => page.evaluate(() => {
      const select = document.querySelector('#thinking-effort');
      return { model: document.querySelector('#model').value, profile: document.querySelector('#profile').value,
        effort: select.value, superChat: document.querySelector('#superchat-thinking').value,
        options: [...select.options].map(option => ({ value: option.value, disabled: option.disabled, text: option.textContent })),
        cache: document.querySelector('#models-cache').textContent, result: document.querySelector('#result').textContent };
    });
    const saveEffort = async effort => {
      await page.locator('#thinking-effort').selectOption(effort);
      await page.locator('#save').click();
      await page.waitForFunction(() => !document.querySelector('#save').disabled && document.querySelector('#result').textContent === '已保存');
      const current = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'settings' }));
      assert.equal(current.ok, true, current.error);
      assert.equal(current.settings.model, 'deepseek-flash');
      assert.equal(current.settings.profile, 'deepseek');
      assert.equal(current.settings.reasoningProfileOverride, 'deepseek');
      assert.equal(current.settings.thinkingEffort, effort);
      assert.equal(current.settings.superChatThinkingEffort, 'inherit');
      return { profile: current.settings.profile, effort: current.settings.thinkingEffort,
        superChat: current.settings.superChatThinkingEffort, modelReasoning: current.settings.modelReasoning };
    };
    await settingsSection(page, 'live');
    await page.locator('#superchat-thinking').selectOption('inherit');
    await settingsSection(page, 'service');
    report.initialSave = await saveEffort('off');
    report.initialUi = await reasoningUi();
    assert.equal(report.requests.length, 1);
    report.checks.push('real-discovery-metadata-enables-explicit-deepseek-off-and-normal-save');
    await screenshot('catalog-discovered-off-saved');

    report.agedCatalog = await page.evaluate(async () => {
      const key = 'modelCatalog.v1', stored = (await chrome.storage.local.get(key))[key];
      const entries = Object.entries(stored ?? {});
      const matched = entries.filter(([, catalog]) => catalog.models?.includes('deepseek-flash'));
      if (entries.length !== 1 || matched.length !== 1) throw new Error('the disposable fixture must own exactly one successful catalog');
      const [scope, catalog] = matched[0], now = Date.now(), fetchedAt = now - 48 * 60 * 60 * 1000;
      await chrome.storage.local.set({ [key]: { ...stored, [scope]: { ...catalog, fetchedAt } } });
      return { catalogCount: entries.length, fetchedAt, now, ageMs: now - fetchedAt,
        models: catalog.models, capabilities: catalog.capabilities };
    });
    assert.deepEqual(report.agedCatalog.capabilities['deepseek-flash'].supportedLevels, ['low', 'high']);
    assert.equal(report.agedCatalog.ageMs, 48 * 60 * 60 * 1000);
    await page.reload();
    await page.waitForFunction(() => {
      const select = document.querySelector('#thinking-effort'), off = select?.querySelector('option[value="off"]'),
        low = select?.querySelector('option[value="low"]');
      return select?.value === 'off' && off && !off.disabled && low && !low.disabled &&
        document.querySelector('#result')?.textContent === '已保存';
    });
    report.agedUi = await reasoningUi();
    assert.equal(report.agedUi.profile, 'deepseek');
    assert.equal(report.agedUi.superChat, 'inherit');
    assert.equal(report.requests.length, 1, 'reload must reuse the successful catalog without an automatic model fetch');
    report.agedSave = await saveEffort('off');
    assert.equal(report.requests.length, 1, 'saving the 48-hour-old supported effort must not fetch models');
    report.checks.push('48-hour-catalog-retains-enabled-effort-after-reload-and-save-without-network');
    await screenshot('catalog-48h-off-still-enabled-and-saved');

    // DeepSeek always allows off. Save low while it is supported, then revoke
    // low in a new successful discovery to prove explicit refresh replacement.
    report.lowSave = await saveEffort('low');
    assert.equal(report.requests.length, 1);
    supportedLevels = ['high'];
    report.refreshMessage = await lookup(false);
    await page.waitForFunction(() => {
      const option = document.querySelector('#thinking-effort option[value="low"]');
      return option?.disabled && option.textContent.includes('不支持');
    });
    report.refreshedUi = await reasoningUi();
    assert.equal(report.refreshedUi.effort, 'low', 'refresh must flag the previous choice without silently changing it');
    assert.ok(report.refreshedUi.options.some(option => option.value === 'high' && !option.disabled));
    assert.ok(report.refreshedUi.options.some(option => option.value === 'off' && !option.disabled));
    report.refreshedCatalog = await page.evaluate(async () => {
      const entries = Object.values((await chrome.storage.local.get('modelCatalog.v1'))['modelCatalog.v1'] ?? {});
      const catalog = entries.find(entry => entry.models?.includes('deepseek-flash'));
      return { catalogCount: entries.length, fetchedAt: catalog?.fetchedAt, capabilities: catalog?.capabilities };
    });
    assert.equal(report.refreshedCatalog.catalogCount, 1);
    assert.ok(report.refreshedCatalog.fetchedAt > report.agedCatalog.fetchedAt);
    assert.deepEqual(report.refreshedCatalog.capabilities['deepseek-flash'].supportedLevels, ['high']);
    assert.equal(report.requests.length, 2, 'only the explicit refresh can issue the second models GET');
    report.checks.push('explicit-successful-refresh-replaces-metadata-and-flags-previous-low-as-unsupported');
    await screenshot('catalog-refresh-low-now-unsupported');
    report.refreshedSave = await saveEffort('high');
    assert.equal(report.requests.length, 2);
    assert.deepEqual(report.requests.map(request => [request.method, request.path, request.authorized]),
      [['GET', '/v1/models', true], ['GET', '/v1/models', true]]);
    report.checks.push('newly-supported-high-saves-without-an-additional-model-fetch');
    await screenshot('catalog-refresh-high-saved');
  } else if (baseline) {
    assert.match(report.initialError, /^模型查询失败；保留已有列表和输入$/);
    assert.equal(await page.locator('#local-http').isVisible(), false);
    report.checks.push('reproduced-hidden-http-option-and-generic-failure-with-zero-requests');
    await screenshot('http-disabled');
  } else {
    assert.match(report.initialError, /HTTP.*需单独启用/);
    assert.equal(await page.locator('#local-http').isVisible(), true);
    report.checks.push('http-opt-in-visible-and-disabled-request-explained-with-inputs-preserved');
    await screenshot('http-disabled');
    await page.locator('#local-http').check();
    report.successMessage = await lookup(false);
    assert.deepEqual(report.requests, [{ method: 'GET', path: '/v1/models', authorized: true }]);
    await page.locator('#model').focus();
    await page.locator('#model').press('ArrowDown');
    assert.match(await page.locator('#model-choices').textContent(), /deepseek-flash-fixture/);
    assert.equal(await page.locator('#model').inputValue(), 'deepseek-flash');
    report.checks.push('opted-in-http-host-with-port-discovers-models-and-preserves-manual-model');
    await screenshot('models-success');
    const choices = await page.locator('#model-choices').textContent(), cached = await page.locator('#models-cache').textContent();
    status = 401;
    report.authError = await lookup(true);
    assert.match(report.authError, /服务拒绝 Key/);
    assert.doesNotMatch(report.authError, /PRIVATE_REMOTE_BODY/);
    assert.equal(report.requests.length, 2);
    assert.equal(await page.locator('#model-choices').textContent(), choices);
    assert.equal(await page.locator('#models-cache').textContent(), cached);
    assert.equal(await page.locator('#model').inputValue(), 'deepseek-flash');
    report.checks.push('authentication-error-keeps-list-cache-and-input-without-remote-body');
    await page.locator('#endpoint').fill('http://public.example.invalid/v1');
    assert.match(await lookup(true), /HTTP 服务仅允许本机或私有 IPv4/);
    assert.equal(report.requests.length, 2);
    report.checks.push('public-http-remains-blocked-before-network');
    await page.locator('#local-http').uncheck();
    await page.locator('#endpoint').fill('https://service.example.invalid/v1');
    assert.match(await page.locator('#connection-status').textContent(), /https:\/\/service\.example\.invalid\/v1\/chat\/completions/);
    assert.equal(report.requests.length, 2);
    report.checks.push('https-address-needs-no-http-opt-in-or-probe');
    await page.locator('#endpoint').fill('invalid-address');
    assert.match(await lookup(true), /服务地址无效/);
    assert.equal(report.requests.length, 2);
    report.checks.push('malformed-address-shows-specific-error-before-network');
  }
  assert.deepEqual(report.errors, []);
  report.result = 'PASS';
} catch (error) {
  report.result = 'FAIL'; report.error = error.message; process.exitCode = 1;
} finally {
  await context?.close();
  await new Promise(done => server.close(done));
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ result: report.result, version: report.version, checks: report.checks, error: report.error, directory }, null, 2));
}
