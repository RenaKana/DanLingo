import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Bounded production-bundle verification for local performance-test priority.
// Uses a copied extension and isolated browser profile; never changes the source
// bundle, original GGUF file, user's browser profile, or online providers.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const modelPath = process.argv.find(value => value.startsWith('--model='))?.split('=').slice(1).join('=')
  ?? 'D:/Tool/Models/LmStudioModels/lmstudio-community/HY-MT1.5-1.8B-FP8/HY-MT1.5-1.8B-Q8_0.gguf';
const bundlePath = resolve('.output/chrome-mv3');
const artifactRoot = resolve('.artifacts/performance-priority');
const timeoutMs = Number(process.argv.find(value => value.startsWith('--timeout-ms='))?.split('=').at(1) ?? 240_000);
assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 30_000 && timeoutMs <= 600_000, 'invalid timeout');

const originalModel = await stat(modelPath);
const artifactFiles = ['manifest.json', 'background.js'];
const sourceBuild = { bundlePath, snapshotCapturedAt: new Date().toISOString(),
  note: 'Verifier did not run a build; file mtimes identify the production bundle snapshot exercised.', files: {} };
for (const name of artifactFiles) {
  const info = await stat(resolve(bundlePath, name));
  sourceBuild.files[name] = { bytes: info.size, mtimeMs: info.mtimeMs, mtimeIso: new Date(info.mtimeMs).toISOString() };
}

await mkdir(artifactRoot, { recursive: true });
const runDirectory = await mkdtemp(resolve(artifactRoot, 'run-'));
const extension = resolve(runDirectory, 'extension');
const reportPath = resolve(runDirectory, 'report.json');
const report = {
  capturedAt: new Date().toISOString(),
  evidence: 'PRODUCTION_BUILT_EXTENSION_REAL_GGUF_GPU_PERFORMANCE_PRIORITY_ISOLATED_PROFILE',
  scope: 'Functional priority, admission rejection, cancellation/completion restoration, and one bounded native benchmark. Not a throughput or semantic-quality claim.',
  modelPath,
  modelBytes: originalModel.size,
  sourceBuild,
  runDirectory,
  network: [],
  errors: [],
  checks: {},
  performanceTest: {},
  localBenchmark: { progress: [] },
  browserRestartRecovery: { status: 'not-run', reason: 'The bounded native benchmark is intentionally short; no restart/hang recovery phase was forced.' },
};

const trimSettings = value => {
  const settings = value?.settings ?? value;
  if (!settings || typeof settings !== 'object') return null;
  return {
    backend: settings.backend,
    enabled: settings.enabled,
    displayMode: settings.displayMode,
    localModelId: settings.localModelId,
    model: settings.model,
    sourceLanguage: settings.sourceLanguage,
    liveSourceLanguage: settings.liveSourceLanguage,
    targetLanguage: settings.targetLanguage,
    localPerformance: settings.localPerformance,
  };
};

const trimState = state => {
  if (!state) return null;
  return {
    phase: state.phase,
    generation: state.generation,
    model: state.model ? { id: state.model.id, name: state.model.name, bytes: state.model.bytes, architecture: state.model.architecture,
      quantization: state.model.quantization, layerCount: state.model.layerCount, metadataComplete: state.model.metadataComplete } : undefined,
    requested: state.requested,
    runtime: state.runtime,
    gpu: state.gpu,
    active: state.active,
    queued: state.queued,
    completed: state.completed,
    failed: state.failed,
    cancelled: state.cancelled,
    peakActive: state.peakActive,
    nativeSlots: state.nativeSlots,
    nativePeakActive: state.nativePeakActive,
    inferenceCalls: state.inferenceCalls,
    loadMs: state.loadMs,
    warmupMs: state.warmupMs,
    error: state.error,
    fallbackReasons: state.fallbackReasons,
    warnings: state.warnings,
    nativeEvidence: state.nativeEvidence,
  };
};

