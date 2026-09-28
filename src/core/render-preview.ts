import type { DisplayPlanEvent } from './display-plan.ts';

export type RenderPreviewMode = 'original' | 'stored-translation';
export type RenderPreviewState = 'unallocated' | 'reserved' | 'committed' | 'exited' |
  'missed' | 'oversize' | 'text-unsupported' | 'layout-rejected' | 'revoked' |
  'environment-reset' | 'layout-reset' | 'hidden-skipped' | 'closed';
export interface RenderPreviewLayout {
  widthPx: number; heightPx: number; fontSizePx: number; lineHeightPx: number;
  paddingXPx: number; paddingYPx: number; gapPx: number; safetyPx?: number;
}
/** The measurement must use the drawing element's font, white-space and box model. */
export interface RenderPreviewMeasurement { widthPx: number; heightPx: number; lines: number }
export interface RenderPreviewTranslation {
  resourceId: string; epoch: number; id: string; sourceId: string; originalText: string;
  targetLanguage: string; text: string; availableAtWallMs: number; availableAtMediaMs?: number;
  origin?: 'existing-cache' | 'export' | 'live-local';
  runId?: string; requestId?: string; resultId?: string; configIdentity?: string;
}
export interface RenderPreviewOptions {
  measure: (text: string, layout: RenderPreviewLayout) => RenderPreviewMeasurement;
  mode?: RenderPreviewMode;
  targetLanguage?: string;
  resolveTranslation?: (event: DisplayPlanEvent) => RenderPreviewTranslation | undefined;
  onEarlyReject?: (event: DisplayPlanEvent, reason: 'oversize' | 'text-unsupported' | 'layout-rejected') => void;
  maxRecords?: number; maxSamples?: number;
}
export interface RenderPreviewSync {
  resourceId: string; epoch: number; mediaTimeMs: number; events: readonly DisplayPlanEvent[];
  contextValid: boolean;
  eligibility?: (event: DisplayPlanEvent) => 'exclude' | 'retain' | 'unknown';
}
export interface RenderPreviewTick { mediaTimeMs: number; wallTimeMs: number; paused?: boolean; seeking?: boolean }
export interface RenderPreviewItem {
  key: string; text: string; xPx: number; yPx: number; widthPx: number; heightPx: number;
  lane: number; unknown: boolean; sourceMode: RenderPreviewMode; layoutRevision: number;
  origin: RenderPreviewTranslation['origin'] | null;
  runId: string | null; requestId: string | null; resultId: string | null; configIdentity: string | null;
}

interface Entry {
  key: string; event: DisplayPlanEvent; state: RenderPreviewState; reason: string;
  unknown: boolean; lane: number | null; measured?: RenderPreviewMeasurement;
  occupiedWidthPx?: number; layoutRevision?: number; sourceMode?: RenderPreviewMode;
  displayedText?: string; chosenAtMediaMs?: number; chosenAtWallMs?: number;
  latenessMs?: number; endMs?: number; terminalAtMediaMs?: number;
  translationAvailableBeforeDue?: boolean | null; translationLayoutFallback?: boolean;
  translationMissing?: boolean; translationReadyButRejected?: boolean; lateResultCount: number;
  visibleSamples: number;
  previewReadyAtWallMs?: number; previewReadyAtMediaMs?: number;
  textLockedAtWallMs?: number; textLockedAtMediaMs?: number;
  renderSubmittedAtWallMs?: number; renderSubmittedAtMediaMs?: number;
  chosenText?: string; selectedResult?: Pick<RenderPreviewTranslation,
    'origin' | 'runId' | 'requestId' | 'resultId' | 'configIdentity'>;
}
interface LayoutRecord extends RenderPreviewLayout { revision: number; laneHeightPx: number; laneCount: number; speedPxPerMs: number }
interface VisibleSample { key: string; mediaTimeMs: number; wallTimeMs: number; xPx: number; yPx: number;
  layoutRevision: number; sourceMode: RenderPreviewMode; origin: RenderPreviewTranslation['origin'] | null;
  runId: string | null; requestId: string | null; resultId: string | null; configIdentity: string | null }
const valid = (n: number) => Number.isFinite(n) && n >= 0;
const keyOf = (row: DisplayPlanEvent) => JSON.stringify([row.resourceId, row.epoch, row.id]);
const order = (a: Entry, b: Entry) => a.event.mediaTimeMs - b.event.mediaTimeMs ||
  (a.event.sourceId < b.event.sourceId ? -1 : a.event.sourceId > b.event.sourceId ? 1 : 0) ||
  (a.event.id < b.event.id ? -1 : a.event.id > b.event.id ? 1 : 0);
