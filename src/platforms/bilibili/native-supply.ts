import { needsTranslation } from '../../core/messages.ts';
import { protectText, placeholdersIntact } from '../../translation/text.ts';

export interface NativeSupplyControl {
  enabled: true;
  policy?: 'native' | 'owned';
  runId: string;
  instanceId: string;
  configIdentity: string;
  sourceLanguage: string;
  targetLanguage: string;
  fromMs: number;
  toMs: number;
  state: 'armed' | 'running' | 'paused';
}

export interface PlannedSupplyControl {
  enabled: true;
  configIdentity: string;
  sourceLanguage: string;
  targetLanguage: string;
}

type ActiveSupplyControl = NativeSupplyControl | (PlannedSupplyControl & {
  policy: 'owned'; mode: 'planned'; state: 'running';
});

export interface NativeSupplyPrepared {
  id: string;
  sourceId: string;
  originalText: string;
  text: string;
  status: 'translated' | 'cached';
  epoch: number;
  predictionEpoch: number;
  ruleRevision: number;
  deadlineAtEpochMs: number;
  runId: string;
  instanceId: string;
  configIdentity: string;
  resultId?: string;
}

export type PlannedSupplyPrepared = Omit<NativeSupplyPrepared, 'runId' | 'instanceId'>;

export interface NativeSupplySelection {
  choice: 'out-of-scope' | 'untranslated-needed' | 'untranslated-unneeded' | 'adopted' | 'duplicate';
  reason: string;
  text?: string;
  resultId?: string;
}

interface NativeSource {
  id: string | null;
  sourceId: string | null;
  originalText: string | null;
  mode: number | null;
  canReplace: boolean;
  epoch: number;
  mediaTimeMs: number;
  adopt?: (text: string) => boolean;
}

type EventName = 'candidate' | 'nativeValidate' | 'nativeAdmissionOpportunity' | 'adopted' | 'suppressed' |
  'nativeInitRender' | 'nativeInitError' | 'nativeModel' | 'trackAccepted' | 'trackRejected' |
  'nativeFirstShow' | 'domSample' | 'unneeded' | 'outOfScope' | 'duplicate' | 'contractPaused' |
  'ownedSuppressed' | 'nativeRejected' | 'ownedMiss';

export interface NativeSupplyEvent {
  type: EventName;
  id: string | null;
  sourceId: string | null;
  epoch: number;
  predictionEpoch: number | null;
  ruleRevision: number | null;
  mediaTimeMs: number | null;
  monotonicMs: number;
  atEpochMs: number;
  closed?: boolean;
  reason?: string;
  resultId?: string;
  text?: string;
  originalText?: string;
  status?: string;
  nativeResult?: boolean;
}

interface Options {
  resourceId: string;
  session: string;
  now: () => number;
  epochNow: () => number;
  emit: (event: NativeSupplyEvent) => void;
  pause: () => void;
}

interface Prediction { id: string; originalText: string; epoch: number; predictionEpoch: number; ruleRevision: number }

/** This deliberately never inserts or renames a native event. Its output only
 * describes whether a future, independently reviewed native entry could qualify. */