const trimProgressState = state => state ? {
  phase: state.phase,
  generation: state.generation,
  active: state.active,
  queued: state.queued,
  nativeSlots: state.nativeSlots,
  nativePeakActive: state.nativePeakActive,
  inferenceCalls: state.inferenceCalls,
  error: state.error,
  gpu: state.gpu ? {
    verified: state.gpu.verified,
    deviceCreated: state.gpu.deviceCreated,
    timestampQueries: state.gpu.timestampQueries,
    executionMs: state.gpu.executionMs,
    timedComputePasses: state.gpu.timedComputePasses,
    missedComputePasses: state.gpu.missedComputePasses,
    timingReadFailures: state.gpu.timingReadFailures,
    pendingTimingRecords: state.gpu.pendingTimingRecords,
  } : undefined,
} : null;

const summarizeReply = reply => ({
  ok: reply?.ok === true,
  error: typeof reply?.error === 'string' ? reply.error : undefined,
  retryAfterMs: Number.isFinite(reply?.retryAfterMs) ? reply.retryAfterMs : undefined,
  items: Array.isArray(reply?.items) ? reply.items.map(item => ({ id: item?.id, status: item?.status, reason: item?.reason,
    textLength: typeof item?.text === 'string' ? item.text.length : undefined })) : undefined,
});

const until = async (fn, label, budget = timeoutMs) => {
  const deadline = Date.now() + budget;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise(done => setTimeout(done, 120));
  }
  throw new Error(`Timeout: ${label}${last ? ` (${JSON.stringify(last).slice(0, 300)})` : ''}`);
};

const saveReport = async () => {
  await writeFile(reportPath, JSON.stringify(report, null, 2));
};

