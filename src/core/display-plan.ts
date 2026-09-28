/** A page-local display proposal. It never changes native eligibility or renders a comment. */
export interface DisplayPlanCandidate {
  id: string;
  sourceId: string;
  resourceId: string;
  originalText: string;
  mediaTimeMs: number;
  inScope: boolean;
  needsTranslation: boolean;
  state: 'exclude' | 'retain' | 'unknown';
  nativeFiltered?: boolean;
}

export interface DisplayPlanInput {
  resourceId: string;
  epoch: number;
  mediaTimeMs: number;
  wallTimeMs: number;
  playbackRate: number;
  paused: boolean;
  seeking: boolean;
  contentActive: boolean;
  commentsVisible: boolean | null;
  durationMs: number;
  sourceRevision: number;
  ruleRevision: number;
  contextValid: boolean;
  complete: boolean;
  candidates: DisplayPlanCandidate[];
}

export interface DisplayPlanParameters {
  limit: number | null;
  lookaheadMs: number;
  freezeMs: number;
  bucketMs: number;
  dueGraceMs: number;
}

export interface DisplayPlanEvent {
  id: string;
  sourceId: string;
  originalText: string;
  mediaTimeMs: number;
  resourceId: string;
  epoch: number;
  bucket: number;
  startMs: number;
  selectedAtMs: number;
  selectedWallTimeMs: number;
  leadMs: number;
  coldStart: boolean;
  unknown: boolean;
  needsTranslation: boolean;
  sourceRevision: number;
  ruleRevision: number;
  planRevision: number;
  state: 'frozen' | 'revoked' | 'due' | 'missed';
  reason: string;
  dueAtMs?: number;
  dueMediaTimeMs?: number;
}

export interface DisplayPlanDraft {
  id: string;
  sourceId: string;
  originalText: string;
  resourceId: string;
  epoch: number;
  mediaTimeMs: number;
  bucket: number;
  startMs: number;
  unknown: boolean;
  needsTranslation: boolean;
}

export interface DisplayPlanBucket {
  bucket: number;
  bucketMs: number;
  startMs: number;
  frozenAtMs: number;
  selected: number;
  known: number;
  knownTruncated: boolean;
}

export interface DisplayPlanSnapshot {
  parameters: DisplayPlanParameters;
  resourceId: string;
  epoch: number;
  planRevision: number;
  events: DisplayPlanEvent[];
  buckets: DisplayPlanBucket[];
  drafts: DisplayPlanDraft[];
  reasons: Record<string, number>;
  totals: { selected: number; frozen: number; due: number; missed: number; revoked: number;
    unknown: number; needsTranslation: number; frozenBuckets: number; drafts: number; capacityReached: boolean };
  truncated: boolean;
  truncation: { events: number; buckets: number; drafts: number; knownAtFreeze: number };
  contextValid: boolean;
}

const MAX_CANDIDATES = 50_000;
const MAX_EVENT_HISTORY = 4096;
const MAX_BUCKET_SNAPSHOT = 512;
const MAX_DRAFT_SNAPSHOT = 256;
const MAX_KNOWN_PER_BUCKET = 512;
const MAX_SELECTED_PER_EPOCH = 50_000;
const validTime = (value: number) => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const ordinal = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const byTimeAndSource = (a: DisplayPlanCandidate, b: DisplayPlanCandidate) =>
  a.mediaTimeMs - b.mediaTimeMs || ordinal(a.sourceId, b.sourceId) || ordinal(a.id, b.id);
const sameCandidate = (a: DisplayPlanCandidate, b: DisplayPlanCandidate) =>
  a.id === b.id && a.sourceId === b.sourceId && a.resourceId === b.resourceId &&
  a.originalText === b.originalText && a.mediaTimeMs === b.mediaTimeMs &&
  a.inScope === b.inScope && a.needsTranslation === b.needsTranslation &&
  a.state === b.state && (a.nativeFiltered === true) === (b.nativeFiltered === true);

