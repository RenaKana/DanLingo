import { browserLaunchOptions, loadPlaywright } from "./browser-runtime.mjs";
// Isolated topology comparison for the existing local Wllama/WebGPU runtime.
// This script launches one or two independent extension/profile instances; it
// never changes production source, the user's browser, or the original GGUF.
import assert from 'node:assert/strict';
import { mkdir, cp, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { inspectGguf } from '../src/local/gguf.ts';
import { LOCAL_BENCHMARK_CORPUS } from '../src/local/benchmark.ts';
import { buildProviderPayload, parseLocalProviderResult } from '../src/translation/provider.ts';
import { withLocalRuntime } from '../src/local/provider-settings.ts';
import { DEFAULT_SETTINGS } from '../src/core/config.ts';

export const TOTAL_DISPATCH_CONCURRENCY = 4;
export const MEASURED_ROUNDS = 3;
export const DEFAULT_TOTAL_CONTEXT = 2048;
export const DEFAULT_COUNT = 32;
export const DEFAULT_TIMEOUT_MS = 120_000;

const finite = value => typeof value === 'number' && Number.isFinite(value);
const observed = value => finite(value) && value >= 0;
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

function arg(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function integerArg(name, fallback, { min = 1, max = 0x7fffffff } = {}) {
  const value = Number(arg(name, String(fallback)));
  assert.ok(Number.isSafeInteger(value) && value >= min && value <= max, `--${name} must be an integer in ${min}..${max}`);
  return value;
}

/**
 * The only topology difference is the number of isolated native engines and
 * their per-engine parallel/context split. The sum of n_ctx remains fixed.
 */
export function buildTopologyPlans(totalContextTokens = DEFAULT_TOTAL_CONTEXT) {
  assert.ok(Number.isSafeInteger(totalContextTokens) && totalContextTokens > 0 && totalContextTokens % 2 === 0,
    'total unified KV context must be a positive even integer');
  const plans = [
    { id: 'single-instance-x4', instanceCount: 1, parallelPerInstance: 4, contextTokensPerInstance: totalContextTokens },
    { id: 'two-isolated-instances-x2', instanceCount: 2, parallelPerInstance: 2, contextTokensPerInstance: totalContextTokens / 2 },
  ];
  return plans.map(plan => ({ ...plan,
    totalDispatchConcurrency: plan.instanceCount * plan.parallelPerInstance,
    totalUnifiedKvTokens: plan.instanceCount * plan.contextTokensPerInstance,
  }));
}

function percentile(values, fraction) {
  const sorted = values.filter(observed).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil(sorted.length * fraction))) - 1];
}

function latencySummary(values) {
  const clean = values.filter(observed);
  return {
    meanMs: clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null,
    p50Ms: percentile(clean, 0.5), p95Ms: percentile(clean, 0.95), p99Ms: percentile(clean, 0.99),
    minMs: clean.length ? Math.min(...clean) : null, maxMs: clean.length ? Math.max(...clean) : null,
    samples: clean.length,
  };
}

/** Summarize only measured response samples; valid means the production parser accepted the translation. */
export function summarizeInstanceSamples(samples, elapsedMs) {
  const rows = Array.isArray(samples) ? samples : [];
  const valid = rows.filter(row => row.status === 'valid');
  const failed = rows.filter(row => row.status === 'failed');
  const timedOut = rows.filter(row => row.status === 'timeout');
  const cancelled = rows.filter(row => row.status === 'cancelled');
  const validDurations = valid.map(row => row.durationMs).filter(observed);
  const allDurations = rows.map(row => row.durationMs).filter(observed);
  const duration = observed(elapsedMs) ? elapsedMs : null;
  return {
    requests: rows.length,
    validTranslations: valid.length,
    invalidTranslations: failed.filter(row => row.reason === 'LOCAL_BENCHMARK_PROTOCOL_INVALID').length,
    failed: failed.length,
    timeout: timedOut.length,
    cancelled: cancelled.length,
    validRate: rows.length ? valid.length / rows.length : null,
    validThroughputPerSecond: valid.length && duration !== null && duration > 0 ? valid.length / (duration / 1000) : null,
    elapsedMs: duration,
    validLatencyMs: latencySummary(validDurations),
    allLatencyMs: latencySummary(allDurations),
  };
}

