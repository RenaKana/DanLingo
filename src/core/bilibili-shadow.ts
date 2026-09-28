/** Pure copies of the reviewed 1.1.24 time-window and admission arithmetic.
 * Input is the native timeLine.list in its existing order, NOT dmArray sorted
 * again by stime. No native callback or native counter is invoked here. */
export interface ShadowItem { dmid?: string; id_str?: string; stime: number; text: string;
  mode: number; rawMode?: number; pool?: number; on?: boolean; likes?: unknown;
  [key: string]: any }
export interface ShadowRuleDecision { state: 'retain' | 'exclude' | 'unknown'; reason: string }
export interface ShadowForecastInput {
  list: ShadowItem[]; currentTime: number; renderTime: number; lastFetchTime: number;
  lastTime: number; preTime: number; videoSpeed: number; cadenceSeconds?: number;
  horizonSeconds?: number; area: number; height: number; fontSize: number; limit: number;
  match: (item: ShadowItem) => ShadowRuleDecision;
}
export interface ShadowPrediction { item: ShadowItem; predictedInitMs: number;
  lower: number; upper: number; reasons: string[] }

// Native binary-search equality returns the hit index + 1, not upper_bound.
export function nativeShadowIndex(list: ShadowItem[], time: number): number {
  let low = 0, high = list.length - 1, index = 0;
  while (low <= high) {
    index = Math.floor((low + high) / 2);
    const value = list[index]!.stime;
    if (time < value) high = index - 1;
    else if (time > value) low = index + 1;
    else return index + 1;
  }
  return list[index] ? time < list[index]!.stime ? index : index + 1 : index;
}

export function nativeShadowRange(list: ShadowItem[], lower: number, upper: number): ShadowItem[] {
  const start = nativeShadowIndex(list, lower), end = nativeShadowIndex(list, upper);
  return end <= start ? [] : list.slice(start, end);
}

export interface ShadowQuota { start: number; count: number }
export function shadowValidateLimit(state: ShadowQuota, nowMs: number, limit: number, pool: unknown): boolean {
  if (limit < 0 || pool !== 0) return true;
  const max = Math.max(1, Math.floor(limit * (.5 * 1.2) / 3));
  if (state.start === 0) state.start = nowMs;
  if (nowMs > state.start + 1000) {
    state.count = 0;
    state.start += Math.ceil((nowMs - state.start - 1000) / 1000) * 1000;
  }
  if (state.count >= max) return false;
  state.count++; return true;
}

export function forecastBilibiliShadow(input: ShadowForecastInput): {
  selected: ShadowPrediction[]; rejected: Record<string, number>; windows: { lower: number; upper: number; initMs: number }[];
} {
  const selected: ShadowPrediction[] = [], rejected: Record<string, number> = {}, windows: { lower: number; upper: number; initMs: number }[] = [];
  const reject = (reason: string) => { rejected[reason] = (rejected[reason] ?? 0) + 1; };
  const p = input.preTime, rate = input.videoSpeed, horizon = input.horizonSeconds ?? 5;
  if (![input.currentTime, input.renderTime, input.lastFetchTime, input.lastTime, p, rate, horizon,
    input.area, input.height, input.fontSize, input.limit].every(Number.isFinite) || p <= 0 || rate <= 0 ||
    horizon <= 0 || horizon > 30 || input.fontSize <= 0 || input.list.length > 200_000) {
    reject('invalid-input'); return { selected, rejected, windows };
  }
  const cadence = Math.max(p + .001, Math.min(p + .25, input.cadenceSeconds ?? p + 1 / 30));
  const first = Math.max(0, cadence - (input.renderTime - input.lastFetchTime));
  const cap = input.area ? Math.ceil(input.area / 100 * input.height / (28.125 * input.fontSize)) : 9999;
  const quota = { start: 0, count: 0 }, simulatedOn = new Set<ShadowItem>();
  let lastTime = input.lastTime;
  // Mirror complete native batches. The outer horizon clips predictions only,
  // not preceding rows which consume a native batch's quota.
  for (let delta = first; delta <= horizon + .001 && windows.length < 64; delta += cadence) {
    const current = input.currentTime + delta * rate, n = current - .001;
    const lower = Math.max(Math.max(lastTime || n, n) - .001, n), upper = n + p * rate;
    lastTime = upper;
    windows.push({ lower, upper, initMs: current * 1000 });
    let rolls = 0;
    for (const item of nativeShadowRange(input.list, lower, upper)) {
      const decision = input.match(item);
      if (decision.state === 'exclude') { reject(decision.reason); continue; }
      if (!shadowValidateLimit(quota, 1 + delta * 1000, input.limit, item.pool)) { reject('limit'); continue; }
      // validate consumes its allowance even when the item is already active.
      if (item.on || simulatedOn.has(item)) { reject('on'); continue; }
      if (!item.likes && (item.rawMode ?? item.mode) === 1 && ++rolls > cap) { reject('roll-cap'); continue; }
      simulatedOn.add(item);
      if (item.stime > input.currentTime + horizon * rate) continue;
      if (![1, 4, 5, 6].includes(item.mode) || typeof item.text !== 'string' ||
          !item.text || typeof (item.dmid ?? item.id_str) !== 'string') { reject('nonordinary'); continue; }
      selected.push({ item, predictedInitMs: current * 1000, lower, upper,
        reasons: decision.state === 'unknown' ? [decision.reason] : [] });
    }
  }
  return { selected, rejected, windows };
}

