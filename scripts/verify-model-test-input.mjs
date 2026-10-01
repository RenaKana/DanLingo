// Built settings UI and real extension storage in an isolated profile; model replies are fixtures.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { browserLaunchOptions, loadPlaywright } from './browser-runtime.mjs';

if (!process.argv[2]) throw new Error('Usage: node scripts/verify-model-test-input.mjs <built-extension>');
await mkdir('.artifacts', { recursive: true });
const directory = await mkdtemp(resolve('.artifacts/model-test-input-'));
const extension = resolve(directory, 'extension');
await cp(resolve(process.argv[2]), extension, { recursive: true });
const report = { evidence: 'ISOLATED_BUILT_EXTENSION_REAL_STORAGE_MOCK_MODEL', checks: [], screenshots: [], errors: [] };
const { chromium } = await loadPlaywright();
let context;
const check = async (name, run) => { await run(); report.checks.push(name); console.log('PASS', name); };
try {
  context = await chromium.launchPersistentContext(resolve(directory, 'profile'), {
    ...browserLaunchOptions('edge'), headless: true, viewport: { width: 1280, height: 900 },
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--disable-background-networking', '--no-first-run'],
  });
  context.setDefaultTimeout(10000);
  await context.route(/^https?:/, route => route.abort());
  await context.addInitScript(() => {
    if (!globalThis.chrome?.runtime?.id) return;
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    globalThis.__modelTestCalls = [];
    globalThis.__modelTestFailure = false;
    chrome.permissions.request = async () => true;
    const model = { id: 'fixture-local', name: 'Fixture local model', files: ['fixture.gguf'], bytes: 1000000,
      architecture: 'hunyuan-dense', quantization: 'Q4', tokenizer: 'fixture', template: true,
      importedAt: 1, availability: 'ready', metadataVersion: 1, metadataComplete: true };
    chrome.runtime.sendMessage = async (message, ...rest) => {
      if (message.type === 'test-model') {
        __modelTestCalls.push(message);
        if (__modelTestFailure) return { ok: false, error: '模型原样返回了待译文本，未计为翻译成功', result: {
          model: 'Index-Translate-2B.Q8_0', elapsedMs: 10, sourceText: message.text, text: message.text, passed: false,
          sourceLanguage: message.context === 'video' ? message.settings.sourceLanguage : message.settings.liveSourceLanguage,
          targetLanguage: message.settings.targetLanguage, promptMode: 'index-translate', verification: 'basic-language-check',
        } };
        return { ok: true, model: 'fixture', elapsedMs: 10, sourceText: message.text, text: '这个视频很有趣。',
          targetLanguage: message.settings.targetLanguage, promptMode: 'json', verification: 'protocol-only' };
      }
      if (message.type === 'local-control') return { ok: true, models: [model], directories: [],
        state: { phase: 'ready', generation: 1, model, active: 0, queued: 0 } };
      const result = await original(message, ...rest);
      if (message.type === 'overview') result.settings = { ...result.settings, backend: 'online',
        endpoint: 'https://fixture.invalid/v1', endpointInput: 'https://fixture.invalid/v1', model: 'fixture',
        sourceLanguage: 'ja', liveSourceLanguage: 'en', targetLanguage: 'zh-Hans', localModelId: model.id };
      return result;
    };
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await worker.evaluate(() => chrome.storage.local.set({ 'ui.locale.v1': 'zh-CN', 'ui.preferences.v1': { theme: 'light' } }));
  const origin = 'chrome-extension://' + new URL(worker.url()).host;
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  const ready = () => page.waitForFunction(() => document.querySelector('#result')?.textContent === '已保存');
  await page.goto(origin + '/options.html'); await ready();
  const online = page.locator('#model-test-text'), local = page.locator('#local-model-test-text');
  const japanese = 'この動画はとても面白いです。', english = 'This video is very interesting.';
  const saved = (backend, value) => page.waitForFunction(async ({ backend, value }) => {
    const key = `ui.modelTestText.${backend}.v1`;
    return (await chrome.storage.local.get(key))[key] === value;
  }, { backend, value });
  const screenshot = async name => {
    const path = resolve(directory, name + '.png'); await page.locator('[data-section="service"]').screenshot({ path });
    report.screenshots.push(path);
  };
  const change = (id, value) => page.locator('#' + id).evaluate((element, value) => {
    element.value = value; element.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  const submit = async (backend, expected) => {
    const count = await page.evaluate(() => __modelTestCalls.length);
    await page.locator(backend === 'online' ? '#test-model' : '#test-local-model').click();
    await page.waitForFunction(count => __modelTestCalls.length === count + 1, count);
    assert.equal(await page.evaluate(() => __modelTestCalls.at(-1).text), expected);
    const output = page.locator(backend === 'online' ? '#test-result-output' : '#local-test-result-output');
    await output.waitFor(); assert.ok((await output.textContent()).includes(expected));
  };
  await check('visible-default-is-the-submitted-source-for-both-backends', async () => {
    assert.equal(await online.inputValue(), japanese); assert.equal(await local.inputValue(), english);
    assert.equal(await online.getAttribute('data-default-sample'), 'true');
    assert.equal(await online.evaluate(el => getComputedStyle(el).color), 'rgb(101, 108, 118)');
    await screenshot('online-default-light'); await submit('online', japanese);
    await page.locator('#backend').selectOption('local'); await submit('local', english);
    await screenshot('local-default-light'); await page.locator('#backend').selectOption('online');
  });
  await check('typing-replaces-default-at-any-caret-and-persists-on-reopen', async () => {
    await online.click(); await online.evaluate(el => el.setSelectionRange(4, 4));
    await page.keyboard.type('Custom source');
    assert.equal(await online.inputValue(), 'Custom source');
    assert.equal(await online.getAttribute('data-default-sample'), 'false');
    assert.equal(await online.evaluate(el => getComputedStyle(el).color), 'rgb(39, 43, 51)');
    await saved('online', 'Custom source'); await submit('online', 'Custom source');
    await page.reload(); await ready(); assert.equal(await online.inputValue(), 'Custom source');
    assert.equal(await local.inputValue(), english); await screenshot('custom-source');
  });
  await check('clear-or-whitespace-restores-sample-and-removes-saved-custom', async () => {
    await online.fill(''); assert.equal(await online.inputValue(), japanese);
    await saved('online', ''); await submit('online', japanese);
    await online.fill(' \n '); assert.equal(await online.inputValue(), japanese); await saved('online', '');
    await page.reload(); await ready(); assert.equal(await online.inputValue(), japanese);
    assert.equal(await online.getAttribute('data-default-sample'), 'true');
  });
  await check('text-insertion-and-ime-replace-default-without-contamination', async () => {
    await online.click(); await online.evaluate(el => el.setSelectionRange(5, 5));
    await page.keyboard.insertText('粘贴的原文'); assert.equal(await online.inputValue(), '粘贴的原文');
    await online.fill('');
    const cdp = await context.newCDPSession(page);
    await online.click(); await online.evaluate(el => el.setSelectionRange(5, 5));
    await cdp.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
    await cdp.send('Input.insertText', { text: '中文原文' });
    assert.equal(await online.inputValue(), '中文原文'); await saved('online', '中文原文');
    await cdp.detach(); await online.fill(''); await saved('online', '');
  });
  await check('language-and-local-scenario-update-defaults-only', async () => {
    await change('source-language', 'ko'); assert.equal(await online.inputValue(), '이 영상은 정말 재미있어요.');
    await change('model-test-context', 'video'); assert.equal(await local.inputValue(), '이 영상은 정말 재미있어요.');
    await page.locator('#backend').selectOption('local'); await local.fill('保存的本地原文'); await saved('local', '保存的本地原文');
    await change('model-test-context', 'live'); assert.equal(await local.inputValue(), '保存的本地原文');
    await page.reload(); await ready(); assert.equal(await local.inputValue(), '保存的本地原文');
    await page.locator('#backend').selectOption('local'); await local.fill(''); await saved('local', '');
    assert.equal(await local.inputValue(), english); await submit('local', english);
    await change('live-source-language', 'auto'); await change('target-language', 'ja');
    assert.equal(await local.inputValue(), '这个视频很有趣，我期待下一次直播。');
    await change('source-language', 'fr'); assert.equal(await online.inputValue(), '');
    await change('source-language', 'ja'); assert.equal(await online.inputValue(), '');
  });
  await check('default-remains-muted-in-dark-theme', async () => {
    await page.locator('#theme').selectOption('dark');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    assert.equal(await local.evaluate(el => getComputedStyle(el).color), 'rgb(165, 171, 181)');
    await screenshot('local-default-dark');
  });
  await check('rejected-local-output-shows-text-language-and-Index-prompt', async () => {
    await local.fill('666这个入是挂'); await page.evaluate(() => { __modelTestFailure = true; });
    await submit('local', '666这个入是挂');
    assert.match(await page.locator('#local-test-result').textContent(), /原样返回/);
    assert.equal(await page.locator('#local-test-result').evaluate(el => el.classList.contains('error')), true);
    const output = page.locator('#local-test-result-output');
    assert.equal(await output.locator('.model-test-comparison p').nth(1).textContent(), '666这个入是挂');
    assert.match(await output.textContent(), /模型输出/); assert.match(await output.textContent(), /Index-Translate/);
    await screenshot('local-rejected-output-dark');
  });
  assert.deepEqual(report.errors, []); report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL'; report.errors.push(error.stack ?? String(error)); process.exitCode = 1;
} finally {
  await context?.close();
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log('REPORT', resolve(directory, 'report.json'));
}
