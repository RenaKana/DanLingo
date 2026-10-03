import { bilibiliSourceEventId } from '../../core/messages.ts';
import type { BilibiliShadowUpdate } from '../../core/bilibili-shadow.ts';
import { createBilibiliShadowRules, type BilibiliOwnedProjection } from './shadow-rules.ts';
import type { BilibiliNativeBinding } from './video.ts';

type Native = Record<string, any>;
type Rules = Pick<ReturnType<typeof createBilibiliShadowRules>, 'read'>;
type Selection = { item: Native; id: string; sourceId: string; originalText: string;
  stimeMs: number; deadlineAtEpochMs: number; reasons: string[]; metadata: readonly unknown[];
  admissionMetadata: readonly unknown[]; displayMode: number; pauseEligible: boolean };
export type OwnedReleaseUpdate = BilibiliShadowUpdate & { policy: 'owned' };

interface Options {
  binding: BilibiliNativeBinding;
  session: string;
  now: () => number;
  epochNow: () => number;
  rules?: Rules;
  onUpdate: (update: OwnedReleaseUpdate) => void;
  onMiss?: (id: string, sourceId: string, originalText: string, stimeMs: number, reason: string) => void;
}

const ordinary = (item: Native) => [1, 4, 5, 6].includes(item.mode) &&
  [1, 4, 5, 6].includes(item.rawMode ?? item.mode) &&
  typeof (item.dmid ?? item.id_str) === 'string' && /^\d+$/.test(item.dmid ?? item.id_str) &&
  typeof item.text === 'string' && !!item.text.trim() && item.text.length <= 1000 &&
  Number.isFinite(item.stime) && item.stime >= 0 && item.stime <= 86400;

const identityFields = ['dmid', 'id_str', 'stime', 'mode', 'rawMode', 'uhash', 'mid', 'uid', 'pool',
  'weight', 'size', 'color', 'colorfulImg', 'font', 'speed', 'date', 'border', 'colorful', 'shooterType'] as const;
// beforeRender owns these presentation fields. A Worker-cloned source pool can
// retain their earlier values after the real timeline object has been rendered.
const nativePresentationFields = new Set<string>(['mode', 'rawMode', 'color', 'colorfulImg']);
const metadataOf = (item: Native): readonly unknown[] => identityFields.map(key => item[key]);
const sameMetadata = (row: Selection) => identityFields.every((key, index) =>
  Object.is(row.item[key], row.metadata[index]));
const sourceIdOf = (item: unknown): string | null => {
  if (!item || typeof item !== 'object') return null;
  const source = item as Native;
  return [source.dmid, source.id_str].find(value => typeof value === 'string' && /^\d+$/.test(value)) ?? null;
};
const hasAuthor = (item: Native) => typeof item.uhash === 'string' && !!item.uhash.trim() ||
  typeof item.mid === 'string' && !!item.mid.trim() || Number.isSafeInteger(item.mid) && item.mid > 0;
const uniqueSources = (items: Native[]): Map<string, Native | null> => {
  const sources = new Map<string, Native | null>();
  for (const item of items) {
    const id = sourceIdOf(item);
    if (id) sources.set(id, sources.has(id) ? null : item);
  }
  return sources;
};
const samePoolIdentity = (timeline: Native, pooled: Native | null | undefined): boolean =>
  !!pooled && ordinary(pooled) && sourceIdOf(timeline) === sourceIdOf(pooled) &&
  timeline.text === pooled.text && hasAuthor(timeline) && hasAuthor(pooled) &&
  identityFields.every(key => nativePresentationFields.has(key) || Object.is(timeline[key], pooled[key]));

/** Owns a stable five-second subscription, never the native timeline or renderer. */
export class BilibiliOwnedRelease {
  private readonly options: Options;
  private readonly rules: Rules;
  private readonly selected = new Map<string, Selection>();
  private readonly sealed = new Set<number>();
  private readonly supplied = new Set<string>();
  private readonly missed = new Set<string>();
  private readonly suppressed = new Set<string>();
  private readonly seenIds = new Set<string>();
  private readonly rejected: Record<string, number> = {};
  private readonly membershipFailures = new Set<string>();
  private totalSelected = 0;
  private totalSupplied = 0;
  private totalMissed = 0;
  private totalSuppressed = 0;
  private signature = '';
  private playbackRate: number | null = null;
  private timeline: Native[] | null = null;
  private predictionEpoch = 0;
  private revision = 0;
  private ruleRevision = 0;
  private epoch = 0;
  private known = false;
  private reason = 'warming-up';
  private suspendedAt: number | null = null;
  private stopped = false;

