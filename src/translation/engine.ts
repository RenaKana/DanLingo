import { endpointOrigin, localGenerationProfile, normalizeReasoningEffort, providerTimeoutMs, MAX_REQUEST_TIMEOUT_MS, MAX_CONCURRENCY, MAX_LIVE_BATCH_WAIT_MS, LIVE_PROMPT_VERSION } from '../core/config.ts';
import type { Settings, TranslationInput, TranslationOutput, TranslationRequest, TranslationResponse, Usage } from '../core/types.ts';
import { MemoryTranslationCache, translationCacheKey } from './cache.ts';
import type { TranslationCache } from './cache.ts';
import { createClock } from './clock.ts';
import type { TranslationClock } from './clock.ts';
import { addUsage, ChatCompletionsProvider, ProviderError } from './provider.ts';
import type { ProviderRequest, ProviderResult } from './provider.ts';
import { protectText } from './text.ts';
import { localPromptMode, localQualityIssue, localSingleItem } from './local-policy.ts';
import type { LocalInferenceMetrics } from '../local/types.ts';
import { liveTokenEstimate, type TranslationTrace, type LiveTimingEstimate, type LiveDispatchDecision } from './telemetry.ts';

export interface TranslationEngineOptions {
  provider?: { complete(request: ProviderRequest): Promise<ProviderResult> };
  cache?: TranslationCache;
  fetch?: typeof fetch;
  keepAlive?: () => () => void;
  clock?: Partial<TranslationClock> | (() => number);
  maxConcurrency?: number;
  /** Bounds all unresolved unique tasks, including cache lookups and active requests. */
  maxQueuedItems?: number;
  maxQueuedBytes?: number;
  maxSubscribers?: number;
  maxRequestItems?: number;
  onTrace?: (event: TranslationTrace) => void;
}
export interface TranslationEngineStats {
  pendingItems: number;
  queuedItems: number;
  pendingBytes: number;
  subscribers: number;
  activeRequests: number;
  providerCalls: number;
  retries: number;
  mergedInputs: number;
  cacheHits: number;
  translated: number;
  failed: number;
  expired: number;
  original: number;
  deferred: number;
  cacheErrors: number;
  usageReports: number;
  usageUnavailableCalls: number;
  rawInputs: number;
  uniqueTasks: number;
  duplicateOutputIds: number;
  /** Rolling, text-free diagnostic tail; totals above cover the entire engine lifetime. */
  recentTrace: TranslationTrace[];
  localDiagnostics?: { queuedDeadline: number; runningDeadline: number; requestTimeout: number; qualityRejected: number; forcedCalls: number; last?: LocalInferenceMetrics };
  /** Sums only supplied fields. Missing usage stays missing, never an estimated zero. */
  usage?: Usage;
  /** Most recent provider failure, using this engine's monotonic clock; no remote error bodies. */
  lastError?: { reason: string; status?: number; at: number; retryAt?: number };
  /** Present only while the engine is observing a 429 cooldown. */
  rateLimitedUntil?: number;
}
interface ResponseContext {
  vod: boolean;
  live: boolean;
  priority: 'near' | 'buffered' | 'background';
  quotaScope?: string;
  results: TranslationOutput[];
  remaining: number;
  subscribers: Set<Subscription>;
  resolve: (response: TranslationResponse) => void;
  signal?: AbortSignal;
  abort: () => void;
  usage?: Usage;
  earliestDeadline: number;
  hasTranslation: boolean;
  deliveryTimer?: unknown;
  deliverPartial: () => void;
  onResult?: TranslationRequest['onResult'];
  occurrenceIds: number[];
}
interface Subscription {
  input: TranslationInput;
  index: number;
  context: ResponseContext;
  task: Task;
  timer?: unknown;
  done: boolean;
}
interface Task {
  id: string;
  cacheKey: string;
  resourceId: string;
  text: string;
  settings: Settings;
  apiKey: string;
  group: string;
  subscribers: Set<Subscription>;
  bytes: number;
  chars: number;
  tokenEstimate: { input: number; output: number };
  stage: 'lookup' | 'queued' | 'running' | 'saving' | 'done';
  attempts: number;
  readyAt: number;
  enqueuedAt: number;
  batch?: Batch;
  completedText?: string;
  admitted?: boolean;
  bypassCache: boolean;
  forced: boolean;
  cacheGeneration: number;
  serviceClass: 'normal' | 'superchat' | 'manual';
}
interface Batch { tasks: Task[]; controller: AbortController; concurrency: number; urgent: boolean; live: boolean;
  id: number; startedAt: number; load: number; bucket: string; contexts: Set<ResponseContext> }
interface QuotaEntry { at: number; chars: number }
const encoder = new TextEncoder();
const DAY = 86_400_000;
const MIN_RETRY_BUDGET_MS = 100;
const MAX_TIMER_MS = 2_000_000_000;
const QUOTA_WINDOW_MS = 60_000;
const QUOTA_ITEMS = 1200;
const QUOTA_CHARS = 60_000;
const CAPACITY_RETRY_MS = 1000;
function bound(value: number | undefined, fallback: number, ceiling: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(1, Math.min(ceiling, Math.floor(value))) : fallback;
}
function batchGroup(settings: Settings): string {
  return JSON.stringify([
    settings.endpoint, settings.model, settings.profile, settings.sourceLanguage, settings.targetLanguage,
    settings.allowLocalHttp, settings.requestTimeoutMs, settings.concurrency, settings.batchSize, settings.maxBatchChars,
    settings.backend === 'local' ? ['local', settings.localModelId, localPromptMode(settings), settings.localPerformance?.languageValidation, localGenerationProfile(settings), settings.localCapacity, settings.localContextTokens]
      : normalizeReasoningEffort(settings, settings.thinkingEffort),
    providerTimeoutMs(settings),
    settings.translationStream, settings.liveMaxBatchWaitMs, settings.liveMaxInputTokens, settings.liveMaxOutputTokens,
    settings.liveAdaptiveConcurrency,
  ]);
}
function validateSettings(value: Settings): void {
  endpointOrigin(value.endpoint, value.allowLocalHttp);
  if (!['minimax', 'deepseek', 'gemini', 'chat-completions'].includes(value.profile)
      || !['translated', 'original'].includes(value.displayMode)
      || typeof value.enabled !== 'boolean' || typeof value.allowLocalHttp !== 'boolean') throw new Error('invalid-settings');
  for (const name of ['endpoint', 'model', 'sourceLanguage', 'targetLanguage'] as const) {
    const text = value[name];
    if (typeof text !== 'string' || !text.trim() || text.length > (name === 'endpoint' ? 1000 : 100)) throw new Error('invalid-settings');
  }
  for (const [name, minimum, maximum] of [
    ['requestTimeoutMs', 1, MAX_REQUEST_TIMEOUT_MS], ['concurrency', 1, value.backend === 'local' ? 2_147_483_647 : MAX_CONCURRENCY], ['batchSize', 1, 200],
    ['maxBatchChars', 1, 24_000], ['urgentSeconds', 0, 120], ['cacheMaxEntries', 0, 20_000], ['cacheTtlDays', 0, 90],
  ] as const) {
    const n = value[name];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < minimum || n > maximum) throw new Error('invalid-settings');
  }
  const thinkingTimeout = value.thinkingRequestTimeoutMs;
  if (thinkingTimeout !== undefined && (typeof thinkingTimeout !== 'number' || !Number.isFinite(thinkingTimeout)
      || thinkingTimeout < 1 || thinkingTimeout > MAX_REQUEST_TIMEOUT_MS)) throw new Error('invalid-settings');
  if (![value.concurrency, value.batchSize, value.cacheMaxEntries].every(Number.isInteger)) throw new Error('invalid-settings');
  for (const [name, max] of [['liveMaxBatchWaitMs', MAX_LIVE_BATCH_WAIT_MS], ['liveMaxInputTokens', 24000], ['liveMaxOutputTokens', 24000]] as const) {
    if (value[name] !== undefined && (!Number.isInteger(value[name]) || value[name]! < (name === 'liveMaxBatchWaitMs' ? 0 : 256) || value[name]! > max)) throw new Error('invalid-settings');
  }
}

