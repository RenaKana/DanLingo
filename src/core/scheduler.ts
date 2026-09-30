import type { PlaybackClock, Settings, SourceMessage, TranslationOutput } from './types.ts';
import { needsTranslation } from './messages.ts';
import { sameSource } from './source-stream.ts';
import { protectText, placeholdersIntact } from '../translation/text.ts';
import { localGenerationProfile, normalizeReasoningEffort, providerTimeoutMs } from './config.ts';
import { resolveConnection } from './connection.ts';
import { localPromptMode, localQualityIssue } from '../translation/local-policy.ts';
import { videoBatchLimit, type VideoEligibilityUpdate } from './video-policy.ts';
import type { BilibiliShadowSelection, BilibiliShadowUpdate } from './bilibili-shadow.ts';

export type VideoPriority = 'near' | 'buffered' | 'background';
export interface DueItem { id: string; text: string; remainingMs: number;
  sourceId?: string; epoch?: number; predictionEpoch?: number; ruleRevision?: number;
  deadlineAtEpochMs?: number; configIdentity?: string }
export interface NativeDemand { id: string; sourceId: string; originalText: string; mediaTimeMs: number;
  deadlineAtEpochMs: number; epoch: number; predictionEpoch: number; ruleRevision: number }
export interface PreparedVideoItem { id: string; text: string; originalText: string;
  sourceId?: string; status?: 'translated' | 'cached'; epoch?: number;
  predictionEpoch?: number; ruleRevision?: number; deadlineAtEpochMs?: number; configIdentity?: string }
export interface VideoUserFilterUpdate {
  epoch: number;
  revision: number;
  reset: boolean;
  items: { id: string; originalText: string; state: 'exclude' | 'retain' | 'unknown' }[];
}
type SkipReason = 'special' | 'language' | 'emoticon';
export interface SchedulerStats {
  total: number; candidates: number; filtered: number; eligibilityUnknown: number; effectiveScope: 'all' | 'window';
  displayState: 'visible' | 'hidden' | 'unknown'; skipped: Record<SkipReason, number>;
  messages: number; translated: number; cacheHits: number; queued: number; inflight: number;
  failed: number; expired: number; nearTotal: number; nearPrepared: number; sourceComplete: boolean;
}
interface Options {
  settings: Settings;
  request: (resourceId: string, items: DueItem[], signal: AbortSignal, priority: VideoPriority,
    onResult: (output: TranslationOutput) => void) => Promise<TranslationOutput[]>;
  prepared: (items: PreparedVideoItem[]) => void;
  reset: () => void;
  removed?: (ids: string[]) => void;
  cancelItems?: (signal: AbortSignal, ids: string[]) => void;
  status?: (stats: SchedulerStats) => void;
  now?: () => number;
  nowEpochMs?: () => number;
}
export function translationIdentity(settings: Settings): string {
  const provider = settings.backend === 'local'
    ? ['local', settings.localModelId, settings.model, settings.profile, settings.sourceLanguage, settings.targetLanguage,
      localPromptMode(settings), settings.localPerformance?.languageValidation ?? 'strict', localGenerationProfile(settings)]
    : [settings.endpoint.trim() ? resolveConnection(settings).configuredCompletionEndpoint : '', settings.model, settings.profile,
      settings.sourceLanguage, settings.targetLanguage, normalizeReasoningEffort(settings, settings.thinkingEffort)];
  const hybrid = settings.bilibiliOwnedRelease && settings.bilibiliHybrid?.enabled
    ? [settings.bilibiliHybrid, settings.localModelId, settings.localPerformance, settings.localConcurrency,
      settings.endpoint, settings.model, settings.profile, settings.thinkingEffort, settings.onlineConcurrency] : undefined;
  return JSON.stringify([provider, settings.enabled, settings.displayMode, ...(hybrid ? [hybrid] : [])]);
}
export function videoPriority(m: SourceMessage, c: PlaybackClock, urgentSeconds: number): VideoPriority {
  if (m.mediaTimeMs >= c.mediaTimeMs - 5000 && m.renderAtMs <= c.mediaTimeMs + urgentSeconds * 1000) return 'near';
  if (c.buffered?.some(r => m.mediaTimeMs >= r.startMs && m.mediaTimeMs <= r.endMs)) return 'buffered';
  return 'background';
}

