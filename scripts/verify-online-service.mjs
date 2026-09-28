// Real settings/background in an isolated profile, with a loopback model-list fixture.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { browserLaunchOptions, loadPlaywright } from './browser-runtime.mjs';

const baseline = process.argv.includes('--baseline');
const source = resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? process.env.DANLINGO_TEST_EXTENSION ?? '.output/chrome-mv3');
const root = resolve('.artifacts/online-service');
await mkdir(root, { recursive: true });
const directory = await mkdtemp(resolve(root, baseline ? 'baseline-' : 'fixed-'));
const report = { evidence: 'ISOLATED_CHROMIUM_EXTENSION_LOOPBACK_FIXTURE', baseline, checks: [], screenshots: [], requests: [],
  limitations: ['Disposable profile and synthetic Key; no personal browser settings or real provider credentials.', 'Fixture host access is pregranted in the extension copy; native permission prompt is not tested.'] };
let status = 200, context;
const server = createServer((req, res) => {
  report.requests.push({ method: req.method, path: req.url, authorized: req.headers.authorization === 'Bearer fixture-online-service-key' });
  res.writeHead(req.url === '/v1/models' ? status : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(status === 200 ? { data: [{ id: 'deepseek-flash' }, { id: 'deepseek-flash-fixture' }] } : { error: 'PRIVATE_REMOTE_BODY' }));
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
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
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
  if (baseline) {
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
  report.result = 'PASS';
} catch (error) {
  report.result = 'FAIL'; report.error = error.message; process.exitCode = 1;
} finally {
  await context?.close();
  await new Promise(done => server.close(done));
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ result: report.result, version: report.version, checks: report.checks, error: report.error, directory }, null, 2));
}
