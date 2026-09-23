import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Real built options UI/storage with an explicitly simulated local-runtime boundary.
// Does not load a model, use a provider, or touch the user's browser/profile.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '../src/core/config.ts';
import { normalizeLocalConfig, resolveLocalConfig } from '../src/local/config.ts';
import { aggregateLocalBenchmark, recommendLocalBenchmark } from '../src/local/benchmark.ts';
import { settingsSection, settingsDetails } from './settings-navigation.mjs';

const root = resolve('.artifacts/local-settings');
await mkdir(root, { recursive: true });
const directory = await mkdtemp(resolve(root, 'run-'));
const extension = resolve(directory, 'extension'), profile = resolve(directory, 'profile');
const report = { evidence: 'BUILT_OPTIONS_UI_AND_REAL_STORAGE_WITH_SIMULATED_LOCAL_RUNTIME', directory,
  checks: {}, screenshots: [], errors: [], limitations: ['Local load/warmup/benchmark responses are fixtures. Native GPU and production bridge evidence are separate benchmark artifacts.'] };
const model = { id: 'fixture-local-model', name: 'Fixture HY-MT.gguf', bytes: 1908528288, files: ['Fixture HY-MT.gguf'], architecture: 'hunyuan-dense', quantization: 'Q8_0', tokenizer: 'gpt2', template: true, importedAt: 1 };
const initial = { phase: 'idle', backend: 'wllama 3.6.1 · WebGPU', generation: 0, queued: 0, active: 0, completed: 0, failed: 0, cancelled: 0, peakActive: 0, inferenceCalls: 0, contextTokens: 2048, verifiedTranslation: false };
const fixtureConfig = normalizeLocalConfig({ mode: 'custom', parallel: 4 });
const runtime = resolveLocalConfig(fixtureConfig, model.id);
const group = (parallel, workload) => {
  const config = normalizeLocalConfig({ mode: 'custom', parallel });
  const samples = Array.from({ length: 32 }, (_, i) => ({ id: `${workload}-${i}`, corpusId: `${workload}-${i}`, workload,
    source: 'fixture source', output: '模拟译文', quality: 'needs-review', protocolSuccess: true, admittedAt: 0,
    startedAt: i * 12, finishedAt: (i + 1) * (parallel === 4 ? 25 : 40), status: 'success', queueMs: i * 12,
    promptMs: 20, decodeMs: 30, inputTokens: 35, outputTokens: 12, gpuExecutionMs: null, gpuAllocatedBytes: 2100000000 }));
  return { variantId: `p${parallel}`, name: `parallel-${parallel}`, workload, config, runtime: resolveLocalConfig(config, model.id),
    status: 'completed', expected: 32, completed: 32, samples, stats: aggregateLocalBenchmark(samples), fallbackReasons: [],
    ...(parallel === 4 ? { gpuObservation: { completeComputeMs: 200, sampledComputeMs: 200, computePassCoverage: 1,
      scope: 'group-compute-passes', boundariesFlushed: true, pendingTimingRecordsBefore: 0, pendingTimingRecordsAfter: 0 } } : {}) };
};
const groups = [1, 2, 4, 8, 16].flatMap(p => ['short', 'normal', 'long'].map(w => group(p, w)));
const recommendation = recommendLocalBenchmark([1, 2, 4, 8, 16].map(parallel => ({ parallel, requestsPerSecond: parallel === 4 ? 40 : 25,
  p95Ms: parallel === 4 ? 775 : 1240, meanQueueMs: 186, gpuAllocatedBytes: 2100000000, successRate: 1, timeoutRate: 0 })));
const benchmark = { id: 'fixture-benchmark', modelId: model.id, startedAt: 1, finishedAt: 2, status: 'completed', phase: 'done',
  options: { parallels: [1, 2, 4, 8, 16], workloads: ['short', 'normal', 'long'], count: 32, applicationConcurrency: 32 }, groups,
  corpusTokens: [], recommendation, recommendedVariant: { variantId: 'p4', name: 'parallel-4', config: fixtureConfig }, model,
  evidence: 'SIMULATED UI REPORT; no native inference measurement.' };
