import { prepareNativeChatText } from './native-text.ts';
import { validLiveBufferMs } from '../../core/live-budget.ts';

type Data = Record<string, any>;
export interface NativeChatSource { sourceId: string; originalText: string; receivedAt: number; translatable: boolean; authorId?: string }
export interface NativeChatDecision {
  sourceId: string; originalText: string; translated: boolean; cached: boolean;
  reason: 'ready' | 'timeout' | 'overload' | 'handoff'; receivedAt: number; releasedAt: number; deadline: number;
  textCharacters: number; action: Data;
}
interface Pending {
  id: string; action: Data; text: NonNullable<ReturnType<typeof prepareNativeChatText>>;
  receivedAt: number; deadline: number; bytes: number; ready: boolean; eligible: boolean;
  output?: Data; cached: boolean; retryAttempted?: boolean; retrying?: boolean; waitedForRetry?: boolean;
}
interface Options {
  now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(timer: unknown): void;
  current(): boolean; active?(): boolean; submit(action: Data): boolean;
  source(event: NativeChatSource): void; decision(event: NativeChatDecision): void;
  removed(ids: string[], reason: 'removed' | 'abandoned'): void;
  eligible(text: string): boolean;
  retryPolicy?(): { timeoutMs: number; hold: boolean } | undefined;
  retry?(source: NativeChatSource, deadline: number): boolean;
  cancelRetry?(sourceId: string): void;
  maxItems?: number; maxBytes?: number;
}