export function isFatalRuntimeFailure(value) {
  const text = typeof value === 'string' ? value : value instanceof Error ? value.message : JSON.stringify(value ?? '');
  return /LOCAL_GPU_DEVICE_LOST|LOCAL_GPU_DEVICE_FAILED|LOCAL_GPU_OFFLOAD_UNVERIFIED|LOCAL_WORKER_FAILED|LOCAL_GPU_SOFTWARE_ADAPTER|LOCAL_WEBGPU_UNSUPPORTED|out[ -]?of[ -]?memory|allocation failed|device lost|gpu.*(?:lost|fail)|memory.*(?:allocation|exhaust|out)/i.test(text);
}

class ExperimentAbort extends Error {
  constructor(reason) { super(reason); this.name = 'ExperimentAbort'; this.reason = reason; }
}

function parseWorkloads(value) {
  const workloads = String(value).split(',').map(item => item.trim()).filter(Boolean);
  assert.ok(workloads.length > 0 && workloads.every(item => ['short', 'normal', 'long'].includes(item)),
    '--workloads must contain short, normal, or long');
  return [...new Set(workloads)];
}

function corpusFor(workload) {
  const rows = LOCAL_BENCHMARK_CORPUS.filter(item => item.workload === workload && item.id.includes('-ja-'));
  assert.ok(rows.length, `No Japanese corpus rows for workload ${workload}`);
  return rows;
}

function selectCorpusItem(workload, index, count) {
  const corpus = corpusFor(workload);
  const corpusIndex = count < corpus.length && count > 1
    ? Math.floor(index * (corpus.length - 1) / (count - 1)) : index % corpus.length;
  return corpus[corpusIndex];
}

function runtimeConfig(plan) {
  return {
    mode: 'custom', parallel: plan.parallelPerInstance, contextTokens: plan.contextTokensPerInstance,
    estimatedTokensPerRequest: 256, batchPreset: 'balanced', batch: 512, microBatch: 256,
    warmup: true, flashAttention: 'auto', cpuThreads: 'auto', temperature: 0.1,
    normalMaxTokens: 128, superChatMaxTokens: 256, manualMaxTokens: 512,
    superChatReasoning: 'off', allowAutoFallback: false, promptMode: 'auto',
    languageValidation: 'strict', reusePromptCache: false, measureGpu: true,
  };
}

function runtimeSettings(modelId, state) {
  return withLocalRuntime({ ...DEFAULT_SETTINGS, backend: 'local', localModelId: modelId, model: modelId,
    profile: 'chat-completions', sourceLanguage: 'ja', targetLanguage: 'zh-Hans', thinkingEffort: 'default',
    localPerformance: state.requested ?? runtimeConfig({ parallelPerInstance: state.runtime?.parallel ?? 1,
      contextTokensPerInstance: state.runtime?.contextTokens ?? DEFAULT_TOTAL_CONTEXT }),
  }, state);
}

function requestBody(modelId, state, workload, text) {
  const strategy = workload === 'long' ? 'superchat' : 'normal';
  const settings = runtimeSettings(modelId, state);
  return { ...buildProviderPayload(settings, [{ id: '0', text }], 'deadline', strategy),
    strategy, stream: false, benchmark: true, cache_prompt: false };
}

function describeState(state) {
  const gpu = state?.gpu ?? {};
  return {
    phase: state?.phase, generation: state?.generation, active: state?.active, queued: state?.queued,
    completed: state?.completed, failed: state?.failed, cancelled: state?.cancelled,
    peakActive: state?.peakActive, nativeSlots: state?.nativeSlots, nativePeakActive: state?.nativePeakActive,
    runtime: state?.runtime, fallbackReasons: state?.fallbackReasons, error: state?.error,
    gpu: {
      verified: gpu.verified, offloadedLayers: gpu.offloadedLayers, totalLayers: gpu.totalLayers,
      modelBufferMiB: gpu.modelBufferMiB, kvBufferMiB: gpu.kvBufferMiB, computeBufferMiB: gpu.computeBufferMiB,
      allocatedBytes: gpu.allocatedBytes, peakAllocatedBytes: gpu.peakAllocatedBytes,
      timestampQueries: gpu.timestampQueries, timedComputePasses: gpu.timedComputePasses,
    },
  };
}

