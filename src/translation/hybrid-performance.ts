export interface HybridPerformanceSample {
  startedAt: number;
  endedAt: number;
  inputChars: number;
  outputChars: number;
  items: number;
  complete: boolean;
  timely: boolean;
  outcome: 'complete' | 'partial' | 'timeout' | 'error' | 'cancelled';
  streaming: boolean;
  firstContentMs?: number;
  contentChunks?: number;
  contentSpanMs?: number;
  firstChunkChars?: number;
  predictedMs?: number;
}

export interface HybridPerformanceEstimate {
  ready: boolean;
  samples: number;
  status: 'learning' | 'stable' | 'slowing';
  expectedMs?: number;
  outputChars: number;
  firstContentMs?: number;
  charsPerSecond?: number;
  outputCeiling?: number;
}

interface Group {
  samples: HybridPerformanceSample[];
  ceiling?: number;
  timelyStreak: number;
}

const TTL_MS = 10 * 60 * 1000;
const MAX_GROUPS = 128;
const MAX_SAMPLES = 32;
const MIN_COMPLETE = 8;
const FORMAT_CHARS_PER_ITEM = 12;

const complete = (sample: HybridPerformanceSample) => sample.outcome === 'complete' && sample.complete;
const duration = (sample: HybridPerformanceSample) => sample.endedAt - sample.startedAt;
const base = (inputChars: number, items: number) => inputChars + FORMAT_CHARS_PER_ITEM * items;
const missed = (sample: HybridPerformanceSample) => sample.outcome === 'timeout' ||
  sample.outcome === 'partial' || complete(sample) && (!sample.timely ||
    sample.predictedMs !== undefined && duration(sample) > sample.predictedMs * 1.1 + 50);

function percentile(values: number[], fraction: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)]!;
}

function valid(sample: HybridPerformanceSample): boolean {
  return Number.isFinite(sample.startedAt) && Number.isFinite(sample.endedAt) &&
    sample.endedAt > sample.startedAt && Number.isSafeInteger(sample.inputChars) && sample.inputChars >= 0 &&
    Number.isSafeInteger(sample.outputChars) && sample.outputChars >= 0 &&
    Number.isSafeInteger(sample.items) && sample.items > 0 &&
    ['complete', 'partial', 'timeout', 'error', 'cancelled'].includes(sample.outcome) &&
    typeof sample.complete === 'boolean' && typeof sample.timely === 'boolean' &&
    typeof sample.streaming === 'boolean' &&
    (sample.predictedMs === undefined || Number.isFinite(sample.predictedMs) && sample.predictedMs >= 0);
}

/** Three-column nonnegative least squares; all coefficients, including the intercept, stay nonnegative. */
function nonstreamPrediction(samples: HybridPerformanceSample[], inputChars: number, outputChars: number,
  items: number, recentPredictionError: number): number {
  const maxInput = Math.max(1, ...samples.map(sample => sample.inputChars));
  const maxOutput = Math.max(1, ...samples.map(sample => sample.outputChars));
  const maxItems = Math.max(1, ...samples.map(sample => sample.items));
  const rows = samples.map(sample => [1, sample.inputChars / maxInput, sample.outputChars / maxOutput]);
  const times = samples.map(duration);
  const coefficients = [0, 0, 0];
  for (let iteration = 0; iteration < 120; iteration++) {
    for (let column = 0; column < 3; column++) {
      let numerator = 0, denominator = 0;
      for (let row = 0; row < rows.length; row++) {
        const features = rows[row]!;
        const feature = features[column]!;
        const residual = times[row]! - features.reduce((total, value, index) =>
          total + (index === column ? 0 : value * coefficients[index]!), 0);
        numerator += feature * residual;
        denominator += feature * feature;
      }
      coefficients[column] = Math.max(0, numerator / Math.max(denominator, 1e-9));
    }
  }
  const fitted = rows.map(features => features.reduce((total, value, index) => total + value * coefficients[index]!, 0));
  const positiveErrors = times.map((time, index) => Math.max(0, time - fitted[index]!));
  const modelTime = coefficients[0]! + coefficients[1]! * inputChars / maxInput +
    coefficients[2]! * outputChars / maxOutput;
  // An unseen size never inherits the latency of only short, single-item requests.
  const scale = Math.max(1, inputChars / maxInput, outputChars / maxOutput, items / maxItems);
  return Math.max(modelTime + Math.max(100, percentile(positiveErrors, 0.9), recentPredictionError),
    percentile(times, 0.9) * scale);
}

/** Ephemeral, keyed observations only; neither raw text nor credentials enter the model. */
export class HybridPerformanceModel {
  private readonly groups = new Map<string, Group>();

