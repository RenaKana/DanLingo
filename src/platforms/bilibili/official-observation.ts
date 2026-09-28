import type { BilibiliNativeBinding } from './video.ts';
import { OfficialDomObserver } from './official-dom-observer.ts';
import { createUserFilterReader } from './user-filter-reader.ts';

type Native = Record<string, any>;
export type OfficialMode = 'native-1' | 'native-3' | 'native-5' | 'dom';
/** Observe the official engine executing its own decisions. This is not Shadow simulation. */
export class BilibiliOfficialObservation {
  private restores: (() => boolean)[] = [];
  private modelSeen = new WeakSet<object>();
  private events: any[] = [];
  private dom: OfficialDomObserver;
  private batch = 0;
  private currentBatch: number | null = null;
  private stopped = false;
  private setting: Native;
  private timer: Native;
  private original: number;
  private originalCadence: number;
  private requested: number | null;
  private ready = false;
  private error: string | null = null;
  private restored = false;
  private ownsSetting = false;
  private ownsCadence = false;
  private capacityExceeded = false;
  private instrumentationErrors = 0;
  private metadata: any;
  private settingsEvidence: any;
  private nativeContracts: any;
  private sourcePool: any[] = [];
  private binding: BilibiliNativeBinding;
  readonly runId: string;
  readonly mode: OfficialMode;
  private epoch: () => number;
  private epochNow: () => number;
  constructor(binding: BilibiliNativeBinding, runId: string, mode: OfficialMode,
    epoch: () => number, epochNow: () => number = () => Date.now()) {
    this.binding = binding; this.runId = runId; this.mode = mode; this.epoch = epoch; this.epochNow = epochNow;
    this.setting = binding.danmaku.config?.setting;
    this.timer = binding.danmaku.timeController;
    this.original = this.setting?.preTime;
    this.originalCadence = this.timer?.preTime;
    this.requested = mode === 'dom' ? null : Number(mode.slice(7));
    this.dom = new OfficialDomObserver({ container: binding.manager.container, video: binding.video, epochNow });
  }
  private safe(fn: () => void) { try { fn(); } catch { this.instrumentationErrors++; } }
  private source(item: any) {
    return { dmid: typeof (item?.dmid ?? item?.id_str) === 'string' ? item.dmid ?? item.id_str : null,
      text: typeof item?.text === 'string' ? item.text : null,
      stimeMs: Number.isFinite(item?.stime) ? item.stime * 1000 : null,
      mode: item?.mode ?? null, rawMode: item?.rawMode ?? null,
      on: item?.on === true };
  }
  private record(type: string, item?: any, extra: Native = {}) {
    if (this.stopped) return;
    if (this.events.length >= 100000) { this.capacityExceeded = true; return; }
    this.events.push({ type, atEpochMs: this.epochNow(), mediaTimeMs: this.binding.video.currentTime * 1000,
      epoch: this.epoch(), batch: this.currentBatch, ...(item ? this.source(item) : {}), ...extra });
  }
  private wrap(target: Native, key: string, factory: (original: Function) => Function) {
    const original = target?.[key], descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (typeof original !== 'function' || descriptor && (!('value' in descriptor) || !descriptor.writable))
      throw Error(`official-observer-unwritable-${key}`);
    const wrapper = factory(original);
    Object.defineProperty(target, key, descriptor ? { ...descriptor, value: wrapper }
      : { configurable: true, writable: true, value: wrapper });
    this.restores.push(() => {
      if (target[key] !== wrapper) return false;
      if (descriptor) Object.defineProperty(target, key, descriptor); else delete target[key];
      return true;
    });
  }
  start() {
    try {
      const b = this.binding, m = b.manager, self = this;
      this.metadata = b.danmaku.getMetadata();
      if (!b.video.paused || !this.setting || m.config?.setting !== this.setting ||
          !Number.isFinite(this.original) || !Number.isFinite(this.originalCadence) || this.original !== this.originalCadence)
        throw Error('official-observer-pretime-contract');
      this.nativeContracts = { fetchAndInitDm: String(m.fetchAndInitDm), insert: String(m.insert),
        initRender: String(m.initRender), collisionCheck: String(m.collisionCheck),
        shouldFetchAndInitDm: String(this.timer.shouldFetchAndInitDm) };
      if (!this.nativeContracts.fetchAndInitDm.includes('preTime') ||
          !this.nativeContracts.shouldFetchAndInitDm.includes('preTime')) throw Error('official-observer-cadence-contract');
      const reader = createUserFilterReader({ roots: () => [b.player], registry: () => (globalThis as any).window?.nano,
        danmaku: b.danmaku, documentScope: this.runId, now: () => performance.now() });
      const summary = reader.read(true).compiled.summary;
      const selected = Object.fromEntries(['visible', 'limit', 'videoSpeed', 'speedSync', 'speedPlus', 'duration',
        'area', 'opacity', 'fontSize', 'preventShade', 'density'].map(k => [k, this.setting[k] ?? null]));
      this.settingsEvidence = { userRules: summary, native: selected,
        container: { width: m.containerSize?.width, height: m.containerSize?.height },
        initialPending: m.cDmlist?.length ?? null, initialVisual: m.visualArray?.length ?? null,
        mediaRate: b.video.playbackRate, originalPreTime: this.original, originalCadence: this.originalCadence };
      if (this.requested !== null) {
        if (![1, 3, 5].includes(this.requested)) throw Error('official-observer-invalid-pretime');
        for (const target of [this.setting, this.timer]) {
          const desc = Object.getOwnPropertyDescriptor(target, 'preTime');
          if (!desc || !('value' in desc) || !desc.writable) throw Error('official-observer-pretime-not-data');
        }
        // setSetting calls persistence-facing hooks and does not update the timer's copied preTime.
        // Own this task page's two runtime values only; never call setSetting or write user storage.
        this.setting.preTime = this.requested;
        this.ownsSetting = true;
        this.timer.preTime = this.requested;
        this.ownsCadence = true;
        if (this.setting.preTime !== this.requested || this.timer.preTime !== this.requested)
          throw Error('official-observer-pretime-write-failed');
        this.wrap(m, 'fetchAndInitDm', original => function(this: any, ...args: any[]) {
          const prior = self.currentBatch;
          if (this === m) self.safe(() => { self.currentBatch = ++self.batch;
            self.record('nativeFetch', undefined, { renderTimeMs: args[0] * 1000, currentTimeMs: args[1] * 1000,
              seekTarget: args[2] ?? null, seekTargetKind: args[2] === null ? 'null' : typeof args[2],
              seekBackfill: +args[2] >= 0, preTime: self.setting.preTime, cadence: self.timer.preTime }); });
          try { return Reflect.apply(original, this, args); }
          finally { self.currentBatch = prior; }
        });
        this.wrap(m.dataBase, 'getItemsByRange', original => function(this: any, ...args: any[]) {
          const result = Reflect.apply(original, this, args);
          if (this === m.dataBase) self.safe(() => {
            self.record('nativeRange', undefined, { fromMs: args[0] * 1000, toMs: args[1] * 1000, count: result?.length });
          });
          return result;
        });
        this.wrap(m, 'insert', original => function(this: any, ...args: any[]) {
          if (this === m) self.safe(() => { for (const item of args[0] ?? []) self.record('nativeCandidate', item); });
          return Reflect.apply(original, this, args);
        });
        this.wrap(m, 'validate', original => function(this: any, ...args: any[]) {
          const result = Reflect.apply(original, this, args);
          if (this === m) self.safe(() => self.record('nativeValidate', args[0], { result: result === true }));
          return result;
        });
        this.wrap(m, 'initRender', original => function(this: any, ...args: any[]) {
          if (this === m) self.safe(() => self.record('nativeInitRender', args[0]));
          const result = Reflect.apply(original, this, args);
          if (this === m) self.safe(() => self.observeModels());
          return result;
        });
        this.wrap(m, 'collisionCheck', original => function(this: any, ...args: any[]) {
          let pending: any[] = [];
          if (this === m) self.safe(() => { pending = [...(m.cDmlist ?? [])]; });
          const result = Reflect.apply(original, this, args);
          if (this === m) self.safe(() => {
            const accepted = new Set(m.visualArray ?? []);
            for (const model of pending) self.record(accepted.has(model) ? 'trackAccepted' : 'trackRejected', model.textData);
          });
          return result;
        });
      }
      this.dom.start(); this.ready = true;
    } catch (e) { this.error = e instanceof Error ? e.message : String(e); this.stop(); }
    return this.snapshot();
  }
  private observeModels() {
    for (const model of this.binding.manager.cDmlist ?? []) {
      if (this.modelSeen.has(model)) continue;
      this.modelSeen.add(model);
      const source = { ...this.source(model.textData) }, batch = this.currentBatch;
      this.record('nativeModel', model.textData);
      const self = this;
      this.wrap(model, 'firstShow', original => function(this: any, ...args: any[]) {
        const result = Reflect.apply(original, this, args);
        if (this === model) self.safe(() => self.record('nativeFirstShow', undefined, { ...source, batch }));
        return result;
      });
    }
  }
  snapshot() {
    if (!this.stopped && this.mode !== 'dom') this.safe(() => {
      const pool = this.binding.manager.dataBase?.dmArray;
      if (Array.isArray(pool)) {
        if (pool.length > 30000) this.capacityExceeded = true;
        this.sourcePool = pool.slice(0, 30000).map(item => this.source(item));
      }
    });
    return { runId: this.runId, mode: this.mode, ready: this.ready, error: this.error, stopped: this.stopped,
      preTime: { original: this.original, originalCadence: this.originalCadence, current: this.setting?.preTime,
        cadence: this.timer?.preTime, requested: this.requested, restored: this.restored },
      capacityExceeded: this.capacityExceeded || this.dom.capacityExceeded,
      instrumentationErrors: this.instrumentationErrors + this.dom.instrumentationErrors,
      metadata: this.metadata, settingsEvidence: this.settingsEvidence, nativeContracts: this.nativeContracts, sourcePool: this.sourcePool,
      methodHooks: !this.stopped && this.mode !== 'dom', events: this.events, dom: this.dom.snapshot() };
  }
  stop() {
    if (this.stopped) return;
    this.dom.stop();
    let restored = true;
    for (const restore of this.restores.reverse()) try { restored = restore() && restored; } catch { restored = false; }
    this.restores = [];
    if (this.ownsSetting || this.ownsCadence) {
      try {
        if (this.ownsSetting) {
          if (this.setting?.preTime === this.requested) this.setting.preTime = this.original; else restored = false;
        }
        if (this.ownsCadence) {
          if (this.timer?.preTime === this.requested) this.timer.preTime = this.originalCadence; else restored = false;
        }
      } catch { restored = false; }
    }
    this.restored = restored; this.stopped = true;
  }
}