  constructor(options: Options) {
    this.options = options;
    this.rules = options.rules ?? createBilibiliShadowRules({
      player: options.binding.player, danmaku: options.binding.danmaku,
      documentScope: options.session, now: options.now,
      allowPartialUserRules: () => true,
    });
  }

  get active() { return this.known && !this.stopped; }
  get generation() { return this.predictionEpoch; }

  reset(reason: string) {
    this.selected.clear(); this.sealed.clear(); this.supplied.clear(); this.missed.clear();
    this.suppressed.clear(); this.seenIds.clear();
    this.membershipFailures.clear();
    this.suspendedAt = null; this.playbackRate = null;
    this.predictionEpoch++; this.reason = reason;
  }

  private reject(reason: string) { this.rejected[reason] = (this.rejected[reason] ?? 0) + 1; }
  private rejectMembership(id: string) {
    if (!this.membershipFailures.has(id)) { this.membershipFailures.add(id); this.reject('membership-rejected'); }
  }
  private member(row: Selection, timeline: Map<string, Native | null>, pool: Map<string, Native | null>): boolean {
    const valid = this.options.binding.manager.dataBase?.timeLine?.list === this.timeline &&
      timeline.get(row.sourceId) === row.item && samePoolIdentity(row.item, pool.get(row.sourceId));
    if (!valid) this.rejectMembership(row.id);
    return valid;
  }

