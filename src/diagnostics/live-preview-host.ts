import type { ResourceSession, Settings, TranslationOutput, Usage } from '../core/types.ts';
import type { LocalControl, LocalModelInfo, LocalReply, LocalState } from '../local/types.ts';
import { resolveLocalConfig } from '../local/config.ts';
import { withLocalRuntime } from '../local/provider-settings.ts';
import { MemoryTranslationCache } from '../translation/cache.ts';
import { TranslationEngine } from '../translation/engine.ts';
import { localQualityIssue } from '../translation/local-policy.ts';
import { placeholdersIntact } from '../translation/text.ts';
import { ChatCompletionsProvider, ProviderError, type ProviderItem, type ProviderRequest,
  type ProviderTransportContext } from '../translation/provider.ts';
import { LivePreviewBudget, LivePreviewBudgetError, type LivePreviewBudgetLimits, type LivePreviewPhase } from './live-preview-budget.ts';

export const LIVE_PREVIEW_GRANT_KEY = 'bilibiliLivePreview.grant.v1';
export const LIVE_PREVIEW_BUDGET_KEY = 'bilibiliLivePreview.budget.v1';
export const NATIVE_SUPPLY_GRANT_KEY = 'bilibiliNativeSupply.grant.v1';
export const NATIVE_SUPPLY_BUDGET_KEY = 'bilibiliNativeSupply.budget.v1';
export const NATIVE_SUPPLY_GUARD_KEY = 'bilibiliNativeSupply.zeroTransport.v1';
export const OWNED_SUPPLY_GRANT_KEY = 'bilibiliOwnedSupply.grant.v1';
export const OWNED_SUPPLY_BUDGET_KEY = 'bilibiliOwnedSupply.budget.v1';
export const OWNED_SUPPLY_GUARD_KEY = 'bilibiliOwnedSupply.zeroTransport.v1';
export const OWNED_SUPPLY_HISTORY_KEY = 'bilibiliOwnedSupply.history.v1';
export const LIVE_PREVIEW_RESOURCE = 'av117318021548752:cid42173138507';
const TEMPORARY_KEY = 'bilibiliRenderPreview.zeroTransport.v1';
const PERSISTENT_KEY = 'bilibiliUserFilters.zeroTransport.v1';
const NATIVE_LIMITS: LivePreviewBudgetLimits = {
  total: { requests: 100, items: 100, utf16Chars: 2000 },
  phases: {
    main: { requests: 100, items: 100, utf16Chars: 2000 },
    repair: { requests: 100, items: 100, utf16Chars: 2000 },
    supplement: { requests: 0, items: 0, utf16Chars: 0 },
  },
};
function fail(reason: string): never { throw new ProviderError(`live-preview-${reason}`); }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered) :
  value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key =>
    [key, ordered((value as Record<string, unknown>)[key])])) : value;
const sameValues = (a: unknown, b: unknown) => same(ordered(a), ordered(b));
const sameResource = (a: ResourceSession, b: ResourceSession) => a.platform === b.platform &&
  a.scenario === b.scenario && a.resourceId === b.resourceId;
const digest = async (value: unknown) => [...new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(JSON.stringify(value))))].map(x => x.toString(16).padStart(2, '0')).join('');
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const RECOVERABLE_MODEL_ERRORS = new Set(['LOCAL_OFFSCREEN_UNAVAILABLE', 'LOCAL_WORKER_FAILED', 'LOCAL_GPU_DEVICE_FAILED']);

export interface LivePreviewPrepareInput {
  taskId: string; runId: string; phase: LivePreviewPhase; tabId: number;
  epoch: number; fromMs?: number; toMs?: number; repairReason?: string; modelId?: string;
  authorizedExtraLoad?: boolean; authorizedNewBudget?: boolean;
}
export interface LivePreviewResumeInput {
  taskId: string; tabId: number; documentId: string; runId: string;
  instanceId: string; epoch: number; buildId: string; fromMs?: number; toMs?: number;
}

export interface LivePreviewHostContext {
  settings: Settings; configVersion: number; tabId: number; documentId: string;
  session: ResourceSession; idle: boolean;
}
export interface LivePreviewHostOptions {
  purpose?: 'preview' | 'native-supply' | 'owned-supply';
  buildId: string;
  storage: { get: (keys: string | string[]) => Promise<Record<string, any>>;
    set: (value: Record<string, unknown>) => Promise<void>; remove: (key: string) => Promise<void> };
  context: (tabId: number) => Promise<LivePreviewHostContext | null>;
  localControl: (control: LocalControl) => Promise<LocalReply>;
  page: (tabId: number, documentId: string, message: Record<string, unknown>) => Promise<any>;
  createLocalFetch: (modelId: string, gate: { beforeSend: (id: string, signal?: AbortSignal | null) => Promise<void>;
    sent?: (id: string) => void }) => typeof fetch;
  globalIdle?: () => Promise<boolean>;
  keepAlive?: () => () => void;
}
interface Grant {
  taskId: string; runId: string; phase: LivePreviewPhase; tabId: number; documentId: string;
  session: ResourceSession; epoch: number; buildId: string; instanceId: string;
  modelId: string; modelName: string; modelGeneration: number; modelIdentity: string; configIdentity: string;
  savedSettingsIdentity: string; configVersion: number; fromMs: number; toMs: number;
  state: 'preparing' | 'prepared' | 'running' | 'draining' | 'stopped';
  startedAt?: number;
  modelBaseline: ModelSnapshot; loadedByTask: boolean; modelLoads: number; modelAfterLoad?: ModelSnapshot;
  loadRecoveryCount: number; loadOwnership: 'not-loaded' | 'preexisting' | 'loading' | 'owned' | 'uncertain';
  modelIdentityKind: 'metadata-only-sha256'; resumeCount: number;
  loadFailure?: string; reason: string; repairReason?: string;
  cacheOnly?: boolean;
  previousRunId?: string;
  policy?: 'owned'; sourceLanguage?: string; targetLanguage?: string;
}
interface Demand { id: string; sourceId: string; originalText: string; mediaTimeMs: number }
interface NativeDemand extends Demand { deadlineAtEpochMs: number; epoch: number;
  predictionEpoch: number; ruleRevision: string | number }
interface ProvenDemand extends Demand { proofMediaTimeMs: number; proofAtEpochMs?: number }
interface ModelSnapshot {
  phase: LocalState['phase']; modelId: string | null; modelName: string | null; generation: number; modelIdentity: string | null;
  inferenceCalls: number; active: number; queued: number; runtime?: LocalState['runtime']; warmupMs?: number;
}
interface ResultCandidate { taskId: string; resultId: string; originalText: string; text: string;
  completedAt: number; completedAtEpochMs?: number; usage: Usage | null; deliveries: number; validated?: boolean;
  reason?: string; configIdentity?: string }
interface ActiveRun { grant: Grant; settings: Settings; engine: TranslationEngine;
  cache: MemoryTranslationCache;
  requests: Map<string, { controller: AbortController; items: Map<string, string>; nativeItems?: Map<string, NativeDemand> }>;
  requestIds: Set<string>; results: Map<string, ResultCandidate>; candidates: Map<string, ResultCandidate>;
  inputs: any[]; deliveries: any[]; errors: string[];
  proofs: Array<{ atEpochMs: number; mediaTimeMs: number; demands: number }>;
  budgetInsufficient?: boolean;
  usage?: Usage; }