export function replacementQualification(input: {
  enabled?: boolean; maxLateMs?: number; currentMediaMs: number; scheduledMediaMs: number;
  sameResource: boolean; sameEpoch: boolean; sameRules: boolean; correctIdentity: boolean;
  qualified: boolean; used: boolean; reserved: boolean; nativeAdmitted: boolean;
  layoutKnown: boolean;
}): { eligible: boolean; reason: string } {
  const late = input.maxLateMs ?? 500;
  if (input.enabled !== true) return { eligible: false, reason: 'replacement-disabled' };
  if (!Number.isFinite(late) || late < 0 || late > 1000) return { eligible: false, reason: 'invalid-late-window' };
  if (late === 0) return { eligible: false, reason: 'replacement-disabled' };
  if (!input.sameResource || !input.sameEpoch || !input.sameRules || !input.correctIdentity) return { eligible: false, reason: 'identity-or-rules' };
  if (!input.qualified || input.used || input.reserved) return { eligible: false, reason: 'result-unavailable' };
  if (!input.nativeAdmitted || !input.layoutKnown) return { eligible: false, reason: 'native-admission-or-layout' };
  if (!Number.isFinite(input.currentMediaMs) || !Number.isFinite(input.scheduledMediaMs) ||
    input.currentMediaMs < input.scheduledMediaMs) return { eligible: false, reason: 'future-event' };
  if (input.currentMediaMs > input.scheduledMediaMs + late) return { eligible: false, reason: 'expired-event' };
  return { eligible: true, reason: 'qualified-only-no-native-entry' };
}

const validLabel = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
const nonnegative = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function parseControl(raw: unknown): NativeSupplyControl | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (value.enabled !== true || !validLabel(value.runId) || !validLabel(value.instanceId) ||
    !validLabel(value.configIdentity) || !validLabel(value.sourceLanguage) || !validLabel(value.targetLanguage) ||
    !nonnegative(value.fromMs) || !nonnegative(value.toMs) || (value.toMs as number) <= (value.fromMs as number) ||
    !['armed', 'running', 'paused'].includes(String(value.state)) ||
    (value.policy !== undefined && value.policy !== 'native' && value.policy !== 'owned')) return null;
  return value as unknown as NativeSupplyControl;
}

function parsePlannedControl(raw: unknown): ActiveSupplyControl | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (value.enabled !== true || !validLabel(value.configIdentity) ||
    !validLabel(value.sourceLanguage) || !validLabel(value.targetLanguage)) return null;
  return { enabled: true, policy: 'owned', mode: 'planned', state: 'running',
    configIdentity: value.configIdentity as string, sourceLanguage: value.sourceLanguage as string,
    targetLanguage: value.targetLanguage as string };
}

function parsePrepared(raw: unknown, planned: boolean): NativeSupplyPrepared | PlannedSupplyPrepared | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  if (!validLabel(v.id) || !validLabel(v.sourceId) || typeof v.originalText !== 'string' || !v.originalText || v.originalText.length > 1000 ||
    typeof v.text !== 'string' || !v.text.trim() || v.text.length > 2000 || v.text === v.originalText ||
    !placeholdersIntact(v.originalText, v.text) ||
    !['translated', 'cached'].includes(String(v.status)) || !nonnegative(v.epoch) || !nonnegative(v.predictionEpoch) ||
    !nonnegative(v.ruleRevision) || typeof v.deadlineAtEpochMs !== 'number' ||
    !Number.isFinite(v.deadlineAtEpochMs) || v.deadlineAtEpochMs <= 0 || !validLabel(v.configIdentity) ||
    (!planned && (!validLabel(v.runId) || !validLabel(v.instanceId))) ||
    (v.resultId !== undefined && !validLabel(v.resultId))) return null;
  return v as unknown as NativeSupplyPrepared | PlannedSupplyPrepared;
}

/** MAIN-world display-event state, separated from the background's shared computation/cache. */
export class BilibiliNativeSupply {
  private readonly options: Options;
  private control: ActiveSupplyControl | null = null;
  private pausedReason: string | null = null;
  private predictions = new Map<string, Prediction>();
  private ready = new Map<string, NativeSupplyPrepared | PlannedSupplyPrepared>();
  private closed = new Set<string>();
  private counts: Record<string, number> = {};
  private events: NativeSupplyEvent[] = [];
  private droppedEvents = 0;
  private predictionEpoch: number | null = null;
  private ruleRevision: number | null = null;

