import { translatedPacket, type BilibiliComment } from './messages.ts';
import { emoteProse, emotesIntact } from './emotes.ts';
import { validLiveBufferMs } from '../../core/live-budget.ts';

export interface BilibiliDecision {
  source: BilibiliComment; eligible: boolean; translated: boolean; cached: boolean; text: string;
  receivedAt: number; releasedAt: number; reason: 'ready' | 'timeout' | 'handoff' | 'overload';
}
interface Pending {
  source: BilibiliComment; at: number; deadline: number; ready: boolean; text?: string; cached: boolean;
  eligible: boolean; bytes: number; submit(packet: Record<string, any>): void;
  retryAttempted?: boolean; retrying?: boolean; waitedForRetry?: boolean;
}
interface Options {
  now(): number; current(): boolean; active(): boolean; eligible(text: string): boolean;
  setTimeout(fn: () => void, ms: number): unknown; clearTimeout(timer: unknown): void;
  source(source: BilibiliComment, receivedAt: number): void;
  decision(decision: BilibiliDecision): void;
  removed(ids: string[]): void;
  retryPolicy?(): { timeoutMs: number; hold: boolean } | undefined;
  /** Native owner starts a distinct, token-bound request; false keeps the original deadline. */
  retry?(source: BilibiliComment, deadline: number): boolean;
  cancelRetry?(sourceId: string): void;
}
/** One bounded native dispatch queue: the website still owns both renderers and their filtering. */
export class BilibiliNativeQueue {
  private rows = new Map<string, Pending>();
  private seen = new Map<string, number>();
  private bytes = 0;
  private timer: unknown;
  private pumping = false;
  private readonly options: Options;
  constructor(options: Options) { this.options = options; }
  get size() { return this.rows.size; }
  add(source: BilibiliComment, bufferMs: number, submit: Pending['submit'], receivedAt = this.options.now()): boolean {
    if (!this.options.current() || !this.options.active() || !validLiveBufferMs(bufferMs)) return false;
    if (this.rows.has(source.sourceId)) return true;
    const now = this.options.now();
    if (!Number.isFinite(receivedAt) || receivedAt > now || now - receivedAt > 10000) return false;
    for (const [id, at] of this.seen) { if (this.seen.size <= 20000 && now - at < 120000) break; this.seen.delete(id); }
    if (this.seen.has(source.sourceId)) return false;
    let copy: BilibiliComment, bytes: number;
    try { copy = { ...source, packet: structuredClone(source.packet) }; bytes = JSON.stringify(copy.packet).length * 2 + 256; } catch { return false; }
    if (bytes > 2 * 1024 * 1024) return false;
    if (this.rows.size >= 1000 || this.bytes + bytes > 2 * 1024 * 1024) this.flush('overload');
    const eligible = source.translatable && this.options.eligible(emoteProse(source.originalText, source.inlineEmotes));
    this.rows.set(source.sourceId, { source: copy, at: receivedAt, deadline: receivedAt + bufferMs, ready: !eligible, eligible, cached: false, bytes, submit });
    this.bytes += bytes; this.seen.set(source.sourceId, now);
    try { this.options.source({ ...source, translatable: eligible }, receivedAt); }
    catch { const row = this.rows.get(source.sourceId); if (row) row.ready = true; }
    this.pump(); return true;
  }
  prepare(id: string, original: string, text: string, cached = false): boolean {
    const row = this.rows.get(id);
    if (!row || row.retryAttempted || row.ready || row.source.originalText !== original || this.options.now() >= row.deadline || !text.trim() || text.length > 2000 ||
        !emotesIntact(original, text, Object.keys(row.source.inlineEmotes ?? {}))) return false;
    row.text = text; row.cached = cached; row.ready = true; this.pump(); return true;
  }
  original(id: string, original: string) {
    const row = this.rows.get(id); if (row?.source.originalText === original && !row.retrying) { row.ready = true; this.pump(); }
  }
  retryResult(id: string, original: string, text?: string, cached = false): boolean {
    const row = this.rows.get(id);
    if (!row?.retrying || row.ready || row.source.originalText !== original || this.options.now() >= row.deadline) return false;
    if (text !== undefined && (!text.trim() || text.length > 2000 || !emotesIntact(original, text, Object.keys(row.source.inlineEmotes ?? {})))) return false;
    row.text = text; row.cached = cached; row.ready = true; this.pump(); return true;
  }
  private release(row: Pending, reason: BilibiliDecision['reason']) {
    if (!this.rows.delete(row.source.sourceId)) return;
    this.bytes -= row.bytes;
    const now = this.options.now(), translated = reason === 'ready' && (now < row.deadline || row.waitedForRetry === true) && row.text !== undefined;
    const text = translated ? row.text! : row.source.originalText;
    try { row.submit(translated ? translatedPacket(row.source, text) : row.source.packet); }
    catch { this.options.removed([row.source.sourceId]); return; } // A partially executed native call is never replayed.
    try { this.options.decision({ source: row.source, eligible: row.eligible, translated, cached: translated && row.cached, text, receivedAt: row.at, releasedAt: now,
      reason: reason === 'ready' && row.eligible && !translated && (row.retryAttempted || now >= row.deadline) ? 'timeout' : reason }); } catch { /* Never replay a submitted native occurrence. */ }
  }
  pump() {
    if (this.pumping) return;
    this.pumping = true; this.options.clearTimeout(this.timer); this.timer = undefined;
    try {
      if (!this.options.current()) { this.abandon(); return; }
      if (!this.options.active()) { this.flush('handoff'); return; }
      // Start each due second attempt independently, even behind a held head.
      // Queue order still controls native release; time behind the head is not a fresh budget.
      const now = this.options.now();
      for (const row of this.rows.values()) {
        if (!row.eligible || row.text !== undefined || row.retryAttempted || now < row.deadline) continue;
        row.retryAttempted = true;
        const policy = this.options.retryPolicy?.();
        if (!policy || !Number.isFinite(policy.timeoutMs) || policy.timeoutMs < 500 || policy.timeoutMs > 33000) continue;
        const originalDeadline = row.deadline, retryDeadline = originalDeadline + policy.timeoutMs;
        if (now >= retryDeadline) continue;
        if (policy.hold) { row.retrying = true; row.ready = false; row.deadline = retryDeadline; }
        let started = false;
        try { started = this.options.retry?.(row.source, retryDeadline) === true; } catch { /* Fail back to the native original. */ }
        if (!started && policy.hold) { row.retrying = false; row.ready = true; row.deadline = originalDeadline; }
      }
      let behindRetry = false;
      for (const row of this.rows.values()) {
        if (behindRetry && row.text !== undefined) row.waitedForRetry = true;
        behindRetry ||= row.retrying === true;
      }
      for (const row of this.rows.values()) {
        if (!row.ready && this.options.now() < row.deadline) break;
        this.release(row, 'ready');
      }
    } finally {
      this.pumping = false;
      const next = this.rows.values().next().value as Pending | undefined;
      if (next) {
        let deadline = next.deadline;
        for (const row of this.rows.values()) if (row.eligible && !row.retryAttempted && row.text === undefined) deadline = Math.min(deadline, row.deadline);
        this.timer = this.options.setTimeout(() => this.pump(), Math.max(1, deadline - this.options.now()));
      }
    }
  }
  flush(reason: 'handoff' | 'overload' = 'handoff') {
    this.options.clearTimeout(this.timer); this.timer = undefined;
    if (!this.options.current()) { this.abandon(); return; }
    for (const row of [...this.rows.values()]) { if (row.retrying) this.options.cancelRetry?.(row.source.sourceId); this.release(row, reason); }
  }
  abandon() {
    this.options.clearTimeout(this.timer); this.timer = undefined;
    const ids = [...this.rows.keys()];
    for (const row of this.rows.values()) if (row.retrying) this.options.cancelRetry?.(row.source.sourceId);
    this.rows.clear(); this.bytes = 0;
    if (ids.length) this.options.removed(ids);
  }
}