function bufferSnapshot(states) {
  const instances = states.map((state, index) => {
    const gpu = state?.gpu ?? {};
    return { instanceIndex: index, allocatedBytes: observed(gpu.allocatedBytes) ? gpu.allocatedBytes : null,
      peakAllocatedBytes: observed(gpu.peakAllocatedBytes) ? gpu.peakAllocatedBytes : null,
      modelBufferMiB: observed(gpu.modelBufferMiB) ? gpu.modelBufferMiB : null,
      kvBufferMiB: observed(gpu.kvBufferMiB) ? gpu.kvBufferMiB : null,
      computeBufferMiB: observed(gpu.computeBufferMiB) ? gpu.computeBufferMiB : null };
  });
  const sum = key => {
    const values = instances.map(row => row[key]).filter(observed);
    return values.length === instances.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  return { instances, sumAllocatedBytes: sum('allocatedBytes'), sumPeakAllocatedBytes: sum('peakAllocatedBytes'),
    sumModelBufferMiB: sum('modelBufferMiB'), sumKvBufferMiB: sum('kvBufferMiB'), sumComputeBufferMiB: sum('computeBufferMiB'),
    caveat: 'Tracked WebGPU GPUBuffer sizes owned by the meter; not physical VRAM residency, process GPU memory, or total device usage.' };
}

async function readGgufMetadata(modelPath) {
  const info = await stat(modelPath);
  assert.ok(info.isFile() && info.size > 0, 'An existing nonempty GGUF file is required');
  const header = Buffer.alloc(Math.min(info.size, 32 * 1024 * 1024));
  const handle = await open(modelPath, 'r');
  try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
  return { bytes: info.size, mtimeMs: info.mtimeMs, metadata: await inspectGguf(new Blob([header])) };
}

async function prepareExtension(source, target) {
  await cp(source, target, { recursive: true });
  const manifestPath = resolve(target, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.background = { service_worker: 'benchmark-background.js' };
  manifest.content_scripts = [];
  manifest.host_permissions = [];
  manifest.optional_host_permissions = [];
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(resolve(target, 'benchmark-background.js'), `chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== 'local-benchmark-harness') return;
  (async () => {
    if (!await chrome.offscreen.hasDocument()) await chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['WORKERS', 'BLOBS'], justification: 'Isolated local topology benchmark'
    });
    return chrome.runtime.sendMessage({ channel: 'danlingo-local-offscreen-v1', ...message.control });
  })().then(reply, error => reply({ ok: false, error: String(error) }));
  return true;
});`);
  await writeFile(resolve(target, 'benchmark.html'), '<!doctype html><meta charset="utf-8"><title>Local instance benchmark</title><input id="file" type="file"><pre id="status">Isolated topology benchmark</pre>');
}

async function importModel(page, modelId, modelPath, metadata, bytes) {
  await page.locator('#file').setInputFiles(modelPath);
  await page.evaluate(async ({ modelId: id, metadata: info, bytes: modelBytes }) => {
    const file = document.querySelector('#file')?.files?.[0];
    if (!file) throw new Error('MODEL_FILE_INPUT_MISSING');
    await new Promise((done, fail) => {
      const request = indexedDB.open('danlingo-local-models-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('models', { keyPath: 'info.id' });
      request.onerror = () => fail(new Error('IMPORT_FAILED'));
      request.onsuccess = () => {
        const db = request.result, transaction = db.transaction('models', 'readwrite');
        transaction.objectStore('models').put({ info: { ...info, id, name: file.name, files: [file.name], bytes: modelBytes, importedAt: Date.now() }, blobs: [file] });
        transaction.oncomplete = () => { db.close(); done(); };
        transaction.onerror = () => { db.close(); fail(new Error('IMPORT_FAILED')); };
      };
    });
  }, { modelId, metadata, bytes });
}

async function createInstance({ chromium, extensionSource, directory, modelPath, modelMetadata, modelBytes, index, topologyId, headed, report }) {
  const instanceDirectory = resolve(directory, `instance-${index}`);
  await mkdir(instanceDirectory, { recursive: true });
  const extension = resolve(instanceDirectory, 'extension');
  await prepareExtension(extensionSource, extension);
  const profile = await mkdtemp(resolve(instanceDirectory, 'profile-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: !headed,
    ...browserLaunchOptions("chromium"),
    viewport: { width: 1360, height: 900 },
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--disable-background-networking',
      '--disable-component-update', '--disable-sync', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND'],
  });
  const network = [];
  await context.route('**/*', route => {
    if (/^https?:/i.test(route.request().url())) { network.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const background = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(`${topologyId}/instance-${index}: ${error.message}`));
  await page.goto(`chrome-extension://${new URL(background.url()).host}/benchmark.html`);
  const modelId = `topology-${topologyId}-instance-${index}-${randomUUID()}`;
  await importModel(page, modelId, modelPath, modelMetadata, modelBytes);
  const rpc = control => page.evaluate(value => chrome.runtime.sendMessage({ type: 'local-benchmark-harness', control: value }), control);
  const instance = { index, topologyId, directory: instanceDirectory, profile, extension, context, page, background, modelId, rpc, network, loaded: null, settings: null };
  report.network.push(...network);
  return instance;
}

async function readState(instance) {
  const reply = await instance.rpc({ action: 'state' });
  if (!reply?.ok || !reply.state) throw new Error(reply?.error ?? 'LOCAL_STATE_UNAVAILABLE');
  return reply.state;
}

function validateLoadedState(state, plan) {
  assert.equal(state.phase, 'ready', state.error ?? 'LOCAL_LOAD_NOT_READY');
  assert.equal(state.runtime?.parallel, plan.parallelPerInstance, 'native parallel fallback/mismatch');
  assert.equal(state.runtime?.contextTokens, plan.contextTokensPerInstance, 'unified KV context mismatch');
  assert.equal(state.runtime?.batch, 512, 'batch mismatch');
  assert.equal(state.runtime?.microBatch, 256, 'micro-batch mismatch');
  assert.deepEqual(state.fallbackReasons ?? [], [], 'auto fallback is not allowed in this experiment');
  assert.equal(state.gpu?.verified, true, 'hardware WebGPU offload is not verified');
  assert.equal(state.gpu?.offloadedLayers, state.gpu?.totalLayers, 'full native layer offload is required');
}

function fatalStateReason(state) {
  if (!state) return null;
  if (isFatalRuntimeFailure(state.error)) return state.error;
  if (state.phase === 'error' && state.error) return state.error;
  return null;
}

async function runTopology({ chromium, extensionSource, modelPath, modelMetadata, modelBytes, plan, directory, workloads, count, timeoutMs, headed, report, rounds }) {
  const topologyReport = { id: plan.id, plan, status: 'running', directory, instances: [], coldLoad: [], warmup: [], rounds: [], network: [], errors: [] };
  const instances = [];
  let fatalReason = null;
  let aborting = false;
  const activeRequests = new Map();
  const triggerFatal = reason => {
    if (!fatalReason) fatalReason = String(reason || 'LOCAL_FATAL_RUNTIME_FAILURE');
    if (aborting) return;
    aborting = true;
    void Promise.allSettled([...activeRequests.values()].map(({ instance, id }) => instance.rpc({ action: 'abort', id }).catch(() => undefined)));
  };
  const cleanup = async () => {
    await Promise.allSettled(instances.map(async instance => {
      try { await instance.rpc({ action: 'unload' }); } catch {}
      try { await instance.rpc({ action: 'delete', modelId: instance.modelId }); } catch {}
      try { await instance.context.close(); } catch {}
      const profileRoot = resolve(instance.directory) + sep;
      if (!hasFlag('keep-profile') && resolve(instance.profile).startsWith(profileRoot) && resolve(instance.profile).includes(`${sep}profile-`)) {
        try { await rm(instance.profile, { recursive: true, force: true }); } catch {}
      }
    }));
  };
  const states = async () => Promise.all(instances.map(readState));
  const observe = async (target, phase) => {
    try {
      const current = await states();
      const observedPeaks = current.map(state => Number.isFinite(state.nativePeakActive) ? state.nativePeakActive : 0);
      const previousPeaks = target.nativeActivePeakPerInstance ?? [];
      target.nativeActivePeakPerInstance = observedPeaks.map((peak, index) => Math.max(peak, previousPeaks[index] ?? 0));
      // Each isolated controller exposes a lifetime native peak rather than a
      // current active count. Sum the per-instance peaks to keep topology B's
      // native capacity evidence explicit; do not call this promise overlap.
      target.nativeActivePeak = Math.max(target.nativeActivePeak ?? 0, target.nativeActivePeakPerInstance.reduce((sum, peak) => sum + peak, 0));
      target.gpuBuffers = bufferSnapshot(current);
      target.lastStates = current.map(describeState);
      const failure = current.map(fatalStateReason).find(Boolean);
      if (failure) triggerFatal(failure);
    } catch (error) {
      if (isFatalRuntimeFailure(error)) triggerFatal(error.message);
      else target.observationError = error.message;
    }
    target.lastObservedPhase = phase;
  };
  const request = async (instance, workload, index, text, phase, roundIndex) => {
    const id = `${plan.id}-${phase}-${roundIndex}-${instance.index}-${index}-${randomUUID()}`;
    const admittedAt = performance.now();
    const sample = { id, instanceIndex: instance.index, workload, index, phase, round: roundIndex,
      status: 'cancelled', startedAtMs: null, finishedAtMs: null, durationMs: null };
    activeRequests.set(id, { instance, id });
    let timer;
    let timedOut = false;
    try {
      const start = performance.now(); sample.startedAtMs = start - admittedAt;
      const stateBefore = instance.loaded ?? await readState(instance);
      const body = requestBody(instance.modelId, stateBefore, workload, text);
      const replyPromise = instance.rpc({ action: 'complete', id, modelId: instance.modelId, body });
      const timeoutPromise = new Promise(resolveTimeout => {
        timer = setTimeout(async () => {
          timedOut = true;
          try { await instance.rpc({ action: 'abort', id }); } catch {}
          resolveTimeout({ ok: false, error: 'LOCAL_BENCHMARK_TIMEOUT' });
        }, timeoutMs);
      });
      const reply = await Promise.race([replyPromise, timeoutPromise]);
      const finished = performance.now(); sample.finishedAtMs = finished - admittedAt; sample.durationMs = finished - admittedAt;
      if (timedOut) { sample.status = 'timeout'; sample.reason = 'LOCAL_BENCHMARK_TIMEOUT'; return sample; }
      if (!reply?.ok || !reply.result) {
        const reason = reply?.error ?? 'LOCAL_INFERENCE_FAILED';
        sample.status = fatalReason ? 'cancelled' : 'failed'; sample.reason = reason;
        if (isFatalRuntimeFailure(reason) || isFatalRuntimeFailure(reply?.state?.error)) triggerFatal(reason);
        return sample;
      }
      const raw = reply.result;
      const metrics = raw.danlingo_local;
      if (metrics && typeof metrics === 'object') Object.assign(sample, {
        queueMs: observed(metrics.queueMs) ? metrics.queueMs : undefined,
        inferenceMs: observed(metrics.inferenceMs) ? metrics.inferenceMs : undefined,
        promptMs: observed(metrics.promptMs) ? metrics.promptMs : undefined,
        decodeMs: observed(metrics.decodeMs) ? metrics.decodeMs : undefined,
        inputTokens: observed(metrics.promptTokens) ? metrics.promptTokens : undefined,
        outputTokens: observed(metrics.outputTokens) ? metrics.outputTokens : undefined,
        nativeSlot: Number.isSafeInteger(metrics.nativeSlot) ? metrics.nativeSlot : undefined,
        nativeTask: Number.isSafeInteger(metrics.nativeTask) ? metrics.nativeTask : undefined,
        finishReason: metrics.finishReason,
      });
      const settings = runtimeSettings(instance.modelId, instance.loaded ?? await readState(instance));
      const parsed = parseLocalProviderResult(raw, [{ id: '0', text }], settings).items.get('0');
      if (parsed?.text && !parsed.reason) sample.status = 'valid';
      else { sample.status = 'failed'; sample.reason = raw.choices?.[0]?.finish_reason === 'length' ? 'LOCAL_BENCHMARK_TRUNCATED' : parsed?.reason ?? 'LOCAL_BENCHMARK_PROTOCOL_INVALID'; }
      return sample;
    } catch (error) {
      const reason = timedOut ? 'LOCAL_BENCHMARK_TIMEOUT' : (error instanceof Error ? error.message : String(error));
      sample.finishedAtMs = performance.now() - admittedAt; sample.durationMs = sample.finishedAtMs;
      sample.status = fatalReason ? 'cancelled' : reason === 'LOCAL_BENCHMARK_TIMEOUT' ? 'timeout' : 'failed'; sample.reason = reason;
      if (isFatalRuntimeFailure(reason)) triggerFatal(reason);
      return sample;
    } finally {
      clearTimeout(timer);
      activeRequests.delete(id);
    }
  };
  const runMeasured = async (workload, roundIndex) => {
    const target = { round: roundIndex, workload, status: 'running', samples: [], nativeActivePeak: 0, gpuBuffers: null };
    const startedAt = performance.now();
    const queues = instances.map(() => []);
    for (let index = 0; index < count; index++) queues[index % instances.length].push(index);
    const poll = setInterval(() => { void observe(target, 'measuring'); }, 100);
    try {
      await Promise.all(instances.flatMap(instance => Array.from({ length: plan.parallelPerInstance }, async () => {
        const queue = queues[instance.index];
        while (queue.length && !fatalReason) {
          const index = queue.shift();
          const item = selectCorpusItem(workload, index, count);
          target.samples.push(await request(instance, workload, index, item.text, 'measured', roundIndex));
        }
      })));
      target.elapsedMs = performance.now() - startedAt;
      await observe(target, 'complete');
      target.stats = summarizeInstanceSamples(target.samples, target.elapsedMs);
      target.status = fatalReason ? 'aborted' : 'completed';
      topologyReport.rounds.push(target);
      return target;
    } finally {
      clearInterval(poll);
    }
  };
  try {
    for (let index = 0; index < plan.instanceCount; index++) {
      const instance = await createInstance({ chromium, extensionSource, directory, modelPath, modelMetadata, modelBytes,
        index, topologyId: plan.id, headed, report });
      instances.push(instance);
      topologyReport.network.push(...instance.network);
      const coldStarted = performance.now();
      const loadedReply = await instance.rpc({ action: 'load', modelId: instance.modelId, config: runtimeConfig(plan) });
      if (!loadedReply?.ok || !loadedReply.state) {
        const reason = loadedReply?.error ?? 'LOCAL_LOAD_FAILED';
        if (isFatalRuntimeFailure(reason)) triggerFatal(reason);
        throw new ExperimentAbort(reason);
      }
      instance.loaded = loadedReply.state;
      validateLoadedState(instance.loaded, plan);
      const cold = { instanceIndex: index, loadMs: performance.now() - coldStarted, state: describeState(instance.loaded) };
      topologyReport.coldLoad.push(cold);
      topologyReport.instances.push({ index, modelId: instance.modelId, loaded: cold.state });
      await observe({ nativeActivePeak: 0 }, 'loaded');
      if (fatalReason) throw new ExperimentAbort(fatalReason);
    }
    // Warm each isolated engine with the same fixed source rows, but exclude
    // these calls from measured throughput and latency distributions.
    for (const instance of instances) {
      for (const workload of workloads) {
        if (fatalReason) throw new ExperimentAbort(fatalReason);
        const item = selectCorpusItem(workload, 0, count);
        const warmupStarted = performance.now();
        const sample = await request(instance, workload, 0, item.text, 'warmup', -1);
        topologyReport.warmup.push({ instanceIndex: instance.index, workload, elapsedMs: performance.now() - warmupStarted,
          status: sample.status, reason: sample.reason, durationMs: sample.durationMs });
        if (fatalReason) throw new ExperimentAbort(fatalReason);
      }
    }
    for (let roundIndex = 1; roundIndex <= rounds; roundIndex++) {
      for (const workload of workloads) {
        if (fatalReason) throw new ExperimentAbort(fatalReason);
        await runMeasured(workload, roundIndex);
        await writeReportSnapshot(report);
      }
    }
    const measuredRows = topologyReport.rounds.flatMap(round => round.samples);
    const elapsedMs = topologyReport.rounds.reduce((sum, round) => sum + (round.elapsedMs ?? 0), 0);
    topologyReport.aggregate = summarizeInstanceSamples(measuredRows, elapsedMs);
    topologyReport.aggregate.nativeActivePeak = Math.max(0, ...topologyReport.rounds.map(round => round.nativeActivePeak ?? 0));
    topologyReport.aggregate.nativeActivePeakPerInstance = instances.map(instance => Math.max(0, ...topologyReport.rounds.flatMap(round => round.nativeActivePeakPerInstance?.[instance.index] ?? 0)));
    topologyReport.aggregate.gpuBuffers = topologyReport.rounds.at(-1)?.gpuBuffers ?? null;
    topologyReport.aggregate.trackedGpuBufferPeakBytes = Math.max(0, ...topologyReport.rounds.map(round => round.gpuBuffers?.sumPeakAllocatedBytes ?? 0));
    topologyReport.aggregate.measurementCaveat = 'native active peak is worker telemetry from overlapping native token streams; GPU buffer values are tracked GPUBuffer sizes, not physical VRAM.';
    topologyReport.status = 'completed';
  } catch (error) {
    topologyReport.status = fatalReason ? 'aborted' : error instanceof ExperimentAbort ? 'aborted' : 'failed';
    topologyReport.error = fatalReason ?? (error instanceof Error ? error.message : String(error));
    topologyReport.errors.push(topologyReport.error);
    if (fatalReason) report.abortReason = fatalReason;
  } finally {
    topologyReport.finalStates = await Promise.all(instances.map(async instance => {
      try { return describeState(await readState(instance)); } catch (error) { return { error: error.message }; }
    }));
    await cleanup();
    topologyReport.network = [...new Set(topologyReport.network)];
    report.network.push(...topologyReport.network);
  }
  return topologyReport;
}

async function writeReportSnapshot(report) {
  if (!report.directory) return;
  await writeFile(resolve(report.directory, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(resolve(report.root, 'latest.json'), JSON.stringify({ directory: report.directory, report: resolve(report.directory, 'report.json') }, null, 2));
}

function usage() {
  console.log('node --experimental-strip-types scripts/benchmark-local-instances.mjs [--model=PATH] [--count=32] [--workloads=normal] [--total-context=2048] [--timeout-ms=120000] [--headed] [--keep-profile]');
  console.log('Compares one isolated Wllama instance x4 with two isolated instances x2. Each topology has one cold load, an unmeasured warmup, and three measured rounds.');
}

export async function buildMethodOptions(argv = process.argv) {
  const values = new Map(argv.filter(value => value.startsWith('--') && value.includes('=')).map(value => {
    const index = value.indexOf('='); return [value.slice(2, index), value.slice(index + 1)];
  }));
  const totalContextTokens = Number(values.get('total-context') ?? DEFAULT_TOTAL_CONTEXT);
  const count = Number(values.get('count') ?? DEFAULT_COUNT);
  const timeoutMs = Number(values.get('timeout-ms') ?? DEFAULT_TIMEOUT_MS);
  const rounds = Number(values.get('rounds') ?? MEASURED_ROUNDS);
  assert.ok(Number.isSafeInteger(count) && count >= TOTAL_DISPATCH_CONCURRENCY && count <= 256, 'count must be 4..256');
  assert.ok(Number.isSafeInteger(rounds) && rounds === MEASURED_ROUNDS, `rounds is fixed at ${MEASURED_ROUNDS}`);
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 600_000, 'timeout-ms must be 1..600000');
  const workloads = parseWorkloads(values.get('workloads') ?? 'normal');
  return { modelPath: values.get('model') ?? 'D:/Tool/Models/LmStudioModels/lmstudio-community/HY-MT1.5-1.8B-FP8/HY-MT1.5-1.8B-Q8_0.gguf',
    count, rounds, timeoutMs, workloads, totalContextTokens, headed: argv.includes('--headed'), keepProfile: argv.includes('--keep-profile') };
}

async function main() {
  if (hasFlag('help')) { usage(); return; }
  const options = await buildMethodOptions();
  const root = resolve('.artifacts/local-instance-topology');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(resolve(root, 'run-'));
  const report = { capturedAt: new Date().toISOString(), status: 'running', directory, root,
    evidence: 'REAL_GGUF_ISOLATED_EXTENSION_WEBGPU_TOPOLOGY_COMPARISON', errors: [], network: [], topologies: [],
    method: { totalDispatchConcurrency: TOTAL_DISPATCH_CONCURRENCY, totalUnifiedKvTokens: options.totalContextTokens,
      rounds: MEASURED_ROUNDS, countPerWorkloadPerRound: options.count, workloads: options.workloads, timeoutMs: options.timeoutMs,
      coldLoad: 'Measured separately per instance and excluded from warm-round throughput/latency.',
      warmup: 'One unmeasured production-format local request per selected workload per isolated instance after cold load.',
      cache: { resultCaching: false, nativePromptCache: false, bodyCachePrompt: false, runtimeReusePromptCache: false, cacheIdleSlots: false },
      workload: 'Deterministic Japanese corpus rows from src/local/benchmark.ts; same row-selection and dispatch count for both topologies.',
      latency: 'Per-request admission-to-completion wall time; p50/p95/p99 are nearest-rank over valid production-parser translations.',
      throughput: 'Valid production-parser translations divided by the sum of measured round wall durations; failures and timeouts are retained.',
      nativePeak: 'Worker nativePeakActive telemetry observed while native token streams overlap; promise overlap alone is not counted.',
      gpuBuffers: 'Tracked WebGPU GPUBuffer allocation/peak bytes from the packaged meter; not physical VRAM or whole-device memory.' },
    model: null, abortReason: null };
  await writeReportSnapshot(report);
  try {
    const modelInfo = await readGgufMetadata(options.modelPath);
    report.model = { path: options.modelPath, bytes: modelInfo.bytes, metadata: modelInfo.metadata };
    const { chromium } = await loadPlaywright();
    const extensionSource = resolve('.output/chrome-mv3');
    const plans = buildTopologyPlans(options.totalContextTokens);
    for (const plan of plans) {
      if (report.abortReason) break;
      const topology = await runTopology({ chromium, extensionSource, modelPath: options.modelPath, modelMetadata: modelInfo.metadata,
        modelBytes: modelInfo.bytes, plan, directory: resolve(directory, plan.id), workloads: options.workloads, count: options.count,
        timeoutMs: options.timeoutMs, headed: options.headed, report, rounds: options.rounds });
      report.topologies.push(topology);
      await writeReportSnapshot(report);
      if (topology.status === 'aborted') break;
    }
    report.status = report.abortReason ? 'ABORTED' : report.topologies.every(topology => topology.status === 'completed') ? 'PASS' : 'FAIL';
    report.checks = { twoTopologiesCompared: report.topologies.length === plans.length,
      sameTotalUnifiedKvBudget: plans.every(plan => plan.totalUnifiedKvTokens === options.totalContextTokens),
      sameDispatchConcurrency: plans.every(plan => plan.totalDispatchConcurrency === TOTAL_DISPATCH_CONCURRENCY),
      noNetwork: report.network.length === 0,
      originalModelUnchanged: (await stat(options.modelPath)).size === modelInfo.bytes && (await stat(options.modelPath)).mtimeMs === modelInfo.mtimeMs,
      nativePeaksRecorded: report.topologies.every(topology => topology.aggregate?.nativeActivePeak !== undefined),
      trackedGpuBuffersRecorded: report.topologies.every(topology => topology.aggregate?.gpuBuffers !== undefined) };
  } catch (error) {
    report.status = report.abortReason ? 'ABORTED' : 'FAIL';
    report.errors.push(error.stack ?? error.message ?? String(error));
  } finally {
    await writeReportSnapshot(report);
    console.log('REPORT', resolve(directory, 'report.json'), report.status);
    if (report.status !== 'PASS') process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