function parameters(options: Partial<DisplayPlanParameters>): DisplayPlanParameters {
  const value = { limit: 2, lookaheadMs: 10_000, freezeMs: 5_000, bucketMs: 1_000,
    dueGraceMs: 250, ...options };
  if (value.limit !== null && (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > MAX_CANDIDATES) ||
      !Number.isSafeInteger(value.bucketMs) || value.bucketMs < 1 || value.bucketMs > 60_000 ||
      !Number.isSafeInteger(value.lookaheadMs) || value.lookaheadMs < value.bucketMs || value.lookaheadMs > 60_000 ||
      !Number.isSafeInteger(value.freezeMs) || value.freezeMs < 0 || value.freezeMs + value.bucketMs > value.lookaheadMs ||
      Math.ceil(value.freezeMs / value.bucketMs) > MAX_BUCKET_SNAPSHOT ||
      !Number.isSafeInteger(value.dueGraceMs) || value.dueGraceMs < 0 || value.dueGraceMs > value.bucketMs) {
    throw new RangeError('invalid-display-plan-parameters');
  }
  return value;
}

type Ledger = DisplayPlanBucket & { knownAtFreeze: Map<string, string> };

export class DisplayPlanner {
  private params: DisplayPlanParameters;
  private resourceId = '';
  private epoch = -1;
  private planRevision = 1;
  private latestSourceRevision = -1;
  private latestRuleRevision = -1;
  // A monotonic sealed prefix is the non-evictable quota ledger, including empty buckets.
  private sealedThrough = -1;
  private ledger = new Map<string, Ledger>();
  private selectedSources = new Set<string>();
  private events: DisplayPlanEvent[] = [];
  private active = new Map<string, DisplayPlanEvent>();
  private drafts: DisplayPlanDraft[] = [];
  private reasons: Record<string, number> = {};
  private totals = { selected: 0, due: 0, missed: 0, revoked: 0, frozenBuckets: 0 };
  private evictedEvents = 0;
  private evictedBuckets = 0;
  private omittedKnown = 0;
  private omittedDrafts = 0;
  private contextValid = false;
  private stopped = false;
  private coldStart = true;

  constructor(options: Partial<DisplayPlanParameters> = {}) { this.params = parameters(options); }

  configure(options: Partial<DisplayPlanParameters>): DisplayPlanSnapshot {
    const next = parameters({ ...this.params, ...options });
    this.revoke('plan-reconfigured');
    if (this.sealedThrough >= 0) {
      // Seal every new bucket that intersects an old sealed bucket; changing
      // bucket width must not reset the current epoch's spent quota.
      const sealedUntilMs = (this.sealedThrough + 1) * this.params.bucketMs;
      this.sealedThrough = Math.ceil(sealedUntilMs / next.bucketMs) - 1;
    }
    this.params = next;
    this.planRevision++;
    this.stopped = false;
    this.coldStart = true;
    this.drafts = [];
    return this.snapshot();
  }

  stop(reason = 'planner-stopped'): DisplayPlanSnapshot {
    this.revoke(reason);
    this.planRevision++;
    this.stopped = true;
    this.contextValid = false;
    this.drafts = [];
    return this.snapshot();
  }