let context, page;
const check = async (name, fn) => { await fn(); report.checks[name] = 'PASS'; console.log('PASS', name); };
try {
  await cp(resolve('.output/chrome-mv3'), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions.push('https://fixture.invalid/*');
  await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
  const { chromium } = await loadPlaywright();
  context = await chromium.launchPersistentContext(profile, { headless: true,
    ...browserLaunchOptions("chromium"), viewport: { width: 1360, height: 900 },
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND'] });
  await context.route(/^https?:/, route => route.abort());
  const background = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await context.addInitScript(({ model, initial, runtime, benchmark }) => {
    if (!globalThis.chrome?.runtime?.id) return;
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    let pendingLoad, pendingStop, pendingTest;
    const fixture = globalThis.__localFixture = { state: structuredClone(initial), calls: [], report: null, failLoad: false, failStart: false,
      ready() { this.state = { ...this.state, phase: 'ready', stage: 'loaded', model, runtime,
        contextTokens: runtime.contextTokens, nativeSlots: runtime.parallel, warmupMs: 100,
        gpu: { vendor: 'fixture', architecture: 'simulated', verified: true, offloadedLayers: 33, totalLayers: 33, allocatedBytes: 2100000000, flashAttention: true } };
        pendingLoad?.({ ok: true, state: this.state }); pendingLoad = undefined; },
      finish() { this.report = structuredClone(benchmark); },
      finishTest() { pendingTest?.({ok:true,model:model.name,sourceText:'测试原文',text:'テストの翻訳',elapsedMs:150,targetLanguage:'ja',promptMode:'hy-mt',verification:'basic-language-check'});pendingTest=undefined; },
      finishStop() { this.report = { ...this.report, status: 'cancelled', phase: 'done', recommendedVariant: null };
        pendingStop?.({ ok: true, state: structuredClone(this.state), report: structuredClone(this.report) }); pendingStop = undefined; },
    };
    chrome.runtime.sendMessage = function (message, ...rest) {
      if(message?.type==='test-model')return new Promise(resolve=>{pendingTest=resolve;});
      if (message?.type !== 'local-control') return original(message, ...rest);
      const control = message.control; fixture.calls.push(structuredClone(control));
      if (control.action === 'load') {
        if (fixture.failLoad) return Promise.resolve({ ok: false, error: 'LOCAL_FLASH_ATTENTION_UNAVAILABLE' });
        fixture.state = { ...fixture.state, model, phase: 'warming', stage: 'warming', generation: fixture.state.generation + 1 };
        return new Promise(resolve => { pendingLoad = resolve; });
      }
      if (control.action === 'cancel' || control.action === 'unload') {
        fixture.state = structuredClone(initial);
        pendingLoad?.({ ok: false, error: 'LOCAL_CANCELLED' }); pendingLoad = undefined;
      }
      if (control.action === 'benchmark-start') {
        if (fixture.failStart) return Promise.resolve({ ok: false, error: 'LOCAL_BENCHMARK_BUSY' });
        fixture.report = { ...structuredClone(benchmark), status: 'running', phase: 'loading', finishedAt: undefined, groups: [], recommendedVariant: null };
      }
      if (control.action === 'benchmark-stop') {
        fixture.report = { ...fixture.report, status: 'stopping', phase: 'restoring', recommendedVariant: null };
        return new Promise(resolve => { pendingStop = resolve; });
      }
      return Promise.resolve({ ok: true, models: [model], state: structuredClone(fixture.state), report: structuredClone(fixture.report) });
    };
  }, { model, initial, runtime, benchmark });
  page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  const url = `chrome-extension://${new URL(background.url()).host}/options.html`;
  await page.goto(url); await page.locator('#backend').waitFor();
  await page.evaluate(settings => chrome.runtime.sendMessage({ type: 'save', settings, apiKey: '', remember: false }), {
    ...DEFAULT_SETTINGS, backend: 'local', localModelId: model.id, endpoint: 'https://fixture.invalid/v1', model: 'retained-online-model' });
  await page.reload(); await page.locator('#local-model').selectOption(model.id);
  for (const width of [1360, 560, 360]) {
    await page.setViewportSize({ width, height: 900 });
    const path = resolve(directory, `local-${width}.png`);
    await page.locator('#local-settings').screenshot({ path }); report.screenshots.push(path);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `horizontal overflow at ${width}`);
  }
  report.checks.earlyLocalPreview = 'PASS';
  if (!process.argv.includes('--preview-only')) {
    const rpc = message => page.evaluate(message => chrome.runtime.sendMessage(message), message);
    const saved = async () => (await rpc({ type: 'overview' })).settings;
    const open = async id => settingsDetails(page, id);
    const save = async () => { await page.locator('#save').click(); await page.waitForFunction(() => document.querySelector('#result').textContent === '已保存'); };
    const start = async () => { await page.locator('#lb-start').click(); await page.waitForFunction(() => document.querySelector('#lb-status').textContent.includes('运行中')); };
    const finish = async () => { await page.evaluate(() => __localFixture.finish()); await page.waitForFunction(() => document.querySelector('#lb-status').textContent.includes('已完成')); };
    await check('pending-local-test-names-local-model-not-retained-online-model',async()=>{
      await settingsSection(page,'service');await page.locator('#test-model').click();
      await page.waitForFunction(()=>document.querySelector('#test-result').textContent.includes('正在测试 Fixture HY-MT.gguf'));
      assert.doesNotMatch(await page.locator('#test-result').textContent(),/retained-online-model/);
      const path=resolve(directory,'pending-local-test.png');await page.locator('.service-action').filter({has:page.locator('#test-model')}).screenshot({path});report.screenshots.push(path);
      await page.evaluate(()=>__localFixture.finishTest());
      await page.waitForFunction(()=>document.querySelector('#test-result').textContent.includes('格式与语言检查通过'));
      assert.equal((await saved()).model,'retained-online-model');
    });
    await check('local-defaults-and-preset-resolution', async () => {
      await settingsSection(page, 'advanced');
      assert.equal(await page.locator('#lp-mode').inputValue(), 'auto');
      assert.match(await page.locator('#lp-summary').textContent(), /计划 4 序列.*上下文 2048/);
      await settingsSection(page, 'performance');
      assert.equal(await page.locator('#performance-start').isVisible(), true); // Production latency/load replay is also available locally.
      await settingsSection(page, 'advanced');
      await page.locator('#lp-mode').selectOption('high-performance');
      assert.match(await page.locator('#lp-summary').textContent(), /计划 8 序列.*上下文 4096.*512\/256/);
      await page.locator('#lp-mode').selectOption('custom'); await open('#lp-capacity');
      assert.equal(await page.locator('#lp-parallel').isEnabled(), true);
    });
    await check('custom-config-save-and-reload-preserves-online-settings', async () => {
      await page.locator('#lp-parallel').fill('8'); await page.locator('#lp-contextTokens-mode').selectOption('custom'); await page.locator('#lp-contextTokens-value').fill('8192');
      await page.locator('#lp-batchPreset').selectOption('custom');
      await page.locator('#lp-batch').fill('512'); await page.locator('#lp-microBatch').fill('128');
      await page.locator('#lp-temperature').evaluate(el => { el.closest('details').open = true; });
      await page.locator('#lp-temperature').fill('0.05'); await page.locator('#lp-normalMaxTokens').fill('96');
      await settingsSection(page, 'live'); await page.locator('#lp-superChatReasoning').selectOption('on'); await page.locator('#lp-superChatMaxTokens').fill('384');
      await save(); const value = await saved();
      assert.equal(value.localPerformance.parallel, 8); assert.equal(value.localPerformance.microBatch, 128);
      assert.equal(value.localPerformance.temperature, .05); assert.equal(value.localPerformance.superChatReasoning, 'on');
      assert.equal(value.localPerformance.normalMaxTokens, 96); assert.equal(value.localPerformance.superChatMaxTokens, 384);
      assert.equal(value.model, 'retained-online-model'); assert.equal(value.backend, 'local');
      await page.reload(); await settingsSection(page, 'advanced'); await page.locator('#lp-mode').waitFor();
      await page.waitForFunction(() => document.querySelector('#lp-parallel').value === '8');
      assert.equal(await page.locator('#lp-superChatReasoning').inputValue(), 'on');
    });
    await check('user-controlled-custom-parameters-and-wait-persist', async () => {
      await open('#lp-capacity');
      await page.locator('#lp-parallel').fill('40');
      await page.locator('#lp-contextTokens-mode').selectOption('custom'); await page.locator('#lp-contextTokens-value').fill('32768');
      await page.locator('#lp-cpuThreads-mode').selectOption('custom'); await page.locator('#lp-cpuThreads-value').fill('12');
      await page.locator('#lp-allowAutoFallback').uncheck();
      await page.locator('#lp-temperature').evaluate(el => { el.closest('details').open = true; });
      await page.locator('#lp-normalMaxTokens').fill('2048'); await page.locator('#lp-promptMode').selectOption('hy-mt');
      await page.locator('#lp-languageValidation').selectOption('off');
      assert.equal(await page.locator('#lp-reusePromptCache').isChecked(), false);
      await page.locator('#lp-reusePromptCache').check();
      await settingsSection(page, 'live'); await page.locator('#live-buffer').fill('7500');
      await save(); const value = await saved();
      assert.equal(value.liveBufferMs, 7500); assert.equal(value.localPerformance.parallel, 40);
      assert.equal(value.localPerformance.contextTokens, 32768); assert.equal(value.localPerformance.cpuThreads, 12);
      assert.equal(value.localPerformance.normalMaxTokens, 2048); assert.equal(value.localPerformance.allowAutoFallback, false);
      assert.equal(value.localPerformance.promptMode, 'hy-mt'); assert.equal(value.localPerformance.languageValidation, 'off');
      assert.equal(value.localPerformance.reusePromptCache, true);
      for (const width of [1360,360]) {
        await page.setViewportSize({width,height:900}); await settingsSection(page,'advanced');
        const path=resolve(directory,`custom-controls-${width}.png`); await page.locator('#local-performance-host').screenshot({path}); report.screenshots.push(path);
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      }
      await settingsSection(page,'service'); await page.locator('#model-test-text').fill('今天的直播很有趣。');
      const path=resolve(directory,'custom-test-360.png'); await page.locator('label').filter({has:page.locator('#model-test-text')}).screenshot({path}); report.screenshots.push(path);
    });
    await check('unsaved-load-config-warmup-cancellation-and-ready', async () => {
      await open('#lp-capacity'); await page.locator('#lp-parallel').fill('4');
      await settingsSection(page, 'service');
      await page.locator('#local-load').click();
      await page.waitForFunction(() => document.querySelector('#local-state').textContent.includes('预热中'));
      const load = await page.evaluate(() => __localFixture.calls.filter(c => c.action === 'load').at(-1));
      assert.equal(load.config.parallel, 4); assert.equal((await saved()).localPerformance.parallel, 40);
      assert.equal(await page.locator('#local-load').isEnabled(), false);
      assert.equal(await page.locator('#local-cancel').isEnabled(), true);
      await page.locator('#local-cancel').click();
      await page.waitForFunction(() => document.querySelector('#local-state').textContent.includes('未加载'));
      await page.locator('#local-load').click(); await page.evaluate(() => __localFixture.ready());
      await page.waitForFunction(() => document.querySelector('#local-state').textContent.includes('已就绪'));
      assert.match(await page.locator('#local-state').textContent(), /原生槽位 4/);
    });
    await check('invalid-capacity-and-load-error-remain-visible', async () => {
      await open('#lp-capacity');
      await page.locator('#lp-microBatch').fill('1024');
      assert.match(await page.locator('#lp-summary').textContent(), /参数无效/);
      await settingsSection(page, 'service'); await page.locator('#save').click();
      await page.waitForFunction(() => document.activeElement.id === 'lp-microBatch');
      assert.equal(new URL(page.url()).hash, '#advanced', 'semantic config errors reveal their field');
      const before = await page.evaluate(() => __localFixture.calls.filter(c => c.action === 'load').length);
      await settingsSection(page, 'service'); await page.locator('#local-load').click();
      assert.equal(await page.evaluate(() => __localFixture.calls.filter(c => c.action === 'load').length), before);
      await open('#lp-capacity'); await page.locator('#lp-microBatch').fill('128'); await settingsSection(page, 'service');
      await page.evaluate(() => { __localFixture.failLoad = true; }); await page.locator('#local-load').click();
      await page.waitForFunction(() => document.querySelector('#local-result').classList.contains('error'));
      assert.match(await page.locator('#local-result').textContent(), /Flash Attention|FA|本地模型操作失败/);
      await page.evaluate(() => { __localFixture.failLoad = false; });
    });
    await check('benchmark-parameters-stop-restoration-and-start-error', async () => {
      await open('#lb-panel');
      assert.equal(await page.locator('#lb-start').isEnabled(), true);
      await start(); const call = await page.evaluate(() => __localFixture.calls.filter(c => c.action === 'benchmark-start').at(-1));
      assert.deepEqual(call.options.parallels, [1,2,4,8,16]); assert.equal(call.options.count, 32);
      assert.deepEqual(call.options.workloads, ['short','normal','long']); assert.equal(call.options.baseConfig.parallel, 4);
      assert.equal(await page.locator('#local-load').isEnabled(), false);
      await settingsSection(page, 'service'); await page.locator('#backend').selectOption('online'); await page.locator('#running-task').click();
      assert.equal(await page.locator('#lb-stop').isEnabled(), true, 'running local test keeps its stop control after backend draft changes');
      await page.locator('#lb-stop').click();
      await page.waitForFunction(() => document.querySelector('#lb-status').textContent.includes('恢复原配置'));
      assert.equal(await page.locator('#lb-start').isEnabled(), false);
      await page.evaluate(() => __localFixture.finishStop());
      await page.waitForFunction(() => document.querySelector('#lb-status').textContent.includes('已停止'));
      assert.equal(await page.locator('#lb-apply').isEnabled(), false);
      await settingsSection(page, 'service'); await page.locator('#backend').selectOption('local'); await settingsSection(page, 'performance');
      await page.evaluate(() => { __localFixture.failStart = true; }); await page.locator('#lb-start').click();
      await page.waitForFunction(() => document.querySelector('#lb-status').textContent.includes('LOCAL_BENCHMARK_BUSY'));
      await page.evaluate(() => { __localFixture.failStart = false; });
    });
    await check('benchmark-curves-export-and-model-scoped-recommendation', async () => {
      await start(); await finish();
      assert.equal(await page.locator('#lb-charts svg').count(), 3);
      assert.equal(await page.locator('#lb-results > details').count(), 15);
      await page.locator('#lb-results > details').first().evaluate(el => { el.open = true; });
      assert.match(await page.locator('#lb-results').textContent(), /P99.*最小.*最大/s);
      assert.match(await page.locator('#lb-results').textContent(), /GPU 计算时间不含数据传输/);
      assert.match(await page.locator('#lb-results').textContent(), /本组完整计算 200.0 ms · pass 覆盖 100.0%/);
      const download = page.waitForEvent('download'); await page.locator('#lb-export').click();
      const item = await download, file = resolve(directory, 'exported-benchmark.json'); await item.saveAs(file);
      const exported = JSON.parse(await readFile(file, 'utf8')); assert.equal(exported.groups.length, 15); assert.equal(exported.modelId, model.id);
      await page.locator('#lb-apply').click(); assert.equal(await page.locator('#lp-mode').inputValue(), 'auto');
      assert.match(await page.locator('#lp-summary').textContent(), /计划 4 序列.*此模型实测建议/);
      assert.equal(await page.locator('#lp-temperature').inputValue(), '0.05');
      await save(); const value = await saved();
      assert.equal(value.localPerformance.autoRecommendation.modelId, model.id);
      assert.equal(value.localPerformance.autoRecommendation.parallel, 4);
      assert.equal(value.localPerformance.superChatReasoning, 'on');
      // Switching the selected model immediately blocks applying another model's advice.
      await page.locator('#local-model').evaluate(el => { el.add(new Option('Other fixture', 'other')); el.value = 'other'; el.dispatchEvent(new Event('change', {bubbles:true})); });
      assert.equal(await page.locator('#lb-apply').isEnabled(), false);
      await settingsSection(page, 'service'); await page.locator('#local-model').selectOption(model.id); await settingsSection(page, 'performance');
      await page.locator('#theme').selectOption('dark');
      for (const width of [1360,560,360]) {
        await page.setViewportSize({width,height:900});
        const path = resolve(directory, `benchmark-${width}.png`); await page.locator('#lb-panel').screenshot({path}); report.screenshots.push(path);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'benchmark overflow '+width);
      }
    });
    await check('undersized-benchmark-cannot-be-applied', async () => {
      await start();
      await page.evaluate(() => { __localFixture.finish(); for (const group of __localFixture.report.groups) if (group.variantId === 'p4') group.expected = group.completed = 4; });
      await page.waitForFunction(() => document.querySelector('#lb-status').textContent.includes('已完成'));
      assert.equal(await page.locator('#lb-apply').isEnabled(), false);
    });
    await check('hidden-local-and-benchmark-invalid-drafts-do-not-block-online-save', async () => {
      await settingsSection(page, 'advanced');
      await page.locator('#lp-mode').selectOption('custom'); await open('#lp-capacity');
      await page.locator('#lp-parallel').fill('0'); await settingsSection(page, 'performance'); await page.locator('#lb-count').fill('0');
      await settingsSection(page, 'service'); await page.locator('#backend').selectOption('online'); await settingsSection(page, 'performance');
      assert.equal(await page.locator('#performance-start').isVisible(), true);
      assert.equal(await page.locator('#lp-parallel').isEnabled(), false);
      await save(); assert.equal((await saved()).backend, 'online');
      assert.equal((await saved()).localPerformance.autoRecommendation.parallel, 4);
    });
  }
  assert.deepEqual(report.errors, []);
  report.status = 'PASS';
} catch (error) { report.status = 'FAIL'; report.errors.push(error.stack ?? String(error)); process.exitCode = 1; }
finally {
  await context?.close();
  const rel = relative(directory, profile);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), 'owned profile stays within artifact directory');
  await rm(profile, { recursive: true, force: true });
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log('REPORT', resolve(directory, 'report.json'));
}
