import { DisplayPlanner, type DisplayPlanInput, type DisplayPlanCandidate, type DisplayPlanEvent } from '../core/display-plan.ts';
import { VideoScheduler, type DueItem } from '../core/scheduler.ts';
import { needsTranslation } from '../core/messages.ts';
import type { PlaybackClock, Settings, SourceMessage, TranslationOutput } from '../core/types.ts';
import { TranslationEngine } from '../translation/engine.ts';
import { MemoryTranslationCache } from '../translation/cache.ts';
import { protectText } from '../translation/text.ts';
import { USER_FILTER_CONTRACT } from '../platforms/bilibili/user-filters.ts';
import type { UserFilterRow } from '../platforms/bilibili/user-filter-session.ts';

export interface DisplayPlanFrame {
  resourceId: string; epoch: number; clock: PlaybackClock; wallTimeMs: number;
  sourceRevision: number; ruleRevision: number; complete: boolean; contextValid: boolean;
  sources: SourceMessage[]; decisions: UserFilterRow[];
}
export interface DisplayPlanSessionOptions {
  limit?: number; delayMs?: number; now?: number; comparison?: boolean;
  beforeDispatch?: (snapshot: ReturnType<DisplayPlanner['snapshot']>, frame: DisplayPlanFrame) => string[];
  /** The trusted background owns TranslationEngine, cache, validation, and actual-send accounting. */
  live?: LivePlanTransport;
  range?: { startMs: number; endMs: number };
  canRequest?: (event: DisplayPlanEvent, frame: DisplayPlanFrame) => boolean;
  getCurrentClock?: () => PlaybackClock | null;
  getSendable?: (event: DisplayPlanEvent, frame: DisplayPlanFrame) => boolean;
}
export interface LivePlanTransport {
  translate(request: { resourceId: string; epoch: number; requestId: string; items: DueItem[];
    signal: AbortSignal; onResult: (output: LivePlanOutput) => void }): Promise<LivePlanOutput[]>;
  cancelItems?(requestId: string, ids: string[]): void;
  onReady?(output: LivePlanOutput, event: DisplayPlanEvent, frame: DisplayPlanFrame): void;
}
export type LivePlanOutput = TranslationOutput & { taskId?: string; resultId?: string;
  source?: 'new' | 'cache' | 'shared';
  preview?: { runId: string; instanceId: string; configIdentity: string; requestId: string;
    taskId: string; resultId: string; originalText: string;
    kind: 'new-inference' | 'session-cache' | 'session-shared' } };
export type LivePlanDemand = Pick<DisplayPlanEvent,
  'id' | 'sourceId' | 'originalText' | 'mediaTimeMs' | 'resourceId' | 'epoch'>;
export type { DisplayPlanEvent } from '../core/display-plan.ts';
const LIVE_RANGE = { startMs: 45_000, endMs: 85_000 };
function liveSettings(settings: Settings): Settings {
  return { ...settings, enabled: true, backend: 'local', sourceLanguage: 'auto', targetLanguage: 'ja',
    displayMode: 'translated', translationScope: 'window', prefetchSeconds: 10,
    concurrency: Math.min(2, Math.max(1, settings.localConcurrency)),
    localConcurrency: Math.min(2, Math.max(1, settings.localConcurrency)) };
}
const keyOf = (resource: string, epoch: number, id: string) => JSON.stringify([resource, epoch, id]);
const synthetic = (language: string) => language.startsWith('ja') ? 'テスト訳文' : language.startsWith('zh') ? '模拟译文'
  : language.startsWith('ko') ? '모의 번역문' : 'Synthetic translation';
export function displayPlanContextValid(summary: any): boolean {
  return summary?.contract === USER_FILTER_CONTRACT && summary.featureEnabled === true &&
    typeof summary.nativeEnabled === 'boolean' && ['storeFound', 'methodsMatch', 'callbackMatches', 'listComplete', 'switchKnown', 'accountScopeKnown']
      .every(key => summary.readEvidence?.[key] === true);
}
function candidateRows(frame: DisplayPlanFrame, settings: Settings): DisplayPlanCandidate[] {
  const rules = new Map(frame.decisions.map(row => [row.id, row]));
  return frame.sources.map(source => {
    const rule = rules.get(source.id);
    return { id: source.id, sourceId: source.sourceId, resourceId: source.resourceId,
      originalText: source.originalText, mediaTimeMs: source.mediaTimeMs,
      inScope: source.displayPlanEligible === true && source.style.position === '1',
      needsTranslation: source.translatable && needsTranslation(source.originalText, settings.targetLanguage, settings.sourceLanguage) && !protectText(source.originalText).reason,
      state: rule?.originalText === source.originalText ? rule.state : 'unknown' };
  });
}