  update(input: DisplayPlanInput): DisplayPlanSnapshot {
    const validIdentity = typeof input.resourceId === 'string' && !!input.resourceId &&
      Number.isSafeInteger(input.epoch) && input.epoch >= 0;
    if (validIdentity && input.resourceId === this.resourceId && input.epoch < this.epoch) {
      this.reasons = { staleEpoch: 1 };
      this.drafts = [];
      return this.snapshot();
    }
    if (validIdentity && (this.resourceId !== input.resourceId || this.epoch !== input.epoch)) {
      this.revoke('playback-epoch-changed');
      this.resourceId = input.resourceId; this.epoch = input.epoch;
      this.planRevision++;
      this.latestSourceRevision = this.latestRuleRevision = -1;
      this.sealedThrough = -1; this.ledger.clear(); this.selectedSources.clear();
      this.evictedBuckets = this.omittedKnown = 0;
      this.totals = { selected: 0, due: 0, missed: 0, revoked: 0, frozenBuckets: 0 };
      this.coldStart = true;
    }
    this.reasons = {}; this.drafts = []; this.omittedDrafts = 0;
    const invalidInput = !validIdentity || !validTime(input.mediaTimeMs) || !validTime(input.wallTimeMs) ||
      !validTime(input.durationMs) || input.durationMs <= 0 ||
      !Number.isFinite(input.playbackRate) || input.playbackRate < 0 ||
      !Number.isSafeInteger(input.sourceRevision) || input.sourceRevision < 0 ||
      !Number.isSafeInteger(input.ruleRevision) || input.ruleRevision < 0 ||
      !Array.isArray(input.candidates) || input.candidates.length > MAX_CANDIDATES;
    const stale = !invalidInput && (input.sourceRevision < this.latestSourceRevision ||
      input.ruleRevision < this.latestRuleRevision);
    const blocked = invalidInput ? 'invalid-input' : this.stopped ? 'planner-stopped' :
      !input.contextValid ? 'snapshotInvalid' : !input.contentActive ? 'content-inactive' :
      input.commentsVisible === false ? 'comments-hidden' : input.seeking ? 'seeking' :
      input.mediaTimeMs >= input.durationMs ? 'video-ended' : null;
    if (blocked) {
      this.contextValid = false; this.coldStart = true;
      this.reasons[blocked] = 1;
      this.revoke(blocked);
      return this.snapshot();
    }
    if (stale || !input.complete) {
      // An in-flight transaction is not evidence that previously frozen events
      // became ineligible. Keep their subscriptions until a complete revision.
      this.contextValid = false;
      this.reasons[stale ? 'staleRevision' : 'incompleteTransaction'] = 1;
      this.settleDue(input);
      this.trimEvents();
      return this.snapshot();
    }
    this.contextValid = true;
    const revisionChanged = input.sourceRevision !== this.latestSourceRevision ||
      input.ruleRevision !== this.latestRuleRevision;
    this.latestSourceRevision = input.sourceRevision;
    this.latestRuleRevision = input.ruleRevision;

    const candidates = new Map<string, DisplayPlanCandidate | null>();
    const count = (reason: string) => { this.reasons[reason] = (this.reasons[reason] ?? 0) + 1; };
    for (const row of input.candidates) {
      if (!row || typeof row.id !== 'string' || !row.id || row.id.length > 400 ||
          typeof row.sourceId !== 'string' || !row.sourceId || row.sourceId.length > 400 ||
          typeof row.originalText !== 'string' || row.originalText.length > 1000 || !validTime(row.mediaTimeMs) ||
          typeof row.resourceId !== 'string' || !['exclude', 'retain', 'unknown'].includes(row.state) ||
          typeof row.inScope !== 'boolean' || typeof row.needsTranslation !== 'boolean' ||
          row.nativeFiltered !== undefined && typeof row.nativeFiltered !== 'boolean') {
        if (row && typeof row.sourceId === 'string' && row.sourceId) candidates.set(row.sourceId, null);
        count('invalidCandidate'); continue;
      }
      if (row.resourceId !== input.resourceId) { count('wrongResource'); continue; }
      const previous = candidates.get(row.sourceId);
      if (previous === null) continue;
      if (previous && !sameCandidate(previous, row)) candidates.set(row.sourceId, null);
      else if (!previous) candidates.set(row.sourceId, { ...row });
    }
    const rows: DisplayPlanCandidate[] = [];
    for (const candidate of candidates.values()) {
      if (candidate) rows.push(candidate);
      else count('conflictingCandidate');
    }
    for (const event of this.active.values()) {
      const candidate = candidates.get(event.sourceId);
      if (!candidate && (revisionChanged || candidate === null)) { this.terminate(event, 'revoked', 'candidate-unavailable'); continue; }
      if (!candidate) continue;
      if (candidate.id !== event.id || candidate.resourceId !== event.resourceId ||
          candidate.originalText !== event.originalText || candidate.mediaTimeMs !== event.mediaTimeMs ||
          !candidate.inScope || candidate.nativeFiltered || candidate.state === 'exclude') {
        this.terminate(event, 'revoked', 'eligibility-changed'); continue;
      }
      event.sourceRevision = input.sourceRevision;
      event.ruleRevision = input.ruleRevision;
      event.unknown = candidate.state === 'unknown';
    }
    this.settleDue(input);

    const { bucketMs, freezeMs, lookaheadMs, limit } = this.params;
    const currentBucket = Math.floor(input.mediaTimeMs / bucketMs);
    const freezeThrough = Math.min(Math.floor((input.mediaTimeMs + freezeMs) / bucketMs),
      Math.ceil(input.durationMs / bucketMs) - 1);
    const horizon = Math.min(input.durationMs, input.mediaTimeMs + lookaheadMs);
    const freeze = new Map<number, DisplayPlanCandidate[]>();
    const future = new Map<number, DisplayPlanCandidate[]>();
    const seen = new Map<number, Map<string, string>>();
    const seenCount = new Map<number, number>();
    rows.sort(byTimeAndSource);
    for (const row of rows) {
      const bucket = Math.floor(row.mediaTimeMs / bucketMs);
      if (bucket > this.sealedThrough && bucket >= currentBucket && bucket <= freezeThrough && row.mediaTimeMs < input.durationMs) {
        let known = seen.get(bucket);
        if (!known) { known = new Map(); seen.set(bucket, known); }
        seenCount.set(bucket, (seenCount.get(bucket) ?? 0) + 1);
        if (known.size < MAX_KNOWN_PER_BUCKET) known.set(row.sourceId, 'frozenUnselected');
        else this.omittedKnown++;
      }
      if (!row.inScope) { count('outOfScope'); continue; }
      if (row.nativeFiltered) { count('nativeFiltered'); continue; }
      if (row.state === 'exclude') { count('userExcluded'); continue; }
      if (this.selectedSources.has(row.sourceId)) continue;
      if (row.mediaTimeMs >= input.durationMs || row.mediaTimeMs <= input.mediaTimeMs) { count('expired'); continue; }
      if (row.mediaTimeMs > horizon) { count('outsideWindow'); continue; }
      if (bucket <= this.sealedThrough) {
        const prior = this.ledger.get(`${bucketMs}:${bucket}`);
        count(prior?.knownAtFreeze.get(row.sourceId) ??
          (!prior || prior.knownTruncated ? 'frozenUnclassified' : 'lateArrival'));
        continue;
      }
      const target = bucket <= freezeThrough ? freeze : future;
      let group = target.get(bucket);
      if (!group) { group = []; target.set(bucket, group); }
      group.push(row);
    }
    const first = Math.max(currentBucket, this.sealedThrough + 1);
    for (let bucket = first; bucket <= freezeThrough; bucket++) {
      const group = (freeze.get(bucket) ?? []).sort(byTimeAndSource);
      const knownAtFreeze = seen.get(bucket) ?? new Map<string, string>();
      const allowance = Math.max(0, MAX_SELECTED_PER_EPOCH - this.selectedSources.size);
      const chosen = group.slice(0, Math.min(limit ?? group.length, allowance));
      for (const row of group.slice(chosen.length)) {
        const reason = allowance <= chosen.length ? 'capacityNotSelected' : 'densityNotSelected';
        if (knownAtFreeze.has(row.sourceId)) knownAtFreeze.set(row.sourceId, reason);
        count(reason);
      }
      const ledger: Ledger = { bucket, bucketMs, startMs: bucket * bucketMs, frozenAtMs: input.mediaTimeMs,
        selected: chosen.length, known: seenCount.get(bucket) ?? 0,
        knownTruncated: (seenCount.get(bucket) ?? 0) > knownAtFreeze.size, knownAtFreeze };
      this.ledger.set(`${bucketMs}:${bucket}`, ledger); this.totals.frozenBuckets++;
      for (const row of chosen) {
        const event: DisplayPlanEvent = { id: row.id, sourceId: row.sourceId, originalText: row.originalText,
          mediaTimeMs: row.mediaTimeMs, resourceId: input.resourceId, epoch: input.epoch,
          bucket, startMs: bucket * bucketMs, selectedAtMs: input.mediaTimeMs,
          selectedWallTimeMs: input.wallTimeMs, leadMs: row.mediaTimeMs - input.mediaTimeMs,
          coldStart: this.coldStart, unknown: row.state === 'unknown', needsTranslation: row.needsTranslation,
          sourceRevision: input.sourceRevision, ruleRevision: input.ruleRevision, planRevision: this.planRevision,
          state: 'frozen', reason: 'selected' };
        this.events.push(event); this.active.set(row.sourceId, event); this.selectedSources.add(row.sourceId);
        this.totals.selected++; count('selected');
      }
    }
    while (this.ledger.size > MAX_BUCKET_SNAPSHOT) {
      this.ledger.delete(this.ledger.keys().next().value!);
      this.evictedBuckets++;
    }
    this.sealedThrough = Math.max(this.sealedThrough, freezeThrough);
    this.coldStart = false;
    for (const bucket of [...future.keys()].sort((a, b) => a - b)) {
      const group = future.get(bucket)!.sort(byTimeAndSource);
      const chosen = limit === null ? group : group.slice(0, limit);
      for (const row of group.slice(chosen.length)) count('draftDensity');
      for (const row of chosen) {
        if (this.drafts.length >= MAX_DRAFT_SNAPSHOT) { this.omittedDrafts++; continue; }
        this.drafts.push({ id: row.id, sourceId: row.sourceId, originalText: row.originalText,
          resourceId: input.resourceId, epoch: input.epoch, mediaTimeMs: row.mediaTimeMs,
          bucket, startMs: bucket * bucketMs, unknown: row.state === 'unknown',
          needsTranslation: row.needsTranslation });
      }
    }
    this.trimEvents();
    return this.snapshot();
  }