  constructor(options: Options) { this.options = options; }
  get active(): boolean { return this.control !== null; }
  get paused(): boolean { return this.pausedReason !== null || this.control?.state === 'paused'; }
  get running(): boolean { return this.control?.state === 'running' && !this.paused; }
  get state(): string { return this.paused ? 'paused' : this.control?.state ?? 'disabled'; }
  get config(): ActiveSupplyControl | null { return this.control; }
  get policy(): 'native' | 'owned' { return this.control?.policy ?? 'native'; }
  get planned(): boolean { return this.control !== null && 'mode' in this.control && this.control.mode === 'planned'; }
  get fault(): string | null { return this.pausedReason; }

  configure(raw: unknown): { activated: boolean; changed: boolean } {
    if (!raw || (raw as any).enabled !== true) {
      const changed = this.active;
      this.control = null; this.pausedReason = null; this.predictions.clear(); this.ready.clear(); this.closed.clear();
      this.predictionEpoch = null; this.ruleRevision = null;
      return { activated: false, changed };
    }
    const value = parseControl(raw);
    if (!value) {
      const activated = !this.active;
      if (!this.control) this.control = { enabled: true, runId: 'invalid', instanceId: 'invalid',
        configIdentity: 'invalid', sourceLanguage: 'auto', targetLanguage: 'ja',
        fromMs: 0, toMs: 24 * 3600 * 1000, state: 'paused' };
      this.fail('invalid-control');
      return { activated, changed: true };
    }
    return this.configureValue(value);
  }

  configurePlanned(raw: unknown): { activated: boolean; changed: boolean } {
    const value = parsePlannedControl(raw);
    if (!value) {
      const activated = !this.active;
      if (!this.planned) {
        this.predictions.clear(); this.ready.clear(); this.closed.clear();
        this.predictionEpoch = null; this.ruleRevision = null; this.pausedReason = null;
        this.control = { enabled: true, policy: 'owned', mode: 'planned', state: 'running',
        configIdentity: 'invalid', sourceLanguage: 'auto', targetLanguage: 'ja' };
      }
      this.fail('invalid-planned-control');
      return { activated, changed: true };
    }
    return this.configureValue(value);
  }

  private configureValue(value: ActiveSupplyControl): { activated: boolean; changed: boolean } {
    const previous = this.control;
    const legacy = (control: ActiveSupplyControl) => 'runId' in control ? control : null;
    const changed = !previous || (this.planned !== ('mode' in value && value.mode === 'planned')) ||
      legacy(previous)?.runId !== legacy(value)?.runId || legacy(previous)?.instanceId !== legacy(value)?.instanceId ||
      previous.configIdentity !== value.configIdentity ||
      ('fromMs' in previous ? previous.fromMs : null) !== ('fromMs' in value ? value.fromMs : null) ||
      ('toMs' in previous ? previous.toMs : null) !== ('toMs' in value ? value.toMs : null) ||
      previous.sourceLanguage !== value.sourceLanguage || previous.targetLanguage !== value.targetLanguage ||
      (previous.policy ?? 'native') !== (value.policy ?? 'native') ||
      value.policy === 'owned' && previous.state !== value.state;
    if (changed) {
      this.predictions.clear(); this.ready.clear(); this.closed.clear(); this.predictionEpoch = null; this.ruleRevision = null;
      if (!previous || previous.configIdentity !== value.configIdentity ||
        legacy(previous)?.runId !== legacy(value)?.runId || legacy(previous)?.instanceId !== legacy(value)?.instanceId ||
        this.planned !== ('mode' in value && value.mode === 'planned')) this.pausedReason = null;
    }
    this.control = value;
    return { activated: !previous, changed };
  }

  recoverPlanned(reason: string): void {
    if (!this.planned || !this.pausedReason) return;
    this.pausedReason = null;
    this.invalidate(reason);
  }

  fail(reason: string): void {
    if (!this.control || this.pausedReason) return;
    this.pausedReason = reason;
    this.ready.clear(); this.predictions.clear();
    this.event('contractPaused', null, null, -1, null, reason, true);
    if (!this.planned) try { this.options.pause(); } catch { /* diagnostic pause failure remains observable */ }
  }