class PlanSimulation {
  readonly planner: DisplayPlanner;
  private engine: TranslationEngine;
  private scheduler: VideoScheduler;
  private cache = new MemoryTranslationCache({ maxEntries: 4000, maxBytes: 2 * 1024 * 1024 });
  private active = new Map<string, SourceMessage>();
  private prepared = new Set<string>();
  private subscriptions = new Set<string>();
  private submitted = new Set<string>();
  private outcomes = new Map<string, Record<string, unknown>>();
  private inputLog: Record<string, unknown>[] = [];
  private requestLog: Record<string, unknown>[] = [];
  private generation = 0;
  private epoch = -1;
  private resourceId = '';
  private now = 0;
  private valid = false;
  private stopped = false;
  private settings: Settings;
  private providerCalls = 0;
  private providerInputs = 0;
  private orphanInputs = 0;
  private lateResults = 0;
  private truncated = false;
  private delayMs: number;
  private previewExcluded = new Set<string>();
  private beforeDispatch?: DisplayPlanSessionOptions['beforeDispatch'];
  get budgetFull() { return this.subscriptions.size >= 20000 || this.submitted.size >= 20000 ||
    this.prepared.size >= 20000 || this.outcomes.size >= 20000 || this.requestLog.length >= 20000 || this.inputLog.length >= 20000; }
  constructor(limit: number | null, settings: Settings, delayMs = 0, beforeDispatch?: DisplayPlanSessionOptions['beforeDispatch']) {
    this.delayMs = delayMs;
    this.beforeDispatch = beforeDispatch;
    this.planner = new DisplayPlanner({ limit });
    this.settings = { ...settings, enabled: true, displayMode: 'translated', translationScope: 'window', prefetchSeconds: 10 };
    const record = (target: Record<string, unknown>[], value: Record<string, unknown>) => {
      if (target.length < 20000) target.push(value); else this.truncated = true;
    };
    this.engine = new TranslationEngine({ cache: this.cache, provider: { complete: async request => {
      const generation = this.generation;
      const admitted = request.items.map(item => ({ item, owners: [...this.active.values()].filter(source =>
        this.valid && source.originalText === item.text && request.isItemCurrent?.(item.id) !== false) }));
      if (admitted.some(row => row.owners.length === 0) || request.signal?.aborted || this.stopped) {
        this.orphanInputs += admitted.filter(row => row.owners.length === 0).length;
        throw new Error('display-plan-provider-without-valid-subscription');
      }
      this.providerCalls++; this.providerInputs += admitted.length;
      for (const [index, { item, owners }] of admitted.entries()) {
        const ownerKeys = owners.map(source => keyOf(this.resourceId, this.epoch, source.id));
        for (const key of ownerKeys) this.submitted.add(key);
        record(this.inputLog, { sequence: this.providerInputs - admitted.length + index + 1,
          resourceId: this.resourceId, epoch: this.epoch, atMs: this.now, originalText: item.text, owners: ownerKeys });
      }
      if (this.delayMs) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { request.signal?.removeEventListener('abort', abort); resolve(); }, this.delayMs);
        const abort = () => { clearTimeout(timer); reject(new Error('cancelled')); };
        request.signal?.addEventListener('abort', abort, { once: true });
      });
      if (generation !== this.generation || request.signal?.aborted || this.stopped) { this.lateResults++; throw new Error('cancelled'); }
      return { items: new Map(admitted.map(({ item }) => [item.id, { text: synthetic(this.settings.targetLanguage) }])) };
    } } });
    this.scheduler = new VideoScheduler({ settings: this.settings, now: () => this.now,
      reset: () => {}, cancelItems: (signal, ids) => this.engine.cancelItems(signal, ids),
      prepared: items => {
        // This receiver is intentionally disconnected from the real adapter.
        for (const item of items) if (this.valid && this.active.get(item.id)?.originalText === item.originalText)
          this.prepared.add(keyOf(this.resourceId, this.epoch, item.id));
        else this.lateResults++;
      },
      request: async (resourceId, items, signal, priority, onResult) => {
        const generation = this.generation;
        const valid = items.filter(item => this.valid && this.active.get(item.id)?.originalText === item.text);
        for (const item of valid) {
          const key = keyOf(resourceId, this.epoch, item.id); this.subscriptions.add(key);
          record(this.requestLog, { key, atMs: this.now, epoch: this.epoch, id: item.id, originalText: item.text });
        }
        const current = (output: TranslationOutput) => generation === this.generation && this.valid && this.active.has(output.id);
        const result = await this.engine.translate({ resourceId, settings: this.settings, apiKey: 'memory-provider-only',
          mode: 'vod', priority, signal, items: valid.map(item => ({ id: item.id, text: item.text, deadlineAt: performance.now() + item.remainingMs })),
          onResult: output => { if (current(output)) onResult(output); else this.lateResults++; } });
        return result.items.filter(current);
      },
    });
  }
  update(frame: DisplayPlanFrame, input: DisplayPlanInput) {
    if (this.stopped) return;
    this.now = frame.wallTimeMs;
    if (this.resourceId !== frame.resourceId || this.epoch !== frame.epoch) {
      this.generation++; this.active.clear(); this.scheduler.dispose();
      this.resourceId = frame.resourceId; this.epoch = frame.epoch;
    }
    const snapshot = this.planner.update(input);
    this.captureOutcomes(snapshot);
    for (const id of this.beforeDispatch?.(snapshot, frame) ?? [])
      if (this.previewExcluded.size < 20000) this.previewExcluded.add(keyOf(frame.resourceId, frame.epoch, id));
      else this.truncated = true;
    this.valid = input.contextValid && input.contentActive && input.commentsVisible !== false && !input.seeking;
    // A partial transaction cannot replace the last committed subscription basis.
    const sources = new Map((input.complete ? frame.sources : [...this.active.values()]).map(source => [source.id, source]));
    this.active.clear();
    for (const event of snapshot.events) if (event.epoch === this.epoch && event.state === 'frozen' && event.needsTranslation) {
      const source = sources.get(event.id);
      if (this.valid && !this.previewExcluded.has(keyOf(frame.resourceId, frame.epoch, event.id)) &&
          source?.originalText === event.originalText && source.mediaTimeMs > frame.clock.mediaTimeMs) this.active.set(event.id, source);
    }
    const scope = `display-plan:${this.epoch}`;
    // Hold dispatch while atomically replacing this experiment's selected sources.
    this.scheduler.snapshot(frame.resourceId, scope, { ...frame.clock, seeking: true }, undefined, frame.epoch);
    this.scheduler.updateSources([...this.active.values()], [], true, true);
    this.scheduler.snapshot(frame.resourceId, scope, { ...frame.clock, contentActive: this.valid }, undefined, frame.epoch);
  }
  private captureOutcomes(snapshot: ReturnType<DisplayPlanner['snapshot']>) {
    for (const event of snapshot.events) {
      const key = keyOf(event.resourceId, event.epoch, event.id);
      if (event.state === 'frozen' || this.outcomes.has(key)) continue;
      if (this.outcomes.size >= 20000) { this.truncated = true; continue; }
      this.outcomes.set(key, { key, id: event.id, epoch: event.epoch, state: event.state, mediaTimeMs: event.mediaTimeMs,
        checkedAtMs: this.now, result: event.state === 'revoked' ? 'revoked' : event.state === 'missed' ? 'missed'
          : !event.needsTranslation ? 'no-translation-needed' : this.prepared.has(key) ? 'simulation-ready' : 'simulation-late-or-missing',
        submittedBeforeRevocation: event.state === 'revoked' && this.submitted.has(key) });
    }
  }
  configure(limit: number) { this.planner.configure({ limit }); }
  snapshot() { return this.planner.snapshot(); }
  resume(settings: Settings) {
    this.settings = { ...settings, enabled: true, displayMode: 'translated', translationScope: 'window', prefetchSeconds: 10 };
    this.scheduler.configure(this.settings); this.stopped = false;
    this.planner.configure({});
  }
  report(includeText = false) {
    const snapshot = this.planner.snapshot();
    const events = snapshot.events.map(({ originalText, ...event }) => ({ ...event, ...(includeText ? { originalText } : {}) }));
    return { ...snapshot, events, drafts: includeText ? snapshot.drafts : undefined,
      configuration: { backend: this.settings.backend, sourceLanguage: this.settings.sourceLanguage,
        targetLanguage: this.settings.targetLanguage, batchSize: this.settings.batchSize,
        videoBatchSize: this.settings.videoBatchSize, concurrency: this.settings.concurrency,
        localConcurrency: this.settings.localConcurrency, translationScope: this.settings.translationScope,
        prefetchSeconds: this.settings.prefetchSeconds, provider: 'isolated-memory', delayMs: this.delayMs,
        cache: { scope: 'independent-session-memory', maxEntries: 4000, maxBytes: 2 * 1024 * 1024 } },
      subscriptions: this.subscriptions.size, activeSubscriptions: this.active.size,
      simulatedProviderCalls: this.providerCalls, simulatedProviderInputs: this.providerInputs,
      orphanInputs: this.orphanInputs, lateResults: this.lateResults, engine: this.engine.stats(), scheduler: this.scheduler.getStats(),
      previewExcludedSubscriptions: this.previewExcluded.size,
      previewExcludedAfterSubmission: [...this.previewExcluded].filter(key => this.submitted.has(key)).length,
      outcomes: [...this.outcomes.values()], submittedSubscriptions: this.submitted.size,
      providerInputLog: this.inputLog.map(({ originalText, ...row }) => ({ ...row, ...(includeText ? { originalText } : {}) })),
      requestLog: this.requestLog.map(({ originalText, ...row }) => ({ ...row, ...(includeText ? { originalText } : {}) })),
      truncated: this.truncated || snapshot.truncated };
  }
  stop(reason: string) {
    this.planner.stop(reason); this.captureOutcomes(this.planner.snapshot()); this.stopped = true; this.valid = false;
    this.generation++; this.active.clear(); this.scheduler.dispose();
    if (reason === 'invalidated') this.engine.dispose();
  }
}

