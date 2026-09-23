import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalBenchmarkRunner } from '../../src/local/benchmark-runner.ts';
import { normalizeLocalConfig, resolveLocalConfig } from '../../src/local/config.ts';
import { LOCAL_BENCHMARK_CORPUS } from '../../src/local/benchmark.ts';
import { LocalController } from '../../src/local/controller.ts';

class FixtureController {
  state = { phase: 'idle', active: 0, queued: 0 };
  bodies = []; loads = []; unloads = 0;
  snapshot() { return structuredClone(this.state); }
  async load(id, config) {
    this.loads.push(id);
    this.state = { phase: 'ready', active: 0, queued: 0, model: { id }, requested: normalizeLocalConfig(config), runtime: resolveLocalConfig(config, id), fallbackReasons: [] };
    return this.snapshot();
  }
  unload() { this.unloads++; this.state = { phase: 'idle', active: 0, queued: 0 }; }
  abort() {}
  async complete(id, model, body) {
    this.bodies.push(body);
    return { choices: [{ message: { content: '[0,"翻译结果"]' }, finish_reason: 'stop' }],
      danlingo_local: { queueMs: 1, promptMs: 2, decodeMs: 3, promptTokens: 5, outputTokens: 4 } };
  }
}
async function finished(runner) {
  for (let i = 0; i < 100; i++) {
    const report = runner.snapshot();
    if (report.phase === 'done') return report;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('fixture did not settle');
}

for (const thrown of [true, false]) {
  test(`after-group GPU device loss cannot produce a recommendation (${thrown ? 'fatal exception' : 'unavailable diagnostics'})`, async () => {
    const controller = new FixtureController();
    let calls = 0;
    controller.flushGpuTiming = async () => {
      if (++calls === 2) {
        controller.state.phase = 'error';
        controller.state.error = 'LOCAL_GPU_DEVICE_LOST';
        controller.state.generation = 2;
        throw new Error(thrown ? 'LOCAL_GPU_DEVICE_LOST' : 'LOCAL_GPU_TIMING_UNAVAILABLE');
      }
      return controller.snapshot();
    };
    const runner = new LocalBenchmarkRunner(controller);
    runner.start('model', { parallels: [1], workloads: ['short'], count: 2, baseConfig: { measureGpu: true } });
    const report = await finished(runner);
    assert.equal(report.groups[0].stats.success, 2);
    assert.equal(report.groups[0].status, 'failed');
    assert.equal(report.groups[0].error, 'LOCAL_GPU_DEVICE_LOST');
    assert.equal(report.status, 'failed');
    assert.equal(report.recommendation.recommendedParallel, null);
  });
}

test('runner exercises compact provider protocol, preserves limits, measures samples and restores prior model', async () => {
  const controller = new FixtureController();
  await controller.load('previous', { mode: 'custom', parallel: 2 });
  const runner = new LocalBenchmarkRunner(controller);
  runner.start('benchmark', { parallels: [1], workloads: ['short', 'long'], count: 2, applicationConcurrency: 2 });
  const report = await finished(runner);
  assert.equal(report.status, 'completed');
  assert.deepEqual(controller.loads, ['previous', 'benchmark', 'previous']);
  assert.equal(report.groups.length, 2);
  assert.equal(report.groups[0].stats.success, 2);
  assert.equal(report.groups[1].samples[0].quality, 'needs-review');
  assert.equal(controller.bodies.length, 6); // one fresh warmup per workload
  assert.ok(controller.bodies.every(body => body.benchmark && body.cache_prompt === false && body.stream === false));
  assert.ok(controller.bodies.every(body => JSON.parse(body.messages[1].content)[0] === 0));
  assert.equal(controller.bodies[0].max_tokens, 128);
  assert.equal(controller.bodies[3].max_tokens, 256);
  assert.equal(controller.bodies[3].strategy, 'superchat');
  assert.equal(report.recommendation.recommendedParallel, 1);
});

test('truncated results and runtime fallback cannot produce an eligible recommendation', async () => {
  const controller = new FixtureController();
  const load = controller.load.bind(controller);
  controller.load = async (...args) => { await load(...args); controller.state.fallbackReasons = ['LOCAL_FALLBACK']; return controller.snapshot(); };
  controller.complete = async () => ({ choices: [{ message: { content: '[0,"partial"]' }, finish_reason: 'length' }] });
  const runner = new LocalBenchmarkRunner(controller);
  runner.start('model', { parallels: [1], workloads: ['short'], count: 1 });
  const report = await finished(runner);
  assert.equal(report.groups[0].status, 'runtime-mismatch');
  assert.equal(report.groups[0].samples[0].protocolSuccess, false);
  assert.equal(report.groups[0].samples[0].reason, 'LOCAL_BENCHMARK_TRUNCATED');
  assert.equal(report.recommendation.recommendedParallel, null);
  assert.equal(controller.unloads, 1);
});

test('HY benchmark uses Chinese to Japanese plain output and user limits above former caps', async () => {
  const controller = new FixtureController(), load = controller.load.bind(controller);
  controller.load = async (...args) => { await load(...args); controller.state.model.name = 'HY-MT1.5-1.8B-Q8_0.gguf'; return controller.snapshot(); };
  controller.complete = async (_id, _model, body) => {
    controller.bodies.push(body);
    assert.equal(body.messages.length, 1); assert.match(body.messages[0].content, /翻译为日语/);
    const placeholders = body.messages[0].content.match(/\[\[DL:[^\]]+\]\]/g) ?? [];
    return { choices: [{ message: { content: 'こんにちは。' + placeholders.join('') }, finish_reason: 'stop' }] };
  };
  const runner = new LocalBenchmarkRunner(controller);
  runner.start('hy', { sourceLanguage: 'auto', targetLanguage: 'ja', parallels: [33], applicationConcurrency: 65,
    workloads: ['short', 'long'], count: 2, baseConfig: { normalMaxTokens: 2048, superChatMaxTokens: 4096 } });
  const report = await finished(runner);
  assert.equal(report.status, 'completed');
  assert.ok(report.groups.every(group => group.runtime.parallel === 33 && group.stats.success === 2));
  assert.ok(controller.bodies.filter(body => body.strategy === 'normal').every(body => body.max_tokens === 2048));
  assert.ok(controller.bodies.filter(body => body.strategy === 'superchat').every(body => body.max_tokens === 4096));
  assert.ok(controller.bodies.every(body => body.cache_prompt === false));
});