await cp(bundlePath, extension, { recursive: true });
const manifestPath = resolve(extension, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.content_scripts = manifest.content_scripts.filter(entry => entry.js?.some(path => path.includes('settings-host')));
manifest.content_scripts.push({ matches: ['https://live.nicovideo.jp/watch/*'], js: ['session-fixture.js'], run_at: 'document_idle' });
await writeFile(manifestPath, JSON.stringify(manifest));
await writeFile(resolve(extension, 'session-fixture.js'), `
const session = { platform: 'niconico', scenario: 'live', resourceId: 'lv9001', sessionId: crypto.randomUUID(), generation: 0 };
const records = [];
document.documentElement.dataset.fixtureLoaded = 'true';
chrome.runtime.onMessage.addListener(message => {
  if (message?.type !== 'verify-live-session') return;
  const ok = JSON.stringify(message.session) === JSON.stringify(session);
  document.documentElement.dataset.fixtureVerify = JSON.stringify({ ok, incoming: message.session, expected: session });
  return Promise.resolve({ ok });
});
async function openSession() {
  const reply = await chrome.runtime.sendMessage({ type: 'session-open', session });
  document.documentElement.dataset.session = String(reply?.ok === true);
  if (reply?.ok) await chrome.runtime.sendMessage({ type: 'live-presence', session, active: true });
  else document.documentElement.dataset.sessionError = JSON.stringify(reply);
  return reply;
}
async function translate(text = '这个视频非常有趣。') {
  const item = { id: crypto.randomUUID(), text, strategy: 'normal', remainingMs: 120000 };
  const reply = await chrome.runtime.sendMessage({ type: 'translate', resourceId: session.resourceId, session,
    requestId: crypto.randomUUID(), sentAt: performance.timeOrigin + performance.now(), items: [item] });
  const record = { requestId: item.id, ok: reply?.ok === true, error: reply?.error, items: Array.isArray(reply?.items) ? reply.items : [] };
  records.push(record);
  const result = document.getElementById('result');
  if (result) {
    result.dataset.reply = JSON.stringify(record);
    result.textContent = JSON.stringify({ ok: record.ok, error: record.error, statuses: record.items.map(row => row.status) });
  }
  return reply;
}
document.getElementById('translate')?.addEventListener('click', () => { void translate(); });
window.__danlingoFixture = { session, records, openSession, translate };
void openSession().catch(error => { document.documentElement.dataset.sessionError = String(error?.message ?? error); });
`);

let context;
let options;
let popup;
let live;
try {
  const { chromium } = await loadPlaywright();
  context = await chromium.launchPersistentContext(resolve(runDirectory, 'profile'), {
    headless: true,
    ...browserLaunchOptions('chromium'),
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--disable-background-networking',
      '--disable-component-update', '--disable-sync', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND'],
  });
  const fixtureHtml = '<!doctype html><meta charset="utf-8"><button id="translate">translate fixture</button><pre id="result" data-reply=""></pre>';
  await context.route('https://live.nicovideo.jp/**', route => route.fulfill({ contentType: 'text/html', body: fixtureHtml }));
  await context.route(/https?:\/\/(?!live\.nicovideo\.jp)/, route => {
    report.network.push(new URL(route.request().url()).origin);
    return route.abort();
  });

  const background = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const origin = 'chrome-extension://' + new URL(background.url()).host;
  const pageError = error => report.errors.push(error.message);
  options = await context.newPage(); options.on('pageerror', pageError);
  await options.goto(origin + '/options.html');
  await options.locator('#result').waitFor({ state: 'attached' });
  await options.locator('#backend').selectOption('local');
  await options.locator('#local-file').setInputFiles(modelPath);
  await options.waitForFunction(() => {
    const model = document.querySelector('#local-model');
    const file = document.querySelector('#local-file');
    return !!model?.value && file?.disabled === false;
  }, undefined, { timeout: 180_000 });
  const imported = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'settings' }));
  assert.ok(imported?.settings?.localModelId, 'local model import did not select a model');
  const modelId = imported.settings.localModelId;
  await options.evaluate(settings => chrome.storage.local.set({ 'settings.v1': {
    ...settings, backend: 'local', enabled: true, displayMode: 'translated', model: settings.localModelId,
    sourceLanguage: 'zh', liveSourceLanguage: 'zh', targetLanguage: 'ja', localModelId: settings.localModelId,
  } }), imported.settings);
  await options.close(); options = undefined;

  live = await context.newPage(); live.on('pageerror', pageError);
  await live.goto('https://live.nicovideo.jp/watch/lv9001');
  await live.waitForFunction(() => document.documentElement.dataset.session === 'true' || !!document.documentElement.dataset.sessionError, undefined, { timeout: 30_000 });
  const sessionResult = await live.evaluate(() => ({ ok: document.documentElement.dataset.session === 'true', error: document.documentElement.dataset.sessionError }));
  const fixtureState = await live.evaluate(() => ({ ...document.documentElement.dataset }));
  assert.equal(sessionResult.ok, true, `synthetic session-open failed: ${sessionResult.error ?? 'unknown error'} fixture=${JSON.stringify(fixtureState)}`);
  popup = await context.newPage(); popup.on('pageerror', pageError); await popup.goto(origin + '/popup.html');
  await popup.locator('body').waitFor();
  const rpc = message => popup.evaluate(value => chrome.runtime.sendMessage(value), message);
  const settings = () => rpc({ type: 'settings' });
  const localState = async () => (await rpc({ type: 'local-control', control: { action: 'state' } })).state;
  const idleState = label => until(async () => {
    const state = await localState();
    if (state?.phase === 'error') throw new Error(`${label}: ${state.error ?? 'local runtime error'}`);
    return state?.phase === 'ready' && !state.active && !state.queued ? state : null;
  }, label);
  const fixtureTranslate = async () => {
    const previous = await live.locator('#result').getAttribute('data-reply');
    await live.locator('#translate').click();
    await live.waitForFunction(oldValue => {
      const next = document.getElementById('result')?.dataset.reply;
      return !!next && next !== oldValue;
    }, previous, { timeout: 180_000 });
    return live.evaluate(() => {
      const record = JSON.parse(document.getElementById('result').dataset.reply);
      return { ok: record.ok, error: record.error, items: record.items.map(item => ({ status: item.status, reason: item.reason,
        textLength: typeof item.text === 'string' ? item.text.length : undefined })) };
    });
  };

  const configured = await settings();
  assert.equal(configured.ok, true); assert.equal(configured.settings.backend, 'local'); assert.equal(configured.settings.enabled, true);
  assert.equal(configured.settings.localModelId, modelId);
  const baselineEnabled = configured.settings.enabled;
  report.configuration = trimSettings(configured);
  report.modelId = modelId;

  const cold = await idleState('shared local model ready');
  report.coldState = trimState(cold);
  assert.equal(cold.model?.id, modelId); assert.equal(cold.gpu?.verified, true, 'native GPU was not verified');
  assert.equal(cold.gpu?.deviceCreated, true); report.checks.sharedLocalModelReady = true;

  const beforeLive = await localState();
  const beforeTranslation = await fixtureTranslate();
  report.performanceTest.translationBefore = summarizeReply(beforeTranslation);
  assert.equal(beforeLive.model?.id, modelId); assert.equal(beforeTranslation?.ok, true, JSON.stringify(summarizeReply(beforeTranslation)));
  assert.ok(beforeTranslation.items?.some(item => ['translated', 'cached'].includes(item.status)), 'real local live translation did not succeed');
  const afterTranslation = await idleState('native idle after live translation');
  report.performanceTest.liveRequestState = { before: trimState(beforeLive), after: trimState(afterTranslation),
    inferenceCallsDelta: (afterTranslation.inferenceCalls ?? 0) - (beforeLive.inferenceCalls ?? 0) };
  assert.ok(afterTranslation.inferenceCalls > beforeLive.inferenceCalls, 'live request did not reach native inference');
  report.checks.realLiveTranslationBeforePriorityTest = true;

  // Ordinary local PerformanceTest: acquire the shared pause, reject a live
  // admission, and exercise explicit cancellation/release.
  const performanceSettings = { ...configured.settings, backend: 'local', enabled: true, displayMode: 'translated', model: modelId, localModelId: modelId };
  const performanceStart = await rpc({ type: 'performance-start', settings: performanceSettings,
    config: { count: 4, mode: 'load', concurrency: 1, batchSize: 1, arrivalIntervalMs: 0, strategy: 'normal' } });
  report.performanceTest.start = { ok: performanceStart?.ok === true, report: performanceStart?.report ? {
    id: performanceStart.report.id, state: performanceStart.report.state, planned: performanceStart.report.planned,
  } : undefined, error: performanceStart?.error };
  assert.equal(performanceStart?.ok, true, JSON.stringify(performanceStart));
  const pausedForPerformance = await until(async () => {
    const value = await settings(); return value.performancePaused ? value : null;
  }, 'performance test pause');
  report.performanceTest.paused = trimSettings(pausedForPerformance);
  assert.equal(pausedForPerformance.settings.enabled, baselineEnabled);
  const rejectedDuringPerformance = await fixtureTranslate();
  report.performanceTest.rejectedLiveAdmission = summarizeReply(rejectedDuringPerformance);
  assert.equal(rejectedDuringPerformance?.ok, false);
  assert.match(rejectedDuringPerformance?.error ?? '', /性能测试|暂停/);
  await rpc({ type: 'performance-stop' });
  let performanceTerminal;
  await until(async () => {
    const status = await rpc({ type: 'performance-status' });
    const value = await settings();
    if (status.report && status.report.state !== 'running' && value.performancePaused === false) { performanceTerminal = status.report; return true; }
    return null;
  }, 'performance test cancellation and release');
  report.performanceTest.terminal = performanceTerminal ? {
    id: performanceTerminal.id, state: performanceTerminal.state, stopReason: performanceTerminal.stopReason,
    planned: performanceTerminal.planned, actualRequests: performanceTerminal.actualRequests,
    cancelled: performanceTerminal.cancelled, unsent: performanceTerminal.unsent, localInferenceCalls: performanceTerminal.localInferenceCalls,
  } : undefined;
  assert.equal(performanceTerminal?.state, 'stopped');
  const afterPerformanceSettings = await settings();
  assert.equal(afterPerformanceSettings.performancePaused, false); assert.equal(afterPerformanceSettings.settings.enabled, baselineEnabled);
  const afterPerformanceTranslation = await fixtureTranslate();
  report.performanceTest.translationAfter = summarizeReply(afterPerformanceTranslation);
  assert.equal(afterPerformanceTranslation?.ok, true, JSON.stringify(summarizeReply(afterPerformanceTranslation)));
  assert.ok(afterPerformanceTranslation.items?.some(item => ['translated', 'cached'].includes(item.status)));
  report.checks.performancePauseCancelsAndRestores = true;

  // One minimal native benchmark: one slot, ordinary workload, two corpus
  // items, GPU telemetry on. The surrounding live request is already idle.
  const nativeBeforeBenchmark = await idleState('actual native idle before benchmark');
  report.localBenchmark.nativeBefore = trimState(nativeBeforeBenchmark);
  const benchmarkStart = await rpc({ type: 'local-control', control: { action: 'benchmark-start', modelId, options: {
    count: 2, applicationConcurrency: 1, requestTimeoutMs: 120_000, workloads: ['normal'],
    variants: [{ name: 'priority-native-1', config: { mode: 'custom', parallel: 1 } }],
    baseConfig: { mode: 'custom', parallel: 1, measureGpu: true, flashAttention: 'auto', batchPreset: 'balanced' },
  } } });
  report.localBenchmark.start = benchmarkStart?.report ? { ok: benchmarkStart.ok === true, id: benchmarkStart.report.id,
    status: benchmarkStart.report.status, phase: benchmarkStart.report.phase, options: benchmarkStart.report.options } : benchmarkStart;
  assert.equal(benchmarkStart?.ok, true, JSON.stringify(benchmarkStart));
  const pausedForBenchmark = await until(async () => {
    const value = await settings(); return value.performancePaused ? value : null;
  }, 'local benchmark pause');
  report.localBenchmark.paused = trimSettings(pausedForBenchmark);
  assert.equal(pausedForBenchmark.settings.enabled, baselineEnabled);
  const rejectedDuringBenchmark = await fixtureTranslate();
  report.localBenchmark.rejectedLiveAdmission = summarizeReply(rejectedDuringBenchmark);
  assert.equal(rejectedDuringBenchmark?.ok, false);
  assert.match(rejectedDuringBenchmark?.error ?? '', /性能测试|暂停/);

  let benchmarkTerminal;
  await until(async () => {
    const response = await rpc({ type: 'local-control', control: { action: 'benchmark-status' } });
    const value = await settings();
    const current = response.report;
    if (current) {
      const state = await localState();
      report.localBenchmark.progress.push({ at: Date.now(), status: current.status, phase: current.phase,
        groups: current.groups?.map(group => ({ name: group.name, workload: group.workload, status: group.status,
          expected: group.expected, completed: group.completed, error: group.error, nativePeakActive: group.nativeAfter?.nativePeakActive,
          gpuObservation: group.gpuObservation })) ?? [], paused: value.performancePaused, state: trimProgressState(state) });
      if (current.error || current.groups?.some(group => /GPU|OOM|DEVICE|WEBGPU|OUT_OF_MEMORY/i.test(group.error ?? ''))) {
        report.localBenchmark.failureSignal = current.error ?? current.groups.find(group => group.error)?.error;
        if (['running', 'stopping'].includes(current.status)) await rpc({ type: 'local-control', control: { action: 'benchmark-stop' } });
        throw new Error(`native benchmark failure: ${report.localBenchmark.failureSignal}`);
      }
      if (['completed', 'cancelled', 'failed'].includes(current.status) && current.phase === 'done') {
        benchmarkTerminal = current;
        return true;
      }
      if (['running', 'stopping'].includes(current.status)) assert.equal(value.performancePaused, true, 'pause released before benchmark phase done');
    }
    return null;
  }, 'local benchmark completion and restoration');
  report.localBenchmark.terminal = {
    id: benchmarkTerminal.id, status: benchmarkTerminal.status, phase: benchmarkTerminal.phase, error: benchmarkTerminal.error,
    restoreError: benchmarkTerminal.restoreError, model: benchmarkTerminal.model ? { id: benchmarkTerminal.model.id, bytes: benchmarkTerminal.model.bytes } : undefined,
    gpu: benchmarkTerminal.gpu, groups: benchmarkTerminal.groups?.map(group => ({ name: group.name, workload: group.workload,
      status: group.status, expected: group.expected, completed: group.completed, error: group.error, stats: group.stats,
      runtime: group.runtime, nativeBefore: trimState(group.nativeBefore), nativeAfter: trimState(group.nativeAfter), gpuObservation: group.gpuObservation })),
    recommendation: benchmarkTerminal.recommendation, recommendedVariant: benchmarkTerminal.recommendedVariant,
  };
  assert.equal(benchmarkTerminal.status, 'completed', JSON.stringify({ status: benchmarkTerminal.status, error: benchmarkTerminal.error, restoreError: benchmarkTerminal.restoreError }));
  assert.equal(benchmarkTerminal.groups?.length, 1); assert.equal(benchmarkTerminal.groups?.[0]?.status, 'completed');
  assert.equal(benchmarkTerminal.groups?.[0]?.expected, 2); assert.equal(benchmarkTerminal.groups?.[0]?.completed, 2);
  assert.ok(report.localBenchmark.progress.some(row => row.phase === 'restoring' && row.paused === true), 'pause was not held through restoration');
  assert.ok(report.localBenchmark.progress.filter(row => ['running', 'stopping'].includes(row.status)).every(row => row.paused === true), 'pause released before benchmark done');
  report.checks.pauseHeldThroughRestoration = true;
  const afterBenchmarkSettings = await settings();
  assert.equal(afterBenchmarkSettings.performancePaused, false); assert.equal(afterBenchmarkSettings.settings.enabled, baselineEnabled);
  const nativeAfterBenchmark = await idleState('native idle after benchmark restoration');
  report.localBenchmark.nativeAfter = trimState(nativeAfterBenchmark);
  assert.equal(nativeAfterBenchmark.model?.id, modelId); assert.equal(nativeAfterBenchmark.phase, 'ready');
  const afterBenchmarkTranslation = await fixtureTranslate();
  report.localBenchmark.translationAfter = summarizeReply(afterBenchmarkTranslation);
  assert.equal(afterBenchmarkTranslation?.ok, true, JSON.stringify(summarizeReply(afterBenchmarkTranslation)));
  assert.ok(afterBenchmarkTranslation.items?.some(item => ['translated', 'cached'].includes(item.status)));
  report.checks.localBenchmarkPriorityAndRestoration = true;

  assert.equal(report.network.length, 0, 'online network request observed');
  const afterModel = await stat(modelPath);
  assert.equal(afterModel.size, originalModel.size); assert.equal(afterModel.mtimeMs, originalModel.mtimeMs);
  report.checks.originalModelUntouched = true;
  report.checks.noOnlineProviderCalls = true;
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.errors.push(error?.stack ?? String(error));
  process.exitCode = 1;
} finally {
  try { await popup?.close(); } catch {}
  try { await live?.close(); } catch {}
  try { await options?.close(); } catch {}
  try { await context?.close(); } catch {}
  const profile = resolve(runDirectory, 'profile');
  const allowedRoot = resolve(runDirectory) + sep;
  if (profile.startsWith(allowedRoot) && !process.argv.includes('--keep-profile')) await rm(profile, { recursive: true, force: true });
  await saveReport();
  console.log('REPORT', reportPath);
  console.log(JSON.stringify({ status: report.status, checks: report.checks, errors: report.errors }));
}
