import { DEFAULT_SETTINGS } from '../core/config.ts';
import { buildProviderPayload, parseLocalProviderResult } from '../translation/provider.ts';
import { withLocalRuntime } from './provider-settings.ts';
import { aggregateLocalBenchmark, LOCAL_BENCHMARK_CORPUS, LOCAL_CHINESE_BENCHMARK_CORPUS, LOCAL_BENCHMARK_PARALLELS, recommendLocalBenchmark } from './benchmark.ts';
import type { LocalBenchmarkSample, LocalBenchmarkStats, LocalBenchmarkWorkload, LocalBenchmarkRecommendation } from './benchmark.ts';
import { normalizeLocalConfig, resolveLocalConfig, LOCAL_NATIVE_MAX_INTEGER } from './config.ts';
import type { LocalController } from './controller.ts';
import { localError } from './types.ts';
import type { LocalInferenceMetrics, LocalPerformanceConfig, LocalState } from './types.ts';

export interface LocalBenchmarkOptions {
  sourceLanguage?: string; targetLanguage?: string;
  parallels?: number[]; workloads?: LocalBenchmarkWorkload[]; count?: number;
  applicationConcurrency?: number; baseConfig?: Partial<LocalPerformanceConfig>;
  variants?: Array<{ name: string; config: Partial<LocalPerformanceConfig> }>;
  validateCorpus?: boolean;
  /** Capacity-test budget, including application/native queueing; not a realtime deadline. */
  requestTimeoutMs?: number;
}
export interface LocalBenchmarkRequestSample extends LocalBenchmarkSample {
  corpusId: string; source: string; output?: string; rawOutput?: string;
  applicationQueueMs?: number;
  protocolSuccess: boolean; quality: 'needs-review'; finishReason?: string;
}
export interface LocalBenchmarkGpuObservation {
  sampledComputeMs: number | null;
  /** Aggregate for the entire group, never attributed to individual requests. */
  completeComputeMs: number | null;
  scope: 'group-compute-passes';
  boundariesFlushed: boolean; flushError?: string;
  timedComputePasses: number | null; missedComputePasses: number | null; timingReadFailures: number | null;
  computePassCoverage: number | null;
  pendingTimingRecordsBefore: number | null; pendingTimingRecordsAfter: number | null;
  allocatedBufferBytesBefore: number | null; allocatedBufferBytesAfter: number | null;
  lifetimePeakAllocatedBufferBytes: number | null;
  nativePeakActiveBefore: number | null; nativePeakActiveAfter: number | null;
  caveat: string;
}
export interface LocalBenchmarkGroup {
  variantId: string; name: string; workload: LocalBenchmarkWorkload; config: LocalPerformanceConfig;
  status: 'running' | 'completed' | 'cancelled' | 'failed' | 'runtime-mismatch';
  expected: number; completed: number; samples: LocalBenchmarkRequestSample[];
  stats: LocalBenchmarkStats; nativeBefore?: LocalState; nativeAfter?: LocalState;
  runtime?: LocalState['runtime']; fallbackReasons?: string[]; error?: string;
  gpuObservation?: LocalBenchmarkGpuObservation;
}
export interface LocalBenchmarkReport {
  id: string; modelId: string; startedAt: number; finishedAt?: number;
  status: 'running' | 'stopping' | 'completed' | 'cancelled' | 'failed';
  phase: 'loading' | 'preflight' | 'warmup' | 'measuring' | 'restoring' | 'done';
  options: LocalBenchmarkOptions; groups: LocalBenchmarkGroup[];
  corpusTokens: Array<{ id: string; tokens: number | null; error?: string }>;
  model?: LocalState['model']; gpu?: LocalState['gpu'];
  recommendation: LocalBenchmarkRecommendation; error?: string; restoreError?: string;
  recommendedVariant?: { variantId: string; name: string; config: LocalPerformanceConfig } | null;
  evidence: string;
}

