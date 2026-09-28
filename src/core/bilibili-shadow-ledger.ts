export type BilibiliShadowEventType = 'shadowSelected' | 'nativeValidate' | 'nativeInitRender' | 'nativeFirstShow';

export interface BilibiliShadowEvent {
  type: BilibiliShadowEventType;
  id: string;
  originalText: string;
  epoch: number;
  mediaTimeMs: number;
  wallTimeMs: number;
  stimeMs: number;
  result?: boolean;
  reasons?: string[];
  predictedInitMs?: number;
}

type PredictionStatus = 'pending' | 'matched' | 'falsePositive' | 'censored';

interface Prediction {
  selected: BilibiliShadowEvent;
  status: PredictionStatus;
  deadlineMs: number;
  steady: boolean;
  matchedInit?: BilibiliShadowEvent;
  censoredBy?: string;
}

interface Admission {
  event: BilibiliShadowEvent;
  steady: boolean;
  prediction?: Prediction;
}

export interface BilibiliShadowMetrics {
  matchedPredictions: number;
  falsePositives: number;
  pendingPredictions: number;
  censoredPredictions: number;
  maturedPredictions: number;
  actualInit: number;
  predictedBeforeInit: number;
  precision: number | null;
  recall: number | null;
  leadMs: {
    min: number | null;
    p10: number | null;
    p50: number | null;
    samples: number;
    atLeast3000Count: number;
    atLeast3000Ratio: number | null;
  };
}

function copyEvent(event: BilibiliShadowEvent): BilibiliShadowEvent {
  return {
    type: event.type, id: event.id, originalText: event.originalText, epoch: event.epoch,
    mediaTimeMs: event.mediaTimeMs, wallTimeMs: event.wallTimeMs, stimeMs: event.stimeMs,
    ...(event.result === undefined ? {} : { result: event.result }),
    ...(event.reasons === undefined ? {} : { reasons: [...event.reasons] }),
    ...(event.predictedInitMs === undefined ? {} : { predictedInitMs: event.predictedInitMs }),
  };
}

function percentile(sorted: number[], fraction: number): number | null {
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? null;
}

/** Passive, bounded accounting of native calls. A firstShow call is not evidence of visible pixels. */
export class BilibiliShadowLedger {
  readonly maxRecords: number;
  readonly warmupMs: number;

  #events: BilibiliShadowEvent[] = [];
  #predictions: Prediction[] = [];
  #admissions: Admission[] = [];
  #pending = new Set<Prediction>();
  #pendingByKey = new Map<string, Prediction[]>();
  #admissionCountByKey = new Map<string, number>();
  #currentEpoch: number | null = null;
  #highestEpoch: number | null = null;
  #segment = 0;
  #warmupStartMediaMs = 0;
  #mediaTimeMs = -Infinity;
  #duplicateNativeInit = 0;
  #staleEvents = 0;
  #truncated = false;