  record(key: string, sample: HybridPerformanceSample): void {
    if (!key || !valid(sample) || sample.outcome === 'cancelled') return;
    const cutoff = sample.endedAt - TTL_MS;
    for (const [name, group] of this.groups) {
      group.samples = group.samples.filter(entry => entry.endedAt >= cutoff);
      if (!group.samples.length) this.groups.delete(name);
    }
    const group: Group = this.groups.get(key) ?? { samples: [], timelyStreak: 0 };
    // A new observation can reset stale guards, while estimate() remains a pure read.
    if (!group.samples.length) {
      group.ceiling = undefined;
      group.timelyStreak = 0;
    }
    const previousComplete = group.samples.filter(complete).length;
    group.samples.push({
      startedAt: sample.startedAt, endedAt: sample.endedAt, inputChars: sample.inputChars,
      outputChars: sample.outputChars, items: sample.items, complete: sample.complete,
      timely: sample.timely, outcome: sample.outcome, streaming: sample.streaming,
      firstContentMs: sample.firstContentMs, contentChunks: sample.contentChunks,
      contentSpanMs: sample.contentSpanMs, firstChunkChars: sample.firstChunkChars,
      predictedMs: sample.predictedMs,
    });
    if (group.samples.length > MAX_SAMPLES) group.samples.shift();
    const full = group.samples.filter(complete);
    const observedMax = full.length ? Math.max(...full.map(entry => entry.outputChars)) : undefined;
    if (previousComplete < MIN_COMPLETE) {
      group.ceiling = observedMax;
      if (full.length === MIN_COMPLETE) group.timelyStreak = 0;
    }
    if (missed(sample)) {
      group.timelyStreak = 0;
      if (group.ceiling !== undefined) group.ceiling = Math.max(1, Math.floor(group.ceiling * 0.8));
    } else if (complete(sample) && sample.timely && previousComplete >= MIN_COMPLETE) {
      group.timelyStreak++;
      if (group.timelyStreak >= 5) {
        group.timelyStreak = 0;
        if (group.ceiling !== undefined) group.ceiling = Math.floor(group.ceiling * 1.2);
      }
    } else group.timelyStreak = 0;
    this.groups.delete(key);
    this.groups.set(key, group);
    if (this.groups.size > MAX_GROUPS) this.groups.delete(this.groups.keys().next().value!);
  }

  estimate(key: string, shape: { inputChars: number; items: number }, now: number,
    inFlightLowerBoundMs?: number): HybridPerformanceEstimate {
    const inputChars = Number.isSafeInteger(shape.inputChars) && shape.inputChars >= 0 ? shape.inputChars : 0;
    const items = Number.isSafeInteger(shape.items) && shape.items > 0 ? shape.items : 1;
    const observations = this.groups.get(key)?.samples.filter(sample => sample.endedAt >= now - TTL_MS && sample.endedAt <= now) ?? [];
    const full = observations.filter(complete);
    const outputChars = full.length ? Math.ceil(base(inputChars, items) * percentile(full.map(sample =>
      sample.outputChars / base(sample.inputChars, sample.items)), 0.9)) : base(inputChars, items);
    const group = this.groups.get(key);
    const ceiling = full.length ? group?.ceiling : undefined;
    const result: HybridPerformanceEstimate = {
      ready: false, samples: full.length, status: 'learning', outputChars,
      ...(ceiling === undefined ? {} : { outputCeiling: ceiling }),
    };
    if (full.length < MIN_COMPLETE || !Number.isFinite(now) || !Number.isSafeInteger(shape.inputChars) ||
        shape.inputChars < 0 || !Number.isSafeInteger(shape.items) || shape.items < 1) return result;

    const recentErrors = observations.slice(-5).filter(sample => complete(sample) &&
      sample.predictedMs !== undefined).map(sample => Math.max(0, duration(sample) - sample.predictedMs!));
    const recentPredictionError = recentErrors.length ? percentile(recentErrors, 0.9) : 0;
    const streams = full.filter(sample => sample.streaming && Number.isSafeInteger(sample.contentChunks) &&
      sample.contentChunks! >= 2 && Number.isFinite(sample.contentSpanMs) &&
      (sample.contentSpanMs ?? 0) >= 500 && Number.isSafeInteger(sample.firstChunkChars) &&
      (sample.firstChunkChars ?? -1) >= 0 &&
      sample.outputChars > sample.firstChunkChars! && Number.isFinite(sample.firstContentMs) &&
      sample.firstContentMs! >= 0 && sample.firstContentMs! <= duration(sample));
    let expectedMs: number;
    if (streams.length >= 5) {
      const rates = streams.map(sample => (sample.outputChars - sample.firstChunkChars!) * 1000 / sample.contentSpanMs!);
      const firstContentMs = percentile(streams.map(sample => sample.firstContentMs!), 0.9);
      const charsPerSecond = percentile(rates, 0.2);
      const residuals = streams.map(sample => Math.max(0, duration(sample) -
        (firstContentMs + sample.outputChars * 1000 / charsPerSecond)));
      const maxObservedInput = Math.max(1, ...full.map(sample => sample.inputChars));
      const scaledFirstContentMs = firstContentMs * Math.max(1, inputChars / maxObservedInput);
      expectedMs = scaledFirstContentMs + outputChars * 1000 / charsPerSecond +
        Math.max(100, percentile(residuals, 0.9), recentPredictionError);
      result.firstContentMs = firstContentMs;
      result.charsPerSecond = charsPerSecond;
    } else {
      expectedMs = nonstreamPrediction(full, inputChars, outputChars, items, recentPredictionError);
    }
    // Only the latest five attempts can tighten a prediction; censored runs never enter the fit.
    const recentMisses = observations.slice(-5).filter(missed);
    const lowerBound = recentMisses.length ? Math.max(...recentMisses.map(sample => duration(sample) + 100)) : 0;
    const inFlight = Number.isFinite(inFlightLowerBoundMs) && inFlightLowerBoundMs! > 0
      ? inFlightLowerBoundMs! + 100 : 0;
    result.ready = true;
    result.status = recentMisses.length || inFlight > Math.max(100, expectedMs, lowerBound) ? 'slowing' : 'stable';
    result.expectedMs = Math.ceil(Math.max(100, expectedMs, lowerBound, inFlight));
    return result;
  }

  clear(): void { this.groups.clear(); }
}
