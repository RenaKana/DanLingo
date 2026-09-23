import { Wllama } from '@wllama/wllama/esm/index.js';
import { resolveModelFiles } from './storage.ts';
import { inspectAndOrderFiles } from './gguf.ts';
import { localError } from './types.ts';
import type { LocalModelInfo, LocalRuntimeConfig, LocalInferenceMetrics } from './types.ts';
import { normalizeLocalConfig, resolveLocalConfig } from './config.ts';
import { emptyGpuInfo, observeGpuLog, verifyGpuOffload } from './gpu.ts';
import { NativeTelemetry } from './native-telemetry.ts';
import { localGenerationOptions } from './generation.ts';
import { localCompletionCollector } from './completion.ts';
import { translationLoadOptions, translationPrompt, translationRawOptions } from './translation-profile.ts';
import { nativeLoadError } from './load-diagnostics.ts';

let engine: Wllama | undefined;
let runtime: LocalRuntimeConfig;
let loadedModel: LocalModelInfo | undefined;
let gpu = emptyGpuInfo();
let native = new NativeTelemetry();
let failed = false, loading = false, ready = false;
let loadId = '';
let loadFailure: string | undefined;
const running = new Map<string, AbortController>();
const sourceVerifications = new Map<string, AbortController>();
const nativeGenerating = new Set<string>();
let nativeGenerationPeak = 0;
const telemetry = () => self.postMessage({ telemetry: { gpu, nativeSlots: native.slots.size,
  nativePeakActive: Math.max(native.peakActive, nativeGenerationPeak), nativeEvidence: native.evidence } });
