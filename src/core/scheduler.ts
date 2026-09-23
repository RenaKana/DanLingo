import type { PlaybackClock, Settings, SourceMessage, TranslationOutput } from './types.ts';
import { needsTranslation } from './messages.ts';
import { sameSource } from './source-stream.ts';
import { protectText } from '../translation/text.ts';
import { localGenerationProfile, normalizeReasoningEffort, providerTimeoutMs } from './config.ts';
import { resolveConnection } from './connection.ts';
import { localPromptMode } from '../translation/local-policy.ts';

export type VideoPriority = 'near' | 'buffered' | 'background';
export interface DueItem { id: string; text: string; remainingMs: number }
type SkipReason = 'special' | 'language' | 'emoticon';
export interface SchedulerStats {
  total: number; skipped: Record<SkipReason, number>;
  messages: number; translated: number; cacheHits: number; queued: number; inflight: number;
  failed: number; expired: number; nearTotal: number; nearPrepared: number; sourceComplete: boolean;
}
interface Options {
  settings: Settings;
  request: (resourceId: string, items: DueItem[], signal: AbortSignal, priority: VideoPriority) => Promise<TranslationOutput[]>;
  prepared: (items: { id: string; text: string; originalText: string }[]) => void;
  reset: () => void;
  removed?: (ids: string[]) => void;
  status?: (stats: SchedulerStats) => void;
  now?: () => number;
}
export function translationIdentity(settings: Settings): string {
  const provider = settings.backend === 'local'
    ? ['local', settings.localModelId, settings.model, settings.profile, settings.sourceLanguage, settings.targetLanguage,
      localPromptMode(settings), settings.localPerformance?.languageValidation ?? 'strict', localGenerationProfile(settings)]
    : [resolveConnection(settings).configuredCompletionEndpoint, settings.model, settings.profile,
      settings.sourceLanguage, settings.targetLanguage, normalizeReasoningEffort(settings, settings.thinkingEffort)];
  return JSON.stringify([provider, settings.enabled, settings.displayMode]);
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
  private ready = new Map<string, { text: string; cached: boolean }>();
  private failures = new Set<string>();
  private retryAt = new Map<string, number>();
  private requests = new Map<AbortController, SourceMessage[]>();
  private sourceComplete = false;
  private readonly now: () => number;
  private options: Options;
  constructor(options: Options) { this.options = options; this.settings = options.settings; this.now = options.now ?? (() => performance.now()); }
  snapshot(resourceId: string, scope: string, clock: PlaybackClock, sources?: SourceMessage[]): void {
    if (scope !== this.scope || resourceId !== this.resourceId) {
      this.dispose(); this.scope = scope; this.resourceId = resourceId;
    }
    this.clock = clock; this.sampledAt = this.now();
    if (sources) this.updateSources(sources, [], true, true);
    else this.tick();
  }
  updateSources(upserts: SourceMessage[], removes: string[], reset = false, complete = false): void {
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
    this.tick();
  }
  private remove(id: string): void {
    this.pending.delete(id);
    this.sources.delete(id); this.eligible.delete(id); this.skipped.delete(id); this.ready.delete(id); this.failures.delete(id); this.retryAt.delete(id);
    for (const [controller, batch] of this.requests) {
      if (batch.some(message => this.sources.get(message.id) === message)) continue;
      controller.abort();
      for (const message of batch) if (this.pending.get(message.id) === controller) this.pending.delete(message.id);
    }
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
    this.settings = settings;
    if (changed) {
      this.invalidate(); this.eligible.clear(); this.skipped.clear();
      for (const m of this.sources.values()) this.classify(m);
    }
    this.tick();
  }
  retryFailures(): void { this.failures.clear(); this.retryAt.clear(); this.tick(); }
  dispose(): void {
    this.invalidate(); this.clock = null; this.sources.clear(); this.eligible.clear(); this.skipped.clear();
    this.scope = ''; this.resourceId = ''; this.sourceComplete = false;
  }
  private invalidate(): void {
    this.version++;
    for (const controller of this.requests.keys()) controller.abort();
    this.requests.clear(); this.pending.clear(); this.ready.clear(); this.failures.clear(); this.retryAt.clear();
    this.options.reset();
  }
  private currentClock(): PlaybackClock | null {
    if (!this.clock) return null;
    const c = this.clock;
    return { ...c, mediaTimeMs: c.mediaTimeMs + (c.paused || c.seeking || !c.contentActive ? 0 : Math.max(0, this.now() - this.sampledAt) * c.playbackRate) };
  }
  private inRange(m: SourceMessage, c: PlaybackClock): boolean {
    return this.settings.translationScope === 'all' ||
      (m.mediaTimeMs >= Math.max(0, c.mediaTimeMs - 5000) && m.mediaTimeMs <= c.mediaTimeMs + this.settings.prefetchSeconds * 1000);
  }
  getStats(): SchedulerStats {
    const c = this.currentClock();
    const stats: SchedulerStats = { total: 0, skipped: { special: 0, language: 0, emoticon: 0 }, messages: 0, translated: 0, cacheHits: 0, queued: 0, inflight: this.requests.size,
      failed: 0, expired: 0, nearTotal: 0, nearPrepared: 0, sourceComplete: this.sourceComplete };
    if (!c) return stats;
    for (const [id, m] of this.sources) {
      if (!this.inRange(m, c)) continue;
      stats.total++;
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
    if (!c || !c.contentActive || c.seeking || !this.settings.enabled || this.settings.displayMode === 'original') return;
    const rank = { near: 0, buffered: 1, background: 2 };
    const candidates = [...this.eligible].map(id => this.sources.get(id)!).filter(m => this.inRange(m, c) &&
      !this.ready.has(m.id) && !this.pending.has(m.id) && !this.failures.has(m.id) && (this.retryAt.get(m.id) ?? 0) <= this.now())
      .sort((a, b) => rank[videoPriority(a, c, this.settings.urgentSeconds)] - rank[videoPriority(b, c, this.settings.urgentSeconds)] || a.renderAtMs - b.renderAtMs);
    while (candidates.length && this.requests.size < this.settings.concurrency) {
      const priority = videoPriority(candidates[0]!, c, this.settings.urgentSeconds);
      const batch: SourceMessage[] = []; let chars = 0;
      while (candidates.length && batch.length < this.settings.batchSize) {
        const m = candidates[0]!;
        if (priority === 'near' && videoPriority(m, c, this.settings.urgentSeconds) !== 'near') break;
        if (batch.length && chars + m.originalText.length > this.settings.maxBatchChars) break;
        candidates.shift(); batch.push(m); chars += m.originalText.length;
      }
      const controller = new AbortController(); this.requests.set(controller, batch);
      for (const m of batch) this.pending.set(m.id, controller);
      const version = this.version;
      const items = batch.map(m => ({ id: m.id, text: m.originalText, remainingMs: providerTimeoutMs(this.settings) }));
      void this.options.request(this.resourceId, items, controller.signal, priority).then(results => {
        if (version !== this.version || controller.signal.aborted) return;
        const output = new Map(results.map(r => [r.id, r]));
        const prepared: { id: string; text: string; originalText: string }[] = [];
        for (const m of batch) {
          if (this.sources.get(m.id) !== m) continue;
          const r = output.get(m.id);
          if ((r?.status === 'translated' || r?.status === 'cached') && typeof r.text === 'string' && r.text.trim() && r.text.length <= 2000) {
            this.ready.set(m.id, { text: r.text, cached: r.status === 'cached' });
            prepared.push({ id: m.id, text: r.text, originalText: m.originalText });
          } else if (r?.status === 'deferred') this.retryAt.set(m.id, this.now() + Math.max(250, r.retryAfterMs ?? 1000));
          else this.failures.add(m.id);
        }
        if (prepared.length) this.options.prepared(prepared);
      }).catch(() => {
        if (version === this.version) for (const m of batch) if (this.sources.get(m.id) === m) this.retryAt.set(m.id, this.now() + 2000);
      }).finally(() => {
        if (version !== this.version) return;
        this.requests.delete(controller);
        for (const m of batch) if (this.pending.get(m.id) === controller) this.pending.delete(m.id);
        this.options.status?.(this.getStats()); this.tick();
      });
    }
    this.options.status?.(this.getStats());
  }
}