const terminal = (state: RenderPreviewState) => !['unallocated', 'reserved', 'committed'].includes(state);
const MAX_MEASUREMENTS = 512;
const sourceTrace = (row: Entry) => ({ origin: row.selectedResult?.origin ?? null,
  runId: row.selectedResult?.runId ?? null, requestId: row.selectedResult?.requestId ?? null,
  resultId: row.selectedResult?.resultId ?? null, configIdentity: row.selectedResult?.configIdentity ?? null });

/** A separate, page-local renderer ledger. No DOM, provider, adapter or planner calls. */
export class RenderPreviewEngine {
  private readonly options: RenderPreviewOptions;
  private readonly records = new Map<string, Entry>();
  private readonly lanes: Entry[][] = [];
  private readonly layouts: LayoutRecord[] = [];
  private readonly samples: VisibleSample[] = [];
  private readonly measurements = new Map<string, RenderPreviewMeasurement>();
  private readonly earlyRejected: { resourceId: string; epoch: number; id: string }[] = [];
  private readonly maxRecords: number;
  private readonly maxSamples: number;
  private current?: LayoutRecord;
  private resourceId = '';
  private epoch = -1;
  private lastMediaTimeMs = -1;
  private mode: RenderPreviewMode;
  private visible = true;
  private closed = false;
  private budgetExceeded = false;
  private sampleTruncated = false;
  private hiddenCutoffMs = -1;

  constructor(options: RenderPreviewOptions) {
    this.options = options;
    this.mode = options.mode ?? 'original';
    if (this.mode === 'stored-translation' && !options.targetLanguage) throw new RangeError('target-language-required');
    this.maxRecords = options.maxRecords ?? 4096;
    this.maxSamples = options.maxSamples ?? 2048;
    if (!Number.isSafeInteger(this.maxRecords) || this.maxRecords < 1 ||
        !Number.isSafeInteger(this.maxSamples) || this.maxSamples < 1) throw new RangeError('render-preview-budget-invalid');
  }

  setMode(mode: RenderPreviewMode) {
    if (mode === 'stored-translation' && !this.options.targetLanguage) throw new RangeError('target-language-required');
    this.mode = mode; // Locked text on committed objects is never changed.
  }

  setLayout(layout: RenderPreviewLayout, mediaTimeMs: number) {
    if (this.closed) return;
    const fields = [layout.widthPx, layout.heightPx, layout.fontSizePx, layout.lineHeightPx,
      layout.paddingXPx, layout.paddingYPx, layout.gapPx, layout.safetyPx ?? 2];
    if (fields.some(value => !valid(value)) || fields.slice(0, 4).some(value => value === 0) ||
        !valid(mediaTimeMs) || layout.widthPx < layout.gapPx || layout.lineHeightPx < layout.fontSizePx)
      throw new RangeError('render-preview-layout-invalid');
    const laneHeightPx = layout.lineHeightPx + 2 * layout.paddingYPx;
    const laneCount = Math.floor(layout.heightPx / laneHeightPx);
    if (laneCount < 1) throw new RangeError('render-preview-no-lanes');
    const base = { ...layout, safetyPx: layout.safetyPx ?? 2 };
    if (this.current && Object.keys(base).every(key =>
      (this.current as unknown as Record<string, number>)[key] === (base as unknown as Record<string, number>)[key])) return;
    if (this.layouts.length >= 64) { this.exhaust(mediaTimeMs); return; }
    if (this.current) {
      for (const row of this.records.values()) {
        if (row.state === 'committed') this.end(row, 'layout-reset', 'layout-changed', mediaTimeMs);
        else if (row.state === 'reserved' || row.state === 'unallocated') {
          this.release(row);
          if (row.event.mediaTimeMs <= mediaTimeMs) this.end(row, 'layout-reset', 'layout-changed', mediaTimeMs);
          else { row.state = 'unallocated'; row.measured = undefined; row.occupiedWidthPx = undefined; }
        }
      }
      this.measurements.clear();
    }
    this.lanes.length = 0;
    const current = { ...base, revision: this.layouts.length + 1, laneHeightPx, laneCount,
      speedPxPerMs: layout.widthPx / 6000 };
    this.current = current; this.layouts.push(current);
    for (let i = 0; i < laneCount; i++) this.lanes.push([]);
    this.reserveFuture(mediaTimeMs);
  }