const workloads: LocalBenchmarkWorkload[] = ['short', 'normal', 'long'];
function corpusFor(options: LocalBenchmarkOptions) {
  if (options.sourceLanguage === undefined && options.targetLanguage === undefined) return LOCAL_BENCHMARK_CORPUS;
  const source = (options.sourceLanguage ?? 'auto').split('-')[0]!, target = (options.targetLanguage ?? 'zh-Hans').split('-')[0]!;
  const selected = source === 'auto' ? target === 'ja' ? 'zh' : 'ja' : source;
  if (selected === target) throw new Error('LOCAL_BENCHMARK_SAME_LANGUAGE');
  const corpus = selected === 'zh' ? LOCAL_CHINESE_BENCHMARK_CORPUS : LOCAL_BENCHMARK_CORPUS.filter(item => item.id.includes(`-${selected}-`));
  if (!corpus.length) throw new Error('LOCAL_BENCHMARK_CORPUS_UNAVAILABLE');
  return corpus;
}
const integer = (n: number, max: number) => Number.isInteger(n) && n >= 1 && n <= max;
const measured = (n: unknown): number | undefined => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
const diagnosticFlushError = (error: unknown): string => {
  const code = localError(error);
  if (!['LOCAL_GPU_TIMING_BUSY', 'LOCAL_GPU_TIMING_TIMEOUT', 'LOCAL_GPU_TIMING_UNAVAILABLE'].includes(code)) throw error;
  return code;
};
const recommendationSampleGate = 'Automatic advice requires at least two native-slot waves per selected workload: expected requests >= 2 × resolved parallel, with all expected requests completed. Smaller runs retain measurements but are excluded from recommendations.';
// Missing controller queue observations must not become the shorter application wait.
const summarize = (samples: LocalBenchmarkRequestSample[]) => aggregateLocalBenchmark(samples.map(sample => ({ ...sample,
  startedAt: sample.queueMs === undefined ? undefined : sample.startedAt })));
function gpuObservation(before: LocalState, after: LocalState, boundariesFlushed = false, flushError?: string): LocalBenchmarkGpuObservation {
  const delta = (key: 'executionMs' | 'timedComputePasses' | 'missedComputePasses' | 'timingReadFailures') => {
    const start = measured(before.gpu?.[key]), end = measured(after.gpu?.[key]);
    return before.generation === after.generation && start !== undefined && end !== undefined && end >= start ? end - start : null;
  };
  const timedComputePasses = delta('timedComputePasses'), missedComputePasses = delta('missedComputePasses');
  const sampledComputeMs = delta('executionMs'), timingReadFailures = delta('timingReadFailures');
  const complete = boundariesFlushed && before.gpu?.timestampQueries === true && after.gpu?.timestampQueries === true
    && timedComputePasses !== null && timedComputePasses > 0 && missedComputePasses === 0 && timingReadFailures === 0
    && before.gpu?.pendingTimingRecords === 0 && after.gpu?.pendingTimingRecords === 0;
  return { sampledComputeMs, completeComputeMs: complete ? sampledComputeMs : null, scope: 'group-compute-passes', boundariesFlushed,
    ...(flushError ? { flushError } : {}), timedComputePasses, missedComputePasses, timingReadFailures,
    computePassCoverage: timedComputePasses !== null && missedComputePasses !== null && timedComputePasses + missedComputePasses > 0
      ? timedComputePasses / (timedComputePasses + missedComputePasses) : null,
    pendingTimingRecordsBefore: measured(before.gpu?.pendingTimingRecords) ?? null,
    pendingTimingRecordsAfter: measured(after.gpu?.pendingTimingRecords) ?? null,
    allocatedBufferBytesBefore: measured(before.gpu?.allocatedBytes) ?? null, allocatedBufferBytesAfter: measured(after.gpu?.allocatedBytes) ?? null,
    lifetimePeakAllocatedBufferBytes: measured(after.gpu?.peakAllocatedBytes) ?? null,
    nativePeakActiveBefore: measured(before.nativePeakActive) ?? null, nativePeakActiveAfter: measured(after.nativePeakActive) ?? null,
    caveat: 'Compute-pass timestamp sums, not total GPU time: transfers and other GPU work are excluded. completeComputeMs is a group aggregate only when both idle boundaries were flushed, all compute passes were measured, and no read failed or remains pending. Otherwise sampled deltas can cross workload boundaries. Tracked buffer allocation is not physical VRAM use. Native and allocation peaks are lifetime values and may include earlier workloads or warmup.' };
}

