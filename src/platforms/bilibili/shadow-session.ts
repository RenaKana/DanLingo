import { isReviewedDanmakuBuild } from './native-builds.ts';
import { bilibiliSourceEventId } from '../../core/messages.ts';
import { forecastBilibiliShadow, type BilibiliShadowSelection, type BilibiliShadowUpdate, type ShadowItem } from '../../core/bilibili-shadow.ts';
import { BilibiliShadowLedger } from '../../core/bilibili-shadow-ledger.ts';
import { createBilibiliShadowRules } from './shadow-rules.ts';
import type { BilibiliNativeBinding } from './video.ts';

type Native = Record<string, any>;
type EventType = 'shadowSelected' | 'nativeValidate' | 'nativeInitRender' | 'nativeFirstShow';
interface Options { binding: BilibiliNativeBinding; session: string; now?: () => number; nowEpochMs?: () => number;
  /** The adapter records actual init only after its own adoption gate. */
  observeInit?: boolean;
  allowPartialUserRules?: () => boolean;
  onUpdate?: (update: BilibiliShadowUpdate) => void;
  /** Deterministic harness seam; production always uses the native rule reader. */
  rules?: Pick<ReturnType<typeof createBilibiliShadowRules>, 'read'> }

/** Delegate exactly once and preserve any later wrapper when releasing ours. */
function observe(object: Native, key: string, wrap: (original: Function) => Function): (() => boolean) | null {
  const original = object?.[key], descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (typeof original !== 'function' || descriptor && (!('value' in descriptor) || !descriptor.writable)) return null;
  const wrapper = wrap(original);
  try { Object.defineProperty(object, key, descriptor ? { ...descriptor, value: wrapper }
    : { configurable: true, writable: true, value: wrapper }); } catch { return null; }
  return () => {
    if (object[key] !== wrapper) return false;
    if (descriptor) Object.defineProperty(object, key, descriptor); else delete object[key];
    return true;
  };
}

/** MAIN-world prediction and passive observation. Never drives native rendering,
 * native filters, native counters, playback or provider calls. */
export class BilibiliShadowSession {
  private readonly options: Options;
  private readonly now: () => number;
  private readonly nowEpochMs: () => number;
  private readonly ledger = new BilibiliShadowLedger();
  private readonly rules: Pick<ReturnType<typeof createBilibiliShadowRules>, 'read'>;
  private readonly restores: (() => boolean)[] = [];
  private readonly modelRestores = new Map<Native, () => boolean>();
  private readonly selected = new Map<string, { id: string; originalText: string; stime: number }>();
  private activeSelections = new Map<string, BilibiliShadowSelection>();
  private readonly recorded = new Set<string>();
  private readonly firstDeadlines = new Map<string, number>();
  private shadowEpoch = 0;
  private nativeEpoch = 0;
  private revision = 0;
  private signature = '';
  private stopped = false;
  private predicting = true;
  private capacityExceeded = false;
  private running = false;
  private known = false;
  private reviewed = false;
  private metadata: { version: string | null; lastCompiled: string | null } = { version: null, lastCompiled: null };
  private reason = 'warming-up';
  private lastFetchRender: number | null = null;
  private cadenceSeconds = 1 + 1 / 30;
  private lastForecast: ReturnType<typeof forecastBilibiliShadow> | null = null;
  private hooks = { validate: false, initRender: false, fetch: false, firstShow: 0, firstShowUnavailable: 0 };
  private observed = { ignoredNative: 0, instrumentationErrors: 0, invalidations: {} as Record<string, number> };
  private restoration: { restored: number; laterWrapperPreserved: number } | null = null;

