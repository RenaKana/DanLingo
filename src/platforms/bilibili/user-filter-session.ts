import type { SourceMessage } from '../../core/types.ts';
import { BUILD_ID } from '../../core/build-identity.ts';
import { SOURCE_CHUNK_BYTES } from '../../core/source-stream.ts';
import { compileBilibiliUserRules, ownData, type CompiledUserRules, type UserFilterDecision, type UserRuleCategory } from './user-filters.ts';
import { createUserFilterReader, observeUserRuleCalls } from './user-filter-reader.ts';

export interface UserFilterRow { id: string; originalText: string; state: 'exclude' | 'retain' | 'unknown'; category?: UserRuleCategory;
  legacyState?: 'exclude' | 'retain' | 'unknown' }

/** MAIN-only read/match publisher. It owns no native settings or candidate data. */
export class BilibiliUserFilterSession {
  private reader: ReturnType<typeof createUserFilterReader>;
  private compiled: CompiledUserRules;
  private enabled = false;
  private audit = false;
  private revision = 0;
  private rows: SourceMessage[] = [];
  private raw = new Map<string, unknown>();
  private predicted = new Map<string, { decision: UserFilterDecision; originalText: string }>();
  private suppressed = new Set<UserRuleCategory>();
  private restoreObserver?: () => boolean;
  private observedStore: unknown;
  private lastPublished = -Infinity;
  private lastReadRevision = -1;
  private revisionDetectedAt = 0;
  private force = true;
  private natural = { calls: 0, predictedExcludes: 0, matchedUserBranch: 0, conflicts: 0, changedSnapshot: 0,
    regexpPredictions: 0, regexpPredictionsMatchedUserBranch: 0 };
  private authorInputs = { uhashStrings: 0, uidStrings: 0, uidNumbers: 0, missing: 0 };
  private restored = true;
  private metrics = { lastRefreshMs: 0, maxRefreshMs: 0, currentMatchMs: 0, legacyMatchMs: 0, judgments: 0 };
  private options: { player: unknown; danmaku: unknown; documentScope: string; now: () => number; emit: (payload: Record<string, unknown>) => void };
  constructor(options: BilibiliUserFilterSession['options']) {
    this.options = options;
    this.reader = createUserFilterReader({ ...options, roots: () => [options.player],
      registry: () => (globalThis as any).window?.nano });
    this.compiled = compileBilibiliUserRules({ scope: options.documentScope, revision: 0, verified: false,
      enabled: null, complete: false, rules: [] });
  }
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled; this.force = true;
    if (!enabled) this.stopObserver();
  }
  invalidate(): void { this.force = true; }
  setAudit(enabled: boolean): void { if (this.audit !== enabled) { this.audit = enabled; this.force = true; } }
  firstExcludedTime(): number | null {
    const excluded = (row: SourceMessage) => this.predicted.get(row.sourceId)?.decision.state === 'exclude';
    return (this.rows.find(row => excluded(row) && this.predicted.get(row.sourceId)?.decision.category === 'regexp')
      ?? this.rows.find(excluded))?.mediaTimeMs ?? null;
  }
  private stopObserver(): void {
    if (this.restoreObserver) this.restored = this.restoreObserver() && this.restored;
    this.restoreObserver = undefined; this.observedStore = undefined;
  }
  refresh(rows: SourceMessage[], pool: unknown[]): void {
    this.rows = rows;
    if (!this.enabled && !this.force) return;
    const now = this.options.now();
    if (!this.force && now - this.lastPublished < 2000) return;
    this.raw.clear();
    this.authorInputs = { uhashStrings: 0, uidStrings: 0, uidNumbers: 0, missing: 0 };
    for (const source of pool) {
      const id = ownData(source, 'dmid') ?? ownData(source, 'id_str');
      if (typeof id === 'string' && !this.raw.has(id)) this.raw.set(id, source);
      const hash = ownData(source, 'uhash'), uid = ownData(source, 'uid');
      if (typeof hash === 'string' && hash) this.authorInputs.uhashStrings++;
      else if (typeof uid === 'string' && uid) this.authorInputs.uidStrings++;
      else if (typeof uid === 'number' && Number.isSafeInteger(uid)) this.authorInputs.uidNumbers++;
      else this.authorInputs.missing++;
    }
    const snapshot = this.enabled ? this.reader.read(this.force) : null;
    if (snapshot) this.compiled = snapshot.compiled;
    const store = this.reader.store();
    if (this.enabled && store !== this.observedStore) {
      this.stopObserver(); this.observedStore = store;
      if (store) this.restoreObserver = observeUserRuleCalls(store.blockStore, (source, result) => this.observe(source, result));
    }
    if (this.force || this.lastReadRevision !== this.compiled.summary.revision) {
      this.revision++; this.lastReadRevision = this.compiled.summary.revision;
      this.revisionDetectedAt = snapshot?.changed ? snapshot.detectedAt : now;
    }
    this.force = false; this.lastPublished = now;
    this.predicted.clear();
    const matchingStarted = performance.now();
    const items = rows.map(row => this.decision(row));
    this.metrics.lastRefreshMs = performance.now() - matchingStarted;
    this.metrics.maxRefreshMs = Math.max(this.metrics.maxRefreshMs, this.metrics.lastRefreshMs);
    const summary = this.summary(), encoder = new TextEncoder();
    const overhead = encoder.encode(JSON.stringify(summary)).length + 2048;
    const chunks: UserFilterRow[][] = [[]];
    let bytes = overhead;
    for (const item of items) {
      const size = encoder.encode(JSON.stringify(item)).length + 1;
      if (chunks.at(-1)!.length >= 200 || bytes + size > SOURCE_CHUNK_BYTES) { chunks.push([]); bytes = overhead; }
      chunks.at(-1)!.push(item); bytes += size;
    }
    chunks.forEach((items, index) => this.options.emit({ type: 'bilibili-user-filter',
      revision: this.revision, index, complete: index === chunks.length - 1, enabled: this.enabled,
      detectedAt: this.revisionDetectedAt, summary, items }));
  }
  decision(row: SourceMessage): UserFilterRow {
    const raw = this.raw.get(row.sourceId);
    const started = performance.now();
    let decision: UserFilterDecision = this.enabled && ownData(raw, 'text') === row.originalText
      ? this.compiled.match(raw) : { state: 'unknown', reason: 'disabled-or-source-unavailable', revision: this.compiled.summary.revision };
    if (decision.category && this.suppressed.has(decision.category)) decision = { ...decision, state: 'unknown', reason: 'natural-admission-conflict' };
    this.predicted.set(row.sourceId, { decision, originalText: row.originalText });
    this.metrics.currentMatchMs += performance.now() - started; this.metrics.judgments++;
    const baselineStarted = performance.now();
    const legacyState = this.audit && this.enabled && ownData(raw, 'text') === row.originalText ? this.compiled.matchLegacy(raw).state : undefined;
    this.metrics.legacyMatchMs += performance.now() - baselineStarted;
    if (this.audit && this.enabled) this.compiled.auditText(row.originalText);
    return { id: row.id, originalText: row.originalText, state: decision.state, ...(decision.category ? { category: decision.category } : {}),
      ...(legacyState ? { legacyState } : {}) };
  }
  forSources(rows: SourceMessage[], pool: unknown[]): { revision: number; items: UserFilterRow[]; summary: ReturnType<BilibiliUserFilterSession['summary']> } {
    // A newly decoded source must carry its judgment in the same source packet.
    if (this.enabled) for (const source of pool) {
      const id = ownData(source, 'dmid') ?? ownData(source, 'id_str');
      if (typeof id === 'string') this.raw.set(id, source);
    }
    return { revision: this.revision, items: rows.map(row => this.decision(row)), summary: this.summary() };
  }
  private observe(source: unknown, result: unknown): void {
    this.natural.calls++;
    const id = ownData(source, 'dmid') ?? ownData(source, 'id_str');
    const prior = typeof id === 'string' ? this.predicted.get(id) : undefined;
    if (!prior || prior.originalText !== ownData(source, 'text') || prior.decision.state !== 'exclude') return;
    const current = this.reader.read(true);
    if (current.compiled.summary.revision !== prior.decision.revision) { this.natural.changedSnapshot++; this.force = true; return; }
    this.natural.predictedExcludes++;
    if (prior.decision.category === 'regexp') this.natural.regexpPredictions++;
    if (result) {
      this.natural.matchedUserBranch++;
      if (prior.decision.category === 'regexp') this.natural.regexpPredictionsMatchedUserBranch++;
    }
    else {
      this.natural.conflicts++;
      if (prior.decision.category) this.suppressed.add(prior.decision.category);
      this.force = true;
    }
  }
  summary() {
    const sampledHits = { keyword: 0, regexp: 0, sender: 0 };
    for (const { decision } of this.predicted.values()) if (decision.state === 'exclude' && decision.category && decision.category !== 'account') sampledHits[decision.category]++;
    return { ...this.compiled.summary, mainBuildId: BUILD_ID, featureEnabled: this.enabled, revision: this.revision,
      sampledHits,
      matchingMetrics: { ...this.metrics }, semanticAudit: this.audit ? this.compiled.auditSummary() : [],
      semanticFixtures: this.audit ? this.compiled.auditGenerated() : [],
      pollingMs: 2000, natural: { ...this.natural }, suppressedCategories: [...this.suppressed],
      authorInputs: { ...this.authorInputs },
      restored: !this.enabled && !this.restoreObserver && this.restored };
  }
  stop(): boolean { this.enabled = false; this.stopObserver(); this.raw.clear(); this.predicted.clear(); return this.restored; }
}