  invalidate(reason: string): void {
    if (!this.active) return;
    this.predictions.clear(); this.ready.clear(); this.closed.clear(); this.predictionEpoch = null; this.ruleRevision = null;
    this.event('contractPaused', null, null, -1, null, `invalidated:${reason}`);
  }

  updatePrediction(value: unknown): void {
    if (!this.control) return;
    const v = value as Record<string, any>;
    if (!v || !nonnegative(v.epoch) || !nonnegative(v.predictionEpoch) || !nonnegative(v.ruleRevision) ||
      v.known !== true || v.active !== true || !Array.isArray(v.items) || v.items.length > 2000) {
      this.predictions.clear(); this.ready.clear(); this.predictionEpoch = null; this.ruleRevision = null;
      return;
    }
    if (this.predictionEpoch !== v.predictionEpoch || this.ruleRevision !== v.ruleRevision) this.ready.clear();
    this.predictionEpoch = v.predictionEpoch; this.ruleRevision = v.ruleRevision;
    const next = new Map<string, Prediction>();
    for (const row of v.items) if (row && validLabel(row.id) && typeof row.originalText === 'string' &&
      row.originalText.length > 0 && row.originalText.length <= 1000) next.set(row.id, {
        id: row.id, originalText: row.originalText, epoch: v.epoch,
        predictionEpoch: v.predictionEpoch, ruleRevision: v.ruleRevision,
      });
    this.predictions = next;
    // A native batch can advance manager.lastTime before insert/initRender. Its
    // already qualified result has left the future forecast by then, but the
    // actual synchronous gate has not happened. Only a changed identity or
    // generation invalidates that ready display event; the live forecast still
    // controls whether a new result may be delivered.
    for (const [id, result] of this.ready) {
      const current = next.get(id);
      if (result.epoch !== v.epoch || current && current.originalText !== result.originalText)
        this.ready.delete(id);
    }
  }

  acceptPrepared(raw: unknown, source: { id: string; sourceId: string; originalText: string } | undefined,
    epoch: number): boolean {
    if (!this.control || this.paused) return false;
    const v = parsePrepared(raw, this.planned), c = this.control;
    if (!v || !source || v.id !== source.id || v.sourceId !== source.sourceId || v.originalText !== source.originalText ||
      (!this.planned && ('runId' in v ? v.runId : null) !== ('runId' in c ? c.runId : null)) ||
      (!this.planned && ('instanceId' in v ? v.instanceId : null) !== ('instanceId' in c ? c.instanceId : null)) ||
      v.configIdentity !== c.configIdentity || v.epoch !== epoch ||
      v.deadlineAtEpochMs < this.options.epochNow() || this.closed.has(`${epoch}\u0000${v.id}\u0000${v.originalText}`)) return false;
    const predicted = this.predictions.get(v.id);
    if (!predicted || predicted.originalText !== v.originalText || predicted.epoch !== epoch ||
      predicted.predictionEpoch !== v.predictionEpoch || predicted.ruleRevision !== v.ruleRevision) return false;
    if (!needsTranslation(v.originalText, c.targetLanguage, c.sourceLanguage) || protectText(v.originalText).reason) return false;
    this.ready.set(v.id, v);
    return true;
  }

  forget(ids: readonly string[]): void {
    for (const id of ids) {
      this.ready.delete(id);
      // Initial source mirroring also emits forget for newly discovered rows.
      // In planned mode the MAIN planner owns membership; a content-side result
      // withdrawal must not erase a newer authoritative plan before delivery.
      if (!this.planned) this.predictions.delete(id);
    }
  }