test('explicit stop invalidates the generation and rejects pending native work without an abort acknowledgement', async () => {
  let worker;
  const controller = new LocalController(() => worker = {
    onmessage: null, onerror: null, terminated: false, messages: [],
    terminate() { this.terminated = true; },
    postMessage(message) {
      this.messages.push(message);
      if (message.action === 'load') queueMicrotask(() => this.onmessage({ data: {
        id: message.id, ok: true, model: { id: message.modelId }, requested: normalizeLocalConfig(message.config), runtime: resolveLocalConfig(message.config),
      } }));
      // Native completion intentionally never acknowledges; explicit Stop terminates it.
    },
  });
  const runner = new LocalBenchmarkRunner(controller);
  runner.start('model', { parallels: [1], workloads: ['short'], count: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(worker.messages.some(message => message.action === 'complete'));
  const generation = controller.snapshot().generation;
  const stopping = runner.stop();
  assert.equal(worker.terminated, true);
  assert.ok(controller.snapshot().generation > generation);
  assert.equal(runner.isRunning(), true);
  assert.throws(() => runner.start('another'), /LOCAL_BENCHMARK_BUSY/);
  const report = await stopping;
  assert.equal(report.status, 'cancelled');
  assert.equal(controller.snapshot().phase, 'idle');
  assert.equal(runner.isRunning(), false);
});

test('explicit stop interrupts an unresolved model load with no active inference requests', async () => {
  let worker;
  const controller = new LocalController(() => worker = {
    onmessage: null, onerror: null, terminated: false,
    postMessage() {}, // Model load never responds.
    terminate() { this.terminated = true; },
  });
  const runner = new LocalBenchmarkRunner(controller);
  runner.start('model', { parallels: [1], workloads: ['short'], count: 1 });
  assert.equal(controller.snapshot().phase, 'loading');
  assert.equal(controller.snapshot().active, 0);
  const stopping = runner.stop();
  assert.equal(worker.terminated, true);
  assert.equal(runner.isRunning(), true);
  assert.equal((await stopping).status, 'cancelled');
  assert.equal(controller.snapshot().phase, 'idle');
  assert.equal(runner.isRunning(), false);
});

test('capacity timeout includes application queue and does not invent controller queue observations', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new FixtureController();
  let calls = 0, rejectActive;
  const complete = controller.complete.bind(controller);
  controller.complete = (...args) => ++calls === 1 ? complete(...args) : new Promise((resolve, reject) => { rejectActive = reject; });
  controller.abort = () => rejectActive(new Error('LOCAL_CANCELLED'));
  const runner = new LocalBenchmarkRunner(controller);
  assert.throws(() => runner.start('model', { requestTimeoutMs: 0 }), /LOCAL_BENCHMARK_CONFIG_INVALID/);
  assert.throws(() => runner.start('model', { requestTimeoutMs: Infinity }), /LOCAL_BENCHMARK_CONFIG_INVALID/);
  runner.start('model', { parallels: [1], workloads: ['short'], count: 2, applicationConcurrency: 1, requestTimeoutMs: 5 });
  // Start the first measured request, then cross both samples' shared admission
  // deadline deterministically. Real 5ms timers can fire early relative to
  // performance.now() and accidentally admit the queued sample under load.
  for (let i = 0; i < 100 && calls < 2; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  now = 10;
  t.mock.timers.tick(10);
  const report = await finished(runner);
  assert.equal(report.options.requestTimeoutMs, 5);
  assert.equal(report.groups[0].stats.timeout, 2);
  assert.equal(calls, 2); // warmup and first sample; the app-queued sample already expired
  assert.equal(report.groups[0].stats.queueMs.coverage, 0);
  assert.ok(report.groups[0].samples.every(sample => sample.queueMs === undefined));
  assert.equal(controller.unloads, 1);
});

test('GPU group telemetry uses sampled counter deltas and exposes boundary coverage caveats', async () => {
  const controller = new FixtureController();
  const complete = controller.complete.bind(controller);
  controller.complete = async (...args) => {
    const previous = controller.state.gpu;
    controller.state.gpu = { executionMs: (previous?.executionMs ?? 0) + 4, timedComputePasses: (previous?.timedComputePasses ?? 0) + 3,
      missedComputePasses: (previous?.missedComputePasses ?? 0) + 1, timingReadFailures: 0, pendingTimingRecords: 2,
      allocatedBytes: 1024, peakAllocatedBytes: 2048 };
    controller.state.nativePeakActive = 4;
    return complete(...args);
  };
  const runner = new LocalBenchmarkRunner(controller);
  const initial = runner.start('model', { parallels: [1], workloads: ['short'], count: 2 });
  assert.equal(initial.options.requestTimeoutMs, 120000);
  const report = await finished(runner), gpu = report.groups[0].gpuObservation;
  assert.equal(gpu.sampledComputeMs, 8);
  assert.equal(gpu.completeComputeMs, null);
  assert.equal(gpu.boundariesFlushed, false);
  assert.equal(gpu.timedComputePasses, 6);
  assert.equal(gpu.missedComputePasses, 2);
  assert.equal(gpu.computePassCoverage, 0.75);
  assert.equal(gpu.pendingTimingRecordsBefore, 2);
  assert.equal(gpu.allocatedBufferBytesAfter, 1024);
  assert.equal(gpu.lifetimePeakAllocatedBufferBytes, 2048);
  assert.match(gpu.caveat, /not total GPU time/);
  assert.match(gpu.caveat, /not physical VRAM/);
});

for (const incomplete of [undefined, 'missed', 'pending', 'failed', 'unsupported', 'flush-error']) {
  test(`GPU group flushes warmup and completed concurrent requests with ${incomplete ?? 'complete'} coverage`, async () => {
    const controller = new FixtureController(), complete = controller.complete.bind(controller);
    let deferredMs = 0, calls = 0, flushes = 0, active = 0;
    controller.complete = async (...args) => {
      active++; calls++; deferredMs += 4;
      await Promise.resolve(); const result = await complete(...args); active--;
      return result;
    };
    controller.flushGpuTiming = async () => {
      assert.equal(active, 0); flushes++;
      assert.equal(calls, flushes === 1 ? 1 : 3); // warmup; then both measured requests
      const previous = controller.state.gpu;
      controller.state.gpu = { timestampQueries: incomplete !== 'unsupported',
        executionMs: (previous?.executionMs ?? 0) + deferredMs,
        timedComputePasses: (previous?.timedComputePasses ?? 0) + deferredMs / 4,
        missedComputePasses: flushes === 2 && incomplete === 'missed' ? 1 : 0,
        timingReadFailures: flushes === 2 && incomplete === 'failed' ? 1 : 0,
        pendingTimingRecords: flushes === 2 && incomplete === 'pending' ? 1 : 0 };
      deferredMs = 0;
      if (incomplete === 'flush-error') throw new Error('LOCAL_GPU_TIMING_TIMEOUT');
      return controller.snapshot();
    };
    const runner = new LocalBenchmarkRunner(controller);
    runner.start('model', { parallels: [1], workloads: ['short'], count: 2, applicationConcurrency: 2, baseConfig: { measureGpu: true } });
    const report = await finished(runner), group = report.groups[0];
    assert.equal(report.status, 'completed'); assert.equal(flushes, 2);
    assert.equal(group.gpuObservation.sampledComputeMs, 8);
    assert.equal(group.gpuObservation.completeComputeMs, incomplete ? null : 8);
    assert.equal(group.gpuObservation.scope, 'group-compute-passes');
    assert.equal(group.gpuObservation.boundariesFlushed, incomplete !== 'flush-error');
    assert.equal(group.stats.gpuExecutionMs, null);
    assert.ok(group.samples.every(sample => sample.gpuExecutionMs === null));
    if (incomplete === 'flush-error') assert.equal(group.gpuObservation.flushError, 'LOCAL_GPU_TIMING_TIMEOUT');
  });
}

test('controller flush is diagnostics-only, requires idle capacity, and is cancelled on unload', async () => {
  let worker;
  const controller = new LocalController(() => worker = {
    onmessage: null, onerror: null, messages: [], terminate() {},
    postMessage(message) {
      this.messages.push(message);
      if (message.action === 'load') queueMicrotask(() => this.onmessage({ data: { id: message.id, ok: true,
        model: { id: message.modelId }, runtime: resolveLocalConfig(message.config), requested: normalizeLocalConfig(message.config) } }));
    },
  });
  await controller.load('model', { measureGpu: false });
  await assert.rejects(controller.flushGpuTiming(), /LOCAL_GPU_TIMING_UNAVAILABLE/);
  assert.equal(worker.messages.length, 1);
  await controller.load('model', { measureGpu: true });
  const flushing = controller.flushGpuTiming(); const request = worker.messages.at(-1);
  assert.equal(request.action, 'gpu-flush');
  worker.onmessage({ data: { id: request.id, ok: true, gpu: { executionMs: 12, pendingTimingRecords: 0 } } });
  assert.equal((await flushing).gpu.executionMs, 12);
  const completion = controller.complete('test', 'model', {});
  await assert.rejects(controller.flushGpuTiming(), /LOCAL_GPU_TIMING_BUSY/);
  const completionRejected = assert.rejects(completion, /LOCAL_MODEL_CHANGED/);
  controller.unload(); await completionRejected;
  await controller.load('model', { measureGpu: true });
  const pending = controller.flushGpuTiming(), rejected = assert.rejects(pending, /LOCAL_MODEL_CHANGED/);
  controller.unload(); await rejected;
});

test('repeated variant names and parallel values retain an unambiguous recommended configuration', async () => {
  const controller = new FixtureController();
  const complete = controller.complete.bind(controller);
  controller.complete = (...args) => controller.state.requested.temperature === 0
    ? Promise.resolve({ choices: [{ message: { content: 'invalid' }, finish_reason: 'stop' }] }) : complete(...args);
  const runner = new LocalBenchmarkRunner(controller);
  runner.start('model', { workloads: ['short'], count: 2, variants: [
    { name: 'same', config: { mode: 'custom', parallel: 1, temperature: 0 } },
    { name: 'same', config: { mode: 'custom', parallel: 1, temperature: 0.2 } },
  ] });
  const report = await finished(runner);
  assert.equal(report.recommendedVariant.variantId, 'variant-1');
  assert.equal(report.recommendedVariant.config.temperature, 0.2);
  assert.notEqual(report.groups[0].variantId, report.groups[1].variantId);
  assert.equal(report.groups[0].gpuObservation.sampledComputeMs, null);
  assert.equal(report.groups[0].gpuObservation.computePassCoverage, null);
});

test('individual raw-completion preflight failure remains unknown while measured translation continues', async () => {
  const controller = new FixtureController(), complete = controller.complete.bind(controller);
  controller.complete = (...args) => {
    const body = args[2];
    if (body.tokenizeText !== undefined) {
      if (body.tokenizeText === 'ㅋㅋㅋㅋ') return Promise.reject(new Error('LOCAL_INFERENCE_FAILED'));
      return Promise.resolve({ tokens: 8 });
    }
    return complete(...args);
  };
  const runner = new LocalBenchmarkRunner(controller);
  runner.start('model', { parallels: [1], workloads: ['short', 'normal'], count: 16, validateCorpus: true });
  const report = await finished(runner);
  assert.equal(report.status, 'completed');
  assert.deepEqual(report.corpusTokens.find(item => item.id === 'short-ko-07'), { id: 'short-ko-07', tokens: null, error: 'LOCAL_INFERENCE_FAILED' });
  assert.equal(report.corpusTokens.length, LOCAL_BENCHMARK_CORPUS.filter(item => item.workload !== 'long').length);
  for (const group of report.groups) {
    assert.equal(group.stats.success, 16);
    const ids = group.samples.map(sample => sample.corpusId);
    for (const language of ['ja', 'en', 'ko']) assert.ok(ids.some(id => id.includes(`-${language}-`)));
    assert.equal(new Set(ids).size, 16);
  }
  assert.ok(report.groups[0].samples.some(sample => sample.corpusId === 'short-ko-07'));
  assert.ok(report.groups[0].samples.some(sample => sample.source.length <= 4));
});

test('preflight stops when the model becomes unavailable instead of hiding a runtime failure', async () => {
  const controller = new FixtureController();
  let calls = 0;
  controller.complete = async () => {
    calls++;
    controller.state.phase = 'error';
    throw new Error('LOCAL_GPU_DEVICE_FAILED');
  };
  const runner = new LocalBenchmarkRunner(controller);
  runner.start('model', { parallels: [1], workloads: ['short'], count: 1, validateCorpus: true });
  const report = await finished(runner);
  assert.equal(report.status, 'failed');
  assert.equal(report.error, 'LOCAL_GPU_DEVICE_FAILED');
  assert.equal(calls, 1);
  assert.equal(report.corpusTokens[0].tokens, null);
  assert.equal(report.groups.length, 0);
});

test('restoration retains running status and exclusive ownership until the original model is ready', async () => {
  const controller = new FixtureController();
  await controller.load('previous', { parallel: 2 });
  const load = controller.load.bind(controller);
  let restore;
  controller.load = (id, config) => id === 'previous' ? new Promise(resolve => { restore = async () => resolve(await load(id, config)); }) : load(id, config);
  const runner = new LocalBenchmarkRunner(controller);
  assert.equal(runner.isRunning(), false);
  runner.start('model', { parallels: [1], workloads: ['short'], count: 1 });
  for (let i = 0; i < 20 && !restore; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof restore, 'function');
  assert.equal(runner.snapshot().phase, 'restoring');
  assert.equal(runner.snapshot().status, 'running');
  assert.equal(runner.isRunning(), true);
  assert.throws(() => runner.start('another'), /LOCAL_BENCHMARK_BUSY/);
  let stopped = false;
  const stopping = runner.stop().then(value => { stopped = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runner.snapshot().status, 'stopping');
  assert.equal(runner.isRunning(), true);
  assert.equal(stopped, false);
  await restore();
  assert.equal((await stopping).status, 'cancelled');
  assert.equal(runner.isRunning(), false);
  assert.equal(controller.snapshot().model.id, 'previous');
});

test('auto benchmark recommendation retains the measured model-specific parallel', async () => {
  const controller = new FixtureController(), runner = new LocalBenchmarkRunner(controller);
  const autoRecommendation = { modelId: 'model', measuredAt: 1, parallel: 4, contextTokens: 4096,
    batch: 512, microBatch: 256, flashAttention: 'auto', cpuThreads: 1 };
  runner.start('model', { workloads: ['short'], count: 8, variants: [{ name: 'auto', config: { mode: 'auto', autoRecommendation } }] });
  const report = await finished(runner);
  assert.equal(report.groups[0].status, 'completed');
  assert.equal(report.groups[0].runtime.parallel, 4);
  assert.equal(report.recommendation.recommendedParallel, 4);
  assert.equal(report.recommendedVariant.variantId, 'variant-0');
});

for (const count of [16, 32]) {
  test(`parallel 16 with ${count} samples ${count === 16 ? 'retains metrics without automatic advice' : 'meets the two-wave recommendation gate'}`, async () => {
    const runner = new LocalBenchmarkRunner(new FixtureController());
    runner.start('model', { parallels: [16], workloads: ['short', 'normal'], count });
    const report = await finished(runner);
    assert.equal(report.status, 'completed');
    assert.ok(report.groups.every(group => group.status === 'completed' && group.stats.success === count && group.samples.length === count));
    assert.equal(report.recommendation.recommendedParallel, count === 16 ? null : 16);
    assert.equal(report.recommendation.eligible.length, count === 16 ? 0 : 1);
    assert.match(report.recommendation.algorithm, /two native-slot waves per selected workload/);
    assert.match(report.evidence, /two native-slot waves/);
  });
}