  /** Returns exact IDs preflight-rejected early or confirmed layout-rejected since the last sync. */
  sync(input: RenderPreviewSync): string[] {
    if (this.closed || this.budgetExceeded) return [];
    if (!input.resourceId || !Number.isSafeInteger(input.epoch) || input.epoch < 0 || !valid(input.mediaTimeMs))
      throw new RangeError('render-preview-identity-invalid');
    if (this.resourceId !== input.resourceId || this.epoch !== input.epoch) {
      this.earlyRejected.length = 0;
      this.resetActive('environment-reset', 'epoch-changed', input.mediaTimeMs);
      this.resourceId = input.resourceId; this.epoch = input.epoch;
      this.lastMediaTimeMs = input.mediaTimeMs;
      this.hiddenCutoffMs = this.visible ? -1 : input.mediaTimeMs;
    }
    if (!input.contextValid) {
      this.resetActive('revoked', 'context-invalid', input.mediaTimeMs);
      this.earlyRejected.length = 0;
      return [];
    }
    const present = new Set<string>();
    for (const event of [...input.events].sort((a, b) => a.mediaTimeMs - b.mediaTimeMs ||
      (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0))) {
      if (event.resourceId !== input.resourceId || event.epoch !== input.epoch ||
          !event.id || !event.sourceId || !valid(event.mediaTimeMs)) continue;
      const key = keyOf(event);
      present.add(key);
      let row = this.records.get(key);
      if (!row) {
        if (this.records.size >= this.maxRecords) { this.exhaust(input.mediaTimeMs); return []; }
        row = { key, event: { ...event }, state: 'unallocated', reason: '', unknown: event.unknown,
          lane: null, lateResultCount: 0, visibleSamples: 0 };
        this.records.set(key, row);
      } else if (row.event.sourceId !== event.sourceId || row.event.originalText !== event.originalText ||
                 row.event.mediaTimeMs !== event.mediaTimeMs) {
        if (!terminal(row.state)) this.end(row, 'revoked', 'source-changed', input.mediaTimeMs);
        continue;
      } else row.unknown = event.unknown;
      if (terminal(row.state)) continue; // Never resurrect a spent selected event.
      const eligible = input.eligibility?.(event) ?? (event.unknown ? 'unknown' : 'retain');
      if (eligible === 'exclude' || event.state === 'revoked') {
        this.end(row, 'revoked', eligible === 'exclude' ? 'rule-excluded' : 'planner-revoked', input.mediaTimeMs);
        continue;
      }
      // Planner's low-frequency missed state is not a renderer deadline.
      // The first media tick independently applies t0 + 250ms.
      if (!this.visible) continue;
      if (row.state === 'unallocated' && row.event.mediaTimeMs > input.mediaTimeMs)
        this.reserve(row, input.mediaTimeMs);
    }
    for (const row of this.records.values()) if (row.event.resourceId === input.resourceId &&
      row.event.epoch === input.epoch && !present.has(row.key) && !terminal(row.state))
      this.end(row, 'revoked', 'selection-removed', input.mediaTimeMs);
    return [...new Set(this.earlyRejected.splice(0)
      .filter(row => row.resourceId === input.resourceId && row.epoch === input.epoch).map(row => row.id))];
  }

  setVisible(visible: boolean, mediaTimeMs: number) {
    if (this.closed || !valid(mediaTimeMs) || visible === this.visible) return;
    this.visible = visible;
    if (!visible) {
      for (const row of this.records.values()) if (row.state === 'committed')
        this.end(row, 'environment-reset', 'hidden', mediaTimeMs);
      this.hiddenCutoffMs = mediaTimeMs;
    } else {
      this.hiddenCutoffMs = mediaTimeMs;
      for (const row of this.records.values()) if ((row.state === 'reserved' || row.state === 'unallocated') &&
        row.event.mediaTimeMs <= mediaTimeMs)
        this.end(row, 'hidden-skipped', 'hidden-gap', mediaTimeMs);
      this.reserveFuture(mediaTimeMs);
    }
  }

