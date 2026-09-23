import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Isolated real-GGUF benchmark. The original weights and user's browser are never changed.
import assert from 'node:assert/strict';
import { mkdir, cp, mkdtemp, readFile, writeFile, stat, open, rm, readdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectGguf } from '../src/local/gguf.ts';
import { LOCAL_BENCHMARK_CORPUS } from '../src/local/benchmark.ts';
import { buildProviderPayload } from '../src/translation/provider.ts';
import { DEFAULT_SETTINGS } from '../src/core/config.ts';
import { traceNativeActions } from './native-action-trace.mjs';
import { replaceNativeRuntime } from './native-runtime-override.mjs';
import { createHash } from 'node:crypto';
import { sampleBrowserGpuMemory } from './gpu-process-memory.mjs';

const arg = (name, fallback) => process.argv.find(value => value.startsWith('--' + name + '='))?.split('=').slice(1).join('=') ?? fallback;
const modelPath = arg('model', 'D:/Tool/Models/LmStudioModels/lmstudio-community/HY-MT1.5-1.8B-FP8/HY-MT1.5-1.8B-Q8_0.gguf');
const smoke = process.argv.includes('--smoke');
const production = process.argv.includes('--production');
const parallels = arg('parallel', smoke ? '2' : '1,2,4,8,16').split(',').map(Number);
const cpuThreads = arg('threads', 'auto') === 'auto' ? 'auto' : Number(arg('threads'));
assert.ok(parallels.every(n => Number.isInteger(n) && n >= 1 && n <= 32));
const root = resolve('.artifacts/local-multisequence'); await mkdir(root, { recursive: true });
const directory = await mkdtemp(resolve(root, 'run-')), extension = resolve(directory, 'extension');
await cp(resolve('.output/chrome-mv3'), extension, { recursive: true });
let packagedNativeBuild;
try { packagedNativeBuild = JSON.parse(await readFile(resolve(extension, 'local/native-build.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const nativeBuild = arg('native-build', '');
let nativeBuildEvidence;
if (nativeBuild) {
  const buildPath = resolve(nativeBuild), wasm = await readFile(resolve(buildPath, 'wllama.wasm'));
  const runtime = await readFile(resolve(buildPath, 'wllama.js'), 'utf8');
  const workerPath = resolve(extension, 'local/wllama-worker.js');
  await writeFile(workerPath, await replaceNativeRuntime(await readFile(workerPath, 'utf8'), runtime));
  await writeFile(resolve(extension, 'local/wllama.wasm'), wasm);
  nativeBuildEvidence = { buildPath, wasmBytes: wasm.length, wasmSha256: createHash('sha256').update(wasm).digest('hex'),
    runtimeSha256: createHash('sha256').update(runtime).digest('hex'), note: 'Isolated native build override; production JS, controller and model are unchanged. Published WASM symbol names do not apply to this binary.' };
}
const nativeTrace = process.argv.includes('--native-trace');
if (nativeTrace) {
  const workerPath = resolve(extension, 'local/wllama-worker.js');
  await writeFile(workerPath, traceNativeActions((await readFile(workerPath, 'utf8')).replaceAll('\r\n', '\n')));
}
const nativeCache = arg('native-cache', 'unchanged');
const idleCache = arg('cache-idle-slots', 'unchanged');
const contextCheckpoints = arg('ctx-checkpoints', 'unchanged');
const nativeLogLevel = arg('native-log-level', 'unchanged');
assert.ok(['unchanged', 'true', 'false'].includes(nativeCache));
assert.ok(['unchanged', 'true', 'false'].includes(idleCache));
assert.ok(['unchanged', '0'].includes(contextCheckpoints));
assert.ok(['unchanged', '1'].includes(nativeLogLevel));
if (nativeCache !== 'unchanged' || idleCache !== 'unchanged' || contextCheckpoints !== 'unchanged' || nativeLogLevel !== 'unchanged') {
  const assets = resolve(extension, 'assets');
  const workerPath = resolve(assets, (await readdir(assets)).find(name => /^inference\.worker-.*\.js$/.test(name)));
  let source = await readFile(workerPath, 'utf8');
  if (nativeCache !== 'unchanged') {
    const expression = /cache_prompt:[A-Za-z_$][\w$]*\.cache_prompt!==!1/g;
    assert.equal([...source.matchAll(expression)].length, 1, 'Pinned generation cache option anchor');
    source = source.replace(expression, `cache_prompt:${nativeCache === 'true' ? '!0' : '!1'}`);
  }
  if (idleCache !== 'unchanged') {
    const expression = /cache_idle_slots:[A-Za-z_$][\w$]*\.cache_idle_slots/g;
    assert.equal([...source.matchAll(expression)].length, 1, 'Pinned idle slot cache option anchor');
    source = source.replace(expression, `cache_idle_slots:${idleCache === 'true' ? '!0' : '!1'}`);
  }
  if (contextCheckpoints !== 'unchanged') {
    // The pinned public API omits this supported GLUE field; patch the actual load payload.
    const expression = /swa_full:[A-Za-z_$][\w$]*\.swa_full,/g;
    assert.equal([...source.matchAll(expression)].length, 1, 'Pinned native checkpoint payload anchor');
    source = source.replace(expression, match => match + 'n_ctx_checkpoints:0,');
  }
  if (nativeLogLevel !== 'unchanged') {
    const expression = /loadModel\([A-Za-z_$][\w$]*\.blobs,\{log_level:2,/g;
    assert.equal([...source.matchAll(expression)].length, 1, 'Pinned native log level anchor');
    source = source.replace(expression, match => match.replace('log_level:2', 'log_level:1'));
  }
  await writeFile(workerPath, source);
}
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
if (!production) manifest.background = { service_worker: 'benchmark-background.js' };
manifest.content_scripts = [];
manifest.host_permissions = []; manifest.optional_host_permissions = [];
await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
await writeFile(resolve(extension, 'benchmark-background.js'), `chrome.runtime.onMessage.addListener((m,s,reply)=>{
  if(m.type!=='local-benchmark-harness')return;
  (async()=>{if(!await chrome.offscreen.hasDocument())await chrome.offscreen.createDocument({url:'offscreen.html',reasons:['WORKERS','BLOBS'],justification:'Isolated local model benchmark'});
  return chrome.runtime.sendMessage({channel:'danlingo-local-offscreen-v1',...m.control});})().then(reply,e=>reply({ok:false,error:String(e)}));return true;
});`);
await writeFile(resolve(extension, 'benchmark.html'), '<!doctype html><meta charset="utf-8"><title>Local model benchmark</title><input id="file" type="file"><pre id="status">Isolated real GPU benchmark</pre>');
const before = await stat(modelPath), header = Buffer.alloc(Math.min(before.size, 32 * 1024 * 1024)), file = await open(modelPath, 'r');
try { await file.read(header, 0, header.length, 0); } finally { await file.close(); }
const metadata = await inspectGguf(new Blob([header]));
const modelId = 'benchmark-' + crypto.randomUUID();
const report = { capturedAt: new Date().toISOString(), evidence: 'REAL_GGUF_PACKAGED_OFFSCREEN_NATIVE_WEBGPU_ISOLATED_HARNESS',
  nativeActionTrace: nativeTrace ? 'Isolated artifact-only timing instrumentation; JSPI FIFO unchanged. Aggregate actions and capped slow records, no request contents.' : undefined,
  nativeCacheOverride: nativeCache,
  idleSlotCacheOverride: idleCache,
  contextCheckpointsOverride: contextCheckpoints,
  nativeLogLevelOverride: nativeLogLevel,
  nativeBuildOverride: nativeBuildEvidence,
  packagedNativeBuild,
  directory, modelPath, modelBytes: before.size, metadata, network: [], errors: [], checks: {}, groups: [],
  physicalGpu: { scope: 'Whole GPU, includes other applications; not model-only VRAM or execution time.', samples: [] } };
let gpuSampling = false;
let browserCdp, processMemoryRead;
const measureProcessMemory = arg('process-vram', 'false') === 'true';
report.processGpuMemory = { requested: measureProcessMemory,
  scope: 'Windows GPU process DedicatedUsage/SharedUsage counters for this isolated browser only, all adapters. Includes browser GPU resources; not model-only physical residency.',
  samples: [], errors: [] };
const sampleProcessMemory = () => {
  if (!measureProcessMemory || !browserCdp) return Promise.resolve();
  if (processMemoryRead) return processMemoryRead;
  processMemoryRead = (async () => {
    const observedGroup = () => { const group = report.benchmark?.groups?.at(-1); return group ? { name: group.name, workload: group.workload, status: group.status } : null; };
    const observedAtStart = { at: Date.now(), phase: report.benchmark?.phase, group: observedGroup() };
    try { report.processGpuMemory.samples.push({ ...await sampleBrowserGpuMemory(browserCdp), observedAtStart,
      observedAtEnd: { phase: report.benchmark?.phase, group: observedGroup() } }); }
    catch (error) { if (report.processGpuMemory.errors.length < 3) report.processGpuMemory.errors.push(error.message); }
    finally { processMemoryRead = undefined; }
  })();
  return processMemoryRead;
};
const samplePhysicalGpu = async () => {
  if (gpuSampling) return;
  gpuSampling = true;
  try {
    const { stdout } = await promisify(execFile)('C:/Windows/system32/nvidia-smi.exe',
      ['--query-gpu=index,utilization.gpu,memory.used,memory.total,power.draw', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 2500 });
    for (const line of stdout.trim().split('\n')) {
      const [index, utilizationPercent, usedMiB, totalMiB, powerWatts] = line.split(',').map(value => Number(value.trim()));
      report.physicalGpu.samples.push({ at: Date.now(), index, utilizationPercent, usedMiB, totalMiB, powerWatts });
    }
  } catch { report.physicalGpu.unavailable = true; }
  finally { gpuSampling = false; }
};
await samplePhysicalGpu();
const gpuInterval = setInterval(() => { void samplePhysicalGpu(); }, 3000);
const processMemoryInterval = measureProcessMemory ? setInterval(() => { void sampleProcessMemory(); }, 8000) : undefined;
const profile = await mkdtemp(resolve(directory, 'profile-'));
let context, page;
const rpc = control => page.evaluate(({ control, production }) => chrome.runtime.sendMessage({ type: production ? 'local-control' : 'local-benchmark-harness', control }), {control,production});
const save = async () => { await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2)); await writeFile(resolve(root, 'latest.json'), JSON.stringify({ directory, report: resolve(directory, 'report.json') })); };
const watchdog = setTimeout(() => { report.errors.push('BENCHMARK_WATCHDOG'); void context?.close(); }, Number(arg('watchdog-ms', '900000')));
try {
  const { chromium } = await loadPlaywright();
  context = await chromium.launchPersistentContext(profile, { headless: true,
    ...browserLaunchOptions("chromium"),
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND'] });
  if (measureProcessMemory) {
    browserCdp = await context.browser().newBrowserCDPSession();
    await sampleProcessMemory();
  }
  await context.route('**/*', route => { if (/^https?:/.test(route.request().url())) { report.network.push(route.request().url()); return route.abort(); } return route.continue(); });
  const background = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  await page.goto('chrome-extension://' + new URL(background.url()).host + (production ? '/options.html' : '/benchmark.html'));
  if (production) await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'file'; document.body.append(input); });
  await page.locator('#file').setInputFiles(modelPath);
  await page.evaluate(async ({ modelId, metadata, bytes }) => {
    const file = document.querySelector('#file').files[0];
    await new Promise((done, fail) => { const request = indexedDB.open('danlingo-local-models-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('models', { keyPath: 'info.id' });
      request.onerror = () => fail(new Error('IMPORT_FAILED'));
      request.onsuccess = () => { const db = request.result, tx = db.transaction('models', 'readwrite');
        tx.objectStore('models').put({ info: { ...metadata, id: modelId, name: file.name, files: [file.name], bytes, importedAt: Date.now() }, blobs: [file] });
        tx.oncomplete = () => { db.close(); done(); }; tx.onerror = () => { db.close(); fail(new Error('IMPORT_FAILED')); }; };
    });
  }, { modelId, metadata, bytes: before.size });
  console.log('IMPORTED', JSON.stringify({ modelId, bytes: before.size, directory }));
  if (production) {
    assert.equal(smoke, false, 'production mode uses benchmark controls, not harness-only completion');
    const loaded = await rpc({action:'load',modelId,config:{mode:'custom',parallel:1,cpuThreads,temperature:Number(arg('temperature','.1'))}});
    assert.equal(loaded.ok,true);
    const generation = loaded.state.generation;
    const tested = await page.evaluate(settings => chrome.runtime.sendMessage({type:'test-model',settings}),
      {...DEFAULT_SETTINGS,backend:'local',localModelId:modelId,model:modelId,profile:'chat-completions',thinkingEffort:'default'});
    report.productionTest = tested;
    assert.equal(tested.ok,true,JSON.stringify(tested));
    const state = (await rpc({action:'state'})).state;
    assert.equal(state.generation,generation);
    assert.ok(state.inferenceCalls>0);
    report.checks.productionProviderBridge = true;
  }
  if (smoke) {
    for (const parallel of parallels) {
      const loaded = await rpc({ action: 'load', modelId, config: { mode: 'custom', parallel,
        cpuThreads, batchPreset: arg('batch', 'balanced'), flashAttention: arg('flash', 'auto'), temperature: Number(arg('temperature', '.1')), measureGpu: arg('gpu-timing', 'true') === 'true' } });
      report.groups.push({ parallel, loaded }); await save();
      console.log('LOADED', JSON.stringify(loaded)); assert.equal(loaded.ok, true);
      assert.equal(loaded.state.runtime.parallel, parallel, 'fallback is not benchmark success');
      const settings = { ...DEFAULT_SETTINGS, backend: 'local', profile: 'chat-completions', thinkingEffort: 'default', sourceLanguage: 'auto', targetLanguage: 'zh-Hans' };
      const shortCorpus = LOCAL_BENCHMARK_CORPUS.filter(row => row.workload === 'short');
      const requests = Array.from({length:Number(arg('count','8'))}, (_, index) => shortCorpus[index % shortCorpus.length]).map(row => ({ ...row,
        body: { ...buildProviderPayload(settings, [{ id: row.id, text: row.text }], 'deadline'), strategy: 'normal', benchmark: true, observeNativeGeneration: true, cache_prompt: false } }));
      const started = performance.now();
      const results = await page.evaluate(async ({ requests, modelId }) => Promise.all(requests.map(async (row, i) => {
        const start = performance.now(); const response = await chrome.runtime.sendMessage({ type: 'local-benchmark-harness', control: { action: 'complete', id: 'probe-' + i, modelId, body: row.body } });
        return { id: row.id, durationMs: performance.now() - start, response };
      })), { requests, modelId });
      const state = (await rpc({ action: 'state' })).state;
      Object.assign(report.groups.at(-1), { results, totalMs: performance.now() - started, finalState: state });
      console.log('GENERATED', JSON.stringify({ parallel, peakActive: state.peakActive, nativePeakActive: state.nativePeakActive, nativeSlots: state.nativeSlots, gpu: state.gpu, successes: results.filter(row => row.response.ok).length, samples: results.slice(0, 2) }));
      assert.ok(results.every(row => row.response.ok));
      assert.ok(parallel === 1 || state.nativePeakActive >= 2, 'needs native multi-sequence evidence');
      await save();
    }
  } else {
    const variantPath = arg('variants', '');
    const variants = variantPath ? JSON.parse(await readFile(resolve(variantPath), 'utf8')) : undefined;
    const started = await rpc({ action: 'benchmark-start', modelId, options: { parallels, variants,
      count: Number(arg('count', '32')), applicationConcurrency: Number(arg('application-concurrency', '32')),
      requestTimeoutMs: Number(arg('timeout-ms', '120000')),
      workloads: arg('workloads', 'short,normal,long').split(','), validateCorpus: arg('validate-corpus', 'false') === 'true',
      baseConfig: { mode: 'custom', cpuThreads, measureGpu: arg('gpu-timing', 'true') === 'true', flashAttention: arg('flash', 'auto'),
        temperature: Number(arg('temperature', '.1')), batchPreset: arg('batch', 'balanced') } } });
    assert.equal(started.ok, true, JSON.stringify(started));
    let lastProgress;
    while (true) {
      const response = await rpc({ action: 'benchmark-status' }); report.benchmark = response.report;
      assert.ok(response.ok && response.report, JSON.stringify(response)); await save();
      const progress = JSON.stringify({ status: response.report.status, phase: response.report.phase, groups: response.report.groups?.length, completed: response.report.groups?.at(-1)?.completed });
      if (progress !== lastProgress) console.log('PROGRESS', progress);
      lastProgress = progress;
      if (!['running', 'stopping'].includes(response.report.status)) break;
      await new Promise(done => setTimeout(done, 2000));
    }
    const unavailableOnly = report.benchmark.status === 'failed' && !report.benchmark.error && !report.benchmark.restoreError
      && report.benchmark.groups.every(group => group.status === 'completed' || group.error === 'LOCAL_FLASH_ATTENTION_UNAVAILABLE');
    assert.ok(report.benchmark.status === 'completed' || unavailableOnly, JSON.stringify({status:report.benchmark.status,error:report.benchmark.error,restoreError:report.benchmark.restoreError}));
    report.checks.unavailableVariants = report.benchmark.groups.filter(group => group.error === 'LOCAL_FLASH_ATTENTION_UNAVAILABLE').map(group => group.name);
  }
  report.checks.originalUnchanged = (await stat(modelPath)).size === before.size && (await stat(modelPath)).mtimeMs === before.mtimeMs;
  report.checks.noNetwork = report.network.length === 0;
  report.status = 'PASS';
} catch (error) { report.status = 'FAIL'; report.errors.push(error.message); process.exitCode = 1; console.error(error); }
finally {
  clearInterval(gpuInterval);
  clearInterval(processMemoryInterval);
  await processMemoryRead;
  clearTimeout(watchdog);
  try { if (page && !page.isClosed()) { await rpc({ action: 'unload' }); await rpc({ action: 'delete', modelId }); } } catch {}
  await context?.close(); await save();
  // Only remove this invocation's generated profile after the owned browser is closed.
  const resolvedProfile = resolve(profile), allowedRoot = resolve(directory) + sep;
  if (!resolvedProfile.startsWith(allowedRoot) || !resolvedProfile.includes(sep + 'profile-')) throw new Error('UNSAFE_PROFILE_CLEANUP');
  if (!process.argv.includes('--keep-profile')) await rm(resolvedProfile, { recursive: true, force: true });
  console.log('REPORT', resolve(directory, 'report.json'));
}