  constructor(options: Options) {
    this.options = options; this.now = options.now ?? (() => performance.now());
    this.nowEpochMs = options.nowEpochMs ?? (() => performance.timeOrigin + performance.now());
    const { binding } = options;
    try {
      const metadata = binding.danmaku.getMetadata();
      this.metadata = {
        version: typeof metadata?.version === 'string' && metadata.version.length <= 100 ? metadata.version : null,
        lastCompiled: typeof metadata?.lastCompiled === 'string' && metadata.lastCompiled.length <= 100
          ? metadata.lastCompiled : null,
      };
      this.reviewed = isReviewedDanmakuBuild(this.metadata);
    } catch { /* A changed native engine keeps original rendering and no shadow demand. */ }
    this.rules = options.rules ?? createBilibiliShadowRules({ player: binding.player, danmaku: binding.danmaku,
      documentScope: options.session, now: this.now, allowPartialUserRules: options.allowPartialUserRules });
    const session = this, manager = binding.manager;
    const safe = (fn: () => void) => { try { fn(); } catch { session.observed.instrumentationErrors++; } };
    const validate = observe(manager, 'validate', original => function(this: Native, ...args: any[]) {
      const result = Reflect.apply(original, this, args);
      if (this === manager) safe(() => session.record('nativeValidate', args[0], { result: result === true }));
      return result;
    });
    const init = options.observeInit === false ? null : observe(manager, 'initRender', original => function(this: Native, ...args: any[]) {
      if (this === manager) safe(() => session.record('nativeInitRender', args[0]));
      const result = Reflect.apply(original, this, args);
      if (this === manager) safe(() => {
        for (const model of manager.cDmlist ?? []) session.observeModel(model, safe);
      });
      return result;
    });
    const fetch = observe(manager, 'fetchAndInitDm', original => function(this: Native, ...args: any[]) {
      if (this === manager) safe(() => {
        const render = args[0], p = binding.danmaku.config?.setting?.preTime ?? manager.config?.setting?.preTime;
        if (typeof args[2] !== 'number' && Number.isFinite(render) && session.lastFetchRender !== null) {
          const interval = render - session.lastFetchRender;
          if (interval > p && interval < p + .25) session.cadenceSeconds = interval;
        }
        session.lastFetchRender = Number.isFinite(render) ? render : null;
      });
      return Reflect.apply(original, this, args);
    });
    this.hooks.validate = !!validate; this.hooks.initRender = !!init; this.hooks.fetch = !!fetch;
    for (const restore of [validate, init, fetch]) if (restore) this.restores.push(restore);
  }

  private item(source: any): ShadowItem | null {
    if (!source || ![1, 4, 5, 6].includes(source.mode) ||
      typeof (source.dmid ?? source.id_str) !== 'string' || typeof source.text !== 'string' ||
      !source.text || source.text.length > 1000 || !Number.isFinite(source.stime)) return null;
    return source;
  }

  private record(type: EventType, source: any, details: Record<string, any> = {}) {
    if (this.stopped || !this.running) return;
    const item = this.item(source);
    if (!item) { this.observed.ignoredNative++; return; }
    const id = bilibiliSourceEventId(this.options.binding.identity.resourceId, (item.dmid ?? item.id_str)!);
    // Native init can see the adapter's translated shallow copy; identity stays
    // tied to the original timeline text captured at selection when available.
    const originalText = this.selected.get(id)?.originalText ?? item.text;
    this.ledger.record({ type, id, originalText, epoch: this.shadowEpoch,
      mediaTimeMs: this.options.binding.video.currentTime * 1000, wallTimeMs: this.now(),
      stimeMs: item.stime * 1000, ...details });
  }

  private observeModel(model: Native, safe: (fn: () => void) => void) {
    if (this.stopped || this.modelRestores.has(model) || !this.item(model?.textData)) return;
    const session = this;
    const restore = observe(model, 'firstShow', original => function(this: Native, ...args: any[]) {
      const result = Reflect.apply(original, this, args);
      safe(() => session.record('nativeFirstShow', this.textData));
      return result;
    });
    if (restore) { this.modelRestores.set(model, restore); this.hooks.firstShow++; }
    else this.hooks.firstShowUnavailable++;
  }