/** Owns the controller through cleanup. Explicit Stop invalidates its benchmark worker. */
export class LocalBenchmarkRunner {
  private controller: LocalController;
  private report: LocalBenchmarkReport | null = null;
  private running?: Promise<void>;
  private cancelled = false;
  private active = new Set<string>();
  private sequence = 0;
  constructor(controller: LocalController) { this.controller = controller; }
  snapshot(): LocalBenchmarkReport | null { return structuredClone(this.report); }
  isRunning(): boolean { return this.running !== undefined; }
  /** Resolves only after inference cleanup and restoration of the previous model. */
  settled(): Promise<void> { return this.running ?? Promise.resolve(); }
  start(modelId: string, options: LocalBenchmarkOptions = {}): LocalBenchmarkReport {
    if (this.running) throw new Error('LOCAL_BENCHMARK_BUSY');
    const previous = this.controller.snapshot();
    if (previous.active || previous.queued || ['loading', 'warming', 'generating'].includes(previous.phase)) throw new Error('LOCAL_BENCHMARK_BUSY');
    if (typeof modelId !== 'string' || !modelId.trim()) throw new Error('LOCAL_MODEL_NOT_FOUND');
    for (const [key, value] of [['source', options.sourceLanguage], ['target', options.targetLanguage]])
      if (value !== undefined && (typeof value !== 'string' || !(key === 'source' && value === 'auto') && !/^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(value))) throw new Error('LOCAL_BENCHMARK_CONFIG_INVALID');
    corpusFor(options);
    const count = options.count ?? 32, concurrency = options.applicationConcurrency ?? 32;
    const requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    const selected = options.workloads ?? workloads;
    const parallels = options.parallels ?? [...LOCAL_BENCHMARK_PARALLELS];
    if (!integer(requestTimeoutMs, 600_000) || !integer(count, 256) || !integer(concurrency, LOCAL_NATIVE_MAX_INTEGER) || !Array.isArray(selected) || !selected.length
      || selected.length > 3 || new Set(selected).size !== selected.length || selected.some(w => !workloads.includes(w))
      || !Array.isArray(parallels) || !parallels.length || parallels.length > 32 || parallels.some(p => !integer(p, LOCAL_NATIVE_MAX_INTEGER))
      || (options.validateCorpus !== undefined && typeof options.validateCorpus !== 'boolean')) throw new Error('LOCAL_BENCHMARK_CONFIG_INVALID');
    const variants = options.variants ?? parallels.map(parallel => ({ name: `parallel-${parallel}`, config: { mode: 'custom' as const, parallel } }));
    if (!Array.isArray(variants) || !variants.length || variants.length > 32) throw new Error('LOCAL_BENCHMARK_CONFIG_INVALID');
    const configs = variants.map((v, index) => {
      if (!v || typeof v.name !== 'string' || !v.name.trim() || v.name.length > 80) throw new Error('LOCAL_BENCHMARK_CONFIG_INVALID');
      const config = normalizeLocalConfig({ ...options.baseConfig, ...v.config });
      resolveLocalConfig(config, modelId);
      return { variantId: `variant-${index}`, name: v.name, config };
    });
    this.cancelled = false;
    this.report = { id: `benchmark-${Date.now()}-${++this.sequence}`, modelId, startedAt: Date.now(), status: 'running', phase: 'loading',
      options: structuredClone({ ...options, count, applicationConcurrency: concurrency, workloads: selected, requestTimeoutMs }), groups: [], corpusTokens: [],
      recommendation: recommendLocalBenchmark([]), recommendedVariant: null,
      evidence: 'Capacity benchmark with configurable request budget including application and native queueing; this is not realtime deadline acceptance. Local authored corpus; production prompt, format and enabled basic-language checks. Translation meaning requires review. Native peaks are lifetime snapshots, not reset per workload. GPU timestamp deltas cover sampled compute passes only, not total GPU execution time; allocation counts are tracked buffers, not physical VRAM usage. ' + recommendationSampleGate };
    this.report.recommendation.algorithm += ' ' + recommendationSampleGate;
    this.running = this.run(modelId, configs, selected, count, concurrency, previous, options.validateCorpus === true)
      .finally(() => { this.running = undefined; });
    return this.snapshot()!;
  }
  async stop(): Promise<LocalBenchmarkReport | null> {
    if (this.running) {
      this.cancelled = true;
      if (this.report) this.report.status = 'stopping';
      // Stop is an explicit whole-benchmark action, including pending model loads.
      // Ordinary request deadlines still use cooperative abort in request().
      if (this.report && !['restoring', 'done'].includes(this.report.phase)) this.controller.unload();
      await this.running;
    }
    return this.snapshot();
  }
  private async request(modelId: string, body: Record<string, unknown>, admittedAt = performance.now()): Promise<unknown> {
    if (this.cancelled) throw new Error('LOCAL_CANCELLED');
    const remaining = this.report!.options.requestTimeoutMs! - (performance.now() - admittedAt);
    if (remaining <= 0) throw new Error('LOCAL_BENCHMARK_TIMEOUT');
    const id = `${this.report!.id}-${++this.sequence}`;
    this.active.add(id);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; this.controller.abort(id); }, remaining);
    try {
      const result = await this.controller.complete(id, modelId, body);
      if (timedOut) throw new Error('LOCAL_BENCHMARK_TIMEOUT');
      return result;
    } catch (error) { throw timedOut ? new Error('LOCAL_BENCHMARK_TIMEOUT') : error; }
    finally { clearTimeout(timer); this.active.delete(id); }
  }
  private body(modelId: string, text: string, workload: LocalBenchmarkWorkload): Record<string, unknown> {
    const strategy = workload === 'long' ? 'superchat' : 'normal';
    return { ...buildProviderPayload(this.settings(modelId),
      [{ id: '0', text }], 'deadline', strategy), strategy, stream: false, benchmark: true, cache_prompt: false };
  }
  private settings(modelId: string) {
    return withLocalRuntime({ ...DEFAULT_SETTINGS, backend: 'local' as const, model: modelId, localModelId: modelId,
      sourceLanguage: this.report?.options.sourceLanguage ?? 'auto', targetLanguage: this.report?.options.targetLanguage ?? DEFAULT_SETTINGS.targetLanguage,
      localPerformance: this.controller.snapshot().requested }, this.controller.snapshot());
  }
  private async run(modelId: string, variants: Array<{ variantId: string; name: string; config: LocalPerformanceConfig }>, selected: LocalBenchmarkWorkload[],
    count: number, concurrency: number, previous: LocalState, validate: boolean): Promise<void> {
    const report = this.report!;
    let finalStatus: 'completed' | 'cancelled' | 'failed' = 'completed';
    try {
      for (const variant of variants) {
        if (this.cancelled) break;
        report.phase = 'loading';
        let state: LocalState;
        try { state = await this.controller.load(modelId, variant.config, { validateSourceOnReuse: true }); }
        catch (error) {
          for (const workload of selected) report.groups.push({ ...variant, workload, status: 'failed', expected: count, completed: 0,
            samples: [], stats: aggregateLocalBenchmark([]), error: localError(error) });
          continue;
        }
        report.model = state.model; report.gpu = state.gpu;
        if (this.cancelled) break;
        if (validate && !report.corpusTokens.length) {
          report.phase = 'preflight';
          for (const item of corpusFor(report.options).filter(item => selected.includes(item.workload))) {
            if (this.cancelled) break;
            try {
              // A raw one-token completion is a tokenizer surrogate. Empty/EOG
              // completion failures do not establish that authored source is invalid.
              const result = await this.request(modelId, { tokenizeText: item.text, benchmark: true, strategy: 'normal' }) as { tokens?: number; tokenCount?: number };
              const tokens = measured(result.tokens) ?? measured(result.tokenCount);
              report.corpusTokens.push({ id: item.id, tokens: tokens !== undefined && Number.isSafeInteger(tokens) ? tokens : null,
                ...(tokens === undefined || !Number.isSafeInteger(tokens) ? { error: 'LOCAL_TOKEN_COUNT_UNAVAILABLE' } : {}) });
            } catch (error) {
              const code = localError(error), current = this.controller.snapshot();
              report.corpusTokens.push({ id: item.id, tokens: null, error: code });
              if (this.cancelled || code === 'LOCAL_CANCELLED' || current.model?.id !== modelId
                || !['ready', 'generating'].includes(current.phase)) throw error;
            }
          }
        }
        for (const workload of selected) {
          if (this.cancelled) break;
          const group: LocalBenchmarkGroup = { ...variant, workload, status: 'running', expected: count, completed: 0, samples: [],
            stats: aggregateLocalBenchmark([]), runtime: state.runtime, fallbackReasons: state.fallbackReasons };
          report.groups.push(group);
          try {
            const corpus = corpusFor(report.options).filter(item => item.workload === workload);
            report.phase = 'warmup';
            await this.request(modelId, this.body(modelId, corpus[0]!.text, workload));
            if (this.cancelled) { group.status = 'cancelled'; break; }
            let beforeFlushed = false, afterFlushed = false, flushError: string | undefined;
            if (variant.config.measureGpu) {
              try { await this.controller.flushGpuTiming(); beforeFlushed = true; }
              catch (error) { flushError = diagnosticFlushError(error); }
            }
            if (this.cancelled) { group.status = 'cancelled'; break; }
            group.nativeBefore = this.controller.snapshot();
            if (group.nativeBefore.phase !== 'ready' || group.nativeBefore.model?.id !== modelId
              || group.nativeBefore.generation !== state.generation) throw new Error(group.nativeBefore.error ?? 'LOCAL_MODEL_CHANGED');
            report.phase = 'measuring';
            const admittedAt = performance.now();
            let next = 0;
            const worker = async () => {
              while (next < count) {
                const index = next++;
                // Spread smaller samples over both endpoints of the complete corpus;
                // larger samples visit every entry before wrapping deterministically.
                const corpusIndex = count < corpus.length && count > 1 ? Math.floor(index * (corpus.length - 1) / (count - 1)) : index % corpus.length;
                const item = corpus[corpusIndex]!;
                const startedAt = performance.now();
                const sample: LocalBenchmarkRequestSample = { id: `${group.name}-${workload}-${index}`, corpusId: item.id, source: item.text,
                  workload, admittedAt, startedAt, applicationQueueMs: Math.max(0, startedAt - admittedAt), finishedAt: startedAt,
                  status: 'cancelled', protocolSuccess: false, quality: 'needs-review' };
                if (!this.cancelled) {
                  try {
                    const raw = await this.request(modelId, this.body(modelId, item.text, workload), admittedAt) as {
                      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; danlingo_local?: LocalInferenceMetrics };
                    const choice = raw.choices?.[0], metrics = raw.danlingo_local;
                    sample.rawOutput = typeof choice?.message?.content === 'string' ? choice.message.content : undefined;
                    sample.finishReason = choice?.finish_reason ?? metrics?.finishReason;
                    const controllerQueueMs = measured(metrics?.queueMs);
                    if (controllerQueueMs !== undefined) sample.queueMs = sample.applicationQueueMs! + controllerQueueMs;
                    sample.promptMs = measured(metrics?.promptMs); sample.decodeMs = measured(metrics?.decodeMs);
                    sample.inputTokens = measured(metrics?.promptTokens); sample.outputTokens = measured(metrics?.outputTokens);
                    sample.gpuExecutionMs = measured(metrics?.gpuExecutionMs) ?? null;
                    sample.gpuAllocatedBytes = measured(metrics?.gpuAllocatedBytes);
                    const parsed = parseLocalProviderResult(raw, [{ id: '0', text: item.text }], this.settings(modelId)).items.get('0');
                    sample.protocolSuccess = !!parsed?.text && !parsed.reason;
                    if (sample.protocolSuccess) sample.output = parsed!.text;
                    sample.status = sample.protocolSuccess ? 'success' : 'failed';
                    if (!sample.protocolSuccess) sample.reason = sample.finishReason === 'length' ? 'LOCAL_BENCHMARK_TRUNCATED'
                      : parsed?.reason === 'wrong-target-language' || parsed?.reason === 'untranslated-text' ? parsed.reason : 'LOCAL_BENCHMARK_PROTOCOL_INVALID';
                  } catch (error) {
                    sample.reason = localError(error);
                    sample.status = sample.reason === 'LOCAL_BENCHMARK_TIMEOUT' ? 'timeout' : this.cancelled || sample.reason === 'LOCAL_CANCELLED' ? 'cancelled' : 'failed';
                  }
                } else sample.reason = 'LOCAL_CANCELLED';
                sample.finishedAt = performance.now(); group.samples.push(sample); group.completed++;
                group.stats = summarize(group.samples);
              }
            };
            await Promise.all(Array.from({ length: Math.min(count, concurrency) }, worker));
            if (variant.config.measureGpu && !this.cancelled) {
              try { await this.controller.flushGpuTiming(); afterFlushed = true; }
              catch (error) { flushError = diagnosticFlushError(error); }
            }
            group.nativeAfter = this.controller.snapshot();
            if (!this.cancelled && (group.nativeAfter.phase !== 'ready' || group.nativeAfter.model?.id !== modelId
              || group.nativeAfter.generation !== group.nativeBefore.generation)) throw new Error(group.nativeAfter.error ?? 'LOCAL_MODEL_CHANGED');
            group.gpuObservation = gpuObservation(group.nativeBefore, group.nativeAfter, beforeFlushed && afterFlushed, flushError);
            const expected = resolveLocalConfig(variant.config, modelId), actual = group.nativeAfter.runtime;
            const mismatch = !actual || ['parallel', 'contextTokens', 'batch', 'microBatch'].some(key => actual[key as keyof typeof actual] !== expected[key as keyof typeof expected])
              || !!group.nativeAfter.fallbackReasons?.length;
            group.status = this.cancelled ? 'cancelled' : mismatch ? 'runtime-mismatch' : 'completed';
          } catch (error) { group.status = this.cancelled ? 'cancelled' : 'failed'; group.error = localError(error); }
        }
      }
      const candidates = variants.flatMap(variant => {
        const groups = report.groups.filter(g => g.variantId === variant.variantId);
        const parallel = resolveLocalConfig(variant.config, modelId).parallel;
        if (groups.length !== selected.length || groups.some(g => g.status !== 'completed'
          || g.expected < 2 * parallel || g.completed !== g.expected || g.samples.length !== g.expected)) return [];
        // Combine measured intervals without model-load/warmup gaps between workloads.
        let offset = 0;
        const samples = groups.flatMap(g => {
          const start = Math.min(...g.samples.map(s => s.admittedAt));
          const shifted = g.samples.map(s => ({ ...s, admittedAt: s.admittedAt - start + offset, finishedAt: s.finishedAt - start + offset,
            startedAt: s.startedAt === undefined ? undefined : s.startedAt - start + offset }));
          offset += g.stats.totalDurationMs ?? 0;
          return shifted;
        });
        const stats = summarize(samples);
        return [{ variantId: variant.variantId, parallel, requestsPerSecond: stats.requestsPerSecond, p95Ms: stats.endToEndMs.p95Ms,
          meanMs: stats.endToEndMs.meanMs, meanQueueMs: stats.queueMs.meanMs, gpuAllocatedBytes: stats.gpuAllocatedBytes, successRate: stats.successRate, timeoutRate: stats.timeoutRate }];
      });
      report.recommendation = recommendLocalBenchmark(candidates);
      report.recommendation.algorithm += ' ' + recommendationSampleGate;
      const chosen = candidates.find(candidate => candidate === report.recommendation.recommended);
      const recommended = variants.find(variant => variant.variantId === chosen?.variantId);
      report.recommendedVariant = recommended ? structuredClone(recommended) : null;
      finalStatus = this.cancelled ? 'cancelled' : report.groups.some(g => g.status === 'failed') ? 'failed' : 'completed';
    } catch (error) { report.error = localError(error); finalStatus = this.cancelled ? 'cancelled' : 'failed'; }
    finally {
      report.phase = 'restoring';
      try {
        if (previous.model && previous.requested && previous.phase === 'ready') await this.controller.load(previous.model.id, previous.requested);
        else this.controller.unload();
      } catch (error) { report.restoreError = localError(error); finalStatus = 'failed'; }
      report.status = finalStatus === 'failed' ? 'failed' : this.cancelled ? 'cancelled' : finalStatus;
      report.phase = 'done'; report.finishedAt = Date.now();
    }
  }
}