  constructor({ maxRecords = 20_000, warmupMs = 5_000 }: { maxRecords?: number; warmupMs?: number } = {}) {
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || !Number.isFinite(warmupMs) || warmupMs < 0) {
      throw new RangeError('Invalid shadow ledger capacity or warmup duration');
    }
    this.maxRecords = maxRecords;
    this.warmupMs = warmupMs;
  }

  #key(event: BilibiliShadowEvent): string {
    return JSON.stringify([this.#segment, event.epoch, event.id, event.originalText]);
  }

  #censorPending(reason: string): void {
    for (const prediction of this.#pending) {
      prediction.status = 'censored';
      prediction.censoredBy = reason;
    }
    this.#pending.clear();
    this.#pendingByKey.clear();
    this.#admissionCountByKey.clear();
  }

  #enter(epoch: number, mediaTimeMs: number): boolean {
    if (this.#highestEpoch !== null && epoch < this.#highestEpoch) return false;
    if (this.#currentEpoch === epoch) return true;
    if (this.#currentEpoch !== null) this.#censorPending('epoch-changed');
    this.#currentEpoch = epoch;
    this.#highestEpoch = epoch;
    this.#segment++;
    this.#warmupStartMediaMs = mediaTimeMs;
    this.#mediaTimeMs = -Infinity;
    return true;
  }

  #mature(mediaTimeMs: number): void {
    this.#mediaTimeMs = Math.max(this.#mediaTimeMs, mediaTimeMs);
    for (const prediction of this.#pending) {
      if (this.#mediaTimeMs > prediction.deadlineMs) {
        prediction.status = 'falsePositive';
        this.#pending.delete(prediction);
      }
    }
  }

  record(event: BilibiliShadowEvent): void {
    if (!['shadowSelected', 'nativeValidate', 'nativeInitRender', 'nativeFirstShow'].includes(event.type) ||
        typeof event.id !== 'string' || typeof event.originalText !== 'string' ||
        !Number.isSafeInteger(event.epoch) ||
        [event.mediaTimeMs, event.wallTimeMs, event.stimeMs].some(value => !Number.isFinite(value)) ||
        (event.predictedInitMs !== undefined && !Number.isFinite(event.predictedInitMs))) {
      throw new TypeError('Invalid shadow ledger event');
    }
    if (this.#events.length >= this.maxRecords) {
      this.#truncated = true;
      return;
    }
    const captured = copyEvent(event);
    this.#events.push(captured);
    if (!this.#enter(captured.epoch, captured.mediaTimeMs)) {
      this.#staleEvents++;
      return;
    }
    this.#mature(captured.mediaTimeMs);
    const key = this.#key(captured);
    // Both prediction and native admission use the source's video-time cohort.
    const steady = captured.stimeMs - this.#warmupStartMediaMs >= this.warmupMs;
    if (captured.type === 'shadowSelected') {
      const prediction: Prediction = { selected: captured, status: 'pending', deadlineMs: captured.stimeMs + 2_000, steady };
      this.#predictions.push(prediction);
      this.#pending.add(prediction);
      const pending = this.#pendingByKey.get(key) ?? [];
      pending.push(prediction);
      this.#pendingByKey.set(key, pending);
      this.#mature(captured.mediaTimeMs);
    } else if (captured.type === 'nativeInitRender') {
      const count = this.#admissionCountByKey.get(key) ?? 0;
      if (count) this.#duplicateNativeInit++;
      this.#admissionCountByKey.set(key, count + 1);
      const prediction = this.#pendingByKey.get(key)?.find(candidate =>
        candidate.status === 'pending' && candidate.selected.stimeMs === captured.stimeMs &&
        candidate.selected.wallTimeMs < captured.wallTimeMs);
      if (prediction) {
        prediction.status = 'matched';
        prediction.matchedInit = captured;
        this.#pending.delete(prediction);
      }
      this.#admissions.push({ event: captured, steady: prediction?.steady ?? steady, prediction });
    }
  }

  advance({ epoch, mediaTimeMs, wallTimeMs }: { epoch: number; mediaTimeMs: number; wallTimeMs: number }): void {
    if (!Number.isSafeInteger(epoch) || !Number.isFinite(mediaTimeMs) || !Number.isFinite(wallTimeMs)) {
      throw new TypeError('Invalid shadow ledger clock');
    }
    if (this.#enter(epoch, mediaTimeMs)) this.#mature(mediaTimeMs);
  }

  invalidate(reason: string): void {
    this.#censorPending(reason);
    this.#currentEpoch = null;
  }

  #metrics(
    includePrediction: (prediction: Prediction) => boolean,
    includeAdmission: (admission: Admission) => boolean,
  ): BilibiliShadowMetrics {
    const predictions = this.#predictions.filter(includePrediction);
    const admissions = this.#admissions.filter(includeAdmission);
    const count = (status: PredictionStatus) => predictions.filter(prediction => prediction.status === status).length;
    const matchedPredictions = count('matched');
    const falsePositives = count('falsePositive');
    const pendingPredictions = count('pending');
    const censoredPredictions = count('censored');
    const maturedPredictions = matchedPredictions + falsePositives;
    const predictedBeforeInit = admissions.filter(admission => admission.prediction !== undefined).length;
    const lead = admissions.flatMap(admission => admission.prediction
      ? [admission.event.wallTimeMs - admission.prediction.selected.wallTimeMs] : []).sort((a, b) => a - b);
    const atLeast3000Count = lead.filter(value => value >= 3_000).length;
    return {
      matchedPredictions, falsePositives, pendingPredictions, censoredPredictions, maturedPredictions,
      actualInit: admissions.length, predictedBeforeInit,
      precision: maturedPredictions ? matchedPredictions / maturedPredictions : null,
      recall: admissions.length ? predictedBeforeInit / admissions.length : null,
      leadMs: {
        min: lead[0] ?? null, p10: percentile(lead, 0.1), p50: percentile(lead, 0.5),
        samples: lead.length, atLeast3000Count,
        atLeast3000Ratio: lead.length ? atLeast3000Count / lead.length : null,
      },
    };
  }

  #acceptance(metrics: BilibiliShadowMetrics) {
    const reasons: string[] = [];
    if (this.#truncated) reasons.push('truncated');
    if (metrics.maturedPredictions === 0) reasons.push('no-matured-predictions');
    if (metrics.actualInit === 0) reasons.push('no-native-init');
    if (metrics.leadMs.samples === 0) reasons.push('no-matched-native-init');
    if (metrics.pendingPredictions > 0) reasons.push('cohort-not-settled');
    if (metrics.censoredPredictions > 0) reasons.push('interrupted-predictions');
    if (metrics.precision !== null && metrics.precision < 0.9) reasons.push('precision-below-0.9');
    if (metrics.recall !== null && metrics.recall < 0.9) reasons.push('recall-below-0.9');
    if (metrics.leadMs.min !== null && metrics.leadMs.min < 3_000) reasons.push('min-lead-below-3000ms');
    return { passed: reasons.length === 0, reasons };
  }

  report(options?: { fromStimeMs: number; toStimeMs: number }) {
    if (options && (!Number.isFinite(options.fromStimeMs) || !Number.isFinite(options.toStimeMs) ||
        options.fromStimeMs > options.toStimeMs)) {
      throw new RangeError('Invalid shadow ledger evaluation window');
    }
    const overall = this.#metrics(() => true, () => true);
    const steadyState = this.#metrics(prediction => prediction.steady, admission => admission.steady);
    const evaluation = options ? {
      fromStimeMs: options.fromStimeMs,
      toStimeMs: options.toStimeMs,
      metrics: this.#metrics(
        prediction => prediction.selected.stimeMs >= options.fromStimeMs && prediction.selected.stimeMs <= options.toStimeMs,
        admission => admission.event.stimeMs >= options.fromStimeMs && admission.event.stimeMs <= options.toStimeMs,
      ),
    } : null;
    const eventTypes = { shadowSelected: 0, nativeValidate: 0, nativeInitRender: 0, nativeFirstShow: 0 };
    let nativeValidateTrue = 0, nativeValidateFalse = 0, nativeValidateUnknown = 0;
    for (const event of this.#events) {
      eventTypes[event.type]++;
      if (event.type === 'nativeValidate') {
        if (event.result === true) nativeValidateTrue++;
        else if (event.result === false) nativeValidateFalse++;
        else nativeValidateUnknown++;
      }
    }
    return {
      events: this.#events.map(copyEvent),
      predictions: this.#predictions.map(prediction => ({
        selected: copyEvent(prediction.selected), status: prediction.status, deadlineMs: prediction.deadlineMs,
        steadyState: prediction.steady,
        ...(prediction.matchedInit ? { matchedInit: copyEvent(prediction.matchedInit) } : {}),
        ...(prediction.censoredBy ? { censoredBy: prediction.censoredBy } : {}),
      })),
      classification: { eventTypes, nativeValidateTrue, nativeValidateFalse, nativeValidateUnknown,
        duplicateNativeInit: this.#duplicateNativeInit, staleEvents: this.#staleEvents },
      overall, steadyState,
      evaluation: evaluation ? { ...evaluation, acceptance: this.#acceptance(evaluation.metrics) } : null,
      truncated: this.#truncated,
      acceptance: this.#acceptance(steadyState),
      firstShowIsVisiblePixelEvidence: false as const,
    };
  }
}