/** One shared instance per background worker supplies cross-tab coalescing and global limits. */
export class TranslationEngine {
  private localDiagnostics = { queuedDeadline: 0, runningDeadline: 0, requestTimeout: 0, qualityRejected: 0, forcedCalls: 0, last: undefined as LocalInferenceMetrics | undefined };
  readonly cache: TranslationCache;
  private readonly clock: TranslationClock;
  private readonly provider: { complete(request: ProviderRequest): Promise<ProviderResult> };
  private readonly cacheGenerations = new Map<string, number>();
  private cacheWriteTail?: Promise<void>;
  private readonly maxConcurrency: number;
  private readonly maxQueuedItems: number;
  private readonly maxQueuedBytes: number;
  private readonly maxSubscribers: number;
  private readonly maxRequestItems: number;
  private readonly tasks = new Set<Task>();
  private readonly byKey = new Map<string, Set<Task>>();
  private readonly active = new Set<Batch>();
  private readonly liveSessions = new Map<string, number>();
  private readonly quotas = new Map<string, Map<string, QuotaEntry>>();
  private pendingBytes = 0;
  private subscribers = 0;
  private sequence = 0;
  private occurrenceSequence = 0;
  private batchSequence = 0;
  private readonly traceTail: TranslationTrace[] = [];
  private readonly onTrace?: TranslationEngineOptions['onTrace'];
  private readonly timings = new Map<string, { elapsed: number; items: number; complete: boolean }[]>();
  private readonly controls = new Map<string, { limit: number; changedAt: number; blockedUntil: number }>();
  private pumpScheduled = false;
  private wakeTimer?: unknown;
  private rateLimitedUntil = 0;
  private disposed = false;
  private counts = {
    providerCalls: 0, retries: 0, mergedInputs: 0, cacheHits: 0, translated: 0, failed: 0,
    expired: 0, original: 0, deferred: 0, cacheErrors: 0, usageReports: 0, usageUnavailableCalls: 0,
    rawInputs: 0, uniqueTasks: 0, duplicateOutputIds: 0,
  };
  private usage?: Usage;
  private lastError?: TranslationEngineStats['lastError'];
  private readonly rejectedGroups = new Map<string, { apiKey: string; reason: string }>();

  constructor(options: TranslationEngineOptions = {}) {
    this.clock = createClock(options.clock);
    this.cache = options.cache ?? new MemoryTranslationCache({ now: this.clock.wallNow });
    this.provider = options.provider ?? new ChatCompletionsProvider({ fetch: options.fetch, clock: this.clock, keepAlive: options.keepAlive });
    this.maxConcurrency = bound(options.maxConcurrency, 2_147_483_647, 2_147_483_647);
    this.maxQueuedItems = bound(options.maxQueuedItems, 1000, 10_000);
    this.maxQueuedBytes = bound(options.maxQueuedBytes, 2 * 1024 * 1024, 32 * 1024 * 1024);
    this.maxSubscribers = bound(options.maxSubscribers, 4000, 40_000);
    this.maxRequestItems = bound(options.maxRequestItems, 1000, 10_000);
    this.onTrace = options.onTrace;
  }

  private trace(event: TranslationTrace): void {
    this.traceTail.push(event);
    if (this.traceTail.length > 256) this.traceTail.shift();
    try { this.onTrace?.(event); } catch { /* Diagnostics never change delivery. */ }
  }