  tick(input: RenderPreviewTick): { active: RenderPreviewItem[]; counts: Record<string, number> } {
    if (this.closed || !this.current || !this.visible || this.budgetExceeded) return { active: [], counts: this.counts() };
    if (!valid(input.mediaTimeMs) || !valid(input.wallTimeMs)) throw new RangeError('render-preview-clock-invalid');
    if (input.seeking || this.lastMediaTimeMs >= 0 && input.mediaTimeMs + 1 < this.lastMediaTimeMs) {
      this.resetActive('environment-reset', input.seeking ? 'seeking' : 'media-time-reversed', input.mediaTimeMs);
      this.hiddenCutoffMs = Math.max(this.hiddenCutoffMs, input.mediaTimeMs);
      return { active: [], counts: this.counts() };
    }
    const mediaTimeMs = input.paused && this.lastMediaTimeMs >= 0 ? this.lastMediaTimeMs : input.mediaTimeMs;
    this.lastMediaTimeMs = mediaTimeMs;
    for (const row of [...this.records.values()].filter(row => row.event.resourceId === this.resourceId &&
      row.event.epoch === this.epoch && !terminal(row.state)).sort(order)) {
      if (row.state === 'committed') {
        if (mediaTimeMs >= (row.endMs ?? Infinity)) this.end(row, 'exited', 'natural-exit', mediaTimeMs);
        continue;
      }
      const due = row.event.mediaTimeMs;
      if (due > mediaTimeMs) continue;
      if (due <= this.hiddenCutoffMs) { this.end(row, 'hidden-skipped', 'hidden-gap', mediaTimeMs); continue; }
      if (mediaTimeMs - due > 250) { this.end(row, 'missed', 'schedule-late', mediaTimeMs); continue; }
      this.enter(row, mediaTimeMs, input.wallTimeMs);
    }
    return { active: [...this.records.values()].filter(row => row.state === 'committed' &&
      row.event.resourceId === this.resourceId && row.event.epoch === this.epoch)
      .map(row => this.draw(row, mediaTimeMs)), counts: this.counts() };
  }

  sampleVisible(keys: readonly string[], mediaTimeMs: number, wallTimeMs: number) {
    if (this.closed || !this.visible || !valid(mediaTimeMs) || !valid(wallTimeMs)) return;
    for (const key of new Set(keys)) {
      const row = this.records.get(key);
      if (!row || row.state !== 'committed' || row.event.resourceId !== this.resourceId ||
          row.event.epoch !== this.epoch || mediaTimeMs < row.event.mediaTimeMs ||
          mediaTimeMs >= (row.endMs ?? Infinity)) continue;
      const position = this.draw(row, mediaTimeMs);
      const layout = this.layouts.find(value => value.revision === row.layoutRevision);
      if (!layout || position.xPx + position.widthPx <= 0 || position.xPx >= layout.widthPx) continue;
      row.visibleSamples++;
      if (this.samples.length < this.maxSamples) this.samples.push({ key, mediaTimeMs, wallTimeMs,
        xPx: position.xPx, yPx: position.yPx, layoutRevision: row.layoutRevision!,
        sourceMode: row.sourceMode!, ...sourceTrace(row) });
      else this.sampleTruncated = true;
    }
  }

  noteTranslationResult(result: RenderPreviewTranslation) {
    const row = this.records.get(JSON.stringify([result.resourceId, result.epoch, result.id]));
    if (!row || !this.validTranslation(row, result)) return;
    if (row.previewReadyAtWallMs === undefined || result.availableAtWallMs < row.previewReadyAtWallMs) {
      row.previewReadyAtWallMs = result.availableAtWallMs;
      row.previewReadyAtMediaMs = result.availableAtMediaMs;
    }
    if (row.chosenAtWallMs !== undefined && result.availableAtWallMs > row.chosenAtWallMs)
      row.lateResultCount++;
  }

