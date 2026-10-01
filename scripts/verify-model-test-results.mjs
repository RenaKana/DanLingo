// Real background/provider/UI chain against a loopback fixture; no personal profile or real service.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { browserLaunchOptions, loadPlaywright } from './browser-runtime.mjs';

if (!process.argv[2]) throw new Error('Usage: node scripts/verify-model-test-results.mjs <built-extension>');
await mkdir('.artifacts', { recursive: true });
const directory = await mkdtemp(resolve('.artifacts/model-test-results-'));
const extension = resolve(directory, 'extension');
await cp(resolve(process.argv[2]), extension, { recursive: true });
let mode = 'translated', context;
const sourceText = '666这个入是挂', translated = '666このユーザーはチートです';
const report = { evidence: 'ISOLATED_EDGE_REAL_BACKGROUND_LOOPBACK_PROVIDER', checks: [], screenshots: [], errors: [], requests: 0 };
const server = createServer(async (request, response) => {
  if (request.method !== 'POST') { response.writeHead(404); response.end('{}'); return; }
  for await (const _chunk of request) { /* Consume only fixture input; do not log headers or credentials. */ }
  report.requests++;
  if (mode === 'http-error') {
    response.writeHead(401, { 'content-type': 'application/json' }); response.end('{"error":"PRIVATE_GATEWAY_BODY"}'); return;
  }
  const text = mode === 'unchanged' ? sourceText : translated;
  const content = mode === 'malformed' ? '<img src=x onerror=alert(1)>这不是协议响应' : mode === 'empty' ? '' : mode === 'whitespace' ? ' \n '
    : JSON.stringify([0, text]);
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
const check = async (name, run) => { await run(); report.checks.push(name); console.log('PASS', name); };
try {
  const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
  report.version = manifest.version;
  manifest.host_permissions.push('http://127.0.0.1/*');
  await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
  const { chromium } = await loadPlaywright();
  context = await chromium.launchPersistentContext(resolve(directory, 'profile'), {
    ...browserLaunchOptions('edge'), headless: true, viewport: { width: 1280, height: 900 },
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--disable-background-networking',
      '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
  });
  context.setDefaultTimeout(12000);
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await worker.evaluate(() => chrome.storage.local.set({ 'ui.locale.v1': 'zh-CN', 'ui.preferences.v1': { theme: 'light' } }));
  const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto('chrome-extension://' + new URL(worker.url()).host + '/options.html#service');
  await page.waitForFunction(() => document.querySelector('#result')?.textContent === '已保存');
  await page.locator('#backend').selectOption('online'); await page.locator('#endpoint').fill(endpoint);
  await page.locator('#endpoint').press('Escape');
  await page.locator('#local-http').check(); await page.locator('#api-key').fill('fixture-key');
  await page.locator('#model').fill('fixture-model'); await page.locator('#model-test-text').fill(sourceText);
  await page.locator('#target-language').evaluate(el => { el.value = 'ja'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  const output = page.locator('#test-result-output'), status = page.locator('#test-result');
  const run = async next => {
    mode = next; const before = report.requests;
    await page.locator('#test-model').click();
    await page.waitForFunction(() => !document.querySelector('#test-model').disabled);
    assert.equal(report.requests, before + 1); await output.waitFor();
  };
  const screenshot = async name => {
    const path = resolve(directory, name + '.png'); await output.locator('xpath=..').screenshot({ path });
    report.screenshots.push(path);
  };
  await check('successful-result-keeps-translation-and-success-status', async () => {
    await run('translated'); assert.ok((await output.textContent()).includes(translated));
    assert.equal(await status.evaluate(el => el.classList.contains('error')), false);
  });
  await check('unchanged-output-remains-visible-with-failure-status', async () => {
    await run('unchanged'); assert.match(await status.textContent(), /原文未发生变化/);
    assert.equal(await output.locator('.model-test-comparison p').nth(1).textContent(), JSON.stringify([0, sourceText]));
    assert.ok((await output.textContent()).includes('模型输出')); await screenshot('unchanged-output');
  });
  await check('malformed-assistant-output-is-visible-as-literal-text', async () => {
    await run('malformed'); assert.match(await status.textContent(), /响应格式/);
    assert.ok((await output.textContent()).includes('<img src=x onerror=alert(1)>'));
    assert.equal(await output.locator('img').count(), 0); await screenshot('malformed-output');
  });
  await check('empty-output-and-http-failure-remain-visible-with-no-output-label', async () => {
    await run('empty'); assert.ok((await output.textContent()).includes('未收到模型输出'));
    await run('whitespace'); assert.ok((await output.textContent()).includes('未收到模型输出'));
    await run('http-error'); assert.match(await status.textContent(), /服务拒绝 Key/);
    assert.ok((await output.textContent()).includes('未收到模型输出'));
    assert.doesNotMatch(await page.locator('body').textContent(), /PRIVATE_GATEWAY_BODY/);
    assert.equal(await status.evaluate(el => el.classList.contains('error')), true); await screenshot('no-output');
  });
  assert.deepEqual(report.errors, []); report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL'; report.errors.push(error.stack ?? String(error)); process.exitCode = 1;
} finally {
  await context?.close(); await new Promise(done => server.close(done));
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log('REPORT', resolve(directory, 'report.json'));
}