  tick(epoch: number): void {
    if (this.stopped) return;
    const { binding, epochNow } = this.options;
    const { manager, danmaku, video } = binding;
    const snapshot = this.rules.read();
    const setting = manager.config?.setting;
    const list = manager.dataBase?.timeLine?.list;
    const pool = manager.dataBase?.dmArray;
    const rate = video.playbackRate, currentTime = video.currentTime, preTime = setting?.preTime;
    const height = manager.containerSize?.height, width = manager.containerSize?.width;
    const doc = manager.container?.ownerDocument ?? (globalThis as any).document;
    // A resize changes capacity for new buckets, not the already sealed work.
    // Invalid dimensions still revoke the native contract below.
    const signature = JSON.stringify([epoch, snapshot.fingerprint, setting?.visible,
      setting?.area, setting?.fontSize, setting?.limit, preTime, doc?.hidden === true]);
    if (this.signature && (signature !== this.signature || list !== this.timeline)) this.reset('configuration-or-epoch-changed');
    this.signature = signature; this.timeline = Array.isArray(list) ? list : null;
    this.epoch = epoch; this.ruleRevision = snapshot.revision;
    const contract = Array.isArray(list) && Array.isArray(pool) && list.length <= 200000 &&
      Number.isFinite(currentTime) && currentTime >= 0 && Number.isFinite(rate) && rate > 0 && rate <= 16 &&
      Number.isFinite(preTime) && preTime > 0 && preTime <= 5 &&
      Number.isFinite(setting?.area) && setting.area >= 0 &&
      Number.isFinite(setting?.fontSize) && setting.fontSize > 0 &&
      Number.isFinite(setting?.limit) && Number.isFinite(height) && height > 0 &&
      Number.isFinite(width) && width > 0 &&
      typeof setting?.visible === 'boolean' && snapshot.nativeSettings?.visible === setting.visible;
    const sampledAtEpochMs = epochNow();
    const suspended = video.paused === true || video.readyState < 3;
    const resumed = !suspended && this.suspendedAt !== null;
    const available = !video.seeking && doc?.hidden !== true && setting?.visible === true &&
      (suspended || danmaku.isRunning !== false);
    const previousKnown = this.known;
    this.known = contract && snapshot.known && available;
    this.reason = !contract ? 'native-contract-unavailable' : !snapshot.known ? snapshot.reason ?? 'rules-unknown'
      : !available ? 'playback-inactive' : suspended ? 'playback-suspended' : 'running';
    if (previousKnown && !this.known) this.reset(this.reason);
    if (this.known && suspended && this.suspendedAt === null) {
      for (const row of this.selected.values()) if (row.deadlineAtEpochMs > sampledAtEpochMs &&
        !this.supplied.has(row.id) && !this.missed.has(row.id) && !this.suppressed.has(row.id))
        row.pauseEligible = true;
    }
    if (this.known && this.suspendedAt !== null) {
      // Only observed pause/buffering time shifts the forecast. Never revive an
      // already expired row, nor extend the original timeout of an issued request.
      const delay = Math.max(0, sampledAtEpochMs - this.suspendedAt);
      for (const row of this.selected.values()) if (row.deadlineAtEpochMs > this.suspendedAt &&
        !this.supplied.has(row.id) && !this.missed.has(row.id) && !this.suppressed.has(row.id))
        row.deadlineAtEpochMs += delay;
    }
    this.suspendedAt = this.known && suspended ? sampledAtEpochMs : null;
    if (this.known && !suspended)
      for (const row of this.selected.values()) row.pauseEligible = false;
    if (this.known) {
      const width = preTime * rate, horizon = currentTime + 5 * rate;
      const rateChanged = this.playbackRate !== null && this.playbackRate !== rate;
      this.playbackRate = rate;
      // A held-speed round trip keeps the same display events and translations.
      // Rebuild the bucket grid without revoking their in-flight subscriptions.
      if (rateChanged) this.sealed.clear();
      if (!suspended && (rateChanged || resumed)) for (const row of this.selected.values()) {
        row.deadlineAtEpochMs = Math.min(row.deadlineAtEpochMs,
          sampledAtEpochMs + Math.max(0, (row.item.stime - width - currentTime) / rate * 1000));
      }
      const first = Math.floor(currentTime / width);
      const timelineSources = uniqueSources(list), poolSources = uniqueSources(pool);
      for (let bucket = first; (bucket + 1) * width <= horizon + 1e-9 && bucket < first + 100; bucket++) {
        if (this.sealed.has(bucket)) continue;
        this.sealed.add(bucket);
        const lower = Math.max(currentTime, bucket * width), upper = (bucket + 1) * width;
        const candidates: { item: Native; index: number; reasons: string[];
          projection?: BilibiliOwnedProjection }[] = [];
        for (let index = 0; index < list.length; index++) {
          const item = list[index];
          if (!item || !ordinary(item) || item.stime < lower || item.stime >= upper) continue;
          const sourceId = sourceIdOf(item)!;
          if (this.seenIds.has(bilibiliSourceEventId(binding.identity.resourceId, sourceId))) continue;
          if (timelineSources.get(sourceId) !== item || !samePoolIdentity(item, poolSources.get(sourceId))) {
            this.rejectMembership(bilibiliSourceEventId(binding.identity.resourceId, sourceId)); continue;
          }
          let verdict: ReturnType<typeof snapshot.match>;
          try { verdict = snapshot.matchOwned ? snapshot.matchOwned(item) : snapshot.match(item); }
          catch { this.known = false; this.reason = 'rule-evaluation-failed'; break; }
          if (verdict.state === 'exclude' || verdict.state === 'unknown' && !verdict.reason.startsWith('user-')) {
            this.reject(verdict.reason); continue;
          }
          candidates.push({ item, index, projection: verdict.projection,
            reasons: verdict.state === 'unknown' ? [verdict.reason] : [] });
        }
        if (!this.known) break;
        candidates.sort((a, b) => (Number(b.item.weight) || 0) - (Number(a.item.weight) || 0) ||
          a.item.stime - b.item.stime || a.index - b.index);
        const scrollCap = setting.area ? Math.ceil(setting.area / 100 * height / (28.125 * setting.fontSize)) : Infinity;
        const limitCap = setting.limit < 0 ? Infinity : Math.max(1, Math.floor(setting.limit * .5 * 1.2 / 3));
        // Previously selected rows still consume density in the rebuilt grid.
        // Repeated speed changes must not refill a bucket's entire allowance.
        let scroll = 0, count = 0;
        for (const row of this.selected.values()) if (row.item.stime >= lower && row.item.stime < upper) {
          count++; if (row.displayMode === 1 && !row.item.likes) scroll++;
        }
        for (const { item, reasons, projection } of candidates) {
          const displayMode = projection?.mode ?? item.mode;
          if (count >= limitCap || displayMode === 1 && !item.likes && scroll >= scrollCap) { this.reject('density-cap'); continue; }
          const sourceId = sourceIdOf(item)!;
          const id = bilibiliSourceEventId(binding.identity.resourceId, sourceId);
          if (this.selected.size >= 2000) { this.known = false; this.reason = 'owned-capacity-exceeded'; break; }
          const stimeMs = item.stime * 1000;
          // A row's first native preparation opportunity is stime - preTime * rate.
          // Capture the deadline once; a later tick must never move it forward.
          const deadlineAtEpochMs = sampledAtEpochMs + Math.max(0, (item.stime - width - currentTime) / rate * 1000);
          const metadata = metadataOf(item);
          const admissionMetadata = identityFields.map((key, index) => projection && nativePresentationFields.has(key)
            ? (projection as Native)[key] : metadata[index]);
          this.selected.set(id, { item, id, sourceId, originalText: item.text,
            stimeMs, deadlineAtEpochMs, reasons, metadata, admissionMetadata, displayMode,
            pauseEligible: suspended });
          this.seenIds.add(id); this.totalSelected++;
          count++; if (displayMode === 1 && !item.likes) scroll++;
        }
        if (!this.known) break;
      }
      for (const row of this.selected.values()) {
        if (this.missed.has(row.id) || this.supplied.has(row.id) || this.suppressed.has(row.id)) continue;
        const metadataChanged = row.originalText !== row.item.text || !sameMetadata(row);
        const membershipChanged = !metadataChanged && !this.member(row, timelineSources, poolSources);
        if (metadataChanged || membershipChanged) {
          const reason = metadataChanged ? 'source-metadata-changed' : 'source-membership-changed';
          this.missed.add(row.id); this.totalMissed++; this.reject(reason);
          this.options.onMiss?.(row.id, row.sourceId, row.originalText, row.stimeMs, reason);
        }
        if (!this.supplied.has(row.id) && !this.missed.has(row.id) && !this.suppressed.has(row.id) && row.item.stime < currentTime - .001) {
          this.missed.add(row.id); this.totalMissed++; this.reject('missed-window');
          this.options.onMiss?.(row.id, row.sourceId, row.originalText, row.stimeMs, 'missed-window');
        }
      }
      // Sealed buckets and seen IDs keep terminal history; object references only
      // need to remain live for the current preparation horizon.
      for (const row of this.selected.values()) if ((this.supplied.has(row.id) || this.missed.has(row.id) ||
        this.suppressed.has(row.id)) && row.stimeMs / 1000 < currentTime - width - .001) {
        this.selected.delete(row.id); this.supplied.delete(row.id); this.missed.delete(row.id); this.suppressed.delete(row.id);
      }
    }
    // The emitted lease renews while suspended; selected rows keep their playback deadlines.
    const items = this.known ? [...this.selected.values()].filter(row => !this.supplied.has(row.id) &&
      !this.suppressed.has(row.id) &&
       !this.missed.has(row.id) && (suspended ? row.pauseEligible : row.deadlineAtEpochMs > sampledAtEpochMs)).map(row => ({
        id: row.id, sourceId: row.sourceId, originalText: row.originalText,
         stimeMs: row.stimeMs,
         deadlineAtEpochMs: suspended && row.pauseEligible ? sampledAtEpochMs + 60_000 : row.deadlineAtEpochMs,
         reasons: row.reasons,
      })) : [];
    if (new TextEncoder().encode(JSON.stringify(items)).length > 240 * 1024) {
      this.known = false; this.reason = 'bridge-capacity-exceeded';
    }
    this.options.onUpdate({ policy: 'owned', epoch, revision: ++this.revision,
      predictionEpoch: this.predictionEpoch, ruleRevision: this.ruleRevision,
      sampledAtEpochMs, playbackRate: rate, active: true, known: this.known, suspended,
      items: this.known ? items : [] });
  }