/** A B-only subscription lane. Translation and provider accounting remain in the trusted background. */
class LivePlan {
  readonly planner: DisplayPlanner;
  readonly scheduler: VideoScheduler;
  private settings: Settings;
  private frame?: DisplayPlanFrame;
  private active = new Map<string, SourceMessage>();
  private excluded = new Set<string>();
  private subscribed = new Set<string>();
  private submitted = new Set<string>();
  private previewReady = new Set<string>();
  private outputs = new Map<string, LivePlanOutput & { requestId: string }>();
  private outcomes = new Map<string, Record<string, unknown>>();
  private requestLog: Record<string, unknown>[] = [];
  private readyLog: Record<string, unknown>[] = [];
  private requestIds = new Map<AbortSignal, string>();
  private generation = 0;
  private sequence = 0;
  private now = 0;
  private valid = false;
  private supplyStopped = false;
  private truncated = false;
  private readonly sessionId = crypto.randomUUID();
  private readonly options: DisplayPlanSessionOptions;
  get budgetFull() { return this.subscribed.size >= 20000 || this.submitted.size >= 20000 ||
    this.outcomes.size >= 20000 || this.requestLog.length >= 20000 || this.readyLog.length >= 20000; }
  constructor(limit: number, settings: Settings, options: DisplayPlanSessionOptions) {
    this.settings = settings;
    this.options = options;
    this.planner = new DisplayPlanner({ limit });
    this.scheduler = new VideoScheduler({ settings, now: () => this.now, reset: () => {},
      cancelItems: (signal, ids) => {
        const requestId = this.requestIds.get(signal);
        if (requestId) options.live!.cancelItems?.(requestId, ids);
      },
      prepared: items => {
        for (const item of items) {
          const event = this.planner.snapshot().events.find(row => row.id === item.id &&
            row.epoch === this.frame?.epoch && row.resourceId === this.frame?.resourceId);
          const output = this.outputs.get(item.id), frame = this.frame;
          if (!frame || !event || !output || !this.sendable(event, false) ||
              output.text !== item.text || this.active.get(item.id)?.originalText !== item.originalText) continue;
          const key = keyOf(event.resourceId, event.epoch, event.id);
          if (this.previewReady.has(key)) continue;
          this.previewReady.add(key);
          const outcome = this.outcomes.get(key);
          if (outcome) outcome.result = 'preview-ready';
          if (this.readyLog.length < 20000) this.readyLog.push({ key, id: event.id, sourceId: event.sourceId,
            resourceId: event.resourceId, epoch: event.epoch, mediaTimeMs: event.mediaTimeMs,
            requestId: output.requestId, runId: output.preview?.runId,
            instanceId: output.preview?.instanceId, configIdentity: output.preview?.configIdentity,
            taskId: output.preview?.taskId ?? output.taskId, resultId: output.preview?.resultId ?? output.resultId,
            kind: output.preview?.kind, source: output.source, status: output.status, previewReadyAtMs: performance.now(),
            originalText: event.originalText, translatedText: output.text });
          else this.truncated = true;
          options.live!.onReady?.(output, event, frame);
        }
      },
      request: async (resourceId, items, signal, _priority, onResult) => {
        const frame = this.frame;
        if (!frame || signal.aborted || this.supplyStopped) return [];
        const generation = this.generation;
        const demand = new Map(this.currentDemand().map(row => [row.id, row]));
        const valid = items.filter(item => demand.get(item.id)?.originalText === item.text);
        if (!valid.length) return [];
        const requestId = `${this.sessionId}:${++this.sequence}`;
        this.requestIds.set(signal, requestId);
        for (const item of valid) {
          const key = keyOf(resourceId, frame.epoch, item.id);
          this.submitted.add(key);
          if (this.requestLog.length < 20000) this.requestLog.push({ requestId, key, id: item.id,
            sourceId: demand.get(item.id)!.sourceId, resourceId, epoch: frame.epoch,
            mediaTimeMs: demand.get(item.id)!.mediaTimeMs, requestedAtMs: performance.now(),
            originalText: item.text });
          else this.truncated = true;
        }
        const apply = (output: LivePlanOutput) => {
          if (generation !== this.generation || signal.aborted || !valid.some(item =>
              item.id === output.id && item.text === this.active.get(item.id)?.originalText &&
              (!output.preview || output.preview.requestId === requestId &&
                output.preview.originalText === item.text))) return;
          this.outputs.set(output.id, { ...output, requestId });
          onResult(output);
        };
        try {
          const results = await options.live!.translate({ resourceId, epoch: frame.epoch, requestId,
            items: valid, signal, onResult: apply });
          const accepted = results.filter(output => generation === this.generation && !signal.aborted &&
            valid.some(item => item.id === output.id && item.text === this.active.get(item.id)?.originalText &&
              (!output.preview || output.preview.requestId === requestId &&
                output.preview.originalText === item.text)));
          for (const output of accepted) this.outputs.set(output.id, { ...output, requestId });
          return accepted;
        } finally { this.requestIds.delete(signal); }
      },
    });
  }
  private sendable(event: DisplayPlanEvent, requireFuture: boolean): boolean {
    const frame = this.frame, clock = this.options.getCurrentClock?.();
    return !this.supplyStopped && this.valid && !!frame && !!clock && frame.contextValid &&
      frame.resourceId === event.resourceId && frame.epoch === event.epoch &&
      (event.state === 'frozen' || !requireFuture && event.state === 'due') &&
      clock.contentActive && !clock.paused && !clock.seeking && clock.commentsVisible !== false &&
      (!requireFuture || event.mediaTimeMs > clock.mediaTimeMs) &&
      this.options.getSendable?.(event, frame) === true &&
      this.options.canRequest?.(event, frame) !== false;
  }
  currentDemand(): LivePlanDemand[] {
    if (this.supplyStopped) return [];
    return this.planner.snapshot().events.filter(event => {
      const source = this.active.get(event.id);
      return this.sendable(event, true) && source?.sourceId === event.sourceId &&
        source.resourceId === event.resourceId && source.originalText === event.originalText &&
        source.mediaTimeMs === event.mediaTimeMs &&
        !this.excluded.has(keyOf(event.resourceId, event.epoch, event.id));
    })
      .map(({ id, sourceId, originalText, mediaTimeMs, resourceId, epoch }) =>
        ({ id, sourceId, originalText, mediaTimeMs, resourceId, epoch }));
  }
  update(frame: DisplayPlanFrame, input: DisplayPlanInput) {
    if (this.supplyStopped) return;
    this.frame = frame; this.now = frame.wallTimeMs;
    if (this.planner.snapshot().resourceId !== frame.resourceId || this.planner.snapshot().epoch !== frame.epoch) {
      this.generation++; this.active.clear(); this.outputs.clear(); this.scheduler.dispose();
    }
    const snapshot = this.planner.update(input);
    this.captureOutcomes(snapshot);
    for (const id of this.options.beforeDispatch?.(snapshot, frame) ?? []) {
      if (this.excluded.size < 20000) this.excluded.add(keyOf(frame.resourceId, frame.epoch, id));
      else this.truncated = true;
    }
    this.valid = input.contextValid && input.contentActive && !input.paused && !input.seeking &&
      input.commentsVisible !== false;
    const sources = new Map((input.complete ? frame.sources : [...this.active.values()]).map(source => [source.id, source]));
    const previousActive = new Map(this.active);
    this.active.clear();
    for (const event of snapshot.events) if (event.epoch === frame.epoch &&
        (event.state === 'frozen' || event.state === 'due' && previousActive.has(event.id)) &&
        event.needsTranslation &&
        !this.excluded.has(keyOf(frame.resourceId, frame.epoch, event.id))) {
      const source = sources.get(event.id);
      if (source?.sourceId === event.sourceId && source.resourceId === event.resourceId &&
          source.originalText === event.originalText && source.mediaTimeMs === event.mediaTimeMs &&
          this.sendable(event, event.state === 'frozen')) {
        this.active.set(event.id, source);
        if (event.state === 'frozen') this.subscribed.add(keyOf(frame.resourceId, frame.epoch, event.id));
      }
    }
    const scope = `display-plan-live:${frame.epoch}`;
    this.scheduler.snapshot(frame.resourceId, scope, { ...frame.clock, seeking: true }, undefined, frame.epoch);
    this.scheduler.updateSources([...this.active.values()], [], true, true);
    this.scheduler.snapshot(frame.resourceId, scope, { ...frame.clock, contentActive: this.valid,
      paused: frame.clock.paused || !this.valid }, undefined, frame.epoch);
  }
  private captureOutcomes(snapshot: ReturnType<DisplayPlanner['snapshot']>) {
    for (const event of snapshot.events) {
      const key = keyOf(event.resourceId, event.epoch, event.id);
      if (event.state === 'frozen' || this.outcomes.has(key)) continue;
      if (this.outcomes.size >= 20000) { this.truncated = true; continue; }
      this.outcomes.set(key, { key, id: event.id, sourceId: event.sourceId, epoch: event.epoch,
        mediaTimeMs: event.mediaTimeMs, state: event.state, checkedAtMs: this.now,
        result: this.previewReady.has(key) ? 'preview-ready' : this.submitted.has(key) ? 'not-ready-after-request'
          : event.needsTranslation ? 'no-request' : 'no-translation-needed' });
    }
  }
  feedAfterSupplyStopped(frame: DisplayPlanFrame) {
    this.frame = frame;
    this.options.beforeDispatch?.(this.planner.snapshot(), frame);
  }
  configure(limit: number) { this.planner.configure({ limit }); }
  snapshot() { return this.planner.snapshot(); }
  resume(settings: Settings) {
    if (this.supplyStopped) throw new Error('display-plan-live-supply-stopped');
    this.settings = liveSettings(settings); this.scheduler.configure(this.settings);
    this.planner.configure({});
  }
  stopSupply(reason: string) {
    if (this.supplyStopped) return;
    this.supplyStopped = true; this.generation++; this.valid = false;
    this.active.clear(); this.outputs.clear(); this.scheduler.dispose();
    this.supplyStopReason = reason;
  }
  private supplyStopReason = '';
  report(includeText = false) {
    const snapshot = this.planner.snapshot();
    const events = snapshot.events.map(({ originalText, ...event }) => ({ ...event, ...(includeText ? { originalText } : {}) }));
    const redact = (rows: Record<string, unknown>[]) => rows.map(({ originalText, translatedText, ...row }) =>
      ({ ...row, ...(includeText ? { originalText, translatedText } : {}) }));
    return { ...snapshot, events, drafts: includeText ? snapshot.drafts : undefined,
      evidence: 'display-plan-live-background-translation', supplyStopped: this.supplyStopped,
      supplyStopReason: this.supplyStopReason,
      configuration: { backend: this.settings.backend, sourceLanguage: this.settings.sourceLanguage,
        targetLanguage: this.settings.targetLanguage, concurrency: this.settings.concurrency,
        localConcurrency: this.settings.localConcurrency, translationScope: this.settings.translationScope,
        prefetchSeconds: this.settings.prefetchSeconds, provider: 'trusted-background-transport' },
      subscriptions: this.subscribed.size, activeSubscriptions: this.currentDemand().length,
      transportSubmittedSubscriptions: this.submitted.size, previewReadyCount: this.previewReady.size,
      transportRequestLog: redact(this.requestLog), previewReadyLog: redact(this.readyLog),
      outcomes: [...this.outcomes.values()], scheduler: this.scheduler.getStats(),
      previewExcludedSubscriptions: this.excluded.size, truncated: this.truncated || snapshot.truncated };
  }
  stop(reason: string) {
    this.stopSupply(reason); this.planner.stop(reason); this.captureOutcomes(this.planner.snapshot());
  }
}