  /** deadlineAt is background monotonic time for legacy requests; VOD uses priority and dispatch timeouts. */
  async translate(request: TranslationRequest): Promise<TranslationResponse> {
    const fallback = (status: TranslationOutput['status'], reason: string, retryAfterMs?: number): TranslationResponse => ({
      items: request.items.map(({ id, text }) => ({ id, text, status, reason, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) })),
    });
    if (this.disposed) return fallback('original', 'engine-disposed');
    if (request.signal?.aborted) return fallback('original', 'cancelled');
    if (typeof request.resourceId !== 'string' || !request.resourceId.length || request.resourceId.length > 1000) {
      return fallback('failed', 'invalid-resource');
    }
    let settings: Settings;
    try {
      settings = { ...request.settings };
      validateSettings(settings);
      if (settings.backend !== 'local') settings.thinkingEffort = normalizeReasoningEffort(settings, settings.thinkingEffort);
    }
    catch { return fallback('failed', 'invalid-settings'); }
    if (!settings.enabled || settings.displayMode === 'original') return fallback('original', 'translation-disabled');
    if (request.items.length === 0) return { items: [] };
    // A rejected oversized envelope cannot create an unbounded number of timers or cache lookups.
    if (request.items.length > this.maxRequestItems) return request.mode === 'vod'
      ? fallback('deferred', 'request-overflow', CAPACITY_RETRY_MS) : fallback('original', 'request-overflow');
    return new Promise<TranslationResponse>((resolve) => {
      const context: ResponseContext = {
        vod: request.mode === 'vod', live: request.mode === 'deadline', priority: request.priority ?? 'background', quotaScope: request.quotaScope,
        results: new Array<TranslationOutput>(request.items.length), remaining: request.items.length,
        subscribers: new Set(), resolve, signal: request.signal,
        earliestDeadline: Math.min(...request.items.map((item) => item.deadlineAt).filter(Number.isFinite)),
        hasTranslation: false,
        onResult: request.onResult, occurrenceIds: [],
        deliverPartial: () => {
          // This Promise has useful early results. Release them before a slower sibling consumes its budget.
          for (const subscription of [...context.subscribers]) this.finish(subscription, 'original', 'response-deadline');
        },
        abort: () => {
          for (const subscription of [...context.subscribers]) this.finish(subscription, 'original', 'cancelled');
        },
      };
      request.signal?.addEventListener('abort', context.abort, { once: true });
      const group = JSON.stringify([batchGroup(settings), context.live ? request.resourceId : '', context.live, request.namespace ?? '']);
      const lookups: Task[] = [];
      request.items.forEach((source, index) => {
        // Snapshot inputs/settings: page mutation cannot change task identity after admission.
        const input = { ...source };
        const occurrenceId = ++this.occurrenceSequence;
        context.occurrenceIds[index] = occurrenceId; this.counts.rawInputs++;
        this.trace({ type: 'arrival', at: this.clock.now(), occurrenceId, deadlineAt: input.deadlineAt });
        const direct = (status: TranslationOutput['status'], reason: string, retryAfterMs?: number) => {
          this.record(context, index, { id: input.id, text: input.text, status, reason,
            ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
        };
        const overflow = (reason: string) => direct(context.vod ? 'deferred' : 'original', reason, context.vod ? CAPACITY_RETRY_MS : undefined);
        if (typeof input.id !== 'string' || input.id.length > 1000 || typeof input.text !== 'string' || !Number.isFinite(input.deadlineAt)) {
          direct('failed', 'invalid-input'); return;
        }
        if (!context.vod && input.deadlineAt <= this.clock.now()) { direct('expired', 'deadline'); return; }
        if (input.text.length === 0 || input.text.length > settings.maxBatchChars) { direct('original', 'input-size'); return; }
        const protectedText = protectText(input.text);
        if (protectedText.reason) { direct('original', protectedText.reason); return; }
        if (protectedText.text.length > settings.maxBatchChars) { direct('original', 'protected-input-size'); return; }
        if (this.subscribers >= this.maxSubscribers) { overflow('subscriber-overflow'); return; }
        const persistentKey = translationCacheKey(request.resourceId, input.text, settings, context.live ? LIVE_PROMPT_VERSION : undefined);
        const key = request.bypassCache ? JSON.stringify([persistentKey, request.namespace, occurrenceId]) : persistentKey;
        // Credentials are compared only in transient memory, never encoded in a cache key or diagnostic.
        let task = [...(this.byKey.get(key) ?? [])].reverse().find((candidate) =>
          candidate.apiKey === request.apiKey && !candidate.batch?.controller.signal.aborted &&
          (!request.force || candidate.forced && ['lookup', 'queued', 'running'].includes(candidate.stage)),
        );
        let created = false;
        if (task) { this.counts.mergedInputs++; if ((input.strategy ?? 'normal') === 'normal') task.serviceClass = 'normal'; }
        else {
          const bytes = encoder.encode(key).byteLength + encoder.encode(input.text).byteLength + 256;
          if (!this.makeRoom(bytes, input.deadlineAt, context)) { overflow('queue-overflow'); return; }
          if (request.force) this.cacheGenerations.set(key, (this.cacheGenerations.get(key) ?? 0) + 1);
          task = {
            id: `t${++this.sequence}`, cacheKey: key, resourceId: request.resourceId, text: input.text,
            settings, apiKey: request.apiKey, group, subscribers: new Set(), bytes, chars: protectedText.text.length,
            tokenEstimate: liveTokenEstimate(protectedText.text),
            stage: 'lookup', attempts: 0, readyAt: this.clock.now(), enqueuedAt: this.clock.now(),
            bypassCache: request.bypassCache === true, forced: request.force === true,
            cacheGeneration: this.cacheGenerations.get(key) ?? 0, serviceClass: input.strategy ?? 'normal',
          };
          this.tasks.add(task); this.pendingBytes += bytes;
          const bucket = this.byKey.get(key) ?? new Set<Task>();
          bucket.add(task); this.byKey.set(key, bucket);
          created = true;
          this.counts.uniqueTasks++;
        }
        this.trace({ type: 'bind', at: this.clock.now(), occurrenceId, taskId: task.id, reused: !created });
        const subscription: Subscription = { input, index, context, task, done: false };
        task.subscribers.add(subscription); context.subscribers.add(subscription); this.subscribers++;
        if (!context.vod) this.armDeadline(subscription);
        if (task.completedText !== undefined) this.finish(subscription, 'translated', undefined, task.completedText);
        else if (created) lookups.push(task);
      });
      if (lookups.length) void this.prepare(lookups);
    });
  }

  private record(context: ResponseContext, index: number, output: TranslationOutput): void {
    context.results[index] = output;
    try { context.onResult?.({ ...output }); } catch { /* A closed receiver must not interrupt shared tasks. */ }
    this.trace({ type: 'ready', at: this.clock.now(), occurrenceId: context.occurrenceIds[index]!, status: output.status, reason: output.reason });
    if (output.status === 'cached') this.counts.cacheHits++;
    else this.counts[output.status]++;
    if (output.status === 'translated' || output.status === 'cached') context.hasTranslation = true;
    if (--context.remaining === 0) {
      this.clock.clearTimeout(context.deliveryTimer);
      context.signal?.removeEventListener('abort', context.abort);
      context.resolve(context.usage ? { items: context.results, usage: context.usage } : { items: context.results });
    } else if (!context.vod && !context.onResult && context.hasTranslation && context.deliveryTimer === undefined) {
      const remaining = context.earliestDeadline - this.clock.now();
      // Up to 25 ms for background-to-caller handoff, without adding a new core request field.
      context.deliveryTimer = this.clock.setTimeout(context.deliverPartial, Math.max(0, remaining - Math.min(25, remaining / 2)));
    }
  }
  private armDeadline(subscription: Subscription): void {
    const remaining = subscription.input.deadlineAt - this.clock.now();
    if (remaining <= 0) { this.finish(subscription, 'expired', 'deadline'); return; }
    subscription.timer = this.clock.setTimeout(() => this.armDeadline(subscription), Math.min(remaining, MAX_TIMER_MS));
  }
  private finish(subscription: Subscription, status: TranslationOutput['status'], reason?: string, text?: string, retryAfterMs?: number): void {
    if (subscription.done) return;
    subscription.done = true;
    this.clock.clearTimeout(subscription.timer);
    const { task, context, input, index } = subscription;
    task.subscribers.delete(subscription); context.subscribers.delete(subscription); this.subscribers--;
    if (!context.vod && status !== 'original' && this.clock.now() >= input.deadlineAt) { status = 'expired'; reason = 'deadline'; }
    if (status === 'expired' && task.settings.backend === 'local') {
      if (task.stage === 'running') this.localDiagnostics.runningDeadline++;
      else this.localDiagnostics.queuedDeadline++;
    }
    if (reason === 'timeout' && task.settings.backend === 'local') this.localDiagnostics.requestTimeout++;
    const output: TranslationOutput = {
      id: input.id, text: status === 'translated' || status === 'cached' ? text : input.text, status,
    };
    if (reason) output.reason = reason;
    if (retryAfterMs !== undefined) output.retryAfterMs = retryAfterMs;
    this.record(context, index, output);
    if (task.subscribers.size === 0) {
      if (task.stage === 'lookup' || task.stage === 'queued') this.remove(task);
      if (task.stage === 'running' && task.batch?.tasks.every((item) => item.subscribers.size === 0 && item.completedText === undefined)) task.batch.controller.abort();
    }
    this.schedulePump();
  }
  private finishTask(task: Task, status: TranslationOutput['status'], reason?: string, text?: string, retryAfterMs?: number): void {
    for (const subscription of [...task.subscribers]) this.finish(subscription, status, reason, text, retryAfterMs);
    this.remove(task);
  }
  private remove(task: Task): void {
    if (!this.tasks.delete(task)) return;
    this.pendingBytes -= task.bytes; task.stage = 'done';
    const bucket = this.byKey.get(task.cacheKey);
    bucket?.delete(task);
    if (!bucket?.size) { this.byKey.delete(task.cacheKey); this.cacheGenerations.delete(task.cacheKey); }
  }
  private deadline(task: Task, latest = false): number {
    let value = latest ? -Infinity : Infinity;
    for (const subscription of task.subscribers) value = latest
      ? Math.max(value, subscription.input.deadlineAt) : Math.min(value, subscription.input.deadlineAt);
    return value;
  }
  private vod(task: Task): boolean { return [...task.subscribers].some((subscription) => subscription.context.vod); }
  private live(task: Task): boolean { return [...task.subscribers].some((subscription) => subscription.context.live); }
  /** Trusted, expiring presence: a closed tab or sleeping content process cannot reserve forever. */
  setLiveSession(scope: string, active: boolean): void {
    if (active) this.liveSessions.set(scope, this.clock.now() + 6000);
    else this.liveSessions.delete(scope);
    this.schedulePump();
  }
  hasLiveWork(): boolean {
    for (const [scope, until] of this.liveSessions) if (until <= this.clock.now()) this.liveSessions.delete(scope);
    return this.liveSessions.size > 0 || [...this.tasks].some(task => this.live(task));
  }
  private priority(task: Task): number {
    if (this.live(task) && task.serviceClass !== 'normal') return -0.5;
    if (this.live(task)) return -1;
    return Math.min(...[...task.subscribers].map(({ context, input }) => context.vod
      ? ['near', 'buffered', 'background'].indexOf(context.priority)
      : input.deadlineAt - this.clock.now() <= task.settings.urgentSeconds * 1000 ? 0 : 2));
  }
  private urgent(task: Task): boolean { return this.priority(task) <= 0; }
  private makeRoom(bytes: number, deadline: number, context: ResponseContext): boolean {
    if (bytes > this.maxQueuedBytes) return false;
    while (this.tasks.size >= this.maxQueuedItems || this.pendingBytes + bytes > this.maxQueuedBytes) {
      const furthest = [...this.tasks].filter((task) =>
        (task.stage === 'lookup' || task.stage === 'queued') && (context.vod
          ? this.priority(task) > ['near', 'buffered', 'background'].indexOf(context.priority)
          : this.vod(task) || this.deadline(task) > deadline),
      ).sort((a, b) => this.priority(b) - this.priority(a) || this.deadline(b) - this.deadline(a))[0];
      if (!furthest) return false;
      for (const subscription of [...furthest.subscribers]) this.finish(subscription,
        subscription.context.vod ? 'deferred' : 'original', 'queue-overflow', undefined,
        subscription.context.vod ? CAPACITY_RETRY_MS : undefined);
      this.remove(furthest);
    }
    return true;
  }
  private async prepare(tasks: Task[]): Promise<void> {
    const settings = tasks[0]!.settings;
    const policy = { ttlMs: settings.cacheTtlDays * DAY, maxEntries: settings.cacheMaxEntries };
    let cached = new Map<string, string>();
    const eligible = tasks.filter(task => !task.bypassCache && !task.forced);
    try {
      if (this.cache.getMany) cached = await this.cache.getMany(eligible.map((task) => task.cacheKey), policy);
      else {
        // Compatibility caches still settle as a group: no per-item completion may start the pump.
        const results = await Promise.allSettled(eligible.map((task) => this.cache.get(task.cacheKey, policy)));
        results.forEach((result, index) => {
          if (result.status === 'rejected') this.counts.cacheErrors++;
          else if (result.value !== undefined) cached.set(eligible[index]!.cacheKey, result.value);
        });
      }
    }
    catch { this.counts.cacheErrors++; }
    for (const task of tasks) {
      if (task.stage !== 'lookup') continue;
      const hit = cached.get(task.cacheKey);
      if (typeof hit === 'string' && hit.trim() && !localQualityIssue(task.settings, task.text, hit)) { this.finishTask(task, 'cached', undefined, hit); continue; }
      if (task.settings.backend !== 'local' && (!task.apiKey || /[\r\n]/.test(task.apiKey))) { this.finishTask(task, 'failed', 'api-key-missing-or-invalid'); continue; }
      const rejected = this.rejectedGroups.get(task.group);
      if (rejected?.apiKey === task.apiKey) { this.finishTask(task, 'failed', rejected.reason); continue; }
      task.stage = 'queued';
      this.trace({ type: 'queued', at: this.clock.now(), taskId: task.id });
    }
    this.schedulePump();
  }
  private schedulePump(): void {
    if (this.pumpScheduled || this.disposed) return;
    this.pumpScheduled = true;
    // Coalesce independent same-turn request groups after their complete cache lookups settle.
    queueMicrotask(() => queueMicrotask(() => { this.pumpScheduled = false; if (!this.disposed) this.pump(); }));
  }
  private canRun(task: Task): boolean {
    const limit = Math.min(this.maxConcurrency, task.settings.concurrency,
      task.settings.backend === 'local' ? bound(task.settings.localCapacity, 1, Number.MAX_SAFE_INTEGER) : MAX_CONCURRENCY,
      ...[...this.active].map((batch) => batch.concurrency));
    if (task.serviceClass === 'normal' && this.live(task) && this.active.size >= limit) {
      // At a single-slot backend, cancel a slower category to release the only slot.
      // With multiple slots, slower categories always leave one slot for normal chat.
      if (limit === 1) for (const batch of this.active) if (batch.tasks.every(item => item.serviceClass !== 'normal')) batch.controller.abort();
    }
    if (this.active.size >= limit) return false;
    if (task.serviceClass !== 'normal' && limit > 1 && [...this.active].filter(batch => batch.tasks.every(item => item.serviceClass !== 'normal')).length >= limit - 1) return false;
    if (this.live(task) && task.settings.liveAdaptiveConcurrency !== false) {
      const control = this.control(task);
      const active = [...this.active].filter(batch => batch.live && batch.tasks[0]?.group === task.group).length;
      if (active >= control.limit) return false;
    }
    if (this.vod(task) && this.hasLiveWork()) {
      return limit >= 2 && [...this.active].filter(batch => !batch.live).length < limit - 1;
    }
    if (this.vod(task) || this.urgent(task)) return true;
    // One far batch at most, and always leave one slot for newly arriving urgent work.
    // At concurrency=1, far work waits until it enters the urgent window.
    return this.active.size < limit - 1 && ![...this.active].some((batch) => !batch.urgent);
  }
  private control(task: Task): { limit: number; changedAt: number; blockedUntil: number } {
    let control = this.controls.get(task.group);
    if (!control) {
      if (this.controls.size >= 128) this.controls.delete(this.controls.keys().next().value!);
      // Start with the user's configured capacity. Cold low-density traffic must not lose
      // coverage merely because a couple of slow requests occupy an invented lower cap.
      control = { limit: task.settings.concurrency, changedAt: this.clock.now(), blockedUntil: 0 };
      this.controls.set(task.group, control);
    }
    return control;
  }
  private timingBucket(task: Task, chars: number, load = this.active.size + 1): string {
    return JSON.stringify([task.group, chars <= 256 ? 0 : chars <= 1024 ? 1 : 2, load <= 2 ? 0 : load <= 8 ? 1 : 2]);
  }
  private timingEstimate(task: Task, chars = task.chars, items?: number): LiveTimingEstimate {
    const samples = this.timings.get(this.timingBucket(task, chars));
    const sorted = (samples ?? []).filter(sample => items === undefined || sample.items === items && sample.complete)
      .map(sample => sample.elapsed).sort((a, b) => a - b);
    return { expectedMs: sorted.length ? Math.max(25, sorted[Math.ceil(sorted.length * 0.8) - 1]!) : 160,
      samples: sorted.length, charsBucket: chars <= 256 ? 0 : chars <= 1024 ? 1 : 2,
      loadBucket: this.active.size + 1 <= 2 ? 0 : this.active.size + 1 <= 8 ? 1 : 2 };
  }
  private expectedMs(task: Task, chars = task.chars): number {
    return this.timingEstimate(task, chars).expectedMs;
  }
  private sendAt(task: Task, chars = task.chars): number {
    if (localSingleItem(task.settings)) return task.enqueuedAt; // A single-source translation never benefits from aggregation delay.
    return Math.min(task.enqueuedAt + (task.settings.liveMaxBatchWaitMs ?? MAX_LIVE_BATCH_WAIT_MS), this.deadline(task) - this.expectedMs(task, chars) - 25);
  }
  private adjustCapacity(now: number): void {
    const groups = new Map<string, Task[]>();
    for (const task of this.tasks) if (task.stage === 'queued' && this.live(task) && task.settings.liveAdaptiveConcurrency !== false) {
      const group = groups.get(task.group) ?? []; group.push(task); groups.set(task.group, group);
    }
    for (const tasks of groups.values()) {
      const first = tasks.sort((a, b) => this.deadline(a) - this.deadline(b))[0]!;
      const control = this.control(first);
      if (now < control.blockedUntil || now - control.changedAt < 250) continue;
      const active = [...this.active].filter(batch => batch.live && batch.tasks[0]?.group === first.group).length;
      // Demand is based on unique queued tasks and complete batch capacity, never raw duplicates.
      const input = tasks.reduce((sum, task) => sum + task.tokenEstimate.input, 0);
      const output = tasks.reduce((sum, task) => sum + task.tokenEstimate.output, 0);
      const batches = Math.max(Math.ceil(tasks.length / (localSingleItem(first.settings) ? 1 : first.settings.batchSize)),
        Math.ceil(input / (first.settings.liveMaxInputTokens ?? 4096)), Math.ceil(output / (first.settings.liveMaxOutputTokens ?? 4096)));
      const slack = Math.max(1, this.deadline(first) - now - 25);
      const desired = Math.min(first.settings.concurrency, this.maxConcurrency,
        Math.max(1, active + Math.ceil(batches * this.expectedMs(first) / slack)));
      if (desired > control.limit) { control.limit = Math.min(desired, control.limit + Math.max(1, Math.ceil(control.limit / 2))); control.changedAt = now; }
      else if (active === 0 && now - control.changedAt >= 2000 && desired < control.limit) { control.limit--; control.changedAt = now; }
    }
  }
  /** Only actual new provider admissions spend quota; cache hits, joins and retries are free. */
  private admit(task: Task): boolean {
    if (task.admitted) return true;
    const scope = [...task.subscribers][0]?.context.quotaScope;
    if (!scope) { task.admitted = true; return true; }
    const now = this.clock.now();
    for (const [name, entries] of this.quotas) {
      for (const [key, entry] of entries) {
        if (entry.at + QUOTA_WINDOW_MS <= now) entries.delete(key);
      }
      if (!entries.size) this.quotas.delete(name);
    }
    const entries = this.quotas.get(scope) ?? new Map<string, QuotaEntry>();
    const key = JSON.stringify([task.resourceId, task.text]);
    if (entries.has(key)) { task.admitted = true; return true; }
    const chars = [...entries.values()].reduce((sum, entry) => sum + entry.chars, 0);
    if (entries.size >= QUOTA_ITEMS || chars + task.text.length > QUOTA_CHARS) {
      let count = entries.size;
      let remainingChars = chars;
      let retryAt = now + QUOTA_WINDOW_MS;
      for (const entry of [...entries.values()].sort((a, b) => a.at - b.at)) {
        count--; remainingChars -= entry.chars;
        retryAt = entry.at + QUOTA_WINDOW_MS;
        if (count < QUOTA_ITEMS && remainingChars + task.text.length <= QUOTA_CHARS) break;
      }
      this.finishTask(task, 'deferred', 'quota-exceeded', undefined, Math.max(1, retryAt - now));
      return false;
    }
    entries.set(key, { at: now, chars: task.text.length }); this.quotas.set(scope, entries);
    task.admitted = true;
    return true;
  }
  private pump(): void {
    this.clock.clearTimeout(this.wakeTimer); this.wakeTimer = undefined;
    const now = this.clock.now();
    // Browser event dispatch can checkpoint microtasks between abort listeners.
    // Inspect the shared signal itself before freeing capacity can admit a peer.
    for (const task of [...this.tasks]) for (const subscription of [...task.subscribers]) {
      if (subscription.context.signal?.aborted) this.finish(subscription, 'original', 'cancelled');
    }
    this.adjustCapacity(now);
    // A cache promise may settle after its deadline before the timer task gets CPU time.
    for (const task of [...this.tasks]) {
      if (task.stage !== 'queued') continue;
      for (const subscription of [...task.subscribers]) {
        if (!subscription.context.vod && subscription.input.deadlineAt <= now) this.finish(subscription, 'expired', 'deadline');
      }
    }
    if (now >= this.rateLimitedUntil) {
      const waiting = new Set<string>();
      for (;;) {
        const ready = [...this.tasks].filter((task) => task.stage === 'queued' && task.readyAt <= now && task.subscribers.size)
          .sort((a, b) => this.priority(a) - this.priority(b) || this.deadline(a) - this.deadline(b));
        const first = ready.find((task) => !waiting.has(task.group) && this.canRun(task));
        if (!first) break;
        const urgent = this.urgent(first);
        const tasks = [first];
        let chars = first.chars;
        // Conservative fixed-prefix allowance plus escaped/protected JSON row sizes.
        // These are sizing estimates, not tokenizer counts or billable usage.
        const local = first.settings.backend === 'local';
        const localOutputLimit = local ? localGenerationProfile(first.settings, first.serviceClass).maxTokens : Infinity;
        // Conservative compact-prompt allowance. Full pooled context is a batch ceiling;
        // actual tokenizer/KV admission remains the local worker's responsibility.
        const localInputLimit = local ? bound(first.settings.localContextTokens, 2048, Number.MAX_SAFE_INTEGER) - localOutputLimit : Infinity;
        const maxBatchItems = localSingleItem(first.settings) ? 1 : first.settings.batchSize;
        let inputTokens = (local ? 256 : 1024) + first.tokenEstimate.input;
        let outputTokens = first.tokenEstimate.output;
        let sizeLimited = false;
        const live = this.live(first);
        const declined = { characters: 0, inputTokens: 0, outputTokens: 0, deadlineRegression: 0, quota: 0 };
        let timingDecline: LiveDispatchDecision['timingDecline'];
        for (const task of ready) {
          if (task === first || task.group !== first.group || task.apiKey !== first.apiKey
              || this.vod(task) !== this.vod(first) || this.priority(task) !== this.priority(first)) continue;
          if (tasks.length >= maxBatchItems) break;
          if (chars + task.chars > first.settings.maxBatchChars) { declined.characters++; sizeLimited = true; continue; }
          const estimate = task.tokenEstimate;
          if (local && (inputTokens + estimate.input > localInputLimit || outputTokens + estimate.output > localOutputLimit)) {
            declined.inputTokens += Number(inputTokens + estimate.input > localInputLimit);
            declined.outputTokens += Number(outputTokens + estimate.output > localOutputLimit);
            sizeLimited = true; continue;
          }
          if (live) {
            const inputLimited = inputTokens + estimate.input > (first.settings.liveMaxInputTokens ?? 4096);
            const outputLimited = outputTokens + estimate.output > (first.settings.liveMaxOutputTokens ?? 4096);
            if (inputLimited || outputLimited) {
              declined.inputTokens += Number(inputLimited); declined.outputTokens += Number(outputLimited);
              sizeLimited = true; continue;
            }
            const current = this.timingEstimate(first, chars), expanded = this.timingEstimate(first, chars + task.chars);
            const budgetMs = this.deadline(first) - now;
            // Split only when measured expansion would make an otherwise viable batch late.
            // An already-late estimate (or the same coarse bucket) must not turn every
            // remaining task into a singleton. Keep short-budget attempts and subscribers.
            if (current.samples && expanded.samples && current.expectedMs + 25 <= budgetMs
                && expanded.expectedMs + 25 > budgetMs) {
              declined.deadlineRegression++; timingDecline ??= { current, expanded, budgetMs };
              sizeLimited = true; continue;
            }
          }
          tasks.push(task); chars += task.chars;
          inputTokens += estimate.input; outputTokens += estimate.output;
        }
        if (live && first.attempts === 0 && tasks.length < first.settings.batchSize && !sizeLimited
            && now < this.sendAt(first, chars)) { waiting.add(first.group); continue; }
        // Under overload, adjacent EDF tasks can all expire before a measured full
        // response. Keep the EDF anchor, but backfill its other slots with the earliest
        // queued deadlines that may still benefit. Nothing is dropped or expired early.
        // Require the same item count and character/load bucket; the 160ms seed and
        // singleton estimates are not evidence for a full batch. Replacements cannot
        // increase any payload bound, and every substitution rechecks the forecast.
        let backfill: LiveDispatchDecision['backfill'];
        const forecast = live ? this.timingEstimate(first, chars, tasks.length) : undefined;
        if (forecast?.samples && tasks.length > 1
            && tasks.every(task => this.deadline(task, true) <= now + forecast.expectedMs + 25)) {
          const selected = new Set(tasks), beneficiaries: Task[] = [];
          for (let index = 1; index < tasks.length; index++) {
            const skipped = tasks[index]!;
            const replacement = ready.find(task => {
              if (selected.has(task) || task.group !== first.group || task.apiKey !== first.apiKey
                  || this.vod(task) !== this.vod(first) || this.priority(task) !== this.priority(first)
                  || task.chars > skipped.chars || task.tokenEstimate.input > skipped.tokenEstimate.input
                  || task.tokenEstimate.output > skipped.tokenEstimate.output) return false;
              const nextEstimate = this.timingEstimate(first, chars - skipped.chars + task.chars, tasks.length);
              return nextEstimate.samples > 0 && this.deadline(task, true) > now + nextEstimate.expectedMs + 25
                && beneficiaries.every(retained => this.deadline(retained, true) > now + nextEstimate.expectedMs + 25);
            });
            if (!replacement) continue;
            backfill ??= { items: tasks.length, forecast, replacements: [] };
            backfill.replacements.push({ skippedTaskId: skipped.id, selectedTaskId: replacement.id });
            // Keep original members excluded even if a smaller substitution changes
            // buckets; the backfill trace must identify tasks actually left queued.
            selected.add(replacement); beneficiaries.push(replacement);
            tasks[index] = replacement;
            chars += replacement.chars - skipped.chars;
            inputTokens += replacement.tokenEstimate.input - skipped.tokenEstimate.input;
            outputTokens += replacement.tokenEstimate.output - skipped.tokenEstimate.output;
          }
        }
        // Only the final dispatch spends quota; bypassed and aggregating tasks do not.
        if (!this.admit(first)) continue;
        const backfillBounds = backfill ? { items: tasks.length, chars, inputTokens, outputTokens } : undefined;
        for (let index = 1; index < tasks.length; index++) {
          const task = tasks[index]!;
          if (this.admit(task)) continue;
          declined.quota++; tasks.splice(index--, 1);
          chars -= task.chars; inputTokens -= task.tokenEstimate.input; outputTokens -= task.tokenEstimate.output;
        }
        // A rejected quota scope (or a large source that no longer fits its quota)
        // must not prevent an eligible queued peer from filling the same request.
        if (declined.quota) for (const task of ready) {
          if (tasks.length >= (backfillBounds?.items ?? maxBatchItems)) break;
          if (task.stage !== 'queued' || tasks.includes(task) || task.group !== first.group || task.apiKey !== first.apiKey
              || this.vod(task) !== this.vod(first) || this.priority(task) !== this.priority(first)
              || chars + task.chars > first.settings.maxBatchChars) continue;
          const estimate = task.tokenEstimate;
          if (local && (inputTokens + estimate.input > localInputLimit || outputTokens + estimate.output > localOutputLimit)) continue;
          if (live) {
            if (inputTokens + estimate.input > (first.settings.liveMaxInputTokens ?? 4096)
                || outputTokens + estimate.output > (first.settings.liveMaxOutputTokens ?? 4096)) continue;
            const current = this.timingEstimate(first, chars), expanded = this.timingEstimate(first, chars + task.chars);
            if (current.samples && expanded.samples && current.expectedMs + 25 <= this.deadline(first) - now
                && expanded.expectedMs + 25 > this.deadline(first) - now) continue;
            if (backfillBounds) {
              if (chars + task.chars > backfillBounds.chars || inputTokens + estimate.input > backfillBounds.inputTokens
                  || outputTokens + estimate.output > backfillBounds.outputTokens) continue;
              const forecast = this.timingEstimate(first, chars + task.chars, tasks.length + 1);
              const retained = tasks.filter(item => backfill!.replacements.some(row => row.selectedTaskId === item.id));
              if (!forecast.samples || retained.some(item => this.deadline(item, true) <= now + forecast.expectedMs + 25)) continue;
            }
          }
          if (!this.admit(task)) { declined.quota++; continue; }
          tasks.push(task); chars += task.chars;
          inputTokens += estimate.input; outputTokens += estimate.output;
        }
        if (backfill) {
          backfill.replacements = backfill.replacements.filter(row => tasks.some(task => task.id === row.selectedTaskId)
            && !tasks.some(task => task.id === row.skippedTaskId));
          if (!backfill.replacements.length) backfill = undefined;
        }
        const liveDispatch: LiveDispatchDecision | undefined = live ? {
          trigger: tasks.length >= maxBatchItems ? 'batch-limit' : sizeLimited ? 'candidate-limit'
            : now < first.enqueuedAt + (first.settings.liveMaxBatchWaitMs ?? MAX_LIVE_BATCH_WAIT_MS) ? 'deadline-margin' : 'aggregation-limit',
          queuedMs: now - first.enqueuedAt, estimate: this.timingEstimate(first, chars),
          budgets: tasks.map(task => ({ taskId: task.id, earliestMs: this.deadline(task) - now,
            latestMs: this.deadline(task, true) - now, subscribers: task.subscribers.size })),
          declined, ...(timingDecline ? { timingDecline } : {}), ...(backfill ? { backfill } : {}),
        } : undefined;
        const batch: Batch = { tasks, controller: new AbortController(), concurrency: Math.min(first.settings.concurrency,
          local ? bound(first.settings.localCapacity, 1, Number.MAX_SAFE_INTEGER) : MAX_CONCURRENCY), urgent, live: this.live(first),
          id: ++this.batchSequence, startedAt: now, load: this.active.size + 1, bucket: this.timingBucket(first, chars),
          contexts: new Set(tasks.flatMap(task => [...task.subscribers].map(s => s.context))) };
        this.active.add(batch);
        if (tasks.some((task) => task.attempts > 0)) this.counts.retries++;
        this.counts.providerCalls++;
        for (const task of tasks) { task.stage = 'running'; task.batch = batch; task.attempts++; }
        this.trace({ type: 'attempt', at: now, batchId: batch.id, taskIds: tasks.map(t => t.id), items: tasks.length,
          attempt: Math.max(...tasks.map(t => t.attempts)), inputTokenUpperEstimate: inputTokens,
          outputTokenEstimate: outputTokens, activeRequests: this.active.size, ...(liveDispatch ? { liveDispatch } : {}) });
        void this.run(batch);
      }
    }
    let next = Infinity;
    for (const until of this.liveSessions.values()) if (until > now) next = Math.min(next, until);
    for (const task of this.tasks) {
      if (task.stage !== 'queued') continue;
      const readyAt = Math.max(task.readyAt, this.rateLimitedUntil);
      if (readyAt > now) next = Math.min(next, readyAt);
      if (this.live(task)) {
        const sendAt = this.sendAt(task);
        if (sendAt > now) next = Math.min(next, sendAt);
        const control = this.control(task);
        if (task.settings.liveAdaptiveConcurrency !== false && control.limit < task.settings.concurrency) {
          const adjustmentAt = Math.max(control.changedAt + 250, control.blockedUntil);
          if (adjustmentAt > now) next = Math.min(next, adjustmentAt);
        }
      }
      const becomesUrgent = this.vod(task) ? Infinity : this.deadline(task) - task.settings.urgentSeconds * 1000;
      if (becomesUrgent > now) next = Math.min(next, becomesUrgent);
    }
    if (Number.isFinite(next)) this.wakeTimer = this.clock.setTimeout(() => this.schedulePump(), Math.min(next - now, MAX_TIMER_MS));
  }
  private retry(task: Task, reason: string, waitMs: number): void {
    if (this.live(task)) { this.finishTask(task, 'original', reason); return; }
    const readyAt = this.clock.now() + waitMs;
    if (task.attempts < 2 && task.subscribers.size && (this.vod(task) || this.deadline(task, true) - readyAt >= MIN_RETRY_BUDGET_MS)) {
      task.stage = 'queued'; task.batch = undefined; task.readyAt = readyAt;
    } else this.finishTask(task, 'failed', reason, undefined, this.vod(task) && reason === 'http-429' ? waitMs : undefined);
  }
  private async save(tasks: Task[]): Promise<void> {
    const previousWrite = this.cacheWriteTail;
    let releaseWrite!: () => void;
    const currentWrite = new Promise<void>(resolve => { releaseWrite = () => { if (this.cacheWriteTail === currentWrite) this.cacheWriteTail = undefined; resolve(); }; });
    this.cacheWriteTail = currentWrite;
    if (previousWrite) await previousWrite;
    const all = tasks;
    tasks = tasks.filter(task => !task.bypassCache && task.cacheGeneration === (this.cacheGenerations.get(task.cacheKey) ?? 0));
    if (!tasks.length) { all.forEach(task => this.remove(task)); releaseWrite(); return; }
    const settings = tasks[0]!.settings;
    const policy = { ttlMs: settings.cacheTtlDays * DAY, maxEntries: settings.cacheMaxEntries };
    try {
      if (this.cache.setMany) await this.cache.setMany(tasks.map((task) => ({
        key: task.cacheKey, text: task.completedText!, resourceId: task.resourceId,
      })), policy);
      else {
        const results = await Promise.allSettled(tasks.map((task) => this.cache.set(task.cacheKey, task.completedText!, {
          ...policy, resourceId: task.resourceId,
        })));
        this.counts.cacheErrors += results.filter((result) => result.status === 'rejected').length;
      }
    } catch { this.counts.cacheErrors++; }
    finally { all.forEach((task) => this.remove(task)); releaseWrite(); this.schedulePump(); }
  }
  private async run(batch: Batch): Promise<void> {
    const first = batch.tasks[0]!;
    let usage: Usage | undefined, status = 'failed', duplicates = 0;
    const pendingSaves: Task[] = [];
    const accept = (task: Task, text: string, saveNow = true): void => {
      if (task.completedText !== undefined || this.disposed || batch.controller.signal.aborted || task.stage === 'done' || !text.trim()) return;
      const issue = localQualityIssue(task.settings, task.text, text);
      if (issue) { this.localDiagnostics.qualityRejected++; this.lastError = { reason: issue, at: this.clock.now() }; this.finishTask(task, 'failed', issue); return; }
      task.stage = 'saving'; task.completedText = text;
      for (const subscription of [...task.subscribers]) this.finish(subscription, 'translated', undefined, text);
      // Stream delivery and cache writes never stop the provider from draining final usage.
      if (saveNow) void this.save([task]); else pendingSaves.push(task);
    };
    try {
      if (first.settings.backend === 'local' && batch.tasks.some(task => task.forced)) this.localDiagnostics.forcedCalls++;
      const result = await this.provider.complete({
        settings: first.settings, apiKey: first.apiKey,
        strategy: first.serviceClass,
        force: batch.tasks.some(task => task.forced),
        mode: batch.live ? 'deadline' : this.vod(first) ? 'vod' : undefined,
        items: batch.tasks.map(({ id, text }) => ({ id, text })), signal: batch.controller.signal,
        onItem: (id, output) => {
          const task = batch.tasks.find(task => task.id === id);
          if (task && output.text !== undefined) accept(task, output.text);
        },
        // A short-lived subscriber must not cancel another subscriber's longer budget.
        budgetMs: batch.tasks.some((task) => this.vod(task)) ? providerTimeoutMs(first.settings)
          : Math.max(...batch.tasks.map((task) => this.deadline(task, true))) - this.clock.now(),
      });
      usage = result.usage;
      if (result.local) this.localDiagnostics.last = { ...result.local };
      if (batch.controller.signal.aborted || this.disposed) throw new ProviderError('cancelled');
      // Context usage is available to non-streaming Promise consumers; global totals settle below.
      for (const context of batch.contexts) context.usage = addUsage(context.usage, usage);
      duplicates = result.duplicateIds?.length ?? 0;
      this.counts.duplicateOutputIds += duplicates;
      status = 'completed';
      for (const task of batch.tasks) {
        if (task.completedText !== undefined || task.stage === 'done') continue;
        const output = result.items.get(task.id);
        if (output?.text !== undefined) {
          accept(task, output.text, false);
        } else {
          status = 'partial';
          if (first.settings.backend === 'local' && ['wrong-target-language', 'untranslated-text', 'output-truncated', 'instruction-leak'].includes(output?.reason ?? '')) {
            this.localDiagnostics.qualityRejected++; this.lastError = { reason: output!.reason!, at: this.clock.now() };
          }
          if (output?.reason === 'missing-id') this.retry(task, 'missing-id', 0);
          else this.finishTask(task, 'failed', output?.reason ?? 'invalid-response');
        }
      }
      const saves = new Map<string, Task[]>();
      for (const task of pendingSaves) {
        const policy = JSON.stringify([task.settings.cacheTtlDays, task.settings.cacheMaxEntries]);
        const tasks = saves.get(policy) ?? []; tasks.push(task); saves.set(policy, tasks);
      }
      for (const tasks of saves.values()) void this.save(tasks);
      if (batch.live) {
        const elapsed = this.clock.now() - batch.startedAt;
        const samples = this.timings.get(batch.bucket) ?? [];
        const previous = samples.length ? samples.reduce((sum, sample) => sum + sample.elapsed, 0) / samples.length : 0;
        if (previous && samples.length >= 3 && elapsed > previous * 1.5 && batch.load > 2) {
          const control = this.control(first); control.limit = Math.max(1, control.limit - 1); control.blockedUntil = this.clock.now() + 2000;
        }
        samples.push({ elapsed, items: batch.tasks.length, complete: status === 'completed' }); if (samples.length > 32) samples.shift();
        if (this.timings.size >= 128 && !this.timings.has(batch.bucket)) this.timings.delete(this.timings.keys().next().value!);
        this.timings.set(batch.bucket, samples);
      }
    } catch (error: unknown) {
      const failure = error instanceof ProviderError ? error : new ProviderError('provider-error');
      usage = failure.usage ?? usage; status = failure.message;
      for (const context of batch.contexts) context.usage = addUsage(context.usage, usage);
      for (const task of batch.tasks) {
        const output = failure.partialItems?.get(task.id);
        if (output?.text !== undefined) accept(task, output.text);
      }
      if (batch.controller.signal.aborted) {
        for (const task of batch.tasks) if (task.completedText === undefined) this.finishTask(task, 'original', 'cancelled');
        return; // An old cancelled request cannot overwrite current configuration failure state.
      }
      const waitMs = failure.status === 429 ? failure.retryAfterMs ?? 1000 : 200;
      if (failure.status === 429) this.rateLimitedUntil = Math.max(this.rateLimitedUntil, this.clock.now() + waitMs);
      if (batch.live && failure.retryable) {
        const control = this.control(first);
        // 429 is capacity feedback. An isolated network failure is not evidence that
        // fewer concurrent requests will help; keep capacity and stop increases instead.
        if (failure.status === 429) control.limit = Math.max(1, Math.floor(control.limit / 2));
        control.blockedUntil = this.clock.now() + Math.max(1000, waitMs); control.changedAt = this.clock.now();
      }
      if (failure.message !== 'cancelled') {
        this.lastError = { reason: failure.message, at: this.clock.now() };
        if (failure.status !== undefined) this.lastError.status = failure.status;
        if (failure.status === 429) this.lastError.retryAt = this.rateLimitedUntil;
        if ((failure.status === 401 || failure.status === 403) && !batch.controller.signal.aborted) {
          this.rejectedGroups.set(first.group, { apiKey: first.apiKey, reason: failure.message });
          for (const task of [...this.tasks]) {
            if (task.stage === 'queued' && task.group === first.group && task.apiKey === first.apiKey) this.finishTask(task, 'failed', failure.message);
          }
        }
      }
      for (const task of batch.tasks) {
        if (task.completedText !== undefined || task.stage === 'done') continue;
        if (failure.retryable) this.retry(task, failure.message, waitMs);
        else this.finishTask(task, failure.message === 'cancelled' ? 'original' : 'failed', failure.message);
      }
    } finally {
      if (usage) { this.counts.usageReports++; this.usage = addUsage(this.usage, usage); }
      if (usage?.promptTokens === undefined || usage?.completionTokens === undefined) this.counts.usageUnavailableCalls++;
      this.trace({ type: 'settled', at: this.clock.now(), batchId: batch.id, durationMs: this.clock.now() - batch.startedAt,
        status, usage, usageKnown: usage?.promptTokens !== undefined && usage?.completionTokens !== undefined, duplicateIds: duplicates });
      this.active.delete(batch); this.schedulePump();
    }
  }

  /** Global usage counts actual attempts once; response usage describes calls shared by that response. */
  stats(): TranslationEngineStats {
    const snapshot: TranslationEngineStats = {
      ...this.counts, pendingItems: this.tasks.size,
      queuedItems: [...this.tasks].filter((task) => task.stage === 'queued' || task.stage === 'lookup').length,
      pendingBytes: this.pendingBytes, subscribers: this.subscribers, activeRequests: this.active.size,
      recentTrace: this.traceTail.map(event => structuredClone(event)),
      localDiagnostics: structuredClone(this.localDiagnostics),
    };
    if (this.usage) snapshot.usage = { ...this.usage };
    if (this.lastError) snapshot.lastError = { ...this.lastError };
    if (this.rateLimitedUntil > this.clock.now()) snapshot.rateLimitedUntil = this.rateLimitedUntil;
    return snapshot;
  }
  /** Called only by the trusted background after cancelling subscriptions for a settings action. */
  resetFailureState(): void {
    this.rejectedGroups.clear(); this.lastError = undefined; this.rateLimitedUntil = 0;
    // Background calls this before clear/settings changes. A pending write must no longer supply joins.
    for (const task of [...this.tasks]) if (task.stage === 'saving') this.remove(task);
    this.schedulePump();
  }
  dispose(): void {
    this.disposed = true;
    this.rejectedGroups.clear();
    this.quotas.clear();
    this.liveSessions.clear();
    this.clock.clearTimeout(this.wakeTimer);
    for (const task of [...this.tasks]) this.finishTask(task, 'original', 'engine-disposed');
    for (const batch of this.active) batch.controller.abort();
  }
}