  /** Formal fetch replaces only ordinary candidates; unrelated native types pass through. */
  candidates(currentTime: number, preTime: number, rate: number): Native[] {
    if (!this.active || !Number.isFinite(currentTime) || !Number.isFinite(preTime) || !Number.isFinite(rate)) return [];
    const list = this.options.binding.manager.dataBase?.timeLine?.list;
    const pool = this.options.binding.manager.dataBase?.dmArray;
    if (!Array.isArray(list) || !Array.isArray(pool) || list !== this.timeline) return [];
    const timelineSources = uniqueSources(list), poolSources = uniqueSources(pool);
    const lower = currentTime - .001, upper = currentTime + preTime * rate - .001;
    return [...this.selected.values()].filter(row => !this.supplied.has(row.id) && !this.missed.has(row.id) &&
      !this.suppressed.has(row.id) && sameMetadata(row) && this.member(row, timelineSources, poolSources) &&
      row.item.stime >= lower && row.item.stime <= upper &&
      row.item.text === row.originalText)
      .sort((a, b) => a.item.stime - b.item.stime || a.sourceId.localeCompare(b.sourceId))
      .map(row => row.item);
  }

  matches(item: Native): boolean {
    const sourceId = sourceIdOf(item);
    if (!sourceId) return false;
    const row = this.selected.get(bilibiliSourceEventId(this.options.binding.identity.resourceId, sourceId));
    const list = this.options.binding.manager.dataBase?.timeLine?.list;
    const pool = this.options.binding.manager.dataBase?.dmArray;
    if (!Array.isArray(list) || !Array.isArray(pool) || list !== this.timeline) return false;
    return !!row && row.item === item && row.originalText === item.text && sameMetadata(row) &&
      this.member(row, uniqueSources(list), uniqueSources(pool)) &&
      !this.supplied.has(row.id) && !this.missed.has(row.id) && !this.suppressed.has(row.id);
  }

