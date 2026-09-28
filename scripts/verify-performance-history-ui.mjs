// Isolated Edge acceptance for performance history. Run with --experimental-strip-types.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_SETTINGS } from '../src/core/config.ts';
import { PERFORMANCE_HISTORY_KEY, performanceRecord } from '../src/translation/performance-history.ts';
import { PerformanceTest } from '../src/translation/performance-test.ts';
import { browserLaunchOptions, loadPlaywright } from './browser-runtime.mjs';
import { settingsSection } from './settings-navigation.mjs';
import { catalogs } from '../src/i18n/catalogs.ts';
import { LOCALES } from '../src/i18n/locale.ts';

const extensionDir = resolve('D:/Tool/DanLingo-Workspace/testing/current/extension');
const outputRoot = resolve('.artifacts/performance-history-ui');
const runDir = resolve(outputRoot, `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
await mkdir(runDir, { recursive: true });
const reportPath = join(runDir, 'report.json');
const expectedVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const modelListFixture = [
  { id: 'fixture-7b-gguf', name: '7B.gguf', files: ['7B.gguf'], bytes: 0, architecture: 'fixture', quantization: 'Q4_K_M', tokenizer: 'fixture', template: false, importedAt: 1, translationProfile: 'translategemma', availability: 'ready' },
  { id: 'fixture-1-8b-gguf', name: '1.8B.gguf', files: ['1.8B.gguf'], bytes: 0, architecture: 'fixture', quantization: 'Q4_K_M', tokenizer: 'fixture', template: false, importedAt: 2, translationProfile: 'translategemma', availability: 'ready' },
];
const localStateFixture = {
  phase: 'idle', backend: 'wllama 3.6.1 · WebGPU', generation: 0, queued: 0, active: 0,
  completed: 0, failed: 0, cancelled: 0, peakActive: 0, inferenceCalls: 0,
  contextTokens: 2048, verifiedTranslation: false,
};
const report = {
  evidence: 'ISOLATED_EDGE_UI_WITH_PERFORMANCETEST_MOCK_FETCH_FIXTURES',
  fixtureScope: '7B.gguf and 1.8B.gguf are fictional local-model labels; mocked translations and batch phases are not model measurements.',
  browser: 'Microsoft Edge, headless, fresh temporary profile',
  build: {}, checks: {}, screenshots: [], downloads: [], blockedExternalHttp: [], browserErrors: [], errors: [],
};
let context, profileDir;

function tokensIn(prompt) {
  const tokens = [];
  let offset = 0;
  while (true) {
    const start = prompt.indexOf('[[DL:', offset);
    if (start < 0) break;
    const end = prompt.indexOf(']]', start);
    if (end < 0) break;
    tokens.push(prompt.slice(start, end + 2));
    offset = end + 2;
  }
  return tokens;
}

async function buildFixture(model, concurrency, wallStartedAt) {
  const settings = {
    ...DEFAULT_SETTINGS,
    backend: 'local', model, localModelId: `fixture-${model.replaceAll('.', '-')}`,
    localTranslationProfile: 'translategemma', localCapacity: concurrency,
    liveSourceLanguage: 'ja', sourceLanguage: 'auto', liveMaxBatchWaitMs: 0,
    endpoint: 'https://fixture.invalid/private-endpoint',
  };
  const config = { count: 5, mode: 'load', concurrency, batchSize: 1, arrivalIntervalMs: 0, budgetMs: 5000, strategy: 'normal' };
  let calls = 0;
  const run = new PerformanceTest(config, settings, 'synthetic-fixture-secret-not-a-credential', {
    fetch: async (_url, init) => {
      calls++;
      const prompt = JSON.parse(init.body).messages[0].content;
      return Response.json({ choices: [{ message: { content: '谢谢你的直播！' + tokensIn(prompt).join('') }, finish_reason: 'stop' }] });
    },
  });
  const result = await run.run();
  result.wallStartedAt = wallStartedAt;
  const record = performanceRecord(result);
  assert.ok(record, `${model} should convert to a valid PerformanceRecord`);
  assert.equal(result.state, 'completed');
  assert.equal(result.successRequests, config.count);
  assert.equal(result.actualRequests, config.count);
  assert.equal(calls, config.count);
  assert.equal(record.model, model);
  assert.equal(record.config.concurrency, concurrency);
  assert.equal(record.config.count, 5);
  assert.equal(record.config.mode, 'load');
  assert.equal(record.config.batchSize, 1);
  assert.equal(record.config.arrivalIntervalMs, 0);
  assert.equal(record.config.budgetMs, 5000);
  const json = JSON.stringify(record);
  for (const forbidden of ['synthetic-fixture-secret', 'fixture.invalid', 'endpoint', 'apiKey', 'settings', 'samples', 'jobs', '谢谢你的直播'])
    assert.equal(json.includes(forbidden), false, `${forbidden} must not be exported`);
  return { result, record, calls };
}

function assertSafeExport(data, expectedCount = 2) {
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.records.length, expectedCount);
  const forbiddenKeys = new Set(['apikey', 'endpoint', 'endpointinput', 'settings', 'samples', 'jobs', 'items', 'prompt', 'text']);
  const inspect = (value, path = 'root') => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbiddenKeys.has(key.toLowerCase()), false, `${path}.${key} must not be exported`);
      inspect(child, `${path}.${key}`);
    }
  };
  inspect(data);
  const json = JSON.stringify(data);
  for (const forbidden of ['synthetic-fixture-secret', 'fixture.invalid', '谢谢你的直播'])
    assert.equal(json.includes(forbidden), false, `${forbidden} must not be exported`);
}

async function check(name, fn) {
  const value = await fn();
  report.checks[name] = 'PASS';
  console.log('PASS', name);
  return value;
}

async function capture(page, name) {
  const path = join(runDir, name + '.png');
  await page.screenshot({ path, fullPage: true });
  report.screenshots.push(path);
}

async function captureHistory(page, name) {
  const path = join(runDir, name + '.png');
  await page.locator('.performance-history').evaluate(el => el.scrollIntoView({ block: 'start' }));
  await page.locator('.performance-history').screenshot({ path });
  report.screenshots.push(path);
}

async function dimensions(page) {
  return page.evaluate(() => {
    const history = document.querySelector('.performance-history');
    const list = document.querySelector('#performance-history-rows');
    return {
      viewport: innerWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      historyClient: history?.clientWidth ?? 0,
      historyScroll: history?.scrollWidth ?? 0,
      listClient: list?.clientWidth ?? 0,
      listScroll: list?.scrollWidth ?? 0,
      records: [...(list?.querySelectorAll('.history-record') ?? [])].map(record => ({
        clientWidth: record.clientWidth,
        scrollWidth: record.scrollWidth,
        parentWidth: record.parentElement?.clientWidth ?? 0,
      })),
    };
  });
}

async function exportHistory(page, filename, expectedCount = 2) {
  const disclosure = page.locator('#performance-history-disclosure');
  if (!await disclosure.evaluate(el => el.open)) await disclosure.locator(':scope > summary').click();
  const destination = join(runDir, filename);
  const [download] = await Promise.all([
    page.waitForEvent('download'), page.locator('#performance-export').click(),
  ]);
  await download.saveAs(destination);
  const data = JSON.parse(await readFile(destination, 'utf8'));
  assertSafeExport(data, expectedCount);
  report.downloads.push({ path: destination, records: data.records.length, safe: true });
  return data;
}

try {
  assert.ok(process.env.DANLINGO_PLAYWRIGHT_MODULE, 'DANLINGO_PLAYWRIGHT_MODULE must point to the installed Playwright module');
  assert.ok(process.env.DANLINGO_TEST_BROWSER, 'DANLINGO_TEST_BROWSER must point to Microsoft Edge');
  const manifest = JSON.parse(await readFile(join(extensionDir, 'manifest.json'), 'utf8'));
  const buildInfo = JSON.parse(await readFile(join(extensionDir, 'danlingo-build.json'), 'utf8'));
  const runtimeInfo = JSON.parse(await readFile(join(extensionDir, 'runtime-identity.json'), 'utf8'));
  assert.equal(manifest.version, expectedVersion);
  assert.equal(buildInfo.version, manifest.version);
  assert.equal(runtimeInfo.version, manifest.version);
  assert.ok(runtimeInfo.buildId.startsWith(`${expectedVersion}-`));
  report.build = {
    version: manifest.version,
    builtAt: buildInfo.builtAt,
    runtimeBuiltAt: runtimeInfo.builtAt,
    buildId: runtimeInfo.buildId,
    commit: runtimeInfo.commit,
    sourceHash: runtimeInfo.sourceHash,
  };

  const fixtureBase = Date.now() - 10_000;
  const fixtures = [
    await buildFixture('7B.gguf', 2, fixtureBase),
    await buildFixture('1.8B.gguf', 4, fixtureBase + 1_000),
  ];
  report.fixtureRuns = fixtures.map(({ result, record, calls }) => ({
    model: record.model, concurrency: record.config.concurrency,
    requested: record.config.count, completed: result.successRequests, mockFetchCalls: calls,
  }));
  const records = fixtures.map(fixture => fixture.record);

  const tempRoot = resolve(tmpdir());
  profileDir = await mkdtemp(join(tempRoot, 'danlingo-performance-history-edge-'));
  const profileRelative = relative(tempRoot, profileDir);
  assert.ok(profileRelative && !profileRelative.startsWith('..') && !isAbsolute(profileRelative));

  const { chromium } = await loadPlaywright();
  context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    ...browserLaunchOptions('edge'),
    locale: 'zh-CN',
    viewport: { width: 1440, height: 1100 },
    acceptDownloads: true,
    serviceWorkers: 'allow',
    args: [
      '--disable-extensions-except=' + extensionDir,
      '--load-extension=' + extensionDir,
      '--disable-background-networking',
      '--disable-component-update',
      '--no-first-run',
      '--host-resolver-rules=MAP * ~NOTFOUND',
    ],
  });
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (/^https?:/i.test(url)) {
      report.blockedExternalHttp.push(url);
      await route.abort();
    } else await route.continue();
  });
  await context.addInitScript(({ failedReport, localModels, localState }) => {
    const runtime = globalThis.chrome?.runtime;
    if (!runtime?.sendMessage) return;
    const send = runtime.sendMessage.bind(runtime);
    const trace = {
      mode: 'normal', localListMessages: 0, localControlActions: [],
      startMessages: 0, startPayloads: [], statusMessages: 0, mockedStatusMessages: 0,
      stopMessages: 0, historyDeletePayloads: [], rejectNextHistoryDelete: false, batchStatusPhases: [],
      batchMode: false, stopRequested: false, nextBatchStatus: 0,
      onlineReport: null, permissionRequests: [], denyPermission: false,
    };
    Object.defineProperty(globalThis, '__performanceHistoryUiTrace', { value: trace, configurable: false });
    chrome.permissions.request = async request => { trace.permissionRequests.push(structuredClone(request)); return !trace.denyPermission; };
    runtime.sendMessage = (message, ...rest) => {
      // The isolated real model database is deliberately empty. Background source
      // reconciliation may clear its selected id; match the UI-only list fixture.
      if (message?.type === 'overview') return send(message, ...rest).then(response => ({
        ...response, settings: { ...response.settings, backend: 'local', localModelId: localModels[0].id,
          liveSourceLanguage: 'ja', targetLanguage: 'zh-Hans', endpoint: 'https://fixture.invalid/v1',
          endpointInput: 'https://fixture.invalid/v1', model: 'fixture-online-default' },
      }));
      if (message?.type === 'model-catalog') return Promise.resolve({ ok: true,
        catalog: { models: ['fixture-online-default', 'fixture-online-alternative'], fetchedAt: 1 } });
      if (message?.type === 'local-control') {
        const action = message.control?.action;
        trace.localControlActions.push(action ?? 'unknown');
        if (action === 'list') {
          trace.localListMessages++;
          return Promise.resolve({ ok: true, models: structuredClone(localModels), directories: [], state: structuredClone(localState), scanBusy: false });
        }
      }
      if (message?.type === 'performance-start') {
        trace.startMessages++;
        trace.startPayloads.push(structuredClone(message));
        if (message.settings.backend === 'online') {
          trace.onlineReport = { ...structuredClone(failedReport), id: 'fixture-online-run', backend: 'online', model: message.settings.model };
          return Promise.resolve({ ok: true, report: structuredClone(trace.onlineReport), saveState: null });
        }
        trace.batchMode = true; trace.stopRequested = false; trace.nextBatchStatus = 0;
        trace.batchStatusPhases.push('preparing');
        return Promise.resolve({ ok: true, report: null, batch: {
          id: 'fixture-performance-batch', state: 'running', phase: 'preparing', index: 0,
          total: localModels.length, completed: 0, modelId: localModels[0].id, modelName: localModels[0].name,
        } });
      }
      if (message?.type === 'performance-status') {
        trace.statusMessages++;
        if (trace.onlineReport) return Promise.resolve({ ok: true, report: structuredClone(trace.onlineReport), saveState: null });
      }
      if (message?.type === 'performance-status' && trace.mode === 'save-failed') {
        trace.mockedStatusMessages++;
        return Promise.resolve({ ok: true, report: structuredClone(failedReport), saveState: 'failed' });
      }
      if (message?.type === 'performance-status' && trace.batchMode) {
        const phases = ['unloading', 'loading', 'testing', 'saving', 'finishing'];
        const stopped = trace.stopRequested;
        const phase = stopped ? 'done' : phases[Math.min(trace.nextBatchStatus++, phases.length - 1)];
        if (stopped) trace.batchMode = false;
        trace.batchStatusPhases.push(phase);
        return Promise.resolve({ ok: true, report: null, saveState: null, batch: {
          id: 'fixture-performance-batch', state: stopped ? 'stopped' : 'running', phase,
          index: 0, total: localModels.length, completed: 0,
          modelId: localModels[0].id, modelName: localModels[0].name,
        } });
      }
      if (message?.type === 'performance-stop') {
        trace.stopMessages++;
        trace.stopRequested = true;
        return Promise.resolve({ ok: true });
      }
      if (message?.type === 'performance-history-delete') {
        trace.historyDeletePayloads.push(structuredClone(message));
        if (trace.rejectNextHistoryDelete) {
          trace.rejectNextHistoryDelete = false;
          return Promise.resolve({ ok: false });
        }
      }
      return send(message, ...rest);
    };
  }, { failedReport: fixtures[0].result, localModels: modelListFixture, localState: localStateFixture });

  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extensionId = new URL(worker.url()).host;
  assert.ok(extensionId);
  report.extensionId = extensionId;
  const localSettings = {
    ...DEFAULT_SETTINGS, backend: 'local', localModelId: modelListFixture[0].id,
    liveSourceLanguage: 'ja', targetLanguage: 'zh-Hans',
  };
  await worker.evaluate(async ({ key, value, settings }) => {
    await chrome.storage.local.set({ [key]: value, 'settings.v1': settings, 'ui.locale.v1': 'zh-CN' });
    return chrome.storage.local.get([key, 'settings.v1']);
  }, { key: PERFORMANCE_HISTORY_KEY, value: records, settings: localSettings });

  let page = await context.newPage();
  page.on('pageerror', error => report.browserErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.browserErrors.push(message.text()); });
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await settingsSection(page, 'performance');
  await page.locator('.performance-history').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelectorAll('#performance-models input[data-model-id]').length === 2);

  await check('isolated-local-model-list-populates-fixtures-without-loading-a-model', async () => {
    assert.equal(await page.locator('#performance-count').getAttribute('type'), 'number');
    assert.equal(await page.locator('#performance-count').inputValue(), '10');
    const boxes = page.locator('#performance-models input[data-model-id]');
    assert.equal(await boxes.count(), 2);
    assert.deepEqual(await boxes.evaluateAll(inputs => inputs.map(input => ({ id: input.dataset.modelId, checked: input.checked, disabled: input.disabled }))), [
      { id: modelListFixture[0].id, checked: true, disabled: false },
      { id: modelListFixture[1].id, checked: false, disabled: false },
    ]);
    const trace = await page.evaluate(() => globalThis.__performanceHistoryUiTrace);
    assert.ok(trace.localListMessages > 0);
    assert.equal(trace.localControlActions.some(action => ['load', 'ensure', 'benchmark-start'].includes(action)), false);
    report.localModelFixture = { listRequests: trace.localListMessages, models: modelListFixture.map(({ id, name }) => ({ id, name })), modelLoadRequested: false };
  });

  await check('real-background-history-read-displays-two-records', async () => {
    const response = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'performance-history' }));
    assert.equal(response?.ok, true);
    assert.equal(response.records.length, 2);
    await page.waitForFunction(() => document.querySelectorAll('#performance-history-rows > .history-record').length === 2);
    const rows = await page.locator('#performance-history-rows > .history-record').allTextContents();
    assert.ok(rows.some(text => text.includes('7B.gguf')));
    assert.ok(rows.some(text => text.includes('1.8B.gguf')));
    assert.equal(await page.locator('#performance-history-status').textContent().then(text => text.includes('2')), true);
    report.historyRows = rows;
    return response.records.length;
  });

  await check('history-defaults-to-compact-model-time-rows-and-supports-keyboard-expansion', async () => {
    const historyDisclosure = page.locator('#performance-history-disclosure');
    if (!await historyDisclosure.evaluate(el => el.open)) await historyDisclosure.locator(':scope > summary').click();
    const records = page.locator('#performance-history-rows > .history-record');
    assert.equal(await records.locator('details[open]').count(), 0);
    const first = records.first(), summary = first.locator('summary');
    const remove = first.locator('.history-delete');
    assert.equal(await remove.isVisible(), true);
    assert.equal(await remove.evaluate(el => el.parentElement?.classList.contains('history-summary-line')), true);
    const afterDate = await remove.evaluate(el => el.previousElementSibling?.classList.contains('history-time'));
    assert.equal(afterDate, true);
    const text = await summary.innerText();
    assert.ok(text.includes('1.8B.gguf') && text.includes('删除'));
    assert.ok(!text.includes('已完成') && !text.includes('请求并发'));
    const style = await summary.locator('.history-model').evaluate(el => ({ size: parseFloat(getComputedStyle(el).fontSize), weight: getComputedStyle(el).fontWeight }));
    assert.ok(style.size >= 15); assert.ok(Number(style.weight) >= 700);
    await captureHistory(page, 'desktop-collapsed-records');
    await page.evaluate(() => { globalThis.__performanceHistoryUiTrace.rejectNextHistoryDelete = true; });
    await remove.press('Space');
    await page.locator('#performance-history-action-status').getByText('操作失败').waitFor({ state: 'visible' });
    assert.equal(await first.locator('details').evaluate(el => el.open), false, 'keyboard delete must not expand the record');
    assert.equal(await first.locator('.history-delete').isVisible(), true);
    assert.deepEqual((await page.evaluate(() => globalThis.__performanceHistoryUiTrace.historyDeletePayloads)), [
      { type: 'performance-history-delete', ids: [fixtures[1].record.id] },
    ]);
    await summary.click(); assert.equal(await first.locator('.history-conditions').isVisible(), true);
    await summary.press('Enter'); assert.equal(await first.locator('.history-conditions').isVisible(), false);
    await summary.press('Space'); assert.equal(await first.locator('.history-conditions').isVisible(), true);
  });

  await check('expanded-record-conditions-match-shared-load-settings', async () => {
    const conditions = page.locator('#performance-history-rows > .history-record').first().locator('.history-conditions');
    assert.equal(await conditions.isVisible(), true);
    const fields = await conditions.locator('.history-item').evaluateAll(items => Object.fromEntries(items.map(item => [
      item.querySelector('.history-label')?.textContent ?? '', item.querySelector('.history-value')?.textContent ?? '',
    ])));
    assert.equal(fields['语言'], 'ja → zh-Hans');
    assert.equal(fields['任务数'], '5');
    assert.equal(fields['每任务批量'], '1');
    assert.equal(fields['到达间隔'], '0 ms');
    assert.equal(fields['成功时限'], `${new Intl.NumberFormat('zh-CN').format(5000)} ms`);
    report.visibleConditions = fields;
  });

  await check('desktop-record-blocks-fill-history-width-with-no-horizontal-overflow', async () => {
    const size = await dimensions(page);
    assert.ok(size.document <= size.viewport + 1, JSON.stringify(size));
    assert.ok(size.body <= size.viewport + 1, JSON.stringify(size));
    assert.ok(size.historyClient > 0 && size.listClient > 0, JSON.stringify(size));
    assert.ok(size.historyScroll <= size.historyClient + 1, JSON.stringify(size));
    assert.ok(size.listScroll <= size.listClient + 1, JSON.stringify(size));
    assert.equal(size.records.length, 2);
    for (const record of size.records) {
      assert.ok(record.clientWidth > 0, JSON.stringify(record));
      assert.ok(Math.abs(record.clientWidth - record.parentWidth) <= 1, JSON.stringify(record));
      assert.ok(record.scrollWidth <= record.clientWidth + 1, JSON.stringify(record));
    }
    report.desktopDimensions = size;
    await captureHistory(page, 'desktop-history-record-blocks');
  });

  await check('all-locales-translate-history-and-controls-without-changing-drafts-or-starting-tests', async () => {
    const count = await page.locator('#performance-count').inputValue();
    const selected = await page.locator('#performance-models input:checked').evaluateAll(nodes => nodes.map(el => el.dataset.modelId));
    const before = await page.evaluate(() => ({ starts: __performanceHistoryUiTrace.startMessages,
      deletes: __performanceHistoryUiTrace.historyDeletePayloads.length }));
    await page.locator('#performance-count').focus();
    for (const { code } of LOCALES) {
      await page.evaluate(code => chrome.storage.local.set({ 'ui.locale.v1': code }), code);
      await page.waitForFunction(code => document.documentElement.lang === code, code);
      assert.equal(await page.locator('.history-heading-title').textContent(), catalogs[code]['performance.history']);
      assert.equal(await page.locator('.history-delete').first().textContent(), catalogs[code]['performance.history.delete']);
      assert.ok((await page.locator('.history-conditions').first().textContent()).includes(catalogs[code]['performance.history.language']));
      assert.equal(await page.locator('#performance-history-rows details[open]').count(), 1);
      assert.equal(await page.locator('#performance-history-disclosure').evaluate(el => el.open), true);
      assert.equal(await page.locator('#performance-count').inputValue(), count);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'performance-count');
      assert.deepEqual(await page.locator('#performance-models input:checked').evaluateAll(nodes => nodes.map(el => el.dataset.modelId)), selected);
      assert.deepEqual(await page.evaluate(() => ({ starts: __performanceHistoryUiTrace.startMessages,
        deletes: __performanceHistoryUiTrace.historyDeletePayloads.length })), before);
      const size = await dimensions(page);
      assert.ok(size.document <= size.viewport + 1 && size.historyScroll <= size.historyClient + 1, code);
      if (['en', 'de', 'ja', 'ar', 'zh-TW'].includes(code)) await captureHistory(page, 'history-' + code);
    }
    await page.evaluate(() => chrome.storage.local.set({ 'ui.locale.v1': 'zh-CN' }));
    await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
  });

  await check('history-persists-after-reopening-options-page', async () => {
    await page.close();
    page = await context.newPage();
    page.on('pageerror', error => report.browserErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.browserErrors.push(message.text()); });
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await settingsSection(page, 'performance');
    await page.waitForFunction(() => document.querySelectorAll('#performance-history-rows > .history-record').length === 2);
    const historyDisclosure = page.locator('#performance-history-disclosure');
    if (!await historyDisclosure.evaluate(el => el.open)) await historyDisclosure.locator(':scope > summary').click();
    assert.equal(await page.locator('#performance-history-rows details[open]').count(), 0);
    const rows = await page.locator('#performance-history-rows > .history-record').allTextContents();
    assert.ok(rows.some(text => text.includes('7B.gguf')));
    assert.ok(rows.some(text => text.includes('1.8B.gguf')));
    return rows.length;
  });

  await check('json-export-contains-only-safe-history-fields', async () => {
    const data = await exportHistory(page, 'history-export.json');
    assert.deepEqual(new Set(data.records.map(record => record.model)), new Set(['7B.gguf', '1.8B.gguf']));
  });

  await check('burst-checkbox-preserves-fields-restores-previous-values-and-clears-on-manual-change', async () => {
    await page.locator('#performance-mode').selectOption('load');
    await page.locator('#performance-batch-size').fill('5');
    await page.locator('#performance-arrival').fill('250');
    await page.locator('#performance-budget').fill('3000');
    await page.locator('#performance-strategy').selectOption('superchat');
    await page.locator('#performance-count').fill('17');
    await page.locator('#performance-concurrency').fill('7');
    await page.locator('#performance-burst').check();
    const preset = await page.evaluate(() => Object.fromEntries(['count','mode','concurrency','batch-size','arrival','budget','strategy']
      .map(id => [id, document.querySelector(`#performance-${id}`).value])));
    assert.deepEqual(preset, { count: '17', mode: 'load', concurrency: '7', 'batch-size': '1', arrival: '0', budget: '5000', strategy: 'normal' });
    assert.equal(await page.locator('#performance-burst').isChecked(), true);
    await page.locator('#performance-burst').uncheck();
    const restored = await page.evaluate(() => Object.fromEntries(['count','mode','concurrency','batch-size','arrival','budget','strategy']
      .map(id => [id, document.querySelector(`#performance-${id}`).value])));
    assert.deepEqual(restored, { count: '17', mode: 'load', concurrency: '7', 'batch-size': '5', arrival: '250', budget: '3000', strategy: 'superchat' });
    await page.locator('#performance-burst').check();
    await page.locator('#performance-batch-size').fill('3');
    assert.equal(await page.locator('#performance-burst').isChecked(), false);
    assert.equal(await page.locator('#performance-batch-size').inputValue(), '3');
    const starts = await page.evaluate(() => globalThis.__performanceHistoryUiTrace.startMessages);
    assert.equal(starts, 0, 'editing or toggling the preset must not send performance-start');
    report.burstPreset = { preset, restored, manuallyChangedBatchSize: 3, automaticallyUnchecked: true, startMessages: starts };
  });

  await check('local-batch-start-payload-phases-and-stop-are-ui-only-fixtures', async () => {
    await page.locator('#performance-mode').selectOption('load');
    await page.locator('#performance-count').fill('17');
    await page.locator('#performance-concurrency').fill('7');
    await page.locator('#performance-batch-size').fill('1');
    await page.locator('#performance-arrival').fill('0');
    await page.locator('#performance-budget').fill('5000');
    await page.locator('#performance-strategy').selectOption('normal');
    await page.locator('#performance-source').selectOption('ja');
    await page.locator('#performance-target').selectOption('zh-Hans');
    await page.locator('#performance-parallel').fill('3');
    await page.locator('#performance-context').fill('4096');
    await page.locator('#performance-prompt').selectOption('hy-mt');
    await page.locator(`#performance-models input[data-model-id="${modelListFixture[1].id}"]`).check();
    await page.locator('#performance-start').click();
    await page.waitForFunction(() => globalThis.__performanceHistoryUiTrace.batchStatusPhases.includes('testing'));

    const payload = await page.evaluate(() => globalThis.__performanceHistoryUiTrace.startPayloads[0]);
    assert.ok(payload);
    assert.equal(payload.settings.backend, 'local');
    assert.equal(payload.settings.localModelId, modelListFixture[0].id);
    assert.equal(payload.settings.liveSourceLanguage, 'ja');
    assert.equal(payload.settings.targetLanguage, 'zh-Hans');
    assert.deepEqual(payload.modelIds, modelListFixture.map(model => model.id));
    assert.deepEqual(payload.config, { count: 17, mode: 'load', concurrency: 7, batchSize: 1, arrivalIntervalMs: 0, strategy: 'normal', budgetMs: 5000 });
    assert.equal(payload.settings.localPerformance.mode, 'custom');
    assert.equal(payload.settings.localPerformance.parallel, 3);
    assert.equal(payload.settings.localPerformance.contextTokens, 4096);
    assert.equal(payload.settings.localPerformance.promptMode, 'hy-mt');
    assert.equal(await page.locator('#performance-start').isDisabled(), true);
    assert.equal(await page.locator('#performance-stop').isDisabled(), false);
    assert.equal(await page.locator('#performance-models input[data-model-id]').first().isDisabled(), true);

    await page.waitForFunction(() => globalThis.__performanceHistoryUiTrace.batchStatusPhases.includes('finishing'));
    assert.equal(await page.locator('#performance-start').isDisabled(), true);
    assert.equal(await page.locator('#performance-stop').isDisabled(), false);
    assert.equal(await page.locator('#performance-count').isDisabled(), true);
    await page.locator('#performance-stop').click();
    await page.waitForFunction(() => globalThis.__performanceHistoryUiTrace.batchStatusPhases.includes('done') &&
      document.querySelector('#performance-start')?.disabled === false);
    const trace = await page.evaluate(() => globalThis.__performanceHistoryUiTrace);
    assert.equal(trace.startMessages, 1);
    assert.equal(trace.stopMessages, 1);
    assert.deepEqual(trace.batchStatusPhases.slice(0, 4), ['preparing', 'unloading', 'loading', 'testing']);
    assert.ok(trace.batchStatusPhases.includes('saving'));
    assert.ok(trace.batchStatusPhases.includes('finishing'));
    assert.equal(trace.batchStatusPhases.at(-1), 'done');
    assert.equal(trace.localControlActions.some(action => ['load', 'ensure', 'benchmark-start'].includes(action)), false);
    report.performanceBatchFixture = {
      startPayload: { modelIds: payload.modelIds, config: payload.config, localSettings: payload.settings.localPerformance },
      observedPhases: trace.batchStatusPhases, stopMessages: trace.stopMessages,
      modelLoadRequested: false, realPerformanceStartSentToBackground: false,
    };
  });

  await check('delete-is-persisted-and-does-not-return-after-reopening-or-export', async () => {
    const deleted = fixtures[1].record;
    const row = page.locator(`#performance-history-rows [data-record-id="${deleted.id}"]`);
    const details = row.locator('details');
    if (await details.evaluate(el => el.open)) await row.locator('summary').click();
    assert.equal(await details.evaluate(el => el.open), false);
    assert.equal(await row.locator('.history-delete').isVisible(), true);
    await row.locator('.history-delete').click();
    await page.waitForFunction(id => !document.querySelector(`#performance-history-rows [data-record-id="${id}"]`), deleted.id);
    const trace = await page.evaluate(() => globalThis.__performanceHistoryUiTrace);
    assert.deepEqual(trace.historyDeletePayloads, [
      // The earlier failed deletion was checked before this document was reopened.
      { type: 'performance-history-delete', ids: [deleted.id] },
    ]);
    const stored = await page.evaluate(key => chrome.storage.local.get(key), PERFORMANCE_HISTORY_KEY);
    const remaining = stored[PERFORMANCE_HISTORY_KEY];
    assert.equal(remaining.length, 1);
    assert.equal(remaining.some(record => record.id === deleted.id), false);
    report.historyDeleteRequest = trace.historyDeletePayloads.at(-1);

    await page.close();
    page = await context.newPage();
    page.on('pageerror', error => report.browserErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.browserErrors.push(message.text()); });
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await settingsSection(page, 'performance');
    await page.waitForFunction(() => document.querySelectorAll('#performance-history-rows > .history-record').length === 1);
    const rows = await page.locator('#performance-history-rows > .history-record').allTextContents();
    assert.ok(rows.some(text => text.includes('7B.gguf')));
    assert.equal(rows.some(text => text.includes('1.8B.gguf')), false);
    const data = await exportHistory(page, 'history-export-after-delete.json', 1);
    assert.deepEqual(data.records.map(record => record.id), [fixtures[0].record.id]);
    report.deletedRecord = { id: deleted.id, absentFromStorage: true, absentAfterReopen: true, absentFromExport: true };
    return rows.length;
  });

  await check('save-failure-state-keeps-current-report-exportable', async () => {
    await page.locator('#performance-history-rows summary').click();
    await page.evaluate(() => {
      globalThis.__performanceHistoryUiTrace.mode = 'save-failed';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.locator('#performance-save-status').getByText(/记录未能保存/).waitFor({ state: 'visible' });
    assert.equal(await page.locator('#performance-history-rows details[open]').count(), 1);
    assert.equal(await page.locator('#performance-retry-save').isVisible(), true);
    const statusReads = await page.evaluate(() => globalThis.__performanceHistoryUiTrace.mockedStatusMessages);
    assert.ok(statusReads > 0);
    report.failureState = { simulatedPerformanceStatusMessages: statusReads, retryButtonVisible: true, realSaveOrRetryPerformed: false };
    await capture(page, 'save-failed-current-report');
    const data = await exportHistory(page, 'history-export-after-save-failure.json', 1);
    assert.equal(data.records.length, 1);
    assert.ok(data.records.some(record => record.id === fixtures[0].record.id));
    return data.records.length;
  });

  await check('560px-record-block-fills-history-width-with-no-horizontal-overflow', async () => {
    await page.setViewportSize({ width: 560, height: 900 });
    const size = await dimensions(page);
    assert.ok(size.document <= size.viewport + 1, JSON.stringify(size));
    assert.ok(size.body <= size.viewport + 1, JSON.stringify(size));
    assert.ok(size.historyClient > 0 && size.listClient > 0, JSON.stringify(size));
    assert.ok(size.historyScroll <= size.historyClient + 1, JSON.stringify(size));
    assert.ok(size.listScroll <= size.listClient + 1, JSON.stringify(size));
    assert.equal(size.records.length, 1);
    for (const record of size.records) {
      assert.ok(record.clientWidth > 0, JSON.stringify(record));
      assert.ok(Math.abs(record.clientWidth - record.parentWidth) <= 1, JSON.stringify(record));
      assert.ok(record.scrollWidth <= record.clientWidth + 1, JSON.stringify(record));
    }
    report.mobileDimensions = size;
    await captureHistory(page, 'mobile-560-history-record-block');
    return size;
  });

  await check('online-test-uses-independent-model-current-service-and-permission-without-saving-settings', async () => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    const savedBefore = await page.evaluate(() => chrome.storage.local.get('settings.v1'));
    await page.locator('#performance-backend').selectOption('online');
    assert.equal(await page.locator('#performance-model-field').isVisible(), false);
    assert.equal(await page.locator('#performance-parallel').isVisible(), false);
    assert.equal(await page.locator('#performance-online-field').isVisible(), true);
    assert.equal(await page.locator('#performance-online-model').inputValue(), 'fixture-online-default');
    await page.waitForFunction(() => document.querySelector('#performance-online-models option[value="fixture-online-alternative"]'));
    await page.locator('#performance-online-configure').click();
    await page.waitForURL(/#service$/);
    assert.equal(await page.locator('#backend').inputValue(), 'online');
    await page.locator('#api-key').fill('fixture-key-only');
    await page.locator('#backend').selectOption('local');
    await settingsSection(page, 'performance');
    assert.equal(await page.locator('#performance-backend').inputValue(), 'online');
    await page.locator('#performance-online-model').fill('fixture-online-custom');
    await page.locator('#performance-count').fill('3');
    await page.evaluate(() => { globalThis.__performanceHistoryUiTrace.denyPermission = true; });
    await page.locator('#performance-start').click();
    assert.equal(await page.evaluate(() => globalThis.__performanceHistoryUiTrace.startMessages), 0);
    assert.equal(await page.locator('#performance-start').isDisabled(), false);
    await page.evaluate(() => { globalThis.__performanceHistoryUiTrace.denyPermission = false; });
    await page.locator('#performance-start').click();
    await page.waitForFunction(() => globalThis.__performanceHistoryUiTrace.startMessages === 1);
    const payload = await page.evaluate(() => globalThis.__performanceHistoryUiTrace.startPayloads[0]);
    assert.equal(payload.settings.backend, 'online');
    assert.equal(payload.settings.model, 'fixture-online-custom');
    assert.equal(payload.settings.endpoint, 'https://fixture.invalid/v1/chat/completions');
    assert.equal(payload.apiKey, 'fixture-key-only');
    assert.equal(payload.modelIds, undefined);
    assert.equal(payload.config.count, 3);
    const permissionRequests = await page.evaluate(() => globalThis.__performanceHistoryUiTrace.permissionRequests);
    assert.deepEqual(permissionRequests, [{ origins: ['https://fixture.invalid/*'] }, { origins: ['https://fixture.invalid/*'] }]);
    assert.deepEqual(await page.evaluate(() => chrome.storage.local.get('settings.v1')), savedBefore);
    await page.locator('.performance-panel').scrollIntoViewIfNeeded();
    await capture(page, 'online-test-controls');
    report.onlineFixture = { backend: payload.settings.backend, model: payload.settings.model, count: payload.config.count,
      permissionDeniedPreventedStart: true, savedSettingsUnchanged: true, realProviderCalled: false };
  });

  await check('fixture-acceptance-sends-no-external-http-or-model-load', async () => {
    assert.deepEqual(report.blockedExternalHttp, []);
    const trace = await page.evaluate(() => globalThis.__performanceHistoryUiTrace);
    assert.equal(trace.localControlActions.some(action => ['load', 'ensure', 'benchmark-start'].includes(action)), false);
    report.fixtureOnlyVerification = { blockedExternalHttp: report.blockedExternalHttp.length, modelLoadRequested: false };
  });

  assert.deepEqual(report.browserErrors, [], 'browser console or page errors');
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.errors.push(error?.stack ?? String(error));
  process.exitCode = 1;
} finally {
  await context?.close();
  if (profileDir) {
    const tempRoot = resolve(tmpdir());
    const rel = relative(tempRoot, resolve(profileDir));
    assert.ok(basename(profileDir).startsWith('danlingo-performance-history-edge-'));
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), 'temporary profile must remain under the OS temp directory');
    await rm(profileDir, { recursive: true, force: true });
    report.temporaryProfileRemoved = true;
  }
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log('REPORT', reportPath);
}
