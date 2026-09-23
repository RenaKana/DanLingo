import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { LocalController } from '../../src/local/controller.ts';
import { fingerprintFiles } from '../../src/local/gguf.ts';

const source = readFileSync(new URL('../../src/local/inference.worker.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function makeWorkerHarness({ file, cancelOnProgress = false, legacy = false } = {}) {
  const harness = { inbound: [], outbound: [], resolutions: [], loadedFiles: undefined, rotated: 0, terminated: false,
    onmessage: null, onerror: null, tasks: new Set(), stateHistory: [], observeState: undefined };
  let cancellationSent = false;
  const modelInfo = { id: 'worker-model', name: file.name, files: [file.name], bytes: file.size, importedAt: 1, architecture: 'llama' };
  const dependencies = {
    '@wllama/wllama/esm/index.js': { Wllama: class {
      constructor() { this.loaded = false; harness.engine = this; }
      setCompat() {}
      async loadModel(files) { this.files = files; this.loaded = true; harness.loadedFiles = files; }
      getLoadedContextInfo() { return { n_vocab: 1, n_layer: 1, n_ctx: 2048, metadata: { 'general.architecture': 'llama' } }; }
      getNumThreads() { return 1; }
      isModelLoaded() { return this.loaded; }
      async createCompletion() { return { choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }; }
      async exit() { this.loaded = false; }
    } },
    './storage.ts': { resolveModelFiles: async (modelId, options = {}) => {
      harness.resolutions.push({ modelId, options });
      const fingerprint = await fingerprintFiles([file], {
        shouldCancel: options.shouldCancel, cancelCode: 'LOCAL_CANCELLED', onProgress: options.onProgress,
      });
      if (options.shouldCancel?.()) throw new Error('LOCAL_CANCELLED');
      if (legacy) harness.rotated++;
      return { info: { ...modelInfo, id: modelId, fingerprint }, files: [file] };
    } },
    './gguf.ts': { inspectAndOrderFiles: async files => ({ files, info: { architecture: 'llama' } }) },
    './types.ts': { localError: error => /^LOCAL_[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'LOCAL_INFERENCE_FAILED' },
    './config.ts': {
      normalizeLocalConfig: value => ({ ...value, parallel: 1, contextTokens: 2048, batch: 128, microBatch: 128,
        cpuThreads: 1, flashAttention: 'off', warmup: false, allowAutoFallback: false, measureGpu: false }),
      resolveLocalConfig: value => ({ ...value, parallel: 1, contextTokens: 2048, batch: 128, microBatch: 128,
        cpuThreads: 1, flashAttention: 'off', warmup: false, allowAutoFallback: false, measureGpu: false }),
    },
    './gpu.ts': {
      emptyGpuInfo: () => ({ verified: false, deviceCreated: false, offloadedLayers: 0, totalLayers: 0 }),
      observeGpuLog() {}, verifyGpuOffload: info => { info.verified = true; },
    },
    './native-telemetry.ts': { NativeTelemetry: class {
      constructor() { this.slots = new Map(); this.active = new Map(); this.peakActive = 0; this.evidence = []; this.warmup = false; }
      observe() { return false; }
    } },
    './generation.ts': { localGenerationOptions: () => ({ reasoning: 'off', maxTokens: 1, options: {} }) },
    './completion.ts': { localCompletionCollector: () => ({ onData() {}, result: () => undefined }) },
    './translation-profile.ts': { translationLoadOptions: () => ({}), translationPrompt: () => '', translationRawOptions: () => ({}) },
    './load-diagnostics.ts': { nativeLoadError: () => undefined },
  };
  const self = {
    location: { href: 'https://extension.invalid/offscreen.js' },
    addEventListener() {},
    postMessage(message) {
      harness.outbound.push(message);
      harness.onmessage?.({ data: message });
      if (message.stage === 'fingerprinting' && harness.observeState) harness.stateHistory.push(harness.observeState());
      if (cancelOnProgress && !cancellationSent && message.stage === 'fingerprinting'
        && message.verificationProgress?.bytesProcessed > 0) {
        cancellationSent = true;
        queueMicrotask(() => {
          const cancel = { action: 'cancel-verification', id: message.id };
          harness.inbound.push(cancel); void self.onmessage({ data: cancel });
        });
      }
    },
  };
  runInNewContext(compiled, {
    exports: {}, self, navigator: { gpu: {} },
    WebAssembly: { Suspending() {}, Memory: class {} },
    URL, performance, AbortController, DOMException,
    require: key => { assert.ok(key in dependencies, key); return dependencies[key]; },
  });
  harness.dispatch = message => { harness.inbound.push(message); return self.onmessage({ data: message }); };
  harness.postMessage = message => {
    if (harness.terminated) return;
    harness.inbound.push(message);
    const task = Promise.resolve().then(() => self.onmessage({ data: message }));
    harness.tasks.add(task);
    void task.catch(error => { if (!harness.terminated) harness.onerror?.({ message: String(error) }); })
      .finally(() => harness.tasks.delete(task));
  };
  harness.terminate = () => { harness.terminated = true; };
  harness.script = self;
  return harness;
}

function loadConfig() {
  return { mode: 'custom', parallel: 1, contextTokens: 2048, estimatedTokensPerRequest: 64,
    batchPreset: 'compatibility', batch: 128, microBatch: 128, warmup: false, flashAttention: 'off',
    allowAutoFallback: false, cpuThreads: 1, measureGpu: false };
}

test('inference Worker verifies source bytes, passes the same File to the engine, and only manual reuse revalidates', async () => {
  const file = new File([new Uint8Array(8 * 1024 * 1024)], 'model.gguf');
  const worker = makeWorkerHarness({ file });
  const controller = new LocalController(() => worker);
  worker.observeState = () => controller.snapshot();

  const state = await controller.load('worker-model', loadConfig());
  assert.equal(state.phase, 'ready');
  assert.equal(worker.loadedFiles[0], file, 'engine.loadModel receives the exact File returned by resolveModelFiles');
  assert.equal(worker.resolutions.length, 1, 'initial load verifies once');
  assert.ok(worker.outbound.some(message => message.stage === 'fingerprinting'
    && message.verificationProgress?.bytesProcessed > 0), 'Worker reports source verification byte progress');
  assert.ok(worker.stateHistory.some(snapshot => snapshot.verificationProgress?.bytesProcessed > 0), 'controller exposes byte progress in its current state');

  await controller.load('worker-model', loadConfig());
  assert.equal(worker.resolutions.length, 1, 'ordinary ensure reuses the loaded runtime without rereading source bytes');
  await controller.complete('request-one', 'worker-model', { tokenizeText: 'fixture' });
  assert.equal(worker.resolutions.length, 1, 'ordinary generation does not reread source bytes');

  await controller.load('worker-model', loadConfig(), { validateSourceOnReuse: true });
  assert.equal(worker.resolutions.length, 2, 'manual load reuse validates through the existing Worker');
  assert.ok(worker.inbound.some(message => message.action === 'validate-source'), 'manual reuse sends validate-source');
  assert.equal(worker.loadedFiles[0], file, 'manual verification leaves the engine File reference intact');
  assert.equal(controller.snapshot().stage, 'loaded');
  assert.equal(controller.snapshot().verificationProgress, undefined);
  controller.unload();
});

test('cancelling Worker verification prevents legacy identity rotation', async () => {
  const file = new File([new Uint8Array(8 * 1024 * 1024)], 'legacy.gguf');
  const worker = makeWorkerHarness({ file, cancelOnProgress: true, legacy: true });
  const result = await worker.dispatch({ id: 'load-cancel', action: 'load', modelId: 'worker-model', config: loadConfig() });
  assert.equal(result, undefined);
  assert.equal(worker.rotated, 0, 'resolver never reaches the legacy identity commit after cancellation');
  assert.ok(worker.outbound.some(message => message.id === 'load-cancel' && message.ok === false && message.error === 'LOCAL_CANCELLED'));
  assert.ok(worker.inbound.some(message => message.action === 'cancel-verification'));
});
