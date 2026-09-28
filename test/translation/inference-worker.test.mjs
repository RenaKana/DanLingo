import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { LocalController } from '../../src/local/controller.ts';

const source = readFileSync(new URL('../../src/local/inference.worker.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function makeWorkerHarness({ file }) {
  const harness = { inbound: [], outbound: [], imports: [], loadedFiles: undefined, prepared: undefined,
    fileReadCalls: 0, nativeFileReads: 0, nativeLoadStarted: false, terminated: false,
    onmessage: null, onerror: null, tasks: new Set() };
  for (const method of ['slice', 'arrayBuffer', 'stream', 'text']) {
    if (typeof file[method] !== 'function') continue;
    const original = file[method].bind(file);
    file[method] = (...args) => {
      harness.fileReadCalls++;
      if (harness.nativeLoadStarted) harness.nativeFileReads++;
      return original(...args);
    };
  }
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
    },
  };
  runInNewContext(compiled, {
    exports: {}, self, navigator: { gpu: {} },
    WebAssembly: { Suspending() {}, Memory: class {} },
    URL, performance, AbortController, DOMException,
    require: key => {
      harness.imports.push(key);
      assert.ok(key in dependencies, key);
      return dependencies[key];
    },
  });
  harness.postMessage = message => {
    if (harness.terminated) return;
    harness.inbound.push(message);
    if (message.action === 'load') {
      harness.nativeLoadStarted = true;
      harness.prepared = message.prepared;
    }
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

function preparedModel(file, id = 'worker-model') {
  return { info: { id, name: file.name, files: [file.name], bytes: file.size, importedAt: 1, architecture: 'llama' },
    files: [file], timings: { sourceMs: 1, metadataMs: 0 } };
}

test('cold preparation coalesces before native load and ready revalidation runs only on request', async () => {
  assert.doesNotMatch(source, /from\s+['"]\.\/(?:storage|gguf)\.ts['"]/);
  const file = new File([new Uint8Array(8 * 1024 * 1024)], 'model.gguf');
  const prepared = preparedModel(file);
  const workers = [];
  let preparationCalls = 0;
  const preparationOptions = [];
  let releasePreparation;
  const preparationGate = new Promise(resolve => { releasePreparation = resolve; });
  const controller = new LocalController(() => {
    const worker = makeWorkerHarness({ file });
    workers.push(worker);
    return worker;
  }, undefined, async (modelId, options) => {
    preparationCalls++;
    preparationOptions.push(options);
    options.onProgress?.({ stage: 'reading-file', currentFile: file.name });
    await preparationGate;
    return prepared;
  });

  const firstLoad = controller.load('worker-model', loadConfig());
  const sharedLoad = controller.load('worker-model', loadConfig());
  assert.equal(preparationCalls, 1);
  assert.equal(workers.length, 0, 'native Worker is not created before preparation finishes');
  assert.equal(controller.snapshot().currentFile, file.name, 'source preparation progress is visible through the controller');

  releasePreparation();
  const [state, sharedState] = await Promise.all([firstLoad, sharedLoad]);
  assert.equal(state.phase, 'ready');
  assert.equal(sharedState.phase, 'ready');
  const worker = workers[0];
  assert.equal(worker.prepared, prepared, 'controller forwards the prepared model payload unchanged');
  assert.equal(worker.loadedFiles, prepared.files, 'engine.loadModel receives the exact prepared File array');
  assert.equal(worker.loadedFiles[0], file, 'engine.loadModel receives the same File returned by preparation');
  assert.equal(preparationCalls, 1);
  assert.equal(worker.fileReadCalls, 0, 'preparation mock did not hash or read the file contents');
  assert.equal(worker.nativeFileReads, 0, 'native Worker does not read file contents');
  assert.equal(worker.imports.includes('./storage.ts'), false);
  assert.equal(worker.imports.includes('./gguf.ts'), false);
  assert.equal(worker.inbound.filter(message => message.action === 'load').length, 1);

  await controller.load('worker-model', loadConfig());
  assert.equal(preparationCalls, 1, 'ready automatic reuse skips source preparation');

  await controller.load('worker-model', loadConfig(), { validateSourceOnReuse: true });
  assert.equal(preparationCalls, 2, 'manual ready reuse invokes the preparation callback for source checks');
  assert.equal(typeof preparationOptions[1].shouldCancel, 'function');
  assert.equal(preparationOptions[1].onProgress, undefined, 'ready source checks do not publish cold-load progress');
  assert.equal(worker.inbound.filter(message => message.action === 'load').length, 1, 'ready source checks do not reload native state');
  assert.equal(worker.inbound.some(message => message.action === 'validate-source'), false, 'source checks stay outside the native Worker');
  assert.equal(worker.fileReadCalls, 0);
  assert.equal(worker.nativeFileReads, 0);
  assert.equal(controller.snapshot().stage, 'loaded');
  controller.unload();
});

test('unload cancels source preparation through the generation-bound callback before Worker creation', async () => {
  const file = new File(['source'], 'legacy.gguf');
  let releasePreparation;
  const preparationGate = new Promise(resolve => { releasePreparation = resolve; });
  let optionsSeen;
  let committed = false;
  const workers = [];
  const controller = new LocalController(() => {
    const worker = makeWorkerHarness({ file });
    workers.push(worker);
    return worker;
  }, undefined, async (modelId, options) => {
    optionsSeen = options;
    options.onProgress?.({ stage: 'reading-file', currentFile: file.name });
    await preparationGate;
    if (options.shouldCancel?.()) throw new Error('LOCAL_CANCELLED');
    committed = true;
    return preparedModel(file, modelId);
  });
  const loading = controller.load('worker-model', loadConfig());
  const rejected = assert.rejects(loading, /LOCAL_CANCELLED/);
  assert.equal(controller.snapshot().currentFile, file.name);
  assert.equal(typeof optionsSeen.shouldCancel, 'function');

  controller.unload();
  assert.equal(optionsSeen.shouldCancel(), true, 'unload advances the generation seen by source preparation');
  releasePreparation();
  await rejected;
  assert.equal(committed, false, 'cancelled preparation cannot commit source identity');
  assert.equal(workers.length, 0, 'cancelled preparation never creates a native Worker');
  assert.equal(controller.snapshot().phase, 'idle');
});
