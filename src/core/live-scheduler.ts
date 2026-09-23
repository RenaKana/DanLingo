import type { LiveConnection, LivePlaybackState, LiveSourceMessage, ResourceSession, Settings, TranslationOutput } from './types.ts';
import { sameSession } from './resource.ts';
import { needsTranslation } from './messages.ts';
import { translationIdentity } from './scheduler.ts';
import { createClock, type TranslationClock } from '../translation/clock.ts';
import { protectText } from '../translation/text.ts';
import { prepareEmoteText } from '../platforms/bilibili-live/emotes.ts';

export interface LiveDueItem { id: string; text: string; remainingMs: number; emoteTokens?: string[] }
export interface LivePresentation {
  releasePolicy: 'deadline' | 'ready-in-order';
  /** Null follows video playback; native chat can instead report its own visibility. */
  active: boolean | null;
}
export interface LiveRelease {
  source: LiveSourceMessage;
  text: string;
  translated: boolean;
  cached: boolean;
  /** Display-world monotonic time at which a valid result arrived, before its deadline. */
  preparedAt?: number;
  displayAt: number;
  releasedAt: number;
}
export interface LiveStats {
  received: number; released: number; translated: number; original: number; cacheHits: number;
  timedOut: number; overloaded: number; dropped: number; removed: number; queued: number; inflight: number;
  recentEligible: number; recentTranslated: number;
  rawEligible: number; notRequired: number; onTimeReady: number;
  readinessMs: { p50: number | null; p95: number | null; p99: number | null; samples: number };
}
interface Entry {
  source: LiveSourceMessage; displayAt: number; bytes: number; eligible: boolean;
  dispatched: boolean; output?: { text: string; cached: boolean; preparedAt: number }; controller?: AbortController;
}
interface Options {
  settings: Settings;
  request(session: ResourceSession, items: LiveDueItem[], signal: AbortSignal, onResult: (output: TranslationOutput) => void): Promise<TranslationOutput[]>;
  /** False means no display capacity. This event is dropped, never replayed later. */
  release(event: LiveRelease): boolean;
  /** Native adapters may prepare before their independent fail-safe release timer fires. */
  prepare?: (event: LiveRelease) => void;
  remove?: (ids: string[]) => void;
  reset?: () => void;
  status?: (stats: LiveStats) => void;
  clock?: Partial<TranslationClock>;
  maxItems?: number; maxBytes?: number; maxSeen?: number; maxAgeMs?: number; maxLatenessMs?: number;
}

// IPC envelopes only transport raw events; provider batching happens after central deduplication.
// Cover the bounded 1000-entry display buffer even when arrivals produce one-item
// IPC envelopes. A smaller IPC cap would starve otherwise free API batch slots.
const MAX_ENVELOPE_ITEMS = 200, MAX_ENVELOPE_CHARS = 24000, MAX_OUTSTANDING_ENVELOPES = 1024;