export interface BilibiliShadowSelection {
  id: string; originalText: string;
  sourceId?: string; stimeMs?: number; deadlineAtEpochMs?: number; reasons?: string[];
}
export interface BilibiliShadowUpdate { epoch: number; revision: number; active: boolean; known: boolean;
  /** Same subscription wire shape, different evidence: owned lists are not native forecasts. */
  policy?: 'native' | 'owned';
  /** Playback is temporarily paused/buffering; the owned list remains valid. */
  suspended?: boolean;
  predictionEpoch?: number; ruleRevision?: number; sampledAtEpochMs?: number; playbackRate?: number;
  items: BilibiliShadowSelection[] }
export function parseBilibiliShadowUpdate(value: unknown): BilibiliShadowUpdate | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as BilibiliShadowUpdate;
  if (v.policy !== undefined && v.policy !== 'native' && v.policy !== 'owned') return null;
  if (v.suspended !== undefined && (typeof v.suspended !== 'boolean' || v.policy !== 'owned')) return null;
  if (!Number.isSafeInteger(v.epoch) || v.epoch < 0 || !Number.isSafeInteger(v.revision) || v.revision < 0 ||
    typeof v.active !== 'boolean' || typeof v.known !== 'boolean' || !Array.isArray(v.items) || v.items.length > 2000) return null;
  if (v.predictionEpoch !== undefined && (!Number.isSafeInteger(v.predictionEpoch) || v.predictionEpoch < 0) ||
      v.ruleRevision !== undefined && (!Number.isSafeInteger(v.ruleRevision) || v.ruleRevision < 0) ||
      v.sampledAtEpochMs !== undefined && (!Number.isFinite(v.sampledAtEpochMs) || v.sampledAtEpochMs <= 0) ||
      v.playbackRate !== undefined && (!Number.isFinite(v.playbackRate) || v.playbackRate <= 0 || v.playbackRate > 16)) return null;
  const ids = new Set<string>();
  for (const row of v.items) {
    if (!row || typeof row.id !== 'string' || !row.id || row.id.length > 400 || ids.has(row.id) ||
      typeof row.originalText !== 'string' || !row.originalText || row.originalText.length > 1000 ||
      row.sourceId !== undefined && (typeof row.sourceId !== 'string' || !row.sourceId || row.sourceId.length > 100) ||
      row.stimeMs !== undefined && (!Number.isFinite(row.stimeMs) || row.stimeMs < 0) ||
      row.deadlineAtEpochMs !== undefined && (!Number.isFinite(row.deadlineAtEpochMs) || row.deadlineAtEpochMs <= 0) ||
      row.reasons !== undefined && (!Array.isArray(row.reasons) || row.reasons.length > 16 ||
        row.reasons.some(reason => typeof reason !== 'string' || reason.length > 100))) return null;
    ids.add(row.id);
  }
  return { epoch: v.epoch, revision: v.revision, active: v.active, known: v.known,
    ...(v.policy === undefined ? {} : { policy: v.policy }),
    ...(v.suspended === undefined ? {} : { suspended: v.suspended }),
    ...(v.predictionEpoch === undefined ? {} : { predictionEpoch: v.predictionEpoch }),
    ...(v.ruleRevision === undefined ? {} : { ruleRevision: v.ruleRevision }),
    ...(v.sampledAtEpochMs === undefined ? {} : { sampledAtEpochMs: v.sampledAtEpochMs }),
    ...(v.playbackRate === undefined ? {} : { playbackRate: v.playbackRate }),
    items: v.items.map(({ id, originalText, sourceId, stimeMs, deadlineAtEpochMs, reasons }) => ({
      id, originalText, ...(sourceId === undefined ? {} : { sourceId }),
      ...(stimeMs === undefined ? {} : { stimeMs }),
      ...(deadlineAtEpochMs === undefined ? {} : { deadlineAtEpochMs }),
      ...(reasons === undefined ? {} : { reasons: [...reasons] }),
    })) };
}
