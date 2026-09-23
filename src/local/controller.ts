import { LOCAL_BACKEND } from './types.ts';
import type { LocalState, LocalModelInfo, LocalPerformanceConfig, LocalInferenceMetrics } from './types.ts';
import { LOCAL_NATIVE_MAX_INTEGER, normalizeLocalConfig, resolveLocalConfig } from './config.ts';

interface WorkerLike { postMessage(message: unknown): void; terminate(): void; onmessage: ((event: MessageEvent) => void) | null; onerror: ((event: ErrorEvent) => void) | null }
interface Pending { resolve: (value: any) => void; reject: (error: Error) => void }
interface Request extends Pending { id: string; body: unknown; strategy: 'normal' | 'superchat' | 'manual'; benchmark: boolean; enqueuedAt: number; queueMs: number; cancelled: boolean }
const initialState = (generation: number): LocalState => ({ phase: 'idle', backend: LOCAL_BACKEND, generation, queued: 0, active: 0, completed: 0, failed: 0, cancelled: 0, peakActive: 0, inferenceCalls: 0, contextTokens: 2048, verifiedTranslation: false });
/** One controller in one offscreen document; settings and video tabs share its native slots. */
export class LocalController {
  private worker?: WorkerLike;
  private pending = new Map<string, Pending>();
  private queue: Request[] = [];
  private active = new Map<string, Request>();
  private loadPromise?: Promise<LocalState>;
  private identity?: string;
  private requestSequence = 0;
  private state = initialState(0);
  private createWorker: () => WorkerLike;
  private now: () => number;
  constructor(createWorker: () => WorkerLike, now = () => performance.now()) { this.createWorker = createWorker; this.now = now; }
  snapshot(): LocalState { return structuredClone(this.state); }
  private reset(error: string): void {
    this.state.generation++;
    this.worker?.terminate(); this.worker = undefined;
    for (const pending of this.pending.values()) pending.reject(new Error(error));
    for (const request of [...this.queue, ...this.active.values()]) request.reject(new Error(error));
    this.pending.clear(); this.queue = []; this.active.clear();
    this.identity = undefined; this.loadPromise = undefined;
    this.state.verificationProgress = undefined;
  }
  unload(): LocalState {
    this.reset('LOCAL_MODEL_CHANGED'); this.state = initialState(this.state.generation);
    return this.snapshot();
  }
  private fatal(error: string): void {
    this.state.cancelled += [...this.active.values()].filter(request => request.cancelled).length;
    this.state.failed += this.queue.length + [...this.active.values()].filter(request => !request.cancelled).length;
    this.reset(error);
    this.state.active = 0; this.state.queued = 0; this.state.phase = 'error'; this.state.error = error;
    this.state.stage = undefined;
  }
  async load(modelId: string, config?: Partial<LocalPerformanceConfig>, options: { validateSourceOnReuse?: boolean } = {}): Promise<LocalState> {
    const requested = normalizeLocalConfig(config);
    const resolved = resolveLocalConfig(requested, modelId);
    const identity = JSON.stringify([modelId, requested]);
    if (this.identity === identity && ['ready', 'generating'].includes(this.state.phase)) {
      if (options.validateSourceOnReuse) await this.validateSource(modelId);
      return this.snapshot();
    }
    if (this.identity === identity && this.loadPromise) return this.loadPromise;
    this.unload(); this.identity = identity;
    const generation = this.state.generation;
    this.state.phase = 'loading'; this.state.stage = 'reading-file'; this.state.requested = requested;
    this.state.model = { id: modelId } as LocalModelInfo;
    const started = this.now();
    let worker: WorkerLike;
    try { worker = this.createWorker(); this.worker = worker; }
    catch (error) { this.state.phase = 'error'; this.state.error = 'LOCAL_WORKER_FAILED'; throw error; }
    worker.onmessage = event => {
      if (generation !== this.state.generation) return;
      const data = event.data;
      if (data.fatal) {
        this.fatal(/^LOCAL_[A-Z0-9_]+$/.test(data.error || '') ? data.error : 'LOCAL_GPU_DEVICE_FAILED'); return;
      }
      if (data.telemetry) {
        if (data.telemetry.gpu) this.state.gpu = { ...this.state.gpu, ...data.telemetry.gpu };
        if (typeof data.telemetry.nativeSlots === 'number') this.state.nativeSlots = data.telemetry.nativeSlots;
        if (typeof data.telemetry.nativePeakActive === 'number') this.state.nativePeakActive = data.telemetry.nativePeakActive;
        if (Array.isArray(data.telemetry.nativeEvidence)) this.state.nativeEvidence = data.telemetry.nativeEvidence;
        return;
      }
      if (data.stage) {
        this.state.stage = data.stage;
        const progress = data.verificationProgress;
        if (progress && Number.isSafeInteger(progress.bytesProcessed) && Number.isSafeInteger(progress.totalBytes)
          && progress.bytesProcessed >= 0 && progress.totalBytes >= progress.bytesProcessed) {
          this.state.verificationProgress = { bytesProcessed: progress.bytesProcessed, totalBytes: progress.totalBytes };
        } else if (data.stage !== 'fingerprinting') this.state.verificationProgress = undefined;
        if (data.stage === 'warming') this.state.phase = 'warming';
        if (data.model) this.state.model = data.model; return;
      }
      const request = this.active.get(data.id);
      if (request) { this.settle(request, data); return; }
      const pending = this.pending.get(data.id); if (!pending) return;
      this.pending.delete(data.id);
      if (data.ok) pending.resolve(data); else pending.reject(new Error(data.error || 'LOCAL_INFERENCE_FAILED'));
    };
    worker.onerror = () => { if (generation === this.state.generation) this.fatal('LOCAL_WORKER_FAILED'); };
    const loading = (async () => {
      try {
        const response = await this.rpc({ action: 'load', modelId, config: requested }, 300_000, 'LOCAL_LOAD_TIMEOUT');
        if (generation !== this.state.generation) throw new Error('LOCAL_MODEL_CHANGED');
        const runtime = response.runtime ?? resolved;
        if (!Number.isSafeInteger(runtime.parallel) || runtime.parallel < 1 || runtime.parallel > LOCAL_NATIVE_MAX_INTEGER) throw new Error('LOCAL_CONFIG_INVALID');
        this.state.model = response.model; this.state.gpu = response.gpu; this.state.runtime = runtime;
        this.state.requested = response.requested ?? requested; this.state.fallbackReasons = response.fallbackReasons ?? [];
        this.state.warnings = response.warnings ?? [];
        this.state.contextTokens = runtime.contextTokens; this.state.nativeSlots = response.nativeSlots;
        this.state.nativePeakActive = response.nativePeakActive ?? this.state.nativePeakActive; this.state.nativeEvidence = response.nativeEvidence ?? this.state.nativeEvidence;
        this.state.warmupMs = response.warmupMs; this.state.phase = 'ready'; this.state.stage = 'loaded'; this.state.verificationProgress = undefined; this.state.loadMs = this.now() - started;
        return this.snapshot();
      } catch (error) {
        if (generation === this.state.generation) { this.worker?.terminate(); this.worker = undefined; this.state.phase = 'error'; this.state.error = error instanceof Error ? error.message : 'LOCAL_LOAD_FAILED'; this.state.verificationProgress = undefined; this.state.stage = undefined; }
        throw error;
      } finally { if (generation === this.state.generation) this.loadPromise = undefined; }
    })();
    this.loadPromise = loading; return loading;
  }
  /** Recheck a source in the inference worker when a manual load reuses this runtime. */
  async validateSource(modelId: string): Promise<void> {
    if (!this.worker || this.state.model?.id !== modelId || !['ready', 'generating'].includes(this.state.phase)) {
      throw new Error('LOCAL_MODEL_NOT_LOADED');
    }
    const generation = this.state.generation;
    const previousStage = this.state.stage;
    this.state.stage = 'fingerprinting'; this.state.verificationProgress = undefined;
    try {
      await this.rpc({ action: 'validate-source', modelId }, 300_000, 'LOCAL_LOAD_TIMEOUT');
      if (generation !== this.state.generation) throw new Error('LOCAL_MODEL_CHANGED');
    } finally {
      if (generation === this.state.generation) { this.state.stage = previousStage; this.state.verificationProgress = undefined; }
    }
  }
  /** Diagnostics only, at an idle benchmark boundary; never waits inside complete(). */
  async flushGpuTiming(): Promise<LocalState> {
    if (this.state.phase !== 'ready' || this.active.size || this.queue.length) throw new Error('LOCAL_GPU_TIMING_BUSY');
    if (!this.state.runtime?.measureGpu) throw new Error('LOCAL_GPU_TIMING_UNAVAILABLE');
    const generation = this.state.generation;
    const response = await this.rpc({ action: 'gpu-flush' }, 6000);
    if (generation !== this.state.generation) throw new Error('LOCAL_MODEL_CHANGED');
    if (response.gpu) this.state.gpu = { ...this.state.gpu, ...response.gpu };
    return this.snapshot();
  }
  abort(id: string): void {
    const index = this.queue.findIndex(request => request.id === id);
    if (index >= 0) {
      const [request] = this.queue.splice(index, 1); this.state.queued = this.queue.length;
      this.state.cancelled++; request!.reject(new Error('LOCAL_CANCELLED')); this.drain(); return;
    }
    const request = this.active.get(id);
    if (!request || request.cancelled) return;
    request.cancelled = true;
    try { this.worker?.postMessage({ action: 'abort', id }); }
    catch { this.fatal('LOCAL_WORKER_FAILED'); }
  }
  async complete(id: string, modelId: string, body: unknown): Promise<unknown> {
    if (!this.worker || this.state.model?.id !== modelId || !['ready', 'generating'].includes(this.state.phase)) throw new Error('LOCAL_MODEL_NOT_LOADED');
    if (this.queue.length + this.active.size >= 128) throw new Error('LOCAL_QUEUE_FULL');
    if (this.active.has(id) || this.pending.has(id) || this.queue.some(request => request.id === id)) throw new Error('LOCAL_DUPLICATE_REQUEST_ID');
    const strategy = (body as { strategy?: unknown } | null)?.strategy;
    return new Promise((resolve, reject) => {
      this.queue.push({ id, body, resolve, reject, strategy: strategy === 'superchat' || strategy === 'manual' ? strategy : 'normal', benchmark: (body as any)?.benchmark === true, enqueuedAt: this.now(), queueMs: 0, cancelled: false });
      this.state.queued = this.queue.length; this.drain();
    });
  }
  private drain(): void {
    const capacity = this.state.runtime?.parallel ?? 0;
    if (!this.worker || !['ready', 'generating'].includes(this.state.phase)) return;
    if (capacity === 1 && this.queue.some(request => request.strategy === 'normal' && !request.benchmark)) {
      const sc = [...this.active.values()].find(request => request.strategy === 'superchat');
      if (sc) this.abort(sc.id);
    }
    while (this.worker && this.active.size < capacity && this.queue.length) {
      const normal = this.queue.findIndex(request => request.strategy === 'normal');
      const nonNormalActive = [...this.active.values()].filter(request => request.strategy !== 'normal').length;
      if (normal < 0 && !this.queue[0]?.benchmark && capacity > 1 && nonNormalActive >= capacity - 1) break;
      const [request] = this.queue.splice(normal < 0 ? 0 : normal, 1);
      request!.queueMs = Math.max(0, this.now() - request!.enqueuedAt);
      this.active.set(request!.id, request!); this.state.queued = this.queue.length;
      this.state.active = this.active.size; this.state.peakActive = Math.max(this.state.peakActive, this.active.size);
      this.state.phase = 'generating'; this.state.inferenceCalls++;
      try { this.worker.postMessage({ action: 'complete', id: request!.id, body: request!.body }); }
      catch { this.fatal('LOCAL_WORKER_FAILED'); return; }
    }
  }
  private settle(request: Request, response: any): void {
    this.active.delete(request.id); this.state.active = this.active.size;
    const metrics = response.result?.danlingo_local as LocalInferenceMetrics | undefined;
    if (metrics) { metrics.queueMs = request.queueMs; this.state.lastMetrics = structuredClone(metrics); }
    if (request.cancelled) { this.state.cancelled++; request.reject(new Error('LOCAL_CANCELLED')); }
    else if (!response.ok) { this.state.failed++; request.reject(new Error(response.error || 'LOCAL_INFERENCE_FAILED')); }
    else { this.state.completed++; request.resolve(response.result); }
    this.state.phase = this.active.size ? 'generating' : 'ready'; this.drain();
  }
  private rpc(message: Record<string, unknown>, timeoutMs?: number, timeoutError = 'LOCAL_GPU_TIMING_TIMEOUT'): Promise<any> {
    const id = `control-${++this.requestSequence}`;
    return new Promise((resolve, reject) => {
      if (!this.worker) { reject(new Error('LOCAL_MODEL_NOT_LOADED')); return; }
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        this.pending.delete(id); reject(new Error(timeoutError));
      }, timeoutMs);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); } });
      try { this.worker.postMessage({ ...message, id }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error instanceof Error ? error : new Error('LOCAL_WORKER_FAILED')); }
    });
  }
}