/** Assigned deadlines bound waiting; native adapters retain final display authority. */
export class LiveScheduler {
  private settings: Settings;
  private readonly clock: TranslationClock;
  private session?: ResourceSession;
  private version = 0;
  private connection: LiveConnection = 'disconnected';
  private playback: LivePlaybackState = { paused: true, seeking: false, contentActive: false, atLiveEdge: false };
  private presentation: LivePresentation = { releasePolicy: 'deadline', active: null };
  private ticking = false;
  private tickRequested = false;
  private entries = new Map<string, Entry>();
  private seen = new Map<string, number>();
  private requests = new Set<AbortController>();
  private bytes = 0;
  private timer?: unknown;
  private lastDisplayAt = 0;
  private recent: { at: number; eligible: boolean; translated: boolean }[] = [];
  private readiness: number[] = [];
  private counts = { received: 0, released: 0, translated: 0, original: 0, cacheHits: 0, timedOut: 0, overloaded: 0, dropped: 0, removed: 0, rawEligible: 0, notRequired: 0, onTimeReady: 0 };
  private readonly options: Options;
  constructor(options: Options) { this.options = options; this.settings = options.settings; this.clock = createClock(options.clock); }
  start(session: ResourceSession): void {
    if (sameSession(this.session, session)) return;
    this.dispose(); this.session = { ...session };
    this.counts = { received: 0, released: 0, translated: 0, original: 0, cacheHits: 0, timedOut: 0, overloaded: 0, dropped: 0, removed: 0, rawEligible: 0, notRequired: 0, onTimeReady: 0 };
    this.recent = [];
  }
  configure(settings: Settings): void {
    const changed = translationIdentity(settings) !== translationIdentity(this.settings) || settings.liveSourceLanguage !== this.settings.liveSourceLanguage;
    this.settings = settings;
    if (changed) this.clear(); // Buffers already assigned to events otherwise keep their original deadline.
    this.tick();
  }
  setConnection(connection: LiveConnection): void {
    this.connection = connection;
    if (connection !== 'connected') this.clear();
    this.tick();
  }
  setPlayback(state: LivePlaybackState): void {
    this.playback = { ...state };
    if (!this.active()) this.clear();
    this.tick();
  }
  setPresentation(presentation: LivePresentation): void {
    this.presentation = { ...presentation };
    if (!this.active()) this.clear();
    this.tick();
  }
  private active(): boolean {
    return !!this.session && this.connection === 'connected' && this.settings.enabled && this.settings.displayMode === 'translated' &&
      (this.presentation.active ?? (!this.playback.paused && !this.playback.seeking && this.playback.contentActive && this.playback.atLiveEdge));
  }
  ingest(messages: LiveSourceMessage[]): void {
    const now = this.clock.now(); this.prune(now);
    for (const input of messages.slice(0, 500)) {
      if (!input.id || input.id.length > 400 || !input.originalText || input.originalText.length > 1000 ||
          !Number.isFinite(input.receivedAt) || input.receivedAt > now + 100) continue;
      if (this.seen.has(input.id)) continue;
      this.seen.set(input.id, now); this.prune(now);
      if (!this.active()) continue; // Establish a baseline while paused, never catch up on resume.
      this.counts.received++;
      const source = { ...input };
      const prose = source.emoteTokens === undefined ? source.originalText : this.session?.platform === 'bilibili'
        ? prepareEmoteText(source.originalText, source.emoteTokens)?.prose ?? '' : '';
      const eligible = source.translatable && needsTranslation(prose, this.settings.targetLanguage, this.settings.liveSourceLanguage) && !protectText(prose).reason;
      if (eligible) this.counts.rawEligible++; else this.counts.notRequired++;
      const bytes = new TextEncoder().encode(source.originalText).length + source.id.length * 2 + 256;
      const nativeTime = this.session?.platform === 'niconico' && Number.isFinite(source.scheduledAt) ? source.scheduledAt! : source.receivedAt;
      const displayAt = Math.max(this.lastDisplayAt, nativeTime + this.settings.liveBufferMs);
      if (now - source.receivedAt > (this.options.maxAgeMs ?? 10000) || displayAt < now - (this.options.maxLatenessMs ?? 1000) || displayAt > now + 6000) {
        this.counts.dropped++; this.sample(eligible, false); continue;
      }
      if (this.entries.size >= (this.options.maxItems ?? 1000) || this.bytes + bytes > (this.options.maxBytes ?? 2 * 1024 * 1024)) {
        this.counts.overloaded++; this.counts.dropped++; this.sample(eligible, false); continue;
      }
      this.lastDisplayAt = displayAt; this.bytes += bytes;
      this.entries.set(source.id, { source, displayAt, eligible, bytes, dispatched: false });
    }
    this.tick();
  }
  remove(ids: string[]): void {
    for (const id of ids.slice(0, 1000)) {
      this.seen.set(id, this.clock.now());
      const entry = this.entries.get(id);
      if (entry) { this.delete(entry); this.counts.removed++; }
    }
    this.options.remove?.(ids); this.prune(this.clock.now()); this.tick();
  }
  removeAuthor(authorId: string): void {
    this.remove([...this.entries.values()].filter(e => e.source.authorId === authorId).map(e => e.source.id));
  }
  private delete(entry: Entry): void {
    if (this.entries.delete(entry.source.id)) this.bytes -= entry.bytes;
    if (entry.controller && ![...this.entries.values()].some(e => e.controller === entry.controller)) entry.controller.abort();
  }
  private sample(eligible: boolean, translated: boolean): void {
    this.recent.push({ at: this.clock.now(), eligible, translated });
    if (this.recent.length > 1200) this.recent.shift();
  }
  private prune(now: number): void {
    for (const [id, at] of this.seen) {
      if (now - at <= 120000 && this.seen.size <= (this.options.maxSeen ?? 10000)) break;
      this.seen.delete(id);
    }
    while (this.recent.length && now - this.recent[0]!.at > 60000) this.recent.shift();
  }
  getStats(): LiveStats {
    this.prune(this.clock.now());
    const recent = this.recent.filter(r => r.eligible);
    const sorted = [...this.readiness].sort((a, b) => a - b);
    const percentile = (p: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]! : null;
    return { ...this.counts, queued: this.entries.size, inflight: this.requests.size,
      recentEligible: recent.length, recentTranslated: recent.filter(r => r.translated).length,
      readinessMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), samples: sorted.length } };
  }
  tick(): void {
    // Preparation/release callbacks may synchronously update or acknowledge entries.
    // Finish the current pass before considering newly queued work.
    if (this.ticking) { this.tickRequested = true; return; }
    this.ticking = true;
    try {
      do { this.tickRequested = false; this.pump(); } while (this.tickRequested);
    } finally { this.ticking = false; }
  }
  private pump(): void {
    this.clock.clearTimeout(this.timer); this.timer = undefined;
    if (!this.active()) return;
    const now = this.clock.now(), version = this.version;
    // Map insertion order is event order; displayAt is non-decreasing and finite.
    for (const entry of this.entries.values()) {
      if (entry.displayAt > now && !(this.presentation.releasePolicy === 'ready-in-order' && (entry.output || !entry.eligible))) break;
      const output = entry.output;
      this.delete(entry);
      const stale = now - entry.displayAt > (this.options.maxLatenessMs ?? 1000);
      const displayed = !stale && this.options.release({ source: entry.source, text: output?.text ?? entry.source.originalText,
        translated: !!output, cached: output?.cached ?? false, preparedAt: output?.preparedAt, displayAt: entry.displayAt, releasedAt: now });
      if (!displayed) { this.counts.dropped++; if (!stale) this.counts.overloaded++; }
      else {
        this.counts.released++;
        if (output) { this.counts.translated++; if (output.cached) this.counts.cacheHits++; }
        else { this.counts.original++; if (entry.eligible) this.counts.timedOut++; }
      }
      this.sample(entry.eligible, displayed && !!output);
      if (version !== this.version || !this.active()) return;
    }
    const pending = [...this.entries.values()].filter(e => e.eligible && !e.dispatched);
    while (pending.length && this.requests.size < MAX_OUTSTANDING_ENVELOPES) {
      const batch: Entry[] = []; let chars = 0;
      for (const entry of pending) {
        if (batch.length >= MAX_ENVELOPE_ITEMS || chars + entry.source.originalText.length > MAX_ENVELOPE_CHARS) break;
        batch.push(entry); chars += entry.source.originalText.length;
      }
      pending.splice(0, batch.length); this.dispatch(batch);
    }
    let next = Infinity;
    for (const entry of this.entries.values()) {
      next = Math.min(next, entry.displayAt);
    }
    if (Number.isFinite(next)) this.timer = this.clock.setTimeout(() => this.tick(), Math.max(1, next - this.clock.now()));
    this.options.status?.(this.getStats());
  }
  private dispatch(batch: Entry[]): void {
    const controller = new AbortController(); this.requests.add(controller);
    const version = this.version, session = { ...this.session! };
    for (const e of batch) { e.dispatched = true; e.controller = controller; }
    const byId = new Map(batch.map(entry => [entry.source.id, entry]));
    const accept = (result: TranslationOutput) => {
      if (controller.signal.aborted || version !== this.version || !sameSession(this.session, session)) return;
      const entry = byId.get(result?.id), preparedAt = this.clock.now();
      if (!entry || entry.output || this.entries.get(entry.source.id) !== entry || preparedAt >= entry.displayAt) return;
      if ((result.status !== 'translated' && result.status !== 'cached') || typeof result.text !== 'string' || !result.text.trim() || result.text.length > 2000) return;
      entry.output = { text: result.text, cached: result.status === 'cached', preparedAt };
      this.counts.onTimeReady++;
      this.readiness.push(Math.max(0, preparedAt - entry.source.receivedAt));
      if (this.readiness.length > 1200) this.readiness.shift();
      this.options.prepare?.({ source: entry.source, text: result.text, translated: true, cached: entry.output.cached,
        preparedAt, displayAt: entry.displayAt, releasedAt: preparedAt });
      this.tick();
    };
    const items = batch.map(e => ({ id: e.source.id, text: e.source.originalText, remainingMs: Math.max(0, e.displayAt - this.clock.now()),
      ...(e.source.emoteTokens?.length ? { emoteTokens: e.source.emoteTokens } : {}) }));
    void Promise.resolve().then(() => {
      if (controller.signal.aborted || version !== this.version) return [];
      // Include microtask queuing in the budget as well.
      const due = items.map((item, i) => ({ ...item, remainingMs: Math.max(0, batch[i]!.displayAt - this.clock.now()) })).filter(item => item.remainingMs > 0);
      return due.length ? this.options.request(session, due, controller.signal, accept) : [];
    }).then(results => {
      for (const result of results) accept(result);
    }).catch(() => { /* At the original display time these entries fall back once. */ })
      .finally(() => { this.requests.delete(controller); if (version === this.version) this.tick(); });
  }
  private clear(): void {
    this.version++; this.clock.clearTimeout(this.timer); this.timer = undefined;
    for (const request of this.requests) request.abort();
    this.requests.clear(); this.entries.clear(); this.bytes = 0; this.lastDisplayAt = 0; this.options.reset?.();
  }
  dispose(): void { this.clear(); this.session = undefined; this.connection = 'disconnected'; this.seen.clear(); this.recent = []; this.readiness = []; }
}