  event(type: EventName, id: string | null, sourceId: string | null, epoch: number,
    mediaTimeMs: number | null, reason?: string, closed?: boolean, extra: Partial<NativeSupplyEvent> = {}): void {
    if (!this.active) return;
    const value: NativeSupplyEvent = { type, id, sourceId, epoch, predictionEpoch: this.predictionEpoch,
      ruleRevision: this.ruleRevision, mediaTimeMs, monotonicMs: this.options.now(),
      atEpochMs: this.options.epochNow(),
      ...(reason ? { reason } : {}), ...(closed ? { closed } : {}), ...extra };
    this.counts[type] = (this.counts[type] ?? 0) + 1;
    if (this.events.length < 20000) this.events.push(value); else this.droppedEvents++;
    this.options.emit(value);
  }

  /** No admission, consumption, or native side effect occurs during an owned preflight. */
  preflight(source: NativeSource): { eligible: boolean; reason: string } {
    const { id, sourceId, originalText, mode, canReplace, epoch, mediaTimeMs } = source;
    const c = this.control;
    if (!c || this.paused || c.state !== 'running') return { eligible: false, reason: this.pausedReason ?? 'not-running' };
    if (!id || !sourceId || !originalText || !Number.isFinite(mediaTimeMs) ||
      ![1, 4, 5, 6].includes(mode ?? -1)) return { eligible: false, reason: 'source-identity-unavailable' };
    if (this.closed.has(`${epoch}\u0000${id}\u0000${originalText}`)) return { eligible: false, reason: 'terminal-event' };
    if ('fromMs' in c && (mediaTimeMs < c.fromMs || mediaTimeMs > c.toMs))
      return { eligible: false, reason: 'outside-experiment-window' };
    if (!needsTranslation(originalText, c.targetLanguage, c.sourceLanguage) || protectText(originalText).reason)
      return { eligible: true, reason: 'classified-no-translation' };
    if (!canReplace) return { eligible: false, reason: 'native-copy-unsupported' };
    const result = this.ready.get(id);
    if (!result || result.sourceId !== sourceId || result.originalText !== originalText || result.epoch !== epoch ||
      result.predictionEpoch !== this.predictionEpoch || result.ruleRevision !== this.ruleRevision)
      return { eligible: false, reason: 'no-qualified-result' };
    return { eligible: true, reason: 'qualified-result' };
  }

  closeNativeRejected(source: NativeSource): void {
    const { id, sourceId, originalText, epoch, mediaTimeMs } = source;
    this.closed.add(`${epoch}\u0000${id}\u0000${originalText}`);
    if (id) this.ready.delete(id);
    this.event('nativeRejected', id, sourceId, epoch, mediaTimeMs, 'native-did-not-init', true,
      originalText === null ? {} : { originalText });
  }

  closeOwnedSuppressed(source: NativeSource, reason: string): void {
    const { id, sourceId, originalText, epoch, mediaTimeMs } = source;
    this.closed.add(`${epoch}\u0000${id}\u0000${originalText}`);
    if (id) { this.ready.delete(id); this.predictions.delete(id); }
    this.event('ownedSuppressed', id, sourceId, epoch, mediaTimeMs, reason, true,
      originalText === null ? {} : { originalText });
  }

  closeOwnedMiss(id: string, sourceId: string, originalText: string, epoch: number,
    mediaTimeMs: number, reason: string): void {
    this.closed.add(`${epoch}\u0000${id}\u0000${originalText}`);
    this.ready.delete(id); this.predictions.delete(id);
    this.event('ownedMiss', id, sourceId, epoch, mediaTimeMs, reason, true, { originalText });
  }