/** Video-scoped preparation survives seeking; only the native renderer decides display. */
export class VideoScheduler {
  private settings: Settings;
  private resourceId = '';
  private scope = '';
  private version = 0;
  private clock: PlaybackClock | null = null;
  private sampledAt = 0;
  private sources = new Map<string, SourceMessage>();
  private eligible = new Set<string>();
  private skipped = new Map<string, SkipReason>();
  private pending = new Map<string, AbortController>();
  private ready = new Map<string, { text: string; cached: boolean; status: 'translated' | 'cached';
    epoch?: number; predictionEpoch?: number; ruleRevision?: number; deadlineAtEpochMs?: number }>();
  private published = new Set<string>();
  private failures = new Set<string>();
  private retryAt = new Map<string, number>();
  private requests = new Map<AbortController, SourceMessage[]>();
  private sourceComplete = false;
  private epoch = 0;
  private eligibilityRevision = -1;
  private capability: VideoEligibilityUpdate['capability'] = 'unknown';
  private display: VideoEligibilityUpdate['display'] = 'unknown';
  private eligibility = new Map<string, { originalText: string; state: VideoEligibilityUpdate['items'][number]['state'] }>();
  private userFilterRevision = -1;
  private shadowRevision = -1;
  private shadowAt = -Infinity;
  private shadowKnown = false;
  private shadowSuspended = false;
  private shadowSelected = new Map<string, BilibiliShadowSelection>();
  private shadowPredictionEpoch = -1;
  private shadowRuleRevision = -1;
  private closedNative = new Map<string, { originalText: string; epoch: number; predictionEpoch: number }>();
  private attemptedNative = new Set<string>();
  private userFilter = new Map<string, { originalText: string; state: VideoUserFilterUpdate['items'][number]['state'] }>();
  private readonly now: () => number;
  private readonly nowEpochMs: () => number;
  private options: Options;
  constructor(options: Options) { this.options = options; this.settings = options.settings;
    this.now = options.now ?? (() => performance.now());
    this.nowEpochMs = options.nowEpochMs ?? (() => performance.timeOrigin + performance.now()); }
  private get strictBilibili(): boolean {
    return this.settings.bilibiliNativeTranslationOnly === true || this.settings.bilibiliOwnedRelease === true;
  }
  snapshot(resourceId: string, scope: string, clock: PlaybackClock, sources?: SourceMessage[], epoch = 0): void {
    if (scope !== this.scope || resourceId !== this.resourceId) {
      this.dispose(); this.scope = scope; this.resourceId = resourceId;
    }
    if (epoch < this.epoch) return;
    if (epoch !== this.epoch) {
      if (this.strictBilibili) {
        this.invalidate(); this.closedNative.clear(); this.attemptedNative.clear();
      }
      this.epoch = epoch; this.eligibilityRevision = -1; this.capability = 'unknown'; this.display = 'unknown';
      this.eligibility.clear(); this.userFilterRevision = -1; this.userFilter.clear();
      this.clearShadow();
    }
    if (clock.commentsVisible !== undefined) this.display = clock.commentsVisible ? 'visible' : 'hidden';
    else if (this.eligibilityRevision < 0) this.display = 'unknown';
    this.clock = clock; this.sampledAt = this.now();
    if (sources) this.updateSources(sources, [], true, true);
    else this.tick();
  }
  updateEligibility(update: VideoEligibilityUpdate): void {
    if (update.epoch !== this.epoch || update.revision <= this.eligibilityRevision) return;
    this.eligibilityRevision = update.revision;
    if (update.reset) this.eligibility.clear();
    this.capability = update.capability; this.display = update.display;
    for (const item of update.items) {
      const source = this.sources.get(item.id);
      if (source && source.originalText === item.originalText) {
        this.eligibility.set(item.id, { originalText: item.originalText, state: item.state });
      }
    }
    this.tick();
  }
  updateUserFilter(update: VideoUserFilterUpdate): void {
    if (!this.applyUserFilter(update)) return;
    this.tick();
  }
  updateShadow(update: BilibiliShadowUpdate): void {
    if ((update.policy === 'owned') !== (this.settings.bilibiliOwnedRelease === true)) return;
    if (update.epoch !== this.epoch || update.revision <= this.shadowRevision) return;
    const strict = this.strictBilibili;
    const validStrict = Number.isSafeInteger(update.predictionEpoch) && update.predictionEpoch! >= 0 &&
      Number.isSafeInteger(update.ruleRevision) && update.ruleRevision! >= 0 &&
      Number.isFinite(update.sampledAtEpochMs) && update.sampledAtEpochMs! > 0 &&
      Number.isFinite(update.playbackRate) && update.playbackRate! > 0 &&
      update.items.every(item => typeof item.sourceId === 'string' && !!item.sourceId &&
        Number.isFinite(item.stimeMs) && Number.isFinite(item.deadlineAtEpochMs) &&
        item.deadlineAtEpochMs! > update.sampledAtEpochMs! && Array.isArray(item.reasons));
    if (strict && this.shadowRevision >= 0 &&
        (update.predictionEpoch !== this.shadowPredictionEpoch || update.ruleRevision !== this.shadowRuleRevision))
      // Resume/rule changes retire forecast subscriptions, not the resource
      // session that owns the experiment permit and MAIN-world control lease.
      this.invalidate(false);
    this.shadowRevision = update.revision; this.shadowAt = this.now();
    this.shadowPredictionEpoch = validStrict ? update.predictionEpoch! : -1;
    this.shadowRuleRevision = validStrict ? update.ruleRevision! : -1;
    this.shadowKnown = update.active && update.known && (!strict || validStrict);
    this.shadowSuspended = update.policy === 'owned' && update.suspended === true;
    const next = new Map((this.shadowKnown ? update.items : []).map(item => [item.id, item]));
    if (strict) {
      const removed: string[] = [];
      for (const [id, value] of this.ready) {
        const selection = next.get(id);
        // The estimate expires demand, not an already published display result.
        // MAIN closes the event at its actual synchronous adoption opportunity.
        if (!this.shadowKnown || !this.sources.has(id) || value.epoch !== this.epoch ||
          selection && selection.originalText !== this.sources.get(id)?.originalText ||
          value.predictionEpoch !== this.shadowPredictionEpoch || value.ruleRevision !== this.shadowRuleRevision) {
          this.ready.delete(id); this.published.delete(id); removed.push(id);
        }
      }
      if (removed.length) this.options.removed?.(removed);
    }
    this.shadowSelected = next;
    this.tick();
  }
  /** The actual MAIN-world adoption boundary is terminal for this playback event. */
  closeNativeEvent(id: string, originalText: string, epoch: number, predictionEpoch: number, _reason: string): boolean {
    const source = this.sources.get(id);
    if (!this.strictBilibili || epoch !== this.epoch ||
        !id || !originalText || !Number.isSafeInteger(predictionEpoch) || predictionEpoch < 0 ||
        source && source.originalText !== originalText ||
        this.closedNative.has(id)) return false;
    this.closedNative.set(id, { originalText, epoch, predictionEpoch });
    this.ready.delete(id); this.published.delete(id);
    this.options.removed?.([id]); this.tick();
    return true;
  }
  /** Effective, unclosed subscriptions for the guarded background dispatch. */
  currentNativeDemand(): NativeDemand[] {
    if (!this.strictBilibili || !this.settings.enabled ||
        this.settings.displayMode === 'original' || !this.clock?.contentActive || this.clock.seeking ||
        this.display === 'hidden') return [];
    const c = this.currentClock();
    if (!c) return [];
    return [...this.eligible].flatMap(id => {
      const m = this.sources.get(id), selection = this.shadowSelected.get(id);
      if (!m || !selection || !this.inScope(m, c)) return [];
      return [{ id, sourceId: m.sourceId, originalText: m.originalText, mediaTimeMs: m.mediaTimeMs,
        deadlineAtEpochMs: selection.deadlineAtEpochMs!, epoch: this.epoch,
        predictionEpoch: this.shadowPredictionEpoch, ruleRevision: this.shadowRuleRevision }];
    });
  }
  private clearShadow(): void {
    this.shadowRevision = -1; this.shadowAt = -Infinity; this.shadowKnown = false;
    this.shadowSuspended = false;
    this.shadowPredictionEpoch = -1; this.shadowRuleRevision = -1; this.shadowSelected.clear();
  }
  private applyUserFilter(update: VideoUserFilterUpdate): boolean {
    if (update.epoch !== this.epoch || update.revision < this.userFilterRevision ||
        (update.revision === this.userFilterRevision && update.reset)) return false;
    const affected = update.reset ? [...this.sources.values()] : update.items.flatMap(item => {
      const source = this.sources.get(item.id);
      return source?.originalText === item.originalText ? [source] : [];
    });
    const previouslyExcluded = new Set(affected.filter(m => this.userFilterState(m) === 'exclude').map(m => m.id));
    this.userFilterRevision = update.revision;
    if (update.reset) this.userFilter.clear();
    for (const item of update.items) {
      const source = this.sources.get(item.id);
      if (source?.originalText === item.originalText) {
        this.userFilter.set(item.id, { originalText: item.originalText, state: item.state });
      }
    }
    const newlyExcluded = affected.filter(m => !previouslyExcluded.has(m.id) && this.userFilterState(m) === 'exclude')
      .map(m => m.id);
    for (const id of newlyExcluded) this.published.delete(id);
    if (newlyExcluded.length) this.options.removed?.(newlyExcluded);
    return true;
  }
  updateSources(upserts: SourceMessage[], removes: string[], reset = false, complete = false,
    userFilter?: VideoUserFilterUpdate): void {
    if (reset) {
      const incoming = new Set(upserts.map(m => m.id));
      removes = [...this.sources.keys()].filter(id => !incoming.has(id));
      this.sourceComplete = false;
    }
    for (const id of removes) this.remove(id);
    const changed: string[] = [];
    for (const m of upserts) {
      const old = this.sources.get(m.id);
      if (old && sameSource(old, m)) continue;
      this.remove(m.id); changed.push(m.id); this.sources.set(m.id, m);
      this.classify(m);
    }
    if (removes.length || changed.length) this.options.removed?.([...removes, ...changed]);
    this.sourceComplete = complete;
    if (userFilter) this.applyUserFilter(userFilter);
    this.tick();
  }
  private remove(id: string): void {
    this.pending.delete(id);
    this.sources.delete(id); this.eligible.delete(id); this.skipped.delete(id); this.ready.delete(id); this.published.delete(id);
    this.failures.delete(id); this.retryAt.delete(id); this.eligibility.delete(id); this.userFilter.delete(id);
  }
  private classify(m: SourceMessage): void {
    const reason = !m.translatable ? 'special' :
      !needsTranslation(m.originalText, this.settings.targetLanguage, this.settings.sourceLanguage) ? 'language' :
      protectText(m.originalText).reason ? 'emoticon' : null;
    if (reason) this.skipped.set(m.id, reason);
    else this.eligible.add(m.id);
  }
  configure(settings: Settings): void {
    const changed = translationIdentity(this.settings) !== translationIdentity(settings);
    const nativeChanged = this.settings.bilibiliNativeTranslationOnly !== settings.bilibiliNativeTranslationOnly ||
      this.settings.bilibiliOwnedRelease !== settings.bilibiliOwnedRelease;
    if (this.settings.bilibiliShadowScheduler !== settings.bilibiliShadowScheduler || nativeChanged) this.clearShadow();
    this.settings = settings;
    if (changed || nativeChanged) {
      if (changed && settings.bilibiliOwnedRelease) {
        this.clearShadow(); this.closedNative.clear(); this.attemptedNative.clear();
      }
      this.invalidate(); this.eligible.clear(); this.skipped.clear();
      if (nativeChanged) { this.closedNative.clear(); this.attemptedNative.clear(); }
      for (const m of this.sources.values()) this.classify(m);
    }
    this.tick();
  }
  retryFailures(): void {
    for (const id of this.failures) if (!this.attemptedNative.has(id)) this.failures.delete(id);
    for (const id of this.retryAt.keys()) if (!this.attemptedNative.has(id)) this.retryAt.delete(id);
    this.tick();
  }
  dispose(): void {
    this.invalidate(); this.clock = null; this.sources.clear(); this.eligible.clear(); this.skipped.clear();
    this.scope = ''; this.resourceId = ''; this.sourceComplete = false; this.epoch = 0;
    this.eligibilityRevision = -1; this.capability = 'unknown'; this.display = 'unknown'; this.eligibility.clear();
    this.userFilterRevision = -1; this.userFilter.clear();
    this.closedNative.clear(); this.attemptedNative.clear();
    this.clearShadow();
  }
  private invalidate(resetResource = true): void {
    const published = resetResource ? [] : [...this.published];
    this.version++;
    for (const controller of this.requests.keys()) controller.abort();
    this.requests.clear(); this.pending.clear(); this.ready.clear(); this.published.clear(); this.failures.clear(); this.retryAt.clear();
    if (resetResource) this.options.reset();
    else if (published.length) this.options.removed?.(published);
  }
  private currentClock(): PlaybackClock | null {
    if (!this.clock) return null;
    const c = this.clock;
    const suspended = c.paused || this.settings.bilibiliOwnedRelease && this.shadowSuspended;
    return { ...c, mediaTimeMs: c.mediaTimeMs + (suspended || c.seeking || !c.contentActive ? 0 : Math.max(0, this.now() - this.sampledAt) * c.playbackRate) };
  }
  private effectiveScope(): 'all' | 'window' {
    if (this.settings.bilibiliOwnedRelease) return 'window';
    return this.settings.translationScope === 'all' ||
      (this.settings.translationScope === 'auto' && this.capability === 'filtered-pool') ? 'all' : 'window';
  }
  private eligibilityState(m: SourceMessage): VideoEligibilityUpdate['items'][number]['state'] {
    const entry = this.eligibility.get(m.id);
    return entry?.originalText === m.originalText ? entry.state : 'unknown';
  }
  private userFilterState(m: SourceMessage): VideoUserFilterUpdate['items'][number]['state'] {
    const entry = this.userFilter.get(m.id);
    return entry?.originalText === m.originalText ? entry.state : 'unknown';
  }
  private inRange(m: SourceMessage, c: PlaybackClock): boolean {
    if (m.platform === 'bilibili' && (this.settings.bilibiliShadowScheduler || this.strictBilibili))
      return m.mediaTimeMs >= Math.max(0, c.mediaTimeMs - 2000) && m.mediaTimeMs <= c.mediaTimeMs + 5000 * c.playbackRate;
    return this.effectiveScope() === 'all' ||
      (m.mediaTimeMs >= Math.max(0, c.mediaTimeMs - 5000) && m.mediaTimeMs <= c.mediaTimeMs + this.settings.prefetchSeconds * 1000);
  }
  private inScope(m: SourceMessage, c: PlaybackClock): boolean {
    if (m.platform === 'bilibili' && (this.settings.bilibiliShadowScheduler || this.strictBilibili) &&
      (!this.shadowKnown || this.now() - this.shadowAt > 1500 ||
       this.shadowSelected.get(m.id)?.originalText !== m.originalText)) return false;
    if (m.platform === 'bilibili' && this.strictBilibili) {
      const selection = this.shadowSelected.get(m.id);
      if (!selection || selection.sourceId !== m.sourceId || selection.stimeMs !== m.mediaTimeMs ||
          selection.deadlineAtEpochMs! <= this.nowEpochMs() || this.closedNative.has(m.id)) return false;
    }
    const state = this.eligibilityState(m);
    return this.inRange(m, c) && state !== 'filtered' && this.userFilterState(m) !== 'exclude' &&
      (this.settings.translationScope !== 'auto' || this.effectiveScope() !== 'all' || state === 'eligible');
  }
  getStats(): SchedulerStats {
    const c = this.currentClock();
    const stats: SchedulerStats = { total: 0, candidates: this.sources.size, filtered: 0, eligibilityUnknown: 0,
      effectiveScope: this.effectiveScope(), displayState: this.display,
      skipped: { special: 0, language: 0, emoticon: 0 }, messages: 0, translated: 0, cacheHits: 0, queued: 0, inflight: this.requests.size,
      failed: 0, expired: 0, nearTotal: 0, nearPrepared: 0, sourceComplete: this.sourceComplete };
    if (!c) return stats;
    for (const [id, m] of this.sources) {
      if (!this.inRange(m, c)) continue;
      stats.total++;
      const state = this.eligibilityState(m);
      if (state === 'filtered' || this.userFilterState(m) === 'exclude') { stats.filtered++; continue; }
      if (state === 'unknown') stats.eligibilityUnknown++;
      if (!this.inScope(m, c)) continue;
      const skipped = this.skipped.get(id);
      if (skipped) { stats.skipped[skipped]++; continue; }
      stats.messages++;
      const ready = this.ready.get(id);
      if (ready) { stats.translated++; if (ready.cached) stats.cacheHits++; }
      else if (this.failures.has(id)) stats.failed++;
      else stats.queued++;
      if (videoPriority(m, c, this.settings.urgentSeconds) === 'near') { stats.nearTotal++; if (ready) stats.nearPrepared++; }
    }
    return stats;
  }
  tick(): void {
    const c = this.currentClock();
    if (c) for (const [controller, batch] of this.requests) {
      const invalid = batch.filter(m => this.sources.get(m.id) !== m || this.pending.get(m.id) !== controller ||
        m.platform === 'bilibili' && this.settings.bilibiliOwnedRelease &&
          (!c.contentActive || c.seeking || !this.settings.enabled || this.settings.displayMode === 'original' || this.display === 'hidden') ||
        !this.eligible.has(m.id) || this.ready.has(m.id) || this.failures.has(m.id) || !this.inScope(m, c));
      if (!invalid.length) continue;
      const invalidIds = new Set(invalid.map(m => m.id));
      for (const m of invalid) if (this.pending.get(m.id) === controller) this.pending.delete(m.id);
      if (invalid.length === batch.length) {
        this.requests.delete(controller); controller.abort();
      } else {
        batch.splice(0, batch.length, ...batch.filter(m => !invalidIds.has(m.id)));
        this.options.cancelItems?.(controller.signal, [...invalidIds]);
      }
    }
    if (!c || !c.contentActive || c.seeking || !this.settings.enabled || this.settings.displayMode === 'original') return;
    if (this.display === 'hidden') { this.options.status?.(this.getStats()); return; }
    for (const [id, value] of this.ready) {
      const source = this.sources.get(id);
      if (source) this.publishReady(source, value, c);
    }
    // A suspended owned plan authorizes only the frozen five-second window.
    // Each request captures its finite preparation deadline once; refreshed
    // plans never extend it or retry an already attempted display event.
    const rank = { near: 0, buffered: 1, background: 2 };
    const candidates = [...this.eligible].map(id => this.sources.get(id)!).filter(m => this.inScope(m, c) &&
      !this.ready.has(m.id) && !this.pending.has(m.id) && !this.failures.has(m.id) &&
      !(m.platform === 'bilibili' && this.strictBilibili && this.attemptedNative.has(m.id)) &&
      (this.retryAt.get(m.id) ?? 0) <= this.now())
      .sort((a, b) => rank[videoPriority(a, c, this.settings.urgentSeconds)] - rank[videoPriority(b, c, this.settings.urgentSeconds)] ||
        (this.strictBilibili ?
          (this.shadowSelected.get(a.id)?.deadlineAtEpochMs ?? Infinity) - (this.shadowSelected.get(b.id)?.deadlineAtEpochMs ?? Infinity) : 0) ||
        a.renderAtMs - b.renderAtMs);
    // These are bounded bridge packets, not provider requests. Local saturation
    // must not withhold the overflow candidates from the background router.
    const hybrid = this.settings.bilibiliOwnedRelease && this.settings.bilibiliHybrid?.enabled;
    const requestLimit = hybrid ? 64 : this.settings.concurrency;
    const packetLimit = hybrid ? 200 : videoBatchLimit(this.settings);
    while (candidates.length && this.requests.size < requestLimit) {
      const priority = videoPriority(candidates[0]!, c, this.settings.urgentSeconds);
      const batch: SourceMessage[] = []; let chars = 0;
      while (candidates.length && batch.length < packetLimit) {
        const m = candidates[0]!;
        if (!this.inScope(m, c)) { candidates.shift(); continue; }
        if (priority === 'near' && videoPriority(m, c, this.settings.urgentSeconds) !== 'near') break;
        if (batch.length && chars + m.originalText.length > this.settings.maxBatchChars) break;
        candidates.shift(); batch.push(m); chars += m.originalText.length;
      }
      if (!batch.length) continue;
      const controller = new AbortController(); this.requests.set(controller, batch);
      for (const m of batch) {
        this.pending.set(m.id, controller);
        if (m.platform === 'bilibili' && this.strictBilibili) this.attemptedNative.add(m.id);
      }
      const version = this.version;
      const identity = translationIdentity(this.settings);
      const subscriptions = new Map(batch.map(m => [m.id, this.shadowSelected.get(m.id)]));
      const items: DueItem[] = batch.map(m => {
        const selection = m.platform === 'bilibili' && this.strictBilibili ? subscriptions.get(m.id) : null;
        return { id: m.id, text: m.originalText,
          remainingMs: selection ? Math.max(0, selection.deadlineAtEpochMs! - this.nowEpochMs()) : providerTimeoutMs(this.settings),
          ...(selection ? { sourceId: m.sourceId, epoch: this.epoch, predictionEpoch: this.shadowPredictionEpoch,
            ruleRevision: this.shadowRuleRevision, deadlineAtEpochMs: selection.deadlineAtEpochMs,
            configIdentity: identity } : {}) };
      });
      const apply = (r: TranslationOutput): void => {
        if (version !== this.version || controller.signal.aborted) return;
        const m = batch.find(item => item.id === r.id);
        if (!m || this.sources.get(m.id) !== m || this.pending.get(m.id) !== controller || this.ready.has(m.id)) return;
        const strict = m.platform === 'bilibili' && this.strictBilibili;
        const subscription = subscriptions.get(m.id);
        if (strict && (!subscription || this.epoch !== items.find(item => item.id === m.id)?.epoch ||
            this.shadowPredictionEpoch !== items.find(item => item.id === m.id)?.predictionEpoch ||
            this.shadowRuleRevision !== items.find(item => item.id === m.id)?.ruleRevision ||
            !this.inScope(m, this.currentClock() ?? c) || subscription.deadlineAtEpochMs! <= this.nowEpochMs())) return;
        if ((r.status === 'translated' || r.status === 'cached') && typeof r.text === 'string' && r.text.trim() &&
            r.text.length <= 2000 && (!strict ||
              (r.text !== m.originalText && placeholdersIntact(m.originalText, r.text) && !localQualityIssue({ ...this.settings, backend: r.backend ?? this.settings.backend }, m.originalText, r.text)))) {
          this.ready.set(m.id, { text: r.text, cached: r.status === 'cached', status: r.status,
            ...(strict ? { epoch: this.epoch, predictionEpoch: this.shadowPredictionEpoch,
              ruleRevision: this.shadowRuleRevision, deadlineAtEpochMs: subscription!.deadlineAtEpochMs } : {}) });
          this.retryAt.delete(m.id); this.failures.delete(m.id);
          const current = this.currentClock();
          if (current && current.contentActive && !current.seeking && this.settings.enabled &&
              this.settings.displayMode !== 'original' && this.display !== 'hidden') {
            this.publishReady(m, this.ready.get(m.id)!, current);
          }
          this.options.status?.(this.getStats());
        }
      };
      void this.options.request(this.resourceId, items, controller.signal, priority, apply).then(results => {
        if (version !== this.version || controller.signal.aborted) return;
        const output = new Map<string, TranslationOutput>();
        for (const r of results) {
          const old = output.get(r.id);
          if (!old || (r.status === 'translated' || r.status === 'cached')) output.set(r.id, r);
        }
        for (const m of batch) {
          if (this.sources.get(m.id) !== m || this.pending.get(m.id) !== controller || this.ready.has(m.id)) continue;
          const r = output.get(m.id);
          if ((r?.status === 'translated' || r?.status === 'cached') && typeof r.text === 'string' && r.text.trim() &&
              r.text.length <= 2000 && (!(m.platform === 'bilibili' && this.strictBilibili) ||
                (r.text !== m.originalText && placeholdersIntact(m.originalText, r.text) && !localQualityIssue({ ...this.settings, backend: r.backend ?? this.settings.backend }, m.originalText, r.text)))) {
            apply(r);
          } else if (r?.status === 'deferred' && !(m.platform === 'bilibili' && this.strictBilibili))
            this.retryAt.set(m.id, this.now() + Math.max(250, r.retryAfterMs ?? 1000));
          else this.failures.add(m.id);
        }
      }).catch(() => {
        if (version === this.version && !controller.signal.aborted) for (const m of batch)
          if (this.sources.get(m.id) === m && this.pending.get(m.id) === controller && !this.ready.has(m.id))
            if (m.platform === 'bilibili' && this.strictBilibili) this.failures.add(m.id);
            else this.retryAt.set(m.id, this.now() + 2000);
      }).finally(() => {
        if (version !== this.version) return;
        this.requests.delete(controller);
        for (const m of batch) if (this.pending.get(m.id) === controller) this.pending.delete(m.id);
        this.options.status?.(this.getStats()); this.tick();
      });
    }
    this.options.status?.(this.getStats());
  }
  private publishReady(m: SourceMessage, value: { text: string; cached: boolean; status: 'translated' | 'cached';
    epoch?: number; predictionEpoch?: number; ruleRevision?: number; deadlineAtEpochMs?: number }, c: PlaybackClock): void {
    if (this.published.has(m.id) || !this.eligible.has(m.id) || !this.inScope(m, c)) return;
    const strict = m.platform === 'bilibili' && this.strictBilibili;
    if (strict && (value.epoch !== this.epoch || value.predictionEpoch !== this.shadowPredictionEpoch ||
        value.ruleRevision !== this.shadowRuleRevision || value.deadlineAtEpochMs! <= this.nowEpochMs() ||
        value.text === m.originalText)) return;
    this.published.add(m.id);
    this.options.prepared([{ id: m.id, text: value.text, originalText: m.originalText,
      ...(strict ? { sourceId: m.sourceId, status: value.status, epoch: this.epoch,
        predictionEpoch: this.shadowPredictionEpoch, ruleRevision: this.shadowRuleRevision,
        deadlineAtEpochMs: value.deadlineAtEpochMs, configIdentity: translationIdentity(this.settings) } : {}) }]);
  }
}