function metadataFor(model: LocalModelInfo | undefined): Record<string, unknown> {
  if (!model || model.metadataComplete !== true || model.availability && model.availability !== 'ready' ||
      !validId(model.id) || !Number.isSafeInteger(model.bytes) || model.bytes <= 0 || !Array.isArray(model.files) ||
      model.files.length === 0 || model.files.some(file => typeof file !== 'string' || !file) ||
      !model.architecture || !model.quantization || !model.tokenizer) fail('model-metadata-unavailable');
  const source = model.source ? {
    kind: model.source.kind,
    ...(model.source.kind === 'directory' ? { directoryId: model.source.directoryId } : {}),
    files: [...model.source.files].map(file => ({ path: file.path, size: file.size, lastModified: file.lastModified }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  } : null;
  return {
    id: model.id, name: model.name, files: [...model.files].sort(), bytes: model.bytes,
    architecture: model.architecture, quantization: model.quantization, tokenizer: model.tokenizer,
    template: model.template, importedAt: model.importedAt, source,
    translationProfile: model.translationProfile ?? null, weightBytes: model.weightBytes ?? null,
    layerCount: model.layerCount ?? null, embeddingLength: model.embeddingLength ?? null,
    attentionHeads: model.attentionHeads ?? null, kvHeads: model.kvHeads ?? null,
    keyLength: model.keyLength ?? null, valueLength: model.valueLength ?? null,
    kvKeyDimension: model.kvKeyDimension ?? null, kvValueDimension: model.kvValueDimension ?? null,
    kvDimension: model.kvDimension ?? null, contextLength: model.contextLength ?? null,
    metadataVersion: model.metadataVersion ?? null, metadataComplete: model.metadataComplete,
    templateCapability: model.templateCapability ?? null,
  };
}

/** Result qualification is stricter than the ordinary engine's local quality heuristic. */
export function strictNativeResultIssue(original: string, text: string, settings: Settings): string | null {
  if (!text.trim() || text.length > 24_000) return 'invalid-text';
  if (!placeholdersIntact(original, text)) return 'placeholder-mismatch';
  if (text === original) return 'unchanged-output';
  return localQualityIssue(settings, original, text) ?? null;
}

async function modelIdentity(model: LocalModelInfo | undefined): Promise<string> {
  return digest(metadataFor(model));
}

async function modelSnapshot(state: LocalState, identity?: string): Promise<ModelSnapshot> {
  return {
    phase: state.phase, modelId: state.model?.id ?? null, modelName: state.model?.name ?? null,
    generation: state.generation,
    modelIdentity: identity ?? (state.model ? await modelIdentity(state.model) : null),
    inferenceCalls: state.inferenceCalls, active: state.active, queued: state.queued,
    ...(state.runtime ? { runtime: structuredClone(state.runtime) } : {}),
    ...(state.warmupMs === undefined ? {} : { warmupMs: state.warmupMs }),
  };
}

function errorCode(error: unknown, fallback = 'LOCAL_LOAD_FAILED'): string {
  const candidate = error instanceof Error ? error.message : '';
  return /^LOCAL_[A-Z0-9_]+$/.test(candidate) ? candidate : fallback;
}

function previewSettings(context: LivePreviewHostContext, state: LocalState, native = false, modelId?: string,
  owned = false): Settings {
  if (owned) return withLocalRuntime({ ...context.settings, enabled: true, backend: 'local' as const,
    localModelId: modelId, model: modelId ?? context.settings.model, concurrency: context.settings.localConcurrency,
    translationScope: 'window' as const, localPerformance: { ...context.settings.localPerformance,
      languageValidation: 'strict' as const } }, state);
  const concurrency = Math.max(1, Math.min(2, context.settings.localConcurrency));
  const selected = native ? 2 : concurrency;
  return withLocalRuntime({ ...context.settings, enabled: true, backend: 'local' as const,
    ...(native ? { localModelId: modelId, model: modelId } : {}),
    sourceLanguage: 'auto', targetLanguage: 'ja', concurrency: selected,
    localConcurrency: selected, translationScope: 'window' as const, prefetchSeconds: native ? 5 : 10,
    ...(native ? { localPerformance: { ...context.settings.localPerformance,
      normalMaxTokens: 128, languageValidation: 'strict' as const, promptMode: 'auto' as const,
      warmup: false, parallel: 2 } } : {}) }, state);
}

/** Background coordinator only: existing engine/provider, scoped permission, and a durable send ledger. */
export class LivePreviewHost {
  private readonly options: LivePreviewHostOptions;
  private readonly native: boolean;
  private readonly owned: boolean;
  private budget: LivePreviewBudget;
  private budgetIdentity?: { taskId: string; modelIdentity: string; configIdentity: string };
  private run?: ActiveRun;
  private permits = new WeakMap<object, { run: ActiveRun; request: ProviderRequest }>();
  private preparing = false;
  private readonly revoked = new Map<string, string>();
  private ownerTab: number | null = null;
  get ownerTabId(): number | null { return this.run?.grant.tabId ?? this.ownerTab; }
  constructor(options: LivePreviewHostOptions) {
    this.options = options;
    this.owned = options.purpose === 'owned-supply';
    this.native = options.purpose === 'native-supply' || this.owned;
    this.budget = this.makeBudget();
  }
  private makeBudget(): LivePreviewBudget {
    return new LivePreviewBudget({
      read: async () => (await this.options.storage.get(this.budgetKey))[this.budgetKey],
      write: value => this.options.storage.set({ [this.budgetKey]: value }),
    }, this.native ? NATIVE_LIMITS : undefined);
  }
  private get grantKey() { return this.owned ? OWNED_SUPPLY_GRANT_KEY : this.native ? NATIVE_SUPPLY_GRANT_KEY : LIVE_PREVIEW_GRANT_KEY; }
  private get budgetKey() { return this.owned ? OWNED_SUPPLY_BUDGET_KEY : this.native ? NATIVE_SUPPLY_BUDGET_KEY : LIVE_PREVIEW_BUDGET_KEY; }
  private get guardKey() { return this.owned ? OWNED_SUPPLY_GUARD_KEY : this.native ? NATIVE_SUPPLY_GUARD_KEY : TEMPORARY_KEY; }
  private get ownerKind() { return this.owned ? 'owned-supply' : this.native ? 'native-supply' : 'live-preview'; }
  get active() { return !!this.run && ['prepared', 'running', 'draining'].includes(this.run.grant.state); }
  private async save(grant: Grant) { await this.options.storage.set({ [this.grantKey]: structuredClone(grant) }); }
  private async openBudget(grant: Grant) {
    const identity = { taskId: grant.taskId, modelIdentity: grant.modelIdentity, configIdentity: grant.configIdentity };
    if (same(identity, this.budgetIdentity)) return;
    this.budget = this.makeBudget();
    await this.budget.open(identity.taskId, identity.modelIdentity, identity.configIdentity);
    this.budgetIdentity = identity;
  }
  private async assertPreparing(grant: Grant) {
    await this.guardOwned(grant);
    const persisted = (await this.options.storage.get(this.grantKey))[this.grantKey];
    const reason = this.revoked.get(grant.instanceId);
    if (reason) {
      if (persisted?.instanceId === grant.instanceId && persisted.state !== 'stopped') {
        persisted.state = 'stopped'; persisted.reason = reason; await this.save(persisted);
      }
      fail('permit-revoked');
    }
    if (persisted?.instanceId !== grant.instanceId || persisted.state !== 'preparing') fail('permit-revoked');
  }
  private revoke(instanceId: string, reason: string) {
    this.revoked.set(instanceId, reason);
    if (this.revoked.size > 100) this.revoked.delete(this.revoked.keys().next().value!);
  }
  private async savePreparing(grant: Grant) {
    if (this.revoked.has(grant.instanceId)) return this.assertPreparing(grant);
    const persisted = (await this.options.storage.get(this.grantKey))[this.grantKey];
    if (this.revoked.has(grant.instanceId) || persisted?.instanceId !== grant.instanceId || persisted.state !== 'preparing')
      return this.assertPreparing(grant);
    await this.save(grant);
    await this.assertPreparing(grant);
  }
  private async guardOwned(grant: Grant) {
    const otherKeys = [TEMPORARY_KEY, NATIVE_SUPPLY_GUARD_KEY, OWNED_SUPPLY_GUARD_KEY]
      .filter(key => key !== this.guardKey);
    const stored = await this.options.storage.get([this.guardKey, ...otherKeys, PERSISTENT_KEY]);
    const guard = stored[this.guardKey];
    if (stored[PERSISTENT_KEY] || otherKeys.some(key => stored[key]) || !guard || guard.enabled !== true || guard.kind !== this.ownerKind ||
        guard.tabId !== grant.tabId || guard.runId !== grant.runId) fail('other-guard-or-missing-owner');
  }
  private async assertRun(run: ActiveRun, allowPrepared = false) {
    const grant = run.grant;
    if (this.run !== run || !(grant.state === 'running' || allowPrepared && grant.state === 'prepared')) fail('not-running');
    await this.guardOwned(grant);
    const persisted = (await this.options.storage.get(this.grantKey))[this.grantKey];
    if (grant.buildId !== this.options.buildId || persisted?.instanceId !== grant.instanceId ||
        persisted.state !== grant.state || persisted.taskId !== grant.taskId || persisted.runId !== grant.runId ||
        persisted.tabId !== grant.tabId || persisted.documentId !== grant.documentId || persisted.epoch !== grant.epoch)
      fail('permit-revoked');
    const current = await this.options.context(grant.tabId);
    if (!current || !current.idle || current.settings.enabled || this.owned &&
        (current.settings.bilibiliOwnedRelease !== true || current.settings.backend !== 'local' ||
          current.settings.localModelId !== grant.modelId) || !this.native && (current.settings.backend !== 'local' ||
        current.settings.localModelId !== grant.modelId) || current.documentId !== grant.documentId ||
        !same(current.session, grant.session) || current.configVersion !== grant.configVersion ||
        await digest(current.settings) !== grant.savedSettingsIdentity) fail('context-changed');
    const local = await this.options.localControl({ action: 'state', demand: true });
    if (!local.ok || !local.state || !['ready', 'generating'].includes(local.state.phase) ||
        local.state.model?.id !== grant.modelId || local.state.generation !== grant.modelGeneration ||
        await modelIdentity(local.state.model) !== grant.modelIdentity ||
        !same(local.state.runtime, grant.modelAfterLoad?.runtime)) fail('model-changed');
    if (this.run !== run || !(grant.state === 'running' || allowPrepared && grant.state === 'prepared')) fail('not-running');
  }
  async acceptsTransport(context: ProviderTransportContext): Promise<boolean> {
    const bound = context.localPreviewPermit && this.permits.get(context.localPreviewPermit);
    if (!bound || bound.request !== context.request || context.request.settings.backend !== 'local' ||
        context.request.settings.localModelId !== bound.run.grant.modelId) return false;
    await this.assertRun(bound.run);
    return true;
  }
  private async proof(run: ActiveRun, texts: readonly string[]): Promise<ProvenDemand[][]> {
    const started = performance.now(), grant = run.grant;
    const proof = await this.options.page(grant.tabId, grant.documentId, { type: 'bilibili-live-preview-proof',
      runId: grant.runId, instanceId: grant.instanceId, epoch: grant.epoch });
    const roundTrip = performance.now() - started;
    if (!proof?.ok || proof.buildId !== grant.buildId || proof.runId !== grant.runId ||
        proof.instanceId !== grant.instanceId || proof.epoch !== grant.epoch || !same(proof.session, grant.session) ||
        proof.contextValid !== true || proof.visible !== true || proof.clock?.paused !== false ||
        proof.clock?.seeking !== false || proof.clock?.playbackRate !== 1 || proof.clock?.contentActive !== true ||
        !Number.isFinite(proof.clock.mediaTimeMs) || proof.clock.mediaTimeMs < grant.fromMs ||
        proof.clock.mediaTimeMs >= grant.toMs || !Array.isArray(proof.demands) || proof.demands.length > 100) fail('no-current-demand');
    const demands = proof.demands as Demand[];
    return texts.map(text => {
      const owners = demands.filter(row => typeof row.id === 'string' && typeof row.sourceId === 'string' &&
        row.originalText === text && Number.isFinite(row.mediaTimeMs) && row.mediaTimeMs >= grant.fromMs &&
        row.mediaTimeMs < grant.toMs && row.mediaTimeMs - proof.clock.mediaTimeMs > roundTrip);
      if (!owners.length) fail('no-current-demand');
      return owners.map(owner => ({ ...owner, proofMediaTimeMs: proof.clock.mediaTimeMs }));
    });
  }
  private async nativeProof(run: ActiveRun, items: readonly NativeDemand[]): Promise<ProvenDemand[][]> {
    const grant = run.grant;
    const proof = await this.options.page(grant.tabId, grant.documentId, {
      type: 'bilibili-native-supply-proof', runId: grant.runId, instanceId: grant.instanceId,
      configIdentity: grant.configIdentity, epoch: grant.epoch,
    });
    if (!proof?.ok || proof.buildId !== grant.buildId || proof.runId !== grant.runId ||
        proof.instanceId !== grant.instanceId || proof.epoch !== grant.epoch ||
        !same(proof.session, grant.session) || proof.contextValid !== true || proof.visible !== true ||
        proof.clock?.paused !== false || proof.clock?.seeking !== false ||
        (this.owned ? !Number.isFinite(proof.clock?.playbackRate) || proof.clock.playbackRate <= 0 ||
          proof.clock.playbackRate > 16 : proof.clock?.playbackRate !== 1) || proof.clock?.contentActive !== true ||
        !Number.isFinite(proof.clock.mediaTimeMs) || proof.clock.mediaTimeMs < grant.fromMs ||
        proof.clock.mediaTimeMs >= grant.toMs || !Array.isArray(proof.demands) ||
        proof.demands.length > 2000) fail('no-current-demand');
    const now = Date.now();
    const owners = items.map(item => {
      const current = proof.demands.filter((row: NativeDemand) => row?.id === item.id &&
        row.sourceId === item.sourceId && row.originalText === item.originalText &&
        row.mediaTimeMs === item.mediaTimeMs && row.epoch === item.epoch &&
        row.predictionEpoch === item.predictionEpoch && row.ruleRevision === item.ruleRevision &&
        row.deadlineAtEpochMs === item.deadlineAtEpochMs && item.epoch === grant.epoch &&
        item.deadlineAtEpochMs > now && item.mediaTimeMs >= grant.fromMs && item.mediaTimeMs < grant.toMs);
      if (!current.length) fail('no-current-demand');
      return current.map((owner: NativeDemand) => ({ ...owner, proofMediaTimeMs: proof.clock.mediaTimeMs,
        proofAtEpochMs: now }));
    });
    if (run.proofs.length < 10000) run.proofs.push({ atEpochMs: now,
      mediaTimeMs: proof.clock.mediaTimeMs, demands: proof.demands.length });
    return owners;
  }
  private nativeOwners(run: ActiveRun, selected: readonly ProviderItem[]): NativeDemand[] {
    return selected.map(item => {
      for (const request of run.requests.values()) {
        if (request.controller.signal.aborted) continue;
        for (const owner of request.nativeItems?.values() ?? []) {
          if (owner.originalText === item.text && owner.epoch === run.grant.epoch && owner.deadlineAtEpochMs > Date.now())
            return owner;
        }
      }
      fail('no-current-demand');
    });
  }
  private makeRun(grant: Grant, settings: Settings, cache = new MemoryTranslationCache({ maxEntries: 4000, maxBytes: 2 * 1024 * 1024 })): ActiveRun {
    const run = { grant, settings, requests: new Map(), requestIds: new Set(), results: new Map(),
      candidates: new Map(), inputs: [], deliveries: [], errors: [], proofs: [], cache } as unknown as ActiveRun;
    run.engine = new TranslationEngine({ cache,
      ...(this.native ? { validateResult: strictNativeResultIssue, maxAttempts: 1,
        cacheOnly: () => grant.cacheOnly === true } : {}),
      keepAlive: this.options.keepAlive, provider: { complete: request => this.complete(run, request) } });
    return run;
  }
  private async preflightModel(modelId: string): Promise<{ state: LocalState; identity: string; modelName: string; model: LocalModelInfo }> {
    const [inventory, current] = await Promise.all([
      this.options.localControl({ action: 'list' }), this.options.localControl({ action: 'state' }),
    ]);
    if (!inventory.ok || !Array.isArray(inventory.models) || !current.ok || !current.state) fail('model-preflight-failed');
    const selected = inventory.models.find(model => model.id === modelId);
    if (!selected) fail('selected-model-missing');
    const identity = await modelIdentity(selected);
    return { state: current.state, identity, modelName: selected.name.trim().slice(0, 200) || selected.id, model: selected };
  }
  private async loadModel(grant: Grant, context: LivePreviewHostContext, expectedIdentity: string): Promise<LocalState> {
    const config = { ...context.settings.localPerformance,
      ...(this.native && !this.owned ? { mode: 'custom' as const, parallel: 2, normalMaxTokens: 128,
        promptMode: 'auto' as const } : {}), warmup: false };
    for (let attempt = 0; attempt < (this.owned ? 1 : 2); attempt++) {
      grant.modelLoads = attempt + 1;
      grant.loadOwnership = 'loading';
      if (attempt > 0) grant.loadRecoveryCount = 1;
      await this.save(grant);
      let reply: LocalReply | undefined, thrown: unknown;
      try { reply = await this.options.localControl({ action: 'load', modelId: grant.modelId, config }); }
      catch (error) { thrown = error; }
      const state = reply?.state;
      if (reply?.ok && state?.phase === 'ready' && state.model?.id === grant.modelId && state.runtime &&
          state.generation > grant.modelBaseline.generation && await modelIdentity(state.model) === expectedIdentity) {
        grant.modelGeneration = state.generation;
        grant.modelAfterLoad = await modelSnapshot(state, expectedIdentity);
        grant.modelIdentity = expectedIdentity;
        grant.loadedByTask = true;
        grant.loadOwnership = 'owned';
        grant.loadFailure = undefined;
        await this.save(grant);
        if (state.inferenceCalls !== 0 || (state.warmupMs ?? 0) > 0) fail('unexpected-warmup');
        return state;
      }
      const code = reply?.error && /^LOCAL_[A-Z0-9_]+$/.test(reply.error) ? reply.error : errorCode(thrown);
      grant.loadFailure = code;
      let observed = state;
      if (!observed || ['loading', 'warming'].includes(observed.phase)) {
        try { observed = (await this.options.localControl({ action: 'state' })).state; } catch { /* Retain uncertainty. */ }
      }
      const canRetry = attempt === 0 && RECOVERABLE_MODEL_ERRORS.has(code) && observed &&
        ['idle', 'error'].includes(observed.phase) && observed.active === 0 && observed.queued === 0;
      if (!canRetry) {
        grant.loadOwnership = 'uncertain';
        await this.save(grant);
        fail(code === 'LOCAL_LOAD_FAILED' ? 'model-load-failed' : 'model-load-failed');
      }
      grant.loadOwnership = 'uncertain';
      grant.loadRecoveryCount = 1;
      await this.save(grant);
      const retry = await this.preflightModel(grant.modelId);
      if (retry.identity !== expectedIdentity || !['idle', 'error'].includes(retry.state.phase) ||
          retry.state.active !== 0 || retry.state.queued !== 0) fail('model-retry-preflight-failed');
    }
    fail('model-load-failed');
  }
  private async reloadOwnedNativeModel(grant: Grant, context: LivePreviewHostContext,
    expectedIdentity: string, previous: LocalState): Promise<LocalState> {
    // The previous auto-mode load was owned by this same zero-call preparation.
    // Spend its only recovery before touching the model, so an interrupted load
    // cannot silently claim a third attempt on the next prepare call.
    grant.modelLoads = 2; grant.loadRecoveryCount = 1; grant.loadOwnership = 'loading';
    await this.savePreparing(grant);
    if (previous.phase === 'ready') {
      const unloaded = await this.options.localControl({ action: 'unload' });
      const idle = unloaded.state ?? (await this.options.localControl({ action: 'state' })).state;
      if (!unloaded.ok || idle?.phase !== 'idle' || idle.active !== 0 || idle.queued !== 0 ||
          idle.inferenceCalls !== 0) {
        grant.loadOwnership = 'uncertain'; await this.savePreparing(grant); fail('native-recovery-unload-uncertain');
      }
    }
    await this.assertPreparing(grant);
    const config = { ...context.settings.localPerformance, mode: 'custom' as const, parallel: 2,
      normalMaxTokens: 128, promptMode: 'auto' as const, warmup: false };
    let reply: LocalReply | undefined;
    try { reply = await this.options.localControl({ action: 'load', modelId: grant.modelId, config }); }
    catch { /* A loading/error state is uncertain, so no second recovery is permitted. */ }
    const state = reply?.state;
    if (!reply?.ok || state?.phase !== 'ready' || state.model?.id !== grant.modelId || !state.runtime ||
        state.generation <= previous.generation || state.inferenceCalls !== 0 || state.active !== 0 ||
        state.queued !== 0 || (state.warmupMs ?? 0) > 0 ||
        await modelIdentity(state.model) !== expectedIdentity ||
        state.runtime.parallel !== 2 || state.runtime.normalMaxTokens !== 128) {
      grant.loadOwnership = 'uncertain'; await this.savePreparing(grant); fail('native-recovery-load-uncertain');
    }
    await this.assertPreparing(grant);
    grant.modelGeneration = state.generation;
    grant.modelAfterLoad = await modelSnapshot(state, expectedIdentity);
    grant.loadOwnership = 'owned'; grant.loadFailure = undefined;
    await this.savePreparing(grant);
    return state;
  }
  private async loadAuthorizedNativeRepairModel(grant: Grant, context: LivePreviewHostContext,
    expectedIdentity: string, previous: LocalState): Promise<LocalState> {
    // Record the third load before touching the model. An interrupted call is never retried.
    grant.modelLoads = 3; grant.loadOwnership = 'loading';
    await this.savePreparing(grant);
    const config = { ...context.settings.localPerformance, mode: 'custom' as const, parallel: 2,
      normalMaxTokens: 128, promptMode: 'auto' as const, warmup: false };
    let reply: LocalReply | undefined;
    try { reply = await this.options.localControl({ action: 'load', modelId: grant.modelId, config }); }
    catch { /* An unknown load outcome must retain the spent authorization. */ }
    const state = reply?.state;
    if (!reply?.ok || state?.phase !== 'ready' || state.model?.id !== grant.modelId || !state.runtime ||
        state.generation <= previous.generation || state.inferenceCalls !== 0 || state.active !== 0 ||
        state.queued !== 0 || (state.warmupMs ?? 0) > 0 ||
        await modelIdentity(state.model) !== expectedIdentity ||
        state.runtime.parallel !== 2 || state.runtime.normalMaxTokens !== 128) {
      grant.loadOwnership = 'uncertain'; await this.savePreparing(grant); fail('native-repair-load-uncertain');
    }
    await this.assertPreparing(grant);
    grant.modelGeneration = state.generation;
    grant.modelAfterLoad = await modelSnapshot(state, expectedIdentity);
    grant.loadOwnership = 'owned'; grant.loadFailure = undefined;
    await this.savePreparing(grant);
    return state;
  }
  async prepare(input: LivePreviewPrepareInput) {
    if (this.preparing) fail('preparing');
    this.preparing = true;
    try {
      if (!validId(input.taskId) || !validId(input.runId) || !Number.isSafeInteger(input.tabId) ||
          !Number.isSafeInteger(input.epoch) || !['main', 'repair', 'supplement'].includes(input.phase)) fail('invalid-prepare');
      if (input.authorizedExtraLoad !== undefined &&
          (input.authorizedExtraLoad !== true || !this.native || this.owned || input.phase !== 'repair'))
        fail('unauthorized-extra-load');
      if (input.authorizedNewBudget !== undefined &&
          (input.authorizedNewBudget !== true || !this.owned || input.phase !== 'main')) fail('unauthorized-new-budget');
      const fromMs = this.native ? input.fromMs ?? 0 : input.phase === 'repair' ? input.fromMs ?? 45000 : 45000;
      const toMs = this.native ? input.toMs ?? 45000 : input.phase === 'repair' ? input.toMs ?? 65000 : 85000;
      if (input.phase !== 'main' && (typeof input.repairReason !== 'string' || !input.repairReason.trim() ||
          input.repairReason.length > 4096)) fail(input.phase === 'repair' ? 'invalid-repair' : 'invalid-supplement');
      if (this.owned && (input.phase !== 'main' || input.fromMs === undefined || input.toMs === undefined ||
          !Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || fromMs < 0 ||
          toMs > 43_200_000 || toMs <= fromMs)) fail('invalid-owned-window');
      if (this.native && !this.owned && (input.phase === 'supplement' || !Number.isInteger(fromMs) || !Number.isInteger(toMs)
          || fromMs < 0 || toMs > 45000 || toMs <= fromMs ||
          (input.phase === 'repair' && toMs - fromMs > 15000) ||
          (input.phase === 'main' && (fromMs !== 0 || toMs !== 45000)))) fail('invalid-native-window');
      if (!this.native && input.phase === 'repair' && (!Number.isInteger(fromMs) ||
          !Number.isInteger(toMs) || fromMs < 45000 || toMs > 85000 || toMs <= fromMs || toMs - fromMs > 20000))
        fail('invalid-repair');
      if (!this.native && input.phase === 'supplement' && (input.fromMs !== undefined && input.fromMs !== 45000 ||
          input.toMs !== undefined && input.toMs !== 85000)) fail('invalid-supplement');
      if (this.run && this.run.grant.runId === input.runId && this.run.grant.state === 'prepared') {
        const grant = this.run.grant;
        if (grant.taskId === input.taskId && grant.tabId === input.tabId && grant.epoch === input.epoch &&
            grant.phase === input.phase && grant.fromMs === fromMs && grant.toMs === toMs &&
            (input.modelId === undefined || grant.modelId === input.modelId) &&
            grant.repairReason === input.repairReason) return this.status();
        fail('identity-mismatch');
      }
      if (this.active) fail('other-live-run');
      const stored = await this.options.storage.get([TEMPORARY_KEY, NATIVE_SUPPLY_GUARD_KEY, OWNED_SUPPLY_GUARD_KEY,
        PERSISTENT_KEY, this.grantKey, this.budgetKey, ...(this.owned ? [OWNED_SUPPLY_HISTORY_KEY] : [])]);
      const old = stored[this.grantKey] as Grant | undefined;
      const newOwnedBudget = this.owned && input.authorizedNewBudget === true && old?.state === 'stopped' &&
        old.reason === 'cleanup' && !!stored[this.budgetKey] && !stored[OWNED_SUPPLY_GUARD_KEY] &&
        old.taskId !== input.taskId && old.runId !== input.runId && input.phase === 'main';
      const reopenOwned = this.owned && old?.state === 'stopped' && old.reason === 'cleanup' &&
        old.taskId === input.taskId && old.runId === input.runId && input.phase === 'main' &&
        !stored[OWNED_SUPPLY_GUARD_KEY] && (!!stored[this.budgetKey] || old.configIdentity === '') &&
        !input.authorizedNewBudget;
      if (this.owned && (old && !reopenOwned && !newOwnedBudget || !old &&
          (stored[this.budgetKey] || input.authorizedNewBudget))) fail('owned-resume-or-budget-required');
      const unusedRetiredPreparation = old?.state === 'stopped' && old.reason === 'owner-tab-retired' &&
        old.configIdentity === '' && !stored[this.budgetKey];
      const recoveringNativeLoad = this.native && !this.owned && input.phase === 'main' &&
        (old?.state === 'preparing' || unusedRetiredPreparation) &&
        old.taskId === input.taskId && old.runId === input.runId;
      if (old && old.state !== 'stopped' && !recoveringNativeLoad) fail('recovery-required');
      const repairOwner = this.native && !this.owned && input.phase === 'repair' && old?.state === 'stopped' &&
        this.run?.grant.instanceId === old.instanceId && this.run.grant.state === 'stopped' &&
        old.taskId === input.taskId && old.tabId === input.tabId && old.epoch !== input.epoch &&
        this.ownedTemporaryGuard(stored[NATIVE_SUPPLY_GUARD_KEY], old);
      const authorizedRepairOwner = !this.owned && input.authorizedExtraLoad === true && old?.state === 'stopped' &&
        (old.reason === 'cleanup' || old.reason === 'owner-tab-retired') &&
        old.phase === 'main' && old.taskId === input.taskId &&
        old.runId !== input.runId && old.tabId !== input.tabId && old.buildId !== this.options.buildId &&
        old.modelLoads === 2 && old.loadRecoveryCount === 1 && old.modelBaseline?.phase === 'idle' &&
        old.loadedByTask === true && old.loadOwnership === 'owned' &&
        old.modelIdentityKind === 'metadata-only-sha256' && old.modelAfterLoad?.phase === 'ready' &&
        old.modelAfterLoad.modelId === old.modelId && old.modelAfterLoad.modelIdentity === old.modelIdentity &&
        old.modelAfterLoad.generation === old.modelGeneration && old.modelAfterLoad.inferenceCalls === 0 &&
        old.modelAfterLoad.active === 0 && old.modelAfterLoad.queued === 0 &&
        (old.modelAfterLoad.warmupMs ?? 0) === 0 && old.modelAfterLoad.runtime?.mode === 'custom' &&
        old.modelAfterLoad.runtime.parallel === 2 &&
        old.modelAfterLoad.runtime.normalMaxTokens === 128 &&
        !stored[NATIVE_SUPPLY_GUARD_KEY] && !stored[TEMPORARY_KEY] && !stored[OWNED_SUPPLY_GUARD_KEY] && !stored[PERSISTENT_KEY];
      if (this.native && !this.owned && input.phase === 'repair' &&
          (input.authorizedExtraLoad === true ? !authorizedRepairOwner : !repairOwner || old!.phase !== 'main'))
        fail('repair-unavailable');
      if (this.native && !this.owned && input.phase === 'main' && old && !recoveringNativeLoad) fail('main-already-used');
      if (stored[PERSISTENT_KEY] || stored[TEMPORARY_KEY] ||
          stored[OWNED_SUPPLY_GUARD_KEY] ||
          stored[NATIVE_SUPPLY_GUARD_KEY] && !repairOwner && !recoveringNativeLoad) fail('existing-guard');
      const context = await this.options.context(input.tabId);
      const selectedId = this.owned ? context?.settings.localModelId : this.native ?
        input.modelId ?? context?.settings.localModelId : context?.settings.localModelId;
      if (!context || !context.idle || context.settings.enabled || this.owned &&
          (context.settings.bilibiliOwnedRelease !== true || context.settings.backend !== 'local' ||
            input.modelId !== undefined && input.modelId !== selectedId) || !this.native && context.settings.backend !== 'local' ||
          !selectedId || !validId(selectedId) || this.owned &&
          (context.session.platform !== 'bilibili' || context.session.scenario !== 'video') ||
          !this.owned && context.session.resourceId !== LIVE_PREVIEW_RESOURCE) fail('requires-selected-idle-local-model');
      const preflight = await this.preflightModel(selectedId);
      if (reopenOwned && (old!.modelId !== selectedId || old!.modelIdentity !== preflight.identity ||
          old!.savedSettingsIdentity !== await digest(context.settings) ||
          stored[this.budgetKey] && (stored[this.budgetKey].taskId !== input.taskId ||
            stored[this.budgetKey].phaseRuns?.main !== input.runId ||
            stored[this.budgetKey].modelIdentity !== preflight.identity ||
            stored[this.budgetKey].configIdentity !== old!.configIdentity))) fail('owned-budget-identity-changed');
      if (newOwnedBudget) {
        const budget = stored[this.budgetKey], history = stored[OWNED_SUPPLY_HISTORY_KEY] ?? [];
        if (!Array.isArray(history) || history.some(entry => !entry || typeof entry !== 'object' ||
            entry.grant?.taskId === input.taskId || entry.grant?.runId === input.runId) ||
            budget.taskId !== old!.taskId || budget.phaseRuns?.main !== old!.runId ||
            budget.modelIdentity !== old!.modelIdentity || budget.configIdentity !== old!.configIdentity)
          fail('owned-budget-history-invalid');
        if (this.run?.requests.size || this.run?.engine.stats().activeRequests ||
            this.run?.engine.stats().pendingItems ||
            !['idle', 'ready'].includes(preflight.state.phase) || preflight.state.active || preflight.state.queued ||
            preflight.state.phase === 'ready' && (preflight.state.model?.id !== selectedId ||
              !preflight.state.runtime || await modelIdentity(preflight.state.model) !== preflight.identity))
          fail('owned-budget-not-idle');
        this.budget = this.makeBudget(); this.budgetIdentity = undefined;
        await this.openBudget(old!);
        if (!await this.budget.readSnapshot()) fail('owned-budget-history-invalid');
        const archivedBudget = (await this.options.storage.get(this.budgetKey))[this.budgetKey];
        await this.options.storage.set({ [OWNED_SUPPLY_HISTORY_KEY]: [...history,
          { archivedAt: Date.now(), grant: structuredClone(old), budget: structuredClone(archivedBudget) }],
        [this.grantKey]: null, [this.budgetKey]: null });
        this.run = undefined;
      }
      if (repairOwner && (selectedId !== old!.modelId || preflight.identity !== old!.modelIdentity ||
          context.documentId !== old!.documentId || !sameResource(context.session, old!.session) ||
          await digest(context.settings) !== old!.savedSettingsIdentity ||
          preflight.state.phase !== 'ready' || preflight.state.generation !== old!.modelGeneration))
        fail('repair-identity-changed');
      if (authorizedRepairOwner) {
        if (selectedId !== old!.modelId || preflight.identity !== old!.modelIdentity ||
            context.documentId === old!.documentId ||
            !sameResource(context.session, old!.session) ||
            await digest(context.settings) !== old!.savedSettingsIdentity ||
            preflight.state.phase !== 'idle' || preflight.state.model ||
            preflight.state.active !== 0 || preflight.state.queued !== 0 ||
            preflight.state.inferenceCalls !== 0 || !old!.configIdentity)
          fail('repair-identity-changed');
        const budget = stored[this.budgetKey];
        if (!budget || budget.taskId !== old!.taskId || budget.modelIdentity !== old!.modelIdentity ||
            budget.configIdentity !== old!.configIdentity || budget.phaseRuns?.main !== old!.runId ||
            budget.phaseRuns?.repair !== null || budget.phaseRuns?.supplement)
          fail('repair-budget-changed');
        await this.openBudget(old!);
        const snapshot = await this.budget.readSnapshot();
        if (!snapshot || snapshot.phases.main.runId !== old!.runId || snapshot.phases.repair.runId !== null ||
            snapshot.attempts.length !== 0) fail('repair-budget-changed');
        const storedRuntime = old!.modelAfterLoad!.runtime!;
        const resolvedRuntime = { ...resolveLocalConfig({ ...context.settings.localPerformance,
          mode: 'custom', parallel: 2, normalMaxTokens: 128, promptMode: 'auto', warmup: false }, selectedId),
        ...(storedRuntime.cpuThreadsActual === undefined ? {} : { cpuThreadsActual: storedRuntime.cpuThreadsActual }) };
        if (!sameValues(storedRuntime, resolvedRuntime)) fail('repair-config-changed');
        const expected = previewSettings(context, { ...preflight.state, phase: 'ready',
          model: preflight.model, runtime: resolvedRuntime }, true, selectedId);
        if (await digest(expected) !== old!.configIdentity) fail('repair-config-changed');
      }
      if (recoveringNativeLoad) {
        const budget = stored[this.budgetKey];
        if (old!.phase !== 'main' || old!.tabId !== input.tabId || old!.modelId !== selectedId ||
            input.modelId !== old!.modelId || old!.fromMs !== fromMs || old!.toMs !== toMs ||
            old!.modelIdentity !== preflight.identity || old!.modelIdentityKind !== 'metadata-only-sha256' ||
            !sameResource(context.session, old!.session) ||
            await digest(context.settings) !== old!.savedSettingsIdentity ||
            old!.loadOwnership !== 'owned' || !old!.loadedByTask || old!.modelLoads !== 1 ||
            old!.loadRecoveryCount !== 0 || old!.modelBaseline?.phase !== 'idle' ||
            old!.modelAfterLoad?.phase !== 'ready' || old!.modelAfterLoad.modelId !== selectedId ||
            old!.modelAfterLoad.modelIdentity !== preflight.identity ||
            old!.modelAfterLoad.generation !== old!.modelGeneration ||
            old!.modelAfterLoad.inferenceCalls !== 0 ||
            old!.modelAfterLoad.runtime?.mode !== 'auto' ||
            old!.modelAfterLoad.runtime.parallel === 2 ||
            old!.modelAfterLoad.runtime.normalMaxTokens !== 128 ||
            !this.ownedTemporaryGuard(stored[NATIVE_SUPPLY_GUARD_KEY], old!) ||
            budget && (budget.taskId !== old!.taskId || budget.modelIdentity !== old!.modelIdentity ||
              !Array.isArray(budget.attempts) || budget.attempts.length !== 0 ||
              budget.phaseRuns?.main !== null && budget.phaseRuns?.main !== old!.runId ||
              budget.phaseRuns?.repair !== null || budget.phaseRuns?.supplement))
          fail('native-preparation-recovery-unavailable');
        await this.guardOwned(old!);
      }
      if (this.native && !this.owned && (preflight.model.architecture !== 'hunyuan-dense' ||
          !/hy[-_ ]?mt2[-_ ]?7b(?!\d)/i.test(preflight.modelName) ||
          !preflight.model.files.some(file => /hy[-_ ]?mt2[-_ ]?7b(?!\d).*\.gguf$/i.test(file))))
        fail('native-requires-hy-mt2-7b');
      const first = preflight.state;
      if (!['idle', 'ready'].includes(first.phase) || first.active || first.queued)
        fail('model-not-idle');
      if (first.phase === 'ready' && (first.model?.id !== selectedId || !first.runtime ||
          await modelIdentity(first.model) !== preflight.identity)) fail('different-model-loaded');
      if (this.native && !this.owned && !recoveringNativeLoad && first.phase === 'ready' &&
          (first.runtime?.parallel !== 2 || first.runtime?.normalMaxTokens !== 128))
        fail('native-model-runtime-mismatch');
      if (recoveringNativeLoad && (first.inferenceCalls !== 0 ||
          first.phase === 'ready' && (first.model?.id !== old!.modelId ||
            first.generation !== old!.modelGeneration ||
            !same(first.runtime, old!.modelAfterLoad!.runtime))))
        fail('native-preparation-model-changed');
      const { authorizedExtraLoad: _authorizedExtraLoad, authorizedNewBudget: _authorizedNewBudget,
        ...grantInput } = input;
      const grant: Grant = recoveringNativeLoad ? {
        ...old!, documentId: context.documentId, session: structuredClone(context.session),
        epoch: input.epoch, buildId: this.options.buildId, instanceId: crypto.randomUUID(),
        configVersion: context.configVersion, modelName: preflight.modelName,
        resumeCount: old!.resumeCount + 1, state: 'preparing', reason: '',
      } : { ...grantInput, fromMs, toMs, documentId: context.documentId, session: structuredClone(context.session),
        buildId: this.options.buildId, instanceId: crypto.randomUUID(), modelId: selectedId,
        modelName: preflight.modelName,
        modelGeneration: first.generation, modelIdentity: preflight.identity, configIdentity: '',
        savedSettingsIdentity: await digest(context.settings), configVersion: context.configVersion,
        state: 'preparing', modelBaseline: repairOwner || authorizedRepairOwner ? old!.modelBaseline : await modelSnapshot(first,
          first.phase === 'ready' ? preflight.identity : undefined),
        loadedByTask: repairOwner || authorizedRepairOwner ? old!.loadedByTask : false,
        modelLoads: repairOwner || authorizedRepairOwner ? old!.modelLoads : 0,
        loadRecoveryCount: repairOwner || authorizedRepairOwner ? old!.loadRecoveryCount : 0,
        loadOwnership: repairOwner || authorizedRepairOwner ? old!.loadOwnership : first.phase === 'ready' ? 'preexisting' : 'not-loaded',
        modelIdentityKind: 'metadata-only-sha256', resumeCount: 0, reason: '',
        ...(this.owned ? { policy: 'owned' as const, sourceLanguage: context.settings.sourceLanguage,
          targetLanguage: context.settings.targetLanguage } : {}),
        ...(authorizedRepairOwner ? { previousRunId: old!.runId } : {}) };
      await this.save(grant);
      if (!recoveringNativeLoad) await this.options.storage.set({
        [this.guardKey]: { enabled: true, kind: this.ownerKind, tabId: input.tabId, runId: input.runId } });
      await this.guardOwned(grant);
      this.ownerTab = input.tabId;
      let state = first;
      if (recoveringNativeLoad) state = await this.reloadOwnedNativeModel(grant, context, preflight.identity, first);
      else if (authorizedRepairOwner) state = await this.loadAuthorizedNativeRepairModel(grant, context, preflight.identity, first);
      else if (state.phase === 'idle') state = await this.loadModel(grant, context, preflight.identity);
      if (state.model?.id !== grant.modelId || !state.runtime || await modelIdentity(state.model) !== preflight.identity)
        fail('model-not-ready');
      if (this.native && !this.owned && (state.runtime.parallel !== 2 || state.runtime.normalMaxTokens !== 128))
        fail('native-model-runtime-mismatch');
      const settings = previewSettings(context, state, this.native, grant.modelId, this.owned);
      await this.assertPreparing(grant);
      grant.modelGeneration = state.generation;
      if (!grant.modelAfterLoad) grant.modelAfterLoad = await modelSnapshot(state, preflight.identity);
      grant.modelIdentity = preflight.identity;
      grant.configIdentity = await digest(settings);
      if ((repairOwner || authorizedRepairOwner || reopenOwned && old!.configIdentity) &&
          grant.configIdentity !== old!.configIdentity)
        fail(this.owned ? 'owned-budget-identity-changed' : 'repair-config-changed');
      if (recoveringNativeLoad && stored[this.budgetKey] &&
          stored[this.budgetKey].configIdentity !== grant.configIdentity) fail('recovery-budget-identity-changed');
      await this.openBudget(grant);
      await this.budget.beginPhase(grant.phase, grant.runId, grant.repairReason);
      await this.assertPreparing(grant);
      grant.state = 'prepared'; await this.save(grant);
      const retainedCache = this.native && this.run?.grant.taskId === grant.taskId &&
        this.run.grant.modelIdentity === grant.modelIdentity &&
        this.run.grant.configIdentity === grant.configIdentity ? this.run.cache : undefined;
      const run = this.makeRun(grant, settings, retainedCache);
      this.run = run;
      return this.status();
    } finally { this.preparing = false; }
  }
  async resume(input: LivePreviewResumeInput) {
    if (this.preparing) fail('preparing');
    this.preparing = true;
    try {
      if (!validId(input.taskId) || !validId(input.runId) || !validId(input.instanceId) ||
          !Number.isSafeInteger(input.tabId) || !Number.isSafeInteger(input.epoch) ||
          typeof input.documentId !== 'string' || !input.documentId || input.documentId.length > 200 ||
          typeof input.buildId !== 'string' || input.buildId !== this.options.buildId) fail('invalid-resume');
      if (this.active || this.run && (!this.owned || this.run.grant.state !== 'stopped' ||
          this.run.requests.size !== 0)) fail('other-live-run');
      const stored = await this.options.storage.get([this.grantKey, this.budgetKey, this.guardKey, PERSISTENT_KEY]);
      const grant = stored[this.grantKey] as Grant | undefined;
      if (this.owned && (!stored[this.budgetKey] || stored[this.budgetKey].taskId !== input.taskId ||
          stored[this.budgetKey].phaseRuns?.main !== input.runId ||
          stored[this.budgetKey].modelIdentity !== grant?.modelIdentity ||
          stored[this.budgetKey].configIdentity !== grant?.configIdentity)) fail('owned-budget-identity-changed');
      const resumeStoppedOwned = this.owned && grant?.state === 'stopped' &&
        grant.reason !== 'cleanup' && grant.reason !== 'owner-tab-retired';
      if (!grant || !['prepared', 'running'].includes(grant.state) && !resumeStoppedOwned || grant.taskId !== input.taskId ||
          grant.tabId !== input.tabId || grant.documentId !== input.documentId || grant.runId !== input.runId ||
          grant.instanceId !== input.instanceId || !resumeStoppedOwned && grant.epoch !== input.epoch ||
          grant.buildId !== input.buildId ||
          grant.modelIdentityKind !== 'metadata-only-sha256' || !grant.modelAfterLoad ||
          !['preexisting', 'owned'].includes(grant.loadOwnership) || grant.modelAfterLoad.generation !== grant.modelGeneration)
        fail('recovery-identity-mismatch');
      if (this.owned && (grant.policy !== 'owned' || !Number.isSafeInteger(input.fromMs ?? grant.fromMs) ||
          !Number.isSafeInteger(input.toMs ?? grant.toMs) || (input.fromMs ?? grant.fromMs) < 0 ||
          (input.toMs ?? grant.toMs) > 43_200_000 ||
          (input.toMs ?? grant.toMs) <= (input.fromMs ?? grant.fromMs))) fail('invalid-owned-window');
      const context = await this.options.context(grant.tabId);
      if (!context || !context.idle || context.settings.enabled || this.owned &&
          (context.settings.bilibiliOwnedRelease !== true || context.settings.backend !== 'local' ||
            context.settings.localModelId !== grant.modelId) || !this.native && (context.settings.backend !== 'local' ||
          context.settings.localModelId !== grant.modelId) || context.documentId !== grant.documentId ||
          (resumeStoppedOwned ? !sameResource(context.session, grant.session) : !same(context.session, grant.session)) ||
          await digest(context.settings) !== grant.savedSettingsIdentity) fail('recovery-context-changed');
      await this.guardOwned(grant);
      const preflight = await this.preflightModel(grant.modelId);
      const local = preflight.state;
      if (preflight.identity !== grant.modelIdentity || local.phase !== 'ready' || local.active !== 0 || local.queued !== 0 ||
          local.model?.id !== grant.modelId || local.generation !== grant.modelGeneration || !local.runtime ||
          await modelIdentity(local.model) !== grant.modelIdentity || !same(local.runtime, grant.modelAfterLoad.runtime))
        fail('recovery-model-changed');
      const settings = previewSettings(context, local, this.native, grant.modelId, this.owned);
      if (await digest(settings) !== grant.configIdentity) fail('recovery-config-changed');
      if (this.owned && (grant.sourceLanguage !== context.settings.sourceLanguage ||
          grant.targetLanguage !== context.settings.targetLanguage)) fail('recovery-config-changed');

      // Rotate the persisted capability before restoring any in-memory request path.
      const latest = (await this.options.storage.get(this.grantKey))[this.grantKey];
      if (latest?.instanceId !== input.instanceId || latest.state !== grant.state) fail('permit-revoked');
      await this.guardOwned(grant);
      grant.instanceId = crypto.randomUUID(); grant.modelName = preflight.modelName;
      grant.state = 'preparing'; grant.resumeCount += 1;
      grant.configVersion = context.configVersion;
      if (resumeStoppedOwned) {
        grant.session = structuredClone(context.session); grant.epoch = input.epoch;
        grant.fromMs = input.fromMs ?? grant.fromMs; grant.toMs = input.toMs ?? grant.toMs;
      }
      grant.reason = ''; await this.save(grant); this.ownerTab = grant.tabId;
      await this.openBudget(grant);
      await this.budget.beginPhase(grant.phase, grant.runId, grant.repairReason);
      grant.state = 'prepared'; await this.save(grant);
      const retainedCache = this.owned && this.run?.grant.taskId === grant.taskId &&
        this.run.grant.modelIdentity === grant.modelIdentity && this.run.grant.configIdentity === grant.configIdentity
        ? this.run.cache : undefined;
      this.run = this.makeRun(grant, settings, retainedCache);
      return this.status();
    } finally { this.preparing = false; }
  }
  async start(tabId: number, documentId: string, runId: string, instanceId: string) {
    const run = this.match(tabId, documentId, runId, instanceId);
    await this.assertRun(run, true);
    run.grant.startedAt ??= Date.now();
    run.grant.state = 'running'; await this.save(run.grant);
    return this.status();
  }
  async replay(tabId: number, documentId: string, input: { runId: string; instanceId: string; epoch: number }) {
    if (!this.native || this.owned) fail('replay-unavailable');
    const run = this.match(tabId, documentId, input.runId, input.instanceId);
    if (run.grant.state !== 'stopped' || run.requests.size !== 0 || !Number.isSafeInteger(input.epoch) ||
        input.epoch === run.grant.epoch || run.engine.stats().activeRequests !== 0 ||
        run.engine.stats().pendingItems !== 0) fail('replay-not-idle');
    await this.guardOwned(run.grant);
    const context = await this.options.context(tabId);
    if (!context || !context.idle || context.settings.enabled || context.documentId !== documentId ||
        !sameResource(context.session, run.grant.session) || context.configVersion !== run.grant.configVersion ||
        await digest(context.settings) !== run.grant.savedSettingsIdentity) fail('replay-context-changed');
    const local = await this.options.localControl({ action: 'state', demand: true });
    if (!local.ok || !local.state || local.state.phase !== 'ready' || local.state.active || local.state.queued ||
        local.state.model?.id !== run.grant.modelId || local.state.generation !== run.grant.modelGeneration ||
        await modelIdentity(local.state.model) !== run.grant.modelIdentity ||
        !same(local.state.runtime, run.grant.modelAfterLoad?.runtime)) fail('replay-model-changed');
    const persisted = (await this.options.storage.get(this.grantKey))[this.grantKey];
    if (persisted?.instanceId !== input.instanceId || persisted.state !== 'stopped') fail('permit-revoked');
    const grant = { ...run.grant, instanceId: crypto.randomUUID(), epoch: input.epoch,
      session: structuredClone(context.session),
      cacheOnly: true, state: 'prepared' as const, reason: '' };
    await this.save(grant);
    this.run = this.makeRun(grant, run.settings, run.cache);
    return this.status();
  }
  private match(tabId: number, documentId: string, runId: string, instanceId: string): ActiveRun {
    const run = this.run;
    if (!run || run.grant.tabId !== tabId || run.grant.documentId !== documentId ||
        run.grant.runId !== runId || run.grant.instanceId !== instanceId) fail('identity-mismatch');
    return run;
  }
  async stopForTab(tabId: number, reason = 'owner-tab-retired') {
    if (!Number.isSafeInteger(tabId)) return this.status();
    if (this.run?.grant.tabId === tabId) {
      if (this.run.grant.state === 'stopped') return this.status();
      return this.stop(reason);
    }
    const grant = (await this.options.storage.get(this.grantKey))[this.grantKey] as Grant | undefined;
    if (!grant || grant.tabId !== tabId || grant.state === 'stopped') return this.status();
    this.ownerTab = tabId;
    grant.state = 'stopped'; grant.reason = reason; await this.save(grant);
    return this.status();
  }
  async translate(tabId: number, documentId: string, message: any) {
    if (this.native) return this.translateNative(tabId, documentId, message);
    const run = this.match(tabId, documentId, message.runId, message.instanceId);
    await this.assertRun(run);
    if (typeof message.requestId !== 'string' || !/^[a-zA-Z0-9_:-]{1,100}$/.test(message.requestId) ||
        run.requestIds.has(message.requestId) || run.requestIds.size >= 500 || !Array.isArray(message.items) ||
        !message.items.length || message.items.length > 100 || run.requests.size >= 2 || message.epoch !== run.grant.epoch)
      fail('invalid-request');
    const seen = new Set<string>();
    for (const item of message.items) {
      if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 500 || seen.has(item.id) ||
          typeof item.text !== 'string' || !item.text || item.text.length > 10000 ||
          !Number.isFinite(item.remainingMs) || item.remainingMs <= 0) fail('invalid-item');
      seen.add(item.id);
    }
    await this.proof(run, message.items.map((item: any) => item.text));
    await this.assertRun(run);
    const controller = new AbortController(), itemMap = new Map<string, string>(message.items.map((item: any) => [item.id, item.text]));
    run.requests.set(message.requestId, { controller, items: itemMap }); run.requestIds.add(message.requestId);
    const outputs = new Map<string, any>();
    const deliver = (output: TranslationOutput) => {
      const text = itemMap.get(output.id);
      const unchanged = !!text && ['translated', 'cached'].includes(output.status) && output.text === text;
      let result = text ? run.results.get(text) : undefined;
      if (text && output.status === 'translated' && output.text) {
        const candidate = run.candidates.get(text);
        if (candidate?.text === output.text) {
          candidate.validated = !unchanged;
          if (unchanged) candidate.reason = 'unchanged-output';
          candidate.configIdentity = run.grant.configIdentity;
          result = candidate; run.results.set(text, candidate);
        }
      }
      const previewOutput: TranslationOutput = unchanged
        ? { id: output.id, text, status: 'original', reason: 'unchanged-output' } : output;
      const decorated = { ...previewOutput, ...(result?.validated === true &&
        ['translated', 'cached'].includes(output.status) ? { preview: {
        runId: run.grant.runId, instanceId: run.grant.instanceId, configIdentity: run.grant.configIdentity,
        requestId: message.requestId, taskId: result.taskId, resultId: result.resultId, originalText: text,
        kind: output.status === 'cached' ? 'session-cache' : result.deliveries > 0 ? 'session-shared' : 'new-inference' } } : {}) };
      if (result && decorated.preview) result.deliveries++;
      outputs.set(output.id, decorated);
      run.deliveries.push({ requestId: message.requestId, at: performance.now(), output: decorated });
      if (this.run !== run || controller.signal.aborted || run.grant.state !== 'running') return;
      void this.options.page(tabId, documentId, { type: 'bilibili-live-preview-result', ...decorated.preview,
        runId: run.grant.runId, instanceId: run.grant.instanceId, requestId: message.requestId, output: decorated }).catch(() => {});
    };
    try {
      const response = await run.engine.translate({ resourceId: run.grant.session.resourceId, settings: run.settings,
        apiKey: 'local-preview', mode: 'vod', signal: controller.signal, priority: 'near',
        items: message.items.map((item: any) => ({ id: item.id, text: item.text,
          deadlineAt: performance.now() + Math.min(item.remainingMs, 120000) })), onResult: deliver });
      return { ok: true, items: response.items.map(item => outputs.get(item.id) ?? item), usage: response.usage };
    } finally { run.requests.delete(message.requestId); }
  }
  private async translateNative(tabId: number, documentId: string, message: any) {
    const run = this.match(tabId, documentId, message.runId, message.instanceId);
    await this.assertRun(run);
    if (message.epoch !== run.grant.epoch || typeof message.requestId !== 'string' ||
        !/^[a-zA-Z0-9_:-]{1,100}$/.test(message.requestId) || run.requestIds.has(message.requestId) ||
        run.requestIds.size >= 500 || !Array.isArray(message.items) || message.items.length === 0 ||
        message.items.length > 100 || run.requests.size >= 2) fail('invalid-request');
    const seen = new Set<string>();
    const items: NativeDemand[] = message.items.map((item: any) => {
      if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 500 || seen.has(item.id) ||
          typeof item.sourceId !== 'string' || !item.sourceId || item.sourceId.length > 500 ||
          typeof item.text !== 'string' || !item.text || item.text.length > 10000 ||
          !Number.isFinite(item.mediaTimeMs) || !Number.isFinite(item.deadlineAtEpochMs) ||
          item.deadlineAtEpochMs <= Date.now() || item.epoch !== run.grant.epoch ||
          !Number.isSafeInteger(item.predictionEpoch) ||
          !(typeof item.ruleRevision === 'string' || Number.isSafeInteger(item.ruleRevision))) fail('invalid-item');
      seen.add(item.id);
      return { id: item.id, sourceId: item.sourceId, originalText: item.text,
        mediaTimeMs: item.mediaTimeMs, deadlineAtEpochMs: item.deadlineAtEpochMs,
        epoch: item.epoch, predictionEpoch: item.predictionEpoch, ruleRevision: item.ruleRevision };
    });
    await this.nativeProof(run, items);
    await this.assertRun(run);
    const controller = new AbortController();
    const itemMap = new Map(items.map(item => [item.id, item.originalText]));
    const nativeItems = new Map(items.map(item => [item.id, item]));
    run.requests.set(message.requestId, { controller, items: itemMap, nativeItems });
    run.requestIds.add(message.requestId);
    const outputs = new Map<string, any>();
    const deliver = (output: TranslationOutput) => {
      const owner = nativeItems.get(output.id);
      if (!owner) return;
      const qualified = ['translated', 'cached'].includes(output.status) && typeof output.text === 'string' &&
        output.text !== owner.originalText &&
        !strictNativeResultIssue(owner.originalText, output.text, run.settings) && Date.now() < owner.deadlineAtEpochMs;
      const matched = run.candidates.get(owner.originalText);
      const candidate = matched?.text === output.text ? matched : undefined;
      const provenance = qualified ? {
        runId: run.grant.runId, instanceId: run.grant.instanceId, configIdentity: run.grant.configIdentity,
        requestId: message.requestId,
        ...(candidate ? { taskId: candidate.taskId, resultId: candidate.resultId } : {}),
        kind: output.status === 'cached' ? 'session-cache' : candidate?.deliveries ? 'session-shared' : 'new-inference',
      } : undefined;
      const finalOutput = !qualified && ['translated', 'cached'].includes(output.status)
        ? { id: output.id, text: owner.originalText, status: 'expired' as const, reason: 'adoption-deadline' } : output;
      const decorated = { ...finalOutput, ...(provenance ? { nativeSupply: provenance } : {}) };
      if (provenance && candidate) candidate.deliveries++;
      if (provenance) run.results.set(owner.originalText, candidate ?? {
        taskId: output.id, resultId: `${run.grant.runId}:${output.id}`, originalText: owner.originalText,
        text: output.text!, completedAt: performance.now(), completedAtEpochMs: Date.now(),
        usage: null, deliveries: 1,
        validated: true, configIdentity: run.grant.configIdentity,
      });
      outputs.set(output.id, decorated);
      run.deliveries.push({ requestId: message.requestId, at: performance.now(), atEpochMs: Date.now(), output: decorated,
        sourceId: owner.sourceId, epoch: owner.epoch, predictionEpoch: owner.predictionEpoch,
        ruleRevision: owner.ruleRevision, deadlineAtEpochMs: owner.deadlineAtEpochMs });
      if (this.run !== run || controller.signal.aborted || run.grant.state !== 'running') return;
      void this.options.page(tabId, documentId, { type: 'bilibili-native-supply-result',
        runId: run.grant.runId, instanceId: run.grant.instanceId, configIdentity: run.grant.configIdentity,
        requestId: message.requestId, sourceId: owner.sourceId, originalText: owner.originalText,
        mediaTimeMs: owner.mediaTimeMs, deadlineAtEpochMs: owner.deadlineAtEpochMs,
        epoch: owner.epoch, predictionEpoch: owner.predictionEpoch, ruleRevision: owner.ruleRevision,
        output: decorated }).catch(() => {});
    };
    try {
      const response = await run.engine.translate({ resourceId: run.grant.session.resourceId,
        settings: run.settings, apiKey: 'local-native-supply', signal: controller.signal, priority: 'near',
        items: items.map(item => ({ id: item.id, text: item.originalText,
          deadlineAt: performance.now() + Math.max(0, item.deadlineAtEpochMs - Date.now()) })), onResult: deliver });
      const budget = this.owned ? await this.budget.readSnapshot() : null;
      const remaining = budget?.total.remaining;
      const budgetExhausted = this.owned && !!remaining && (run.budgetInsufficient === true ||
        remaining.requests === 0 || remaining.items === 0 || remaining.utf16Chars === 0);
      return { ok: true, items: response.items.map(item => outputs.get(item.id) ?? item), usage: response.usage,
        ...(this.owned ? { budgetExhausted, budgetRemaining: remaining ?? null,
          ...(budgetExhausted ? { budgetReason: run.budgetInsufficient ? 'insufficient-for-request' : 'limit-reached' } : {}) } : {}) };
    } finally { run.requests.delete(message.requestId); }
  }
  cancel(tabId: number, documentId: string, message: any) {
    const run = this.match(tabId, documentId, message.runId, message.instanceId), request = run.requests.get(message.requestId);
    if (request) {
      if (Array.isArray(message.ids)) {
        const ids = message.ids.filter((id: any) => typeof id === 'string');
        for (const id of ids) request.nativeItems?.delete(id);
        run.engine.cancelItems(request.controller.signal, ids);
      }
      else request.controller.abort();
    }
    return { ok: true };
  }
  private async complete(run: ActiveRun, request: ProviderRequest) {
    let selected: readonly ProviderItem[] = [], attemptId: string | undefined, reserved = false, wasSent = false;
    const rememberCandidate = (id: string, text: string, usage: Usage | null) => {
      const source = selected.find(item => item.id === id);
      if (!source || !text || request.isItemCurrent?.(id) === false) return;
      const candidate: ResultCandidate = { taskId: id, resultId: `${run.grant.runId}:${id}`,
        originalText: source.text, text, completedAt: performance.now(), completedAtEpochMs: Date.now(),
        usage, deliveries: 0 };
      run.candidates.set(source.text, candidate);
    };
    const providerRequest: ProviderRequest = { ...request, onItem: (id, output) => {
      if (typeof output.text === 'string' && output.text) rememberCandidate(id, output.text, null);
      request.onItem?.(id, output);
    } };
    const permit = {}; this.permits.set(permit, { run, request: providerRequest });
    const provider = new ChatCompletionsProvider({ localPreviewPermit: permit, keepAlive: this.options.keepAlive,
      onLocalPayload: items => { selected = items; }, fetch: this.options.createLocalFetch(run.grant.modelId, {
        beforeSend: async (id, signal) => {
          await this.assertRun(run);
          if (signal?.aborted || !selected.length || selected.some(item => request.isItemCurrent?.(item.id) === false)) fail('cancelled');
          if (this.native) await this.nativeProof(run, this.nativeOwners(run, selected));
          else await this.proof(run, selected.map(item => item.text));
          await this.assertRun(run);
          attemptId = id;
          try {
            await this.budget.reserve({ phase: run.grant.phase, runId: run.grant.runId, attemptId: id, items: [...selected] });
          } catch (error) {
            if (this.owned && error instanceof LivePreviewBudgetError) {
              const remaining = (await this.budget.readSnapshot())?.total.remaining;
              if (remaining && (remaining.requests < 1 || remaining.items < selected.length ||
                  remaining.utf16Chars < selected.reduce((count, item) => count + item.text.length, 0)))
                run.budgetInsufficient = true;
            }
            throw error;
          }
          reserved = true;
          try {
            await this.assertRun(run);
            const owners = this.native ? await this.nativeProof(run, this.nativeOwners(run, selected))
              : await this.proof(run, selected.map(item => item.text));
            if (this.run !== run || run.grant.state !== 'running') fail('not-running');
            if (signal?.aborted || selected.some(item => request.isItemCurrent?.(item.id) === false)) fail('cancelled');
            run.inputs.push({ attemptId: id, at: performance.now(), atEpochMs: Date.now(),
              items: selected.map((item, index) => ({ ...item, owners: owners[index] })) });
          } catch (error) { await this.budget.settle(id, { status: 'not-sent' }); reserved = false; throw error; }
        },
        sent: id => { wasSent = true; void this.budget.settle(id, { status: 'sent' }).catch(() => { void this.stop('budget-storage-failed'); }); },
      }) });
    try {
      const result = await provider.complete(providerRequest);
      for (const item of selected) {
        const output = result.items.get(item.id);
        if (typeof output?.text === 'string' && output.text && !output.reason) {
          rememberCandidate(item.id, output.text, result.usage ?? null);
          const saved = run.results.get(item.text);
          if (saved?.taskId === item.id) saved.usage = result.usage ?? null;
        }
      }
      if (attemptId && wasSent) await this.budget.settle(attemptId, { status: 'completed', usage: result.usage });
      reserved = false;
      return result;
    } catch (error) {
      if (attemptId && reserved) await this.budget.settle(attemptId, { status: wasSent
        ? request.signal?.aborted ? 'cancelled' : 'failed' : 'not-sent',
      ...(wasSent && error instanceof ProviderError && error.usage ? { usage: error.usage } : {}) });
      reserved = false;
      const reason = error instanceof ProviderError ? error.code : 'live-preview-provider-failed';
      if (run.errors.length < 200) run.errors.push(reason);
      throw error;
    } finally { this.permits.delete(permit); }
  }
  private async waitForLocalIdle(timeoutMs = 5000): Promise<LocalState> {
    const deadline = Date.now() + timeoutMs;
    do {
      try {
        const reply = await this.options.localControl({ action: 'state' });
        const state = reply.ok ? reply.state : undefined;
        if (state && ['idle', 'ready', 'error'].includes(state.phase) && state.active === 0 && state.queued === 0) return state;
      } catch { /* Retry only until the bounded cleanup deadline. */ }
      if (Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    fail('cleanup-not-idle');
  }
  private ownedTemporaryGuard(guard: any, grant: Grant): boolean {
    return !!guard && guard.enabled === true && guard.kind === this.ownerKind &&
      guard.tabId === grant.tabId && guard.runId === grant.runId;
  }
  async stop(reason = 'manual', drain = false) {
    const run = this.run;
    const grant = run?.grant ?? (await this.options.storage.get(this.grantKey))[this.grantKey] as Grant | undefined;
    if (!grant) return this.status();
    this.ownerTab = grant.tabId;
    grant.state = drain ? 'draining' : 'stopped'; grant.reason = reason;
    // Revoke in memory and abort before storage can yield to a pending send.
    if (run) {
      for (const request of run.requests.values()) request.controller.abort();
      run.engine.dispose();
    }
    await this.save(grant);
    return this.status();
  }
  async cleanupRetiredOwned(expected: Pick<Grant, 'taskId' | 'runId' | 'instanceId' | 'tabId' | 'documentId'>) {
    if (!this.owned || this.preparing) fail('retired-owner-unavailable');
    this.preparing = true;
    try {
      const current = this.run?.grant ?? (await this.options.storage.get(this.grantKey))[this.grantKey];
      if (!current || current.state !== 'stopped' || this.run?.requests.size ||
          ['taskId', 'runId', 'instanceId', 'tabId', 'documentId'].some(key =>
            current[key as keyof Grant] !== expected[key as keyof typeof expected])) fail('retired-owner-changed');
      return await this.cleanup();
    } finally { this.preparing = false; }
  }
  async retireOwned(expected: Pick<Grant, 'taskId' | 'runId' | 'instanceId' | 'tabId' | 'documentId'>) {
    if (!this.owned || this.preparing) fail('retired-owner-unavailable');
    this.preparing = true;
    try {
      const stored = await this.options.storage.get([this.grantKey, this.guardKey]);
      const persisted = stored[this.grantKey] as Grant | undefined;
      const guard = stored[this.guardKey];
      if (!guard && (!persisted || persisted.state === 'stopped')) return;
      const current = this.run?.grant ?? persisted;
      const matches = (grant: Grant | undefined) => !!grant &&
        (['taskId', 'runId', 'instanceId', 'tabId', 'documentId'] as const)
          .every(key => grant[key] === expected[key]);
      if (!matches(current) || !matches(persisted) || !this.ownedTemporaryGuard(guard, current!))
        fail('retired-owner-changed');
      await this.stop('owner-tab-retired');
      const deadline = Date.now() + 5000;
      while (this.run && (this.run.requests.size > 0 || this.run.engine.stats().activeRequests > 0 ||
          this.run.engine.stats().pendingItems > 0)) {
        if (Date.now() >= deadline) fail('cleanup-not-idle');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const latest = await this.options.storage.get([this.grantKey, this.guardKey]);
      if (!matches(latest[this.grantKey]) || latest[this.grantKey].state !== 'stopped' ||
          !this.ownedTemporaryGuard(latest[this.guardKey], current!)) fail('retired-owner-changed');
      await this.cleanup();
    } finally { this.preparing = false; }
  }
  async cleanup() {
    await this.stop('cleanup');
    const grant = this.run?.grant ?? (await this.options.storage.get(this.grantKey))[this.grantKey] as Grant | undefined;
    if (!grant) return this.status();
    grant.state = 'stopped'; grant.reason = 'cleanup'; await this.save(grant);
    const otherKeys = [TEMPORARY_KEY, NATIVE_SUPPLY_GUARD_KEY, OWNED_SUPPLY_GUARD_KEY]
      .filter(key => key !== this.guardKey);
    const initial = await this.options.storage.get([this.guardKey, ...otherKeys, PERSISTENT_KEY]);
    const guard = initial[this.guardKey];
    if (guard && !this.ownedTemporaryGuard(guard, grant)) fail('cleanup-owner-changed');
    if (!this.ownedTemporaryGuard(guard, grant)) return this.status(false, true);

    const local = await this.waitForLocalIdle();
    if (!initial[PERSISTENT_KEY] && !otherKeys.some(key => initial[key]) && grant.loadedByTask && grant.loadOwnership === 'owned' &&
        local.phase === 'ready' && local.model?.id === grant.modelId && local.generation === grant.modelGeneration &&
        await modelIdentity(local.model) === grant.modelIdentity) {
      const current = await this.options.context(grant.tabId).catch(() => null);
      const idleOwner = current ? current.idle && !current.settings.enabled :
        await this.options.globalIdle?.().catch(() => false) ?? false;
      if (idleOwner) {
        const latestGuard = await this.options.storage.get([this.guardKey, ...otherKeys, PERSISTENT_KEY]);
        if (this.ownedTemporaryGuard(latestGuard[this.guardKey], grant) && !latestGuard[PERSISTENT_KEY] &&
            !otherKeys.some(key => latestGuard[key])) {
          const latest = await this.options.localControl({ action: 'state' });
          const currentOwner = await this.options.context(grant.tabId).catch(() => null);
          const stillIdleOwner = currentOwner ? currentOwner.idle && !currentOwner.settings.enabled :
            await this.options.globalIdle?.().catch(() => false) ?? false;
          if (latest.ok && latest.state?.phase === 'ready' && latest.state.active === 0 && latest.state.queued === 0 &&
              latest.state.model?.id === grant.modelId && latest.state.generation === grant.modelGeneration &&
              await modelIdentity(latest.state.model) === grant.modelIdentity && stillIdleOwner) {
            const unloaded = await this.options.localControl({ action: 'unload' });
            if (!unloaded.ok) fail('cleanup-unload-failed');
          }
        }
      }
    }
    const finalGuard = (await this.options.storage.get(this.guardKey))[this.guardKey];
    if (finalGuard && this.ownedTemporaryGuard(finalGuard, grant)) await this.options.storage.remove(this.guardKey);
    else if (finalGuard) fail('cleanup-owner-changed');
    return this.status(false, true);
  }
  async status(includeText = false, includeLocalState = false) {
    const grant = this.run?.grant ?? (await this.options.storage.get(this.grantKey))[this.grantKey] as Grant | undefined;
    const scrub = (rows: any[]) => includeText ? rows : rows.map(row => {
      const copy = { ...row }; delete copy.text; delete copy.originalText;
      if (copy.output) { copy.output = { ...copy.output }; delete copy.output.text;
        if (copy.output.preview) { copy.output.preview = { ...copy.output.preview }; delete copy.output.preview.originalText; } }
      if (copy.items) copy.items = copy.items.map((item: any) => ({ id: item.id, chars: item.text.length,
        owners: Array.isArray(item.owners) ? item.owners.map(({ originalText: _, ...owner }: Demand) => owner) : [] }));
      return copy;
    });
    const budget = await this.budget.readSnapshot();
    const result: Record<string, any> = { ok: true, buildId: this.options.buildId, ownerTabId: grant?.tabId ?? this.ownerTab,
      grant: grant ? { ...grant,
      state: !this.run && grant.state !== 'stopped' ? 'recovery-required' : grant.state } : null,
      budget, engine: this.run?.engine.stats() ?? null,
      results: scrub([...(this.run?.results.values() ?? [])]), inputs: scrub(this.run?.inputs ?? []),
      deliveries: scrub(this.run?.deliveries ?? []), errors: this.run?.errors ?? [],
      activeRequests: this.run?.requests.size ?? 0,
      nativePrepared: this.native ? [...(this.run?.results.values() ?? [])].filter(row => row.validated).length : 0,
      nativeSupply: this.native ? { cacheOnly: grant?.cacheOnly === true,
        subscribed: this.run?.engine.stats().rawInputs ?? 0,
        providers: { actualSent: budget?.total.actualSent ?? null, occupied: budget?.total.occupied ?? null },
        qualified: [...(this.run?.deliveries ?? [])].filter(row => row.output.nativeSupply).length,
        delivered: this.run?.deliveries.length ?? 0, usage: budget?.usage ?? null,
        lastClock: this.run?.proofs.at(-1) ?? null, proofs: this.run?.proofs.length ?? 0,
        replacement: 'unavailable' } : undefined,
      onlineCalls: 0 };
    if (includeLocalState && grant) {
      try {
        const local = await this.options.localControl({ action: 'state' });
        result.localState = local.ok && local.state ? {
          phase: local.state.phase, active: local.state.active, queued: local.state.queued,
          inferenceCalls: local.state.inferenceCalls, generation: local.state.generation,
          modelId: local.state.model?.id ?? null, modelName: local.state.model?.name ?? null,
        } : null;
      } catch { result.localState = null; }
    }
    return result;
  }
}