self.addEventListener('danlingo-local-gpu', ((event: CustomEvent) => {
  const value = event.detail;
  if (value?.error) {
    failed = true;
    if (!loading) { ready = false; self.postMessage({ fatal: true, error: /^LOCAL_[A-Z0-9_]+$/.test(value.error) ? value.error : 'LOCAL_GPU_DEVICE_FAILED' }); }
    return;
  }
  if (value?.adapter) { gpu.vendor = value.adapter.vendor; gpu.architecture = value.adapter.architecture; }
  if (value?.deviceCreated === true) gpu.deviceCreated = true;
  if (value?.metrics) Object.assign(gpu, value.metrics);
  telemetry();
}) as EventListener);
const metadataOnly = (...values: unknown[]) => {
  for (const value of values) {
    if (loading) loadFailure ??= nativeLoadError(value);
    observeGpuLog(gpu, value);
    if (native.observe(value, gpu)) {
      if (loading && native.warmup) self.postMessage({ id: loadId, stage: 'warming' });
      telemetry();
    }
  }
};
const numeric = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
function inferenceError(error: unknown): string {
  if (error instanceof Error && /abort/i.test(error.name)) return 'LOCAL_CANCELLED';
  const message = error instanceof Error ? error.message : '';
  if (/context|kv.cache|too.long|exceed.*token/i.test(message)) return 'LOCAL_CONTEXT_CAPACITY_EXCEEDED';
  if (/unknown architecture|unsupported architecture|unsupported.*(?:model|tensor|backend)|(?:model|tensor|backend).*unsupported|not implemented|invalid.*(?:model|tensor)|failed to load.*model/i.test(message)) return 'LOCAL_NATIVE_UNSUPPORTED';
  return localError(error);
}
async function resolveModelFilesWithProgress(id: string, modelId: string) {
  const cancellation = new AbortController();
  sourceVerifications.set(id, cancellation);
  try {
    return await resolveModelFiles(modelId, {
      shouldCancel: () => cancellation.signal.aborted,
      onProgress: progress => {
        if (!cancellation.signal.aborted) self.postMessage({ id, stage: 'fingerprinting',
          verificationProgress: { bytesProcessed: progress.bytesProcessed, totalBytes: progress.totalBytes } });
      },
    });
  } finally {
    if (sourceVerifications.get(id) === cancellation) sourceVerifications.delete(id);
  }
}
self.onmessage = async (event: MessageEvent) => {
  const { id, action, modelId, body } = event.data;
  if (action === 'abort') { running.get(id)?.abort(); sourceVerifications.get(id)?.abort(); return; }
  if (action === 'cancel-verification') { sourceVerifications.get(id)?.abort(); return; }
  try {
    if (action === 'load') {
      loading = true; ready = false; loadId = id;
      if (!(navigator as any).gpu) throw new Error('LOCAL_WEBGPU_UNSUPPORTED');
      if (!(WebAssembly as any).Suspending) throw new Error('LOCAL_BROWSER_JSPI_UNSUPPORTED');
      try { new WebAssembly.Memory({ address: 'i64', initial: 1n } as any); } catch { throw new Error('LOCAL_BROWSER_MEMORY64_UNSUPPORTED'); }
      const model = await resolveModelFilesWithProgress(id, modelId);
      const inspected = await inspectAndOrderFiles(model.files);
      const modelInfo = { ...model.info, ...inspected.info, id: model.info.id, name: model.info.name,
        files: model.info.files, bytes: model.info.bytes, importedAt: model.info.importedAt };
      loadedModel = modelInfo;
      const requested = normalizeLocalConfig(event.data.config);
      const desired = resolveLocalConfig(requested, modelId), fallbackReasons: string[] = [];
      const warnings: string[] = [];
      const attempts: LocalRuntimeConfig[] = [desired];
      if (requested.allowAutoFallback) {
        if (desired.flashAttention === 'auto') attempts.push({ ...desired, flashAttention: 'off' });
        if (desired.flashAttention !== 'on') attempts.push({ ...desired, mode: 'custom', parallel: 1,
          contextTokens: 2048, batchPreset: 'compatibility', batch: 128, microBatch: 128, flashAttention: 'off' });
      }
      let lastError: unknown;
      for (let attempt = 0; attempt < attempts.length; attempt++) {
        runtime = attempts[attempt]!; failed = false; loadFailure = undefined; gpu = emptyGpuInfo(); native = new NativeTelemetry(); nativeGenerating.clear(); nativeGenerationPeak = 0;
        try {
          self.postMessage({ id, stage: 'initializing-wasm', model: modelInfo });
          (self as any).__DANLINGO_GPU_TIMING__ = runtime.measureGpu;
          engine = new Wllama({ default: new URL('/local/wllama.wasm', self.location.href).href }, {
            suppressNativeLog: false, logger: { debug: metadataOnly, log: metadataOnly, warn: metadataOnly, error: metadataOnly } });
          engine.setCompat(null);
          self.postMessage({ id, stage: 'loading-weights' });
          await engine.loadModel(inspected.files, { log_level: 2, n_ctx: runtime.contextTokens,
            ...(runtime.cpuThreads === 'auto' ? {} : { n_threads: runtime.cpuThreads }),
            n_gpu_layers: 999, n_parallel: runtime.parallel, kv_unified: true, cont_batching: true,
            // Avoid idle-slot state copies/readbacks stalling global decoding during refill.
            // Live KV stays shared; prompt reuse is a separate user option.
            cache_idle_slots: false,
            n_batch: runtime.batch, n_ubatch: runtime.microBatch, ...translationLoadOptions(modelInfo.translationProfile), warmup: runtime.warmup,
            // Pinned native API: true selects AUTO; strict On requires completed FA work below.
            flash_attn: runtime.flashAttention !== 'off',
            // Omit shared reasoning/template defaults so SC Auto can retain model behavior.
            // Normal, manual and warmup requests explicitly disable template thinking.
          });
          const context = engine.getLoadedContextInfo() as ReturnType<Wllama['getLoadedContextInfo']> & { success?: boolean };
          if (context.success === false || !(context.n_vocab > 0) || !(context.n_layer > 0) || context.metadata['general.architecture'] !== modelInfo.architecture) throw new Error(loadFailure ?? 'LOCAL_MODEL_LOAD_REJECTED');
          if (Number.isFinite(context.n_ctx_train) && context.n_ctx_train > 0 && runtime.contextTokens > context.n_ctx_train) warnings.push('LOCAL_CONTEXT_ABOVE_TRAINING_LIMIT');
          verifyGpuOffload(gpu);
          if (failed) throw new Error('LOCAL_GPU_DEVICE_FAILED');
          runtime = { ...runtime, contextTokens: context.n_ctx, cpuThreadsActual: engine.getNumThreads() };
          const warmStarted = performance.now();
          // Strict On still needs a completed capability probe when general warmup is disabled.
          const verifyAttention = runtime.flashAttention === 'on';
          if (runtime.warmup || verifyAttention) {
            self.postMessage({ id, stage: 'warming' });
            const warmup = localGenerationOptions(runtime, { strategy: 'normal', max_tokens: 1, cache_prompt: false }, modelInfo);
            if (modelInfo.translationProfile) {
              const { chat_template_kwargs: _, ...options } = warmup.options;
              await engine.createCompletion({ ...options, ...translationRawOptions(modelInfo.translationProfile, [{ role: 'user',
                content: translationPrompt(modelInfo.translationProfile, 'ja', 'zh-Hans', 'こんにちは') }]), stream: false });
            } else {
              await engine.createChatCompletion({ messages: [{ role: 'user', content: 'Translate to Chinese: こんにちは' }],
                ...warmup.options, stream: false, cache_prompt: false });
            }
          }
          if (failed) throw new Error('LOCAL_GPU_DEVICE_FAILED');
          // Only completed GPU work turns an encoded known FA dispatch into execution evidence.
          if ((runtime.warmup || verifyAttention) && gpu.flashAttentionObserved) gpu.flashAttention = true;
          if (runtime.flashAttention === 'on' && gpu.flashAttention !== true) throw new Error('LOCAL_FLASH_ATTENTION_UNAVAILABLE');
          const warmupMs = runtime.warmup ? performance.now() - warmStarted : 0;
          native.active.clear(); native.peakActive = 0;
          ready = true; loading = false;
          self.postMessage({ id, ok: true, model: modelInfo, gpu, requested, runtime, fallbackReasons, warnings,
            nativeSlots: native.slots.size, nativeEvidence: native.evidence, warmupMs });
          return;
        } catch (error) {
          lastError = loadFailure ? new Error(loadFailure) : error;
          // Await native shutdown before constructing another model instance.
          const reason = inferenceError(lastError);
          try { await engine?.exit(); }
          catch { engine = undefined; throw new Error('LOCAL_WORKER_SHUTDOWN_FAILED'); }
          finally { engine = undefined; }
          fallbackReasons.push(reason);
          if (reason === 'LOCAL_MODEL_LOAD_REJECTED' || reason === 'LOCAL_NATIVE_UNSUPPORTED' || reason === 'LOCAL_CHAT_TEMPLATE_UNSUPPORTED') break;
        }
      }
      throw lastError;
    }
    if (action === 'validate-source') {
      const activeModel = loadedModel;
      if (!ready || loading || !activeModel || activeModel.id !== modelId) throw new Error('LOCAL_MODEL_NOT_LOADED');
      const current = await resolveModelFilesWithProgress(id, modelId);
      if (current.info.id !== activeModel.id) throw new Error('LOCAL_SOURCE_CHANGED');
      self.postMessage({ id, ok: true });
      return;
    }
    if (action === 'gpu-flush') {
      if (!ready || loading || running.size) throw new Error('LOCAL_GPU_TIMING_BUSY');
      if (!runtime.measureGpu || typeof (self as any).__DANLINGO_GPU_FLUSH__ !== 'function') throw new Error('LOCAL_GPU_TIMING_UNAVAILABLE');
      const metrics = await (self as any).__DANLINGO_GPU_FLUSH__();
      Object.assign(gpu, metrics);
      self.postMessage({ id, ok: true, gpu });
      return;
    }
    if (action === 'complete') {
      if (!ready || !engine?.isModelLoaded()) throw new Error('LOCAL_MODEL_NOT_LOADED');
      if (!gpu.verified || failed) throw new Error('LOCAL_GPU_OFFLOAD_UNVERIFIED');
      if (running.size >= runtime.parallel) throw new Error('LOCAL_CAPACITY_EXCEEDED');
      const abort = new AbortController(); running.set(id, abort);
      const started = performance.now();
      try {
        const generation = localGenerationOptions(runtime, body, loadedModel);
        const { reasoning, maxTokens } = generation;
        const options = { ...generation.options, messages: body.messages, stream: false as const, abortSignal: abort.signal };
        let observed: any;
        if (body.tokenizeText === undefined) {
          const collector = localCompletionCollector(active => {
            if (active) {
              if (!nativeGenerating.has(id)) {
                nativeGenerating.add(id); nativeGenerationPeak = Math.max(nativeGenerationPeak, nativeGenerating.size);
                native.evidence.push('native_stream_first_token active=' + nativeGenerating.size);
              }
            } else {
              nativeGenerating.delete(id); native.evidence.push('native_stream_finished active=' + nativeGenerating.size);
            }
            if (native.evidence.length > 256) native.evidence.splice(0, native.evidence.length - 256);
            telemetry();
          });
          // Drain native token events for progress evidence. Partial text stays in
          // this worker until completion, cancellation and language checks pass.
          // llama.cpp accepts stream_options; the pinned wllama type omits it.
          const streamOptions = { ...options, stream: true as const, stream_options: { include_usage: true }, onData: collector.onData };
          if (loadedModel?.translationProfile) {
            const { messages, chat_template_kwargs: _, ...rawOptions } = streamOptions;
            await engine.createCompletion({ ...rawOptions, ...translationRawOptions(loadedModel.translationProfile, messages) });
          } else await engine.createChatCompletion(streamOptions);
          observed = collector.result();
        }
        const result: any = observed ?? (body.tokenizeText !== undefined
          ? await engine.createCompletion({ prompt: String(body.tokenizeText), max_tokens: 1, temperature: 0, cache_prompt: false, abortSignal: abort.signal } as any)
          : await engine.createChatCompletion(options));
        if (abort.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const timings = result.timings;
        const metrics: LocalInferenceMetrics = { queueMs: 0, inferenceMs: performance.now() - started,
          promptTokens: numeric(result.usage?.prompt_tokens), outputTokens: numeric(result.usage?.completion_tokens),
          cachedTokens: numeric(result.usage?.prompt_tokens_details?.cached_tokens),
          promptMs: numeric(timings?.prompt_ms), decodeMs: numeric(timings?.predicted_ms),
          gpuExecutionMs: null, gpuAllocatedBytes: gpu.allocatedBytes, gpuPeakAllocatedBytes: gpu.peakAllocatedBytes,
          finishReason: result.choices?.[0]?.finish_reason, reasoning, maxTokens };
        self.postMessage({ id, ok: true, result: { ...result, ...(body.tokenizeText !== undefined ? { tokens: numeric(result.usage?.prompt_tokens) } : {}), danlingo_local: metrics } });
      } finally { running.delete(id); nativeGenerating.delete(id); telemetry(); }
    }
  } catch (error) {
    if (action === 'load') loading = false;
    self.postMessage({ id, ok: false, error: inferenceError(error) });
  }
};