  report(includeText = false) {
    const records = [...this.records.values()].map(row => ({ key: row.key, resourceId: row.event.resourceId,
      epoch: row.event.epoch, id: row.event.id, sourceId: row.event.sourceId,
      originalLength: row.event.originalText.length, mediaTimeMs: row.event.mediaTimeMs,
      state: row.state, reason: row.reason, unknown: row.unknown, lane: row.lane,
      widthPx: row.measured?.widthPx ?? null, heightPx: row.measured?.heightPx ?? null,
      occupiedWidthPx: row.occupiedWidthPx ?? null, layoutRevision: row.layoutRevision ?? null,
      chosenAtMediaMs: row.chosenAtMediaMs ?? null, chosenAtWallMs: row.chosenAtWallMs ?? null,
      latenessMs: row.latenessMs ?? null, endMs: row.endMs ?? null,
      terminalAtMediaMs: row.terminalAtMediaMs ?? null, sourceMode: row.sourceMode ?? null,
      translationAvailableBeforeDue: row.translationAvailableBeforeDue ?? null,
      translationLayoutFallback: row.translationLayoutFallback === true,
      translationMissing: row.translationMissing === true,
      translationReadyButRejected: row.translationReadyButRejected === true,
      lateResultCount: row.lateResultCount, visibleSamples: row.visibleSamples,
      previewReadyAtWallMs: row.previewReadyAtWallMs ?? null,
      previewReadyAtMediaMs: row.previewReadyAtMediaMs ?? null,
      textLockedAtWallMs: row.textLockedAtWallMs ?? null,
      textLockedAtMediaMs: row.textLockedAtMediaMs ?? null,
      renderSubmittedAtWallMs: row.renderSubmittedAtWallMs ?? null,
      renderSubmittedAtMediaMs: row.renderSubmittedAtMediaMs ?? null,
      ...sourceTrace(row), ...(includeText ? { chosenText: row.chosenText ?? null } : {}) }));
    const lateness = records.filter(row => row.latenessMs !== null).map(row => row.latenessMs!).sort((a, b) => a - b);
    return { contract: 'render-preview-v1', resourceId: this.resourceId, epoch: this.epoch,
      mode: this.mode, visible: this.visible, closed: this.closed, limits: { maxRecords: this.maxRecords,
        maxSamples: this.maxSamples, maxMeasurements: MAX_MEASUREMENTS, maxLayouts: 64 },
      truncated: { records: this.budgetExceeded, samples: this.sampleTruncated },
      layouts: this.layouts.map(layout => ({ ...layout })), records, samples: this.samples.map(row => ({ ...row })),
      counts: this.counts(), lateness: { count: lateness.length, minMs: lateness[0] ?? null,
        medianMs: lateness.length ? lateness[Math.ceil(lateness.length / 2) - 1] : null,
        p95Ms: lateness.length ? lateness[Math.ceil(lateness.length * .95) - 1] : null,
        maxMs: lateness.at(-1) ?? null } };
  }

  close(mediaTimeMs = this.lastMediaTimeMs) {
    if (this.closed) return;
    this.resetActive('closed', 'preview-closed', Math.max(0, mediaTimeMs));
    for (const row of this.records.values()) {
      row.event.originalText = ''; row.displayedText = undefined; row.chosenText = undefined;
    }
    this.lanes.length = 0; this.measurements.clear(); this.closed = true;
  }

  private counts() {
    const values: Record<string, number> = { selected: this.records.size, entered: 0, unknown: 0, visibleDistinct: 0,
      translationLayoutFallback: 0, translationReadyButRejected: 0, lateResults: 0 };
    for (const row of this.records.values()) {
      values[row.state] = (values[row.state] ?? 0) + 1;
      if (row.chosenAtMediaMs !== undefined) values.entered = (values.entered ?? 0) + 1;
      if (row.unknown) values.unknown = (values.unknown ?? 0) + 1;
      if (row.sourceMode) values[row.sourceMode] = (values[row.sourceMode] ?? 0) + 1;
      if (row.visibleSamples) values.visibleDistinct = (values.visibleDistinct ?? 0) + 1;
      if (row.translationLayoutFallback) values.translationLayoutFallback = (values.translationLayoutFallback ?? 0) + 1;
      if (row.translationReadyButRejected) values.translationReadyButRejected = (values.translationReadyButRejected ?? 0) + 1;
      values.lateResults = (values.lateResults ?? 0) + row.lateResultCount;
    }
    return values;
  }

  private measure(text: string): { value?: RenderPreviewMeasurement; reason?: 'text-unsupported' | 'oversize' } {
    const layout = this.current!;
    if (!text || /[\r\n\v\f\u0085\u2028\u2029]/u.test(text)) return { reason: 'text-unsupported' };
    const key = JSON.stringify([layout.revision, text]);
    let value = this.measurements.get(key);
    if (!value) {
      try { value = this.options.measure(text, layout); } catch { return { reason: 'text-unsupported' }; }
      if (!value || !valid(value.widthPx) || value.widthPx === 0 || !valid(value.heightPx) ||
          value.heightPx === 0 || value.lines !== 1 || value.heightPx > layout.laneHeightPx + 0.01)
        return { reason: 'text-unsupported' };
      if (this.measurements.size >= MAX_MEASUREMENTS) this.measurements.clear();
      this.measurements.set(key, value);
    }
    if ((layout.widthPx + value.widthPx + layout.safetyPx!) / layout.speedPxPerMs > 18_000)
      return { reason: 'oversize' };
    return { value };
  }