  private invalidate(reason: string) {
    this.ledger.invalidate(reason);
    this.shadowEpoch++; this.selected.clear(); this.activeSelections.clear(); this.recorded.clear();
    this.firstDeadlines.clear();
    this.lastFetchRender = null; this.capacityExceeded = false;
    this.observed.invalidations[reason] = (this.observed.invalidations[reason] ?? 0) + 1;
  }

  setPredicting(enabled: boolean) { this.predicting = enabled; }

  /** Called immediately before the actual native delegate, never on a suppressed opportunity. */
  recordNativeInit(source: unknown): void {
    if (this.options.observeInit !== false) return;
    try { this.record('nativeInitRender', source); } catch { this.observed.instrumentationErrors++; }
  }

  /** Observe models produced by the delegate without invoking firstShow. */
  afterNativeInit(): void {
    if (this.options.observeInit !== false || this.stopped) return;
    const safe = (fn: () => void) => { try { fn(); } catch { this.observed.instrumentationErrors++; } };
    safe(() => { for (const model of this.options.binding.manager.cDmlist ?? []) this.observeModel(model, safe); });
  }

  tick(epoch = 0) {
    if (this.stopped) return;
    const { binding } = this.options, { video, danmaku, manager } = binding;
    const setting = manager.config?.setting, tc = danmaku.timeController;
    const snapshot = this.rules.read();
    const sampledAtEpochMs = this.nowEpochMs();
    const doc = manager.container?.ownerDocument ?? (globalThis as any).document;
    const rate = video.playbackRate;
    const signature = JSON.stringify([epoch, snapshot.fingerprint, rate, setting?.visible,
      setting?.area, setting?.fontSize, setting?.limit, setting?.preTime, setting?.noDanmakuXTypes,
      manager.containerSize?.height, doc?.hidden === true]);
    const running = video.paused === false && !video.seeking && video.readyState >= 3 &&
      doc?.hidden !== true && setting?.visible === true && danmaku.isRunning !== false;
    if (this.signature && (signature !== this.signature || this.running !== running))
      this.invalidate(signature !== this.signature ? 'configuration-or-epoch-changed' : running ? 'resume' : 'playback-interrupted');
    this.signature = signature; this.nativeEpoch = epoch; this.running = running;
    this.known = !this.capacityExceeded && this.reviewed && snapshot.known && !!setting && !!tc && Array.isArray(manager.dataBase?.timeLine?.list) &&
      this.hooks.validate && (this.hooks.initRender || this.options.observeInit === false) && this.hooks.fetch;
    this.reason = !this.reviewed ? 'native-version-unreviewed' : !this.known ? snapshot.reason ?? 'native-contract-unavailable' : running ? 'running' : 'playback-inactive';
    if (running) this.ledger.advance({ epoch: this.shadowEpoch, mediaTimeMs: video.currentTime * 1000, wallTimeMs: this.now() });
    for (const [model, restore] of this.modelRestores) {
      if (!(manager.cDmlist ?? []).includes(model) && !(manager.visualArray ?? []).includes(model)) {
        restore(); this.modelRestores.delete(model);
      }
    }
    if (running && this.known && this.predicting) {
      const forecast = forecastBilibiliShadow({ list: manager.dataBase.timeLine.list,
        currentTime: video.currentTime, renderTime: tc.renderTime, lastFetchTime: tc.lastFetchDmTime || tc.renderTime,
        lastTime: manager.lastTime || 0, preTime: setting.preTime, videoSpeed: rate,
        cadenceSeconds: this.cadenceSeconds, horizonSeconds: 5, area: setting.area,
        height: manager.containerSize.height, fontSize: setting.fontSize, limit: setting.limit, match: snapshot.match });
      this.lastForecast = forecast;
      const active = new Map<string, BilibiliShadowSelection>();
      for (const prediction of forecast.selected) {
        const item = prediction.item, id = bilibiliSourceEventId(binding.identity.resourceId, (item.dmid ?? item.id_str)!);
        const sourceId = (item.dmid ?? item.id_str)!;
        const key = JSON.stringify([id, item.text]);
        const estimate = sampledAtEpochMs + (prediction.predictedInitMs - video.currentTime * 1000) / rate;
        if (!Number.isFinite(estimate) || active.has(id)) continue;
        // A fresh 5s forecast can move its estimate on every tick. The first
        // estimate is the subscription's conservative deadline for this epoch;
        // it cannot drift later or change the identity of a pending result.
        let deadlineAtEpochMs = this.firstDeadlines.get(key);
        if (deadlineAtEpochMs === undefined) {
          if (this.firstDeadlines.size >= 20000) {
            this.capacityExceeded = true; this.reason = 'capacity-exceeded'; this.known = false; break;
          }
          deadlineAtEpochMs = estimate; this.firstDeadlines.set(key, estimate);
        }
        if (deadlineAtEpochMs <= sampledAtEpochMs) continue;
        active.set(id, { id, sourceId, originalText: item.text, stimeMs: item.stime * 1000,
          deadlineAtEpochMs, reasons: [...prediction.reasons] });
        if (this.recorded.has(key)) continue;
        if (this.recorded.size >= 20000 || this.selected.size >= 2000) {
          this.capacityExceeded = true; this.reason = 'capacity-exceeded'; this.known = false; break;
        }
        this.recorded.add(key);
        this.selected.set(id, { id, originalText: item.text, stime: item.stime });
        this.record('shadowSelected', item, { reasons: prediction.reasons, predictedInitMs: prediction.predictedInitMs });
      }
      this.activeSelections = active;
    } else {
      this.activeSelections.clear();
    }
    for (const [id, row] of this.selected) if (row.stime * 1000 + 2000 < video.currentTime * 1000) this.selected.delete(id);
    const items = this.known && running ? [...this.activeSelections.values()] : [];
    if (new TextEncoder().encode(JSON.stringify(items)).length > 240 * 1024) {
      this.capacityExceeded = true; this.known = false; this.reason = 'bridge-capacity-exceeded';
    }
    this.options.onUpdate?.({ epoch, revision: ++this.revision, predictionEpoch: this.shadowEpoch,
      ruleRevision: snapshot.revision, sampledAtEpochMs, playbackRate: rate, active: true, known: this.known && running,
      items: this.known && running ? items : [] });
  }