/** Explicitly started page-local planner. The optional live lane delegates translation to the background. */
export class DisplayPlanSession {
  private a?: PlanSimulation;
  private b: PlanSimulation | LivePlan;
  private live: boolean;
  private range: { startMs: number; endMs: number };
  private supplyStopped = false;
  private supplyStopReason = '';
  private lastFrame?: DisplayPlanFrame;
  private recorded = new Map<string, string>();
  private frames: Record<string, unknown>[] = [];
  private traceBytes = 0;
  private traceTruncated = false;
  private stopped = false;
  private stopReason = '';
  private startedAt: number;
  private settings: Settings;
  get running() { return !this.stopped; }
  constructor(settings: Settings, options: DisplayPlanSessionOptions = {}) {
    this.live = !!options.live;
    this.range = options.range ?? LIVE_RANGE;
    if (this.live && (!options.getCurrentClock || !options.getSendable))
      throw new Error('display-plan-live-current-clock-and-sendability-required');
    if (this.live && (!Number.isFinite(this.range.startMs) || !Number.isFinite(this.range.endMs) ||
        this.range.startMs < 0 || this.range.endMs <= this.range.startMs))
      throw new RangeError('invalid-display-plan-live-range');
    if (this.live && options.comparison === true) throw new Error('display-plan-live-must-be-B-only');
    if (this.live && options.limit !== undefined && options.limit !== 2)
      throw new Error('display-plan-live-fixed-density-two');
    this.settings = this.live ? liveSettings(settings) : settings;
    this.startedAt = options.now ?? performance.now();
    if (!this.live && options.comparison !== false) this.a = new PlanSimulation(null, settings, options.delayMs ?? 0);
    this.b = this.live ? new LivePlan(2, this.settings, options)
      : new PlanSimulation(options.limit ?? 2, settings, options.delayMs ?? 0, options.beforeDispatch);
  }
  update(frame: DisplayPlanFrame) {
    if (this.stopped) return;
    if (this.live && frame.clock.mediaTimeMs >= this.range.endMs) this.stopSupply('range-ended');
    if (this.supplyStopped) {
      this.lastFrame = frame;
      (this.b as LivePlan).feedAfterSupplyStopped(frame);
      return;
    }
    if (this.live && frame.clock.mediaTimeMs < this.range.startMs) return;
    // Each update can add at most one bounded source pool. Stop before another
    // update when a side exhausts its record budget; never evict spent quotas.
    if (frame.sources.length > 20000 || this.a?.budgetFull || this.b.budgetFull) {
      this.traceTruncated = true; this.stop('record-budget-exhausted'); return;
    }
    const candidates = candidateRows(frame, this.settings).filter(row => !this.live ||
      row.mediaTimeMs >= this.range.startMs && row.mediaTimeMs < this.range.endMs);
    const input: DisplayPlanInput = { ...frame.clock, resourceId: frame.resourceId, epoch: frame.epoch, wallTimeMs: frame.wallTimeMs,
      commentsVisible: frame.clock.commentsVisible ?? null, sourceRevision: frame.sourceRevision, ruleRevision: frame.ruleRevision,
      complete: frame.complete, contextValid: frame.contextValid, candidates };
    this.record(frame, input);
    if (this.traceTruncated) { this.stop('input-trace-budget-exhausted'); return; }
    this.lastFrame = frame; this.a?.update(frame, input); this.b.update(frame, input);
  }
  private record(frame: DisplayPlanFrame, input: DisplayPlanInput) {
    if (this.traceTruncated) return;
    if (frame.epoch !== this.lastFrame?.epoch || frame.resourceId !== this.lastFrame?.resourceId) this.recorded.clear();
    const next = new Map<string, string>(), upserts: DisplayPlanCandidate[] = [];
    for (const row of input.candidates) {
      const encoded = JSON.stringify(row); next.set(row.id, encoded);
      if (this.recorded.get(row.id) !== encoded) upserts.push(row);
    }
    const removes = [...this.recorded.keys()].filter(id => !next.has(id));
    const { candidates: _, ...clock } = input;
    const entry = { ...clock, upserts, removes, observedCandidates: frame.sources.length,
      reset: frame.epoch !== this.lastFrame?.epoch || frame.resourceId !== this.lastFrame?.resourceId };
    const bytes = new TextEncoder().encode(JSON.stringify(entry)).length;
    if (this.frames.length >= 1000 || this.traceBytes + bytes > 8 * 1024 * 1024) { this.traceTruncated = true; return; }
    this.frames.push(entry); this.traceBytes += bytes; this.recorded = next;
  }
  configure(limit: number) {
    if (this.live) {
      if (limit !== 2) throw new Error('display-plan-live-fixed-density-two');
      return;
    }
    this.b.configure(limit); if (this.lastFrame) this.update(this.lastFrame);
  }
  currentDemand(): LivePlanDemand[] { return this.live ? (this.b as LivePlan).currentDemand() : []; }
  stopSupply(reason = 'supply-stopped') {
    if (!this.live) throw new Error('display-plan-stop-supply-requires-live');
    if (this.supplyStopped || this.stopped) return;
    this.supplyStopped = true; this.supplyStopReason = reason;
    (this.b as LivePlan).stopSupply(reason);
  }
  resume(settings: Settings) {
    if (this.traceTruncated) throw new Error('display-plan-record-budget-exhausted');
    if (this.supplyStopped) throw new Error('display-plan-live-supply-stopped');
    this.settings = this.live ? liveSettings(settings) : settings;
    this.stopped = false; this.stopReason = '';
    this.a?.resume(settings); this.b.resume(settings);
  }
  view() {
    const report = this.b.snapshot(), events = report.events;
    return { enabled: !this.stopped, connected: !!this.lastFrame?.contextValid, resourceId: this.lastFrame?.resourceId ?? '',
      status: this.stopped ? 'stopped' : this.supplyStopped ? 'draining' :
        !this.lastFrame?.contextValid ? 'snapshot-invalid' : !this.lastFrame?.complete ? 'waiting-transaction' : 'preview',
      stopReason: this.stopped ? this.stopReason : this.supplyStopReason,
      parameters: report.parameters, frozenBuckets: report.totals.frozenBuckets,
      selected: report.totals.selected, translationNeeded: report.totals.needsTranslation,
      unknown: report.totals.unknown, reasons: report.reasons, truncated: report.truncated || this.traceTruncated,
      error: this.traceTruncated ? this.stopReason : undefined,
      upcoming: events.filter(row => row.state === 'frozen' && row.epoch === this.lastFrame?.epoch)
        .sort((a, b) => a.mediaTimeMs - b.mediaTimeMs).slice(0, 8)
        .map(row => ({ id: row.id, originalText: row.originalText ?? '', mediaTimeMs: row.mediaTimeMs, unknown: row.unknown, needsTranslation: row.needsTranslation })) };
  }
  report(includeText = false) {
    return { evidence: this.live ? 'display-plan-live-background-translation' : 'display-plan-memory-provider-only',
      startedAt: this.startedAt, stopped: this.stopped, stopReason: this.stopReason,
      ...(this.live ? { supplyStopped: this.supplyStopped, range: this.range } : {}),
      limits: { inputFrames: 1000, inputBytes: 8 * 1024 * 1024, sourcePool: 20000, sideRecords: 40000 },
      lastClock: this.lastFrame?.clock, resourceId: this.lastFrame?.resourceId, epoch: this.lastFrame?.epoch,
      ...(this.a ? { A: this.a.report(includeText) } : {}), B: this.b.report(includeText), inputFrames: includeText ? this.frames : undefined,
      inputFrameCount: this.frames.length, inputBytes: this.traceBytes, inputTruncated: this.traceTruncated,
      ...(!this.live ? { actualModelCalls: 0 } : {}),
      modelLoads: 0, nativeSettingsWrites: 0, adapterPrepared: 0 };
  }
  stop(reason = 'stopped') { if (!this.stopped || reason === 'invalidated') { this.stopped = true; this.stopReason = reason; this.a?.stop(reason); this.b.stop(reason); } }
}