  private reserveFuture(mediaTimeMs: number) {
    if (!this.current || !this.visible) return;
    for (const row of [...this.records.values()].filter(row => row.state === 'unallocated' &&
      row.event.resourceId === this.resourceId && row.event.epoch === this.epoch &&
      row.event.mediaTimeMs > mediaTimeMs).sort(order)) this.reserve(row, mediaTimeMs);
  }

  private reserve(row: Entry, mediaTimeMs: number) {
    if (!this.current || row.state !== 'unallocated') return;
    const measured = this.measure(row.event.originalText);
    if (measured.reason) {
      this.end(row, measured.reason, measured.reason, mediaTimeMs);
      if (mediaTimeMs < row.event.mediaTimeMs) this.earlyRejected.push({ resourceId: row.event.resourceId,
        epoch: row.event.epoch, id: row.event.id });
      try { this.options.onEarlyReject?.(row.event, measured.reason); } catch { /* Diagnostic callback cannot alter geometry. */ }
      return;
    }
    const lane = this.findLane(row, measured.value!.widthPx + this.current.safetyPx!);
    if (lane < 0) return; // A future revocation may release space before the deadline.
    row.measured = measured.value; row.occupiedWidthPx = measured.value!.widthPx + this.current.safetyPx!;
    row.layoutRevision = this.current.revision; row.lane = lane; row.state = 'reserved';
    this.lanes[lane]!.push(row); this.lanes[lane]!.sort(order);
  }

  private findLane(row: Entry, occupiedWidthPx: number): number {
    const layout = this.current!;
    for (let lane = 0; lane < layout.laneCount; lane++) {
      const values = this.lanes[lane]!.filter(other => other !== row).sort(order);
      const index = values.findIndex(other => order(other, row) > 0);
      const previous = index === 0 ? undefined : (index < 0 ? values.at(-1) : values[index - 1]);
      const next = index < 0 ? undefined : values[index];
      if (previous && layout.speedPxPerMs * (row.event.mediaTimeMs - previous.event.mediaTimeMs) + 1e-6 <
          (previous.occupiedWidthPx ?? 0) + layout.gapPx) continue;
      if (next && layout.speedPxPerMs * (next.event.mediaTimeMs - row.event.mediaTimeMs) + 1e-6 <
          occupiedWidthPx + layout.gapPx) continue;
      return lane;
    }
    return -1;
  }

  private validTranslation(row: Entry, result: RenderPreviewTranslation) {
    return result.resourceId === row.event.resourceId && result.epoch === row.event.epoch &&
      result.id === row.event.id && result.sourceId === row.event.sourceId &&
      result.originalText === row.event.originalText && result.targetLanguage === this.options.targetLanguage &&
      typeof result.text === 'string' && !!result.text && valid(result.availableAtWallMs) &&
      (result.availableAtMediaMs === undefined || valid(result.availableAtMediaMs));
  }