  report(evaluation?: { fromStimeMs: number; toStimeMs: number }) {
    return { kind: 'bilibili-shadow-scheduler', horizonSeconds: 5, target: 'nativeInitRender',
      reportedAtEpochMs: this.nowEpochMs(), reportedMonotonicMs: this.now(),
      scope: 'native text modes 1/4/5/6, string dmid, nonempty text of at most 1000 UTF-16 units',
      firstShowIsVisiblePixel: false, resourceId: this.options.binding.identity.resourceId,
      metadata: { ...this.metadata },
      session: this.options.session, nativeEpoch: this.nativeEpoch, shadowEpoch: this.shadowEpoch,
      known: this.known, reason: this.reason, capacityExceeded: this.capacityExceeded, predicting: this.predicting, hooks: { ...this.hooks },
      observed: { ...this.observed }, cadenceSeconds: this.cadenceSeconds,
      lastForecast: this.lastForecast && { rejected: this.lastForecast.rejected, windows: this.lastForecast.windows },
      restoration: this.restoration, ledger: this.ledger.report(evaluation) };
  }

  stop() {
    if (this.stopped) return this.report();
    this.ledger.invalidate('stopped'); this.stopped = true; this.running = false;
    let restored = 0, laterWrapperPreserved = 0;
    for (const restore of [...this.modelRestores.values(), ...this.restores.reverse()]) {
      if (restore()) restored++; else laterWrapperPreserved++;
    }
    this.modelRestores.clear(); this.restoration = { restored, laterWrapperPreserved };
    this.activeSelections.clear();
    this.options.onUpdate?.({ epoch: this.nativeEpoch, revision: ++this.revision, predictionEpoch: this.shadowEpoch,
      active: false, known: false, items: [] });
    return this.report();
  }
}