  private terminate(event: DisplayPlanEvent, state: 'revoked' | 'due' | 'missed', reason: string) {
    if (event.state !== 'frozen') return;
    event.state = state; event.reason = reason;
    this.active.delete(event.sourceId);
    this.totals[state]++;
  }

  private settleDue(input: DisplayPlanInput) {
    if (input.paused) return;
    for (const event of [...this.active.values()]) {
      if (input.mediaTimeMs < event.mediaTimeMs) continue;
      event.dueAtMs = input.wallTimeMs;
      event.dueMediaTimeMs = input.mediaTimeMs;
      this.terminate(event, input.mediaTimeMs - event.mediaTimeMs <= this.params.dueGraceMs ? 'due' : 'missed',
        input.mediaTimeMs - event.mediaTimeMs <= this.params.dueGraceMs ? 'planned-due' : 'due-grace-exceeded');
    }
  }

  private revoke(reason: string) {
    for (const event of [...this.active.values()]) this.terminate(event, 'revoked', reason);
    this.trimEvents();
  }

  private trimEvents() {
    let terminal = this.events.length - this.active.size;
    if (terminal <= MAX_EVENT_HISTORY) return;
    this.events = this.events.filter(event => {
      if (event.state !== 'frozen' && terminal > MAX_EVENT_HISTORY) {
        terminal--; this.evictedEvents++; return false;
      }
      return true;
    });
  }

