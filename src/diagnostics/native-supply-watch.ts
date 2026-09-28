import type { PlaybackClock, ResourceSession, Settings, TranslationOutput } from '../core/types.ts';
import type { DueItem, NativeDemand, PreparedVideoItem } from '../core/scheduler.ts';

interface Context { ready: boolean; epoch: number; session: ResourceSession; clock: PlaybackClock | null;
  settings: Settings; configVersion: number; visible: boolean; video: HTMLVideoElement | null; snapshotAt?: number }
interface Options {
  buildId: string; context(): Context; demands(): NativeDemand[];
  rpc(message: Record<string, unknown>): Promise<any>;
  control(extra?: Record<string, unknown>): void; configure(settings: Settings): void; send(message: Record<string, unknown>): void;
  close(id: string, original: string, epoch: number, predictionEpoch: number, reason: string): void;
  original(id: string): string | undefined;
}
type OfficialMode = 'native-1' | 'native-3' | 'native-5' | 'dom';
const OFFICIAL_ACTIONS: Record<string, OfficialMode> = {
  'reference-official-1-start': 'native-1',
  'reference-official-3-start': 'native-3',
  'reference-official-5-start': 'native-5',
  'reference-official-dom-start': 'dom',
};

/** Owns the content-side subscriptions only. Rendering and final adoption stay in MAIN. */
export class NativeSupplyWatch {
  grant: any = null;
  state: 'disabled' | 'waiting' | 'armed' | 'running' | 'paused' | 'draining' = 'disabled';
  reason = '';
  reference = false;
  referenceFullVideo = false;
  private referenceDurationMs = 0;
  private referenceStartedAtEpochMs = 0;
  private referenceSamples: any[] = [];
  private referenceForecasts: any[] = [];
  private referenceTruncated = false;
  private referenceSampleAt = -Infinity;
  private official: { mode: OfficialMode; runId: string; durationMs: number;
    startedAtEpochMs: number } | null = null;
  private officialReport: any = null;
  private officialRevision = 0;
  private officialSamples: any[] = [];
  private officialSampleAt = -Infinity;
  private officialTruncated = false;
  private version = 0;
  private policy: 'native' | 'owned' = 'native';
  private preparing = false;
  private drainUntilMs: number | null = null;
  private requests = new Map<string, { signal: AbortSignal; items: Map<string, NativeDemand>;
    receive(output: TranslationOutput): void }>();
  private results = new Map<string, any>();
  private events: any[] = [];
  private report: any = null;
  private shadowReport: any = null;
  private ownedReport: any = null;
  private subscriptions: any[] = [];
  private deliveries: any[] = [];
  private pending = { runId: 'native-pending', instanceId: 'native-pending', configIdentity: 'pending', fromMs: 0, toMs: 45000 };
  private options: Options;
  constructor(options: Options) { this.options = options; }
  get active() { return this.state !== 'disabled'; }
  get running() { return this.state === 'running'; }
  get waiting() { return this.state === 'waiting'; }
  get owned() { return this.active ? this.policy === 'owned' : this.options.context().settings.bilibiliOwnedRelease === true; }
  get startBlocker() {
    if (!this.owned) return '';
    const s = this.options.context().settings;
    if (s.enabled) return '请先关闭设置中的“启用翻译”，再用下方按钮启动自主弹幕';
    if (s.backend !== 'local' || !s.localModelId) return '请先选择已登记的本地模型';
    return '';
  }
  get displayReason() {
    if (this.waiting) return this.startBlocker || this.reason;
    if (!this.owned || !/^[a-z][a-z0-9-]+$/.test(this.reason)) return this.reason;
    if (/budget.*(?:identity|changed)|config|context-changed/.test(this.reason)) return '配置或页面已变化；结束旧任务后可显式启动新预算';
    if (/budget/.test(this.reason)) return '本次预算已停止；继续会使用剩余额度';
    if (/model/.test(this.reason)) return '本地模型尚未就绪或已变化，请检查模型设置';
    if (/guard|owner|other-live-run/.test(this.reason)) return '翻译许可仍受任务保护；请先结束占用它的实验';
    if (/contract|native-|owned-/.test(this.reason)) return '当前播放器或弹幕规则暂不可用，自主弹幕已暂停';
    return '自主弹幕已暂停，请检查播放和翻译配置';
  }
  get officialActive() { return this.official !== null; }
  officialObservationValue() {
    return this.official && { mode: this.official.mode, runId: this.official.runId };
  }
  armSetting() {
    if (this.active) return;
    this.policy = this.options.context().settings.bilibiliOwnedRelease ? 'owned' : 'native';
    this.state = this.policy === 'owned' ? 'waiting' : 'paused';
    this.reason = this.owned ? '尚未启动翻译；普通弹幕暂不显示' : '等待启动有预算的7B实验';
    if (!this.waiting) this.options.context().video?.pause();
    this.options.control();
  }
  controlValue() {
    if (!this.active) return null;
    const owner = this.grant ?? this.pending;
    const settings = this.options.context().settings;
    return { runId: owner.runId, instanceId: owner.instanceId, configIdentity: owner.configIdentity,
      ...(this.owned ? { policy: 'owned' as const } : {}),
      fromMs: owner.fromMs, toMs: owner.toMs, enabled: true,
      sourceLanguage: this.owned ? this.grant?.sourceLanguage ?? settings.sourceLanguage : 'auto',
      targetLanguage: this.owned ? this.grant?.targetLanguage ?? settings.targetLanguage : 'ja',
      state: this.state === 'running' || this.state === 'draining' ? 'running' : this.state === 'armed' || this.waiting ? 'armed' : 'paused' };
  }
  effectiveSettings(): Settings {
    const s = this.options.context().settings;
    if (this.owned) return { ...s, enabled: !this.waiting, displayMode: 'translated', bilibiliOwnedRelease: true,
      bilibiliNativeTranslationOnly: true, bilibiliShadowScheduler: false, backend: 'local',
      concurrency: s.localConcurrency, translationScope: 'window', prefetchSeconds: 5 };
    return { ...s, enabled: true, displayMode: 'translated', bilibiliNativeTranslationOnly: true,
      bilibiliOwnedRelease: false,
      bilibiliShadowScheduler: true, backend: 'local', sourceLanguage: 'auto', targetLanguage: 'ja',
      localConcurrency: 2, concurrency: 2, translationScope: 'window', prefetchSeconds: 5 };
  }
  private identityCurrent(grant = this.grant) {
    const c = this.options.context();
    return !!grant && c.ready && c.epoch === grant.epoch && c.configVersion === grant.configVersion &&
      JSON.stringify(c.session) === JSON.stringify(grant.session);
  }
  async host(action: string, extra: Record<string, unknown> = {}) {
    const reply = await this.options.rpc({ type: this.owned ? 'bilibili-owned-supply-host' : 'bilibili-native-supply-host', action,
      runId: this.grant?.runId, instanceId: this.grant?.instanceId, epoch: this.options.context().epoch, ...extra });
    if (!reply?.ok) throw Error(reply?.error ?? 'native-supply-host-unavailable');
    return reply;
  }
  private abortRequests() {
    for (const [requestId] of this.requests) void this.host('cancel', { requestId }).catch(() => {});
    this.requests.clear();
  }
  /** Leave a legacy diagnostic from a settings change without touching playback. */
  async retire(): Promise<void> {
    const type = this.owned ? 'bilibili-owned-supply-host' : 'bilibili-native-supply-host';
    const owner = this.grant && { runId: this.grant.runId, instanceId: this.grant.instanceId,
      epoch: this.options.context().epoch };
    this.version++; this.abortRequests();
    this.state = 'disabled';
    try {
      if (owner) for (const action of ['stop', 'cleanup']) {
        const reply = await this.options.rpc({ type, action, ...owner, reason: 'ordinary-planned-flow' });
        if (!reply?.ok) throw Error(reply?.error ?? 'legacy-retirement-failed');
      }
    } finally {
      this.grant = null; this.results.clear(); this.reference = false; this.official = null;
      this.reason = ''; this.options.control();
    }
  }
  pause(reason: string) {
    if (!this.active) return;
    if (this.state === 'paused') { this.reason = reason; return; }
    this.state = 'paused'; this.reason = reason; this.version++; this.abortRequests();
    this.options.context().video?.pause(); this.options.control();
    void this.host('stop', { reason }).catch(() => {});
  }
  tick() {
    if (this.official) {
      const c = this.options.context();
      if (Date.now() - this.officialSampleAt >= 200) {
        this.officialSampleAt = Date.now();
        if (this.officialSamples.length < 20000) this.officialSamples.push({ atEpochMs: this.officialSampleAt,
          epoch: c.epoch, mediaTimeMs: (c.video?.currentTime ?? 0) * 1000, paused: c.video?.paused,
          seeking: c.video?.seeking, playbackRate: c.video?.playbackRate, readyState: c.video?.readyState,
          visible: c.visible, ended: c.video?.ended });
        else this.officialTruncated = true;
      }
      return;
    }
    if (this.reference) {
      const c = this.options.context();
      if (!this.referenceFullVideo && (c.clock?.mediaTimeMs ?? 0) >= 52000) c.video?.pause();
      if (this.referenceFullVideo && Date.now() - this.referenceSampleAt >= 200) {
        this.referenceSampleAt = Date.now();
        if (this.referenceSamples.length < 20000) this.referenceSamples.push({ atEpochMs: this.referenceSampleAt,
          epoch: c.epoch, mediaTimeMs: (c.video?.currentTime ?? 0) * 1000, paused: c.video?.paused,
          seeking: c.video?.seeking, playbackRate: c.video?.playbackRate, readyState: c.video?.readyState,
          visible: c.visible, ended: c.video?.ended });
        else this.referenceTruncated = true;
      }
      return;
    }
    if (!this.active || this.preparing || this.waiting) return;
    const c = this.options.context();
    if (!this.grant) c.video?.pause();
    if (this.grant && !this.identityCurrent()) { this.pause('播放或配置已变化，请停止后重新准备'); return; }
    if (this.running && (!c.ready || !c.visible || c.clock?.seeking)) this.pause('播放环境不可用');
    if (this.running && c.clock && c.clock.mediaTimeMs >= this.grant.toMs) {
      this.state = 'draining'; this.abortRequests(); void this.host('drain', { reason: 'range-complete' }).catch(() => {});
    }
    if (this.state === 'draining' && c.clock && c.clock.mediaTimeMs >= (this.drainUntilMs ?? this.grant.toMs + 7000)) {
      c.video?.pause(); this.state = 'paused'; this.reason = this.drainUntilMs === null ? '片段结束' : '本次预算已停止；可继续剩余额度或显式启动新预算'; this.options.control();
    }
  }
  proof(message: any) {
    const c = this.options.context();
    return { ok: this.running && this.identityCurrent() && message.runId === this.grant?.runId &&
      message.instanceId === this.grant?.instanceId && message.epoch === c.epoch,
      buildId: this.options.buildId, runId: this.grant?.runId, instanceId: this.grant?.instanceId,
      epoch: c.epoch, session: c.session, contextValid: c.ready, visible: c.visible,
      clock: c.clock, demands: this.options.demands().filter(d => d.mediaTimeMs >= this.grant?.fromMs && d.mediaTimeMs < this.grant?.toMs) };
  }
  async request(items: DueItem[], signal: AbortSignal, receive: (o: TranslationOutput) => void): Promise<TranslationOutput[]> {
    const grant = this.grant, version = this.version;
    if (!this.running || !this.identityCurrent(grant)) return items.map(i => ({ id: i.id, status: 'original', reason: 'cancelled' }));
    const requestId = crypto.randomUUID(), demands = this.options.demands();
    const owners = new Map<string, NativeDemand>();
    for (const item of items) {
      const d = demands.find(d => d.id === item.id && d.originalText === item.text && d.epoch === item.epoch &&
        d.predictionEpoch === item.predictionEpoch && d.ruleRevision === item.ruleRevision && d.deadlineAtEpochMs === item.deadlineAtEpochMs);
      if (d && d.mediaTimeMs >= grant.fromMs && d.mediaTimeMs < grant.toMs) owners.set(item.id, d);
    }
    const excluded: TranslationOutput[] = items.filter(i => !owners.has(i.id)).map(i => ({ id: i.id, status: 'original', reason: 'no-current-demand' }));
    if (!owners.size) return excluded;
    const request = { signal, items: owners, receive };
    this.subscriptions.push({ requestId, atEpochMs: Date.now(), items: [...owners.values()] });
    this.requests.set(requestId, request);
    const cancel = () => { void this.host('cancel', { requestId }).catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (signal.aborted) return items.map(i => ({ id: i.id, status: 'original', reason: 'cancelled' }));
      const response = await this.host('translate', { requestId, items: [...owners.values()].map(d => ({ ...d, text: d.originalText,
        remainingMs: Math.max(0, d.deadlineAtEpochMs - Date.now()) })) });
      if (signal.aborted || version !== this.version || !this.identityCurrent(grant)) return excluded;
      for (const output of response.items ?? []) this.acceptResult(requestId, output);
      if (this.owned && response.budgetExhausted === true) {
        const clock = this.options.context().clock;
        this.reason = response.budgetReason === 'insufficient-for-request' ? '剩余额度不足本批请求，正在收尾' : '本次预算已用完，正在收尾';
        this.state = 'draining';
        this.drainUntilMs = (clock?.mediaTimeMs ?? grant.toMs) + 7000 * (clock?.playbackRate ?? 1);
        this.abortRequests(); this.options.control();
        void this.host('drain', { reason: 'budget-limit' }).catch(() => {});
      }
      return excluded.concat(response.items ?? []);
    } catch (error) {
      this.reason = error instanceof Error ? error.message : 'native-supply-request-failed';
      return excluded.concat([...owners.keys()].map(id => ({ id, status: 'failed' as const, reason: this.reason })));
    } finally { signal.removeEventListener('abort', cancel); this.requests.delete(requestId); }
  }
  cancelItems(signal: AbortSignal, ids: string[]) {
    for (const [requestId, request] of this.requests) if (request.signal === signal) {
      const removed = ids.filter(id => request.items.delete(id));
      if (removed.length) void this.host('cancel', { requestId, ids: removed }).catch(() => {});
    }
  }
  acceptResult(requestId: string, output: any) {
    const request = this.requests.get(requestId), owner = request?.items.get(output?.id), meta = output?.nativeSupply;
    if (output?.id && this.deliveries.length < 20000) this.deliveries.push({ requestId, atEpochMs: Date.now(),
      id: output.id, status: output.status, reason: output.reason ?? null, hasProvenance: !!meta,
      current: !!request && !request.signal.aborted && !!owner && this.running && this.identityCurrent() });
    if (!request || request.signal.aborted || !owner || !this.running || !this.identityCurrent()) return;
    if (['translated', 'cached'].includes(output.status)) {
      if (!meta || meta.runId !== this.grant.runId || meta.instanceId !== this.grant.instanceId ||
        meta.configIdentity !== this.grant.configIdentity || typeof output.text !== 'string' || output.text === owner.originalText ||
        owner.deadlineAtEpochMs <= Date.now()) return;
      this.results.set(output.id, { ...meta, ...owner, text: output.text, status: output.status });
    }
    request.receive(output);
  }
  prepared(items: PreparedVideoItem[]) {
    if (!this.running || !this.identityCurrent()) return;
    const valid = items.flatMap(item => {
      const result = this.results.get(item.id);
      return result && item.epoch === result.epoch && item.predictionEpoch === result.predictionEpoch &&
        item.ruleRevision === result.ruleRevision && item.originalText === result.originalText && item.text === result.text &&
        item.deadlineAtEpochMs! > Date.now() ? [{ ...item, ...result }] : [];
    });
    if (valid.length) this.options.send({ type: 'prepared', nativeSupply: true, items: valid });
  }
  native(message: any) {
    if (!this.active && !this.reference && !this.official) return;
    if (message.type === 'bilibili-official-observation' && this.official &&
        (message.report?.runId === this.official.runId && message.report?.mode === this.official.mode ||
          message.report?.error && !message.report?.runId)) {
      this.officialReport = { ...message.report, runId: this.official.runId, mode: this.official.mode };
      this.officialRevision++;
    }
    if (this.referenceFullVideo && message.type === 'bilibili-shadow') {
      const c = this.options.context();
      if (this.referenceForecasts.length < 20000) this.referenceForecasts.push({
        atEpochMs: Date.now(), mediaTimeMs: (c.video?.currentTime ?? 0) * 1000,
        epoch: message.epoch, predictionEpoch: message.predictionEpoch, ruleRevision: message.ruleRevision,
        revision: message.revision, sampledAtEpochMs: message.sampledAtEpochMs,
        playbackRate: message.playbackRate, active: message.active, known: message.known,
        items: message.items });
      else this.referenceTruncated = true;
    }
    if (message.type === 'bilibili-native-supply-report') this.report = message.report;
    if (message.type === 'bilibili-shadow-report') this.shadowReport = message.report;
    if (message.type === 'bilibili-owned-release-report') this.ownedReport = message.report;
    if (message.type === 'snapshot' && message.nativeSupply?.ownedRelease) this.ownedReport = message.nativeSupply.ownedRelease;
    if (message.type === 'snapshot' && message.nativeSupply?.report && !this.report?.events) this.report = message.nativeSupply.report;
    const e = message.type === 'bilibili-native-supply-event' ? message.event : null;
    if (!e) return;
    if (this.events.length < 20000) this.events.push(e);
    if (e.closed && e.id && Number.isSafeInteger(e.predictionEpoch)) {
      const original = e.originalText ?? this.options.demands().find(d => d.id === e.id)?.originalText ?? this.results.get(e.id)?.originalText ?? this.options.original(e.id);
      if (original) this.options.close(e.id, original, e.epoch, e.predictionEpoch, e.reason ?? e.type);
    }
    if (e.type === 'contractPaused' && e.closed) this.pause(e.reason ?? 'native-contract-invalid');
  }
  status(full = false) {
    const c = this.options.context();
    return { ok: c.ready && !!c.clock, ...(!c.ready || !c.clock ? { error: 'watch-not-ready' } : {}),
      buildId: this.options.buildId, state: this.state, reason: this.reason,
      policy: this.owned ? 'owned' : 'native', range: { fromMs: (this.grant ?? this.pending).fromMs, toMs: (this.grant ?? this.pending).toMs },
      epoch: c.epoch, session: c.session, clock: c.clock, activeRequests: this.requests.size,
      ...(this.reference ? { reference: { fullVideo: this.referenceFullVideo,
        durationMs: this.referenceDurationMs, ended: c.video?.ended === true,
        startedAtEpochMs: this.referenceStartedAtEpochMs, truncated: this.referenceTruncated,
        sampleCount: this.referenceSamples.length, forecastCount: this.referenceForecasts.length,
        ...(full ? { samples: this.referenceSamples, forecasts: this.referenceForecasts } : {}) } } : {}),
      ...(this.official ? { official: { ...this.official, fullVideo: true,
        ended: c.video?.ended === true, sampleCount: this.officialSamples.length,
        truncated: this.officialTruncated,
        ...(full ? { samples: this.officialSamples } : {}) } } : {}),
      officialReport: full ? this.officialReport : this.officialReport && {
        ...this.officialReport, events: undefined, dom: undefined, sourcePool: undefined },
      native: full ? this.report : this.report && { ...this.report, events: undefined },
      ...(this.owned ? { ownedRelease: this.ownedReport } : {}),
      ...(full ? { shadow: this.shadowReport, events: this.events, results: [...this.results.values()],
        subscriptions: this.subscriptions, deliveries: this.deliveries } : {}) };
  }
  async action(action: string, input: any = {}): Promise<any> {
    if (action === 'reference-ready') {
      const c = this.options.context();
      if (!c.ready || !c.video) throw Error('watch-not-ready');
      if (c.settings.enabled || this.active || this.grant || this.official) throw Error('native-reference-requires-idle');
      c.video.pause();
      // The native bridge may become ready before the ordinary asynchronous
      // status publisher registers this document with the background guard.
      const opened = await this.options.rpc({ type: 'session-open', session: c.session });
      if (!opened?.ok) throw Error('native-reference-session-unavailable');
      return this.status();
    }
    if (Object.hasOwn(OFFICIAL_ACTIONS, action)) {
      const c = this.options.context(), mode = OFFICIAL_ACTIONS[action];
      if (!c.ready || !c.video || !c.clock) throw Error('watch-not-ready');
      if (c.settings.enabled || this.active || this.grant || this.reference || this.official)
        throw Error('native-reference-requires-idle');
      const durationMs = c.video.duration * 1000;
      if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 3_600_000)
        throw Error('native-reference-duration-unavailable');
      c.video.pause();
      this.officialReport = null; this.officialRevision = 0;
      this.officialSamples = []; this.officialSampleAt = -Infinity; this.officialTruncated = false;
      this.official = { mode: mode!, runId: crypto.randomUUID(), durationMs, startedAtEpochMs: 0 };
      this.options.configure({ ...c.settings, enabled: false, bilibiliNativeTranslationOnly: false,
        bilibiliShadowScheduler: false });
      this.options.control();
      await this.waitOfficialReport(report => report.ready === true, 'official-reference-ready-timeout');
      const snapshotBefore = c.snapshotAt;
      c.video.currentTime = 0;
      for (let i = 0; i < 60; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        const now = this.options.context();
        if (now.ready && snapshotBefore !== undefined && now.snapshotAt !== undefined &&
            now.snapshotAt > snapshotBefore && now.video?.seeking === false &&
            now.clock?.seeking === false && Math.abs(now.clock.mediaTimeMs) < 300) break;
        if (i === 59) throw Error('official-reference-seek-timeout');
      }
      const opened = await this.options.rpc({ type: 'session-open', session: this.options.context().session });
      if (!opened?.ok) throw Error('official-reference-session-unavailable');
      const revision = this.officialRevision;
      await this.waitOfficialReport(report => report.ready === true, 'official-reference-post-seek-timeout',
        revision, () => this.options.control({ officialObservationExport: true }));
      this.official!.startedAtEpochMs = Date.now();
      await c.video.play();
      return this.status(true);
    }
    if (action === 'reference-start' || action === 'reference-full-start') {
      const c = this.options.context();
      if (!c.ready || !c.video) throw Error('watch-not-ready');
      if (c.settings.enabled || this.active || this.grant || this.official) throw Error('native-reference-requires-idle');
      const fullVideo = action === 'reference-full-start', durationMs = c.video.duration * 1000;
      if (fullVideo && (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 3600000))
        throw Error('native-reference-duration-unavailable');
      this.referenceFullVideo = fullVideo; this.referenceDurationMs = durationMs;
      this.referenceSamples = []; this.referenceForecasts = []; this.referenceTruncated = false;
      this.referenceSampleAt = -Infinity;
      this.reference = true; this.shadowReport = null; c.video.pause();
      this.options.configure({ ...c.settings, enabled: false, bilibiliNativeTranslationOnly: false, bilibiliShadowScheduler: true });
      this.options.control(); c.video.currentTime = 0;
      await new Promise(r => setTimeout(r, 500));
      this.referenceStartedAtEpochMs = Date.now();
      await c.video.play(); return this.status();
    }
    if (action === 'reference-snapshot') {
      if (this.official) {
        const revision = this.officialRevision;
        this.options.control({ officialObservationExport: true });
        await this.waitOfficialReport(report => report.ready === true, 'official-reference-export-timeout', revision);
        return this.status(true);
      }
      if (!this.reference) throw Error('native-reference-not-running');
      this.options.control({ shadowExport: true }); await new Promise(r => setTimeout(r, 100));
      return this.status(true);
    }
    if (action === 'reference-stop' || action === 'reference-export') {
      if (this.official) {
        if (action === 'reference-export') {
          const revision = this.officialRevision;
          this.options.control({ officialObservationExport: true });
          await this.waitOfficialReport(report => report.ready === true, 'official-reference-export-timeout', revision);
          return this.status(true);
        }
        this.options.context().video?.pause();
        const revision = this.officialRevision;
        this.options.control({ officialObservationStop: true, officialObservationExport: true });
        await this.waitOfficialReport(report => report.preTime?.restored === true &&
          report.methodHooks === false, 'official-reference-restore-timeout', revision);
        const result = this.status(true);
        this.official = null; this.options.control();
        return result;
      }
      this.options.context().video?.pause();
      this.options.control({ shadowExport: true }); await new Promise(r => setTimeout(r, 100));
      const report = this.status(true);
      if (action === 'reference-stop') { this.reference = false; this.referenceFullVideo = false; this.options.control(); }
      return report;
    }
    if (action === 'status') return this.status();
    if (action === 'export') {
      this.options.control({ nativeSupplyExport: true, shadowExport: true });
      await new Promise(r => setTimeout(r, 50));
      return this.status(true);
    }
    if (action === 'owned-start') {
      const c = this.options.context();
      if (!c.settings.bilibiliOwnedRelease) throw Error('请先开启自主弹幕');
      if (this.startBlocker) throw Error(this.startBlocker);
      if (!c.ready || !c.video || this.running || this.state === 'draining') throw Error('owned-supply-not-idle');
      const fromMs = Math.max(0, Math.floor(c.video.currentTime * 1000));
      const toMs = Math.ceil(c.video.duration * 1000);
      if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || toMs <= fromMs || toMs > 43_200_000)
        throw Error('自主弹幕需要时长明确且尚未播放结束的视频');
      this.armSetting();
      if (!this.owned) throw Error('请先结束其他弹幕实验');
      c.video.pause();
      const opened = await this.options.rpc({ type: 'session-open', session: c.session });
      if (!opened?.ok) throw Error('当前视频身份尚未就绪，请刷新视频页后重试');
      const existing = await this.host('status');
      const old = existing.grant;
      const fresh = input.newBudget === true;
      if (old && old.policy !== 'owned') throw Error('owned-supply-owner-mismatch');
      if (old && existing.ownerScope === 'other-tab') throw Error('另一个视频页仍持有自主弹幕任务；请先在该页结束任务并关闭该页');
      // Both operations are explicit user actions. A normal start keeps the
      // old task ledger; only the separately labelled new-budget action may
      // archive that ledger and authorize a new finite budget.
      if (old) {
        if (existing.ownerScope === 'orphaned') {
          await this.host('retire-stopped', { previous: { taskId: old.taskId, runId: old.runId, instanceId: old.instanceId } });
          old.reason = 'cleanup';
        } else {
          if (old.state !== 'stopped') await this.host('stop', { reason: 'owned-resume' });
          if (fresh || old.reason === 'cleanup' || existing.ownerScope === 'same-tab-retired' ||
              old.session?.sessionId !== c.session.sessionId || old.session?.resourceId !== c.session.resourceId) {
            await this.host('cleanup'); old.reason = 'cleanup';
          }
        }
      }
      const reuse = old && !fresh;
      const taskId = reuse ? old.taskId : 'owned-ui-' + crypto.randomUUID();
      const runId = reuse ? old.runId : taskId;
      const page = await this.action('replay-prepare', { runId, fromMs, toMs });
      const canResume = reuse && old.reason !== 'cleanup' && old.session?.sessionId === c.session.sessionId &&
        old.session?.resourceId === c.session.resourceId;
      const reply = canResume ? await this.host('resume', { input: { taskId, runId, instanceId: old.instanceId,
        documentId: old.documentId, buildId: this.options.buildId, epoch: page.epoch, fromMs, toMs } }) :
        await this.host('prepare', { input: { taskId, runId, phase: 'main', epoch: page.epoch, fromMs, toMs,
          ...(fresh && old ? { authorizedNewBudget: true } : {}) } });
      await this.action('bind', { grant: reply.grant });
      return this.action('start');
    }
    if (action === 'prepare' || action === 'replay-prepare') {
      const c = this.options.context();
      if (!c.ready || !c.video) throw Error('watch-not-ready');
      if (c.settings.enabled || (this.grant && action !== 'replay-prepare')) throw Error('native-supply-requires-disabled-idle-video');
      const owned = action === 'replay-prepare' ? this.owned : c.settings.bilibiliOwnedRelease === true;
      if (owned && (c.settings.backend !== 'local' || !c.settings.localModelId)) throw Error('请先选择已登记的本地模型并关闭普通翻译');
      const fromMs = input.fromMs ?? (owned ? Math.max(0, Math.floor(c.video.currentTime * 1000)) : 0);
      const toMs = input.toMs ?? (owned ? Math.ceil(c.video.duration * 1000) : 45000);
      if (owned && (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || fromMs < 0 ||
        toMs <= fromMs || toMs > 43_200_000)) throw Error('自主弹幕需要时长明确且尚未播放结束的视频');
      this.policy = owned ? 'owned' : 'native';
      this.reference = false;
      this.preparing = true;
      try {
        this.version++; this.abortRequests(); this.results.clear(); this.events = []; this.report = null; this.shadowReport = null; this.ownedReport = null;
        this.subscriptions = []; this.deliveries = [];
        this.state = 'armed'; this.reason = ''; this.grant = null; this.drainUntilMs = null;
        this.pending = { runId: input.runId ?? 'native-pending', instanceId: 'native-pending', configIdentity: 'pending', fromMs, toMs };
        c.video.pause(); this.options.control(); this.options.configure(this.effectiveSettings());
        const snapshotBefore = c.snapshotAt;
        if (!owned) c.video.currentTime = this.pending.fromMs / 1000;
        for (let i = 0; !owned && i < 60; i++) {
          await new Promise(r => setTimeout(r, 100));
          const now = this.options.context();
          if (now.ready && (snapshotBefore === undefined || now.snapshotAt! > snapshotBefore) && !now.clock?.seeking &&
            Math.abs((now.clock?.mediaTimeMs ?? -1000) - this.pending.fromMs) < 300) break;
          if (i === 59) throw Error('native-supply-seek-timeout');
        }
        const opened = await this.options.rpc({ type: 'session-open', session: this.options.context().session });
        if (!opened?.ok) throw Error('native-supply-session-unavailable');
        this.options.control();
        return this.status();
      } finally { this.preparing = false; }
    }
    if (action === 'bind') {
      const c = this.options.context(), grant = input.grant ?? input;
      if (this.state !== 'armed' || grant.epoch !== c.epoch || grant.buildId !== this.options.buildId ||
        grant.configVersion !== c.configVersion || JSON.stringify(grant.session) !== JSON.stringify(c.session) ||
        (grant.policy === 'owned') !== this.owned || this.owned && (grant.sourceLanguage !== c.settings.sourceLanguage ||
          grant.targetLanguage !== c.settings.targetLanguage || grant.modelId !== c.settings.localModelId)) throw Error('native-supply-grant-mismatch');
      this.grant = grant; this.options.configure(this.effectiveSettings()); this.options.control(); return this.status();
    }
    if (action === 'replay') {
      const old = this.grant;
      if (!old) throw Error('native-supply-replay-unavailable');
      await this.action('replay-prepare', { runId: old.runId, fromMs: old.fromMs, toMs: old.toMs });
      const host = await this.host('replay', { runId: old.runId, instanceId: old.instanceId, epoch: this.options.context().epoch });
      return this.action('bind', { grant: host.grant });
    }
    if (action === 'start') {
      if (this.state !== 'armed' || !this.identityCurrent()) throw Error('native-supply-not-prepared');
      await this.host('start'); this.state = 'running'; this.options.configure(this.effectiveSettings()); this.options.control();
      await this.options.context().video!.play(); return this.status();
    }
    if (action === 'stop' || action === 'drain') {
      if (action === 'stop') this.pause('已停止');
      else { this.state = 'draining'; this.abortRequests(); await this.host('drain'); }
      return this.status();
    }
    if (action === 'cleanup') {
      this.options.context().video?.pause(); this.version++; this.abortRequests();
      const c = this.options.context();
      this.state = c.settings.bilibiliNativeTranslationOnly || c.settings.bilibiliOwnedRelease ? 'paused' : 'disabled';
      this.policy = c.settings.bilibiliOwnedRelease ? 'owned' : 'native';
      this.reason = this.active ? '实验已结束；关闭对应实验选项可恢复普通模式' : '';
      this.grant = null; this.results.clear(); this.options.control();
      this.options.configure(this.active ? this.effectiveSettings() : { ...c.settings, enabled: false });
      return { ...this.status(), restored: true };
    }
    throw Error('native-supply-invalid-action');
  }
  private async waitOfficialReport(accept: (report: any) => boolean, timeout: string,
    afterRevision = 0, retryExport?: () => void) {
    const runId = this.official?.runId;
    for (let i = 0; i < 120; i++) {
      const report = this.officialReport;
      if (this.officialRevision > afterRevision && report?.runId === runId) {
        if (accept(report)) return;
        if (report.error) throw Error(`official-reference-${String(report.error)}`);
      }
      if (retryExport && i % 5 === 0) retryExport();
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error(timeout);
  }
}