  private enter(row: Entry, mediaTimeMs: number, wallTimeMs: number) {
    this.release(row);
    row.textLockedAtMediaMs = mediaTimeMs; row.textLockedAtWallMs = wallTimeMs;
    let translation: RenderPreviewTranslation | undefined;
    if (this.mode === 'stored-translation') {
      try { translation = this.options.resolveTranslation?.(row.event); } catch { /* Invalid seed falls back to source. */ }
    }
    const ready = translation && this.validTranslation(row, translation) &&
      translation.availableAtWallMs <= wallTimeMs ? translation : undefined;
    if (ready && (row.previewReadyAtWallMs === undefined || ready.availableAtWallMs < row.previewReadyAtWallMs)) {
      row.previewReadyAtWallMs = ready.availableAtWallMs;
      row.previewReadyAtMediaMs = ready.availableAtMediaMs;
    }
    let selected: { value?: RenderPreviewMeasurement; reason?: 'text-unsupported' | 'oversize' } | undefined;
    let lane = -1, text = row.event.originalText, mode: RenderPreviewMode = 'original';
    if (ready) {
      const proposed = this.measure(ready.text);
      if (proposed.value) {
        const choice = this.findLane(row, proposed.value.widthPx + this.current!.safetyPx!);
        if (choice >= 0) { selected = proposed; lane = choice; text = ready.text; mode = 'stored-translation'; }
      }
      if (lane < 0) { row.translationLayoutFallback = true; row.translationReadyButRejected = true; }
    } else if (this.mode === 'stored-translation') row.translationMissing = true;
    if (lane < 0) {
      selected = this.measure(row.event.originalText);
      if (selected.value) lane = this.findLane(row, selected.value.widthPx + this.current!.safetyPx!);
    }
    if (!selected?.value || lane < 0) {
      const reason = selected?.reason ?? 'layout-rejected';
      this.end(row, reason, selected?.reason ?? 'no-lane', mediaTimeMs);
      if (reason === 'layout-rejected') {
        this.earlyRejected.push({ resourceId: row.event.resourceId, epoch: row.event.epoch, id: row.event.id });
        try { this.options.onEarlyReject?.(row.event, reason); } catch { /* Diagnostic callback cannot alter geometry. */ }
      }
      return;
    }
    row.state = 'committed'; row.reason = 'render-committed'; row.lane = lane;
    row.measured = selected.value; row.occupiedWidthPx = selected.value.widthPx + this.current!.safetyPx!;
    row.layoutRevision = this.current!.revision; row.displayedText = text; row.chosenText = text;
    row.sourceMode = mode;
    row.selectedResult = mode === 'stored-translation' ? {
      origin: ready?.origin, runId: ready?.runId, requestId: ready?.requestId,
      resultId: ready?.resultId, configIdentity: ready?.configIdentity } : undefined;
    row.chosenAtMediaMs = mediaTimeMs; row.chosenAtWallMs = wallTimeMs;
    row.renderSubmittedAtMediaMs = mediaTimeMs; row.renderSubmittedAtWallMs = wallTimeMs;
    row.latenessMs = mediaTimeMs - row.event.mediaTimeMs;
    row.endMs = row.event.mediaTimeMs + (this.current!.widthPx + row.occupiedWidthPx) / this.current!.speedPxPerMs;
    row.translationAvailableBeforeDue = ready?.availableAtMediaMs === undefined ? null :
      ready.availableAtMediaMs <= row.event.mediaTimeMs;
    this.lanes[lane]!.push(row); this.lanes[lane]!.sort(order);
  }

  private draw(row: Entry, mediaTimeMs: number): RenderPreviewItem {
    const layout = this.layouts.find(value => value.revision === row.layoutRevision)!;
    return { key: row.key, text: row.displayedText!,
      xPx: layout.widthPx - layout.speedPxPerMs * (mediaTimeMs - row.event.mediaTimeMs),
      yPx: row.lane! * layout.laneHeightPx, widthPx: row.measured!.widthPx,
      heightPx: row.measured!.heightPx, lane: row.lane!, unknown: row.unknown,
      sourceMode: row.sourceMode!, layoutRevision: layout.revision, ...sourceTrace(row) };
  }

  private release(row: Entry) {
    if (row.lane !== null) {
      const lane = this.lanes[row.lane];
      if (lane) { const index = lane.indexOf(row); if (index >= 0) lane.splice(index, 1); }
      row.lane = null;
    }
  }

  private end(row: Entry, state: RenderPreviewState, reason: string, mediaTimeMs: number) {
    const committedLane = row.chosenAtMediaMs === undefined ? null : row.lane;
    this.release(row); row.state = state; row.reason = reason; row.terminalAtMediaMs = mediaTimeMs;
    if (committedLane !== null) row.lane = committedLane; // Keep finalized geometry for independent inspection.
    row.displayedText = undefined;
  }

  private resetActive(state: RenderPreviewState, reason: string, mediaTimeMs: number) {
    for (const row of this.records.values()) if (!terminal(row.state)) this.end(row, state, reason, mediaTimeMs);
    for (const lane of this.lanes) lane.length = 0;
    this.measurements.clear();
  }

  private exhaust(mediaTimeMs: number) {
    this.budgetExceeded = true;
    this.resetActive('environment-reset', 'record-budget-exhausted', mediaTimeMs);
  }
}