/** Native actions are kept locally; neither a timeout nor a result ever edits a shown row. */
export class YoutubeNativeQueue {
  private rows = new Map<string, Pending>();
  private seen = new Map<string, number>();
  private bytes = 0;
  private timer: unknown;
  private pumping = false;
  private readonly options: Options;
  constructor(options: Options) { this.options = options; }
  get size() { return this.rows.size; }
  seed(ids: string[]) { for (const id of ids.slice(-2000)) if (id) { this.seen.delete(id); this.seen.set(id, this.options.now()); } this.prune(); }
  private prune() {
    for (const [id, at] of this.seen) {
      if (this.seen.size <= 20000 && this.options.now() - at <= 120000) break;
      this.seen.delete(id);
    }
  }
  /** true consumes an ordinary action; false leaves the original method in charge. */
  add(action: Data, bufferMs: number): boolean {
    const receivedAt = this.options.now();
    const renderer = action?.item?.liveChatTextMessageRenderer;
    const id = renderer?.id;
    if (typeof id !== 'string' || !id || id.length > 300) return false;
    if (this.rows.has(id)) return true;
    this.prune();
    if (this.seen.has(id)) return false; // Native duplicate/update semantics remain authoritative.
    const text = prepareNativeChatText(renderer.message);
    if (!text || text.text.length > 1000 || !validLiveBufferMs(bufferMs)) return false;
    this.seen.set(id, this.options.now());
    let bytes: number, source: Data;
    try { source = structuredClone(action); bytes = JSON.stringify(source).length * 2 + 256; } catch { return false; }
    const maxBytes = this.options.maxBytes ?? 2 * 1024 * 1024;
    if (this.rows.size >= (this.options.maxItems ?? 1000) || this.bytes + bytes > maxBytes) this.flush('overload');
    if (bytes > maxBytes) return false;
    const eligible = text.translatable && this.options.eligible(text.text);
    const row: Pending = { id, action:source, text, receivedAt, deadline: receivedAt + bufferMs, bytes, ready: !eligible, eligible, cached: false };
    this.rows.set(id, row); this.bytes += bytes;
    this.options.source({ sourceId: id, originalText: text.text, receivedAt, translatable: eligible,
      ...(typeof renderer.authorExternalChannelId === 'string' && renderer.authorExternalChannelId.length <= 200 ? { authorId: renderer.authorExternalChannelId } : {}) });
    this.pump(); return true;
  }
  prepare(id: string, originalText: string, translated: string, cached: boolean): boolean {
    const row = this.rows.get(id);
    if (!row || row.ready || row.retryAttempted || row.text.text !== originalText || this.options.now() >= row.deadline) return false;
    const message = row.text.restore(translated);
    if (!message || this.options.now() >= row.deadline) return false;
    row.output = { ...row.action, item: { ...row.action.item, liveChatTextMessageRenderer: { ...row.action.item.liveChatTextMessageRenderer, message } } };
    row.cached = cached; row.ready = true; this.pump(); return true;
  }
  retryResult(id: string, originalText: string, translated?: string, cached = false): boolean {
    const row = this.rows.get(id);
    if (!row?.retrying || row.ready || row.text.text !== originalText || this.options.now() >= row.deadline) return false;
    if (translated !== undefined && (!translated.trim() || translated.length > 2000)) return false;
    if (translated !== undefined) {
      const message = row.text.restore(translated);
      if (!message) return false;
      row.output = { ...row.action, item: { ...row.action.item, liveChatTextMessageRenderer: { ...row.action.item.liveChatTextMessageRenderer, message } } };
      row.cached = cached;
    } else row.output = undefined;
    row.retrying = false; row.ready = true; this.pump(); return true;
  }
  original(id: string, originalText: string): void {
    const row = this.rows.get(id);
    if (!row || row.retrying || row.text.text !== originalText) return;
    row.ready = true; this.pump();
  }
  remove(ids: string[], pump = true): void {
    const removed: string[] = [];
    for (const id of ids) {
      const row = this.rows.get(id);
      if (row) { if (row.retrying) this.options.cancelRetry?.(id); this.rows.delete(id); this.bytes -= row.bytes; removed.push(id); }
      if (typeof id === 'string') { this.seen.delete(id); this.seen.set(id, this.options.now()); }
    }
    if (removed.length) this.options.removed(removed, 'removed');
    if (pump) this.pump();
  }
  removeAuthor(author: string) { this.remove([...this.rows.values()].filter(row => row.action.item.liveChatTextMessageRenderer.authorExternalChannelId === author).map(row => row.id)); }
  clear() { this.remove([...this.rows.keys()]); }
  private release(row: Pending, reason: NativeChatDecision['reason']) {
    if (!this.rows.delete(row.id)) return;
    this.bytes -= row.bytes;
    const originalOnly = reason === 'handoff' || reason === 'overload';
    const expired = this.options.now() >= row.deadline;
    const output = !originalOnly && (!expired || row.waitedForRetry) && row.output;
    if (row.retrying) this.options.cancelRetry?.(row.id);
    if (!originalOnly && expired && row.eligible) reason = 'timeout';
    if (!originalOnly && reason === 'ready' && row.eligible && !output && row.retryAttempted) reason = 'timeout';
    const action = output || row.action;
    // Delete before calling the site. If its method throws after partial work, never retry.
    if (!this.options.submit(action)) { this.options.removed([row.id], 'abandoned'); return; }
    const message = action.item.liveChatTextMessageRenderer.message;
    const chars = typeof message.simpleText === 'string' ? [...message.simpleText].length
      : (message.runs || []).reduce((n: number, run: Data) => n + (typeof run.text === 'string' ? [...run.text].length : 0), 0);
    this.options.decision({ sourceId: row.id, originalText: row.text.text, translated: !!output, cached: !!output && row.cached,
      reason, receivedAt: row.receivedAt, releasedAt: this.options.now(), deadline: row.deadline, textCharacters: chars, action });
  }
  pump() {
    if (this.pumping) return;
    this.pumping = true;
    this.options.clearTimeout(this.timer); this.timer = undefined;
    try {
      if (!this.options.current()) { this.abandon(); return; }
      if (this.options.active?.() === false) { this.flush('handoff'); return; }
      const now = this.options.now();
      for (const row of this.rows.values()) {
        if (!row.eligible || row.output || row.retryAttempted || now < row.deadline) continue;
        row.retryAttempted = true;
        const policy = this.options.retryPolicy?.();
        if (!policy || !Number.isFinite(policy.timeoutMs) || policy.timeoutMs < 500 || policy.timeoutMs > 33000) continue;
        const originalDeadline = row.deadline, retryDeadline = originalDeadline + policy.timeoutMs;
        if (now >= retryDeadline) continue;
        if (policy.hold) { row.retrying = true; row.ready = false; row.deadline = retryDeadline; }
        let started = false;
        try {
          started = this.options.retry?.({ sourceId: row.id, originalText: row.text.text, receivedAt: row.receivedAt, translatable: row.eligible,
            ...(typeof row.action.item.liveChatTextMessageRenderer.authorExternalChannelId === 'string' ? { authorId: row.action.item.liveChatTextMessageRenderer.authorExternalChannelId } : {}) }, retryDeadline) === true;
        } catch { /* Fall back to the native original. */ }
        if (!started && policy.hold) { row.retrying = false; row.ready = true; row.deadline = originalDeadline; }
      }
      let behindRetry = false;
      for (const row of this.rows.values()) {
        if (behindRetry && row.output) row.waitedForRetry = true;
        behindRetry ||= row.retrying === true;
      }
      for (const row of this.rows.values()) {
        if (!row.ready && this.options.now() < row.deadline) break;
        this.release(row, row.output || !row.eligible ? 'ready' : 'timeout');
      }
    } finally {
      this.pumping = false;
      const next = this.rows.values().next().value as Pending | undefined;
      if (next) {
        let deadline = next.deadline;
        for (const row of this.rows.values()) if (row.eligible && !row.retryAttempted && !row.output) deadline = Math.min(deadline, row.deadline);
        this.timer = this.options.setTimeout(() => this.pump(), Math.max(1, deadline - this.options.now()));
      }
    }
  }
  flush(reason: 'handoff' | 'overload') {
    this.options.clearTimeout(this.timer); this.timer = undefined;
    if (!this.options.current()) { this.abandon(); return; }
    for (const row of [...this.rows.values()]) { if (row.retrying) this.options.cancelRetry?.(row.id); this.release(row, reason); }
  }
  abandon() {
    this.options.clearTimeout(this.timer); this.timer = undefined;
    const ids = [...this.rows.keys()]; for (const row of this.rows.values()) if (row.retrying) this.options.cancelRetry?.(row.id); this.rows.clear(); this.bytes = 0;
    if (ids.length) this.options.removed(ids, 'abandoned');
  }
}