  select(source: NativeSource): NativeSupplySelection {
    const { id, sourceId, originalText, mode, canReplace, epoch, mediaTimeMs } = source;
    if (!this.control) return { choice: 'out-of-scope', reason: 'disabled' };
    const details = originalText === null ? {} : { originalText };
    this.event('nativeAdmissionOpportunity', id, sourceId, epoch, mediaTimeMs, undefined, false, details);
    if (mode !== 1 && mode !== 4 && mode !== 5 && mode !== 6) {
      this.event('outOfScope', id, sourceId, epoch, mediaTimeMs, 'nonordinary-mode', false, details);
      return { choice: 'out-of-scope', reason: 'nonordinary-mode' };
    }
    const terminal = `${epoch}\u0000${id}\u0000${originalText}`;
    if (this.closed.has(terminal)) {
      this.event('duplicate', id, sourceId, epoch, mediaTimeMs, 'terminal-event', true, details);
      return { choice: 'duplicate', reason: 'terminal-event' };
    }
    this.closed.add(terminal);
    const suppress = (reason: string): NativeSupplySelection => {
      this.event('suppressed', id, sourceId, epoch, mediaTimeMs, reason, true, details);
      return { choice: 'untranslated-needed', reason };
    };
    if (this.paused) return suppress(this.pausedReason ?? 'experiment-paused');
    if (this.control.state !== 'running') return suppress('not-running');
    if (!id || !sourceId || !originalText || originalText.length > 1000 || !Number.isFinite(mediaTimeMs)) {
      this.fail('source-identity-unavailable'); return suppress('source-identity-unavailable');
    }
    if (!needsTranslation(originalText, this.control.targetLanguage, this.control.sourceLanguage) || protectText(originalText).reason) {
      this.event('unneeded', id, sourceId, epoch, mediaTimeMs, 'classified-no-translation', true, details);
      return { choice: 'untranslated-unneeded', reason: 'classified-no-translation' };
    }
    if ('fromMs' in this.control && (mediaTimeMs < this.control.fromMs || mediaTimeMs > this.control.toMs))
      return suppress('outside-experiment-window');
    if (!canReplace) return suppress('native-copy-unsupported');
    const result = this.ready.get(id);
    if (!result || result.sourceId !== sourceId || result.originalText !== originalText || result.epoch !== epoch ||
      result.predictionEpoch !== this.predictionEpoch || result.ruleRevision !== this.ruleRevision) return suppress('no-qualified-result');
    if (source.adopt && !source.adopt(result.text)) {
      this.fail('native-copy-failed');
      return suppress('native-copy-failed');
    }
    this.ready.delete(id);
    this.event('adopted', id, sourceId, epoch, mediaTimeMs, result.status, true,
      { ...details, resultId: result.resultId, text: result.text, status: result.status });
    return { choice: 'adopted', reason: result.status, text: result.text, resultId: result.resultId };
  }

  report(): Record<string, unknown> {
    return { kind: 'bilibili-native-supply', resourceId: this.options.resourceId, session: this.options.session,
      state: this.state, policy: this.policy, planned: this.planned, pausedReason: this.pausedReason,
      runId: this.control && 'runId' in this.control ? this.control.runId : null,
      instanceId: this.control && 'instanceId' in this.control ? this.control.instanceId : null,
      configIdentity: this.control?.configIdentity ?? null,
      predictionEpoch: this.predictionEpoch, ruleRevision: this.ruleRevision, predicted: this.predictions.size,
      ready: this.ready.size, terminal: this.closed.size, counts: { ...this.counts }, events: this.events.slice(),
      droppedEvents: this.droppedEvents, replacement: { enabled: false, maxLateMs: 500,
        reason: 'no-reviewed-native-entry-preserving-identity-and-admission' } };
  }

  summary(): Record<string, unknown> {
    return { state: this.state, policy: this.policy, planned: this.planned, pausedReason: this.pausedReason,
      runId: this.control && 'runId' in this.control ? this.control.runId : null,
      instanceId: this.control && 'instanceId' in this.control ? this.control.instanceId : null,
      configIdentity: this.control?.configIdentity ?? null, counts: { ...this.counts },
      predicted: this.predictions.size, ready: this.ready.size, droppedEvents: this.droppedEvents };
  }
}