  snapshot(): DisplayPlanSnapshot {
    const allBuckets = [...this.ledger.values()].sort((a, b) => a.startMs - b.startMs || a.bucketMs - b.bucketMs);
    const active = [...this.active.values()];
    return { parameters: { ...this.params }, resourceId: this.resourceId, epoch: this.epoch,
      planRevision: this.planRevision, events: this.events.map(event => ({ ...event })),
      buckets: allBuckets.map(({ knownAtFreeze: _, ...bucket }) => ({ ...bucket })),
      drafts: this.drafts.map(draft => ({ ...draft })), reasons: { ...this.reasons },
      totals: { ...this.totals, frozen: active.length,
        unknown: active.filter(event => event.unknown).length,
        needsTranslation: active.filter(event => event.needsTranslation).length,
        drafts: this.drafts.length + this.omittedDrafts,
        capacityReached: this.selectedSources.size >= MAX_SELECTED_PER_EPOCH },
      truncated: this.evictedEvents > 0 || this.evictedBuckets > 0 || this.omittedDrafts > 0 || this.omittedKnown > 0,
      truncation: { events: this.evictedEvents, buckets: this.evictedBuckets,
        drafts: this.omittedDrafts, knownAtFreeze: this.omittedKnown },
      contextValid: this.contextValid };
  }
}