  markSupplied(item: Native) {
    const id = bilibiliSourceEventId(this.options.binding.identity.resourceId, item.dmid ?? item.id_str);
    if (!this.supplied.has(id)) { this.supplied.add(id); this.totalSupplied++; }
  }

  /** Called only after the real beforeRender/filter/validate chain. The original
   * event must survive intact apart from the exact projected native styling. */
  matchesAdmission(item: Native): boolean {
    const sourceId = sourceIdOf(item);
    if (!sourceId) return false;
    const row = this.selected.get(bilibiliSourceEventId(this.options.binding.identity.resourceId, sourceId));
    return !!row && row.item === item && this.supplied.has(row.id) && !this.suppressed.has(row.id) &&
      !this.missed.has(row.id) && row.originalText === item.text &&
      identityFields.every((key, index) => Object.is(item[key], row.admissionMetadata[index]));
  }

  markSuppressed(item: Native) {
    const id = bilibiliSourceEventId(this.options.binding.identity.resourceId, item.dmid ?? item.id_str);
    if (!this.suppressed.has(id)) { this.suppressed.add(id); this.totalSuppressed++; }
  }

  report() {
    return { kind: 'owned-release', horizonSeconds: 5, resourceId: this.options.binding.identity.resourceId,
      epoch: this.epoch, predictionEpoch: this.predictionEpoch, ruleRevision: this.ruleRevision,
      known: this.known, reason: this.reason, sealedBuckets: this.sealed.size,
      selected: this.selected.size, supplied: this.supplied.size, missed: this.missed.size,
      suppressed: this.suppressed.size, totals: { selected: this.totalSelected,
        supplied: this.totalSupplied, missed: this.totalMissed, suppressed: this.totalSuppressed },
      unknownPolicy: 'partial-user-unknown-needs-native-admission', nativeAdmissionRequired: true,
      densityPolicy: 'owned-bucket-area-scroll-cap-and-limit',
      rejected: { ...this.rejected } };
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true; this.known = false; this.reset('stopped');
    this.options.onUpdate({ policy: 'owned', epoch: this.epoch, revision: ++this.revision,
      predictionEpoch: this.predictionEpoch, active: false, known: false, items: [] });
  }
}
